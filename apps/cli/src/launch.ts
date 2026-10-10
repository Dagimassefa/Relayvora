import fs from 'node:fs';
import path from 'node:path';
import { AgentRelayError, ExitCode, runInteractive, sha256, type AgentAdapter, type Checkpoint } from '@agentrelay/core';
import { confirmOrAbort } from './confirm.js';
import { type CliContext, openStore, selectAdapters } from './context.js';
import { handoffPath } from './project.js';

/**
 * The first message given to the launched agent. It points at the handoff file instead of carrying
 * the text: command lines have length limits (8 KB through cmd.exe on Windows), and the agent reads
 * the file with its own tools, including any edits made after the checkpoint was created.
 */
export function pointerPrompt(cp: Checkpoint, handoffFile: string): string {
  const rel = path.relative(cp.project.root, handoffFile).split(path.sep).join('/');
  const from = cp.source.provider === 'manual' ? 'a previous session' : `a ${cp.source.provider} session`;
  return `Continue the task described in ${rel} (an AgentRelay handoff from ${from}). Read that file first, verify its agent-reported and inferred claims, then carry on.`;
}

export interface LaunchPlan {
  checkpointId: string;
  target: string;
  displayName: string;
  executable: string;
  source: 'path' | 'editor-extension';
  editor: string | null;
  version: string | null;
  cwd: string;
  args: string[];
  prompt: string;
  handoffFile: string;
}

/** Works out exactly what would be run. Throws if the target cannot be launched. */
export async function planLaunch(ctx: CliContext, cp: Checkpoint, target: string | null): Promise<LaunchPlan> {
  const provider = target ?? cp.handoff.targetProvider;
  if (!provider) {
    throw new AgentRelayError('No target agent: pass --to claude or --to codex.', ExitCode.Usage);
  }
  const adapter: AgentAdapter = selectAdapters(ctx, provider)[0]!;
  if (!adapter.launchArgs) {
    throw new AgentRelayError(`${adapter.displayName} cannot be launched by AgentRelay yet.`, ExitCode.Unsupported);
  }
  if (!fs.existsSync(cp.project.root)) {
    throw new AgentRelayError(`The checkpoint's project folder no longer exists: ${cp.project.root}`, ExitCode.PreconditionFailed);
  }

  // Recreate the handoff file if it was deleted; an edited file is kept as the user left it.
  const handoffFile = handoffPath(cp.project.root, cp.id);
  if (!fs.existsSync(handoffFile)) {
    fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
    fs.writeFileSync(handoffFile, cp.handoff.prompt ?? '');
  }

  const probe = await adapter.probe({ env: ctx.env });
  if (!probe.found || !probe.path) {
    throw new AgentRelayError(
      `${adapter.displayName} was not found on PATH or in an editor extension. Install its CLI, or use --copy and paste the handoff into the editor panel.`,
      ExitCode.NotFound,
    );
  }
  const prompt = pointerPrompt(cp, handoffFile);
  return {
    checkpointId: cp.id,
    target: adapter.id,
    displayName: adapter.displayName,
    executable: probe.path,
    source: probe.source ?? 'path',
    editor: probe.editor ?? null,
    version: probe.version ?? null,
    cwd: cp.project.root,
    args: adapter.launchArgs(prompt),
    prompt,
    handoffFile,
  };
}

export interface LaunchResult {
  launched: boolean;
  plan: LaunchPlan;
  exitCode: number | null;
}

/**
 * Asks for confirmation (unless `yes`), records what is being sent in the audit trail, then hands
 * the terminal to the agent until it exits.
 */
export async function executeLaunch(ctx: CliContext, plan: LaunchPlan, options: { yes?: boolean; dryRun?: boolean } = {}): Promise<LaunchResult> {
  if (options.dryRun) return { launched: false, plan, exitCode: null };
  await confirmOrAbort(`Launch ${plan.displayName} in ${plan.cwd} with this handoff?`, options.yes === undefined ? {} : { yes: options.yes });

  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(plan.cwd);
    store.recordAudit({
      action: 'handoff.launch',
      projectId: project?.id ?? null,
      target: plan.checkpointId,
      details: {
        agent: plan.target,
        executable: plan.executable,
        source: plan.source,
        version: plan.version,
        promptSha256: sha256(plan.prompt),
        handoffFile: plan.handoffFile,
        handoffSha256: sha256(fs.readFileSync(plan.handoffFile)),
      },
    });
  } finally {
    store.close();
  }

  const { exitCode } = await runInteractive(plan.executable, plan.args, { cwd: plan.cwd, env: ctx.env });
  return { launched: true, plan, exitCode };
}
