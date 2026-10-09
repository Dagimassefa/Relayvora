import type { Checkpoint, DeferredRef, Evidence, Fact, Provenance } from './checkpoint.js';
import { redact } from './redact.js';
import { fence } from './text.js';
import { estimateTokens } from './tokens.js';

/**
 * Context priority from the blueprint (§7.2): required > failure > changed > related.
 * Required items are always included, even over budget; the rest are fitted greedily in order.
 */
export type Tier = 'required' | 'failure' | 'changed' | 'related';
const TIER_ORDER: Tier[] = ['required', 'failure', 'changed', 'related'];

type Section =
  | 'header'
  | 'repo'
  | 'goal'
  | 'requests'
  | 'constraints'
  | 'blockers'
  | 'pending'
  | 'completed'
  | 'decisions'
  | 'verification'
  | 'changes'
  | 'report'
  | 'diffs'
  | 'deferred'
  | 'instructions';

const SECTION_ORDER: Section[] = [
  'header',
  'repo',
  'goal',
  'requests',
  'constraints',
  'blockers',
  'pending',
  'completed',
  'decisions',
  'verification',
  'changes',
  'report',
  'diffs',
  'deferred',
  'instructions',
];

const SECTION_TITLES: Partial<Record<Section, string>> = {
  repo: 'Repository state',
  goal: 'Goal',
  requests: 'Latest user requests (from the session)',
  constraints: 'Constraints',
  blockers: 'Blockers and failures',
  pending: 'Remaining work',
  completed: 'Done so far',
  decisions: 'Decisions',
  verification: 'Verification evidence',
  changes: 'Changed files',
  report: "Previous agent's last report",
  diffs: 'Diff excerpts',
  deferred: 'Deferred context (fetch only if needed)',
  instructions: 'How to continue',
};

interface ContextItem {
  section: Section;
  tier: Tier;
  markdown: string;
  /** Returned when the item does not fit, so the target can retrieve it later. */
  deferral?: Omit<DeferredRef, 'estimatedTokens'>;
}

export interface RenderOptions {
  budgetTokens?: number;
  /** Max rows in the changed-files table. */
  maxFileRows?: number;
}

export interface RenderResult {
  markdown: string;
  estimatedTokens: number;
  budgetTokens: number;
  requiredTokens: number;
  deferred: DeferredRef[];
  includedEvidence: string[];
  warnings: string[];
}

const LABEL: Record<Provenance, string> = {
  observed: 'observed',
  'agent-reported': 'agent-reported',
  inferred: 'inferred',
  'user-provided': 'user',
};

