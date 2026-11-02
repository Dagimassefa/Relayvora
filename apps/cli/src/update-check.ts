import fs from 'node:fs';
import path from 'node:path';
import { RELAYVORA_VERSION } from '@relayvora/core';

const REGISTRY_URL = 'https://registry.npmjs.org/relayvora/latest';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;

export interface UpdateInfo {
  current: string;
  latest: string;
}

interface Cache {
  checkedAt: string;
  latest: string | null;
}

/** Orders `1.2.3` and `1.2.3-alpha.4` the way npm does: a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre?.split('.') ?? [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p) ? Number(p) : null;
    const qn = /^\d+$/.test(q) ? Number(q) : null;
    if (pn !== null && qn !== null) {
      if (pn !== qn) return pn - qn;
    } else if (p !== q) {
      return pn !== null ? -1 : qn !== null ? 1 : p < q ? -1 : 1;
    }
  }
  return 0;
}

export function updateChecksDisabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.RELAYVORA_NO_UPDATE_CHECK || env.CI);
}

function readCache(file: string): Cache | null {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Cache;
    return typeof c.checkedAt === 'string' ? c : null;
  } catch {
    return null;
  }
}

/**
 * Asks the npm registry for the latest published version at most once a day, caching the answer in
 * the data directory. The request carries nothing about the user or their projects. Never throws:
 * offline, slow or disabled checks return null.
 */
export async function checkForUpdate(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  fetchLatest: () => Promise<string | null> = fetchLatestVersion,
  now: Date = new Date(),
): Promise<UpdateInfo | null> {
  if (updateChecksDisabled(env)) return null;
  const file = path.join(dataDir, 'update-check.json');
  let cache = readCache(file);
  if (!cache || now.getTime() - Date.parse(cache.checkedAt) >= CHECK_EVERY_MS) {
    const latest = await fetchLatest().catch(() => null);
    // A failed check is cached too, so being offline costs one timeout a day, not one per run.
    cache = { checkedAt: now.toISOString(), latest: latest ?? cache?.latest ?? null };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(cache)}\n`);
    } catch {
      // the notice is a convenience; never fail the home screen over it
    }
  }
  return cache.latest && compareVersions(cache.latest, RELAYVORA_VERSION) > 0 ? { current: RELAYVORA_VERSION, latest: cache.latest } : null;
}

async function fetchLatestVersion(): Promise<string | null> {
  const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : null;
}
