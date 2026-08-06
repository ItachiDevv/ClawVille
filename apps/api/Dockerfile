FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json tsconfig.json ./

# Copy all workspace packages (needed for workspace:* resolution)
COPY packages/ packages/
COPY apps/api/ apps/api/

# Install dependencies (includes workspace linking)
RUN bun install

# Build workspace packages — fail-fast on tsc errors. Previously used
# `bun run build || true`, which silently masked tsc failures and shipped
# corrupt dist/*.js that crashed the api at import time. `bunx tsc` fails
# the image build if the source doesn't compile — catch it at build, not
# at runtime.
RUN cd packages/shared && bunx tsc
RUN cd packages/database && bunx tsc
RUN cd packages/agent-templates && bunx tsc
RUN cd packages/agent-runtime && bunx tsc
# wager-program — added 2026-05-12 alongside the clawville_wager Anchor program.
# Consumed by apps/api/src/services/wager-program-client.ts via `main: ./dist/index.js`;
# missing this step crash-loops the api with "Cannot find module @clawville/wager-program".
RUN cd packages/wager-program && bunx tsc

EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=5s --start-period=60s --retries=3 CMD curl -fsS "http://127.0.0.1:${PORT:-4000}/health" || exit 1

# Run directly from source — bun handles TS natively
CMD ["bun", "run", "apps/api/src/index.ts"]