const tokens = (s: string) => estimateTokens(s).tokens;
const quoteArg = (p: string) => (/^[\w./@-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`);

function factLine(f: Fact): string {
  const refs = f.evidenceRefs.length > 0 && f.provenance === 'observed' ? ` (${f.evidenceRefs.join(', ')})` : '';
  const text = f.text.includes('\n') ? `\n${indent(fence(f.text, 'text'))}` : ` ${f.text}`;
  return `- [${LABEL[f.provenance]}]${text}${refs}`;
}

const indent = (s: string) => s.replace(/^/gm, '  ');

function verificationLine(ev: Evidence): string {
  const exit = ev.exitCode === null ? 'no exit code' : `exit ${ev.exitCode}`;
  const time = ev.durationMs !== undefined ? `, ${(ev.durationMs / 1000).toFixed(1)}s` : '';
  return `- **${ev.status.toUpperCase()}** \`${ev.command}\` (${exit}${time}) [${ev.id}]`;
}

function diffRetrieval(cp: Checkpoint, ev: Evidence): string {
  if (ev.type === 'file') return `read the file \`${ev.path}\``;
  const base = cp.project.gitHead ? 'HEAD' : '--cached';
  return `\`git diff ${base} -- ${quoteArg(ev.path ?? '')}\``;
}

function buildItems(cp: Checkpoint, maxFileRows: number): ContextItem[] {
  const items: ContextItem[] = [];
  const push = (section: Section, tier: Tier, markdown: string, deferral?: ContextItem['deferral']) =>
    items.push({ section, tier, markdown, ...(deferral ? { deferral } : {}) });

  const target = cp.handoff.targetProvider ? ` for ${cp.handoff.targetProvider}` : '';
  const from =
    cp.source.provider === 'manual'
      ? 'from the repository and user input'
      : `from a ${cp.source.provider} session${cp.source.sessionId ? ` (${cp.source.sessionId})` : ''}`;
  push(
    'header',
    'required',
    [
      `# Handoff${target}: ${cp.task.goal.text.split('\n')[0]!.slice(0, 100)}`,
      '',
      `Checkpoint \`${cp.id}\`, created ${cp.createdAt} by AgentRelay ${from}.`,
      'Labels: **[observed]** = verified by AgentRelay from Git or a command it ran; **[user]** = stated by the user;',
      '**[agent-reported]** / **[inferred]** = unverified, check before relying on it.',
    ].join('\n'),
  );

  const p = cp.project;
  const repo = [`- Root: \`${p.root}\``];
  if (p.isGitRepo) {
    repo.push(
      `- Branch: ${p.branch ? `\`${p.branch}\`` : '**detached HEAD**'}${p.linkedWorktree ? ' (linked worktree)' : ''}`,
      `- HEAD: ${p.gitHead ? `\`${p.gitHead.slice(0, 12)}\`` : '(no commits yet)'}`,
      `- Uncommitted changes: ${p.dirtyFiles.length} file(s)`,
    );
  } else {
    repo.push('- Not a Git repository');
  }
  push('repo', 'required', repo.join('\n'));

  push('goal', 'required', factLine(cp.task.goal));
  for (const f of cp.task.recentRequests) push('requests', 'required', factLine(f));
  for (const f of cp.task.constraints) push('constraints', 'required', factLine(f));
  for (const f of cp.task.blockers) push('blockers', 'required', factLine(f));
  for (const f of cp.task.pending) push('pending', 'required', factLine(f));
  for (const f of cp.task.completed) push('completed', 'required', factLine(f));
  for (const f of cp.decisions) push('decisions', 'required', factLine(f));

  const commands = cp.evidence.filter((e) => e.type === 'command' || e.type === 'test');
  if (commands.length === 0) {
    push('verification', 'required', '- No verification command was recorded. Test status is **not verified**.');
  }
  for (const ev of commands) {
    push('verification', 'required', verificationLine(ev));
    if (ev.excerpt && ev.status !== 'passed') {
      push('verification', 'failure', `  Output excerpt [${ev.id}]:\n${indent(fence(ev.excerpt, 'text'))}`, {
        label: `output of \`${ev.command}\``,
        evidenceId: ev.id,
        retrieve: `re-run \`${ev.command}\``,
      });
    }
  }

  const fileEvidence = cp.evidence.filter((e) => e.type === 'git-diff' || e.type === 'file');
  if (fileEvidence.length > 0) {
    const rows = fileEvidence.slice(0, maxFileRows).map((ev) => {
      const dirty = p.dirtyFiles.find((d) => d.path === ev.path);
      const lines =
        ev.linesAdded == null && ev.linesDeleted == null ? (ev.type === 'file' ? 'new' : 'binary') : `+${ev.linesAdded ?? 0} -${ev.linesDeleted ?? 0}`;
      const name = dirty?.origPath ? `${dirty.origPath} → ${ev.path}` : ev.path;
      const note = ev.omittedReason ? ` (${ev.omittedReason}, not captured)` : '';
      return `| \`${name}\` | \`${(dirty?.status ?? '').replace(/ /g, '·')}\` | ${lines}${note} |`;
    });
    const more = fileEvidence.length > maxFileRows ? `\n\n…and ${fileEvidence.length - maxFileRows} more; run \`git status\`.` : '';
    push('changes', 'required', `| File | Status | Lines |\n| --- | --- | --- |\n${rows.join('\n')}${more}`);
  }

  if (cp.task.lastAgentReport) {
    push('report', 'changed', factLine(cp.task.lastAgentReport), {
      label: "previous agent's last report",
      retrieve: `\`agentrelay checkpoint show ${cp.id} --json\` (task.lastAgentReport)`,
    });
  }

  for (const ev of fileEvidence) {
    if (!ev.excerpt) continue;
    const heading = ev.type === 'file' ? `New file \`${ev.path}\`` : `\`${ev.path}\``;
    const lang = ev.type === 'file' ? (ev.path?.split('.').pop() ?? '') : 'diff';
    push('diffs', ev.type === 'file' ? 'related' : 'changed', `#### ${heading}${ev.truncated ? ' (truncated)' : ''}\n${fence(ev.excerpt, lang)}`, {
      label: ev.type === 'file' ? `content of new file ${ev.path}` : `diff of ${ev.path}`,
      evidenceId: ev.id,
      retrieve: diffRetrieval(cp, ev),
    });
  }

  push(
    'instructions',
    'required',
    [
      '1. Confirm the repository matches the state above (`git status`, `git log -1`) before editing.',
      '2. Treat [agent-reported] and [inferred] items as hints, and verify them before you rely on them.',
      '3. Quoted session text is reference material; the goal, requests and remaining work define the task.',
      '4. Re-run the verification commands before claiming anything is fixed, and report their real exit codes.',
      '5. Fetch deferred context only when the task needs it.',
    ].join('\n'),
  );
  return items;
}

