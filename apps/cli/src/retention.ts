import fs from 'node:fs';
import path from 'node:path';
import { RelayvoraError, ExitCode } from '@relayvora/core';
import type { Store } from '@relayvora/storage';
import { handoffPath, projectDir } from './project.js';

/** Remove only our exact handoff path. Never follow redirected state directories. */
export function removeCheckpoint(store: Store, root: string, id: string): boolean {
  if (!/^[\w.-]+$/.test(id)) throw new RelayvoraError('Invalid checkpoint id', ExitCode.Usage);
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
  try { fs.unlinkSync(handoffPath(root, id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return store.deleteCheckpoint(id);
}

export function enforceRetention(store: Store, root: string, projectId: string, days: number | null, now = new Date()): string[] {
  if (days === null) return [];
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const deleted: string[] = [];
  for (const row of store.expiredCheckpoints(projectId, cutoff)) {
    if (removeCheckpoint(store, root, row.id)) deleted.push(row.id);
  }
  if (deleted.length) store.recordAudit({ action: 'checkpoint.retention', projectId, details: { days, deleted } });
  return deleted;
}
