import { z } from 'zod';

export const CHECKPOINT_SCHEMA_VERSION = '0.1';

/**
 * Where a fact came from. `observed` facts were captured by AgentRelay itself (git, a command
 * it ran, a file hash) and must cite evidence. Everything an agent says about itself is
 * `agent-reported` until verified.
 */
export const Provenance = z.enum(['observed', 'agent-reported', 'inferred', 'user-provided']);
export type Provenance = z.infer<typeof Provenance>;

export const Fact = z.object({
  text: z.string().min(1),
  provenance: Provenance,
  evidenceRefs: z.array(z.string()).default([]),
});
export type Fact = z.infer<typeof Fact>;

export const DirtyFile = z.object({
  path: z.string().min(1),
  /** Two-letter porcelain status, e.g. " M", "A ", "??". */
  status: z.string().length(2),
  origPath: z.string().optional(),
});

export const EvidenceType = z.enum(['git-status', 'git-diff', 'git-commit', 'command', 'test', 'file', 'transcript', 'note']);
export type EvidenceType = z.infer<typeof EvidenceType>;

/**
 * `passed` / `failed` / `unknown` / `not-run` describe commands. `recorded` means the artifact itself
 * was captured (a diff, a file, a transcript) and makes no claim about correctness.
 */
export const EvidenceStatus = z.enum(['passed', 'failed', 'unknown', 'not-run', 'recorded']);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

export const Evidence = z.object({
  id: z.string().min(1),
  type: EvidenceType,
  path: z.string().optional(),
  /** Hash of the full artifact (whole patch, file or output), even when `excerpt` is truncated. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  command: z.string().optional(),
  exitCode: z.number().int().nullable().default(null),
  status: EvidenceStatus,
  /** Redacted content or excerpt. The full artifact stays retrievable by reference. */
  excerpt: z.string().optional(),
  truncated: z.boolean().default(false),
  linesAdded: z.number().int().nonnegative().nullable().optional(),
  linesDeleted: z.number().int().nonnegative().nullable().optional(),
  /** Why the content was not captured, e.g. "sensitive", "binary", "symlink". */
  omittedReason: z.string().optional(),
  /** For `git-commit` evidence: the commit this patch belongs to. */
  commit: z
    .object({
      sha: z.string().regex(/^[0-9a-f]{7,64}$/),
      subject: z.string(),
      authoredAt: z.string(),
      filesChanged: z.number().int().nonnegative(),
    })
    .optional(),
  durationMs: z.number().int().nonnegative().optional(),
  capturedAt: z.iso.datetime({ offset: true }),
});
export type Evidence = z.infer<typeof Evidence>;

export const SessionHealthSchema = z.object({
  lastActivityAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastLimitAt: z.string().nullable(),
  limitMessage: z.string().nullable(),
  limitResetsAt: z.string().nullable(),
  quota: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() })),
  quotaAt: z.string().nullable(),
  compactions: z.number().int().nonnegative(),
});

export const UsageSource = z.enum(['provider-reported', 'estimated', 'unavailable']);

export const DeferredRef = z.object({
  /** What was left out of the handoff text. */
  label: z.string().min(1),
  evidenceId: z.string().optional(),
  /** How the receiving agent can fetch it if needed. */
  retrieve: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative(),
});
export type DeferredRef = z.infer<typeof DeferredRef>;

