# Reef Race Phase 2 — Detailed Implementation Plan

## Changelog

- **v2 (2026-04-25)** — Addresses audit SHA `8767545` (`.claude/plans/reef-race-phase2-audit.md`). Revisions in this pass:
  - **C1 fix:** `BotRoomView` extended with `lap`, `nextCheckpoint`, `currentPlacement` per body (+ `finishedAt`/`dnf` for filtering). `buildBotRoomView` rewritten to project these from `state.bodies` + `state.lastPlacementMap`. Added to §11 file-scope.
  - **C2 fix:** `event.power_up_collected` carries `kind: ReefPowerUpKind` so the HUD swaps the inventory slot the moment the placement-aware re-roll runs (option `(a)` from audit C2). Inventory broadcast channel is NOT wired in Phase 2 — flagged out-of-scope. Section §4.1 updated.
  - **C3 fix:** `lastSlipstreamEventAt` added to `ActivityState` (§7.1), set inside the `event.slipstream` case branch (§7.2), read by the auto-clear (§7.3).
  - **C4/C5 fix:** `applyIntentForTick` step 4 redesigned with a separate `positiveStack` (capped at `KINEMATIC_BOOST_CAP = 0.85`) and `negativeStack` (floored at `NEGATIVE_KINETIC_FLOOR = -0.50`). The `Math.max(positive, pickup)` competition stays for the POSITIVE slot only; negatives ALWAYS subtract. Property bullets re-derived against the new arithmetic. New §2.3.x worked example table.
  - **C6 fix:** `KINEMATIC_BOOST_FLOOR` renamed to `NEGATIVE_KINETIC_FLOOR` to make clear it's a floor on the SUM-OF-NEGATIVES, not a `speedMod` floor. The absolute `speedMod` floor (`Math.max(0.5, ...)`) is documented as the third clamp in the chain.
  - **S1 fix:** `event.apex_bonus` renamed to `event.apex_verdict` carrying `kind: 'clean' | 'wide'`. HUD toast renamed `<ReefRaceApexToast>`.
  - **S3 fix:** Per-event firing-frequency analysis added in §4.6.
  - **S4 fix:** `event.slipstream_end` event added so HUD can hide DRAFT badge cleanly without 100ms timer polling.
  - **S5 fix:** §12 (now §13 — see structure below) lists the town-guide knowledge[] update with explicit text covering all five mechanics + "shields don't block hazards" rule.
  - **S6 fix:** §2.2 rewritten against the actual `tickRoom` step numbering (0..9 from `reef-race-sim.ts:677-748`). Phase 2 insertion points re-stated unambiguously.
  - **S7 fix:** `state.lastPlacementMap` invalidation specified — refreshed at the TOP of `tickRoom` (just after `state.tick += 1`), every tick. §2.6 + §3.1.
  - **S13 fix:** `rib-top` ribbon moved to a clearly-on-straight section (`t=0.92`/`t=0.98` — both BEFORE `t=0`). Lap-up cleanup uses `body.lap` PRE-increment as the key so the just-collected boost survives the lap rollover. §1.5 + §2.11.
  - **N12 fix (promoted to significant):** Bot heuristics gated by `BOT_OPENING_GRACE_MS` short-circuit for draft / apex / hazard / placement-fire blocks. §8.2.
  - **Test gap fixes (G1-G9):** New tests P2-T35 (chain drafting), P2-T36 (leader elimination mid-draft), P2-T37 (ribbon at start/finish lap-up), P2-T38 (hazard during stall — verifies plan §2.12 row), P2-T39 (positive + negative kineticMult combination), P2-T40 (placement on finish), P2-T41 (ribbon during ink-slick), P2-T42 (snapshot bandwidth baseline fixture protocol). Total tests now 42.
  - **Implementation order fix:** §12 (was the old §12) replaced with explicit 10 sub-PR split per audit recommendation. Phase 2 ships as ONE PR with internal commits in the recommended order (see §12 for the full rationale and the explicit "ONE PR vs many PRs" decision).

- **v1 (2026-04-25)** — Original plan, SHA `ea723ee`.

---

**Status:** Revised v2 — ready for second-pass audit.
**Branch:** `worktree-fix-bumper-build` (worktree at `.claude/worktrees/fix-bumper-build`)
**Date authored:** 2026-04-25
**Author:** Orchestrator (planning pass)
**High-level design:** `.claude/plans/reef-race-real-racing.md` §"Phase 2 — depth"
**Phase 1 reference:** `.claude/plans/reef-race-phase1-detailed.md` (SHA `b68068a`) + impl audit `aae73b4`
**Audit addressed:** `.claude/plans/reef-race-phase2-audit.md` (SHA `8767545`)

---

## 0. Baseline facts from source audit (post Phase 1 merge `f4d276e`)

Every value verified against live source.

| Fact | Source | Value |
|---|---|---|
| Sim tick | `reef-race-sim.ts:99` | `REEF_TICK_MS = 1000/30 ≈ 33.33ms` |
| Snapshot delta | `reef-race-sim.ts:103` | 5Hz → every 6 ticks |
| Snapshot keyframe | `reef-race-sim.ts:106` | 1Hz → every 30 ticks |
| Track ellipse | `reef-race-config.ts:110-111` | `REEF_TRACK_A=1100`, `REEF_TRACK_B=700` |
| Track lane half-width | `reef-race-config.ts:114` | `REEF_TRACK_HALF_WIDTH=150` (300wu lane) |
| Centerline / tangent | `reef-race-config.ts:133-155` | `reefCenterlineAt(t)` / `reefTangentAt(t)` — exported |
| Body radius | `reef-race-config.ts:101` | `REEF_BODY_RADIUS=22` |
| Pickup radius | `reef-race-config.ts:284` | `REEF_POWERUP_RADIUS=28` |
| `REEF_MAX_SPEED` | `reef-race-config.ts:85` | 500 wu/s |
| `REEF_BOOST_MULT` (turbo pickup) | `reef-race-config.ts:88` | 1.4× → +0.40 additive |
| Drift boost mults | `reef-race-config.ts:332` | `[0.12, 0.24, 0.38]` (drift-3 = +0.38) |
| Launch boost mult | `reef-race-config.ts:356` | 0.30 (+30%) |
| `REEF_KINEMATIC_TOLERANCE` | `reef-race-config.ts:374` | 2.0× (validators clamp at 1000 wu/s) |
| Hard velocity cap (boost-gated) | `reef-race-sim.ts:1062` | `REEF_MAX_SPEED * 1.85 = 925 wu/s` |
| `activeBoosts` map | `reef-race-sim.ts:178` | `Map<ReefBoostKind, ReefBoostEntry>` |
| `ReefBoostKind` union | `reef-race-config.ts:302` | `'launch-boost' | 'launch-stall' | 'drift-boost'` |
| `applyIntentForTick` step 4 (speedMod) | `reef-race-sim.ts:775-810` | takes MAX of `kineticMult` vs `pickupMult` |
| Boost-gated hard cap site | `reef-race-sim.ts:1057-1067` | inside `integrateMotion`, gate `isBoostActive` |
| Snapshot diff predicate | `reef-race-sim.ts:1487-1500` | field-by-field equality on `prev` vs current |
| `EntityDelta.changed` schema | `protocol.ts:136-145` | open dictionary `[k: string]: unknown` |
| `applyEntityDelta` | `activity.ts:278-314` | explicit field copy; unknown fields ignored |
| `ServerFrame` union exhaustiveness | `activity.ts:758-764` | `default: never` guard — type-only catch |
| `tryUsePowerUp` slot uses | `reef-race-sim.ts:1240-1277` | calls `rollPowerUpKind(state)` once per respawn |
| `rollPowerUpKind` | `reef-race-sim.ts:1588-1597` | weighted draw across 6 kinds, GLOBAL (no placement input) |
| `tickPickups` respawn site | `reef-race-sim.ts:1126-1142` | sets `pk.kind = this.rollPowerUpKind(state)` |
| Test helper `bootDriftRoom` | `reef-race-sim.test.ts:333-352` | reused for drift/launch tests; pattern source |
| Bot opening grace | `reef-race-bot.ts:41` | 2500ms (`BOT_OPENING_GRACE_MS`) |
| Bot view shape (today) | `reef-race-sim.ts:961-1015` | `{petId, x, y, vx, vy, rot, alive, inventory}` per body, plus `selfPetId/arenaRadius/now/matchStartedAt/nextCheckpoint?/checkpoints?` — **no per-body lap/nextCheckpoint/placement (C1 fix below)** |
| Actual `tickRoom` step order | `reef-race-sim.ts:677-748` | 0=runBotControllers; 1=applyIntentForTick; 2=integrateMotion; 3=expire activeEffects+activeBoosts; 4=resolveProximity; 5=resolvePickups; 6=tickPickups; 7=resolveCheckpoints; 8=shouldEndRound; 9=broadcastKeyframe/Delta |

**No file** at `packages/shared/src/types/activity-frames.ts`. Protocol lives in `packages/shared/src/activities/protocol.ts`. All Phase 2 references to "activity-frames.ts" mean `protocol.ts`. The high-level plan (`reef-race-real-racing.md:108`) still mis-references the old path; corrected as part of this revision (§11 file-scope).

---

## 1. Constants (server)

All numeric tunables go in `apps/api/src/services/activity/sim/reef-race-config.ts`. Phase 2 introduces the combined-kinematic cap (`KINEMATIC_BOOST_CAP`) and the negatives floor (`NEGATIVE_KINETIC_FLOOR`).

### 1.1 New `ReefBoostKind` extensions

```ts
export type ReefBoostKind =
  | 'launch-boost'      // existing (Phase 1) — positive
  | 'launch-stall'      // existing (Phase 1) — pseudo-effect, gates thrust
  | 'drift-boost'       // existing (Phase 1) — positive
  | 'slipstream-boost'  // NEW Phase 2 — positive (+0.20)
  | 'ribbon-boost'      // NEW Phase 2 — positive (+0.30)
  | 'apex-bonus'        // NEW Phase 2 — positive (+0.05)
  | 'apex-penalty'      // NEW Phase 2 — negative (-0.05)
  | 'hazard-slow';      // NEW Phase 2 — negative (-0.40)
```

`apex-penalty` and `hazard-slow` carry a `mult: number` that is **negative** so the same speedMod arithmetic reads them as a downstream subtraction. The name `boost` is an artifact — the union represents all kinematic effects (positive or negative). **Phase 3 cleanup ticket:** rename to `ReefKineticEffectKind` (audit N6).

The union remains DISTINCT from `ReefPowerUpKind` (Phase 1 audit C2 invariant). `activeBoosts` and `activeEffects` continue to be separate Maps on `ReefBody`.

### 1.2 Combined-kinematic cap and negatives floor (consolidated — was split across §1.2 and §1.8 in v1)

```ts
/**
 * Phase 2 — soft cap on the SUM of POSITIVE kinematic mults applied in
 * applyIntentForTick step 4. Bounds drift + launch + slipstream + ribbon +
 * apex-bonus stacking so the sum never crosses REEF_KINEMATIC_TOLERANCE (2.0×).
 *
 *   Max possible additive positive stack:
 *     drift-3 (0.38) + launch (0.30) + slipstream (0.20) + ribbon (0.30)
 *     + apex-bonus (0.05) = 1.23 → 1 + 1.23 = 2.23×
 *
 *   Cap at 0.85 → 1 + 0.85 = 1.85× = same backstop as the existing hard cap
 *   in integrateMotion. Anti-cheat tolerance (2.0×) buffers above this by
 *   0.15×, leaving room for one tick of integration overshoot.
 *
 *   Negative entries (apex-penalty, hazard-slow) bypass the positive cap (it
 *   should not protect a slow). They are summed into a SEPARATE
 *   negativeStack with its own floor (NEGATIVE_KINETIC_FLOOR).
 */
export const KINEMATIC_BOOST_CAP = 0.85;

/**
 * Phase 2 — floor on the SUM of NEGATIVE kinematic mults. Mirrors the
 * existing ink-slick override (which hard-floors speedMod at 0.5) by limiting
 * how much negatives can stack before the absolute speedMod floor takes over.
 *
 *   Max possible additive negative stack:
 *     hazard-slow (-0.40) + apex-penalty (-0.05) = -0.45
 *
 *   Floor at -0.50 → leaves 0.05 of headroom for any future negative
 *   (Phase 3 wall-scrape, etc.) without changing the absolute floor logic.
 *
 *   THREE clamps in the chain (in order):
 *     1. positiveStack ≤ KINEMATIC_BOOST_CAP    (this constant)
 *     2. negativeStack ≥ NEGATIVE_KINETIC_FLOOR (this constant)
 *     3. speedMod      ≥ 0.5                    (absolute floor in §2.3)
 *
 *   Ink-slick continues to OVERRIDE everything to speedMod = 0.5 (existing).
 */
export const NEGATIVE_KINETIC_FLOOR = -0.50;
```

### 1.3 Slipstream

```ts
/** Min distance behind a target to count as in-wake (wu). Same as Phase 1 body radius pad. */
export const SLIPSTREAM_MIN_DISTANCE = REEF_BODY_RADIUS * 1.5; // 33 wu — avoid self-collision spam
/** Max distance behind a target to count as in-wake (wu). Plan-locked at 50wu. */
export const SLIPSTREAM_MAX_DISTANCE = 50;
/** Half-width of the wake cone behind the target, perpendicular to their velocity (wu). */
export const SLIPSTREAM_HALF_WIDTH = REEF_BODY_RADIUS * 1.5; // 33 wu — slightly wider than 1 body
/** Min |dot(self.vel, target.vel)| / (|self||target|) to count as "moving the same way". */
export const SLIPSTREAM_MIN_VEL_ALIGNMENT = 0.5; // ≈ 60° spread
/**
 * Required consecutive ticks in valid wake to trigger boost. 1.5s × 30Hz = 45 ticks.
 * Same magnitude as DRIFT_SPARK_TICK_3 (full hairpin) — tuned to feel deliberate.
 */
export const SLIPSTREAM_REQUIRED_TICKS = 45;
/**
 * +20% top-speed mult while in-wake, per high-level plan §Phase 2 line 63.
 * Applied as additive contribution to positiveStack, capped via KINEMATIC_BOOST_CAP.
 */
export const SLIPSTREAM_BOOST_MULT = 0.20;
/**
 * Grace ticks after leaving the wake before boost expires AND the server emits
 * `event.slipstream_end`. Avoids dropouts on 1-tick lateral wobble. 0.2s = 6 ticks.
 */
export const SLIPSTREAM_GRACE_TICKS = 6;
/**
 * Active-boost ttl per refresh tick. With SLIPSTREAM_GRACE_TICKS = 6 the natural
 * expiry happens slightly after grace runs out — the server emits the
 * `event.slipstream_end` event at the SAME tick the grace counter hits 0,
 * not when the activeBoosts entry naturally expires.
 */
export const SLIPSTREAM_REFRESH_TTL_MS = 250; // longer than 200ms in v1 — see §2.7 commentary
```

### 1.4 Cornering apex

The track has two hairpins on the ellipse poles where curvature is highest. Computed once at config load.

```ts
/**
 * Apex marker is a planar disc on the INSIDE of each hairpin. Computed off the
 * checkpoint AABBs at the two hairpin t-values:
 *   Hairpin A (CCW pole): t = 0.25  → checkpoint index 3, sim center ≈ (-1100, 0)
 *   Hairpin B (CW pole):  t = 0.75  → checkpoint index 9, sim center ≈ (+1100, 0)
 *
 * Inside line is in the direction of the inward normal (already computed by
 * buildReefCheckpoints()); offset = REEF_TRACK_HALF_WIDTH * 0.55 → 82.5wu in
 * from the centerline, well clear of the outer guardrail.
 */
export const APEX_HAIRPIN_CHECKPOINT_INDICES: readonly [number, number] = [3, 9];
/** Inward offset from centerline to apex marker center (wu). */
export const APEX_INSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.55; // 82.5 wu
/** Outward offset for the "drift wide" detection ring (wu). */
export const APEX_OUTSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.55; // 82.5 wu
/** Apex disc radius (wu). Slightly bigger than the body so a clean clip counts. */
export const APEX_INNER_RADIUS = REEF_BODY_RADIUS * 2; // 44 wu
/** Outside-line ring radius (wu). */
export const APEX_OUTER_RADIUS = REEF_BODY_RADIUS * 2; // 44 wu
/** Speed mults — small numbers per high-level plan §Phase 2 line 64. */
export const APEX_BONUS_MULT   = 0.05;  // +5%
export const APEX_PENALTY_MULT = -0.05; // -5%
/** Bonus / penalty duration (ms). 1.5s → ~half the time it takes to leave the corner. */
export const APEX_DURATION_MS = 1_500;
/**
 * Re-arming behaviour: each (petId, lap, hairpinIndex) triple awards a verdict
 * AT MOST ONCE. Re-traversing on a subsequent lap re-arms. Tracked via a
 * per-body Set<string> keyed by `${lap}:${hairpinIndex}` (cleared on lap-up
 * — see §2.11 for the PRE-INCREMENT keying rule).
 */
```

