import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ExitCode, RelayvoraError, isWithin, parseCommandLine, redact, runCommand, type VerificationResult } from '@relayvora/core';
import { runVerification } from './checkpoint-service.js';
import { type CliContext } from './context.js';
import { parseAppUrl, startRuntime, type ManagedRuntime } from './managed-runtime.js';
import { locateProject } from './project.js';

export type GateState = 'verifying' | 'verified' | 'recovery_required' | 'blocked' | 'stale';
const STATES: readonly GateState[] = ['verifying', 'verified', 'recovery_required', 'blocked', 'stale'];

export interface GateCheck { command: string; status: 'passed' | 'failed' | 'unknown'; exitCode: number | null; detail: string }
export interface GateRecord {
  version: 2;
  project: string;
  state: GateState;
  spec: string;
  /** Extra files locked with the specification, e.g. acceptance or regression tests. */
  protect: string[];
  objective: string;
  sourceFingerprint: string;
  specFingerprint: string;
  /** Present when Relayvora started the app itself; the only way a run can reach `verified`. */
  runtime: { command: string; url: string; pid: number | null } | null;
  startedAt: string;
  finishedAt: string | null;
  result: { status: 'passed' | 'failed' | 'unknown'; exitCode: number | null; detail: string } | null;
  checks: GateCheck[];
  reasons: string[];
  /** HMAC over the record with a per-user key; detects edits by tools that do not hold the key. */
  signature?: string;
}

export interface GateOptions {
  spec: string;
  objective: string;
  /** Kane timeout in seconds. */
  timeout: number;
  /** Command that starts the app from the checked-out tree (no shell). Requires `url`. */
  start?: string;
  /** Local URL the started app serves; Kane is pointed at it. */
  url?: string;
  readyTimeout?: number;
  /** Regression commands run against the same tree after Kane; any failure requires recovery. */
  checks?: string[];
  protect?: string[];
}

export interface GateDeps {
  verify?: (command: string, cwd: string, timeoutSec: number) => Promise<VerificationResult>;
  startApp?: typeof startRuntime;
}

