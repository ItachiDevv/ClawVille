# Phase 2 Implementation Audit

**Plan v2:** `.claude/plans/reef-race-phase2-detailed.md` (SHA `6b0eb9d`, 2087 lines)
**Plan v1 audit:** `.claude/plans/reef-race-phase2-audit.md` (SHA `8767545`)
**Implementation commits:** `d2ee725` (3da: §5-6 visuals) + `0eb3d0f` (general: §1-4,7-9)
**Diff range:** `f4d276e..0eb3d0f` (3,381 insertions, 51 deletions, 17 files)
**Auditor:** Orchestrator (red-team, second pass)
**Date:** 2026-04-25
**Branch:** `worktree-fix-bumper-build`
**Mode:** Find issues — not implementing.

---

## 1. Phase 1 anchors (11 checks)

All citations against current `apps/api/src/services/activity/sim/reef-race-sim.ts` post-Phase-2.

| Anchor | Description | Status | Citation |
|---|---|---|---|
| C1 | drift bias inside `Math.atan2` in `applyIntentForTick` step 6 | ✅ INTACT | reef-race-sim.ts:974-982 — `body.rot = baseRot + turnSign * DRIFT_ANGULAR_BIAS_RAD` (drift bias added to atan2 result, not accumulated). |
| C2 | drift / launch / slipstream / ribbon / apex / hazard ALL write to `activeBoosts: Map<ReefBoostKind, ...>`, never to `activeEffects` | ✅ INTACT | resolveSlipstream:1924, resolveBoostRibbons:1994, resolveApex:2033/2048, resolveHazards:2090 — all `body.activeBoosts.set(...)`. `activeEffects` only used for power-up pickups (rr-ink-slick / rr-turbo-bubble). reef-race-sim.ts:208 splits the maps. |
| C3 | `REEF_KINEMATIC_TOLERANCE = 2.0` named at both validator call-sites | ✅ INTACT | reef-race-sim.ts:1199 + 1212 — both `validateReefVelocityDelta` and `validateReefPositionDelta` call-sites pass the named constant. |
| C4 | launch boost data path through room manager intact | ✅ INTACT | reef-race-sim.ts:474-484 — `opts?.launchBoosts?.get(petId)` seeds `activeBoosts.set('launch-boost', {expiresAt: startedAt + LAUNCH_BOOST_DURATION_MS, mult: LAUNCH_BOOST_MULT})` at startRoom; expiry timed from green light. |
| C5 | bot launch early-return BEFORE grace branch intact | ✅ INTACT | reef-race-bot.ts:130-159 — launch attempt block runs before the `inGrace` calculation at line 222 and bypasses the `thrust: inGrace ? 0.4 : thrust` final return. |
| C6 | drift cancels only on speed/release — Phase 2 didn't add collision cancel | ✅ INTACT | reef-race-sim.ts:1036 — `const shouldCancel = !driftBit \|\| !fastEnough` (the only two cancel paths). resolveProximity (line 1247-1270) does not modify `body.drift.charging` or trigger drift-cancel. |
| S5 | hard cap inside `if (boost active)` only — extended to "any positive boost active" | ✅ INTACT + WIDENED | reef-race-sim.ts:1231-1244 — `isPositiveBoostActive` enumerates all 5 positive kinds. Cap value unchanged at `REEF_MAX_SPEED * 1.85 = 925 wu/s`. Non-boosted bodies never clamped. |
| S4 (P1) | drift fires speedMod-only — no velocity impulse | ✅ INTACT | reef-race-sim.ts:1042-1048 — drift release sets `activeBoosts.set('drift-boost', ...)` only; no `body.vx +=` or `body.vy +=` in the cancel branch. |
| S6 (P1) | abort buffer cleanup runs at startRoom transition | ✅ NOT TOUCHED | Phase 2 doesn't modify the launch verdict / preLaunchBuffer path. |
| S10 (P1) | `startedAt` set in `startRoom` for relative time math | ✅ INTACT | reef-race-sim.ts:427 — `startedAt` populated; passed to body init for `lapStartedAt`. |
| S11 (P1) | first-sighting `driftSparks` init in `applyEntityDelta` | ✅ INTACT | apps/web/src/stores/activity.ts:323-326 — first-insert branch initialises `driftSparks: typeof c.driftSparks === 'number' ? ... : 0`. |

**All 11 Phase 1 anchors survived Phase 2 intact.**

---

## 2. Phase 2 plan v2 anchors (4 checks)

