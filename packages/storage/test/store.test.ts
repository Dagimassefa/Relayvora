import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCheckpoint } from '@agentrelay/core';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, Store } from '../src/index.js';

const open: Store[] = [];
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ar store ü-'));
const track = (s: Store) => (open.push(s), s);

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('Store', () => {
  it('creates every blueprint table and records the schema version', () => {
    const store = track(Store.openInDir(tmpDir()));
    expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(
      expect.arrayContaining([
        'projects',
        'sessions',
        'tasks',
        'checkpoints',
        'evidence',
        'usage_events',
        'adapter_capabilities',
        'audit_events',
      ]),
    );
  });

  it('is safe to migrate repeatedly and to reopen', () => {
    const dir = tmpDir();
    track(Store.openInDir(dir)).close();
    open.pop();
    const store = track(Store.openInDir(dir));
    expect(store.migrate()).toEqual([]);
  });

  it('refuses a database from a newer AgentRelay', () => {
    const store = track(Store.open(':memory:'));
    store.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    expect(() => store.migrate()).toThrow(/newer than this AgentRelay supports/);
  });

  it('rolls back a failed migration as a unit', () => {
    const store = track(Store.open(':memory:', { migrate: false }));
    const broken = [...MIGRATIONS, { version: 99, name: 'broken', sql: 'CREATE TABLE ok_table (x); THIS IS NOT SQL;' }];
    expect(() => store.migrate(broken)).toThrow();
    expect(store.schemaVersion()).toBe(0);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get()).toBeUndefined();
  });

  it('upserts projects idempotently and writes audit events', () => {
    const store = track(Store.open(':memory:'));
    const a = store.upsertProject('/work/demo');
    const b = store.upsertProject('/work/demo');
    expect(b.id).toBe(a.id);
    expect(store.listProjects()).toHaveLength(1);

    store.recordAudit({ action: 'project.init', projectId: a.id, details: { x: 1 } });
    const row = store.db.prepare('SELECT action, details_json FROM audit_events').get() as Record<string, string>;
    expect(row).toEqual({ action: 'project.init', details_json: '{"x":1}' });
  });

  it('lets two connections share one database file', () => {
    const dir = tmpDir();
    const first = track(Store.openInDir(dir));
    const second = track(Store.openInDir(dir));
    first.upsertProject('/a');
    second.upsertProject('/b');
    expect(first.listProjects().map((p) => p.root)).toEqual(['/a', '/b']);
  });
});

describe('Store checkpoints', () => {
  const at = '2026-10-01T10:00:00.000Z';
  const cp = (id: string) =>
    parseCheckpoint({
      schemaVersion: '0.1',
      id,
      createdAt: at,
      project: { root: '/work/demo', gitHead: null, branch: 'main', dirtyFiles: [] },
      source: { provider: 'codex', sessionId: 's1', capturedAt: at },
      task: { goal: { text: 'Fix it\nsecond line', provenance: 'user-provided' } },
      evidence: [{ id: 'ev-cmd-1', type: 'test', command: 'pnpm test', exitCode: 1, status: 'failed', excerpt: 'boom', capturedAt: at }],
      handoff: { targetProvider: 'claude', prompt: '# hi', contextFiles: [], budgetTokens: 4000, estimatedTokens: 3 },
      usage: { source: 'provider-reported', inputTokens: 10, outputTokens: 2, costUsd: null },
    });

  it('round-trips a checkpoint with evidence and usage rows', () => {
    const store = track(Store.open(':memory:'));
    const project = store.upsertProject('/work/demo');
    store.saveCheckpoint(cp('cp-20261001-100000-aaaa'), project.id);

    expect(store.getCheckpoint('cp-20261001-100000-aaaa')).toEqual(cp('cp-20261001-100000-aaaa'));
    const ev = store.db.prepare('SELECT status, exit_code AS exitCode FROM evidence').get();
    expect(ev).toEqual({ status: 'failed', exitCode: 1 });
    expect(store.db.prepare('SELECT input_tokens AS n FROM usage_events').get()).toEqual({ n: 10 });
    expect(store.listCheckpoints(project.id)).toEqual([
      expect.objectContaining({ id: 'cp-20261001-100000-aaaa', targetProvider: 'claude', estimatedTokens: 3, goal: 'Fix it' }),
    ]);
  });

  it('resolves unique prefixes and rejects ambiguous ones', () => {
    const store = track(Store.open(':memory:'));
    const project = store.upsertProject('/work/demo');
    store.saveCheckpoint(cp('cp-20261001-100000-aaaa'), project.id);
    store.saveCheckpoint(cp('cp-20261001-100000-aabb'), project.id);
    expect(store.getCheckpoint('cp-20261001-100000-aab')?.id).toBe('cp-20261001-100000-aabb');
    expect(() => store.getCheckpoint('cp-20261001')).toThrow(/ambiguous/);
    expect(store.getCheckpoint('cp-nope')).toBeUndefined();
    expect(store.getCheckpoint('%')).toBeUndefined();
  });

  it('upgrades a v1 database in place', () => {
    const store = track(Store.open(':memory:', { migrate: false }));
    store.migrate(MIGRATIONS.slice(0, 1));
    expect(store.schemaVersion()).toBe(1);
    expect(store.migrate().map((m) => m.version)).toEqual([2]);
    expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });
});
