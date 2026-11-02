import path from 'node:path';
import readline from 'node:readline';
import { RELAYVORA_VERSION, RelayvoraError, renderHandoff } from '@relayvora/core';
import { z, ZodError } from 'zod';
import { createCheckpoint, loadCheckpoint } from './checkpoint-service.js';
import { runCheckpointList, summarize } from './commands/checkpoint.js';
import { latestCheckpointId, withEditedHandoff } from './commands/export.js';
import { runImport } from './commands/import.js';
import { runInbox } from './commands/share.js';
import { type CliContext, createContext } from './context.js';

/**
 * `relayvora mcp`: a Model Context Protocol server on stdio, so any agent with MCP support (Cursor,
 * Copilot, Windsurf, Claude Code, Codex...) can fetch handoffs, save checkpoints and read the inbox
 * itself, including agents Relayvora has no adapter for. JSON-RPC 2.0, one message per line.
 *
 * Nothing here pushes to a remote or runs commands: sharing (`sync`, `send`) and verification
 * commands stay with the person at the terminal.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Relayvora moves unfinished work between AI coding agents through checkpoints: a compact handoff with the goal, what is done, what is left, and Git evidence.',
  'When the user asks you to continue or pick up work, call get_handoff (or inbox, for work a teammate sent) and follow the handoff.',
  'Before you stop with work unfinished (a limit is near, the user is switching agents, or they ask you to hand off), call create_checkpoint with an accurate goal, completed and pending steps, blockers and decisions.',
].join(' ');

const project = z.string().optional().describe('Project directory; defaults to the directory the server was started in.');
const list = (what: string) => z.array(z.string()).optional().describe(what);

interface Tool<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  schema: S;
  readOnly: boolean;
  /** Talks to a Git remote. */
  network?: boolean;
  run(ctx: CliContext, args: z.infer<S>): Promise<string>;
}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool<z.ZodObject>;

