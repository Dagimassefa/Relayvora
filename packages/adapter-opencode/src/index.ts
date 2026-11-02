import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  directoryExists,
  finalizeSessions,
  probeExecutable,
  sha256,
  type AgentAdapter,
  type DiscoverOptions,
  type ProbeOptions,
  type SessionDiscovery,
  type SessionSummary,
} from '@relayvora/core';
import { openDatabase, parseSessionPath, sessionPath } from './db.js';
import { readOpenCodeTranscript } from './transcript.js';

/**
 * OpenCode (1.x) keeps every session in one SQLite database, `$XDG_DATA_HOME/opencode/opencode.db`
 * (default `~/.local/share/opencode`, on Windows too). A session is addressed as
 * `<database>#<session id>`. Older releases used JSON files under `storage/`; OpenCode migrates
 * those into the database on upgrade, so only the database is read. Neither is a documented API.
 */
export function openCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode');
}

interface SessionRow {
  id: string;
  directory: string | null;
  time_created: number;
  time_updated: number;
  size: number;
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  executable: 'opencode',
  capabilities: {
    discoverSessions: 'best-effort',
    readTranscript: 'best-effort',
    launch: 'documented',
    usageReporting: 'best-effort',
  },

  probe(options?: ProbeOptions) {
    return probeExecutable('opencode', options);
  },

  readTranscript(sessionPathValue: string) {
    return readOpenCodeTranscript(sessionPathValue);
  },

  /** A session is rows in a shared database, so hash its own messages and parts rather than the file. */
  async sessionSha256(sessionPathValue: string) {
    const { dbFile, sessionId } = parseSessionPath(sessionPathValue);
    const db = openDatabase(dbFile);
    try {
      const rows = db
        .prepare(
          `SELECT id, data FROM message WHERE session_id = ?
           UNION ALL SELECT id, data FROM part WHERE session_id = ? ORDER BY id`,
        )
        .all(sessionId, sessionId) as Array<{ id: string; data: string }>;
      return sha256(rows.map((r) => `${r.id}\n${r.data}`).join('\n'));
    } finally {
      db.close();
    }
  },

  /** Documented by `opencode [project] --prompt <text>`: starts the TUI with the prompt as the first message. */
  launchArgs(prompt: string) {
    return ['--prompt', prompt];
  },

  sessionRoots(env = process.env) {
    return [openCodeDataDir(env)];
  },

  async discoverSessions(options: DiscoverOptions = {}): Promise<SessionDiscovery> {
    const warnings: string[] = [];
    const scannedRoots: string[] = [];
    const sessions: SessionSummary[] = [];

    for (const root of this.sessionRoots(options.env)) {
      if (!(await directoryExists(root))) continue;
      scannedRoots.push(root);
      const dbFile = path.join(root, 'opencode.db');
      if (!(await fs.stat(dbFile).catch(() => null))) {
        if (await directoryExists(path.join(root, 'storage'))) {
          warnings.push(`${root}: only the JSON storage of an older OpenCode was found; run OpenCode 1.x once to migrate it`);
        }
        continue;
      }
      try {
        const db = openDatabase(dbFile);
        try {
          // Child sessions are subagent runs started by a parent session; they belong to it.
          const rows = db
            .prepare(
              `SELECT s.id, s.directory, s.time_created, s.time_updated,
                 (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM message m WHERE m.session_id = s.id)
               + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM part p WHERE p.session_id = s.id) AS size
               FROM session s WHERE s.parent_id IS NULL`,
            )
            .all() as unknown as SessionRow[];
          for (const row of rows) {
            sessions.push({
              provider: 'opencode',
              id: row.id,
              path: sessionPath(dbFile, row.id),
              cwd: row.directory || null,
              startedAt: new Date(row.time_created).toISOString(),
              updatedAt: new Date(row.time_updated).toISOString(),
              sizeBytes: row.size,
            });
          }
        } finally {
          db.close();
        }
      } catch (error) {
        warnings.push(`${dbFile}: ${(error as Error).message}`);
      }
    }

    return { sessions: finalizeSessions(sessions, options), scannedRoots, warnings };
  },
};

export { readOpenCodeTranscript, parseSessionPath, sessionPath };

export default opencodeAdapter;
