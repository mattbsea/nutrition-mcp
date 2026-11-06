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
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 8080
# --smol runs Bun's GC more aggressively and grows the heap more slowly, keeping
# RSS low. Set TRUST_PROXY=1 when running behind a reverse proxy you control
# (the Home Assistant add-on does).
CMD ["bun", "--smol", "src/index.ts"]
