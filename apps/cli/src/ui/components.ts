import { stripAnsi } from '@agentrelay/core';
import type { ColorName, Theme } from './theme.js';

/** Printable width, ignoring escape codes. */
export function visibleLength(text: string): number {
  return [...stripAnsi(text)].length;
}

/** Cuts styled text to `max` visible characters without breaking escape sequences. */
export function truncateVisible(text: string, max: number, ellipsis = '…'): string {
  if (visibleLength(text) <= max) return text;
  const limit = Math.max(0, max - [...ellipsis].length);
  let out = '';
  let count = 0;
  // eslint-disable-next-line no-control-regex
  const parts = text.split(/(\u001b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith('\u001b[')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (count >= limit) break;
      out += ch;
      count++;
    }
  }
  // Close any style left open by the cut.
  return `${out}${ellipsis}${text.includes('\u001b[') ? '\u001b[0m' : ''}`;
}

export function padVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

// Two-row block font. Each glyph row has the same width.
const FONT: Record<string, [string, string]> = {
  A: ['▄▀█', '█▀█'],
  G: ['█▀▀', '█▄█'],
  E: ['█▀▀', '██▄'],
  N: ['█▄ █', '█ ▀█'],
  T: ['▀█▀', ' █ '],
  R: ['█▀█', '█▀▄'],
  L: ['█  ', '█▄▄'],
  Y: ['█▄█', ' █ '],
};

export function logo(t: Theme, word = 'AGENTRELAY'): string[] {
  if (!t.unicode) return [t.bold(t.fg('cyan', word.split('').join(' ')))];
  const rows = [0, 1].map((r) => word.split('').map((c) => FONT[c]?.[r] ?? c).join(' '));
  return rows.map((row) => t.bold(t.gradient(row, 'cyan', 'magenta')));
}

export function banner(t: Theme, version: string, tagline = 'hand off work between AI coding agents'): string {
  const [top, bottom] = logo(t);
  const meta = `${t.fg('gray', `v${version}`)}  ${t.dim(tagline)}`;
  if (!bottom) return ['', `  ${top}  ${meta}`, ''].join('\n');
  // Beside the logo when there is room, otherwise underneath.
  return visibleLength(bottom) + visibleLength(meta) + 5 <= t.width
    ? ['', `  ${top}`, `  ${bottom}   ${meta}`, ''].join('\n')
    : ['', `  ${top}`, `  ${bottom}`, `  ${meta}`, ''].join('\n');
}

/** Rounded panel with a title in the top border. Lines may contain styling. */
export function box(t: Theme, title: string, lines: string[], color: ColorName = 'cyan', width = Math.min(t.width, 78)): string {
  const { tl, tr, bl, br, h, v } = t.sym.box;
  const inner = width - 4;
  const titleText = title ? ` ${title} ` : '';
  const topFill = Math.max(0, width - 3 - visibleLength(titleText));
  const top = t.fg(color, `${tl}${h}`) + t.bold(t.fg(color, titleText)) + t.fg(color, `${h.repeat(topFill)}${tr}`);
  const body = lines.map((line) => {
    const fitted = truncateVisible(line, inner, t.sym.ellipsis);
    return `${t.fg(color, v)} ${padVisible(fitted, inner)} ${t.fg(color, v)}`;
  });
  const bottom = t.fg(color, `${bl}${h.repeat(width - 2)}${br}`);
  return [top, ...body, bottom].join('\n');
}

/** Section rule like `── TITLE ─────────`. */
export function rule(t: Theme, title: string, color: ColorName = 'violet', width = Math.min(t.width, 78)): string {
  const h = t.sym.box.h;
  const label = ` ${title} `;
  return t.fg(color, h.repeat(2)) + t.bold(t.fg(color, label)) + t.fg(color, h.repeat(Math.max(0, width - 2 - label.length)));
}

/** HP-bar style meter: green → amber → red as it fills. */
export function meter(t: Theme, value: number, max: number, width = 24): string {
  const ratio = max > 0 ? value / max : 0;
  const filled = Math.max(0, Math.min(width, Math.round(Math.min(ratio, 1) * width)));
  const color: ColorName = ratio > 1 ? 'red' : ratio >= 0.85 ? 'amber' : 'lime';
  return t.fg(color, t.sym.barFull.repeat(filled)) + t.fg('gray', t.sym.barEmpty.repeat(width - filled));
}

/** Inverted label, e.g. a provider tag. */
export function chip(t: Theme, text: string, color: ColorName): string {
  return t.level === 0 ? `[${text}]` : t.bold(t.bg(color, ` ${text} `));
}

const PROVIDER_COLORS: Record<string, ColorName> = { claude: 'orange', codex: 'cyan', manual: 'violet' };

export function providerChip(t: Theme, provider: string): string {
  return chip(t, provider.toUpperCase(), PROVIDER_COLORS[provider] ?? 'blue');
}

export function providerName(t: Theme, provider: string): string {
  return t.bold(t.fg(PROVIDER_COLORS[provider] ?? 'blue', provider));
}

export type Status = 'ok' | 'warn' | 'fail' | 'info';

export function statusIcon(t: Theme, status: Status): string {
  switch (status) {
    case 'ok':
      return t.fg('lime', t.sym.ok);
    case 'warn':
      return t.fg('amber', t.sym.warn);
    case 'fail':
      return t.fg('red', t.sym.fail);
    default:
      return t.fg('blue', t.sym.info);
  }
}

/** Fixed-width label column, e.g. `GOAL   `. */
export function label(t: Theme, text: string, width = 8): string {
  return t.bold(t.fg('violet', text.padEnd(width)));
}

export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '?' : n.toLocaleString('en-US');
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '?';
  if (seconds < 45) return 'just now';
  const units: Array<[number, string]> = [
    [60, 'm'],
    [3600, 'h'],
    [86400, 'd'],
    [86400 * 30, 'mo'],
    [86400 * 365, 'y'],
  ];
  let unit: [number, string] = units[0]!;
  for (const u of units) if (seconds >= u[0]) unit = u;
  return `${Math.floor(seconds / unit[0])}${unit[1]} ago`;
}

/** ANSI-aware table. Column widths are computed from visible text. */
export function table(t: Theme, headers: string[], rows: string[][], maxWidth = t.width): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visibleLength(r[i] ?? ''))));
  // Shrink the last column to fit the terminal.
  const fixed = widths.slice(0, -1).reduce((a, w) => a + w + 2, 0);
  widths[widths.length - 1] = Math.max(10, Math.min(widths[widths.length - 1]!, maxWidth - fixed - 2));
  const line = (cells: string[], style?: (s: string) => string) =>
    '  ' +
    cells
      .map((c, i) => {
        const fitted = truncateVisible(c, widths[i]!, t.sym.ellipsis);
        const styled = style ? style(fitted) : fitted;
        return i === cells.length - 1 ? styled : padVisible(styled, widths[i]!);
      })
      .join('  ');
  return [line(headers, (s) => t.bold(t.fg('violet', s))), ...rows.map((r) => line(r))].join('\n');
}

/** Short id for display: first 8 characters of a UUID-like id. */
export function shortId(id: string): string {
  return /^[0-9a-f-]{20,}$/i.test(id) ? id.slice(0, 8) : id;
}
