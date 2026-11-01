#!/usr/bin/env node
/**
 * Matched-task benchmark: does relaying through Relayvora save tokens versus continuing the session?
 *
 * Each task has two steps. Step A builds up a session. Step B is the follow-up, done either
 *   normal: in the same session (claude -p --resume), or
 *   relay:  in a fresh session started from an Relayvora handoff (checkpoint + launch prompt).
 * Both arms do their own step A in their own copy of the task, so step B starts from equivalent states.
 * Usage comes from each agent's own JSON output; quality from hidden tests the agents never see.
 *
 *   node run.mjs --agents claude,codex --scenarios warm,cold --reps 3 --dry-run
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from '../core/dist/index.js';
import { parseCodexOutput, parseOptions, sumKnown } from './metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', '..', 'apps', 'cli', 'dist', 'bin.js');
const ALLOWED_TOOLS = ['Bash(npm *)', 'Bash(node *)', 'PowerShell(npm *)', 'PowerShell(node *)'];

const args = parseOptions(process.argv.slice(2));
const taskNames = (args.tasks ?? 'small-calculator,large-inventory,medium-csv').split(',');
const agents = (args.agents ?? 'claude,codex').split(',');
const scenarios = (args.scenarios ?? 'warm').split(',');
const reps = Number(args.reps ?? 3);
const concurrency = Number(args.concurrency ?? 2);
const coldMinutes = Number(args['cold-minutes'] ?? 65);

const run = async (file, argv, opts = {}) => {
  const r = await runCommand(file, argv, { maxOutputBytes: 64 * 1024 * 1024, timeoutMs: 900_000, ...opts });
  if (r.timedOut || r.cancelled || r.truncated) throw new Error(`Command did not finish completely: ${file}`);
  return { code: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
};

const relayvora = (argv, cwd, env) => run(process.execPath, [CLI, ...argv], { cwd, env: { ...process.env, ...env } });

async function agentPath(agent) {
  const r = await relayvora(['--json', 'doctor'], process.cwd());
  const check = JSON.parse(r.stdout).checks.find((c) => c.id === `adapter:${agent}`);
  const p = check?.detail?.probe?.path;
  if (!p) throw new Error(`${agent} not found (relayvora doctor)`);
  return p;
}

/** One non-interactive agent invocation; normalizes the provider result plus wall time. */
async function invokeAgent(bin, agent, cwd, prompt, resume) {
  // Prompts use stdin so Windows batch shims never interpret task text.
  const argv = agent === 'codex'
    ? ['exec', ...(resume ? ['resume', resume] : []), '--json', '--full-auto', '-']
    : ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS, ...(resume ? ['--resume', resume] : [])];
  const started = new Date();
  const r = await run(bin, argv, { cwd, input: prompt });
  if (r.code !== 0) throw new Error(`${agent} exited ${r.code}: ${r.stderr.slice(0, 500)}`);
  let json;
  try {
    json = agent === 'codex' ? parseCodexOutput(r.stdout, resume) : JSON.parse(r.stdout);
  } catch {
    throw new Error(`${agent} output could not be read: ${r.stdout.slice(0, 300)}`);
  }
  if (json.is_error || !json.session_id) throw new Error(`${agent} did not complete successfully`);
  json.duration_ms ??= Date.now() - started.getTime();
  return { json, startedAt: started.toISOString(), endedAt: new Date().toISOString() };
}

/** Per-call input context from the session transcript, deduplicated by message id, within a time window. */
function callsInWindow(sessionId, fromIso, toIso, agent) {
  const dir = agent === 'codex'
    ? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions')
    : path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
  if (!fs.existsSync(dir)) return [];
  const file = agent === 'codex'
    ? fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, String(f))).find(f => f.endsWith(`${sessionId}.jsonl`))
    : fs.readdirSync(dir).map(d => path.join(dir, d, `${sessionId}.jsonl`)).find(f => fs.existsSync(f));
  if (!file) return [];
  const calls = new Map();
  let lastTotal = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (agent === 'codex') {
      if (o.type !== 'event_msg' || o.payload?.type !== 'token_count') continue;
      const info = o.payload.info;
      const total = info?.total_token_usage?.total_tokens ?? 0;
      if (total <= lastTotal) continue;
      lastTotal = total;
      if (o.timestamp >= fromIso && o.timestamp <= toIso && typeof info?.last_token_usage?.input_tokens === 'number') calls.set(total, info.last_token_usage.input_tokens);
      continue;
    }
    if (o.type !== 'assistant' || !o.message?.usage || !o.message.id) continue;
    if (o.timestamp < fromIso || o.timestamp > toIso) continue;
    const u = o.message.usage;
    calls.set(o.message.id, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
  }
  return [...calls.values()];
}

