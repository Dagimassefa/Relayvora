import fs from 'node:fs/promises';

export interface JsonlHead {
  records: unknown[];
  parseErrors: number;
  /** Lines skipped because they exceeded `maxLineBytes` (e.g. a prompt with pasted images). */
  oversizedLines: number;
  /** True when the scan stopped before end of file. */
  partial: boolean;
}

export interface JsonlHeadOptions {
  /** Stop after this many parsed records. */
  maxRecords?: number;
  /** Lines longer than this are skipped without being buffered. */
  maxLineBytes?: number;
  /** Never read more than this many bytes in total. */
  maxScanBytes?: number;
}

const NEWLINE = 0x0a;

/**
 * Parses the first records of a JSONL file. Agent transcripts can be huge and a single line can
 * hold megabytes of pasted content, so this streams in chunks, skips oversized lines without
 * buffering them, and stops at a hard byte cap.
 */
export async function readJsonlHead(filePath: string, options: JsonlHeadOptions = {}): Promise<JsonlHead> {
  const { maxRecords = 50, maxLineBytes = 256 * 1024, maxScanBytes = 8 * 1024 * 1024 } = options;
  const result: JsonlHead = { records: [], parseErrors: 0, oversizedLines: 0, partial: false };

  const handle = await fs.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let line: Buffer[] = [];
    let lineBytes = 0;
    let skipping = false;
    let position = 0;

    const finishLine = () => {
      if (skipping) {
        result.oversizedLines++;
      } else if (lineBytes > 0) {
        const text = Buffer.concat(line, lineBytes).toString('utf8').trim();
        if (text) {
          try {
            result.records.push(JSON.parse(text));
          } catch {
            result.parseErrors++;
          }
        }
      }
      line = [];
      lineBytes = 0;
      skipping = false;
    };

    while (result.records.length < maxRecords) {
      if (position >= maxScanBytes) {
        result.partial = true;
        break;
      }
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxScanBytes - position), position);
      if (bytesRead === 0) {
        finishLine(); // final line without a trailing newline
        break;
      }
      position += bytesRead;

      let start = 0;
      while (start < bytesRead && result.records.length < maxRecords) {
        const nl = chunk.indexOf(NEWLINE, start);
        const end = nl === -1 || nl >= bytesRead ? bytesRead : nl;
        if (!skipping) {
          const piece = end - start;
          if (lineBytes + piece > maxLineBytes) {
            skipping = true;
            line = [];
            lineBytes = 0;
          } else if (piece > 0) {
            line.push(Buffer.from(chunk.subarray(start, end)));
            lineBytes += piece;
          }
        }
        if (end === bytesRead) break;
        finishLine();
        start = end + 1;
      }
    }

    if (result.records.length >= maxRecords) result.partial = true;
    return result;
  } finally {
    await handle.close();
  }
}

/** Safely reads a string at a dotted path from untrusted parsed JSON. */
export function pickString(value: unknown, dottedPath: string): string | undefined {
  let current: unknown = value;
  for (const key of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}
