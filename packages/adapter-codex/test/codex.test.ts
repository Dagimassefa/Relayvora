import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/codex', import.meta.url));

describe('codexAdapter.discoverSessions', () => {
  it('reads current session_meta rollouts and legacy rollouts, newest first', async () => {
    const result = await codexAdapter.discoverSessions({ env: { CODEX_HOME: fixtures } });
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toContain('0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    expect(ids).toContain('12345678-90ab-4cde-8f01-234567890abc');

    expect(result.sessions.find((s) => s.id.startsWith('0199'))).toMatchObject({
      provider: 'codex',
      cwd: '/work/demo',
      startedAt: '2026-10-01T10:00:00.000Z',
    });
    // Legacy format has no cwd: kept, but flagged.
    expect(result.sessions.find((s) => s.id.startsWith('1234'))).toMatchObject({ cwd: null });
    expect(result.warnings.some((w) => w.includes('no working directory'))).toBe(true);
  });

  it('respects the limit', async () => {
    const result = await codexAdapter.discoverSessions({ env: { CODEX_HOME: fixtures }, limit: 1 });
    expect(result.sessions).toHaveLength(1);
  });
});

describe('codexAdapter.readTranscript', () => {
  const current = `${fixtures}/sessions/2026/10/01/rollout-2026-10-01T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl`;
  const legacy = `${fixtures}/sessions/2025/05/20/rollout-2025-05-20T08-00-00-12345678-90ab-4cde-8f01-234567890abc.jsonl`;

  it('uses user_message events, ignoring injected environment context', async () => {
    const t = await codexAdapter.readTranscript!(current);
    expect(t.firstUserPrompt).toBe('Add input validation');
    expect(t.recentUserPrompts).toEqual(['Use zod for the schema']);
    expect(t.lastAgentMessage).toBe('Validation added with zod; tests not run yet.');
  });

  it('takes the last cumulative token_count as usage', async () => {
    const t = await codexAdapter.readTranscript!(current);
    expect(t.usage).toMatchObject({ inputTokens: 2500, cachedInputTokens: 1800, outputTokens: 300, costUsd: null });
  });

  it('falls back to message items for legacy rollouts', async () => {
    const t = await codexAdapter.readTranscript!(legacy);
    expect(t.firstUserPrompt).toBe('legacy rollout without cwd');
    expect(t.lastAgentMessage).toBe('legacy reply');
    expect(t.usage).toBeNull();
  });
});
