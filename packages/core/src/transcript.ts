import type { TurnStats } from './snapshot.js';
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

/** Accumulates per-turn context sizes and the session's time span while streaming. */
export class TurnTracker {
  private count = 0;
  private firstAt: string | null = null;
  private lastAt: string | null = null;
  private firstContext: number | null = null;
  private lastContext: number | null = null;
  private tokensSoFar = 0;
  private editAt: { calls: number; tokens: number } | null = null;

  /**
   * Marks that the next counted call (or the current one, for formats that report usage after the
   * call) edited a file. Only the first edit matters: everything before it is onboarding.
   */
  edit(): void {
    this.editAt ??= { calls: this.count, tokens: this.tokensSoFar };
  }

  /** Any record with a timestamp widens the session's time span. */
  seen(timestamp: unknown): void {
    if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) return;
    if (this.firstAt === null || timestamp < this.firstAt) this.firstAt = timestamp;
    if (this.lastAt === null || timestamp > this.lastAt) this.lastAt = timestamp;
  }

  turn(contextTokens: number | null): void {
    this.count++;
    if (contextTokens === null) return;
    this.tokensSoFar += contextTokens;
    if (this.firstContext === null) this.firstContext = contextTokens;
    this.lastContext = contextTokens;
  }

  stats(): TurnStats | null {
    if (this.count === 0 && this.firstAt === null) return null;
    return {
      count: this.count,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
      firstContextTokens: this.firstContext,
      lastContextTokens: this.lastContext,
      callsBeforeFirstEdit: this.editAt?.calls ?? null,
      tokensBeforeFirstEdit: this.editAt?.tokens ?? null,
    };
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
