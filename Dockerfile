# Pinned to the Bun release the code was built and tested with: the SQLite layer
# needs bun:sqlite's Database#function and Transaction#immediate, and SQLite
# >= 3.37 for STRICT tables (src/db/migrate.ts checks this at startup).
FROM oven/bun:1.4.4
# The app never relies on the process time zone; timestamps are UTC.
ENV TZ=UTC
ENV NODE_ENV=production
# All state (SQLite database, keys.json, export archives) lives under DATA_DIR.
ENV DATA_DIR=/data
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
# Runtime user: ROOT, on purpose. Home Assistant mounts the add-on's /data as a
# root-owned directory, and add-ons conventionally run as root inside their own
# container (the container is the isolation boundary, not the uid). A baked-in
# `USER bun` + `chown bun /data` cannot work there: the chown applies to the
# image layer, which the mount then hides, and the bun user could not write the
# volume. The server creates DATA_DIR itself (0700) and every file in it
# (database, WAL, keys.json) as 0600, whoever it runs as, so nothing in /data
# is readable by another account.
# Plain Docker users who want an unprivileged process can run
#   docker run --user 1000:1000 -v "$PWD/data:/data" ...
# with ./data owned by that uid; the server needs nothing else.
VOLUME /data
EXPOSE 8080
# --smol runs Bun's GC more aggressively and grows the heap more slowly, keeping
# RSS low. Set TRUST_PROXY=1 when running behind a reverse proxy you control
# (the Home Assistant add-on does).
CMD ["bun", "--smol", "src/index.ts"]
