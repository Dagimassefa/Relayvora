import { AGENTRELAY_VERSION, type SessionSummary } from '@agentrelay/core';
import { getRepoState } from '@agentrelay/git';
import type { ActivityStats, CheckpointRow } from '@agentrelay/storage';
import { type CliContext, openStore } from '../context.js';
import { locateProject, readProjectConfig } from '../project.js';
import { banner, compact, label, providerChip, providerName, relativeTime, rule, statusIcon } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export interface HomeData {
  project: {
    root: string;
    name: string;
    initialized: boolean;
    git: { branch: string | null; head: string | null; changedFiles: number } | null;
  };
  sessions: Array<{ provider: string; count: number; latest: SessionSummary | null }>;
  lastCheckpoint: CheckpointRow | null;
  stats: { project: ActivityStats | null; global: ActivityStats };
}

/** Everything the home screen shows. Read-only: running bare `agentrelay` never writes anything. */
export async function runHome(ctx: CliContext): Promise<HomeData> {
  const { root, isGitRepo } = await locateProject(ctx.cwd);
  const [git, sessions] = await Promise.all([
    isGitRepo ? getRepoState(root).catch(() => null) : Promise.resolve(null),
    Promise.all(
      ctx.adapters.map(async (adapter) => {
        const found = await adapter.discoverSessions({ env: ctx.env, projectRoot: root }).catch(() => null);
        return { provider: adapter.id, count: found?.sessions.length ?? 0, latest: found?.sessions[0] ?? null };
      }),
    ),
  ]);

  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(root);
    return {
      project: {
        root,
        name: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
        initialized: readProjectConfig(root) !== null,
        git: git ? { branch: git.branch, head: git.head, changedFiles: git.entries.length } : null,
      },
      sessions,
      lastCheckpoint: project ? (store.listCheckpoints(project.id, 1)[0] ?? null) : null,
      stats: { project: project ? store.activityStats(project.id) : null, global: store.activityStats() },
    };
  } finally {
    store.close();
  }
}

export function renderHome(h: HomeData, t: Theme = PLAIN): string {
  const sep = t.fg('gray', ` ${t.sym.dot} `);
  const w = Math.min(t.width, 78) - 2;
  const out = [banner(t, AGENTRELAY_VERSION)];

  // Project
  const git = h.project.git;
  const gitText = git
    ? `${t.fg('violet', git.branch ?? 'detached HEAD')}${sep}${git.changedFiles ? t.fg('amber', `${git.changedFiles} changed`) : t.fg('lime', 'clean')}`
    : t.dim('not a Git repository');
  const init = h.project.initialized ? `${statusIcon(t, 'ok')} ${t.dim('ready')}` : `${statusIcon(t, 'warn')} ${t.fg('amber', 'run agentrelay init')}`;
  out.push(`  ${label(t, 'PROJECT', 9)}${t.bold(t.fg('cyan', h.project.name))}${sep}${gitText}${sep}${init}`);

  // Sessions
  const sessionParts = h.sessions.map((s) => `${providerName(t, s.provider)} ${t.bold(String(s.count))}`);
  const latest = h.sessions
    .map((s) => s.latest)
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  out.push(
    `  ${label(t, 'SESSIONS', 9)}${sessionParts.join(sep)}${latest ? `${sep}${t.dim('latest')} ${providerChip(t, latest.provider)} ${t.fg('blue', relativeTime(latest.updatedAt))}` : ''}`,
  );

  // Last relay
  const last = h.lastCheckpoint;
  out.push(
    `  ${label(t, 'LAST', 9)}${
      last
        ? `${providerChip(t, last.sourceProvider)} ${t.fg('gray', t.sym.arrow)} ${last.targetProvider ? providerChip(t, last.targetProvider) : t.dim('any')}  ${t.fg('cyan', `~${compact(last.estimatedTokens ?? 0)} tok`)}${sep}${t.fg('blue', relativeTime(last.createdAt))}${sep}${t.dim(last.id)}`
        : t.dim('no checkpoints yet')
    }`,
  );

  // Stats
  const g = h.stats.global;
  out.push('', `  ${rule(t, `${t.sym.bolt} RELAY STATS`, 'magenta', w)}`, '');
  if (g.checkpoints === 0) {
    out.push(`  ${t.dim('Nothing relayed yet. Your first checkpoint starts the streak.')}`);
  } else {
    const streakColor = g.streakDays >= 3 ? 'magenta' : g.streakDays > 0 ? 'lime' : 'gray';
    const cell = (value: string, name: string) => `${value} ${t.dim(name)}`;
    out.push(
      '  ' +
        [
          cell(t.bold(t.fg('cyan', String(g.checkpoints))), 'checkpoints'),
          cell(t.bold(t.fg('lime', `${g.passedRuns}/${g.verifiedRuns}`)), 'verified runs passed'),
          cell(t.bold(t.fg(streakColor, `${g.streakDays}d`)), 'streak'),
        ].join('   '),
      '  ' +
        [
          cell(t.bold(t.fg('violet', String(g.projects))), g.projects === 1 ? 'project' : 'projects'),
          cell(t.bold(t.fg('amber', `~${compact(g.deferredTokens)}`)), 'tok of context deferred (est.)'),
        ].join('   '),
    );
  }

  // Quick moves
  out.push('', `  ${rule(t, 'QUICK MOVES', 'cyan', w)}`, '');
  const moves: Array<[string, string]> = [];
  if (!h.project.initialized) moves.push(['agentrelay init', 'set up this project']);
  const busiest = h.sessions.filter((s) => s.count > 0).sort((a, b) => (b.latest?.updatedAt ?? '').localeCompare(a.latest?.updatedAt ?? ''))[0];
  const from = busiest?.provider ?? 'codex';
  const to = from === 'claude' ? 'codex' : 'claude';
  moves.push(
    [`agentrelay handoff --from ${from} --to ${to} --verify "<test cmd>"`, 'relay the work'],
    ['agentrelay sessions', 'browse sessions'],
    ['agentrelay checkpoint list', 'past relays'],
    ['agentrelay doctor', 'system check'],
  );
  const cmdWidth = Math.max(...moves.map(([c]) => c.length));
  for (const [cmd, what] of moves) out.push(`  ${t.fg('cyan', t.sym.arrow)} ${t.bold(cmd.padEnd(cmdWidth))}  ${t.dim(what)}`);
  out.push('', `  ${t.dim('agentrelay --help for everything')}`, '');
  return out.join('\n');
}
