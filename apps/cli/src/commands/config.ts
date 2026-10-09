import path from 'node:path';
import { DB_FILENAME } from '@agentrelay/storage';
import type { CliContext } from '../context.js';
import { type ProjectConfig, locateProject, projectConfigPath, readProjectConfig } from '../project.js';
import { label, providerName, rule } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export interface ConfigResult {
  dataDir: string;
  databasePath: string;
  projectRoot: string;
  projectConfigPath: string;
  projectConfig: ProjectConfig | null;
}

export async function runConfigShow(ctx: CliContext): Promise<ConfigResult> {
  const { root } = await locateProject(ctx.cwd);
  return {
    dataDir: ctx.dataDir,
    databasePath: path.join(ctx.dataDir, DB_FILENAME),
    projectRoot: root,
    projectConfigPath: projectConfigPath(root),
    projectConfig: readProjectConfig(root),
  };
}

export function renderConfig(r: ConfigResult, t: Theme = PLAIN): string {
  const lines = [
    '',
    `  ${rule(t, 'CONFIG', 'violet', Math.min(t.width, 78) - 2)}`,
    '',
    `  ${label(t, 'data', 9)}${t.dim(r.dataDir)}`,
    `  ${label(t, 'database', 9)}${t.dim(r.databasePath)}`,
    `  ${label(t, 'project', 9)}${t.fg('cyan', r.projectRoot)}`,
    `  ${label(t, 'config', 9)}${r.projectConfig ? t.dim(r.projectConfigPath) : t.fg('amber', 'not initialized; run agentrelay init')}`,
  ];
  if (r.projectConfig) {
    const c = r.projectConfig;
    lines.push(
      '',
      `  ${label(t, 'agents', 9)}${c.providers.map((p) => providerName(t, p)).join(t.fg('gray', ` ${t.sym.dot} `))}`,
      `  ${label(t, 'budget', 9)}${t.bold(c.handoffBudgetTokens.toLocaleString('en-US'))} ${t.dim('tokens per handoff (estimated)')}`,
      `  ${label(t, 'retention', 9)}${c.retentionDays === null ? 'forever' : `${c.retentionDays} days`} ${t.dim('(not enforced yet)')}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
