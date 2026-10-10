import type { SessionHealth } from './snapshot.js';

/**
 * When does relaying beat continuing? Thresholds come from packages/benchmarks:
 * - Agents spend ~30-40k tokens per call on their own instructions; a fresh session pays a one-time
 *   cache write and a call or two of orientation. Small sessions (40k/call) cost +73% to relay.
 * - Large sessions (160k/call) relay with -71% context per call at about equal cost while the old
 *   session's cache is warm; break-even ~10 calls.
 * - Claude Code caches prompts for 1 hour (measured: all its cache writes use the 1h TTL). After that,
 *   continuing re-processes the whole context at the expensive cache-write rate.
 */
export const SMALL_SESSION_TOKENS = 60_000;
export const LARGE_SESSION_TOKENS = 120_000;
export const CACHE_TTL_MINUTES = 60;
/** A usage limit counts as current for this long when the agent gave no parseable reset time. */
export const LIMIT_ASSUMED_MINUTES = 5 * 60;
export const QUOTA_WARN_PERCENT = 90;

export type RelayVerdict = 'relay' | 'either' | 'continue';

export interface RelayAssessment {
  verdict: RelayVerdict;
  /** One line for the card and alerts. */
  headline: string;
  /** Short supporting reasons, most important first. */
  reasons: string[];
  /** Stable key for de-duplicating alerts, e.g. "limit", "cold", "quota". Null when nothing to alert. */
  alert: 'limit' | 'quota' | 'cold' | 'compacted' | null;
}

export interface AssessInput {
  agent: string;
  /** Provider id; the 1h cache lifetime is measured for Claude Code and assumed for others. */
  provider?: string;
  /** Context of the session's last model call (tokens). */
  contextTokens: number | null;
  health: SessionHealth | null;
  now?: Date;
}

const minutesSince = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 60_000 : null);

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;

/** Decides whether to relay now, from the session's size, idle time, limits and compactions. */
export function assessRelay(input: AssessInput): RelayAssessment {
  const now = input.now ?? new Date();
  const h = input.health;
  const ctx = input.contextTokens;
  const reasons: string[] = [];

  // 1. A usage limit that is still in force: continuing is not possible, relaying is.
  if (h?.lastLimitAt && (!h.lastSuccessAt || h.lastLimitAt >= h.lastSuccessAt)) {
    const resetsAt = h.limitResetsAt ? Date.parse(h.limitResetsAt) : null;
    const ago = minutesSince(h.lastLimitAt, now) ?? 0;
    const current = resetsAt !== null ? resetsAt > now.getTime() : ago < LIMIT_ASSUMED_MINUTES;
    if (current) {
      const resets = resetsAt !== null ? ` (resets in ${formatDuration((resetsAt - now.getTime()) / 60_000)})` : h.limitMessage ? ` (${h.limitMessage})` : '';
      return {
        verdict: 'relay',
        headline: `${input.agent} hit its usage limit ${formatDuration(ago)} ago${resets}`,
        reasons: ['continuing has to wait for the limit to reset'],
        alert: 'limit',
      };
    }
  }

  // 2. Close to a limit window (Codex reports this).
  const fresh = (h?.quota ?? []).filter((q) => !q.resetsAt || Date.parse(q.resetsAt) > now.getTime());
  const tight = fresh.filter((q) => q.usedPercent >= QUOTA_WARN_PERCENT).sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (tight) {
    const resets = tight.resetsAt ? `, resets in ${formatDuration((Date.parse(tight.resetsAt) - now.getTime()) / 60_000)}` : '';
    reasons.push(`${input.agent} has used ${Math.round(tight.usedPercent)}% of its ${tight.label} limit${resets}`);
  }

  // 3. The cache has expired: continuing re-processes the whole context at the expensive rate.
  const idle = minutesSince(h?.lastActivityAt ?? null, now);
  const cold = idle !== null && idle >= CACHE_TTL_MINUTES;
  if (cold && ctx !== null && ctx >= SMALL_SESSION_TOKENS) {
    const expired = input.provider === 'claude' ? 'has expired' : 'has likely expired';
    reasons.push(`idle ${formatDuration(idle!)}: its cache ${expired}, so continuing re-processes ${k(ctx)} tokens at full price`);
  }

  if (h && h.compactions > 0) reasons.push(`already compacted ${h.compactions}x (older context is summarised)`);

  if (tight) return { verdict: 'relay', headline: reasons[0]!, reasons: reasons.slice(1), alert: 'quota' };
  if (cold && ctx !== null && ctx >= SMALL_SESSION_TOKENS) {
    return { verdict: 'relay', headline: `${input.agent} session is large and cold: relaying is cheaper`, reasons, alert: 'cold' };
  }
  if (ctx === null) return { verdict: 'either', headline: 'no usage recorded for this session', reasons, alert: null };
  if (ctx >= LARGE_SESSION_TOKENS) {
    return {
      verdict: h && h.compactions > 0 ? 'relay' : 'either',
      headline: `large session (${k(ctx)}/call): a relay cuts context ~70%; cost breaks even after ~10 calls`,
      reasons,
      alert: h && h.compactions > 0 ? 'compacted' : null,
    };
  }
  if (ctx < SMALL_SESSION_TOKENS) {
    return {
      verdict: 'continue',
      headline: `small session (${k(ctx)}/call): continuing is cheaper; relay to switch agent or at a limit`,
      reasons,
      alert: null,
    };
  }
  return { verdict: 'either', headline: `mid-size session (${k(ctx)}/call): pays off on longer follow-ups`, reasons, alert: null };
}
