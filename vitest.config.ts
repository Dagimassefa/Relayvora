import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./${pkg}/src/index.ts`, import.meta.url));

// Tests run against source, so no build step is needed before `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@agentrelay/core': src('packages/core'),
      '@agentrelay/storage': src('packages/storage'),
      '@agentrelay/git': src('packages/git'),
      '@agentrelay/adapter-claude': src('packages/adapter-claude'),
      '@agentrelay/adapter-codex': src('packages/adapter-codex'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
