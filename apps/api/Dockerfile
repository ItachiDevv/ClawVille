FROM oven/bun:1
WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json tsconfig.json ./

# Copy all workspace packages (needed for workspace:* resolution)
COPY packages/ packages/
COPY apps/api/ apps/api/

# Install dependencies (includes workspace linking)
RUN bun install

# Build workspace packages (database, shared, agent-runtime, agent-templates)
RUN cd packages/shared && bun run build || true
RUN cd packages/database && bun run build || true
RUN cd packages/agent-templates && bun run build || true
RUN cd packages/agent-runtime && bun run build || true

EXPOSE 4000

# Run directly from source — bun handles TS natively
CMD ["bun", "run", "apps/api/src/index.ts"]