| Anchor | Description | Status | Citation |
|---|---|---|---|
| Combined-boost arithmetic | 4-stage pipeline: positiveStack capped at +0.85, pickup competes via `Math.max` with positive slot, negativeStack floored at -0.50, kineticDelta = effectivePositive + negativeStack | ✅ INTACT | reef-race-sim.ts:920-965 — exact 4-stage form per plan §2.3. Constants pulled from config (line 94-95). |
| C1 plan-v2 fix | `BotRoomView` extended with `lap`, `nextCheckpoint`, `currentPlacement`, `finishedAt`, `dnf` per body | ✅ INTACT | reef-race-sim.ts:1138-1142 (return-shape declaration) + 1166-1170 (population from state.lastPlacementMap). reef-race-bot.ts:67-72 type usage. |
| C2 plan-v2 fix | `event.power_up_collected.kind` field carries placement-rolled kind | ⚠️ PARTIAL | Server emits `kind: finalKind` unconditionally (reef-race-sim.ts:1305-1310). Protocol declares `kind?: string` as OPTIONAL (protocol.ts:267). Client guards `typeof frame.kind === 'string'` (activity.ts:764). The optionality is semantically correct (Phase 1 servers may omit) but the type signature fails to enforce kind validity — `string` not `ReefPowerUpKind` — so any rogue string would slip through. |
| N12 plan-v2 fix | bot heuristics gated by `BOT_OPENING_GRACE_MS` | ✅ INTACT | reef-race-bot.ts:222 (`inGrace` flag), 225 (draft), 248 (apex), 280 (hazard), 305 (powerup-fire) — all four blocks gated. P2-T33 + P2-T34 cover the regression fence. |

---

## 3. Speed-mod arithmetic verification (manual trace)

Source: `applyIntentForTick` step 4, lines 920-965. Constants: LAUNCH_BOOST_MULT=0.30, DRIFT_BOOST_MULTS[2]=0.38, SLIPSTREAM_BOOST_MULT=0.20, RIBBON_BOOST_MULT=0.30, APEX_BONUS_MULT=0.05, REEF_BOOST_MULT-1.0=0.40, HAZARD_SLOW_MULT=-0.40, KINEMATIC_BOOST_CAP=0.85, NEGATIVE_KINETIC_FLOOR=-0.50.

| # | Scenario | positiveStack (raw → capped) | pickupAdd | effectivePositive | negativeStack | kineticDelta | speedMod | Expected | Result |
|---|---|---|---|---|---|---|---|---|---|
| 1 | drift-3 alone | 0.38 → 0.38 | 0 | 0.38 | 0 | +0.38 | **1.38** | 1.38 | ✅ PASS |
| 2 | drift-3 + hazard | 0.38 → 0.38 | 0 | 0.38 | -0.40 | -0.02 | **0.98** | 0.98 | ✅ PASS |
| 3 | drift-3 + hazard + turbo | 0.38 → 0.38 | 0.40 | 0.40 | -0.40 | 0.00 | **1.00** | 1.00 | ✅ PASS |
| 4 | hazard alone | 0 → 0 | 0 | 0 | -0.40 | -0.40 | **0.60** | 0.60 | ✅ PASS |
| 5 | drift-3 + launch + slip + ribbon (all positives) | 1.18 → 0.85 (cap) | 0 | 0.85 | 0 | +0.85 | **1.85** | 1.85 | ✅ PASS |
| 6 | drift-3 + launch + slip + ribbon + hazard (mixed) | 1.18 → 0.85 (cap) | 0 | 0.85 | -0.40 | +0.45 | **1.45** | 1.45 | ✅ PASS |

**6/6 PASS.** v2 fix for audit C4/C5 (positives no longer silently erased by negatives) is correctly implemented in code.

⚠️ **Test bounds for P2-T40 are LOOSE** (significant): `expect(speedNoTurbo).toBeLessThan(REEF_MAX_SPEED * 1.05)` (i.e. < 525 wu/s). Asymptote for drift-3+hazard at 0.98× = ~490 wu/s. With v1 BUG (hazard erased) it'd be 500 wu/s. Both pass. The test does NOT actually catch the C5 regression. Tighten to `< REEF_MAX_SPEED * 1.0` (must be strictly slower than baseline). reef-race-sim.test.ts:1601.

---

## 4. Behavioural path traces

### 4.1 Slipstream (P2-T1, P2-T36, P2-T37)

