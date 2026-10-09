import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../src/adapter.js';
import { finalizeSessions } from '../src/discovery.js';
import { canonicalPath } from '../src/platform.js';

const isWin = process.platform === 'win32';

function session(id: string, cwd: string | null): SessionSummary {
  return { provider: 'test', id, path: `/s/${id}.jsonl`, cwd, startedAt: null, updatedAt: '2026-10-01T00:00:00Z', sizeBytes: 1 };
}

/** The 8.3 short form of a Windows path, or null when the volume does not generate short names. */
function shortName(p: string): string | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder($args[0]).ShortPath`, p],
      { encoding: 'utf8' },
    ).trim();
    return out && out !== p ? out : null;
  } catch {
    return null;
  }
}

describe('canonicalPath', () => {
  const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar canon ')));

  it('keeps a missing tail but canonicalises the existing ancestor', () => {
    const missing = path.join(real, 'gone', 'deeper');
    expect(canonicalPath(missing)).toBe(missing);
  });

  it.runIf(isWin || process.platform === 'darwin')('normalises case on case-insensitive volumes', () => {
    expect(canonicalPath(real.toUpperCase())).toBe(real);
  });

  it.runIf(isWin)('expands 8.3 short names (as on GitHub-hosted Windows runners)', () => {
    const dir = path.join(real, 'Long Directory Name');
    fs.mkdirSync(dir);
    const short = shortName(dir);
    if (!short) return; // short-name generation disabled on this volume
    expect(canonicalPath(short)).toBe(dir);
  });

  it.runIf(!isWin)('resolves symlinks', () => {
    const link = path.join(os.tmpdir(), `ar-link-${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(real, link);
    expect(canonicalPath(path.join(link, 'x'))).toBe(path.join(real, 'x'));
  });
});

describe('finalizeSessions project filter', () => {
  it('matches a session whose cwd spells the project path differently', () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar proj ')));
    const variants: string[] = [];
    if (isWin) {
      variants.push(project.toUpperCase());
      const short = shortName(project);
      if (short) variants.push(short);
    } else {
      const link = path.join(os.tmpdir(), `ar-proj-link-${process.pid}`);
      fs.rmSync(link, { force: true });
      fs.symlinkSync(project, link);
      variants.push(link);
    }
    for (const cwd of variants) {
      const kept = finalizeSessions([session('mine', path.join(cwd, 'sub')), session('other', os.homedir())], {
        projectRoot: project,
      });
      expect(kept.map((s) => s.id), cwd).toEqual(['mine']);
    }
  });
});
