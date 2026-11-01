import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '@relayvora/core';
import { createContext, type CliContext } from '../src/context.js';
import {
  claudeHooksInstalled,
  codexNotifyStatus,
  installClaudeHooks,
  installCodexNotify,
  uninstallClaudeHooks,
  uninstallCodexNotify,
} from '../src/hooks-install.js';
import { handleHookEvent, parseClaudeHook, parseCodexNotify } from '../src/hooks.js';

const OPTIONS = { everyMinutes: 15, keep: 2, verify: false };
const tmp = (name: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), name)));

describe('hook event parsing', () => {
  const claude = (o: object) => parseClaudeHook(JSON.stringify({ session_id: 's1', cwd: '/p', transcript_path: '/t', ...o }));

  it('maps Claude Code events to triggers', () => {
    expect(claude({ hook_event_name: 'PreCompact', trigger: 'auto' })).toEqual({ agent: 'claude', trigger: 'pre-compact', sessionId: 's1', cwd: '/p' });
    expect(claude({ hook_event_name: 'SessionEnd', reason: 'other' })?.trigger).toBe('session-end');
    expect(claude({ hook_event_name: 'StopFailure' })?.trigger).toBe('limit');
    expect(claude({ hook_event_name: 'Stop', stop_hook_active: false })?.trigger).toBe('turn');
  });

  it('ignores re-entrant Stop events, unknown events and bad input', () => {
    expect(claude({ hook_event_name: 'Stop', stop_hook_active: true })).toBeNull();
    expect(claude({ hook_event_name: 'PreToolUse' })).toBeNull();
    expect(parseClaudeHook('not json')).toBeNull();
    expect(parseClaudeHook(JSON.stringify({ hook_event_name: 'Stop' }))).toBeNull();
  });

  it('reads the Codex notify payload', () => {
    const payload = { type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'u1', cwd: '/p', 'input-messages': [], 'last-assistant-message': 'ok' };
    expect(parseCodexNotify(JSON.stringify(payload))).toEqual({ agent: 'codex', trigger: 'turn', sessionId: 't1', cwd: '/p' });
    expect(parseCodexNotify(JSON.stringify({ ...payload, type: 'other' }))).toBeNull();
  });
});

describe('Claude Code hook installation', () => {
  it('merges with existing settings and hooks, reinstalls cleanly, and uninstalls only its own entries', () => {
    const file = path.join(tmp('ar settings '), '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const theirs = { type: 'command', command: 'echo hi' };
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [theirs] }] } }));

    installClaudeHooks(file, OPTIONS, true);
    installClaudeHooks(file, OPTIONS, true); // again: no duplicates
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(claudeHooksInstalled(file)).toEqual(['Stop', 'StopFailure', 'PreCompact', 'SessionEnd']);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.StopFailure[0].matcher).toBe('rate_limit');
    const ours = settings.hooks.PreCompact[0].hooks[0];
    expect(ours).toMatchObject({ type: 'command', command: process.execPath, timeout: 10 });
    expect(ours.args.slice(1, 3)).toEqual(['hook', 'claude']);

    expect(uninstallClaudeHooks(file, true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [theirs] }] } });
    expect(uninstallClaudeHooks(file, true)).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    const file = path.join(tmp('ar settings '), 'settings.json');
    installClaudeHooks(file, OPTIONS, false);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('Codex notify installation', () => {
  it('puts notify at the top level, before the first table, and removes it again', () => {
    const file = path.join(tmp('ar codex '), 'config.toml');
    fs.writeFileSync(file, 'model = "gpt-6.1-sol"\n\n[projects."C:/x"]\ntrust_level = "trusted"\n');
    installCodexNotify(file, OPTIONS, true);
    installCodexNotify(file, OPTIONS, true);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const notify = lines.findIndex((l) => l.startsWith('notify = '));
    expect(lines.filter((l) => l.startsWith('notify = '))).toHaveLength(1);
    expect(notify).toBeLessThan(lines.findIndex((l) => l.startsWith('[projects')));
    expect(codexNotifyStatus(file)).toBe('ours');
    expect(uninstallCodexNotify(file, true)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('model = "gpt-6.1-sol"\n\n[projects."C:/x"]\ntrust_level = "trusted"\n');
  });

  it("never replaces someone else's notify program", () => {
    const file = path.join(tmp('ar codex '), 'config.toml');
    fs.writeFileSync(file, 'notify = ["python3", "/home/me/notify.py"]\n');
    const plan = installCodexNotify(file, OPTIONS, true);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings[0]).toMatch(/already has a notify program/);
    expect(fs.readFileSync(file, 'utf8')).toBe('notify = ["python3", "/home/me/notify.py"]\n');
    expect(uninstallCodexNotify(file, true)).toBe(false);
  });
});

describe('handleHookEvent', () => {
  let ctx: CliContext;
  let project: string;
  const thread = '0199aaaa-0000-7000-8000-00000000000a';

  beforeEach(async () => {
    const home = tmp('ar hookrun ');
    project = path.join(home, 'proj');
    fs.mkdirSync(project);
    await runCommand('git', ['init', '-q', project]);
    const sessions = path.join(home, 'codex', 'sessions', '2026', '10', '10');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `rollout-2026-10-10T10-00-00-${thread}.jsonl`),
      [
        { timestamp: '2026-10-10T10:00:00Z', type: 'session_meta', payload: { id: thread, cwd: project } },
        { timestamp: '2026-10-10T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add a health check endpoint to the API server' } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    ctx = createContext({ cwd: project, env: { ...process.env, RELAYVORA_HOME: path.join(home, 'state'), CODEX_HOME: path.join(home, 'codex') } });
  });

  it('throttles turn checkpoints, always saves on compaction or limits, and prunes old ones', async () => {
    const event = { agent: 'codex' as const, sessionId: thread, cwd: project };
    const first = await handleHookEvent(ctx, { ...event, trigger: 'turn' }, OPTIONS);
    expect(first).toMatchObject({ action: 'created', reason: 'turn' });
    expect(await handleHookEvent(ctx, { ...event, trigger: 'turn' }, OPTIONS)).toMatchObject({ action: 'skipped' });

    const compact = await handleHookEvent(ctx, { ...event, trigger: 'pre-compact' }, OPTIONS);
    const limit = await handleHookEvent(ctx, { ...event, trigger: 'limit' }, OPTIONS);
    expect(limit.pruned).toEqual([first.checkpointId]); // keep: 2

    const { Store } = await import('@relayvora/storage');
    const store = Store.openInDir(ctx.dataDir);
    expect(store.autoCheckpoints(thread).map((c) => [c.id, c.trigger])).toEqual([
      [limit.checkpointId, 'limit'],
      [compact.checkpointId, 'pre-compact'],
    ]);
    store.close();
    expect(fs.existsSync(path.join(project, '.relayvora', 'handoffs', `${first.checkpointId}.md`))).toBe(false);
  });
});
