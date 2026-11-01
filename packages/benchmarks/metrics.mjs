/** Parse the documented `codex exec --json` stream. Costs are deliberately unknown. */
export function parseCodexOutput(stdout, resumeId) {
  const events = stdout.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  const failed = events.find(e => e.type === 'turn.failed' || e.type === 'error');
  if (failed) throw new Error(`Codex failed: ${JSON.stringify(failed)}`);
  const completed = events.filter(e => e.type === 'turn.completed');
  const sessionId = events.find(e => e.type === 'thread.started')?.thread_id ?? resumeId;
  if (!sessionId || completed.length === 0) throw new Error('Codex stream has no session id or completed turn');
  const sum = key => completed.reduce((n, e) => n + (e.usage?.[key] ?? 0), 0);
  return {
    session_id: sessionId,
    usage: { input_tokens: sum('input_tokens'), cached_input_tokens: sum('cached_input_tokens'), output_tokens: sum('output_tokens') },
    num_turns: completed.length,
    is_error: false,
  };
}

export function parseOptions(argv) {
  const opts = {};
  const values = new Set(['tasks', 'agents', 'scenarios', 'reps', 'concurrency', 'cold-minutes', 'rescore']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (['run', 'dry-run', 'help'].includes(key) && argv[i].startsWith('--')) opts[key] = true;
    else if (values.has(key) && argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${argv[i]}`);
  }
  for (const key of ['reps', 'concurrency', 'cold-minutes']) {
    if (opts[key] !== undefined && (!/^[1-9]\d*$/.test(opts[key]) || !Number.isSafeInteger(Number(opts[key])))) throw new Error(`--${key} must be a positive integer`);
  }
  for (const [key, allowed] of [['agents', ['claude', 'codex']], ['scenarios', ['warm', 'cold']]]) {
    if (opts[key] && opts[key].split(',').some(v => !allowed.includes(v))) throw new Error(`--${key} must use ${allowed.join(',')}`);
  }
  if (opts.tasks && opts.tasks.split(',').some(v => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v))) throw new Error('Invalid task name');
  return opts;
}

export function sumKnown(values) {
  return values.every(v => v !== null && v !== undefined) ? values.reduce((a, b) => a + b, 0) : null;
}