- **End-to-end (A in front, B 50wu behind, both +Y at 300 wu/s):** at tick T, resolveSlipstream computes `dx=0, dy=50, distSq=2500` (within `[33²=1089, 50²=2500]`). target tSpeed = 300 ≥ 150 (REEF_MAX_SPEED * 0.30). dot = (0*0 + 50*300)/300 = 50 > 0 (B is behind). perpMag = |0*300 - 50*0|/300 = 0 ≤ 33. self sSpeed = 300; align = (0*0 + 300*300)/(300*300) = 1.0 ≥ 0.5. bestSrc=A. `slipstreamConsecutiveTicks` increments each tick. After SLIPSTREAM_REQUIRED_TICKS=45, `activeBoosts.set('slipstream-boost', {expiresAt: now+250, mult: 0.20})`. Edge-trigger: `event.slipstream` broadcast once. ✅ Verified by P2-T1 (uses 1.5s real-time = 45 ticks).

- **Chain check (A→B→C):** P2-T36 plants three bodies. C closer to B than to A → C drafts B (closest valid target rule line 1907). Both B and C accumulate ticks in parallel. Each fires `event.slipstream` exactly once on rising edge. ✅ test asserts `slipEvts.length === 2`.

- **Leader elimination:** P2-T37 sets `A.forfeited = true` after B has the boost. resolveSlipstream filters bodies list (line 1873-1877) — A no longer in `bodies`. B's bestSrc → null. Grace branch decrements counter; at counter=0, `event.slipstream_end` broadcast + `slipstreamSourcePetId = null` + `activeBoosts.delete('slipstream-boost')`. ✅

### 4.2 Apex / hazard / ribbon detection

| Mechanic | Tick step | Geometry | Event | activeBoosts write | Test |
|---|---|---|---|---|---|
| Slipstream | 3a (after sweep, before proximity) | per-body O(N²) cone check | `event.slipstream` / `event.slipstream_end` (edge-triggered) | `slipstream-boost` mult 0.20 | P2-T1..T5 + T36 + T37 |
| Boost ribbon | 5a (after pickups, before checkpoints) | segment-distance test (project body onto a→b segment, perpDist ≤ 35wu) — `isOnRibbon()` line 2209 | `event.ribbon_collected` (edge-triggered, 1× per lap per ribbon) | `ribbon-boost` mult 0.30 | P2-T11..T14 + T38 + T42 |
| Apex verdict | 5b (after ribbons) | dual-disc check vs `innerCenter` and `outerCenter` (line 2024-2058) | `event.apex_verdict` (kind: 'clean' \| 'wide', edge-triggered per (lap, hairpinIndex)) | `apex-bonus` mult 0.05 OR `apex-penalty` mult -0.05 | P2-T6..T10 |
| Hazard | 5c (after apex) | center-overlap circle test (line 2080-2087) | `event.hazard_hit` (edge-triggered per (lap, hazardId)) | `hazard-slow` mult -0.40, refreshed every overlap tick (200ms ttl) | P2-T15..T18 + T39 + T40 |

