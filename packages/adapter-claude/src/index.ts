import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  directoryExists,
  finalizeSessions,
  pickString,
  probeExecutable,
  readJsonlHead,
  walkFiles,
  type AgentAdapter,
  type DiscoverOptions,
  type ProbeOptions,
  type SessionDiscovery,
  type SessionSummary,
} from '@agentrelay/core';
import { readClaudeTranscript } from './transcript.js';

/**
 * Claude Code keeps one JSONL transcript per session under
 * `<config dir>/projects/<encoded cwd>/<session id>.jsonl`. That layout is observed, not a
 * documented API, so discovery is best-effort and tolerant of unknown records.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

export async function readClaudeSession(file: string): Promise<{ session: SessionSummary; warnings: string[] }> {
  const warnings: string[] = [];
  const stat = await fs.stat(file);
  const head = await readJsonlHead(file);
  if (head.parseErrors > 0) warnings.push(`${file}: ${head.parseErrors} unparseable line(s) in header`);

  let cwd: string | undefined;
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  for (const record of head.records) {
    cwd ??= pickString(record, 'cwd');
    sessionId ??= pickString(record, 'sessionId');
    startedAt ??= pickString(record, 'timestamp');
    if (cwd && sessionId && startedAt) break;
  }
  if (!cwd) warnings.push(`${file}: no working directory recorded in header`);

  return {
    session: {
      provider: 'claude',
      id: sessionId ?? path.basename(file, '.jsonl'),
      path: file,
      cwd: cwd ?? null,
      startedAt: startedAt ?? null,
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    },
    warnings,
  };
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  executable: 'claude',
  capabilities: {
    discoverSessions: 'best-effort',
    readTranscript: 'best-effort',
    launch: 'unsupported',
    usageReporting: 'best-effort',
  },

  probe(options?: ProbeOptions) {
    return probeExecutable('claude', options);
  },

  readTranscript(sessionPath: string) {
    return readClaudeTranscript(sessionPath);
  },

  sessionRoots(env = process.env) {
    return [path.join(claudeConfigDir(env), 'projects')];
  },

  async discoverSessions(options: DiscoverOptions = {}): Promise<SessionDiscovery> {
    const warnings: string[] = [];
    const scannedRoots: string[] = [];
    const sessions: SessionSummary[] = [];

    for (const root of this.sessionRoots(options.env)) {
      if (!(await directoryExists(root))) continue;
      scannedRoots.push(root);
      // Sub-agent transcripts live in nested folders; only top-level session files count.
      const files = await walkFiles(root, (name) => name.endsWith('.jsonl'), { maxDepth: 1 });
      for (const file of files) {
        try {
          const result = await readClaudeSession(file);
          sessions.push(result.session);
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`${file}: ${(error as Error).message}`);
        }
      }
    }

    return { sessions: finalizeSessions(sessions, options), scannedRoots, warnings };
  },
};

export { readClaudeTranscript };

export default claudeAdapter;
