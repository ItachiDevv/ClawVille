FROM node:20-alpine AS base

# Install bun
RUN npm install -g bun

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock turbo.json tsconfig.json ./

# Copy all workspace packages
COPY packages/ packages/
COPY apps/web/ apps/web/

# Install dependencies
RUN bun install

# Build workspace packages first
RUN cd packages/shared && bun run build || true
RUN cd packages/database && bun run build || true

# Build Next.js
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN cd apps/web && bun run build

EXPOSE 3000

CMD ["bun", "run", "--cwd", "apps/web", "start"]
