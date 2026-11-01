import { AgentRelayError, canonicalPath, ExitCode } from '@agentrelay/core';
import { confirmOrAbort } from '../confirm.js';
import { type CliContext, openStore } from '../context.js';
import { locateProject, readProjectConfig } from '../project.js';
import { removeCheckpoint } from '../retention.js';

export interface CleanupOptions { yes?: boolean; dryRun?: boolean; days?: number }
export interface CleanupResult { dryRun: boolean; checkpointIds: string[]; deleted: number }

export async function runCleanup(ctx: CliContext, id: string | null, options: CleanupOptions = {}): Promise<CleanupResult> {
  const { root } = await locateProject(ctx.cwd);
  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(root);
    let ids: string[];
    if (id !== null) {
      const cp = store.getCheckpoint(id);
      if (!cp || canonicalPath(cp.project.root) !== canonicalPath(root)) {
        throw new AgentRelayError(`No checkpoint found in this project with id "${id}"`, ExitCode.NotFound);
      }
      ids = [cp.id];
    } else {
      const days = options.days ?? readProjectConfig(root)?.retentionDays ?? null;
      if (days !== null && (!Number.isInteger(days) || days <= 0)) throw new AgentRelayError('days must be a positive integer', ExitCode.Usage);
      ids = days === null || !project ? [] : store.expiredCheckpoints(project.id, new Date(Date.now() - days * 86_400_000).toISOString()).map(r => r.id);
    }
    const result: CleanupResult = { dryRun: Boolean(options.dryRun), checkpointIds: ids, deleted: 0 };
    if (options.dryRun || ids.length === 0) return result;
    await confirmOrAbort(`Delete ${ids.length} checkpoint(s), their handoff files, evidence and usage records from ${root}?`, options.yes === undefined ? {} : { yes: options.yes });
    for (const cpId of ids) {
      if (removeCheckpoint(store, root, cpId)) {
        result.deleted++;
        store.recordAudit({ action: id === null ? 'checkpoint.prune' : 'checkpoint.delete', projectId: project?.id ?? null, target: cpId });
      }
    }
    return result;
  } finally { store.close(); }
}

export function renderCleanup(result: CleanupResult): string {
  return `${result.dryRun ? `Would delete ${result.checkpointIds.length}` : `Deleted ${result.deleted}`} checkpoint(s).${result.checkpointIds.length ? `\n${result.checkpointIds.join('\n')}` : ''}\n`;
}
