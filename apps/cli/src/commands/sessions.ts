import type { SessionSummary } from '@agentrelay/core';
import { type CliContext, selectAdapters } from '../context.js';
import { formatBytes } from '../output.js';
import { locateProject } from '../project.js';
import { providerChip, relativeTime, rule, shortId, table } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

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

export function renderSessions(result: SessionsResult, verbose = false, t: Theme = PLAIN): string {
  const sessions = result.providers.flatMap((p) => p.sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const scope = result.projectRoot ? `for ${result.projectRoot}` : 'across all projects';
  const out: string[] = ['', `  ${rule(t, `SESSIONS ${t.sym.dot} ${sessions.length}`, 'cyan', Math.min(t.width, 78) - 2)}`, ''];

  if (sessions.length === 0) {
    out.push(`  ${t.fg('amber', t.sym.warn)} No sessions found ${scope}.`);
    for (const p of result.providers) {
      if (p.scannedRoots.length === 0) out.push(`    ${t.dim(`${p.provider}: no session directory found`)}`);
    }
    if (result.projectRoot) out.push(`  ${t.fg('cyan', t.sym.arrow)} Try ${t.bold('agentrelay sessions --all')}`);
  } else {
    out.push(`  ${t.dim(scope)}`, '');
    const rows = sessions.map((s) => [
      providerChip(t, s.provider),
      t.bold(shortId(s.id)),
      t.fg('blue', relativeTime(s.updatedAt)),
      t.fg('gray', formatBytes(s.sizeBytes)),
      t.dim(s.cwd ?? '?'),
    ]);
    out.push(table(t, ['AGENT', 'SESSION', 'UPDATED', 'SIZE', 'WORKING DIRECTORY'], rows));
    const first = sessions[0]!;
    out.push(
      '',
      `  ${t.fg('cyan', t.sym.arrow)} ${t.dim('relay it:')} ${t.bold(`agentrelay handoff --session ${shortId(first.id)} --to ${first.provider === 'claude' ? 'codex' : 'claude'}`)}`,
    );
  }

  const warnings = result.providers.flatMap((p) => p.warnings);
  if (warnings.length > 0) {
    out.push('');
    if (verbose) out.push(...warnings.map((w) => `  ${t.fg('amber', t.sym.warn)} ${t.dim(w)}`));
    else out.push(`  ${t.fg('amber', t.sym.warn)} ${t.dim(`${warnings.length} file(s) could not be fully read; use --verbose for details.`)}`);
  }
  out.push('');
  return out.join('\n');
}
