/** Kane's one-shot --agent stream. Unknown events are ignored, never interpreted as success. */
export interface KaneFailure {
  /** Kane's machine-readable outcome, e.g. assertion_error.confirmed_product_bug. */
  reasonCode?: string;
  /** Kane's own verdict about who is at fault; application_issue means the app, not the agent or infrastructure. */
  family?: string;
  confirmed?: boolean;
  confidence?: number;
  title?: string;
  rootCause?: string;
  suggestion?: string;
}

export interface KaneResult {
  status: 'passed' | 'failed' | 'unknown';
  summary: string;
  failure?: KaneFailure;
  /** Local path of Kane's evidence pack, if reported. Relayvora records the path but never copies the pack. */
  evidencePack?: string;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

// Kane's own progress chatter on stderr; the evidence path is taken from the structured event instead.
const STDERR_NOISE = [/^Skill update available:/i, /^Running on:/i, /^evidence: view locally with/i];

function readVerdict(terminal: Record<string, unknown>): KaneFailure | undefined {
  const verdict = terminal.verdict && typeof terminal.verdict === 'object' && !Array.isArray(terminal.verdict)
    ? terminal.verdict as Record<string, unknown> : undefined;
  const failure: KaneFailure = {
    reasonCode: str(terminal.reason_code),
    family: str(verdict?.family),
    confirmed: typeof verdict?.confirmed === 'boolean' ? verdict.confirmed : undefined,
    confidence: typeof verdict?.confidence === 'number' ? verdict.confidence : undefined,
    title: str(verdict?.bug_title),
    rootCause: str(verdict?.root_cause) ?? str(terminal.reason),
    suggestion: str(verdict?.suggestion),
  };
  return Object.values(failure).some((v) => v !== undefined) ? failure : undefined;
}

export function parseKaneResult(stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, truncated: boolean): KaneResult {
  const failures: string[] = [];
  const errors: string[] = [];
  let terminal: Record<string, unknown> | undefined;
  let terminalCount = 0;
  let unresolved = false;
  let evidencePack: string | undefined;
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
    else if (event.type === 'coverage' && str(event.pack)) evidencePack = str(event.pack);
    else if (!event.type && event.status === 'failed' && typeof event.remark === 'string') {
      failures.push(`Step ${typeof event.step === 'number' ? event.step : '?'}: ${event.remark}`);
    }
  }
  const failure = terminal?.status === 'failed' ? readVerdict(terminal) : undefined;
  // A verdict that blames the agent or infrastructure, or is unconfirmed, is not evidence of an app defect.
  const verdictDisputes = failure?.family !== undefined && (failure.family !== 'application_issue' || failure.confirmed !== true);
  let status: KaneResult['status'] = 'unknown';
  if (!timedOut && !truncated && terminalCount === 1 && !unresolved && errors.length === 0) {
    if (exitCode === 0 && terminal?.status === 'passed' && failures.length === 0) status = 'passed';
    if (exitCode === 1 && terminal?.status === 'failed' && !verdictDisputes) status = 'failed';
  }
  const reason = status !== 'unknown' ? ''
    : verdictDisputes ? ` (Kane did not confirm an application defect: ${failure!.family}${failure!.confirmed === true ? '' : ', unconfirmed'})`
    : ' (incomplete, inconsistent, or infrastructure error)';
  // Kane's summary often repeats the verdict's root cause and suggestion; keep only the new lines.
  const verdictText = [failure?.rootCause, failure?.suggestion].filter(Boolean).join('\n');
  const description = (str(terminal?.summary) ?? '').split('\n').filter((l) => !l.trim() || !verdictText.includes(l.trim())).join('\n').trim();
  const session = str(terminal?.session_dir) ? `Kane session: ${str(terminal?.session_dir)}` : '';
  const verdictLines = failure ? [
    failure.reasonCode && `Kane reason: ${failure.reasonCode}`,
    failure.title && `Kane bug: ${failure.title}${failure.confidence !== undefined ? ` (confidence ${failure.confidence})` : ''}`,
    failure.rootCause && `Kane root cause: ${failure.rootCause}`,
    failure.suggestion && `Kane suggestion (unverified): ${failure.suggestion}`,
  ] : [];
  const extraStderr = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !STDERR_NOISE.some((re) => re.test(l))).join('\n');
  // test_url (a shareable Test Manager link) is deliberately never recorded.
  const lines = [`Kane result: ${status}${reason}`,
    ...failures, ...errors.map((e) => `Kane error: ${e}`), ...(unresolved ? ['Kane reported unresolved variables.'] : []),
    ...verdictLines, description, session, evidencePack ? `Kane evidence pack: ${evidencePack}` : '', extraStderr].filter(Boolean);
  return { status, summary: lines.join('\n'), ...(failure ? { failure } : {}), ...(evidencePack ? { evidencePack } : {}) };
}
