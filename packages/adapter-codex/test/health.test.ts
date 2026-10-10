import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/index.js';

const PRIMARY_RESET = 1791633600;
const WEEKLY_RESET = 1792000000;

// The real rate_limits shape Codex writes with each token_count.
const tokenCount = (ts: string, total: number, primary: number, reached: string | null = null) =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: total, total_tokens: total }, last_token_usage: { input_tokens: total } },
      rate_limits: {
        primary: { used_percent: primary, window_minutes: 300, resets_at: PRIMARY_RESET },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: WEEKLY_RESET },
        rate_limit_reached_type: reached,
      },
    },
  });

describe('Codex session health', () => {
  it('reads limit windows and a reached limit', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-codex-health-')), 'rollout.jsonl');
    fs.writeFileSync(file, [tokenCount('2026-10-10T10:00:00Z', 1000, 50), tokenCount('2026-10-10T11:00:00Z', 2000, 100, 'primary')].join('\n'));
    const t = await codexAdapter.readTranscript!(file);
    expect(t.health.quota).toEqual([
      { label: '5h', usedPercent: 100, resetsAt: new Date(PRIMARY_RESET * 1000).toISOString() },
      { label: 'weekly', usedPercent: 40, resetsAt: new Date(WEEKLY_RESET * 1000).toISOString() },
    ]);
    expect(t.health).toMatchObject({
      lastLimitAt: '2026-10-10T11:00:00Z',
      limitMessage: '5h limit reached',
      limitResetsAt: new Date(PRIMARY_RESET * 1000).toISOString(),
      lastSuccessAt: '2026-10-10T11:00:00Z',
    });
  });

  it('reads a usage-limit error event', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-codex-health-')), 'rollout.jsonl');
    const message = "You've hit your usage limit. Try again later.";
    fs.writeFileSync(
      file,
      [tokenCount('2026-10-10T10:00:00Z', 1000, 80), JSON.stringify({ timestamp: '2026-10-10T10:05:00Z', type: 'event_msg', payload: { type: 'error', message } })].join('\n'),
    );
    const t = await codexAdapter.readTranscript!(file);
    expect(t.health).toMatchObject({ lastLimitAt: '2026-10-10T10:05:00Z', limitMessage: message, lastSuccessAt: '2026-10-10T10:00:00Z' });
  });
});
