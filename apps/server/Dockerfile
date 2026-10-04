# Build context: repository root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @margin/server --workspace @margin/web --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
COPY skills skills
RUN npm run build -w @margin/web

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
# Same uid as the compile sandbox's user, so both can read and write the build copies.
RUN useradd --create-home --uid 10001 margin && mkdir -p /data && chown margin:margin /data
USER margin
WORKDIR /app/apps/server
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/index.ts"]
