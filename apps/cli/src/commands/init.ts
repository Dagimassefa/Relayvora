import { type CliContext, openStore } from '../context.js';
import { ensureProject } from '../project.js';

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

export function renderInit(r: InitResult): string {
  return [
    `${r.createdConfig ? 'Initialized' : 'Already initialized'} AgentRelay in ${r.root}`,
    `  config:  ${r.configPath}`,
    `  store:   ${r.dataDir}`,
    ...r.warnings.map((w) => `  warning: ${w}`),
  ].join('\n');
}
