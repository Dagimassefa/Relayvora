import type { BuildCheckpointInput } from '../src/build.js';
import type { GitFileChange, GitSnapshot, TranscriptDigest, VerificationResult } from '../src/snapshot.js';

export const AT = '2026-10-01T10:00:00.000Z';

export function file(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    path,
    status: ' M',
    kind: 'modified',
    linesAdded: 1,
    linesDeleted: 1,
    binary: false,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    content: null,
    truncated: false,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

export function snapshot(files: GitFileChange[] = [file('src/date.ts')]): GitSnapshot {
  return {
    root: '/work/demo',
    head: 'b'.repeat(40),
    branch: 'main',
    detached: false,
    linkedWorktree: false,
    base: 'b'.repeat(40),
    files,
    capturedAt: AT,
    warnings: [],
  };
}

export function verification(command: string, exitCode: number | null, output = ''): VerificationResult {
  return { command, exitCode, timedOut: false, output, durationMs: 1234, startedAt: AT };
}

export function transcript(overrides: Partial<TranscriptDigest> = {}): TranscriptDigest {
  return {
    title: 'Fix date parser',
    firstUserPrompt: 'Fix the failing date parser test',
    latestSubstantialPrompt: null,
    recentUserPrompts: ['Also keep the public API stable'],
    userPromptCount: 2,
    lastAgentMessage: 'Fixed leap years; tests pass now.',
    usage: null,
    warnings: [],
    ...overrides,
  };
}

export function input(overrides: Partial<BuildCheckpointInput> = {}): BuildCheckpointInput {
  return {
    id: 'cp-test',
    now: new Date(AT),
    projectRoot: '/work/demo',
    git: snapshot(),
    source: { provider: 'manual', sessionId: null, sessionPath: null },
    transcript: null,
    user: { goal: 'Fix leap years' },
    verifications: [],
    targetProvider: 'claude',
    budgetTokens: 4000,
    ...overrides,
  };
}
