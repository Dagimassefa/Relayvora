import type { Theme } from './theme.js';
import { statusIcon, type Status } from './components.js';

export interface StepOutcome {
  status: Status;
  detail?: string;
}

/** Reports long-running steps. The checkpoint service depends only on this interface. */
export interface Progress {
  step<T>(label: string, run: () => Promise<T>, outcome?: (result: T) => StepOutcome): Promise<T>;
}

export const SILENT_PROGRESS: Progress = {
  step: (_label, run) => run(),
};

const seconds = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Animated spinner on a TTY, one static line per finished step otherwise. Writes to `stream`
 * (stderr in the CLI) so stdout stays clean for the handoff text and --json.
 */
export function terminalProgress(t: Theme, stream: NodeJS.WriteStream = process.stderr): Progress {
  const animate = Boolean(stream.isTTY) && t.level > 0;
  return {
    async step(label, run, outcome) {
      const started = Date.now();
      let frame = 0;
      const draw = () => {
        const spin = t.fg('cyan', t.sym.spinner[frame++ % t.sym.spinner.length]!);
        stream.write(`\r\u001b[2K  ${spin} ${label} ${t.fg('gray', seconds(Date.now() - started))}`);
      };
      const timer = animate ? setInterval(draw, 80) : undefined;
      if (animate) draw();

      const finish = (status: Status, detail?: string) => {
        if (timer) clearInterval(timer);
        const parts = [`  ${statusIcon(t, status)} ${label}`];
        if (detail) parts.push(status === 'fail' ? t.fg('red', detail) : status === 'warn' ? t.fg('amber', detail) : t.dim(detail));
        parts.push(t.fg('gray', seconds(Date.now() - started)));
        stream.write(`${animate ? '\r\u001b[2K' : ''}${parts.join('  ')}\n`);
      };

      try {
        const result = await run();
        const o = outcome?.(result) ?? { status: 'ok' as const };
        finish(o.status, o.detail);
        return result;
      } catch (error) {
        finish('fail', (error as Error).message.split('\n')[0]);
        throw error;
      }
    },
  };
}
