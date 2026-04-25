# Phase 2 Plan Audit

**Plan:** `.claude/plans/reef-race-phase2-detailed.md` (1714 lines, SHA `ea723ee`)
**Auditor:** Orchestrator (red-team pass)
**Date:** 2026-04-25
**Mode:** Find issues — not implementing, not approving.

---

## Critical issues (must fix before implementing)

### C1 — `buildBotRoomView` is missing `lap` + `nextCheckpoint` per body, plan does not extend it

**Severity:** Critical. Bot heuristic in §8.2 computes own-placement via `getOwnPlacement(view)` which "walks `view.bodies` once and computes the same race-progress formula the sim uses." But `view.bodies` in `reef-race-sim.ts:988-1001` only carries `{petId, x, y, vx, vy, rot, alive, inventory}` — no `lap`, no `nextCheckpoint`. Without those, race progress can't be computed and the placement-aware fire-rate (§8.2 "Aggressive items in 8th") is impossible.

The plan's file-scope table (§11) for `reef-race-sim.ts` lists many changes but **does not mention extending `buildBotRoomView`**. §8.3 explicitly claims "Bot doesn't need any new exports from `reef-race-config.ts`" — but it DOES need new fields on the bot view shape, and that shape is defined in `reef-race-sim.ts`, not the bot file. Plan misses this.

**Fix:** Plan must explicitly extend `buildBotRoomView`'s return shape to include `lap` and `nextCheckpoint` (and arguably `finishedAt` / `dnf` so DNFers can be filtered out). Add to §11 file-scope.

### C2 — Plan's "collected kind ≠ spawn kind" relies on inventory broadcast that doesn't exist

**Severity:** Critical. §2.5 ends:
> "the in-world spawn kind is cosmetic only ... The collected kind is what the player gets; ... the snapshot's `inventory` PowerUpDelta carries the actual collected kind (already the source of truth for the HUD)"

But the Reef Race sim **does NOT broadcast inventory deltas** today. `buildSnapshot` (`reef-race-sim.ts:1415-1439`) emits `bodies` + `pickups` only. `broadcastDelta` (1479-1542) emits entity deltas + power-up world deltas — never `inventory: [...]` on PowerUpDelta. `event.power_up_collected` carries only `{spawnId, collectorPetId}` — no `kind`.

The web client's HUD reads `state.powerUpInventory`, which is populated in `activity.ts:530-537` from `p.inventory` arrivals — but the Reef sim never sends them. So the HUD's inventory display path for Reef is **either silently broken today OR derived from somewhere else not visible in the sim**.

If the plan's "spawn kind ≠ collect kind" split ships, the client will display the spawn kind (because that's what `event.power_up_spawned` + `pickup.kind` carry through), and the player USES the collected kind on actionBit press. The slot mismatch will be invisible to the player — but the actual fired item won't match what they thought they picked up. UX bug.

**Fix:** EITHER (a) keep the spawn-time roll authoritative (i.e. simpler approach: roll based on the LIKELY collector = nearest-body's placement at spawn time, and accept the visual mid-flight artifact), OR (b) add inventory broadcast to Reef sim's snapshot delta path so the HUD can display the actual collected kind, OR (c) emit a new event `event.power_up_collected_kind { spawnId, kind }` on collect. Plan must pick one and document. As written, the user gets a "stealth swap" that breaks affordance.

### C3 — `lastSlipstreamEventAt` is referenced but not declared

**Severity:** Critical (build-breaking once enforced). §7.3 says "The store carries `lastSlipstreamEventAt: number` updated in the case branch." But §7.1's list of new fields on `ActivityState` is `slipstreamActive`, `lastApexVerdict`, `lastRibbonCollectedAt`, `lastHazardHitAt` — `lastSlipstreamEventAt` is missing. §7.2's `case 'event.slipstream'` does NOT update `lastSlipstreamEventAt` either; it only flips `slipstreamActive: true`. The auto-clear in §7.3 has nothing to read from.

**Fix:** Add `lastSlipstreamEventAt: number` to §7.1. Update §7.2 case branch to set it. Implementation will not work as drafted.

### C4 — Apex penalty + ink-slick interaction crashes the floor logic

**Severity:** Critical (silent gameplay break). §2.3 plan code:

```ts
const negativeKinetic = Math.max(apexPenSub + hazardSub, KINEMATIC_BOOST_FLOOR);
const kineticMult = positiveKinetic + negativeKinetic;
const pickupMult  = powerBoosted ? REEF_BOOST_MULT - 1.0 : 0;
const bestMult = Math.max(kineticMult, pickupMult);
speedMod = slicked ? 0.5 : Math.max(0.5, 1.0 + bestMult);
```

When `slicked` and ALSO `apex-penalty + hazard-slow` and ALSO `powerBoosted`, the `slicked` branch takes 0.5 — discarding both the slow-stack AND the turbo. That's the same behavior as today (slick overrides everything). **But** when NOT slicked, the `Math.max(kineticMult, pickupMult)` taken with `kineticMult` strongly negative (e.g. -0.40) and `pickupMult = 0.40` → bestMult = +0.40 → speedMod = 1.40. **The hazard slow is silently erased by an active turbo-bubble.** This is wrong: the design says "drift-3 + hazard = net positive shortcut" (§2.3 properties bullet 5). If turbo also nullifies hazard, the entire risk/reward of the urchin field is moot whenever a player has a turbo charge.

**Fix:** EITHER (a) move `negativeKinetic` OUTSIDE the `Math.max` so it's always subtracted: `bestMult = Math.max(positiveKinetic, pickupMult) + negativeKinetic`, OR (b) document that turbo bypasses hazard intentionally (and update §10.5 hazard interaction matrix). As written, §2.12's interaction matrix row "Hazard | applied always (negative)" is FALSE — it's only applied when no pickup mult exists.

### C5 — Drift-3 + hazard "net positive" claim is also wrong under the same arithmetic

**Severity:** Critical (math error). Same arithmetic. Plan §2.3 properties:
> "Drift-3 + hazard (-0.40) → kineticMult = -0.02 → speedMod = 0.98"

But by the formula, `positiveKinetic = 0.38`, `negativeKinetic = -0.40`, `kineticMult = -0.02`. Then `pickupMult = 0` (no turbo). `bestMult = max(-0.02, 0) = 0`. `speedMod = 1.0 + 0 = 1.0`, NOT 0.98. The `Math.max(kineticMult, pickupMult)` step floors negative-kinetic at 0 because `pickupMult = 0` is bigger. So the hazard is also erased even without a turbo.

**Fix:** Same as C4. The arithmetic in §2.3 doesn't produce the property-bullet outcomes. Re-derive the cap/floor formula and re-state the property-bullet outcomes against the corrected formula. P2-T17 will fail as written because the asymptote will hit ≈500 wu/s, not ≈490 wu/s.

### C6 — `KINEMATIC_BOOST_FLOOR` listed twice with different intents

§1.2 says `KINEMATIC_BOOST_CAP = 0.85` (clamp positive sum). §1.8 says `KINEMATIC_BOOST_FLOOR = -0.50` (combined cannot drop more than 50%). But in §2.3 the implementation `Math.max(apexPenSub + hazardSub, KINEMATIC_BOOST_FLOOR)` only floors at -0.50, then takes `Math.max(kineticMult, pickupMult)` — which (per C4/C5) cancels the floor entirely whenever turbo is active or the positive stack > |negative stack|. The floor name is misleading because the actual hard floor `Math.max(0.5, 1 + bestMult)` lives elsewhere.

**Fix:** Rename `KINEMATIC_BOOST_FLOOR` to `NEGATIVE_KINETIC_FLOOR` and document it's the LIMIT on summed negatives (not a speedMod floor — that's the existing `Math.max(0.5, ...)`).

