import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, getRepoState, git, parsePorcelainZ } from '../src/index.js';

async function sh(cwd: string, ...args: string[]) {
  const r = await git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function newRepo(): Promise<string> {
  // Spaces and non-ASCII characters on purpose: both break naive quoting.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar repo ñ-')));
  await sh(dir, 'init', '-q', '-b', 'main');
  return dir;
}

const write = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

describe('parsePorcelainZ', () => {
  it('parses renames with their original path', () => {
    expect(parsePorcelainZ('R  new.ts\0old.ts\0 M a b.ts\0?? ü.txt\0')).toEqual([
      { path: 'new.ts', status: 'R ', origPath: 'old.ts', kind: 'renamed' },
      { path: 'a b.ts', status: ' M', kind: 'modified' },
      { path: 'ü.txt', status: '??', kind: 'untracked' },
    ]);
  });
  it('classifies conflicts', () => {
    expect(parsePorcelainZ('UU x.ts\0AA y.ts\0').map((e) => e.kind)).toEqual(['conflicted', 'conflicted']);
  });
});

describe('getRepoState', () => {
  it('returns null root outside a repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-norepo-'));
    expect(await findRepoRoot(dir)).toBeNull();
    await expect(getRepoState(dir)).rejects.toMatchObject({ exitCode: 6 });
  });

  it('handles a repository with no commits', async () => {
    const dir = await newRepo();
    const state = await getRepoState(dir);
    expect(state).toMatchObject({ head: null, branch: 'main', detached: false, entries: [] });
  });

  it('reports dirty, untracked, renamed and unicode paths', async () => {
    const dir = await newRepo();
    write(dir, 'src/old name.ts', 'export const a = 1;\n');
    write(dir, 'keep.ts', 'x\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-q', '-m', 'init');

    await sh(dir, 'mv', 'src/old name.ts', 'src/new name.ts');
    write(dir, 'keep.ts', 'changed\n');
    write(dir, 'docs/résumé.md', '# hi\n');

    const state = await getRepoState(path.join(dir, 'src'));
    expect(path.resolve(state.root)).toBe(path.resolve(dir));
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
    expect(state.branch).toBe('main');
    const byPath = Object.fromEntries(state.entries.map((e) => [e.path, e]));
    expect(byPath['src/new name.ts']).toMatchObject({ kind: 'renamed', origPath: 'src/old name.ts' });
    expect(byPath['keep.ts']).toMatchObject({ kind: 'modified', status: ' M' });
    expect(byPath['docs/résumé.md']).toMatchObject({ kind: 'untracked' });
  });

  it('detects detached HEAD and linked worktrees', async () => {
    const dir = await newRepo();
    write(dir, 'a.txt', '1\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-q', '-m', 'one');
    const head = (await sh(dir, 'rev-parse', 'HEAD')).trim();

    await sh(dir, 'checkout', '-q', '--detach', head);
    expect(await getRepoState(dir)).toMatchObject({ head, branch: null, detached: true, linkedWorktree: false });

    const wt = path.join(path.dirname(dir), `${path.basename(dir)} wt`);
    await sh(dir, 'worktree', 'add', '-q', '-b', 'feature', wt);
    expect(await getRepoState(wt)).toMatchObject({ branch: 'feature', linkedWorktree: true });
  });
});
