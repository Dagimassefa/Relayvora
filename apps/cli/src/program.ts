import { AGENTRELAY_VERSION, AgentRelayError, ExitCode } from '@agentrelay/core';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ZodError } from 'zod';
import { type CreateCheckpointOptions, type CreateCheckpointResult, createCheckpoint } from './checkpoint-service.js';
import {
  renderCheckpointList,
  renderSummary,
  runCheckpointList,
  runCheckpointShow,
  summarize,
} from './commands/checkpoint.js';
import { renderConfig, runConfigShow } from './commands/config.js';
import { renderDoctor, runDoctor } from './commands/doctor.js';
import { type ExportOptions, runExport } from './commands/export.js';
import { renderHome, runHome } from './commands/home.js';
import { renderInit, runInit } from './commands/init.js';
import { renderSessions, runSessions } from './commands/sessions.js';
import { copyToClipboard } from './clipboard.js';
import { createContext } from './context.js';
import { emit } from './output.js';
import { banner, statusIcon } from './ui/components.js';
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
    .option('--from <provider>', 'use the latest session of this provider for this project (claude, codex)')
    .option('--session <id>', 'use this session id (or a unique prefix)')
    .option('--goal <text>', 'what the work is trying to achieve (default: inferred from the session)')
    .option('--constraint <text>', 'a hard constraint; repeatable', collect)
    .option('--done <text>', 'something already completed; repeatable', collect)
    .option('--pending <text>', 'remaining work; repeatable', collect)
    .option('--blocker <text>', 'a known blocker; repeatable', collect)
    .option('--decision <text>', 'a decision already made; repeatable', collect)
    .option('--verify <command>', 'run a command (no shell) and record its exit code as evidence; repeatable', collect)
    .option('--verify-timeout <seconds>', 'timeout per verification command', parsePositiveInt, 600)
    .option('--budget <tokens>', 'token budget for the handoff text (estimated tokens)', parsePositiveInt)
    .option('--no-transcript', 'do not read the session transcript')
    .option('--copy', 'copy the handoff to the clipboard, ready to paste into the agent panel');
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
    .name('agentrelay')
    .description('Move unfinished work between AI coding agents with compact, evidence-backed checkpoints.')
    .version(AGENTRELAY_VERSION, '-V, --version')
    .option('--json', 'machine-readable JSON output')
    .option('-C, --cwd <dir>', 'run as if started in <dir>')
    .option('-v, --verbose', 'show extra detail and warnings')
    .option('--no-color', 'plain output without colours (also: NO_COLOR=1)')
    .showHelpAfterError()
    .exitOverride();
  styleHelp(program, ui.out);
  program.addHelpText('beforeAll', () => (ui.out.level > 0 ? banner(ui.out, AGENTRELAY_VERSION) : ''));

  const ctxFor = (cmd: Command) => {
    const opts = cmd.optsWithGlobals<GlobalOptions>();
    return { opts, ctx: createContext(opts.cwd ? { cwd: opts.cwd } : {}) };
  };

  // Bare `agentrelay`: the home screen.
  program.action(async (_options, cmd: Command) => {
    const { opts, ctx } = ctxFor(cmd);
    emit(opts, await runHome(ctx), (h) => renderHome(h, ui.out));
  });

  program
    .command('init')
    .description('register the current project and create .agentrelay/ (ignored by Git)')
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
    .option('-p, --provider <id>', 'only this provider (claude, codex)')
    .option('-a, --all', 'include sessions from every directory, not just this project')
    .option('-n, --limit <n>', 'max sessions per provider', parsePositiveInt, 20)
    .action(async (options: { provider?: string; all?: boolean; limit: number }, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const result = await runSessions(ctx, options);
      emit(opts, result, (r) => renderSessions(r, opts.verbose, ui.out));
    });

  const checkpoint = program.command('checkpoint').description('create and inspect checkpoints');

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
    .command('export <id>')
    .description('export a checkpoint (always re-redacted); writing a file asks for confirmation')
    .addOption(new Option('--format <format>', 'output format').choices(['markdown', 'json']).default('markdown'))
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .option('--force', 'overwrite an existing file')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (id: string, options: ExportOptions, cmd: Command) => {
      const { opts, ctx } = ctxFor(cmd);
      const result = await runExport(ctx, id, options);
      if (opts.json) {
        const { content, ...meta } = result;
        emit(opts, result.out ? meta : result, () => '');
      } else if (result.out) {
        const t = ui.err;
        process.stderr.write(
          `  ${statusIcon(t, 'ok')} Exported ${t.bold(result.checkpointId)} ${t.dim(`(${result.format}, ~${result.estimatedTokens} tok)`)} ${t.fg('cyan', t.sym.arrow)} ${t.bold(result.out)}\n`,
        );
      } else {
        process.stdout.write(result.content);
      }
    });

  addCheckpointOptions(
    program
      .command('handoff')
      .description('build a checkpoint and preview the handoff for another agent')
      .requiredOption('--to <provider>', 'provider that will receive the handoff (claude, codex)')
      .option('--preview', 'show the handoff without launching anything (default)')
      .option('--confirm', 'launch the target agent with the handoff (not available yet)'),
  ).action(async (flags: CheckpointFlags & { confirm?: boolean }, cmd: Command) => {
    const { opts, ctx } = ctxFor(cmd);
    if (flags.confirm) {
      throw new AgentRelayError(
        'Launching the target agent is not implemented yet (planned for Phase 3). Use --preview and hand over the file manually.',
        ExitCode.Unsupported,
      );
    }
    const result = await createCheckpoint(ctx, toCreateOptions(flags, opts, ui));
    const copied = await maybeCopy(flags, result, ui, Boolean(opts.json));
    if (opts.json) {
      emit(opts, { ...summarize(result, copied), markdown: result.checkpoint.handoff.prompt }, () => '');
    } else {
      // The handoff text goes to stdout (pipe-friendly); the card goes to stderr.
      process.stdout.write(highlightMarkdown(result.checkpoint.handoff.prompt ?? '', ui.out));
      process.stderr.write(`${renderSummary(summarize(result, copied), ui.err)}\n`);
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
    const hint = code === ExitCode.Usage ? `\n  ${t.dim('run agentrelay --help for usage')}` : '';
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
    if (error instanceof AgentRelayError) return reportError(error.message, error.exitCode, json, ui.err);
    if (error instanceof ZodError) {
      const detail = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return reportError(`Invalid data: ${detail}`, ExitCode.Failure, json, ui.err);
    }
    const message = error instanceof Error ? (process.env.AGENTRELAY_DEBUG ? error.stack ?? error.message : error.message) : String(error);
    return reportError(message, ExitCode.Failure, json, ui.err);
  }
}
