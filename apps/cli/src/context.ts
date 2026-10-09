import path from 'node:path';
import { claudeAdapter } from '@agentrelay/adapter-claude';
import { codexAdapter } from '@agentrelay/adapter-codex';
import { AgentRelayError, ExitCode, dataDir, type AgentAdapter } from '@agentrelay/core';
import { Store } from '@agentrelay/storage';

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
    cwd: path.resolve(overrides.cwd ?? process.cwd()),
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
    throw new AgentRelayError(`Unknown provider "${provider}". Supported: ${known}`, ExitCode.Usage);
  }
  return [adapter];
}

export function openStore(ctx: CliContext): Store {
  return Store.openInDir(ctx.dataDir);
}
