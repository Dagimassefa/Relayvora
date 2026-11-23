/** Kane's one-shot --agent stream. Unknown events are ignored, never interpreted as success. */
export interface KaneResult {
  status: 'passed' | 'failed' | 'unknown';
  summary: string;
}

export function parseKaneResult(stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, truncated: boolean): KaneResult {
  const failures: string[] = [];
  const errors: string[] = [];
  let terminal: Record<string, unknown> | undefined;
  let terminalCount = 0;
  let unresolved = false;
  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      event = value as Record<string, unknown>;
    } catch { continue; }
    if (event.type === 'run_end') { terminal = event; terminalCount++; }
    else if (event.type === 'error' && typeof event.message === 'string') errors.push(event.message);
    else if (event.type === 'warning' && event.code === 'unresolved_variables') unresolved = true;
    else if (!event.type && event.status === 'failed' && typeof event.remark === 'string') {
      failures.push(`Step ${typeof event.step === 'number' ? event.step : '?'}: ${event.remark}`);
    }
  }
  let status: KaneResult['status'] = 'unknown';
  if (!timedOut && !truncated && terminalCount === 1 && !unresolved && errors.length === 0) {
    if (exitCode === 0 && terminal?.status === 'passed' && failures.length === 0) status = 'passed';
    if (exitCode === 1 && terminal?.status === 'failed') status = 'failed';
  }
  const description = typeof terminal?.summary === 'string' ? terminal.summary : '';
  const session = typeof terminal?.session_dir === 'string' ? `Kane session: ${terminal.session_dir}` : '';
  const lines = [`Kane result: ${status}${status === 'unknown' ? ' (incomplete, inconsistent, or infrastructure error)' : ''}`,
    ...failures, ...errors.map((e) => `Kane error: ${e}`), ...(unresolved ? ['Kane reported unresolved variables.'] : []),
    description, session, stderr.trim()].filter(Boolean);
  return { status, summary: lines.join('\n') };
}
