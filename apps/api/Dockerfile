FROM oven/bun:1.3.11
WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json tsconfig.json ./

# Copy all workspace packages (needed for workspace:* resolution)
COPY packages/ packages/
COPY apps/api/ apps/api/

# Install dependencies (includes workspace linking)
RUN bun install

# Build workspace packages — use bunx tsc directly (bun 1.3.13 has a bun-run-tsc
# regression that mangles string literals during build; pinning to 1.3.11 + direct
# bunx invocation sidesteps both issues). Fail build on real tsc errors so dist is
# never corrupted silently.
RUN cd packages/shared && bunx tsc
RUN cd packages/database && bunx tsc
RUN cd packages/agent-templates && bunx tsc
RUN cd packages/agent-runtime && bunx tsc

EXPOSE 4000

# Run directly from source — bun handles TS natively
CMD ["bun", "run", "apps/api/src/index.ts"]
