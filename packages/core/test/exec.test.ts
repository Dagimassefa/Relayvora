import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planSpawn, runCommand } from '../src/exec.js';
import { probeExecutable } from '../src/probe.js';

const node = process.execPath;

describe('runCommand', () => {
  it('captures stdout, stderr and exit code without a shell', async () => {
    const r = await runCommand(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('passes shell metacharacters through as literal arguments', async () => {
    const tricky = 'a && echo pwned; $(whoami) `id` | "quoted"';
    const r = await runCommand(node, ['-e', 'process.stdout.write(process.argv[1])', tricky]);
    expect(r.stdout).toBe(tricky);
  });

  it('kills the process on timeout', async () => {
    const r = await runCommand(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(20_000);
  });

  it('supports cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await runCommand(node, ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal });
    expect(r.cancelled).toBe(true);
  });

  it('rejects with NotFound for a missing executable', async () => {
    await expect(runCommand('definitely-not-a-real-binary-xyz')).rejects.toMatchObject({ exitCode: 3 });
  });
});

describe('planSpawn on Windows', () => {
  it('routes .cmd shims through cmd.exe with quoted arguments', () => {
    const plan = planSpawn('C:\\Program Files (x86)\\nodejs\\claude.cmd', ['--version'], 'win32');
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe('""C:\\Program Files (x86)\\nodejs\\claude.cmd" "--version""');
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it('refuses arguments cmd.exe could reinterpret', () => {
    expect(() => planSpawn('C:\\bin\\agent.cmd', ['x & del *'], 'win32')).toThrow(/unsafe argument/);
    expect(() => planSpawn('C:\\bin\\agent.cmd', ['%PATH%'], 'win32')).toThrow(/unsafe argument/);
  });

  it('leaves .exe and non-Windows spawns untouched', () => {
    expect(planSpawn('C:\\bin\\git.exe', ['status'], 'win32')).toEqual({
      file: 'C:\\bin\\git.exe',
      args: ['status'],
      windowsVerbatimArguments: false,
    });
  });
});

describe('probeExecutable', () => {
  it('reports a missing executable without throwing', async () => {
    expect(await probeExecutable('definitely-not-a-real-binary-xyz')).toEqual({
      found: false,
      error: 'definitely-not-a-real-binary-xyz not found on PATH',
    });
  });

  it('reads the version from a shim (exercises the .cmd path on Windows)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar probe '));
    const isWin = process.platform === 'win32';
    const file = path.join(dir, isWin ? 'fake-agent.cmd' : 'fake-agent');
    fs.writeFileSync(file, isWin ? '@echo off\r\necho fake-agent 1.2.3\r\n' : '#!/bin/sh\necho fake-agent 1.2.3\n', {
      mode: 0o755,
    });
    const env = { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '') };
    const probe = await probeExecutable('fake-agent', { env });
    expect(probe).toMatchObject({ found: true, version: 'fake-agent 1.2.3' });
  });
});
