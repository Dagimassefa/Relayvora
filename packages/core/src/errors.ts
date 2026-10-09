/**
 * Stable process exit codes. Scripts depend on these, so values must never be reused
 * for a different meaning once released.
 */
export const ExitCode = {
  Ok: 0,
  Failure: 1,
  Usage: 2,
  NotFound: 3,
  Unsupported: 4,
  Cancelled: 5,
  PreconditionFailed: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class AgentRelayError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = ExitCode.Failure, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentRelayError';
    this.exitCode = exitCode;
  }
}