function digest(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function gateDir(ctx: CliContext): string { return path.join(ctx.dataDir, 'completion-gates'); }
function statePath(ctx: CliContext, root: string): string { return path.join(gateDir(ctx), `${digest(root)}.json`); }

async function readRegularFile(root: string, name: string, label: string): Promise<Buffer> {
  const absolute = path.resolve(root, name);
  if (!isWithin(root, absolute)) throw new RelayvoraError(`${label} must be inside the project: ${name}`, ExitCode.Usage);
  const stat = await fs.lstat(absolute).catch(() => { throw new RelayvoraError(`${label} not found: ${name}`, ExitCode.NotFound); });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RelayvoraError(`${label} must be a regular file: ${name}`, ExitCode.Usage);
  // Reject symlinked parent directories too, including for ignored files.
  const real = await fs.realpath(absolute);
  if (!isWithin(root, real) || real !== absolute) throw new RelayvoraError(`${label} must not use symlinks: ${name}`, ExitCode.Usage);
  return fs.readFile(absolute);
}

/** Full contents of tracked and non-ignored untracked files plus HEAD and index; the spec and protected files separately. */
export async function fingerprints(root: string, spec: string, protect: readonly string[] = []): Promise<{ source: string; spec: string }> {
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
  const add = (h: ReturnType<typeof createHash>, value: string | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); h.update(`${bytes.length}:`); h.update(bytes); };
  add(hash, head); add(hash, index);
  for (const name of [...new Set(files.split('\0').filter(Boolean))].sort()) {
    const file = path.resolve(root, name);
    if (!isWithin(root, file)) throw new Error('Repository contains an unsafe path');
    add(hash, name);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Cannot fingerprint non-regular file: ${name}`);
      add(hash, String(st.mode)); add(hash, await fs.readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') add(hash, '<deleted>');
      else throw error;
    }
  }
  const specHash = createHash('sha256');
  for (const [label, name] of [['Acceptance specification', spec] as const, ...[...protect].sort().map((p) => ['Protected file', p] as const)]) {
    add(specHash, path.relative(root, path.resolve(root, name)).split(path.sep).join('/'));
    add(specHash, await readRegularFile(root, name, label));
  }
  return { source: hash.digest('hex'), spec: specHash.digest('hex') };
}

async function signingKey(ctx: CliContext): Promise<Buffer> {
  const file = path.join(gateDir(ctx), '.key');
  await fs.mkdir(gateDir(ctx), { recursive: true });
  try { await fs.writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'hex');
}

export async function sign(ctx: CliContext, value: object): Promise<string> {
  const { signature: _ignored, ...rest } = value as { signature?: string };
  return createHmac('sha256', await signingKey(ctx)).update(JSON.stringify(rest)).digest('hex');
}

export async function verifySignature(ctx: CliContext, value: { signature?: string }): Promise<boolean> {
  if (typeof value.signature !== 'string' || !/^[0-9a-f]{64}$/.test(value.signature)) return false;
  const expected = Buffer.from(await sign(ctx, value), 'hex');
  return timingSafeEqual(expected, Buffer.from(value.signature, 'hex'));
}

export async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

async function save(ctx: CliContext, root: string, record: GateRecord): Promise<void> {
  record.signature = await sign(ctx, record);
  await writeAtomic(statePath(ctx, root), JSON.stringify(record, null, 2));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** One gate or recovery per project at a time. A lock left by a dead process is taken over. */
export async function acquireProjectLock(ctx: CliContext, root: string): Promise<() => Promise<void>> {
  const file = `${statePath(ctx, root)}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return async () => { await fs.rm(file, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number((await fs.readFile(file, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) {
        throw new RelayvoraError(`Another completion gate or recovery is running for this project (pid ${owner}).`, ExitCode.PreconditionFailed);
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new RelayvoraError('Could not acquire the project lock.', ExitCode.PreconditionFailed);
}

function checkObjectiveTargets(objective: string, url: URL | undefined): void {
  if (!url) return;
  for (const match of objective.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) {
    let target: URL;
    try { target = new URL(match[0]); } catch { continue; }
    if (target.origin !== url.origin) {
      throw new RelayvoraError(`The objective points at ${target.origin}, not the app Relayvora starts (${url.origin}).`, ExitCode.Usage);
    }
  }
}

async function readRecord(ctx: CliContext, root: string): Promise<GateRecord | undefined> {
  try { return JSON.parse(await fs.readFile(statePath(ctx, root), 'utf8')) as GateRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function kaneCommand(objective: string, url?: URL): string {
  return `kane-cli run ${JSON.stringify(objective)} --agent${url ? ` --url ${url.href}` : ''}`;
}

/** Runs the gate; the caller must hold the project lock. */
export async function runGateLocked(ctx: CliContext, root: string, options: GateOptions, deps: GateDeps = {}): Promise<GateRecord> {
  const verify = deps.verify ?? runVerification;
  const startApp = deps.startApp ?? startRuntime;
  if (!options.objective.trim() || /[\x00-\x1f]/.test(options.objective)) throw new RelayvoraError('Provide a single-line Kane objective.', ExitCode.Usage);
  if (Boolean(options.start) !== Boolean(options.url)) throw new RelayvoraError('--start and --url must be given together.', ExitCode.Usage);
  const url = options.url ? parseAppUrl(options.url) : undefined;
  checkObjectiveTargets(options.objective, url);
  const checks = options.checks ?? [];
  checks.forEach((c) => parseCommandLine(c));
  if (options.start) parseCommandLine(options.start);
  const protect = [...new Set((options.protect ?? []).map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join('/')))].sort();
  const specPath = path.relative(root, path.resolve(root, options.spec)).split(path.sep).join('/');
  const objective = redact(options.objective).text;

  const before = await fingerprints(root, options.spec, protect);
  const prior = await readRecord(ctx, root);
  if (prior) {
    if (prior.version !== 2 || !(await verifySignature(ctx, prior))) {
      throw new RelayvoraError('The stored gate state is from an older version or was modified outside Relayvora. Remove it to start a new task.', ExitCode.PreconditionFailed);
    }
    if (prior.project !== root || prior.spec !== specPath || prior.specFingerprint !== before.spec || prior.objective !== objective || prior.protect.join('\n') !== protect.join('\n')) {
      throw new RelayvoraError('The locked acceptance specification, protected files or objective changed. Start a separately authorized task instead of replacing the baseline.', ExitCode.PreconditionFailed);
    }
  }
  const record: GateRecord = {
    version: 2, project: root, state: 'verifying', spec: specPath, protect, objective,
    sourceFingerprint: before.source, specFingerprint: before.spec,
    runtime: options.start && url ? { command: redact(options.start).text, url: url.href, pid: null } : null,
    startedAt: new Date().toISOString(), finishedAt: null, result: null, checks: [], reasons: [],
  };
  await save(ctx, root, record);

  let runtime: ManagedRuntime | undefined;
  try {
    if (options.start && url) {
      runtime = await startApp({ command: options.start, url, cwd: root, readyTimeoutSec: options.readyTimeout ?? 60, env: ctx.env });
      record.runtime!.pid = runtime.pid ?? null;
    }
    const result = await verify(kaneCommand(options.objective, url), root, options.timeout);
    const aliveAfterKane = runtime ? runtime.alive() : false;
    const status = result.status ?? 'unknown';
    record.result = { status, exitCode: result.exitCode, detail: redact(result.error ?? result.output).text.slice(0, 4000) };
    for (const check of checks) {
      const r = await verify(check, root, options.timeout);
      const checkStatus = r.timedOut || r.exitCode === null ? 'unknown' : r.exitCode === 0 ? 'passed' : 'failed';
      record.checks.push({ command: redact(check).text, status: checkStatus, exitCode: r.exitCode, detail: redact(r.error ?? r.output).text.slice(-2000) });
    }
    if (runtime) await runtime.stop();
    const after = await fingerprints(root, options.spec, protect);
    const failedChecks = record.checks.filter((c) => c.status === 'failed');
    if (before.source !== after.source || before.spec !== after.spec) {
      record.state = 'stale'; record.reasons.push('Source, acceptance specification or protected files changed during verification.');
    } else if (status === 'failed' || failedChecks.length) {
      record.state = 'recovery_required';
      if (status === 'failed') record.reasons.push('Kane reported a confirmed functional failure.');
      for (const c of failedChecks) record.reasons.push(`Regression check failed (exit ${c.exitCode}): ${c.command}`);
    } else if (status !== 'passed' || record.checks.some((c) => c.status !== 'passed')) {
      record.state = 'blocked'; record.reasons.push(status !== 'passed' ? 'Kane did not produce a conclusive passing result.' : 'A regression check did not complete.');
    } else if (!runtime) {
      record.state = 'blocked'; record.reasons.push('The running application is not bound to the fingerprinted source; pass --start and --url so Relayvora starts it.');
    } else if (!aliveAfterKane) {
      record.state = 'blocked'; record.reasons.push('The app process Relayvora started exited during verification, so the result may come from another server.');
    } else {
      record.state = 'verified';
      record.reasons.push('Kane passed against the app Relayvora started from this exact source, regression checks passed, and nothing changed during the run.');
    }
  } catch (error) {
    record.state = 'blocked'; record.reasons.push(redact((error as Error).message).text);
  } finally {
    if (runtime) await runtime.stop();
  }
  record.finishedAt = new Date().toISOString();
  await save(ctx, root, record);
  return record;
}

export async function runGate(ctx: CliContext, options: GateOptions, deps: GateDeps = {}): Promise<GateRecord> {
  const { root, isGitRepo } = await locateProject(ctx.cwd);
  if (!isGitRepo) throw new RelayvoraError('Completion gate requires a Git repository.', ExitCode.PreconditionFailed);
  const release = await acquireProjectLock(ctx, root);
  try { return await runGateLocked(ctx, root, options, deps); }
  finally { await release(); }
}

export async function gateStatus(ctx: CliContext): Promise<GateRecord> {
  const { root } = await locateProject(ctx.cwd);
  let record: GateRecord | undefined;
  try { record = await readRecord(ctx, root); } catch { record = undefined; }
  if (!record) throw new RelayvoraError('No completion gate run found for this project.', ExitCode.NotFound);
  // State on disk is not trusted unless Relayvora signed it, and fingerprints are always re-checked.
  if (record.version !== 2 || !STATES.includes(record.state) || record.project !== root || !(await verifySignature(ctx, record))) {
    throw new RelayvoraError('Invalid or modified completion gate state; run the gate again.', ExitCode.PreconditionFailed);
  }
  try {
    const current = await fingerprints(root, record.spec, record.protect);
    if (current.source !== record.sourceFingerprint || current.spec !== record.specFingerprint) {
      return { ...record, state: 'stale', reasons: ['Source, acceptance specification or protected files changed after verification.'] };
    }
  } catch { return { ...record, state: 'blocked', reasons: ['Could not establish current fingerprints.'] }; }
  return record;
}
