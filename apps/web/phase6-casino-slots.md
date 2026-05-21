# Phase 6 — the Cove + Claw Arcade (visual-first, 12-building square ring)

**Status:** PLANNING — not implemented.
**Date:** 2026-05-17
**Depends on:**
- `clawville_wager` Anchor program live on devnet (already merged; `contracts/programs/clawville-wager/`).
- `@clawville/wager-program` TS client (already merged).
- `wager-program-client.ts` settlement-authority decrypt pipeline (already merged).
- `treasury_wallets` row with `purpose='wager-settlement-authority'` seeded (already in place).
- Devnet treasury funding (SOL + devnet USDC) — operator action, not in this phase.
- the Cove interior GLB: `C:/Users/newma/Downloads/casino.glb` (CC-BY-4.0 by Poly-Polygonal/Sketchfab — attribution required).
- Claw Machine Arcade GLB — user has downloaded, path TBD.

**Blocks:** future the cove games (blackjack, roulette, plinko, crash) inherit this engine + escrow + RNG.

---

## 1. Goal

Add **two** buildings to the world and expand the ring to a **12-building square layout**:
- **the Cove** (#11) — reels first, claw-machine-house pattern. SOL/USDC tier in SOL + USDC, plus a ClawTokens fun-money tier on the same engine.
- **Claw Machine Arcade** (#12) — skill-based crane game. On-brand for "ClawVille." Phase 6.3 separately.

**Visual-first phasing.** The whole UX (walk-in animation, 2D reel screen, win celebrations, the cove interior) ships with MOCK spin data before any backend or contract work. Validates feel before backend lock-in. Real RNG + paytables + on-chain custody plug into the existing UI in subsequent phases.

---

## 2. The four sub-phases

| Phase | Scope | Backend? | SOL/USDC tier? |
|---|---|---|---|
| **6.0 — Visual & World** | Ring expansion, the cove interior, walk-in flow, 2D reel screen with MOCK data, arcade reel reserved | No | No |
| **6.1 — Fun-money engine** | Real RNG, pokie, paytables, DB tables, Hono routes, Monte Carlo CI gate, verifier UI. ClawTokens currency live. | Yes | No |
| **6.2 — SOL/USDC tier custody** | 8 new predict-program ix (4 sol + 4 spl), wallet adapter modals, devnet end-to-end | Yes | Yes (devnet) |
| **6.3 — Claw Machine Arcade** | Arcade building + crane game mechanic + prize redemption | Yes | TBD |

**Phase 6.0 is the de-risker.** If the walk-in + 2D reel screen + the cove interior don't feel right, 6.1+6.2 don't matter. Ships in days, not weeks. No contracts touched. No DB writes. No RNG.

---

## 3. Non-goals (whole Phase 6)

- **No KYC / geoblocking infra.** User has cleared explicitly.
- **No mainnet deployment.** Devnet only until 6.2 passes audit.
- **No $CLAWVILLE SPL token predicting** at launch — SOL, USDC, ClawTokens only.
- **No on-chain RNG (VRF).** Commit-reveal is the only RNG path. VRF deferred.
- **No multi-player reel tournaments / shared jackpots.** Solo-vs-house only.
- **No responsible-gaming intervention systems.** Hooks left, not built.
- **No 3D in-world reel reels.** 2D modal overlay only — Stake/BC.Game pattern, industry standard.
- **No table games** (blackjack, roulette, poker) in this phase. Tables in `casino.glb` stay as decorative scenery; no click interaction.

---

## 4. Architecture decisions (locked across all phases)

### 4.1 12-building square ring (3 per side, no corners)

Replaces the current 10-building cluster arrangement. Corners stay as plaza space for fountains, statues, transit pads.

```
        N1   N2   N3
        │    │    │
      ┌─────────────────┐
      │                 │
  W1─┤                 ├─E1
      │                 │
  W2─┤     PLAZA       ├─E2
      │                 │
  W3─┤                 ├─E3
      │                 │
      └─────────────────┘
        │    │    │
        S1   S2   S3
```

Existing 10 buildings get repositioned into 10 of the 12 reels. the Cove + Claw Arcade fill the remaining 2 reels — placement TBD by `3da` based on visual flow + thematic grouping.

### 4.2 RNG: commit-reveal provably-fair, off-chain

Server generates `serverSeed` (32 bytes from `crypto.randomBytes`), commits `sha256(serverSeed)` to client at session open. Per spin: player provides `clientSeed` + `nonce`, server derives reel stops via `HMAC-SHA256(serverSeed, ${clientSeed}:${nonce}:${block})` where `block` is the 0-indexed 32-byte block number in the derived stream. The caller-facing byte cursor maps to block index via `floor(cursor / 32)`; cursor is the BYTE offset INTO the concatenated stream. On session close, server reveals `serverSeed` and player can re-derive every spin.

- Zero deps — Node `crypto` only. ~50 LOC.
- Public verifier UI at `/casino/verify`.
- Reel strips + paytable committed as plain TS constants in `packages/shared/src/constants/slot-paytables.ts`.

### 4.3 Math engine: `pokie` (npm, ISC, 0 runtime deps) with crypto RNG injection

Pokie's `RandomNumberGenerator` is implementation-pluggable. Inject HMAC byte source instead of default `Math.random()`. Pokie's `VideoSlotSession` handles lines, wilds, scatters, free spins, sticky respins. 33 test files cover all eval paths.

### 4.4 Custody (Phase 6.2): hybrid session escrow

Player signs **one** transaction at session open to escrow N SOL/USDC into a `SlotSession` PDA. Plays unlimited spins off-chain against the escrow. On session close (cash-out / idle / max-spins), server signs final balance with settlement authority, sends `close_slot_session_{sol|spl}` ix. Funds split: player gets `final_balance`, treasury gets `escrow - final_balance`.

### 4.5 SOL + USDC simultaneously

8 ix: `{open,close,authority_close_idle,player_cancel_unstarted}_slot_session_{sol,spl}`. Mirror the existing predict-program `_sol`/`_spl` pattern. ~80% code overlap per pair.

### 4.6 House bankroll solvency

Max single win in a session ≤ 0.5% of treasury reserves for that currency. Checked at session open. If treasury can't cover, session rejected with `casino_bankroll_low`.

### 4.7 Reel UI is 2D, not 3D

When player clicks a reel cabinet mesh (Object_8/Object_9 in `casino.glb`), a full-viewport 2D modal opens. Reels, HUD, win celebrations all 2D HTML/Canvas/CSS. The 3D the cove interior stays mounted underneath. Closing returns to 3D.

### 4.8 Walk-in flow

```
1. Player in world → clicks casino building
2. Existing BuildingPortalModal opens → "Walk in" CTA
3. Click → modal closes, avatar pathfinds to building entrance (1.5–2s walk using existing avatar movement)
4. On arrival → 600ms fade-to-black
5. Unmount world scene, mount casino interior scene (route-isolated, `Canvas key={'casino-interior'}`)
6. 600ms fade-in → player avatar standing at door of casino interior
7. Player walks to slot machines OR back-out door
8. Click slot machine → 2D slot screen modal opens
```

Reuses existing avatar movement + scene-isolation patterns. Only new code: walk-to-entrance trigger + fade transition.

---

## 5. Phase 6.0 — Visual & World

**Goal:** ship the full UX shell that players can walk into and click, with mock spin data. No backend. No DB writes. No RNG. No contracts.

### Concern 6.0.1 — Ring expansion + building reposition

**Files:**
- `packages/shared/src/constants/map-locations.ts` — rewrite `MAP_LOCATIONS` to 12-reel square. 10 existing buildings repositioned into N1-N3, E1-E3, S1-S3, W1-W3. the Cove + Arcade reels assigned (e.g. the cove at E2, arcade at W2 — `3da` recommends final placement).
- `apps/web/src/lib/three/world-3d.tsx` — adjust building ring scale / positions.
- `apps/web/src/lib/three/ground.tsx` (or equivalent) — corner plaza features (placeholder for fountains/statues).
- `packages/shared/src/constants/building-types.ts` — add `casino` and `claw-arcade` building types.

**Critical: building IDs must NOT change.** Existing user data references building IDs (avatar location, inventory, quest progress). Reposition the geometry, keep IDs stable.

**Acceptance:**
- All 10 existing buildings render in new positions, IDs unchanged.
- the Cove + Arcade reels have placeholder cubes/signs (real GLBs come in next concerns).
- Visual flow: player can walk from plaza center to any of the 12 reels in <8s.

### Concern 6.0.2 — the Cove interior scene from `casino.glb`

**Files:**
- `apps/web/src/lib/three/casino-interior.tsx` (new) — route-isolated activity scene.
- `apps/web/src/lib/three/casino-building.tsx` (new) — exterior shell in world ring. Placeholder cube with neon trim until proper exterior asset acquired.
- `apps/web/src/components/three/CasinoLighting.tsx` (new) — neon ambient (cyan + magenta point lights, NO shadows per Iris Xe rules).
- `apps/web/public/models/casino-interior.glb` (new) — processed copy of user's GLB: scale 0.1×, recentered origin, gltf-transform optimize pass.
- `apps/web/public/credits.md` or `apps/web/src/app/credits/page.tsx` (new or modified) — Sketchfab + Poly-Polygonal attribution (CC-BY-4.0 requirement).

**Processing pipeline (one-time, via `blend007:mesh` or `scripts/`):**
1. Apply 0.1× scale to all meshes.
2. Recenter origin to floor-center (Box3 in TS or `Object > Set Origin > Origin to Geometry` in Blender).
3. Run `gltf-transform optimize --simplify=false` (don't decimate — already 449 tris).
4. Save to `apps/web/public/models/casino-interior.glb`.

**Click hotspots:**
- Object_8 and Object_9 = reel cabinet cluster (left wall). Add invisible `THREE.Mesh` clickboxes positioned over them. Each opens 2D reel screen with a machine slug (`classic-3x5` for both at MVP).
- Object_4/5/6 = tables. **No interaction.** Pure scenery.

**Acceptance:**
- the Cove interior loads in <1s on cold cache.
- 3da audits and approves.
- Browser playtest: walk in → see reel machines → cursor changes on hover → click → 2D screen opens. No console errors. ≥50 FPS on Iris Xe.

### Concern 6.0.3 — Walk-in animation

**Files:**
- `apps/web/src/stores/game.ts` — extend `enterBuilding` with a `walkInPath` option for the cove + arcade. Returns a promise that resolves when avatar arrives.
- `apps/web/src/components/game/building-portal-modal.tsx` — "Walk in" CTA on the cove building.
- `apps/web/src/components/casino/SceneTransition.tsx` (new) — generic 600ms fade overlay with `onMidway` callback (for scene swap).
- `apps/web/src/app/casino/page.tsx` (new) — route-isolated interior scene mount point.

**Pattern:**
- Click → animate avatar walk to entrance (existing pathfind, target = building door position).
- On arrival, push `/casino` route; `SceneTransition` plays 600ms fade-out → next-tick scene swap → 600ms fade-in.
- Exit door in the cove interior triggers reverse: fade → push back to `/game` → avatar at door of the cove exterior.

**Acceptance:**
- Walk-in feels intentional (no instant teleport, no jarring scene change).
- Browser playtest: from `/game`, click the cove → walk-to-door → fade → the cove interior. <3s total. Reverse exit works the same.

### Concern 6.0.4 — 2D reel screen (mock data)

**Files:**
- `apps/web/src/components/casino/SlotScreenModal.tsx` (new) — full-viewport modal that opens when reel cabinet clicked. Closes on Escape / back button / explicit X.
- `apps/web/src/components/casino/SlotReels.tsx` (new) — 5×3 reel grid. CSS / Canvas / Pixi (decision deferred to implementer — recommend CSS transforms first; upgrade to Canvas/Pixi if anim feels janky).
- `apps/web/src/components/casino/SlotHUD.tsx` (new) — bet size, balance, spin button, autoplay dropdown, paytable button, mute, fairness button.
- `apps/web/src/components/casino/PaytableModal.tsx` (new) — symbol → payout table view.
- `apps/web/src/lib/casino/mock-engine.ts` (new) — deterministic mock spin generator. Same shape as real `slot-engine.ts` will have. Returns canned reel layouts + payouts for visual testing.
- `apps/web/src/lib/casino/symbols.ts` (new) — symbol icon assets + sprite map.

**Mock engine behavior:**
- `mockSpin({bet, paytableId}): MockSpinResult` — returns one of: pure loss (60%), small win (25%), medium win (10%), big win (5%). Uses `Math.random()` since this is MOCK only.
- Same `MockSpinResult` shape as future `SpinResult` so swap-in is trivial.
- Includes `winningLines: WinningLine[]` so HUD highlights can render correctly.

**Reel animation:**
- 5 reels, **sequential stop** with 0.4s staggered delay between reels (creates the near-miss tension that's core to reel UX).
- Per reel: 0.3s ease-in, ~3 rotations/sec peak, 1s ease-out, land on target symbol.
- After all stop: if `winningLines.length > 0`, draw lit lines (CSS additive overlay), pulse symbols 1.15× scale, particle burst at proportional intensity.

**Acceptance:**
- Reel screen opens / closes cleanly.
- Spin button triggers reel anim, lands on mock symbols, shows mock payout.
- All states (idle / spinning / win / loss / autoplay) reachable via dev panel.
- Mobile responsive: bottom-bar HUD, full-width reels, 56px+ spin button.

### Concern 6.0.5 — Win celebration system (mocked)

**File:** `apps/web/src/components/casino/WinCelebration.tsx` (new).

**Tiers** (multiplier of bet — mock returns chosen by mock engine):

| Tier | Trigger | Effect |
|---|---|---|
| Micro (1–2×) | Brief coin chime + symbol highlight, no overlay |
| Small (2–10×) | 2D coin shower (~30 sprites, object pool) + count-up + chime |
| Medium (10–50×) | "WIN" lower-third banner + heavier shower + chord progression |
| Big (50–500×) | Full-screen darken + center win amount + 3D coin spray + escalating music |
| Mega (500×+) | Screen shake + flash + 3s lockout + mascot cameo (lobster) |

**Anti-fatigue:** if 3+ medium wins in 60s, particle density drops 40%.

**Dev panel:** `/casino/dev-celebrations` route (gated `ADMIN_USER_IDS`) — buttons to fire each tier.

**Acceptance:** all 5 tiers visually distinct, no overlap with HUD, no perf drop.

### Concern 6.0.6 — Sound design (mocked)

**Files:**
- `apps/web/public/sound/casino/{reel-stop,reel-loop,win-{micro..mega},ambient}.webm` (new) — WebM Opus, ≤50KB each.
- `apps/web/src/lib/casino/sound-manager.ts` (new) — Web Audio API wrapper. Master + per-category gain. Mute persisted in localStorage. AudioContext lazy-resumed on first interaction.

**Acceptance:** all sounds trigger correctly with mock spins. Mute toggle works. No autoplay blocks.

### Concern 6.0.7 — Mobile responsive pass

**Files:** sweep across `apps/web/src/app/casino/**`, `apps/web/src/components/casino/**`.

**Breakpoints:**
- ≥1024px: desktop layout.
- 768–1024px: scaled, HUD repositions.
- <768px: single column, bottom-sticky HUD, spin button bottom-center (≥56px), bet adjustment is +/- only.
- All interactive elements ≥44×44px. Spin double-tap-protected (100ms debounce).

**Acceptance:** Playwright responsive matrix on 6 viewports passes.

### Concern 6.0.8 — Arcade reel placeholder (12th reel)

**Files:**
- `packages/shared/src/constants/map-locations.ts` — arcade entry in 12-reel grid.
- `apps/web/src/lib/three/claw-arcade-building.tsx` (new) — exterior. If user's arcade GLB is provided in time, use it (apply same processing as the cove: scale + recenter). Otherwise: placeholder cube with "Coming Soon" sign.
- Click on arcade in world → toast "Coming soon" (until Phase 6.3 ships actual game).

**Acceptance:** building visible in correct reel. Click feedback present.

### Concern 6.0.9 — Town Guide knowledge update (Phase 6.0 layer)

**File:** `packages/agent-templates/src/locations/town-guide.ts` — Nori's `knowledge[]`.

**Add:**
- Town layout changed from cluster arrangement to 12-building square ring (3 per side, plaza corners).
- Two new buildings: the Cove (E2 or wherever) and Claw Machine Arcade (W2 or wherever).
- the Cove: walk in, sit at reel cabinet, play with ClawTokens (currently). SOL/USDC tier (SOL, USDC) coming.
- Arcade: under construction. Skill-based claw machine game.
- Pointer to `/casino/verify` for provably-fair verification (works even with mock data — verifier validates the shape).
- "Tables in the the cove are scenery for now — only reel machines are playable."

### Concern 6.0.10 — Three-doc sync (Phase 6.0 layer)

- **`3dStructure.md`:** new ring layout (12-square geometry, 3-per-side, corner plazas), the cove interior (`casino-interior.glb`, scale 0.1×, click hotspots on Object_8/9), walk-in animation pattern, arcade placeholder.
- **`GameFeatures.md`:** new modes (the cove reels — mocked at 6.0), 2D reel screen pattern, walk-in flow, ClawTokens-only at 6.0.
- **`ARCHITECTURE.md`:** new route `/casino`, new building types `casino` + `claw-arcade`, sound assets paths. No DB / route changes yet (those are 6.1).
- Bump "Last Audited" on all three.

### Phase 6.0 acceptance criteria

- [ ] Ring expanded to 12-building square. Existing 10 building IDs unchanged.
- [ ] the Cove interior renders from `casino.glb` at correct scale, centered.
- [ ] Reel cabinet click hotspots (Object_8, Object_9) trigger 2D reel screen.
- [ ] Walk-in flow: world → click the cove → walk to door → fade → interior. <3s total.
- [ ] 2D reel screen: spin, reel anim, mock payout, win celebrations (all 5 tiers).
- [ ] Mobile responsive across 6 viewports.
- [ ] Sound works, mute persists.
- [ ] Town Guide explains new layout.
- [ ] Attribution credit (CC-BY-4.0) visible at `/credits`.
- [ ] All three canonical docs updated, "Last Audited" bumped.
- [ ] Browser playtest recorded end-to-end (`feedback_pre_ship_browser_test_mandatory`).
- [ ] No console errors, ≥50 FPS on Iris Xe baseline.

---

## 6. Phase 6.1 — Fun-money engine

**Goal:** swap mock spin engine for real provably-fair RNG + pokie math + DB persistence. ClawTokens currency live. SOL/USDC tier currencies (SOL/USDC) stubbed at route level (return 501 with "coming in 6.2").

### Concern 6.1.1 — Provably-fair RNG module

**File:** `apps/api/src/services/provable-rng.ts` (new, ~80 LOC).

**API:**
```ts
// Defensive caps — mirror these in any Zod schema validating route input.
export const CLIENT_SEED_MAX_LENGTH = 256;   // chars (post-trim, post-lowercase)
export const MAX_BYTE_COUNT          = 65536; // bytes per deriveBytes() call

export interface ServerSeedPair {
  /** Hex-lowercase server seed (64 chars, 32 bytes of CSPRNG). NEVER expose until reveal. */
  serverSeed: string;
  /** sha256(serverSeed) — commit-phase publication. Safe to expose at commit. */
  serverSeedHash: string;
}

export function createServerSeed(): ServerSeedPair;

export interface DeriveBytesArgs {
  serverSeed: string;   // 64-char hex
  clientSeed: string;   // non-empty hex
  nonce: number;        // non-negative integer
  cursor: number;       // non-negative integer byte offset
  byteCount: number;    // positive integer (≤ 65536)
}
export interface DerivedBytes {
  bytes: Buffer;
  cursorAfter: number;
}
export function deriveBytes(args: DeriveBytesArgs): DerivedBytes;

export function sampleIntFromBytes(args: { ... }): SampledInt; // see file for full
```

Verification is performed by the consumer of `deriveBytes` calling `deriveBytes` itself with the same inputs and comparing the resulting bytes — there is no separate `verifySpinFromInputs` function in the shipped code.

**Implementation:** `crypto.randomBytes(32).toString('hex')`, HMAC-SHA256 keyed by serverSeed raw bytes (`Buffer.from(serverSeed, 'hex')`), message `${clientSeed}:${nonce}:${block}` where `block` is the 0-indexed 32-byte block number. Caller passes a byte `cursor`; implementation maps to startBlock = `floor(cursor / 32)`, generates the needed contiguous blocks, slices. `clientSeed` is lowercased before HMAC; `sha256Hex` hashes the UTF-8 bytes of the hex string (NOT the decoded bytes) — frontend verifier must match.

**Acceptance:** deterministic byte-for-byte. Test vector with hand-computed expected output.

### Concern 6.1.2 — Reel math service

**File:** `apps/api/src/services/slot-engine.ts` (new).

Wraps pokie `VideoSlotSession`. Custom `RandomNumberGenerator` pulls from `deriveBytes` via rejection sampling (modulo bias avoidance) → integers in `[0, reelStripLen)`.

**Paytable at MVP:** `classic-3x5` in `packages/shared/src/constants/slot-paytables.ts`. return rate target 96%. Reel strips, symbol weights, line definitions — plain exported TS constants.

**Acceptance:** deterministic. 1000-spin snapshot test passes.

### Concern 6.1.3 — Database schema

**File:** `packages/database/src/schema/casino.ts` (new). Tables: `slot_sessions`, `slot_spins`. (Full schema in original plan — fields: serverSeed, serverSeedHash, currentBalance, escrowAmount, status, sessionPda, etc.)

`bun run db:push` to apply. No data migration.

### Concern 6.1.4 — Hono routes

**File:** `apps/api/src/routes/casino-slots.ts` (new). Endpoints: `POST /session/open`, `POST /spin`, `POST /session/close`, `GET /session/:id`, `GET /session/:id/spins`, `GET /paytables/:id`, `POST /verify`.

ClawTokens path is fully wired. SOL/USDC return 501.

Middleware: Lucia auth, 60 spins/min rate limit, idempotency-key header on `/spin`.

### Concern 6.1.5 — Monte Carlo return rate CI gate — **SHIPPED 2026-05-19**

**Files:**
- `scripts/casino/rtp-sim.ts` ✅ — 1M-spin simulator on top of `runSpin` + `CLASSIC_PAYTABLE`. Flags: `--spins`, `--bet`, `--seed`, `--client-seed`, `--strict-rtp <lo>,<hi>`, `--exit-on-fail`. Reports return rate + hit freq + max win + 6-bucket histogram + per-symbol middle-row hit rate. 1M spins ~11s; 100k ~1.1s.
- `.github/workflows/rtp-gate.yml` ✅ — triggers on PR touching `slot-paytables.ts`/`slot-engine.ts`/`provable-rng.ts`/`rtp-sim.ts`. Runs 100k Monte Carlo with `--strict-rtp 0.95,0.97 --exit-on-fail`. Band wider than local 1M acceptance [95.5%, 96.5%] to absorb 100k-sample stderr.
- `apps/api/src/services/__tests__/rtp-fixture.test.ts` ✅ — 10k Monte Carlo inside `bun test`, asserts [92%, 100%] band + hit-freq + max-win sanity. Catches gross drift on every test run.
- `packages/shared/src/constants/slot-paytables.ts` — reel strips retuned L=80→84, composition (C=22, L=22, O=14, P=14, B=7, +1 each high-pay). Payouts UNCHANGED.

**Acceptance (all met):**
- [x] 1M spins <60s locally — measured 10.78s.
- [x] CI fails on intentional paytable bug — `--strict-rtp` + `--exit-on-fail` verified locally with deliberately-out-of-band thresholds.
- [x] Monte Carlo 1M spins, return rate within ±0.5% of 96.00% — measured 95.8888% (Δ=−0.11%).
- [x] Analytic return rate 96.0041% (one-line × 20 lines).
- [x] Per-symbol middle hits within ±0.05% of expected — no symbol starved.

### Concern 6.1.6 — Hook 2D reel screen to real backend

**File:** `apps/web/src/lib/casino/mock-engine.ts` deleted; replaced with real API calls.

UI shell unchanged — only the data source. Mock and real have the same shape so this is mostly a one-file edit.

### Concern 6.1.7 — Provably-fair verifier UI

**Files:**
- `apps/web/src/app/casino/verify/page.tsx` (new) — paste serverSeed + clientSeed + nonce + paytable, re-derive client-side, show pass/fail.
- `apps/web/src/app/casino/verify/[sessionId]/page.tsx` (new) — one-click verify all spins in a past session.
- `apps/web/src/lib/casino/verifier.ts` (new) — browser-safe `deriveBytes` (same algo as server).

**Acceptance:** known-good session 100% verifies. Tamper test: hand-edit one byte in `slot_spins` row → verifier flags it.

### Concern 6.1.8 — Town Guide knowledge (Phase 6.1 layer)

Update Nori: provably-fair available, ClawTokens live, SOL/USDC tier coming. Pointer to verify UI.

### Concern 6.1.9 — Three-doc sync (Phase 6.1 layer)

- ARCHITECTURE.md: new routes group `/api/casino/slots/*`, new tables, new services, dep add (`pokie`).
- GameFeatures.md: fun-money tier live.
- 3dStructure.md: no changes.

### Phase 6.1 acceptance

- [ ] ClawTokens session end-to-end: open → 100 spins → close, balance correct in DB.
- [x] Monte Carlo 1M spins, return rate within ±0.5% of 96.00%. (Slice 4 — 95.89% sim / 96.00% analytic.)
- [ ] Verifier: known seeds re-derive identical reels.
- [ ] Mock engine fully deleted, no dead code.
- [ ] SOL/USDC routes return 501 with friendly message.

---

## 6.5. Phase 6.1.5 — Bonus mechanics (Bundle B) — **SHIPPED 2026-05-19**

**Last edit:** 2026-05-19 — backend salvaged from killed worktree, RTP-shape lock applied (team-lead option-(a) decision), Town Guide knowledge synced, GameFeatures.md + ARCHITECTURE.md updated same diff. Section status: SHIPPED.

**Goal:** layer scatter-triggered free spins + multiplier wilds onto the shipped 6.1 engine. Ships AFTER 6.1 base UI is end-to-end working. UI parity with math parity — animation work is not a stretch goal.

User approved 2026-05-18 ("Bundle B") after rejecting cherry-charm AGPL contamination route. UI inspiration only (R3F reel rig, stop-pop timing, win cascade) — no code copied, MIT-clean.

**Field-name note (post-rename, 2026-05-19):** the user-facing "bet" field was renamed to `predict` end-to-end (commit `ffb914b`). This section uses `predict` throughout. Engine math is unchanged.

### New paytable: `classic-3x5-bonus` (additive — `classic-3x5` keeps shipping for non-bonus modes)

- 11 symbols total: existing 0-9 unchanged (Cherry, Lemon, Orange, Plum, Bell, BAR, Seven, WILD, BAR×2, BAR×3), **add id 10 = Scatter (Treasure Chest art)**.
- New scatter asset: `apps/web/public/assets/slot-symbols/s10.svg` — Treasure Chest, gold (`themeColor: '#ffd778'`). `displayName: 'Scatter'` in `CLASSIC_SLOT_SYMBOL_ASSETS[10]`.
- Reel strips: 5×84 (matches the slice-6.1.4 retune used by `classic-3x5`). Each strip has exactly 3 scatters per reel, balanced by trimming low-tier counts. Wild density limited to R1/R2 only (R0/R3/R4 have no wild) so the FS-mode wild-multiplier amplification doesn't overshoot the combined RTP band.
- Scatter pays anywhere on the 5x3 grid (not payline-restricted), as a multiplier on TOTAL PREDICT:
  - 3 scatters anywhere = 2× total predict
  - 4 scatters = 10× total predict
  - 5 scatters = 50× total predict
- `SCATTER_PAY_TABLE = [0,0,0,2,10,50]` (indexable by scatter count).

### Free Spins mode

- 3+ scatters in base mode → award **10** free spins (`FREE_SPIN_RULES.AWARD_BASE`), transition session to `free-spin` mode.
- During free spins: same paytable, same RNG cursor chain. Line wins are NOT further doubled (see RTP-shape lock below).
- 3+ scatters during free spins = **+5** retrigger (`FREE_SPIN_RULES.AWARD_RETRIGGER`), cumulative, capped at **50** total unspent free spins (`CAP_REMAINING`).
- Free spins consume no predict; player can't change predict mid-free-spin run.
- Session state in `slot_sessions`: `freeSpinsRemaining`, `mode` ∈ `'base' | 'free-spin'`.

### Multiplier Wilds

- Every Wild (id 7) landed in the 5×3 visible window draws a multiplier value at spin time via `sampleIntFromBytes(range=100)`:
  - draw ∈ [0, 60)  → **×2** (60%)
  - draw ∈ [60, 90) → **×3** (30%)
  - draw ∈ [90, 100) → **×5** (10%)
- Cursor advances per draw (5 reel samples + N landed-wilds + scatter eval = up to ~11 sample calls per spin).
- **In FREE-SPIN mode only:** a winning line whose matchLen prefix crosses a wild cell has its line payout multiplied by that wild's value. Multiple wilds on one line MULTIPLY together (e.g. ×2 × ×3 = ×6).
- **In BASE mode:** wild multipliers are still drawn (preserves deterministic byte-stream replay) and emitted in `SpinResult.wildMultipliers[]` so the UI can render a "potential" chip on the cell, but they do **NOT** amplify base-mode line wins.

### RTP-shape lock (team-lead decision 2026-05-19) — load-bearing

Two `FREE_SPIN_RULES` flags ship at:

| Flag | Shipped value | What it means |
|---|---|---|
| `FS_LINE_WIN_MULTIPLIER` | `1` | No outer ×2 scalar applied to line wins in FS mode. |
| `FS_WILD_MULTIPLIER_DOUBLE` | `false` | Wild multipliers emit their raw table value (2/3/5) regardless of mode. |

**Why both off:** with both flags set to the original spec values (`FS_LINE_WIN_MULTIPLIER=2`, `FS_WILD_MULTIPLIER_DOUBLE=true`), 30k Monte Carlo measures combined RTP ≈ 126% — unshippable (the house would drain into the player). With them off, 100k MC measures **96.38%** combined, comfortably inside the strict CI band `[95.5%, 99.5%]`. The flags are kept (not deleted) so a future strip retune can move toward the spec-literal interpretation; flipping them flips the math without touching engine code paths.

**Value to the player in FS mode without doubling:**
- spins themselves are free (no predict debit) — that IS the bonus
- line wins still pay at the raw kind payout
- multiplier wilds STILL apply in FS at base 2×/3×/5× weights (they're inert in base mode)
- scatter pay-anywhere still fires on retrigger

VERIFICATION.md guarantees the provably-fair RTP; widening the CI band to hide an out-of-band RTP would break that promise. Option-(a) flag flip is the only resolution that preserves it.

### Engine surface (`apps/api/src/services/slot-engine.ts`)

Additive, non-breaking on shipped `SpinResult` shape:

```ts
export interface SpinResult {
  reels: SymbolId[][];
  winningLines: WinningLine[];
  winAmount: bigint;
  freeSpinsAwarded: number;          // LIVE — AWARD_BASE/AWARD_RETRIGGER on trigger
  isFreeSpin: boolean;                // LIVE — true on a free spin
  wildMultipliers: WildMultiplier[];  // empty array if no wilds landed
  scatterPayout: bigint;              // atomic units, 0n if scatter count < 3
  cursorAfter: number;
}

export interface WildMultiplier {
  reelIndex: number;  // 0..4
  rowIndex: number;   // 0..2
  multiplier: number; // raw table value: 2, 3, or 5 (no FS doubling per the lock above)
}

export interface RunSpinArgs {
  // ... slice-2 fields (paytableId, serverSeed, clientSeed, nonce, cursor)
  predict: bigint;          // post-rename: was `bet`
  freeSpinMode?: boolean;   // caller (route) passes session state
}
```

`evaluateReels` accepts an optional options bag carrying `wildMultipliers` + `freeSpinLineMultiplier`; on `classic-3x5` (no scatter symbol) these defaults to `[]` and `1`, reproducing slice-2 behaviour byte-for-byte.

### Wire types (`apps/api/src/routes/casino-slots.types.ts`)

`SerializedSpinResult` adds `wildMultipliers: SerializedWildMultiplier[]` + `scatterPayout: string`. `SpinResponse` adds `mode: 'base' | 'free-spin'` + `freeSpinsRemaining: number` so the frontend can swap spin-button label + render `FreeSpinBanner`.

### Route surface (`apps/api/src/routes/casino-slots.ts`)

- `POST /session/open` accepts `paytableId: 'classic-3x5' | 'classic-3x5-bonus'`.
- `POST /spin` reads `session.mode` + `freeSpinsRemaining` to derive `isFreeSpinSpin`; if true, skips the predict debit + does NOT increment `totalStaked` (FS is free). Bumps `freeSpinsRemaining` on trigger (clamped at `CAP_REMAINING`), decrements on FS-consumed, flips `mode` back to `'base'` when remaining hits 0.
- `GET /paytables/:id` returns both paytables; bonus response includes `symbols[10].isScatter: true`.
- `POST /verify` accepts both paytable ids.

### Acceptance

- [x] Free-spin trigger rate ≈ 1 per 80-150 spins. Live measurement: ~1 per 90 base spins at 100k MC.
- [x] Free-spin mode applies multiplier wilds only (line wins NOT additionally doubled; RTP-shape lock).
- [x] Retrigger cap (50 max FS) tested (engine + DB-gated route test).
- [x] Monte Carlo (rtp-sim `--paytable classic-3x5-bonus`): 100k spins, combined RTP **96.38%** ∈ strict band [95.5%, 99.5%]. Local 1M run target [96.5%, 99.5%]. CI gate enforced in `.github/workflows/rtp-gate.yml`.
- [x] Verifier-compatible SpinResult: `wildMultipliers` + `scatterPayout` carry through `serializeSpinResult` byte-identically (same byte stream → same fields).
- [x] Cherry-charm-inspired R3F reel animation in the cove UI (impl-2 work — original code, no AGPL copy). SHIPPED 2026-05-19: `SlotReels3D.tsx` + `SlotReelsCanvas.tsx`; 5 CylinderGeometry drums, per-reel CanvasTexture (84×128×3px), ACCEL/STEADY/DECEL/POP phases, deterministic landing via `findStripPosition`, `frameloop='demand'`. `SlotScreenModal` integrates via `spinTrigger` counter + `winningCells3D` memo.

### Ordering

Lands AFTER 6.1 base ships end-to-end (slices 3+4+5 → ClawTokens working loop). 6.1.5 is a bolt-on, not a precondition.

---

## 7. Phase 6.2 — SOL/USDC tier custody (SOL + USDC)

**Goal:** 8 new Anchor instructions, devnet end-to-end, wallet adapter modals.

### Concern 6.2.1 — Anchor program extension

8 new ix in `contracts/programs/clawville-wager/src/instructions/`:
- `open_slot_session_sol.rs` + `open_slot_session_spl.rs`
- `close_slot_session_sol.rs` + `close_slot_session_spl.rs`
- `authority_close_idle_session_sol.rs` + `authority_close_idle_session_spl.rs`
- `player_cancel_unstarted_session_sol.rs` + `player_cancel_unstarted_session_spl.rs`

New state: `SlotSession` account (`player`, `currency`, `escrow_amount`, `opened_at`, `last_authority_settle_at`, `status`, `server_seed_hash`, `nonce`, `bump`). PDA seed `[b"slot_session", player.key().as_ref(), &[nonce]]`.

New events: `SlotSessionOpened`, `SlotSessionClosed`, `SlotSessionCancelled`. New errors: `SessionAlreadyClosed`, `BankrollInsufficient`, `InvalidSettlementAmount`, `SessionNotIdle`, `SessionHasSpins`.

**Acceptance:** Anchor tests cover open→close (winning), open→close (losing), idle close, player cancel, double-close rejection, mismatched authority rejection, bankroll-insufficient rejection. Devnet deploy succeeds. Existing lobby ix untouched.

### Concern 6.2.2 — TS client + IDL re-export

`packages/wager-program/src/index.ts` + regenerated IDL. Export `findSlotSessionPda`.

### Concern 6.2.3 — API routes (SOL/USDC tier path)

Un-501 the SOL + USDC paths in `casino-slots.ts`. On `/session/open` with `currency='sol'|'usdc'`: validate treasury bankroll headroom, return unsigned ix for client to sign, poll for confirmation, write session row with `session_pda` + `open_tx_signature`.

On `/session/close`: reveal serverSeed, server signs `close_slot_session_{sol|spl}` with settlement authority, send tx, write `close_tx_signature`. Idempotent on retry.

Cron `apps/api/src/jobs/casino-settle-pending.ts` retries failed settle txs every 60s. Idle sessions (>24h no spins) get force-closed by `authority_close_idle_session_{sol|spl}`.

### Concern 6.2.4 — Wallet adapter modals

**Files:**
- `apps/web/src/components/casino/OpenSessionModal.tsx` (new) — escrow input, currency reminder, "Sign to start playing".
- `apps/web/src/components/casino/CloseSessionModal.tsx` (new) — final balance display, "Cash out to wallet", tx-pending state.
- `apps/web/src/components/casino/TxPendingOverlay.tsx` (new) — generic Solana tx-pending with retry / explorer link.

Reuse existing `@solana/wallet-adapter` (already in ClawVille for Phase 5.1).

### Phase 6.2 acceptance

- [ ] Anchor devnet deploy, program ID unchanged.
- [ ] SOL end-to-end devnet: open → 50 spins → cash out, lamports arrive.
- [ ] USDC end-to-end devnet: same, micro-USDC to player ATA.
- [ ] Idle-session cron refunds after 24h timeout.
- [ ] Player cancel before any spin returns full escrow.
- [ ] Treasury bankroll cap blocks session open when reserves too low.
- [ ] No regression in PvP predict-program lobby flow.

---

## 8. Phase 6.3 — Claw Machine Arcade (12th building)

**Goal:** 12th-building game ships. On-brand for ClawVille name.

Scope deferred to its own plan doc (`.claude/plans/phase6.3-claw-arcade.md`) after 6.0 ships. Notes:
- Skill-based crane game (player controls crane, attempts to grab prize).
- Real GLB from user (path TBD).
- Prize redemption flow — ClawTokens → cosmetic items / skins / boosters.
- Skill-based means provably-fair is simpler (player input is part of outcome) — but RNG still gates grab-strength variance.
- Same commit-reveal pattern can apply if we add an RNG-gated grip variance.

---

## 9. Build order & dependencies

Sequential within phase, sequential across phases (except 6.3 which is independent).

```
6.0.1 (ring expand) ──┐
6.0.2 (interior)  ────┤
6.0.3 (walk-in)   ────┼──> 6.0.4 (2D screen) ──> 6.0.5 (celebrate) ──> 6.0.6 (sound) ──> 6.0.7 (mobile) ──> 6.0.8 (arcade stub) ──> 6.0.9 (Nori) ──> 6.0.10 (docs)
6.0.2 needs casino.glb processing first
6.0.3 needs 6.0.2 (interior to enter)

6.1 starts after 6.0 passes acceptance
6.1.1 ──> 6.1.2 ──> 6.1.3 ──> 6.1.4 ──> 6.1.5 ──> 6.1.6 ──> 6.1.7 ──> 6.1.8 ──> 6.1.9

6.2 starts after 6.1 passes
6.2.1 ──> 6.2.2 ──> 6.2.3 ──> 6.2.4

6.3 is independent — can run in parallel with 6.1/6.2 once 6.0 ships
```

---

## 10. Per-concern team requirement

Per CLAUDE.md mandatory pattern: every concern runs **Implementer-Manager → Auditor-Manager → Fix → Re-audit** loop. 3D concerns (6.0.1, 6.0.2, 6.0.3, 6.0.8) spawn `3da`. Blender preprocessing for `casino.glb` spawns `blend007:mesh` (launching NEW Blender, never user's running instance).

Recursive teams required on: 6.1.1 (RNG correctness is load-bearing), 6.2.1 (Anchor contracts, custody), 6.2.3 (SOL/USDC tier routes).

---

## 11. Open operator questions (non-blocking)

1. **Arcade GLB path** — user said downloaded, not found in `~/Downloads` as of evening 2026-05-17. Confirm location.
2. **the Cove exterior shell** — interior GLB is interior-only. Options: (a) commission via blend007, (b) download CC0 from Sketchfab/Kenney, (c) placeholder cube with neon trim until commissioned.
3. **Final 12-reel assignment** — `3da` to recommend the cove + arcade placement based on visual flow + thematic grouping.
4. **Devnet treasury seeding (Phase 6.2 prereq)** — user said will fund. SOL + devnet USDC ATA.
5. **Mainnet timeline** — separate phase gate, audit + bankroll plan. Not in 6.2 scope.
6. **Sound assets** — record/produce custom OR pull from CC0 freesound.org? Show user picks before bundling.

---

## 12. Risks

| Risk | Phase | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Ring reposition breaks user data references | 6.0 | Low | High | Keep IDs stable; only geometry changes. Smoke test on existing avatars. |
| `casino.glb` scale wrong in-world | 6.0 | Med | Med | Blender preprocessing pass; 3da verifies via browser playtest. |
| Walk-in animation feels janky | 6.0 | Med | Med | Use existing pathfind. Iterate with screenshots. |
| Iris Xe crash in the cove interior | 6.0 | Low | High | 449 tris (trivially light). No shadows. No drei Text. No instanced ShaderMaterial. |
| return rate off-target due to paytable bug | 6.1 | Med | High | Monte Carlo CI gate blocks merge. |
| Wallet adapter UX confusion | 6.2 | High | Med | OpenSessionModal explains "one signature, then play freely" upfront. |
| RPC timeout on settle tx | 6.2 | Med | Med | Settle-pending cron + idempotent close handler. |
| Idle session escrow stuck | 6.2 | Low | High | 24h authority-close cron + player-cancel ix escape hatch. |
| Settlement authority key compromise | 6.2 | Low | Catastrophic | Same key as existing predict program — same KEK pipeline, no new attack surface. |
| Browser/server RNG impl drift | 6.1 | Med | High | Shared module imported by both, CI tests in both environments. |

---

## 13. What changes if KYC / geoblocking added later

Hooks left:
- `casinoEligibility` middleware stub in `apps/api/src/middleware/casino-eligibility.ts` — currently always `eligible:true`. Swappable to country / KYC threshold check without touching routes.
- `slot_sessions.currency` enum check at session-open time.
- `users.identity_pubkey` from Phase 5.1 is the natural KYC subject identifier.

---

## 14. Memory references

- [[project-the cove-reels]] — locked decisions, why 12-square / pokie / commit-reveal / hybrid escrow won.
- [[feedback-agpl-contamination]] — why cherry-charm was not chosen as code source.
- [[project-phase5_1]] — wallet identity rails for future KYC.
- [[feedback-pre-ship-browser-test-mandatory]] — browser playtest before merge.
- [[feedback-three-doc-standing-rule]] — same-diff doc updates required.
- [[feedback-town-guide-knowledge-sync]] — Nori must know about new gameplay.
- [[feedback-always-use-3da]] — 3D concerns must spawn 3da.
- [[feedback-collaborative-team-pattern]] — per-concern Implementer → Auditor → Fix → Re-audit loop.
- [[feedback-gpu-crashes]] / [[feedback-webgpu-instanced]] — Iris Xe constraints.
- [[feedback-blender07-scene-import-ban]] — blend007 launches NEW Blender, never user's running instance.
