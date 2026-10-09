import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscoverOptions, SessionSummary } from './adapter.js';
import { isWithin } from './platform.js';

/**
 * Recursively collects files under `root` matching `predicate`, bounded in depth and count so a
 * huge or hostile directory cannot stall discovery. Symlinked directories are not followed.
 */
export async function walkFiles(
  root: string,
  predicate: (name: string) => boolean,
  { maxDepth = 5, maxFiles = 5000 }: { maxDepth?: number; maxFiles?: number } = {},
): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile() && predicate(entry.name)) found.push(full);
    }
  }
  await visit(root, 0);
  return found;
}

export async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Applies the shared project filter, newest-first ordering and limit. */
export function finalizeSessions(sessions: SessionSummary[], options: DiscoverOptions): SessionSummary[] {
  const filtered = options.projectRoot
    ? sessions.filter((s) => s.cwd !== null && isWithin(options.projectRoot!, s.cwd))
    : sessions;
  filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
}
