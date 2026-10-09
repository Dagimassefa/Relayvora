import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '@agentrelay/core';
import { createCheckpoint } from '../src/checkpoint-service.js';
import { runCheckpointList, runCheckpointShow } from '../src/commands/checkpoint.js';
import { runExport } from '../src/commands/export.js';
import { createContext } from '../src/context.js';
import { main } from '../src/program.js';

let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

const git = async (...args: string[]) => {
  const r = await runCommand('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: project });
  if (r.exitCode !== 0) throw new Error(r.stderr);
};

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar cp ✓-')));
  project = path.join(home, 'my project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  await git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'src', 'date.js'), 'export const isLeap = (y) => y % 4 === 0;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(project, 'src', 'date.js'), 'export const isLeap = (y) => y % 4 === 0 && y % 100 !== 0;\n');

  // A Codex session recorded in this project.
  const sessions = path.join(home, 'codex', 'sessions', '2026', '10', '01');
  fs.mkdirSync(sessions, { recursive: true });
  const lines = [
    { timestamp: '2026-10-01T10:00:00Z', type: 'session_meta', payload: { id: '0199aaaa-0000-7000-8000-000000000001', cwd: project } },
    { timestamp: '2026-10-01T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix leap years for centuries' } },
    { timestamp: '2026-10-01T10:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Changed isLeap; not tested.' } },
  ];
  fs.writeFileSync(
    path.join(sessions, 'rollout-2026-10-01T10-00-00-0199aaaa-0000-7000-8000-000000000001.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );

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

const ctx = () => createContext({ cwd: project, env });
const node = (code: string) => `"${process.execPath}" -e "${code}"`;

describe('checkpoint create', () => {
  it('builds a checkpoint from the latest session, Git and a failing verification', async () => {
    const r = await createCheckpoint(ctx(), {
      from: 'codex',
      to: 'claude',
      verify: [node('process.exit(2)')],
    });
    const cp = r.checkpoint;
    expect(cp.source).toMatchObject({ provider: 'codex', sessionId: '0199aaaa-0000-7000-8000-000000000001' });
    expect(cp.task.goal).toMatchObject({ text: 'Fix leap years for centuries', provenance: 'inferred' });
    expect(cp.task.lastAgentReport?.provenance).toBe('agent-reported');
    expect(cp.task.blockers[0]).toMatchObject({ provenance: 'observed', evidenceRefs: ['ev-cmd-1'] });
    expect(cp.project).toMatchObject({ branch: 'main', dirtyFiles: [{ path: 'src/date.js', status: ' M' }] });

    // Handoff file is written for review, inside a Git-ignored directory.
    expect(fs.readFileSync(r.handoffFile, 'utf8')).toBe(cp.handoff.prompt);
    expect(r.handoffFile).toContain(path.join('.agentrelay', 'handoffs'));
    const status = await runCommand('git', ['status', '--porcelain'], { cwd: project });
    expect(status.stdout.trim()).toBe('M src/date.js');
  });

  it('works with no session at all (recovery from repository state)', async () => {
    const r = await createCheckpoint(ctx(), { goal: 'Finish the leap-year fix', pending: ['Add tests'] });
    expect(r.checkpoint.source.provider).toBe('manual');
    expect(r.checkpoint.handoff.prompt).toContain('- [user] Add tests');
    expect(r.checkpoint.warnings.join()).toMatch(/NOT verified/);
  });

  it('records a missing executable as unknown, not as a pass or fail', async () => {
    const r = await createCheckpoint(ctx(), { goal: 'x', verify: ['definitely-not-installed-xyz --run'] });
    expect(r.checkpoint.evidence.find((e) => e.id === 'ev-cmd-1')).toMatchObject({ status: 'unknown', exitCode: null });
  });

  it('fails fast on bad input', async () => {
    await expect(createCheckpoint(ctx(), {})).rejects.toMatchObject({ exitCode: 2 });
    await expect(createCheckpoint(ctx(), { goal: 'x', verify: ['a | b'] })).rejects.toMatchObject({ exitCode: 2 });
    await expect(createCheckpoint(ctx(), { goal: 'x', to: 'nope' })).rejects.toMatchObject({ exitCode: 2 });
    await expect(createCheckpoint(ctx(), { from: 'claude' })).rejects.toMatchObject({ exitCode: 3 });
  });
});

describe('show, list and export', () => {
  it('lists, shows (also by prefix and with a new budget) and exports', async () => {
    const { checkpoint } = await createCheckpoint(ctx(), { goal: 'Fix leap years' });
    const list = await runCheckpointList(ctx(), 10);
    expect(list.checkpoints.map((c) => c.id)).toEqual([checkpoint.id]);

    const shown = await runCheckpointShow(ctx(), checkpoint.id.slice(0, 18), {});
    expect(shown.markdown).toBe(checkpoint.handoff.prompt);
    const smaller = await runCheckpointShow(ctx(), checkpoint.id, { budget: 200 });
    expect(smaller.markdown).not.toBe(checkpoint.handoff.prompt);

    const out = path.join(home, 'export', 'handoff.md');
    await expect(runExport(ctx(), checkpoint.id, { out })).rejects.toThrow(/Confirmation needed/); // stdin is not a TTY
    expect(fs.existsSync(out)).toBe(false);

    const written = await runExport(ctx(), checkpoint.id, { out, yes: true });
    expect(fs.readFileSync(out, 'utf8')).toBe(written.content);
    await expect(runExport(ctx(), checkpoint.id, { out, yes: true })).rejects.toThrow(/--force/);
    await runExport(ctx(), checkpoint.id, { out, yes: true, force: true, format: 'json' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).id).toBe(checkpoint.id);
  });
});

describe('CLI', () => {
  const run = async (...args: string[]) => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.AGENTRELAY_HOME = env.AGENTRELAY_HOME;
    process.env.CODEX_HOME = env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    const code = await main(['node', 'agentrelay', '--cwd', project, ...args]);
    vi.restoreAllMocks();
    return { code, stdout };
  };

  it('handoff --preview prints the Markdown; --json returns it with a summary', async () => {
    const md = await run('handoff', '--from', 'codex', '--to', 'claude', '--preview');
    expect(md.code).toBe(0);
    expect(md.stdout).toMatch(/^# Handoff for claude: Fix leap years for centuries/);

    const json = await run('--json', 'handoff', '--from', 'codex', '--to', 'claude', '--goal', 'Fix it', '--budget', '500');
    const parsed = JSON.parse(json.stdout);
    expect(parsed.handoff.budgetTokens).toBe(500);
    expect(parsed.markdown).toContain('# Handoff for claude: Fix it');
  });

  it('handoff --confirm is refused with the Unsupported exit code', async () => {
    expect((await run('handoff', '--to', 'claude', '--goal', 'x', '--confirm')).code).toBe(4);
  });

  it('repeatable task flags are all recorded', async () => {
    const { stdout } = await run('--json', 'checkpoint', 'create', '--goal', 'g', '--pending', 'a', '--pending', 'b', '--decision', 'use UTC');
    const id = JSON.parse(stdout).id;
    const show = await run('checkpoint', 'show', id, '--format', 'json');
    const cp = JSON.parse(show.stdout);
    expect(cp.task.pending.map((f: { text: string }) => f.text)).toEqual(['a', 'b']);
    expect(cp.decisions[0].text).toBe('use UTC');
  });
});
