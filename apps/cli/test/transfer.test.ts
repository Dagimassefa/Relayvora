import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '@relayvora/core';
import { captureChanges } from '../src/changes.js';
import { createCheckpoint, loadCheckpoint } from '../src/checkpoint-service.js';
import { runExport } from '../src/commands/export.js';
import { runImport } from '../src/commands/import.js';
import { createContext } from '../src/context.js';
import { handoffPath } from '../src/project.js';

// Two "machines": separate clones of one remote, each with its own Relayvora store.
let home: string;
let laptop: string;
let desktop: string;

const git = async (cwd: string, ...args: string[]) => {
  const r = await runCommand('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr);
  return r.stdout;
};
const ctxOn = (cwd: string, machine: string) =>
  createContext({ cwd, env: { ...process.env, RELAYVORA_HOME: path.join(home, machine, 'state'), CODEX_HOME: path.join(home, machine, 'codex') } });
// Git for Windows may check files out with CRLF (core.autocrlf); compare content, not line endings.
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar transfer ')));
  const remote = path.join(home, 'remote.git');
  await git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  laptop = path.join(home, 'laptop', 'proj');
  desktop = path.join(home, 'desktop', 'proj');
  fs.mkdirSync(path.join(laptop, 'src'), { recursive: true });
  await git(laptop, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(laptop, 'src', 'date.js'), 'export const isLeap = (y) => y % 4 === 0;\n');
  await git(laptop, 'add', '-A');
  await git(laptop, 'commit', '-q', '-m', 'init');
  await git(laptop, 'remote', 'add', 'origin', remote);
  await git(laptop, 'push', '-q', 'origin', 'main');
  await git(home, 'clone', '-q', remote, desktop);
});