### 1.5 Boost ribbons

The track has two long straights — top and bottom of the ellipse (t≈0 and t≈0.5). Plan painted on each.

```ts
/**
 * Boost ribbon — straight-line segment painted on the track surface. Crossing
 * the segment with a body radius overlap fires +30% / 2s.
 *
 * Geometry: each ribbon is an oriented line segment in sim-space (Vec2 a, Vec2 b).
 * The detection AABB is along the segment tangent, lane-perpendicular extents
 * = RIBBON_HALF_WIDTH. A body crossing the segment has its t-projection in [0,1]
 * AND |perp distance| ≤ RIBBON_HALF_WIDTH.
 *
 * Phase 2 ships ONE ribbon per straight (2 total). Future Phase can add side-by-
 * side parallel ribbons for "pick a line".
 */
export interface ReefBoostRibbon {
  /** Ribbon id — petId-scoped "already collected this lap" set keys on this. */
  id: string;
  /** Start / end of the centerline segment in sim-space (wu). */
  a: Vec2;
  b: Vec2;
}

/**
 * Ribbons computed at module-load from centerline:
 *   - Ribbon "rib-top" — straight near t≈0 BUT FULLY BEFORE t=0 (start/finish):
 *     a = reefCenterlineAt(0.92), b = reefCenterlineAt(0.98)
 *     → ~480 wu chord across the start straight, finish-line gap excluded
 *     ON BOTH SIDES so the body never crosses the ribbon and the start/finish
 *     line in the same tick. Audit fix S13.
 *   - Ribbon "rib-bot" — straight near t=0.5 (bottom of ellipse):
 *     a = reefCenterlineAt(0.46), b = reefCenterlineAt(0.54)
 *
 * Stored as a builder (not a literal) so future Phase tweaks can re-parametrise.
 */
export function buildReefBoostRibbons(): ReefBoostRibbon[];

/** Half-width of ribbon detection band, perpendicular to segment tangent (wu). */
export const RIBBON_HALF_WIDTH = REEF_BODY_RADIUS * 1.6; // 35 wu (driver picks the line)
/** Ribbon collection mult (additive). Plan-locked at +30%. */
export const RIBBON_BOOST_MULT = 0.30;
/** Ribbon boost duration (ms). Plan-locked at 2s. */
export const RIBBON_BOOST_DURATION_MS = 2_000;
/**
 * Per-ribbon collection cooldown (ms) — prevents oscillation along the segment.
 * Independent from RIBBON_BOOST_DURATION_MS so a player can collect ribbon-A,
 * lose the boost, then collect ribbon-B mid-lap. Audit S14 noted this is mostly
 * redundant given the per-lap dedupe — kept for safety on potential reverse-driving
 * exploits in future Phase variants.
 */
export const RIBBON_COLLECTION_COOLDOWN_MS = 5_000;
```

### 1.6 Hazard patches

```ts
/**
 * Hazard patch — circular slow zone clipping the inside-line of each hairpin.
 * "Sea urchin field" per high-level plan §Phase 2 line 65. Faster route through
 * the apex BUT you eat -40% speed while inside.
 *
 * Phase 2 ships ONE hazard per hairpin (2 total). Center is offset from the
 * hairpin checkpoint center along its inward normal — slightly INSIDE the apex
 * marker so the apex bonus + hazard-clip combination forces a real choice.
 */
export interface ReefHazardPatch {
  id: string;
  center: Vec2;
  radius: number;
}

export function buildReefHazardPatches(): ReefHazardPatch[];

/**
 * Hazard patch radius (wu). Body must center-overlap to count. Tuned so the
 * hazard fits between the apex marker and the centerline → drift-wide gives
 * apex-penalty, perfect-line gives apex-bonus, urchin-clip gives speed-damage.
 */
export const HAZARD_RADIUS = REEF_BODY_RADIUS * 2.5; // 55 wu
/** Inward offset from centerline to hazard center (wu). Slightly INSIDE apex marker. */
export const HAZARD_INSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.40; // 60 wu
/**
 * Hazard mult (additive negative). With the v2 arithmetic (§2.3):
 *   - Drift-3 alone:           speedMod = 1.38 (ok)
 *   - Hazard alone:            speedMod = 0.60 (slow)
 *   - Drift-3 + hazard:        kineticDelta = 0.38 - 0.40 = -0.02 → speedMod = 0.98
 *     → "shortcut tradeoff" actually exists (audit C5 fix). The drifted player who
 *      takes the inside line through the urchin field comes out 2% slower than
 *      baseline — but they covered LESS DISTANCE through the apex, net win.
 *   - Drift-3 + hazard + turbo: positiveStack = 0.38, pickup = 0.40,
 *      effectivePositive = max(0.38, 0.40) = 0.40, neg = -0.40, kineticDelta = 0.00,
 *      speedMod = 1.00. Turbo "buys back" the hazard cleanly — a deliberate
 *      design choice: spending a turbo to fly through the shortcut works.
 */
export const HAZARD_SLOW_MULT = -0.40;
/**
 * Refresh cadence — hazard re-applies every tick the body overlaps. Effect
 * is set once with a short expiry; re-firing extends. Avoids a "leave the
 * patch but the boost lingers" feel.
 */
export const HAZARD_TICK_DURATION_MS = 200; // 6 ticks — enough to absorb tick scheduling jitter
```

### 1.7 Placement-weighted power-up table

```ts
/**
 * Placement-keyed power-up roll table. Replaces the global `rollPowerUpKind`
 * draw at COLLECT time (`resolvePickups`) when a placement is supplied.
 *
 * Mario Kart rubber band — leaders get defensive items only, trailers get
 * aggressive items more often. Mid-pack rolls the legacy global table.
 *
 * Weights are RELATIVE within each placement bucket (don't need to sum to 100).
 * The roll is sum-then-LCG-mod-then-walk, identical to existing rollPowerUpKind.
 */
export const PLACEMENT_ITEM_TABLE: Record<
  number,
  ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }>
> = {
  // 1st place — defensive only
  1: [
    { kind: 'rr-bubble-shield', weight: 50 },
    { kind: 'rr-ink-slick',     weight: 30 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
  ],
  // 2nd–3rd — defensive-leaning
  2: [
    { kind: 'rr-turbo-bubble',  weight: 35 },
    { kind: 'rr-bubble-shield', weight: 25 },
    { kind: 'rr-ink-slick',     weight: 20 },
    { kind: 'rr-tide-wave',     weight: 10 },
    { kind: 'rr-seeker-jelly',  weight:  7 },
    { kind: 'rr-whirlpool',     weight:  3 },
  ],
  3: [/* same as 2 */],
  // 4th–5th — neutral (matches REEF_POWERUP_DEFS distribution)
  4: [
    { kind: 'rr-turbo-bubble',  weight: 50 },
    { kind: 'rr-bubble-shield', weight: 12 },
    { kind: 'rr-ink-slick',     weight: 10 },
    { kind: 'rr-seeker-jelly',  weight: 10 },
    { kind: 'rr-tide-wave',     weight:  8 },
    { kind: 'rr-whirlpool',     weight: 10 },
  ],
  5: [/* same as 4 */],
  // 6th–7th — aggressive-leaning
  6: [
    { kind: 'rr-seeker-jelly',  weight: 25 },
    { kind: 'rr-tide-wave',     weight: 22 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
    { kind: 'rr-whirlpool',     weight: 18 },
    { kind: 'rr-ink-slick',     weight: 10 },
    { kind: 'rr-bubble-shield', weight:  5 },
  ],
  7: [/* same as 6 */],
  // 8th — aggressive only
  8: [
    { kind: 'rr-whirlpool',    weight: 35 },
    { kind: 'rr-seeker-jelly', weight: 30 },
    { kind: 'rr-tide-wave',    weight: 25 },
    { kind: 'rr-turbo-bubble', weight: 10 },
  ],
};

/**
 * Look up the weighted item table for a given placement. Out-of-range
 * placements (placement < 1 OR placement > 8) fall through to the legacy
 * global REEF_POWERUP_DEFS distribution — same code path as today.
 */
export function getPlacementItemTable(placement: number):
  ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }> | null;
```

**Table justification.** The table flattens at the extremes (1st = pure defense, 8th = pure offense) but interpolates through the middle. Asymmetry is the rubber band: 1st place gets shield+slick to defend a lead, 8th gets whirlpool+seeker to actually catch up. Empirically tuned to match Mario Kart 8's "place 8 = lightning" intensity without the lightning itself (which would be a power-up addition, deferred).

---

## 2. Server sim integration

### 2.1 New per-body state on `ReefBody` (§3 details types)

Phase 2 adds `slipstream`, `apex`, `ribbons`, `hazard` slices. None replace the existing `drift` / `currentDriftBoostSparks` / `activeBoosts` fields.

### 2.2 Where each mechanic plugs into the actual `tickRoom` (audit S6 fix)

The actual `tickRoom` step order verified against `reef-race-sim.ts:677-748`:

```
0. runBotControllers
1. applyIntentForTick   ← speedMod READ here (per body)
2. integrateMotion      ← position update + boost-gated hard cap
3. expire activeEffects + activeBoosts  ← sweep
4. resolveProximity     ← body-body push apart
5. resolvePickups       ← collect + inventory write
6. tickPickups          ← respawn roll (cosmetic kind)
7. resolveCheckpoints   ← lap-up cleanup runs here (Phase 2 §2.11)
8. shouldEndRound check
9. snapshot broadcast (broadcastDelta or broadcastKeyframe)
```

**Phase 2 insertions** (numbered to preserve existing comment ordering — letters `a` indicate "between step N and step N+1"):

```
0a. cacheLivePlacementMap(state)
        ← TOP of tickRoom, runs ONCE per tick, just after `state.tick += 1`.
          Stored on state.lastPlacementMap. Used by:
          - resolvePickups (placement-aware re-roll)
          - buildBotRoomView (per-body placement projection)
          - broadcastDelta (placement field on EntityDelta)
          Audit S7 fix.

3a. resolveSlipstream(state, now)
        ← AFTER activeBoosts sweep. Position is post-integration (correct for
          wake distance). Boost set here is read by NEXT tick's applyIntentForTick.
          Pair-wise loop on alive racing bodies. Sets/refreshes 'slipstream-boost'.

5a. resolveBoostRibbons(state, now)
        ← AFTER resolvePickups (so power-up collisions resolve first), BEFORE
          resolveCheckpoints (so the ribbon is collected on the SAME tick as the
          cross — important: if a body crosses both the ribbon AND the start/finish
          line on the same tick, ribbon fires first and the lap-up cleanup
          PRESERVES the just-added entry per §2.11).

5b. resolveApex(state, now)
        ← Same window — between pickups and checkpoints. Pure positional check.

5c. resolveHazards(state, now)
        ← Same window. Sets/refreshes 'hazard-slow' active-boost entry, broadcasts
          edge-triggered `event.hazard_hit`.

(6 stays unchanged — tickPickups respawn roll uses GLOBAL weights for the
 cosmetic in-world kind. Placement-aware roll happens at COLLECT time inside
 step 5, see §2.5 below.)
```

**Insert order rationale:**
- Slipstream at 3a — runs AFTER position integration so the wake distance check uses true positions, AFTER the activeBoosts sweep so the OWN boost doesn't get swept the same tick it's set.
- Ribbons/apex/hazard at 5a-5c — runs AFTER pickup collection (those resolve at body collision radius too, no need to compete) and BEFORE checkpoint resolution so the lap-up cleanup CAN'T retroactively wipe an entry just collected on the same tick.
- The lap-up cleanup at step 7 uses the PRE-INCREMENT lap as the dedupe key (§2.11) — so the "ribbon collected on lap-up tick" survives. Audit S13 fix.

### 2.3 Modified `applyIntentForTick` step 4 (speedMod arithmetic — v2, audit C4/C5/C6 fix)

The current code (`reef-race-sim.ts:775-810`) computes:

```ts
const kineticMult = (launchBoosted ? LAUNCH_BOOST_MULT : 0)
                  + (driftBoosted ? DRIFT_BOOST_MULTS[...] : 0);
const pickupMult  = powerBoosted ? REEF_BOOST_MULT - 1.0 : 0;
const bestMult    = Math.max(kineticMult, pickupMult);
speedMod = slicked ? 0.5 : 1.0 + bestMult;
```

**Phase 2 v2 replacement.** Combination model is documented explicitly here per audit instructions:

```ts
// ─── 1. POSITIVE kinematic stack — ADDITIVE, capped ──────────────────────
//
// All five positive kinematic effects ADD into a single positiveStack.
// Capped at KINEMATIC_BOOST_CAP (0.85) — the cap prevents the stack from
// pushing speedMod above the existing boost-gated hard cap of 1.85×.
//
// Sources:
//   - launch-boost  (+0.30)  — Phase 1
//   - drift-boost   (+0.12 / +0.24 / +0.38 by spark tier) — Phase 1
//   - slipstream    (+0.20)  — Phase 2
//   - ribbon        (+0.30)  — Phase 2
//   - apex-bonus    (+0.05)  — Phase 2
//
const launchAdd     = body.activeBoosts.has('launch-boost')
  ? LAUNCH_BOOST_MULT : 0;
const driftAdd      = (body.activeBoosts.has('drift-boost')
                        && body.currentDriftBoostSparks >= 1)
  ? (DRIFT_BOOST_MULTS[body.currentDriftBoostSparks - 1] ?? 0)
  : 0;
const slipstreamAdd = body.activeBoosts.get('slipstream-boost')?.mult ?? 0;
const ribbonAdd     = body.activeBoosts.get('ribbon-boost')?.mult ?? 0;
const apexBonusAdd  = body.activeBoosts.get('apex-bonus')?.mult ?? 0;

const positiveStackRaw = launchAdd + driftAdd + slipstreamAdd
                       + ribbonAdd + apexBonusAdd;
const positiveStack    = Math.min(positiveStackRaw, KINEMATIC_BOOST_CAP);

// ─── 2. PICKUP turbo competes for the POSITIVE slot only ─────────────────
//
// Phase 1 invariant preserved: turbo-bubble does NOT additively stack with
// drift; it replaces it (taking the larger). We extend that rule to the
// FULL positive stack: pickup vs (capped positive stack) is taken via MAX.
//
// This means a turbo cancels into a +0.40 floor on the positive contribution —
// useful when the player has no kinematic boosts active. With drift-3 alone
// (positive = 0.38), the pickup wins (0.40 > 0.38). With drift-3 + launch
// (positive = 0.68), the kinematic wins. With the cap saturated (0.85), the
// kinematic always wins.
//
const pickupAdd       = powerBoosted ? (REEF_BOOST_MULT - 1.0) : 0; // 0.40
const effectivePositive = Math.max(positiveStack, pickupAdd);

// ─── 3. NEGATIVE kinematic stack — ADDITIVE, floored, ALWAYS APPLIED ────
//
// Negatives DO NOT compete with positives via Math.max — they are summed
// independently and ALWAYS subtract. This is the audit C4/C5 fix: in v1
// the Math.max(kineticMult, pickupMult) silently erased hazard-slow whenever
// any positive boost was active. In v2, hazard ALWAYS subtracts.
//
// Sources (mults stored as NEGATIVE numbers in activeBoosts):
//   - apex-penalty (-0.05) — Phase 2
//   - hazard-slow  (-0.40) — Phase 2
//
const apexPenSub  = body.activeBoosts.get('apex-penalty')?.mult ?? 0;
const hazardSub   = body.activeBoosts.get('hazard-slow')?.mult  ?? 0;
const negativeStackRaw = apexPenSub + hazardSub;
const negativeStack    = Math.max(negativeStackRaw, NEGATIVE_KINETIC_FLOOR);

// ─── 4. Combine + apply ink-slick override + absolute floor ─────────────
//
// kineticDelta is the signed sum of (capped positive vs pickup) and
// (floored negative). Applied to the baseline 1.0 to produce speedMod.
//
// Three clamps in the chain (in order):
//   1. positiveStack ≤ KINEMATIC_BOOST_CAP    (cap on positives)
//   2. negativeStack ≥ NEGATIVE_KINETIC_FLOOR (floor on negatives)
//   3. speedMod      ≥ 0.5                    (absolute floor)
// Plus: ink-slick continues to OVERRIDE everything to 0.5.
//
const kineticDelta = effectivePositive + negativeStack;
speedMod = slicked ? 0.5 : Math.max(0.5, 1.0 + kineticDelta);
```

