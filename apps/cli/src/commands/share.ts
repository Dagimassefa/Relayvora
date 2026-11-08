import { RelayvoraError, ExitCode, isValidCheckpointId } from '@relayvora/core';
import { loadCheckpoint } from '../checkpoint-service.js';
import { confirmOrAbort } from '../confirm.js';
import { type CliContext, openStore, otherAgent } from '../context.js';
import { ensureProject, locateProject } from '../project.js';
import {
  CHECKPOINT_PATH,
  SENT_PATH,
  SHARE_BRANCH,
  checkpointPath,
  fetchShared,
  githubAccessUrl,
  identity,
  readBlob,
  readShared,
  remoteUrl,
  sentPath,
  writeShared,
  type Identity,
} from '../share-branch.js';
import { label, relativeTime, rule, statusIcon } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';
import { EXPORT_BUNDLE_FORMAT, buildJsonExport, latestCheckpointId, withEditedHandoff } from './export.js';
import { importParsed, parseExport } from './import.js';

export interface ShareFlags {
  remote?: string;
  yes?: boolean;
}

interface Repo {
  root: string;
  /** null when the repository has no such remote: the branch is kept locally only. */
  remote: string | null;
  url: string | null;
  me: Identity;
}

async function openRepo(ctx: CliContext, remoteName = 'origin'): Promise<Repo> {
  const { root, isGitRepo } = await locateProject(ctx.cwd);
  if (!isGitRepo) throw new RelayvoraError('Sharing goes through the project\'s Git repository; run this inside a Git clone.', ExitCode.PreconditionFailed);
  const url = await remoteUrl(root, remoteName);
  return { root, remote: url ? remoteName : null, url, me: await identity(root) };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Imports every shared checkpoint this store does not have yet. Returns the ids imported, and the
 * branch files that were refused (bad id, id that does not match the file name, invalid patch...).
 */
async function importMissing(ctx: CliContext, root: string, entries: Map<string, string>): Promise<{ received: string[]; rejected: string[] }> {
  const store = openStore(ctx);
  let missing: string[];
  try {
    const ids = [...entries.keys()].flatMap((p) => CHECKPOINT_PATH.exec(p)?.[1] ?? []);
    missing = ids.filter((id) => store.getCheckpoint(id)?.id !== id);
  } finally {
    store.close();
  }
  const received: string[] = [];
  const rejected: string[] = [];
  for (const id of missing) {
    try {
      const parsed = parseExport(await readBlob(root, entries.get(checkpointPath(id))!), checkpointPath(id), id);
      await importParsed(ctx, parsed, `${SHARE_BRANCH}:${checkpointPath(id)}`);
      received.push(id);
    } catch (error) {
      rejected.push(`${checkpointPath(id)}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  return { received, rejected };
}

export interface SyncResult {
  remote: string | null;
  url: string | null;
  /** Checkpoints from this machine added to the shared branch. */
  shared: string[];
  /** Checkpoints from other devices or people added to this machine. */
  received: string[];
  pushed: boolean;
  notes: string[];
}

/**
 * Two-way sync of this project's checkpoints through the `relayvora/handoffs` branch: yours go up,
 * everything on the branch comes down. The same GitHub (or any Git) login then gives every device
 * the full history. Asks before sharing new checkpoints, since everyone who can read the repository
 * can read them.
 */
export async function runSync(ctx: CliContext, flags: ShareFlags = {}): Promise<SyncResult> {
  const repo = await openRepo(ctx, flags.remote);
  const notes: string[] = [];
  if (!repo.remote) notes.push(`This repository has no "${flags.remote ?? 'origin'}" remote, so checkpoints were only saved to the local ${SHARE_BRANCH} branch.`);
  if (repo.remote) await fetchShared(repo.root, repo.remote);
  const before = await readShared(repo.root, repo.remote);

  const store = openStore(ctx);
  let ids: string[];
  try {
    const project = await ensureProject(ctx.cwd, store);
    ids = store.listCheckpoints(project.record.id, 100_000).map((c) => c.id).filter((id) => !before.entries.has(checkpointPath(id)));
  } finally {
    store.close();
  }
  if (ids.length && repo.remote) {
    await confirmOrAbort(`Share ${ids.length} checkpoint(s) with everyone who can read ${repo.url}?`, flags.yes === undefined ? {} : { yes: flags.yes });
  }
  const additions = new Map<string, string>();
  for (const id of ids) additions.set(checkpointPath(id), json((await buildJsonExport(withEditedHandoff(await loadCheckpoint(ctx, id)).cp, false)).body));

  const { entries, pushed } = await writeShared(repo.root, repo.remote, additions, `relayvora: share ${ids.length} checkpoint(s)`, repo.me, { fetched: true });
  const { received, rejected } = await importMissing(ctx, repo.root, entries);
  notes.push(...rejected.map((r) => `Not imported: ${r}`));
  return { remote: repo.remote, url: repo.url, shared: ids, received, pushed, notes };
}

export function renderSync(r: SyncResult, t: Theme = PLAIN): string {
  const out = ['', `  ${rule(t, 'SYNC', 'lime', Math.min(t.width, 78) - 2)}`, ''];
  out.push(`  ${label(t, 'via', 10)}${r.url ? t.fg('cyan', r.url) : t.dim('local branch only')}`);
  out.push(`  ${label(t, 'shared', 10)}${r.shared.length ? `${statusIcon(t, 'ok')} ${r.shared.length} checkpoint(s) from this machine` : t.dim('nothing new from this machine')}`);
  out.push(`  ${label(t, 'received', 10)}${r.received.length ? `${statusIcon(t, 'ok')} ${r.received.length} checkpoint(s): ${r.received.slice(0, 3).join(', ')}${r.received.length > 3 ? ', ...' : ''}` : t.dim('nothing new')}`);
  if (r.notes.length) out.push('', ...r.notes.map((n) => `  ${statusIcon(t, 'warn')} ${t.fg('amber', n)}`));
  out.push('', `  ${t.dim('See them with')} ${t.bold('relayvora checkpoint list')}${t.dim(', what was sent to you with')} ${t.bold('relayvora inbox')}`, '');
  return out.join('\n');
}

export interface SendFlags extends ShareFlags {
  to: string[];
  withChanges?: boolean;
  note?: string;
}

export interface SendResult {
  checkpointId: string;
  to: string[];
  remote: string | null;
  url: string | null;
  pushed: boolean;
  changedFiles: string[];
  /** Where to give the recipients access to the repository, when it is on GitHub. */
  accessUrl: string | null;
  notes: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends a checkpoint (default: the latest) to people by the email they use with Git. It lands in
 * their `relayvora inbox` once they can read the repository; inviting them there is GitHub's job.
 */
export async function runSend(ctx: CliContext, id: string | undefined, flags: SendFlags): Promise<SendResult> {
  const to = [...new Set(flags.to.map((e) => e.trim().toLowerCase()))];
  const bad = to.filter((e) => !EMAIL.test(e));
  if (to.length === 0 || bad.length) throw new RelayvoraError(`--to needs email addresses${bad.length ? `; not an email: ${bad.join(', ')}` : ''}`, ExitCode.Usage);
  const repo = await openRepo(ctx, flags.remote);
  if (!repo.me.email) throw new RelayvoraError('Set your Git email first, so people know who sent it: git config --global user.email you@example.com', ExitCode.PreconditionFailed);
  if (!repo.remote) throw new RelayvoraError(`This repository has no "${flags.remote ?? 'origin'}" remote to send through. Push it to GitHub first.`, ExitCode.PreconditionFailed);

  const { cp } = withEditedHandoff(await loadCheckpoint(ctx, id ?? (await latestCheckpointId(ctx))));
  const { body, changes, notes } = await buildJsonExport(cp, Boolean(flags.withChanges));
  const carried = changes ? ` with uncommitted changes to ${changes.files.length} file(s)` : '';
  await confirmOrAbort(
    `Send ${cp.id}${carried} to ${to.join(', ')}? Everyone who can read ${repo.url} can see it.`,
    flags.yes === undefined ? {} : { yes: flags.yes },
  );

  const at = new Date().toISOString();
  const additions = new Map<string, string>([[checkpointPath(cp.id), json(body)]]);
  for (const email of to) {
    additions.set(sentPath(cp.id, email), json({ checkpointId: cp.id, from: repo.me, to: email, at, ...(flags.note ? { note: flags.note } : {}) }));
  }
  const { pushed } = await writeShared(repo.root, repo.remote, additions, `relayvora: send ${cp.id} to ${to.join(', ')}`, repo.me);

  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(repo.root);
    store.recordAudit({ action: 'checkpoint.send', projectId: project?.id ?? null, target: cp.id, details: { to, remote: repo.url, changedFiles: changes?.files.length ?? 0 } });
  } finally {
    store.close();
  }
  return { checkpointId: cp.id, to, remote: repo.remote, url: repo.url, pushed, changedFiles: changes?.files ?? [], accessUrl: githubAccessUrl(repo.url), notes };
}

export function renderSend(r: SendResult, t: Theme = PLAIN): string {
  const out = ['', `  ${rule(t, `${t.sym.bolt} SENT`, 'lime', Math.min(t.width, 78) - 2)}`, ''];
  out.push(`  ${label(t, 'checkpoint', 12)}${t.bold(r.checkpointId)}${r.changedFiles.length ? t.dim(` + changes to ${r.changedFiles.length} file(s)`) : ''}`);
  out.push(`  ${label(t, 'to', 12)}${r.to.join(', ')}`);
  out.push(`  ${label(t, 'via', 12)}${t.fg('cyan', r.url ?? '')}`);
  if (r.notes.length) out.push('', ...r.notes.map((n) => `  ${statusIcon(t, 'warn')} ${t.fg('amber', n)}`));
  out.push('', `  ${t.dim('They get it with')} ${t.bold('relayvora inbox')} ${t.dim('in their clone of the repository.')}`);
  out.push(
    `  ${t.dim('Not a collaborator yet? Invite them by email')}${r.accessUrl ? `${t.dim(':')} ${t.fg('cyan', r.accessUrl)}` : t.dim(' on your Git host.')}`,
    '',
  );
  return out.join('\n');
}

export interface InboxItem {
  checkpointId: string;
  from: Identity;
  to: string[];
  at: string;
  note: string | null;
  goal: string;
  targetProvider: string | null;
  sourceProvider: string;
  carriesChanges: boolean;
}

export interface InboxResult {
  me: string;
  sent: boolean;
  items: InboxItem[];
  received: string[];
  /** Shared checkpoints that were refused, with the reason. */
  rejected: string[];
}

interface SentRecord {
  checkpointId: string;
  from: Identity;
  to: string;
  at: string;
  note?: string;
}

/**
 * Checkpoints sent to you (by your Git email), or with --sent those you sent. Fetches first and
 * imports anything new, so every item is ready for `relayvora launch`.
 */
export async function runInbox(ctx: CliContext, flags: ShareFlags & { sent?: boolean } = {}): Promise<InboxResult> {
  const repo = await openRepo(ctx, flags.remote);
  if (!repo.me.email) throw new RelayvoraError('Set your Git email first, the address people send to: git config --global user.email you@example.com', ExitCode.PreconditionFailed);
  if (repo.remote) await fetchShared(repo.root, repo.remote);
  const { entries } = await readShared(repo.root, repo.remote);

  const byId = new Map<string, InboxItem>();
  for (const [p, blob] of entries) {
    if (!SENT_PATH.test(p)) continue;
    let rec: SentRecord;
    try {
      rec = JSON.parse(await readBlob(repo.root, blob)) as SentRecord;
    } catch {
      continue;
    }
    if (typeof rec?.checkpointId !== 'string' || !isValidCheckpointId(rec.checkpointId)) continue;
    const mine = flags.sent ? rec.from?.email === repo.me.email : rec.to === repo.me.email;
    const cpBlob = entries.get(checkpointPath(rec.checkpointId));
    if (!mine || !cpBlob) continue;
    const key = flags.sent ? rec.checkpointId : `${rec.checkpointId} ${rec.from?.email}`;
    const existing = byId.get(key);
    if (existing) {
      existing.to.push(rec.to);
      continue;
    }
    let raw: { format?: string; changes?: unknown };
    let checkpoint;
    try {
      raw = JSON.parse(await readBlob(repo.root, cpBlob)) as { format?: string; changes?: unknown };
      ({ checkpoint } = parseExport(JSON.stringify(raw), checkpointPath(rec.checkpointId), rec.checkpointId));
    } catch {
      continue; // reported by importMissing below
    }
    byId.set(key, {
      checkpointId: rec.checkpointId,
      from: rec.from,
      to: [rec.to],
      at: rec.at,
      note: rec.note ?? null,
      goal: checkpoint.task.goal.text.split('\n')[0]!.slice(0, 100),
      targetProvider: checkpoint.handoff.targetProvider,
      sourceProvider: checkpoint.source.provider,
      carriesChanges: raw.format === EXPORT_BUNDLE_FORMAT && Boolean(raw.changes),
    });
  }
  const { received, rejected } = await importMissing(ctx, repo.root, entries);
  const items = [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
  return { me: repo.me.email, sent: Boolean(flags.sent), items, received, rejected };
}

export function renderInbox(r: InboxResult, t: Theme = PLAIN): string {
  const title = r.sent ? `SENT (${r.items.length})` : `INBOX (${r.items.length})`;
  const out = ['', `  ${rule(t, title, 'violet', Math.min(t.width, 78) - 2)}`, ''];
  const rejected = r.rejected.map((x) => `  ${statusIcon(t, 'warn')} ${t.fg('amber', `Not imported: ${x}`)}`);
  if (r.items.length === 0) {
    if (rejected.length) out.push(...rejected, '');
    out.push(`  ${statusIcon(t, 'info')} ${t.dim(r.sent ? 'You have not sent anything from this repository yet.' : `Nothing sent to ${r.me} in this repository yet.`)}`, '');
    return out.join('\n');
  }
  for (const i of r.items) {
    // The sender is whatever the shared branch says; anyone who can push to it can write any name.
    const who = r.sent ? `to ${i.to.join(', ')}` : `from ${i.from?.name ? `${i.from.name} <${i.from.email}>` : i.from?.email ?? 'unknown'} ${t.dim('(unverified)')}`;
    const target = i.targetProvider ?? (i.sourceProvider === 'manual' ? 'claude' : otherAgent(i.sourceProvider));
    out.push(`  ${statusIcon(t, 'ok')} ${t.bold(i.checkpointId)}  ${who}  ${t.dim(relativeTime(i.at))}`);
    out.push(`      ${i.goal}${i.carriesChanges ? t.dim('  · carries uncommitted changes') : ''}`);
    if (i.note) out.push(`      ${t.fg('amber', `"${i.note}"`)}`);
    if (!r.sent) {
      const apply = i.carriesChanges ? `${t.bold(`relayvora import ${i.checkpointId} --apply-changes`)}${t.dim(', then ')}` : '';
      out.push(`      ${t.dim('continue:')} ${apply}${t.bold(`relayvora launch ${i.checkpointId} --to ${target}`)}`);
    }
    out.push('');
  }
  if (rejected.length) out.push(...rejected, '');
  if (!r.sent) out.push(`  ${t.dim('Senders and contents come from the shared branch and are not verified. Review a handoff before acting on it.')}`, '');
  return out.join('\n');
}
