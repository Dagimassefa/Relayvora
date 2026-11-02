import path from 'node:path';
import { RELAYVORA_VERSION, RelayvoraError, ExitCode, type Checkpoint } from '@relayvora/core';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ZodError } from 'zod';
import { type CreateCheckpointOptions, type CreateCheckpointResult, createCheckpoint, loadCheckpoint } from './checkpoint-service.js';
import {
  renderCheckpointList,
  renderSummary,
  runCheckpointList,
  runCheckpointShow,
  summarize,
} from './commands/checkpoint.js';
import { renderConfig, runConfigShow } from './commands/config.js';
import { renderCleanup, runCleanup, type CleanupOptions } from './commands/cleanup.js';
import { renderDoctor, runDoctor } from './commands/doctor.js';
import { type ExportOptions, runExport } from './commands/export.js';
import { renderHome, runHome } from './commands/home.js';
import { type ImportOptions, renderImport, runImport } from './commands/import.js';
import { renderInbox, renderSend, renderSync, runInbox, runSend, runSync, type SendFlags, type ShareFlags } from './commands/share.js';
import { renderInit, runInit } from './commands/init.js';
import { renderReport, runReport } from './commands/report.js';
import { runWatch } from './commands/watch.js';
import { renderHooksInstall, renderHooksStatus, runHooksInstall, runHooksStatus, runHooksUninstall, type HooksFlags } from './commands/hooks.js';
import { handleHookEvent, logHookProblem, parseClaudeHook, parseCodexNotify, parseOpenCodeEvent, spawnHookWorker, type HookEvent } from './hooks.js';
import { renderSessions, runSessions } from './commands/sessions.js';
import { copyToClipboard } from './clipboard.js';
import { type CliContext, createContext, otherAgent, selectAdapters } from './context.js';
import { executeLaunch, planLaunch } from './launch.js';
import { emit } from './output.js';
import { banner, label, providerChip, rule, statusIcon } from './ui/components.js';
import { highlightMarkdown } from './ui/markdown.js';
import { terminalProgress } from './ui/progress.js';
import { PLAIN, createTheme, type Theme } from './ui/theme.js';

interface GlobalOptions {
  json?: boolean;
  cwd?: string;
  verbose?: boolean;
  color?: boolean;
}

/** Themes for each output stream; either can be a terminal while the other is piped. */
export interface Ui {
  out: Theme;
  err: Theme;
}

const PLAIN_UI: Ui = { out: PLAIN, err: PLAIN };

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== value.trim()) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return n;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Task and evidence options shared by `checkpoint create` and `handoff`. */
function addCheckpointOptions(cmd: Command): Command {
  return cmd
    .option('--from <provider>', 'use the latest session of this provider for this project (claude, codex, opencode)')
    .option('--session <id>', 'use this session id (or a unique prefix)')
    .option('--goal <text>', 'what the work is trying to achieve (default: inferred from the session)')
    .option('--constraint <text>', 'a hard constraint; repeatable', collect)
    .option('--done <text>', 'something already completed; repeatable', collect)
    .option('--pending <text>', 'remaining work; repeatable', collect)
    .option('--blocker <text>', 'a known blocker; repeatable', collect)
    .option('--decision <text>', 'a decision already made; repeatable', collect)
    .option('--verify <command>', 'run a command (no shell) and record its exit code; "auto" runs the project typecheck/lint/test scripts; repeatable', collect)
    .option('--verify-timeout <seconds>', 'timeout per verification command', parsePositiveInt, 600)
    .option('--budget <tokens>', 'token budget for the handoff text (estimated tokens)', parsePositiveInt)
    .option('--no-transcript', 'do not read the session transcript')
    .option('--copy', 'copy the handoff to the clipboard, ready to paste into the agent panel')
    .option('--commits-since <when>', 'include your commits since then ("2h", "1d", a date); default: the session start')
    .option('--no-commits', 'do not include commits made during the session');
}

