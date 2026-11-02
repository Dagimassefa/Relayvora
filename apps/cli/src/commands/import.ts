import fs from 'node:fs';
import path from 'node:path';
import { RelayvoraError, ExitCode, parseCheckpoint, type Checkpoint } from '@relayvora/core';
import { getRepoState, git } from '@relayvora/git';
import { Changes, applyChanges } from '../changes.js';
import { type CliContext, openStore, otherAgent } from '../context.js';
import { ensureProject, handoffPath, locateProject, projectDir } from '../project.js';
import { CHECKPOINT_PATH, SHARE_BRANCH, checkpointPath, readBlob, readShared, remoteUrl } from '../share-branch.js';
import { label, rule, statusIcon } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';
import { EXPORT_BUNDLE_FORMAT } from './export.js';

export interface ImportOptions {
  /** Apply the carried uncommitted changes to the working tree. */
  applyChanges?: boolean;
  /** Replace a checkpoint with the same id imported earlier. */
  force?: boolean;
  /** Remote whose shared branch is searched when the argument is a checkpoint id. */
  remote?: string;
}

export interface ImportResult {
  checkpointId: string;
  projectRoot: string;
  /** Where the checkpoint was made on the other machine. */
  originalRoot: string;
  handoffFile: string;
  /** The checkpoint was already in this store, so it was left as it was. */
  alreadyImported: boolean;
  changes: { files: string[]; patchFile: string; applied: boolean } | null;
  targetProvider: string | null;
  sourceProvider: string;
  notes: string[];
}

export interface ParsedExport {
  checkpoint: Checkpoint;
  changes: Changes | null;
}

/** Reads an export file, or a checkpoint shared on the project's relayvora/handoffs branch (by id or prefix). */
async function readExport(ctx: CliContext, fileOrId: string, remote: string): Promise<ParsedExport> {
  const file = path.resolve(ctx.cwd, fileOrId);
  if (fs.existsSync(file)) return parseExport(fs.readFileSync(file, 'utf8'), file);
  const { root, isGitRepo } = await locateProject(ctx.cwd);
  if (isGitRepo) {
    const { entries } = await readShared(root, (await remoteUrl(root, remote)) ? remote : null);
    const ids = [...entries.keys()].flatMap((p) => CHECKPOINT_PATH.exec(p)?.[1] ?? []).filter((id) => id.startsWith(fileOrId));
    const id = ids.includes(fileOrId) ? fileOrId : ids.length === 1 ? ids[0]! : null;
    if (ids.length > 1 && !id) throw new RelayvoraError(`"${fileOrId}" matches several shared checkpoints: ${ids.join(', ')}`, ExitCode.Usage);
    if (id) return parseExport(await readBlob(root, entries.get(checkpointPath(id))!), `${SHARE_BRANCH}:${checkpointPath(id)}`);
  }
  throw new RelayvoraError(`No such file, and no shared checkpoint "${fileOrId}" (run relayvora sync first): ${file}`, ExitCode.NotFound);
}

export function parseExport(text: string, file: string): ParsedExport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const hint = text.trimStart().startsWith('#') ? ' This looks like a Markdown handoff, which cannot be imported.' : '';
    throw new RelayvoraError(
      `${file} is not a Relayvora JSON export.${hint} On the other machine run: relayvora export --out handoff.json`,
      ExitCode.Usage,
    );
  }
  const bundle = data as { format?: unknown; checkpoint?: unknown; changes?: unknown };
  if (bundle.format === EXPORT_BUNDLE_FORMAT) {
    return { checkpoint: parseCheckpoint(bundle.checkpoint), changes: bundle.changes ? Changes.parse(bundle.changes) : null };
  }
  return { checkpoint: parseCheckpoint(data), changes: null };
}

/** Points the checkpoint at this clone: its root, and the root quoted in the handoff text. */
function rebase(cp: Checkpoint, root: string): Checkpoint {
  if (cp.project.root === root) return cp;
  return {
    ...cp,
    project: { ...cp.project, root },
    handoff: { ...cp.handoff, prompt: cp.handoff.prompt?.split(cp.project.root).join(root) ?? null },
    warnings: [...cp.warnings, `Imported from another machine, where the project was at ${cp.project.root}.`],
  };
}

/** What the clone is missing compared to the machine the checkpoint came from. */
async function gitNotes(cp: Checkpoint, root: string, carried: boolean): Promise<string[]> {
  const notes: string[] = [];
  const head = cp.project.gitHead;
  const short = head?.slice(0, 12);
  const where = cp.project.branch ? ` on ${cp.project.branch}` : '';
  if (head) {
    const local = await getRepoState(root).catch(() => null);
    const known = (await git(root, ['cat-file', '-e', `${head}^{commit}`])).exitCode === 0;
    if (!known) {
      notes.push(`Commit ${short}${where} is not in this clone yet. Push it from the other machine, then run git pull here.`);
    } else if (local && local.head !== head) {
      notes.push(`This clone is at ${local.head?.slice(0, 12) ?? 'no commit'}${local.branch ? ` on ${local.branch}` : ''}; the checkpoint was made at ${short}${where}.`);
    }
  }
  if (cp.project.dirtyFiles.length && !carried) {
    const shown = cp.project.dirtyFiles.slice(0, 5).map((d) => d.path).join(', ');
    notes.push(
      `${cp.project.dirtyFiles.length} file(s) had uncommitted changes on the other machine and are not in this export (${shown}${cp.project.dirtyFiles.length > 5 ? ', ...' : ''}). Commit and push them there, or export again with --with-changes.`,
    );
  }
  return notes;
}

