import {
  CHECKPOINT_SCHEMA_VERSION,
  Checkpoint,
  type CheckpointInput,
  type Evidence,
  type Fact,
} from './checkpoint.js';
import { AgentRelayError, ExitCode } from './errors.js';
import { sha256 } from './hash.js';
import { redact, isSensitivePath, type RedactionFinding } from './redact.js';
import type { GitSnapshot, SessionCommits, TranscriptDigest, VerificationResult } from './snapshot.js';
import { outputExcerpt, truncateText } from './text.js';

export interface UserTaskInput {
  goal?: string;
  constraints?: string[];
  completed?: string[];
  pending?: string[];
  blockers?: string[];
  decisions?: string[];
}

export interface BuildCheckpointInput {
  id: string;
  now: Date;
  projectRoot: string;
  git: GitSnapshot | null;
  source: {
    provider: string;
    sessionId: string | null;
    sessionPath: string | null;
    /** Hash of the transcript file, so the evidence can be checked later. */
    sessionSha256?: string | null;
  };
  transcript: TranscriptDigest | null;
  user: UserTaskInput;
  verifications: VerificationResult[];
  /** Commits made since the session started (work already committed mid-session). */
  commits?: SessionCommits | null;
  targetProvider: string | null;
  budgetTokens: number;
  /** Problems found while collecting inputs (unreadable transcript, session from another directory...). */
  extraWarnings?: string[];
}

/** Per-item caps on what is stored in a checkpoint. The renderer applies the token budget later. */
export const LIMITS = {
  goalChars: 800,
  promptChars: 1200,
  agentReportChars: 2000,
  patchChars: 12_000,
  fileChars: 8_000,
  outputChars: 4_000,
} as const;

const TEST_COMMAND = /\b(test|tests|vitest|jest|mocha|pytest|unittest|rspec|phpunit|ctest|spec)\b|\bgo test\b|\bcargo test\b/i;

class Redactor {
  private counts = new Map<string, number>();

  text(value: string): string {
    const result = redact(value);
    this.add(result.findings);
    return result.text;
  }

  add(findings: RedactionFinding[]): void {
    for (const f of findings) this.counts.set(f.rule, (this.counts.get(f.rule) ?? 0) + f.count);
  }

  summary(): string | null {
    if (this.counts.size === 0) return null;
    const total = [...this.counts.values()].reduce((a, b) => a + b, 0);
    const detail = [...this.counts].map(([rule, n]) => `${rule} ×${n}`).join(', ');
    return `Redacted ${total} likely secret(s) before storing: ${detail}. Review the handoff before sharing it.`;
  }
}

/**
 * Assembles a checkpoint from collected inputs. Pure apart from hashing: no I/O, so it is fully
 * testable and identical on every platform. All free text is redacted here, before storage.
 */
