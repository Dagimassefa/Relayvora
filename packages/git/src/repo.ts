import path from 'node:path';
import { AgentRelayError, ExitCode, runCommand, type ExecResult } from '@agentrelay/core';

export interface StatusEntry {
  /** Repo-relative path, forward slashes, as Git reports it. */
  path: string;
  /** Two-letter porcelain v1 status (index, worktree), e.g. " M", "A ", "??", "UU". */
  status: string;
  /** Source path for renames and copies. */
  origPath?: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'type-changed' | 'other';
}

export interface RepoState {
  root: string;
  /** null for a repository with no commits yet. */
  head: string | null;
  /** null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** True inside a linked worktree created by `git worktree add`. */
  linkedWorktree: boolean;
  entries: StatusEntry[];
}

// Read-only commands must not take index.lock, or we could break an agent that is mid-commit.
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

export async function git(cwd: string, args: string[], options: { maxOutputBytes?: number } = {}): Promise<ExecResult> {
  return runCommand('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: gitEnv(), timeoutMs: 30_000, ...options });
}

export async function gitOk(cwd: string, args: string[], options: { maxOutputBytes?: number } = {}): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) {
    throw new AgentRelayError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`, ExitCode.Failure);
  }
  return result.stdout;
}

/** Returns the repository top-level directory containing `cwd`, or null if not inside a work tree. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) return null;
  // Git prints forward slashes on Windows; normalize to the native form.
  return path.resolve(result.stdout.trim());
}

function classify(status: string): StatusEntry['kind'] {
  const [x = ' ', y = ' '] = status;
  if (status === '??') return 'untracked';
  if (x === 'U' || y === 'U' || status === 'AA' || status === 'DD') return 'conflicted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'T' || y === 'T') return 'type-changed';
  if (x === 'M' || y === 'M') return 'modified';
  return 'other';
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parsePorcelainZ(output: string): StatusEntry[] {
  const fields = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const entry: StatusEntry = { path: field.slice(3), status, kind: classify(status) };
    // With -z, a rename/copy is followed by a separate field holding the original path.
    if (status.includes('R') || status.includes('C')) {
      const orig = fields[++i];
      if (orig) entry.origPath = orig;
    }
    entries.push(entry);
  }
  return entries;
}

export async function getRepoState(cwd: string): Promise<RepoState> {
  const root = await findRepoRoot(cwd);
  if (!root) throw new AgentRelayError(`Not a Git repository: ${cwd}`, ExitCode.PreconditionFailed);

  const [headResult, branchResult, gitDir, commonDir, status] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOk(root, ['rev-parse', '--absolute-git-dir']),
    gitOk(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitOk(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);

  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

  return {
    root,
    head,
    branch,
    // An unborn branch has a symbolic ref but no HEAD commit; that is not detached.
    detached: branch === null,
    linkedWorktree: path.resolve(gitDir.trim()) !== path.resolve(commonDir.trim()),
    entries: parsePorcelainZ(status),
  };
}


export async function gitVersion(): Promise<string | null> {
  try {
    const result = await runCommand('git', ['--version'], { timeoutMs: 10_000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}
