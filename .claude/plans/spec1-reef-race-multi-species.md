# SPEC 1 — Multi-Species GLB Rider in Reef Race

**Status:** Draft — awaiting Auditor review  
**Author:** Plan Implementer agent (Plan-only, not Code Implementer)  
**Date:** 2026-04-29  
**Code Implementer:** separate agent, reads this file

---

## A. Goal Statement

Replace the hardcoded `'/models/lobster.glb'` path in `ReefRacePlayer.tsx` with a live dispatch to the correct GLB (`lobster.glb`, `crayfish.glb`, or `sea_horse.glb`) based on each player's `modelKey` (stored in `pets.model_key`). The species metadata is sent from server → client once per match in `snapshot.init` via a new `RoomMeta.reefParticipantMeta` field (modelled on the existing `reefRacingProfiles` pattern), then cached in the activity store and injected into entity objects before the 3D scene reads them.

---

## B. Scope

### IN
- `ReefRacePlayer.tsx`: replace hardcoded `glbPath`, add species dispatch, add `useGLTF.preload` for `crayfish.glb` (already preloaded: `lobster.glb`, `sea_horse.glb`)
- `packages/shared/src/activities/protocol.ts`: extend `RoomMeta` with `reefParticipantMeta?`
- `apps/api/src/services/activity/pet-profile-loader.ts`: new `loadParticipantMeta()` function (DB query: `pets.model_key` per petId)
- `apps/api/src/services/activity/activity-ws-hub.ts`: build and inject `reefParticipantMeta` into `snapshot.init`
- `apps/web/src/stores/activity.ts`: store `reefParticipantMeta`, merge `species` into entity objects on `snapshot.init` and `snapshot.keyframe`

### OUT
- VRM Milady rendering (SPEC 2 — any `modelKey` matching `milady_official_*` falls back to `lobster.glb` for now with a `console.warn`)
- Per-species animation polish (existing `applySwimmingAnim` handles all three; bone-traversal path already works for `sea_horse.glb`, procedural fallback for static meshes)
- UI species picker in `/create-agent` (already implemented upstream)
- Per-species racing stats (future feature, requires separate sim changes)
- `color` field population (same gap exists but it is a UI-only tint concern, no GLB path effect; out of scope for this spec)

---

## C. File-by-File Changes

### C1. `packages/shared/src/activities/protocol.ts`

**Extend `RoomMeta`** — add an optional `reefParticipantMeta` field immediately after `reefRacingProfiles`:

```ts
/**
 * Reef Race SPEC 1 — per-pet display metadata sent ONCE in `snapshot.init`
 * so the client can render the correct GLB without re-querying the pets table.
 * Keys are petId strings. Bots get `modelKey: 'lobster'` (their DB row
 * `openclaw_bots` uses a fixed species).
 *
 * Only populated for `activityId === 'reef-race'` rooms. Absent on all other
 * activity types so existing clients are unaffected.
 */
reefParticipantMeta?: Record<string, {
  /** Matches `pets.model_key` — determines which GLB to render. */
  modelKey: string;
}>;
```

**No change to `EntityDelta` or `WorldState`.** Species is static per-match (locked at room start) — no reason to put it in the per-tick delta stream.

### C2. `apps/api/src/services/activity/pet-profile-loader.ts`

**Add `loadParticipantMeta()`** — a new async function below `loadRacingProfiles`:

```ts
/**
 * SPEC 1 — Fetch per-pet display metadata (modelKey) for Reef Race rooms.
 *
 * - humanPetIds: real pets; read from DB.
 * - botPetIds: synthetic bots; always get { modelKey: 'lobster' }.
 *
 * Any petId not returned by the SELECT gets { modelKey: 'lobster' } as a
 * safe fallback. DB failure falls back all petIds to 'lobster' so the race
 * still renders (wrong model is better than a broken page).
 */
export async function loadParticipantMeta(
  humanPetIds: string[],
  botPetIds: string[],
): Promise<Record<string, { modelKey: string }>> {
  const out: Record<string, { modelKey: string }> = {};

  // Bots always render as lobster.
  for (const petId of botPetIds) {
    out[petId] = { modelKey: 'lobster' };
  }

  if (humanPetIds.length === 0) return out;

  try {
    const rows = await db
      .select({ id: pets.id, modelKey: pets.modelKey })
      .from(pets)
      .where(inArray(pets.id, humanPetIds));

    for (const row of rows) {
      out[row.id] = { modelKey: row.modelKey ?? 'lobster' };
    }

    // Fill any petId the DB didn't return (deleted pet, edge case).
    for (const petId of humanPetIds) {
      if (!out[petId]) out[petId] = { modelKey: 'lobster' };
    }
  } catch (err) {
    console.error('[loadParticipantMeta] DB error, falling back to lobster:', err);
    for (const petId of humanPetIds) {
      out[petId] = { modelKey: 'lobster' };
    }
  }

  return out;
}
```

