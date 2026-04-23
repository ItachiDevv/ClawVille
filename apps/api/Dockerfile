FROM oven/bun:1
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

EXPOSE 4000

# Run directly from source — bun handles TS natively
CMD ["bun", "run", "apps/api/src/index.ts"]
