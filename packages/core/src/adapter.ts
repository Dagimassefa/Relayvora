import type { TranscriptDigest } from './snapshot.js';

/**
 * Contract every agent integration implements. Adapters are read-only with respect to the
 * vendor's own files: they may discover and read sessions, but never rewrite vendor state.
 */
export interface AgentAdapter {
  /** Stable provider id used in checkpoints and on the CLI, e.g. "claude". */
  readonly id: string;
  readonly displayName: string;
  /** Executable name looked up on PATH. */
  readonly executable: string;
  readonly capabilities: AdapterCapabilities;

  /** Locates the executable and reads its version. Never throws for a missing install. */
  probe(options?: ProbeOptions): Promise<ExecutableProbe>;
  /** Directories this adapter would scan for sessions, in priority order. */
  sessionRoots(env?: NodeJS.ProcessEnv): string[];
  /** Lists sessions, newest first. Unreadable or unknown-format files become warnings, not errors. */
  discoverSessions(options?: DiscoverOptions): Promise<SessionDiscovery>;
  /** Extracts prompts, the last agent message and usage from a session file. Read-only. */
  readTranscript?(sessionPath: string): Promise<TranscriptDigest>;
}

export interface AdapterCapabilities {
  discoverSessions: CapabilityLevel;
  readTranscript: CapabilityLevel;
  launch: CapabilityLevel;
  usageReporting: CapabilityLevel;
}

/**
 * `documented`: relies on a vendor-documented interface.
 * `best-effort`: relies on observed, undocumented formats that may change between versions.
 */
export type CapabilityLevel = 'documented' | 'best-effort' | 'unsupported';

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ExecutableProbe {
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
  /** Where the executable was found: a global install on PATH, or bundled in an editor extension. */
  source?: 'path' | 'editor-extension';
  /** Editor whose extension bundles it, e.g. "VS Code" or "Cursor". */
  editor?: string;
}

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  /** Only return sessions whose working directory is this path or inside it. */
  projectRoot?: string;
  limit?: number;
}

export interface SessionSummary {
  provider: string;
  id: string;
  /** Absolute path to the session file on disk. */
  path: string;
  /** Working directory recorded in the session, when present. */
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string;
  sizeBytes: number;
}

export interface SessionDiscovery {
  sessions: SessionSummary[];
  /** Roots that were scanned and existed. */
  scannedRoots: string[];
  warnings: string[];
}