export function buildCheckpoint(input: BuildCheckpointInput): Checkpoint {
  const at = input.now.toISOString();
  const r = new Redactor();
  const warnings: string[] = [...(input.extraWarnings ?? [])];
  const evidence: Evidence[] = [];
  const git = input.git;

  // --- Git evidence -------------------------------------------------------------------------
  if (git) {
    evidence.push({
      id: 'ev-git-status',
      type: 'git-status',
      command: 'git status --porcelain=v1 --untracked-files=all',
      exitCode: 0,
      status: 'recorded',
      truncated: false,
      capturedAt: git.capturedAt,
    });
    git.files.forEach((file, i) => {
      const id = `ev-file-${i + 1}`;
      const base: Evidence = {
        id,
        type: file.kind === 'untracked' ? 'file' : 'git-diff',
        path: file.path,
        exitCode: null,
        status: 'recorded',
        truncated: file.truncated,
        linesAdded: file.linesAdded,
        linesDeleted: file.linesDeleted,
        capturedAt: git.capturedAt,
      };
      if (file.sha256) base.sha256 = file.sha256;
      if (file.omittedReason) base.omittedReason = file.omittedReason;
      const raw = file.patch ?? file.content;
      if (raw !== null && !isSensitivePath(file.path)) {
        const limited = truncateText(raw, file.kind === 'untracked' ? LIMITS.fileChars : LIMITS.patchChars);
        base.excerpt = r.text(limited.text);
        base.truncated = file.truncated || limited.truncated;
      } else if (isSensitivePath(file.path)) {
        base.omittedReason = 'sensitive';
      }
      evidence.push(base);
    });
    if (git.detached) warnings.push('HEAD is detached; commit or create a branch before continuing work.');
    warnings.push(...git.warnings);
    const sensitive = git.files.filter((f) => isSensitivePath(f.path)).map((f) => f.path);
    if (sensitive.length > 0) {
      warnings.push(`Contents of sensitive file(s) were not captured: ${sensitive.join(', ')}`);
    }
  } else {
    warnings.push('Not a Git repository: there is no Git evidence, so file changes are unverified.');
  }

  // --- Commits made during the session ---------------------------------------------------------
  // Agents often commit as they go; without these the next agent would see a clean tree and
  // no record of what was built.
  const commitFacts: Fact[] = [];
  const sessionCommits = input.commits?.commits ?? [];
  sessionCommits.forEach((c, i) => {
    const id = `ev-commit-${i + 1}`;
    const ev: Evidence = {
      id,
      type: 'git-commit',
      command: `git show ${c.shortSha}`,
      exitCode: 0,
      status: 'recorded',
      truncated: c.truncated,
      linesAdded: c.linesAdded,
      linesDeleted: c.linesDeleted,
      commit: { sha: c.sha, subject: r.text(c.subject), authoredAt: c.authoredAt, filesChanged: c.filesChanged },
      capturedAt: at,
    };
    if (c.sha256) ev.sha256 = c.sha256;
    if (c.patch) {
      const limited = truncateText(c.patch, LIMITS.patchChars);
      ev.excerpt = r.text(limited.text);
      ev.truncated = c.truncated || limited.truncated;
    }
    if (c.withheldFiles.length > 0) {
      ev.omittedReason = `sensitive: ${c.withheldFiles.join(', ')}`;
      warnings.push(`Commit ${c.shortSha}: patches of sensitive file(s) were not captured: ${c.withheldFiles.join(', ')}`);
    }
    evidence.push(ev);
    commitFacts.push({
      text: `Committed \`${c.shortSha}\` ${r.text(c.subject)} (${c.filesChanged} file(s), +${c.linesAdded} -${c.linesDeleted})`,
      provenance: 'observed',
      evidenceRefs: [id],
    });
  });
  if (input.commits) warnings.push(...input.commits.warnings);

  // --- Transcript evidence --------------------------------------------------------------------
  const transcriptRefs: string[] = [];
  if (input.source.sessionPath) {
    const ev: Evidence = {
      id: 'ev-transcript',
      type: 'transcript',
      path: input.source.sessionPath,
      exitCode: null,
      status: 'recorded',
      truncated: false,
      capturedAt: at,
    };
    if (input.source.sessionSha256) ev.sha256 = input.source.sessionSha256;
    evidence.push(ev);
    transcriptRefs.push(ev.id);
  }
  if (input.transcript) warnings.push(...input.transcript.warnings);

  // --- Verification commands ------------------------------------------------------------------
  const completed: Fact[] = [];
  const blockers: Fact[] = [];
  input.verifications.forEach((v, i) => {
    const id = `ev-cmd-${i + 1}`;
    const excerpt = outputExcerpt(v.error ? `${v.error}\n${v.output}` : v.output, { maxChars: LIMITS.outputChars });
    const failed = v.exitCode !== null && v.exitCode !== 0;
    const passed = v.exitCode === 0 && !v.timedOut;
    evidence.push({
      id,
      type: TEST_COMMAND.test(v.command) ? 'test' : 'command',
      command: v.command,
      exitCode: v.exitCode,
      status: passed ? 'passed' : failed ? 'failed' : 'unknown',
      excerpt: r.text(excerpt.text),
      truncated: excerpt.truncated,
      durationMs: Math.round(v.durationMs),
      capturedAt: v.startedAt,
    });
    const cmd = `\`${r.text(v.command)}\``;
    if (passed) completed.push({ text: `${cmd} passes (exit 0)`, provenance: 'observed', evidenceRefs: [id] });
    else if (failed) blockers.push({ text: `${cmd} fails (exit ${v.exitCode})`, provenance: 'observed', evidenceRefs: [id] });
    else {
      const why = v.timedOut ? 'timed out' : v.error ? `could not run: ${v.error}` : 'did not finish';
      blockers.push({ text: `${cmd} ${why}; result unknown`, provenance: 'observed', evidenceRefs: [id] });
    }
  });
  if (input.verifications.length === 0) {
    warnings.push('No verification command was run (use --verify); test status is NOT verified.');
  }

  // --- Task facts -----------------------------------------------------------------------------
  const userFacts = (items: string[] | undefined): Fact[] =>
    (items ?? []).filter((t) => t.trim()).map((t) => ({ text: r.text(t.trim()), provenance: 'user-provided', evidenceRefs: [] }));

  // Sessions drift across tasks, so the latest request long enough to describe a task is a better
  // guess at the current goal than the first prompt. Either way it is labelled inferred.
  const t = input.transcript;
  const inferredFrom = t?.latestSubstantialPrompt ? 'latest substantial request' : 'first prompt';
  const inferredGoal = t?.latestSubstantialPrompt ?? t?.firstUserPrompt ?? null;
  let goal: Fact;
  if (input.user.goal?.trim()) {
    goal = { text: r.text(input.user.goal.trim()), provenance: 'user-provided', evidenceRefs: [] };
  } else if (inferredGoal) {
    goal = {
      text: r.text(truncateText(inferredGoal, LIMITS.goalChars).text),
      provenance: 'inferred',
      evidenceRefs: transcriptRefs,
    };
    warnings.push(`Goal was inferred from the session's ${inferredFrom}; pass --goal to state it explicitly.`);
  } else {
    throw new AgentRelayError(
      'No goal available: pass --goal "<what you are trying to do>", or choose a session with --from/--session.',
      ExitCode.Usage,
    );
  }

  const recentRequests: Fact[] = (t?.recentUserPrompts ?? []).filter((p) => p !== inferredGoal || input.user.goal?.trim()).map((p) => ({
    text: r.text(truncateText(p, LIMITS.promptChars).text),
    provenance: 'user-provided',
    evidenceRefs: transcriptRefs,
  }));
  const lastAgentReport: Fact | null = input.transcript?.lastAgentMessage
    ? {
        text: r.text(truncateText(input.transcript.lastAgentMessage, LIMITS.agentReportChars).text),
        provenance: 'agent-reported',
        evidenceRefs: transcriptRefs,
      }
    : null;
  if (input.source.provider !== 'manual' && !input.transcript) {
    warnings.push('The session transcript could not be read; task details come from the repository and user input only.');
  }

  const usage = input.transcript?.usage;
  const draft: CheckpointInput = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    id: input.id,
    createdAt: at,
    project: {
      root: git?.root ?? input.projectRoot,
      isGitRepo: git !== null,
      gitHead: git?.head ?? null,
      branch: git?.branch ?? null,
      linkedWorktree: git?.linkedWorktree ?? false,
      commitsSince: input.commits?.since ?? null,
      dirtyFiles: (git?.files ?? []).map((f) => ({
        path: f.path,
        status: f.status,
        ...(f.origPath ? { origPath: f.origPath } : {}),
      })),
    },
    source: {
      provider: input.source.provider,
      sessionId: input.source.sessionId,
      sessionPath: input.source.sessionPath,
      title: input.transcript?.title ? r.text(input.transcript.title) : null,
      capturedAt: at,
    },
    task: {
      goal,
      constraints: userFacts(input.user.constraints),
      completed: [...userFacts(input.user.completed), ...commitFacts, ...completed],
      pending: userFacts(input.user.pending),
      blockers: [...userFacts(input.user.blockers), ...blockers],
      recentRequests,
      lastAgentReport,
    },
    decisions: userFacts(input.user.decisions),
    evidence,
    handoff: {
      targetProvider: input.targetProvider,
      prompt: null,
      contextFiles: (git?.files ?? []).filter((f) => f.kind !== 'deleted').map((f) => f.path),
      budgetTokens: input.budgetTokens,
    },
    usage: usage
      ? {
          source: 'provider-reported',
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
          note: usage.note,
        }
      : { source: 'unavailable', inputTokens: null, outputTokens: null, costUsd: null },
    warnings,
  };

  const summary = r.summary();
  if (summary) draft.warnings!.push(summary);
  return Checkpoint.parse(draft);
}

export function checkpointSha256(cp: Checkpoint): string {
  return sha256(JSON.stringify(cp));
}
