export const AGENTRELAY_VERSION = '0.1.0-alpha.0';

/** Oldest Node.js release with unflagged `node:sqlite`. */
export const MIN_NODE_VERSION = '22.13.0';

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}
