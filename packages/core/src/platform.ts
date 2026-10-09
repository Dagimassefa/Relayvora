import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type OsFamily = 'windows' | 'macos' | 'linux' | 'other';

export interface PlatformInfo {
  os: OsFamily;
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  isWsl: boolean;
  nodeVersion: string;
  homeDir: string;
}

export function osFamily(platform: NodeJS.Platform = process.platform): OsFamily {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'other';
  }
}

/** WSL is a distinct environment: Linux paths, but Windows-side agents and sessions are not visible by default. */
export function detectWsl(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function detectPlatform(env: NodeJS.ProcessEnv = process.env): PlatformInfo {
  return {
    os: osFamily(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    isWsl: detectWsl(process.platform, env),
    nodeVersion: process.versions.node,
    homeDir: os.homedir(),
  };
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Per-user directory for AgentRelay's global state (SQLite store, logs).
 * `AGENTRELAY_HOME` overrides the platform default.
 */
export function dataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const p = pathApi(platform);
  if (env.AGENTRELAY_HOME) return p.resolve(env.AGENTRELAY_HOME);
  switch (platform) {
    case 'win32':
      return p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'agentrelay');
    case 'darwin':
      return p.join(home, 'Library', 'Application Support', 'agentrelay');
    default:
      return p.join(env.XDG_DATA_HOME ?? p.join(home, '.local', 'share'), 'agentrelay');
  }
}

/** Windows and default macOS volumes are case-insensitive; compare accordingly but never rewrite the original case. */
function comparable(p: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(p);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/** True when `child` is `root` or inside it. Purely lexical; resolve symlinks first when that matters. */
export function isWithin(root: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const rel = pathApi(platform).relative(comparable(root, platform), comparable(child, platform));
  return rel === '' || (!rel.startsWith('..') && !pathApi(platform).isAbsolute(rel));
}

/** Finds an executable on PATH, honouring PATHEXT on Windows. Returns the absolute path or undefined. */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const p = pathApi(platform);
  const isWindows = platform === 'win32';
  const envGet = (key: string) =>
    isWindows ? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] : env[key];

  const candidates = (base: string): string[] => {
    if (!isWindows) return [base];
    const exts = (envGet('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const hasExt = exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()));
    return hasExt ? [base] : exts.map((e) => base + e.toLowerCase());
  };

  const isExecutableFile = (file: string): boolean => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (name.includes('/') || (isWindows && name.includes('\\'))) {
    return candidates(p.resolve(name)).find(isExecutableFile);
  }

  const dirs = (envGet('PATH') ?? '').split(isWindows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const found = candidates(p.join(dir.replace(/^"(.*)"$/, '$1'), name)).find(isExecutableFile);
    if (found) return found;
  }
  return undefined;
}
