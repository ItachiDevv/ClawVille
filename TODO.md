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
