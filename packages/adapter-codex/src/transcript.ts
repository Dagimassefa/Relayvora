import {
  PromptCollector,
  asNumber,
  asRecord,
  forEachJsonlRecord,
  type TranscriptDigest,
  type TranscriptUsage,
} from '@agentrelay/core';

function contentText(content: unknown, itemType: string): string | null {
  if (!Array.isArray(content)) return null;
  const text = content
    .map((c) => asRecord(c))
    .filter((c) => c?.type === itemType && typeof c.text === 'string')
    .map((c) => (c!.text as string).trim())
    .filter(Boolean)
    .join('\n\n');
  return text || null;
}

// Codex injects environment and instruction blocks as user-role messages.
const INJECTED = /^<(environment_context|user_instructions|permissions|turn_aborted)\b/;

const PREFILTER = /"type"\s*:\s*"(event_msg|response_item|message)"/;

/**
 * Prefers `event_msg` records (clean user/agent text). Falls back to `response_item` messages for
 * older rollouts that do not emit events.
 */
export async function readCodexTranscript(file: string): Promise<TranscriptDigest> {
  const eventPrompts = new PromptCollector();
  const itemPrompts = new PromptCollector();
  let eventAgent: string | null = null;
  let itemAgent: string | null = null;
  let usage: TranscriptUsage | null = null;

  const stats = await forEachJsonlRecord(
    file,
    (value) => {
      const record = asRecord(value);
      if (!record) return;
      // Legacy rollouts put the item at the top level instead of under `payload`.
      const payload = record.type === 'event_msg' || record.type === 'response_item' ? asRecord(record.payload) : record;
      if (!payload) return;

      if (record.type === 'event_msg') {
        if (payload.type === 'user_message' && typeof payload.message === 'string') {
          eventPrompts.add(payload.message);
        } else if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
          eventAgent = payload.message.trim();
        } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
          eventAgent = payload.last_agent_message.trim();
        } else if (payload.type === 'token_count') {
          const total = asRecord(asRecord(payload.info)?.total_token_usage);
          if (total) {
            usage = {
              // OpenAI semantics: input_tokens already includes cached_input_tokens.
              inputTokens: asNumber(total.input_tokens),
              cachedInputTokens: asNumber(total.cached_input_tokens),
              outputTokens: asNumber(total.output_tokens),
              costUsd: null,
              note: 'From Codex CLI cumulative token_count events. Codex records no cost.',
            };
          }
        }
        return;
      }

      if (payload.type === 'message' && payload.role === 'user') {
        const text = contentText(payload.content, 'input_text');
        if (text && !INJECTED.test(text)) itemPrompts.add(text);
      } else if (payload.type === 'message' && payload.role === 'assistant') {
        itemAgent = contentText(payload.content, 'output_text') ?? itemAgent;
      }
    },
    PREFILTER,
  );

  const prompts = eventPrompts.count > 0 ? eventPrompts : itemPrompts;
  const warnings: string[] = [];
  if (stats.parseErrors > 0) warnings.push(`Codex transcript: ${stats.parseErrors} unparseable line(s) skipped`);
  if (prompts.count === 0) warnings.push('Codex transcript: no user prompts recognised (format may have changed)');
  return {
    title: null,
    firstUserPrompt: prompts.first,
    recentUserPrompts: prompts.recentPrompts(),
    userPromptCount: prompts.count,
    lastAgentMessage: eventAgent ?? itemAgent,
    usage,
    warnings,
  };
}
