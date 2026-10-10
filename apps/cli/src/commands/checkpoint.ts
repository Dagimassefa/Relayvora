import path from 'node:path';
import { AgentRelayError, ExitCode, renderHandoff, type Checkpoint } from '@agentrelay/core';
import type { CheckpointRow } from '@agentrelay/storage';
import { type CreateCheckpointResult, loadCheckpoint } from '../checkpoint-service.js';
import { type CliContext, openStore } from '../context.js';
import { locateProject } from '../project.js';
import { pointerPrompt } from '../launch.js';
import { box, compact, label, meter, num, providerChip, providerName, relativeTime, shortId, statusIcon, table } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export interface CheckpointSummary {
  id: string;
  createdAt: string;
  source: { provider: string; sessionId: string | null; title: string | null };
  targetProvider: string | null;
  goal: string;
  goalProvenance: string;
  evidence: { total: number; failingCommands: number; passingCommands: number };
  files: { changed: number; linesAdded: number; linesDeleted: number };
  /** Commits made since the session started; `inlined` patches made it into the handoff text. */
  commits: { count: number; linesAdded: number; linesDeleted: number; inlined: number };
  /** What the handoff text contains, for the card when the full text is not printed. */
  content: { requests: number; blockers: number; pending: number; inlinedFiles: number; agentReport: boolean };
  handoff: { file: string; estimatedTokens: number | null; budgetTokens: number | null; deferred: number; deferredTokens: number };
  usage: Checkpoint['usage'];
  warnings: string[];
  /** One-line prompt that points the next agent at the handoff file. */
  pointer: string;
  /** True when the handoff text was copied to the clipboard (--copy). */
  copied: boolean;
}

export function summarize(result: CreateCheckpointResult, copied = false): CheckpointSummary {
  const cp = result.checkpoint;
  const commands = cp.evidence.filter((e) => e.type === 'command' || e.type === 'test');
  const files = cp.evidence.filter((e) => e.type === 'git-diff' || e.type === 'file');
  const commitEvidence = cp.evidence.filter((e) => e.type === 'git-commit');
  return {
    id: cp.id,
    createdAt: cp.createdAt,
    source: { provider: cp.source.provider, sessionId: cp.source.sessionId, title: cp.source.title },
    targetProvider: cp.handoff.targetProvider,
    goal: cp.task.goal.text,
    goalProvenance: cp.task.goal.provenance,
    evidence: {
      total: cp.evidence.length,
      failingCommands: commands.filter((e) => e.status !== 'passed').length,
      passingCommands: commands.filter((e) => e.status === 'passed').length,
    },
    files: {
      changed: cp.project.dirtyFiles.length,
      linesAdded: files.reduce((n, e) => n + (e.linesAdded ?? 0), 0),
      linesDeleted: files.reduce((n, e) => n + (e.linesDeleted ?? 0), 0),
    },
    commits: {
      count: commitEvidence.length,
      linesAdded: commitEvidence.reduce((n, e) => n + (e.linesAdded ?? 0), 0),
      linesDeleted: commitEvidence.reduce((n, e) => n + (e.linesDeleted ?? 0), 0),
      inlined: commitEvidence.filter((e) => e.excerpt && !cp.handoff.deferred.some((d) => d.evidenceId === e.id)).length,
    },
    content: {
      requests: cp.task.recentRequests.length,
      blockers: cp.task.blockers.length,
      pending: cp.task.pending.length,
      inlinedFiles: files.filter((e) => e.excerpt && !cp.handoff.deferred.some((d) => d.evidenceId === e.id)).length,
      agentReport: cp.task.lastAgentReport !== null && !cp.handoff.deferred.some((d) => d.label.includes('last report')),
    },
    handoff: {
      file: result.handoffFile,
      estimatedTokens: cp.handoff.estimatedTokens,
      budgetTokens: cp.handoff.budgetTokens,
      deferred: cp.handoff.deferred.length,
      deferredTokens: cp.handoff.deferred.reduce((n, d) => n + d.estimatedTokens, 0),
    },
    usage: cp.usage,
    warnings: cp.warnings,
    pointer: pointerPrompt(cp, result.handoffFile),
    copied,
  };
}

