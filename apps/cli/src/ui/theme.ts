/**
 * Terminal theme: colour depth detection, the palette, and symbol sets. Everything degrades to plain
 * text when output is not a terminal, when NO_COLOR / --no-color is set, or with --json, so scripts
 * and logs never see escape codes.
 */

export type ColorLevel = 0 | 1 | 2 | 3; // none, 16 colours, 256 colours, truecolor

type Rgb = readonly [number, number, number];

/** Neon-on-dark palette. `basic` is the closest 16-colour SGR code for limited terminals. */
export const PALETTE = {
  cyan: { rgb: [0, 229, 255], basic: 96 },
  magenta: { rgb: [255, 43, 214], basic: 95 },
  violet: { rgb: [139, 92, 246], basic: 35 },
  lime: { rgb: [57, 255, 20], basic: 92 },
  amber: { rgb: [255, 176, 0], basic: 93 },
  red: { rgb: [255, 59, 92], basic: 91 },
  blue: { rgb: [56, 189, 248], basic: 94 },
  orange: { rgb: [255, 122, 69], basic: 33 },
  gray: { rgb: [120, 128, 150], basic: 90 },
  white: { rgb: [235, 240, 255], basic: 97 },
  ink: { rgb: [12, 12, 20], basic: 30 },
} as const satisfies Record<string, { rgb: Rgb; basic: number }>;

export type ColorName = keyof typeof PALETTE;

export interface Symbols {
  ok: string;
  fail: string;
  warn: string;
  info: string;
  arrow: string;
  bullet: string;
  dot: string;
  bolt: string;
  barFull: string;
  barEmpty: string;
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  spinner: string[];
  ellipsis: string;
}

const UNICODE: Symbols = {
  ok: '✔',
  fail: '✖',
  warn: '▲',
  info: '●',
  arrow: '➜',
  bullet: '◆',
  dot: '·',
  bolt: '⚡',
  barFull: '█',
  barEmpty: '░',
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ellipsis: '…',
};

const ASCII: Symbols = {
  ok: '+',
  fail: 'x',
  warn: '!',
  info: '*',
  arrow: '>',
  bullet: '*',
  dot: '-',
  bolt: '*',
  barFull: '#',
  barEmpty: '-',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  spinner: ['|', '/', '-', '\\'],
  ellipsis: '...',
};

export interface Theme {
  level: ColorLevel;
  unicode: boolean;
  /** Usable columns. */
  width: number;
  sym: Symbols;
  fg(color: ColorName, text: string): string;
  bg(color: ColorName, text: string, fg?: ColorName): string;
  bold(text: string): string;
  dim(text: string): string;
  /** Horizontal colour gradient across the visible characters of `text`. */
  gradient(text: string, from: ColorName, to: ColorName): string;
}

const ESC = '\u001b[';

function rgbTo256([r, g, b]: Rgb): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function sgr(level: ColorLevel, rgb: Rgb, basic: number, background: boolean): string {
  if (level === 3) return `${ESC}${background ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (level === 2) return `${ESC}${background ? 48 : 38};5;${rgbTo256(rgb)}m`;
  return `${ESC}${background ? basic + 10 : basic}m`;
}

export interface ThemeOptions {
  /** false forces plain output (e.g. --no-color, --json). */
  color?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function detectColorLevel(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    const n = Number.parseInt(force, 10);
    return (n >= 1 && n <= 3 ? n : 1) as ColorLevel;
  }
  if (!stream.isTTY || env.TERM === 'dumb') return 0;
  // Node's own detection covers Windows Terminal, conhost, COLORTERM, TERM and CI variables.
  const depth = typeof stream.getColorDepth === 'function' ? stream.getColorDepth(env) : 4;
  return depth >= 24 ? 3 : depth >= 8 ? 2 : depth >= 4 ? 1 : 0;
}

function detectUnicode(env: NodeJS.ProcessEnv): boolean {
  if (env.AGENTRELAY_ASCII === '1') return false;
  if (process.platform !== 'win32') return env.TERM !== 'linux';
  // Every modern Windows host (Windows Terminal, VS Code, conhost on Win10+) renders these glyphs.
  return true;
}

export function createTheme(stream: NodeJS.WriteStream, options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env;
  const level: ColorLevel = options.color === false ? 0 : detectColorLevel(stream, env);
  const unicode = detectUnicode(env);
  const width = Math.max(40, Math.min(stream.columns || 80, 100));
  return makeTheme(level, unicode, width);
}

export function makeTheme(level: ColorLevel, unicode = true, width = 80): Theme {
  const wrap = (open: string, close: string) => (text: string) => (level === 0 || text === '' ? text : `${open}${text}${close}`);
  const fgCode = (c: ColorName) => sgr(level, PALETTE[c].rgb, PALETTE[c].basic, false);
  const bgCode = (c: ColorName) => sgr(level, PALETTE[c].rgb, PALETTE[c].basic, true);

  return {
    level,
    unicode,
    width,
    sym: unicode ? UNICODE : ASCII,
    fg: (color, text) => wrap(fgCode(color), `${ESC}39m`)(text),
    bg: (color, text, fg = 'ink') => (level === 0 ? text : `${bgCode(color)}${fgCode(fg)}${text}${ESC}39m${ESC}49m`),
    bold: wrap(`${ESC}1m`, `${ESC}22m`),
    dim: wrap(`${ESC}2m`, `${ESC}22m`),
    gradient(text, from, to) {
      if (level === 0) return text;
      if (level === 1) return this.fg(from, text);
      const chars = [...text];
      const a = PALETTE[from].rgb;
      const b = PALETTE[to].rgb;
      const n = Math.max(1, chars.filter((c) => c.trim()).length - 1);
      let i = 0;
      return (
        chars
          .map((c) => {
            if (!c.trim()) return c;
            const t = i++ / n;
            const rgb: Rgb = [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * t)) as unknown as Rgb;
            return `${sgr(level, rgb, PALETTE[from].basic, false)}${c}`;
          })
          .join('') + `${ESC}39m`
      );
    },
  };
}

/** Plain theme for --json, pipes and tests. */
export const PLAIN = makeTheme(0, true, 80);
