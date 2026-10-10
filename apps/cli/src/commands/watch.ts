import { type AgentRadar, relayRadar, renderRadar } from '../alerts.js';
import type { CliContext } from '../context.js';
import { locateProject } from '../project.js';
import { rule, statusIcon } from '../ui/components.js';
import type { Theme } from '../ui/theme.js';

export interface WatchOptions {
  intervalSeconds: number;
  /** Check once and return (also what --json without a loop uses). */
  once?: boolean;
  bell?: boolean;
  json?: boolean;
  /** Where to write (stdout in the CLI); injectable for tests. */
  write?: (text: string) => void;
  /** Stops the loop; the CLI wires this to Ctrl+C. */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface WatchEvent {
  at: string;
  kind: 'alert' | 'cleared';
  provider: string;
  sessionId: string;
  alert: string | null;
  headline: string;
  suggestion: string | null;
}

/** The alert state of one agent's latest session; null when there is nothing to relay. */
const alertKey = (r: AgentRadar) => (r.assessment.verdict === 'relay' ? `${r.session.id}:${r.assessment.alert}` : null);

/**
 * Re-checks the relay radar on an interval and reports changes the moment they happen: an agent hit
 * its usage limit, is close to it, or its large session went cold. Returns the events it emitted.
 */
export async function runWatch(ctx: CliContext, t: Theme, options: WatchOptions): Promise<WatchEvent[]> {
  const write = options.write ?? ((s: string) => process.stdout.write(s));
  const now = options.now ?? (() => new Date());
  const { root } = await locateProject(ctx.cwd);
  const state = new Map<string, string | null>();
  const events: WatchEvent[] = [];
  const time = () => now().toTimeString().slice(0, 5);

  const check = async (first: boolean) => {
    const radar = await relayRadar(ctx, root, now());
    if (first && !options.json) {
      write(['', `  ${rule(t, `RELAY RADAR ${t.sym.dot} ${root}`, 'lime', Math.min(t.width, 78) - 2)}`, '', ...renderRadar(radar, t), ''].join('\n') + '\n');
      if (!options.once) write(`  ${t.dim(`watching every ${options.intervalSeconds}s for limits, near-limits and cold sessions; Ctrl+C to stop`)}\n\n`);
    }
    for (const r of radar) {
      const key = alertKey(r);
      const prev = state.get(r.provider);
      state.set(r.provider, key);
      if (first && !options.json) continue; // already shown in the radar above
      if (key && key !== prev) {
        const event: WatchEvent = {
          at: now().toISOString(),
          kind: 'alert',
          provider: r.provider,
          sessionId: r.session.id,
          alert: r.assessment.alert,
          headline: r.assessment.headline,
          suggestion: r.suggestion,
        };
        events.push(event);
        if (options.json) write(`${JSON.stringify(event)}\n`);
        else {
          write(`${options.bell ? '\u0007' : ''}  ${t.fg('gray', time())} ${statusIcon(t, 'warn')} ${t.bold(t.fg('amber', r.assessment.headline))}\n`);
          for (const reason of r.assessment.reasons) write(`        ${t.dim(reason)}\n`);
          write(`        ${t.fg('cyan', t.sym.arrow)} ${t.bold(r.suggestion)}\n`);
        }
      } else if (!key && prev && !first) {
        const event: WatchEvent = { at: now().toISOString(), kind: 'cleared', provider: r.provider, sessionId: r.session.id, alert: null, headline: r.assessment.headline, suggestion: null };
        events.push(event);
        if (options.json) write(`${JSON.stringify(event)}\n`);
        else write(`  ${t.fg('gray', time())} ${statusIcon(t, 'ok')} ${t.dim(`${r.agent}: ${r.assessment.headline}`)}\n`);
      }
    }
  };

  await check(true);
  if (options.once) return events;
  while (!options.signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalSeconds * 1000);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (options.signal?.aborted) break;
    await check(false);
  }
  return events;
}
