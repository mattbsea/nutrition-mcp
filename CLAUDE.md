# food-mcp (fork of nutrition-mcp for Home Assistant)

Bun + Hono + `bun:sqlite`. One process, one user, one container. MIT; keep the
upstream copyright notice in LICENSE.

## Map

- `src/index.ts` — HTTP app (`createApp`): access log, secure headers, body
  limit, shutdown gate, `/mcp/:key`, `/exports/download`, the health-sync router,
  generic 404. Boot only runs when it is the entrypoint.
- `src/perimeter.ts` — client IP (`TRUST_PROXY`), key guard, ban, log redaction.
- `src/keys.ts` — `DATA_DIR/keys.json` (mcp key, export secret).
- `src/mcp.ts` — all 53 tools (`registerTools`), server instructions, the MCP
  handler. Errors go through `src/tool-runner.ts` (`runTool`).
- `src/db/` — the SQLite layer: `schema.ts` (append-only `MIGRATIONS`),
  `migrate.ts` (`openDb`), `repo.ts` (everything callers import), per-area files.
- `src/export.ts`, `src/export-files.ts` — ZIP build, files, signed links.
- `src/health-sync.ts` (pure hourly model), `health-sync-status.ts` (plan + dashboard
  status), `health-sync-routes.ts` (bearer-key API), `db/health-store.ts` (ledger).
  See docs/apple-health-shortcuts.md.
- `public/widgets/` — the in-chat MCP widgets.

## Rules

- Never edit a shipped migration; append a new one in `src/db/schema.ts`.
- Every repo query keeps `user_id = ?`. Parameterised SQL only.
- Never log or return a key. The access log prints `/mcp/[redacted]`.
- Tests: `bun test`, in-memory SQLite (`useMemoryDb()` from
  `src/db/test-helpers.ts`). `src/mcp.test.ts` mocks `./db/repo.js` for its
  call-witness assertions; `src/mcp-sqlite.test.ts` drives the tools on the real
  repository.
- `bun run typecheck` and `bun run format:check` must be clean.
