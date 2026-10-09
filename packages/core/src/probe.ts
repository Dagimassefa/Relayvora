import type { ExecutableProbe, ProbeOptions } from './adapter.js';
import { findBundledExecutables, type BundledBinarySpec } from './editors.js';
import { runCommand } from './exec.js';
import { findExecutable } from './platform.js';

async function readVersion(file: string, options: ProbeOptions): Promise<Pick<ExecutableProbe, 'version' | 'error'>> {
  try {
    const result = await runCommand(file, ['--version'], { env: options.env ?? process.env, timeoutMs: options.timeoutMs ?? 15_000 });
    if (result.timedOut) return { error: '--version timed out' };
    if (result.exitCode !== 0) return { error: `--version exited with ${result.exitCode}` };
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    return version ? { version } : {};
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Finds an agent CLI: a global install on PATH first, then a copy bundled in an editor extension
 * (VS Code, Cursor, ...). Runs `--version` on it. Reports problems instead of throwing.
 */
export async function probeExecutable(name: string, options: ProbeOptions = {}, bundled?: BundledBinarySpec): Promise<ExecutableProbe> {
  const env = options.env ?? process.env;
  const onPath = findExecutable(name, env);
  if (onPath) return { found: true, path: onPath, source: 'path', ...(await readVersion(onPath, options)) };

  const fromEditor = bundled ? findBundledExecutables(bundled, { env })[0] : undefined;
  if (fromEditor) {
    return {
      found: true,
      path: fromEditor.path,
      source: 'editor-extension',
      editor: fromEditor.editor,
      ...(await readVersion(fromEditor.path, options)),
    };
  }
  return { found: false, error: bundled ? `${name} not found on PATH or in editor extensions` : `${name} not found on PATH` };
}
