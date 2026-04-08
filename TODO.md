# ClawVille TODO

## CRITICAL RULES
- **NEVER run localhost for testing** — crashes Intel Iris Xe GPU, requires PC restart
- **Always push to git → Railway auto-deploys → test on production URL**
- Production URL: https://web-production-58aa7.up.railway.app/game
- API URL: https://api-production-e9f2.up.railway.app

## Current State
- WebGPU renderer active with WebGL2 fallback ✅
- GLB model buildings (SpongeBob style: Krusty Krab, Pineapple, Patrick's Rock, etc.) ✅
- GLB lobster NPCs with species color tinting ✅
- Bikini Bottom terrain GLB as sandy landscape ✅
- Terrain raycasting with Layer 1 isolation ✅
- Deployed to Railway ✅

## NEXT: Priority Issues

### 1. ~~NPCs not moving~~ DONE
- [x] Root cause: API SSE stream sending 10 idle NPCs overwriting client wander
- [x] Fix: disabled SSE stream, demo wander runs freely with 10 colorful lobsters

### 2. Location NPC models — unique character per building
Each building needs a dedicated NPC that stands in front and teaches the building's skill.
- [ ] Find/create 10 unique character GLB models (one per building theme)
- [ ] Possible sources: Sketchfab, ReadyPlayerMe, Mixamo characters
- [ ] Suggested characters per building:
  - cron-hub (Tide Clock): clockwork robot / old sailor
  - webhook-gateway (Krusty Krab): SpongeBob-style fry cook
  - memory-vault (Squidward's): librarian / scholar
  - skill-forge (Chum Bucket): blacksmith / mad scientist
  - channel-bridge (Shipwreck): pirate captain
  - tool-workshop (Submarine): mechanic / engineer
  - canvas-studio (Pineapple): artist / painter
  - voice-tower (Tower): bard / town crier
  - security-fortress (Rock): knight / guard
  - config-citadel (Seashell): wizard / sage
- [ ] Place each NPC at the entrance of their building using buildingZones positions
- [ ] Wire up interaction — clicking NPC opens the building's chat/shop
- File: create `apps/web/src/lib/three/arena-location-npcs.tsx`

### 3. ~~Ground texture + decorations~~ DONE
- [x] Procedural sand texture (canvas noise + ripples, tiled 24x16)
- [x] Replaced blue blob decorations with 12 coral-reef + kelp models

## DONE (this session)

### ~~Extend sandy terrain~~ DONE
- [x] Added sand plane (0xe8d5b0) at y=-6, MAP_WIDTH*3 x MAP_HEIGHT*3

### ~~Spread buildings apart~~ DONE
- [x] Repositioned all 10 buildingZones across full 40x25 grid

### ~~NPCs bigger~~ DONE
- [x] NPC_SCALE 4->8, speed 1.5->4, tick 200->100ms

### ~~Wire up underwater decorations~~ DONE
- [x] underwater-decorations.glb loaded + 8 clones scattered at map edges

### ~~Building edit mode~~ DONE
- [x] Visit /game?edit=1 to drag-and-drop buildings, copy positions

## Completed
- [x] WebGPU renderer with WebGL2 fallback
- [x] GLB model buildings replacing primitive geometry
- [x] GLB lobster NPCs replacing 30-mesh primitives
- [x] Bikini Bottom terrain replacing grey procedural sand
- [x] Terrain raycasting with layer isolation
- [x] SpongeBob building models downloaded (Krusty Krab, Pineapple, Patrick's Rock, Squidward's House, Chum Bucket)
- [x] Deploy to Railway (web + API)
- [x] GPU-safe scene (~50 draw calls, was 350+)

## Gameify — RPG/MMO Features

### 1. Skill Bazaar (Diablo/WoW/EverQuest themed)
A marketplace building where players/agents buy and sell skills.
- [ ] Bazaar building in the 3D world (dedicated zone, maybe Sandy's Treedome or new building)
- [ ] Browse skills by category, rarity, price — RPG-style item cards with stats
- [ ] Sellers list skills they've earned from buildings (knowledge books = inventory items)
- [ ] Buyers spend ClawTokens to purchase — seller gets paid
- [ ] Rarity tiers: Common (free lessons), Rare (building-specific), Epic (quest rewards), Legendary (bounty completions)
- [ ] Visual: glowing item pedestals, particle effects per rarity, haggle animations
- [ ] DB: `skill_listings` table (sellerId, skillId, price, rarity, listedAt)
- [ ] API: GET /bazaar/listings, POST /bazaar/list, POST /bazaar/buy

### 2. Auction House for Skills & Agents
Timed auctions where agents and skills go to highest bidder.
- [ ] Auction house building in the world
- [ ] List a skill or full agent config for auction (starting bid, duration)
- [ ] Real-time bidding with countdown timer
- [ ] Snipe protection (extends timer if bid in last 30s)
- [ ] "Buy Now" option at premium price
- [ ] Agent auctions: sell a fully configured agent (character + all learned skills)
- [ ] History log of past auctions and price trends
- [ ] DB: `auctions` table (sellerId, itemType, itemId, startBid, currentBid, bidderId, endsAt)
- [ ] API: GET /auctions, POST /auctions/create, POST /auctions/bid
- [ ] WebSocket or SSE for live bid updates

### 3. Quest NPC — Coding Bounties
A quest-giver NPC that posts coding bounties from the ClawVille team. Completing quests earns native tokens + exclusive skills.
- [ ] Quest board building/NPC in the world (town center or dedicated building)
- [ ] Quests = real coding tasks/bounties posted by the team
- [ ] Reward structure: native token amount + exclusive skill (like getting a legendary item from a raid boss)
- [ ] Quest tiers: Side Quest (small tasks, 10-50 tokens), Main Quest (features, 100-500 tokens + rare skill), Legendary Quest (major milestones, 1000+ tokens + legendary skill + title)
- [ ] Quest status: Available → Accepted → In Progress → Review → Complete/Failed
- [ ] Submission: link to PR/commit, verified by team or automated tests
- [ ] Quest log UI: active quests, completed quests, rewards earned
- [ ] DB: `quests` table, `quest_submissions` table, `quest_rewards` table
- [ ] API: GET /quests, POST /quests/accept, POST /quests/submit

### 4. Agent Setup Screen (WoW Character Select)
Before entering the world, players choose/configure which agent to bring in.
- [ ] Full-screen character select UI (3D model preview, rotating platform, spotlight)
- [ ] Choose from: new blank agent, pre-configured archetypes, previously saved agents
- [ ] Agent stats display: skills learned, knowledge areas, level, token balance
- [ ] "Talent tree" style skill visualization showing what the agent knows
- [ ] Loadout system: equip skills before entering (limited skill slots like ability bars)
- [ ] Import/export agent configs (JSON or on-chain)
- [ ] Visual: dramatic lighting, particle effects, "Enter World" button with animation
- [ ] Route: /select-agent (before /game)

### 5. Bounty Board — Community Coding Bounties
An open board where anyone (AI agents or humans) can post coding bounties for others to complete.
- [ ] Bounty board building in the world (notice board visual with pinned tasks)
- [ ] Anyone can post a bounty: title, description, requirements, reward
- [ ] Minimum reward: must include native token (ensures skin in the game)
- [ ] Bonus rewards: poster can add new AI agent configs, new skills, NFTs, etc.
- [ ] AI agents can autonomously browse, accept, and attempt bounties
- [ ] Reputation system: completion rate, quality score, earnings history
- [ ] Dispute resolution: poster approves/rejects, escalation to DAO vote
- [ ] Featured bounties: team-promoted bounties get visibility boost
- [ ] DB: `bounties` table, `bounty_attempts` table, `bounty_rewards` table
- [ ] API: GET /bounties, POST /bounties/create, POST /bounties/accept, POST /bounties/submit, POST /bounties/approve

## Later
- [ ] Remove ground plane squares from building GLB models (the pineapple has a visible sand square)
- [ ] Custom domain for web
- [ ] Fix API NPC conversations (Anthropic API key not resolving in Railway)
- [ ] Building proximity interactions (enter building on approach)
- [ ] Minimap showing NPC positions
- [ ] Better camera follow for logged-in player
- [ ] Add more SpongeBob-style buildings (Sandy's Treedome, etc.)

## GPU Performance Rules
- NEVER use Text/Billboard from drei (crashes Intel Iris Xe)
- NEVER test locally — always deploy to Railway
- Keep total draw calls under 100
- Use GLB models (1-2 draw calls each) not primitive meshes
- WebGPU renderer is active (import from three/webgpu)
- No per-frame Object3D allocation
- Max 3 lights (hemisphere + ambient + 1 directional)
- Prefer MeshBasicMaterial where lighting isn't needed

## Key Files
- `apps/web/src/components/three/World3DCanvas.tsx` — Canvas + WebGPU + camera
- `apps/web/src/lib/three/arena-terrain.tsx` — Bikini Bottom GLB terrain
- `apps/web/src/lib/three/arena-buildings.tsx` — GLB building loader + raycasting
- `apps/web/src/lib/three/arena-npcs.tsx` — GLB lobster NPCs + terrain following
- `apps/web/src/lib/three/player-avatar.tsx` — GLB lobster player + terrain following
- `apps/web/src/stores/npc.ts` — Demo NPC wander system
- `apps/web/src/lib/pixi/tilemap-data.ts` — Building zone positions (buildingZones)
