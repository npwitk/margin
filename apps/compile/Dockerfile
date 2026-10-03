# Build context: repository root.
ARG TEXLIVE_IMAGE=texlive/texlive:latest-full

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/compile/package.json apps/compile/
RUN npm ci --workspace @margin/compile --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/compile apps/compile

FROM ${TEXLIVE_IMAGE}
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app /app
RUN useradd --create-home --uid 10001 tex
USER tex
WORKDIR /app/apps/compile
ENV DATA_DIR=/data PORT=8788 HOME=/tmp
EXPOSE 8788
CMD ["node", "--import", "tsx", "src/index.ts"]
