import { AgentRelayError, ExitCode } from '@agentrelay/core';
import type { CliContext } from '../context.js';
import {
  type HookPlan,
  type HookScope,
  claudeHooksInstalled,
  claudeSettingsFile,
  codexConfigFile,
  codexNotifyStatus,
  ensureGitIgnored,
  installClaudeHooks,
  installCodexNotify,
  uninstallClaudeHooks,
  uninstallCodexNotify,
} from '../hooks-install.js';
import { DEFAULT_HOOK_OPTIONS, type HookOptions } from '../hooks.js';
import { locateProject } from '../project.js';
import { label, rule, statusIcon } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export interface HooksFlags {
  agent: 'claude' | 'codex' | 'all';
  scope: HookScope;
  every: number;
  keep: number;
  verify?: boolean;
  dryRun?: boolean;
}

const agentsOf = (a: HooksFlags['agent']) => (a === 'all' ? (['claude', 'codex'] as const) : ([a] as const));

export interface HooksInstallResult {
  dryRun: boolean;
  plans: HookPlan[];
  excludedIn: string | null;
  notes: string[];
}

export async function runHooksInstall(ctx: CliContext, flags: HooksFlags): Promise<HooksInstallResult> {
  if (flags.scope !== 'local' && flags.scope !== 'user') throw new AgentRelayError('--scope must be local or user', ExitCode.Usage);
  const options: HookOptions = { everyMinutes: flags.every, keep: flags.keep, verify: Boolean(flags.verify) };
  const apply = !flags.dryRun;
  const { root } = await locateProject(ctx.cwd);
  const plans: HookPlan[] = [];
  let excludedIn: string | null = null;
  const notes: string[] = [];
  for (const agent of agentsOf(flags.agent)) {
    if (agent === 'claude') {
      const file = claudeSettingsFile(flags.scope, root);
      plans.push(installClaudeHooks(file, options, apply));
      if (apply && flags.scope === 'local') excludedIn = await ensureGitIgnored(root, file);
      notes.push(
        flags.scope === 'local'
          ? 'Claude Code: active for this project once you have accepted its workspace trust prompt here.'
          : 'Claude Code: active in every project you trust in Claude Code.',
      );
    } else {
      plans.push(installCodexNotify(codexConfigFile(ctx.env), options, apply));
      notes.push('Codex: notify is global, so it covers every project (Codex allows one notify program).');
    }
  }
  notes.push(`Checkpoints are saved in the background and never slow the agent. Problems go to ${ctx.dataDir}${process.platform === 'win32' ? '\\' : '/'}hooks.log.`);
  return { dryRun: !apply, plans, excludedIn, notes };
}

export function renderHooksInstall(r: HooksInstallResult, t: Theme = PLAIN): string {
  const out = ['', `  ${rule(t, r.dryRun ? 'HOOKS (dry run, nothing written)' : 'HOOKS INSTALLED', 'lime', Math.min(t.width, 78) - 2)}`, ''];
  for (const p of r.plans) {
    out.push(`  ${statusIcon(t, p.changes.length ? 'ok' : 'warn')} ${t.bold(p.agent === 'claude' ? 'Claude Code' : 'Codex')}  ${t.dim(p.file)}`);
    for (const c of p.changes) out.push(`      ${t.fg('cyan', t.sym.arrow)} ${c}`);
    for (const w of p.warnings) out.push(`      ${statusIcon(t, 'warn')} ${t.fg('amber', w)}`);
  }
  if (r.excludedIn) out.push('', `  ${statusIcon(t, 'info')} ${t.dim(`kept the settings file out of Git via ${r.excludedIn}`)}`);
  out.push('', ...r.notes.map((n) => `  ${t.dim(n)}`), '', `  ${t.dim('See them with')} ${t.bold('agentrelay hooks status')}${t.dim(', remove with')} ${t.bold('agentrelay hooks uninstall')}`, '');
  return out.join('\n');
}

export interface HooksStatus {
  claude: Array<{ scope: HookScope; file: string; events: string[] }>;
  codex: { file: string; status: 'ours' | 'other' | 'none' };
}

export async function runHooksStatus(ctx: CliContext): Promise<HooksStatus> {
  const { root } = await locateProject(ctx.cwd);
  return {
    claude: (['local', 'user'] as const).map((scope) => {
      const file = claudeSettingsFile(scope, root);
      return { scope, file, events: claudeHooksInstalled(file) };
    }),
    codex: { file: codexConfigFile(ctx.env), status: codexNotifyStatus(codexConfigFile(ctx.env)) },
  };
}

export function renderHooksStatus(s: HooksStatus, t: Theme = PLAIN): string {
  const out = ['', `  ${rule(t, 'HOOKS', 'violet', Math.min(t.width, 78) - 2)}`, ''];
  for (const c of s.claude) {
    out.push(
      `  ${statusIcon(t, c.events.length ? 'ok' : 'info')} ${label(t, `claude/${c.scope}`, 14)}${
        c.events.length ? c.events.join(', ') : t.dim('not installed')
      }  ${t.dim(c.file)}`,
    );
  }
  const codex = s.codex.status === 'ours' ? 'notify (end of turn)' : s.codex.status === 'other' ? t.fg('amber', 'another notify program is set') : t.dim('not installed');
  out.push(`  ${statusIcon(t, s.codex.status === 'ours' ? 'ok' : 'info')} ${label(t, 'codex', 14)}${codex}  ${t.dim(s.codex.file)}`, '');
  return out.join('\n');
}

export async function runHooksUninstall(ctx: CliContext, flags: Pick<HooksFlags, 'agent' | 'scope' | 'dryRun'>): Promise<{ removed: string[] }> {
  const { root } = await locateProject(ctx.cwd);
  const removed: string[] = [];
  for (const agent of agentsOf(flags.agent)) {
    if (agent === 'claude') {
      const file = claudeSettingsFile(flags.scope, root);
      if (uninstallClaudeHooks(file, !flags.dryRun)) removed.push(file);
    } else if (uninstallCodexNotify(codexConfigFile(ctx.env), !flags.dryRun)) {
      removed.push(codexConfigFile(ctx.env));
    }
  }
  return { removed };
}

export { DEFAULT_HOOK_OPTIONS };