export const Checkpoint = z
  .object({
    schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
    id: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    project: z.object({
      root: z.string().min(1),
      isGitRepo: z.boolean().default(true),
      gitHead: z.string().nullable(),
      /** null when HEAD is detached. */
      branch: z.string().nullable(),
      linkedWorktree: z.boolean().default(false),
      /** Start of the window for commits captured as evidence (the session start), if any. */
      commitsSince: z.string().nullable().default(null),
      dirtyFiles: z.array(DirtyFile),
    }),
    source: z.object({
      /** Provider id, or "manual" for a checkpoint built only from the repository and user input. */
      provider: z.string().min(1),
      sessionId: z.string().nullable(),
      sessionPath: z.string().nullable().default(null),
      title: z.string().nullable().default(null),
      /** Limit, idle and compaction signals from the source session when the checkpoint was made. */
      health: SessionHealthSchema.nullable().default(null),
      capturedAt: z.iso.datetime({ offset: true }),
    }),
    task: z.object({
      goal: Fact,
      constraints: z.array(Fact).default([]),
      completed: z.array(Fact).default([]),
      pending: z.array(Fact).default([]),
      blockers: z.array(Fact).default([]),
      /** The user's latest instructions in the source session, newest last. */
      recentRequests: z.array(Fact).default([]),
      /** The source agent's last status message. Always agent-reported. */
      lastAgentReport: Fact.nullable().default(null),
    }),
    decisions: z.array(Fact).default([]),
    evidence: z.array(Evidence).default([]),
    handoff: z.object({
      targetProvider: z.string().nullable(),
      prompt: z.string().nullable(),
      contextFiles: z.array(z.string()).default([]),
      budgetTokens: z.number().int().positive().nullable(),
      estimatedTokens: z.number().int().nonnegative().nullable().default(null),
      deferred: z.array(DeferredRef).default([]),
    }),
    /** Usage of the source session up to the checkpoint, as recorded by the agent itself. */
    usage: z.object({
      source: UsageSource,
      inputTokens: z.number().int().nonnegative().nullable(),
      cachedInputTokens: z.number().int().nonnegative().nullable().default(null),
      outputTokens: z.number().int().nonnegative().nullable(),
      costUsd: z.number().nonnegative().nullable(),
      note: z.string().nullable().default(null),
      /** Input context of the last model call: what each further turn in the source session would carry. */
      contextTokens: z.number().int().nonnegative().nullable().default(null),
      /** Model calls in the source session so far. */
      turns: z.number().int().nonnegative().nullable().default(null),
    }),
    warnings: z.array(z.string()).default([]),
  })
  .superRefine((cp, ctx) => {
    const ids = new Set<string>();
    cp.evidence.forEach((ev, i) => {
      if (ids.has(ev.id)) {
        ctx.addIssue({ code: 'custom', path: ['evidence', i, 'id'], message: `Duplicate evidence id "${ev.id}"` });
      }
      ids.add(ev.id);

      // "Tests passed" is only a fact if we have the command and its exit code.
      if (ev.status === 'passed' && (!ev.command || ev.exitCode !== 0)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', i, 'status'],
          message: 'status "passed" requires a recorded command and exitCode 0; use "unknown" if not verified',
        });
      }
      if (ev.status === 'failed' && (!ev.command || ev.exitCode === null || ev.exitCode === 0)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', i, 'status'],
          message: 'status "failed" requires a recorded command and a non-zero exitCode',
        });
      }
    });

    const facts: Array<[(string | number)[], Fact]> = [
      [['task', 'goal'], cp.task.goal],
      ...(['constraints', 'completed', 'pending', 'blockers', 'recentRequests'] as const).flatMap((key) =>
        cp.task[key].map((f, i): [(string | number)[], Fact] => [['task', key, i], f]),
      ),
      ...(cp.task.lastAgentReport ? [[['task', 'lastAgentReport'], cp.task.lastAgentReport] as [string[], Fact]] : []),
      ...cp.decisions.map((f, i): [(string | number)[], Fact] => [['decisions', i], f]),
    ];
    for (const [path, fact] of facts) {
      if (fact.provenance === 'observed' && fact.evidenceRefs.length === 0) {
        ctx.addIssue({ code: 'custom', path, message: 'An "observed" fact must cite at least one evidence id' });
      }
      for (const ref of fact.evidenceRefs) {
        if (!ids.has(ref)) {
          ctx.addIssue({ code: 'custom', path, message: `Unknown evidence reference "${ref}"` });
        }
      }
    }
    for (const [i, ref] of cp.handoff.deferred.entries()) {
      if (ref.evidenceId && !ids.has(ref.evidenceId)) {
        ctx.addIssue({ code: 'custom', path: ['handoff', 'deferred', i], message: `Unknown evidence "${ref.evidenceId}"` });
      }
    }
  });

export type Checkpoint = z.infer<typeof Checkpoint>;
export type CheckpointInput = z.input<typeof Checkpoint>;

export function parseCheckpoint(data: unknown): Checkpoint {
  return Checkpoint.parse(data);
}

export function safeParseCheckpoint(data: unknown) {
  return Checkpoint.safeParse(data);
}

/** Sortable, human-typeable id such as `cp-20261009-181502-a1b2`. */
export function newCheckpointId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `cp-${stamp}-${suffix}`;
}
