import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRelayError,
  ExitCode,
  buildCheckpoint,
  isWithin,
  newCheckpointId,
  parseCommandLine,
  runCommand,
  sha256File,
  withRenderedHandoff,
  type AgentAdapter,
  type Checkpoint,
  type RenderResult,
  type SessionSummary,
  type TranscriptDigest,
  type UserTaskInput,
  type VerificationResult,
} from '@agentrelay/core';
import { collectGitSnapshot } from '@agentrelay/git';
import type { Store } from '@agentrelay/storage';
import { type CliContext, openStore, selectAdapters } from './context.js';
import { ensureProject, handoffPath } from './project.js';

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
  /** Progress messages (stderr in the CLI). */
  log?: (message: string) => void;
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
  const log = options.log ?? (() => {});
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
    if (options.session) picked = await findSession(ctx, options.session, options.from);
    else if (options.from) picked = await latestSession(ctx, options.from, project.root);
    const session = picked?.session ?? null;
    if (session?.cwd && !isWithin(project.root, session.cwd)) {
      extraWarnings.push(`The session was recorded in ${session.cwd}, not in this project (${project.root}).`);
    }

    let transcript: TranscriptDigest | null = null;
    let sessionSha256: string | null = null;
    if (picked && options.transcript !== false) {
      log(`Reading ${picked.adapter.displayName} session ${picked.session.id}…`);
      if (!picked.adapter.readTranscript) {
        extraWarnings.push(`${picked.adapter.displayName} transcripts cannot be read yet.`);
      } else {
        try {
          transcript = await picked.adapter.readTranscript(picked.session.path);
          sessionSha256 = await sha256File(picked.session.path);
        } catch (error) {
          extraWarnings.push(`Could not read session transcript: ${(error as Error).message}`);
        }
      }
    }

    log(project.isGitRepo ? 'Collecting Git evidence…' : 'Not a Git repository; skipping Git evidence.');
    const git = project.isGitRepo ? await collectGitSnapshot(project.root) : null;

    const verifications: VerificationResult[] = [];
    for (const command of verify) {
      log(`Running \`${command}\`…`);
      const result = await runVerification(command, project.root, options.verifyTimeoutSec ?? 600);
      log(`  → ${result.timedOut ? 'timed out' : result.error ? `could not run: ${result.error}` : `exit ${result.exitCode}`}`);
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
