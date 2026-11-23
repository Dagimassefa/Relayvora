import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { ExitCode, RelayvoraError, findExecutable, parseCommandLine, planSpawn } from '@relayvora/core';

/**
 * An application process started by Relayvora itself from the checked-out tree. Binding a browser
 * result to source relies on three facts this module establishes: nothing was listening on the
 * address before the start, the started process answered on it, and that process was still alive
 * when verification finished (so it was not replaced or restarted in between).
 */
export interface ManagedRuntime {
  url: URL;
  pid: number | undefined;
  alive(): boolean;
  /** Last lines of the process output, for diagnostics. */
  log(): string;
  stop(): Promise<void>;
}

export function parseAppUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RelayvoraError(`Invalid --url: ${value}`, ExitCode.Usage); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RelayvoraError('--url must be http or https.', ExitCode.Usage);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new RelayvoraError('--url must point at this machine (localhost, 127.0.0.1 or [::1]) so Relayvora can own the server.', ExitCode.Usage);
  }
  return url;
}

function portOf(url: URL): number { return Number(url.port || (url.protocol === 'https:' ? 443 : 80)); }

/** True when something accepts TCP connections on the URL's host and port. */
export function isListening(url: URL, timeoutMs = 1000): Promise<boolean> {
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: portOf(url) });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
    const timer = setTimeout(resolve, 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
    }
  });
}

export async function startRuntime(options: { command: string; url: URL; cwd: string; readyTimeoutSec: number; env?: NodeJS.ProcessEnv }): Promise<ManagedRuntime> {
  const argv = parseCommandLine(options.command);
  if (!argv.length) throw new RelayvoraError('--start needs a command.', ExitCode.Usage);
  if (await isListening(options.url)) {
    throw new RelayvoraError(`Something is already listening on ${options.url.host}. Stop it so Relayvora can start the app from the checked-out source.`, ExitCode.PreconditionFailed);
  }
  const env = { ...(options.env ?? process.env), PORT: String(portOf(options.url)), FORCE_COLOR: '0', NO_COLOR: '1' };
  const resolved = findExecutable(argv[0]!, env);
  if (!resolved) throw new RelayvoraError(`Executable not found on PATH: ${argv[0]}`, ExitCode.NotFound);
  const plan = planSpawn(resolved, argv.slice(1));
  const child = spawn(plan.file, plan.args, {
    cwd: options.cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let output = '';
  const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-8000); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  const alive = () => !spawnError && child.exitCode === null && child.signalCode === null;
  const runtime: ManagedRuntime = { url: options.url, pid: child.pid, alive, log: () => output.trim().split(/\r?\n/).slice(-20).join('\n'), stop: () => killTree(child) };

  const deadline = Date.now() + options.readyTimeoutSec * 1000;
  while (Date.now() < deadline) {
    if (!alive()) {
      await runtime.stop();
      throw new RelayvoraError(`The app exited before it was ready${spawnError ? `: ${spawnError.message}` : ` (exit ${child.exitCode})`}.\n${runtime.log()}`, ExitCode.PreconditionFailed);
    }
    try {
      await fetch(options.url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      return runtime; // any HTTP response means the server is up
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  await runtime.stop();
  throw new RelayvoraError(`The app did not answer on ${options.url.href} within ${options.readyTimeoutSec}s.\n${runtime.log()}`, ExitCode.PreconditionFailed);
}
