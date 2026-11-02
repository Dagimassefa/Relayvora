import {
  PromptCollector,
  TurnTracker,
  asNumber,
  asRecord,
  stripInjectedBlocks,
  type SessionHealth,
  type TranscriptDigest,
  type TranscriptUsage,
} from '@relayvora/core';
import { openDatabase, parseSessionPath } from './db.js';

interface Row {
  id: string;
  message_id?: string;
  time_created: number;
  data: string;
}

/** OpenCode tools that change files; the first call using one ends onboarding. */
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const LIMIT_TEXT = /usage limit|rate.?limit|quota|too many requests|hit your .*limit|insufficient_quota/i;
/** Titles OpenCode gives a session before it has generated one. */
const PLACEHOLDER_TITLE = /^(New|Child) session - /;

const iso = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function parse(row: Row): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(row.data)) ?? null;
  } catch {
    return null;
  }
}

/** Text the user or agent wrote; `synthetic` parts are injected by OpenCode (file contents, reminders). */
function partsText(parts: Record<string, unknown>[]): string | null {
  const text = parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string' && !p.synthetic && !p.ignored)
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n\n');
  return text || null;
}

/** Anthropic-style counts: cache reads and writes are reported apart from uncached input. */
function contextOf(tokens: Record<string, unknown> | undefined): number | null {
  if (!tokens) return null;
  const cache = asRecord(tokens.cache);
  const input = asNumber(tokens.input);
  if (input === null) return null;
  return input + (asNumber(cache?.read) ?? 0) + (asNumber(cache?.write) ?? 0);
}

function errorText(error: unknown): string | null {
  const e = asRecord(error);
  if (!e) return null;
  const data = asRecord(e.data);
  const message = typeof data?.message === 'string' ? data.message : typeof e.message === 'string' ? e.message : null;
  const limited = asNumber(data?.statusCode) === 429 || (message !== null && LIMIT_TEXT.test(message));
  return limited ? (message ?? 'rate limit reached').slice(0, 200) : null;
}

export async function readOpenCodeTranscript(sessionPathValue: string): Promise<TranscriptDigest> {
  const { dbFile, sessionId } = parseSessionPath(sessionPathValue);
  const db = openDatabase(dbFile);
  let title: string | null = null;
  let messages: Row[];
  let parts: Row[];
  try {
    const session = db.prepare('SELECT title FROM session WHERE id = ?').get(sessionId) as { title?: string } | undefined;
    if (!session) throw new Error(`OpenCode session ${sessionId} not found in ${dbFile}`);
    if (session.title && !PLACEHOLDER_TITLE.test(session.title)) title = session.title;
    messages = db
      .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId) as unknown as Row[];
    // Part ids sort in creation order.
    parts = db
      .prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id')
      .all(sessionId) as unknown as Row[];
  } finally {
    db.close();
  }

  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  let parseErrors = 0;
  for (const row of parts) {
    const part = parse(row);
    if (!part) {
      parseErrors++;
      continue;
    }
    const list = partsByMessage.get(row.message_id!) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id!, list);
  }

  const prompts = new PromptCollector();
  const tracker = new TurnTracker();
  let lastAgent: string | null = null;
  let input = 0;
  let cached = 0;
  let output = 0;
  let cost = 0;
  let sawTokens = false;
  const health: SessionHealth = {
    lastActivityAt: null,
    lastSuccessAt: null,
    lastLimitAt: null,
    limitMessage: null,
    limitResetsAt: null,
    quota: [],
    quotaAt: null,
    compactions: 0,
  };

  const count = (tokens: Record<string, unknown> | undefined, callCost: unknown) => {
    const context = contextOf(tokens);
    tracker.turn(context);
    if (!tokens) return;
    sawTokens = true;
    input += context ?? 0;
    cached += asNumber(asRecord(tokens.cache)?.read) ?? 0;
    // Reasoning tokens are billed as output.
    output += (asNumber(tokens.output) ?? 0) + (asNumber(tokens.reasoning) ?? 0);
    cost += asNumber(callCost) ?? 0;
  };

  for (const row of messages) {
    const message = parse(row);
    if (!message) {
      parseErrors++;
      continue;
    }
    const time = asRecord(message.time);
    const at = iso(time?.created) ?? iso(row.time_created);
    tracker.seen(at);
    tracker.seen(iso(time?.completed));
    const own = partsByMessage.get(row.id) ?? [];

    if (message.role === 'user') {
      if (own.some((p) => p.type === 'compaction')) health.compactions++;
      const text = partsText(own);
      const cleaned = text ? stripInjectedBlocks(text) : '';
      if (cleaned) prompts.add(cleaned);
      continue;
    }
    if (message.role !== 'assistant') continue;

    // Each step-finish is one model call, reported after that step's tool calls.
    let edited = false;
    let steps = 0;
    for (const part of own) {
      if (part.type === 'tool' && typeof part.tool === 'string' && EDIT_TOOLS.has(part.tool)) edited = true;
      if (part.type === 'retry') {
        const limit = errorText(part.error);
        if (limit) {
          health.lastLimitAt = iso(asRecord(part.time)?.created) ?? at;
          health.limitMessage = limit;
        }
      }
      if (part.type === 'step-finish') {
        steps++;
        if (edited) tracker.edit();
        edited = false;
        count(asRecord(part.tokens), part.cost);
      }
    }
    if (steps === 0 && message.tokens) {
      if (edited) tracker.edit();
      count(asRecord(message.tokens), message.cost);
    }

    const limit = errorText(message.error);
    if (limit) {
      health.lastLimitAt = at;
      health.limitMessage = limit;
    } else if (!message.error && time?.completed) {
      health.lastSuccessAt = iso(time.completed);
    }
    lastAgent = partsText(own) ?? lastAgent;
  }

  const usage: TranscriptUsage | null = sawTokens
    ? {
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
        costUsd: cost,
        note: 'From OpenCode per-call token counts. Cost is OpenCode’s estimate from model prices; free models report 0.',
      }
    : null;

  const warnings: string[] = [];
  if (parseErrors > 0) warnings.push(`OpenCode transcript: ${parseErrors} unparseable record(s) skipped`);
  if (prompts.count === 0) warnings.push('OpenCode transcript: no user prompts recognised (format may have changed)');
  const turns = tracker.stats();
  return {
    title,
    firstUserPrompt: prompts.first,
    latestSubstantialPrompt: prompts.latestSubstantial,
    recentUserPrompts: prompts.recentPrompts(),
    userPromptCount: prompts.count,
    lastAgentMessage: lastAgent,
    usage,
    turns,
    health: { ...health, lastActivityAt: turns?.lastAt ?? null },
    warnings,
  };
}
