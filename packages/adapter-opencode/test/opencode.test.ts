import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opencodeAdapter, parseSessionPath, sessionPath } from '../src/index.js';

// Mirrors the tables and JSON shapes OpenCode 1.19 writes (captured from a real session).
const SCHEMA = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const tokens = (input: number, read: number, output = 10) => ({ total: input + read + output, input, output, reasoning: 2, cache: { write: 0, read } });

let home: string;
let dbFile: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relayvora-opencode-'));
  fs.mkdirSync(path.join(home, 'opencode'));
  dbFile = path.join(home, 'opencode', 'opencode.db');
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  const session = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run('ses_main', 'p1', null, 'calm-river', '/work/demo', 'Fix the calculator', '1.19.5', T0, T0 + 60_000);
  session.run('ses_child', 'p1', 'ses_main', 'sub-task', '/work/demo', 'Child session - 2026', '1.19.5', T0, T0 + 90_000);
  session.run('ses_other', 'p2', null, 'far-away', '/elsewhere', 'New session - 2026-10-19', '1.19.5', T0 - 86_400_000, T0 - 86_000_000);

  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  const addPart = (msg: string, ses: string, data: object) => part.run(`prt_${String(++n).padStart(3, '0')}`, msg, ses, T0 + n, T0 + n, JSON.stringify(data));

  message.run('msg_1', 'ses_main', T0, T0, JSON.stringify({ role: 'user', time: { created: T0 } }));
  addPart('msg_1', 'ses_main', { type: 'text', text: 'Fix the bug in calc.py so that add() returns the sum of both of its arguments' });
  addPart('msg_1', 'ses_main', { type: 'text', text: 'Called the Read tool with the following input: {...}', synthetic: true });

  // One assistant message, two model calls: a read, then an edit.
  message.run('msg_2', 'ses_main', T0 + 1000, T0 + 5000, JSON.stringify({ role: 'assistant', time: { created: T0 + 1000, completed: T0 + 5000 }, cost: 0.02, tokens: tokens(250, 9000) }));
  addPart('msg_2', 'ses_main', { type: 'step-start' });
  addPart('msg_2', 'ses_main', { type: 'tool', tool: 'read', state: { status: 'completed' } });
  addPart('msg_2', 'ses_main', { type: 'step-finish', tokens: tokens(9000, 0), cost: 0.01 });
  addPart('msg_2', 'ses_main', { type: 'step-start' });
  addPart('msg_2', 'ses_main', { type: 'tool', tool: 'edit', state: { status: 'completed' } });
  addPart('msg_2', 'ses_main', { type: 'step-finish', tokens: tokens(250, 9000), cost: 0.01 });
  addPart('msg_2', 'ses_main', { type: 'text', text: 'Fixed add() in calc.py; tests not run yet.' });

  message.run('msg_3', 'ses_main', T0 + 20_000, T0 + 20_000, JSON.stringify({ role: 'user', time: { created: T0 + 20_000 } }));
  addPart('msg_3', 'ses_main', { type: 'compaction', auto: true });

  message.run('msg_4', 'ses_main', T0 + 30_000, T0 + 30_000, JSON.stringify({ role: 'user', time: { created: T0 + 30_000 } }));
  addPart('msg_4', 'ses_main', { type: 'text', text: '<system_reminder>be brief</system_reminder>now run the tests' });
  message.run('msg_5', 'ses_main', T0 + 31_000, T0 + 32_000, JSON.stringify({
    role: 'assistant',
    time: { created: T0 + 31_000 },
    error: { name: 'APIError', data: { message: 'Rate limit reached for requests', statusCode: 429 } },
  }));
  db.close();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('opencodeAdapter.discoverSessions', () => {
  it('lists top-level sessions from the database, newest first, skipping subagent sessions', async () => {
    const result = await opencodeAdapter.discoverSessions({ env: { XDG_DATA_HOME: home } });
    expect(result.sessions.map((s) => s.id)).toEqual(['ses_main', 'ses_other']);
    expect(result.sessions[0]).toMatchObject({
      provider: 'opencode',
      path: sessionPath(dbFile, 'ses_main'),
      cwd: '/work/demo',
      startedAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0 + 60_000).toISOString(),
    });
    expect(result.sessions[0]!.sizeBytes).toBeGreaterThan(0);
    expect(result.scannedRoots).toEqual([path.join(home, 'opencode')]);
  });

  it('filters by project and reports a missing database without failing', async () => {
    const scoped = await opencodeAdapter.discoverSessions({ env: { XDG_DATA_HOME: home }, projectRoot: '/elsewhere' });
    expect(scoped.sessions.map((s) => s.id)).toEqual(['ses_other']);
    const empty = await opencodeAdapter.discoverSessions({ env: { XDG_DATA_HOME: path.join(home, 'none') } });
    expect(empty).toEqual({ sessions: [], scannedRoots: [], warnings: [] });
  });
});