### C7 — `placement` field in EntityDelta will not propagate via `applyEntityDelta` first-insert branch

`applyEntityDelta` in `apps/web/src/stores/activity.ts:278-313` only initialises `x/y/rot/vx/vy/alive/driftSparks` on first sighting. Any other field hits the "existing-only" path. But §4.3 claims `placement?: number` is a `changed` field on `EntityDelta`. The plan's §7.4 says `placement` is hoisted in the `snapshot.delta` handler caller, NOT applied to the per-entity Map (which is fine). But §7.5 says "BumperShellEntity does NOT need placement field". Cross-checking against R11: "First-insert branch sets `placement: undefined`" — but BumperShellEntity has no `placement` field, so there's nothing to set. The R11 mitigation is misleading/redundant. Not breaking, but noise in the audit checklist.

**Fix:** Strike R11. The HUD's `<PlacementTile>` reads `state.placement` (top-level numeric, not per-entity). Per-entity placement field on BumperShellEntity is correctly NOT added.

### C8 — Outer apex zone center sits OUTSIDE the lane, can never be entered legitimately

§1.4: `APEX_OUTSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.55 = 82.5 wu`. Outer ring center at `cp.center - normal * 82.5` = 82.5wu OUTSIDE the centerline. The track half-width is 150wu (lane half), so the outer center is at 82.5 → still inside lane. But add the radius = 44wu → outer ring extends to 82.5 + 44 = 126.5wu from centerline. The body radius is 22wu, so a body at 104.5wu from centerline (still in lane: 150 > 104.5) center-touches the outer ring. OK.

**However**, the bot heuristic for "drift wide" detection actually fires when a body is mid-corner clipping the OUTER rail. Bodies that hit the rail get separation pushback, are forced inward, and never reach 104+wu offsets long enough to trigger the verdict — UNLESS they're cutting wide with momentum. In practice this means the "wide" penalty fires only on cars actively skidding outward, which IS the intended UX. But the `RIBBON_HALF_WIDTH = 35wu` and the apex zone width is also ~44wu — these are "narrow" zones and a player skating just inside the edge will MISS both. Consider widening or revisit after telemetry.

**Severity:** Significant (gameplay tuning), not critical. Flag for telemetry-driven re-tune.

---

## Significant issues (should fix)

### S1 — `event.apex_bonus` is misnamed when carrying the penalty case

