import { AgentRelayError, ExitCode, renderHandoff, type Checkpoint } from '@agentrelay/core';
import type { CheckpointRow } from '@agentrelay/storage';
import { type CreateCheckpointResult, loadCheckpoint } from '../checkpoint-service.js';
import { type CliContext, openStore } from '../context.js';
import { table } from '../output.js';
import { locateProject } from '../project.js';

const n = (v: number | null | undefined) => (v === null || v === undefined ? '?' : v.toLocaleString('en-US'));

export interface CheckpointSummary {
  id: string;
  createdAt: string;
  source: { provider: string; sessionId: string | null; title: string | null };
  targetProvider: string | null;
  goal: string;
  goalProvenance: string;
  evidence: { total: number; failingCommands: number; passingCommands: number };
  handoff: { file: string; estimatedTokens: number | null; budgetTokens: number | null; deferred: number };
  usage: Checkpoint['usage'];
  warnings: string[];
}

export function summarize(result: CreateCheckpointResult): CheckpointSummary {
  const cp = result.checkpoint;
  const commands = cp.evidence.filter((e) => e.type === 'command' || e.type === 'test');
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
    handoff: {
      file: result.handoffFile,
      estimatedTokens: cp.handoff.estimatedTokens,
      budgetTokens: cp.handoff.budgetTokens,
      deferred: cp.handoff.deferred.length,
    },
    usage: cp.usage,
    warnings: cp.warnings,
  };
}

export function renderSummary(s: CheckpointSummary): string {
  const source =
    s.source.provider === 'manual'
      ? 'repository + user input (no session)'
      : `${s.source.provider} session ${s.source.sessionId}${s.source.title ? ` ("${s.source.title}")` : ''}`;
  const goal = s.goal.split('\n')[0]!;
  const lines = [
    `Checkpoint ${s.id}`,
    `  source:    ${source}`,
    `  goal:      ${goal.length > 90 ? `${goal.slice(0, 89)}…` : goal} [${s.goalProvenance}]`,
    `  evidence:  ${s.evidence.total} item(s); commands: ${s.evidence.passingCommands} passed, ${s.evidence.failingCommands} failed/unknown`,
    `  handoff:   ~${n(s.handoff.estimatedTokens)} tokens (estimated; budget ${n(s.handoff.budgetTokens)})${
      s.handoff.deferred ? `, ${s.handoff.deferred} item(s) deferred` : ''
    }${s.targetProvider ? ` → ${s.targetProvider}` : ''}`,
    `  preview:   ${s.handoff.file}`,
  ];
  if (s.usage.source !== 'unavailable') {
    const cost = s.usage.costUsd !== null ? `, ~$${s.usage.costUsd.toFixed(2)}` : '';
    lines.push(`  session usage so far (${s.usage.source}): ${n(s.usage.inputTokens)} in / ${n(s.usage.outputTokens)} out${cost}`);
  }
  if (s.warnings.length > 0) lines.push('', 'Warnings:', ...s.warnings.map((w) => `  - ${w}`));
  lines.push('', 'Review (and edit, if needed) the preview file before handing it to another agent.');
  return lines.join('\n');
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

export function renderCheckpointList(r: { projectRoot: string; checkpoints: CheckpointRow[] }): string {
  if (r.checkpoints.length === 0) return `No checkpoints for ${r.projectRoot}.`;
  const rows = r.checkpoints.map((c) => [
    c.id,
    c.createdAt.replace('T', ' ').slice(0, 16),
    c.sourceProvider,
    c.targetProvider ?? '-',
    c.estimatedTokens === null ? '?' : `~${c.estimatedTokens}`,
    (c.goal ?? '').length > 60 ? `${c.goal!.slice(0, 59)}…` : (c.goal ?? ''),
  ]);
  return table(['CHECKPOINT', 'CREATED (UTC)', 'FROM', 'TO', 'TOKENS', 'GOAL'], rows);
}