export const TOOLS = [
  tool({
    name: 'list_checkpoints',
    title: 'List checkpoints',
    description: 'List the checkpoints saved for this project, newest first.',
    schema: z.object({ limit: z.number().int().positive().max(200).optional().describe('Max checkpoints (default 20).'), project }),
    readOnly: true,
    async run(ctx, args) {
      const { projectRoot, checkpoints } = await runCheckpointList(ctx, args.limit ?? 20);
      if (!checkpoints.length) return `No checkpoints for ${projectRoot} yet.`;
      const rows = checkpoints.map(
        (c) => `- ${c.id}  ${c.createdAt}  ${c.sourceProvider} -> ${c.targetProvider ?? 'any'}${c.trigger !== 'manual' ? ` (auto: ${c.trigger})` : ''}\n  ${(c.goal ?? '').split('\n')[0]!.slice(0, 160)}`,
      );
      return `Checkpoints for ${projectRoot}:\n${rows.join('\n')}`;
    },
  }),
  tool({
    name: 'get_handoff',
    title: 'Get a handoff',
    description:
      'Fetch the handoff of a checkpoint (default: the latest for this project) to continue the work. Also finds checkpoints shared on the relayvora/handoffs branch and imports them.',
    schema: z.object({
      id: z.string().optional().describe('Checkpoint id or unique prefix; default: the latest.'),
      budget: z.number().int().positive().optional().describe('Re-render the handoff to fit this many tokens.'),
      project,
    }),
    readOnly: true,
    async run(ctx, args) {
      const id = args.id ?? (await latestCheckpointId(ctx));
      const cp = await loadCheckpoint(ctx, id).catch(async (error: unknown) => {
        // Not here yet: it may have been synced or sent from another machine.
        if (!args.id) throw error;
        const imported = await runImport(ctx, args.id).catch(() => null);
        if (!imported) throw error;
        return loadCheckpoint(ctx, imported.checkpointId);
      });
      const { cp: current } = withEditedHandoff(cp);
      const markdown = args.budget !== undefined ? renderHandoff(current, { budgetTokens: args.budget }).markdown : (current.handoff.prompt ?? renderHandoff(current).markdown);
      return `Checkpoint ${cp.id} (from ${cp.source.provider}, ${cp.createdAt}).\n\n${markdown}`;
    },
  }),
  tool({
    name: 'create_checkpoint',
    title: 'Save a checkpoint',
    description:
      'Save the state of the current task as a checkpoint and write its handoff file, so another agent or another session can continue. Git evidence (branch, changed files, diffs, recent commits) is collected automatically; describe the task yourself.',
    schema: z.object({
      goal: z.string().min(1).describe('What the task is trying to achieve, in one or two sentences.'),
      completed: list('Steps already done.'),
      pending: list('Steps still to do, in order.'),
      blockers: list('What is failing or blocking progress.'),
      decisions: list('Decisions made and why, so they are not reopened.'),
      constraints: list('Rules to keep following.'),
      to: z.string().optional().describe('Agent that will continue: claude, codex or opencode. Leave out for any agent.'),
      from: z.string().optional().describe('Also read the latest session transcript of this agent (claude, codex, opencode).'),
      project,
    }),
    readOnly: false,
    async run(ctx, args) {
      const result = await createCheckpoint(ctx, {
        goal: args.goal,
        ...(args.completed ? { completed: args.completed } : {}),
        ...(args.pending ? { pending: args.pending } : {}),
        ...(args.blockers ? { blockers: args.blockers } : {}),
        ...(args.decisions ? { decisions: args.decisions } : {}),
        ...(args.constraints ? { constraints: args.constraints } : {}),
        ...(args.to ? { to: args.to } : {}),
        ...(args.from ? { from: args.from } : {}),
      });
      const s = summarize(result);
      const lines = [
        `Saved checkpoint ${s.id}.`,
        `Handoff file: ${s.handoff.file} (~${s.handoff.estimatedTokens ?? '?'} tokens)`,
        `Changed files: ${s.files.changed}; commits this session: ${s.commits.count}`,
        `To continue in another agent, tell it: ${s.pointer}`,
        ...s.warnings.map((w) => `Warning: ${w}`),
      ];
      return lines.join('\n');
    },
  }),
  tool({
    name: 'inbox',
    title: 'Check the inbox',
    description:
      'Checkpoints teammates sent to the user (matched by their Git email) through this repository. Fetches the relayvora/handoffs branch and imports anything new, so get_handoff can read it.',
    schema: z.object({
      sent: z.boolean().optional().describe('Show what the user sent instead.'),
      remote: z.string().optional().describe('Git remote to check (default: origin).'),
      project,
    }),
    readOnly: true,
    network: true,
    async run(ctx, args) {
      const r = await runInbox(ctx, { ...(args.sent ? { sent: true } : {}), ...(args.remote ? { remote: args.remote } : {}) });
      if (!r.items.length) return r.sent ? `${r.me} has not sent any checkpoints in this repository.` : `Nothing sent to ${r.me} in this repository.`;
      const rows = r.items.map((i) =>
        [
          `- ${i.checkpointId}  ${i.at}  ${r.sent ? `to ${i.to.join(', ')}` : `from ${i.from.name ?? ''} <${i.from.email}>`}`,
          `  goal: ${i.goal}`,
          ...(i.note ? [`  note: ${i.note}`] : []),
          ...(i.carriesChanges ? ['  carries uncommitted changes: apply them with import_checkpoint (applyChanges: true)'] : []),
        ].join('\n'),
      );
      return `${r.sent ? 'Sent' : 'Inbox'} for ${r.me}:\n${rows.join('\n')}`;
    },
  }),
  tool({
    name: 'import_checkpoint',
    title: 'Import a checkpoint',
    description:
      'Import a checkpoint from a JSON export file or from the relayvora/handoffs branch (by id or prefix), optionally applying the uncommitted changes it carries to the working tree.',
    schema: z.object({
      source: z.string().min(1).describe('Path to a JSON export, or a shared checkpoint id or prefix.'),
      applyChanges: z.boolean().optional().describe('Apply the carried uncommitted changes (needs the same commit checked out).'),
      force: z.boolean().optional().describe('Replace a checkpoint with the same id imported earlier.'),
      remote: z.string().optional().describe('Git remote holding the shared branch (default: origin).'),
      project,
    }),
    readOnly: false,
    async run(ctx, args) {
      const r = await runImport(ctx, args.source, {
        ...(args.applyChanges ? { applyChanges: true } : {}),
        ...(args.force ? { force: true } : {}),
        ...(args.remote ? { remote: args.remote } : {}),
      });
      return [
        `${r.alreadyImported ? 'Already imported' : 'Imported'} checkpoint ${r.checkpointId} (made at ${r.originalRoot}).`,
        `Handoff file: ${r.handoffFile}`,
        ...(r.changes ? [r.changes.applied ? `Applied uncommitted changes to ${r.changes.files.length} file(s).` : `Carries changes to ${r.changes.files.length} file(s), saved in ${r.changes.patchFile}.`] : []),
        ...r.notes,
        'Read it with get_handoff.',
      ].join('\n');
    },
  }),
];

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Response = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const ok = (id: Request['id'], result: unknown): Response => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Request['id'], code: number, message: string): Response => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function inputSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export interface McpServerOptions {
  /** Directory tools work in when a call names no project. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Handles one JSON-RPC message; returns the response, or null for a notification. */
export function createMcpHandler(options: McpServerOptions): (message: unknown) => Promise<Response | null> {
  return async (message) => {
    const req = message as Request;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return fail(req?.id, -32600, 'Invalid request');
    if (req.id === undefined) return null; // notifications/initialized, cancellations...

    switch (req.method) {
      case 'initialize': {
        const asked = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '';
        return ok(req.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'relayvora', title: 'Relayvora', version: RELAYVORA_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(req.id, {});
      case 'tools/list':
        return ok(req.id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: inputSchema(t.schema),
            annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: Boolean(t.network) },
          })),
        });
      case 'tools/call': {
        const name = req.params?.name;
        const t = TOOLS.find((x) => x.name === name);
        if (!t) return fail(req.id, -32602, `Unknown tool: ${String(name)}`);
        try {
          const args = t.schema.parse(req.params?.arguments ?? {}) as { project?: string };
          const cwd = args.project ? path.resolve(options.cwd, args.project) : options.cwd;
          const text = await t.run(createContext({ cwd, ...(options.env ? { env: options.env } : {}) }), args);
          return ok(req.id, { content: [{ type: 'text', text }], isError: false });
        } catch (error) {
          // Tool failures go back to the agent as results it can read and act on.
          const text =
            error instanceof ZodError
              ? `Invalid arguments: ${error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
              : error instanceof RelayvoraError || error instanceof Error
                ? error.message
                : String(error);
          return ok(req.id, { content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        return fail(req.id, -32601, `Method not found: ${req.method}`);
    }
  };
}

/** Serves MCP on stdin/stdout until stdin closes. Only protocol messages go to stdout. */
export async function serveMcp(options: McpServerOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const handle = createMcpHandler(options);
  const send = (r: Response | null) => {
    if (r) output.write(`${JSON.stringify(r)}\n`);
  };
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve(); // one call at a time: the store is a single SQLite file
  for await (const line of rl) {
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send(fail(null, -32700, 'Parse error'));
        return;
      }
      if (Array.isArray(message)) {
        const responses: Response[] = [];
        for (const m of message) {
          const r = await handle(m);
          if (r) responses.push(r);
        }
        if (responses.length) output.write(`${JSON.stringify(responses)}\n`);
      } else {
        send(await handle(message));
      }
    });
  }
  await queue;
}