**Import needed:** `pets` already imported in this file. `inArray` already imported. No new deps.

**DB column name check:** In `packages/database/src/schema/pets.ts` the column is `model_key` VARCHAR with Drizzle field `modelKey`. Verify the Drizzle field accessor before coding: search `pets.modelKey` in pet-profile-loader.ts to confirm naming convention matches existing callers.

### C3. `apps/api/src/services/activity/activity-ws-hub.ts`

**Add import:**
```ts
import { loadParticipantMeta } from './pet-profile-loader';
```

**In `sendInit()`, add after the `reefRacingProfiles` block (around line 583):**

```ts
// SPEC 1 — per-pet modelKey metadata for GLB dispatch on the client.
// Pattern mirrors reefRacingProfiles (Phase 3). DB query is ≤8 rows,
// ~1ms. Falls back to all-lobster on error.
let reefParticipantMeta: Record<string, { modelKey: string }> | undefined;
if (room.activityId === 'reef-race') {
  const allPetIds = Array.from(room.participants.keys());
  const humanPetIds = allPetIds.filter(
    (id) => room.participants.get(id)!.subjectType !== 'bot',
  );
  const botPetIds = allPetIds.filter(
    (id) => room.participants.get(id)!.subjectType === 'bot',
  );
  try {
    reefParticipantMeta = await loadParticipantMeta(humanPetIds, botPetIds);
  } catch (err) {
    console.error('[activity-ws-hub] loadParticipantMeta failed:', err);
    reefParticipantMeta = undefined; // client falls back to lobster
  }
}
```

**In the `this.safeSend(ws, {...})` call, add to the `room:` object:**
```ts
reefParticipantMeta,
```

This is sent to every player in the room. The payload is **~96 bytes total, sent once in `snapshot.init`, with zero per-tick overhead** — `reefParticipantMeta` lives in `RoomMeta`, not in `EntityDelta`, so it never appears in the per-tick delta stream. The one-shot cost is negligible on top of the existing profiles payload.

**Why no `!REEF_RACE_USE_SPLINE` guard here:** The `reefRacingProfiles` block that this code is modelled on is gated with `!REEF_RACE_USE_SPLINE` because racing profiles are consumed by the sim, which is mode-dependent. `reefParticipantMeta` is display-only (GLB path dispatch on the client); it has no sim coupling and is equally needed in both spline-sim and non-spline-sim modes. The guard is intentionally omitted.

**Sequencing note:** `sendInit` is `async`; the `await loadParticipantMeta(...)` call sits inside an already-async function. No structural refactor needed.

### C4. `apps/web/src/stores/activity.ts`

**Two changes:**

**C4a — Extend `ActivityState` interface** to hold participant meta:

After the `reefRace: ReefRaceState` field, add:

```ts
/**
 * SPEC 1 — per-pet modelKey map for Reef Race GLB dispatch.
 * Populated once on `snapshot.init`, never updated per-tick.
 * Empty map on non-reef-race rooms.
 */
reefParticipantMeta: Record<string, { modelKey: string }>;
```

Add to `emptyState()`:
```ts
reefParticipantMeta: {},
```

**Also extend the `Pick` union in `emptyState()` (lines 470-508) to include `| 'reefParticipantMeta'`:** The `emptyState` return type is guarded by a `Pick<ActivityState, ...>` union that controls which fields `reset()` is allowed to wipe. Without adding `'reefParticipantMeta'` to that union, the `reset()` call will silently skip wiping `reefParticipantMeta`, leaving stale species data from the prior room surviving into the next match.

Add to `reset()` call (search where `reefRace: EMPTY_REEF_RACE` is reset):
```ts
reefParticipantMeta: {},
```

**C4b — Populate on `snapshot.init` and `snapshot.keyframe`:**

In the `case 'snapshot.init':` block, extend the `set({...})` call:
```ts
reefParticipantMeta: frame.room.reefParticipantMeta ?? {},
```

In the `case 'snapshot.keyframe':` block, do the same:
```ts
reefParticipantMeta: frame.room.reefParticipantMeta ?? state.reefParticipantMeta,
```

