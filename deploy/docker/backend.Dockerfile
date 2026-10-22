# syntax=docker/dockerfile:1
# Durable backend: single SQLite writer, agent loop and model access (docs/deployment.md).
# Runtime image carries no secret: provider keys and tokens are runtime environment only.
#   docker build -f deploy/docker/backend.Dockerfile -t hepi-backend .

FROM node:24-bookworm-slim AS toolchain
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /app

# Install from the root lockfile only; workspace manifests must be present for the frozen-lockfile check.
FROM toolchain AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/gateway/package.json packages/gateway/
COPY packages/protocol/package.json packages/protocol/
COPY packages/session/package.json packages/session/
COPY patches patches
RUN --mount=type=cache,id=hepi-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @hepi/server...

FROM toolchain AS runtime
ENV NODE_ENV=production \
    HEPI_BIND_HOST=127.0.0.1 \
    PORT=8787 \
    HEPI_DB=/var/lib/hepi/hepi.sqlite \
    HEPI_SKILL_REPOSITORY=/var/lib/hepi/skill-repository.sqlite
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/gateway/package.json packages/gateway/
COPY packages/protocol/package.json packages/protocol/
COPY packages/session/package.json packages/session/
COPY patches patches
RUN --mount=type=cache,id=hepi-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @hepi/server...
# Sources are TypeScript and run directly on Node 24 type stripping (docs/deployment.md), so no build output is needed.
COPY apps/server apps/server
COPY packages packages
RUN install -d -o node -g node /var/lib/hepi
USER node
WORKDIR /app/apps/server
EXPOSE 8787
CMD ["node", "src/main.ts"]
