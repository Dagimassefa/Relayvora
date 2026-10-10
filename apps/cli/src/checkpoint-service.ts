import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRelayError,
  ExitCode,
  buildCheckpoint,
  detectVerifyCommands,
  canonicalPath,
  isWithin,
  newCheckpointId,
  parseCommandLine,
  runCommand,
  sha256File,
  withRenderedHandoff,
  type AgentAdapter,
  type Checkpoint,
  type RenderResult,
  type SessionCommits,
  type SessionSummary,
  type TranscriptDigest,
  type UserTaskInput,
  type VerificationResult,
} from '@agentrelay/core';
import { collectCommitsSince, collectGitSnapshot, resolveSince } from '@agentrelay/git';
import type { Store } from '@agentrelay/storage';
import { type CliContext, openStore, selectAdapters } from './context.js';
import { ensureProject, handoffPath } from './project.js';
import { SILENT_PROGRESS, type Progress } from './ui/progress.js';

export interface CreateCheckpointOptions extends UserTaskInput {
  /** Use the latest session of this provider for the project. */
  from?: string;
  /** Use this session id (or unique prefix). */
  session?: string;
  /** Provider that will receive the handoff. */
  to?: string;
  budget?: number;
  /** Commands to run now and record as evidence, e.g. "pnpm test". */
  verify?: string[];
  verifyTimeoutSec?: number;
  /** Set false to skip reading the session transcript. */
  transcript?: boolean;
  /** Set false to skip commits made since the session started. */
  commits?: boolean;
  /** Include commits since this time ("2h", "3d", an ISO date...). Defaults to the session start. */
  commitsSince?: string;
  /** Reports each step (spinner on stderr in the CLI). */
  progress?: Progress;
}

export interface CreateCheckpointResult {
  checkpoint: Checkpoint;
  render: RenderResult;
  handoffFile: string;
  session: SessionSummary | null;
}

