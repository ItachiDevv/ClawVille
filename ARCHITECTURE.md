# ClawVille Architecture

## System Overview

```
Browser (Next.js)                         Hetzner CCX13 + Coolify
+--------------------------+              +--------------------------+
|  Next.js App Router      |              |  Hono API (Bun :4000)   |
|  +--------------------+  |   REST/SSE   |  +--------------------+ |
|  | World3DCanvas (R3F) |  | <---------> |  | Auth (Lucia)       | |
|  | Three.js WebGPU     |  |             |  | Agent Orchestrator | |
|  +--------------------+  |              |  | NPC Simulation     | |
|  +--------------------+  |              |  +--------------------+ |
|  | Zustand Stores      |  |              |  | ElizaOS Runtime    | |
|  | (game, npc)         |  |              |  | (Anthropic/OpenAI) | |
|  +--------------------+  |              |  +--------------------+ |
|  +--------------------+  |              |          |              |
|  | React UI Overlays   |  |              |  +--------------------+ |
|  | (chat, shop, HUD)  |  |              |  | PostgreSQL         | |
|  +--------------------+  |              |  | (Drizzle ORM)      | |
+--------------------------+              +--------------------------+
```

## Frontend Architecture

**Framework**: Next.js 14 (App Router) with React 19

**Entry point**: `apps/web/src/app/game/page.tsx` -- dynamically imports `World3DCanvas` (SSR disabled) and mounts all game UI overlays as React components.

**Key layers**:
- **3D Renderer**: `World3DCanvas.tsx` -- Three.js WebGPU via React Three Fiber 9
- **2D Fallback**: `PixiCanvas.tsx` -- PixiJS 8 for devices without WebGPU/WebGL2
- **UI Overlays**: Chat panel, shop, inventory, minimap, HUD, quest tracker, daily login
- **State**: Zustand stores bridge the 3D scene and React UI

## 3D Rendering Pipeline

**Renderer**: Three.js r182 imported from `three/webgpu` with WebGL2 fallback.

**R3F 9 integration**: WebGPU elements registered via `extend(THREE)` with custom JSX type declarations.

**Scene graph** (`World3DCanvas.tsx`):
1. `ArenaTerrain` -- Bikini Bottom GLB terrain + TSL sand material (ripples, grain, height roughness)
2. `ArenaBuildings` -- 10 GLB building models (SpongeBob-style) placed at building zone positions
3. `ArenaNpcs` -- GLB lobster NPCs with species color tinting, terrain following
4. `ArenaLocationNpcs` -- Dedicated NPC per building entrance, faces camera
5. `PlayerPet` -- Player's GLB lobster with WASD movement + terrain raycasting (Layer 1)
6. `MergedSeaweed` -- 3000 blades, 3 variants, TSL wind animation (merged geometry)
7. `UnderwaterAtmosphere` -- Caustics, depth backdrop, dust particles
8. `UnderwaterLightRays` -- 7 pulsing god ray shafts from surface
9. `ArenaFx` -- Additional visual effects

**Materials**: TSL (Three.js Shading Language) only -- node-based materials compatible with WebGPU renderer.

**Camera**: OrbitControls with WASD pan (Explore mode) or character follow (Player/NPC modes). Arrow keys rotate orbit azimuth/polar in all modes.

## GPU Constraints

Target hardware: **Intel Iris Xe** (integrated GPU).

Hard rules:
- No `InstancedMesh` + `ShaderMaterial` -- crashes WebGPU silently with no console errors
- No drei `Text` or `Billboard` -- crashes Intel Iris Xe, requires PC restart
- No per-frame `Object3D` allocation
- Max 3 lights (hemisphere + ambient + 1 directional)
- Keep draw calls under 100 (currently ~50)
- Use merged geometry instead of instancing for repeated objects
- TSL-only materials (no raw GLSL ShaderMaterial)
- GLB models preferred (1-2 draw calls each vs many for primitive meshes)

## Backend Architecture

**Runtime**: Bun with Hono 4.x HTTP framework.

**Route modules** (`apps/api/src/routes/`):
| Route | Purpose |
|-------|---------|
| `auth.ts` | Login, signup, logout (Lucia sessions) |
| `pets.ts` | Pet CRUD, pet chat, heartbeat, daily login |
| `locations.ts` | Location data |
| `chat.ts` | Location agent chat with dynamic context injection |
| `items.ts` | Shop browse, inventory, buy, learn |
| `openclaw.ts` | OpenClaw bot registration (override/avatar) |
| `npc-sse.ts` | Server-Sent Events for NPC simulation state |

