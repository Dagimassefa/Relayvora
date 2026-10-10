import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand, type AgentAdapter } from '@agentrelay/core';
import { createCheckpoint } from '../src/checkpoint-service.js';
import { createContext, type CliContext } from '../src/context.js';
import { executeLaunch, planLaunch, pointerPrompt } from '../src/launch.js';

let home: string;
let project: string;
let record: string;
let ctx: CliContext;

/** A stand-in agent: a Node script that records its argv and cwd, then exits with code 7. */
function fakeAgent(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  const script = path.join(home, 'fake-agent.cjs');
  fs.writeFileSync(
    script,
    `require('fs').writeFileSync(process.env.FAKE_AGENT_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })); process.exit(7);`,
  );
  return {
    id: 'fake',
    displayName: 'Fake Agent',
    executable: 'fake',
    capabilities: { discoverSessions: 'unsupported', readTranscript: 'unsupported', launch: 'documented', usageReporting: 'unsupported' },
    probe: async () => ({ found: true, path: process.execPath, source: 'path', version: 'fake 1.0' }),
    sessionRoots: () => [],
    discoverSessions: async () => ({ sessions: [], scannedRoots: [], warnings: [] }),
    launchArgs: (prompt: string) => [script, prompt],
    ...overrides,
  };
}

beforeEach(async () => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ar launch ')));
  project = path.join(home, 'my project');
  fs.mkdirSync(project);
  await runCommand('git', ['init', '-q', project]);
  record = path.join(home, 'record.json');
  const env = { ...process.env, AGENTRELAY_HOME: path.join(home, 'state'), FAKE_AGENT_RECORD: record };
  ctx = createContext({ cwd: project, env, adapters: [fakeAgent()] });
});

afterEach(() => vi.restoreAllMocks());

async function checkpoint() {
  return (await createCheckpoint(ctx, { goal: 'Finish the portal routing', to: 'fake' })).checkpoint;
}

describe('planLaunch', () => {
  it('points the agent at the handoff file and runs it in the project folder', async () => {
    const cp = await checkpoint();
    const plan = await planLaunch(ctx, cp, null);
    expect(plan).toMatchObject({ target: 'fake', executable: process.execPath, cwd: cp.project.root, version: 'fake 1.0' });
    expect(plan.prompt).toBe(pointerPrompt(cp, plan.handoffFile));
    expect(plan.prompt).toContain(`.agentrelay/handoffs/${cp.id}.md`);
    expect(plan.args.at(-1)).toBe(plan.prompt);
  });

  it('recreates a deleted handoff file but keeps an edited one', async () => {
    const cp = await checkpoint();
    const plan = await planLaunch(ctx, cp, null);
    fs.writeFileSync(plan.handoffFile, 'edited by the user');
    await planLaunch(ctx, cp, null);
    expect(fs.readFileSync(plan.handoffFile, 'utf8')).toBe('edited by the user');
    fs.rmSync(plan.handoffFile);
    await planLaunch(ctx, cp, null);
    expect(fs.readFileSync(plan.handoffFile, 'utf8')).toBe(cp.handoff.prompt);
  });

  it('explains what is missing', async () => {
    const cp = await createCheckpoint(ctx, { goal: 'x' });
    await expect(planLaunch(ctx, cp.checkpoint, null)).rejects.toMatchObject({ exitCode: 2 });

    const noLaunch = createContext({ ...ctx, adapters: [fakeAgent({ launchArgs: undefined })] });
    await expect(planLaunch(noLaunch, cp.checkpoint, 'fake')).rejects.toMatchObject({ exitCode: 4 });

    const missing = createContext({ ...ctx, adapters: [fakeAgent({ probe: async () => ({ found: false }) })] });
    await expect(planLaunch(missing, cp.checkpoint, 'fake')).rejects.toThrow(/use --copy/);
  });
});

describe('executeLaunch', () => {
  it('launches the agent with the prompt, in the project, and records the launch', async () => {
    const cp = await checkpoint();
    const plan = await planLaunch(ctx, cp, null);
    const result = await executeLaunch(ctx, plan, { yes: true });

    expect(result).toMatchObject({ launched: true, exitCode: 7 });
    const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
    expect(seen.argv).toEqual([plan.prompt]);
    expect(fs.realpathSync.native(seen.cwd)).toBe(fs.realpathSync.native(cp.project.root));

    const { Store } = await import('@agentrelay/storage');
    const store = Store.openInDir(ctx.dataDir);
    const row = store.db.prepare("SELECT target, details_json FROM audit_events WHERE action = 'handoff.launch'").get() as {
      target: string;
      details_json: string;
    };
    store.close();
    expect(row.target).toBe(cp.id);
    expect(JSON.parse(row.details_json)).toMatchObject({ agent: 'fake', promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('refuses to launch without confirmation when there is no terminal', async () => {
    const plan = await planLaunch(ctx, await checkpoint(), null);
    await expect(executeLaunch(ctx, plan)).rejects.toThrow(/--yes/);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('does nothing on a dry run', async () => {
    const plan = await planLaunch(ctx, await checkpoint(), null);
    expect(await executeLaunch(ctx, plan, { dryRun: true, yes: true })).toMatchObject({ launched: false });
    expect(fs.existsSync(record)).toBe(false);
  });
});