/** Relative to the current directory when inside it; absolute otherwise. */
function displayPath(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

const PROVENANCE_TAG: Record<string, string> = {
  'user-provided': 'user',
  observed: 'observed',
  inferred: 'inferred',
  'agent-reported': 'agent-reported',
};

const PANEL_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The "mission card" printed after a checkpoint is captured. */
export function renderSummary(s: CheckpointSummary, t: Theme = PLAIN, launching = false): string {
  const sep = t.fg('gray', ` ${t.sym.dot} `);
  const from =
    s.source.provider === 'manual'
      ? `${providerChip(t, 'manual')} ${t.dim('repository + your input')}`
      : `${providerChip(t, s.source.provider)} ${t.bold(shortId(s.source.sessionId ?? '?'))}${s.source.title ? ` ${t.dim(`"${s.source.title}"`)}` : ''}`;
  const to = s.targetProvider ? providerChip(t, s.targetProvider) : t.dim('any agent');
  const goal = s.goal.split('\n')[0]!;
  const tag = PROVENANCE_TAG[s.goalProvenance] ?? s.goalProvenance;
  const tagColor = s.goalProvenance === 'inferred' || s.goalProvenance === 'agent-reported' ? 'amber' : 'lime';

  const tests =
    s.evidence.passingCommands + s.evidence.failingCommands === 0
      ? `${statusIcon(t, 'warn')} ${t.fg('amber', 'not verified')} ${t.dim('(add --verify "<cmd>")')}`
      : [
          s.evidence.passingCommands ? `${statusIcon(t, 'ok')} ${t.fg('lime', `${s.evidence.passingCommands} passed`)}` : '',
          s.evidence.failingCommands ? `${statusIcon(t, 'fail')} ${t.fg('red', `${s.evidence.failingCommands} failing`)}` : '',
        ]
          .filter(Boolean)
          .join('   ');

  const used = s.handoff.estimatedTokens ?? 0;
  const budget = s.handoff.budgetTokens ?? 0;
  const pct = budget ? Math.round((used / budget) * 100) : 0;
  const lines = [
    `${label(t, 'FROM')}${from}`,
    `${label(t, 'TO')}${to}`,
    `${label(t, 'GOAL')}${t.bold(goal)} ${t.fg(tagColor, `[${tag}]`)}`,
    '',
    `${label(t, 'TESTS')}${tests}`,
    `${label(t, 'FILES')}${t.bold(String(s.files.changed))} uncommitted${sep}${t.fg('lime', `+${num(s.files.linesAdded)}`)} ${t.fg('red', `-${num(s.files.linesDeleted)}`)}`,
    ...(s.commits.count > 0
      ? [
          `${label(t, 'COMMITS')}${t.bold(String(s.commits.count))} this session${sep}${t.fg('lime', `+${num(s.commits.linesAdded)}`)} ${t.fg('red', `-${num(s.commits.linesDeleted)}`)}`,
        ]
      : []),
    `${label(t, 'BUDGET')}${meter(t, used, budget, 22)}  ${t.bold(num(used))}${t.dim(`/${num(budget)} tok`)}  ${t.fg('gray', `${pct}%`)}`,
  ];
  const c = s.content;
  const contents = [
    'goal',
    c.requests ? `${c.requests} request(s)` : '',
    c.blockers ? t.fg('red', `${c.blockers} blocker(s)`) : '',
    c.pending ? `${c.pending} to-do` : '',
    c.inlinedFiles ? `${c.inlinedFiles} diff(s)` : '',
    s.commits.inlined ? `${s.commits.inlined} commit patch(es)` : '',
    c.agentReport ? 'agent report' : '',
  ].filter(Boolean);
  lines.push(`${label(t, 'HOLDS')}${contents.join(sep)}`);
  if (s.handoff.deferred > 0) {
    lines.push(
      `${label(t, 'DEFER')}${t.bold(String(s.handoff.deferred))} item(s)${sep}${t.fg('cyan', `~${compact(s.handoff.deferredTokens)} tok`)} ${t.dim('kept out, fetch on demand')}`,
    );
  }
  if (s.usage.source !== 'unavailable') {
    const cost = s.usage.costUsd !== null ? `${sep}~$${s.usage.costUsd.toFixed(2)}` : '';
    const cached = s.usage.cachedInputTokens ? ` ${t.dim(`(${compact(s.usage.cachedInputTokens)} cached)`)}` : '';
    lines.push(
      `${label(t, 'USAGE')}${compact(s.usage.inputTokens ?? 0)} in${cached}${sep}${compact(s.usage.outputTokens ?? 0)} out${cost} ${t.dim('· session so far')}`,
    );
  }

  const out = ['', box(t, `${t.sym.bullet} CHECKPOINT ${s.id}`, lines, 'magenta')];
  for (const w of s.warnings) out.push(`  ${statusIcon(t, 'warn')} ${t.fg('amber', w)}`);

  const panel = s.targetProvider ? `the ${providerName(t, PANEL_NAMES[s.targetProvider] ?? s.targetProvider)} panel` : 'the next agent';
  const arrow = t.fg('cyan', t.sym.arrow);
  out.push('', `  ${arrow} ${t.dim('review')}  ${t.bold(displayPath(s.handoff.file))}  ${t.dim(`or agentrelay checkpoint show ${s.id}`)}`);
  if (s.copied) {
    out.push(`  ${statusIcon(t, 'ok')} ${t.bold(t.fg('lime', 'copied'))}  paste into ${panel} ${t.dim('(Ctrl+V / Cmd+V)')}`);
  }
  if (launching) {
    out.push('');
    return out.join('\n');
  }
  if (!s.copied) {
    out.push(
      `  ${arrow} ${t.dim('relay ')}  ${t.bold(`agentrelay launch ${s.id}`)} ${t.dim('in a terminal,')} or paste into ${panel} ${t.dim('(--copy)')}`,
    );
  }
  out.push(`  ${arrow} ${t.dim('or say')}  ${t.fg('orange', s.pointer)}`, '');
  return out.join('\n');
}

export interface ShowOptions {
  format?: 'markdown' | 'json';
  budget?: number;
}

/** Returns the stored handoff, or re-renders it when a different budget is requested. */
export async function runCheckpointShow(ctx: CliContext, id: string, options: ShowOptions): Promise<{ checkpoint: Checkpoint; markdown: string }> {
  const checkpoint = await loadCheckpoint(ctx, id);
  const markdown =
    options.budget !== undefined
      ? renderHandoff(checkpoint, { budgetTokens: options.budget }).markdown
      : (checkpoint.handoff.prompt ?? renderHandoff(checkpoint).markdown);
  return { checkpoint, markdown };
}

export async function runCheckpointList(ctx: CliContext, limit: number): Promise<{ projectRoot: string; checkpoints: CheckpointRow[] }> {
  const { root } = await locateProject(ctx.cwd);
  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(root);
    if (!project) {
      throw new AgentRelayError(`${root} has no checkpoints yet; run \`agentrelay checkpoint create\``, ExitCode.NotFound);
    }
    return { projectRoot: root, checkpoints: store.listCheckpoints(project.id, limit) };
  } finally {
    store.close();
  }
}

export function renderCheckpointList(r: { projectRoot: string; checkpoints: CheckpointRow[] }, t: Theme = PLAIN): string {
  if (r.checkpoints.length === 0) return `\n  ${statusIcon(t, 'info')} No checkpoints for ${r.projectRoot} yet.\n`;
  const rows = r.checkpoints.map((c) => [
    t.bold(c.id),
    t.fg('blue', relativeTime(c.createdAt)),
    `${providerChip(t, c.sourceProvider)} ${t.fg('gray', t.sym.arrow)} ${c.targetProvider ? providerChip(t, c.targetProvider) : t.dim('any')}`,
    c.estimatedTokens === null ? '?' : t.fg('cyan', `~${compact(c.estimatedTokens)}`),
    c.goal ?? '',
  ]);
  return ['', table(t, ['CHECKPOINT', 'WHEN', 'RELAY', 'TOKENS', 'GOAL'], rows), ''].join('\n');
}
