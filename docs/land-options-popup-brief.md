# Land options pill — FROZEN implementation spec (rev 2, 2026-07-30)

**Status:** FROZEN. Supersedes the 2026-07-28 rev-1 brief, which was REJECTED by
adversarial review (findings 1-10). Every file:line below was re-verified against
this worktree at `50106259` (branch `feat/land-options-pill`, off `origin/staging`)
during the revision. Where the critique's line number pointed at a comment rather
than the code, the number here is the corrected one.

**Founder ask:** "make sure options pop up for land." Today the only land
interaction in-world is clicking a for-sale sign on an AVAILABLE parcel
(`apps/web/src/lib/three/land-parcels.tsx:819` → `openLandOffice(parcelCode)`,
list built at `:790` filtered to `status === 'available'`). Walking onto a parcel
shows nothing, and owned parcels have zero in-world surface. This slice adds a
building-style proximity pill for parcels.

**Domain:** land-economy. READ-ONLY UI. The pill only ROUTES into existing
surfaces. No economy writes, no API/schema/protocol change.

---

## 0. Revision log — what changed vs rev 1

| # | Rev-1 said | Rev 2 |
|---|---|---|
| 1 | "Set by the SAME mechanism that sets `nearLocation`" | REPLACED. There is no single such mechanism; it is duplicated across three files and does not cover autonomous mode at all. Rev 2 specs ONE centralized 5 Hz tracker (§4.2) reading the active body per control mode. |
| 2 | Implied the Pixi 2D fallback needs a parallel edit | Pixi is EXPLICITLY out of scope. `PixiCanvas` has no mount site anywhere in the app (verified §3.7). The pure helper is the future seam if it is ever revived. |
| 3 | "positions must come from the shared parcel geometry" | Kept, and hardened: the helper accepts CENTERED WORLD coordinates ONLY; every call site converts explicitly, with the per-source conversion spelled out (§4.2). |
| 4 | available → "For Sale" | REMOVED. Permanent buy is DISABLED for every tier (verified §3.5). All acquisition copy is now tenure-accurate (§5). The words "For Sale", "Buy", "Purchase", "Sale" appear nowhere in pill copy. |
| 5 | Pill reads status via the store default | BLOCKER FIX. The store defaults any MISSING parcel to `'available'`, which is poison for a pill (§3.4). The pill now renders ONLY for an explicitly hydrated `parcelCode`, and the hydrator is extended to cover all four statuses (§4.4). |
| 6 | "same pill slot as LocationHUD ⇒ inherits its placement" | REMOVED. Nothing is inherited. The pill calls `useIsMobile()` itself and re-states LocationHUD's exact offset formula (§4.5). `TalkToCharacterBar` gets a one-line suppression because it sits at `z-50`, ABOVE LocationHUD's `zIndex: 45` (§4.7). |
| 7 | "Guests see the pill too" | PINNED to exact states (§4.6 + §5): logged-in player/autonomous = full pill; GUEST in npc mode = pill (guests are avatar-bearing); anonymous explore = no pill (no body). Guest CTA copy does not promise the focused parcel, because guest focus is ignored (verified §3.6). |
| 8 | No lifecycle clearing | ADDED. `nearParcelCode` is cleared at every site that clears `nearLocation`, enumerated by line (§4.3). |
| 9 | Doc list named `GameFeatures.md` only | `3dStructure.md` ADDED. The tracker edits `apps/web/src/components/three/World3DCanvas.tsx`, which is a file-path trigger in CLAUDE.md (§8). |
| 10 | Gates were 5 loose items | Rewritten as an enumerated offline checklist plus explicitly-owned browser checks (§9). |

---

## 1. Verified baseline — facts this spec is built on

Everything in this section was read in this worktree. Do not re-derive it; DO
re-check it if a file has moved by the time you implement.

### 1.1 Parcel geometry (`packages/shared/src/constants/land-parcels.ts`)

- `ParcelSlot` interface at `:85`. Fields used here: `id` (`:87`, equals the DB
  `land_parcels.parcel_code`), `tier` (`:89`), `cx` (`:93`), `cz` (`:95`),
  `size` (`:97`, square footprint side length in world units).
- `LAND_PARCELS: readonly ParcelSlot[]` at `:223`, computed once at module load,
  pure (no RNG, no clock).
- `cx` / `cz` are CENTERED WORLD units. World center is `(0, 0)`; `TILE_SIZE = 32`
  (`:78`); grid is 704x704 tiles = 22528x22528 wu (`:15`).
- Populated rings today (`TIER_CONFIG` at `:127`, counts from
  `PARCEL_TIER_COUNTS`): founder h=190t footprint 38t (10 parcels), starter
  h=258t footprint 34t (26), c h=305t footprint 34t (20). Tiers a and b are
  count 0. Total supply 56.
- The header carries a NO-OVERLAP proof (`:40`-`:67`): no two parcels overlap,
  and parcels never reach the building ring. A first-match hit test is therefore
  unambiguous.

Derived ring bounds (computed from the above, not guessed):

| tier | frame radius wu | half footprint wu | inner edge wu | outer edge wu |
|---|---|---|---|---|
| founder | 6080 | 608 | **5472** | 6688 |
| starter | 8256 | 544 | 7712 | 8800 |
| c | 9760 | 544 | 9216 | **10304** |

`5472` and `10304` are the tight early-out gates. They MUST be computed at module
load from `LAND_PARCELS` (§4.1), never hardcoded, so a supply change cannot drift
them.

### 1.2 Coordinate spaces

Two spaces are in play and they are trivially confusable:

- **Map-pixel space** (a.k.a. game space): `0 .. MAP_WIDTH`. `MAP_WIDTH =
  MAP_HEIGHT = 22528` (`apps/web/src/lib/pixi/tilemap-data.ts:22`-`:23`).
- **Centered world space**: `-11264 .. +11264`. `HALF_W = MAP_WIDTH / 2` and
  `HALF_H = MAP_HEIGHT / 2` (`World3DCanvas.tsx:112`-`:113`) both equal 11264,
  matching `HALF_MAP_WU` in `land-parcels.ts:244`.

Conversion is `world = mapPixel - 11264` on both axes. Every existing proximity
producer performs it explicitly:

- VRM player path: `player-avatar.tsx:611`-`:612`
  (`avatarPositionRef.x - HALF_W`, `avatarPositionRef.y - HALF_H`).
- GLB player path: `player-avatar.tsx:1113`-`:1114` (identical expression).
- Possessed NPC path: `npc-controller.tsx:224`-`:225`
  (`npc.x - MAP_WIDTH / 2`, `npc.y - MAP_HEIGHT / 2`).

**Refinement the critique missed:** the two player paths are two code paths but
ONE data source. Both read the module-scope `avatarPositionRef` exported from
`@/stores/game`. A single tracker reading `avatarPositionRef` therefore covers
both without touching `player-avatar.tsx` at all.

### 1.3 The existing 5 Hz tracker pattern (`World3DCanvas.tsx:1177`-`:1228`)

`MinimapPositionTracker` is the model to copy. It:

- uses `useSceneFrame(({ clock }) => { ... })` (imported at `:11`, defined in
  `apps/web/src/components/three/world-stage/use-scene-frame.ts:94`), which is
  scene-gated so it does not run for an inactive sub-scene;
- time-gates to 5 Hz with a `useRef` and `if (now - lastWriteRef.current < 0.2) return;`
  (`:1179`-`:1184`);
- reads `useGameStore.getState()` non-reactively (`:1186`);
- branches per control mode: npc via `useNpcStore.getState().npcs.find(n => n.id === store.possessedNpcId)`
  (`:1192`-`:1194`); autonomous via the same lookup on `store.autonomousBodyId`
  (`:1195`-`:1204`); player returns early because the avatar ref is authoritative
  (`:1205`-`:1208`); explore falls through to camera position (`:1209`-`:1213`).

It is mounted unconditionally at `World3DCanvas.tsx:2211`.