§4.1 emits one event type for both verdicts: `event.apex_bonus { kind: 'inside' | 'wide' }`. Calling the wide-line "drift wide" case `event.apex_bonus` is semantically wrong (it's NOT a bonus). When this hits log dashboards and analytics, "apex_bonus" with `kind: wide` is confusing.

**Fix:** Either split into two events (`event.apex_clean` / `event.apex_wide`) or rename to neutral `event.apex_verdict`. Update §7.2 case + §6.2 toast.

### S2 — Slipstream "best target = closest" creates oscillation in chains

§2.7 picks `bestSrc = closest valid target`. Plan correctly notes "avoid bouncing between two leaders" — but in a 3-body chain (A leads B leads C), C might oscillate between drafting B (closer) and drafting A (further). The plan asserts P2-T1 with two bodies but no chain test. Add a test case or document chain-handling.

The bigger issue: when C drafts B and B drafts A, B's effective speed bumps up by +0.20 (slipstream-boost). C is now drafting B-at-1.20×, but the velocity-alignment / distance check still uses B's CURRENT velocity (not its non-boosted velocity). C continues to draft B without issue. OK — but the plan should explicitly state "drafting transitive" if that's the intent (it is, by physics). No fix needed beyond a single-line clarification.

### S3 — Slipstream `wasActive` flag is local to a method invocation, fires event multiple times

§2.7:
```ts
const wasActive = self.activeBoosts.has('slipstream-boost');
self.activeBoosts.set('slipstream-boost', { expiresAt: now + 200, ... });
if (!wasActive) { broadcast event.slipstream }
```

Once SLIPSTREAM_REQUIRED_TICKS (45) is reached, the boost is set every tick. `wasActive` is true on all subsequent ticks — broadcasts only fire on the rising edge. ✓

BUT — when the body LEAVES the wake, `expiresAt = now + 200ms` from the last in-wake tick → boost expires ~6 ticks later. If the body re-enters the wake within 200ms (≈6 ticks), `wasActive` is still true, no event fires. If they re-enter AFTER expiry, a new event fires. That's correct but undocumented.

Now consider a slipstream that hits the 200ms ttl at tick T, expires, then on tick T+1 the body is STILL in the wake but `slipstreamConsecutiveTicks` was held at 45+ throughout — `set` runs again with `wasActive = false` → DUPLICATE event. The grace-tick logic (§2.7 `else { grace... }`) only runs in the OFF-path. The IN-PATH always sets+rebroadcasts.

**Fix:** Track a separate `slipstreamEventBroadcastTick` and only broadcast if `state.tick - body.slipstreamEventBroadcastTick > THROTTLE_TICKS` (e.g. 30 ticks = once per second max). Or: tie the `expiresAt` to a longer ttl that's refreshed each tick (e.g. 1000ms) so single-tick expiry doesn't re-trigger.

### S4 — `event.slipstream` doesn't carry `isActive: false` clear signal; client relies on 250ms timeout

§7.3 says client auto-clears `slipstreamActive` after 250ms with no fresh event. But §6.1 says component runs `setInterval(check, 100)` — that's 10 wakeups/sec while in match. Across 8 simultaneous Reef HUDs in spectator mode, that's negligible cost but still adds 80 timer fires/sec. More importantly: a brief network hiccup (>250ms of dropped frames) would clear the flag prematurely even if the player IS still drafting.

**Fix:** Server SHOULD emit a `event.slipstream_end { dstPetId }` once when the body leaves the wake (tracked per-body). Add to §4.1 events. Removes the timer entirely.

### S5 — Hazard hit on shielded body still slows them — plan calls out as design choice but doesn't update Town Guide

§2.10 + P2-T16 + R-row "shield doesn't protect against terrain": this is a non-obvious rule. Players will be surprised when their shield runs out mid-hairpin and they're STILL slowed.

§11 file-scope updates `town-guide.ts` knowledge[] with one paragraph. That paragraph (per §11 row) does NOT mention "shields don't block hazards." Add it to the knowledge entry to satisfy the same-diff doc rule.

**Fix:** Extend the town-guide.ts knowledge entry per CLAUDE.md mandate.

### S6 — Plan adds new `expiresAt` ttls that are very short (200ms = 6 ticks); single dropped tick clears boost

§2.10 hazard: `expiresAt: now + HAZARD_TICK_DURATION_MS = 200ms`. §2.7 slipstream: `expiresAt: now + 200ms`. These are refreshed each tick. But the active-boost sweep (`tickRoom` step 3) runs at the TOP of each tick (`for ... if (entry.expiresAt <= now)`). Between sweep at tick T and refresh at tick T+1 (during step 4 `applyIntentForTick`), the boost can briefly disappear.

Worse: `applyIntentForTick` runs BEFORE the resolveSlipstream/resolveHazards (which are inserted at steps 2.5, 2.7-2.9 per §2.2 — but step 3 is "expire activeBoosts" and the plan §2.2 numbers are confusing). Actual tick order from `tickRoom` (lines 677-748):
0. runBotControllers
1. applyIntentForTick (SPEEDMOD READ HERE)
2. integrateMotion
3. expire activeBoosts ← expiry runs HERE
4. resolveProximity
5. resolvePickups
6. tickPickups
7. resolveCheckpoints

The plan's §2.2 numbering is WRONG vs the source. It says step 1 is applyIntent (correct), step 4 is resolveProximity, but the source says step 4 is resolveProximity at line 717, and step 3 is the sweep. So §2.2 inserts:
- "2.5 resolveSlipstream" ← BEFORE proximity but AFTER integration. The slipstream boost set on tick T's resolveSlipstream WON'T be read by applyIntentForTick until tick T+1. The 200ms ttl is enough (6 ticks) so it'll survive, but the PLAN'S NUMBERING IS NON-STANDARD.

§2.2 also says "Slipstream BEFORE checkpoint resolution because both walk the body list and slipstream needs current positions" — but the plan's resolveProximity runs at 4 (after slipstream), and proximity MOVES bodies (§reef-race-sim.ts:1086-1090). So slipstream in step "2.5" reads PRE-proximity positions, and the speedMod for tick T+1 is applied AFTER proximity has separated bodies. That's actually fine — but the plan's claim "uses current positions" is mildly misleading.

**Fix:** Rewrite §2.2 to reflect actual source step numbering (0-9 from tickRoom). Make insertion points unambiguous.

### S7 — `state.lastPlacementMap` cache invalidation is undefined

§2.6 says "Cache `state.lastPlacementMap` between calls in the same tick. Recompute at most once per `tickRoom`." But the plan never specifies WHERE in `tickRoom` the cache is refreshed. Naive implementation: refresh at tick start. Cost: 8-body sort once per tick = 240/sec. Trivial. But the cache must be invalidated when:
- A body crosses a checkpoint (placements change)
- A body finishes (placements compress)
- A body forfeits (placements compress)

The simplest correct strategy: recompute at the top of `tickRoom` once. Plan doesn't say this.

**Fix:** Add explicit cache refresh point. Recommend: `state.lastPlacementMap = computeLivePlacements(state)` at line 681 of `tickRoom`, just after `state.tick += 1`.

### S8 — `computeLivePlacements` returns wrong value during DNF compression

§2.6 implementation places DNF bodies at end (sort returns -1/+1 for DNF). But for placement purposes, finishers come first (1, 2, 3...), then racers, then DNFers. With 4 racing + 2 finished + 2 DNF = 8 bodies, placements are 1-2 (finishers), 3-6 (racers by progress), 7-8 (DNFers). DNFers all get unique placements (7, 8) but they're tied — they didn't finish. UX-wise, putting them at "8th of 8" is OK; the placement-weighted item table for DNFers won't be queried (they're DNF, can't collect). But §2.5 still calls `computeLivePlacements` for the WORLD pickup roll, which is body-agnostic; only the COLLECT roll is body-aware. So DNF placement is harmless.

**Severity:** Low. Document it.

### S9 — `apex-penalty` and `apex-bonus` use the same `key = ${lap}:${hairpinIndex}` short-circuit

§2.9: a body driving fast through both rings IN THE SAME TICK could only fire ONE verdict (the inner check is checked first; outer check is `else if`, but the `apexCheckedThisLap.has(key)` early-out short-circuits the second iteration of the `for (const zone of state.apexZones)` loop). Since the rings DON'T overlap (centers 165wu apart, radii 44wu, gap 165 - 88 = 77wu of clear track between them), a body can't be in both at once. ✓

But: a body crossing the OUTER ring first, then the INNER ring later in the same lap, would only get the penalty. The bonus would never fire because the per-key set already has the entry. With the racing line being centerline → inside, a player going wide first then re-cornering tightly should get... only the penalty? That's actually intentional ("you blew the corner, no bonus this lap"). But it would be jarring for a player who recovers a missed line and clips inside. Either way, document. P2-T7 + P2-T9 don't test this case.

**Severity:** Low/UX. Add test or flag in plan.

### S10 — Bot's `getOwnPlacement` will run on EVERY computeInput tick

§8.2: `getOwnPlacement(view)` is called inside the powerup-fire branch. This walks `view.bodies` once. With 8 bots × 30 ticks/sec = 240 placement computations/sec, each O(N log N). Trivial cost, but redundant with the sim's `state.lastPlacementMap` (which the bot can't access through the view).

