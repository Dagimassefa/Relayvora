import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand, type VerificationResult } from '@relayvora/core';
import { acquireProjectLock, fingerprints, gateStatus, kaneCommand, runGate, type GateDeps } from '../src/completion-gate.js';
import { createContext } from '../src/context.js';
import type { ManagedRuntime } from '../src/managed-runtime.js';

let root: string;
let tmp: string;
let ctx: ReturnType<typeof createContext>;
const result = (status: 'passed' | 'failed' | 'unknown', command = 'kane'): VerificationResult => ({ command, status, exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : 2, timedOut: false, output: 'observed', durationMs: 1, startedAt: new Date().toISOString() });
const kane = (status: 'passed' | 'failed' | 'unknown') => async () => result(status);
const fakeApp = (state = { alive: true, starts: 0, stops: 0 }): GateDeps['startApp'] => async ({ url }) => {
  state.starts++;
  const runtime: ManagedRuntime = { url, pid: 4242, alive: () => state.alive, log: () => '', stop: async () => { state.stops++; } };
  return runtime;
};
const managed = { spec: 'spec.md', objective: 'Open http://localhost:3999/ and verify save', timeout: 10, start: 'node app.js', url: 'http://localhost:3999/' };

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gate-'));
  fs.mkdirSync(path.join(tmp, 'project'));
  root = fs.realpathSync.native(path.join(tmp, 'project'));
  ctx = createContext({ cwd: root, dataDir: path.join(tmp, 'state') });
  for (const args of [['init', '-q'], ['config', 'user.name', 'Tester'], ['config', 'user.email', 'tester@example.com']]) {
    expect((await runCommand('git', args, { cwd: root })).exitCode).toBe(0);
  }
  fs.writeFileSync(path.join(root, 'spec.md'), 'Save the item');
  fs.writeFileSync(path.join(root, 'app.js'), 'version one');
  fs.writeFileSync(path.join(root, 'app.test.js'), 'test one');
  expect((await runCommand('git', ['add', '.'], { cwd: root })).exitCode).toBe(0);
  expect((await runCommand('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], { cwd: root })).exitCode).toBe(0);
});

describe('completion gate', () => {
  it('does not verify a passing Kane run when Relayvora did not start the app', async () => {
    const record = await runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, { verify: kane('passed') });
    expect(record.state).toBe('blocked');
    expect(record.reasons.join()).toMatch(/not bound/);
    expect((await gateStatus(ctx)).state).toBe('blocked');
  });
  it('verifies a pass against the app it started, points Kane at it and stops the app', async () => {
    const app = { alive: true, starts: 0, stops: 0 };
    const commands: string[] = [];
    const record = await runGate(ctx, managed, { startApp: fakeApp(app), verify: async (c) => { commands.push(c); return result('passed', c); } });
    expect(record.state).toBe('verified');
    expect(record.runtime).toMatchObject({ url: 'http://localhost:3999/', pid: 4242 });
    expect(commands[0]).toBe(kaneCommand(managed.objective, new URL(managed.url)));
    expect(commands[0]).toContain('--url http://localhost:3999/');
    expect(app.stops).toBeGreaterThan(0);
    expect((await gateStatus(ctx)).state).toBe('verified');
    fs.writeFileSync(path.join(root, 'app.js'), 'version two');
    expect((await gateStatus(ctx)).state).toBe('stale');
  });
  it('blocks when the started app died during verification', async () => {
    const app = { alive: true, starts: 0, stops: 0 };
    const record = await runGate(ctx, managed, { startApp: fakeApp(app), verify: async () => { app.alive = false; return result('passed'); } });
    expect(record.state).toBe('blocked');
    expect(record.reasons.join()).toMatch(/exited during verification/);
  });
  it('requires recovery when a regression check fails even though Kane passed', async () => {
    const record = await runGate(ctx, { ...managed, checks: ['npm test'] }, { startApp: fakeApp(), verify: async (c) => result(c.startsWith('kane-cli') ? 'passed' : 'failed', c) });
    expect(record.state).toBe('recovery_required');
    expect(record.checks).toEqual([expect.objectContaining({ command: 'npm test', status: 'failed', exitCode: 1 })]);
  });
  it('records a failed run and invalidates it after a source or spec change', async () => {
    expect((await runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, { verify: kane('failed') })).state).toBe('recovery_required');
    fs.writeFileSync(path.join(root, 'app.js'), 'version two');
    expect((await gateStatus(ctx)).state).toBe('stale');
    fs.writeFileSync(path.join(root, 'spec.md'), 'A changed requirement');
    await expect(runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, { verify: kane('passed') })).rejects.toThrow(/locked acceptance/);
  });
  it('locks protected files with the specification', async () => {
    const opts = { ...managed, protect: ['app.test.js'] };
    expect((await runGate(ctx, opts, { startApp: fakeApp(), verify: kane('failed') })).state).toBe('recovery_required');
    fs.writeFileSync(path.join(root, 'app.test.js'), 'weakened test');
    await expect(runGate(ctx, opts, { startApp: fakeApp(), verify: kane('passed') })).rejects.toThrow(/protected files/);
  });
  it('fails closed if files change during the run or Kane is inconclusive', async () => {
    const stale = await runGate(ctx, managed, { startApp: fakeApp(), verify: async () => {
      fs.writeFileSync(path.join(root, 'app.js'), 'changed');
      return result('passed');
    } });
    expect(stale.state).toBe('stale');
    expect((await runGate(ctx, managed, { startApp: fakeApp(), verify: kane('unknown') })).state).toBe('blocked');
  });
  it('blocks when the app cannot be started', async () => {
    const record = await runGate(ctx, managed, { startApp: async () => { throw new Error('Something is already listening on localhost:3999'); }, verify: kane('passed') });
    expect(record.state).toBe('blocked');
    expect(record.reasons.join()).toMatch(/already listening/);
  });
  it('rejects bad inputs before doing any work', async () => {
    await expect(fingerprints(root, '../outside.md')).rejects.toThrow(/inside the project/);
    await expect(runGate(ctx, { ...managed, url: undefined }, { verify: kane('passed') })).rejects.toThrow(/together/);
    await expect(runGate(ctx, { ...managed, url: 'http://example.com/' }, { verify: kane('passed') })).rejects.toThrow(/this machine/);
    await expect(runGate(ctx, { ...managed, objective: 'Open http://localhost:4000/ and save' }, { startApp: fakeApp(), verify: kane('passed') })).rejects.toThrow(/not the app Relayvora starts/);
  });
});

