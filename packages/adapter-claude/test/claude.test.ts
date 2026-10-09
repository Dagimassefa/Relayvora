import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/index.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/claude', import.meta.url));

describe('claudeAdapter.discoverSessions', () => {
  it('reads session id, cwd and start time from fixtures and warns on corrupt files', async () => {
    const result = await claudeAdapter.discoverSessions({ env: { CLAUDE_CONFIG_DIR: fixtures } });
    expect(result.scannedRoots).toHaveLength(1);
    const session = result.sessions.find((s) => s.id === '11111111-2222-4333-8444-555555555555');
    expect(session).toMatchObject({
      provider: 'claude',
      cwd: '/work/demo',
      startedAt: '2026-10-01T09:00:00.000Z',
    });
    expect(result.sessions.find((s) => s.id === 'corrupted')).toMatchObject({ cwd: null });
    expect(result.warnings.some((w) => w.includes('corrupted.jsonl'))).toBe(true);
  });

  it('filters to a project root, including subdirectories', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-claude-'));
    const project = path.join(home, 'my project');
    const dir = path.join(home, 'projects', 'enc');
    fs.mkdirSync(dir, { recursive: true });
    const line = (id: string, cwd: string) => JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: '2026-10-01T00:00:00Z' });
    fs.writeFileSync(path.join(dir, 'a.jsonl'), line('in-root', project) + '\n');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), line('in-sub', path.join(project, 'pkg')) + '\n');
    fs.writeFileSync(path.join(dir, 'c.jsonl'), line('elsewhere', path.join(home, 'my project-2')) + '\n');

    const result = await claudeAdapter.discoverSessions({ env: { CLAUDE_CONFIG_DIR: home }, projectRoot: project });
    expect(result.sessions.map((s) => s.id).sort()).toEqual(['in-root', 'in-sub']);
  });

  it('returns nothing, without error, when no sessions directory exists', async () => {
    const result = await claudeAdapter.discoverSessions({ env: { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'nope-ar') } });
    expect(result).toEqual({ sessions: [], scannedRoots: [], warnings: [] });
  });
});

describe('claudeAdapter.readTranscript', () => {
  const file = path.join(fixtures, 'projects', '-work-demo', '11111111-2222-4333-8444-555555555555.jsonl');

  it('extracts real user prompts, skipping tool results, meta, injected blocks, images and sidechains', async () => {
    const t = await claudeAdapter.readTranscript!(file);
    expect(t.firstUserPrompt).toBe('Fix the failing date parser test');
    expect(t.recentUserPrompts).toEqual(['Also keep the public API stable']);
    expect(t.userPromptCount).toBe(2);
    expect(t.title).toBe('Fix date parser');
    expect(t.lastAgentMessage).toBe('Fixed leap years; tests pass now.');
    expect(t.warnings).toEqual([]);
  });

  it('sums usage across models, counting cache reads and writes as input', async () => {
    const t = await claudeAdapter.readTranscript!(file);
    expect(t.usage).toMatchObject({ inputTokens: 1310, cachedInputTokens: 1000, outputTokens: 55, costUsd: 0.42 });
  });

  it('warns instead of failing on an unrecognisable file', async () => {
    const t = await claudeAdapter.readTranscript!(path.join(fixtures, 'projects', '-work-demo', 'corrupted.jsonl'));
    expect(t.firstUserPrompt).toBeNull();
    expect(t.warnings.join()).toMatch(/no user prompts recognised/);
  });
});
