import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseKaneResult } from '../src/kane.js';

// Recorded from real kane-cli 0.10.8 runs against fixtures/demo-app (paths, ids and share links scrubbed).
const real = (name: string) => readFileSync(new URL(`./fixtures/kane-real-${name}.ndjson`, import.meta.url), 'utf8');
const realStderr = 'Skill update available: not installed → 0.1.4 — run `kane-cli install skill`\n\nRunning on: Desktop · Chrome\nevidence: view locally with `kane-cli evidence serve C:\\x.evidence`\n';

describe('real Kane 0.10.8 output', () => {
  it('parses a real pass with its evidence pack and without stderr noise', () => {
    const result = parseKaneResult(real('pass'), realStderr, 0, false, false);
    expect(result.status).toBe('passed');
    expect(result.failure).toBeUndefined();
    expect(result.evidencePack).toMatch(/\.evidence$/);
    expect(result.summary).toContain('Milk was added to the list.');
    expect(result.summary).not.toMatch(/Skill update|Running on|test-manager/);
  });
  it('parses a real confirmed product bug with Kane\'s structured verdict', () => {
    const result = parseKaneResult(real('fail'), realStderr, 1, false, false);
    expect(result.status).toBe('failed');
    expect(result.failure).toMatchObject({ reasonCode: 'assertion_error.confirmed_product_bug', family: 'application_issue', confirmed: true, title: 'List items lack a Delete button' });
    expect(result.summary).toContain('Step 6: agent_info: The eggs list item exists');
    expect(result.summary).toContain('Kane suggestion (unverified): Add a Delete button');
    expect(result.summary.split('Add a Delete button for each list item').length - 1).toBe(1);
    expect(result.summary).toContain('evidence: objective_contradiction');
  });
  it('does not treat a failure Kane blames on itself or leaves unconfirmed as an app defect', () => {
    const agentFault = real('fail').replace('"family":"application_issue"', '"family":"agent_issue"');
    expect(parseKaneResult(agentFault, '', 1, false, false).status).toBe('unknown');
    const unconfirmed = real('fail').replace('"confirmed":true', '"confirmed":false');
    expect(parseKaneResult(unconfirmed, '', 1, false, false).status).toBe('unknown');
  });
});

const event = (v: object) => JSON.stringify(v);
describe('Kane agent output', () => {
  it('requires a consistent completed pass, not just exit zero', () => {
    expect(parseKaneResult('', '', 0, false, false).status).toBe('unknown');
    expect(parseKaneResult(event({ type: 'run_end', status: 'passed', summary: 'Saved' }), '', 0, false, false).status).toBe('passed');
    expect(parseKaneResult(event({ type: 'run_end', status: 'passed' }), '', 0, false, true).status).toBe('unknown');
    expect(parseKaneResult(event({ type: 'run_end', status: 'passed' }), '', 1, false, false).status).toBe('unknown');
    expect(parseKaneResult([event({ type: 'warning', code: 'unresolved_variables' }), event({ type: 'run_end', status: 'passed' })].join('\n'), '', 0, false, false).status).toBe('unknown');
  });
  it('reports failed steps and distinguishes infrastructure errors', () => {
    const output = [event({ step: 3, status: 'failed', remark: 'Expected total 40, saw 20' }), event({ type: 'run_end', status: 'failed', summary: 'Cart failed', session_dir: '/tmp/session' })].join('\n');
    const result = parseKaneResult(output, 'evidence: pack', 1, false, false);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Expected total 40, saw 20');
    expect(result.summary).toContain('/tmp/session');
    expect(parseKaneResult(event({ type: 'error', message: 'Authentication failed' }), '', 2, false, false).status).toBe('unknown');
    expect(parseKaneResult(output, '', 1, true, false).status).toBe('unknown');
  });
});
