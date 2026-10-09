import { type CliContext, openStore } from '../context.js';
import { ensureProject } from '../project.js';
import { label, statusIcon } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export interface InitResult {
  root: string;
  isGitRepo: boolean;
  projectId: string;
  configPath: string;
  createdConfig: boolean;
  dataDir: string;
  warnings: string[];
}

/** Idempotent: re-running keeps an existing config and only refreshes the project registration. */
export async function runInit(ctx: CliContext): Promise<InitResult> {
  const store = openStore(ctx);
  try {
    const project = await ensureProject(ctx.cwd, store);
    const warnings = project.isGitRepo ? [] : ['Not inside a Git repository; checkpoints will lack Git evidence.'];
    store.recordAudit({
      action: 'project.init',
      projectId: project.record.id,
      target: project.root,
      details: { createdConfig: project.createdConfig },
    });
    return {
      root: project.root,
      isGitRepo: project.isGitRepo,
      projectId: project.record.id,
      configPath: project.configPath,
      createdConfig: project.createdConfig,
      dataDir: ctx.dataDir,
      warnings,
    };
  } finally {
    store.close();
  }
}

export function renderInit(r: InitResult, t: Theme = PLAIN): string {
  const head = r.createdConfig
    ? `${statusIcon(t, 'ok')} ${t.bold('AgentRelay is live in')} ${t.fg('cyan', r.root)}`
    : `${statusIcon(t, 'info')} ${t.bold('Already initialized in')} ${t.fg('cyan', r.root)}`;
  return [
    '',
    `  ${head}`,
    `    ${label(t, 'config')} ${t.dim(r.configPath)}`,
    `    ${label(t, 'store')} ${t.dim(r.dataDir)}`,
    ...r.warnings.map((w) => `  ${statusIcon(t, 'warn')} ${t.fg('amber', w)}`),
    '',
    `  ${t.fg('cyan', t.sym.arrow)} ${t.dim('next:')} ${t.bold('agentrelay handoff --from codex --to claude --verify "pnpm test"')}`,
    '',
  ].join('\n');
}
