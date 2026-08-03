FROM node:20-alpine AS base

RUN apk add --no-cache curl

# Install bun
RUN npm install -g bun

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json tsconfig.json ./
# Vendored npm tarballs (packages pulled from the registry — see vendor/npm/README.md)
COPY vendor/ vendor/

# Copy all workspace packages + web app
COPY packages/ packages/
COPY apps/web/ apps/web/

# Install dependencies
RUN bun install

# Build workspace packages — fail-fast on tsc errors. Previously used
# `bun run build || true`, which silently masked tsc failures and shipped
# corrupt dist. See apps/api/Dockerfile for the full incident notes.
RUN cd packages/shared && bunx tsc
RUN cd packages/database && bunx tsc
RUN cd packages/agent-templates && bunx tsc
RUN cd packages/agent-runtime && bunx tsc

# Build Next.js
ARG NEXT_PUBLIC_API_URL
ARG SOURCE_COMMIT
ARG NEXT_PUBLIC_SOURCE_COMMIT
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV NEXT_PUBLIC_SOURCE_COMMIT=$NEXT_PUBLIC_SOURCE_COMMIT

RUN cd apps/web && bun run build

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=3 CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["bun", "run", "--cwd", "apps/web", "start"]
