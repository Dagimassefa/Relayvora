import {
  AgentRelayError,
  ExitCode,
  type AgentAdapter,
  type Checkpoint,
  type SessionSummary,
  type TranscriptDigest,
} from '@agentrelay/core';
import { loadCheckpoint, runVerification } from '../checkpoint-service.js';
import { type CliContext, openStore, selectAdapters } from '../context.js';
import { locateProject } from '../project.js';
import { box, compact, label, meter, providerChip, statusIcon } from '../ui/components.js';
import { SILENT_PROGRESS, type Progress } from '../ui/progress.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export interface CheckOutcome {
  command: string;
  status: 'passed' | 'failed' | 'unknown';
  exitCode: number | null;
}

export interface ReceivingSession {
  provider: string;
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  turns: number | null;
  firstContextTokens: number | null;
  lastContextTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  usageNote: string | null;
  /** Calls and input tokens before the receiving agent's first edit: its onboarding. */
  callsBeforeFirstEdit: number | null;
  tokensBeforeFirstEdit: number | null;
}

export interface RelayReport {
  checkpointId: string;
  createdAt: string;
  goal: string;
  source: { provider: string; sessionId: string | null; usage: Checkpoint['usage'] };
  handoff: { estimatedTokens: number | null; budgetTokens: number | null };
  receiving: ReceivingSession | null;
  /** 1 - receiving first-turn context / source last-turn context. Null when either side is unknown. */
  contextReduction: number | null;
  /**
   * Rough payback: onboarding tokens / tokens saved per turn. An upper bound, since a continuing
   * session would also have spent some of those calls. Null when it cannot be computed.
   */
  payback: { savedPerTurn: number; turns: number | null } | null;
  checks: { atCheckpoint: CheckOutcome[]; now: CheckOutcome[] | null };
  notes: string[];
}

export interface ReportOptions {
  /** Re-run the checkpoint's verification commands now. */
  reverify?: boolean;
  progress?: Progress;
}

const mentions = (d: TranscriptDigest, id: string) =>
  [d.firstUserPrompt, d.latestSubstantialPrompt, ...d.recentUserPrompts].some((p) => p?.includes(id));

/**
 * The session that continued from a checkpoint: started after it, in the same project, and with a
 * prompt that mentions the checkpoint id (the launch pointer and the pasted handoff both do).
 */
async function findReceivingSession(
  ctx: CliContext,
  cp: Checkpoint,
): Promise<{ adapter: AgentAdapter; session: SessionSummary; digest: TranscriptDigest } | null> {
  const adapters = cp.handoff.targetProvider ? selectAdapters(ctx, cp.handoff.targetProvider) : ctx.adapters;
  for (const adapter of adapters) {
    if (!adapter.readTranscript) continue;
    const { sessions } = await adapter.discoverSessions({ env: ctx.env, projectRoot: cp.project.root });
    // Oldest qualifying session first: the first one to pick the handoff up is the relay.
    const candidates = sessions
      .filter((s) => s.updatedAt >= cp.createdAt && s.id !== cp.source.sessionId)
      .slice(0, 15)
      .reverse();
    for (const session of candidates) {
      const digest = await adapter.readTranscript(session.path).catch(() => null);
      if (digest && mentions(digest, cp.id)) return { adapter, session, digest };
    }
  }
  return null;
}

function outcome(command: string, exitCode: number | null, status?: string): CheckOutcome {
  const s = status === 'passed' || exitCode === 0 ? 'passed' : exitCode !== null && exitCode !== 0 ? 'failed' : 'unknown';
  return { command, status: s, exitCode };
}

async function latestCheckpointId(ctx: CliContext): Promise<string> {
  const { root } = await locateProject(ctx.cwd);
  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(root);
    const latest = project ? store.listCheckpoints(project.id, 1)[0] : undefined;
    if (!latest) throw new AgentRelayError(`No checkpoints for ${root} yet.`, ExitCode.NotFound);
    return latest.id;
  } finally {
    store.close();
  }
}

