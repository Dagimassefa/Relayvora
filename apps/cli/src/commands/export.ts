import fs from 'node:fs';
import path from 'node:path';
import { AgentRelayError, ExitCode, estimateTokens, redact, type RedactionFinding } from '@agentrelay/core';
import { loadCheckpoint } from '../checkpoint-service.js';
import { confirmOrAbort } from '../confirm.js';
import { type CliContext, openStore } from '../context.js';
import { locateProject } from '../project.js';

export interface ExportOptions {
  format?: 'markdown' | 'json';
  out?: string;
  force?: boolean;
  yes?: boolean;
}

export interface ExportResult {
  checkpointId: string;
  format: 'markdown' | 'json';
  out: string | null;
  bytes: number;
  estimatedTokens: number;
  /** Secrets caught by the export-time redaction pass (normally none: content is redacted at creation). */
  redactions: RedactionFinding[];
  content: string;
}

/**
 * Exports a checkpoint. Redaction always runs again on the way out. Writing to a file requires
 * confirmation (or --yes) and never overwrites without --force.
 */
export async function runExport(ctx: CliContext, id: string, options: ExportOptions): Promise<ExportResult> {
  const cp = await loadCheckpoint(ctx, id);
  const format = options.format ?? 'markdown';
  const raw = format === 'json' ? `${JSON.stringify(cp, null, 2)}\n` : (cp.handoff.prompt ?? '');
  const { text: content, findings } = redact(raw);
  const result: ExportResult = {
    checkpointId: cp.id,
    format,
    out: null,
    bytes: Buffer.byteLength(content),
    estimatedTokens: estimateTokens(content).tokens,
    redactions: findings,
    content,
  };
  if (!options.out) return result;

  const out = path.resolve(ctx.cwd, options.out);
  if (fs.existsSync(out) && !options.force) {
    throw new AgentRelayError(`${out} already exists; pass --force to overwrite`, ExitCode.PreconditionFailed);
  }
  const extra = findings.length > 0 ? `, ${findings.reduce((a, f) => a + f.count, 0)} extra redaction(s)` : '';
  await confirmOrAbort(`Export ${cp.id} as ${format} (~${result.estimatedTokens} tokens${extra}) to ${out}?`, {
    ...(options.yes !== undefined ? { yes: options.yes } : {}),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);

  const store = openStore(ctx);
  try {
    const project = store.getProjectByRoot((await locateProject(ctx.cwd)).root);
    store.recordAudit({ action: 'checkpoint.export', projectId: project?.id ?? null, target: cp.id, details: { out, format, bytes: result.bytes } });
  } finally {
    store.close();
  }
  return { ...result, out };
}