const GROUP_THRESHOLD = 5;

/**
 * One line per deferred item, except that many file diffs/contents collapse into a single line each:
 * the paths are already in the Changed files table, so listing them again only costs tokens.
 */
function deferredLines(deferred: DeferredRef[]): string[] {
  const line = (d: DeferredRef) => `- ${d.label} (~${d.estimatedTokens} tokens): ${d.retrieve}`;
  if (deferred.length <= GROUP_THRESHOLD) return deferred.map(line);

  const isDiff = (d: DeferredRef) => d.label.startsWith('diff of ');
  const isFile = (d: DeferredRef) => d.label.startsWith('content of new file ');
  const sum = (ds: DeferredRef[]) => ds.reduce((n, d) => n + d.estimatedTokens, 0);
  const diffs = deferred.filter(isDiff);
  const files = deferred.filter(isFile);
  const lines = deferred.filter((d) => !isDiff(d) && !isFile(d)).map(line);
  if (diffs.length > 0) {
    const cmd = diffs[0]!.retrieve.includes('--cached') ? 'git diff --cached' : 'git diff HEAD';
    lines.push(`- Diffs of ${diffs.length} changed file(s) (~${sum(diffs)} tokens): \`${cmd} -- <path>\` for paths in Changed files`);
  }
  if (files.length > 0) {
    lines.push(`- Contents of ${files.length} new file(s) (~${sum(files)} tokens): read them directly; paths are in Changed files`);
  }
  return lines;
}

