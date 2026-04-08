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

## NEXT: Fix These 4 Issues (in order)

### 1. BIGGEST: Extend sandy terrain
The Bikini Bottom GLB has a small sandy patch — everything outside is dark ocean floor.
- [ ] Add a large sand-colored plane (color ~0xe8d5b0) UNDER the Bikini Bottom GLB
- [ ] Make it cover the entire map area (MAP_WIDTH * 3 x MAP_HEIGHT * 3)
- [ ] Position at y=-6 or lower so it sits just below the Bikini Bottom terrain
- [ ] This way the sandy patch blends into more sand, not dark void
- File: `apps/web/src/lib/three/arena-terrain.tsx`

### 2. Spread buildings apart
Buildings are clustered too close together — hard to distinguish them.
- [ ] Adjust building zone positions in `apps/web/src/lib/pixi/tilemap-data.ts` (buildingZones array)
- [ ] Spread the x,y tile coordinates further apart
- [ ] Current map is 40x25 tiles — use more of that space
- [ ] Consider reducing building count visible at once or making the map larger

### 3. NPCs bigger + actually moving
NPCs are tiny dots and appear stationary.
- [ ] Increase NPC_SCALE from 4 to 8 in `apps/web/src/lib/three/arena-npcs.tsx`
- [ ] Increase wander speed from 1.5 to 4 in `apps/web/src/stores/npc.ts` (tickDemoNpcs function)
- [ ] Increase wander tick rate from 200ms to 100ms for smoother movement
- [ ] Verify demo wander auto-start is enabled (check bottom of npc.ts for startDemoWander call)

### 4. Wire up underwater decorations
Downloaded but not in scene yet: `apps/web/public/models/underwater-decorations.glb` (6MB)
- [ ] Load with useGLTF in arena-terrain.tsx
- [ ] Clone and scatter individual pieces (rocks, kelp, seaweed) around map edges
- [ ] Or load the whole scene as one decoration cluster and place copies around the border
- [ ] Keep draw calls low — the GLB is pre-baked so should be efficient

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
