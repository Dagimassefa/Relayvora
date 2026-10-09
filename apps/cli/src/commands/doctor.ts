import fs from 'node:fs';
import {
  MIN_NODE_VERSION,
  compareVersions,
  detectPlatform,
  directoryExists,
  type PlatformInfo,
} from '@agentrelay/core';
import { gitVersion } from '@agentrelay/git';
import { LATEST_SCHEMA_VERSION } from '@agentrelay/storage';
import { type CliContext, openStore } from '../context.js';
import { locateProject, readProjectConfig } from '../project.js';
import { rule, statusIcon } from '../ui/components.js';
import { PLAIN, type Theme } from '../ui/theme.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  platform: PlatformInfo;
  checks: Check[];
}

async function check(id: string, fn: () => Promise<Omit<Check, 'id'>> | Omit<Check, 'id'>): Promise<Check> {
  try {
    return { id, ...(await fn()) };
  } catch (error) {
    return { id, status: 'fail', message: (error as Error).message };
  }
}

export async function runDoctor(ctx: CliContext): Promise<DoctorReport> {
  const platform = detectPlatform(ctx.env);
  const checks: Check[] = [];

  checks.push(
    await check('node', () =>
      compareVersions(platform.nodeVersion, MIN_NODE_VERSION) >= 0
        ? { status: 'ok', message: `Node.js ${platform.nodeVersion}` }
        : { status: 'fail', message: `Node.js ${platform.nodeVersion} is too old; need >= ${MIN_NODE_VERSION}` },
    ),
  );

  checks.push(
    await check('platform', () => ({
      status: platform.isWsl ? 'warn' : 'ok',
      message: platform.isWsl
        ? `WSL (${platform.release}): sessions from agents installed on the Windows side are not visible here`
        : `${platform.os} ${platform.release} (${platform.arch})`,
    })),
  );

  checks.push(
    await check('git', async () => {
      const version = await gitVersion();
      return version ? { status: 'ok', message: version } : { status: 'fail', message: 'git not found on PATH' };
    }),
  );

  checks.push(
    await check('store', () => {
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      fs.accessSync(ctx.dataDir, fs.constants.W_OK);
      const store = openStore(ctx);
      try {
        const version = store.schemaVersion();
        return {
          status: version === LATEST_SCHEMA_VERSION ? 'ok' : 'warn',
          message: `SQLite store at ${store.file} (schema v${version})`,
        };
      } finally {
        store.close();
      }
    }),
  );

  checks.push(
    await check('project', async () => {
      const { root, isGitRepo } = await locateProject(ctx.cwd);
      const config = readProjectConfig(root);
      if (!config) return { status: 'warn', message: `${root} is not initialized; run \`agentrelay init\`` };
      if (!isGitRepo) return { status: 'warn', message: `${root} is initialized but is not a Git repository` };
      return { status: 'ok', message: `${root} (providers: ${config.providers.join(', ')})` };
    }),
  );

  const store = (() => {
    try {
      return openStore(ctx);
    } catch {
      return null;
    }
  })();
  try {
    for (const adapter of ctx.adapters) {
      checks.push(
        await check(`adapter:${adapter.id}`, async () => {
          const probe = await adapter.probe({ env: ctx.env });
          const roots = adapter.sessionRoots(ctx.env);
          const existing = [];
          for (const r of roots) if (await directoryExists(r)) existing.push(r);
          store?.saveAdapterCapabilities({
            provider: adapter.id,
            executablePath: probe.path ?? null,
            version: probe.version ?? null,
            capabilities: adapter.capabilities,
          });

          const sessions = existing.length > 0 ? 'sessions found' : 'no sessions yet';
          const detail = { probe, sessionRoots: roots, capabilities: adapter.capabilities };
          if (!probe.found) {
            const message =
              existing.length > 0
                ? `${adapter.displayName}: sessions readable, but no \`${adapter.executable}\` on PATH or in an editor extension`
                : `${adapter.displayName} not found: no \`${adapter.executable}\` on PATH, no editor extension, no sessions`;
            return { status: 'warn', message, detail };
          }
          const where = probe.source === 'editor-extension' ? `${probe.editor} extension` : 'on PATH';
          if (probe.error) return { status: 'warn', message: `${adapter.displayName} (${where}): ${probe.error}`, detail };
          // Strip a trailing product name some CLIs print, e.g. "2.1.295 (Claude Code)".
          const version = (probe.version ?? 'unknown version').replace(/\s*\([^)]*\)\s*$/, '');
          return { status: 'ok', message: `${adapter.displayName} ${version} · ${where} · ${sessions}`, detail };
        }),
      );
    }
  } finally {
    store?.close();
  }

  return { ok: checks.every((c) => c.status !== 'fail'), platform, checks };
}

export function renderDoctor(report: DoctorReport, t: Theme = PLAIN): string {
  const width = Math.max(...report.checks.map((c) => c.id.length));
  const tint = (c: Check) => (c.status === 'fail' ? t.fg('red', c.message) : c.status === 'warn' ? t.fg('amber', c.message) : c.message);
  const count = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
  const lines = [
    '',
    '  ' + rule(t, 'SYSTEM CHECK', 'cyan', Math.min(t.width, 78) - 2),
    '',
    ...report.checks.map((c) => `  ${statusIcon(t, c.status)} ${t.bold(c.id.padEnd(width))}  ${tint(c)}`),
    '',
    `  ${t.fg('lime', `${count('ok')}/${report.checks.length} online`)}  ${t.fg('gray', t.sym.dot)}  ${t.fg(count('warn') ? 'amber' : 'gray', `${count('warn')} warning(s)`)}  ${t.fg('gray', t.sym.dot)}  ${t.fg(count('fail') ? 'red' : 'gray', `${count('fail')} critical`)}`,
    report.ok
      ? `  ${t.bold(t.fg('lime', `${t.sym.ok} Ready to relay.`))}`
      : `  ${t.bold(t.fg('red', `${t.sym.fail} Blocking problems found; fix the lines marked ${t.sym.fail} above.`))}`,
    '',
  ];
  return lines.join('\n');
}
