# food-mcp

A single-container, self-hosted MCP server for personal nutrition tracking: log
meals and macros, look up foods (USDA FoodData Central, Open Food Facts), track
water, weight, body measurements and goals, and review trends, all through
Claude (or any MCP client). It is a fork of
[akutishevsky/nutrition-mcp](https://github.com/akutishevsky/nutrition-mcp),
rebuilt to run as one container (a Home Assistant add-on) with SQLite storage and
no external services.

Licensed MIT. The upstream copyright notice is kept in [LICENSE](LICENSE).

## Status

Work in progress on branch `ha-addon`. What exists today:

| Piece                                                     | State                                   |
| --------------------------------------------------------- | --------------------------------------- |
| MCP server (53 tools, in-chat widgets)                    | working, secret-path access             |
| SQLite storage (`DATA_DIR/nutrition.db`)                  | working                                 |
| Export (`export_all_data` → ZIP, signed short-lived link) | working                                 |
| Apple Health shortcut API (`/api/v1/health-sync/*`)       | answers `501 not_available_yet`         |
| Dashboard at `/`                                          | not built; `/` answers a plain 404 JSON |
| Home Assistant add-on packaging                           | not built                               |

## How access works

There is exactly one user and one credential per surface:

- **MCP:** `https://<host>/mcp/<key>`. The key is a long random secret in the
  URL path (the same pattern as the Home Assistant and Portainer MCP servers).
  There is no token exchange, no sign-in and no account. Add it in Claude as a custom
  connector URL.
    - `MCP_KEY` sets the key. If unset, 48 random bytes (base64url) are generated
      once and saved to `DATA_DIR/keys.json` (mode 600). The startup log prints
      one line saying where to read it, never the key itself.
    - A wrong or missing key gets the same generic `404 {"error":"not_found"}`
      as any unknown route, decided before the request body is read. The compare
      is constant time. Repeated failures from one address earn a `429` with an
      escalating `Retry-After`.
    - The key never appears in logs (the access log prints `/mcp/[redacted]`,
      and every console line is scrubbed as a backstop) or in any response.
- **Apple Health shortcuts:** `Authorization: Bearer <shortcut key>` on
  `/api/v1/health-sync/*`. A separate secret from the MCP key (`SHORTCUT_KEY`, or
  generated once into `DATA_DIR/keys.json` as `shortcut_key`), compared in
  constant time, never accepted in a URL, with a generic 401 and the same
  per-address failure ban. The shortcut build guide, the hourly design and a
  test checklist are in [docs/apple-health-shortcuts.md](docs/apple-health-shortcuts.md);
  `scripts/health-sync-curl.sh` exercises every route without a phone.
- **Export download:** `export_all_data` writes the ZIP under
  `DATA_DIR/exports` and returns `/exports/download?exp=…&sig=…`, an
  HMAC-signed link valid for 60 minutes. Archives older than that are deleted
  at startup and hourly; `delete_account` removes them too.

## Configuration

See [.env.example](.env.example). The ones that matter:

| Variable                         | Meaning                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`                       | Where everything lives (`nutrition.db`, `keys.json`, `exports/`). Default `./data`, `/data` in the container.                                                                                                                                                   |
| `MCP_KEY`                        | The MCP path key (≥ 32 chars, letters, digits, `-`, `_`). Generated and persisted when unset.                                                                                                                                                                   |
| `TRUST_PROXY`                    | `1` behind a reverse proxy you control: failure counting uses the rightmost `X-Forwarded-For` entry and `X-Forwarded-Host`/`-Proto` build the advertised URLs (HSTS, icons). Otherwise those headers are ignored. `PUBLIC_URL` overrides the advertised origin. |
| `PUBLIC_URL`                     | Public origin, used to build the export link the tool returns.                                                                                                                                                                                                  |
| `USDA_API_KEY`, `OFF_USER_AGENT` | Food lookups. Open Food Facts requires a User-Agent with a contact.                                                                                                                                                                                             |
| `PORT`, `HOST`                   | Listen address (`8080`, `0.0.0.0`).                                                                                                                                                                                                                             |

## Run

```sh
bun install
MCP_KEY=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n') bun start
# then: POST http://localhost:8080/mcp/<key>
```

Container: `docker build -t food-mcp .` (pinned to `oven/bun:1.4.4`; the SQLite
layer needs `bun:sqlite`'s `Database#function` and `Transaction#immediate`, and
SQLite ≥ 3.37 for STRICT tables — checked at startup).

## Storage

SQLite in WAL mode, one process, one connection. 16 tables, versioned
migrations (`PRAGMA user_version`), STRICT tables with CHECK constraints, and a
`user_id` predicate in every query (there is no row-level security to lean on;
the only owner is `local-owner`). Take backups with `VACUUM INTO` or after
`PRAGMA wal_checkpoint(TRUNCATE)`; a plain file copy of a running database can
miss committed data. External tools should open the file read-only.

## Development

```sh
bun test            # whole suite, in-memory SQLite
bun run typecheck
bun run format:check
```

Tests must never open the on-disk database: `getDb()` refuses to under
`NODE_ENV=test` unless a test installed one with `setDb(openDb(":memory:"))`.
