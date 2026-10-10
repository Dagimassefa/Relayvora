import fs from 'node:fs';
import path from 'node:path';
import { findExecutable } from './platform.js';

export interface DetectedCheck {
  /** Command line, ready for parseCommandLine (no shell syntax). */
  command: string;
  /** Where it came from, e.g. `package.json "lint" script`. */
  source: string;
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  /** Maximum number of commands; checks are ordered fastest-feedback first. */
  max?: number;
}

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

function packageManager(root: string, declared: unknown): PackageManager {
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

// Script names per kind, in preference order. Combined scripts like "check" are skipped on purpose:
// separate commands give separate pass/fail evidence.
const SCRIPT_KINDS: Array<[string, string[]]> = [
  ['typecheck', ['typecheck', 'type-check', 'types', 'tsc']],
  ['lint', ['lint']],
  ['test', ['test', 'test:unit', 'test:ci']],
];

/** Scripts that would never finish or never test anything. */
function unusable(body: string): boolean {
  return /no test specified/i.test(body) || /(^|\s)--watch\b|(^|\s)watch(\s|$)/.test(body);
}

function detectNode(root: string, env: NodeJS.ProcessEnv): DetectedCheck[] {
  const text = readText(path.join(root, 'package.json'));
  if (!text) return [];
  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = pkg.scripts ?? {};
  const pm = packageManager(root, pkg.packageManager);
  if (!findExecutable(pm, env)) return [];
  const found: DetectedCheck[] = [];
  for (const [, names] of SCRIPT_KINDS) {
    const name = names.find((n) => typeof scripts[n] === 'string' && !unusable(scripts[n] as string));
    if (name) found.push({ command: `${pm} run ${name}`, source: `package.json "${name}" script` });
  }
  return found;
}

function detectPython(root: string, env: NodeJS.ProcessEnv): DetectedCheck[] {
  const pyproject = readText(path.join(root, 'pyproject.toml')) ?? '';
  const found: DetectedCheck[] = [];
  if (/^\[tool\.ruff/m.test(pyproject) && findExecutable('ruff', env)) {
    found.push({ command: 'ruff check .', source: 'pyproject.toml [tool.ruff]' });
  }
  const hasPytestConfig =
    /^\[tool\.pytest/m.test(pyproject) || fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'conftest.py'));
  const hasTestsDir = fs.existsSync(path.join(root, 'tests'));
  if ((hasPytestConfig || hasTestsDir) && findExecutable('pytest', env)) {
    found.push({ command: 'pytest -q', source: hasPytestConfig ? 'pytest configuration' : 'tests/ directory' });
  }
  return found;
}

function detectGo(root: string, env: NodeJS.ProcessEnv): DetectedCheck[] {
  if (!fs.existsSync(path.join(root, 'go.mod')) || !findExecutable('go', env)) return [];
  return [
    { command: 'go vet ./...', source: 'go.mod' },
    { command: 'go test ./...', source: 'go.mod' },
  ];
}

function detectRust(root: string, env: NodeJS.ProcessEnv): DetectedCheck[] {
  if (!fs.existsSync(path.join(root, 'Cargo.toml')) || !findExecutable('cargo', env)) return [];
  return [{ command: 'cargo test', source: 'Cargo.toml' }];
}

function detectMake(root: string, env: NodeJS.ProcessEnv): DetectedCheck[] {
  const makefile = readText(path.join(root, 'Makefile'));
  if (!makefile || !/^test\s*:/m.test(makefile) || !findExecutable('make', env)) return [];
  return [{ command: 'make test', source: 'Makefile "test" target' }];
}

/**
 * Finds the project's own verification commands from its manifests. Only commands whose tool is
 * installed are returned. A Makefile target is used only when nothing more specific exists.
 */
export function detectVerifyCommands(root: string, options: DetectOptions = {}): DetectedCheck[] {
  const env = options.env ?? process.env;
  const found = [...detectNode(root, env), ...detectPython(root, env), ...detectGo(root, env), ...detectRust(root, env)];
  const all = found.length > 0 ? found : detectMake(root, env);
  return all.slice(0, options.max ?? 4);
}