**Fix (optional optimization):** Add `placement?: number` to `BotRoomView` populated by `buildBotRoomView` from the cached `state.lastPlacementMap`. Eliminates 240 redundant sorts/sec.

### S11 — Phase 2 widens `isPositiveBoostActive` gate but keeps cap at 1.85× — boundary not exercised

§2.4 widens the gate. Good. But the comment claims "no headroom needed beyond the existing margin." The validator tolerance is 2.0× = 1000 wu/s. The gate fires at speed > 925 wu/s (1.85× × 500). Between ticks, integration over 33ms at acceleration `REEF_MAX_ACCEL = 2000 wu/s²` adds 66 wu/s — so a body at 925 wu/s could spike to 991 wu/s mid-tick, still under the validator's 1000 wu/s. But what about NEGATIVE velocity damping? The drag (`REEF_DRAG = 0.97` per tick) takes 925 → 897.25, under cap. No issue. P2-T27 only checks the steady-state cap, not the transient overshoot.

**Severity:** Low. Add transient overshoot to P2-T27 or document the analysis.

### S12 — Inventory broadcast already broken in Phase 1; Phase 2's "rarity tier hint" tile is built on shaky ground

§6.3 adds a tier-hint icon to `<PlacementTile>` based on `placement`. Self-contained — fine. BUT, the broader assumption that the HUD's `powerUpInventory` reflects the ACTUAL slots requires the inventory broadcast path to work. Verifying §11's claim "old clients silently drop the new placement field" is fine, but the plan assumes the existing inventory channel is functional — and it ISN'T for Reef Race today (see C2). Phase 2 should call out that pre-existing bug and either fix it or document it as out-of-scope.

**Severity:** High. Fix the inventory channel as part of C2's resolution, or add explicit out-of-scope statement.

### S13 — Ribbon at `t=0.96`/`t=0.04` straddles the start/finish line