**The critique's finding 5 is correct:** the existing BUILDING proximity checks
are NOT throttled. `player-avatar.tsx:1109`-`:1111` says so in a comment ("Runs
every frame"), and the NPC check at `npc-controller.tsx:220`-`:226` is inside an
unthrottled `useSceneFrame`. Rev 1's "throttle identical to the building check"
was factually wrong. Rev 2 uses the 5 Hz `MinimapPositionTracker` pattern instead.

### 1.4 Client land store (`apps/web/src/stores/land.ts`)

- `ParcelStatus = 'available' | 'owned' | 'reserved' | 'retired'` at `:16`.
- `ParcelState { status, ownerAvatarId }` at `:18`-`:21`.
- `parcels: Map<string, ParcelState>` keyed by parcelCode at `:46`.
- `setParcels` has **PATCH semantics**, documented at `:53`-`:55` and implemented
  at `:85`-`:92` (copy the Map, then `next.set` each incoming key). Keys absent
  from the update survive untouched. This is what makes §4.4 safe.
- **The poison:** `getParcelStatus()` at `:115`-`:120` returns
  `parcels.get(parcelId)?.status ?? 'available'`. Anything not in the map reads
  as available. The 3D sign layer uses the same default inline at
  `land-parcels.tsx:790`.

### 1.5 Hydration (`apps/web/src/lib/three/land-state-hydrator.tsx`)

- `fetchAllParcelStates()` at `:58`-`:80` issues exactly TWO requests via
  `Promise.allSettled`: `status: 'available'` and `status: 'owned'` (`:60`-`:63`),
  merging both into one record (`:67`-`:77`) with owned merged second.
- `mapStatus()` at `:46`-`:53` ALREADY handles all four statuses, including
  `reserved` and `retired`. No change needed there.
- Mounted at `World3DCanvas.tsx:2094`, inside the Canvas tree, with no auth gate.
- 60s `staleTime` (`:94`), `retry: 1` (`:96`), `throwOnError: false` (`:99`).
  A total fetch failure leaves the store EMPTY, which under the `?? 'available'`
  default means every parcel reads as available.

### 1.6 Server contract (`apps/api/src/routes/land.ts`)

- `GET /parcels?tier=&status=` at `:835`. PUBLIC, no auth (`sessionMiddleware`
  at `:831` is a non-throwing no-op for anonymous callers).
- `PARCEL_STATUSES = ['available','owned','reserved','retired']` at `:311`;
  `statusSchema = z.enum(PARCEL_STATUSES)` at `:316`; the query schema is
  `.strict()` at `:318`-`:323`. So `?status=reserved` and `?status=retired` are
  ACCEPTED today. No API edit is required.
- The status filter is EXACT (`eq(landParcels.status, status)` at `:857`-`:859`).
  There is no "everything" mode.
- Rate limit `createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 })` at `:439`,
  per client IP, shared with the service-listings reads. 60s server-side read
  cache keyed `parcels:<tier>:<status>` at `:852`-`:854` / `:881`.
- Client wrapper `api.getLandParcels({ tier?, status? })` at
  `apps/web/src/lib/api.ts:1399`-`:1405`, typed against
  `LandParcelStatus = 'available' | 'owned' | 'reserved' | 'retired'`
  (`apps/web/src/components/game/land/types.ts:11`).

### 1.7 Tenure model — buy is DEAD

- `POST /parcels/:parcelId/buy` returns `409 { error: 'tenure_model_active' }`
  unconditionally for EVERY tier (`apps/api/src/routes/land.ts:1328`; the
  founder ruling is documented at `:1315`-`:1327`).
- starter acquires via `POST /claim-starter` (refundable deposit escrow).
- c / b / a / **founder** acquire via `POST /parcels/:parcelId/claim-hold`
  (CLV hold-to-keep). Thresholds are FOUNDER-LOCKED at
  `packages/shared/src/constants/land-economy.ts:151`-`:157`:
  c 100k, b 500k, a 2.5M, founder 10M CLV; starter `null`.

### 1.8 Founder tier IS claimable in-game (correction to the orchestrator's assumption)

The revision brief hypothesized founder might be non-claimable and asked me to
verify before finalizing. It is claimable:

- `isHoldTier(tier)` is a local helper at `land-office-modal.tsx:178`-`:180`,
  defined as `holdThresholdForTier(tier) != null`. founder returns 10,000,000,
  so `isHoldTier('founder') === true`.
- `ParcelCard` at `:414` therefore takes the hold branch at `:459`, rendering
  "Hold 10,000,000 $CLAWVILLE" (`:463`-`:464`) plus a live **Claim** button
  (`:466`-`:471`) with a `min-h-[44px]` tap target.
- The seed defaults every row, founder included, to `status: 'available'`
  (`apps/api/scripts/seed-land-parcels.ts:26`), and the schema default is
  `'available'` (`packages/database/src/schema/land.ts:217`).

**Decision:** founder parcels get the same "Available" framing as c/b/a with the
hold sub-line. They are NOT rendered as "Reserved parcel". The orchestrator's
decision 5 authorized exactly this outcome conditional on verification, and the
verification passed. The copy still never says "for sale" or "buy".

### 1.9 Ownership resolution

- The Land Office resolves "me" as `avatar?.id` from `useAvatar()`
  (`land-office-modal.tsx:2057`; `useAvatar` at `apps/web/src/hooks/use-avatar.ts:7`-`:21`,
  which swallows 401 and yields `null`).
- The pill uses the identical pattern. Raw agent-session-only rendering is OUT
  of scope (critique finding 10 accepted as MINOR).

### 1.10 Guest state

- `hasAvatar = !!avatar` at `apps/web/src/app/(world)/game/page.tsx:544`.
- Guests ARE avatar-bearing: `GuestAvatarBootstrap` (mounted `:642`) mints a
  guest avatar, and the `hasAvatar` block comment at `:654`-`:661` states it
  covers "ALL avatar-bearing visitors including guests minted by the auto-create
  flow". So mounting inside that block DOES reach guest npc mode.
- `useIsGuest()` at `apps/web/src/hooks/use-is-guest.ts:29`.
- **Guest focus is ignored:** `LandOfficeModal`'s open effect returns early for
  guests at `:2146` (`if (isGuest) return;`) BEFORE the
  `if (focusParcelCode) setTab('for-sale')` block at `:2149`-`:2151`, and the
  render swaps the whole body for `<GuestLandSandbox />` at `:2236`-`:2239`.
  Guest CTA copy must not promise the focused lot.
- **Starter claim auto-picks:** the starter branch's button is
  `onClick={onClaimStarter}` (`:515`), the parcel-AGNOSTIC modal, per the comment
  at `:501`-`:507` ("claim-starter takes no parcelId and AUTO-PICKS an available
  lot ... without binding to THIS card's parcel"). Copy must not promise the
  approached lot is the lot awarded.

### 1.11 Bottom-slot occupants

- `LocationHUD` (`apps/web/src/components/game/location-hud.tsx`): fixed
  bottom-center at `:106`-`:109`, `zIndex: 45` (`:110`), width
  `minWidth: 280` / `maxWidth: 'min(420px, calc(100vw - 32px))'` (`:111`-`:112`).
  Suppresses in explore at `:38`, on any open chat at `:40`, and when
  `!nearLocation` at `:41`. Calls `useIsMobile()` at `:34`. Bottom offset formula
  at `:95`-`:98`.
- `TalkToCharacterBar` (`apps/web/src/components/game/talk-to-character-bar.tsx`):
  still MOUNTED at `page.tsx:686`. Its render gate is `:58`
  (`if (controlMode !== 'npc' || chatOpen || nearLocation) return null;`), and its
  container is `fixed bottom-0 left-1/2 -translate-x-1/2 z-50` at `:127`.
  **`z-50` is above LocationHUD's `zIndex: 45`**, so it would draw over the pill.
  The comment at `location-hud.tsx:52`-`:53` claiming this bar was "REMOVED" is
  STALE; the component is alive. Do not trust that comment.

---

## 2. Design decisions (frozen; do not re-litigate)

**D1 — one centralized tracker, not an extension of the building check.**
Building proximity is computed in three separate unthrottled places and covers
neither autonomous mode nor a common data path. Rev 2 adds ONE new tracker rather
than editing any of the three.

**D2 — building precedence is enforced RENDER-side, not tracker-side.**
The tracker writes `nearParcelCode` regardless of `nearLocation`; the pill
returns null when `nearLocation` is set. This is the cheaper option (the tracker
does not read a second store axis, and no ordering dependency exists between two
writers). Rev 1 asked for this choice to be made and documented; it is made here.

**D3 — the pill renders only for an EXPLICITLY hydrated parcelCode.**
This is the blocker fix. It closes three holes at once, only one of which the
critique named: (a) a status outside the two hydrated ones, (b) a FAILED fetch,
which today leaves the store empty so every parcel would read "Available",
(c) the pre-hydration window on first mount. (b) and (c) are live today; (a) is
currently latent (see §10).

**D4 — Pixi is out of scope.** `PixiCanvas` is referenced only by its own
definition (`apps/web/src/components/pixi/PixiCanvas.tsx:287`) and by comments;
`useGameLoop` is imported only by `PixiCanvas` itself. There is no mount site.
The pure helper in §4.1 is the seam if 2D is ever revived.

**D5 — helper takes centered world coordinates only.** No overload, no mode flag,
no map-pixel entry point. Every caller converts.

---

## 3. File-by-file changes

Seven files. All client-side. No `apps/api/**`, no `packages/**` source change.

### 3.1 NEW `apps/web/src/lib/land-proximity.ts`

Three-free module (no `three`, no `@react-three/*`, no React), following the
established dependency-light pattern of `apps/web/src/lib/land-query-keys.ts`.
Its only import is `{ LAND_PARCELS, type ParcelSlot } from '@clawville/shared'`.

Exact exported surface:

```ts
/** Tight Chebyshev ring bounds, derived at module load from LAND_PARCELS. */
export const LAND_PROXIMITY_INNER_WU: number;
export const LAND_PROXIMITY_OUTER_WU: number;

/**
 * Return the parcelCode whose square footprint contains the point, or null.
 * @param x centered world X (wu). NOT map-pixel.
 * @param z centered world Z (wu). NOT map-pixel.
 */
export function findParcelAtWorldPos(x: number, z: number): string | null;

/** O(1) lookup of the geometry slot for a parcelCode, or null. */
export function getParcelSlotByCode(code: string): ParcelSlot | null;
```

Implementation contract:

1. At module load, one plain indexed loop over `LAND_PARCELS` computes both gate
   constants and fills a `Map<string, ParcelSlot>` for `getParcelSlotByCode`:
   - `LAND_PROXIMITY_INNER_WU = min over parcels of (max(|cx|, |cz|) - size / 2)`
   - `LAND_PROXIMITY_OUTER_WU = max over parcels of (max(|cx|, |cz|) + size / 2)`
   With today's supply these evaluate to 5472 and 10304. Assert those two values
   in the unit test so a supply change surfaces as a test diff rather than a
   silent behavior change.
   Soundness: every parcel center sits exactly on its square frame, so
   `max(|cx|, |cz|)` equals that frame's radius. For a point inside a parcel,
   at least one axis is within `size / 2` of a coordinate of magnitude `R`, hence
   `max(|x|, |z|) >= R - size / 2 >= INNER` and `<= R + size / 2 <= OUTER`. Both
   gates are conservative and exact; neither can produce a false negative.
2. `findParcelAtWorldPos`:
   - `const r = Math.max(Math.abs(x), Math.abs(z)); if (r < INNER || r > OUTER) return null;`
   - then `for (let i = 0; i < LAND_PARCELS.length; i++)` with
     `const p = LAND_PARCELS[i]; const half = p.size * 0.5;`
     `if (Math.abs(x - p.cx) <= half && Math.abs(z - p.cz) <= half) return p.id;`
   - `return null;`
   - **Zero allocations.** No `.find` / `.filter` / `.map` / `.some`, no closures,
     no destructuring of the slot into a new object, no result object, no
     `Math.hypot`, no temporary arrays. The function must be callable 5x/sec
     forever without producing GC pressure (Iris Xe rule).
   - First match wins; the geometry proof at `land-parcels.ts:40`-`:67` guarantees
     no two footprints overlap.

### 3.2 EDIT `apps/web/src/components/three/World3DCanvas.tsx` — new `LandProximityTracker`

Add a new headless component immediately AFTER `MinimapPositionTracker` (which
ends at `:1228`), and mount it immediately after `<MinimapPositionTracker />`
(`:2211`). It returns `null` and adds zero geometry, zero materials, zero draw
calls.

New import: `findParcelAtWorldPos` from `@/lib/land-proximity`.
Everything else it needs is already imported in this file: `useSceneFrame`
(`:11`), `useGameStore` + `avatarPositionRef` (`:65`), `useNpcStore`, `HALF_W` /
`HALF_H` (`:112`-`:113`).

Body contract:

```
useSceneFrame(({ clock }) => {
  now = clock.elapsedTime
  if (now - lastRef.current < 0.2) return      // 5 Hz, same gate as :1183
  lastRef.current = now

  store = useGameStore.getState()
  mode  = store.controlMode

  mapX / mapY resolution:
    'player'      -> avatarPositionRef.x, avatarPositionRef.y
    'npc'         -> npcs.find(n => n.id === store.possessedNpcId)  -> npc.x, npc.y
                     (no possessedNpcId or no match -> clear to null, return)
    'autonomous'  -> npcs.find(n => n.id === store.autonomousBodyId) -> body.x, body.y
                     (no autonomousBodyId or no match -> clear to null, return)
    'explore'     -> clear to null, return          // free camera, no walking body

  worldX = mapX - HALF_W
  worldZ = mapY - HALF_H
  code   = findParcelAtWorldPos(worldX, worldZ)
  if (code !== store.nearParcelCode) store.setNearParcelCode(code)
})
```

Notes the implementer must honor:

- "clear to null" means `if (store.nearParcelCode !== null) store.setNearParcelCode(null)`.
  Never leave a stale code behind when the body source disappears.
- Autonomous uses the RAW confirmed snapshot (`body.x` / `body.y`), exactly like
  `MinimapPositionTracker:1200`-`:1203`, NOT the damped/interpolated follow value
  used by `FPSFollowCamera:676`-`:689`. Raw confirmed snapshots are more than
  adequate against a 1088-1216 wu footprint at 5 Hz, and this keeps the tracker
  free of any extrapolation (3dStructure §6z bans extrapolation for NPC entities).
- The two `.find` calls allocate a closure per invocation. That is accepted: it
  runs at most 5x/sec and is the EXACT existing pattern at `:1193` and `:1201`.
  The zero-allocation mandate binds strictly on the new per-parcel sweep in §3.1,
  which is the only new hot code.
- Do NOT read `nearLocation` here (decision D2).

### 3.3 EDIT `apps/web/src/stores/game.ts` — new proximity axis

**Interface** — declare directly after `setNearCharacter` (`:180`):

```ts
  // Near land parcel — parcelCode of the parcel whose footprint the ACTIVE body
  // is standing inside, or null. Written at 5 Hz by LandProximityTracker
  // (World3DCanvas). Building precedence is enforced render-side by
  // LandOptionsPill, not here.
  nearParcelCode: string | null;
  setNearParcelCode: (code: string | null) => void;
```

**Implementation** — directly after the `setNearCharacter` impl (`:902`-`:906`),
mirroring the `setNearLocation` no-op guard at `:897`-`:900`:

```ts
  nearParcelCode: null,
  setNearParcelCode: (code) => {
    if (code === get().nearParcelCode) return;
    set({ nearParcelCode: code });
  },
```

**Clear sites** — add `nearParcelCode: null` at every place `nearLocation` is
cleared today. Exact line regions in the current file:

| Function | Line region | How to add |
|---|---|---|
| `setControlMode` | `:800` (the `...(mode === 'explore' \|\| mode === 'autonomous' ? { nearLocation: null, nearCharacter: null } : {})` spread) | Add `nearParcelCode: null` as an **UNCONDITIONAL** key in the same `set({...})` object, NOT inside the conditional spread. Rationale: every mode change swaps which body is tracked, so the previous body's parcel is stale in all directions (player→autonomous, npc→player, etc). The tracker re-establishes within 200ms. |
| `openBuildingPortal` | `:945`-`:946` | Add beside `nearLocation: null, nearCharacter: null`. |
| `enterBuilding` | `:1004`-`:1005` | Add beside `nearLocation: null, nearCharacter: null`. |
| `resetStore` | `:1466`-`:1467` | Add beside `nearLocation: null, nearCharacter: null`. This also covers the identity sweep: `clearIdentityState` calls `resetStore()` (`apps/web/src/lib/clear-identity-state.ts:57`). |

**Deliberately NOT cleared:** `openLandOffice` (`:1278`-`:1281`). The pill
self-suppresses while `landOfficeOpen` is true, and clearing here would make the
pill blink off then back on when the modal closes, before the tracker's next tick.

### 3.4 EDIT `apps/web/src/lib/three/land-state-hydrator.tsx` — full status coverage

Change `fetchAllParcelStates()` (`:58`-`:80`) from two requests to four.

```ts
const [availableResult, ownedResult, reservedResult, retiredResult] =
  await Promise.allSettled([
    api.getLandParcels({ status: 'available' }),
    api.getLandParcels({ status: 'owned' }),
    api.getLandParcels({ status: 'reserved' }),
    api.getLandParcels({ status: 'retired' }),
  ]);
```

and merge in the SAME order:

```ts
if (availableResult.status === 'fulfilled') merge(availableResult.value);
if (ownedResult.status    === 'fulfilled') merge(ownedResult.value);
if (reservedResult.status === 'fulfilled') merge(reservedResult.value);
if (retiredResult.status  === 'fulfilled') merge(retiredResult.value);
```

`mapStatus` (`:46`-`:53`) already maps all four; leave it alone. Update the file
header comment at `:8`-`:9` and `:24`-`:25`, which currently says "available +
owned", and drop the now-wrong line at `:25` ("'retired' parcels are included in
the owned fetch if the server returns them" — they are not; the filter is exact,
`apps/api/src/routes/land.ts:857`-`:859`).

**Merge-safety analysis (this is why the change is safe):**

- Within one fetch the four lists are merged into ONE fresh record, then pushed
  in a single `setParcels(data)` call at `:106`. The store's PATCH semantics
  (`stores/land.ts:85`-`:92`) mean this only ADDS or OVERWRITES keys present in
  the record; nothing is dropped.
- The four queries are four separate snapshots, so a parcel changing status
  mid-batch could appear in two lists. Merge order resolves that: later wins.
  Order is chosen so the SUPPRESSING statuses win, which fails safe (a pill that
  does not render beats a pill that renders the wrong thing). Self-corrects on
  the next 60s refetch.
- The existing `available` then `owned` relative order is PRESERVED exactly, so
  no current behavior changes.
- Going from 2 to 4 statuses actually makes the patch semantics SOUND for the
  first time. Today a parcel transitioning from `owned` to `reserved` would keep
  its stale `owned` entry in the client map forever, because no fetch would ever
  re-report it. After this change every reachable status is covered.
- **Cost:** the endpoint is capped at 60 req/min/IP (`apps/api/src/routes/land.ts:439`).
  With `staleTime: 60_000` a client spends 4 of 60 per minute (6.7%), plus
  post-claim invalidations. The server holds a 60s cache per `(tier, status)` key
  (`:852`-`:854`), so the two new keys cost 2 extra DB queries per minute
  GLOBALLY, not per client. Acceptable.

### 3.5 NEW `apps/web/src/components/game/land-options-pill.tsx`

Default export `LandOptionsPill`, `'use client'`.

**Hook order (React rules of hooks).** Call every hook unconditionally FIRST, then
the early returns. Mirror `location-hud.tsx:27`-`:41`.

Hooks:

```ts
const controlMode      = useGameStore((s: GameState) => s.controlMode);
const nearLocation     = useGameStore((s: GameState) => s.nearLocation);
const nearParcelCode   = useGameStore((s: GameState) => s.nearParcelCode);
const chatOpen         = useGameStore((s: GameState) => s.chatOpen);
const guideChatOpen    = useGameStore((s: GameState) => s.guideChatOpen);
const landOfficeOpen   = useGameStore((s: GameState) => s.landOfficeOpen);
const openLandOffice   = useGameStore((s: GameState) => s.openLandOffice);
const parcels          = useLandStore((s) => s.parcels);
const { data: avatar } = useAvatar();
const isGuest          = useIsGuest();
const isMobile         = useIsMobile();
```

**Gate ladder, in this exact order:**

1. `if (controlMode === 'explore') return null;` (no walking body)
2. `if (chatOpen || guideChatOpen || landOfficeOpen) return null;` (a foreground
   surface owns the screen; mirrors `location-hud.tsx:40` and adds the modal)
3. `if (nearLocation) return null;` (**building precedence**, decision D2)
4. `if (!nearParcelCode) return null;`
5. `const state = parcels.get(nearParcelCode); if (!state) return null;`
   (**D3 — explicit hydration required. Never call `getParcelStatus()` here and
   never write `?? 'available'` anywhere in this file.**)
6. `if (state.status === 'reserved' || state.status === 'retired') return null;`

Then derive:

```ts
const slot     = getParcelSlotByCode(nearParcelCode);   // for the tier
const tier     = slot?.tier ?? null;
const myId     = (avatar as { id?: string } | null | undefined)?.id ?? null;
const ownedByMe= state.status === 'owned' && !!myId && state.ownerAvatarId === myId;
```

Rendering per §5. Actionable variants render a `<button type="button">`;
info-only variants render a `<div>` so there is no dead tap target.

**Positioning — restate, do not inherit (critique finding 6):**

```ts
const hasBottomChatBar = controlMode === 'player' || controlMode === 'autonomous';
const bottomOffset = isMobile
  ? 'max(calc(env(safe-area-inset-bottom, 0px) + 220px), 240px)'
  : `calc(env(safe-area-inset-bottom, 0px) + ${hasBottomChatBar ? 84 : 36}px)`;
```

This is character-identical to `location-hud.tsx:95`-`:98`. It is safe to occupy
the same slot because gate 3 guarantees LocationHUD is hidden whenever this pill
renders. If that formula is ever changed in LocationHUD it MUST be changed here in
the same diff; add a one-line comment pointing at `location-hud.tsx:95`.

Style, mirroring `location-hud.tsx:105`-`:132` with the differences called out:

- `position: 'fixed'`, `bottom: bottomOffset`, `left: '50%'`,
  `transform: 'translateX(-50%)'`, `zIndex: 45`, `minWidth: 280`,
  `maxWidth: 'min(420px, calc(100vw - 32px))'`, `borderRadius: 999`,
  `padding: '14px 28px'`, `backdropFilter: 'blur(8px)'`,
  `touchAction: 'manipulation'`, `userSelect: 'none'`.
- Same dark gradient panel. **Light text only** on it: title `#fff`, secondary
  `rgba(253, 230, 138, 0.85)` or `#e0f2fe`. Never a dark token on this panel.
- **Amber accent instead of cyan** so a parcel pill is not mistaken for a building
  pill: border `1.5px solid rgba(251, 191, 36, 0.55)`, matching glow. Amber ties
  to the Land Office's own price/threshold color
  (`land-office-modal.tsx:459`, `text-amber-300`).
- **NO pulse animation.** The building pill pulses (`location-hud.tsx:126`,
  `:134`-`:149`) because entering a building is the primary call to action; the
  parcel pill is secondary and must not compete for attention.
- Rendered height must clear 44px for the actionable variants (the padding plus
  two text rows already does; do not shrink it).

### 3.6 EDIT `apps/web/src/app/(world)/game/page.tsx` — mount

- Add `import LandOptionsPill from '@/components/game/land-options-pill';` beside
  the other game-component imports (near `:23`).
- Mount INSIDE the existing `{hasAvatar && (<>...</>)}` block, on the line
  immediately after `<LocationHUD />` (`:664`).

Why this mount point satisfies decision 7 (evidence, not assumption): `hasAvatar`
is `!!avatar` from `useAvatar()` (`:544`); guests are minted an avatar by
`GuestAvatarBootstrap` (`:642`) and the block's own comment (`:654`-`:661`) states
it is for "ALL avatar-bearing visitors including guests". So GUEST npc mode
renders the pill. Anonymous explore has no avatar and no walking body, so it gets
no pill, which is the intended behavior, not a gap. No second mount site is needed.

Also extend the block comment at `:654`-`:661` with one sentence naming the pill.

### 3.7 EDIT `apps/web/src/components/game/talk-to-character-bar.tsx` — one-line suppression

- Add the selector beside `:34`:
  `const nearParcelCode = useGameStore((s) => s.nearParcelCode);`
- Change the gate at `:58` from
  `if (controlMode !== 'npc' || chatOpen || nearLocation) return null;`
  to
  `if (controlMode !== 'npc' || chatOpen || nearLocation || nearParcelCode) return null;`
- Extend the comment at `:53`-`:57` to name the parcel case.
- Update the mount-site comment at `page.tsx:683`-`:685`, which currently states
  the self-gate as `controlMode === 'npc' && !chatOpen && !nearLocation`.

This is REQUIRED, not belt-and-braces: the bar's container is `z-50` (`:127`),
above the pill's `zIndex: 45`, so without it the bar draws over the pill in guest
npc mode, which is exactly the mode decision 7 pins as supported.

---

## 4. Bottom-slot arbitration

Precedence: **building > parcel > NPC talk prompt.**

| `nearLocation` | `nearParcelCode` | LocationHUD | LandOptionsPill | TalkToCharacterBar (npc mode) |
|---|---|---|---|---|
| set | set | renders | null (gate 3) | null (existing `nearLocation` clause) |
| set | null | renders | null (gate 4) | null (existing clause) |
| null | set | null (`:41`) | **renders** | null (**new** `nearParcelCode` clause) |
| null | null | null (`:41`) | null (gate 4) | renders |

Independent of precedence, all three yield to an open chat, and the pill
additionally yields to an open Land Office modal.

---

## 5. Copy table

Rules: no em dashes. Never the words "For Sale", "Buy", "Purchase", or "Sale".
Separator is the middle dot `·`, as LocationHUD already uses (`:159`). Light text
on the dark panel. `<code>` renders the raw parcelCode, e.g. `parcel-c-07`.

| Store state | Tier | Guest | Title | Sub line | Action |
|---|---|---|---|---|---|
| `available` | starter | no | `Parcel <code> · Available` | `Refundable vCLAW deposit` | button **`View in Land Office`** |
| `available` | c / b / a / founder | no | `Parcel <code> · Available` | `Hold $CLAWVILLE to keep` | button **`View in Land Office`** |
| `available` | any | yes | `Parcel <code> · Available` | `Preview the Land Office` | button **`View in Land Office`** |
| `owned`, `ownerAvatarId === myId` | any | n/a | `Your parcel <code>` | `Manage your land` | button **`Manage`** |
| `owned`, other owner | any | any | `Claimed parcel <code>` | `Someone already holds this lot` | none (info-only `<div>`) |
| `reserved` or `retired` | any | any | nothing rendered | | |
| parcelCode not in the hydrated map | any | any | nothing rendered | | |

Leading glyph `🏝️` on the title row for every rendered variant.

Both buttons call `openLandOffice(nearParcelCode)` (`game.ts:1278`-`:1281`).

**Why one label works for every case.** "View in Land Office" promises the Land
Office, not the lot. That keeps it truthful in all three places where the lot is
NOT guaranteed: guests land in `GuestLandSandbox` with focus ignored
(`land-office-modal.tsx:2146`, `:2236`); the starter claim auto-picks a lot
(`:494`-`:500`); and a hold claim can still fail the CLV threshold server-side.
Do not "improve" this label to "Claim this parcel" or "Open parcel <code>".

Guests still pass `nearParcelCode` to `openLandOffice`; the argument is harmlessly
ignored on that path.

---

## 6. Explicit NON-scope

Out of scope, and a diff touching any of these is a spec violation:

- Any `apps/api/**` change. The four statuses are already accepted
  (`land.ts:311`, `:316`, `:318`-`:323`).
- Any schema, migration, or seed change.
- Any `[ACTION:]` verb, `PROTOCOL_VERSION`, skill-manual, or Nori knowledge
  change. Agents keep their existing land REST path; see the PARITY note in §11.
- `LandOfficeModal` behavior of ANY kind, including its "🏝️ For Sale" tab label
  at `:2243`. That label is pre-existing copy debt; see §10.
- The 3D scene: no geometry, no material, no draw call, no shader, no GLB. The
  pill is DOM; the tracker returns `null`.
- The sign-hitbox click path (`land-parcels.tsx:790`-`:826`) and its inline
  `?? 'available'` default.
- `player-avatar.tsx`, `npc-controller.tsx`, and the building proximity checks.
- Pixi (`apps/web/src/lib/pixi/use-game-loop.ts`, `components/pixi/PixiCanvas.tsx`).
  Dead path, decision D4.
- Agent-session-only ownership rendering (critique finding 10, accepted as minor).

NEWLY IN SCOPE relative to rev 1, both client-only: the `TalkToCharacterBar`
one-line suppression (§3.7) and the `LandStateHydrator` status coverage (§3.4).

---

## 7. Docs, same diff

| Doc | What to add |
|---|---|
| `GameFeatures.md` | Land section: the proximity pill, the precedence table from §4, the copy table from §5, guest behavior, and the fact that a non-hydrated parcel renders nothing. Bump "Last Audited". |
| `3dStructure.md` | **Required** because `apps/web/src/components/three/World3DCanvas.tsx` is edited (CLAUDE.md file-path trigger table). Add `LandProximityTracker` to the World3DCanvas component inventory beside `MinimapPositionTracker`: headless, 5 Hz, zero geometry, zero draw calls, no allocations in the sweep. Bump "Last Audited" with a one-line drift note. |
| NEW `docs/land-options-popup-notes.md` | Inventory of what was implemented, the verification record (every gate in §9 with its actual result), and an honest gaps section seeded from §10. |
| `deploy-status.md` | On push only; the orchestrator owns this. |

---

## 8. Offline verification checklist

Gates 1 to 6 are offline and owned by the implementer. Gates 7 and 8 need a
browser and are owned by the orchestrator.

**Gate 1 — build.** From the repo root, `bun run build` exits 0.

**Gate 2 — types.** `cd apps/web && bun run typecheck` (which is `tsc --noEmit`)
exits 0. Note `apps/web` has no `test` script; tests are colocated `*.test.ts`
files run by `bun test` from the root.

**Gate 3 — new unit test** at `apps/web/src/lib/land-proximity.test.ts`, run with
`bun test apps/web/src/lib/land-proximity.test.ts`. Required cases:

1. `LAND_PROXIMITY_INNER_WU === 5472` and `LAND_PROXIMITY_OUTER_WU === 10304`
   (pins the derivation against today's supply).
2. Town center `(0, 0)` returns `null` (early-out taken).
3. For EVERY parcel in `LAND_PARCELS`, its exact center `(cx, cz)` returns its
   own `id`. Fifty-six assertions, cheap, catches any axis swap.
4. A point just INSIDE an edge, `(cx + size / 2 - 1, cz)`, returns that `id`.
5. A point just OUTSIDE the same edge, `(cx + size / 2 + 1, cz)`, does NOT return
   that `id` (null or a different id are both acceptable; assert `!== id`).
6. A corner point `(cx + size / 2, cz + size / 2)` returns the `id` (inclusive
   bound, matching `<=` in the test).
7. Far outside the world, `(20000, 20000)`, returns `null`.
8. `getParcelSlotByCode('parcel-c-00')` returns a slot whose `id` matches;
   `getParcelSlotByCode('nope')` returns `null`.
9. Allocation discipline is not machine-checkable here; instead assert
   `findParcelAtWorldPos` returns a `string | null` primitive and never an object.

**Gate 4 — coordinate-space audit (grep, must be clean).** In
`land-proximity.ts`, there is no reference to `HALF_W`, `HALF_H`, `MAP_WIDTH`,
`MAP_HEIGHT`, or the literal `11264`. The helper is centered-world-only (D5), and
every conversion lives at the call site in `World3DCanvas.tsx`.

**Gate 5 — poison-default audit (grep, must be clean).** Neither
`land-options-pill.tsx` nor `land-proximity.ts` contains `?? 'available'` or a
call to `getParcelStatus`. This is the D3 blocker fix and is the single most
important grep in this list.

**Gate 6 — allocation audit (read, must be clean).** The body of
`findParcelAtWorldPos` contains no `.find(`, `.filter(`, `.map(`, `.some(`, no
object or array literal, and no arrow function.

**Gate 7 — browser walk-ons** (`bun run build && bun run start`, localhost:3000,
never `bun run dev`):

- Logged-in **player** mode: walk onto an AVAILABLE parcel. Pill appears within
  about 200ms. Tapping it opens the Land Office with that parcel's card focused
  and highlighted (`FOCUSED_CARD_ID`, `land-office-modal.tsx:445`-`:450`).
- Walk from that parcel toward a building until `nearLocation` sets: the pill
  disappears and LocationHUD takes over. Walk back: the pill returns.
- Walk onto a parcel owned by the signed-in account: reads `Your parcel <code>`
  with **Manage**.
- Walk onto a parcel owned by someone else (staging landtest account owns one):
  reads `Claimed parcel <code>`, info-only, not tappable.
- Walk off every parcel: pill disappears.
- Toggle player to autonomous while standing on a parcel: pill clears
  immediately, then re-establishes only if the agent's body is also on a parcel.
- **Guest npc mode** (fresh isolated guest, no account): pill appears on an
  available parcel with **View in Land Office**; tapping opens the guest sandbox;
  the `TalkToCharacterBar` does NOT draw over it.
- Explore mode: no pill anywhere on the map.

**Gate 8 — viewport sweep** via `chrome-devtools` `emulate`, at 390x844,
744x1133, 820x1180, and 1024x1366, **portrait AND landscape**. Per size confirm:
both joystick zones visible and not covered; the pill does not overlap the
joysticks, the minimap, the Nori button, or the avatar chat bar; the tap target
is at least 44px; the pill is horizontally centered and does not clip at
`maxWidth`. State explicitly in the notes doc that `env(safe-area-inset-*)` does
NOT exist in devtools emulation, so the bottom-anchored safe-area math is NOT
proven by this sweep and needs one real-iPad screenshot from the founder.

---

## 9. Honest residuals and limitations

State these in `docs/land-options-popup-notes.md`; do not quietly drop them.

1. **The reserved/retired hole is currently LATENT, not live.** No code path in
   `apps/api/src` writes `'reserved'` or `'retired'` to `land_parcels` today (the
   only `status: 'reserved'` hit in the API is `services/keypair-vault.ts:147`,
   an unrelated table). So the critique's "reserved and retired parcels will be
   reported as available" describes a real DEFECT MECHANISM with a currently
   empty blast radius. The genuinely live half of the same bug is the FAILED and
   PRE-HYDRATION cases: `throwOnError: false` plus `retry: 1`
   (`land-state-hydrator.tsx:96`-`:99`) means a network blip leaves the store
   empty, and under the `?? 'available'` default a naive pill would tell every
   player that every parcel, including occupied ones, is available. D3 fixes all
   three at once.
2. **The `?? 'available'` poison survives elsewhere.** `getParcelStatus`
   (`stores/land.ts:115`-`:120`) and the sign-hitbox filter
   (`land-parcels.tsx:790`) still carry it. Fixing those would change 3D
   for-sale-sign rendering, which is out of scope for a UI-affordance slice, and
   changing sign visibility on a failed fetch is a separate judgment call. Filed
   here as known debt, not fixed.
3. **The Land Office modal still says "For Sale".** Its tab label at
   `land-office-modal.tsx:2243` is `🏝️ For Sale`. The pill therefore improves the
   in-world copy while the modal it opens still uses the retired framing. Not
   fixed here (non-scope), and worth a follow-up.
4. **5 Hz means up to a 200ms lag** on the pill appearing and disappearing at a
   footprint boundary. Against 1088-1216 wu footprints this is imperceptible, but
   it is a deliberate trade, not an oversight.
5. **Safe-area positioning cannot be proven offline.** See gate 8.
6. **Autonomous coverage depends on `autonomousBodyId` being confirmed.** During
   the window between the mode toggle and the first SSE tick the id is null and
   the tracker holds `nearParcelCode` at null. This mirrors what
   `MinimapPositionTracker:1200`-`:1204` and `FPSFollowCamera:654`-`:664` already
   do, and produces no pill rather than a wrong pill.
7. **Pixi has no parcel proximity.** By decision D4, and the path is dead.
8. **Ownership is browser-session-scoped.** `useAvatar()` resolves through
   `/api/avatars/me`, so a raw agent-session-only client would not see the
   "Your parcel" variant. Accepted (critique finding 10, MINOR).

---

## 10. Critique findings: disposition

| Finding | Disposition |
|---|---|
| 1. Spec file missing | **REJECTED as stale.** `docs/land-options-popup-brief.md` exists in this worktree (untracked at review time, which is why the reviewer could not see it). No spec content was affected. |
| 2. `nearLocation` mechanism does not cover every mode | **ACCEPTED**, with a correction: the reviewer listed the VRM and GLB player paths as two separate producers, but both read the same module-scope `avatarPositionRef` (`player-avatar.tsx:611`, `:1113`), so one tracker covers both. Fixed by §3.2. |
| 3. reserved/retired reported as available | **ACCEPTED as a mechanism**, downgraded on live impact (see §9.1), and fixed more broadly than proposed: §3.4 hydrates all four statuses AND §3.5 gate 5 refuses to render on any non-hydrated code, which also covers fetch failure and the pre-hydration window that the critique did not name. The critique's suggested "replace the map atomically rather than patching" was NOT adopted: `setParcels` patch semantics (`stores/land.ts:85`-`:92`) are correct once all four statuses are fetched, and switching to replace would break the Land Office's own partial push at `land-office-modal.tsx:2133`. |
| 4. Coordinate parity requires conversion | **ACCEPTED.** D5 plus §1.2 and §3.2. |
| 5. "throttle identical to the building check" unsupported | **ACCEPTED.** The building checks are unthrottled; rev 1 was wrong. §3.2 uses the 5 Hz `MinimapPositionTracker` pattern. |
| 6. HUD slot overlap and precedence | **ACCEPTED.** §3.7 plus §4. Verified independently that `TalkToCharacterBar` is still mounted (`page.tsx:686`) at `z-50` (`:127`) despite the stale "REMOVED" comment at `location-hud.tsx:52`. |
| 7. "Guests see the pill" only conditionally true | **ACCEPTED and pinned.** §3.6 and §5. Guests ARE avatar-bearing, so the `hasAvatar` block does reach guest npc mode; anonymous explore is deliberately excluded. |
| 8. "For Sale" is wrong language | **ACCEPTED.** §5. One sub-point CORRECTED: the critique implied founder parcels should never be presented as acquirable. They are acquirable, via hold-to-keep at 10M CLV, and the modal renders a live Claim button for them (§1.8). Founder gets the "Available" plus hold framing, never "for sale" or "buy". |
| 9. Lifecycle clearing | **ACCEPTED.** §3.3, with the four exact sites and the no-op setter guard. |
| 10. Agent-session ownership | **ACCEPTED as out of scope.** §6 and §9.8. |

---

## 11. PARITY note (carry verbatim in the commit body)

> PARITY: human path: in-world `LandOptionsPill` proximity affordance in
> player/autonomous/guest-npc modes, routing into the existing Land Office modal.
> Agent path: UNCHANGED. Connected and hosted agents continue to use the existing
> land REST surface (`GET /api/land/parcels`, `GET /api/land/me`,
> `POST /api/land/claim-starter`, `POST /api/land/parcels/:id/claim-hold`), which
> already resolves agent identity through `requireAuthOrAgentSession`
> (`apps/api/src/routes/land.ts:908`). This slice adds a human/guest UI affordance
> over surfaces both subjects already reach; it adds no new capability that an
> agent lacks, mutates no economy state, and needs no `[ACTION:]` verb or
> `PROTOCOL_VERSION` bump.

---

## 12. Working rules for the implementer

- Verify before you write. Every file:line above was checked against this
  worktree on 2026-07-30, but files move. If a stated fact is wrong, STOP, record
  the discrepancy in the report and in `docs/land-options-popup-notes.md`,
  implement against the REAL code, and log the deviation. Never improvise
  silently.
- No browser MCP tools. Gates 1 to 6 only; the orchestrator owns 7 and 8.
- Serial steps, wip commits, no pushes.
- Never `bun run dev` (Iris Xe WebGPU crash). Local verification is
  `bun run build && bun run start` on :3000.
- Markers `land-pill.done` / `land-pill.blocked` plus report `land-pill-report.md`
  in the orchestrator-provided scratchpad reports directory.
