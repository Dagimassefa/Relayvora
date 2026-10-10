import {
  PromptCollector,
  TurnTracker,
  asNumber,
  asRecord,
  forEachJsonlRecord,
  stripInjectedBlocks,
  type TranscriptDigest,
  type TranscriptUsage,
} from '@agentrelay/core';

// Blocks Claude Code injects into user turns (slash-command echoes, hook output, IDE context).
const INJECTED_BLOCK =
  /<(system-reminder|local-command-[\w-]+|command-[\w-]+|ide_[\w-]+|user-prompt-submit-hook|bash-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g;

export function cleanUserText(text: string): string {
  return stripInjectedBlocks(text, INJECTED_BLOCK);
}

function userPromptText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === 'string') return cleanUserText(content) || null;
  if (!Array.isArray(content)) return null;
  // Tool results are carried in user turns; they are not things the user typed.
  if (content.some((c) => asRecord(c)?.type === 'tool_result')) return null;
  const parts = content
    .map((c) => asRecord(c))
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => cleanUserText(c!.text as string))
    .filter((t) => t && !/^\[Image[^\]]*\]$/.test(t));
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function assistantText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((c) => asRecord(c))
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => (c!.text as string).trim())
    .filter(Boolean)
    .join('\n\n');
  return text || null;
}

function usageFromCostState(record: Record<string, unknown>): TranscriptUsage | null {
  const models = asRecord(record.modelUsage);
  if (!models) return null;
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const value of Object.values(models)) {
    const m = asRecord(value);
    if (!m) continue;
    // Anthropic reports cache reads/writes separately from uncached input; sum them for total input.
    input += (asNumber(m.inputTokens) ?? 0) + (asNumber(m.cacheReadInputTokens) ?? 0) + (asNumber(m.cacheCreationInputTokens) ?? 0);
    cached += asNumber(m.cacheReadInputTokens) ?? 0;
    output += asNumber(m.outputTokens) ?? 0;
  }
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    costUsd: asNumber(record.totalCostUSD),
    note: 'From Claude Code session cost state. Cost is Claude Code’s estimate at API prices, not a subscription bill.',
  };
}

/** Claude Code tools that change files; the first call using one ends onboarding. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const PREFILTER =/"type"\s*:\s*"(user|assistant|ai-title|cost-state)"/;

export async function readClaudeTranscript(file: string): Promise<TranscriptDigest> {
  const prompts = new PromptCollector();
  let title: string | null = null;
  let lastAgentMessage: string | null = null;
  let usage: TranscriptUsage | null = null;
  const tracker = new TurnTracker();
  // Claude Code writes one record per content block, each repeating the call's usage: keep one per message id.
  const calls = new Map<string, Record<string, unknown>>();
  const editCalls = new Set<string>();

  const stats = await forEachJsonlRecord(
    file,
    (value) => {
      const record = asRecord(value);
      if (!record || record.isSidechain === true) return;
      tracker.seen(record.timestamp);
      const message = asRecord(record.message);
      switch (record.type) {
        case 'user':
          if (message && record.isMeta !== true) {
            const text = userPromptText(message);
            if (text) prompts.add(text);
          }
          break;
        case 'assistant': {
          if (!message) break;
          lastAgentMessage = assistantText(message) ?? lastAgentMessage;
          const callUsage = asRecord(message.usage);
          const id = typeof message.id === 'string' ? message.id : typeof record.requestId === 'string' ? record.requestId : null;
          if (callUsage && id) calls.set(id, callUsage);
          const content = Array.isArray(message.content) ? message.content : [];
          if (id && content.some((c) => asRecord(c)?.type === 'tool_use' && EDIT_TOOLS.has(String(asRecord(c)?.name)))) editCalls.add(id);
          break;
        }
        case 'ai-title':
          if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) title = record.aiTitle.trim();
          break;
        case 'cost-state':
          usage = usageFromCostState(record) ?? usage;
          break;
      }
    },
    PREFILTER,
  );

  // Context of a call = uncached input + cache reads + cache writes (Anthropic reports them separately).
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const [id, u] of calls) {
    if (editCalls.has(id)) tracker.edit();
    const read = asNumber(u.cache_read_input_tokens) ?? 0;
    const context = (asNumber(u.input_tokens) ?? 0) + read + (asNumber(u.cache_creation_input_tokens) ?? 0);
    tracker.turn(context);
    input += context;
    cached += read;
    output += asNumber(u.output_tokens) ?? 0;
  }
  // Claude Code writes its cost summary only at certain points; until then, sum the per-call usage.
  if (!usage && calls.size > 0) {
    usage = {
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      costUsd: null,
      note: 'Summed from per-call usage in the Claude Code transcript; no cost recorded yet.',
    };
  }

  const warnings: string[] = [];
  if (stats.parseErrors > 0) warnings.push(`Claude transcript: ${stats.parseErrors} unparseable line(s) skipped`);
  if (prompts.count === 0) warnings.push('Claude transcript: no user prompts recognised (format may have changed)');
  return {
    title,
    firstUserPrompt: prompts.first,
    latestSubstantialPrompt: prompts.latestSubstantial,
    recentUserPrompts: prompts.recentPrompts(),
    userPromptCount: prompts.count,
    lastAgentMessage,
    usage,
    turns: tracker.stats(),
    warnings,
  };
}
