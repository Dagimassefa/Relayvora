import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayvoraError, ExitCode, isSensitivePath, redact, runCommand, sha256 } from '@relayvora/core';
import { z } from 'zod';

/** Uncommitted work carried by an export: a binary-safe patch against `base`. */
export const Changes = z.object({
  base: z.string().regex(/^[0-9a-f]{40,64}$/),
  files: z.array(z.string()),
  /** Sensitive files that were changed but left out of the patch. */
  withheld: z.array(z.string()).default([]),
  patch: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Changes = z.infer<typeof Changes>;

const MAX_PATCH_BYTES = 20 * 1024 * 1024;

async function gitIn(root: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const r = await runCommand('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    env,
    timeoutMs: 60_000,
    maxOutputBytes: MAX_PATCH_BYTES,
    ...(input === undefined ? {} : { input }),
  });
  if (r.truncated) throw new RelayvoraError('The uncommitted changes are too large to export (over 20 MB); commit and push them instead.', ExitCode.PreconditionFailed);
  if (r.exitCode !== 0) throw new RelayvoraError(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`, ExitCode.Failure);
  return r.stdout;
}

/**
 * Captures every uncommitted change, untracked files included, as one patch against HEAD. It works on
 * a throwaway index, so the user's staging area is never touched. Sensitive files (.env, keys...) are
 * left out, and a patch that still looks like it holds secrets is refused rather than redacted, since
 * a redacted patch would no longer apply.
 */
export async function captureChanges(root: string): Promise<Changes | null> {
  const index = path.join(os.tmpdir(), `relayvora-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  try {
    const base = (await gitIn(root, ['rev-parse', '--verify', 'HEAD'], env).catch(() => '')).trim();
    if (!base) throw new RelayvoraError('The repository has no commits yet, so there is nothing to base a patch on; make a first commit.', ExitCode.PreconditionFailed);
    await gitIn(root, ['read-tree', 'HEAD'], env);
    await gitIn(root, ['add', '-A', '--', '.'], env);
    const changed = (await gitIn(root, ['diff', '--cached', '--name-only', '-z', 'HEAD'], env)).split('\0').filter(Boolean);
    const withheld = changed.filter((f) => isSensitivePath(f));
    if (withheld.length) await gitIn(root, ['reset', '-q', '--', ...withheld], env);
    const files = changed.filter((f) => !withheld.includes(f));
    if (files.length === 0) return null;
    const patch = await gitIn(root, ['diff', '--cached', '--binary', '--full-index', 'HEAD'], env);
    const secrets = redact(patch).findings;
    if (secrets.length) {
      throw new RelayvoraError(
        `The uncommitted changes look like they contain secrets (${secrets.map((s) => `${s.rule} x${s.count}`).join(', ')}). Remove them, or export without --with-changes and move the code through Git.`,
        ExitCode.PreconditionFailed,
      );
    }
    return { base, files, withheld, patch, sha256: sha256(patch) };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/**
 * Applies carried changes to the working tree (not the index). Requires the same base commit so the
 * patch lands exactly where it was made, and checks first so a conflict changes nothing.
 */
export async function applyChanges(root: string, changes: Changes): Promise<void> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (sha256(changes.patch) !== changes.sha256) {
    throw new RelayvoraError('The patch in this export is damaged (its checksum does not match).', ExitCode.Failure);
  }
  const head = (await gitIn(root, ['rev-parse', '--verify', 'HEAD'], env).catch(() => '')).trim();
  if (head !== changes.base) {
    throw new RelayvoraError(
      `The changes were made on top of commit ${changes.base.slice(0, 12)}, but this clone is at ${head ? head.slice(0, 12) : 'no commit'}. Push that commit from the other machine and check it out here (git pull), then import again with --apply-changes.`,
      ExitCode.PreconditionFailed,
    );
  }
  const check = await runCommand('git', ['apply', '--check', '--binary', '-'], { cwd: root, env, input: changes.patch });
  if (check.exitCode !== 0) {
    throw new RelayvoraError(
      `The changes do not apply cleanly here, so nothing was changed: ${check.stderr.trim().split('\n').slice(0, 3).join('; ')}`,
      ExitCode.PreconditionFailed,
    );
  }
  await gitIn(root, ['apply', '--binary', '-'], env, changes.patch);
}
