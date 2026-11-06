# Security

This is a personal, self-hosted service that holds health data and is reachable
from the internet behind a reverse proxy. The threat model and the controls:

- **Access** is a long random key in the MCP URL path, compared in constant
  time, with a generic 404 for anything else and an escalating per-address ban
  after repeated failures. Treat the URL like a password; rotate it by changing
  `MCP_KEY` (or deleting `mcp_key` from `DATA_DIR/keys.json`) and restarting.
- **Secrets** are never logged or returned. `DATA_DIR/keys.json` is mode 600.
- **Input** is validated at the tool boundary; every SQL statement uses bound
  parameters; request bodies are capped at 1 MiB; CORS is closed.
- **Headers:** `nosniff`, `X-Frame-Options: DENY`, a strict CSP, `no-referrer`,
  `no-store`, and HSTS over https.
- **No third-party scripts or CDNs.**

Please report vulnerabilities privately to the repository owner rather than in a
public issue. This project is a fork of
[akutishevsky/nutrition-mcp](https://github.com/akutishevsky/nutrition-mcp); the
upstream service's policies do not apply to it.

## Runtime user and file permissions

The image runs as root, like Home Assistant add-ons in general: `/data` is a
root-owned mount, and the container is the isolation boundary. The server
creates `DATA_DIR` as 0700 and the database, its `-wal`/`-shm` files and
`keys.json` as 0600 (umask 077 at start-up), so no other account sees them.
Outside Home Assistant you can run it unprivileged with
`docker run --user 1000:1000 -v "$PWD/data:/data" ...` on a directory that uid owns.
