import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '@relayvora/core';
import { createCheckpoint } from '../src/checkpoint-service.js';
import { runCheckpointList } from '../src/commands/checkpoint.js';
import { runImport } from '../src/commands/import.js';
import { runInbox, runSend, runSync } from '../src/commands/share.js';
import { createContext } from '../src/context.js';

// One remote, three clones: Alice's laptop and desktop (one person, two devices) and Bob's machine.
let home: string;
let laptop: string;
let desktop: string;
let bob: string;

const git = async (cwd: string, ...args: string[]) => {
  const r = await runCommand('git', ['-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr);
  return r.stdout;
};
const ctxOn = (cwd: string) =>
  createContext({ cwd, env: { ...process.env, RELAYVORA_HOME: path.join(path.dirname(cwd), 'state'), CODEX_HOME: path.join(path.dirname(cwd), 'codex') } });
const clone = async (remote: string, dir: string, name: string, email: string) => {
  await git(home, 'clone', '-q', remote, dir);
  await git(dir, 'config', 'user.name', name);
  await git(dir, 'config', 'user.email', email);
};
const ids = async (cwd: string) => (await runCheckpointList(ctxOn(cwd), 50)).checkpoints.map((c) => c.id).sort();
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar share ')));
  const seed = path.join(home, 'seed');
  const remote = path.join(home, 'remote.git');
  await git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  fs.mkdirSync(seed);
  await git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'app.js'), 'export const version = 1;\n');
  await git(seed, 'add', '-A');
  await git(seed, '-c', 'user.name=S', '-c', 'user.email=s@e.x', 'commit', '-q', '-m', 'init');
  await git(seed, 'push', '-q', remote, 'main');
  laptop = path.join(home, 'laptop', 'proj');
  desktop = path.join(home, 'desktop', 'proj');
  bob = path.join(home, 'bob', 'proj');
  await clone(remote, laptop, 'Alice', 'Alice@Example.com');
  await clone(remote, desktop, 'Alice', 'alice@example.com');
  await clone(remote, bob, 'Bob', 'bob@example.com');
});

describe('sync between your own devices', () => {
  it('gives every device the full history, without touching the checked-out branch', async () => {
    const a = (await createCheckpoint(ctxOn(laptop), { goal: 'Bump the version' })).checkpoint.id;
    const b = (await createCheckpoint(ctxOn(laptop), { goal: 'Write release notes' })).checkpoint.id;
    await expect(runSync(ctxOn(laptop))).rejects.toThrow(/Confirmation needed/); // not a TTY
    const up = await runSync(ctxOn(laptop), { yes: true });
    expect(up).toMatchObject({ remote: 'origin', pushed: true, received: [] });
    expect(up.shared.sort()).toEqual([a, b].sort());

    const down = await runSync(ctxOn(desktop), { yes: true });
    expect(down.received.sort()).toEqual([a, b].sort());
    expect(await ids(desktop)).toEqual([a, b].sort());

    // Work saved on the desktop while offline is merged with the remote on the next sync.
    const c = (await createCheckpoint(ctxOn(desktop), { goal: 'Fix the build' })).checkpoint.id;
    expect((await runSync(ctxOn(desktop), { remote: 'nowhere', yes: true })).notes[0]).toMatch(/only saved to the local/);
    expect((await runSync(ctxOn(desktop), { yes: true })).pushed).toBe(true);
    expect((await runSync(ctxOn(laptop), { yes: true })).received).toEqual([c]);
    expect(await ids(laptop)).toEqual([a, b, c].sort());

    for (const dir of [laptop, desktop]) {
      expect(await git(dir, 'status', '--porcelain')).toBe('');
      expect((await git(dir, 'branch', '--show-current')).trim()).toBe('main');
    }
  });
});

describe('send and inbox', () => {
  it('delivers a checkpoint, with its changes, to the inbox of the person it was sent to', async () => {
    fs.writeFileSync(path.join(laptop, 'app.js'), 'export const version = 2;\n');
    const { checkpoint } = await createCheckpoint(ctxOn(laptop), { goal: 'Bump the version', to: 'codex' });
    await expect(runSend(ctxOn(laptop), undefined, { to: ['not-an-email'], yes: true })).rejects.toThrow(/not an email/);

    const sent = await runSend(ctxOn(laptop), undefined, { to: ['Bob@Example.com'], withChanges: true, note: 'tests still fail', yes: true });
    expect(sent).toMatchObject({ checkpointId: checkpoint.id, to: ['bob@example.com'], pushed: true, changedFiles: ['app.js'] });

    const inbox = await runInbox(ctxOn(bob));
    expect(inbox.received).toEqual([checkpoint.id]);
    expect(inbox.items).toEqual([
      expect.objectContaining({
        checkpointId: checkpoint.id,
        from: { name: 'Alice', email: 'alice@example.com' },
        note: 'tests still fail',
        goal: 'Bump the version',
        targetProvider: 'codex',
        carriesChanges: true,
      }),
    ]);
    await runImport(ctxOn(bob), checkpoint.id.slice(0, 20), { applyChanges: true });
    expect(read(path.join(bob, 'app.js'))).toBe('export const version = 2;\n');

    expect((await runInbox(ctxOn(desktop))).items).toEqual([]); // sent to Bob, not to Alice
    expect((await runInbox(ctxOn(desktop), { sent: true })).items.map((i) => i.to)).toEqual([['bob@example.com']]);
  });
});
