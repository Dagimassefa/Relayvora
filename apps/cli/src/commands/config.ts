import path from 'node:path';
import { DB_FILENAME } from '@agentrelay/storage';
import type { CliContext } from '../context.js';
import { type ProjectConfig, locateProject, projectConfigPath, readProjectConfig } from '../project.js';

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

export function renderConfig(r: ConfigResult): string {
  return [
    `data dir:       ${r.dataDir}`,
    `database:       ${r.databasePath}`,
    `project root:   ${r.projectRoot}`,
    `project config: ${r.projectConfig ? r.projectConfigPath : '(not initialized; run `agentrelay init`)'}`,
    ...(r.projectConfig ? ['', JSON.stringify(r.projectConfig, null, 2)] : []),
  ].join('\n');
}
