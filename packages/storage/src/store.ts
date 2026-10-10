import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentRelayError,
  ExitCode,
  safeParseCheckpoint,
  sha256,
  type Checkpoint,
  type SessionSummary,
} from '@agentrelay/core';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations.js';

export const DB_FILENAME = 'agentrelay.db';

export interface ProjectRecord {
  id: string;
  root: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  action: string;
  projectId?: string | null;
  target?: string | null;
  details?: unknown;
}

export interface AdapterCapabilityRecord {
  provider: string;
  executablePath: string | null;
  version: string | null;
  capabilities: unknown;
}

export interface CheckpointRow {
  id: string;
  sourceProvider: string;
  sourceSessionId: string | null;
  targetProvider: string | null;
  estimatedTokens: number | null;
  goal: string | null;
  createdAt: string;
}

export interface ReceivingUsage {
  provider: string;
  sessionId: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  firstContextTokens: number | null;
  lastContextTokens: number | null;
  turns: number | null;
  durationMs: number | null;
}

export interface MeasuredRelay {
  checkpointId: string;
  sourceProvider: string;
  targetProvider: string;
  sourceContextTokens: number;
  receivingFirstContextTokens: number;
  receivingInputTokens: number | null;
  receivingCostUsd: number | null;
  receivingTurns: number | null;
}

export interface ActivityStats {
  checkpoints: number;
  projects: number;
  /** Estimated tokens of context listed as deferred instead of inlined, summed over checkpoints. */
  deferredTokens: number;
  verifiedRuns: number;
  passedRuns: number;
  /** Distinct UTC days with at least one checkpoint, newest first. */
  activeDays: string[];
  /** Consecutive UTC days with a checkpoint, ending today or yesterday. */
  streakDays: number;
}

/** Counts consecutive days (YYYY-MM-DD, newest first) ending today or yesterday. */
export function streak(daysDesc: string[], today: Date = new Date()): number {
  const dayMs = 86_400_000;
  const toNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / dayMs);
  const todayNum = Math.floor(today.getTime() / dayMs);
  const first = daysDesc[0];
  if (!first || todayNum - toNum(first) > 1) return 0;
  let count = 1;
  for (let i = 1; i < daysDesc.length; i++) {
    if (toNum(daysDesc[i - 1]!) - toNum(daysDesc[i]!) !== 1) break;
    count++;
  }
  return count;
}

const now = () => new Date().toISOString();

/**
 * Local SQLite store. WAL mode plus a busy timeout lets concurrent CLI invocations share the file;
 * every write goes through an IMMEDIATE transaction so writers serialize instead of deadlocking.
 */
export class Store {
  private constructor(
    readonly db: DatabaseSync,
    readonly file: string,
  ) {}

  static open(file: string, { migrate = true }: { migrate?: boolean } = {}): Store {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    const store = new Store(db, file);
    if (migrate) store.migrate();
    return store;
  }

