import type { SessionSummary } from '@agentrelay/core';
import { type CliContext, selectAdapters } from '../context.js';
import { formatBytes, table } from '../output.js';
import { locateProject } from '../project.js';

export interface SessionsOptions {
  provider?: string;
  /** List sessions from every directory instead of only the current project. */
  all?: boolean;
  limit?: number;
}

export interface SessionsResult {
  projectRoot: string | null;
  providers: Array<{
    provider: string;
    scannedRoots: string[];
    sessions: SessionSummary[];
    warnings: string[];
  }>;
}

export async function runSessions(ctx: CliContext, options: SessionsOptions = {}): Promise<SessionsResult> {
  const adapters = selectAdapters(ctx, options.provider);
  const projectRoot = options.all ? null : (await locateProject(ctx.cwd)).root;

  const providers = await Promise.all(
    adapters.map(async (adapter) => {
      const found = await adapter.discoverSessions({
        env: ctx.env,
        ...(projectRoot ? { projectRoot } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      return { provider: adapter.id, ...found };
    }),
  );
  return { projectRoot, providers };
}

export function renderSessions(result: SessionsResult, verbose = false): string {
  const rows = result.providers
    .flatMap((p) => p.sessions)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((s) => [s.provider, s.id, s.updatedAt.replace('T', ' ').slice(0, 16), formatBytes(s.sizeBytes), s.cwd ?? '?']);

  const scope = result.projectRoot ? `for ${result.projectRoot}` : 'across all projects';
  const out: string[] = [];
  if (rows.length === 0) {
    out.push(`No sessions found ${scope}.`);
    for (const p of result.providers) {
      if (p.scannedRoots.length === 0) out.push(`  ${p.provider}: no session directory found`);
    }
    if (result.projectRoot) out.push('  Try --all to list sessions from every directory.');
  } else {
    out.push(`Sessions ${scope}:`, '', table(['PROVIDER', 'SESSION', 'UPDATED (UTC)', 'SIZE', 'CWD'], rows));
  }

  const warningCount = result.providers.reduce((n, p) => n + p.warnings.length, 0);
  if (warningCount > 0) {
    if (verbose) out.push('', ...result.providers.flatMap((p) => p.warnings.map((w) => `warning: ${w}`)));
    else out.push('', `${warningCount} file(s) could not be fully read; use --verbose for details.`);
  }
  return out.join('\n');
}