interface CheckpointFlags {
  from?: string;
  session?: string;
  to?: string;
  goal?: string;
  constraint?: string[];
  done?: string[];
  pending?: string[];
  blocker?: string[];
  decision?: string[];
  verify?: string[];
  verifyTimeout: number;
  budget?: number;
  transcript: boolean;
  copy?: boolean;
  commits: boolean;
  commitsSince?: string;
}

function toCreateOptions(flags: CheckpointFlags, opts: GlobalOptions, ui: Ui): CreateCheckpointOptions {
  const o: CreateCheckpointOptions = {
    constraints: flags.constraint ?? [],
    completed: flags.done ?? [],
    pending: flags.pending ?? [],
    blockers: flags.blocker ?? [],
    decisions: flags.decision ?? [],
    verify: flags.verify ?? [],
    verifyTimeoutSec: flags.verifyTimeout,
    transcript: flags.transcript,
  };
  if (flags.from) o.from = flags.from;
  if (flags.session) o.session = flags.session;
  if (flags.to) o.to = flags.to;
  if (flags.goal) o.goal = flags.goal;
  if (flags.budget !== undefined) o.budget = flags.budget;
  o.commits = flags.commits;
  if (flags.commitsSince) o.commitsSince = flags.commitsSince;
  if (!opts.json) o.progress = terminalProgress(ui.err, process.stderr);
  return o;
}

/** Copies the handoff when --copy is set. A clipboard failure is a warning: the checkpoint is already saved. */
async function maybeCopy(flags: CheckpointFlags, result: CreateCheckpointResult, ui: Ui, json: boolean): Promise<boolean> {
  if (!flags.copy) return false;
  try {
    await copyToClipboard(result.checkpoint.handoff.prompt ?? '');
    return true;
  } catch (error) {
    if (!json) process.stderr.write(`  ${ui.err.fg('amber', ui.err.sym.warn)} ${ui.err.fg('amber', (error as Error).message)}
`);
    return false;
  }
}

interface LaunchFlags {
  yes?: boolean;
  dryRun?: boolean;
}

/** Shows the launch plan, asks, launches, and reports when the agent exits. */
async function launchWithUi(ctx: CliContext, cp: Checkpoint, target: string | null, flags: LaunchFlags, ui: Ui): Promise<void> {
  const t = ui.err;
  const plan = await planLaunch(ctx, cp, target);
  const where = plan.source === 'editor-extension' ? `${plan.editor} extension build` : 'on PATH';
  const version = plan.version ? ` ${plan.version.replace(/\s*\([^)]*\)\s*$/, '')}` : '';
  process.stderr.write(
    [
      `  ${rule(t, `${t.sym.bolt} LAUNCH`, 'lime', Math.min(t.width, 78) - 2)}`,
      '',
      `  ${label(t, 'agent')}${providerChip(t, plan.target)} ${t.bold(`${plan.displayName}${version}`)} ${t.dim(`(${where})`)}`,
      `  ${label(t, 'in')}${t.fg('cyan', plan.cwd)}`,
      `  ${label(t, 'repo')}${
        !plan.freshness.checked
          ? t.dim('not a Git repository; not re-checked')
          : plan.freshness.fresh
            ? `${statusIcon(t, 'ok')} ${t.dim('unchanged since the checkpoint (the agent is told it can skip re-checking)')}`
            : `${statusIcon(t, 'warn')} ${t.fg('amber', `changed since the checkpoint: ${plan.freshness.differences.slice(0, 3).join('; ')}`)}`
      }`,
      `  ${label(t, 'sends')}${
        plan.mode === 'inline'
          ? `${t.bold('the handoff itself')} ${t.dim(`(${plan.prompt.length.toLocaleString('en-US')} chars, no file read needed)`)}`
          : t.fg('orange', plan.prompt)
      }`,
      '',
      '',
    ].join('\n'),
  );
  if (flags.dryRun) {
    // The inlined handoff would flood the screen; show its size instead (the full text is in the file and in --json).
    const shown = plan.args.map((a) => (a === plan.prompt && plan.mode === 'inline' ? `<handoff, ${a.length.toLocaleString('en-US')} chars>` : JSON.stringify(a)));
    process.stderr.write(`  ${statusIcon(t, 'info')} ${t.dim('dry run, nothing launched:')} ${plan.executable} ${shown.join(' ')}\n\n`);
    return;
  }
  const result = await executeLaunch(ctx, plan, flags.yes === undefined ? {} : { yes: flags.yes });
  const ok = result.exitCode === 0 || result.exitCode === null;
  process.stderr.write(
    `\n  ${statusIcon(t, ok ? 'ok' : 'warn')} ${t.bold(`back from ${plan.displayName}`)} ${t.dim(`(exit ${result.exitCode ?? 'signal'})`)}  ${t.dim(`relay again: relayvora handoff --from ${plan.target} --to ${otherAgent(plan.target)}`)}\n\n`,
  );
}