#### 2.3.x Worked-example table (matches audit-required property bullets)

| Scenario | positiveStack (raw → capped) | pickupAdd | effectivePositive | negativeStack | kineticDelta | speedMod | Notes |
|---|---|---|---|---|---|---|---|
| Drift-3 alone | 0.38 → 0.38 | 0 | 0.38 | 0 | +0.38 | **1.38** | unchanged from Phase 1 |
| Drift-3 + launch | 0.68 → 0.68 | 0 | 0.68 | 0 | +0.68 | **1.68** | under cap, additive (was 1.85 in v1; v2 is more accurate — cap only fires when raw > 0.85) |
| Drift-3 + launch + slipstream | 0.88 → 0.85 | 0 | 0.85 | 0 | +0.85 | **1.85** | cap saturated |
| All five positives | 1.23 → 0.85 | 0 | 0.85 | 0 | +0.85 | **1.85** | cap saturated |
| Hazard alone | 0 | 0 | 0 | -0.40 | -0.40 | **0.60** | slow, no override |
| **Drift-3 + hazard** | 0.38 | 0 | 0.38 | -0.40 | -0.02 | **0.98** | shortcut tradeoff EXISTS (audit C5 fix) |
| **Drift-3 + hazard + turbo** | 0.38 | 0.40 | 0.40 | -0.40 | 0.00 | **1.00** | turbo "buys back" hazard (intentional) |
| Apex-penalty + hazard | 0 | 0 | 0 | -0.45 | -0.45 | **0.55** | both subtract, above absolute floor |
| Apex-penalty + hazard + drift-3 | 0.38 | 0 | 0.38 | -0.45 | -0.07 | **0.93** | net negative, drift saves you a bit |
| Ink-slick + drift-3 | 0.38 | 0 | 0.38 | 0 | +0.38 | **0.5** | slicked override |
| Ink-slick + drift-3 + turbo | 0.38 | 0.40 | 0.40 | 0 | +0.40 | **0.5** | slicked override |
| Turbo alone | 0 | 0.40 | 0.40 | 0 | +0.40 | **1.40** | unchanged from Phase 1 |
| Turbo + drift-3 | 0.38 | 0.40 | 0.40 | 0 | +0.40 | **1.40** | turbo wins (0.40 > 0.38), unchanged from Phase 1 |
| Stalled body — any composition | (n/a — short-circuits earlier in `applyIntentForTick`) | | | | | **0.5** | `if (stalled) speedMod = 0.5` short-circuit; kinematicMult math is SKIPPED. Hazard during stall is a no-op (audit G4 fix — §2.12 row corrected). |

**Anti-cheat headroom verification:**
- Max legit speedMod = 1.85.
- Under `REEF_KINEMATIC_TOLERANCE = 2.0`, validator allows up to 1000 wu/s.
- Boost-gated hard cap at `REEF_MAX_SPEED * 1.85 = 925 wu/s` — same as Phase 1, **gate widened** to include slipstream/ribbon/apex-bonus (§2.4).
- Audit S11 transient overshoot: 33ms × 2000 wu/s² = 66 wu/s mid-tick spike on top of 925 = 991 — under 1000. Safe.

### 2.4 Boost-gated hard cap update (`integrateMotion`)

Current Phase 1 site (`reef-race-sim.ts:1057-1067`):

```ts
const isBoostActive =
  body.activeBoosts.has('launch-boost') ||
  body.activeBoosts.has('drift-boost');
if (isBoostActive) { /* hardCap = REEF_MAX_SPEED * 1.85 */ }
```

Phase 2 v2 replacement — gate widens to include all positive kinematic effects:

```ts
const isPositiveBoostActive =
  body.activeBoosts.has('launch-boost')      ||
  body.activeBoosts.has('drift-boost')       ||
  body.activeBoosts.has('slipstream-boost')  ||
  body.activeBoosts.has('ribbon-boost')      ||
  body.activeBoosts.has('apex-bonus');
if (isPositiveBoostActive) {
  const speed = Math.hypot(body.vx, body.vy);
  const hardCap = REEF_MAX_SPEED * 1.85; // unchanged
  if (speed > hardCap) {
    body.vx = (body.vx / speed) * hardCap;
    body.vy = (body.vy / speed) * hardCap;
  }
}
```

The cap value stays at 1.85× because `KINEMATIC_BOOST_CAP = 0.85` makes 1.85× the new theoretical ceiling — no headroom needed beyond the existing margin.

### 2.5 Placement-aware re-roll at COLLECT time (`resolvePickups`) — protocol fix per audit C2

In `tickPickups` (`reef-race-sim.ts:1126-1142`), the SPAWN roll is unchanged — uses the legacy global `rollPowerUpKind(state)` for the cosmetic in-world kind. This avoids a "pickup turns into a different mesh visually mid-flight" bug.

In `resolvePickups` (`reef-race-sim.ts:1095-1124`), at the moment a body collects, we re-roll based on the COLLECTOR's placement and broadcast the FINAL kind in `event.power_up_collected`:

```ts
// Existing inside the collision branch:
//   const slot = body.inventory.findIndex((s) => s.kind === null);
//   if (slot < 0) continue; // inventory full — drop the pickup, no fire

// v2 — placement-aware re-roll:
const collectorPlacement = state.lastPlacementMap?.get(body.petId) ?? null;
const finalKind = collectorPlacement
  ? this.rollPowerUpKindForPlacement(state, collectorPlacement)
  : pk.kind; // fall back to spawn-time kind if placement unavailable

body.inventory[slot] = { kind: finalKind, charges: 1, cooldownUntil: 0 };

// v2 — broadcast the FINAL kind so the HUD can swap the inventory slot
// immediately. C2 audit fix — closes the "stealth swap" UX bug by making
// the wire event authoritative for inventory state. The web client's
// inventory broadcast channel (which is broken for Reef Race today, see
// §13 out-of-scope) is NOT the source of truth here.
this.broadcastFn(state.roomId, {
  type: 'event.power_up_collected',
  spawnId:        pk.id,
  collectorPetId: body.petId,
  kind:           finalKind, // NEW in Phase 2
});
```

`rollPowerUpKindForPlacement(state, placement)` is a new private method on `ReefRaceSim` that walks `PLACEMENT_ITEM_TABLE[placement]` (or falls through to `rollPowerUpKind` if entry is null/undefined). Uses the existing LCG (`lcgNext(state)`) so determinism is preserved.

**HUD handling.** In `apps/web/src/stores/activity.ts` the `event.power_up_collected` case branch — already exists in the Phase 1 code — gets ONE addition: when `frame.collectorPetId === state.selfPetId`, write `frame.kind` into `state.powerUpInventory` at the first empty slot. This restores the inventory display as the source of truth for self, even though the per-tick inventory delta channel is not yet wired for Reef Race (out-of-scope, §13).

### 2.6 `computeLivePlacements`

```ts
/**
 * Live placement computed from race progress = lap*REEF_CHECKPOINT_COUNT +
 * (cpDone) for racing bodies. Higher progress = better placement (1 = leader).
 * Finished bodies retain finish placement (sorted by finishedAt asc). DNFers
 * appended last with deterministic petId tie-break.
 *
 * Returns a Map<petId, placement> with placements 1..N. Pure function of
 * state — safe to call from any tick step.
 *
 * Refresh policy: called ONCE per tick at step 0a (top of tickRoom) and
 * stored on state.lastPlacementMap. All readers pull from the cache. Audit
 * S7 fix.
 *
 * Cost: O(N log N) on N <= 8.
 */
private computeLivePlacements(state: ReefRoomState): Map<string, number>;
```

Implementation (concise):

```ts
const racing: Array<{petId: string; progress: number; finishedAt: number | null; dnf: boolean}> = [];
for (const b of state.bodies.values()) {
  if (b.dnf || b.forfeited) {
    racing.push({petId: b.petId, progress: -Infinity, finishedAt: null, dnf: true});
    continue;
  }
  if (b.finishedAt !== null) {
    racing.push({petId: b.petId, progress: Infinity, finishedAt: b.finishedAt, dnf: false});
    continue;
  }
  // Race progress: full laps + completed checkpoints in the current lap.
  // nextCheckpoint=1 means we just crossed 0 → 0 fully done; nextCheckpoint=11
  // means we've crossed 1..10 = 10 done. Wrap: nextCheckpoint=0 means we've
  // crossed 1..11 and are about to cross 0 → 11 done (+ lap-start).
  const cpDone = b.nextCheckpoint === 0
    ? REEF_CHECKPOINT_COUNT - 1
    : b.nextCheckpoint - 1;
  racing.push({
    petId: b.petId,
    progress: b.lap * REEF_CHECKPOINT_COUNT + cpDone,
    finishedAt: null,
    dnf: false,
  });
}
// Sort: finishers first by finishedAt asc, then racers by progress desc, then DNF.
// Tie-break by petId ASCENDING for determinism (audit N8 fix).
racing.sort((a, b) => {
  if (a.finishedAt !== null && b.finishedAt !== null) return a.finishedAt - b.finishedAt;
  if (a.finishedAt !== null) return -1;
  if (b.finishedAt !== null) return 1;
  if (a.dnf && !b.dnf) return 1;
  if (!a.dnf && b.dnf) return -1;
  if (a.progress !== b.progress) return b.progress - a.progress;
  return a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0;
});
const out = new Map<string, number>();
racing.forEach((r, i) => out.set(r.petId, i + 1));
return out;
```

### 2.7 `resolveSlipstream` (new private method on `ReefRaceSim`)

```ts
private resolveSlipstream(state: ReefRoomState, now: number): void {
  // Snapshot the racing-body list once.
  const bodies: ReefBody[] = [];
  for (const b of state.bodies.values()) {
    if (b.alive && !b.dnf && b.finishedAt === null && !b.forfeited) bodies.push(b);
  }
  // Per-body inner loop — O(N²) on N≤8 = 64 checks/tick. Cheap.
  for (const self of bodies) {
    let bestSrc: ReefBody | null = null;
    for (const target of bodies) {
      if (target === self) continue;
      // Vector self → target.
      const dx = target.x - self.x;
      const dy = target.y - self.y;
      const distSq = dx * dx + dy * dy;
      const minSq = SLIPSTREAM_MIN_DISTANCE * SLIPSTREAM_MIN_DISTANCE;
      const maxSq = SLIPSTREAM_MAX_DISTANCE * SLIPSTREAM_MAX_DISTANCE;
      if (distSq < minSq || distSq > maxSq) continue;
      // Target's velocity must be non-trivial (a parked / stalled car can't make wake).
      const tSpeed = Math.hypot(target.vx, target.vy);
      if (tSpeed < REEF_MAX_SPEED * 0.30) continue;
      // Self must be BEHIND the target (dot(self→target, target.vel) > 0).
      const dot = (dx * target.vx + dy * target.vy) / (tSpeed);
      if (dot <= 0) continue;
      // Lateral offset must be within wake half-width.
      const perpMag = Math.abs(dx * target.vy - dy * target.vx) / tSpeed;
      if (perpMag > SLIPSTREAM_HALF_WIDTH) continue;
      // Velocities must be roughly aligned (both moving the same way).
      const sSpeed = Math.hypot(self.vx, self.vy);
      if (sSpeed < REEF_MAX_SPEED * 0.30) continue;
      const align = (self.vx * target.vx + self.vy * target.vy) / (sSpeed * tSpeed);
      if (align < SLIPSTREAM_MIN_VEL_ALIGNMENT) continue;
      // Prefer the closest valid target (avoid bouncing between two leaders).
      const dist = Math.sqrt(distSq);
      if (!bestSrc || dist < Math.hypot(bestSrc.x - self.x, bestSrc.y - self.y)) {
        bestSrc = target;
      }
    }
    if (bestSrc) {
      // Continue / start charging.
      if (self.slipstreamSourcePetId === bestSrc.petId) {
        self.slipstreamConsecutiveTicks++;
      } else {
        self.slipstreamSourcePetId = bestSrc.petId;
        self.slipstreamConsecutiveTicks = 1;
      }
      self.slipstreamGraceTicksLeft = SLIPSTREAM_GRACE_TICKS;
      // Threshold reached → set / refresh boost.
      if (self.slipstreamConsecutiveTicks >= SLIPSTREAM_REQUIRED_TICKS) {
        const wasActive = self.activeBoosts.has('slipstream-boost');
        self.activeBoosts.set('slipstream-boost', {
          expiresAt: now + SLIPSTREAM_REFRESH_TTL_MS,
          mult: SLIPSTREAM_BOOST_MULT,
        });
        // Edge-trigger: only broadcast on RISING edge of `wasActive`. Audit S3
        // fix — the longer SLIPSTREAM_REFRESH_TTL_MS (250ms) is comfortably
        // greater than one tick (33ms), so the boost won't expire-then-set
        // mid-tick and double-broadcast.
        if (!wasActive) {
          this.broadcastFn(state.roomId, {
            type: 'event.slipstream',
            srcPetId: bestSrc.petId,
            dstPetId: self.petId,
          });
        }
      }
    } else {
      // Out of wake — apply grace, then clear AND broadcast end event.
      if (self.slipstreamGraceTicksLeft > 0) {
        self.slipstreamGraceTicksLeft--;
        if (self.slipstreamGraceTicksLeft === 0
            && self.activeBoosts.has('slipstream-boost')) {
          // Edge-trigger: emit `event.slipstream_end` exactly when grace runs
          // out and the boost is about to be allowed to expire. Audit S4 fix.
          self.activeBoosts.delete('slipstream-boost');
          this.broadcastFn(state.roomId, {
            type: 'event.slipstream_end',
            dstPetId: self.petId,
          });
        }
        // (If activeBoosts didn't have slipstream-boost, the body never reached
        //  threshold — no end event needed. Just decrement grace.)
      } else {
        // Already cleared in a prior tick; ensure source/counter reset.
        self.slipstreamSourcePetId        = null;
        self.slipstreamConsecutiveTicks   = 0;
      }
    }
  }
}
```

