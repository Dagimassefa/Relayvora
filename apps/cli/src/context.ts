import { claudeAdapter } from '@relayvora/adapter-claude';
import { codexAdapter } from '@relayvora/adapter-codex';
import { RelayvoraError, ExitCode, canonicalPath, dataDir, type AgentAdapter } from '@relayvora/core';
import { Store } from '@relayvora/storage';

export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  adapters: readonly AgentAdapter[];
}

export const BUILTIN_ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter];

export function createContext(overrides: Partial<CliContext> = {}): CliContext {
  const env = overrides.env ?? process.env;
  return {
    cwd: canonicalPath(overrides.cwd ?? process.cwd()),
    env,
    dataDir: overrides.dataDir ?? dataDir(env),
    adapters: overrides.adapters ?? BUILTIN_ADAPTERS,
  };
}

export function selectAdapters(ctx: CliContext, provider?: string): readonly AgentAdapter[] {
  if (!provider) return ctx.adapters;
  const adapter = ctx.adapters.find((a) => a.id === provider);
  if (!adapter) {
    const known = ctx.adapters.map((a) => a.id).join(', ');
    throw new RelayvoraError(`Unknown provider "${provider}". Supported: ${known}`, ExitCode.Usage);
  }
  return [adapter];
}

export function openStore(ctx: CliContext): Store {
  return Store.openInDir(ctx.dataDir);
}