§1.5 places "rib-top" centerline segment from `reefCenterlineAt(0.96)` to `reefCenterlineAt(0.04)` — wrapping around `t=0`. Two issues:
1. `reefCenterlineAt(0.96)` and `reefCenterlineAt(0.04)` are NOT colinear with the straight ahead — the centerline is curving here. The "straight" between t=0.96 and t=0.04 cuts a chord across the start/finish, not a tangent line. Bodies driving the centerline will pass NEAR but not THROUGH the chord midpoint. `RIBBON_HALF_WIDTH = 35wu` should still catch them but barely.
2. The start/finish line IS at t=0 (checkpoint 0). Crossing the ribbon = crossing the start/finish on the same tick = lap completion + ribbon collection same tick. The plan says (§2.2) "ribbons/apex/hazard AFTER pickups, BEFORE checkpoints" — so ribbon fires first, then lap-up clears `ribbonsCollectedThisLap`. The ribbon entry just added is wiped on the same tick. Player loses the boost they just earned.

**Fix:** EITHER (a) move "rib-top" to a clearly-on-straight section (e.g. `t=[0.92, 0.04]` to bias backward, or split into two ribbons one per side), OR (b) lap-up cleanup uses `body.lap` BEFORE the increment as the key (i.e. preserves the just-collected ribbon for the just-finished lap), OR (c) accept that ribbon-top is effectively a per-RACE pickup not per-LAP. Plan's choice unclear.

### S14 — Ribbon cooldown semantics conflict with lap-up clear

§1.5: `RIBBON_COLLECTION_COOLDOWN_MS = 5000`. Per-ribbon cross-lap cooldown. §2.11: lap-up clears `ribbonsCollectedThisLap`. So:
- Lap 1 t=10s: collect ribbon → `ribbonLastCollectedAt[id] = 10`, set added.
- Lap 1 t=12s: try collect → rejected (in lap-set).
- Lap 2 t=14s (lap-up at 13s clears set): try collect → cooldown rejects (10+5=15 > 14).
- Lap 2 t=16s: collect → succeeds.

