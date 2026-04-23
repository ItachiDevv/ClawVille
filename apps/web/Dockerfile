FROM node:20-alpine AS base

# Pin bun to 1.3.11 — bun 1.3.13 has a bun-run-tsc regression that mangles
# string literals during package builds (channel-bridge.ts etc produce corrupt
# dist output). Stay on 1.3.11 until confirmed fixed upstream.
RUN npm install -g bun@1.3.11

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json tsconfig.json ./

# Copy all workspace packages + web app
COPY packages/ packages/
COPY apps/web/ apps/web/

# Install dependencies
RUN bun install

# Build ALL workspace packages (web imports from all of them) — use bunx tsc
# directly, fail-on-error, so corrupt dist never ships silently.
RUN cd packages/shared && bunx tsc
RUN cd packages/database && bunx tsc
RUN cd packages/agent-templates && bunx tsc
RUN cd packages/agent-runtime && bunx tsc

# Build Next.js
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN cd apps/web && bun run build

EXPOSE 3000

CMD ["bun", "run", "--cwd", "apps/web", "start"]
