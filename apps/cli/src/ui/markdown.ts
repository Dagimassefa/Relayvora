import type { Theme } from './theme.js';

/**
 * Light terminal highlighting for handoff Markdown. Only applied when writing to a colour terminal;
 * piped output stays plain Markdown so it can be pasted into an agent unchanged.
 */
export function highlightMarkdown(md: string, t: Theme): string {
  if (t.level === 0) return md;
  let fence: string | null = null;
  let lang = '';
  return md
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s*(`{3,})(\w*)\s*$/.exec(line);
      if (fenceMatch) {
        if (fence === null) {
          fence = fenceMatch[1]!;
          lang = fenceMatch[2] ?? '';
        } else if (fenceMatch[1]!.length >= fence.length) {
          fence = null;
        }
        return t.fg('gray', line);
      }
      if (fence !== null) {
        if (lang === 'diff') {
          if (/^\s*\+(?!\+\+)/.test(line)) return t.fg('lime', line);
          if (/^\s*-(?!--)/.test(line)) return t.fg('red', line);
          if (/^\s*@@/.test(line)) return t.fg('violet', line);
          return t.dim(line);
        }
        return t.dim(line);
      }
      if (line.startsWith('# ')) return t.bold(t.gradient(line, 'cyan', 'magenta'));
      if (line.startsWith('## ')) return t.bold(t.fg('cyan', line));
      if (line.startsWith('#### ')) return t.bold(t.fg('violet', line));
      return line
        .replace(/\[observed\]/g, t.fg('lime', '[observed]'))
        .replace(/\[user\]/g, t.fg('blue', '[user]'))
        .replace(/\[(agent-reported|inferred)\]/g, (m) => t.fg('amber', m))
        .replace(/\*\*PASSED\*\*/g, t.bold(t.fg('lime', 'PASSED')))
        .replace(/\*\*(FAILED|UNKNOWN)\*\*/g, (_m, s: string) => t.bold(t.fg('red', s)))
        .replace(/`([^`\n]+)`/g, (_m, code: string) => t.fg('orange', code));
    })
    .join('\n');
}