/** Reads stdin to the end, giving up after a few seconds so a hook can never hang. */
function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function styleHelp(program: Command, t: Theme): void {
  program.configureHelp({
    styleTitle: (s) => t.bold(t.fg('violet', s)),
    styleCommandText: (s) => t.bold(t.fg('cyan', s)),
    styleSubcommandText: (s) => t.fg('cyan', s),
    styleOptionText: (s) => t.fg('magenta', s),
    styleArgumentText: (s) => t.fg('amber', s),
    styleDescriptionText: (s) => t.dim(s),
  });
}

export function buildProgram(ui: Ui = PLAIN_UI): Command {
  const program = new Command()
    .name('relayvora')
    .description('Move unfinished work between AI coding agents with compact, evidence-backed checkpoints.')
    .version(RELAYVORA_VERSION, '-V, --version')
    .option('--json', 'machine-readable JSON output')
    .option('-C, --cwd <dir>', 'run as if started in <dir>')
    .option('-v, --verbose', 'show extra detail and warnings')
    .option('--no-color', 'plain output without colours (also: NO_COLOR=1)')
    .showHelpAfterError()
    .exitOverride();
  styleHelp(program, ui.out);
  program.addHelpText('beforeAll', () => (ui.out.level > 0 ? banner(ui.out, RELAYVORA_VERSION) : ''));

  const ctxFor = (cmd: Command) => {
    const opts = cmd.optsWithGlobals<GlobalOptions>();
    return { opts, ctx: createContext(opts.cwd ? { cwd: opts.cwd } : {}) };
  };

  // Bare `relayvora`: the home screen.
  program.action(async (_options, cmd: Command) => {
    const { opts, ctx } = ctxFor(cmd);
    emit(opts, await runHome(ctx), (h) => renderHome(h, ui.out));
  });

  program
    .command('init')
    .description('register the current project and create .relayvora/ (ignored by Git)')
    .action(async (_options, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runInit(ctx), (r) => renderInit(r, ui.out));
    });

  program
    .command('doctor')
    .description('check platform, Git, local store and installed agents')
    .action(async (_options, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const report = await runDoctor(ctx);
      emit(opts, report, (r) => renderDoctor(r, ui.out));
      if (!report.ok) process.exitCode = ExitCode.PreconditionFailed;
    });

  program
    .command('sessions')
    .description('list local agent sessions for this project (read-only)')
    .option('-p, --provider <id>', 'only this provider (claude, codex, opencode)')
    .option('-a, --all', 'include sessions from every directory, not just this project')
    .option('-n, --limit <n>', 'max sessions per provider', parsePositiveInt, 20)
    .action(async (options: { provider?: string; all?: boolean; limit: number }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const result = await runSessions(ctx, options);
      emit(opts, result, (r) => renderSessions(r, opts.verbose, ui.out));
    });

  const checkpoint = program.command('checkpoint').description('create and inspect checkpoints');

  checkpoint.command('delete <id>')
    .description('delete a checkpoint in this project, its handoff, evidence and usage')
    .option('--dry-run', 'preview without deleting')
    .option('-y, --yes', 'delete without asking')
    .action(async (id: string, flags: CleanupOptions, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runCleanup(ctx, id, flags), renderCleanup);
    });

  checkpoint.command('prune')
    .description('delete expired checkpoints in this project using its retention setting')
    .option('--days <days>', 'override the configured retention age', parsePositiveInt)
    .option('--dry-run', 'preview without deleting')
    .option('-y, --yes', 'delete without asking')
    .action(async (flags: CleanupOptions, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runCleanup(ctx, null, flags), renderCleanup);
    });

  addCheckpointOptions(
    checkpoint
      .command('create')
      .description('capture task state, Git evidence and verification results into a checkpoint')
      .option('--to <provider>', 'provider that will receive the handoff'),
  ).action(async (flags: CheckpointFlags, cmd: Command) => {
    const { opts, ctx } = ctxFor(cmd);
    const result = await createCheckpoint(ctx, toCreateOptions(flags, opts, ui));
    const copied = await maybeCopy(flags, result, ui, Boolean(opts.json));
    emit(opts, summarize(result, copied), (s) => renderSummary(s, ui.out));
  });

  checkpoint
    .command('list')
    .description('list checkpoints for this project, newest first')
    .option('-n, --limit <n>', 'max checkpoints', parsePositiveInt, 20)
    .action(async (options: { limit: number }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runCheckpointList(ctx, options.limit), (r) => renderCheckpointList(r, ui.out));
    });

  checkpoint
    .command('show <id>')
    .description('print a checkpoint handoff (Markdown) or the full checkpoint (--format json)')
    .addOption(new Option('--format <format>', 'output format').choices(['markdown', 'json']).default('markdown'))
    .option('--budget <tokens>', 're-render the handoff with a different token budget', parsePositiveInt)
    .action(async (id: string, options: { format: 'markdown' | 'json'; budget?: number }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const { checkpoint: cp, markdown } = await runCheckpointShow(ctx, id, options);
      if (opts.json || options.format === 'json') process.stdout.write(`${JSON.stringify(cp, null, 2)}\n`);
      else process.stdout.write(highlightMarkdown(markdown, ui.out));
    });

  program
    .command('export [id]')
    .description('export a checkpoint (default: the latest here) as Markdown, or as JSON to import on another machine; always re-redacted')
    .addOption(new Option('--format <format>', 'output format (default: json for a .json file, else markdown)').choices(['markdown', 'json']))
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .option('--with-changes', 'JSON: also carry your uncommitted changes as a patch (sensitive files left out)')
    .option('--force', 'overwrite an existing file')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (id: string | undefined, options: ExportOptions, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const result = await runExport(ctx, id, options);
      const t = ui.err;
      if (opts.json) {
        const { content, ...meta } = result;
        emit(opts, result.out ? meta : result, () => '');
      } else if (result.out) {
        const carried = result.changedFiles.length ? `, changes to ${result.changedFiles.length} file(s)` : '';
        process.stderr.write(
          `  ${statusIcon(t, 'ok')} Exported ${t.bold(result.checkpointId)} ${t.dim(`(${result.format}, ~${result.estimatedTokens} tok${result.editedHandoff ? ', your edits' : ''}${carried})`)} ${t.fg('cyan', t.sym.arrow)} ${t.bold(result.out)}\n`,
        );
        if (result.format === 'json') process.stderr.write(`  ${t.dim('On the other machine, in the project:')} ${t.bold(`relayvora import ${path.basename(result.out)}`)}\n`);
      } else {
        process.stdout.write(result.content);
      }
      if (!opts.json) for (const n of result.notes) process.stderr.write(`  ${statusIcon(t, 'warn')} ${t.fg('amber', n)}\n`);
    });

  program
    .command('import <file-or-id>')
    .description('import a checkpoint exported on another machine, or shared on the relayvora/handoffs branch, ready to launch')
    .option('--apply-changes', 'also apply the uncommitted changes it carries (needs the same commit checked out)')
    .option('--force', 'replace a checkpoint with the same id imported earlier')
    .option('--remote <name>', 'remote holding the shared branch', 'origin')
    .action(async (file: string, options: ImportOptions, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runImport(ctx, file, options), (r) => renderImport(r, ui.out));
    });

  // Sharing through the repository itself: the Git host's login is the account.
  program
    .command('sync')
    .description('share the checkpoints of this project through the relayvora/handoffs branch, and get those from your other devices')
    .option('--remote <name>', 'remote to sync with', 'origin')
    .option('-y, --yes', 'share without asking')
    .action(async (flags: ShareFlags, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runSync(ctx, flags), (r) => renderSync(r, ui.out));
    });

  program
    .command('send [id]')
    .description('send a checkpoint (default: the latest) to people by their Git email; it shows up in their inbox')
    .requiredOption('--to <email>', 'recipient; repeatable', collect)
    .option('--with-changes', 'also carry your uncommitted changes (sensitive files left out)')
    .option('--note <text>', 'a short message for the recipient')
    .option('--remote <name>', 'remote to send through', 'origin')
    .option('-y, --yes', 'send without asking')
    .action(async (id: string | undefined, flags: SendFlags, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runSend(ctx, id, flags), (r) => renderSend(r, ui.out));
    });

  program
    .command('inbox')
    .description('checkpoints sent to you in this repository (by your Git email), ready to launch')
    .option('--sent', 'show what you sent instead')
    .option('--remote <name>', 'remote to check', 'origin')
    .action(async (flags: ShareFlags & { sent?: boolean }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runInbox(ctx, flags), (r) => renderInbox(r, ui.out));
    });

  addCheckpointOptions(
    program
      .command('handoff')
      .description('build a checkpoint and preview the handoff for another agent')
      .requiredOption('--to <provider>', 'provider that will receive the handoff (claude, codex, opencode)')
      .option('--preview', 'show the handoff without launching anything (default)')
      .option('--confirm', 'launch the target agent in this terminal with the handoff (asks first)')
      .option('-y, --yes', 'with --confirm: launch without asking')
      .option('--dry-run', 'with --confirm: show what would be launched, without launching')
      .option('--print', 'print the full handoff text in the terminal (always printed when output is piped)'),
  ).action(async (flags: CheckpointFlags & LaunchFlags & { confirm?: boolean; print?: boolean }, cmd: Command) => {
    const { opts, ctx } = ctxFor(cmd);
    if (flags.confirm && opts.json && !flags.dryRun) {
      throw new RelayvoraError('--json cannot be combined with launching an agent; use --dry-run, or drop --json.', ExitCode.Usage);
    }
    if (flags.confirm) selectAdapters(ctx, flags.to); // fail on an unknown agent before doing any work
    const result = await createCheckpoint(ctx, toCreateOptions(flags, opts, ui));
    const copied = await maybeCopy(flags, result, ui, Boolean(opts.json));
    if (opts.json) {
      const plan = flags.confirm ? await planLaunch(ctx, result.checkpoint, flags.to ?? null) : undefined;
      emit(opts, { ...summarize(result, copied), markdown: result.checkpoint.handoff.prompt, ...(plan ? { launch: plan } : {}) }, () => '');
      return;
    }
    // Piped or redirected: the handoff text goes to stdout so `> handoff.md` works. On a terminal the
    // full text (every diff) would bury the card, so it is shown only with --print.
    if (!flags.confirm && (flags.print || !process.stdout.isTTY)) {
      process.stdout.write(highlightMarkdown(result.checkpoint.handoff.prompt ?? '', ui.out));
    }
    process.stderr.write(`${renderSummary(summarize(result, copied), ui.err, Boolean(flags.confirm))}\n`);
    if (flags.confirm) await launchWithUi(ctx, result.checkpoint, flags.to ?? null, flags, ui);
  });

  program
    .command('launch <checkpoint>')
    .description('start the target agent in this terminal with an existing handoff (asks first)')
    .option('--to <provider>', 'agent to launch (default: the checkpoint target)')
    .option('-y, --yes', 'launch without asking')
    .option('--dry-run', 'show what would be launched, without launching')
    .action(async (id: string, flags: LaunchFlags & { to?: string }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      if (opts.json && !flags.dryRun) {
        throw new RelayvoraError('--json cannot be combined with launching an agent; use --dry-run, or drop --json.', ExitCode.Usage);
      }
      const cp = await loadCheckpoint(ctx, id);
      if (opts.json) {
        emit(opts, await planLaunch(ctx, cp, flags.to ?? null), () => '');
        return;
      }
      await launchWithUi(ctx, cp, flags.to ?? null, flags, ui);
    });

  program
    .command('report [checkpoint]')
    .description('measure a relay: the session that continued it, context per turn, and check results')
    .option('--reverify', "re-run the checkpoint's verification commands now")
    .action(async (id: string | undefined, flags: { reverify?: boolean }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const report = await runReport(ctx, id, {
        ...(flags.reverify ? { reverify: true } : {}),
        ...(opts.json ? {} : { progress: terminalProgress(ui.err, process.stderr) }),
      });
      emit(opts, report, (r) => renderReport(r, ui.out));
    });

  program
    .command('watch')
    .description('alert the moment a relay pays off: an agent hits or nears its limit, or a large session goes cold')
    .option('-i, --interval <seconds>', 'seconds between checks', parsePositiveInt, 60)
    .option('--once', 'check once and exit')
    .option('--bell', 'ring the terminal bell on each alert')
    .action(async (flags: { interval: number; once?: boolean; bell?: boolean }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const stop = new AbortController();
      const onSigint = () => stop.abort();
      process.on('SIGINT', onSigint);
      try {
        await runWatch(ctx, ui.out, {
          intervalSeconds: flags.interval,
          signal: stop.signal,
          ...(flags.once ? { once: true } : {}),
          ...(flags.bell ? { bell: true } : {}),
          ...(opts.json ? { json: true } : {}),
        });
      } finally {
        process.off('SIGINT', onSigint);
      }
    });

  const hooks = program.command('hooks').description('save checkpoints automatically from agent hooks (limit hit, compaction, session end, turns)');
  const hookOptions = (cmd: Command) =>
    cmd
      .addOption(new Option('--agent <agent>', 'which agent').choices(['claude', 'codex', 'opencode', 'all']).default('all'))
      .addOption(new Option('--scope <scope>', 'Claude Code and OpenCode: this project (local, not committed) or your user').choices(['local', 'user']).default('local'))
      .option('--dry-run', 'show what would change without writing');
  hookOptions(hooks.command('install').description('install the hooks'))
    .option('--every <minutes>', 'minimum minutes between end-of-turn checkpoints', parsePositiveInt, 15)
    .option('--keep <n>', 'automatic checkpoints kept per session', parsePositiveInt, 5)
    .option('--verify', 'also run the project checks (slower)')
    .action(async (flags: HooksFlags, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runHooksInstall(ctx, flags), (r) => renderHooksInstall(r, ui.out));
    });
  hooks
    .command('status')
    .description('show where Relayvora hooks are installed')
    .action(async (_o, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runHooksStatus(ctx), (r) => renderHooksStatus(r, ui.out));
    });
  hookOptions(hooks.command('uninstall').description('remove the hooks, leaving any other hooks untouched')).action(async (flags: HooksFlags, cmd: Command) => {
    const { opts, ctx } = ctxFor(cmd);
    const r = await runHooksUninstall(ctx, flags);
    emit(opts, r, () => (r.removed.length ? r.removed.map((f) => `  ${statusIcon(ui.out, 'ok')} removed from ${f}`).join('\n') : '  nothing to remove'));
  });

  // Called by the agents' hooks: parse the event, start a background checkpoint, return at once.
  program
    .command('hook <agent> [payload]', { hidden: true })
    .option('--every <minutes>', '', parsePositiveInt, 15)
    .option('--keep <n>', '', parsePositiveInt, 5)
    .option('--verify')
    .action(async (agent: string, payload: string | undefined, flags: { every: number; keep: number; verify?: boolean }, cmd: Command) => {
      const { ctx } = ctxFor(cmd);
      try {
        const event =
          agent === 'claude' ? parseClaudeHook(await readStdin())
          : agent === 'codex' ? parseCodexNotify(payload ?? '')
          : agent === 'opencode' ? parseOpenCodeEvent(payload ?? '')
          : null;
        if (event) spawnHookWorker(event, { everyMinutes: flags.every, keep: flags.keep, verify: Boolean(flags.verify) });
      } catch (error) {
        logHookProblem(ctx.dataDir, `hook ${agent}: ${(error as Error).message}`);
      }
    });
  program
    .command('hook-run', { hidden: true })
    .requiredOption('--event <json>')
    .option('--every <minutes>', '', parsePositiveInt, 15)
    .option('--keep <n>', '', parsePositiveInt, 5)
    .option('--verify')
    .action(async (flags: { event: string; every: number; keep: number; verify?: boolean }, cmd: Command) => {
      const { ctx } = ctxFor(cmd);
      try {
        const r = await handleHookEvent(ctx, JSON.parse(flags.event) as HookEvent, { everyMinutes: flags.every, keep: flags.keep, verify: Boolean(flags.verify) });
        if (r.action === 'created') logHookProblem(ctx.dataDir, `ok ${r.reason} -> ${r.checkpointId}${r.pruned?.length ? ` (pruned ${r.pruned.length})` : ''}`);
      } catch (error) {
        logHookProblem(ctx.dataDir, `hook-run: ${(error as Error).message}`);
      }
    });

  const config = program.command('config').description('inspect configuration');
  config
    .command('show', { isDefault: true })
    .description('show resolved paths and project configuration')
    .action(async (_options, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      emit(opts, await runConfigShow(ctx), (r) => renderConfig(r, ui.out));
    });

  return program;
}

