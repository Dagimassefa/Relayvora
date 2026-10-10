import { describe, expect, it } from 'vitest';
import { buildCheckpoint } from '../src/build.js';
import { renderHandoff, withRenderedHandoff } from '../src/handoff.js';
import { estimateTokens } from '../src/tokens.js';
import { file, input, snapshot, transcript, verification } from './helpers.js';

const bigPatch = (n: number) =>
  `diff --git a/f b/f\n@@ -1,${n} +1,${n} @@\n` + Array.from({ length: n }, (_, i) => `+const line${i} = ${i};`).join('\n');

function richCheckpoint() {
  return buildCheckpoint(
    input({
      user: { goal: 'Fix leap years', blockers: ['CI is red'], pending: ['Handle 2000'] },
      source: { provider: 'codex', sessionId: 's1', sessionPath: '/s.jsonl' },
      transcript: transcript({ lastAgentMessage: 'I changed parser.ts. '.repeat(40) }),
      git: snapshot([
        file('src/a.ts', { patch: bigPatch(40) }),
        file('src/b.ts', { patch: bigPatch(200) }),
        file('docs/new.md', { kind: 'untracked', status: '??', patch: null, content: 'hello '.repeat(300) }),
      ]),
      verifications: [verification('pnpm test', 1, 'Error: expected false\n'.repeat(3) + 'Tests: 1 failed')],
    }),
  );
}

describe('renderHandoff', () => {
  it('always includes goal, branch, blockers, failures and instructions', () => {
    const r = renderHandoff(richCheckpoint(), { budgetTokens: 100 });
    for (const needle of ['Fix leap years', '`main`', 'CI is red', '`pnpm test` fails (exit 1)', '## How to continue']) {
      expect(r.markdown).toContain(needle);
    }
    expect(r.warnings.join()).toMatch(/exceeds the budget of 100; nothing required was dropped/);
    expect(r.warnings.join()).not.toMatch(/validation failed/);
  });

  it('stays within budget whenever the required context fits', () => {
    const cp = richCheckpoint();
    const required = renderHandoff(cp, { budgetTokens: 1 }).requiredTokens;
    for (const budget of [required + 50, required + 300, required + 800, required + 2000, 20_000]) {
      const r = renderHandoff(cp, { budgetTokens: budget });
      expect(r.estimatedTokens, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(estimateTokens(r.markdown).tokens).toBe(r.estimatedTokens);
    }
  });

  it('prioritises failure output over diffs, diffs over new-file contents', () => {
    const cp = richCheckpoint();
    const required = renderHandoff(cp, { budgetTokens: 1 }).requiredTokens;
    const r = renderHandoff(cp, { budgetTokens: required + 400 });
    expect(r.markdown).toContain('Output excerpt [ev-cmd-1]');
    const deferredLabels = r.deferred.map((d) => d.label);
    expect(deferredLabels).toContain('content of new file docs/new.md');
    expect(deferredLabels).toContain('diff of src/b.ts');
  });

  it('includes everything and defers nothing with a generous budget', () => {
    const r = renderHandoff(richCheckpoint(), { budgetTokens: 50_000 });
    expect(r.deferred).toEqual([]);
    expect(r.markdown).not.toContain('## Deferred context');
    expect(r.markdown).toContain('#### New file `docs/new.md`');
  });

  it('gives deferred items a concrete way to retrieve them', () => {
    const r = renderHandoff(richCheckpoint(), { budgetTokens: 1 });
    expect(r.deferred.find((d) => d.label === 'diff of src/a.ts')?.retrieve).toBe('`git diff HEAD -- src/a.ts`');
    expect(r.deferred.find((d) => d.label.startsWith('output of'))?.retrieve).toBe('re-run `pnpm test`');
  });

  it('groups many deferred files into one line each for diffs and new files', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`src/f${i}.ts`, { patch: bigPatch(100) }));
    const cp = buildCheckpoint(input({ git: snapshot(files) }));
    const r = renderHandoff(cp, { budgetTokens: 1 });
    expect(r.deferred).toHaveLength(12);
    expect(r.markdown).toMatch(/- Diffs of 12 changed file\(s\) \(~\d+ tokens\): `git diff HEAD -- <path>`/);
  });

  it('is deterministic', () => {
    const cp = richCheckpoint();
    expect(renderHandoff(cp, { budgetTokens: 900 }).markdown).toBe(renderHandoff(cp, { budgetTokens: 900 }).markdown);
  });

  it('labels provenance and fences quoted session text', () => {
    const r = renderHandoff(richCheckpoint(), { budgetTokens: 50_000 });
    expect(r.markdown).toContain('- [user] Fix leap years');
    expect(r.markdown).toContain('- [agent-reported] I changed parser.ts.');
    expect(r.markdown).toContain('- [observed] `pnpm test` fails (exit 1) (ev-cmd-1)');
  });

  it('withRenderedHandoff stores the prompt, estimate and deferrals on the checkpoint', () => {
    const { checkpoint, render } = withRenderedHandoff(richCheckpoint(), { budgetTokens: 1500 });
    expect(checkpoint.handoff.prompt).toBe(render.markdown);
    expect(checkpoint.handoff.estimatedTokens).toBe(render.estimatedTokens);
    expect(checkpoint.handoff.deferred).toEqual(render.deferred);
    expect(checkpoint.handoff.budgetTokens).toBe(1500);
  });
});

describe('session commits in the handoff', () => {
  const commitOf = (n: number, lines: number) => ({
    sha: String(n).repeat(40),
    shortSha: String(n).repeat(7),
    subject: `feat: step ${n}`,
    authoredAt: '2026-10-09T12:00:00Z',
    filesChanged: 1,
    linesAdded: lines,
    linesDeleted: 0,
    patch: `diff --git a/f${n} b/f${n}\n` + Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n'),
    truncated: false,
    sha256: null,
    withheldFiles: [],
  });

  it('lists commits under Done so far and inlines the newest patch first', () => {
    const cp = buildCheckpoint(
      input({ git: snapshot([]), commits: { since: '2026-10-09T11:00:00Z', author: null, warnings: [], commits: [commitOf(1, 120), commitOf(2, 120)] } }),
    );
    const floor = renderHandoff(cp, { budgetTokens: 1 }).requiredTokens;
    const r = renderHandoff(cp, { budgetTokens: floor + 500 });
    expect(r.markdown).toContain('- [observed] Committed `1111111` feat: step 1');
    expect(r.markdown).toContain('Commits since the session started (2026-10-09T11:00:00Z): 2');
    expect(r.markdown).toContain('#### Commit `2222222` feat: step 2');
    expect(r.markdown).not.toContain('#### Commit `1111111`');
    expect(r.deferred).toEqual([expect.objectContaining({ label: 'patch of commit 1111111', retrieve: '`git show 1111111`' })]);
  });

  it('groups many deferred commit patches into one line', () => {
    const commits = Array.from({ length: 7 }, (_, i) => commitOf(i + 1, 200));
    const cp = buildCheckpoint(input({ git: snapshot([]), commits: { since: '1d', author: null, warnings: [], commits } }));
    const r = renderHandoff(cp, { budgetTokens: 1 });
    expect(r.markdown).toMatch(/- Patches of 7 commit\(s\) \(~\d+ tokens\): `git show <sha>`/);
  });
});
