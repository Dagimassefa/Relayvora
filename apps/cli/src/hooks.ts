import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { asRecord } from '@agentrelay/core';
import { createCheckpoint } from './checkpoint-service.js';
import { type CliContext, createContext, openStore } from './context.js';
import { cliEntryPoint } from './hooks-install.js';
import { removeCheckpoint } from './retention.js';

export type HookTrigger = 'pre-compact' | 'session-end' | 'turn' | 'limit';

/** An agent event, normalised from Claude Code hook input or a Codex notify payload. */
export interface HookEvent {
  agent: 'claude' | 'codex';
  trigger: HookTrigger;
  sessionId: string;
  cwd: string;
}

export interface HookOptions {
  /** Minimum minutes between turn-triggered checkpoints of the same session. */
  everyMinutes: number;
  /** Automatic checkpoints kept per session; older ones are deleted. */
  keep: number;
  /** Run the project's checks (--verify auto); slower, so off by default. */
  verify: boolean;
}

export const DEFAULT_HOOK_OPTIONS: HookOptions = { everyMinutes: 15, keep: 5, verify: false };

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Claude Code sends JSON on stdin: { session_id, transcript_path, cwd, hook_event_name, ... }.
 * PreCompact, SessionEnd and StopFailure (installed with matcher "rate_limit": the turn ended because
 * of a usage or rate limit) always checkpoint; Stop (end of each turn) is throttled.
 */
export function parseClaudeHook(input: string): HookEvent | null {
  let data: Record<string, unknown> | undefined;
  try {
    data = asRecord(JSON.parse(input));
  } catch {
    return null;
  }
  const sessionId = str(data?.session_id);
  const cwd = str(data?.cwd);
  const name = str(data?.hook_event_name);
  if (!sessionId || !cwd || !name) return null;
  // Already continuing because of a Stop hook: not a real end of turn.
  if (name === 'Stop' && data?.stop_hook_active === true) return null;
  const triggers: Record<string, HookTrigger> = { PreCompact: 'pre-compact', SessionEnd: 'session-end', Stop: 'turn', StopFailure: 'limit' };
  const trigger = triggers[name];
  return trigger ? { agent: 'claude', trigger, sessionId, cwd } : null;
}

/**
 * Hooks must return fast (SessionEnd hooks get ~1.5s by default) and never slow the agent, so the
 * checkpoint runs in a detached background process and the hook exits immediately.
 */
export function spawnHookWorker(event: HookEvent, options: HookOptions, bin: string = cliEntryPoint()): void {
  const args = [bin, 'hook-run', '--event', JSON.stringify(event), '--every', String(options.everyMinutes), '--keep', String(options.keep)];
  if (options.verify) args.push('--verify');
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.on('error', () => {});
  child.unref();
}

/**
 * Codex runs its `notify` program with one JSON argument after each agent turn:
 * { type: "agent-turn-complete", "thread-id", "turn-id", cwd, "input-messages", "last-assistant-message" }.
 */
export function parseCodexNotify(arg: string): HookEvent | null {
  let data: Record<string, unknown> | undefined;
  try {
    data = asRecord(JSON.parse(arg));
  } catch {
    return null;
  }
  if (data?.type !== 'agent-turn-complete') return null;
  const sessionId = str(data['thread-id']) ?? str(data.thread_id);
  const cwd = str(data.cwd);
  return sessionId && cwd ? { agent: 'codex', trigger: 'turn', sessionId, cwd } : null;
}

export interface HookResult {
  action: 'created' | 'skipped';
  reason: string;
  checkpointId?: string;
  pruned?: string[];
}

/**
 * Saves a checkpoint for an agent event. Turn events are throttled per session; compaction and
 * session end always save. Keeps the newest `keep` automatic checkpoints of the session.
 */
export async function handleHookEvent(base: CliContext, event: HookEvent, options: HookOptions = DEFAULT_HOOK_OPTIONS): Promise<HookResult> {
  const ctx = createContext({ ...base, cwd: event.cwd });
  // A per-session marker, touched as soon as any worker starts, so a burst of events (PreCompact then
  // Stop, or several quick turns) yields one checkpoint even while the first is still being written.
  const marker = path.join(ctx.dataDir, 'hook-markers', `${event.agent}-${event.sessionId.replace(/[^\w.-]/g, '_')}`);
  if (event.trigger === 'turn') {
    const recent = (() => {
      try {
        return Date.now() - fs.statSync(marker).mtimeMs;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    })();
    if (recent < options.everyMinutes * 60_000) {
      return { action: 'skipped', reason: `last automatic checkpoint ${Math.round(recent / 60_000)}m ago` };
    }
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString());

  const other = event.agent === 'claude' ? 'codex' : 'claude';
  const result = await createCheckpoint(ctx, {
    session: event.sessionId,
    from: event.agent,
    to: other,
    trigger: event.trigger,
    verify: options.verify ? ['auto'] : [],
  });

  // Prune: automatic checkpoints are a safety net, not an archive.
  const pruned: string[] = [];
  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(result.checkpoint.project.root);
    for (const old of store.autoCheckpoints(event.sessionId, event.agent, project!.id).slice(options.keep)) {
      if (removeCheckpoint(store, result.checkpoint.project.root, old.id)) pruned.push(old.id);
    }
    store.recordAudit({ action: `checkpoint.auto.${event.trigger}`, target: result.checkpoint.id, details: { agent: event.agent, sessionId: event.sessionId, pruned } });
  } finally {
    store.close();
  }
  return { action: 'created', reason: event.trigger, checkpointId: result.checkpoint.id, pruned };
}

/** Hooks must never disturb the agent: problems are appended here instead of printed. */
export function logHookProblem(dataDir: string, message: string): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'hooks.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // nothing else we can safely do inside a hook
  }
}
