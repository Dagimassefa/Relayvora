import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCheckpoint, withRenderedHandoff } from '@agentrelay/core';
import { Store } from '@agentrelay/storage';
import { createCheckpoint } from '../src/checkpoint-service.js';
import { runCleanup } from '../src/commands/cleanup.js';
import { createContext, type CliContext } from '../src/context.js';
import { ensureProject, handoffPath, projectConfigPath } from '../src/project.js';
import { enforceRetention } from '../src/retention.js';

let ctx: CliContext;
let store: Store;
let projectId: string;
beforeEach(async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar cleanup ')));
  ctx = createContext({ cwd: root, dataDir: path.join(root, 'store') });
  store = Store.openInDir(ctx.dataDir);
  projectId = (await ensureProject(root, store)).record.id;
});
afterEach(() => store.close());

function save(id: string, ageDays: number, root = ctx.cwd) {
  const cp = withRenderedHandoff(buildCheckpoint({
    id, now: new Date(Date.now() - ageDays * 86_400_000), projectRoot: root,
    source: { provider: 'manual', sessionId: null, sessionPath: null },
    git: null, transcript: null, user: { goal: 'Finish the task' },
    verifications: [{ command: 'node --version', exitCode: 0, timedOut: false, output: 'v22', durationMs: 1, startedAt: new Date().toISOString() }],
    budgetTokens: 4000, targetProvider: null,
  })).checkpoint;
  store.saveCheckpoint(cp, root === ctx.cwd ? projectId : store.upsertProject(root).id);
  fs.mkdirSync(path.dirname(handoffPath(root, id)), { recursive: true });
  fs.writeFileSync(handoffPath(root, id), cp.handoff.prompt ?? '');
  return cp;
}

describe('checkpoint cleanup', () => {
  it('previews and deletes a unique prefix with its file, evidence and usage', async () => {
    save('cp-delete-me', 2);
    store.db.prepare("INSERT INTO usage_events (checkpoint_id, provider, source, recorded_at) VALUES (?, 'manual', 'estimated', ?)").run('cp-delete-me', new Date().toISOString());
    expect(await runCleanup(ctx, 'cp-delete', { dryRun: true })).toMatchObject({ deleted: 0, checkpointIds: ['cp-delete-me'] });
    expect(store.getCheckpoint('cp-delete-me')).toBeDefined();
    expect(await runCleanup(ctx, 'cp-delete', { yes: true })).toMatchObject({ deleted: 1 });
    expect(store.getCheckpoint('cp-delete-me')).toBeUndefined();
    expect(fs.existsSync(handoffPath(ctx.cwd, 'cp-delete-me'))).toBe(false);
    for (const table of ['evidence', 'usage_events']) expect(store.db.prepare(`SELECT * FROM ${table} WHERE checkpoint_id = ?`).all('cp-delete-me')).toEqual([]);
  });

  it('prunes only expired records in this project and honors forever', async () => {
    save('cp-old', 40); save('cp-recent', 1);
    const other = path.join(ctx.cwd, 'other');
    save('cp-other', 40, other);
    expect(enforceRetention(store, ctx.cwd, projectId, null)).toEqual([]);
    expect(await runCleanup(ctx, null, { dryRun: true })).toMatchObject({ checkpointIds: ['cp-old'] });
    expect(await runCleanup(ctx, null, { yes: true })).toMatchObject({ deleted: 1 });
    expect(store.getCheckpoint('cp-recent')).toBeDefined();
    expect(store.getCheckpoint('cp-other')).toBeDefined();
    await expect(runCleanup(ctx, 'cp-other', { yes: true })).rejects.toMatchObject({ exitCode: 3 });
  });

  it('requires confirmation and tolerates missing handoff files', async () => {
    save('cp-confirm', 1);
    if (!process.stdin.isTTY) await expect(runCleanup(ctx, 'cp-confirm')).rejects.toMatchObject({ exitCode: 6 });
    fs.unlinkSync(handoffPath(ctx.cwd, 'cp-confirm'));
    expect((await runCleanup(ctx, 'cp-confirm', { yes: true })).deleted).toBe(1);
  });

  it('enforces retention after a new checkpoint is saved; null disables it', async () => {
    save('cp-expired', 40);
    await createCheckpoint(ctx, { goal: 'New task' });
    expect(store.getCheckpoint('cp-expired')).toBeUndefined();
    save('cp-kept', 40);
    fs.writeFileSync(projectConfigPath(ctx.cwd), JSON.stringify({ schemaVersion: 1, retentionDays: null }));
    await createCheckpoint(ctx, { goal: 'Keep history' });
    expect(store.getCheckpoint('cp-kept')).toBeDefined();
  });

  it('refuses redirected handoff directories without deleting records or external files', async () => {
    save('cp-safe', 40);
    const dir = path.dirname(handoffPath(ctx.cwd, 'cp-safe'));
    const outside = path.join(ctx.cwd, 'external');
    fs.renameSync(dir, outside);
    fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(runCleanup(ctx, 'cp-safe', { yes: true })).rejects.toMatchObject({ exitCode: 6 });
    expect(store.getCheckpoint('cp-safe')).toBeDefined();
    expect(fs.existsSync(path.join(outside, 'cp-safe.md'))).toBe(true);
  });
});