/**
 * Cost of one `claude -p` call. Careful: with --resume, total_cost_usd (and modelUsage) are cumulative
 * for the whole session, while `usage` covers only this call. Pass the previous cumulative cost to get
 * the cost of this step alone.
 */
function usageOf(step, calls, previousCumulativeCost = 0) {
  const u = step.json.usage ?? {};
  return {
    costUsd: step.json.total_cost_usd === undefined ? null : step.json.total_cost_usd - previousCumulativeCost,
    cumulativeCostUsd: step.json.total_cost_usd ?? null,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    cacheReadTokens: u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: step.agent === 'codex' ? null : u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    turns: step.json.num_turns ?? null,
    durationMs: step.json.duration_ms ?? null,
    calls: calls.length,
    firstCallContext: calls[0] ?? null,
    avgCallContext: calls.length ? Math.round(calls.reduce((a, b) => a + b, 0) / calls.length) : null,
    maxCallContext: calls.length ? Math.max(...calls) : null,
    isError: Boolean(step.json.is_error),
  };
}

/**
 * Sanity check: the main model's cumulative tokens must equal this step's tokens plus earlier steps'.
 * Catches cost/usage accounting mismatches like the cumulative-cost trap above.
 */
function costCheck(json, step) {
  const main = Object.values(json.modelUsage ?? {}).reduce((best, m) => ((m.cacheReadInputTokens ?? 0) > (best?.cacheReadInputTokens ?? -1) ? m : best), null);
  if (!main) return 'no modelUsage';
  const cumulativeRead = main.cacheReadInputTokens ?? 0;
  return cumulativeRead === step.cacheReadTokens ? 'usage covers this step only' : `modelUsage is cumulative (${cumulativeRead} vs ${step.cacheReadTokens} cache-read tokens)`;
}

async function setupRepo(task, dir) {
  // Every job has a new directory under a freshly created run root; never remove an existing path.
  fs.mkdirSync(dir);
  for (const [file, content] of Object.entries(task.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const git = async (...a) => {
    const r = await run('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: dir });
    if (r.code !== 0) throw new Error(`Git setup failed: ${r.stderr}`);
  };
  await git('init', '-q', '-b', 'main');
  await git('add', '-A');
  await git('commit', '-qm', 'task start');
}

async function hiddenScore(taskDir, dir, hiddenTest) {
  const target = path.join(dir, `__hidden__${path.extname(hiddenTest)}`);
  fs.copyFileSync(path.join(taskDir, hiddenTest), target);
  const r = await run(process.execPath, ['--test', target], { cwd: dir });
  fs.rmSync(target);
  const num = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0);
  const score = { passed: num('pass'), total: num('tests'), exitCode: r.code };
  if (!score.total) throw new Error(`Hidden tests produced no score: ${r.stderr}${r.stdout}`);
  return score;
}

async function runJob(bin, agent, scenario, root, task, taskDir, arm, rep, log) {
  const dir = path.join(root, `${agent}-${scenario}-${task.name}-${arm}-${rep}`);
  const env = { RELAYVORA_HOME: path.join(dir, '..', `.relayvora-home-${task.name}-${arm}-${rep}`) };
  await setupRepo(task, dir);
  const result = { task: task.name, agent, scenario, arm, rep, dir };

  log(`${task.name} ${arm} #${rep}: step A`);
  const a = await invokeAgent(bin, agent, dir, task.promptA);
  a.agent = agent;
  result.stepA = usageOf(a, callsInWindow(a.json.session_id, a.startedAt, a.endedAt, agent));
  result.contextAtHandoff = result.stepA.maxCallContext;

  log(`${task.name} ${arm} #${rep}: step B (${arm})`);
  let nextPrompt = task.promptB;
  if (arm === 'relay') {
    const t0 = Date.now();
    const cp = await relayvora(
      ['--json', 'checkpoint', 'create', '--from', agent, '--session', a.json.session_id, '--to', agent, '--goal', task.promptB, '--verify', 'auto'],
      dir,
      env,
    );
    if (cp.code !== 0) throw new Error(`checkpoint failed: ${cp.stdout}${cp.stderr}`);
    const checkpoint = JSON.parse(cp.stdout);
    const plan = JSON.parse((await relayvora(['--json', 'launch', checkpoint.id, '--dry-run'], dir, env)).stdout);
    result.relay = {
      checkpointId: checkpoint.id,
      handoffTokens: checkpoint.handoff.estimatedTokens,
      launchMode: plan.mode,
      repoFresh: plan.freshness.fresh,
      relayvoraMs: Date.now() - t0,
    };
    nextPrompt = plan.prompt;
  }
  if (scenario === 'cold') {
    log(`${task.name} ${agent} ${arm} #${rep}: waiting ${coldMinutes} minutes before step B`);
    const until = Date.now() + coldMinutes * 60_000;
    while (Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(30_000, until - Date.now())));
  }
  result.idleBeforeStepBMs = Date.now() - Date.parse(a.endedAt);
  const b = await invokeAgent(bin, agent, dir, nextPrompt, arm === 'normal' ? a.json.session_id : undefined);
  b.agent = agent;
  // Resumed (normal arm): the reported cost includes step A; the fresh relay session starts from zero.
  result.stepB = usageOf(b, callsInWindow(b.json.session_id, b.startedAt, b.endedAt, agent), arm === 'normal' ? (a.json.total_cost_usd ?? 0) : 0);
  result.stepB.costCheck = agent === 'codex' ? 'Codex reports per-turn usage; dollar cost unavailable' : costCheck(b.json, result.stepB);
  result.hidden = await hiddenScore(taskDir, dir, task.hiddenTest);
  result.totalCostUsd = sumKnown([result.stepA.costUsd, result.stepB.costUsd]);
  log(`${task.name} ${arm} #${rep}: done, B $${result.stepB.costUsd?.toFixed(3)}, hidden ${result.hidden.passed}/${result.hidden.total}`);
  return result;
}

async function pool(jobs, size) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          results.push(await job());
        } catch (error) {
          results.push({ error: String(error.message ?? error) });
        }
      }
    }),
  );
  return results;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (a, b) => (a === null || b === null || b === 0 ? null : (a - b) / b);

