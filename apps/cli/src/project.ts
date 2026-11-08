import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, RelayvoraError, isValidCheckpointId } from '@relayvora/core';
import { findRepoRoot } from '@relayvora/git';
import type { ProjectRecord, Store } from '@relayvora/storage';
import { z } from 'zod';

export const PROJECT_DIR = '.relayvora';
export const PROJECT_CONFIG_FILE = 'config.json';
export const HANDOFFS_DIR = 'handoffs';

export const ProjectConfig = z.object({
  schemaVersion: z.literal(1),
  /** Providers this project hands work between. */
  providers: z.array(z.string()).default(['claude', 'codex', 'opencode']),
  /** Default token budget for generated handoffs (estimated tokens). */
  handoffBudgetTokens: z.number().int().positive().default(4000),
  /** Relayvora checkpoint retention in days; null keeps everything. Vendor transcripts are never deleted. */
  retentionDays: z.number().int().positive().nullable().default(30),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = ProjectConfig.parse({ schemaVersion: 1 });

export interface ProjectLocation {
  root: string;
  isGitRepo: boolean;
}

/** The project root is the enclosing Git work tree, or the directory itself outside Git. */
export async function locateProject(cwd: string): Promise<ProjectLocation> {
  const gitRoot = await findRepoRoot(cwd).catch(() => null);
  return gitRoot ? { root: gitRoot, isGitRepo: true } : { root: cwd, isGitRepo: false };
}

export function projectDir(root: string): string {
  return path.join(root, PROJECT_DIR);
}

export function projectConfigPath(root: string): string {
  return path.join(projectDir(root), PROJECT_CONFIG_FILE);
}

/**
 * `<project>/.relayvora/handoffs/<id><ext>`. Ids can come from other people (shared checkpoints), so
 * the id is validated and the result must stay inside the handoffs directory.
 */
export function handoffPath(root: string, checkpointId: string, ext: '.md' | '.patch' = '.md'): string {
  const dir = path.join(projectDir(root), HANDOFFS_DIR);
  const file = path.join(dir, `${checkpointId}${ext}`);
  if (!isValidCheckpointId(checkpointId) || path.dirname(file) !== dir) {
    throw new RelayvoraError(`Invalid checkpoint id: ${JSON.stringify(checkpointId)}`, ExitCode.Usage);
  }
  return file;
}

export function readProjectConfig(root: string): ProjectConfig | null {
  const file = projectConfigPath(root);
  if (!fs.existsSync(file)) return null;
  return ProjectConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export interface EnsuredProject extends ProjectLocation {
  record: ProjectRecord;
  config: ProjectConfig;
  configPath: string;
  createdConfig: boolean;
}

/**
 * Creates `.relayvora/` (self-ignored by Git) and the default config if missing, and registers the
 * project in the store. Idempotent; never overwrites an existing config.
 */
export async function ensureProject(cwd: string, store: Store): Promise<EnsuredProject> {
  const location = await locateProject(cwd);
  const dir = projectDir(location.root);
  fs.mkdirSync(dir, { recursive: true });

  // Keeps local state out of commits without touching the user's own .gitignore.
  const ignoreFile = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');

  const configPath = projectConfigPath(location.root);
  let config = readProjectConfig(location.root);
  const createdConfig = config === null;
  if (config === null) {
    config = DEFAULT_PROJECT_CONFIG;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { ...location, record: store.upsertProject(location.root), config, configPath, createdConfig };
}
