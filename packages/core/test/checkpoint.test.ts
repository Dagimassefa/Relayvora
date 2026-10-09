import { describe, expect, it } from 'vitest';
import { CHECKPOINT_SCHEMA_VERSION, safeParseCheckpoint, type CheckpointInput } from '../src/checkpoint.js';

const at = '2026-10-01T10:00:00.000Z';

function validCheckpoint(): CheckpointInput {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    id: 'cp-1',
    createdAt: at,
    project: { root: '/work/demo', gitHead: 'abc123', branch: 'main', dirtyFiles: [{ path: 'src/date.ts', status: ' M' }] },
    source: { provider: 'codex', sessionId: 'sess-1', capturedAt: at },
    task: {
      goal: { text: 'Fix date parser', provenance: 'user-provided' },
      pending: [{ text: 'Handle leap years', provenance: 'agent-reported' }],
      blockers: [{ text: 'date.test.ts fails', provenance: 'observed', evidenceRefs: ['ev-test'] }],
    },
    evidence: [
      { id: 'ev-test', type: 'test', command: 'pnpm test date', exitCode: 1, status: 'failed', capturedAt: at },
    ],
    handoff: { targetProvider: 'claude', prompt: null, contextFiles: ['src/date.ts'], budgetTokens: 4000 },
    usage: { source: 'unavailable', inputTokens: null, outputTokens: null, costUsd: null },
  };
}

const messages = (input: unknown) => {
  const result = safeParseCheckpoint(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('checkpoint schema', () => {
  it('accepts a valid checkpoint and fills defaults', () => {
    const result = safeParseCheckpoint(validCheckpoint());
    expect(result.success).toBe(true);
    expect(result.data?.task.completed).toEqual([]);
    expect(result.data?.warnings).toEqual([]);
  });

  it('rejects an unknown schema version', () => {
    expect(safeParseCheckpoint({ ...validCheckpoint(), schemaVersion: '9.9' }).success).toBe(false);
  });

  it('rejects "passed" without a recorded command and zero exit code', () => {
    const cp = validCheckpoint();
    cp.evidence = [{ id: 'ev-test', type: 'test', status: 'passed', capturedAt: at }];
    expect(messages(cp).join()).toMatch(/requires a recorded command and exitCode 0/);
  });

  it('rejects "failed" with a zero exit code', () => {
    const cp = validCheckpoint();
    cp.evidence![0]!.exitCode = 0;
    expect(messages(cp).join()).toMatch(/non-zero exitCode/);
  });

  it('requires observed facts to cite evidence that exists', () => {
    const cp = validCheckpoint();
    cp.task.completed = [{ text: 'Refactored parser', provenance: 'observed' }];
    cp.decisions = [{ text: 'Use UTC', provenance: 'agent-reported', evidenceRefs: ['missing'] }];
    const errs = messages(cp).join('\n');
    expect(errs).toMatch(/must cite at least one evidence id/);
    expect(errs).toMatch(/Unknown evidence reference "missing"/);
  });

  it('allows a detached HEAD and a repo without commits', () => {
    const cp = validCheckpoint();
    cp.project = { ...cp.project, gitHead: null, branch: null };
    expect(safeParseCheckpoint(cp).success).toBe(true);
  });
});