function reportError(message: string, code: ExitCode, json: boolean, t: Theme): ExitCode {
  if (json) {
    process.stdout.write(`${JSON.stringify({ error: { message, exitCode: code } }, null, 2)}\n`);
  } else {
    const hint = code === ExitCode.Usage ? `\n  ${t.dim('run relayvora --help for usage')}` : '';
    process.stderr.write(`\n  ${t.fg('red', t.sym.fail)} ${t.bold(t.fg('red', 'error'))} ${message}${hint}\n\n`);
  }
  return code;
}

/** Runs the CLI and returns the process exit code instead of exiting, so it can be tested in-process. */
export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const color = !json && !argv.includes('--no-color');
  const ui: Ui = {
    out: createTheme(process.stdout, { color }),
    err: createTheme(process.stderr, { color }),
  };
  const program = buildProgram(ui);
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : ExitCode.Ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are reported as "errors" under exitOverride; commander already printed them.
      return error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
    }
    if (error instanceof RelayvoraError) return reportError(error.message, error.exitCode, json, ui.err);
    if (error instanceof ZodError) {
      const detail = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return reportError(`Invalid data: ${detail}`, ExitCode.Failure, json, ui.err);
    }
    const message = error instanceof Error ? (process.env.RELAYVORA_DEBUG ? error.stack ?? error.message : error.message) : String(error);
    return reportError(message, ExitCode.Failure, json, ui.err);
  }
}
