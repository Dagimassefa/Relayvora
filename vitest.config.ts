import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./${pkg}/src/index.ts`, import.meta.url));

// Tests run against source, so no build step is needed before `pnpm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@relayvora/core': src('packages/core'),
      '@relayvora/storage': src('packages/storage'),
      '@relayvora/git': src('packages/git'),
      '@relayvora/adapter-claude': src('packages/adapter-claude'),
      '@relayvora/adapter-codex': src('packages/adapter-codex'),
      '@relayvora/adapter-opencode': src('packages/adapter-opencode'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    // Slow Windows CI runners can take over the 10s default just to set up fixtures (e.g. SQLite).
    hookTimeout: 30_000,
    // Tests never reach the npm registry; update-check tests inject their own fetch.
    env: { RELAYVORA_NO_UPDATE_CHECK: '1' },
  },
});
