import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/index.js';

describe('Claude session health', () => {
  it('detects a usage limit, the last successful call and compactions', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-claude-health-')), 's.jsonl');
    const limitText = "You've hit your session limit · resets 4:50am (Africa/Nairobi)";
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', timestamp: '2026-10-10T09:00:00Z', message: { role: 'user', content: 'build it' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T09:01:00Z', message: { id: 'm1', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-10T09:30:00Z', content: 'Conversation compacted' }),
        // The real shape Claude Code writes when a limit is hit.
        JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: '2026-10-10T10:00:00Z', message: { content: [{ type: 'text', text: limitText }] } }),
      ].join('\n'),
    );
    const t = await claudeAdapter.readTranscript!(file);
    expect(t.health).toMatchObject({
      lastSuccessAt: '2026-10-10T09:01:00Z',
      lastLimitAt: '2026-10-10T10:00:00Z',
      limitMessage: limitText,
      compactions: 1,
      lastActivityAt: '2026-10-10T10:00:00Z',
    });
    expect(t.lastAgentMessage).toBe('working'); // the error is not the agent's report
  });
});