**Geometry correctness:** All 4 use `state.checkpoints[idx].center + normal * OFFSET` derived from the elliptical track (`buildReefCheckpoints` from PR #60). `APEX_HAIRPIN_CHECKPOINT_INDICES = [3, 9]` matches t=0.25 and t=0.75 hairpin polls. Ribbon t-values `0.92, 0.98, 0.46, 0.54` are all on the long-straight portions. ✅

### 4.3 Placement-weighted item roll

- `computeLivePlacements` called ONCE per tick at top of `tickRoom` step 0a (line 787). Cached on `state.lastPlacementMap`. ✅
- **Cache invalidation:** the cache is RECOMPUTED every tick — there's no "stale" path. P2-T41 verifies the cache reflects `body.finishedAt` immediately. ✅
- **`event.power_up_collected.kind` reflects placement-rolled kind:** reef-race-sim.ts:1288-1310 — `collectorPlacement = state.lastPlacementMap.get(body.petId) ?? null`; `finalKind = rollPowerUpKindForPlacement(state, collectorPlacement)`; `body.inventory[slot] = { kind: finalKind, ... }`; broadcast carries `kind: finalKind`. ✅
- **HUD inventory update:** activity.ts:761-771 — guarded by `typeof frame.kind === 'string'`, finds first `null` slot, writes `{ kind: frame.kind, charges: 1 }`. ⚠️ See §6 below — inventory channel for SELF still broken (ack out-of-scope).

### 4.4 Bot heuristics

| Heuristic | Detection | Engagement | Grace-gated |
|---|---|---|---|
| Drafts behind leader | `pickDraftTarget`: nearest body within 75wu (SLIPSTREAM_MAX_DISTANCE * 1.5), within ±30° of self heading (cos ≥ 0.866). reef-race-bot.ts:364-399 | Bias dir 25% toward target's position over checkpoint dir (line 235-239) | ✅ line 225 |
| Clips hairpin inside | `isHairpinTarget = APEX_HAIRPIN_CHECKPOINT_INDICES.includes(targetIndex)` (line 244-247) | 70% chance to switch lineMode='inside'; bias dir 30% toward `cp.center + normal * APEX_INSIDE_OFFSET` (line 256-262) | ✅ line 248 |
| Steers through ribbons | NOT IMPLEMENTED — plan §8.2 specifies "When the next-checkpoint t-value is near a ribbon's midpoint... nudge dir toward the ribbon's centerline." Implementation skipped this entirely. | N/A — bots will hit ribbons only by accident (centerline-following). | N/A — N/A |
| Avoids hazards | Approximates hazard center as `cp.center + normal * APEX_INSIDE_OFFSET * 0.73` for hairpin targets (line 281-282); doesn't read actual hazards from view (server doesn't project them to BotRoomView) | Bias dir AWAY by 0.10 * unit vector when hdist < 60wu AND ahead-of-self (line 286-300) | ✅ line 280 |
| Aggressive items in 8th | `getOwnPlacement(view)`: one-liner via `view.bodies.find(b => b.petId === selfPetId)?.currentPlacement` (line 407-410) | useChance scales 0.30 (1st) → 0.45 (8th) linearly (line 329-337) | ✅ line 305 |

**Significant gap:** Ribbon-aware steering for bots is fully omitted. Plan §8.2 specifies it; commit `0eb3d0f` skipped it. This means bots will benefit from ribbons only by accident on the centerline path. Acceptable for a v1 ship but the plan v2 file-scope claims +130 lines on the bot file (only ~191 lines added) suggests this was overlooked, not deliberate.

---

## 5. Type / test execution