describe('export and import between machines', () => {
  it('moves a checkpoint, with the handoff edits, onto the other clone', async () => {
    fs.writeFileSync(path.join(laptop, 'src', 'date.js'), 'export const isLeap = (y) => y % 4 === 0 && y % 100 !== 0;\n');
    const { checkpoint, handoffFile } = await createCheckpoint(ctxOn(laptop, 'a'), { goal: 'Fix leap years', to: 'codex' });
    fs.appendFileSync(handoffFile, '\nAlso keep the public API unchanged.\n');

    const file = path.join(home, 'handoff.json');
    const exported = await runExport(ctxOn(laptop, 'a'), undefined, { out: file, yes: true });
    expect(exported).toMatchObject({ checkpointId: checkpoint.id, format: 'json', editedHandoff: true, changedFiles: [] });
    expect(exported.notes[0]).toMatch(/1 file\(s\) had uncommitted changes.*--with-changes/);

    const imported = await runImport(ctxOn(desktop, 'b'), file);
    expect(imported).toMatchObject({ checkpointId: checkpoint.id, alreadyImported: false, changes: null, targetProvider: 'codex' });
    expect(imported.originalRoot).toBe(checkpoint.project.root);
    expect(imported.notes).toEqual([expect.stringMatching(/not in this export \(src\/date\.js\).*--with-changes/)]);

    const local = await loadCheckpoint(ctxOn(desktop, 'b'), checkpoint.id);
    expect(local.project.root).toBe(imported.projectRoot);
    const text = fs.readFileSync(handoffPath(imported.projectRoot, checkpoint.id), 'utf8');
    expect(text).toContain(`Root: \`${imported.projectRoot}\``);
    expect(text).not.toContain(checkpoint.project.root);
    expect(text).toContain('Also keep the public API unchanged.');

    expect((await runImport(ctxOn(desktop, 'b'), file)).alreadyImported).toBe(true);
    expect((await runImport(ctxOn(desktop, 'b'), file, { force: true })).alreadyImported).toBe(false);
  });

  it('says when the commit the work sits on has not been pushed', async () => {
    fs.writeFileSync(path.join(laptop, 'src', 'b.js'), 'export const b = 1;\n');
    await git(laptop, 'add', '-A');
    await git(laptop, 'commit', '-q', '-m', 'local only');
    await createCheckpoint(ctxOn(laptop, 'a'), { goal: 'Add b' });
    const file = path.join(home, 'h.json');
    await runExport(ctxOn(laptop, 'a'), undefined, { out: file, yes: true });
    expect((await runImport(ctxOn(desktop, 'b'), file)).notes).toEqual([expect.stringMatching(/is not in this clone yet.*git pull/)]);
  });

  it('carries uncommitted work, untracked files included, without touching the index or secrets', async () => {
    fs.writeFileSync(path.join(laptop, 'src', 'date.js'), 'export const isLeap = (y) => y % 4 === 0 && y % 100 !== 0;\n');
    fs.writeFileSync(path.join(laptop, 'src', 'century.js'), 'export const century = (y) => Math.ceil(y / 100);\n');
    fs.writeFileSync(path.join(laptop, '.env'), 'PORT=3000\n');
    await git(laptop, 'add', 'src/century.js');
    const staged = await git(laptop, 'diff', '--cached', '--name-only');
    await createCheckpoint(ctxOn(laptop, 'a'), { goal: 'Fix leap years' });

    const file = path.join(home, 'with-changes.json');
    const exported = await runExport(ctxOn(laptop, 'a'), undefined, { out: file, yes: true, withChanges: true });
    expect(exported.changedFiles.sort()).toEqual(['src/century.js', 'src/date.js']);
    expect(exported.notes).toEqual([expect.stringMatching(/Left out sensitive file\(s\): \.env/)]);
    expect(await git(laptop, 'diff', '--cached', '--name-only')).toBe(staged);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).format).toBe('relayvora-export');

    const saved = await runImport(ctxOn(desktop, 'b'), file);
    expect(saved.changes).toMatchObject({ applied: false });
    expect(fs.existsSync(saved.changes!.patchFile)).toBe(true);
    expect(saved.notes.at(-1)).toMatch(/--apply-changes/);
    expect(fs.existsSync(path.join(desktop, 'src', 'century.js'))).toBe(false);

    const applied = await runImport(ctxOn(desktop, 'b'), file, { applyChanges: true });
    expect(applied.changes).toMatchObject({ applied: true });
    expect(read(desktop, 'src/date.js')).toBe(read(laptop, 'src/date.js'));
    expect(read(desktop, 'src/century.js')).toBe(read(laptop, 'src/century.js'));
    expect(fs.existsSync(path.join(desktop, '.env'))).toBe(false);
  });

  it('applies changes only on the commit they were made on', async () => {
    fs.writeFileSync(path.join(laptop, 'src', 'date.js'), 'export const isLeap = () => true;\n');
    await createCheckpoint(ctxOn(laptop, 'a'), { goal: 'Change isLeap' });
    const file = path.join(home, 'c.json');
    await runExport(ctxOn(laptop, 'a'), undefined, { out: file, yes: true, withChanges: true });

    fs.writeFileSync(path.join(desktop, 'README.md'), 'hi\n');
    await git(desktop, 'add', '-A');
    await git(desktop, 'commit', '-q', '-m', 'other work');
    await expect(runImport(ctxOn(desktop, 'b'), file, { applyChanges: true })).rejects.toThrow(/made on top of commit/);
    expect(read(desktop, 'src/date.js')).toBe('export const isLeap = (y) => y % 4 === 0;\n');
  });

  it('refuses to carry changes that look like secrets, and rejects files that are not exports', async () => {
    fs.writeFileSync(path.join(laptop, 'src', 'config.js'), `export const API_TOKEN = "ghp_${'a'.repeat(36)}";\n`);
    await expect(captureChanges(laptop)).rejects.toThrow(/look like they contain secrets/);

    const md = path.join(home, 'handoff.md');
    fs.writeFileSync(md, '# Handoff for codex: something\n');
    await expect(runImport(ctxOn(desktop, 'b'), md)).rejects.toThrow(/Markdown handoff/);
  });
});
