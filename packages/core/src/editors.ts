import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Editors whose extensions can bundle an agent CLI. Most people run Claude Code and Codex through
 * these extensions rather than a global install, so the bundled binary is a first-class install.
 */
export const EDITOR_EXTENSION_ROOTS: ReadonlyArray<{ editor: string; dir: string }> = [
  { editor: 'VS Code', dir: '.vscode' },
  { editor: 'VS Code Insiders', dir: '.vscode-insiders' },
  { editor: 'Cursor', dir: '.cursor' },
  { editor: 'Windsurf', dir: '.windsurf' },
  { editor: 'VSCodium', dir: '.vscode-oss' },
  { editor: 'VS Code Server', dir: '.vscode-server' },
];

export interface BundledBinarySpec {
  /** Extension folder prefix, e.g. `anthropic.claude-code-`. The version follows it. */
  extensionPrefix: string;
  /** Returns candidate binary paths inside one extension folder (may list directories). */
  candidates(extensionDir: string, platform: NodeJS.Platform, arch: string): string[];
}

export interface BundledExecutable {
  path: string;
  editor: string;
  extensionVersion: string;
}

export interface BundledSearchOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Home directory honouring the env passed in (USERPROFILE on Windows, HOME elsewhere). */
export function homeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Finds agent binaries bundled in editor extensions, newest extension version first. */
export function findBundledExecutables(spec: BundledBinarySpec, options: BundledSearchOptions = {}): BundledExecutable[] {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? homeDir(options.env, platform);
  const found: BundledExecutable[] = [];

  for (const root of EDITOR_EXTENSION_ROOTS) {
    const extensionsDir = path.join(home, root.dir, 'extensions');
    let entries: string[];
    try {
      entries = fs.readdirSync(extensionsDir);
    } catch {
      continue;
    }
    const matching = entries
      .filter((name) => name.startsWith(spec.extensionPrefix))
      .map((name) => ({ name, version: name.slice(spec.extensionPrefix.length).split('-')[0] ?? '' }))
      .sort((a, b) => compareVersionsDesc(a.version, b.version));
    for (const ext of matching) {
      const binary = spec.candidates(path.join(extensionsDir, ext.name), platform, arch).find(isFile);
      if (binary) found.push({ path: binary, editor: root.editor, extensionVersion: ext.version });
    }
  }
  return found;
}

const PLATFORM_WORDS: Partial<Record<NodeJS.Platform, RegExp>> = {
  win32: /^win/i,
  darwin: /^(mac|darwin|apple)/i,
  linux: /^linux/i,
};
const ARCH_WORDS: Record<string, RegExp> = {
  x64: /(x86_64|x64|amd64)/i,
  arm64: /(aarch64|arm64)/i,
};

/**
 * Candidates `<extensionDir>/<subdir>/<platform-arch dir>/<name>`: lists the platform folders that exist
 * and orders the ones matching the current architecture first. Folder naming varies by vendor and release.
 */
export function platformBinaryCandidates(
  extensionDir: string,
  subdir: string,
  name: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const exe = platform === 'win32' ? `${name}.exe` : name;
  const base = path.join(extensionDir, subdir);
  let dirs: string[];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return [];
  }
  const platformRe = PLATFORM_WORDS[platform];
  const archRe = ARCH_WORDS[arch];
  return dirs
    .filter((d) => (platformRe ? platformRe.test(d) : false))
    .sort((a, b) => Number(archRe?.test(b) ?? 0) - Number(archRe?.test(a) ?? 0))
    .map((d) => path.join(base, d, exe));
}
