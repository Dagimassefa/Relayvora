import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayvoraError, ExitCode, runCommand, type ExecResult } from '@relayvora/core';

/**
 * Shared checkpoints live on an orphan branch of the project's own repository, so whoever can read
 * the repository (you on another device, your teammates) can read them, and nobody else. It is
 * written with Git plumbing on a throwaway index: the working tree, index and checked-out branch are
 * never touched.
 *
 * Layout: `checkpoints/<id>.json` (an export) and `sent/<id>/<email>.json` (who sent it to whom).
 * Paths are never rewritten by two people with different content in practice, so merging two tips
 * is a union of their files.
 */
export const SHARE_BRANCH = 'relayvora/handoffs';
const LOCAL_REF = `refs/heads/${SHARE_BRANCH}`;
const remoteRef = (remote: string) => `refs/remotes/${remote}/${SHARE_BRANCH}`;

export interface Identity {
  name: string | null;
  email: string | null;
}

interface RunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

async function run(root: string, args: string[], options: RunOptions = {}): Promise<ExecResult> {
  return runCommand('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 64 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

async function ok(root: string, args: string[], options: RunOptions = {}): Promise<string> {
  const r = await run(root, args, options);
  if (r.exitCode !== 0) throw new RelayvoraError(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`, ExitCode.Failure);
  return r.stdout;
}

async function revParse(root: string, ref: string): Promise<string | null> {
  const r = await run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function identity(root: string): Promise<Identity> {
  const get = async (key: string) => {
    const r = await run(root, ['config', '--get', key]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  const email = await get('user.email');
  return { name: await get('user.name'), email: email?.toLowerCase() ?? null };
}

/** The remote's URL, or null when the repository has no such remote. */
export async function remoteUrl(root: string, remote: string): Promise<string | null> {
  const r = await run(root, ['remote', 'get-url', remote]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** Fetches the shared branch. Returns false when the remote does not have it yet. */
export async function fetchShared(root: string, remote: string): Promise<boolean> {
  const r = await run(root, ['fetch', '--quiet', '--no-tags', remote, `+${LOCAL_REF}:${remoteRef(remote)}`], { timeoutMs: 120_000 });
  if (r.exitCode === 0) return true;
  if (/couldn't find remote ref|could not find remote ref/i.test(r.stderr)) {
    await run(root, ['update-ref', '-d', remoteRef(remote)]);
    return false;
  }
  throw new RelayvoraError(`Could not fetch from ${remote}: ${r.stderr.trim() || `exit ${r.exitCode}`}`, ExitCode.Failure);
}

async function entriesOf(root: string, commit: string | null): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  if (!commit) return entries;
  for (const line of (await ok(root, ['ls-tree', '-r', '-z', commit])).split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (m) entries.set(m[2]!, m[1]!);
  }
  return entries;
}

export interface SharedState {
  localTip: string | null;
  remoteTip: string | null;
  /** path -> blob id: the union of both tips, the local version winning on a clash. */
  entries: Map<string, string>;
}

/** Reads the shared files as of the last fetch, without changing any ref. */
export async function readShared(root: string, remote: string | null): Promise<SharedState> {
  const localTip = await revParse(root, LOCAL_REF);
  const remoteTip = remote ? await revParse(root, remoteRef(remote)) : null;
  const entries = new Map([...(await entriesOf(root, remoteTip)), ...(await entriesOf(root, localTip))]);
  return { localTip, remoteTip, entries };
}

export async function readBlob(root: string, blob: string): Promise<string> {
  return ok(root, ['cat-file', 'blob', blob]);
}

async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  return (await run(root, ['merge-base', '--is-ancestor', a, b])).exitCode === 0;
}

/** Commits `entries` on top of `parents`; returns the single parent unchanged when nothing differs. */
async function commitEntries(root: string, entries: Map<string, string>, parents: string[], message: string, who: Identity): Promise<string | null> {
  if (entries.size === 0 && parents.length === 0) return null;
  const index = path.join(os.tmpdir(), `relayvora-share-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    const lines = [...entries].map(([p, blob]) => `100644 blob ${blob}\t${p}`).join('\n');
    await ok(root, ['update-index', '--index-info'], { env, input: `${lines}\n` });
    const tree = (await ok(root, ['write-tree'], { env })).trim();
    if (parents.length === 1 && (await ok(root, ['rev-parse', `${parents[0]}^{tree}`])).trim() === tree) return parents[0]!;
    const name = who.name ?? 'Relayvora';
    const email = who.email ?? 'relayvora@localhost';
    return (
      await ok(root, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
        env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
      })
    ).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

export interface WriteResult {
  entries: Map<string, string>;
  /** True when the remote was updated. */
  pushed: boolean;
}

/**
 * Adds files to the shared branch, merging with what the remote has, and pushes. A push that loses a
 * race with someone else's is retried after fetching again.
 */
export async function writeShared(
  root: string,
  remote: string | null,
  additions: ReadonlyMap<string, string>,
  message: string,
  who: Identity,
  { fetched = false }: { fetched?: boolean } = {},
): Promise<WriteResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (remote && (attempt > 0 || !fetched)) await fetchShared(root, remote);
    const { localTip, remoteTip, entries } = await readShared(root, remote);
    for (const [p, content] of additions) entries.set(p, (await ok(root, ['hash-object', '-w', '--stdin'], { input: content })).trim());

    let parents = [...new Set([localTip, remoteTip].filter((c): c is string => c !== null))];
    if (parents.length === 2) {
      if (await isAncestor(root, parents[0]!, parents[1]!)) parents = [parents[1]!];
      else if (await isAncestor(root, parents[1]!, parents[0]!)) parents = [parents[0]!];
    }
    const tip = await commitEntries(root, entries, parents, message, who);
    if (!tip) return { entries, pushed: false };
    if (tip !== localTip) await ok(root, ['update-ref', LOCAL_REF, tip]);
    if (!remote || tip === remoteTip) return { entries, pushed: false };

    const push = await run(root, ['push', '--quiet', remote, `${LOCAL_REF}:${LOCAL_REF}`], { timeoutMs: 120_000 });
    if (push.exitCode === 0) {
      await run(root, ['update-ref', remoteRef(remote), tip]);
      return { entries, pushed: true };
    }
    if (!/rejected|fetch first|non-fast-forward/i.test(push.stderr)) {
      throw new RelayvoraError(`Could not push to ${remote}: ${push.stderr.trim() || `exit ${push.exitCode}`}`, ExitCode.Failure);
    }
  }
  throw new RelayvoraError(`Could not push to ${remote}: the shared branch kept changing; try again.`, ExitCode.Failure);
}

export const checkpointPath = (id: string) => `checkpoints/${id}.json`;
export const sentPath = (id: string, email: string) => `sent/${id}/${email.toLowerCase().replace(/[^a-z0-9@._+-]/g, '_')}.json`;
export const CHECKPOINT_PATH = /^checkpoints\/([^/]+)\.json$/;
export const SENT_PATH = /^sent\/([^/]+)\/[^/]+\.json$/;

/** A browser link to the repository's collaborator settings, when it is hosted on GitHub. */
export function githubAccessUrl(url: string | null): string | null {
  const m = url ? /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}/settings/access` : null;
}