| Check | Result |
|---|---|
| `cd packages/shared && bun --bun tsc --noEmit` | **PASS** (exit 0) |
| `cd apps/api && bun --bun tsc --noEmit` | **PASS** (exit 0) |
| `cd apps/web && bun --bun tsc --noEmit` | **PASS** (exit 0) |
| `bun test apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | **68 pass / 0 fail** (423 expects) |
| `bun test apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts` | **14 pass / 0 fail** (648 expects) |
| `bun test apps/api/src/services/activity/__tests__/activity-room-manager.test.ts` | 32 pass / **1 fail** — failure is "Room sweeper > aborts COUNTDOWN rooms with no connected players" |

**The 1 activity-room-manager failure pre-exists at master `f4d276e` (verified via `git checkout f4d276e -- apps/api/src/services/activity/bots/* && bun test`). NOT a Phase 2 regression.** Same for 3 pre-existing bumper-shells-bot failures (heuristic dir bias) and 4 pre-existing `@clawville/database` import errors (db build artifact issue). None traceable to Phase 2 changes.

**Phase 2 added 47 new sim tests + 5 new bot tests = 52 new tests; 0 failures attributable to Phase 2 code.** Phase 1 baselines (T1-T21 sim, T22-T25 bot) all still pass.

---

## 6. Issues found

### Critical

**None.** No Phase 2 code change introduces a runtime bug, crash, or invariant violation. The v2 plan correctly addressed all 6 critical issues (C1-C6) from the v1 audit, and the implementation faithfully encodes them.

### Significant

1. **Town Guide knowledge[] update SKIPPED entirely.** `packages/agent-templates/src/locations/town-guide.ts` was NOT touched by either Phase 2 commit. Plan §11 file-scope mandates +12 lines covering all 5 mechanics + "shields don't block hazards" rule. CLAUDE.md has it as a hard mandate ("Skip = broken onboarding"). Audit checklist §14 explicitly lists this requirement. **Fix:** add knowledge entry per plan §11 row.

2. **`3dStructure.md` and `GameFeatures.md` NOT updated.** Plan §11 file-scope mandates +40 lines and +70 lines respectively documenting the 3 new scene components, draw-call cost, RoomMeta source-of-truth, the 5 mechanics, combined-boost ceiling math, and "shields don't block hazards" rule. Both docs exist locally (gitignored per CLAUDE.md) but neither contains any Phase 2 Reef Race additions. Audit checklist §14 implicitly lists them. **Fix:** update both docs same diff.

3. **`reef-race-real-racing.md` line 108 (audit N2 fix) NOT applied.** Stale `packages/shared/src/types/activity-frames.ts` reference unchanged. Plan §11 specifies +1/-1 line. **Fix:** sed/edit the line.

4. **P2-T35 snapshot bandwidth regression test + fixture COMPLETELY MISSING.** Plan §9.8 specifies P2-T35 (delta size grows by ~1 number per body per tick, comparison against `phase1-snapshot-bytes.json` fixture). Plan §11 file-scope explicitly lists the fixture file. Plan §12 commit-order specifies it captures the baseline at commit #1. Audit checklist §14: "Snapshot bandwidth growth ≤ 50% vs `phase1-snapshot-bytes.json` fixture (P2-T35, audit G9 fix)." Neither the test nor the fixture exists. **Fix:** add P2-T35 + commit baseline fixture.

5. **PlacementTile rarity-tier hint icon SKIPPED.** Plan §6.3 specifies a one-character mini-icon (🛡 / 🛡* / ⚖ / ⚔* / ⚔) below the placement number indicating the next-roll tier. Plan §11 file-scope budgets +25 lines on `reef-race-hud.tsx` for "Mount slipstream tag, apex toast, AND update PlacementTile to show rarity-tier hint". Implementation only mounts the components — the tier hint is absent. Without it the placement-weighted item table is invisible to players. **Fix:** add icon block to PlacementTile keyed on `placement`.

6. **Bot ribbon-steering heuristic SKIPPED.** Plan §8.2 specifies "When the next-checkpoint t-value is near a ribbon's midpoint... nudge dir toward the ribbon's centerline". Implementation file added 191 lines, plan budgeted +130 lines for all heuristics including ribbons — ribbon-aware steering is absent. Bots collect ribbons only by accident on the centerline. **Fix:** add ribbon-midpoint pull when self is approaching a ribbon-bearing checkpoint.

7. **P2-T40 test bounds too loose to catch the C5 regression.** Asymptote at 0.98× = 490 wu/s; v1 BUG asymptote = 500 wu/s. Test asserts `< REEF_MAX_SPEED * 1.05 = 525 wu/s`. Both pass. The test no longer functions as a regression fence for the C4/C5 fix. **Fix:** tighten to `expect(speedNoTurbo).toBeLessThan(REEF_MAX_SPEED * 1.0)` (must be strictly slower than baseline). reef-race-sim.test.ts:1601.

### Minor

1. **`event.power_up_collected.kind` typed as `string?` (optional + non-narrowed).** Plan §4.1 specifies `kind: ReefPowerUpKind` (non-optional, typed). protocol.ts:267 declares `kind?: string`. The optionality is semantically correct (Phase 1 servers may omit) but the loose `string` type means a rogue server could send any string and the client would write it into the inventory slot without runtime validation. Low risk (server-controlled, never user-influenced) but a code-quality hit. **Fix:** export `ReefPowerUpKind` from `@clawville/shared` and narrow the type.

2. **`lastSlipstreamEventAt` is dead code.** Declared, initialised, and set in the store, but never read by any component. Plan §7.1 acknowledges this ("audit-paranoia diagnostics only — no longer required for HUD logic given event.slipstream_end"). Acceptable but bloat. **Fix:** delete the field if Phase 2.5 doesn't introduce a reader.

3. **HUD inventory display path for self after fire is broken (pre-existing; plan acknowledges out-of-scope).** Server `tryUsePowerUp` clears `body.inventory[slot]` on fire, but the per-tick inventory delta channel for Reef Race is silently broken (audit C2/S12). The client's `powerUpInventory` is updated on `event.power_up_collected.kind` (after collect) but never cleared on fire. Player will see a stale full slot after firing a power-up. Plan §13 calls this out as a Phase 2.5 cleanup ticket. **Fix (Phase 2.5):** wire per-tick inventory delta for Reef Race OR emit `event.power_up_consumed { petId, slotIndex }` and clear the slot in the store.

4. **Bot can't see hazards through `BotRoomView`.** Implementation approximates hazard centers from hairpin checkpoint geometry (line 281-282 of reef-race-bot.ts) — a hard-coded 0.73 multiplier of `APEX_INSIDE_OFFSET`. If hazard placement formula changes (e.g. `HAZARD_INSIDE_OFFSET` retunes), bot avoidance silently drifts off the actual hazard center. **Fix:** project `state.hazards` into the bot view.

5. **Slipstream end-event branch resets `slipstreamSourcePetId = null`/`slipstreamConsecutiveTicks = 0` ONLY if grace expired AND the boost was active.** If the body never reached SLIPSTREAM_REQUIRED_TICKS (charged for 30 ticks then left wake), grace decrements but `activeBoosts.has('slipstream-boost')` is false → no reset. Eventually the `else` branch (line 1957-1961) resets after grace. Path is technically correct but reading the code is harder than necessary because the reset is split across two branches. Cosmetic, not a bug.

---

## 7. Brand check

Per CLAUDE.md TOP PROJECT PRIORITIES:

1. **Ship to Milady AI app store** — Phase 2 is depth, not Milady. Neutral.
2. **Open agent onboarding** — Phase 2 doesn't change `/api/agent/connect` or SKILL.md surfaces. Neutral.
3. **Free agent leaderboard** — `event.slipstream`, `event.ribbon_collected`, `event.apex_verdict`, `event.hazard_hit` are NOT in leaderboard weights — verified correct in plan §10.x. ✅
4. **Gamified UI + free promotion + unified leaderboard** — Phase 2 directly adds depth. ✅

**Honest skill-ceiling verdict:**

- **Slipstream** is invisible to the leader. The drafter sees the DRAFT chip + +20% but the leader has no idea anything happened. As I noted in v1 audit, ~60% of players will never realise drafting exists. Plan ack'd this; ship-as-is.
- **Apex bonuses** still small (+5%/-5%); dwarfed by drift-3 (+38%). Players unlikely to notice in heat-of-the-moment play. Telemetry will reveal whether to amplify.
- **Boost ribbons** at +30% / 2s are SUBSTANTIAL + visible (glowing green slabs with 1Hz pulse). Will be felt. ✅
- **Hazards** at -40% are SUBSTANTIAL + visible (purple TorusKnot). Will be felt. ✅
- **Placement-weighted items** add real rubber-band depth — but **NO TIER HINT means players can't see their next-roll bias**. Ship blocker for this mechanic specifically: without the icon, the rubber-band feels like RNG noise.

Net: 3 of 5 mechanics deliver felt depth. Slipstream + apex are borderline pending telemetry. **Tier hint is the missing piece for placement-weighted items.**

---

## 8. Verdict

**PROCEED with revision.**

Code quality is strong: zero critical issues, all Phase 1 anchors intact, all v2 plan-fix anchors honoured, all 6 speed-mod arithmetic scenarios produce the spec-promised values, type checks all pass, 82/82 reef-race tests pass.

But 7 significant gaps need to land before merge:

1. Town Guide knowledge[] update (CLAUDE.md mandate; broken onboarding without it)
2. `3dStructure.md` + `GameFeatures.md` Phase 2 sections (CLAUDE.md mandate)
3. `reef-race-real-racing.md` N2 fix (1-line edit)
4. P2-T35 snapshot bandwidth regression test + fixture
5. PlacementTile rarity-tier hint icon (placement-weighted-items mechanic invisible without it)
6. Bot ribbon-steering heuristic
7. P2-T40 bounds tightening

Of those, items 1, 2, 3, 5 are doc/UX hygiene that can land in a follow-up commit before the PR ships. Items 4, 6, 7 are test/heuristic completeness — also follow-up-able.

**No risk of regressing Phase 1.** No risk of anti-cheat bypass (combined cap holds at 1.85× ≤ 1000 wu/s validator ceiling). No risk of physics breakage (drift bias formula unchanged; activeBoosts/activeEffects separation preserved).

**Ship after the 7 gaps land.**

---

## 9. Audit summary

| Severity | Count |
|---|---|
| Critical | 0 |
| Significant | 7 |
| Minor | 5 |
| Test gaps | (folded into significant — items 4, 7) |

**Phase 1 anchors intact:** 11/11
**Phase 2 v2 anchors intact:** 4/4 (1 partial — kind type narrowness)
**Speed-mod arithmetic verification:** 6/6 PASS
**Tests:** 82/82 reef-race tests pass; 0 Phase-2-attributable failures elsewhere
**Type checks:** 3/3 PASS

**Verdict: PROCEED (after 7 gaps land in follow-up commit).**
