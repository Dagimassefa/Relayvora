import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '@relayvora/core';
import { runSend } from '../src/commands/share.js';
import { createContext } from '../src/context.js';
import { createMcpHandler, serveMcp } from '../src/mcp.js';

let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;

const git = async (cwd: string, ...args: string[]) => {
  const r = await runCommand('git', ['-c', 'commit.gpgsign=false', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr);
  return r.stdout;
};

let nextId = 1;
const call = async (handle: ReturnType<typeof createMcpHandler>, name: string, args: Record<string, unknown> = {}) => {
  const res = (await handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  return { text: res.result.content[0]!.text, isError: res.result.isError };
};

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar mcp ')));
  repo = path.join(home, 'proj');
  env = { ...process.env, RELAYVORA_HOME: path.join(home, 'state'), CODEX_HOME: path.join(home, 'codex') };
  fs.mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Alice');
  await git(repo, 'config', 'user.email', 'alice@example.com');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const version = 1;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
});

describe('mcp server', () => {
  it('negotiates the protocol and lists its tools', async () => {
    const handle = createMcpHandler({ cwd: repo, env });
    const init = (await handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } })) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'relayvora' } });
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();

    const listed = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string; inputSchema: { type: string; required?: string[] } }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(['list_checkpoints', 'get_handoff', 'create_checkpoint', 'inbox', 'import_checkpoint']);
    expect(listed.result.tools.find((t) => t.name === 'create_checkpoint')!.inputSchema).toMatchObject({ type: 'object', required: ['goal'] });

    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })).toMatchObject({ error: { code: -32602 } });
  });

  it('lets an agent save a checkpoint and another fetch its handoff', async () => {
    const handle = createMcpHandler({ cwd: home, env });
    expect(await call(handle, 'get_handoff', { project: 'proj' })).toMatchObject({ isError: true, text: expect.stringMatching(/No checkpoints/) });
    expect(await call(handle, 'create_checkpoint', { project: 'proj' })).toMatchObject({ isError: true, text: expect.stringMatching(/Invalid arguments: goal/) });

    fs.writeFileSync(path.join(repo, 'app.js'), 'export const version = 2;\n');
    const saved = await call(handle, 'create_checkpoint', {
      project: 'proj',
      goal: 'Bump the version to 2',
      completed: ['Changed app.js'],
      pending: ['Update the changelog'],
      to: 'codex',
    });
    expect(saved.isError).toBe(false);
    const id = /Saved checkpoint (\S+)\./.exec(saved.text)![1]!;

    const listed = await call(handle, 'list_checkpoints', { project: repo });
    expect(listed.text).toContain(`${id}`);
    expect(listed.text).toContain('Bump the version to 2');

    const handoff = await call(handle, 'get_handoff', { project: repo });
    expect(handoff.text).toMatch(new RegExp(`^Checkpoint ${id} `));
    expect(handoff.text).toContain('Update the changelog');
    expect(handoff.text).toContain('app.js');
  });

  it('reads the inbox and fetches handoffs that were sent from another clone', async () => {
    const remote = path.join(home, 'remote.git');
    await git(home, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(repo, 'remote', 'add', 'origin', remote);
    await git(repo, 'push', '-q', 'origin', 'main');
    const bob = path.join(home, 'bob', 'proj');
    await git(home, 'clone', '-q', remote, bob);
    await git(bob, 'config', 'user.name', 'Bob');
    await git(bob, 'config', 'user.email', 'bob@example.com');

    const alice = createMcpHandler({ cwd: repo, env });
    const id = /Saved checkpoint (\S+)\./.exec((await call(alice, 'create_checkpoint', { goal: 'Ship the release' })).text)![1]!;
    await runSend(createContext({ cwd: repo, env }), id, { to: ['bob@example.com'], note: 'over to you', yes: true });

    const bobEnv = { ...env, RELAYVORA_HOME: path.join(home, 'bob', 'state') };
    const bobs = createMcpHandler({ cwd: bob, env: bobEnv });
    // get_handoff is read-only: a checkpoint on the shared branch must be imported first.
    await git(bob, 'fetch', '-q', 'origin', '+refs/heads/relayvora/handoffs:refs/remotes/origin/relayvora/handoffs');
    expect(await call(bobs, 'get_handoff', { id: id.slice(0, 20) })).toMatchObject({ isError: true, text: expect.stringMatching(/import_checkpoint/) });
    expect((await call(bobs, 'import_checkpoint', { source: id.slice(0, 20) })).isError).toBe(false);
    const handoff = (await call(bobs, 'get_handoff', { id: id.slice(0, 20) })).text;
    expect(handoff).toContain('Ship the release');
    expect(handoff).toContain('Imported by Relayvora from another machine or person');

    const inbox = await call(bobs, 'inbox');
    expect(inbox.text).toContain(`${id}`);
    expect(inbox.text).toContain('from Alice <alice@example.com>');
    expect(inbox.text).toContain('note: over to you');
  });

  it('serves newline-delimited JSON-RPC on stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (d: Buffer) => lines.push(...d.toString().split('\n').filter(Boolean)));
    const done = serveMcp({ cwd: repo, env }, input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })}\n`);
    input.write('{not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    await done;
    const messages = lines.map((l) => JSON.parse(l) as { id: number | null });
    expect(messages).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: '2025-06-18' }) }),
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) }),
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });
});
