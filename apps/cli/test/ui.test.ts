import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@agentrelay/core';
import { streak } from '@agentrelay/storage';
import { banner, box, meter, relativeTime, table, truncateVisible, visibleLength } from '../src/ui/components.js';
import { highlightMarkdown } from '../src/ui/markdown.js';
import { detectColorLevel, makeTheme } from '../src/ui/theme.js';

const tty = (depth: number) => ({ isTTY: true, getColorDepth: () => depth }) as unknown as NodeJS.WriteStream;
const pipe = { isTTY: false } as unknown as NodeJS.WriteStream;

describe('colour detection', () => {
  it('is off for pipes, NO_COLOR and TERM=dumb', () => {
    expect(detectColorLevel(pipe, {})).toBe(0);
    expect(detectColorLevel(tty(24), { NO_COLOR: '1' })).toBe(0);
    expect(detectColorLevel(tty(24), { TERM: 'dumb' })).toBe(0);
  });
  it('maps terminal depth and honours FORCE_COLOR', () => {
    expect(detectColorLevel(tty(24), {})).toBe(3);
    expect(detectColorLevel(tty(8), {})).toBe(2);
    expect(detectColorLevel(tty(4), {})).toBe(1);
    expect(detectColorLevel(pipe, { FORCE_COLOR: '3' })).toBe(3);
    expect(detectColorLevel(tty(24), { FORCE_COLOR: '0' })).toBe(0);
  });
});

describe('components', () => {
  const color = makeTheme(3, true, 80);
  const plain = makeTheme(0, true, 80);

  it('measures and truncates styled text by visible width', () => {
    const s = color.fg('cyan', 'hello world');
    expect(visibleLength(s)).toBe(11);
    const cut = truncateVisible(s, 6);
    expect(stripAnsi(cut)).toBe('hello…');
    expect(cut.endsWith('\u001b[0m')).toBe(true);
  });

  it('draws boxes whose rows all have the same visible width', () => {
    const out = box(color, 'TITLE', [color.fg('lime', 'short'), 'x'.repeat(200)], 'magenta', 40);
    const widths = out.split('\n').map(visibleLength);
    expect(new Set(widths)).toEqual(new Set([40]));
  });

  it('colours the meter by fill level', () => {
    expect(stripAnsi(meter(plain, 5, 10, 10))).toBe('█████░░░░░');
    expect(meter(color, 5, 10, 10)).toContain('57;255;20'); // lime
    expect(meter(color, 95, 100, 10)).toContain('255;176;0'); // amber
    expect(meter(color, 120, 100, 10)).toContain('255;59;92'); // red
  });

  it('aligns table columns ignoring escape codes', () => {
    const out = table(color, ['A', 'B'], [[color.fg('red', 'xx'), 'y'], ['zzzz', 'w']]);
    const lines = out.split('\n').map(stripAnsi);
    expect(lines[1]!.indexOf('y')).toBe(lines[2]!.indexOf('w'));
  });

  it('falls back to ASCII glyphs', () => {
    const ascii = makeTheme(0, false, 80);
    expect(stripAnsi(banner(ascii, '1.0'))).toContain('A G E N T R E L A Y');
    expect(box(ascii, 't', ['x'], 'cyan', 10)).toMatch(/^\+-/);
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(relativeTime('2026-10-09T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-09T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime('2026-10-09T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-10-01T12:00:00Z', now)).toBe('8d ago');
  });
});

describe('highlightMarkdown', () => {
  const md = '# Handoff\n- [observed] ok\n```diff\n+added\n-removed\n```\n';
  it('is a no-op without colour, so piped handoffs stay pasteable', () => {
    expect(highlightMarkdown(md, makeTheme(0))).toBe(md);
  });
  it('preserves the text exactly when colour is stripped', () => {
    expect(stripAnsi(highlightMarkdown(md, makeTheme(3)))).toBe(md);
  });
});

describe('streak', () => {
  const today = new Date('2026-10-09T15:00:00Z');
  it('counts consecutive days ending today or yesterday', () => {
    expect(streak(['2026-10-09', '2026-10-08', '2026-10-07', '2026-10-05'], today)).toBe(3);
    expect(streak(['2026-10-08', '2026-10-07'], today)).toBe(2);
    expect(streak(['2026-10-06'], today)).toBe(0);
    expect(streak([], today)).toBe(0);
  });
});