export async function runReport(ctx: CliContext, id: string | undefined, options: ReportOptions = {}): Promise<RelayReport> {
  const progress = options.progress ?? SILENT_PROGRESS;
  const cp = await loadCheckpoint(ctx, id ?? (await latestCheckpointId(ctx)));
  const notes: string[] = [];

  const found = await progress.step(
    'Finding the session that continued this relay',
    () => findReceivingSession(ctx, cp),
    (f) => (f ? { status: 'ok', detail: `${f.adapter.id} ${f.session.id.slice(0, 8)}` } : { status: 'warn', detail: 'not found yet' }),
  );

  let receiving: ReceivingSession | null = null;
  if (found) {
    const { digest, session, adapter } = found;
    const t = digest.turns;
    const durationMs = t?.firstAt && t.lastAt ? Date.parse(t.lastAt) - Date.parse(t.firstAt) : null;
    receiving = {
      provider: adapter.id,
      sessionId: session.id,
      startedAt: t?.firstAt ?? session.startedAt,
      endedAt: t?.lastAt ?? session.updatedAt,
      durationMs,
      turns: t?.count ?? null,
      firstContextTokens: t?.firstContextTokens ?? null,
      lastContextTokens: t?.lastContextTokens ?? null,
      inputTokens: digest.usage?.inputTokens ?? null,
      cachedInputTokens: digest.usage?.cachedInputTokens ?? null,
      outputTokens: digest.usage?.outputTokens ?? null,
      costUsd: digest.usage?.costUsd ?? null,
      usageNote: digest.usage?.note ?? null,
      callsBeforeFirstEdit: t?.callsBeforeFirstEdit ?? null,
      tokensBeforeFirstEdit: t?.tokensBeforeFirstEdit ?? null,
    };
  } else {
    notes.push(
      `No session mentioning ${cp.id} was found after the checkpoint. Launch it with \`agentrelay launch ${cp.id}\`, or paste the handoff into the agent.`,
    );
  }

  // Checkpoints made before context sizes were recorded: read the source transcript again, but only
  // if that session did not continue after the checkpoint (otherwise the number would be from later).
  let usage = cp.usage;
  if (usage.contextTokens === null && cp.source.sessionPath && cp.source.provider !== 'manual') {
    const adapter = ctx.adapters.find((a) => a.id === cp.source.provider);
    const digest = adapter?.readTranscript ? await adapter.readTranscript(cp.source.sessionPath).catch(() => null) : null;
    const turns = digest?.turns;
    if (turns?.lastContextTokens && turns.lastAt && turns.lastAt <= cp.createdAt) {
      usage = { ...usage, contextTokens: turns.lastContextTokens, turns: turns.count };
      notes.push('Source context size was read from the source transcript now (this checkpoint predates recording it).');
    }
  }

  const source = usage.contextTokens;
  const target = receiving?.firstContextTokens ?? null;
  const contextReduction = source && target !== null ? 1 - target / source : null;
  const savedPerTurn = source !== null && target !== null ? source - target : null;
  const onboarding = receiving?.tokensBeforeFirstEdit ?? null;
  const payback =
    savedPerTurn === null ? null : { savedPerTurn, turns: savedPerTurn > 0 && onboarding !== null ? Math.max(1, Math.ceil(onboarding / savedPerTurn)) : null };
  if (source === null) notes.push('The source session recorded no per-turn usage, so context sizes cannot be compared.');

  const atCheckpoint = cp.evidence
    .filter((e) => e.type === 'command' || e.type === 'test')
    .map((e) => outcome(e.command ?? '?', e.exitCode, e.status));
  let now: CheckOutcome[] | null = null;
  if (options.reverify) {
    now = [];
    for (const c of atCheckpoint) {
      const r = await progress.step(
        `Re-running ${c.command}`,
        () => runVerification(c.command, cp.project.root, 600),
        (v) => (v.exitCode === 0 ? { status: 'ok', detail: 'exit 0' } : { status: 'fail', detail: v.timedOut ? 'timed out' : `exit ${v.exitCode}` }),
      );
      now.push(outcome(c.command, r.timedOut ? null : r.exitCode));
    }
    if (atCheckpoint.length === 0) notes.push('The checkpoint recorded no verification commands, so there is nothing to re-run.');
  }

  const report: RelayReport = {
    checkpointId: cp.id,
    createdAt: cp.createdAt,
    goal: cp.task.goal.text.split('\n')[0]!,
    source: { provider: cp.source.provider, sessionId: cp.source.sessionId, usage },
    handoff: { estimatedTokens: cp.handoff.estimatedTokens, budgetTokens: cp.handoff.budgetTokens },
    receiving,
    contextReduction,
    payback,
    checks: { atCheckpoint, now },
    notes,
  };

  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(cp.project.root);
    if (cp.usage.contextTokens === null && usage.contextTokens !== null) {
      store.saveSourceContext(project?.id ?? null, cp.id, cp.source.provider, usage.contextTokens, usage.turns);
    }
    if (receiving) {
      store.saveReceivingUsage(project?.id ?? null, cp.id, {
        provider: receiving.provider,
        sessionId: receiving.sessionId,
        inputTokens: receiving.inputTokens,
        cachedInputTokens: receiving.cachedInputTokens,
        outputTokens: receiving.outputTokens,
        costUsd: receiving.costUsd,
        firstContextTokens: receiving.firstContextTokens,
        lastContextTokens: receiving.lastContextTokens,
        turns: receiving.turns,
        durationMs: receiving.durationMs,
      });
    }
    store.recordAudit({
      action: 'relay.report',
      projectId: project?.id ?? null,
      target: cp.id,
      details: { receivingSession: receiving?.sessionId ?? null, contextReduction, reverified: Boolean(now) },
    });
  } finally {
    store.close();
  }
  return report;
}