  static openInDir(dir: string): Store {
    return Store.open(path.join(dir, DB_FILENAME));
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  /** Applies pending migrations. Returns the migrations that ran. */
  migrate(migrations: readonly Migration[] = MIGRATIONS): Migration[] {
    const latest = migrations[migrations.length - 1]?.version ?? 0;
    const applied: Migration[] = [];
    this.transaction(() => {
      const current = this.schemaVersion();
      if (current > latest) {
        throw new AgentRelayError(
          `Database schema v${current} is newer than this AgentRelay supports (v${latest}). Upgrade AgentRelay.`,
          ExitCode.Unsupported,
        );
      }
      for (const m of migrations) {
        if (m.version <= current) continue;
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
        applied.push(m);
      }
    });
    return applied;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Registers a project root, or returns the existing record. Idempotent. */
  upsertProject(root: string, name = path.basename(root) || root): ProjectRecord {
    return this.transaction(() => {
      const existing = this.getProjectByRoot(root);
      if (existing) {
        const updatedAt = now();
        this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(updatedAt, existing.id);
        return { ...existing, updatedAt };
      }
      const record: ProjectRecord = { id: randomUUID(), root, name, createdAt: now(), updatedAt: now() };
      this.db
        .prepare('INSERT INTO projects (id, root, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.root, record.name, record.createdAt, record.updatedAt);
      return record;
    });
  }

  getProjectByRoot(root: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT id, root, name, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE root = ?')
      .get(root);
    return row as ProjectRecord | undefined;
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare('SELECT id, root, name, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY name')
      .all() as unknown as ProjectRecord[];
  }

  recordAudit(event: AuditEvent): void {
    this.db
      .prepare('INSERT INTO audit_events (at, action, project_id, target, details_json) VALUES (?, ?, ?, ?, ?)')
      .run(
        now(),
        event.action,
        event.projectId ?? null,
        event.target ?? null,
        event.details === undefined ? null : JSON.stringify(event.details),
      );
  }

  upsertSession(session: SessionSummary, projectId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sessions (provider, id, project_id, path, cwd, started_at, updated_at, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, id) DO UPDATE SET
           project_id = COALESCE(excluded.project_id, sessions.project_id),
           path = excluded.path, cwd = excluded.cwd, updated_at = excluded.updated_at`,
      )
      .run(session.provider, session.id, projectId, session.path, session.cwd, session.startedAt, session.updatedAt, now());
  }

  /** Stores a validated checkpoint, its evidence index and any recorded usage, atomically. */
  saveCheckpoint(cp: Checkpoint, projectId: string): void {
    const body = JSON.stringify(cp);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO checkpoints (id, project_id, task_id, source_provider, source_session_id, schema_version,
             body_json, sha256, created_at, target_provider, estimated_tokens, goal)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cp.id,
          projectId,
          cp.source.provider,
          cp.source.sessionId,
          cp.schemaVersion,
          body,
          sha256(body),
          cp.createdAt,
          cp.handoff.targetProvider,
          cp.handoff.estimatedTokens,
          cp.task.goal.text.split('\n')[0]!.slice(0, 200),
        );
      const insertEvidence = this.db.prepare(
        `INSERT INTO evidence (id, checkpoint_id, type, path, sha256, command, exit_code, status, captured_at, excerpt_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ev of cp.evidence) {
        insertEvidence.run(
          ev.id,
          cp.id,
          ev.type,
          ev.path ?? null,
          ev.sha256 ?? null,
          ev.command ?? null,
          ev.exitCode,
          ev.status,
          ev.capturedAt,
          ev.excerpt === undefined ? null : sha256(ev.excerpt),
        );
      }
      if (cp.usage.source !== 'unavailable') {
        this.db
          .prepare(
            `INSERT INTO usage_events (project_id, checkpoint_id, provider, source, role, session_id, input_tokens,
               cached_input_tokens, output_tokens, cost_usd, context_tokens, turns, recorded_at)
             VALUES (?, ?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            projectId,
            cp.id,
            cp.source.provider,
            cp.usage.source,
            cp.source.sessionId,
            cp.usage.inputTokens,
            cp.usage.cachedInputTokens,
            cp.usage.outputTokens,
            cp.usage.costUsd,
            cp.usage.contextTokens,
            cp.usage.turns,
            now(),
          );
      }
    });
  }

  /** Fills in the source session's context size for a checkpoint recorded before it was captured. */
  saveSourceContext(projectId: string | null, checkpointId: string, provider: string, contextTokens: number, turns: number | null): void {
    const updated = this.db
      .prepare(`UPDATE usage_events SET context_tokens = ?, turns = COALESCE(turns, ?) WHERE checkpoint_id = ? AND role = 'source'`)
      .run(contextTokens, turns, checkpointId);
    if (Number(updated.changes) === 0) {
      this.db
        .prepare(
          `INSERT INTO usage_events (project_id, checkpoint_id, provider, source, role, context_tokens, turns, recorded_at)
           VALUES (?, ?, ?, 'provider-reported', 'source', ?, ?, ?)`,
        )
        .run(projectId, checkpointId, provider, contextTokens, turns, now());
    }
  }

  /** Records (or replaces) the usage of the session that continued from a checkpoint. */
  saveReceivingUsage(projectId: string | null, checkpointId: string, u: ReceivingUsage): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM usage_events WHERE checkpoint_id = ? AND role = 'receiving'`).run(checkpointId);
      this.db
        .prepare(
          `INSERT INTO usage_events (project_id, checkpoint_id, provider, source, role, session_id, input_tokens,
             cached_input_tokens, output_tokens, cost_usd, context_tokens, first_context_tokens, turns, duration_ms, recorded_at)
           VALUES (?, ?, ?, 'provider-reported', 'receiving', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          checkpointId,
          u.provider,
          u.sessionId,
          u.inputTokens,
          u.cachedInputTokens,
          u.outputTokens,
          u.costUsd,
          u.lastContextTokens,
          u.firstContextTokens,
          u.turns,
          u.durationMs,
          now(),
        );
    });
  }

  /**
   * Relays where both sides were measured: the source session's last-turn context and the receiving
   * session's first-turn context, both provider-reported.
   */
  measuredRelays(projectId?: string): MeasuredRelay[] {
    const where = projectId ? 'AND s.project_id = ?' : '';
    return this.db
      .prepare(
        `SELECT s.checkpoint_id AS checkpointId, s.provider AS sourceProvider, r.provider AS targetProvider,
                s.context_tokens AS sourceContextTokens, r.first_context_tokens AS receivingFirstContextTokens,
                r.input_tokens AS receivingInputTokens, r.cost_usd AS receivingCostUsd, r.turns AS receivingTurns
         FROM usage_events s
         JOIN usage_events r ON r.checkpoint_id = s.checkpoint_id AND r.role = 'receiving'
         WHERE s.role = 'source' AND s.context_tokens IS NOT NULL AND r.first_context_tokens IS NOT NULL ${where}
         ORDER BY r.recorded_at DESC`,
      )
      .all(...(projectId ? [projectId] : [])) as unknown as MeasuredRelay[];
  }

  /** Finds a checkpoint by full id or unique prefix. Throws on ambiguity or a corrupt body. */
  getCheckpoint(idOrPrefix: string): Checkpoint | undefined {
    const rows = this.db
      .prepare('SELECT id, body_json AS body FROM checkpoints WHERE id = ? OR id LIKE ? ESCAPE \'\\\' ORDER BY created_at DESC LIMIT 5')
      .all(idOrPrefix, `${idOrPrefix.replace(/[\\%_]/g, '\\$&')}%`) as Array<{ id: string; body: string }>;
    const exact = rows.find((r) => r.id === idOrPrefix);
    const row = exact ?? (rows.length === 1 ? rows[0] : undefined);
    if (!row && rows.length > 1) {
      throw new AgentRelayError(
        `Checkpoint id "${idOrPrefix}" is ambiguous: ${rows.map((r) => r.id).join(', ')}`,
        ExitCode.Usage,
      );
    }
    if (!row) return undefined;
    const parsed = safeParseCheckpoint(JSON.parse(row.body));
    if (!parsed.success) {
      throw new AgentRelayError(`Stored checkpoint ${row.id} failed validation: ${parsed.error.message}`, ExitCode.Failure);
    }
    return parsed.data;
  }

  listCheckpoints(projectId: string, limit = 20): CheckpointRow[] {
    return this.db
      .prepare(
        `SELECT id, source_provider AS sourceProvider, source_session_id AS sourceSessionId,
                target_provider AS targetProvider, estimated_tokens AS estimatedTokens, goal, created_at AS createdAt
         FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as CheckpointRow[];
  }

  /** Aggregate activity, from stored records only. Optionally scoped to one project. */
  activityStats(projectId?: string): ActivityStats {
    const where = projectId ? 'WHERE c.project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS checkpoints,
                COUNT(DISTINCT c.project_id) AS projects,
                COALESCE(SUM((SELECT SUM(json_extract(d.value, '$.estimatedTokens'))
                              FROM json_each(c.body_json, '$.handoff.deferred') d)), 0) AS deferredTokens
         FROM checkpoints c ${where}`,
      )
      .get(...args) as { checkpoints: number; projects: number; deferredTokens: number };
    const runs = this.db
      .prepare(
        `SELECT COUNT(*) AS verifiedRuns, COALESCE(SUM(e.status = 'passed'), 0) AS passedRuns
         FROM evidence e JOIN checkpoints c ON c.id = e.checkpoint_id
         ${where ? `${where} AND` : 'WHERE'} e.type IN ('command', 'test')`,
      )
      .get(...args) as { verifiedRuns: number; passedRuns: number };
    const days = (
      this.db.prepare(`SELECT DISTINCT substr(c.created_at, 1, 10) AS day FROM checkpoints c ${where} ORDER BY day DESC`).all(...args) as Array<{
        day: string;
      }>
    ).map((r) => r.day);
    return { ...totals, ...runs, activeDays: days, streakDays: streak(days) };
  }

  saveAdapterCapabilities(record: AdapterCapabilityRecord): void {
    this.db
      .prepare(
        `INSERT INTO adapter_capabilities (provider, executable_path, version, capabilities_json, probed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           executable_path = excluded.executable_path,
           version = excluded.version,
           capabilities_json = excluded.capabilities_json,
           probed_at = excluded.probed_at`,
      )
      .run(record.provider, record.executablePath, record.version, JSON.stringify(record.capabilities), now());
  }
}

export { LATEST_SCHEMA_VERSION };
