import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayvoraError, ExitCode, runCommand } from '@relayvora/core';
import { type HookOptions } from './hooks.js';

export type HookScope = 'local' | 'user';

/**
 * Claude Code events Relayvora hooks into. Exec form (command + args) runs without a shell, so paths
 * with spaces need no quoting and it works the same on Windows (node.exe is a real executable).
 */
const CLAUDE_EVENTS: Array<{ event: string; matcher?: string; why: string }> = [
  { event: 'StopFailure', matcher: 'rate_limit', why: 'the turn ended because of a usage or rate limit' },
  { event: 'PreCompact', why: 'just before the conversation is compacted' },
  { event: 'SessionEnd', why: 'when the session ends' },
  { event: 'Stop', why: 'at the end of a turn, at most every few minutes' },
];

export interface HookPlan {
  agent: 'claude' | 'codex';
  file: string;
  /** Human-readable summary of what will change. */
  changes: string[];
  warnings: string[];
}

interface CommandHook {
  type: 'command';
  command: string;
  args?: string[];
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}
type ClaudeSettings = { hooks?: Record<string, MatcherGroup[]> } & Record<string, unknown>;

/**
 * This CLI's entry point, located from this module (it sits next to bin.js in dist/), so it is right
 * however the CLI was started: global link, npx, or a direct path.
 */
export function cliEntryPoint(): string {
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  return fs.existsSync(bin) ? fs.realpathSync(bin) : bin;
}

/** The command an agent hook runs: this node binary with this CLI's `hook <agent>` subcommand. */
export function hookCommand(agent: 'claude' | 'codex', options: HookOptions): { command: string; args: string[] } {
  const bin = cliEntryPoint();
  const args = [bin, 'hook', agent, '--every', String(options.everyMinutes), '--keep', String(options.keep)];
  if (options.verify) args.push('--verify');
  return { command: process.execPath, args };
}

/** Our entries are the ones running this CLI's `hook <agent>` subcommand. */
const isOurs = (h: CommandHook, agent: string) => Array.isArray(h.args) && h.args[1] === 'hook' && h.args[2] === agent && /bin\.js$/.test(h.args[0] ?? '');

export function claudeSettingsFile(scope: HookScope, projectRoot: string): string {
  return scope === 'user' ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(projectRoot, '.claude', 'settings.local.json');
}

function readJson(file: string): ClaudeSettings {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeSettings;
  } catch (error) {
    throw new RelayvoraError(`${file} is not valid JSON; fix it before installing hooks (${(error as Error).message})`, ExitCode.PreconditionFailed);
  }
}

/** Removes Relayvora's entries, leaving every other hook exactly as it was. */
function withoutOurClaudeHooks(settings: ClaudeSettings): ClaudeSettings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h, 'claude')) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length === 0 ? rest : { ...rest, hooks };
}

export function installClaudeHooks(file: string, options: HookOptions, apply: boolean): HookPlan {
  const settings = withoutOurClaudeHooks(readJson(file));
  const { command, args } = hookCommand('claude', options);
  const hooks = { ...(settings.hooks ?? {}) };
  for (const e of CLAUDE_EVENTS) {
    // Our hook only spawns a background worker, so it finishes in well under the SessionEnd budget.
    const group: MatcherGroup = { ...(e.matcher ? { matcher: e.matcher } : {}), hooks: [{ type: 'command', command, args, timeout: 10 }] };
    hooks[e.event] = [...(hooks[e.event] ?? []), group];
  }
  if (apply) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  }
  return {
    agent: 'claude',
    file,
    changes: CLAUDE_EVENTS.map((e) => `${e.event}${e.matcher ? ` (${e.matcher})` : ''}: checkpoint ${e.why}`),
    warnings: [],
  };
}

export function uninstallClaudeHooks(file: string, apply: boolean): boolean {
  if (!fs.existsSync(file)) return false;
  const before = readJson(file);
  const after = withoutOurClaudeHooks(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed && apply) fs.writeFileSync(file, `${JSON.stringify(after, null, 2)}\n`);
  return changed;
}

export function claudeHooksInstalled(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const settings = readJson(file);
  return Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => isOurs(h, 'claude'))))
    .map(([event]) => event);
}

/** Keeps a project-local settings file out of commits (Claude Code only does this for files it writes). */
export async function ensureGitIgnored(projectRoot: string, file: string): Promise<string | null> {
  const rel = path.relative(projectRoot, file).split(path.sep).join('/');
  const check = await runCommand('git', ['check-ignore', '-q', rel], { cwd: projectRoot }).catch(() => null);
  if (!check || check.exitCode === 0) return null; // ignored already, or not a Git repo
  const dir = await runCommand('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: projectRoot }).catch(() => null);
  if (!dir || dir.exitCode !== 0) return null;
  const exclude = path.resolve(projectRoot, dir.stdout.trim());
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `\n# Added by relayvora hooks install\n/${rel}\n`);
  return exclude;
}

// ---- Codex: `notify` in ~/.codex/config.toml runs a program with one JSON argument after each turn.

export function codexConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'config.toml');
}

const NOTIFY_LINE = /^\s*notify\s*=/;
const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function codexNotifyStatus(file: string): 'ours' | 'other' | 'none' {
  if (!fs.existsSync(file)) return 'none';
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => NOTIFY_LINE.test(l));
  if (!line) return 'none';
  return /bin\.js".*"hook",\s*"codex"/.test(line) ? 'ours' : 'other';
}

export function installCodexNotify(file: string, options: HookOptions, apply: boolean): HookPlan {
  const status = codexNotifyStatus(file);
  if (status === 'other') {
    return {
      agent: 'codex',
      file,
      changes: [],
      warnings: ['Codex already has a notify program; left it alone. Codex allows only one, so add Relayvora to it by hand if you want both.'],
    };
  }
  const { command, args } = hookCommand('codex', options);
  const line = `notify = [${[command, ...args].map(tomlString).join(', ')}]  # relayvora hooks`;
  if (apply) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lines = text.split(/\r?\n/).filter((l) => !NOTIFY_LINE.test(l));
    // Top-level keys must come before the first [table], or TOML puts them inside that table.
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    const at = firstTable === -1 ? lines.length : firstTable;
    lines.splice(at, 0, line);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'));
  }
  return { agent: 'codex', file, changes: ['notify: checkpoint at the end of a turn, at most every few minutes'], warnings: [] };
}

export function uninstallCodexNotify(file: string, apply: boolean): boolean {
  if (codexNotifyStatus(file) !== 'ours') return false;
  if (apply) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !NOTIFY_LINE.test(l));
    fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'));
  }
  return true;
}
