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

/**
 * Recovers what the user actually typed. Codex injects context as snake_case tag blocks
 * (<environment_context>, <external_codex_apps_open_page>, ...), and the IDE extension wraps the
 * request in Markdown such as "# Files mentioned by the user: ... ## My request: <text>".
 */
export function cleanCodexUserText(text: string): string | null {
  let out = stripInjectedBlocks(text);
  if (/^#{1,2} (Context from my IDE setup|Files mentioned by the user)\b/.test(out)) {
    const marker = /^#{1,3} My request[^\n]*:[ \t]*$/gm;
    let last: RegExpExecArray | null = null;
    for (let m = marker.exec(out); m; m = marker.exec(out)) last = m;
    out = last ? out.slice(last.index + last[0].length).trim() : '';
  }
  return out || null;
}

/** Cleans each input_text item separately: one item can be injected context, the next the request. */
function userText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((c) => asRecord(c))
    .filter((c) => c?.type === 'input_text' && typeof c.text === 'string')
    .map((c) => cleanCodexUserText(c!.text as string))
    .filter((t): t is string => t !== null);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

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
  const tracker = new TurnTracker();
  let lastTotal = -1;

  const stats = await forEachJsonlRecord(
    file,
    (value) => {
      const record = asRecord(value);
      if (!record) return;
      tracker.seen(record.timestamp);
      // Legacy rollouts put the item at the top level instead of under `payload`.
      const payload = record.type === 'event_msg' || record.type === 'response_item' ? asRecord(record.payload) : record;
      if (!payload) return;

      if (record.type === 'event_msg') {
        if (payload.type === 'user_message' && typeof payload.message === 'string') {
          const text = cleanCodexUserText(payload.message);
          if (text) eventPrompts.add(text);
        } else if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
          eventAgent = payload.message.trim();
        } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
          eventAgent = payload.last_agent_message.trim();
        } else if (payload.type === 'token_count') {
          const info = asRecord(payload.info);
          const total = asRecord(info?.total_token_usage);
          // token_count can repeat with unchanged totals (rate-limit updates); a turn is a growth in the total.
          const totalTokens = asNumber(total?.total_tokens);
          if (totalTokens !== null && totalTokens > lastTotal) {
            lastTotal = totalTokens;
            tracker.turn(asNumber(asRecord(info?.last_token_usage)?.input_tokens));
          }
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

      // Edits: the apply_patch tool, or apply_patch run through the shell tool. Usage for the call
      // arrives after it, so marking here counts the calls before this one as onboarding.
      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const args = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : '';
        if (payload.name === 'apply_patch' || args.includes('apply_patch')) tracker.edit();
      }

      if (payload.type === 'message' && payload.role === 'user') {
        const text = userText(payload.content);
        if (text) itemPrompts.add(text);
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
    latestSubstantialPrompt: prompts.latestSubstantial,
    recentUserPrompts: prompts.recentPrompts(),
    userPromptCount: prompts.count,
    lastAgentMessage: eventAgent ?? itemAgent,
    usage,
    turns: tracker.stats(),
    warnings,
  };
}
