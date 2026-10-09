import { describe, expect, it } from 'vitest';
import { buildCheckpoint } from '../src/build.js';
import { file, input, snapshot, transcript, verification } from './helpers.js';

describe('buildCheckpoint', () => {
  it('turns verification results into observed, evidence-linked facts', () => {
    const cp = buildCheckpoint(
      input({
        verifications: [
          verification('pnpm test', 1, 'FAIL src/date.test.ts\nExpected false, received true'),
          verification('pnpm lint', 0, 'ok'),
          { ...verification('pnpm e2e', null), timedOut: true },
        ],
      }),
    );
    const byId = Object.fromEntries(cp.evidence.map((e) => [e.id, e]));
    expect(byId['ev-cmd-1']).toMatchObject({ type: 'test', status: 'failed', exitCode: 1 });
    expect(byId['ev-cmd-2']).toMatchObject({ type: 'command', status: 'passed', exitCode: 0 });
    expect(byId['ev-cmd-3']).toMatchObject({ status: 'unknown', exitCode: null });

    expect(cp.task.blockers).toEqual([
      { text: '`pnpm test` fails (exit 1)', provenance: 'observed', evidenceRefs: ['ev-cmd-1'] },
      { text: '`pnpm e2e` timed out; result unknown', provenance: 'observed', evidenceRefs: ['ev-cmd-3'] },
    ]);
    expect(cp.task.completed).toEqual([{ text: '`pnpm lint` passes (exit 0)', provenance: 'observed', evidenceRefs: ['ev-cmd-2'] }]);
    expect(cp.warnings.join()).not.toMatch(/No verification command/);
  });

  it('warns loudly when nothing was verified', () => {
    expect(buildCheckpoint(input()).warnings.join('\n')).toMatch(/test status is NOT verified/);
  });

  it('labels user input, inferred goals and agent reports by provenance', () => {
    const cp = buildCheckpoint(
      input({
        user: { constraints: ['No new deps'], pending: ['Handle year 2000'] },
        source: { provider: 'codex', sessionId: 's1', sessionPath: '/s/rollout.jsonl', sessionSha256: 'c'.repeat(64) },
        transcript: transcript(),
      }),
    );
    expect(cp.task.goal).toEqual({ text: 'Fix the failing date parser test', provenance: 'inferred', evidenceRefs: ['ev-transcript'] });
    expect(cp.task.constraints[0]).toMatchObject({ text: 'No new deps', provenance: 'user-provided' });
    expect(cp.task.recentRequests[0]).toMatchObject({ text: 'Also keep the public API stable', provenance: 'user-provided' });
    expect(cp.task.lastAgentReport).toMatchObject({ provenance: 'agent-reported', evidenceRefs: ['ev-transcript'] });
    expect(cp.evidence.find((e) => e.id === 'ev-transcript')).toMatchObject({ type: 'transcript', sha256: 'c'.repeat(64) });
    expect(cp.source.title).toBe('Fix date parser');
    expect(cp.warnings.join()).toMatch(/Goal was inferred/);
  });

  it('prefers an explicit goal and requires one when nothing can be inferred', () => {
    expect(buildCheckpoint(input({ transcript: transcript() })).task.goal.provenance).toBe('user-provided');
    expect(() => buildCheckpoint(input({ user: {} }))).toThrow(/No goal available/);
  });

  it('redacts secrets in every captured text and reports the count', () => {
    const cp = buildCheckpoint(
      input({
        user: { goal: 'Rotate key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA' },
        git: snapshot([file('src/config.ts', { patch: '+const token = "ghp_' + 'x'.repeat(36) + '";\n' })]),
        verifications: [verification('node check.js', 1, 'DB_PASSWORD=hunter2 rejected')],
      }),
    );
    const all = JSON.stringify(cp);
    expect(all).not.toMatch(/sk-ant-api03|ghp_x|hunter2/);
    expect(cp.warnings.join()).toMatch(/Redacted 3 likely secret/);
  });

  it('never captures sensitive file contents and records omissions', () => {
    const cp = buildCheckpoint(
      input({
        git: snapshot([
          file('.env', { patch: '+SECRET=1\n' }),
          file('logo.png', { binary: true, patch: null, linesAdded: null, linesDeleted: null, omittedReason: 'binary' }),
          file('notes.md', { kind: 'untracked', status: '??', patch: null, content: '# notes\n' }),
        ]),
      }),
    );
    const ev = Object.fromEntries(cp.evidence.map((e) => [e.path, e]));
    expect(ev['.env']).toMatchObject({ omittedReason: 'sensitive' });
    expect(ev['.env']!.excerpt).toBeUndefined();
    expect(ev['logo.png']).toMatchObject({ omittedReason: 'binary' });
    expect(ev['notes.md']).toMatchObject({ type: 'file', excerpt: '# notes\n' });
    expect(cp.warnings.join()).toMatch(/sensitive file\(s\) were not captured: \.env/);
    expect(cp.project.dirtyFiles.map((d) => d.path)).toEqual(['.env', 'logo.png', 'notes.md']);
  });

  it('handles a non-Git project and a detached HEAD', () => {
    const noGit = buildCheckpoint(input({ git: null }));
    expect(noGit.project).toMatchObject({ isGitRepo: false, gitHead: null, dirtyFiles: [] });
    expect(noGit.warnings.join()).toMatch(/Not a Git repository/);

    const detached = buildCheckpoint(input({ git: { ...snapshot(), branch: null, detached: true } }));
    expect(detached.project.branch).toBeNull();
    expect(detached.warnings.join()).toMatch(/HEAD is detached/);
  });

  it('records provider-reported usage with its caveat', () => {
    const usage = { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, costUsd: 0.01, note: 'n' };
    const cp = buildCheckpoint(input({ transcript: transcript({ usage }) }));
    expect(cp.usage).toEqual({ source: 'provider-reported', ...usage });
    expect(buildCheckpoint(input()).usage.source).toBe('unavailable');
  });
});