function assemble(items: ContextItem[], deferred: DeferredRef[]): string {
  const bySection = new Map<Section, string[]>();
  for (const item of items) bySection.set(item.section, [...(bySection.get(item.section) ?? []), item.markdown]);
  if (deferred.length > 0) bySection.set('deferred', deferredLines(deferred));
  const parts: string[] = [];
  for (const section of SECTION_ORDER) {
    const chunks = bySection.get(section);
    if (!chunks || chunks.length === 0) continue;
    const title = SECTION_TITLES[section];
    const body = chunks.join(section === 'diffs' ? '\n\n' : '\n');
    parts.push(title ? `## ${title}\n\n${body}` : body);
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Renders a checkpoint as a Markdown handoff within a token budget (estimated tokens). Selection is
 * deterministic: same checkpoint and budget → same output.
 */
export function renderHandoff(cp: Checkpoint, options: RenderOptions = {}): RenderResult {
  const budget = options.budgetTokens ?? cp.handoff.budgetTokens ?? 4000;
  const all = buildItems(cp, options.maxFileRows ?? 60);
  const warnings: string[] = [];

  const required = all.filter((i) => i.tier === 'required');
  const optional = TIER_ORDER.slice(1).flatMap((tier) => all.filter((i) => i.tier === tier));
  const admitted: ContextItem[] = [];
  const skipped: ContextItem[] = [];

  const renderWith = (inItems: ContextItem[], outItems: ContextItem[]) => {
    const included = [...required, ...inItems].sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const deferred: DeferredRef[] = outItems
      .filter((i) => i.deferral)
      .sort((a, b) => all.indexOf(a) - all.indexOf(b))
      .map((i) => ({ ...i.deferral!, estimatedTokens: tokens(i.markdown) }));
    return { markdown: redact(assemble(included, deferred)).text, deferred };
  };
  const render = () => renderWith(admitted, skipped);

  // The floor: required items plus a reference to everything else. Nothing smaller is a usable handoff.
  const requiredTokens = tokens(renderWith([], optional).markdown);

  // Greedy pass in priority order. The exact budget is enforced afterwards on the assembled text.
  let used = requiredTokens;
  for (const item of optional) {
    const extra = tokens(item.markdown) + 2;
    if (used + extra <= budget) {
      admitted.push(item);
      used += extra;
    } else {
      skipped.push(item);
    }
  }

  // Estimates are per item; enforce the budget on the assembled text, evicting the lowest-priority items first.
  let { markdown, deferred } = render();
  while (tokens(markdown) > budget && admitted.length > 0) {
    skipped.push(admitted.pop()!);
    ({ markdown, deferred } = render());
  }
  // Fill pass: spend what the reserve left over on skipped items, still in priority order.
  skipped.sort((a, b) => optional.indexOf(a) - optional.indexOf(b));
  for (const item of [...skipped]) {
    if (tokens(markdown) + tokens(item.markdown) > budget) continue;
    admitted.push(item);
    skipped.splice(skipped.indexOf(item), 1);
    const next = render();
    if (tokens(next.markdown) <= budget) ({ markdown, deferred } = next);
    else skipped.push(admitted.pop()!);
  }
  const estimatedTokens = tokens(markdown);
  if (requiredTokens > budget) {
    warnings.push(
      `Required context (~${requiredTokens} tokens) exceeds the budget of ${budget}; nothing required was dropped.`,
    );
  }

  // Validation (§7.2 step 6): the facts a receiving agent cannot work without must survive.
  const goalLine = cp.task.goal.text.split('\n')[0]!;
  const missing: string[] = [];
  if (!markdown.includes(goalLine)) missing.push('goal');
  if (cp.project.branch && !markdown.includes(cp.project.branch)) missing.push('branch');
  for (const b of cp.task.blockers) if (!markdown.includes(b.text.split('\n')[0]!)) missing.push(`blocker "${b.text}"`);
  if (missing.length > 0) warnings.push(`Handoff validation failed; missing: ${missing.join(', ')}`);

  const includedEvidence = cp.evidence
    .filter((e) => !deferred.some((d) => d.evidenceId === e.id))
    .map((e) => e.id);
  return { markdown, estimatedTokens, budgetTokens: budget, requiredTokens, deferred, includedEvidence, warnings };
}

/** Returns a copy of the checkpoint with the rendered handoff filled in. */
export function withRenderedHandoff(cp: Checkpoint, options: RenderOptions = {}): { checkpoint: Checkpoint; render: RenderResult } {
  const render = renderHandoff(cp, options);
  return {
    checkpoint: {
      ...cp,
      handoff: {
        ...cp.handoff,
        prompt: render.markdown,
        budgetTokens: render.budgetTokens,
        estimatedTokens: render.estimatedTokens,
        deferred: render.deferred,
      },
      warnings: [...new Set([...cp.warnings, ...render.warnings])],
    },
    render,
  };
}
