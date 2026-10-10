import fs from 'node:fs';
import readline from 'node:readline';

export interface JsonlScanStats {
  lines: number;
  parsed: number;
  parseErrors: number;
}

/**
 * Streams every record of a JSONL file. `prefilter` runs on the raw line before JSON.parse, so
 * multi-megabyte transcripts only pay parsing cost for lines that can matter.
 */
export async function forEachJsonlRecord(
  filePath: string,
  onRecord: (record: unknown) => void,
  prefilter?: RegExp,
): Promise<JsonlScanStats> {
  const stats: JsonlScanStats = { lines: 0, parsed: 0, parseErrors: 0 };
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    stats.lines++;
    if (!line.trim() || (prefilter && !prefilter.test(line))) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      stats.parseErrors++;
      continue;
    }
    stats.parsed++;
    onRecord(record);
  }
  return stats;
}

export const RECENT_PROMPTS = 3;

/** A prompt with at least this many words is treated as a task description, not a quick follow-up. */
export const SUBSTANTIAL_PROMPT_WORDS = 12;

/** Keeps the first prompt, the latest substantial one, and a bounded window of the latest ones while streaming. */
export class PromptCollector {
  first: string | null = null;
  /** Newest prompt long enough to describe a task ("give me a commit message" is not one). */
  latestSubstantial: string | null = null;
  count = 0;
  private recent: string[] = [];

  add(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    this.count++;
    if (text.split(/\s+/).length >= SUBSTANTIAL_PROMPT_WORDS) this.latestSubstantial = text;
    if (this.first === null) {
      this.first = text;
      return;
    }
    this.recent.push(text);
    if (this.recent.length > RECENT_PROMPTS) this.recent.shift();
  }

  recentPrompts(): string[] {
    return [...this.recent];
  }
}

// Agents inject context into user turns as XML-ish blocks. snake_case tags are never typed by people
// in practice (<environment_context>, <external_codex_apps_open_page>, <user_instructions>, ...).
const SNAKE_CASE_BLOCK = /<([a-z][a-z0-9]*_[a-z0-9_]*)\b[^>]*>[\s\S]*?<\/\1>/g;

/** Removes injected context blocks. `extraTags` adds vendor tags that do not use snake_case. */
export function stripInjectedBlocks(text: string, extraTags?: RegExp): string {
  let out = text.replace(SNAKE_CASE_BLOCK, '');
  if (extraTags) out = out.replace(extraTags, '');
  return out.trim();
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
