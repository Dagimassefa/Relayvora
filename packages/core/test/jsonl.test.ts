import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickString, readJsonlHead } from '../src/jsonl.js';

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-jsonl-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

describe('readJsonlHead', () => {
  it('parses records and counts bad lines, including CRLF and no trailing newline', async () => {
    const file = tmpFile('{"a":1}\r\nnot json\r\n\r\n{"b":2}');
    const head = await readJsonlHead(file);
    expect(head.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(head.parseErrors).toBe(1);
    expect(head.partial).toBe(false);
  });

  it('skips an oversized line and keeps reading the records after it', async () => {
    const huge = JSON.stringify({ type: 'user', blob: 'x'.repeat(300_000) });
    const file = tmpFile(`{"type":"queue"}\n${huge}\n{"cwd":"/work/demo"}\n`);
    const head = await readJsonlHead(file, { maxLineBytes: 64 * 1024 });
    expect(head.oversizedLines).toBe(1);
    expect(head.records).toEqual([{ type: 'queue' }, { cwd: '/work/demo' }]);
  });

  it('stops at the record and byte limits', async () => {
    const file = tmpFile(Array.from({ length: 100 }, (_, i) => `{"i":${i}}`).join('\n'));
    expect((await readJsonlHead(file, { maxRecords: 5 })).records).toHaveLength(5);
    const capped = await readJsonlHead(file, { maxScanBytes: 20 });
    expect(capped.partial).toBe(true);
    expect(capped.records.length).toBeLessThan(5);
  });
});

describe('pickString', () => {
  it('reads nested strings and ignores other types', () => {
    const v = { payload: { id: 'abc', n: 1 } };
    expect(pickString(v, 'payload.id')).toBe('abc');
    expect(pickString(v, 'payload.n')).toBeUndefined();
    expect(pickString(null, 'a')).toBeUndefined();
  });
});
