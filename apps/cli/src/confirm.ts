import readline from 'node:readline/promises';
import { AgentRelayError, ExitCode } from '@agentrelay/core';

export interface ConfirmOptions {
  /** Pre-approved via a documented non-interactive flag such as --yes. */
  yes?: boolean;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
}

/**
 * Asks a yes/no question on the terminal. Without a TTY it refuses rather than guessing, so scripts
 * must opt in explicitly with --yes. Declining raises a Cancelled error.
 */
export async function confirmOrAbort(question: string, options: ConfirmOptions = {}): Promise<void> {
  if (options.yes) return;
  const input = options.input ?? process.stdin;
  if (!input.isTTY) {
    throw new AgentRelayError(`${question} Confirmation needed: re-run with --yes to proceed non-interactively.`, ExitCode.PreconditionFailed);
  }
  const rl = readline.createInterface({ input, output: options.output ?? process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) throw new AgentRelayError('Cancelled.', ExitCode.Cancelled);
  } finally {
    rl.close();
  }
}