describe('opencodeAdapter.readTranscript', () => {
  it('reads prompts, the last agent text, per-call context and onboarding', async () => {
    const t = await opencodeAdapter.readTranscript!(sessionPath(dbFile, 'ses_main'));
    expect(t.title).toBe('Fix the calculator');
    expect(t.firstUserPrompt).toBe('Fix the bug in calc.py so that add() returns the sum of both of its arguments');
    expect(t.recentUserPrompts).toEqual(['now run the tests']);
    expect(t.userPromptCount).toBe(2);
    expect(t.lastAgentMessage).toBe('Fixed add() in calc.py; tests not run yet.');
    expect(t.turns).toMatchObject({
      count: 2,
      firstContextTokens: 9000,
      lastContextTokens: 9250,
      callsBeforeFirstEdit: 1,
      tokensBeforeFirstEdit: 9000,
      firstAt: new Date(T0).toISOString(),
    });
    expect(t.usage).toMatchObject({ inputTokens: 18_250, cachedInputTokens: 9000, outputTokens: 24 });
    expect(t.usage!.costUsd).toBeCloseTo(0.02);
    expect(t.warnings).toEqual([]);
  });

  it('reports rate limits and compactions as session health', async () => {
    const { health } = await opencodeAdapter.readTranscript!(sessionPath(dbFile, 'ses_main'));
    expect(health.compactions).toBe(1);
    expect(health.lastLimitAt).toBe(new Date(T0 + 31_000).toISOString());
    expect(health.limitMessage).toBe('Rate limit reached for requests');
    expect(health.lastSuccessAt).toBe(new Date(T0 + 5000).toISOString());
  });

  it('ignores placeholder titles and fails clearly for an unknown session', async () => {
    expect((await opencodeAdapter.readTranscript!(sessionPath(dbFile, 'ses_other'))).title).toBeNull();
    await expect(opencodeAdapter.readTranscript!(sessionPath(dbFile, 'ses_missing'))).rejects.toThrow(/not found/);
  });
});

describe('opencode session paths, hashing and launch', () => {
  it('round-trips database and session id, including paths that contain #', () => {
    expect(parseSessionPath(sessionPath('/a#b/opencode.db', 'ses_1'))).toEqual({ dbFile: '/a#b/opencode.db', sessionId: 'ses_1' });
    expect(() => parseSessionPath('/no/session/here')).toThrow();
  });

  it('hashes only the session’s own records, stably', async () => {
    const main = await opencodeAdapter.sessionSha256!(sessionPath(dbFile, 'ses_main'));
    expect(main).toMatch(/^[0-9a-f]{64}$/);
    expect(await opencodeAdapter.sessionSha256!(sessionPath(dbFile, 'ses_main'))).toBe(main);
    expect(await opencodeAdapter.sessionSha256!(sessionPath(dbFile, 'ses_other'))).not.toBe(main);
  });

  it('launches the TUI with the handoff as its prompt', () => {
    expect(opencodeAdapter.launchArgs!('Continue the task')).toEqual(['--prompt', 'Continue the task']);
  });
});
