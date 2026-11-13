# syntax=docker/dockerfile:1.7
#
# RecoverX licence server — container image.
#
# Build from the REPOSITORY ROOT (the build needs src/shared and src/server):
#
#   docker build -f deploy/license-server/Dockerfile -t recoverx-license-server .
#
# Run (see docs/LICENSE-SERVER.md for the full walkthrough):
#
#   docker run -d --name recoverx-licensing --restart unless-stopped \
#     -p 127.0.0.1:8787:8787 \
#     -v recoverx-licensing-data:/data \
#     -v /etc/recoverx/license-signing-key.pem:/run/secrets/license_signing_key:ro \
#     -e LICENSE_SIGNING_KEY_FILE=/run/secrets/license_signing_key \
#     -e RECOVERX_LICENSE_PUBLIC_KEY=MCowBQYDK2VwAyEA... \
#     -e LICENSE_TRUST_PROXY=true \
#     recoverx-license-server
#
# The signing key is NEVER baked into the image. It arrives at run time as a
# mounted secret file (preferred) or the LICENSE_SIGNING_KEY variable, and the
# Dockerfile-specific ignore file next to this one keeps *.pem out of the build
# context altogether.

ARG NODE_VERSION=24

# --- build ------------------------------------------------------------------
# Bundles the server and admin CLI into dist/license-server/*.mjs. Everything
# the runtime needs (zod included) ends up in those files.
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src

# The repository's dev dependencies include Electron and its tooling. Install
# scripts are skipped so none of that downloads binaries it will never use;
# the server build needs only Vite and zod from this install.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    HUSKY=0
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig*.json server.vite.config.ts ./
COPY src/shared ./src/shared
COPY src/server ./src/server
COPY src/main/database/sqlite.ts ./src/main/database/sqlite.ts
RUN npm run licensing:build

# --- runtime ----------------------------------------------------------------
# Only Node and two bundled files: no node_modules, no package manager state.
# node:sqlite is compiled into Node itself, so there is nothing native to add.
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LICENSE_DB_FILE=/data/license-server.db

WORKDIR /app
COPY --from=build /src/dist/license-server/ ./

# The image's built-in unprivileged `node` user (uid 1000) owns the data volume
# and nothing else; the application files stay root-owned and read-only to it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8787

# Node 24 has fetch built in, so the health check needs no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The server drains in-flight requests on SIGTERM and exits within ten seconds;
# `docker stop` waits ten by default, so nothing is cut off mid-transaction.
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "server.mjs"]
