import { describe, expect, it } from 'vitest';
import { collapseRepeatedLines, fence, outputExcerpt, parseCommandLine, stripAnsi, truncateText } from '../src/text.js';

describe('parseCommandLine', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(parseCommandLine('pnpm test -- --run "src/a b.test.ts"')).toEqual(['pnpm', 'test', '--', '--run', 'src/a b.test.ts']);
    expect(parseCommandLine(`node -e 'console.log("hi")'`)).toEqual(['node', '-e', 'console.log("hi")']);
    expect(parseCommandLine('C:\\tools\\run.exe --x')).toEqual(['C:\\tools\\run.exe', '--x']);
    expect(parseCommandLine('echo ""')).toEqual(['echo', '']);
  });

  it('allows operators inside quotes but rejects them unquoted', () => {
    expect(parseCommandLine('node -e "a && b | c"')).toEqual(['node', '-e', 'a && b | c']);
    for (const bad of ['npm test | tee log', 'a && b', 'a; b', 'a > out', 'echo $(id)', 'echo `id`']) {
      expect(() => parseCommandLine(bad), bad).toThrow(/not supported/);
    }
  });

  it('rejects empty commands and unterminated quotes', () => {
    expect(() => parseCommandLine('   ')).toThrow(/Empty/);
    expect(() => parseCommandLine('echo "oops')).toThrow(/Unterminated/);
  });
});

describe('outputExcerpt', () => {
  it('keeps short output whole, minus ANSI codes and CRLF', () => {
    expect(outputExcerpt('\u001b[31mFAIL\u001b[0m a\r\nok').text).toBe('FAIL a\nok');
  });

  it('keeps error lines and the tail of long output', () => {
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => `progress ${i}`),
      'Error: boom in parser.ts:12',
      '  at parse (parser.ts:12)',
      ...Array.from({ length: 100 }, (_, i) => `noise ${i}`),
      'Tests: 1 failed, 9 passed',
    ];
    const ex = outputExcerpt(lines.join('\n'));
    expect(ex.truncated).toBe(true);
    expect(ex.text).toContain('Error: boom in parser.ts:12');
    expect(ex.text).toContain('  at parse (parser.ts:12)');
    expect(ex.text).toContain('Tests: 1 failed, 9 passed');
    expect(ex.text).not.toContain('progress 5\n');
  });

  it('collapses repeated lines', () => {
    expect(collapseRepeatedLines(['a', 'a', 'a', 'b'])).toEqual(['a', '…(previous line repeated 2 more times)', 'b']);
  });
});

describe('fence', () => {
  it('uses a fence longer than any backtick run in the content', () => {
    expect(fence('plain')).toBe('```\nplain\n```');
    expect(fence('has ``` inside', 'md')).toBe('````md\nhas ``` inside\n````');
  });
});

describe('truncateText / stripAnsi', () => {
  it('reports how much was cut', () => {
    const t = truncateText('line one\nline two\nline three', 12);
    expect(t.truncated).toBe(true);
    expect(t.text).toMatch(/^line one\n…\[truncated \d+ chars\]$/);
    expect(truncateText('short', 10)).toEqual({ text: 'short', truncated: false });
  });
  it('strips colour codes', () => {
    expect(stripAnsi('\u001b[1;32m✓\u001b[0m ok')).toBe('✓ ok');
  });
});
