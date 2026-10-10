import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  directoryExists,
  finalizeSessions,
  platformBinaryCandidates,
  type BundledBinarySpec,
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
import { readCodexTranscript } from './transcript.js';

/**
 * Codex CLI writes rollouts to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`.
 * Newer versions start with a `session_meta` record whose payload carries id and cwd; older ones
 * put `id` at the top level and may lack cwd. Both are handled; neither is a documented API.
 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function readCodexSession(file: string): Promise<{ session: SessionSummary; warnings: string[] }> {
  const warnings: string[] = [];
  const stat = await fs.stat(file);
  const head = await readJsonlHead(file);
  if (head.parseErrors > 0) warnings.push(`${file}: ${head.parseErrors} unparseable line(s) in header`);

  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  for (const record of head.records) {
    id ??= pickString(record, 'payload.id') ?? pickString(record, 'id');
    cwd ??= pickString(record, 'payload.cwd') ?? pickString(record, 'cwd');
    startedAt ??= pickString(record, 'payload.timestamp') ?? pickString(record, 'timestamp');
    if (id && cwd && startedAt) break;
  }
  if (!cwd) warnings.push(`${file}: no working directory recorded in header`);

  return {
    session: {
      provider: 'codex',
      id: id ?? UUID_IN_NAME.exec(file)?.[1] ?? path.basename(file, '.jsonl'),
      path: file,
      cwd: cwd ?? null,
      startedAt: startedAt ?? null,
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    },
    warnings,
  };
}

/** The Codex IDE extension (`openai.chatgpt`) ships the CLI under `bin/<platform-arch>/`. */
export const CODEX_BUNDLED: BundledBinarySpec = {
  extensionPrefix: 'openai.chatgpt-',
  candidates: (dir, platform, arch) => platformBinaryCandidates(dir, 'bin', 'codex', platform, arch),
};

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  executable: 'codex',
  capabilities: {
    discoverSessions: 'best-effort',
    readTranscript: 'best-effort',
    launch: 'documented',
    usageReporting: 'best-effort',
  },

  probe(options?: ProbeOptions) {
    return probeExecutable('codex', options, CODEX_BUNDLED);
  },

  readTranscript(sessionPath: string) {
    return readCodexTranscript(sessionPath);
  },

  /** Documented by `codex [OPTIONS] [PROMPT]`: starts the interactive CLI with the prompt as the first message. */
  launchArgs(prompt: string) {
    return [prompt];
  },

  sessionRoots(env = process.env) {
    return [path.join(codexHome(env), 'sessions')];
  },

  async discoverSessions(options: DiscoverOptions = {}): Promise<SessionDiscovery> {
    const warnings: string[] = [];
    const scannedRoots: string[] = [];
    const sessions: SessionSummary[] = [];

    for (const root of this.sessionRoots(options.env)) {
      if (!(await directoryExists(root))) continue;
      scannedRoots.push(root);
      const files = await walkFiles(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), {
        maxDepth: 4,
      });
      for (const file of files) {
        try {
          const result = await readCodexSession(file);
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

export { readCodexTranscript };

export default codexAdapter;
