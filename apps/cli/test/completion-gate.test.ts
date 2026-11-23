import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand, type VerificationResult } from '@relayvora/core';
import { fingerprints, gateStatus, runGate } from '../src/completion-gate.js';
import { createContext } from '../src/context.js';

let root: string;
let ctx: ReturnType<typeof createContext>;
const result = (status: 'passed' | 'failed' | 'unknown'): VerificationResult => ({ command: 'kane', status, exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : 2, timedOut: false, output: 'observed', durationMs: 1, startedAt: new Date().toISOString() });
beforeEach(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gate-'));
  fs.mkdirSync(path.join(tmp, 'project'));
  root = fs.realpathSync.native(path.join(tmp, 'project'));
  ctx = createContext({ cwd: root, dataDir: path.join(tmp, 'state') });
  for (const args of [['init', '-q'], ['config', 'user.name', 'Tester'], ['config', 'user.email', 'tester@example.com']]) {
    expect((await runCommand('git', args, { cwd: root })).exitCode).toBe(0);
  }
  fs.writeFileSync(path.join(root, 'spec.md'), 'Save the item');
  fs.writeFileSync(path.join(root, 'app.js'), 'version one');
  expect((await runCommand('git', ['add', '.'], { cwd: root })).exitCode).toBe(0);
  expect((await runCommand('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], { cwd: root })).exitCode).toBe(0);
});

describe('completion gate', () => {
  it('does not verify even a passing Kane run without runtime binding', async () => {
    const record = await runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, async () => result('passed'));
    expect(record.state).toBe('blocked');
    expect(record.reasons.join()).toMatch(/running application/);
    expect((await gateStatus(ctx)).state).toBe('blocked');
  });
  it('records a failed run and invalidates it after a source or spec change', async () => {
    expect((await runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, async () => result('failed'))).state).toBe('recovery_required');
    fs.writeFileSync(path.join(root, 'app.js'), 'version two');
    expect((await gateStatus(ctx)).state).toBe('stale');
    const before = await fingerprints(root, 'spec.md');
    fs.writeFileSync(path.join(root, 'spec.md'), 'A changed requirement');
    expect((await fingerprints(root, 'spec.md')).spec).not.toBe(before.spec);
    await expect(runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, async () => result('passed'))).rejects.toThrow(/locked acceptance/);
  });
  it('fails closed if files change during the run or Kane is inconclusive', async () => {
    const stale = await runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, async () => {
      fs.writeFileSync(path.join(root, 'app.js'), 'changed');
      return result('passed');
    });
    expect(stale.state).toBe('stale');
    const unknown = await runGate(ctx, { spec: 'spec.md', objective: 'Verify save', timeout: 10 }, async () => result('unknown'));
    expect(unknown.state).toBe('blocked');
  });
  it('rejects specifications outside the project', async () => {
    await expect(fingerprints(root, '../outside.md')).rejects.toThrow(/inside the project/);
  });
});
