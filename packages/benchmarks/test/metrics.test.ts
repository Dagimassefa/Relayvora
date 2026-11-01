import { describe, expect, it } from 'vitest';
import { parseCodexOutput, parseOptions, sumKnown } from '../metrics.mjs';

describe('benchmark accounting and planning', () => {
  it('reads Codex usage without double counting cached input or inventing dollars', () => {
    const data = parseCodexOutput([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 12 } },
    ].map(x => JSON.stringify(x)).join('\n'));
    expect(data).toMatchObject({ session_id: 'thread-1', usage: { input_tokens: 100, cached_input_tokens: 80 } });
    expect(sumKnown([0.1, null])).toBeNull();
    expect(sumKnown([0.1, 0.2])).toBeCloseTo(0.3);
  });
  it('accepts a resumed id and rejects incomplete or failed streams', () => {
    expect(parseCodexOutput('{"type":"turn.completed","usage":{}}', 'resumed').session_id).toBe('resumed');
    expect(() => parseCodexOutput('{"type":"thread.started","thread_id":"x"}')).toThrow(/completed/);
    expect(() => parseCodexOutput('{"type":"turn.failed","error":{"message":"limit"}}')).toThrow(/failed/);
  });
  it('validates run dimensions and defaults to a preview', () => {
    expect(parseOptions([]).run).toBeUndefined();
    expect(parseOptions(['--agents', 'claude,codex', '--scenarios', 'warm,cold', '--reps', '3', '--run']).run).toBe(true);
    for (const argv of [['--reps', '0'], ['--concurrency', '-1'], ['--agents', 'unknown'], ['--tasks', '../outside'], ['--cold-minutes'], ['--oops']]) expect(() => parseOptions(argv)).toThrow();
  });
});
