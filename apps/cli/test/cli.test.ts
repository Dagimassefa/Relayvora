import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { runInit } from '../src/commands/init.js';
import { runSessions } from '../src/commands/sessions.js';
import { createContext } from '../src/context.js';
import { main } from '../src/program.js';
import { runCommand } from '@agentrelay/core';

let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar cli ✓-')));
  project = path.join(home, 'my project');
  fs.mkdirSync(project);
  await runCommand('git', ['init', '-q', project]);
  env = {
    ...process.env,
    AGENTRELAY_HOME: path.join(home, 'state'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CODEX_HOME: path.join(home, 'codex'),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const ctx = (cwd = project) => createContext({ cwd, env });

describe('init', () => {
  it('creates an ignored .agentrelay dir and is idempotent', async () => {
    const first = await runInit(ctx());
    expect(first).toMatchObject({ isGitRepo: true, createdConfig: true, warnings: [] });
    expect(path.resolve(first.root)).toBe(path.resolve(project));
    expect(fs.readFileSync(path.join(project, '.agentrelay', '.gitignore'), 'utf8')).toBe('*\n');

    // Running from a subdirectory resolves to the same project.
    fs.mkdirSync(path.join(project, 'src'));
    const second = await runInit(ctx(path.join(project, 'src')));
    expect(second.createdConfig).toBe(false);
    expect(second.projectId).toBe(first.projectId);

    const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project });
    expect(status.stdout).toBe('');
  });

  it('warns outside a Git repository', async () => {
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain);
    expect((await runInit(ctx(plain))).warnings[0]).toMatch(/Not inside a Git repository/);
  });
});

describe('doctor', () => {
  it('reports per-check status and passes on a healthy setup', async () => {
    const report = await runDoctor(ctx());
    const ids = report.checks.map((c) => c.id);
    expect(ids).toEqual(['node', 'platform', 'git', 'store', 'project', 'adapter:claude', 'adapter:codex']);
    expect(report.checks.find((c) => c.id === 'project')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

describe('sessions', () => {
  it('lists only sessions for the current project unless --all', async () => {
    const dir = path.join(home, 'claude', 'projects', 'x');
    fs.mkdirSync(dir, { recursive: true });
    const rec = (id: string, cwd: string) => JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: '2026-10-01T00:00:00Z' });
    fs.writeFileSync(path.join(dir, 'a.jsonl'), rec('mine', project) + '\n');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), rec('other', path.join(home, 'elsewhere')) + '\n');

    const scoped = await runSessions(ctx(), { provider: 'claude' });
    expect(scoped.providers[0]!.sessions.map((s) => s.id)).toEqual(['mine']);
    const all = await runSessions(ctx(), { provider: 'claude', all: true });
    expect(all.providers[0]!.sessions).toHaveLength(2);
  });
});

describe('main', () => {
  const run = async (...args: string[]) => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['node', 'agentrelay', '--cwd', project, ...args]);
    vi.restoreAllMocks();
    return { code, stdout };
  };

  it('returns usage exit code and a JSON error for an unknown provider', async () => {
    const { code, stdout } = await run('--json', 'sessions', '--provider', 'nope');
    expect(code).toBe(2);
    expect(JSON.parse(stdout).error.message).toMatch(/Unknown provider/);
  });

  it('rejects an invalid --limit with the usage exit code', async () => {
    expect((await run('sessions', '--limit', 'abc')).code).toBe(2);
  });

  it('prints help with exit code 0', async () => {
    expect((await run('--help')).code).toBe(0);
  });
});
