import type { ExecutableProbe, ProbeOptions } from './adapter.js';
import { runCommand } from './exec.js';
import { findExecutable } from './platform.js';

/** Finds `name` on PATH and runs `<name> --version`. Reports problems instead of throwing. */
export async function probeExecutable(name: string, options: ProbeOptions = {}): Promise<ExecutableProbe> {
  const env = options.env ?? process.env;
  const found = findExecutable(name, env);
  if (!found) return { found: false, error: `${name} not found on PATH` };
  try {
    const result = await runCommand(found, ['--version'], { env, timeoutMs: options.timeoutMs ?? 15_000 });
    if (result.timedOut) return { found: true, path: found, error: '--version timed out' };
    if (result.exitCode !== 0) {
      return { found: true, path: found, error: `--version exited with ${result.exitCode}` };
    }
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    return version ? { found: true, path: found, version } : { found: true, path: found };
  } catch (error) {
    return { found: true, path: found, error: (error as Error).message };
  }
}
