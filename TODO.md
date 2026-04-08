# ClawVille TODO

## Current State
- Deployed to Railway: https://web-production-58aa7.up.railway.app/game
- API: https://api-production-e9f2.up.railway.app
- 3D scene gutted to ~46 draw calls for GPU safety (Intel Iris Xe was crashing at 350+)
- Buildings are simple box+roof shapes, NPCs are tiny capsules
- Root cause: original scene had 397 meshes with 182 PBR materials (eliza-kiz had ~70)

## Priority 0: GPU Optimization Architecture (DO FIRST)

### Merge building geometry with BufferGeometryUtils
- [ ] Import `mergeGeometries` from three/examples/jsm/utils/BufferGeometryUtils
- [ ] Each building = 1 merged mesh instead of 22 individual meshes
- [ ] Target: 10 buildings × 1 draw call = 10 (was 222)

### Use InstancedMesh for repeated elements
- [ ] Coral reef: 1 instanced mesh (was 40 individual)
- [ ] Kelp forest: 1 instanced mesh (was 50 individual)
- [ ] Rocks: 1 instanced mesh (was 25 individual)
- [ ] Seashells: 1 instanced mesh (was 30 individual)
- [ ] NPC HP bars: shared geometry, not per-NPC

### Use MeshBasicMaterial where PBR isn't needed
- [ ] HP bars → MeshBasicMaterial (already done)
- [ ] Eyes → MeshBasicMaterial (already done)
- [ ] Glow effects → MeshBasicMaterial
- [ ] Flat-colored accents → MeshBasicMaterial
- [ ] Target: reduce MeshStandardMaterial from 182 to ~40

### Cache THREE objects — no allocation in useFrame
- [ ] Audit all useFrame hooks for `new THREE.Vector3/Object3D/Color`
- [ ] Move to useRef or module-level constants
- [ ] Especially arena-npcs.tsx which had 22 allocations per frame

## Priority 1: Rebuild Building Visuals (GPU-safe)

### Each building: 1 merged mesh + unique silhouette
- [ ] cron-hub (Tide Clock Grotto): conch tower + clock face, merged to 1 mesh
- [ ] webhook-gateway (Current Gateway): coral arch, merged to 1 mesh
- [ ] memory-vault (Abyssal Vault): nautilus dome, merged to 1 mesh
- [ ] skill-forge (Hydrothermal Forge): volcanic chimney + anvil, merged to 1 mesh
- [ ] channel-bridge (Coral Bridge): bridge deck + towers, merged to 1 mesh
- [ ] tool-workshop (Salvage Workshop): driftwood shed, merged to 1 mesh
- [ ] canvas-studio (Biolume Studio): cave + ink splatters, merged to 1 mesh
- [ ] voice-tower (Echo Spire): tall spire + conch horn, merged to 1 mesh
- [ ] security-fortress (Shell Fortress): keep + corner towers, merged to 1 mesh
- [ ] config-citadel (Nautilus Citadel): spiral tower + dome, merged to 1 mesh
- [ ] Add emissive glowing accents per building
- [ ] Add entrance indicators (door geometry baked into merge)

### Building draw call budget: max 20 (10 buildings × 2 meshes max)

## Priority 2: NPCs Visible & Moving

- [ ] Enable demo NPC wander system (currently disabled in npc.ts)
- [ ] Scale NPCs to 2x (body is ~14 units tall = visible from overview)
- [ ] Add colored emissive glow to NPC body material
- [ ] Add 5 more demo NPCs (8 total, different species) — only 5 meshes each = 40 total
- [ ] NPC walking bob animation (already in useFrame, just needs direction != idle)
- [ ] Fix API connection so real NPC simulation works in production

### NPC draw call budget: max 40 (8 NPCs × 5 meshes)

## Priority 3: Atmosphere & Environment (all instanced)

- [ ] Coral reef: 1 InstancedMesh, 30 instances, static (no useFrame)
- [ ] Kelp: 1 InstancedMesh, 40 instances, cheap vertex sway via shader
- [ ] Rocks: 1 InstancedMesh, 20 instances, static
- [ ] Seashells: 1 InstancedMesh, 25 instances, static
- [ ] Bubbles: 1 InstancedMesh, 15 instances, simple Y-float in useFrame
- [ ] Water surface shimmer

### Environment draw call budget: max 10 (6 instanced + water + floor + paths + misc)

## Priority 4: Camera & UX

- [ ] Better default camera angle showing more buildings
- [ ] Smooth camera follow when logged in as player
- [ ] Click-to-move pathfinding visual feedback
- [ ] Building proximity glow/highlight when nearby
- [ ] Minimap showing NPC positions

## Total Draw Call Budget: ~80

| Category | Draw Calls | Notes |
|----------|-----------|-------|
| Buildings | 20 | 10 buildings × 2 max |
| NPCs | 40 | 8 NPCs × 5 meshes |
| Environment | 10 | 6 instanced + terrain |
| Lights | 3 | hemisphere + ambient + directional |
| Player pet | 5 | body + eyes + claws |
| Misc (fog, fx) | 2 | |
| **TOTAL** | **~80** | Under 100 limit, safe for Iris Xe |

## Deployment
- [ ] Custom domain for web (clawville.gg or similar)
- [ ] Custom domain for API
- [ ] Fix CORS for production domains
- [ ] Environment variable audit (API keys not exposed to frontend)

## Bugs
- [ ] API NPC conversations failing (Anthropic API key not resolving in Railway)
- [ ] Font loading errors (Google Fonts fetch failing during build)
- [ ] `apps/web/src/services/agent-orchestrator.ts` imports agent-runtime in web app (should be API-only)

## GPU Performance Rules
- NEVER use Text/Billboard from drei (crashes Intel Iris Xe)
- Keep total draw calls under 100
- No per-frame Object3D creation (causes GC pressure)
- Prefer InstancedMesh over individual meshes for repeated elements
- Merge building geometry with BufferGeometryUtils (1 draw call per building)
- Prefer MeshBasicMaterial over MeshStandardMaterial where lighting isn't needed
- Test every change on the deployed Railway URL, not just localhost
- Max 3 lights (hemisphere + ambient + 1 directional)
- eliza-kiz reference: ~70 meshes worked fine — stay under 100
