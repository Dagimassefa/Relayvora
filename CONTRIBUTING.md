# Contributing

1. Node 22.13+ and pnpm 10: `pnpm install`, `pnpm test`, `pnpm build`.
2. Keep business logic in `packages/*`. The CLI only parses flags and renders output.
3. Cross-platform rules: use `path`/`fs` APIs only, with no hard-coded `/home` or drive letters. Use
   `runCommand` (never `shell: true`). Test paths that contain spaces and non-ASCII characters.
4. New agent integrations implement `AgentAdapter` from `@agentrelay/core`. Add synthetic fixtures under
   `fixtures/<provider>/`, never real transcripts.
5. Database changes go in a **new** migration in `packages/storage/src/migrations.ts`. Never edit a released one.
6. Never claim a fact is verified without evidence (see `docs/architecture/overview.md`).
