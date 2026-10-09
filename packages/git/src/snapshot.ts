import fs from 'node:fs/promises';
import path from 'node:path';
import { isSensitivePath, isWithin, sha256, type GitFileChange, type GitSnapshot } from '@agentrelay/core';
import { getRepoState, git, gitOk } from './repo.js';

/** Git's well-known empty tree; diffing against it shows everything as added in a repo without commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface SnapshotOptions {
  /** Patches longer than this are cut (the hash still covers the full patch). */
  maxPatchBytes?: number;
  /** Untracked files larger than this are cut. */
  maxFileBytes?: number;
  /** Stop capturing content after this many files; the rest are listed only. */
  maxFiles?: number;
  /** Cap on the whole `git diff` output. */
  maxDiffOutputBytes?: number;
}

interface NumstatEntry {
  path: string;
  origPath?: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

/** Parses `git diff --numstat -z`. Renames appear as `a\td\t\0old\0new\0`. */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const fields = output.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i]!);
    if (!m) continue;
    const binary = m[1] === '-';
    const entry: NumstatEntry = {
      path: m[3]!,
      added: binary ? null : Number(m[1]),
      deleted: binary ? null : Number(m[2]),
      binary,
    };
    if (entry.path === '') {
      entry.origPath = fields[++i] ?? '';
      entry.path = fields[++i] ?? '';
    }
    entries.push(entry);
  }
  return entries;
}

/** Splits a multi-file unified diff into per-file patches, in output order. */
export function splitPatches(diff: string): string[] {
  return diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
}

function cut(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const sliced = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  const lastNewline = sliced.lastIndexOf('\n');
  return { text: lastNewline > 0 ? sliced.slice(0, lastNewline + 1) : sliced, truncated: true };
}

async function readUntracked(
  root: string,
  relPath: string,
  maxBytes: number,
): Promise<Pick<GitFileChange, 'content' | 'truncated' | 'sha256' | 'omittedReason' | 'binary' | 'linesAdded'>> {
  const empty = { content: null, truncated: false, sha256: null, binary: false, linesAdded: null };
  const abs = path.resolve(root, relPath);
  if (!isWithin(root, abs)) return { ...empty, omittedReason: 'outside-root' };
  if (isSensitivePath(relPath)) return { ...empty, omittedReason: 'sensitive' };
  try {
    const stat = await fs.lstat(abs);
    // Never follow links: a symlink could point at ~/.ssh or anything else outside the repo.
    if (stat.isSymbolicLink()) return { ...empty, omittedReason: 'symlink' };
    if (!stat.isFile()) return { ...empty, omittedReason: 'unreadable' };
    const data = await fs.readFile(abs);
    if (data.subarray(0, 8000).includes(0)) {
      return { ...empty, binary: true, sha256: sha256(data), omittedReason: 'binary' };
    }
    const text = data.toString('utf8');
    const limited = cut(text, maxBytes);
    return {
      content: limited.text,
      truncated: limited.truncated,
      sha256: sha256(data),
      binary: false,
      linesAdded: text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
    };
  } catch {
    return { ...empty, omittedReason: 'unreadable' };
  }
}

/**
 * Captures the working tree as evidence: status, per-file line counts, patches against HEAD
 * (staged + unstaged), and the contents of untracked text files. Read-only; never takes Git locks.
 */
export async function collectGitSnapshot(cwd: string, options: SnapshotOptions = {}): Promise<GitSnapshot> {
  const { maxPatchBytes = 16_000, maxFileBytes = 16_000, maxFiles = 200, maxDiffOutputBytes = 32 * 1024 * 1024 } = options;
  const capturedAt = new Date().toISOString();
  const state = await getRepoState(cwd);
  const root = state.root;
  const base = state.head ?? EMPTY_TREE;
  const warnings: string[] = [];

  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--find-renames'];
  const [numstatOut, patchResult] = await Promise.all([
    gitOk(root, [...diffArgs, '--numstat', '-z', base], { maxOutputBytes: maxDiffOutputBytes }),
    git(root, [...diffArgs, '--unified=3', base], { maxOutputBytes: maxDiffOutputBytes }),
  ]);
  const numstat = parseNumstatZ(numstatOut);

  // Both commands use identical options, so patches come out in numstat order.
  let patches: string[] = [];
  if (patchResult.exitCode !== 0) {
    warnings.push(`git diff failed; patches not captured: ${patchResult.stderr.trim()}`);
  } else if (patchResult.truncated) {
    warnings.push('Diff output exceeded the capture limit; patches not captured.');
  } else {
    patches = splitPatches(patchResult.stdout);
    if (patches.length !== numstat.length) {
      warnings.push(`Could not match patches to files (${patches.length} vs ${numstat.length}); patches not captured.`);
      patches = [];
    }
  }
  const byPath = new Map(numstat.map((n, i) => [n.path, { ...n, patch: patches[i] ?? null }]));

  const files: GitFileChange[] = [];
  let captured = 0;
  for (const entry of state.entries) {
    const change: GitFileChange = {
      path: entry.path,
      status: entry.status,
      kind: entry.kind,
      linesAdded: null,
      linesDeleted: null,
      binary: false,
      patch: null,
      content: null,
      truncated: false,
      sha256: null,
    };
    if (entry.origPath) change.origPath = entry.origPath;

    const overLimit = captured >= maxFiles;
    if (entry.kind === 'untracked') {
      if (overLimit) change.omittedReason = 'too-many-files';
      else Object.assign(change, await readUntracked(root, entry.path, maxFileBytes));
    } else {
      const stat = byPath.get(entry.path);
      if (stat) {
        change.linesAdded = stat.added;
        change.linesDeleted = stat.deleted;
        change.binary = stat.binary;
        if (stat.binary) change.omittedReason = 'binary';
        else if (isSensitivePath(entry.path)) change.omittedReason = 'sensitive';
        else if (overLimit) change.omittedReason = 'too-many-files';
        else if (stat.patch) {
          const limited = cut(stat.patch, maxPatchBytes);
          change.patch = limited.text;
          change.truncated = limited.truncated;
          change.sha256 = sha256(stat.patch);
        }
      }
    }
    if (change.patch !== null || change.content !== null) captured++;
    files.push(change);
  }
  if (captured >= maxFiles && files.length > maxFiles) {
    warnings.push(`Only the first ${maxFiles} changed files were captured in full.`);
  }

  return {
    root,
    head: state.head,
    branch: state.branch,
    detached: state.detached,
    linkedWorktree: state.linkedWorktree,
    base: state.head,
    files,
    capturedAt,
    warnings,
  };
}