**Agent Orchestrator** (`apps/api/src/services/agent-orchestrator.ts`):
- Lazy-starts ElizaOS agents on first chat message
- Auto-stops after 30 minutes of inactivity
- Uses `createElizaRuntime` from `@clawville/agent-runtime`
- Plugins: Anthropic (text generation), OpenAI (text embedding), Bootstrap, SQL

**NPC Simulation** (`apps/api/src/services/npc-simulation.ts`):
- Autonomous NPCs with pathfinding, conversations, and activities
- State streamed to clients via SSE

## Database Schema

PostgreSQL with Drizzle ORM (`packages/database/`).

| Table | Purpose |
|-------|---------|
| `users` / `sessions` | Lucia auth (email + password) |
| `pets` | One per user -- species, color, archetype, stats, position, neoTokens, login streak |
| `pet_inventory` | Knowledge books owned by pet (quantity tracking) |
| `map_locations` | 10 static building zones (seeded) |
| `location_agents` | Per-user agent config at each location |
| `platform_agents` | ElizaOS agent records |
| `platform_agent_logs` | Agent activity logs |

`pets.characterConfig` (JSONB) stores the full resolved archetype data including learned knowledge.

## State Management

Two Zustand stores bridge the 3D scene and React UI:

**`game.ts`** -- Player and world state:
- `controlMode`: `'explore' | 'npc' | 'player' | 'autonomous'`
- `petPosition`, `petSpeed`, `movementDirection`
- `nearLocation`, `currentLocation`, `chatOpen`
- `possessedNpcId`, `hasAgent`, `isSpectator`
- Building visit tracking (localStorage)

**`npc.ts`** -- NPC simulation state:
- Per-NPC: position, direction, species, color, HP, combat state, inventory
- Chat bubbles with expiration
- OpenClaw bot flags

## Control Modes

| Mode | WASD | Camera | Use Case |
|------|------|--------|----------|
| Explore | Pan camera | Free orbit | Browse world without a pet |
| Player | Move pet | Follows pet | Normal gameplay |
| NPC | Move possessed NPC | Follows NPC | Control any NPC |
| Autonomous | Disabled | Follows agent | Watch AI agent play |

Toggle via `ControlModeToggle` component. Without an agent: Explore/NPC. With an agent: Player/Autonomous.

## NPC Simulation

- 10 lobster NPCs wander the map with demo pathfinding
- Each building has a dedicated location NPC at its entrance
- NPCs have species, color tinting, HP, combat state, inventory
- Client-side wander system (`stores/npc.ts`) with configurable tick rate
- Server-side autonomous simulation with SSE streaming (currently disabled for GPU safety)

## Gamification (Planned)

| Feature | Description |
|---------|-------------|
| Skill Bazaar | Marketplace for buying/selling learned skills between players |
| Auction House | Timed auctions for skills and full agent configs |
| Quest Board | Team-posted coding bounties with token + skill rewards |
| Bounty Board | Community-posted coding bounties with reputation system |
| Agent Setup | WoW-style character select with talent tree visualization |

## NeoToken Economy

- Start with 100 tokens
- Daily login: `10 + streak * 5` tokens (max 100/day)
- Chat with building agents: +1 token per message
- Spend at shops: 20 knowledge books across 10 buildings
- Learning flow: buy book -> inventory -> "Read to Pet" -> knowledge merges into agent config

## Deployment

Self-hosted on a single **Hetzner CCX13** VPS (`87.99.142.34`, Ashburn) orchestrated by **Coolify** (self-hosted PaaS), with **Cloudflare** in front for DNS + CDN + DDoS protection. Two apps:

- **Web** (`apps/web/Dockerfile`): Next.js on port 3000 → `https://clawville.world`
- **API** (`apps/api/Dockerfile`): Hono on Bun on port 4000 → `https://api.clawville.world`

Database is **Supabase Postgres** (external — not hosted on the VPS). Environment variables are managed through Coolify's UI and encrypted at rest via Laravel's `Crypt` — bypassing the UI and writing to the `environment_variables` table directly WILL corrupt the encrypted payload, so always use the UI or the model's attribute assignment when writing programmatically.

Both apps auto-deploy from `git push origin master` via a GitHub webhook. Manual redeploys can be queued by SSHing into the VPS and running `queue_application_deployment` inside the Coolify artisan tinker (documented in `CLAUDE.md`). Full playbook for migration / rebuild is in `docs/DEPLOY-HETZNER.md`.

Testing rule: never run `bun run dev` locally — the Three.js/WebGPU scene crashes Intel Iris Xe and requires a PC restart. Always push → Coolify auto-deploys → test against the production URL.
