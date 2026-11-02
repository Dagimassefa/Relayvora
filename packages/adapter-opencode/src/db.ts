import { DatabaseSync } from 'node:sqlite';

/** `<database>#<session id>`: session ids (`ses_...`) never contain `#`, so the last one separates them. */
export function sessionPath(dbFile: string, sessionId: string): string {
  return `${dbFile}#${sessionId}`;
}

export function parseSessionPath(value: string): { dbFile: string; sessionId: string } {
  const at = value.lastIndexOf('#');
  if (at <= 0 || at === value.length - 1) throw new Error(`Not an OpenCode session path: ${value}`);
  return { dbFile: value.slice(0, at), sessionId: value.slice(at + 1) };
}

/**
 * Read-only: OpenCode owns this database. It runs in WAL mode, so reading never blocks a running
 * OpenCode and sees its latest committed writes.
 */
export function openDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile, { readOnly: true });
}