function summarize(results) {
  const out = {};
  const group = r => r.agent ? `${r.agent}/${r.scenario}/${r.task}` : r.task;
  for (const task of [...new Set(results.filter((r) => !r.error).map(group))]) {
    const arm = (name) => results.filter((r) => group(r) === task && r.arm === name && !r.error);
    const stat = (rows, f) => mean(rows.map(f).filter((v) => v !== null && v !== undefined));
    const side = (rows) => ({
      runs: rows.length,
      contextAtHandoff: stat(rows, (r) => r.contextAtHandoff),
      stepBCost: stat(rows, (r) => r.stepB.costUsd),
      stepBInput: stat(rows, (r) => r.stepB.inputTokens),
      stepBOutput: stat(rows, (r) => r.stepB.outputTokens),
      stepBCalls: stat(rows, (r) => r.stepB.calls),
      stepBAvgContext: stat(rows, (r) => r.stepB.avgCallContext),
      stepBSeconds: stat(rows, (r) => (r.stepB.durationMs ?? 0) / 1000),
      totalCost: stat(rows, (r) => r.totalCostUsd),
      hiddenPassRate: stat(rows, (r) => (r.hidden.total ? r.hidden.passed / r.hidden.total : 0)),
    });
    const normal = side(arm('normal'));
    const relay = side(arm('relay'));
    out[task] = {
      normal,
      relay,
      delta: {
        stepBCost: pct(relay.stepBCost, normal.stepBCost),
        stepBInput: pct(relay.stepBInput, normal.stepBInput),
        stepBAvgContext: pct(relay.stepBAvgContext, normal.stepBAvgContext),
        totalCost: pct(relay.totalCost, normal.totalCost),
      },
    };
  }
  return out;
}

function markdown(summary, meta) {
  const money = (v) => (v === null ? '?' : `$${v.toFixed(3)}`);
  const k = (v) => (v === null ? '?' : `${Math.round(v / 1000)}k`);
  const p = (v) => (v === null ? '?' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
  const lines = [`# Relayvora benchmark ${meta.startedAt}`, '', `Agents: ${meta.versions ? JSON.stringify(meta.versions) : `Claude Code ${meta.claudeVersion}`}. Reps per arm: ${meta.reps}.`, '', 'Unknown costs are shown as ?; cold runs record idle time and do not guarantee provider cache expiry.', ''];
  for (const [task, s] of Object.entries(summary)) {
    lines.push(
      `## ${task}`,
      '',
      '| | Normal (same session) | Relayvora (fresh session) | Relay vs normal |',
      '| --- | --- | --- | --- |',
      `| Context per call at handoff | ${k(s.normal.contextAtHandoff)} | ${k(s.relay.contextAtHandoff)} | |`,
      `| Step B cost | ${money(s.normal.stepBCost)} | ${money(s.relay.stepBCost)} | ${p(s.delta.stepBCost)} |`,
      `| Step B input tokens | ${k(s.normal.stepBInput)} | ${k(s.relay.stepBInput)} | ${p(s.delta.stepBInput)} |`,
      `| Step B avg context per call | ${k(s.normal.stepBAvgContext)} | ${k(s.relay.stepBAvgContext)} | ${p(s.delta.stepBAvgContext)} |`,
      `| Step B model calls | ${s.normal.stepBCalls?.toFixed(1)} | ${s.relay.stepBCalls?.toFixed(1)} | |`,
      `| Step B time | ${s.normal.stepBSeconds?.toFixed(0)}s | ${s.relay.stepBSeconds?.toFixed(0)}s | |`,
      `| Total cost (A + B) | ${money(s.normal.totalCost)} | ${money(s.relay.totalCost)} | ${p(s.delta.totalCost)} |`,
      `| Hidden tests passed | ${Math.round((s.normal.hiddenPassRate ?? 0) * 100)}% | ${Math.round((s.relay.hiddenPassRate ?? 0) * 100)}% | |`,
      '',
    );
  }
  return lines.join('\n');
}

/** Re-scores a saved results file (e.g. after an accounting fix) without spending anything. */
function rescore(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of data.results) {
    if (r.error || r.arm !== 'normal' || r.stepB.cumulativeCostUsd !== undefined) continue;
    // Files from before the fix stored the cumulative cost as step B's cost.
    r.stepB.cumulativeCostUsd = r.stepB.costUsd;
    r.stepB.costUsd = r.stepB.costUsd - r.stepA.costUsd;
    r.totalCostUsd = r.stepA.costUsd + r.stepB.costUsd;
  }
  data.summary = summarize(data.results);
  data.meta.rescoredAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const md = markdown(data.summary, data.meta);
  fs.writeFileSync(file.replace(/\.json$/, '.md'), md);
  process.stdout.write(`${md}\n`);
}

