import fs from 'node:fs';
import path from 'node:path';
import { RelayvoraError, ExitCode, estimateTokens, redact, type Checkpoint, type RedactionFinding } from '@relayvora/core';
import { type Changes, captureChanges } from '../changes.js';
import { loadCheckpoint } from '../checkpoint-service.js';
import { confirmOrAbort } from '../confirm.js';
import { type CliContext, openStore } from '../context.js';
import { handoffPath, locateProject } from '../project.js';

/** Marks a JSON export that carries more than the checkpoint (today: uncommitted changes). */
export const EXPORT_BUNDLE_FORMAT = 'relayvora-export';

export interface ExportOptions {
  format?: 'markdown' | 'json';
  out?: string;
  force?: boolean;
  yes?: boolean;
  /** JSON only: carry the uncommitted changes as a patch. */
  withChanges?: boolean;
}

export interface ExportResult {
  checkpointId: string;
  format: 'markdown' | 'json';
  out: string | null;
  bytes: number;
  estimatedTokens: number;
  /** Secrets caught by the export-time redaction pass (normally none: content is redacted at creation). */
  redactions: RedactionFinding[];
  /** True when the handoff file had been edited and the edited text was exported. */
  editedHandoff: boolean;
  /** Files whose uncommitted changes are carried in the export. */
  changedFiles: string[];
  notes: string[];
  content: string;
}

export async function latestCheckpointId(ctx: CliContext): Promise<string> {
  const { root } = await locateProject(ctx.cwd);
  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot(root);
    const latest = project ? store.listCheckpoints(project.id, 1)[0] : undefined;
    if (!latest) throw new RelayvoraError(`No checkpoints for ${root} yet; create one with relayvora checkpoint create.`, ExitCode.NotFound);
    return latest.id;
  } finally {
    store.close();
  }
}

/** The handoff as the user left it: edits to the handoff file win over the stored text. */
export function withEditedHandoff(cp: Checkpoint): { cp: Checkpoint; edited: boolean } {
  const file = handoffPath(cp.project.root, cp.id);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (text === null || text === cp.handoff.prompt || !text.trim()) return { cp, edited: false };
  return { cp: { ...cp, handoff: { ...cp.handoff, prompt: text, estimatedTokens: estimateTokens(text).tokens } }, edited: true };
}

export interface JsonExport {
  /** The checkpoint, or a bundle of the checkpoint and its uncommitted changes. */
  body: unknown;
  findings: RedactionFinding[];
  changes: Changes | null;
  notes: string[];
}

/** Builds what a JSON export holds: the re-redacted checkpoint, plus the uncommitted changes if asked. */
export async function buildJsonExport(cp: Checkpoint, withChanges: boolean): Promise<JsonExport> {
  const notes: string[] = [];
  let changes: Changes | null = null;
  if (withChanges) {
    if (!cp.project.isGitRepo) throw new RelayvoraError('--with-changes needs a Git repository', ExitCode.PreconditionFailed);
    changes = await captureChanges(cp.project.root);
    if (!changes) notes.push('There are no uncommitted changes to carry.');
    if (changes?.withheld.length) notes.push(`Left out sensitive file(s): ${changes.withheld.join(', ')}. Copy them over yourself if they are needed.`);
  } else if (cp.project.dirtyFiles.length > 0) {
    notes.push(
      `${cp.project.dirtyFiles.length} file(s) had uncommitted changes at the checkpoint. They are not in this export: commit and push them, or add --with-changes.`,
    );
  }
  // The patch is embedded after redaction: it was checked for secrets already, and masking would break it.
  const redacted = redact(JSON.stringify(cp));
  const checkpoint: unknown = JSON.parse(redacted.text);
  const body = changes ? { format: EXPORT_BUNDLE_FORMAT, version: 1, checkpoint, changes } : checkpoint;
  return { body, findings: redacted.findings, changes, notes };
}

/**
 * Exports a checkpoint (the project's latest when no id is given). Redaction always runs again on
 * the way out. JSON exports can be imported on another machine with `relayvora import`. Writing to a
 * file requires confirmation (or --yes) and never overwrites without --force.
 */
export async function runExport(ctx: CliContext, id: string | undefined, options: ExportOptions): Promise<ExportResult> {
  const format = options.format ?? (options.withChanges || options.out?.toLowerCase().endsWith('.json') ? 'json' : 'markdown');
  if (options.withChanges && format !== 'json') throw new RelayvoraError('--with-changes needs the JSON format', ExitCode.Usage);
  const { cp, edited } = withEditedHandoff(await loadCheckpoint(ctx, id ?? (await latestCheckpointId(ctx))));

  let content: string;
  let findings: RedactionFinding[];
  let changes: Changes | null = null;
  let notes: string[] = [];
  if (format === 'json') {
    let body: unknown;
    ({ body, findings, changes, notes } = await buildJsonExport(cp, Boolean(options.withChanges)));
    content = `${JSON.stringify(body, null, 2)}\n`;
  } else {
    ({ text: content, findings } = redact(cp.handoff.prompt ?? ''));
  }

  const result: ExportResult = {
    checkpointId: cp.id,
    format,
    out: null,
    bytes: Buffer.byteLength(content),
    estimatedTokens: estimateTokens(cp.handoff.prompt ?? '').tokens,
    redactions: findings,
    editedHandoff: edited,
    changedFiles: changes?.files ?? [],
    notes,
    content,
  };
  if (!options.out) return result;

  const out = path.resolve(ctx.cwd, options.out);
  if (fs.existsSync(out) && !options.force) {
    throw new RelayvoraError(`${out} already exists; pass --force to overwrite`, ExitCode.PreconditionFailed);
  }
  const extra = findings.length > 0 ? `, ${findings.reduce((a, f) => a + f.count, 0)} extra redaction(s)` : '';
  const carried = changes ? `, with uncommitted changes to ${changes.files.length} file(s)` : '';
  await confirmOrAbort(`Export ${cp.id} as ${format} (~${result.estimatedTokens} tokens${extra}${carried}) to ${out}?`, {
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);

  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot((await locateProject(ctx.cwd)).root);
    store.recordAudit({
      action: 'checkpoint.export',
      projectId: project?.id ?? null,
      target: cp.id,
      details: { out, format, bytes: result.bytes, changedFiles: result.changedFiles.length },
    });
  } finally {
    store.close();
  }
  return { ...result, out };
}