(Keyframe re-uses existing meta if the reconnect keyframe doesn't re-supply it, which is the safe path.)

**C4c — Inject `species` into entity objects** when meta is available:

In `hydrateFromWorld()`, the current entity shape does not include `species`. However, `hydrateFromWorld` does not have access to the `reefParticipantMeta` (it takes only `WorldState`). Two options:

- **Option A (simpler):** Do NOT modify `hydrateFromWorld`. Instead, after `set({entities: hydrated.entities, ...})` in the `snapshot.init` case, run a second entity map pass to inject species into each entity:

```ts
// SPEC 1 — inject species from reefParticipantMeta into entity objects.
const participantMeta = frame.room.reefParticipantMeta;
if (participantMeta) {
  const entitiesWithSpecies = new Map(hydrated.entities);
  entitiesWithSpecies.forEach((e, petId) => {
    const meta = participantMeta[petId];
    if (meta) {
      entitiesWithSpecies.set(petId, { ...e, species: meta.modelKey });
    }
  });
  set({ entities: entitiesWithSpecies, ... });
}
```

This runs once per `snapshot.init`, not per-tick. Cost: 1 Map clone + ≤8 iterations = negligible.

- **Option B (elegant):** Pass `reefParticipantMeta` into `hydrateFromWorld` as an optional second param and apply inside the loop.

**Decision: Use Option A.** It avoids touching `hydrateFromWorld`'s signature which is shared with both `snapshot.init` and `snapshot.keyframe`. The second pass is clear and auditable.

Apply the same pattern in `snapshot.keyframe`:
```ts
const participantMeta = frame.room.reefParticipantMeta ?? state.reefParticipantMeta;
// ... after hydration, same injection pass ...
```

**C4d — Carry species through `applyEntityDelta`:**

The `applyEntityDelta` function merges per-tick deltas using spread: `{ ...existing, ...(changed fields) }`. Since `species` is set once on `snapshot.init` and never in a delta, and spread preserves it from `existing`, **no change is needed** in `applyEntityDelta`. Species set on init persists through all subsequent deltas automatically.

### C5. `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx`

**C5a — Replace hardcoded `glbPath` (lines 253-259):**

Replace the current block:
```ts
// entity.species deferred per C8 fix — Phase 1 uses lobster.glb as sole default.
// Phase 1.5 will restore species branching once the server populates the field.
// ...
const glbPath = '/models/lobster.glb';
```

With:
```ts
// SPEC 1 — derive GLB path from entity.species (modelKey from pets.model_key,
// injected by activity store on snapshot.init via reefParticipantMeta).
// Falls back to 'lobster' if species is absent or unrecognised (safe default).
// VRM species (milady_official_*) are SPEC 2 — fall back to lobster with a warn.
const speciesKey = (entity as ReefRaceEntity & { species?: string }).species ?? 'lobster';
const glbPath = (() => {
  switch (speciesKey) {
    case 'crayfish':  return '/models/crayfish.glb';
    case 'seahorse':
    case 'sea_horse': return '/models/sea_horse.glb';
    default:
      // Milady VRM keys (milady_official_*) are SPEC 2. Log once, render lobster.
      if (speciesKey.startsWith('milady_official_')) {
        console.warn(
          `[ReefRacePlayer] species="${speciesKey}" is a VRM (SPEC 2) — rendering lobster.glb as fallback`,
        );
      }
      return '/models/lobster.glb';
  }
})();
```

**Why `seahorse` and `sea_horse` both:** The `AGENT_MODELS` registry uses key `'seahorse'` (no underscore), but the GLB file is `sea_horse.glb`. The `ReefRaceEntity.species` field comment says `'sea_horse' | 'lobster'`. Defensive: match both spellings.

**C5b — Add `useGLTF.preload` for `crayfish.glb`:**

Current preloads at module scope (lines 83-87):
```ts
useGLTF.preload('/models/sea_horse.glb');
useGLTF.preload('/models/lobster.glb');
```

Add:
```ts
useGLTF.preload('/models/crayfish.glb');  // SPEC 1 — 3rd species, static mesh
```

`lobster.glb` and `sea_horse.glb` are already preloaded.

**C5c — Color tint traverse on `crayfish.glb`:**

The existing `clonedScene` useMemo color-tint block traverses by `mesh.isMesh` and applies tint if material is `MeshStandardMaterial`. `crayfish.glb` is a static mesh (0 bones, `MeshStandardMaterial`). The tint traverse will work correctly on crayfish as-is — no code change needed.

`sea_horse.glb` is rigged (93-bone) with `MeshStandardMaterial` materials. Same traverse works. No change needed.

**C5d — `useMemo` dependency array:**

Current `clonedScene` useMemo deps: `[srcScene, entity.color]`.

`srcScene` already changes when `glbPath` changes (because `useGLTF(glbPath)` returns a new scene for each path). So when `entity.species` changes and forces a different `glbPath`, `useGLTF(glbPath)` will return a new `srcScene` object, which invalidates the memo naturally.

However — `useGLTF` is called with `glbPath` computed above the hook. There is a Rules of Hooks constraint: hooks must be called at the top level. **The current code already has `const { scene: srcScene } = useGLTF(glbPath)` after the `glbPath` declaration — that's valid.** The only risk is that `glbPath` changes mid-render when `entity.species` first becomes available (after `snapshot.init` lands). Since species is set once per room and never changes mid-race, this is a one-time transition at join — React will simply re-render with the new path once.

**C5e — `resetTransformSwimState` on species change:**

The existing `useEffect` already calls `resetTransformSwimState(entity.petId)` on cleanup when `clonedScene` changes. Since `clonedScene` changes with species, the cleanup fires correctly. No change needed.

---

## D. Data Flow Trace

```
pets.model_key (DB column)
  │
  ▼ [loadParticipantMeta() in pet-profile-loader.ts]
Record<petId, { modelKey: string }>
  │
  ▼ [activity-ws-hub.ts sendInit()]
RoomMeta.reefParticipantMeta sent in snapshot.init (WS frame)
  │
  ▼ [useActivityWs → applyServerFrame → store snapshot.init case]
ActivityState.reefParticipantMeta (Map-backed Record in Zustand store)
  + Entity injection pass: entity.species = meta[petId].modelKey
  │
  ▼ [ReefRaceScene → ReefRacePlayer(entity)]
entity.species (string, e.g. 'lobster' | 'crayfish' | 'seahorse')
  │
  ▼ [glbPath switch in ReefRacePlayer]
'/models/lobster.glb' | '/models/crayfish.glb' | '/models/sea_horse.glb'
  │
  ▼ [useGLTF(glbPath) → skeletonClone → riderMount.add(clonedScene)]
Correct 3D mesh rendered per player species
```

**For player X with pet of species Y:**
- `pets.model_key = 'crayfish'` → `reefParticipantMeta[X.petId].modelKey = 'crayfish'` → `entity.species = 'crayfish'` → `glbPath = '/models/crayfish.glb'` → crayfish static mesh renders on the glider board.

---

## E. Edge Cases

| Case | Behavior |
|---|---|
| `entity.species` is `undefined` (no meta or race type mismatch) | Falls back to `'lobster'` via `?? 'lobster'` |
| `entity.species` is unknown value (e.g. `'jellyfish'`, `'hermitcrab'`) | Falls back to `lobster.glb` (default case in switch) |
| `entity.species` is `milady_official_N` (SPEC 2 VRM) | Logs a `console.warn`, falls back to `lobster.glb` |
| `crayfish.glb` — 0 bones, static mesh | `applyTransformSwim` handles it (procedural oscillation via `hasBones=false` path) |
| `sea_horse.glb` — 93-bone rig | Bone-traversal path in `applySwimmingAnim` animates spine/tail/fin bones |
| `lobster.glb` — rigged | Existing behavior unchanged |
| Player switches pet mid-race | Not supported — species locked at room start via `snapshot.init`; a reconnect would re-trigger `snapshot.init` with the same meta |
| Bot participants | `loadParticipantMeta` hardcodes `{ modelKey: 'lobster' }` for bots; they always render lobster |
| 8-player race, mixed species | Each entity has independent `species` field; `ReefRacePlayer` is per-entity; no shared state |
| `snapshot.keyframe` (reconnect) | `reefParticipantMeta` re-populated from keyframe if server supplies it; falls back to `state.reefParticipantMeta` if absent |
| DB error on `loadParticipantMeta` | All players render lobster — race proceeds without crashing |
| `pets.model_key` is NULL in DB | `loadParticipantMeta` uses `?? 'lobster'` fallback in the SELECT result |

---

## F. Testing Criteria

### Build
- `bun run build` in repo root passes with zero new TypeScript errors.
- TypeScript will catch: missing `reefParticipantMeta` in `emptyState`, wrong field names on `RoomMeta`, missing `reset` field.

### Existing tests
- `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` — run via `bun test` inside `apps/api`. No sim changes are made; test suite must pass unchanged.
- The only new testable unit is `loadParticipantMeta` — see below.

### Unit test (new, add to `pet-profile-loader.test.ts` or inline file)
```ts
// Pseudo — real file uses Drizzle mock or test DB
it('maps humanPetIds to modelKey from DB', async () => {
  // mock db.select to return [{ id: 'p1', modelKey: 'crayfish' }]
  const result = await loadParticipantMeta(['p1'], []);
  expect(result['p1'].modelKey).toBe('crayfish');
});

it('falls back to lobster for missing petId rows', async () => {
  // mock db.select returns [] (empty)
  const result = await loadParticipantMeta(['p1'], []);
  expect(result['p1'].modelKey).toBe('lobster');
});

it('bots always get lobster without a DB query', async () => {
  const result = await loadParticipantMeta([], ['bot-1']);
  expect(result['bot-1'].modelKey).toBe('lobster');
});

it('DB failure falls back all humanPetIds to lobster', async () => {
  // mock db.select to throw
  const result = await loadParticipantMeta(['p1', 'p2'], []);
  expect(result['p1'].modelKey).toBe('lobster');
  expect(result['p2'].modelKey).toBe('lobster');
});
```

### Browser tests (manual, after deploy)
1. **Single player, own pet is lobster:** Enter Reef Race, observe lobster mesh on the glider board.
2. **Single player, own pet is crayfish:** Change pet `model_key` to `crayfish` in DB (or seed a test pet), enter Reef Race, observe crayfish static mesh on the board. Confirm procedural swim motion (body oscillation — no bones).
3. **Single player, own pet is seahorse:** Same process with `model_key = 'seahorse'`, observe `sea_horse.glb` with bone-driven animation.
4. **8-player mixed race (staging):** Use bot filler (3 lobster bots + 1 crayfish human + 1 seahorse human), confirm each renders the correct GLB. No entity renders the wrong species.
5. **Reconnect:** Drop and reconnect to an in-progress race, confirm species still correct after `snapshot.keyframe`.
6. **Unknown species fallback:** Set a pet `model_key` to `hermitcrab`, confirm lobster renders and `console.warn` fires once.

### Network test
- Open Browser DevTools → Network → WS frame inspector.
- On `snapshot.init`, parse the JSON payload, confirm `room.reefParticipantMeta` object is present with petId keys and `modelKey` values.
- On subsequent `snapshot.delta` frames, confirm `reefParticipantMeta` is absent (it is room-level one-shot, not per-delta).

---

## G. Integration Risk + Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `snapshot.init` payload size increases by ~96 bytes (8 players × ~12 bytes) | Low | Negligible on top of existing 400+ byte profiles payload |
| Client-side entity map mutation on `snapshot.init` requires a full Map clone | Low | Cost: one `new Map()` + ≤8 iterations = O(N) where N≤8; only runs once per match join |
| `pets.modelKey` Drizzle field name vs DB column `model_key` mismatch | Medium | Verified in schema: `pets.ts` line 174 uses `varchar('model_key', { length: 64 })` with Drizzle field name `modelKey`. Confirm accessor: `pets.modelKey` in the select. If Drizzle returns the raw column, it would be `model_key` — Code Implementer must run `bun run db:studio` or check existing callers (e.g. `loadRacingProfiles` uses `pets.archetype` / `pets.level` — follow same pattern). |
| `useGLTF(glbPath)` with runtime-computed path may trigger Suspense on first join | Low | All three paths are preloaded at module scope; the preload ensures the cache is warm before any `ReefRacePlayer` mounts. |
| `crayfish.glb` preload adds ~X KB to initial JS chunk | Low | GLBs are loaded at runtime via `fetch`, not bundled. The `useGLTF.preload` call is a runtime cache-warm, not a bundle-size increase. |
| Species enum mismatch: `AGENT_MODELS` uses `'seahorse'` (no underscore); `ReefRaceEntity.species` docs say `'sea_horse'` | Medium | The switch statement handles BOTH spellings (`case 'seahorse': case 'sea_horse':`). The server sends `pets.model_key` raw (e.g. whatever the DB row contains). The DB `model_key` defaults to `'lobster'`, and the `AGENT_MODELS` registry key is `'seahorse'`. So the server will send `'seahorse'` (no underscore). The switch covers both. |
| Pre-existing type gap: `SeaCreatureSpecies` is `'lobster' \| 'crayfish' \| 'sea_horse'` (underscore), but `AGENT_MODELS` uses key `'seahorse'` (no underscore). The `speciesKey` cast on lines 397-398 of `ReefRacePlayer` (`entity.species ?? 'lobster'`) will resolve `'seahorse'` to itself, not to undefined — so the switch's `case 'seahorse':` branch correctly serves the `sea_horse.glb` path. **No functional regression in SPEC 1** since `hasRig=false` means the seahorse animator path is dormant anyway. However, this type inconsistency must be reconciled when seahorse gets a full animator rig in a future spec: the `SeaCreatureSpecies` type will need a `'seahorse'` variant (or the AGENT_MODELS key changed to `'sea_horse'`). **Do not silently paper over this gap in future sessions.** | Low (no regression now) | No action required for SPEC 1. Document in follow-up task when seahorse rig is added. |

---

## H. Rollout Plan

### Single-commit structure
The plan is shippable in one commit touching these files:
1. `packages/shared/src/activities/protocol.ts` — `RoomMeta` extension
2. `apps/api/src/services/activity/pet-profile-loader.ts` — new `loadParticipantMeta()`
3. `apps/api/src/services/activity/activity-ws-hub.ts` — call `loadParticipantMeta`, inject into `snapshot.init`
4. `apps/web/src/stores/activity.ts` — store field, inject into entities on init
5. `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` — dispatch by species, add preload

### Feature flag
None needed. The change is fully backward-compatible:
- If `reefParticipantMeta` is absent in `snapshot.init` (old server talking to new client), entities keep `species: undefined`, which falls back to `lobster.glb` — the current behavior.
- If new server talks to old client, `reefParticipantMeta` is an unrecognised field in `RoomMeta` — TypeScript `[k: string]: unknown` catch-all means no crash; old client ignores it.

### Doc updates (same diff)
- **`GameFeatures.md`**: Update the Reef Race section to document multi-species support. Add a bullet under "Visual" or "Player Rendering": "Racer GLB determined by pet's model_key: lobster.glb (default), crayfish.glb (static mesh, procedural swim), sea_horse.glb (93-bone rig, bone-driven swim). Milady VRM species are SPEC 2."
- **`3dStructure.md`**: Not required — this is a data routing change, not a world/geometry/lighting change.
- **Memory files**: After implementation, save a `patterns/reef-race-participant-meta-snapshot.md` documenting the `RoomMeta` one-shot metadata pattern (one-time DB query → `snapshot.init` payload → store injection → entity field).

### No DB migration required
`pets.model_key` already exists. No schema changes.

### Deploy sequence
1. `bun run build` — verify clean.
2. `git commit -m "feat(reef-race): SPEC 1 multi-species GLB rider — lobster/crayfish/seahorse"`
3. `git push origin master` → Coolify auto-deploy.
4. Wait ~3 min for API deploy → verify `curl -sS --ssl-no-revoke https://api.clawville.world/health`.
5. Wait ~5 min for web deploy.
6. Enter Reef Race → open WS frame → confirm `reefParticipantMeta` in `snapshot.init`.
7. Browser test: lobster player sees lobster. If a test pet with `model_key='crayfish'` exists, confirm crayfish renders.

---

## I. Out-of-Scope Follow-Ups

These are explicitly NOT in this spec and must NOT be added by the Code Implementer:

1. **SPEC 2: VRM Milady rendering in Reef Race** — `milady_official_*` model keys need the full VRM pipeline (`useVRMInstance`, `VRMCharacterAnimator`, Mixamo retarget). This is a separate substantial feature.

2. **`entity.color` population** — same gap exists (color is never sent in snapshots), but color tinting is a visual-only concern with no broken functionality. Plan a `reefParticipantMeta` extension to include `color?: string` in a follow-up if visual identity between racers matters.

3. **Per-species racing stats** (lobster faster, seahorse turns better) — requires sim changes in `reef-race-sim.ts` / `reef-race-spline-sim.ts` and a new `PetRacingProfile` field. Out of scope.

4. **`crayfish` in `AGENT_MODELS` registry** — `crayfish` was removed from `AGENT_MODELS` in 2026-04-16 (NOTE in file). New pets cannot choose crayfish, but existing pets with `model_key='crayfish'` still need it to render. The GLB and the switch case both handle it. No registry change.

5. **Arena world GLB species dispatch** — `arena-npcs.tsx` already has its own species-to-GLB mapping. This spec only changes `ReefRacePlayer.tsx`. No arena changes.

6. **Snapshot delta species update mid-race** — not needed; species is static per match.
