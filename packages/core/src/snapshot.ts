/** Inputs the checkpoint builder consumes. Producers (git, adapters, the CLI) fill these in. */

export type FileChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'type-changed'
  | 'other';

export interface GitFileChange {
  /** Repo-relative path with forward slashes. */
  path: string;
  origPath?: string;
  /** Two-letter porcelain status. */
  status: string;
  kind: FileChangeKind;
  linesAdded: number | null;
  linesDeleted: number | null;
  binary: boolean;
  /** Unified diff against the snapshot base, possibly truncated. Null when not captured. */
  patch: string | null;
  /** Full content of an untracked text file, possibly truncated. */
  content: string | null;
  truncated: boolean;
  /** Hash of the full patch or content, before truncation. */
  sha256: string | null;
  omittedReason?: 'sensitive' | 'binary' | 'symlink' | 'outside-root' | 'too-many-files' | 'unreadable';
}

export interface GitSnapshot {
  root: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  linkedWorktree: boolean;
  /** The diff base used for patches: HEAD, or null for a repository without commits. */
  base: string | null;
  files: GitFileChange[];
  capturedAt: string;
  warnings: string[];
}

export interface TranscriptUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  note: string;
}

export interface TranscriptDigest {
  title: string | null;
  firstUserPrompt: string | null;
  /** Newest prompt long enough to describe a task; the best guess at the current goal. */
  latestSubstantialPrompt: string | null;
  /** Up to the last few user prompts, oldest first. Excludes the first prompt. */
  recentUserPrompts: string[];
  userPromptCount: number;
  lastAgentMessage: string | null;
  usage: TranscriptUsage | null;
  warnings: string[];
}

export interface VerificationResult {
  /** The command line as the user typed it. */
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the command could not be started at all. */
  error?: string;
  output: string;
  durationMs: number;
  startedAt: string;
}
