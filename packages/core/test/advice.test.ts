import { describe, expect, it } from 'vitest';
import { assessRelay, formatDuration } from '../src/advice.js';
import type { SessionHealth } from '../src/snapshot.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const inMin = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function health(overrides: Partial<SessionHealth> = {}): SessionHealth {
  return {
    lastActivityAt: ago(5),
    lastSuccessAt: ago(5),
    lastLimitAt: null,
    limitMessage: null,
    limitResetsAt: null,
    quota: [],
    quotaAt: null,
    compactions: 0,
    ...overrides,
  };
}

const assess = (contextTokens: number | null, h: Partial<SessionHealth> = {}, provider = 'claude') =>
  assessRelay({ agent: provider === 'claude' ? 'Claude Code' : 'Codex', provider, contextTokens, health: health(h), now: NOW });

describe('assessRelay', () => {
  it('says relay when the agent hit its limit and has not worked since', () => {
    const a = assess(50_000, { lastLimitAt: ago(12), lastSuccessAt: ago(15), limitMessage: "You've hit your session limit · resets 4:50am" });
    expect(a).toMatchObject({ verdict: 'relay', alert: 'limit' });
    expect(a.headline).toBe("Claude Code hit its usage limit 12m ago (You've hit your session limit · resets 4:50am)");
  });

  it('uses a known reset time, and ignores a limit that has reset or that the agent worked past', () => {
    expect(assess(50_000, { lastLimitAt: ago(30), lastSuccessAt: ago(40), limitResetsAt: inMin(90) }).headline).toMatch(/resets in 2h/);
    expect(assess(50_000, { lastLimitAt: ago(30), lastSuccessAt: ago(40), limitResetsAt: ago(1) }).alert).toBeNull();
    expect(assess(50_000, { lastLimitAt: ago(30), lastSuccessAt: ago(2) }).alert).toBeNull();
    expect(assess(50_000, { lastLimitAt: ago(6 * 60), lastSuccessAt: ago(7 * 60) }).alert).toBeNull(); // no reset time: assume 5h
  });

  it('warns near a limit window, ignoring windows that already reset', () => {
    const near = assess(50_000, { quota: [{ label: '5h', usedPercent: 93, resetsAt: inMin(45) }, { label: 'weekly', usedPercent: 40, resetsAt: inMin(5000) }] }, 'codex');
    expect(near).toMatchObject({ verdict: 'relay', alert: 'quota', headline: 'Codex has used 93% of its 5h limit, resets in 45m' });
    expect(assess(50_000, { quota: [{ label: '5h', usedPercent: 99, resetsAt: ago(5) }] }, 'codex').alert).toBeNull();
  });

  it('says relay for a large session whose cache expired, but not for a small one', () => {
    const cold = assess(170_000, { lastActivityAt: ago(90) });
    expect(cold).toMatchObject({ verdict: 'relay', alert: 'cold' });
    expect(cold.reasons[0]).toBe('idle 2h: its cache has expired, so continuing re-processes 170k tokens at full price');
    expect(assess(170_000, { lastActivityAt: ago(90) }, 'codex').reasons[0]).toMatch(/has likely expired/);
    expect(assess(40_000, { lastActivityAt: ago(90) }).verdict).toBe('continue');
  });

  it('falls back to session size while the cache is warm', () => {
    expect(assess(40_000).verdict).toBe('continue');
    expect(assess(90_000).verdict).toBe('either');
    expect(assess(170_000)).toMatchObject({ verdict: 'either', alert: null });
    expect(assess(170_000).headline).toBe('large session (170k/call): a relay starts at ~45k/call and pays back after ~8 calls');
    expect(assess(826_000)).toMatchObject({ verdict: 'relay', alert: null });
    expect(assess(826_000).headline).toMatch(/pays back after ~2 calls/);
    expect(assess(170_000, { compactions: 2 })).toMatchObject({ verdict: 'relay', alert: 'compacted' });
    expect(assess(null).verdict).toBe('either');
  });
});

describe('formatDuration', () => {
  it('uses minutes, hours, then days', () => {
    expect(formatDuration(0.2)).toBe('1m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(150)).toBe('3h');
    expect(formatDuration(3 * 1440)).toBe('3d');
  });
});

describe('breakEvenCalls', () => {
  it('shrinks as the session grows, matching the benchmark at 160k', async () => {
    const { breakEvenCalls } = await import('../src/advice.js');
    expect(breakEvenCalls(160_000)).toBe(8);
    expect(breakEvenCalls(300_000)).toBe(4);
    expect(breakEvenCalls(826_000)).toBe(2);
    expect(breakEvenCalls(40_000)).toBe(Number.POSITIVE_INFINITY);
  });
});
