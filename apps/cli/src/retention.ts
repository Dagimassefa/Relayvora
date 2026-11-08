import fs from 'node:fs';
import path from 'node:path';
import { RelayvoraError, ExitCode, isValidCheckpointId } from '@relayvora/core';
import type { Store } from '@relayvora/storage';
import { handoffPath, projectDir } from './project.js';

/** Remove only our exact handoff paths. Never follow redirected state directories. */
export function removeCheckpoint(store: Store, root: string, id: string): boolean {
  if (!isValidCheckpointId(id)) throw new RelayvoraError('Invalid checkpoint id', ExitCode.Usage);
  for (const dir of [projectDir(root), path.join(projectDir(root), 'handoffs')]) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) {
        throw new RelayvoraError(`Refusing to delete through redirected directory: ${dir}`, ExitCode.PreconditionFailed);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // unlink removes a file or link itself; it never recursively removes a directory.
  for (const file of [handoffPath(root, id), handoffPath(root, id, '.patch')]) {
    try { fs.unlinkSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return store.deleteCheckpoint(id);
}

export function enforceRetention(store: Store, root: string, projectId: string, days: number | null, now = new Date()): string[] {
  if (days === null) return [];
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const row of store.expiredCheckpoints(projectId, cutoff)) {
    // A stored id that is not a valid file name (imported before ids were validated) must not stop
    // retention for the rest of the project; drop it from the store without touching any file.
    if (!isValidCheckpointId(row.id)) {
      if (store.deleteCheckpoint(row.id)) skipped.push(row.id);
      continue;
    }
    if (removeCheckpoint(store, root, row.id)) deleted.push(row.id);
  }
  if (deleted.length || skipped.length) store.recordAudit({ action: 'checkpoint.retention', projectId, details: { days, deleted, invalidIds: skipped } });
  return deleted;
}
