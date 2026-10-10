import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectVerifyCommands } from '../src/detect.js';

const isWin = process.platform === 'win32';

/** A PATH containing only fake executables with these names. */
function fakePath(...names: string[]): NodeJS.ProcessEnv {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ar bin '));
  for (const name of names) {
    const file = path.join(bin, isWin ? `${name}.cmd` : name);
    fs.writeFileSync(file, isWin ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  }
  return { PATH: bin, PATHEXT: '.CMD;.EXE' };
}

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar detect '));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: 'x', scripts, ...extra });

describe('detectVerifyCommands', () => {
  it('finds typecheck, lint and test scripts in that order, with the lockfile package manager', () => {
    const dir = project({
      'package.json': pkg({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', check: 'pnpm lint && pnpm test' }),
      'pnpm-lock.yaml': '',
    });
    expect(detectVerifyCommands(dir, { env: fakePath('pnpm') }).map((c) => c.command)).toEqual([
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run test',
    ]);
  });

  it('honours the packageManager field and alternative script names', () => {
    const dir = project({ 'package.json': pkg({ 'type-check': 'tsc', 'test:unit': 'jest' }, { packageManager: 'yarn@4.1.0' }) });
    expect(detectVerifyCommands(dir, { env: fakePath('yarn') }).map((c) => c.command)).toEqual(['yarn run type-check', 'yarn run test:unit']);
  });

  it("skips npm's placeholder test and watch-mode scripts", () => {
    const dir = project({
      'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', lint: 'eslint . --watch' }),
    });
    expect(detectVerifyCommands(dir, { env: fakePath('npm') })).toEqual([]);
  });

  it('returns nothing when the package manager is not installed', () => {
    const dir = project({ 'package.json': pkg({ test: 'vitest run' }), 'pnpm-lock.yaml': '' });
    expect(detectVerifyCommands(dir, { env: fakePath('npm') })).toEqual([]);
  });

  it('detects Python, Go and Rust projects when their tools are installed', () => {
    const py = project({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n', 'tests/test_a.py': '' });
    expect(detectVerifyCommands(py, { env: fakePath('ruff', 'pytest') }).map((c) => c.command)).toEqual(['ruff check .', 'pytest -q']);
    expect(detectVerifyCommands(py, { env: fakePath() })).toEqual([]);

    const go = project({ 'go.mod': 'module x\n' });
    expect(detectVerifyCommands(go, { env: fakePath('go') }).map((c) => c.command)).toEqual(['go vet ./...', 'go test ./...']);

    const rust = project({ 'Cargo.toml': '[package]\n' });
    expect(detectVerifyCommands(rust, { env: fakePath('cargo') }).map((c) => c.command)).toEqual(['cargo test']);
  });

  it('falls back to a Makefile test target only when nothing more specific exists', () => {
    const dir = project({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./run-tests\n' });
    expect(detectVerifyCommands(dir, { env: fakePath('make') }).map((c) => c.command)).toEqual(['make test']);
    const both = project({ Makefile: 'test:\n\techo\n', 'go.mod': 'module x\n' });
    expect(detectVerifyCommands(both, { env: fakePath('make', 'go') }).map((c) => c.command)).not.toContain('make test');
  });
});
