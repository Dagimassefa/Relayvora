import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectCommitsSince, git, resolveSince } from '../src/index.js';

async function sh(cwd: string, ...args: string[]) {
  const r = await git(cwd, ['-c', 'commit.gpgsign=false', ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function commit(dir: string, file: string, content: string, opts: { email?: string; date?: string; message: string }) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await sh(dir, 'add', '-A');
  // Dates go through the environment because `--since` filters on the committer date.
  if (opts.date) process.env.GIT_COMMITTER_DATE = process.env.GIT_AUTHOR_DATE = opts.date;
  try {
    await sh(dir, '-c', `user.name=${opts.email ?? 'Me'}`, '-c', `user.email=${opts.email ?? 'me@example.com'}`, 'commit', '-q', '-m', opts.message);
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
    delete process.env.GIT_AUTHOR_DATE;
  }
}

async function repo(): Promise<string> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar commits ')));
  await sh(dir, 'init', '-q', '-b', 'main');
  await sh(dir, 'config', 'user.email', 'me@example.com');
  await sh(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

afterEach(() => {
  delete process.env.GIT_COMMITTER_DATE;
  delete process.env.GIT_AUTHOR_DATE;
});

describe('collectCommitsSince', () => {
  it('returns your commits since the session start, oldest first, with stats and patches', async () => {
    const dir = await repo();
    await commit(dir, 'old.ts', 'old\n', { message: 'before the session', date: '2020-01-01T00:00:00Z' });
    await commit(dir, 'src/a.ts', 'export const a = 1;\n', { message: 'feat: add a' });
    await commit(dir, 'src/b.ts', 'export const b = 2;\nexport const c = 3;\n', { message: 'feat: add b' });
    await commit(dir, 'theirs.ts', 'x\n', { message: 'someone else', email: 'other@example.com' });

    const result = await collectCommitsSince(dir, '2024-01-01T00:00:00Z');
    expect(result.author).toBe('me@example.com');
    expect(result.commits.map((c) => c.subject)).toEqual(['feat: add a', 'feat: add b']);
    const b = result.commits[1]!;
    expect(b).toMatchObject({ filesChanged: 1, linesAdded: 2, linesDeleted: 0, truncated: false, withheldFiles: [] });
    expect(b.patch).toContain('+export const c = 3;');
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.shortSha).toBe(b.sha.slice(0, b.shortSha.length));
  });

  it('can include every author', async () => {
    const dir = await repo();
    await commit(dir, 'a.ts', 'a\n', { message: 'mine' });
    await commit(dir, 'b.ts', 'b\n', { message: 'theirs', email: 'other@example.com' });
    const result = await collectCommitsSince(dir, '2024-01-01', { author: null });
    expect(result.commits.map((c) => c.subject)).toEqual(['mine', 'theirs']);
  });

  it('withholds patches of sensitive files but still counts them', async () => {
    const dir = await repo();
    fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=supersecret\n');
    await commit(dir, 'app.ts', 'export {};\n', { message: 'feat: config' });
    const [c] = (await collectCommitsSince(dir, '2024-01-01')).commits;
    expect(c!.withheldFiles).toEqual(['.env']);
    expect(c!.filesChanged).toBe(2);
    expect(c!.patch).toContain('app.ts');
    expect(c!.patch).not.toContain('supersecret');
  });

  it('caps the number of commits, keeping the newest', async () => {
    const dir = await repo();
    for (let i = 1; i <= 4; i++) await commit(dir, `f${i}.ts`, `${i}\n`, { message: `c${i}` });
    const result = await collectCommitsSince(dir, '2024-01-01', { maxCommits: 2 });
    expect(result.commits.map((c) => c.subject)).toEqual(['c3', 'c4']);
    expect(result.warnings.join()).toMatch(/only the newest 2/);
  });

  it('treats a repository without commits as having none', async () => {
    const dir = await repo();
    expect((await collectCommitsSince(dir, '2024-01-01')).commits).toEqual([]);
  });
});

describe('resolveSince', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('turns short durations into ISO times and passes other values through', () => {
    expect(resolveSince('2h', now)).toBe('2026-10-10T10:00:00.000Z');
    expect(resolveSince('30m', now)).toBe('2026-10-10T11:30:00.000Z');
    expect(resolveSince('1d', now)).toBe('2026-10-09T12:00:00.000Z');
    expect(resolveSince('2026-10-01', now)).toBe('2026-10-01');
    expect(resolveSince('yesterday', now)).toBe('yesterday');
  });
});