function duration(ms: number | null): string {
  if (ms === null) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function renderReport(r: RelayReport, t: Theme = PLAIN): string {
  const sep = t.fg('gray', ` ${t.sym.dot} `);
  const tok = (n: number | null | undefined) => (n === null || n === undefined ? '?' : compact(n));
  const u = r.source.usage;
  const lines: string[] = [];

  const srcCached = u.cachedInputTokens ? ` ${t.dim(`(${tok(u.cachedInputTokens)} cached)`)}` : '';
  lines.push(
    `${label(t, 'FROM')}${providerChip(t, r.source.provider)} ${t.bold((r.source.sessionId ?? '').slice(0, 8))}${
      u.turns ? `${sep}${u.turns} turns` : ''
    }${u.inputTokens !== null ? `${sep}${tok(u.inputTokens)} in${srcCached}${sep}${tok(u.outputTokens)} out` : ''}`,
  );
  lines.push(`${label(t, 'HANDOFF')}~${tok(r.handoff.estimatedTokens)} tok ${t.dim('(estimated)')}`);

  const rc = r.receiving;
  if (rc) {
    const cached = rc.cachedInputTokens ? ` ${t.dim(`(${tok(rc.cachedInputTokens)} cached)`)}` : '';
    const cost = rc.costUsd !== null ? `${sep}~$${rc.costUsd.toFixed(2)}` : '';
    lines.push(
      `${label(t, 'TO')}${providerChip(t, rc.provider)} ${t.bold(rc.sessionId.slice(0, 8))}${sep}${rc.turns ?? '?'} turns${sep}${duration(rc.durationMs)}`,
      `${label(t, '')}${tok(rc.inputTokens)} in${cached}${sep}${tok(rc.outputTokens)} out${cost}`,
    );
  } else {
    lines.push(`${label(t, 'TO')}${t.fg('amber', 'no receiving session found yet')}`);
  }

  // Context carried into each turn: the source's last turn vs the receiving session's first.
  const before = u.contextTokens;
  const after = rc?.firstContextTokens ?? null;
  if (before !== null || after !== null) {
    const max = Math.max(before ?? 0, after ?? 0, 1);
    lines.push('');
    if (before !== null) lines.push(`${label(t, 'CONTEXT')}${t.dim('before')} ${meter(t, before, max, 20)} ${t.bold(tok(before))} ${t.dim('tok/turn')}`);
    if (after !== null) {
      const pct = r.contextReduction !== null ? `  ${t.bold(t.fg(r.contextReduction > 0 ? 'lime' : 'amber', `${r.contextReduction > 0 ? '-' : '+'}${Math.abs(Math.round(r.contextReduction * 100))}%`))}` : '';
      lines.push(`${label(t, '')}${t.dim('after ')} ${meter(t, after, max, 20)} ${t.bold(tok(after))} ${t.dim('tok/turn')}${pct}`);
    }
  }

  if (rc && rc.callsBeforeFirstEdit !== null) {
    lines.push(`${label(t, 'ONBOARD')}${rc.callsBeforeFirstEdit} call(s) · ${tok(rc.tokensBeforeFirstEdit)} tok before the first edit`);
  }
  if (r.payback) {
    const p = r.payback;
    lines.push(
      p.savedPerTurn <= 0
        ? `${label(t, 'PAYBACK')}${t.fg('amber', 'none on context alone')} ${t.dim('(source session was small; continuing would have been cheaper)')}`
        : p.turns !== null
          ? `${label(t, 'PAYBACK')}${t.fg(p.turns <= 3 ? 'lime' : 'amber', `tokens back within ~${p.turns} turn(s)`)} ${t.dim(`(${tok(p.savedPerTurn)} tok saved per turn; dollars take longer, see packages/benchmarks)`)}`
          : `${label(t, 'PAYBACK')}${tok(p.savedPerTurn)} tok saved per turn`,
    );
  }

  const checkIcon = (c: CheckOutcome) => statusIcon(t, c.status === 'passed' ? 'ok' : c.status === 'failed' ? 'fail' : 'warn');
  if (r.checks.atCheckpoint.length > 0) {
    lines.push('');
    r.checks.atCheckpoint.forEach((c, i) => {
      const now = r.checks.now?.[i];
      const after = now ? ` ${t.fg('gray', t.sym.arrow)} ${checkIcon(now)} ${t.dim('now')}` : '';
      lines.push(`${label(t, i === 0 ? 'CHECKS' : '')}${checkIcon(c)} ${c.command}${after}`);
    });
  }

  const out = ['', box(t, `${t.sym.bullet} RELAY REPORT ${r.checkpointId}`, lines, 'violet')];
  for (const n of r.notes) out.push(`  ${statusIcon(t, 'info')} ${t.dim(n)}`);
  out.push(
    `  ${t.dim("Token counts are the agents' own records; the handoff size is an estimate. Context per turn compares the")}`,
    `  ${t.dim("source session's last turn with the receiving session's first, which includes the agent's own system prompt.")}`,
  );
  if (!r.checks.now && r.checks.atCheckpoint.length > 0) {
    out.push(`  ${t.fg('cyan', t.sym.arrow)} ${t.dim('re-run the checks:')} ${t.bold(`agentrelay report ${r.checkpointId} --reverify`)}`);
  }
  out.push('');
  return out.join('\n');
}
