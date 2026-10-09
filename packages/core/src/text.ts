import { AgentRelayError, ExitCode } from './errors.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Cuts text to `maxChars`, preferring a line boundary, and says how much was dropped. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.lastIndexOf('\n', maxChars);
  if (cut < maxChars * 0.6) cut = maxChars;
  return { text: `${text.slice(0, cut).trimEnd()}\n…[truncated ${text.length - cut} chars]`, truncated: true };
}

/** Collapses runs of identical lines (progress spam, repeated warnings) into one line plus a count. */
export function collapseRepeatedLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]!);
    if (j - i > 1) out.push(`…(previous line repeated ${j - i - 1} more times)`);
    i = j;
  }
  return out;
}

const FAILURE_LINE =
  /\b(error|errors|fail|failed|failing|failure|exception|assert(ion)?|expected|panic|traceback|cannot|undefined is not)\b|[✗×✖]/i;

/**
 * Deterministic excerpt of command output that keeps what matters for a failure: lines that look
 * like errors (with one line of context) and the tail, where most tools print their summary.
 */
export function outputExcerpt(output: string, { maxLines = 60, maxChars = 4000, tailLines = 25 } = {}): {
  text: string;
  truncated: boolean;
} {
  const lines = collapseRepeatedLines(stripAnsi(output).replace(/\r\n?/g, '\n').trimEnd().split('\n'));
  if (lines.length <= maxLines) {
    const t = truncateText(lines.join('\n'), maxChars);
    return t;
  }

  const tailStart = lines.length - tailLines;
  const keep = new Set<number>();
  for (let i = 0; i < tailStart && keep.size < maxLines - tailLines; i++) {
    if (FAILURE_LINE.test(lines[i]!)) {
      keep.add(i);
      if (i + 1 < tailStart) keep.add(i + 1);
    }
  }
  const picked: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) picked.push('…');
    picked.push(lines[i]!);
    last = i;
  }
  picked.push(`…(${tailStart - keep.size} lines omitted)…`, ...lines.slice(tailStart));
  return { text: truncateText(picked.join('\n'), maxChars).text, truncated: true };
}

/** Returns a Markdown code fence longer than any backtick run inside `content`. */
export function fence(content: string, lang = ''): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${content.replace(/\n$/, '')}\n${f}`;
}

/**
 * Splits a command line into argv without invoking a shell. Supports single and double quotes.
 * Shell operators are rejected rather than silently passed as literal arguments.
 */
export function parseCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) current += line[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) args.push(current);
      current = '';
      inToken = false;
    } else if ('|&;<>`'.includes(c) || (c === '$' && line[i + 1] === '(')) {
      throw new AgentRelayError(
        `Shell operator "${c}" is not supported in a verification command (no shell is used). Put the pipeline in a script and run that.`,
        ExitCode.Usage,
      );
    } else {
      current += c;
      inToken = true;
    }
  }
  if (quote) throw new AgentRelayError(`Unterminated ${quote} quote in command: ${line}`, ExitCode.Usage);
  if (inToken) args.push(current);
  if (args.length === 0) throw new AgentRelayError('Empty verification command', ExitCode.Usage);
  return args;
}