/**
 * Imports a checkpoint exported on another machine into the project here, so `relayvora launch`
 * can continue it. The checkpoint is re-validated and pointed at this clone. Carried uncommitted
 * changes are saved next to the handoff, and applied only with --apply-changes.
 */
export async function runImport(ctx: CliContext, file: string, options: ImportOptions = {}): Promise<ImportResult> {
  return importParsed(ctx, await readExport(ctx, file, options.remote ?? 'origin'), file, options);
}

/** Imports an already-read export; `source` names where it came from, for messages and the audit log. */
export async function importParsed(ctx: CliContext, parsed: ParsedExport, source: string, options: ImportOptions = {}): Promise<ImportResult> {
  const { checkpoint: incoming, changes } = parsed;
  if (options.applyChanges && !changes) {
    throw new RelayvoraError('This export carries no uncommitted changes; export it with --with-changes to bring them along.', ExitCode.Usage);
  }

  const store = openStore(ctx);
  try {
    const project = await ensureProject(ctx.cwd, store);
    if (changes && !project.isGitRepo) {
      throw new RelayvoraError('This export carries uncommitted changes, which need a Git clone of the project here.', ExitCode.PreconditionFailed);
    }
    const cp = rebase(incoming, project.root);
    const handoffFile = handoffPath(project.root, cp.id);
    const existing = store.getCheckpoint(cp.id)?.id === cp.id;
    const alreadyImported = existing && !options.force;

    if (!alreadyImported) {
      if (existing) store.deleteCheckpoint(cp.id);
      store.saveCheckpoint(cp, project.record.id);
      fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
      fs.writeFileSync(handoffFile, cp.handoff.prompt ?? '');
    }

    let carried: ImportResult['changes'] = null;
    if (changes) {
      const patchFile = path.join(projectDir(project.root), 'handoffs', `${cp.id}.patch`);
      fs.mkdirSync(path.dirname(patchFile), { recursive: true });
      fs.writeFileSync(patchFile, changes.patch);
      if (options.applyChanges) await applyChanges(project.root, changes);
      carried = { files: changes.files, patchFile, applied: Boolean(options.applyChanges) };
    }

    const notes = project.isGitRepo && cp.project.isGitRepo ? await gitNotes(cp, project.root, Boolean(changes)) : [];
    if (carried && !carried.applied) {
      notes.push(`It carries uncommitted changes to ${carried.files.length} file(s), saved in ${carried.patchFile}. Apply them with: relayvora import ${source} --apply-changes`);
    }

    store.recordAudit({
      action: 'checkpoint.import',
      projectId: project.record.id,
      target: cp.id,
      details: { from: source, originalRoot: incoming.project.root, alreadyImported, changedFiles: carried?.files.length ?? 0, applied: carried?.applied ?? false },
    });
    return {
      checkpointId: cp.id,
      projectRoot: project.root,
      originalRoot: incoming.project.root,
      handoffFile,
      alreadyImported,
      changes: carried,
      targetProvider: cp.handoff.targetProvider,
      sourceProvider: cp.source.provider,
      notes,
    };
  } finally {
    store.close();
  }
}

export function renderImport(r: ImportResult, t: Theme = PLAIN): string {
  const target = r.targetProvider ?? (r.sourceProvider === 'manual' ? 'claude' : otherAgent(r.sourceProvider));
  const applied = Boolean(r.changes?.applied);
  const title = applied ? 'CHANGES APPLIED' : r.alreadyImported ? 'ALREADY IMPORTED' : 'IMPORTED';
  const out = ['', `  ${rule(t, title, 'lime', Math.min(t.width, 78) - 2)}`, ''];
  out.push(`  ${label(t, 'checkpoint', 12)}${t.bold(r.checkpointId)}`);
  out.push(`  ${label(t, 'from', 12)}${t.dim(r.originalRoot)}`);
  out.push(`  ${label(t, 'handoff', 12)}${t.fg('cyan', r.handoffFile)}`);
  if (r.changes) {
    out.push(
      `  ${label(t, 'changes', 12)}${
        applied ? `${statusIcon(t, 'ok')} applied to ${r.changes.files.length} file(s)` : t.dim(`${r.changes.files.length} file(s), not applied yet`)
      }`,
    );
  }
  if (r.alreadyImported && !applied) out.push('', `  ${statusIcon(t, 'info')} ${t.dim('It was imported before and left unchanged; pass --force to replace it.')}`);
  if (r.notes.length) out.push('', ...r.notes.map((n) => `  ${statusIcon(t, 'warn')} ${t.fg('amber', n)}`));
  out.push('', `  ${t.dim('Continue with')} ${t.bold(`relayvora launch ${r.checkpointId} --to ${target}`)}`, '');
  return out.join('\n');
}
