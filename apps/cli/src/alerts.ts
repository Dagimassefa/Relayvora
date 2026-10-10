import { assessRelay, type RelayAssessment, type SessionSummary, type TranscriptDigest } from '@agentrelay/core';
import type { CliContext } from './context.js';
import { compact, providerChip, relativeTime, statusIcon } from './ui/components.js';
import type { Theme } from './ui/theme.js';

/** One line per agent: verdict icon, agent, session size and age, headline; then reasons and the command. */
export function renderRadar(radar: AgentRadar[], t: Theme): string[] {
  if (radar.length === 0) return [`  ${t.dim('No agent sessions in this project yet.')}`];
  const lines: string[] = [];
  for (const r of radar) {
    const a = r.assessment;
    const icon = statusIcon(t, a.verdict === 'relay' ? 'warn' : a.verdict === 'continue' ? 'ok' : 'info');
    const size = r.contextTokens === null ? '' : `${compact(r.contextTokens)}/call · `;
    const text = a.verdict === 'relay' ? t.bold(t.fg('amber', a.headline)) : t.dim(a.headline);
    lines.push(`  ${icon} ${providerChip(t, r.provider)} ${t.dim(`${size}${relativeTime(r.session.updatedAt)}`)}  ${text}`);
    for (const reason of a.reasons) lines.push(`      ${t.dim(reason)}`);
    if (a.verdict === 'relay') lines.push(`      ${t.fg('cyan', t.sym.arrow)} ${t.bold(r.suggestion)}`);
  }
  return lines;
}

export interface AgentRadar {
  provider: string;
  agent: string;
  session: SessionSummary;
  contextTokens: number | null;
  assessment: RelayAssessment;
  /** The command that relays this session's work to the other agent. */
  suggestion: string;
}

const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

// Transcripts can be tens of MB; `watch` re-checks every minute, so only re-read a file when it changed.
// Time-based signals (cache expiry, limit resets) are re-evaluated on every check regardless.
const digests = new Map<string, { key: string; digest: TranscriptDigest | null }>();

async function cachedDigest(session: SessionSummary, read: () => Promise<TranscriptDigest>): Promise<TranscriptDigest | null> {
  const key = `${session.updatedAt}:${session.sizeBytes}`;
  const hit = digests.get(session.path);
  if (hit?.key === key) return hit.digest;
  const digest = await read().catch(() => null);
  digests.set(session.path, { key, digest });
  return digest;
}

/**
 * For each agent, the latest session in this project and whether relaying it now beats continuing
 * (usage limit hit, near a limit, large and cold, compacted). Read-only.
 */
export async function relayRadar(ctx: CliContext, projectRoot: string, now: Date = new Date()): Promise<AgentRadar[]> {
  const out: AgentRadar[] = [];
  for (const adapter of ctx.adapters) {
    if (!adapter.readTranscript) continue;
    const { sessions } = await adapter.discoverSessions({ env: ctx.env, projectRoot, limit: 1 }).catch(() => ({ sessions: [] as SessionSummary[] }));
    const session = sessions[0];
    if (!session) continue;
    const digest = await cachedDigest(session, () => adapter.readTranscript!(session.path));
    if (!digest) continue;
    const contextTokens = digest.turns?.lastContextTokens ?? null;
    const agent = NAMES[adapter.id] ?? adapter.displayName;
    const other = ctx.adapters.find((a) => a.id !== adapter.id)?.id ?? adapter.id;
    out.push({
      provider: adapter.id,
      agent,
      session,
      contextTokens,
      assessment: assessRelay({ agent, provider: adapter.id, contextTokens, health: digest.health, now }),
      suggestion: `agentrelay handoff --session ${session.id.slice(0, 8)} --to ${other} --verify auto --confirm`,
    });
  }
  return out;
}
