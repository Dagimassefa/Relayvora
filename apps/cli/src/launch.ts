import fs from 'node:fs';
import path from 'node:path';
import { AgentRelayError, ExitCode, runInteractive, sha256, type AgentAdapter, type Checkpoint } from '@agentrelay/core';
import { confirmOrAbort } from './confirm.js';
import { type CliContext, openStore, selectAdapters } from './context.js';
import { collectGitSnapshot } from '@agentrelay/git';
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

export interface Freshness {
  /** False when there was nothing to compare (not a Git repository). */
  checked: boolean;
  fresh: boolean;
  /** Human-readable differences, e.g. "HEAD moved", "src/a.ts changed". */
  differences: string[];
}

/**
 * Compares the repository now with the state recorded in the checkpoint: HEAD, branch, and each
 * changed file's status and content hash. When nothing moved, the launched agent can skip re-checking.
 */
export async function checkFreshness(cp: Checkpoint): Promise<Freshness> {
  if (!cp.project.isGitRepo) return { checked: false, fresh: false, differences: [] };
  const now = await collectGitSnapshot(cp.project.root);
  const differences: string[] = [];
  if (now.head !== cp.project.gitHead) differences.push('HEAD moved');
  if (now.branch !== cp.project.branch) differences.push('branch changed');

  const recorded = new Map(cp.project.dirtyFiles.map((d) => [d.path, d.status]));
  const hashes = new Map(cp.evidence.filter((e) => e.path && (e.type === 'git-diff' || e.type === 'file')).map((e) => [e.path!, e.sha256 ?? null]));
  const current = new Map(now.files.map((f) => [f.path, f]));
  for (const [file, status] of recorded) {
    const c = current.get(file);
    if (!c) differences.push(`${file} no longer changed`);
    else if (c.status !== status) differences.push(`${file} status changed`);
    else if (hashes.get(file) && c.sha256 && hashes.get(file) !== c.sha256) differences.push(`${file} changed`);
  }
  for (const file of current.keys()) if (!recorded.has(file)) differences.push(`${file} newly changed`);
  return { checked: true, fresh: differences.length === 0, differences };
}

function freshnessSentence(f: Freshness): string {
  if (!f.checked) return '';
  if (f.fresh) {
    return 'AgentRelay re-checked the repository just before starting this session: HEAD, branch and uncommitted changes still match the handoff, so you do not need to re-check them.';
  }
  const shown = f.differences.slice(0, 5).join('; ');
  return `The repository changed after the handoff was written (${shown}${f.differences.length > 5 ? '; ...' : ''}). Run git status once before relying on its file list.`;
}

// Command-line ceilings: Windows CreateProcess allows ~32K characters in total, cmd.exe 8K.
const INLINE_LIMIT = process.platform === 'win32' ? 24_000 : 100_000;

/**
 * The launch message. When the command line allows it, the handoff text itself goes in, which saves
 * the agent a file read; otherwise a short pointer to the file. Either way the file as it is on disk
 * now is used, so edits made after the checkpoint are honoured.
 */
export function launchPrompt(cp: Checkpoint, handoffFile: string, freshness: Freshness, inlineAllowed: boolean): { prompt: string; mode: 'inline' | 'pointer' } {
  const fresh = freshnessSentence(freshness);
  const rel = path.relative(cp.project.root, handoffFile).split(path.sep).join('/');
  const text = fs.readFileSync(handoffFile, 'utf8');
  const from = cp.source.provider === 'manual' ? 'a previous session' : `a ${cp.source.provider} session`;
  const intro = `You are continuing work from ${from}. The AgentRelay handoff below (also saved at ${rel}) describes the task, what is done and what is left.`;
  const inline = `${[intro, fresh].filter(Boolean).join(' ')}\n\n${text}`;
  if (inlineAllowed && inline.length <= INLINE_LIMIT) return { prompt: inline, mode: 'inline' };
  return { prompt: [pointerPrompt(cp, handoffFile), fresh].filter(Boolean).join(' '), mode: 'pointer' };
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
  /** inline: the handoff text is in the launch message; pointer: the agent reads the file. */
  mode: 'inline' | 'pointer';
  freshness: Freshness;
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
  const freshness = await checkFreshness(cp);
  // Batch files go through cmd.exe, which cannot carry a long multi-line argument safely.
  const inlineAllowed = !(process.platform === 'win32' && /.(cmd|bat)$/i.test(probe.path));
  const { prompt, mode } = launchPrompt(cp, handoffFile, freshness, inlineAllowed);
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
    mode,
    freshness,
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
