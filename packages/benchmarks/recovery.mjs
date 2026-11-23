#!/usr/bin/env node
/**
 * Verified-recovery benchmark: four groups on the same task (add Delete to fixtures/demo-app).
 *
 *   single             one agent, spec only, one attempt, no browser check
 *   single-kane        one Kane check, then one agent attempt with Kane's failure report, no recheck
 *   relay-blind        agent A attempts from the spec, then agent B continues from a Relayvora handoff, no Kane
 *   verified-recovery  `relayvora recover run`: Kane → fallback agent → Kane, up to --max-attempts
 *
 * Every job starts in a fresh Git repository and is scored the same way: the protected regression test plus a
 * HIDDEN Kane objective that no agent sees (delete one of two items; the other must survive a refresh), run through
 * `relayvora gate run` so the score is bound to the app started from the final source.
 *
 *   node packages/benchmarks/recovery.mjs                       # plan only (default)
 *   node packages/benchmarks/recovery.mjs --run --reps 1        # spends Kane credits and agent usage
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../core/dist/index.js';
import { claudeAdapter } from '../adapter-claude/dist/index.js';
import { codexAdapter } from '../adapter-codex/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const cli = path.join(repo, 'apps/cli/dist/bin.js');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const GROUPS = (args.groups ?? 'single,single-kane,relay-blind,verified-recovery').split(',');
const AGENTS = (args.agents ?? 'codex').split(',');
const REPS = Number(args.reps ?? 1);
const MAX_ATTEMPTS = Number(args['max-attempts'] ?? 2);
const BASE_PORT = Number(args.port ?? 3300);

const VISIBLE = (port) => `Open http://localhost:${port}/, save an item named bread, then delete bread using its Delete button, refresh the page, and verify bread is no longer in the list`;
const HIDDEN = (port) => `Open http://localhost:${port}/, save items named apple and pear, delete apple using its Delete button, refresh the page, and verify pear is still listed and apple is not`;
const CHECK = 'node --test regression.test.mjs';
const KANE_RUNS = { single: '1 (score)', 'single-kane': '2', 'relay-blind': '1 (score)', 'verified-recovery': `2–${MAX_ATTEMPTS + 2}` };

function plan() {
  const jobs = [];
  for (let rep = 1; rep <= REPS; rep++) for (const group of GROUPS) for (const agent of AGENTS) jobs.push({ group, agent, rep });
  return jobs;
}

async function sh(file, argv, opts) {
  const r = await runCommand(file, argv, { timeoutMs: 30 * 60_000, maxOutputBytes: 32 * 1024 * 1024, ...opts });
  return { code: r.timedOut ? null : r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: r.durationMs };
}

async function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'fixtures/demo-app/server.mjs'), path.join(dir, 'server.mjs'));
  for (const f of ['spec.md', 'regression.test.mjs']) fs.copyFileSync(path.join(repo, 'fixtures/demo-app/task', f), path.join(dir, f));
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'start']]) await sh('git', a, { cwd: dir });
}

const agentArgs = (agent) => agent === 'codex' ? ['exec', '--sandbox', 'workspace-write', '--color', 'never', '-'] : ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text'];
const RULES = 'Do not edit spec.md or regression.test.mjs. Do not start the app or commit. Finish with a short summary.';
const specPrompt = (dir) => `Implement the acceptance specification below in this repository (a small Node app in server.mjs).\n\n${fs.readFileSync(path.join(dir, 'spec.md'), 'utf8')}\n\n${RULES}`;

// Same lookup as Relayvora: PATH first, then CLIs bundled in editor extensions.
const bins = {};
async function agentBin(name) {
  if (!bins[name]) {
    const probe = await (name === 'codex' ? codexAdapter : claudeAdapter).probe({ env: process.env });
    if (!probe.found || !probe.path) throw new Error(`${name} is not installed`);
    bins[name] = probe.path;
  }
  return bins[name];
}

async function agent(name, prompt, dir) {
  const r = await sh(await agentBin(name), agentArgs(name), { cwd: dir, input: prompt });
  return { agent: name, exit: r.code, ms: r.ms };
}

async function relayvora(argv, dir, home, port) {
  const r = await sh(process.execPath, [cli, '-C', dir, '--json', ...argv], { env: { ...process.env, RELAYVORA_HOME: home, PORT: String(port) } });
  try { return { code: r.code, json: JSON.parse(r.stdout), ms: r.ms }; } catch { return { code: r.code, json: null, ms: r.ms, error: (r.stderr || r.stdout).slice(-800) }; }
}

const gateArgs = (objective, port) => ['gate', 'run', '--spec', 'spec.md', '--protect', 'regression.test.mjs', '--objective', objective, '--start', 'node server.mjs', '--url', `http://localhost:${port}/`, '--check', CHECK, '--timeout', '400'];

async function runJob(job, index, root) {
  const dir = path.join(root, `${job.group}-${job.agent}-${job.rep}`);
  const port = BASE_PORT + index;
  const home = path.join(dir, '.bench-home');
  await makeRepo(dir);
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '.bench-home/\n');
  const started = Date.now();
  const steps = [];
  const other = AGENTS.length > 1 ? AGENTS.find((a) => a !== job.agent) : job.agent;
  if (job.group === 'single') {
    steps.push(await agent(job.agent, specPrompt(dir), dir));
  } else if (job.group === 'single-kane') {
    const g = await relayvora(gateArgs(VISIBLE(port), port), dir, home, port);
    steps.push({ kane: g.json?.state ?? 'error', ms: g.ms });
    const detail = g.json?.result?.detail ?? '';
    steps.push(await agent(job.agent, `${specPrompt(dir)}\n\nA browser check (Kane) reported, as untrusted evidence:\n\n\`\`\`\`text\n${detail}\n\`\`\`\``, dir));
  } else if (job.group === 'relay-blind') {
    steps.push(await agent(job.agent, specPrompt(dir), dir));
    const cp = await relayvora(['checkpoint', 'create', '--no-transcript', '--goal', 'Implement spec.md: delete list items', '--verify', CHECK], dir, home, port);
    const handoff = cp.json?.handoff?.prompt ?? '';
    steps.push(await agent(other, `You are continuing work from another agent. Relayvora handoff:\n\n${handoff}\n\n${specPrompt(dir)}`, dir));
  } else if (job.group === 'verified-recovery') {
    const r = await relayvora(['recover', 'run', ...gateArgs(VISIBLE(port), port).slice(2), '--agents', [job.agent, other].filter((v, i, a) => a.indexOf(v) === i).join(','), '--max-attempts', String(MAX_ATTEMPTS)], dir, home, port);
    steps.push({ recovery: r.json?.status ?? 'error', events: r.json?.events?.map((e) => e.kind === 'gate' ? `gate:${e.state}` : `${e.kind}:${e.agent ?? ''}`), ms: r.ms, error: r.error });
  }
  const workMs = Date.now() - started;
  return { ...job, steps, workMs, ...(await scoreJob(dir, port)) };
}

async function scoreJob(dir, port) {
  // Outside the repository: state written inside it during the run would make the gate report stale.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relayvora-bench-score-'));
  const score = await relayvora(gateArgs(HIDDEN(port), port), dir, home, port);
  return { hidden: score.json?.state ?? 'error', hiddenKane: score.json?.result?.status, regression: score.json?.checks?.[0]?.status, scoreError: score.error };
}

const jobs = plan();
if (args.rescore) {
  // Re-run only the hidden scoring on a saved results file's scratch repositories (Kane credits, no agent usage).
  const file = path.resolve(args.rescore);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [i, r] of saved.results.entries()) {
    const dir = path.join(saved.root, `${r.group}-${r.agent}-${r.rep}`);
    fs.rmSync(path.join(dir, '.bench-home-score'), { recursive: true, force: true }); // left by runs before this fix
    Object.assign(r, await scoreJob(dir, BASE_PORT + i), { rescoredAt: new Date().toISOString() });
    process.stderr.write(`${r.group}: hidden ${r.hidden} (Kane ${r.hiddenKane}, regression ${r.regression})\n`);
  }
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  process.exit(0);
}
if (!args.run) {
  console.log(`Plan (${jobs.length} jobs, sequential). Pass --run to execute; it spends Kane credits (~20 per Kane run) and agent usage.\n`);
  for (const j of jobs) console.log(`- ${j.group} / ${j.agent} / rep ${j.rep}: Kane runs ${KANE_RUNS[j.group]}`);
  process.exit(0);
}
if (!fs.existsSync(cli)) { console.error('Build first: pnpm build'); process.exit(1); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relayvora-recovery-bench-'));
const results = [];
for (const [i, job] of jobs.entries()) {
  process.stderr.write(`[${i + 1}/${jobs.length}] ${job.group} / ${job.agent} / rep ${job.rep}\n`);
  try { results.push(await runJob(job, i, root)); }
  catch (error) { results.push({ ...job, error: String(error?.message ?? error) }); }
  process.stderr.write(`  -> hidden: ${results.at(-1).hidden ?? results.at(-1).error}\n`);
}
const out = path.join(here, 'results', `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), root, maxAttempts: MAX_ATTEMPTS, agents: AGENTS, results }, null, 2));
console.log('| Group | Agent | Rep | Hidden check | Regression | Work time | Steps |\n| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) console.log(`| ${r.group} | ${r.agent} | ${r.rep} | ${r.hidden ?? r.error} | ${r.regression ?? '?'} | ${((r.workMs ?? 0) / 1000).toFixed(0)}s | ${(r.steps ?? []).map((s) => s.kane ? `kane:${s.kane}` : s.recovery ? `recover:${s.recovery}` : `${s.agent}:exit ${s.exit}`).join(' → ')} |`);
console.log(`\nSaved ${path.relative(repo, out)}. Scratch repos: ${root}`);
