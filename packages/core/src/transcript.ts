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

/** Keeps the first prompt plus a bounded window of the latest ones while streaming. */
export class PromptCollector {
  first: string | null = null;
  count = 0;
  private recent: string[] = [];

  add(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    this.count++;
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
