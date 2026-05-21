---
name: project-casino-slots
description: "Casino + Claw Arcade plan — REAL-MONEY slots (SOL/USDC + ClawTokens fun-money). 12-building square ring (3 per side, no corners). Visual-first phasing 6.0→6.1→6.2→6.3. Casino interior GLB on hand (CC-BY-4.0). Hybrid session escrow extending clawville_wager."
metadata: 
  node_type: memory
  type: project
  originSessionId: 742c7462-6ff1-4984-8aaa-fb4823665b40
---

Adding TWO buildings to ClawVille: casino (slots) + claw machine arcade. Visual-first.

**Locked decisions (2026-05-17):**

**Ring geometry:** expand to a **12-building square** — 3 buildings per side, no corner buildings (corners stay as plaza space for fountains/statues/transit). Current 10-building cluster gets repositioned + 2 new slots (casino + arcade).

**Two new buildings:**
1. **Casino** — slots (Phase 6.0/6.1/6.2). Interior GLB: `C:/Users/newma/Downloads/casino.glb` (CC-BY-4.0 by Poly-Polygonal/Sketchfab, requires attribution). Style fits ClawVille's cartoon palette. 449 tris, 10 meshes — slot machines = Object_8 + Object_9 (left wall, 3 visible standing cabinets), tables = Object_4/5/6 (left as scenery for now).
2. **Claw Machine Arcade** — 12th building (Phase 6.3). ON-BRAND for "ClawVille" name. Skill-based crane game with prize redemption. User has downloaded a GLB for this (path TBD — not yet in `~/Downloads`).

**Currencies (slots):** SOL + USDC (real-money via wager escrow) + ClawTokens (fun-money via existing ledger).

**Custody:** Hybrid session escrow extending `clawville_wager` Anchor program (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG`). 8 new ix mirroring existing `_sol`/`_spl` pattern.

**RNG:** Commit-reveal provably-fair, ~50 LOC zero-deps using Node `crypto`. Public verifier UI.

**Math engine:** Direct in-repo implementation at `apps/api/src/services/slot-engine.ts` (~250 LOC, bigint payouts, deterministic, exports `runSpin` / `evaluateReels` / `getPaytableBundle`). pokie was evaluated but NOT pulled in — wrapping its `number`-typed wins into our bigint contract plus its `RandomNumberGenerator` interface around our `sampleIntFromBytes` cursor model was more glue than implementation (see slot-engine.ts module docstring). The value of the "wraps pokie" hint was the math conventions (LTR matching, wild-as-leader, payouts indexed by `matchLen - 2`), not the package itself.

**Slot UI:** 2D modal overlay (industry standard — Stake/BC.Game pattern). NOT 3D in-world reels. Click slot machine mesh in 3D interior → 2D screen pops. De-risks Iris Xe + ships fast.

**Walk-in pattern:** click building from world → "Walk in" CTA in existing `BuildingPortalModal` → avatar pathfinds to entrance (1.5–2s) → 600ms fade → casino interior scene loads → click slot machine for 2D screen. NOT modal-only — user wants real "walk in" feel.

**Phasing (visual-first, locked):**
- **Phase 6.0 — Visual & World** (UI/3D shell, no backend): ring expansion to 12-slot square, reposition 10 existing buildings, casino exterior shell (placeholder ok) + interior from GLB, walk-in animation, 2D slot screen with MOCK spin data, click hotspots on Object_8/9, arcade slot reserved (placeholder). Three-doc sync. Town Guide knowledge.
- **Phase 6.1 — Fun-money engine** (backend): provably-fair RNG (slice 1, SHIPPED 2026-05-18), in-repo slot engine (slice 2, SHIPPED 2026-05-18 — no pokie dep, see "Math engine" above), DB tables, Hono routes (ClawTokens live, real-money stubbed), Monte Carlo CI gate, verifier UI. Hook 2D screen to real backend.
- **Phase 6.2 — Real-money** (Anchor + custody): 8 new wager-program ix (4 sol + 4 spl), TS client regen, wallet adapter modals, devnet end-to-end.
- **Phase 6.3 — Claw Machine Arcade** (12th building's game): exterior + interior from user GLB, claw mechanic (skill-based), prize redemption.

**Critical NOT-YET-DECIDED:**
- Legal jurisdiction / geoblocking — user clears explicitly out of scope.
- KYC threshold + provider — Phase 5.1 rails exist, no provider integration.
- House bankroll solvency rule — almost certainly need max-bet caps tuned so max single win ≤ 0.5% treasury reserves.
- Arcade GLB path — user said downloaded, not located in `~/Downloads` as of 2026-05-17 evening.
- Exterior shell for casino (interior GLB is interior-only, no facade) — need to commission/download CC0 OR generate placeholder via blend007.

**How to apply:**
- Visual-first means Phase 6.0 ships UX shell users can WALK INTO and CLICK with placeholder fake-spin output before any RNG/contract work.
- Per CLAUDE.md mandatory team pattern, each concern runs Implementer→Auditor→Fix→Re-audit. 3D concerns spawn `3da`. Blender concerns spawn `blend007:mesh` (launching NEW Blender, never touching user's running instance).
- Same-diff doc updates: 3dStructure.md (ring/casino/walk-in), GameFeatures.md (modes/currencies/games), ARCHITECTURE.md (routes/tables/services), town-guide.ts knowledge[] (Nori must explain new layout + casino).
- AGPL/GPL code remains banned (cherry-charm, etc. — reference-only). Pokie ISC + provable-fair custom code stay clean.

Related: [[feedback-agpl-contamination]] [[project-phase5_1]] [[feedback-three-doc-standing-rule]] [[feedback-town-guide-knowledge-sync]] [[feedback-always-use-3da]] [[feedback-pre-ship-browser-test-mandatory]]
