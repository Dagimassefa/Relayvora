import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBundledExecutables, platformBinaryCandidates, type BundledBinarySpec } from '../src/editors.js';
import { probeExecutable } from '../src/probe.js';

const isWin = process.platform === 'win32';
const exe = (name: string) => (isWin ? `${name}.exe` : name);

const CLAUDE: BundledBinarySpec = {
  extensionPrefix: 'anthropic.claude-code-',
  candidates: (dir, platform) => [path.join(dir, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude')],
};
const CODEX: BundledBinarySpec = {
  extensionPrefix: 'openai.chatgpt-',
  candidates: (dir, platform, arch) => platformBinaryCandidates(dir, 'bin', 'codex', platform, arch),
};

function fakeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ar home '));
}

/** Places a real runnable binary (a link to node) so `--version` works in the probe. */
function placeBinary(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.linkSync(process.execPath, file);
  } catch {
    fs.copyFileSync(process.execPath, file);
  }
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

describe('findBundledExecutables', () => {
  it('finds extension-bundled binaries across editors, newest version first', () => {
    const home = fakeHome();
    touch(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.9-win32-x64', 'resources', 'native-binary', exe('claude')));
    touch(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.10-win32-x64', 'resources', 'native-binary', exe('claude')));
    touch(path.join(home, '.cursor', 'extensions', 'anthropic.claude-code-1.0.0', 'resources', 'native-binary', exe('claude')));
    fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-3.0.0-broken'), { recursive: true });

    const found = findBundledExecutables(CLAUDE, { home });
    expect(found.map((f) => [f.editor, f.extensionVersion])).toEqual([
      ['VS Code', '2.1.10'],
      ['VS Code', '2.1.9'],
      ['Cursor', '1.0.0'],
    ]);
  });

  it('picks the Codex binary for this platform and architecture', () => {
    const home = fakeHome();
    const ext = path.join(home, '.vscode', 'extensions', 'openai.chatgpt-26.1.0-x');
    touch(path.join(ext, 'bin', 'linux-x86_64', 'codex'));
    touch(path.join(ext, 'bin', 'windows-aarch64', 'codex.exe'));
    touch(path.join(ext, 'bin', 'windows-x86_64', 'codex.exe'));
    touch(path.join(ext, 'bin', 'macos-aarch64', 'codex'));

    const pick = (platform: NodeJS.Platform, arch: string) =>
      path.relative(ext, findBundledExecutables(CODEX, { home, platform, arch })[0]?.path ?? '');
    expect(pick('win32', 'x64')).toBe(path.join('bin', 'windows-x86_64', 'codex.exe'));
    expect(pick('win32', 'arm64')).toBe(path.join('bin', 'windows-aarch64', 'codex.exe'));
    expect(pick('linux', 'x64')).toBe(path.join('bin', 'linux-x86_64', 'codex'));
    expect(pick('darwin', 'arm64')).toBe(path.join('bin', 'macos-aarch64', 'codex'));
  });

  it('returns nothing when no editor has the extension', () => {
    expect(findBundledExecutables(CLAUDE, { home: fakeHome() })).toEqual([]);
  });
});

describe('probeExecutable with editor extensions', () => {
  it('falls back to the extension-bundled binary when nothing is on PATH', async () => {
    const home = fakeHome();
    placeBinary(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.0', 'resources', 'native-binary', exe('claude')));
    const env = { ...process.env, PATH: path.join(home, 'empty-bin'), USERPROFILE: home, HOME: home };

    const probe = await probeExecutable('claude', { env }, CLAUDE);
    expect(probe).toMatchObject({ found: true, source: 'editor-extension', editor: 'VS Code', version: process.version });
  });

  it('reports not found with the extension search mentioned', async () => {
    const home = fakeHome();
    const env = { ...process.env, PATH: path.join(home, 'empty-bin'), USERPROFILE: home, HOME: home };
    expect(await probeExecutable('claude', { env }, CLAUDE)).toEqual({
      found: false,
      error: 'claude not found on PATH or in editor extensions',
    });
  });
});
