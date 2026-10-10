import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, type AgentAdapter, type SessionHealth } from '@agentrelay/core';
import { runWatch } from '../src/commands/watch.js';
import { createContext } from '../src/context.js';
import { PLAIN } from '../src/ui/theme.js';

const NOW = new Date('2026-10-10T12:00:00Z');

/**
 * A Claude adapter whose single large session follows a scripted sequence of health states, one per
 * check: fine, limit hit, still limited, working again. Stops the watch after the last state.
 */
function scripted(project: string, states: Array<Partial<SessionHealth>>, stop: AbortController): AgentAdapter {
  const file = path.join(project, '..', 'session.jsonl');
  fs.writeFileSync(file, '{}');
  let check = -1;
  const base: SessionHealth = {
    lastActivityAt: '2026-10-10T11:58:00Z',
    lastSuccessAt: '2026-10-10T11:58:00Z',
    lastLimitAt: null,
    limitMessage: null,
    limitResetsAt: null,
    quota: [],
    quotaAt: null,
    compactions: 0,
  };
  return {
    id: 'claude',
    displayName: 'Claude Code',
    executable: 'claude',
    capabilities: { discoverSessions: 'documented', readTranscript: 'documented', launch: 'unsupported', usageReporting: 'documented' },
    probe: async () => ({ found: false }),
    sessionRoots: () => [],
    discoverSessions: async () => {
      check++;
      if (check >= states.length - 1) stop.abort();
      // A new file version per state, so the digest cache re-reads it.
      const at = new Date(NOW.getTime() - 60_000 + check * 1000).toISOString();
      return { sessions: [{ provider: 'claude', id: 'sess-1234-abcd', path: file, cwd: project, startedAt: null, updatedAt: at, sizeBytes: 100 + check }], scannedRoots: [], warnings: [] };
    },
    readTranscript: async () => ({
      title: null,
      firstUserPrompt: 'x',
      latestSubstantialPrompt: null,
      recentUserPrompts: [],
      userPromptCount: 1,
      lastAgentMessage: null,
      usage: null,
      turns: { count: 3, firstAt: null, lastAt: null, firstContextTokens: 40_000, lastContextTokens: 50_000, callsBeforeFirstEdit: null, tokensBeforeFirstEdit: null },
      health: { ...base, ...states[Math.min(check, states.length - 1)] },
      warnings: [],
    }),
  };
}

describe('watch', () => {
  it('alerts once when a limit is hit and reports when it clears', async () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar watch ')));
    const project = path.join(home, 'p');
    fs.mkdirSync(project);
    await runCommand('git', ['init', '-q', project]);

    const stop = new AbortController();
    const limited = { lastLimitAt: '2026-10-10T11:59:30Z', lastSuccessAt: '2026-10-10T11:59:00Z', limitMessage: 'session limit' };
    const adapter = scripted(project, [{}, limited, limited, { lastSuccessAt: '2026-10-10T11:59:50Z' }], stop);
    const ctx = createContext({ cwd: project, env: { ...process.env, AGENTRELAY_HOME: path.join(home, 's') }, adapters: [adapter] });

    const out: string[] = [];
    const events = await runWatch(ctx, PLAIN, { intervalSeconds: 0.01, json: true, signal: stop.signal, write: (s) => out.push(s), now: () => NOW });

    expect(events.map((e) => [e.kind, e.alert])).toEqual([
      ['alert', 'limit'],
      ['cleared', null],
    ]);
    expect(events[0]!.headline).toBe('Claude Code hit its usage limit 1m ago (session limit)');
    expect(events[0]!.suggestion).toMatch(/^agentrelay handoff --session sess-123 --to /);
    expect(out.map((l) => JSON.parse(l).kind)).toEqual(['alert', 'cleared']);
  });

  it('--once shows the radar and returns', async () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar watch ')));
    const project = path.join(home, 'p');
    fs.mkdirSync(project);
    await runCommand('git', ['init', '-q', project]);
    const adapter = scripted(project, [{ lastActivityAt: '2026-10-10T09:00:00Z' }], new AbortController());
    const ctx = createContext({ cwd: project, env: { ...process.env, AGENTRELAY_HOME: path.join(home, 's') }, adapters: [adapter] });
    const out: string[] = [];
    await runWatch(ctx, PLAIN, { intervalSeconds: 60, once: true, write: (s) => out.push(s), now: () => NOW });
    const text = out.join('');
    expect(text).toContain('RELAY RADAR');
    expect(text).toContain('small session (50k/call)');
    expect(text).not.toContain('watching every');
  });
});
