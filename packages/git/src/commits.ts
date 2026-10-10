import { isSensitivePath, sha256, type SessionCommit, type SessionCommits } from '@agentrelay/core';
import { findRepoRoot, git } from './repo.js';
import { splitPatches } from './snapshot.js';

export interface CommitsOptions {
  /** Stop after this many commits (newest are kept). */
  maxCommits?: number;
  /** Per-commit patch cap; the hash still covers the full patch. */
  maxPatchBytes?: number;
  /**
   * Only commits by this author email. `undefined` uses the repository's user.email (the identity
   * agents commit with); `null` disables the filter.
   */
  author?: string | null;
}

const FIELD = '\u001f';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `diff --git a/x b/y` → `y` (the new path). Quoted paths are returned unquoted. */
function patchPath(patch: string): string {
  const header = patch.slice(0, patch.indexOf('\n'));
  const m = /^diff --git (?:"?a\/(.+?)"? )"?b\/(.+?)"?$/.exec(header);
  return m?.[2] ?? '';
}

function cut(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const sliced = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  const nl = sliced.lastIndexOf('\n');
  return { text: nl > 0 ? sliced.slice(0, nl + 1) : sliced, truncated: true };
}

async function describeCommit(root: string, sha: string, maxPatchBytes: number): Promise<Omit<SessionCommit, 'sha' | 'shortSha' | 'subject' | 'authoredAt'>> {
  // One call per commit: numstat lines first, then the patch.
  const r = await git(root, ['show', '--no-color', '--no-ext-diff', '--find-renames', '--format=', '--numstat', '--patch', sha], {
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const empty = { filesChanged: 0, linesAdded: 0, linesDeleted: 0, patch: null, truncated: false, sha256: null, withheldFiles: [] };
  if (r.exitCode !== 0) return empty;

  const diffStart = r.stdout.search(/^diff --git /m);
  const numstat = (diffStart === -1 ? r.stdout : r.stdout.slice(0, diffStart)).split('\n').filter((l) => /^(\d+|-)\t(\d+|-)\t/.test(l));
  let added = 0;
  let deleted = 0;
  for (const line of numstat) {
    const [a, d] = line.split('\t');
    added += Number(a) || 0;
    deleted += Number(d) || 0;
  }
  if (diffStart === -1) return { ...empty, filesChanged: numstat.length, linesAdded: added, linesDeleted: deleted };

  // Withhold sensitive files' patches entirely; never put them through truncation or redaction alone.
  const withheld: string[] = [];
  const kept = splitPatches(r.stdout.slice(diffStart)).filter((p) => {
    const file = patchPath(p);
    if (file && isSensitivePath(file)) {
      withheld.push(file);
      return false;
    }
    return true;
  });
  const full = kept.join('');
  const limited = cut(full, maxPatchBytes);
  return {
    filesChanged: numstat.length,
    linesAdded: added,
    linesDeleted: deleted,
    patch: full ? limited.text : null,
    truncated: limited.truncated || r.truncated,
    sha256: full ? sha256(full) : null,
    withheldFiles: withheld,
  };
}

/**
 * Commits on HEAD since `since` (any date git understands: ISO time, "2 hours ago", ...), oldest
 * first, merges excluded, by default only those authored with the repository's user.email.
 */
export async function collectCommitsSince(cwd: string, since: string, options: CommitsOptions = {}): Promise<SessionCommits> {
  const { maxCommits = 20, maxPatchBytes = 16_000 } = options;
  const root = await findRepoRoot(cwd);
  const warnings: string[] = [];
  if (!root) return { commits: [], since, author: null, warnings: ['Not a Git repository; no commits collected.'] };

  let author = options.author === undefined ? null : options.author;
  if (options.author === undefined) {
    const email = await git(root, ['config', '--get', 'user.email']);
    author = email.exitCode === 0 && email.stdout.trim() ? email.stdout.trim() : null;
  }

  const args = ['log', `--since=${since}`, '--no-merges', `--max-count=${maxCommits + 1}`, `--format=%H${FIELD}%h${FIELD}%aI${FIELD}%s`];
  if (author) args.push(`--author=${escapeRegex(author)}`);
  const log = await git(root, args);
  // An unborn branch has no history: not an error.
  if (log.exitCode !== 0) return { commits: [], since, author, warnings };

  const rows = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(FIELD))
    .filter((f) => f.length >= 4);
  if (rows.length > maxCommits) {
    warnings.push(`More than ${maxCommits} commits since the session started; only the newest ${maxCommits} are included.`);
    rows.length = maxCommits;
  }

  const commits = await Promise.all(
    rows.map(async ([sha, shortSha, authoredAt, ...subject]) => ({
      sha: sha!,
      shortSha: shortSha!,
      authoredAt: authoredAt!,
      subject: subject.join(FIELD),
      ...(await describeCommit(root, sha!, maxPatchBytes)),
    })),
  );
  commits.reverse(); // oldest first, the order the work happened
  return { commits, since, author, warnings };
}

/** Turns "2h", "30m", "3d" into an ISO time; anything else is passed to git unchanged. */
export function resolveSince(value: string, now: Date = new Date()): string {
  const m = /^(\d+)\s*(m|min|h|d)$/i.exec(value.trim());
  if (!m) return value.trim();
  const unit = m[2]!.toLowerCase();
  const ms = Number(m[1]) * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);
  return new Date(now.getTime() - ms).toISOString();
}