async function findSession(
  ctx: CliContext,
  idOrPrefix: string,
  provider?: string,
): Promise<{ adapter: AgentAdapter; session: SessionSummary }> {
  const matches: Array<{ adapter: AgentAdapter; session: SessionSummary }> = [];
  for (const adapter of selectAdapters(ctx, provider)) {
    const { sessions } = await adapter.discoverSessions({ env: ctx.env });
    for (const session of sessions) {
      if (session.id === idOrPrefix) return { adapter, session };
      if (session.id.startsWith(idOrPrefix)) matches.push({ adapter, session });
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new AgentRelayError(
      `Session "${idOrPrefix}" is ambiguous: ${matches.map((m) => `${m.adapter.id}:${m.session.id}`).join(', ')}`,
      ExitCode.Usage,
    );
  }
  throw new AgentRelayError(`No session found with id "${idOrPrefix}"`, ExitCode.NotFound);
}

async function latestSession(
  ctx: CliContext,
  provider: string,
  projectRoot: string,
): Promise<{ adapter: AgentAdapter; session: SessionSummary }> {
  const adapter = selectAdapters(ctx, provider)[0]!;
  const { sessions } = await adapter.discoverSessions({ env: ctx.env, projectRoot, limit: 1 });
  const session = sessions[0];
  if (!session) {
    throw new AgentRelayError(
      `No ${adapter.displayName} session found for ${projectRoot}. Pass --session <id>, or omit --from for a repository-only checkpoint.`,
      ExitCode.NotFound,
    );
  }
  return { adapter, session };
}

/** Runs a verification command without a shell and records the real exit code. */
export async function runVerification(commandLine: string, cwd: string, timeoutSec: number): Promise<VerificationResult> {
  const argv = parseCommandLine(commandLine);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const r = await runCommand(argv[0]!, argv.slice(1), {
      cwd,
      timeoutMs: timeoutSec * 1000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return {
      command: commandLine,
      exitCode: r.timedOut ? null : r.exitCode,
      timedOut: r.timedOut,
      output: [r.stdout, r.stderr].filter(Boolean).join('\n'),
      durationMs: r.durationMs,
      startedAt,
    };
  } catch (error) {
    return {
      command: commandLine,
      exitCode: null,
      timedOut: false,
      error: (error as Error).message,
      output: '',
      durationMs: Date.now() - started,
      startedAt,
    };
  }
}

export async function createCheckpoint(ctx: CliContext, options: CreateCheckpointOptions): Promise<CreateCheckpointResult> {
  const progress = options.progress ?? SILENT_PROGRESS;
  if (options.to) selectAdapters(ctx, options.to); // validate early
  if (options.budget !== undefined && options.budget < 200) {
    throw new AgentRelayError('--budget must be at least 200 tokens', ExitCode.Usage);
  }
  if (!options.goal?.trim() && !options.from && !options.session) {
    throw new AgentRelayError(
      'No goal available: pass --goal "<what you are trying to do>", or choose a session with --from/--session.',
      ExitCode.Usage,
    );
  }
  const verify = options.verify ?? [];
  verify.forEach((v) => parseCommandLine(v)); // fail on bad syntax before doing any work

  const store: Store = openStore(ctx);
  try {
    const project = await ensureProject(ctx.cwd, store);
    const extraWarnings: string[] = [];

    let picked: { adapter: AgentAdapter; session: SessionSummary } | null = null;
    if (options.session || options.from) {
      picked = await progress.step(
        options.session ? `Finding session ${options.session}` : `Finding latest ${options.from} session`,
        () => (options.session ? findSession(ctx, options.session, options.from) : latestSession(ctx, options.from!, project.root)),
        (p) => ({ status: 'ok', detail: `${p.adapter.id} ${p.session.id.slice(0, 8)}` }),
      );
    }
    const session = picked?.session ?? null;
    if (session?.cwd && !isWithin(project.root, canonicalPath(session.cwd))) {
      extraWarnings.push(`The session was recorded in ${session.cwd}, not in this project (${project.root}).`);
    }

    let transcript: TranscriptDigest | null = null;
    let sessionSha256: string | null = null;
    if (picked && options.transcript !== false) {
      const { adapter, session: s } = picked;
      if (!adapter.readTranscript) {
        extraWarnings.push(`${adapter.displayName} transcripts cannot be read yet.`);
      } else {
        try {
          transcript = await progress.step(
            'Reading transcript',
            async () => {
              const digest = await adapter.readTranscript!(s.path);
              sessionSha256 = await sha256File(s.path);
              return digest;
            },
            (d) => ({
              status: d.userPromptCount > 0 ? 'ok' : 'warn',
              detail: `${d.userPromptCount} prompt(s)${d.title ? ` · "${d.title}"` : ''}`,
            }),
          );
        } catch (error) {
          extraWarnings.push(`Could not read session transcript: ${(error as Error).message}`);
        }
      }
    }

    const git = project.isGitRepo
      ? await progress.step(
          'Collecting Git evidence',
          () => collectGitSnapshot(project.root),
          (g) => {
            const added = g.files.reduce((n, f) => n + (f.linesAdded ?? 0), 0);
            const deleted = g.files.reduce((n, f) => n + (f.linesDeleted ?? 0), 0);
            return { status: 'ok', detail: `${g.files.length} file(s) · +${added} -${deleted}` };
          },
        )
      : null;

    // Work committed mid-session is invisible in the working tree, so collect it explicitly.
    const since = options.commitsSince ? resolveSince(options.commitsSince) : (session?.startedAt ?? null);
    let commits: SessionCommits | null = null;
    if (project.isGitRepo && options.commits !== false && since) {
      commits = await progress.step(
        'Collecting session commits',
        () => collectCommitsSince(project.root, since),
        (c) => ({
          status: 'ok',
          detail: c.commits.length
            ? `${c.commits.length} commit(s) · +${c.commits.reduce((n, x) => n + x.linesAdded, 0)} -${c.commits.reduce((n, x) => n + x.linesDeleted, 0)}`
            : 'none since the session started',
        }),
      );
    } else if (project.isGitRepo && options.commits !== false && session && !session.startedAt) {
      extraWarnings.push('The session has no recorded start time, so commits made during it were not collected; use --commits-since.');
    }

    // `--verify auto` expands to the project's own typecheck/lint/test commands.
    const commands: string[] = [];
    for (const v of verify) {
      if (v.trim().toLowerCase() !== 'auto') {
        commands.push(v);
        continue;
      }
      const detected = await progress.step(
        'Detecting checks',
        async () => detectVerifyCommands(project.root, { env: ctx.env }),
        (d) => (d.length ? { status: 'ok', detail: d.map((c) => c.command).join(' · ') } : { status: 'warn', detail: 'none found' }),
      );
      if (detected.length === 0) {
        extraWarnings.push('--verify auto found no typecheck, lint or test command; pass --verify "<command>" explicitly.');
      }
      for (const c of detected) if (!commands.includes(c.command)) commands.push(c.command);
    }

    const verifications: VerificationResult[] = [];
    for (const command of commands) {
      const result = await progress.step(
        `Running ${command}`,
        () => runVerification(command, project.root, options.verifyTimeoutSec ?? 600),
        (r) =>
          r.exitCode === 0
            ? { status: 'ok', detail: 'exit 0' }
            : { status: 'fail', detail: r.timedOut ? 'timed out' : r.error ? `could not run: ${r.error}` : `exit ${r.exitCode}` },
      );
      verifications.push(result);
    }

    const now = new Date();
    const built = buildCheckpoint({
      id: newCheckpointId(now),
      now,
      projectRoot: project.root,
      git,
      source: {
        provider: picked?.adapter.id ?? 'manual',
        sessionId: session?.id ?? null,
        sessionPath: session?.path ?? null,
        sessionSha256,
      },
      transcript,
      user: options,
      verifications,
      commits,
      targetProvider: options.to ?? null,
      budgetTokens: options.budget ?? project.config.handoffBudgetTokens,
      extraWarnings,
    });
    const { checkpoint, render } = withRenderedHandoff(built);

    store.saveCheckpoint(checkpoint, project.record.id);
    if (session) store.upsertSession(session, project.record.id);

    // The handoff file is what the user reviews and edits, and what Phase 3 will hand to the target agent.
    const handoffFile = handoffPath(project.root, checkpoint.id);
    fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
    fs.writeFileSync(handoffFile, checkpoint.handoff.prompt ?? '');

    store.recordAudit({
      action: 'checkpoint.create',
      projectId: project.record.id,
      target: checkpoint.id,
      details: {
        source: checkpoint.source.provider,
        sessionId: checkpoint.source.sessionId,
        targetProvider: checkpoint.handoff.targetProvider,
        estimatedTokens: checkpoint.handoff.estimatedTokens,
        evidence: checkpoint.evidence.length,
        handoffFile,
      },
    });
    return { checkpoint, render, handoffFile, session };
  } finally {
    store.close();
  }
}

export async function loadCheckpoint(ctx: CliContext, idOrPrefix: string): Promise<Checkpoint> {
  const store = openStore(ctx);
  try {
    const cp = store.getCheckpoint(idOrPrefix);
    if (!cp) throw new AgentRelayError(`No checkpoint found with id "${idOrPrefix}"`, ExitCode.NotFound);
    return cp;
  } finally {
    store.close();
  }
}
