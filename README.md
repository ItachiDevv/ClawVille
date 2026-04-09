# ClawVille

A sea-themed 3D game built on ElizaOS where players explore an underwater world, chat with AI agents, and learn OpenClaw agent development through gamified knowledge books.

![ClawVille](WorldImprove.jpg)

## Features

- **Underwater 3D World** -- WebGPU-rendered sea floor with GLB buildings, terrain, seaweed, god rays, and caustics
- **AI Agents** -- 10 building NPCs powered by ElizaOS that teach OpenClaw agent development concepts
- **Knowledge Books** -- 20 books across 10 buildings; buy, read to your pet, and grow its skill set
- **ClawToken Economy** -- Earn tokens through daily logins, chat, and quests; spend them at shops
- **NPC Simulation** -- Autonomous lobster NPCs with pathfinding, conversations, and activities
- **Pet System** -- 14 archetypes, species/color customization, personality, and stats
- **Control Modes** -- Explore, NPC possession, Player, and Autonomous camera modes
- **Gamification** -- Skill Bazaar, Auction House, Quest Board, Bounty Board (planned)

## Tech Stack

| Layer | Tech |
|-------|------|
| Monorepo | Turborepo + Bun |
| Frontend | Next.js 14 (App Router), Three.js r182 WebGPU + R3F 9, Zustand, TanStack Query, TailwindCSS |
| 2D Fallback | PixiJS 8 |
| Backend | Hono 4.x on Bun |
| Database | PostgreSQL + Drizzle ORM |
| AI Runtime | ElizaOS 1.7.1 (Anthropic + OpenAI plugins) |
| Auth | Lucia 3.x + Drizzle adapter |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- PostgreSQL database
- Anthropic API key (text generation)
- OpenAI API key (text embedding)

### Installation

```bash
bun install

# Create .env.local with required variables
cp .env.example .env.local
```

Required environment variables in `.env.local`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/clawville
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

```bash
bun run db:push          # Push schema to database
bun run db:seed          # Seed 10 map locations
bun run dev              # Start all services (web :3000, api :4000)
```

### Commands

| Command | Description |
|---------|-------------|
| `bun install` | Install dependencies |
| `bun run dev` | Start all services (turbo) |
| `bun run build` | Build all packages |
| `bun run db:push` | Push schema to database |
| `bun run db:seed` | Seed 10 map locations |
| `bun run db:studio` | Open Drizzle Studio |

## Project Structure

```
ClawVille/
  apps/
    web/                # Next.js frontend + 3D/2D game (port 3000)
    api/                # Hono REST API (port 4000)
  packages/
    shared/             # Types, constants (species, colors, locations)
    database/           # Drizzle ORM schema + migrations
    agent-runtime/      # ElizaOS wrapper
    agent-templates/    # 10 location character templates
  scripts/
    seed-locations.ts   # Seed map_locations table
```

## Controls

| Input | Action |
|-------|--------|
| WASD | Move character / pan camera (Explore mode) |
| Arrow Keys | Rotate camera orbit |
| Click building | Enter building zone |
| Click NPC | Open chat |

### Control Modes

- **Explore** -- Free camera pan with WASD, no character
- **Player** -- WASD moves your pet, camera follows
- **NPC** -- Possess nearest NPC, WASD overrides its movement
- **Autonomous** -- Agent moves on its own, camera follows

## 10 Sea-Themed Buildings

Each building has a dedicated AI agent NPC and sells 2 knowledge books focused on OpenClaw topics:

| Building | Theme |
|----------|-------|
| Tide Clock Grotto | Cron jobs, task scheduling |
| Current Gateway | Webhooks, HTTP endpoints |
| Abyssal Vault | Vector memory, LanceDB |
| Hydrothermal Forge | ClawHub marketplace skills |
| Coral Bridge | Multi-channel messaging |
| Salvage Workshop | Tool/plugin development |
| Biolume Studio | Live canvas visualization |
| Echo Spire | Voice/speech integration |
| Shell Fortress | Security, permissions |
| Nautilus Citadel | Configuration, deployment |

## Documentation

- [CLAUDE.md](CLAUDE.md) -- Full project specification and developer reference
- [ARCHITECTURE.md](ARCHITECTURE.md) -- System architecture and design decisions
- [TODO.md](TODO.md) -- Roadmap, current tasks, and completed work

## Deployment

Deployed to [Railway](https://railway.app/) with separate services for web and API. Each app has its own Dockerfile in `apps/web/` and `apps/api/`.

Production URLs:
- Web: `https://web-production-58aa7.up.railway.app/game`
- API: `https://api-production-e9f2.up.railway.app`

## License

MIT