describe('gate state integrity', () => {
  it('rejects a state file edited to claim verification', async () => {
    await runGate(ctx, managed, { startApp: fakeApp(), verify: kane('failed') });
    const dir = path.join(tmp, 'state', 'completion-gates');
    const file = path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith('.json'))!);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, state: 'verified' }));
    await expect(gateStatus(ctx)).rejects.toThrow(/modified/);
    await expect(runGate(ctx, managed, { startApp: fakeApp(), verify: kane('passed') })).rejects.toThrow(/modified outside Relayvora/);
  });
  it('allows one gate per project at a time and takes over a dead owner\'s lock', async () => {
    const release = await acquireProjectLock(ctx, root);
    await expect(runGate(ctx, managed, { startApp: fakeApp(), verify: kane('passed') })).rejects.toThrow(/Another completion gate/);
    await release();
    const dir = path.join(tmp, 'state', 'completion-gates');
    const release2 = await acquireProjectLock(ctx, root);
    const lockFile = fs.readdirSync(dir).find((n) => n.endsWith('.lock'))!;
    await release2();
    fs.writeFileSync(path.join(dir, lockFile), '999999999');
    expect((await runGate(ctx, managed, { startApp: fakeApp(), verify: kane('passed') })).state).toBe('verified');
  });
});