**Notes:**
- Audit S4 fix: server emits `event.slipstream_end` so the client doesn't poll a 100ms timer.
- Audit S3 fix: `SLIPSTREAM_REFRESH_TTL_MS = 250ms` (was 200ms in v1). 250ms > 33ms tick → activeBoosts entry survives until the NEXT tick's refresh, so `wasActive` stays true and we don't double-broadcast a mid-tick expire-then-set.
- Audit G6 chain: see §2.7.1 below for the chain-drafting argument.
- Audit-thinking — interaction with collisions: `resolveProximity` runs at step 4 (BEFORE this method's 3a window per §2.2). Two bodies inside `REEF_BODY_RADIUS * 2 = 44wu` of each other separate. Slipstream's `MIN_DISTANCE = 33wu < 44`, so a collision will push them apart and break the wake naturally. No deadlock.

#### 2.7.1 Chain drafting (audit S2 / G1)

In a 3-body chain (A leads, B drafts A, C drafts B):
- B's slipstream targeting picks A (closer, valid). After 45 ticks, B gets +0.20.
- C's targeting evaluates ALL bodies. If C is closer to B than to A, C picks B. Otherwise C picks A.
- B's velocity (boosted) is what C reads — drafting is TRANSITIVE by physics. C is drafting B-at-1.20×, but that's fine: `tSpeed` is the actual current speed.
- No special chain logic needed. The closest-target rule prevents oscillation when C is roughly equidistant from A and B.
- Test P2-T35 (added) explicitly verifies: A→B→C chain → C drafts B (closer body), B drafts A, both get the +0.20 once their counters hit 45.

### 2.8 `resolveBoostRibbons` (new private method)

```ts
private resolveBoostRibbons(state: ReefRoomState, now: number): void {
  if (state.ribbons.length === 0) return; // future-proof
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null || body.forfeited) continue;
    for (const ribbon of state.ribbons) {
      // Skip if already collected this lap (key includes PRE-INCREMENT lap).
      const key = `${body.lap}:${ribbon.id}`;
      if (body.ribbonsCollectedThisLap.has(key)) continue;
      // Per-ribbon cooldown (5s) — prevents oscillating across the line.
      const lastCollect = body.ribbonLastCollectedAt.get(ribbon.id) ?? 0;
      if (now - lastCollect < RIBBON_COLLECTION_COOLDOWN_MS) continue;
      // Segment-distance test: project body onto ribbon.a→ribbon.b.
      if (!isOnRibbon(body, ribbon)) continue;
      // Collected.
      body.ribbonsCollectedThisLap.add(key);
      body.ribbonLastCollectedAt.set(ribbon.id, now);
      body.activeBoosts.set('ribbon-boost', {
        expiresAt: now + RIBBON_BOOST_DURATION_MS,
        mult: RIBBON_BOOST_MULT,
      });
      this.broadcastFn(state.roomId, {
        type: 'event.ribbon_collected',
        petId: body.petId,
        ribbonId: ribbon.id,
      });
      break; // one ribbon per body per tick
    }
  }
}
```

`isOnRibbon(body, ribbon)` is a private helper using projection-onto-segment math (no allocations, all `number`). On lap-up, `body.ribbonsCollectedThisLap` is cleared inside `resolveCheckpoints` — see §2.11.

### 2.9 `resolveApex` (new private method)

```ts
private resolveApex(state: ReefRoomState, now: number): void {
  if (state.apexZones.length === 0) return;
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null || body.forfeited) continue;
    for (const zone of state.apexZones) {
      const key = `${body.lap}:${zone.hairpinIndex}`;
      if (body.apexCheckedThisLap.has(key)) continue;
      const dxIn = body.x - zone.innerCenter.x;
      const dyIn = body.y - zone.innerCenter.y;
      const dxOut = body.x - zone.outerCenter.x;
      const dyOut = body.y - zone.outerCenter.y;
      if (dxIn * dxIn + dyIn * dyIn <= APEX_INNER_RADIUS * APEX_INNER_RADIUS) {
        body.apexCheckedThisLap.add(key);
        body.activeBoosts.set('apex-bonus', {
          expiresAt: now + APEX_DURATION_MS,
          mult: APEX_BONUS_MULT,
        });
        this.broadcastFn(state.roomId, {
          type: 'event.apex_verdict', // audit S1 — renamed from event.apex_bonus
          petId: body.petId,
          hairpinIndex: zone.hairpinIndex,
          kind: 'clean',               // audit S1 — was 'inside'
        });
      } else if (dxOut * dxOut + dyOut * dyOut <= APEX_OUTER_RADIUS * APEX_OUTER_RADIUS) {
        body.apexCheckedThisLap.add(key);
        body.activeBoosts.set('apex-penalty', {
          expiresAt: now + APEX_DURATION_MS,
          mult: APEX_PENALTY_MULT, // negative
        });
        this.broadcastFn(state.roomId, {
          type: 'event.apex_verdict',
          petId: body.petId,
          hairpinIndex: zone.hairpinIndex,
          kind: 'wide',
        });
      }
    }
  }
}
```

`apexZones` is precomputed at `startRoom` from `APEX_HAIRPIN_CHECKPOINT_INDICES` + checkpoint normals. Cleared per-lap via `apexCheckedThisLap` set on the body.

### 2.10 `resolveHazards` (new private method)

```ts
private resolveHazards(state: ReefRoomState, now: number): void {
  if (state.hazards.length === 0) return;
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null || body.forfeited) continue;
    let hit: ReefHazardPatch | null = null;
    for (const hazard of state.hazards) {
      const dx = body.x - hazard.center.x;
      const dy = body.y - hazard.center.y;
      if (dx * dx + dy * dy <= hazard.radius * hazard.radius) {
        hit = hazard;
        break;
      }
    }
    if (hit) {
      body.activeBoosts.set('hazard-slow', {
        expiresAt: now + HAZARD_TICK_DURATION_MS,
        mult: HAZARD_SLOW_MULT,
      });
      // Edge-trigger event broadcast — once per (petId, hazardId) per lap.
      const key = `${body.lap}:${hit.id}`;
      if (!body.hazardsHitThisLap.has(key)) {
        body.hazardsHitThisLap.add(key);
        this.broadcastFn(state.roomId, {
          type: 'event.hazard_hit',
          petId: body.petId,
          hazardId: hit.id,
        });
      }
    }
    // No clear-on-leave — speedMod sweep in step 3 handles expiry naturally
    // because `expiresAt` is now+200ms; if the body's still inside next tick
    // the entry refreshes.
  }
}
```

### 2.11 Lap-up cleanup in `resolveCheckpoints` — PRE-INCREMENT keying (audit S13 fix)

When a body's lap counter advances, clear:
- `body.ribbonsCollectedThisLap.clear()`
- `body.apexCheckedThisLap.clear()`
- `body.hazardsHitThisLap.clear()`

**Critical ordering:** ribbons/apex/hazards run at step 5a-5c (BEFORE checkpoint resolution at step 7). The dedupe key uses `${body.lap}:${zone.id}` — at the time those resolvers fire, `body.lap` is still PRE-INCREMENT. The lap-up cleanup at step 7 then runs `clear()` on the sets. So a ribbon collected on the same tick as a lap-up:
- Step 5a: ribbon resolver sees `body.lap = N`, key = `"N:rib-top"`, adds to set → boost ACTIVE.
- Step 7: checkpoint resolver advances `body.lap` to `N+1`, then runs `clear()` on the sets — wipes `"N:rib-top"` entry, but the `activeBoosts['ribbon-boost']` entry is UNTOUCHED. Boost survives.
- Next tick: ribbon resolver sees `body.lap = N+1`, key = `"N+1:rib-top"` — NOT in the cleared set, but the body has already moved past the ribbon. No re-collect. Cooldown also rejects (5s window).

If the body somehow STILL overlaps the ribbon next tick (e.g., very slow tickrate or a stationary body parked on it), the cooldown rejects until 5s pass. Then it would re-collect on lap N+1 — that's the intended "ribbon refreshes per lap" behavior.

Plumb this into the existing `resolveCheckpoints` `if (justCompletedLap)` branch (`reef-race-sim.ts:1212-1228`) right after `body.lap += 1`. No new function needed.

### 2.12 Interaction matrix — corrected per audit S6 + G4

| Mechanic | Stack with drift? | Stack with launch? | Stack with pickup turbo? | Capped at | Behavior on stall? |
|---|---|---|---|---|---|
| Slipstream | additive | additive | competes via MAX (positive slot) | positiveStack ≤ 0.85 | NO-OP (stall short-circuits speedMod = 0.5) |
| Ribbon | additive | additive | competes via MAX | positiveStack ≤ 0.85 | NO-OP |
| Apex bonus | additive | additive | competes via MAX | positiveStack ≤ 0.85 | NO-OP |
| Apex penalty | subtractive (always) | subtractive (always) | subtractive (always) | negativeStack ≥ -0.50 | NO-OP (audit G4 fix — subtractives are SKIPPED inside stall short-circuit; v1 §2.12 row "applied on top of stall" was WRONG) |
| Hazard | subtractive (always) | subtractive (always) | subtractive (always) | negativeStack ≥ -0.50 | NO-OP |

Stall behavior: when `launch-stall` is active, the existing code path (`reef-race-sim.ts:780-794`) hard-sets `speedMod = 0.5` and `effectiveThrust = min(thrust, 0.30)` — both positive AND negative kineticMult math is SKIPPED. Hazard, apex-penalty, slipstream, ribbon, drift — none of them affect the stalled tick. This is intentional: stall is a single-source override, not a stack.

### 2.13 Anti-cheat tolerance verification

Maximum positive kineticMult = `KINEMATIC_BOOST_CAP = 0.85` → max kineticDelta = 0.85 (when no negatives) → speedMod ≤ 1.85 → max steady-state velocity 925 wu/s. Transient spike per tick: +66 wu/s (33ms × 2000 wu/s² accel) → 991 wu/s, under `REEF_KINEMATIC_TOLERANCE = 2.0` validator's 1000 wu/s ceiling. **9 wu/s safety margin** preserved. No changes to validators or tolerance constants.

---

## 3. Per-body state additions on `ReefBody`

Add to the interface in `reef-race-sim.ts:139-200`:

```ts
// ─── Phase 2 — slipstream ─────────────────────────────────────────────────
/** petId of the body whose wake this body is currently sitting in (null = none). */
slipstreamSourcePetId: string | null;
/** Consecutive ticks the body has been in the SAME source's wake. Reset on switch. */
slipstreamConsecutiveTicks: number;
/** Grace ticks remaining after leaving the wake before clearing source. */
slipstreamGraceTicksLeft: number;

// ─── Phase 2 — boost ribbons ──────────────────────────────────────────────
/** Set of "${lap}:${ribbonId}" entries already credited this lap. Cleared on lap-up. */
ribbonsCollectedThisLap: Set<string>;
/** Last collection time per ribbonId for cross-lap cooldown. */
ribbonLastCollectedAt: Map<string, number>;

// ─── Phase 2 — apex zones ─────────────────────────────────────────────────
/** Set of "${lap}:${hairpinIndex}" entries already verdict'd this lap. Cleared on lap-up. */
apexCheckedThisLap: Set<string>;

// ─── Phase 2 — hazard patches ─────────────────────────────────────────────
/** Set of "${lap}:${hazardId}" entries already broadcast this lap. Cleared on lap-up. */
hazardsHitThisLap: Set<string>;
```

**Initial values** in `startRoom` body init loop (`reef-race-sim.ts:367-429`):

```ts
slipstreamSourcePetId:      null,
slipstreamConsecutiveTicks: 0,
slipstreamGraceTicksLeft:   0,
ribbonsCollectedThisLap:    new Set<string>(),
ribbonLastCollectedAt:      new Map<string, number>(),
apexCheckedThisLap:         new Set<string>(),
hazardsHitThisLap:          new Set<string>(),
```

**Memory footprint**: per body ~ 250 bytes (Phase 1) + ~440 bytes (Phase 2 — 4 empty Sets/Maps + 3 numbers + 1 string ref) ≈ 690 bytes per body. 8 bodies × 200 rooms ≈ 1.1 MB total worst-case. Negligible.

### 3.1 `ReefRoomState` additions

Add to the interface in `reef-race-sim.ts:212-235`:

```ts
/** Phase 2 — boost ribbons (built once at startRoom). */
ribbons: ReefBoostRibbon[];
/** Phase 2 — apex zones (built once at startRoom). */
apexZones: Array<{
  hairpinIndex: number;
  innerCenter: Vec2;
  outerCenter: Vec2;
}>;
/** Phase 2 — hazard patches (built once at startRoom). */
hazards: ReefHazardPatch[];
/**
 * Phase 2 — placement cache. Refreshed at the TOP of every tickRoom
 * (step 0a per §2.2) by `computeLivePlacements`. Read by:
 *   - resolvePickups (placement-aware item re-roll)
 *   - buildBotRoomView (per-body placement projection)
 *   - broadcastDelta (placement field on EntityDelta)
 * Audit S7 fix.
 */
lastPlacementMap: Map<string, number>;
```

Built in `startRoom` immediately after `checkpoints = buildReefCheckpoints();`:

```ts
const ribbons   = buildReefBoostRibbons();
const apexZones = buildReefApexZones(checkpoints); // helper from §3.2
const hazards   = buildReefHazardPatches();
// lastPlacementMap initialised to an empty Map; first tickRoom populates it.
const lastPlacementMap = new Map<string, number>();
```

### 3.2 Helper: `buildReefApexZones(checkpoints)`

Walks `APEX_HAIRPIN_CHECKPOINT_INDICES`, reads each checkpoint's `normal` (already pointing inward toward the origin), and returns:

```ts
function buildReefApexZones(cps: ReefCheckpointAabb[]): Array<{
  hairpinIndex: number;
  innerCenter: Vec2;
  outerCenter: Vec2;
}> {
  return APEX_HAIRPIN_CHECKPOINT_INDICES.map(idx => {
    const cp = cps[idx];
    return {
      hairpinIndex: idx,
      innerCenter: {
        x: cp.center.x + cp.normal.x * APEX_INSIDE_OFFSET,
        y: cp.center.y + cp.normal.y * APEX_INSIDE_OFFSET,
      },
      outerCenter: {
        x: cp.center.x - cp.normal.x * APEX_OUTSIDE_OFFSET,
        y: cp.center.y - cp.normal.y * APEX_OUTSIDE_OFFSET,
      },
    };
  });
}
```

(Resides in `reef-race-config.ts` so the client can import the same builder for visualization. See audit N3: server `state.*` and client `RoomMeta.reefStaticZones` are populated by the SAME builder; client wire data is the only data sent over the wire.)

### 3.3 Helper: `buildReefHazardPatches()`

Same shape as apex but with the hazard offset constant; one hazard per hairpin.

```ts
export function buildReefHazardPatches(): ReefHazardPatch[] {
  const cps = buildReefCheckpoints();
  return APEX_HAIRPIN_CHECKPOINT_INDICES.map(idx => {
    const cp = cps[idx];
    return {
      id: `hz-${idx}`,
      center: {
        x: cp.center.x + cp.normal.x * HAZARD_INSIDE_OFFSET,
        y: cp.center.y + cp.normal.y * HAZARD_INSIDE_OFFSET,
      },
      radius: HAZARD_RADIUS,
    };
  });
}
```

### 3.4 `BotRoomView` — extended shape (audit C1 fix)

`buildBotRoomView` (`reef-race-sim.ts:961-1015`) is rewritten to project per-body race progress and placement so the bot can compute drafting / placement-fire heuristics without re-deriving the same data:

```ts
private buildBotRoomView(
  state: ReefRoomState,
  selfPetId: string,
): {
  selfPetId: string;
  bodies: Array<{
    petId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    alive: boolean;
    inventory: Array<{
      kind: ReefPowerUpKind | null;
      charges: number;
      cooldownUntil: number;
    }>;
    // Phase 2 additions — audit C1 fix
    /** Lap counter for the body (NOT just self). */
    lap: number;
    /** Next-checkpoint index for the body. Used by bot for chain progress. */
    nextCheckpoint: number;
    /** Live placement (1..N), null if race not yet started. */
    currentPlacement: number | null;
    /** Race-progress sentinels — let bot filter DNF / finished bodies cleanly. */
    finishedAt: number | null;
    dnf: boolean;
  }>;
  arenaRadius: number;
  now: number;
  matchStartedAt: number;
  /** Self-shortcut for backwards compat — same value as bodies.find(self).nextCheckpoint. */
  nextCheckpoint?: number;
  /** Centerline points for the 12 checkpoints — bots use these for steering. */
  checkpoints?: ReefCheckpointAabb[];
} {
  const placementMap = state.lastPlacementMap;
  const bodies = Array.from(state.bodies.values()).map((b) => ({
    petId: b.petId,
    x: b.x,
    y: b.y,
    vx: b.vx,
    vy: b.vy,
    rot: b.rot,
    alive: b.alive && !b.dnf && b.finishedAt === null,
    inventory: b.inventory.map((slot) => ({
      kind: slot.kind as ReefPowerUpKind | null,
      charges: slot.charges,
      cooldownUntil: slot.cooldownUntil,
    })),
    lap:              b.lap,
    nextCheckpoint:   b.nextCheckpoint,
    currentPlacement: placementMap.get(b.petId) ?? null,
    finishedAt:       b.finishedAt,
    dnf:              b.dnf,
  }));
  const self = state.bodies.get(selfPetId);
  return {
    selfPetId,
    bodies,
    arenaRadius: Math.max(REEF_TRACK_A, REEF_TRACK_B) + 200,
    now: Date.now(),
    matchStartedAt: state.startedAt,
    nextCheckpoint: self?.nextCheckpoint ?? 1,
    checkpoints: state.checkpoints,
  };
}
```

The bot's `getOwnPlacement(view)` (§8.2) becomes a one-liner: `view.bodies.find(b => b.petId === view.selfPetId)?.currentPlacement ?? null`. Audit S10 optional optimization: ALSO eliminates 240 redundant sorts/sec.

---

## 4. Snapshot / protocol additions

All schema work in `packages/shared/src/activities/protocol.ts`. The TS union must remain exhaustive (`default: never` guard at `activity.ts:758-764` will require a `case`/`break` for each new event).

### 4.1 New `ServerFrame` events (audit S1, S4, C2 fixes)

```ts
| {
    /**
     * Phase 2 — slipstream verdict START. Fired ONCE when `dstPetId` first
     * enters `srcPetId`'s wake AND completes the SLIPSTREAM_REQUIRED_TICKS
     * hold. Edge-triggered. NOT broadcast on every tick of being in-wake.
     */
    type: 'event.slipstream';
    srcPetId: string;
    dstPetId: string;
  }
| {
    /**
     * Phase 2 — slipstream verdict END. Fired ONCE when the body's grace
     * counter runs out and the activeBoosts entry is cleared. Edge-triggered.
     * Audit S4 fix — eliminates client-side 100ms timer polling.
     */
    type: 'event.slipstream_end';
    dstPetId: string;
  }
| {
    /**
     * Phase 2 — apex verdict. `kind: 'clean'` = bonus +5%, `'wide'` = penalty
     * -5%. Fired AT MOST ONCE per (petId, lap, hairpinIndex). HUD reserves
     * a screen-tag toast for two seconds.
     *
     * Audit S1 fix — renamed from `event.apex_bonus` (which was misleading
     * for the penalty case) and the discriminant from `inside`/`wide` to
     * `clean`/`wide` for clarity in dashboards / analytics.
     */
    type: 'event.apex_verdict';
    petId: string;
    hairpinIndex: number;
    kind: 'clean' | 'wide';
  }
| {
    /**
     * Phase 2 — boost ribbon collection. `ribbonId` matches the id from the
     * server's `state.ribbons` (currently `'rib-top'` / `'rib-bot'`). HUD
     * may flash, scene fires a sparkle particle burst.
     */
    type: 'event.ribbon_collected';
    petId: string;
    ribbonId: string;
  }
| {
    /**
     * Phase 2 — sea-urchin field clip. Fired once per (petId, lap, hazardId)
     * — the activeBoosts.has('hazard-slow') entry handles per-tick refresh.
     */
    type: 'event.hazard_hit';
    petId: string;
    hazardId: string;
  }
```

**Modified Phase 1 event** (audit C2 fix):

```ts
| {
    type: 'event.power_up_collected';
    spawnId: string;
    collectorPetId: string;
    /**
     * Phase 2 — kind of the item PLACED INTO INVENTORY. May DIFFER from the
     * spawn-time kind (`pickup.kind`) when the placement-aware re-roll fires.
     * The HUD authoritatively reads THIS field to update the inventory slot;
     * the world mesh continues to reflect the spawn-time kind.
     *
     * Old clients (Phase 1) silently drop unknown fields — backwards-compat ✓.
     * Phase 2 same-diff updates `apps/web/src/stores/activity.ts` to write
     * this into `state.powerUpInventory` for `selfPetId`.
     */
    kind: ReefPowerUpKind;
  }
```

Backwards compat: old clients hit `default: never` → no throw (Phase 1 already proved this pattern). Old `activity.ts` switch still type-checks because the new types are added to the union — Phase 2 same-diff adds the four `case ...: break;` branches in the store (now FIVE — slipstream + slipstream_end + apex_verdict + ribbon_collected + hazard_hit, plus the `kind` extension on power_up_collected).

### 4.2 `RoomMeta` — static-zone bootstrap

Phase 2 adds three static lists to `RoomMeta` so the client can render ribbons / hazards / apex markers without re-deriving them from the centerline:

```ts
export interface RoomMeta {
  // ... existing fields ...

  /**
   * Phase 2 — server-authoritative reef-race static-zone positions. `null`
   * for non-reef-race rooms. Sent once in `snapshot.init`; never updated.
   * Client re-builds visual meshes from these so Phase-3 stat tweaks
   * (e.g. archetype = agility → ribbonDetectRadiusMultiplier) read from a
   * single source of truth.
   */
  reefStaticZones?: {
    ribbons: Array<{ id: string; a: Vec2; b: Vec2 }>;
    apexZones: Array<{
      hairpinIndex: number;
      innerCenter: Vec2;
      outerCenter: Vec2;
    }>;
    hazards: Array<{ id: string; center: Vec2; radius: number }>;
  };
}
```

`snapshot.init` is built in `activity-ws-hub.ts:464-545`. The reef-race branch (line 497-523) populates `reefStaticZones` from `reefRaceSim.getStaticZones(roomId)` (new sim accessor — see §11 file-scope).

### 4.3 `EntityDelta.changed` — placement field

Phase 2 surfaces live placement on every snapshot delta when it changes:

```ts
// in packages/shared/src/activities/protocol.ts EntityDelta.changed comment block
//   placement?: number;  // Phase 2 — 1-indexed live race position
```

The `[k: string]: unknown` catch-all is unchanged. Old clients silently drop the new `placement` field. Phase 2 client (`activity.ts`) reads it inside the snapshot.delta handler, identical to how `driftSparks` is hoisted.

### 4.4 Snapshot diff predicate update

In `reef-race-sim.ts:1487-1500` (the `broadcastDelta` filter), add:

```ts
// Phase 2 — placement change MUST broadcast so the HUD's placement tile
// updates between checkpoint crossings (positional fields may not change
// on the same tick the placement does).
|| p.placement !== b.placement
```

And add `placement: state.lastPlacementMap.get(body.petId) ?? null` to both the snapshot body (`buildSnapshot`) and the `changed` object emitted in `broadcastDelta`. The cache lookup is O(1) — see §3.1.

### 4.5 Per-body driftSparks — already shipped (Phase 1)

No-op for Phase 2. Listed here for completeness so the audit can verify nothing regresses.

### 4.6 Per-event firing-frequency analysis (audit S3 fix)

| Event | Trigger | Worst-case rate (8-body match) | Bandwidth/s |
|---|---|---|---|
| `event.slipstream` | Edge-triggered on first reach of SLIPSTREAM_REQUIRED_TICKS, gated by `!wasActive` | At most once per body per ~1.5s draft window. With 4 simultaneous drafts and best-case oscillation: 4/1.5s = ~3/s | ~120 B/s |
| `event.slipstream_end` | Edge-triggered when grace counter expires | Mirror of above: 3/s worst | ~75 B/s |
| `event.apex_verdict` | Edge-triggered, AT MOST ONCE per (petId, lap, hairpinIndex). With 8 bodies × 2 hairpins × ~1 lap/30s = ~0.5/s | ~50 B/s |
| `event.ribbon_collected` | Edge-triggered, AT MOST ONCE per (petId, lap, ribbonId). Same magnitude as apex: ~0.5/s | ~40 B/s |
| `event.hazard_hit` | Edge-triggered per (petId, lap, hazardId). Same magnitude: ~0.5/s | ~40 B/s |
| `event.power_up_collected` (modified) | Existing event, +`kind` field. ~1 collect/2s/body in active play = ~4/s | +5 B per (just `kind`); +20 B/s total |

**Total Phase 2 event bandwidth overhead:** ~340 B/s in worst case. The protocol baseline is a 2-4 KB snapshot init + ~1 KB/s steady-state delta channel. Phase 2 events add ~10% to event channel — well within the 50% headroom budget set by P2-T42.

---

## 5. Visual / 3D additions (3da owned)

Three new scene components + one HUD subcomponent. **Spawn `3da` for all of §5 and §6.b** — Iris Xe constraints + scene-graph invariants apply.

### 5.1 `ReefRaceBoostRibbons.tsx` (new file)

- Reads `room.reefStaticZones.ribbons` from the activity store.
- For each ribbon, builds a flat `BoxGeometry` along the segment a→b at y=`KART_Y_ABOVE_TRACK + 1` so it sits just above the track ribbon.
- Geometry: `(length × 8wu × RIBBON_HALF_WIDTH * 2)` oriented along the segment tangent. Subdivision: 1 (zero indices needed — geometry lives at module scope shared across all rendered ribbons).
- Material: `MeshStandardMaterial` with `emissive: '#00e676'`, `emissiveIntensity: 0.6`, slight texture-less alpha 0.7 via opacity. NEVER `ShaderMaterial` (Iris Xe ban). NEVER `MeshBasicMaterial` because the ribbon needs to read the directional light gently.
- Module-scope geometry + material — page-lifetime, never disposed.
- A `useFrame` pulses `material.emissiveIntensity` on a 1Hz sine for the "glowing" feel — primitive math, no allocations.
- Draw calls: 2 (one per ribbon), under the 70-call budget.

### 5.2 `ReefRaceHazards.tsx` (new file)

- Reads `room.reefStaticZones.hazards`.
- For each hazard, places a TorusKnotGeometry (low complexity: `radius=hazard.radius`, `tube=4`, `tubularSegments=24`, `radialSegments=4`) flat on the track surface as a stylised "urchin field" placeholder. (Final art — sprites of urchin spikes — deferred to Phase 2.5.)
- Material: `MeshStandardMaterial` with `color: '#9c27b0'` (purple) + `emissive: '#7b1fa2'`, `emissiveIntensity: 0.4`, `roughness: 0.8`. Audit N7: 3da to evaluate `MeshBasicMaterial` with vertex-color emission as alternative if Iris Xe sees overdraw spikes.
- Module-scope geometry + material.
- No useFrame animation — static visual.
- Draw calls: 2 (one per hazard).

### 5.3 `ReefRaceApexMarkers.tsx` (new file)

- Reads `room.reefStaticZones.apexZones`.
- For each zone: TWO ring-meshes (CircleGeometry → torus-stencil): one at `innerCenter` colored green (`#00e676`), one at `outerCenter` colored amber (`#ff9800`).
- Subtle — these are FEEDBACK markers, not visual hazards. Inner ring = "drive through here for +5%", outer ring = "drive too wide and you eat -5%".
- Module-scope geometry + material; static; draw calls: 4 (2 zones × 2 rings).

### 5.4 Slipstream particle trail — DEFERRED

Per high-level plan §"Visual / 3D additions" (line 5): "Skip if too expensive."

Rationale to skip:
- Iris Xe budget: ≤70 draw calls. Phase 2 already adds 2 (ribbons) + 2 (hazards) + 4 (apex markers) = 8 calls — at the budget edge.
- Wake particles would need a per-front-runner Points/Trail object (≤4 max) at 30+ vertices each. Extra 4 draw calls. Borderline.
- Alternative: the trailing player will SEE they're in the wake via the new `event.slipstream` toast in §6 — the absence of a particle stream is information enough for Phase 2.

Re-evaluate in Phase 2.5 if leaderboard signals "players don't realise they're drafting" — that's the objective metric for graduating this off the deferred list.

### 5.5 Mounting in `ReefRaceScene.tsx`

Add three imports and three children inside `<SceneContents>`, wrapped in the pattern matching existing static-mesh components:

```tsx
import ReefRaceBoostRibbons from './ReefRaceBoostRibbons';
import ReefRaceHazards      from './ReefRaceHazards';
import ReefRaceApexMarkers  from './ReefRaceApexMarkers';
// ... inside SceneContents, after <ReefRaceCheckpoints />:
<ReefRaceBoostRibbons />
<ReefRaceHazards />
<ReefRaceApexMarkers />
```

Each component subscribes to `useActivityStore(s => s.room?.reefStaticZones)` with primitive identity check; the store object is stable across non-init frames so re-renders fire only on init / reset. No Map subscriptions.

---

## 6. HUD additions

### 6.1 `ReefRaceSlipstreamTag.tsx` (new file)

- Subscribes to `useActivityStore(s => s.slipstreamActive)` (new boolean state field — see §7 below).
- When `true` AND `matchPhase === 'live'`: renders a small `DRAFT` chip top-center, cyan-glow border, fade in/out with 100ms transition.
- Mounted from `<ReefRaceHud>` next to existing top-center elements (not bottom, to avoid colliding with the drift sparks bar).
- Primitive boolean subscription — re-renders only on transition. Object.is gate is automatic.
- **Audit S4 fix:** No internal timer polling needed. The `slipstreamActive` flag flips on `event.slipstream` and clears on `event.slipstream_end` — both server-driven.

### 6.2 Apex-verdict toast — `ReefRaceApexToast.tsx` (new file)

- Subscribes to `useActivityStore(s => s.lastApexVerdict)` (new `{kind:'clean'|'wide'; at:number} | null` state field).
- When fresh (within last 1.5s of `at`): centers a small toast "PERFECT LINE +5%" (green) or "DRIFT WIDE -5%" (amber) under the placement tile, fades after 1.5s.
- Pulled from store on every `event.apex_verdict` (set inside `applyServerFrame`).
- Auto-clears: a `useEffect` in the toast checks `Date.now() - at > 1500` and falls through to `null` rendering. Primitive object subscription — store sets a NEW object reference on each event, so React fires re-renders correctly.

### 6.3 Item rarity tier hint

Per the user's question — the existing placement tile shows "1st of 8". Adding rarity tier hint:
- Add a small one-character mini-icon below the placement number indicating the next-roll's tier:
  - 1st: 🛡 (defensive)
  - 2nd–3rd: 🛡* (defensive-leaning)
  - 4th–5th: ⚖ (neutral)
  - 6th–7th: ⚔* (aggressive-leaning)
  - 8th: ⚔ (aggressive)
- Stays in the existing `<PlacementTile>` component — no new file. Hidden when `placement === null`. Primitive number subscription on `placement`.

### 6.4 Existing HUD elements untouched

- `LapCounter`, `BestLapTile`, `PowerUpBar`, `LeaveButton`, `RoundCountdown`, `ReefRaceInstructions`, `ReefRaceDriftSparks`, launch glow ring — all read primitive selectors today; Phase 2 changes nothing. Verified against `apps/web/src/components/game/reef-race-hud.tsx:217-348`.

### 6.5 Re-render gates (load-bearing)

- All new HUD components MUST use primitive store subscriptions. NO `useActivityStore(s => s.entities)` or any Map subscription. The drift-sparks pattern (`s.driftSparks` is a primitive number) is the model. Audit verifies this in §14 — failing this requirement breaks the 30Hz tick budget.

---

## 7. Activity store additions (`apps/web/src/stores/activity.ts`)

### 7.1 New fields on `ActivityState` (audit C3 fix)

```ts
// Phase 2 — slipstream live indicator (set on event.slipstream, cleared on
// event.slipstream_end — both server-driven). Primitive boolean.
slipstreamActive: boolean;
// Phase 2 — last slipstream-event tick (for legacy stale-detection if a
// future Phase 3 wants to fall back to a timeout). Audit C3 fix: declared
// here, set in §7.2 case branch, read by audit-paranoia diagnostics only —
// no longer required for HUD logic given event.slipstream_end.
lastSlipstreamEventAt: number;
// Phase 2 — last apex verdict for toast rendering. Replaced (not appended)
// on each event.apex_verdict arrival.
lastApexVerdict: { kind: 'clean' | 'wide'; at: number } | null;
// Phase 2 — last ribbon collected (for HUD "boost!" flash). Optional.
lastRibbonCollectedAt: number;
// Phase 2 — last hazard hit (for HUD "ouch" flash + brief speed-debuff icon).
lastHazardHitAt: number;
// Phase 2 — placement on snapshot.delta is propagated through the same
// hoisting pattern as driftSparks (caller reads d.changed.placement for self).
// (Already covered by existing `placement: number | null` field; no new field.)
```

Init in `emptyState()`:
```ts
slipstreamActive: false,
lastSlipstreamEventAt: 0,
lastApexVerdict: null,
lastRibbonCollectedAt: 0,
lastHazardHitAt: 0,
```

### 7.2 New `case` branches in `applyServerFrame` (REQUIRED — exhaustive switch)

```ts
case 'event.slipstream': {
  if (state.selfPetId && frame.dstPetId === state.selfPetId) {
    set({ slipstreamActive: true, lastSlipstreamEventAt: Date.now() });
  }
  break;
}
case 'event.slipstream_end': {
  if (state.selfPetId && frame.dstPetId === state.selfPetId) {
    set({ slipstreamActive: false });
  }
  break;
}
case 'event.apex_verdict': {
  if (state.selfPetId && frame.petId === state.selfPetId) {
    set({ lastApexVerdict: { kind: frame.kind, at: Date.now() } });
  }
  break;
}
case 'event.ribbon_collected': {
  if (state.selfPetId && frame.petId === state.selfPetId) {
    set({ lastRibbonCollectedAt: Date.now() });
  }
  break;
}
case 'event.hazard_hit': {
  if (state.selfPetId && frame.petId === state.selfPetId) {
    set({ lastHazardHitAt: Date.now() });
  }
  break;
}
// Modified Phase 1 case — extends the existing branch:
case 'event.power_up_collected': {
  // ... existing entry-removal / world cleanup logic ...
  if (state.selfPetId && frame.collectorPetId === state.selfPetId) {
    // Phase 2 — write the actual collected kind into the inventory slot.
    // Audit C2 fix: makes the wire event the source of truth for self.
    const next = [...state.powerUpInventory];
    const slot = next.findIndex((s) => s.kind === null);
    if (slot >= 0) {
      next[slot] = { kind: frame.kind, charges: 1, cooldownUntil: 0 };
      set({ powerUpInventory: next });
    }
  }
  break;
}
```

All FIVE new event-cases (slipstream, slipstream_end, apex_verdict, ribbon_collected, hazard_hit) MUST be added before the `default: never` guard at `activity.ts:758` — TypeScript will fail the build until they're in place.

### 7.3 `slipstreamActive` end-of-life — server-driven (audit S4 fix)

The previous v1 timer-polling approach is REMOVED. Server emits `event.slipstream_end` when grace expires (§2.7); client clears the flag immediately on receipt (§7.2 case branch). No client-side timer needed.

Net code reduction in `<ReefRaceSlipstreamTag>` (~15 lines saved).

### 7.4 Placement hoisting in `snapshot.delta` handler

Mirror the existing driftSparks pattern (`activity.ts:498-514`):

```ts
let nextPlacement: number | null = state.placement;
for (const d of frame.entities) {
  applyEntityDelta(entities, d);
  if (state.selfPetId && d.petId === state.selfPetId) {
    if (typeof d.changed.driftSparks === 'number') {
      nextDriftSparks = d.changed.driftSparks as 0 | 1 | 2 | 3;
    }
    if (typeof d.changed.placement === 'number') {
      nextPlacement = d.changed.placement;
    }
  }
}
// ... existing set() now includes:
set({
  ...
  driftSparks: nextDriftSparks,
  placement: nextPlacement,
});
```

This OVERRIDES the existing `placement` derivation from `frame.scores` (`activity.ts:541-559`) — the server's per-tick `placement` field on EntityDelta is more reliable than ScoreDelta-derived placement (which today uses `score: b.lap`, an undercount of progress). Score-derived placement stays as a fallback if a delta omits the field.

### 7.5 `BumperShellEntity` does NOT need `placement` field

Placement is HUD-state only (single number). The scene's per-entity Map doesn't need it. No change to `bumper-shells-types.ts`. (Audit C7/N9 — R11 from v1 struck.)

---

## 8. Bot integration

### 8.1 Per-bot state additions in `reef-race-bot.ts`

```ts
class ReefRaceBot implements BotController {
  // ... existing fields (driftActive, driftStartedMs, driftTargetTicks,
  // launchAttempted, launchFireMs) ...

  // Phase 2 — slipstream / draft policy
  private draftTargetPetId: string | null = null;
  // Phase 2 — apex line preference (re-rolled per hairpin entry; sticks
  // through the corner so the bot doesn't oscillate).
  private lineMode: 'inside' | 'mid' = 'mid';
  // Phase 2 — last ribbon position aimed at (avoids per-tick recompute).
  private nextRibbonId: string | null = null;
}
```

### 8.2 Bot heuristics (one per mechanic) — gated by opening grace (audit N12 fix)

**ALL new heuristics short-circuit during opening grace.** Phase 1's `BOT_OPENING_GRACE_MS = 2500` exists so humans get a head-start; new draft / apex / hazard / placement-fire logic must respect that.

```ts
// Inside computeInput, BEFORE any Phase 2 heuristic block:
const matchAge = view.now - view.matchStartedAt;
const inGrace  = matchAge < BOT_OPENING_GRACE_MS;
```

**Drafting.** When a target body is within `SLIPSTREAM_MAX_DISTANCE * 1.5 = 75wu` ahead and within ±30° of bot's heading, bias `dir.x` and `dir.y` slightly toward the target's CURRENT position so the bot enters its wake. Already cheap — re-uses the existing forward checkpoint loop.

```ts
// Skipped during grace — bots shouldn't draft humans during head-start.
if (!inGrace) {
  const draftTarget = pickDraftTarget(view, self);
  if (draftTarget) {
    // Bias dir 25% toward draftTarget's position over the next-checkpoint dir.
    dx = dx * 0.75 + (draftTarget.x - self.x) * 0.25 / dist;
    dy = dy * 0.75 + (draftTarget.y - self.y) * 0.25 / dist;
    const m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;
  }
}
```

`pickDraftTarget` is a private fn that finds the nearest ahead-of-self body within range; reuses `view.bodies` (already O(N)).

**Apex.** Bot rolls `lineMode` ONCE per hairpin entry (when `dot < 0.5 && distToTarget > 200` AND target's checkpoint index is in `APEX_HAIRPIN_CHECKPOINT_INDICES`). 70% inside, 30% mid. Inside line steers slightly TOWARD the inside-of-curve direction (reuse checkpoint normal — already in `view.checkpoints[idx].normal`).

```ts
// Skipped during grace.
if (!inGrace && isHairpinTarget && this.lineMode === 'mid' && Math.random() < 0.70) {
  this.lineMode = 'inside';
}
if (!inGrace && this.lineMode === 'inside') {
  const cp = view.checkpoints![targetIndex];
  // Steer 30% toward (cp.center + cp.normal * APEX_INSIDE_OFFSET) instead of cp.center.
  const apexX = cp.center.x + cp.normal.x * APEX_INSIDE_OFFSET;
  const apexY = cp.center.y + cp.normal.y * APEX_INSIDE_OFFSET;
  dx = dx * 0.70 + ((apexX - self.x) / dist) * 0.30;
  dy = dy * 0.70 + ((apexY - self.y) / dist) * 0.30;
}
// On checkpoint cross (lineMode reset): set lineMode = 'mid' again.
```

**Ribbons.** When the next-checkpoint t-value is near a ribbon's midpoint (within ~5% of t), nudge `dir` toward the ribbon's centerline. Implementation: precompute the "ribbon-midpoint sim positions" once on first call (cache as a static class field — same lifetime as the controller), then snap to whichever ribbon midpoint is closer to the next checkpoint when the bot is approaching. Adds maybe 10 wu of lateral pull — enough to graze the ribbon, not enough to ditch the ideal line. **Skipped during grace.**

**Hazards.** Bot has a hazard-aware steering check: if any hazard's center is within 60wu of `self` AND ahead-of-self (positive dot vs `self.vel`), bias `dir` AWAY by 0.1 of the unit vector. Costs O(2) per tick. **Skipped during grace.**

**Aggressive items in 8th.** Bot's `POWERUP_USE_CHANCE = 0.30` becomes placement-aware:
- 1st place: 0.30 (defensive — hold for emergencies)
- 8th place: 0.45 (aggressive — fire fast to catch up)
- Mid: linear interp.

```ts
// Placement fire-rate gating — also skipped during grace.
if (!inGrace) {
  const placement = this.getOwnPlacement(view); // one-liner via view.bodies
  const useChance = placement === 1 ? 0.30
                  : placement === 8 ? 0.45
                  : 0.30 + (placement - 1) * (0.15 / 7);
  if (Math.random() < useChance) { actionBits |= (1 << i); break; }
}
```

`getOwnPlacement(view)`: `view.bodies.find(b => b.petId === view.selfPetId)?.currentPlacement ?? null` — pulls from the projected per-body field added in §3.4. Audit C1 + S10 fix.

### 8.3 Bot needs new fields on `BotRoomView` (audit C1 fix — replaces v1 §8.3)

Per §3.4, `buildBotRoomView` is extended with `lap`, `nextCheckpoint`, `currentPlacement`, `finishedAt`, `dnf` fields per body. The constants `APEX_HAIRPIN_CHECKPOINT_INDICES`, `APEX_INSIDE_OFFSET`, `SLIPSTREAM_MAX_DISTANCE`, `BOT_OPENING_GRACE_MS` are already exported from config.

---

## 9. Test plan

All new tests in `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` and `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts`. Pattern matches Phase 1's `bootDriftRoom` + `setIntent` helpers. **Reuse the helpers verbatim** — extending them is the change, not duplicating them.

### 9.1 Slipstream — sim tests

**P2-T1** — Slipstream charge accumulates when self is in target's wake.
- Two bodies `p1` (front, at origin moving +Y at 300 wu/s), `p2` (behind, 40wu south of p1, also moving +Y at 300 wu/s).
- Tick 50 times.
- After ≥45 ticks: assert `p2.activeBoosts.has('slipstream-boost') === true`, `p2.slipstreamSourcePetId === 'p1'`, `event.slipstream` broadcast EXACTLY once.

**P2-T2** — Slipstream does NOT charge when target's velocity is too slow.
- `p1` parked (vx=0, vy=0). `p2` 40wu behind.
- Tick 60 times.
- Assert `p2.slipstreamConsecutiveTicks === 0`, no `event.slipstream` broadcast.

**P2-T3** — Slipstream cancels on `resolveProximity` collision.
- Bodies positioned 30wu apart (inside `REEF_BODY_RADIUS * 2 = 44wu`); `resolveProximity` separates them.
- Tick once → bodies push to ≥44wu apart → next tick: still in `MAX_DISTANCE = 50wu` band, slipstream continues.
- Tick another 5 times → boost fires (or not) based on accumulated ticks.
- Assert no oscillation: `slipstreamConsecutiveTicks` either monotonically increases or resets cleanly.

**P2-T4** — Slipstream during a collision (edge case).
- `p1` and `p2` in same position (dist=0) — distSq=0 < minSq (= 33²=1089).
- Assert: dist=0 fails the `distSq < minSq` early-out, slipstream NOT credited. No NaN propagation.

**P2-T5** — Slipstream + drift-3 + launch combined respects `KINEMATIC_BOOST_CAP`.
- Plant all three boosts on a body, full thrust 60 ticks.
- Assert `Math.hypot(body.vx, body.vy) <= REEF_MAX_SPEED * 1.85 + 1` (1 wu/s float slack).

### 9.2 Cornering apex — sim tests

**P2-T6** — Inside-line apex bonus fires.
- Plant body inside `apexZones[0].innerCenter`, full forward velocity.
- Tick once.
- Assert `body.activeBoosts.has('apex-bonus')`, `event.apex_verdict` broadcast with `kind: 'clean'`.

**P2-T7** — Outside-line apex penalty fires.
- Plant body inside `apexZones[0].outerCenter`.
- Assert `body.activeBoosts.has('apex-penalty')`, `event.apex_verdict` with `kind: 'wide'`.

**P2-T8** — Apex check at the exact tick of a checkpoint cross.
- Plant body inside both apex disc AND checkpoint AABB simultaneously.
- Tick once.
- Assert apex verdict broadcast AND checkpoint advance — both happen on the same tick. Apex fires BEFORE checkpoint per §2.2 step 5b ordering.

**P2-T9** — Apex re-arms on lap-up.
- Plant body inside inner apex; tick → bonus fires; verify `body.apexCheckedThisLap.size === 1`.
- Manually advance `body.lap`. Tick `resolveCheckpoints` — verify the lap-up cleanup clears the set.
- Plant body inside inner apex again (next lap). Tick → bonus fires AGAIN.

**P2-T10** — Apex bonus + drift = additive.
- Plant body with active drift-3 boost. Cross apex inner zone.
- Read `speedMod` via integration test: speed should asymptote toward `REEF_MAX_SPEED * (1 + min(0.38 + 0.05, 0.85))` = `REEF_MAX_SPEED * 1.43`.

### 9.3 Boost ribbons — sim tests

**P2-T11** — Ribbon collected on segment cross.
- Plant body at midpoint of `state.ribbons[0]` segment, body radius inside the half-width.
- Tick once.
- Assert `body.ribbonsCollectedThisLap.has('0:rib-top')` (or whichever id), `event.ribbon_collected` broadcast, `body.activeBoosts.has('ribbon-boost')`.

**P2-T12** — Ribbon collected by two players at the same tick.
- Two bodies both at midpoint.
- Tick once.
- Assert BOTH bodies get the boost AND each gets one `event.ribbon_collected` broadcast.

**P2-T13** — Same ribbon NOT collected twice in same lap.
- Tick once at midpoint → boost fires.
- Move body offline 10wu, tick.
- Move body back to midpoint, tick.
- Assert: only ONE `event.ribbon_collected` broadcast across all ticks.

**P2-T14** — Ribbon cooldown across laps.
- Manually flip `body.lap` to next lap (clear `ribbonsCollectedThisLap`).
- Plant body at ribbon. Without resetting `ribbonLastCollectedAt`, tick.
- Assert: cooldown rejects (5s window), no boost.
- Advance `now` by 6s, tick.
- Assert: boost fires.

### 9.4 Hazards — sim tests

**P2-T15** — Hazard slow applies on overlap.
- Plant body inside `state.hazards[0].center` radius. Set vx=300.
- Tick once.
- Assert `body.activeBoosts.has('hazard-slow')`, `event.hazard_hit` broadcast.

**P2-T16** — Hazard hit during invuln (e.g., shield active).
- Plant body inside hazard with `body.activeEffects.set('rr-bubble-shield', now+9999)` (the invuln pickup).
- Tick once.
- Assert: `event.hazard_hit` STILL broadcast; `body.activeBoosts.has('hazard-slow')` STILL true.
- (Design choice: hazards are not ATTACKS — they're terrain. Shields don't protect against terrain. Documented in town-guide.ts knowledge[] per S5 fix.)

**P2-T17** — Hazard slow + drift = net positive (audit C5 verification).
- drift-3 boost (+0.38) + hazard (-0.40) → kineticDelta = -0.02 → speedMod = 0.98.
- Run integration test for 30 ticks → speed asymptotes near `REEF_MAX_SPEED * 0.98 ≈ 490 wu/s` (NOT 500 — the v1 spec was wrong; v2 produces the promised value).
- Confirms the "shortcut tradeoff" feels real.

**P2-T18** — Hazard re-fires on continuous overlap.
- Body camped inside hazard for 60 ticks.
- Assert `event.hazard_hit` broadcast EXACTLY ONCE per lap (the per-lap edge-trigger guard).
- Assert `activeBoosts.has('hazard-slow')` continuously TRUE (refreshed each tick).

### 9.5 Placement-weighted items — sim tests

**P2-T19** — `getPlacementItemTable(1)` returns defensive-only weights.
- Static config test. Assert the table for placement 1 contains NO `'rr-whirlpool'`, `'rr-seeker-jelly'`, or `'rr-tide-wave'`.

**P2-T20** — `getPlacementItemTable(8)` returns aggressive-only weights.
- Assert NO `'rr-bubble-shield'`, NO `'rr-ink-slick'`.

**P2-T21** — `computeLivePlacements` orders racing bodies correctly.
- Build state with 3 bodies at different (lap, nextCheckpoint) progress values.
- Assert placement ordering: highest progress = 1.

**P2-T22** — `computeLivePlacements` puts finishers ahead of racers ahead of DNFers.
- Body 1: finishedAt set. Body 2: lap=2, nextCheckpoint=5. Body 3: dnf=true.
- Assert placement: p1=1, p2=2, p3=3.

**P2-T23** — Placement-table lookup at edge of placement (1, 8, mid).
- Mock `lcgNext` to deterministic value, call `rollPowerUpKindForPlacement(state, 1)`, `(state, 4)`, `(state, 8)` — assert each returns a kind FROM the corresponding bucket only.

**P2-T24** — Placement-table fallback to global when placement is null/out-of-range.
- `rollPowerUpKindForPlacement(state, 9)` (out-of-range) returns from `REEF_POWERUP_DEFS` weights.

**P2-T25** — Placement is broadcast in EntityDelta.
- Two bodies with different progress values. Trigger a snapshot.delta. Assert each entity's `changed.placement` matches `state.lastPlacementMap`.

**P2-T26** — Placement broadcasts on placement-only change.
- Body crosses a checkpoint that doesn't change position (planted at it). Assert the snapshot delta still includes the body because `placement` changed (predicate update §4.4).

### 9.6 Anti-cheat / cap regression

**P2-T27** — `KINEMATIC_BOOST_CAP` clamps positive stack.
- Plant ALL FIVE positive boosts (`drift-3`, `launch`, `slipstream`, `ribbon`, `apex-bonus`). Drive 60 ticks.
- Assert `Math.hypot(body.vx, body.vy) <= REEF_MAX_SPEED * 1.85 + 5` (5 wu/s integration slack).
- Also verify per audit S11 transient: peak velocity over 60 ticks ≤ 1000 wu/s (validator ceiling).
- This is the master ceiling test — combined-boost stack must never silently break the validator.

**P2-T28** — `NEGATIVE_KINETIC_FLOOR` clamps negative stack.
- Plant `apex-penalty` AND `hazard-slow`. Drive 30 ticks.
- Assert speed asymptotes near `REEF_MAX_SPEED * 0.55` — `1 + max(-0.45, -0.50) = 0.55`.
- Then plant a hypothetical `-0.30` extra (force-set in test) — assert `negativeStack` floors at `-0.50`, speed asymptotes near `REEF_MAX_SPEED * 0.50`.

**P2-T29** — Hard cap stays at 1.85× even with new boosts (`integrateMotion`).
- Source-grep test (mirrors Phase 1 T14): assert `reef-race-sim.ts` references `1.85` exactly once + the `REEF_MAX_SPEED *` prefix.

### 9.7 Bot tests (in `reef-race-bot.test.ts`)

**P2-T30** — Bot drafts behind a leader when in range (post-grace).
- View with a target body 50wu ahead of self, both moving +Y at 300 wu/s. `view.now - view.matchStartedAt = 5000` (post-grace).
- Assert: returned `dir` has a positive Y component AND lateral X is biased toward target's X.

**P2-T31** — Bot doesn't collide with hazards (post-grace).
- Hazard center at (200, 0), body at (150, 0) moving +X. Post-grace.
- Run 60 ticks of `computeInput`.
- Assert: across at least 70% of ticks, the returned `dir` has a NEGATIVE-Y or large-perpendicular component (steering away).

**P2-T32** — Bot fires aggressive items more eagerly in 8th place (post-grace).
- Mock view: bot is 8th of 8 (`currentPlacement = 8` on bot's body). Inventory carries `'rr-whirlpool'`. Run 1000 computeInput calls.
- Assert: ratio of ticks with `actionBits & 0b01` ≥ 0.40.
- Run again with bot in 1st place (`currentPlacement = 1`).
- Assert: ratio ≤ 0.35.

**P2-T33** — Bot picks the inside line on hairpins ~70% of the time (post-grace).
- View targeting hairpin checkpoint (idx=3 or 9). Run 100 computeInput calls fresh-instantiating the bot each call (so the lineMode roll fires fresh).
- Assert: 50–90 of the 100 trials have `dir` biased toward the inner apex offset.

**P2-T34** — Bot heuristics SKIP during opening grace (audit N12 verification).
- View with `view.now - view.matchStartedAt = 1000` (less than 2500ms grace).
- Plant a draftable target 50wu ahead.
- Assert: `dir` is NOT biased toward draft target (uses default checkpoint dir only).
- Plant bot at hairpin checkpoint with `inGrace = true`.
- Assert: `lineMode` stays `'mid'`, no apex bias.
- Hazard at (200, 0), bot at (150, 0).
- Assert: `dir` shows no away-bias.
- Inventory carries `'rr-whirlpool'`, bot is in 8th place.
- Run 1000 ticks.
- Assert: fire-rate ≤ Phase 1 baseline (no placement boost during grace).

### 9.8 Snapshot bandwidth (regression)

**P2-T35** — Snapshot delta size grows by ~1 number per body per tick.
- Boot a 2-body room. Run 60 ticks.
- Capture all `snapshot.delta` frames; sum the JSON-serialised byte length.
- Compare to a baseline FIXTURE captured pre-Phase-2 in `apps/api/src/services/activity/sim/__tests__/fixtures/phase1-snapshot-bytes.json`. (Fixture committed in PR #1 of the bisect-split; see §12.)
- Assert: delta size grew by < 50% (one new field per body per delta).

This protects the 5Hz delta budget — adding a `placement` per body per delta = +6-byte ASCII number. With 8 bodies × 5Hz = 40 numbers/s = ~240 bytes/s of overhead. Acceptable.

### 9.9 New tests addressing audit test gaps (G1-G9)

**P2-T36** — Chain drafting (audit G1).
- Three bodies in a line: A at (0, 0), B at (0, -40), C at (0, -80). All moving +Y at 300 wu/s.
- Tick 60 times.
- Assert: B drafts A (`B.slipstreamSourcePetId === 'A'`), C drafts B (`C.slipstreamSourcePetId === 'B'`). Both get the +0.20 boost. `event.slipstream` broadcast EXACTLY twice (one for B, one for C).

**P2-T37** — Leader elimination mid-draft (audit G2).
- A leads, B drafts A. After 50 ticks, B has the boost.
- Mark A as `forfeited = true`.
- Tick 10 more times.
- Assert: `B.slipstreamSourcePetId` flips to `null` (filtered out of bodies list); after grace expires (6 ticks), `event.slipstream_end` broadcast for B. Boost cleared.

**P2-T38** — Ribbon at start/finish lap-up interaction (audit G3 / S13).
- Plant body at `state.ribbons[0]` ('rib-top'). Set up such that on this tick the body crosses BOTH the ribbon AND start/finish (lap-up).
- Tick once.
- Assert: ribbon-boost ACTIVE in `body.activeBoosts`, `event.ribbon_collected` broadcast, `body.lap` advanced. `body.ribbonsCollectedThisLap` is empty (cleared on lap-up) BUT the activeBoosts entry survives the cleanup. Per §2.11.

**P2-T39** — Hazard during stall (audit G4 — verifies §2.12 corrected row).
- Plant body inside hazard with `launch-stall` ALSO active.
- Tick once.
- Assert: `speedMod = 0.5` (stall override), `effectiveThrust ≤ 0.30`. Hazard's negative kineticMult is SKIPPED — hazard is a no-op during stall.
- Verify via integration: speed does NOT drop further than the 0.5 stall floor due to hazard.

**P2-T40** — Positive + negative kineticMult combination (audit G8 — exposes v1 C4/C5 bug).
- Plant drift-3 (positive 0.38) + hazard (negative -0.40). NO turbo.
- Tick once.
- Assert: `speedMod === 0.98` (NOT 1.0 as v1 produced).
- Plant additionally turbo-bubble (powerBoosted true).
- Assert: `speedMod === 1.0` (turbo wins positive slot at 0.40, hazard -0.40, kineticDelta = 0.00).

**P2-T41** — Placement on finish (audit G5).
- Body 1: about to cross the final checkpoint. Body 2: lap=1, nextCheckpoint=5.
- Tick body 1 across the line — `finishedAt` gets set.
- Tick once.
- Assert: snapshot delta for body 1 carries `placement: 1`. Body 2 carries `placement: 2`.

**P2-T42** — Ribbon collected during ink-slick (audit G6).
- Plant body slicked (`activeEffects.set('rr-ink-slick', now+5000)`). Move into ribbon segment.
- Tick once.
- Assert: `event.ribbon_collected` broadcast, `body.activeBoosts.has('ribbon-boost')` TRUE — but `speedMod = 0.5` due to slick override.
- Tick 5s forward (slick expires).
- Assert: now `speedMod = 1 + min(0.30, 0.85) = 1.30`. Ribbon boost survived the slick.

**Total tests: 42 (29 sim + 13 bot+regression).** Original 34 + 8 new (T35 was bandwidth, renumbered; G7 — bot-vs-human draft — covered implicitly by P2-T36 chain test).

---

## 10. Risks + mitigations

### R1 — Combined boost stack exceeds anti-cheat tolerance

**Risk:** Naively adding mechanics → drift-3 + launch + slipstream + ribbon + apex = +1.23 → 2.23×, blowing the 2.0× validator.

**Mitigation:** `KINEMATIC_BOOST_CAP = 0.85` clamps the positive sum. Verified by P2-T27 (combined stack never exceeds 1.85×). Hard cap in `integrateMotion` already exists at 1.85× — keeps fail-safe path. Validator tolerance unchanged.

### R2 — Apex check geometry is O(N×M) per tick (N bodies × M zones)

**Risk:** With 8 bodies × 2 hairpins = 16 distance checks/tick = 480/s. Trivial.

**Mitigation:** Distance² comparison (no sqrt). Per-body `apexCheckedThisLap.has(...)` short-circuits the work after the first verdict per zone. No optimization needed.

### R3 — Boost ribbon math depends on track centerline

**Risk:** PR #60 made the track an ellipse. If ribbons were derived from the legacy CatmullRom curve they'd be off the track.

**Mitigation:** Ribbons use `reefCenterlineAt(t)` directly — same source the checkpoints use. v2: `rib-top` placed at `t∈[0.92, 0.98]` (audit S13 fix) so it doesn't straddle start/finish.

### R4 — Placement-weighted item table balance

**Risk:** Misweighting makes 1st place trivially unkillable OR 8th place can't catch up.

**Mitigation:** Initial weights mirror Mario Kart 8's tier curve. Telemetry hooks: `event.power_up_collected` carries `kind` in v2, plus dashboards can correlate placement-at-collect via the snapshot delta's `placement` field. Phase 2.5 dashboard reads to validate the rubber-band lift (target: 8th-place position-gain rate ≥ 1.5× compared to no-rubber-band baseline).

### R5 — Slipstream behind a stalled launcher = noob bonus / exploit

**Risk:** A player who eats a launch-stall is moving slowly. Sneaky opponent could draft them for a free wake.

**Mitigation:** `SLIPSTREAM_MIN_VEL_ALIGNMENT` requires both velocities to align (≥0.5 dot product). A stalled body moving at 75 wu/s won't generate enough wake velocity — `tSpeed < REEF_MAX_SPEED * 0.30 = 150 wu/s` early-out kicks in. Verified by P2-T2.

### R6 — `event.slipstream` event spam at boundary

**Risk:** A body bouncing in/out of the wake fires repeated events.

**Mitigation:** `wasActive` flag (§2.7) — `event.slipstream` only fires on the FIRST tick of a fresh boost. v2 increase of `SLIPSTREAM_REFRESH_TTL_MS` from 200ms → 250ms (§1.3) ensures the boost survives one tick longer than its refresh cadence, so mid-tick expire-then-set can't double-broadcast (audit S3 fix).

### R7 — Phase 2 ships with no feature flag

**Risk:** Spec mandates "DO NOT add a feature flag / kill switch — just ship." If the balance is wrong, rollback = revert PR.

**Mitigation:** Phase 1 critical anchors C1-C6 and S4-S6, S10-S11 verified untouched by Phase 2 changes (audit instructions). No drift / launch path is rerouted. Rolling back Phase 2 leaves a clean Phase 1 game.

### R8 — Bot heuristic regression

**Risk:** New draft + apex + hazard logic disturbs existing bot tests (T22-T25 already test launch + drift + grace).

**Mitigation:** All new bot logic gates on `inGrace` short-circuit (audit N12 fix) AND on placement / hairpin / draft-target detection. Existing tests use generic checkpoints + placements WITHIN the grace window — new logic skips entirely. Run existing T22-T25 unchanged in the same test file — they MUST still pass.

### R9 — `RoomMeta.reefStaticZones` payload growth

**Risk:** Adding three arrays (ribbons, apex, hazards) to `snapshot.init` increases first-frame size.

**Mitigation:** Phase 2 ships 2 ribbons + 2 apex zones + 2 hazards × ~50 bytes each ≈ 600 bytes. `snapshot.init` baseline is ~2-4KB. < 25% growth. Sent ONCE per room; never on deltas.

### R10 — Ribbon cooldown semantics edge case

**Risk:** Server tick clock vs `Date.now()` for `ribbonLastCollectedAt`. Phase 1 uses `Date.now()` for boost expiries but `state.tick` for drift state. Mismatched semantics could break determinism.

**Mitigation:** Phase 2 uses `Date.now()` (passed as `now` param into `resolveBoostRibbons`) for cooldown — same as `activeBoosts.expiresAt`. `state.tick` is reserved for charge-counting (drift sparks). Documented in code header.

### R11 — `applyEntityDelta` first-insert branch needs `placement` init (STRUCK — audit C7/N9)

R11 from v1 is REMOVED. Placement is HUD-state only (top-level `state.placement`); no per-entity propagation needed. `BumperShellEntity` doesn't carry a `placement` field. Audit-verified C7/N9 — false alarm in v1.

### R12 — Ribbon detection on a curved approach

**Risk:** The ribbon "rib-top" sits in a near-straight section, but the centerline curves. A body approaching at a slight angle could miss the segment AABB even if visually crossing.

**Mitigation:** `RIBBON_HALF_WIDTH = 35wu` is wide enough (2.5× body radius) that a ±10° angle of attack still hits. Tested P2-T11/T13/T38. If telemetry shows a >10% miss rate in Phase 2.5, widen to 50wu in a follow-up.

### R13 — `computeLivePlacements` per-tick cost

**Risk:** O(N log N) once per tick. Worst case: 8 bodies = trivial.

**Mitigation:** `state.lastPlacementMap` cache refreshed at top of `tickRoom` (§2.2 step 0a). All readers (resolvePickups / buildBotRoomView / broadcastDelta) pull from cache — zero recomputation in same tick. Audit S7 fix.

### R14 — Stale `state.lastPlacementMap` for buildBotRoomView at tick boundary

**Risk:** `buildBotRoomView` is called by `runBotControllers` at step 0; `state.lastPlacementMap` is refreshed at step 0a (just before). On the FIRST tick of a fresh room, `lastPlacementMap` is empty → bots see `currentPlacement = null` until tick 2.

**Mitigation:** Initial value is `new Map()` (not undefined). Bots tolerate null placement (fall back to `POWERUP_USE_CHANCE = 0.30`, i.e. Phase 1 behavior). Audit-flag: explicitly handle null in §8.2 — already done via `?? null` in `getOwnPlacement`.

---

## 11. File-by-file scope table

Pattern matches `.claude/plans/reef-race-phase1-detailed.md` §10. Owner is `orchestrator` unless noted; line-count estimate is a delta over current file size.

| File | Owner | Phase 2 changes | Δ lines |
|---|---|---|---|
| `packages/shared/src/activities/protocol.ts` | orchestrator | Add 5 events to `ServerFrame` union (`slipstream`, `slipstream_end`, `apex_verdict`, `ribbon_collected`, `hazard_hit`); extend `event.power_up_collected` with `kind` field. Add `reefStaticZones` to `RoomMeta`. Document `placement?: number` in `EntityDelta.changed` block. | +75 |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | orchestrator | Add: Phase-2 `ReefBoostKind` extensions (5 new), `KINEMATIC_BOOST_CAP`, `NEGATIVE_KINETIC_FLOOR`, slipstream constants (8 incl. `SLIPSTREAM_REFRESH_TTL_MS`), apex constants (7) + `APEX_HAIRPIN_CHECKPOINT_INDICES`, ribbon types (`ReefBoostRibbon`) + builder (using `t∈[0.92, 0.98]` for rib-top per S13) + 4 constants, hazard types (`ReefHazardPatch`) + builder + 3 constants, `PLACEMENT_ITEM_TABLE` + `getPlacementItemTable`. | +230 |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | orchestrator | Add `slipstream*`/`ribbons*`/`apex*`/`hazard*` fields to `ReefBody` (§3); add `ribbons`/`apexZones`/`hazards`/`lastPlacementMap` to `ReefRoomState`; build them at `startRoom`; init body fields at body init; new private methods `resolveSlipstream`, `resolveBoostRibbons`, `resolveApex`, `resolveHazards`, `computeLivePlacements`, `rollPowerUpKindForPlacement`, `getStaticZones`; insert resolves + cache refresh into tick pipeline (§2.2); modify `applyIntentForTick` step 4 to use cap/floor stack arithmetic (§2.3); widen `isBoostActive` gate in `integrateMotion`; add lap-up cleanup in `resolveCheckpoints`; modify `resolvePickups` to use placement-rolled kind AND broadcast `kind` in `event.power_up_collected`; add `placement` field to `ReefSnapshot.bodies`, `buildSnapshot`, `broadcastDelta` predicate + emitted `changed` object; **rewrite `buildBotRoomView` to project `lap`, `nextCheckpoint`, `currentPlacement`, `finishedAt`, `dnf` per body** (audit C1 fix). | +420 |
| `apps/api/src/services/activity/activity-ws-hub.ts` | orchestrator | In `sendInit` reef-race branch: include `reefStaticZones: reefRaceSim.getStaticZones(room.id)` in the emitted `RoomMeta`. | +5 |
| `apps/api/src/services/activity/bots/reef-race-bot.ts` | orchestrator | Add `draftTargetPetId`, `lineMode`, `nextRibbonId` instance fields; add `pickDraftTarget` + `getOwnPlacement` (one-liner via projected view) private helpers; integrate draft + apex + hazard + placement-weighted item-fire logic into `computeInput`, ALL gated by `inGrace` short-circuit (audit N12 fix). | +130 |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | orchestrator | Add P2-T1..P2-T29 + P2-T36..P2-T42 (sim + audit-gap tests). | +600 |
| `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts` | orchestrator | Add P2-T30..P2-T34 bot tests (incl. T34 grace short-circuit). | +160 |
| `apps/api/src/services/activity/sim/__tests__/fixtures/phase1-snapshot-bytes.json` | orchestrator | NEW fixture. Captured at the head of Phase 1 (pre-Phase 2 code lands) by running a 2-body room for 60 ticks and serialising delta byte-counts. Committed in PR #1 of the bisect-split. Audit G9 fix. | new file (~200 lines JSON) |
| `apps/web/src/stores/activity.ts` | orchestrator | Add `slipstreamActive`, `lastSlipstreamEventAt`, `lastApexVerdict`, `lastRibbonCollectedAt`, `lastHazardHitAt` to `ActivityState` + `emptyState()`. Add `placement` hoist in `snapshot.delta` handler. Add 5 NEW `case` branches (slipstream, slipstream_end, apex_verdict, ribbon_collected, hazard_hit) before `default: never`. EXTEND existing `event.power_up_collected` case with inventory write for `selfPetId` (audit C2 fix). | +90 |
| `apps/web/src/components/game/reef-race-hud.tsx` | orchestrator | Mount `<ReefRaceSlipstreamTag>`, `<ReefRaceApexToast>`. Update `<PlacementTile>` to show rarity-tier hint icon. | +25 |
| `apps/web/src/components/game/reef-race-slipstream-tag.tsx` | orchestrator | NEW file — `DRAFT` chip top-center. Primitive-bool subscription. NO timer (server-driven via `event.slipstream_end` — audit S4 fix). | +45 |
| `apps/web/src/components/game/reef-race-apex-toast.tsx` | orchestrator | NEW file — apex-verdict toast. Object subscription on `lastApexVerdict` + 1.5s auto-fade. | +60 |
| `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` | 3da | Add visualization-only constants: `RIBBON_VISUAL_HEIGHT`, `RIBBON_VISUAL_THICKNESS`, `HAZARD_VISUAL_TUBE`, `HAZARD_VISUAL_TUBULAR_SEGS`, `APEX_RING_THICKNESS`. (Server constants imported from `apps/api/...` are NOT cross-consumed; client gets values via `RoomMeta.reefStaticZones`.) | +20 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceBoostRibbons.tsx` | 3da | NEW file — flat box mesh per ribbon, emissive pulse, module-scope geometry/material, primitive store subscription on `room.reefStaticZones`. | +90 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceHazards.tsx` | 3da | NEW file — TorusKnot urchin placeholder per hazard, static, module-scope geo/mat. 3da to evaluate `MeshBasicMaterial` alternative if Iris Xe shows overdraw spikes (audit N7). | +70 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceApexMarkers.tsx` | 3da | NEW file — two ring meshes per apex zone (inner green + outer amber). | +70 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx` | 3da | Mount the 3 new components inside `<SceneContents>`. | +6 |
| `3dStructure.md` | 3da | Document the 3 new scene components, their draw-call cost, and that ribbon/hazard/apex marker positions come from `RoomMeta.reefStaticZones`. Bump "Last Audited". | +40 |
| `GameFeatures.md` | orchestrator | Document the 5 new mechanics under Reef Race section. Update combined-boost ceiling math + the speedMod combination model from §2.3. Note "shields don't block hazards" rule. Bump "Last Audited". | +70 |
| `packages/agent-templates/src/locations/town-guide.ts` | orchestrator | Update `knowledge[]` with: "**Reef Race Phase 2.** Adds (1) slipstream drafting — sit in another body's wake at 33-50wu for 1.5s for a +20% boost; (2) cornering apex — clean inside line at the two hairpins gives +5% / 1.5s, drifting wide gives -5% / 1.5s; (3) two boost ribbons painted on the long straights — drive over for +30% / 2s, once per lap each; (4) sea-urchin hazard zones inside the hairpin apexes — clipping costs -40% speed but the line is shorter (drift-3 + hazard ≈ 0.98× speed); (5) Mario-Kart-style placement-weighted power-ups — 1st gets defensive only, 8th gets aggressive only. **Shields don't block hazards** (audit S5 — hazards are terrain, not attacks). Combined positive boosts cap at +85%, combined slows floor at -50%, ink-slick continues to override everything to 0.5×." | +12 |
| `.claude/plans/reef-race-real-racing.md` | orchestrator | Audit N2 — fix the stale `packages/shared/src/types/activity-frames.ts` reference at line 108; should be `packages/shared/src/activities/protocol.ts`. | +1 / -1 |

**Totals:** 20 files touched, ~2200 lines added (+1 fixture file).

**No-touch invariants — verify in audit:**
- Phase 1 anchors C1, C2, C3, C4, C5, C6 — drift bias INSIDE atan2, separate `activeBoosts`/`activeEffects` maps, named tolerance, launch verdict path, bot launch early-return, drift cancel rules. None of these surfaces are rewritten in Phase 2.
- Phase 1 anchors S4, S5, S6, S10, S11 — boost delivery via speedMod (no impulse), boost-gated hard cap, abort buffer cleanup, `startedAt` in `startRoom`, first-sighting `driftSparks` init. None rewritten.
- `REEF_KINEMATIC_TOLERANCE = 2.0` unchanged.
- `REEF_MAX_SPEED = 500`, `REEF_BOOST_MULT = 1.4`, `REEF_BODY_RADIUS = 22` unchanged.
- All Phase 1 sim tests (T1..T21) and bot tests (T22..T25) MUST still pass after Phase 2 lands. Phase 2 changes are STRICTLY additive — no test rewrites.

---

## 12. Implementation order — explicit single-PR-with-bisect-safe-commits decision

**DECISION: Phase 2 ships as ONE PR with internal commits in the order below.** Per audit "Implementation order recommendation" §3 — 10 PRs is too many for one release; practical compromise is one PR with discrete commits in a bisect-friendly order.

**Why one PR, not multiple:**
- Phase 1 was reviewed as a single PR. Phase 2 is purely additive depth; the review surface is the SAME area of code.
- The audit's recommended split into 3 PRs (sim mechanics / bots / client) introduces cross-PR sequencing risk: client code that references protocol events from PR-A can't compile without PR-A merging first; same for bots that reference `BotRoomView` extensions from PR-B.
- Bisect-safe = each commit independently revertable AND each commit either passes ALL existing tests OR adds tests that pass within that commit. Single PR with 10 commits achieves this without merge-train coordination.

**Commit order (each commit is an independent revert point — no commit leaves the build in a partial state):**

| # | Commit subject | Scope | Revert-safe |
|---|---|---|---|
| 1 | `phase2(reef): protocol additions + activity store cases (no-op)` | `protocol.ts`: 5 new events + extended `event.power_up_collected.kind` + `RoomMeta.reefStaticZones` + `EntityDelta.changed.placement` doc. `activity.ts`: empty `case ...: break;` for 5 new events + state fields + emptyState init + placement hoist. NO server emissions yet. | Yes — server doesn't emit, client tolerates absence |
| 2 | `phase2(reef): config constants + types + builders` | `reef-race-config.ts`: all new constants (`KINEMATIC_BOOST_CAP`, `NEGATIVE_KINETIC_FLOOR`, slipstream/apex/ribbon/hazard constants), types (`ReefBoostRibbon`, `ReefHazardPatch`), builders (`buildReefBoostRibbons`, `buildReefHazardPatches`, `buildReefApexZones`), placement table. | Yes — never imported until commit #3 |
| 3 | `phase2(reef): sim infrastructure — body/state shapes + cap math + bot view extension` | `reef-race-sim.ts`: `ReefBody` field additions, `ReefRoomState` field additions (incl. `lastPlacementMap`), `startRoom` builder calls, body-init defaults, `applyIntentForTick` step 4 cap/floor speedMod arithmetic, `integrateMotion` `isPositiveBoostActive` gate widening, `buildBotRoomView` projection of `lap/nextCheckpoint/currentPlacement/finishedAt/dnf`, `computeLivePlacements` + `cacheLivePlacementMap` at top of `tickRoom`. NO new mechanics yet. P2-T27/T28/T39/T40 (cap + floor + combined math) added here. | Yes — only the speedMod arithmetic changes; existing values still produce existing speedMods. |
| 4 | `phase2(reef): slipstream` | `reef-race-sim.ts`: `resolveSlipstream` + tick-pipeline insertion at step 3a + `event.slipstream` / `event.slipstream_end` emission. P2-T1-T5 + T36 (chain) + T37 (leader elim). HUD: `<ReefRaceSlipstreamTag>` + reef-race-hud mount + activity.ts case branches. | Yes — slipstream OFF cleanly without it |
| 5 | `phase2(reef): boost ribbons` | `resolveBoostRibbons` + tick insertion at 5a + `event.ribbon_collected` emission + lap-up cleanup of `ribbonsCollectedThisLap`. `activity-ws-hub.ts` sendInit emits ribbon zones. P2-T11-T14 + T38 (start/finish lap-up) + T42 (ink-slick interaction). 3D component `ReefRaceBoostRibbons.tsx` (3da). | Yes |
| 6 | `phase2(reef): apex bonus + hazards` (paired) | `resolveApex` + `resolveHazards` + tick insertions at 5b/5c + emission of `event.apex_verdict` + `event.hazard_hit` + lap-up cleanup. sendInit emits apex zones + hazards. P2-T6-T10 + T15-T18. 3D components `ReefRaceApexMarkers.tsx` + `ReefRaceHazards.tsx` (3da). HUD: `<ReefRaceApexToast>` + activity.ts case branches. | Yes |
| 7 | `phase2(reef): placement-weighted power-ups` | `rollPowerUpKindForPlacement` + `resolvePickups` re-roll at collect + `event.power_up_collected.kind` emission + activity.ts inventory write. `buildSnapshot` / `broadcastDelta` placement field. P2-T19-T26 + T41 (placement on finish). | Yes — falls back to global roll if placement is null |
| 8 | `phase2(reef): bot heuristics` | `reef-race-bot.ts`: draft + apex + hazard + placement-fire logic + `inGrace` short-circuit. Uses extended `BotRoomView` from commit #3. P2-T30-T34. | Yes — bots fall back to Phase 1 behavior |
| 9 | `phase2(reef): client HUD polish + tier hint` | `reef-race-hud.tsx`: `<PlacementTile>` rarity-tier icon. Final 3D mounting cleanup in `ReefRaceScene.tsx`. | Yes — pure visual |
| 10 | `phase2(reef): docs — town-guide knowledge + 3dStructure + GameFeatures + high-level plan path fix` | `town-guide.ts` knowledge[] (audit S5 fix incl. shield rule), `3dStructure.md`, `GameFeatures.md`, `reef-race-real-racing.md` path fix (audit N2). Bump "Last Audited" lines. | Yes — docs only |

**Snapshot-bandwidth fixture (P2-T35):** captured at the head of commit #1 (BEFORE any Phase 2 sim changes ship), committed as `phase1-snapshot-bytes.json`. P2-T35 reads the fixture for comparison. Audit G9 fix.

**Bisect strategy:** Each commit either ADDs tests that pass within that commit, OR is purely additive scaffolding that doesn't change test outcomes. `git bisect run bun test` on any range will identify the offending commit cleanly.

---

## 13. Out of scope (Phase 2 enforcement)

- Slipstream particle trail VFX — see §5.4 deferral rationale. Reconsider in Phase 2.5 if telemetry justifies.
- Final art for ribbons / hazards — placeholder geometry only. Polish pass deferred.
- Per-archetype stat modifiers (Phase 3): `slipstreamWindowMs`, `ribbonDetectRadiusMultiplier`, etc. Phase 2 uses fixed constants only.
- New power-up kinds (e.g. lightning) — out of scope; sticking to existing 6.
- Personal-best ghost (Phase 4).
- Top-speed cap reduction or per-archetype cap (forbidden invariant).
- Feature flag / kill switch (per spec).
- `import 'three/webgpu'` anywhere (PR #59 ban).
- Per-frame `new Vector3()` or other GC-producing allocations.
- Map/Set subscriptions in HUD components.
- Modifying `REEF_KINEMATIC_TOLERANCE`, `REEF_MAX_SPEED`, or `REEF_BOOST_MULT`.
- Rewriting any Phase 1 critical path (drift bias, activeBoosts separation, named tolerance, launch verdict path, bot launch early-return).
- **Wiring the per-tick inventory delta channel for Reef Race.** Audit C2/S12 — the channel is silently broken today (sim never emits `inventory: [...]` on PowerUpDelta). Phase 2 closes the immediate UX bug via `event.power_up_collected.kind` (authoritative on collect), and the inventory display for self is updated on that event in `activity.ts`. Wiring the per-tick inventory channel is a Phase 2.5 cleanup ticket — tracked in `improvements.md` (orchestrator to add).

---

## 14. Audit checklist (for the second-pass auditor)

The auditor should grep / read for each of these and assert as listed.

- [ ] `KINEMATIC_BOOST_CAP = 0.85` exported from `reef-race-config.ts`. `NEGATIVE_KINETIC_FLOOR = -0.50` exported (renamed from v1's `KINEMATIC_BOOST_FLOOR`).
- [ ] `applyIntentForTick` step 4 uses both constants in the v2 four-step flow: positive cap → pickup competition (MAX) → negative floor → combine → ink-slick override → absolute 0.5 floor.
- [ ] `integrateMotion` `isPositiveBoostActive` gate enumerates ALL 5 positive kinematic kinds (`launch-boost`, `drift-boost`, `slipstream-boost`, `ribbon-boost`, `apex-bonus`).
- [ ] All FIVE new ServerFrame events (`event.slipstream`, `event.slipstream_end`, `event.apex_verdict`, `event.ribbon_collected`, `event.hazard_hit`) are referenced in `activity.ts` switch with explicit `case ...: break;` BEFORE `default: never`. PLUS the `event.power_up_collected` case is extended with an inventory-write block for self.
- [ ] `placement` field is broadcast in `EntityDelta.changed` AND included in the delta-predicate equality check.
- [ ] `RoomMeta.reefStaticZones` populated in `sendInit` reef-race branch.
- [ ] Each new resolver (`resolveSlipstream`, `resolveBoostRibbons`, `resolveApex`, `resolveHazards`) is called inside `tickRoom` at the §2.2 insertion order — slipstream at 3a (after boost sweep, before proximity), ribbons/apex/hazard at 5a-5c (after pickups, before checkpoints).
- [ ] `state.lastPlacementMap` refreshed at top of `tickRoom` (step 0a), BEFORE bot controllers run.
- [ ] `body.ribbonsCollectedThisLap`, `apexCheckedThisLap`, `hazardsHitThisLap` ALL cleared in `resolveCheckpoints` lap-up branch — AFTER the resolvers (which use PRE-INCREMENT lap as key per §2.11).
- [ ] `buildBotRoomView` projects `lap`, `nextCheckpoint`, `currentPlacement`, `finishedAt`, `dnf` per body (audit C1 fix).
- [ ] All new bot heuristics gated by `inGrace` short-circuit using `BOT_OPENING_GRACE_MS` (audit N12 fix).
- [ ] `event.power_up_collected` carries `kind` field; `resolvePickups` broadcasts the placement-rolled kind (audit C2 fix).
- [ ] `event.slipstream_end` emitted on grace expiry — no client-side timer for `slipstreamActive` clear (audit S4 fix).
- [ ] `lastSlipstreamEventAt` declared in `ActivityState` and set in the `event.slipstream` case branch (audit C3 fix).
- [ ] `event.apex_verdict` (renamed from `event.apex_bonus`) carries `kind: 'clean' | 'wide'` (audit S1 fix).
- [ ] `rib-top` ribbon segment is FULLY BEFORE `t=0` (e.g. `t∈[0.92, 0.98]`); does NOT straddle start/finish (audit S13 fix).
- [ ] Town-guide knowledge[] entry covers all 5 mechanics + "shields don't block hazards" rule (audit S5 fix).
- [ ] No new HUD component subscribes to a Map or non-primitive store field.
- [ ] No new file imports `three/webgpu`.
- [ ] No new `useFrame` body allocates a Vector3, Quaternion, or new object literal.
- [ ] All Phase 1 critical anchors (C1-C6, S4-S6, S10-S11) UNCHANGED — verify via `git diff master` on those exact line spans.
- [ ] All Phase 1 tests (T1-T25) still pass post-Phase-2 — verify via `bun test apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts`.
- [ ] `combined boost stack ≤ 1.85×` proven by P2-T27 (the master ceiling test).
- [ ] `drift-3 + hazard → speedMod = 0.98` proven by P2-T17 + P2-T40 (audit C5 fix verification).
- [ ] `drift-3 + hazard + turbo → speedMod = 1.00` proven by P2-T40 (audit C4 fix verification).
- [ ] Snapshot bandwidth growth ≤ 50% vs `phase1-snapshot-bytes.json` fixture (P2-T35, audit G9 fix).
- [ ] `bot.computeInput` test T22-T25 (Phase 1) still pass — i.e. existing launch + drift + grace + cooldown behaviours preserved.
- [ ] `reef-race-real-racing.md` line 108 updated to reference `protocol.ts` (audit N2 fix).
