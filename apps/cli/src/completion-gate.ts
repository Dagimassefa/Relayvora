import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ExitCode, RelayvoraError, isWithin, redact, runCommand, type VerificationResult } from '@relayvora/core';
import { runVerification } from './checkpoint-service.js';
import { type CliContext } from './context.js';
import { locateProject } from './project.js';

type GateState = 'verifying' | 'recovery_required' | 'blocked' | 'stale';
export interface GateRecord {
  version: 1;
  project: string;
  state: GateState;
  spec: string;
  objective: string;
  sourceFingerprint: string;
  specFingerprint: string;
  startedAt: string;
  finishedAt: string | null;
  result: { status: 'passed' | 'failed' | 'unknown'; exitCode: number | null; detail: string } | null;
  reasons: string[];
}

function digest(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function statePath(ctx: CliContext, root: string): string { return path.join(ctx.dataDir, 'completion-gates', `${digest(root)}.json`); }

/** Full contents of tracked and non-ignored untracked files plus HEAD and index. Reject ambiguous inputs. */
export async function fingerprints(root: string, spec: string): Promise<{ source: string; spec: string }> {
  const command = async (args: string[]) => {
    const result = await runCommand('git', args, { cwd: root, timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error(`Cannot fingerprint repository: git ${args[0]} failed or output was truncated`);
    return result.stdout;
  };
  const [head, files, index] = await Promise.all([
    command(['rev-parse', 'HEAD']), command(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    command(['ls-files', '--stage', '-z']),
  ]);
  const hash = createHash('sha256');
  const add = (value: string | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); hash.update(`${bytes.length}:`); hash.update(bytes); };
  add(head); add(index);
  for (const name of [...new Set(files.split('\0').filter(Boolean))].sort()) {
    const file = path.resolve(root, name);
    if (!isWithin(root, file)) throw new Error('Repository contains an unsafe path');
    add(name);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Cannot fingerprint non-regular file: ${name}`);
      add(String(st.mode)); add(await fs.readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') add('<deleted>');
      else throw error;
    }
  }
  const absoluteSpec = path.resolve(root, spec);
  if (!isWithin(root, absoluteSpec)) throw new Error('Acceptance specification must be inside the project');
  const stat = await fs.lstat(absoluteSpec);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Acceptance specification must be a regular file');
  // Reject symlinked parent directories too, including for ignored specifications.
  const realSpec = await fs.realpath(absoluteSpec);
  if (!isWithin(root, realSpec) || realSpec !== absoluteSpec) throw new Error('Acceptance specification must not use symlinks');
  return { source: hash.digest('hex'), spec: digest(await fs.readFile(absoluteSpec)) };
}

async function save(ctx: CliContext, root: string, record: GateRecord): Promise<void> {
  const file = statePath(ctx, root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

export async function runGate(ctx: CliContext, options: { spec: string; objective: string; timeout: number }, verify = runVerification): Promise<GateRecord> {
  const { root, isGitRepo } = await locateProject(ctx.cwd);
  if (!isGitRepo) throw new RelayvoraError('Completion gate requires a Git repository.', ExitCode.PreconditionFailed);
  if (!options.objective.trim() || /[\x00-\x1f]/.test(options.objective)) throw new RelayvoraError('Provide a single-line Kane objective.', ExitCode.Usage);
  const before = await fingerprints(root, options.spec);
  const specPath = path.relative(root, path.resolve(root, options.spec));
  try {
    const prior = JSON.parse(await fs.readFile(statePath(ctx, root), 'utf8')) as GateRecord;
    if (prior.version !== 1 || prior.project !== root || prior.spec !== specPath || prior.specFingerprint !== before.spec || prior.objective !== redact(options.objective).text) {
      throw new RelayvoraError('The locked acceptance specification or objective changed. Start a separately authorized task instead of replacing the baseline.', ExitCode.PreconditionFailed);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const record: GateRecord = { version: 1, project: root, state: 'verifying', spec: path.relative(root, path.resolve(root, options.spec)), objective: redact(options.objective).text,
    sourceFingerprint: before.source, specFingerprint: before.spec, startedAt: new Date().toISOString(), finishedAt: null, result: null, reasons: [] };
  await save(ctx, root, record);
  try {
    const result: VerificationResult = await verify(`kane-cli run ${JSON.stringify(options.objective)} --agent`, root, options.timeout);
    const after = await fingerprints(root, options.spec);
    const status = result.status ?? 'unknown';
    record.result = { status, exitCode: result.exitCode, detail: redact(result.error ?? result.output).text.slice(0, 4000) };
    if (before.source !== after.source || before.spec !== after.spec) {
      record.state = 'stale'; record.reasons.push('Source or acceptance specification changed during verification.');
    } else if (status === 'failed') {
      record.state = 'recovery_required'; record.reasons.push('Kane reported a functional failure.');
    } else {
      record.state = 'blocked';
      record.reasons.push(status === 'passed' ? 'The running application is not bound to the fingerprinted source; verified completion cannot be established.' : 'Kane did not produce a conclusive passing result.');
    }
  } catch (error) {
    record.state = 'blocked'; record.reasons.push(redact((error as Error).message).text);
  }
  record.finishedAt = new Date().toISOString();
  await save(ctx, root, record);
  return record;
}

export async function gateStatus(ctx: CliContext): Promise<GateRecord> {
  const { root } = await locateProject(ctx.cwd);
  let record: GateRecord;
  try { record = JSON.parse(await fs.readFile(statePath(ctx, root), 'utf8')) as GateRecord; }
  catch { throw new RelayvoraError('No completion gate run found for this project.', ExitCode.NotFound); }
  // State on disk is not trusted as proof of completion, even if edited by an agent.
  if (!['verifying', 'recovery_required', 'blocked', 'stale'].includes(record.state) || record.project !== root) {
    throw new RelayvoraError('Invalid completion gate state; run the gate again.', ExitCode.PreconditionFailed);
  }
  try {
    const current = await fingerprints(root, record.spec);
    if (current.source !== record.sourceFingerprint || current.spec !== record.specFingerprint) {
      return { ...record, state: 'stale', reasons: ['Source or acceptance specification changed after verification.'] };
    }
  } catch { return { ...record, state: 'blocked', reasons: ['Could not establish current fingerprints.'] }; }
  return record;
}
