export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a released migration; add a new one. The applied version is tracked in
 * `PRAGMA user_version`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        root        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE sessions (
        provider       TEXT NOT NULL,
        id             TEXT NOT NULL,
        project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
        path           TEXT NOT NULL,
        cwd            TEXT,
        started_at     TEXT,
        updated_at     TEXT NOT NULL,
        discovered_at  TEXT NOT NULL,
        PRIMARY KEY (provider, id)
      );

      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        goal        TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('open', 'done', 'abandoned')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE checkpoints (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        source_provider   TEXT NOT NULL,
        source_session_id TEXT,
        schema_version    TEXT NOT NULL,
        body_json         TEXT NOT NULL,
        sha256            TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX checkpoints_project_idx ON checkpoints(project_id, created_at);

      CREATE TABLE evidence (
        id             TEXT NOT NULL,
        checkpoint_id  TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        type           TEXT NOT NULL,
        path           TEXT,
        sha256         TEXT,
        command        TEXT,
        exit_code      INTEGER,
        status         TEXT NOT NULL,
        captured_at    TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, id)
      );

      CREATE TABLE usage_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
        checkpoint_id  TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
        provider       TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('provider-reported', 'estimated', 'unavailable')),
        input_tokens   INTEGER,
        output_tokens  INTEGER,
        cost_usd       REAL,
        recorded_at    TEXT NOT NULL
      );

      CREATE TABLE adapter_capabilities (
        provider           TEXT PRIMARY KEY,
        executable_path    TEXT,
        version            TEXT,
        capabilities_json  TEXT NOT NULL,
        probed_at          TEXT NOT NULL
      );

      CREATE TABLE audit_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        action        TEXT NOT NULL,
        project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
        target        TEXT,
        details_json  TEXT
      );
      CREATE INDEX audit_events_project_idx ON audit_events(project_id, at);
    `,
  },
  {
    version: 2,
    name: 'checkpoint-handoff-columns',
    sql: `
      ALTER TABLE checkpoints ADD COLUMN target_provider TEXT;
      ALTER TABLE checkpoints ADD COLUMN estimated_tokens INTEGER;
      ALTER TABLE checkpoints ADD COLUMN goal TEXT;
      ALTER TABLE evidence ADD COLUMN excerpt_sha256 TEXT;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
