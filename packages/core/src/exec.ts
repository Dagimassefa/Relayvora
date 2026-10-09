import { spawn } from 'node:child_process';
import { AgentRelayError, ExitCode } from './errors.js';
import { findExecutable } from './platform.js';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. Default 60s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per-stream capture limit; output beyond it is dropped and `truncated` is set. Default 10 MiB. */
  maxOutputBytes?: number;
  input?: string;
}

export interface ExecResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;

// Characters cmd.exe or a batch shim's %* could reinterpret even inside quotes.
const UNSAFE_BATCH_ARG = /["%!^&|<>\r\n]/;
const UNSAFE_BATCH_PATH = /["%\r\n]/;

interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980). npm-installed CLIs on
 * Windows are .cmd shims, so we route those through cmd.exe explicitly and reject arguments that
 * could be reinterpreted, rather than ever building an unchecked shell string.
 */
export function planSpawn(file: string, args: string[], platform: NodeJS.Platform = process.platform): SpawnPlan {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    if (UNSAFE_BATCH_PATH.test(file)) {
      throw new AgentRelayError(`Refusing to run batch file with unsafe path: ${file}`, ExitCode.Unsupported);
    }
    for (const arg of args) {
      if (UNSAFE_BATCH_ARG.test(arg)) {
        throw new AgentRelayError(`Refusing to pass unsafe argument to batch file: ${arg}`, ExitCode.Unsupported);
      }
    }
    const line = [file, ...args].map((a) => `"${a}"`).join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file, args, windowsVerbatimArguments: false };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

/**
 * Runs a command with an argument array and no shell. Never rejects for a non-zero exit;
 * rejects only if the executable cannot be found or started.
 */
export function runCommand(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const env = options.env ?? process.env;
  const resolved = findExecutable(command, env);
  if (!resolved) {
    return Promise.reject(new AgentRelayError(`Executable not found on PATH: ${command}`, ExitCode.NotFound));
  }
  const plan = planSpawn(resolved, args);
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes + chunk.length > maxBytes) truncated = true;
      else out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes + chunk.length > maxBytes) truncated = true;
      else err.push(chunk);
      errBytes += chunk.length;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new AgentRelayError(`Failed to start ${command}: ${error.message}`, ExitCode.Failure, { cause: error }));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        command: resolved,
        args,
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
