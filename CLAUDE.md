# LegacyApp

A 2D LegacyTheme-themed ElizaOS game. Users create an LegacyApp, walk it around a ClawVille map with WASD, and chat with AI agents inside buildings.

## IMPORTANT: ElizaOS is MANDATORY

**ElizaOS is a core requirement for this project - do NOT remove or stub it out.**

- All pet and location chat MUST use the ElizaOS runtime (`@legacyapp/agent-runtime`)
- The agent orchestrator MUST use `createElizaRuntime` from the agent-runtime package
- For deployment, use a platform that supports persistent servers (Railway, Render, Fly.io) - NOT Vercel serverless
- Never replace ElizaOS with direct API calls or stub implementations

## Tech Stack

- **Monorepo**: Turborepo + Bun
- **Frontend**: Next.js 14 (App Router), Phaser 3.80, Zustand, TanStack Query, TailwindCSS
- **Backend**: Hono 4.x on Bun
- **Database**: PostgreSQL + Drizzle ORM
- **AI Runtime**: ElizaOS 1.7.1 (plugin-anthropic, plugin-openai, plugin-bootstrap, plugin-sql)
- **Auth**: Lucia 3.x + Drizzle adapter

## Project Structure

```
legacyapp/
  apps/
    web/          # Next.js frontend + Phaser game (port 3000)
    api/          # Hono REST API (port 4000)
  packages/
    shared/       # Types, constants (species, colors, locations)
    database/     # Drizzle ORM schema + migrations
    agent-runtime/    # ElizaOS wrapper (adapted from eliza-kiz)
    agent-templates/  # 15 location character JSONs
  scripts/
    seed-locations.ts  # Seed map_locations table
```

## Package Naming

All packages use `@legacyapp/*` prefix (e.g. `@legacyapp/shared`, `@legacyapp/database`).

## Commands

```bash
bun install              # Install deps
bun run dev              # Start all (turbo)
bun run db:push          # Push schema to DB
bun run db:seed          # Seed 15 map locations
bun run db:studio        # Drizzle Studio
bun run build            # Build all
```

## Environment Variables

Required in `.env.local`:
- `DATABASE_URL` - PostgreSQL connection string
- `ANTHROPIC_API_KEY` - For ElizaOS TEXT_GENERATION
- `OPENAI_API_KEY` - For ElizaOS TEXT_EMBEDDING

## Architecture Notes

- **Phaser ↔ React bridge**: Zustand store (`stores/game.ts`). Phaser writes `petPosition` and `nearLocation`; React reads `currentLocation` and renders ChatPanel overlay.
- **Agent lifecycle**: Lazy-start on first chat message, auto-stop after 30min inactivity. Orchestrator in `apps/api/src/services/agent-orchestrator.ts`.
- **One pet per user**: Enforced by unique constraint on `pets.userId`.
- **Building zones**: 15 locations defined in `packages/shared/src/constants/map-locations.ts`, scaled 2x in Phaser.
- **Map**: `clawville-map.png` is 780x468, rendered at 2x (1560x936) in Phaser.

## Database Schema

- `users` + `sessions` (Lucia auth)
- `pets` (one per user, species/color/gender/personality/stats/position)
- `map_locations` (static, seeded - 15 buildings)
- `location_agents` (user's agent config per location)
- `platform_agents` (ElizaOS agent records)
- `platform_agent_logs`

## Code Style

- TypeScript strict mode throughout
- Bun as runtime for API, Next.js for web
- Kebab-case filenames, PascalCase components
- Zod validation on all API inputs
- `@/` path alias in web app, `@legacyapp/*` for packages
