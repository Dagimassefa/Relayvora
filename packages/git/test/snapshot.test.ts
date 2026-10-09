import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectGitSnapshot, git, parseNumstatZ, splitPatches } from '../src/index.js';

async function sh(cwd: string, ...args: string[]) {
  const r = await git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function newRepo(): Promise<string> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar snap ñ-')));
  await sh(dir, 'init', '-q', '-b', 'main');
  await sh(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

const write = (dir: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

describe('parseNumstatZ / splitPatches', () => {
  it('parses plain, binary and renamed entries', () => {
    expect(parseNumstatZ('3\t1\tsrc/a b.ts\0-\t-\timg.png\0' + '0\t0\t\0old.ts\0new.ts\0')).toEqual([
      { path: 'src/a b.ts', added: 3, deleted: 1, binary: false },
      { path: 'img.png', added: null, deleted: null, binary: true },
      { path: 'new.ts', origPath: 'old.ts', added: 0, deleted: 0, binary: false },
    ]);
  });
  it('splits a multi-file diff on file headers only', () => {
    const diff = 'diff --git a/x b/x\n+diff --git inside content\ndiff --git a/y b/y\n+y\n';
    expect(splitPatches(diff)).toEqual(['diff --git a/x b/x\n+diff --git inside content\n', 'diff --git a/y b/y\n+y\n']);
  });
});

describe('collectGitSnapshot', () => {
  it('captures patches, line counts, untracked contents and omissions', async () => {
    const dir = await newRepo();
    write(dir, 'src/date.ts', 'export const a = 1;\n');
    write(dir, 'src/old name.ts', 'x\n');
    write(dir, 'img.bin', Buffer.from([0, 1, 2, 3]));
    write(dir, '.env', 'A=1\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-q', '-m', 'init');

    write(dir, 'src/date.ts', 'export const a = 2;\nexport const b = 3;\n');
    await sh(dir, 'mv', 'src/old name.ts', 'src/new name.ts');
    write(dir, 'img.bin', Buffer.from([0, 9, 9, 9]));
    write(dir, '.env', 'A=secret\n');
    write(dir, 'docs/résumé.md', '# CV\nline\n');
    write(dir, 'data.bin', Buffer.from([0, 0, 0]));
    write(dir, '.env.local', 'TOKEN=x\n');

    const snap = await collectGitSnapshot(dir);
    expect(snap.warnings).toEqual([]);
    expect(snap.base).toMatch(/^[0-9a-f]{40}$/);
    const f = Object.fromEntries(snap.files.map((x) => [x.path, x]));

    expect(f['src/date.ts']).toMatchObject({ kind: 'modified', linesAdded: 2, linesDeleted: 1, truncated: false });
    expect(f['src/date.ts']!.patch).toContain('+export const b = 3;');
    expect(f['src/date.ts']!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f['src/new name.ts']).toMatchObject({ kind: 'renamed', origPath: 'src/old name.ts' });
    expect(f['img.bin']).toMatchObject({ binary: true, patch: null, omittedReason: 'binary' });
    expect(f['.env']).toMatchObject({ patch: null, omittedReason: 'sensitive' });
    expect(f['docs/résumé.md']).toMatchObject({ kind: 'untracked', content: '# CV\nline\n', linesAdded: 2 });
    expect(f['data.bin']).toMatchObject({ content: null, omittedReason: 'binary' });
    expect(f['.env.local']).toMatchObject({ content: null, omittedReason: 'sensitive' });
  });

  it('truncates long patches but hashes the full one', async () => {
    const dir = await newRepo();
    write(dir, 'big.txt', 'start\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-q', '-m', 'init');
    write(dir, 'big.txt', Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'));

    const snap = await collectGitSnapshot(dir, { maxPatchBytes: 1000 });
    const big = snap.files[0]!;
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.patch!)).toBeLessThanOrEqual(1000);
    expect(big.linesAdded).toBe(2000);
  });

  it('works in a repository without commits', async () => {
    const dir = await newRepo();
    write(dir, 'a.txt', 'hello\n');
    await sh(dir, 'add', 'a.txt');
    write(dir, 'b.txt', 'untracked\n');

    const snap = await collectGitSnapshot(dir);
    expect(snap.head).toBeNull();
    expect(snap.base).toBeNull();
    const f = Object.fromEntries(snap.files.map((x) => [x.path, x]));
    expect(f['a.txt']).toMatchObject({ kind: 'added', linesAdded: 1 });
    expect(f['a.txt']!.patch).toContain('+hello');
    expect(f['b.txt']).toMatchObject({ kind: 'untracked', content: 'untracked\n' });
  });

  it.skipIf(process.platform === 'win32')('does not follow untracked symlinks', async () => {
    const dir = await newRepo();
    fs.symlinkSync(os.homedir(), path.join(dir, 'home-link'));
    const snap = await collectGitSnapshot(dir);
    expect(snap.files.find((f) => f.path === 'home-link')).toMatchObject({ content: null, omittedReason: 'symlink' });
  });
});
