# ElizaPets

A 2D Neopets-themed game powered by ElizaOS. Create your own ElizaPet, explore Neopia Central with WASD controls, and chat with AI agents inside buildings.

## Tech Stack

| Layer | Tech |
|-------|------|
| Monorepo | Turborepo + Bun |
| Frontend | Next.js 14 (App Router), Phaser 3.80, Zustand, TanStack Query, TailwindCSS |
| Backend | Hono 4.x on Bun |
| Database | PostgreSQL + Drizzle ORM |
| AI Runtime | ElizaOS 1.7.1 |
| Auth | Lucia 3.x + Drizzle adapter |

## Project Structure

```
elizapets/
  apps/
    web/              # Next.js frontend + Phaser game (port 3000)
    api/              # Hono REST API (port 4000)
  packages/
    shared/           # Types, constants (species, colors, locations)
    database/         # Drizzle ORM schema + migrations
    agent-runtime/    # ElizaOS wrapper
    agent-templates/  # 15 location character JSONs
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- PostgreSQL database

### Installation

```bash
# Install dependencies
bun install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your values

# Push database schema
bun run db:push

# Seed map locations
bun run db:seed

# Start development servers
bun run dev
```

### Environment Variables

Create a `.env.local` file with:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/elizapets
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

## Commands

| Command | Description |
|---------|-------------|
| `bun install` | Install dependencies |
| `bun run dev` | Start all services (turbo) |
| `bun run build` | Build all packages |
| `bun run db:push` | Push schema to database |
| `bun run db:seed` | Seed 15 map locations |
| `bun run db:studio` | Open Drizzle Studio |

## Architecture

### Phaser ↔ React Bridge

Zustand store (`stores/game.ts`) bridges the Phaser game and React UI:
- Phaser writes `petPosition` and `nearLocation`
- React reads `currentLocation` and renders the ChatPanel overlay

### Agent Lifecycle

- Agents lazy-start on first chat message
- Auto-stop after 30 minutes of inactivity
- Orchestrator: `apps/api/src/services/agent-orchestrator.ts`

### Map

- Base image: `neopia-central-map.png` (780x468)
- Rendered at 2x scale (1560x936) in Phaser
- 15 building zones defined in `packages/shared/src/constants/map-locations.ts`

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` / `sessions` | Lucia auth |
| `pets` | One per user (species, color, stats, position) |
| `map_locations` | 15 static buildings (seeded) |
| `location_agents` | User's agent config per location |
| `platform_agents` | ElizaOS agent records |
| `platform_agent_logs` | Agent activity logs |

## License

MIT