Plan-correct, but the cooldown effectively makes ribbons collectible AT MOST every 5s. With a 36s lap + 2 ribbons spaced ~half-lap apart, players hit each ribbon ~once per lap anyway. Cooldown is mostly redundant unless someone reverses on the track (which isn't possible in the sim). Recommend dropping the cooldown to simplify, or document the redundancy.

**Severity:** Low. Simplification opportunity.

### S15 — Slipstream `MIN_VEL_ALIGNMENT = 0.5` (≈60° spread) seems generous

§1.3: 0.5 dot product = 60° between velocities. Two bodies turning a hairpin from opposite ends could be at 60° momentarily and trigger draft charge. Phase 1's checkpoint AABBs prevent reverse-direction crossings, so opposite-direction bodies don't really happen except mid-pile-up. But during a hairpin both racers might be at +X-ish vs -X-ish briefly. Tighter (0.7 = ~45°) reduces false positives. But with the 1.5s charge window, even 60° false positives rarely accumulate to a boost.

**Severity:** Low/tuning. Telemetry-driven re-tune.

### S16 — Brand alignment / Town Guide knowledge update underweighted

§11 row for `town-guide.ts`: "+5 lines" and a single paragraph. But CLAUDE.md mandates that knowledge updates explain the FOUR axis priorities. Phase 2 doesn't change the brand axes — it's pure gameplay polish. The knowledge entry should be brief and factual (which the plan's draft achieves), but it should also mention "this is gameplay depth in the gamified UI surface (priority #4)" — or the rule says to focus on user-facing orientation only, which it is. Acceptable as-is.

**Severity:** None. Sanity-check the knowledge entry in PR.

---

## Minor issues / nits

### N1 — `KINEMATIC_BOOST_FLOOR` defined twice in §1 (1.2 and 1.8)

§1.2 mentions "The floor mirrors the existing ink-slick clamp" but the constant itself is defined in §1.8. Confusing organization. Move both `CAP` and `FLOOR` to §1.2.

### N2 — Plan refers to "activity-frames.ts" (high-level plan), §0 already corrects this

§0's table correctly notes that `protocol.ts` is the actual file. But the high-level plan `reef-race-real-racing.md:108` still references `packages/shared/src/types/activity-frames.ts`. That's outside Phase 2's diff scope but the doc should be updated as part of the same-diff requirement (high-level plan is also a doc).

**Severity:** Minor. Add to file-scope table.

### N3 — Plan doesn't specify how `state.ribbons` `state.apexZones` `state.hazards` are initialised on snapshot loading from a remote sim

Phase 2 ships the data via `RoomMeta.reefStaticZones` — but the SERVER also keeps these on `state` (§3.1). They're built at `startRoom`, fine. But the snapshot is stateless across server restarts (rooms are in-memory). If a room mid-race is migrated (currently impossible — Hetzner single instance — but in future), the static zones would need recomputing. Not a Phase 2 bug, but the plan's separation between "client-rendered from RoomMeta" and "server-runtime from state.ribbons" duplicates the data without a single source. Build them ONCE at startRoom from the same builder, then memo-cache.

### N4 — `getStaticZones(roomId)` is a new sim accessor (§4.2) but not in the §11 file-scope table

§4.2 says "see §10". §10 has no §10. There's a §11 file-scope. The §11 entry for `reef-race-sim.ts` says "+ `getStaticZones`" — found. But the plan's references to "§10" are dangling/dead links. Cleanup.

### N5 — `SLIPSTREAM_GRACE_TICKS = 6` is referenced but the `else { grace... }` branch in §2.7 never sets the boost during grace

§2.7's `else` branch decrements `slipstreamGraceTicksLeft` but does NOT call `body.activeBoosts.set('slipstream-boost', ...)` to extend the boost during grace. So during grace, `expiresAt` is from the last in-wake tick (ttl 200ms = 6 ticks). The grace ticks (6) and the ttl (6) align, so the boost naturally expires when grace runs out. ✓ But the grace counter is redundant with the ttl. Either simplify (remove grace counter, rely on ttl) or use grace to EXTEND the ttl. Pick one.

### N6 — `ReefBoostKind` extension expands the union from 3 to 8 kinds

§1.1: union grows from 3 → 8. Phase 1 audit C2 explicitly noted "boost kinds are SEPARATE from `ReefPowerUpKind`." Phase 2 honors that — but `apex-penalty` and `hazard-slow` are NOT BOOSTS (they're slows). The union name "ReefBoostKind" becomes misleading. Plan acknowledges this in §1.1 footer ("the name `boost` is an artifact"). Fine, but a Phase 3 cleanup ticket (rename to `ReefKineticEffectKind`) should be tracked.

### N7 — TorusKnot for hazard placeholder is heavy

§5.2: `TorusKnotGeometry(radius=hazard.radius=55, tube=4, tubularSegments=24, radialSegments=4)` has 24×4 = 96 vertices × 6 indices = 576 indices. With 2 hazards = 1152 indices. Cheap. But `MeshStandardMaterial` with emissive on Iris Xe is a known performance hit if the hazard is in the camera frustum + close. Consider `MeshBasicMaterial` with vertex-color emission, or pre-baked emissive map.

3da concern, not orchestrator. Flag in 3da spawn.

### N8 — Missing: how is `placement` initialised in `state.lastPlacementMap` when the race transitions from countdown to live?

At countdown, no body has crossed any checkpoint yet — they're all at lap=0, nextCheckpoint=1, progress=0. `computeLivePlacements` sorts by progress descending — TIES. The sort is non-stable in some environments, so placement assignment is arbitrary 1..8 among tied bodies.

**Fix:** Tie-break by petId or registration order. Otherwise deterministic-test mode bots could see different placement outcomes per run.

### N9 — `applyEntityDelta` first-insert branch needs a `placement` source

(See C7 above; reclassified as N because it's not actually broken.)

### N10 — `event.ribbon_collected` is fired even for the same body's same lap, gated only by `ribbonsCollectedThisLap.has(key)`

But P2-T13 covers this. ✓ No fix.

### N11 — Plan claims `R12` (curved approach) tested by P2-T11/T13 but those tests plant the body AT THE MIDPOINT, not at a slight angle

P2-T11/T13 don't test the curved-approach edge case. Add P2-T35 or extend P2-T11.

### N12 — `BOT_OPENING_GRACE_MS = 2500` is unchanged in the bot, but new draft/apex/hazard heuristics fire WITHOUT a grace check

§8.2 inserts logic "after the launch + drift logic, before the final thrust calculation." The plan doesn't explicitly add `if (matchAge < BOT_OPENING_GRACE_MS) skip new heuristics`. So bots will draft + apex + dodge from t=0. Possible regression — the grace exists so humans get a head-start. New heuristics should also gate on grace.

**Fix:** Add `inGrace` short-circuit before each new heuristic block in §8.2.

### N13 — `event.apex_bonus` and `event.hazard_hit` test coverage skips the SHIELD interaction

P2-T16 covers shield + hazard. But what about shield + apex? Apex is purely positional, not an attack — shield should NOT block. Not tested. Add a single-line test.

### N14 — Slipstream boost grants a +20% top-speed but combined with ribbon (+30%) + drift-3 (+0.38) = +0.88 → capped at 0.85, the EXTRA +0.03 on top of the 0.85 is absorbed by the cap

That's the design. But P2-T27 doesn't break out the contributions — it tests the combined cap. A single-line test "given (slipstream + ribbon + drift-3) the kineticMult equals KINEMATIC_BOOST_CAP and not 0.88" is missing.

### N15 — Test count is 34, plan says 34, count is correct (T1-T29 sim + T30-T34 bot = 5 bot + 29 sim = 34) ✓

### N16 — Plan's `import 'three/webgpu'` ban (§13) is correctly enforced but no auto-check

The plan's §14 "audit checklist" includes "no new file imports `three/webgpu`" — but no test enforces this. Add a Phase-2-specific lint rule or test.

---

## Test gaps

### G1 — Missing: slipstream chain (3 bodies)

No test for A→B→C chain drafting. P2-T1 only covers 2 bodies.

### G2 — Missing: leader elimination mid-draft

If the leader is forfeited mid-draft, the drafter's `slipstreamSourcePetId` points to a body that's no longer in `state.bodies` (or is `forfeited=true` and skipped). §2.7 filters `for (const target of bodies)` to alive+not-forfeited+not-dnf+not-finished, so the source is removed from `bodies` immediately. The drafter's `slipstreamSourcePetId` becomes stale. Next iteration: no `bestSrc` found → grace → clear. Behavior is correct but UNTESTED.

### G3 — Missing: ribbon collection on the SAME TICK as a checkpoint cross

S13 raises this. Add P2-T36: "ribbon at start/finish + lap-up cleanup interaction."

### G4 — Missing: hazard during a stall

What does drift-cancel-on-hazard look like? The plan §2.12 says "Hazard | subtractive | applied always (negative) | applied on top of stall." But: a body in stall at speed 150 wu/s clips a hazard. `speedMod` is 0.5 (stall override). `effectiveThrust = min(thrust, 0.30)`. The hazard's negative kineticMult is computed per the plan but `if (stalled) speedMod = 0.5` short-circuits ALL the kineticMult math. So hazard during stall is a NO-OP. Plan §2.12 row is wrong: hazard is NOT applied "on top of stall" — it's IGNORED during stall.

**Fix:** Update §2.12 row + add P2-T37 to test.

### G5 — Missing: `placement` propagation when body just FINISHED

P2-T22 covers `computeLivePlacements` ordering. But the broadcast: when a body crosses lap 3 → finishes on tick T, on tick T+1 the placement map ranks finishers first. Self HUD's placement should jump to "1st" (or wherever finish-order placed them). Add P2-T38.

### G6 — Missing: ribbon collected during ink-slick

Slicked body at `speedMod = 0.5` collects ribbon → boost set. Next tick slicked still active → speedMod = 0.5 (override). Ribbon boost has NO EFFECT until slick expires. Test that the ribbon boost SURVIVES the slick (entry stays in activeBoosts) and applies once slick clears. Add P2-T39.

### G7 — Missing: bot drafting AGAINST a human (mixed roster)

P2-T30 tests bot drafting another bot. The view doesn't distinguish bot vs human. Should be identical, but flag as untested.

### G8 — Missing: `KINEMATIC_BOOST_CAP` test under negative arithmetic (C4/C5)

P2-T27 plants only POSITIVE boosts. P2-T28 plants only NEGATIVE. NO test combines positive (turbo or drift) with negative (hazard) — exactly the case where C4/C5 expose the bug. Add P2-T40: "drift-3 + hazard → speedMod is NOT 1.0; it's 0.98."

### G9 — Missing: snapshot bandwidth regression (P2-T34) baseline isn't captured pre-merge

P2-T34 says "Compare to a baseline (Phase 1 expected size, captured pre-merge)." But the plan doesn't specify where the baseline is captured or how the test reads it. Add: capture baseline in a fixture file `apps/api/.../__tests__/fixtures/phase1-snapshot-bytes.json` checked in BEFORE Phase 2 implementation.

---

## Implementation order recommendation

The plan's §12 has 12 steps; reasonable. Concerns:

1. **Step 4 is too large.** It bundles ReefBody fields + RoomState fields + startRoom builder + body init + cap math + integrateMotion gate widening + 6 new private methods + tick pipeline insertion + checkpoint lap-up cleanup + buildSnapshot + broadcastDelta predicate. That's ~10 separate concerns in one step. Recommend splitting:
   - **Step 4a**: ReefBody/RoomState shape + startRoom builder + body init (no behavior). Tests should NOT regress.
   - **Step 4b**: speedMod cap/floor arithmetic (`applyIntentForTick`) + integrateMotion gate widening. No new mechanics yet (zones don't exist on bodies). Tests pass.
   - **Step 4c**: `resolveSlipstream` only. Add P2-T1..T5 (slipstream tests).
   - **Step 4d**: `resolveBoostRibbons` + `buildReefBoostRibbons`. Add P2-T11..T14.
   - **Step 4e**: `resolveApex` + `resolveHazards` + `buildReefApexZones` + `buildReefHazardPatches`. Add P2-T6..T10 + T15..T18.
   - **Step 4f**: `computeLivePlacements` + `rollPowerUpKindForPlacement` + tickPickups/resolvePickups changes + buildSnapshot/broadcastDelta placement. Add P2-T19..T26.

   Each sub-step is independently revertable. A single PR per sub-step lets git bisect identify which mechanic causes a regression.

2. **Step 6 ("flip broadcast emissions ON")** is unnecessary. The "if (false)" guard in step 4 is a code smell. Either ship the events from the start (Phase 1 used the same pattern — events first, client handlers next) OR don't emit until the client handler exists. Simpler: order steps as 4 (server full) → 7 (sendInit static zones) → 2 (client handlers) → 4-tests → flip nothing.

3. **Step 8 (bot heuristics)** should come AFTER step 5 (sim tests pass) but BEFORE step 9 (bot tests). The plan has 8 → 9. ✓ But step 8 also needs the buildBotRoomView extension (per C1) — that's a server-sim change in step 4.

**Recommended split into PRs (maps to commits in one branch, but reviewable as discrete units):**

| PR | Scope | Revert-safe |
|---|---|---|
| #1 | protocol.ts + activity.ts (4 case branches no-op + state fields + placement hoist) | Yes — server doesn't emit yet |
| #2 | reef-race-config.ts constants + types + builders | Yes — never imported until #3 |
| #3 | reef-race-sim.ts: ReefBody/RoomState shape, startRoom builder, body init, cap/floor math, integrateMotion gate widening | Yes — no new mechanics yet |
| #4 | resolveSlipstream + tests T1-T5 | Yes — slipstream OFF without it |
| #5 | resolveBoostRibbons + buildReefBoostRibbons + sendInit ribbon zones + tests T11-T14 | Yes |
| #6 | resolveApex + resolveHazards + buildReefApexZones + buildReefHazardPatches + sendInit zones + tests T6-T10 + T15-T18 | Yes |
| #7 | computeLivePlacements + PLACEMENT_ITEM_TABLE + tickPickups/resolvePickups + EntityDelta placement + tests T19-T26 | Yes |
| #8 | bot heuristics (draft + apex + hazard + placement-fire) + buildBotRoomView extension + tests T30-T33 | Yes |
| #9 | HUD components + 3D scene components + 3da review | Yes — server unchanged |
| #10 | Docs (3dStructure.md + GameFeatures.md + town-guide.ts knowledge[]) | Always |

10 PRs is too many for one release. Practical compromise: bundle into **3 PRs** — sim mechanics (#1-7), bots (#8), client (#9-10). Bisect-friendly within each via clean commits.

---

## Brand alignment honest verdict

Per CLAUDE.md "TOP PROJECT PRIORITIES":

1. **Ship to Milady AI app store** — Phase 2 is a Reef Race depth play, NOT a Milady integration. Neutral.
2. **Open agent onboarding** — Phase 2 doesn't change `/api/agent/connect` or SKILL.md surfaces. Neutral.
3. **Free agent leaderboard** — Reef Race participation already feeds leaderboard via `agent.collaboration.turn`-style events. Phase 2 may add `event.ribbon_collected` / `event.apex_bonus` — these are NOT in leaderboard weights and shouldn't be (they're per-tick, would inflate). Plan correctly avoids this. ✓
4. **Gamified UI + free promotion + unified leaderboard** — Phase 2 directly serves #4: deeper gameplay, more skill expression, retention signal. ✓

Net: Phase 2 helps #4, neutral on #1-3. **No priority-tradeoff PR-rejection trigger.** Proceed once critical issues fixed.

**Honest skill-ceiling verdict:**
- **Slipstream** is invisible to the leader. The drafter sees the +20% — but how do they LEARN to draft? §10.1 says "the trailing player will SEE they're in the wake via the new event.slipstream toast." A 1-bit toast is not a tutorial. 60% of players will never realize drafting exists. Recommend: add a brief "DRAFT HOLD" hint when player is BEHIND a leader at ≥30wu but <70wu and not yet drafting. Telemetry-gateable.
- **Apex bonuses** are SMALL (+5%/-5%). With drift-3 at +38%, the apex is dwarfed. Players will not notice the difference between bonus and penalty in heat-of-the-moment play. Recommend bumping to +/-0.10 or making the penalty more brutal to teach the racing line.
- **Boost ribbons** at +30% / 2s are SUBSTANTIAL. Visible and learnable. ✓
- **Hazards** at -40% are SUBSTANTIAL. Visible. ✓ But the design "shortcut tradeoff" (drift-3 + hazard ≈ neutral) requires the math fix in C4/C5 — as drafted, hazards are actually irrelevant whenever a player has any pickup boost.
- **Placement-weighted items** add real rubber-band depth. ✓

**Average user FELT difference:** Ribbons and hazards yes. Apex + slipstream — borderline; needs telemetry to validate. Recommend: ship Phase 2 as drafted (with critical fixes), measure 1-week retention, then decide whether to amplify apex/slipstream signal in Phase 2.5.

---

## Overall verdict

**NEEDS REVISION before implementation.**

Critical issues C1-C6 are real bugs in the spec — they will produce a non-functional or silently broken implementation:

- **C1**: Bot can't compute placement → bot heuristics fail.
- **C2**: Inventory broadcast is broken in current Reef sim → "spawn vs collect kind" split ships a stealth-swap UX bug.
- **C3**: `lastSlipstreamEventAt` referenced but not declared → build break or non-functional auto-clear.
- **C4 + C5**: speedMod arithmetic in §2.3 doesn't produce the property-bullet outcomes. Hazard slow gets erased by ANY positive boost (turbo OR drift). Plan-promised "shortcut tradeoff" doesn't exist.
- **C6**: `KINEMATIC_BOOST_FLOOR` semantically misleading.

These are FIXABLE in plan revision (no scope cuts needed). Once the speedMod math is reformulated (C4/C5 — combine `pickupMult` with `negativeKinetic` separately from `kineticMult`-vs-`pickupMult` MAX), the plan is sound.

Significant issues S1-S16 should be addressed in plan revision OR explicitly deferred with justification.

Implementation order should split Step 4 into 4a-4f for bisect safety.

**Recommended next action:** Reject for revision. After revision, re-audit only the specific changes (C1-C6 fixes + revised §2.3 arithmetic + extended §11 file-scope including `buildBotRoomView`). Do not proceed to implementation until §2.3 arithmetic produces the §2.3 property-bullet outcomes.

---

## Audit summary

| Severity | Count |
|---|---|
| Critical | 6 (C1-C6, plus C7 reclassified, C8 flagged) — **8 raised, 6 must-fix** |
| Significant | 16 (S1-S16) |
| Minor / nits | 16 (N1-N16) |
| Test gaps | 9 (G1-G9) |

**Lines of plan reviewed:** 1714
**Source files cross-checked:** `reef-race-sim.ts` (1621 lines), `reef-race-config.ts` (380 lines), `reef-race-bot.ts` (~250 lines), `protocol.ts`, `activity.ts` (web store), `activity-ws-hub.ts`, `bumper-shells-sim.ts` (for inventory comparison).

**Verdict:** NEEDS REVISION.