async function main() {
  if (args.help) {
    process.stdout.write('Usage: node packages/benchmarks/run.mjs [--tasks small-calculator,large-inventory,medium-csv] [--agents claude,codex] [--scenarios warm,cold] [--reps 3] [--concurrency 2] [--cold-minutes 65] [--run | --dry-run]\nDefault: preview only. --run spends real agent usage. --rescore <file.json> recalculates saved reports without agent calls.\n');
    return;
  }
  if (args.rescore) return rescore(path.resolve(args.rescore));
  const tasks = [];
  for (const name of taskNames) {
    const taskDir = path.join(here, 'tasks', name);
    const task = (await import(pathToFileURL(path.join(taskDir, 'task.mjs')).href)).default;
    if (!fs.existsSync(path.join(taskDir, task.hiddenTest))) throw new Error(`Missing hidden test for ${name}`);
    tasks.push({ task, taskDir });
  }
  const plannedRuns = taskNames.length * agents.length * scenarios.length * reps * 2;
  if (!args.run || args['dry-run']) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, tasks: taskNames, agents, scenarios, reps, concurrency, coldMinutes, plannedRuns, agentCallsMinimum: plannedRuns * 2, notice: 'Preview only. Pass --run to spend real agent usage.' }, null, 2)}\n`);
    return;
  }
  const bins = {};
  const versions = {};
  for (const agent of agents) {
    bins[agent] = await agentPath(agent);
    versions[agent] = (await run(bins[agent], ['--version'])).stdout.trim();
  }
  const startedAt = new Date().toISOString();
  const root = path.join(os.tmpdir(), 'relayvora-bench', startedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(root, { recursive: true });
  const log = (m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  log(`Agents ${JSON.stringify(versions)}; ${plannedRuns} runs; work dir ${root}`);

  const jobs = [];
  for (const { task, taskDir } of tasks) {
    for (const agent of agents) for (const scenario of scenarios) for (let rep = 1; rep <= reps; rep++) for (const arm of ['normal', 'relay']) {
      jobs.push(async () => {
        try { return await runJob(bins[agent], agent, scenario, root, task, taskDir, arm, rep, log); }
        catch (error) { return { task: task.name, agent, scenario, arm, rep, error: String(error.message ?? error) }; }
      });
    }
  }
  const results = await pool(jobs, concurrency);
  const summary = summarize(results);
  const meta = { startedAt, versions, reps, tasks: taskNames, scenarios, coldMinutes, concurrency };
  const stamp = startedAt.replace(/[:.]/g, '-');
  fs.mkdirSync(path.join(here, 'results'), { recursive: true });
  fs.writeFileSync(path.join(here, 'results', `${stamp}.json`), JSON.stringify({ meta, summary, results }, null, 2));
  const md = markdown(summary, meta);
  fs.writeFileSync(path.join(here, 'results', `${stamp}.md`), md);
  process.stdout.write(`${md}\n`);
  const errors = results.filter((r) => r.error);
  if (errors.length) process.stderr.write(`\n${errors.length} run(s) failed:\n${errors.map((e) => `- ${e.error}`).join('\n')}\n`);
  if (errors.length || results.some(r => !r.error && (r.hidden.exitCode !== 0 || r.hidden.passed !== r.hidden.total))) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
