import { describe, expect, it } from 'vitest';
import { parseKaneResult } from '../src/kane.js';

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
