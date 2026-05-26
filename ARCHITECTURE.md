# ClawVille — Architecture

> **Strict rule:** every code change that adds, removes, or repurposes a route,
> middleware, service, table, event type, or deploy mechanic MUST update this
> doc in the same diff. Reverse holds too. Mismatch is a bug.
>
> Companions: `WorldContent.md` (scene manifest), `3dStructure.md` (3D specs),
> `GameFeatures.md` (gameplay reference). This doc is the **tech** spine — if
> a question is "where does X happen in code", the answer is on this page.

**Last edit:** 2026-05-22 — NPC pathfinding collider-awareness fix. Server-side `apps/api/src/services/pathfinding.ts` rewritten to rasterize EVERY `getServerColliders()` AABB onto its 360×360 walkability grid (10 buildings + 8 town-center prop colliders) with per-axis tile pad = `ceil(halfX/32) + 4` instead of the old fixed `BUILDING_EXCLUSION_PAD = 11` (which under-covered messaging-channels/api-integrations halfX=850 wu = 26.5 tiles and ignored every prop AABB). Adds 3 new exports: `isCollisionFreeWorld(gamePxX, gamePxY, entityHalf)` (wraps `clampPosition2D`, returns true iff outside every AABB), `findNearestWalkable(gamePxX, gamePxY, entityHalf, maxRadiusPx=600)` (spiral-out snap to a point that passes BOTH the A* grid clearance AND the pixel-accurate AABB clamp), and `WORLD_COLLIDER_TILE_SIZE` re-export. `apps/api/src/services/npc-simulation.ts` adds `stuckTicks: number` to `NpcRuntimeState` (seeded 0 at both spawn sites + respawn) and a private `snapPlannerTarget()` helper. All six planners (`planVisitBuilding`, `planApproachNpc`, `planIdleNearHome`, `planWander`, `planCenterWander`, `planApproachNearbyNpc`) now wrap their candidate (tx,ty) in `snapPlannerTarget` BEFORE `findPath`, so a target that lands inside a prop AABB (e.g. shisha-oasis halfX=420 wu) gets snapped outward rather than committing to an unreachable path. `planApproachNpc` now picks an 80 wu stand-off pulled toward the chaser (attempt 0) before random angles (attempts 1-4), preventing chasers from landing on top of a target NPC parked against a wall. `moveNpcs` path-step branch and `moveTowardTarget` both track stuckTicks (increment on `clamped.hit` OR net move < 2 px, reset on real movement); ≥ 4 stuck ticks (≈ 800 ms at 5 Hz) → abandon path, clear destinationBuildingId, set activity=idle, behaviorCooldown=5-15. `moveTowardTarget` previously had NO abandon-on-clamp at all — its non-arena clamp call silently wedged NPCs forever once their `npc.path` emptied (planNpcBehaviors only re-plans on `activity === 'idle'`). Arena mode untouched (gated on `!this.arenaMode`). New `ENTITY_HALF_CHIBI`/`ENTITY_HALF_HUMANOID` constants moved from browser-only `apps/web/src/lib/three/collision/world-colliders.ts` to shared `packages/shared/src/constants/world-colliders-data.ts` so server code can import without the @/ alias. Prior: Concern 6.1.5 (Bundle B bonus mechanics): scatter + free-spin + multiplier-wild bolt-on for the casino slot engine. New `classic-3x5-bonus` paytable in `packages/shared/src/constants/slot-paytables.ts` (`BONUS_SYMBOLS` adds id 10 Scatter with `isScatter: true` + `payouts: [0,0,0,0]`; `BONUS_REEL_STRIPS` is 5×84 with 3 scatters per reel + WILD restricted to R1/R2; `CLASSIC_BONUS_PAYTABLE`/`SCATTER_PAY_TABLE`/`FREE_SPIN_RULES`/`WILD_MULTIPLIER_TABLE` exported through `@clawville/shared`). `slot-symbols.ts` adds `CLASSIC_SLOT_SYMBOL_ASSETS[10]` (s10.svg, 'Scatter', '#ffd778'). `MachineSlug` widened to `'classic-3x5' | 'classic-3x5-bonus'`. Engine (`apps/api/src/services/slot-engine.ts`): `buildBundle` discovers `scatterId` from `isScatter` flag (asserts at-most-one; refuses wild+scatter combo); `runSpin` runs a wild-multiplier draw pass after reel sampling on bonus paytables (one `sampleIntFromBytes(range=100)` per landed wild via `wildMultiplierForDraw`); scatter pay-anywhere computes `predict × SCATTER_PAY_TABLE[count]` and emits `AWARD_BASE`/`AWARD_RETRIGGER` free spins; `evaluateReels` accepts optional `EvaluateReelsOptions` with `wildMultipliers` + `freeSpinLineMultiplier`, applies wild-mult products to line wins only when supplied. `SpinResult` adds `wildMultipliers: WildMultiplier[]` + `scatterPayout: bigint`. **RTP-shape lock (2026-05-19 team-lead decision):** `FS_LINE_WIN_MULTIPLIER=1`, `FS_WILD_MULTIPLIER_DOUBLE=false`; wild multipliers apply only in FS mode (base records but doesn't amplify); 100k MC combined RTP = 96.38%, ~1 trigger per 90 base spins. Flags preserved (not deleted) so a future retune can re-enable. Engine byte stream byte-identical on `classic-3x5` (bonus pass gated by `scatterId !== null`). Route (`apps/api/src/routes/casino-slots.ts`): `POST /session/open` accepts both paytable ids; `POST /spin` derives `isFreeSpinSpin` from session pre-lock snapshot, skips predict debit on FS, leaves `totalStaked` unchanged on FS, updates `mode` + `freeSpinsRemaining` with `CAP_REMAINING=50` clamp, flips `mode='base'` when remaining hits 0; FOR-UPDATE re-check 409s on mode-changed-mid-flight (`session_mode_changed_retry`); `GET /paytables/:id` returns either bundle (bonus response includes `symbols[10].isScatter: true`); `POST /verify` accepts both ids. Wire types (`apps/api/src/routes/casino-slots.types.ts`): `SerializedWildMultiplier = { reelIndex, rowIndex, multiplier }`; `SerializedSpinResult` adds `wildMultipliers` + `scatterPayout`; `SpinResponse` adds `mode: 'base'|'free-spin'` + `freeSpinsRemaining`. Session DB schema (`packages/database/src/schema/casino.ts`) already had `mode` + `free_spins_remaining` + `wild_multipliers` jsonb + `scatter_payout` text columns — no migration needed. Tests: `slot-engine.test.ts` 67/67 pass (25 new Bundle B cases including `wildMultiplierForDraw` mapping, bonus bundle invariants, scatter-line-break, multiplier products, FS-vs-base equivalence, distribution within ±15pp band); `casino-slots.test.ts` 5 pass / 18 skip (DB-gated) — adds 4 Bundle B route tests for FS state machine + retrigger cap. RTP sim: `scripts/casino/rtp-sim.ts` adds `--paytable` flag + FS-budget drain loop with retrigger cap + separate base/FS/combined RTP accounting. `.github/workflows/rtp-gate.yml` adds second step running `--paytable classic-3x5-bonus --strict-rtp 0.955,0.995 --exit-on-fail` — band wider than local 1M target [96.5%, 99.5%] to absorb 100k MC trigger-chain variance. `.claude/plans/phase6-casino-slots.md` §6.5 rewritten to match shipped code (was `bet`-named + spec-literal doubling). Prior: Concern 6.1.8 (rename): casino slots wire field `bet` → `predict` end-to-end to align with the "Predictive Gaming Cove" public framing. DB column `slot_spins.bet` renamed to `slot_spins.predict` via `ALTER TABLE slot_spins RENAME COLUMN bet TO predict;` (in-place; 0 rows in prod at apply time). Drizzle schema, Hono Zod request/response schemas, engine `RunSpinArgs.bet → predict`, `evaluateReels(reels, paytableId, predict)`, route variables (`betBig → predictBig`, `betNumber → predictNumber`), error codes (`predict_must_be_positive`, `predict_exceeds_supported_range`, `predict_must_equal_session_reserved_predict`, `insufficient_clawtokens: need ${predictNumber}, ...`), idempotency-cache mismatch error string (`cached predict=X, new predict=Y`), all unit/route/RTP tests, frontend client (`OpenSlotSessionArgs.predict`, `SpinArgs.predict`, `SpinResponse.predict`, `VerifySpinArgs.predict`), verifier (`runSpinLocal({...predict})`, `perLinePredict`), HUD (`SlotHUDProps.predict`/`minPredict`/`maxPredict`/`onPredictChange`, `PREDICT_CHIPS`, "PREDICT" label, `cv-predict-chips-wrap` class), modal (`predict` state, `handlePredictChange`, `predictBn`), CLI (`--predict` flag, `DEFAULT` 100n, `predictFloat`), `VERIFICATION.md` curl example, `GameFeatures.md` + `ARCHITECTURE.md` doc strings all updated in same diff. `SpinResult` deterministic outputs UNCHANGED (pure rename — `(serverSeed, clientSeed, nonce, cursor, predict=20n)` still produces the canonical `reels=[[7,1,1],[1,3,0],[3,1,1],[1,4,3],[2,2,0]]`/`winAmount=55n`/`cursorAfter=20` fixture). UI component `BetChips` renamed to `PredictChips` (file + class + props + CSS class `cv-predict-chips-wrap`); accessible label reads "Predict size in ClawTokens". Migration SQL committed at `packages/database/migrations-manual/2026-05-19_rename_slot_spins_bet_to_predict.sql` for the deploy step. Prior: Concern 6.1.6 + 6.1.7 (slice 5): casino slots frontend wire-up + provably-fair verifier. Deleted `apps/web/src/lib/casino/mock-engine.ts`. New `apps/web/src/lib/casino/slot-api-client.ts` (TanStack Query hooks for `useOpenSlotSession`/`useSpin`/`useCloseSlotSession`/`useSlotSession`/`useSlotSessionSpins`/`useSlotPaytable`/`useVerifySpinRemote`; `Idempotency-Key` minted via `crypto.randomUUID()` per spin press, re-used on a single press's retries; BigInt stays string on the wire — only the `spinResponseToSpinResult` adapter promotes to bigint for `useFX`). New `apps/web/src/lib/casino/verifier.ts` (browser-safe WebCrypto port of `provable-rng.ts` + `slot-engine.runSpin`; exports `deriveBytes`/`sampleIntFromBytes`/`sha256Hex`/`runSpinLocal`/`evaluateReelsLocal`/`replaySpin`; HMAC keyed by `hexToBytes(serverSeed)` raw bytes, sha256 hashes UTF-8 of hex string — matches server convention byte-for-byte). New frontend routes `apps/web/src/app/casino/verify/page.tsx` (anonymous manual verifier — side-by-side local-vs-remote replay against `/api/casino/slots/verify`, green check or red flag with divergence reasons + `sha256(serverSeed)` recompute) and `apps/web/src/app/casino/verify/[sessionId]/page.tsx` (auth-gated owner-only per-session verifier — fetches all spins via `/session/:id/spins`, runs local `replaySpin` per row in nonce order, shows green/red verdict + commit-hash check; awaits Next.js 15+ async `params` via `use()`). `SlotScreenModal.tsx` rewritten: lazy-opens server session on first spin press (`useOpenSlotSession`), mints fresh idempotency key per press, displays `serverSeedHash` in a fairness chip below header + tooltip card with deeplink to `/casino/verify/<sessionId>`, cash-out triggers `useCloseSlotSession` and reveals seed. `casino.ts` Zustand store now mirrors server session metadata (`sessionId`/`serverSeedHash`/`clientSeed`/`revealedServerSeed`) instead of the deleted mock cursor. `SlotHUD` bet chips changed to `[20,40,100,200,500,1000]` (must be divisible by `CLASSIC_LINES.length=20` per slot-engine guard) and bet stepper now ±20 per click. Casino interior page (`/casino`) gets a top-right "🔐 Verify" `<Link>` to `/casino/verify`. Toast layer in modal dispatches on 400/401/403/404/409/429/501 via `describeCasinoError`. Browser-side test suite at `apps/web/src/lib/casino/__tests__/verifier.test.ts` (20 tests, all green) re-uses slice-1 hand-computed RNG fixtures (TV1/TV2/TV3/TV5/TV6) to prove WebCrypto byte-identity with Node `crypto`; `runSpinLocal` fixture matches server `runSpin` output byte-for-byte (`reels=[[7,1,1],[1,3,0],[3,1,1],[1,4,3],[2,2,0]]`, `winAmount=55`, `cursorAfter=20` for serverSeed=`'a'*64`, clientSeed=`'abcd1234'`, nonce=0, cursor=0, bet=20n). No new API routes (slice 5 is frontend-only); no new DB tables. Prior: Concern 6.1.5 (slice 4): Monte Carlo RTP gate + reel strip retune. New `scripts/casino/rtp-sim.ts` (1M-spin simulator, `--spins/--bet/--seed/--client-seed/--strict-rtp/--exit-on-fail` flags, reports RTP + hit freq + max win + histogram + per-symbol middle-row hit rate). New `.github/workflows/rtp-gate.yml` triggers on PRs touching `slot-paytables.ts`/`slot-engine.ts`/`provable-rng.ts`/`rtp-sim.ts` — runs 100k Monte Carlo, fails build if RTP ∉ [95.00%, 97.00%]. New fixture test `apps/api/src/services/__tests__/rtp-fixture.test.ts` (10k Monte Carlo, asserts [92%, 100%] inside `bun test`). Reel strips in `packages/shared/src/constants/slot-paytables.ts` retuned from L=80 (98.57% analytic / 98.54% sim) to L=84 with composition (C=22, L=22, O=14, P=14, B=7, +1 each high-pay) → 96.00% analytic / 95.89% sim @ 1M spins. Payout multipliers in `CLASSIC_SYMBOLS` UNCHANGED. Prior: Concern 6.1.3 + 6.1.4 (slice 3): casino slots fun-money backend wire. New schema `packages/database/src/schema/casino.ts` (`slot_sessions` + `slot_spins` tables, partial unique index for one-open-session-per-user, idempotency-key unique index per session). New routes `apps/api/src/routes/casino-slots.ts` mounted at `/api/casino/slots/*` — `POST /session/open`, `POST /spin` (Idempotency-Key header required, 60/min/user rate limit, atomic txn covers debit+spin+credit), `POST /session/close` (reveals serverSeed, refunds escrow), `GET /session/:id`, `GET /session/:id/spins`, `GET /paytables/:id` (public), `POST /verify` (public, pure compute). BigInt JSON via explicit `serializeSpinResult`/`serializeWinningLine` helpers in `apps/api/src/routes/casino-slots.types.ts` — NO `BigInt.prototype.toJSON` monkey-patch. ClawTokens currency live; SOL/USDC return 501. Tests at `apps/api/src/routes/__tests__/casino-slots.test.ts`. Prior: Concern 6.1.2: slot engine (server-side deterministic spin evaluator on top of provable-rng). Prior: Concern 6.0.4 polish pass: slot UI redesign. New frontend modules: `apps/web/src/lib/casino/useFX.ts` (5-tier FX state hook), `apps/web/src/styles/casino-tokens.css` (design-token CSS — palette, spacing, motion, shared keyframes), `apps/web/src/components/casino/ui/{NeonButton,NeonCard,NeonModal,BetChips}.tsx` (branded primitives), `packages/shared/src/constants/slot-symbols.ts` (`CLASSIC_SLOT_SYMBOL_ASSETS` manifest exported from `@clawville/shared`), `apps/web/public/assets/slot-symbols/s0..s7.svg` (ClawVille-themed reel art). Existing casino components refactored to consume tokens + primitives; SpinResult contract + mock engine + Zustand store unchanged. No new API routes, no DB changes. Prior: Concern 6.0.4 — 2D slot screen (mock data).
**Current drift note:** 2026-05-26 — NPC route contract tightened: `pathfinding.ts` emits raw tile-center waypoints and exposes segment/path validation through `clampPosition2D`; `npc-simulation.ts` resolves spawns through `findNearestWalkable`, rejects unsafe path segments before committing, and aborts any desired step into a solid AABB. `stores/npc.ts` treats connected SSE positions as authoritative even when idle.

---

## 1. System overview

```
Browser (Next.js)                          Hetzner CCX13 + Coolify
+----------------------------+             +----------------------------+
|  Next.js App Router        |             |  Hono API (Bun :4000)      |
|  +----------------------+  |             |  +----------------------+  |
|  | World3DCanvas (R3F)  |  |  REST/SSE   |  | Auth (Lucia)         |  |
|  | Three.js WebGPU      |<--------------->|  | Agent Orchestrator   |  |
|  +----------------------+  |             |  | NPC Simulation       |  |
|  +----------------------+  |             |  +----------------------+  |
|  | Zustand Stores       |  |             |  | ElizaOS Runtime      |  |
|  | (game, npc)          |  |             |  | (Gemini only)        |  |
|  +----------------------+  |             |  +----------------------+  |
|  +----------------------+  |             |          |                 |
|  | React UI Overlays    |  |             |  +----------------------+  |
|  | (chat, shop, HUD)    |  |             |  | PostgreSQL (Supabase)|  |
|  +----------------------+  |             |  | via Drizzle ORM      |  |
+----------------------------+             |  +----------------------+  |
                                           +----------------------------+
```

Frontend (`apps/web`): Next.js 16, React 19, R3F 9, Zustand. Entry: `app/game/page.tsx` → dynamically imports `World3DCanvas` (SSR disabled).

Backend (`apps/api`): Bun runtime, Hono 4 HTTP. Entry: `apps/api/src/index.ts`.

LLM: **Gemini only**. `plugin-anthropic` and `plugin-openai` were ripped out 2026-04-10 (ultrathink decommission). `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` aren't read anywhere.

---

## 2. Hono routes (`apps/api/src/routes/`)

| File | Mount | Purpose |
|---|---|---|
| `auth.ts` | `/api/auth/*` | Lucia signup/login/logout · `GET /api/auth/enter?t=<ticket>` (Phase 5 magic-link exchange) · `POST /api/auth/milady-session-exchange` · `POST /api/auth/guest` (un-authed visitor bootstrap, 5/min/IP rate-limited) · `GET /api/auth/me/agent-session` (UI hydration of agent liveness) |
| `avatars.ts` | `/api/avatars/*` | Avatar CRUD · `POST /api/avatars/me/heartbeat` · `POST /api/avatars/me/daily-login` · `GET /check-name/:name` (validates against `avatars.name` AND `users.username`) |
| `users.ts` | `/api/users/*` | Username system (2026-05-19) — `GET /check-username/:name` (public availability probe) · `PATCH /me/username` (Lucia-authed, 5/min/IP, 409 on collision). |
| `locations.ts` | `/api/locations/*` | 10-building zone metadata |
| `chat.ts` | `/api/locations/:id/chat`, `/api/chat/system/:slug` | Building chat (dynamic context injection) · system-agent chat (currently `town-guide` only; `503 Retry-After: 3` during boot race; reward rate-limited 1/60s per `(userId, slug)`) |
| `items.ts` | `/api/items/*` | Knowledge-book shop, inventory, buy, learn |
| `agent-gateway.ts` | `/api/agent/*` | The universal connect surface — see §6 |
| `portal.ts` | `/api/portal/*`, `/.well-known/clawville-issuer.json` | Phase 5.1 'scape portal — see §7 |
| `agent-export.ts` | `/api/agent/export-character` | Emits Eliza `Character` JSON + `SkillPack` + Milady install payload |
| `agent-setup.ts` | `/api/agent/setup/*` | Multi-agent roster + loadout (`MAX_AGENTS=1`) |
| `agent-v2.ts` | `/api/v2/agent` | Experimental alt-shape gateway |
| `openclaw.ts` | `/api/openclaw/*` | Legacy bot register/unregister/chat — UI tab removed but endpoint still accepts POSTs |
| `npc-sse.ts` | `/api/npc/*` | SSE stream of NPC sim state |
| `activity.ts` | `/api/activity/*` | Sidebar activity feed |
| `activities.ts` | `/api/activities/*` | Bumper Shells + Reef Race minigame queue, leaderboards, seasons |
| `casino-slots.ts` | `/api/casino/slots/*` | **Phase 6.1 slice 3 casino slots backend wire** (2026-05-19). Commit-reveal RNG + session escrow over `slot_sessions`/`slot_spins`. Surfaces: `POST /session/open` (Lucia auth — debits `predict` ClawTokens, returns `serverSeedHash` + `clientSeed`, NEVER reveals `serverSeed`), `POST /spin` (Lucia auth, `Idempotency-Key` header required, 60 spins/min/user — atomic txn debits predict + inserts spin row + updates session counters + credits winnings, idempotency replay short-circuits BEFORE engine), `POST /session/close` (Lucia auth — reveals `serverSeed`, refunds remaining `escrowAmount`), `GET /session/:id` + `/spins` (Lucia auth, owner-only, redacts `serverSeed` while `status='open'`), `GET /paytables/:id` (public, fed by `@clawville/shared` `CLASSIC_*` constants), `POST /verify` (public, pure compute — runs `runSpin` and returns serialized result). Currency stub: `currency: 'sol' \| 'usdc'` returns 501 `CURRENCY_COMING_SOON` until Phase 6.2 custody. BigInt wire format: every response converts bigint → string via `serializeSpinResult`/`serializeWinningLine` (`apps/api/src/routes/casino-slots.types.ts`). Events emitted: `casino.slots.session.opened`, `casino.slots.spin.executed`, `casino.slots.session.closed`. |
| `wager.ts` | `/api/wager/*` | **Wager lobbies + escrow** (2026-05-13). Wraps the deployed `clawville_wager` Anchor program (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` on devnet, config PDA `AbvtPhFtbQNQ9oT8vQumPEWDowRXibtPeLpmDvTz5i2a`, rake_bps=500). Surfaces: `POST /lobbies` (create — Lucia auth), `GET /lobbies` (list — public, filters: activityId, roomId, state, mine), `GET /lobbies/:idOrInviteCode` (single + players), `POST /lobbies/:id/join` (deposit + join, Lucia auth), `POST /lobbies/:id/lock` (admin/match-server), `POST /lobbies/:id/settle` (admin/match-server — body `{winnerAvatarId}`), `POST /lobbies/:id/cancel` (creator if `state='open'`; admin if in `('open','locked')`), `POST /lobbies/:id/refund` (per-player after cancel). Modes: `multiplayer` (real on-chain escrow), `solo-bots` (no escrow). Visibility: `public` / `private` / `friends` (latter two require `invite_code`). Rake snapshotted at create-time. FEATURE_GATE: `wager-spl-lobbies` (SPL routes refuse), `wager-mainnet-paid` (devnet-only RPC). |
| `research.ts`, `research-sse.ts` | `/api/research/*` | Article scrape + SSE thought-log |
| `claws.ts` | `/api/claws/*` | ClawToken balance + ledger (reads `claw_token_transactions`) |
| `bazaar.ts` | `/api/bazaar/*` | Fixed-price skill listings. **⏸ Writes paused** (503 since 2026-04-21) pending marketplace rework. |
| `marketplace.ts` | `/api/marketplace/*` | Free publish + upvote tier. **⏸ Writes paused.** |
| `auctions.ts` | `/api/auctions/*` | Timed skill auctions. **⏸ Writes paused.** Resolution interval still ticks but has nothing to resolve. |
| `quests.ts` | `/api/quests/*` | Quest board |
| `bounties.ts` | `/api/bounties/*` | Bounty board + reputation |
| `leaderboard.ts` | `/api/leaderboard*` | Two surfaces: legacy auth'd `/api/leaderboard` (in-game modal) · public `/api/leaderboard/agents` (Priority #3 free agent leaderboard, no auth, 60/min/IP, 60s cache). See §5. |
| `skills.ts` | `/api/skills/*` | `GET /api/skills`, `/:buildingId`, `/:buildingId/skill.md` — cached from `building_skills`, emits `skill_md.fetched` events |
| `dashboard.ts` | `/api/dashboard/*` | Admin-gated (`ADMIN_USER_IDS`). DAU, funnel, returning-day, collaboration, teacher-chat, buildings-by-visits. Consumed by `apps/web/src/app/dash/page.tsx`. |
| `admin-identity.ts` | `/api/admin/identity-recover` | Admin-gated stub at the `/identity-recover` path mounted under `/api/admin`. Returns 501. FEATURE_GATE: `admin_identity_recovery`. |

---

## 3. Middleware (`apps/api/src/middleware/`)

| File | Applied | What it does |
|---|---|---|
| `auth.ts` | Global `sessionMiddleware` on `app.ts` · per-route `requireAuth` | Resolves Lucia cookie → `c.get('user') / c.get('session')`. `requireAuth` throws HTTPException(401) when no session. **Cookie domain** (2026-05-22): both Hono (`apps/api/src/lib/auth.ts`) and Next.js (`apps/web/src/lib/auth.ts`) set `domain: '.clawville.world'` in production via `resolveSessionCookieDomain()`; override with `SESSION_COOKIE_DOMAIN` env var for staging. Dev keeps host-only. This eliminates the split-brain that 401'd `clawville.world/api/auth/me` for sessions minted by `api.clawville.world`. Recovery playbook in `docs/auth-security-recovery.md`. |
| `rate-limit.ts` | `/connect` (10/min/IP) · `/export-character` (CF-aware IP via `cf-connecting-ip`) · `/api/auth/guest` (5/min/IP) · `/api/leaderboard/agents` (60/min/IP) · `/api/leaderboard/reef-race/daily-best-lap` (60/min/IP — separate limiter) | `createRateLimiter` + `getClientIp` helpers |
| `admin-only.ts` | `/api/dashboard/*` | Reads `ADMIN_USER_IDS` env at module load. 401 if no user, 403 if not on allowlist. Must run AFTER `sessionMiddleware`. |
| `fingerprint.ts` | Every request | Populates `fp_hash` + `ip_prefix_hash` from sha256 of `FINGERPRINT_SECRET || raw_browser_fingerprint`. Module load throws if `FINGERPRINT_SECRET` is missing or <32 chars — crashes API boot rather than silently emitting unsalted hashes. |

---

## 4. Service layer (`apps/api/src/services/`)

| Service | Purpose |
|---|---|
| `agent-collaboration` | Agent ↔ agent consultation helper. Emits `agent.collaboration.turn` per consulted expert. |
| `agent-orchestrator` | Lazy-starts ElizaOS runtimes on first chat, auto-stops after 30 min idle. System agents (singletons) are exempt from the sweep. |
| `alert-error` | Itachi-debug Telegram bot. 1/60s collapse per `${source}::${message}` with suppressed-count suffix. Required env: `ITACHI_DEBUG_BOT_TOKEN`, `ITACHI_DEBUG_CHAT_ID`. Degrades to `console.warn` when creds missing. |
| `article-scraper` | Pulls + normalizes external articles into `research_articles`. |
| `auth-challenge` | Phase 5.1 in-memory nonce store for signed-challenge reconnect. 60s TTL, single-use, 10k-entry spam cap. Migrate to Redis when multi-pod. |
| `claw-token-ledger` | Canonical write path for `claw_token_transactions`. `transferClawTokens()` does the atomic 2-avatar transfer and emits `tokens.settled` on success. **Never bypass — never write `avatars.clawTokens` directly.** |
| `eliza-migrator` | Pre-migrates ElizaOS internal schema at boot (fixes v2 schema drift). |
| `event-logger` | `logEvent({...})` — single entry for every emitted event. Three-tier fallback: `events` → `event_write_failures` → console + Telegram. Never throws. Sanitizes payload keys that look sensitive. |
| `hermes-client` | Outbound bridge to user-hosted Hermes (OpenAI-compat). |
| `identity-service` | Maps `sha256('{type}:{key}')` → `users` row via `identity_fingerprint`. Phase 5.1 adds `generateIdentityKeypairForUser(userId)` — generates ed25519, envelope-encrypts, conditional UPDATE so race losers don't overwrite. |
| `keypair-vault` | AES-256-GCM wrap/unwrap for `wallets` + `vanity_keypairs`. v1 = direct (legacy), v2 = envelope (per-row DEK wrapped by Cloudflare-held KEK). `decryptWalletRow(row)` dispatches off `encryption_version`. |
| `memory-service` | RAG + embeddings helper for Eliza characters. |
| `milady-gateway` | Inbound dispatcher for Milady plugin traffic. |
| `npc-conversation-engine` | NPC ↔ NPC banter generator (Gemini direct, bypasses Eliza). |
| `npc-simulation` | Authoritative NPC-world tick + SSE fan-out. Default wanderers are identified by `NPC_DEFINITIONS.buildingId === ''`, constrained to the 900-2400wu town-commons annulus, spawned at planner-valid walkable points, and committed only to AABB segment-validated paths. |
| `openclaw-client` | Outbound bridge to a user-hosted OpenClaw gateway. |
| `openclaw-session-sweeper` | Phase 6 sliding 24h TTL on `openclaw_bots.session_expires_at`. Functions: `computeSessionExpiresAt`, `extendSessionTtl`, `expireSession`, `sweepExpiredSessions`. Wired into `apps/api/src/index.ts` boot + `gracefulShutdown`. |
| `pathfinding` | A* over the shared server collider AABB grid from `getServerColliders()`, matching the movement clamp used by NPC simulation. Emits raw tile-center waypoints and exposes segment/path validation against `clampPosition2D`. |
| `avatar-simulation-bridge` | Wires avatar state into the NPC-simulation tick. |
| `research-service` | Owns research stream (article fetch → Gemini summary → SSE). |
| `service-issuer` | Phase 5.1 singleton ed25519 keypair. `signPayload(body)` signs outbound partner calls. Loaded from `CLAWVILLE_SERVICE_ISSUER_SK` env, cached in memory. |
| `session-agent-map` | In-memory `sessionId → agentId` resolver. |
| `session-ticket-service` | Phase 5 magic-link CRUD. |
| `skill-generator` | Builds `building_skills.content` (SKILL.md) from templates + character data. |
| `system-agent-reward-limiter` | In-memory 60s cooldown per `(userId, slug)` for system-agent chat rewards. LRU 1000 entries, swept every 10 min. Single-pod only. |
| `system-npc-seeder` | Boot-time seeders, both idempotent: `ensureSystemAgents()` (world-wide system agents from `SYSTEM_AGENT_TEMPLATES`, today only `town-guide`) and `ensureSystemNpcs()` (10 building residents from `@clawville/agent-templates`). System agents protected from inactivity sweep. Lookups via `getSystemAgent(slug)` — never by name. |
| `wallet-service` | High-level wallet ops on top of `keypair-vault`. Phase 5.1 adds `ensureWalletWithFirstTimeSecret(subjectType, subjectId)` — idempotent, returns plaintext base58 secret **exactly once** when freshly inserted (only approved wallet-secret export channel). |
| `x402-config` | Phase 4 x402 merchant wallet config. |
| `xp-service` | Level/XP math + `avatars.level / xp / total_xp` updates. |
| `activity/sim/bumper-shells-sim` | 60Hz server-authoritative Bumper Shells. 8-body O(n²) collision, 6 power-ups, 15Hz deltas + 1Hz keyframes. |
| `activity/sim/reef-race-sim` | 30Hz server-authoritative Reef Race. ~6000wu oval, 12 checkpoints in fixed sequence, 3 laps, `MIN_LAP_MS=15s` discard, 90s soft / 120s hard timeout. |
| `activity/sim/reef-race-config` | Track + sim constants: `REEF_LAPS=3`, `REEF_CHECKPOINT_COUNT=12`, `REEF_TICK_HZ=30`, oval `REEF_TRACK_A=1100 × REEF_TRACK_B=700`. Pure helpers for centerline + checkpoint geometry. |
| `activity/anti-cheat/shared` | Game-agnostic validators: bounds, rate, magnitude clamps, `ValidationVerdict<T>` union. |
| `activity/anti-cheat/bumper-shells` | Bumper-specific validators. `MAX_SPEED=350`, 5-flag forfeit. |
| `activity/anti-cheat/reef-race` | Reef-specific: position/velocity/lap-time/checkpoint-sequence validators. Skip tracker (`3 skips/5s` → flag). `ReefFlagCounter` extends `BumperFlagCounter`, same 5-flag forfeit. |
| `activity/bots/bot-pool` | `BOT_POOL_CAPACITY=64`. Hydrates from `avatars` joined to `users WHERE email LIKE 'bot-%@bots.clawville.internal'`. `reserve(roomId, count)` / `releaseRoom(roomId)` / `rebindReservation(...)`. Pre-seeded by `scripts/seed-bot-pets.ts`. |
| `activity/bots/bot-controller` | `BotController.computeInput(roomState, dt) → BotInput`. `BOT_CONTROLLERS: Record<activityId, factory>` registry. |
| `activity/bots/bumper-shells-bot` | Heuristic Bumper bot — nearest-opponent ram + edge avoidance + ~30%/tick power-up roll. |
| `activity/bots/reef-race-bot` | Heuristic Reef bot — checkpoint-center aim + thrust modulation by heading mismatch + perpendicular-distance fallback. |
| `activity/reward-pipeline` | `issueRewardsForRoom({room, simResults})` settles LIVE→RESULTS. Placement tokens + first-play-of-day + Reef PB + +25% focus-aligned bonus, all in one `db.transaction(tx)`. Bots get `tokensAwarded=0`. Emits one `activity.match.placed` per participant. |
| `activity/activity-leaderboard-service` | `getLeaderboardSnapshot(activityId, window, limit, offset)` over `activity_results`. Windows: `daily | weekly | all | season`. Bots excluded via `subject_type != 'bot'`. 60s in-memory cache. |
| `activity/activity-season-service` | `ensureFirstSeason()` lazy-creates `2026-Q2-S1`. `getSeasonsCatalog()` returns `{active, past}`, 60s cache. |
| `activity/reef-race-personal-best-service` | Atomic compare-and-set upsert into `reef_race_personal_bests` via `INSERT ... ON CONFLICT DO UPDATE WHERE EXCLUDED.best_lap_ms < existing`. Indexed `dailyRank` scan in the same async chain. 5-min in-memory PB-ghost cache invalidated on every successful write. |
| `activity/reef-race-daily-best-service` | 60s cache for the public daily-best-lap leaderboard. Invalidated on every PB upsert. |
| `wager-program-client` | Anchor client wrapping `@clawville/wager-program` IDL (workspace package — IDL + PDA helpers). Module-scope `Connection` keyed off `SOLANA_RPC_URL` + lazy `loadSettlementAuthority()` (decrypts `treasury_wallets` row with `purpose='wager-settlement-authority'` on first use, caches in memory). Public methods: `createSolLobby` / `joinSolLobby` / `lockLobby` / `settleSolLobby` / `cancelLobby` / `claimSolRefund`. Tagged `WagerClientError` codes for HTTP mapping. Persists decoded Anchor logs to `lobby_events`. SPL variants stubbed behind `wager-spl-lobbies` gate. |
| `activity/wager-lobby-bridge` | Hooks `lockLobbyForRoom` into Bumper Shells + Reef Race `setLiveTransitionFn` (room → LIVE → auto-lock) and `settleLobbyForRoom` into `setEndedFn` (room → RESULTS → auto-settle using placement-1 avatar from `computeResults()`). Idempotent: re-lock/re-settle returns 409. Bot/no-show winner path logs `failed-settle` event and leaves lobby Locked. |

---

## 5. Observability + leaderboard

Every meaningful app action writes one row into `events` via `event-logger.logEvent()`. Three-tier fallback: `events` → `event_write_failures` → console + Telegram. `/dash` queries `events` exclusively.

### 5a. Event types

| Event | Source | Payload highlights |
|---|---|---|
| `agent.connected` | `POST /api/agent/connect` | `identityType`, `protocol`, `isReturning`, `miladyAgentId`, `hasGateway` |
| `agent.chat.turn` | `chat.ts`, `avatars.ts`, `agent-gateway.ts` | `chatType: 'avatar' \| 'location' \| 'character' \| 'building' \| 'system-agent'`, `messageLength`, `tokenAwarded` |
| `agent.collaboration.turn` | `agent-collaboration.ts` (one per consulted expert) | `sourceBuildingId`, `targetBuildingId`, `kind: 'cross-building-consultation'` |
| `skill_md.fetched` | `GET /api/skills/:b/skill.md` | `userAgent`, `referer`, `skillName`, `generatorVersion` |
| `building.visited` | `POST /api/agent/:s/visit-building` | `tokenAwarded`, `activity`, `knowledgeGained` |
| `tokens.settled` | `claw-token-ledger.transferClawTokens()` post-commit | `amount`, `fromAvatarId`, `toAvatarId`, `reason` |
| `identity.issued` | `POST /api/agent/connect`, `POST /api/agent/join` | `identityType`, `identityPubkey`, `via: 'connect' \| 'join'` |
| `identity.reconnected` | `POST /api/agent/reconnect` | `via: 'signed-challenge'` |
| `portal.scape.crossed` | `POST /api/portal/scape`, `POST /api/portal/mint-for-scape` | Outbound: `direction: 'clawville_to_scape'`, `principalId`, `worldCharacterId`, `ticketRefHash`, `ttlMs`. Inbound: symmetric. Companion `portal.scape.cross_failed` on fetch/partner error. |
| `portal.scape.linked` | `POST /api/portal/accept-scape-link` | `scapePrincipalPrefix` (16-char), `scapeDisplayName`, `linkCodeHash` |
| `activity.match.placed` | `reward-pipeline.ts` post-commit, one per participant | `activityId`, `subjectType: 'agent' \| 'bot' \| 'avatar'`, `placement`, `tokensAwarded`, `isGuest` |
| `agent.session.expired` | `openclaw-session-sweeper.sweepExpiredSessions` | `sessionId`, `expiredAt` |
| `agent.session.disconnected` | `POST /api/agent/disconnect` | `sessionId` |
| `auth.signup` / `auth.login` / `auth.logout` / `auth.login.failed` / `auth.password.reset` / `auth.magic_link.enter` / `auth.guest.created` / `auth.milady_session.exchanged` | `apps/api/src/routes/auth.ts` (2026-05-22) | `route`, `outcome`, `sessionId`. `auth.login.failed` carries `reason: 'no_user_or_no_hash' \| 'bad_password'` — pair with `fp_hash` + `ip_prefix_hash` to detect credential stuffing. |
| `exchange.listing.created` / `exchange.order.placed` / `exchange.order.submitted` / `exchange.order.confirmed` / `exchange.order.cancelled` / `exchange.listing.cancelled` | `apps/api/src/routes/exchange.ts` (2026-05-22) | `route`, `outcome`, `beforeBalance`/`afterBalance` for escrow steps, `amountCt`, `recipientAvatarId` on confirm. Pair with `claw_token_transactions` for the per-cent reconciliation in §3 of the recovery doc. |

### 5b. Free agent leaderboard

Public surface at `GET /api/leaderboard/agents`. No auth, 60/min/IP, 60s in-memory cache per window. Consumed by `apps/web/src/app/leaderboard/page.tsx`. Must stay in sync with `AGENT_SCORE_WEIGHTS` + `DAILY_CAPS` in `apps/api/src/routes/leaderboard.ts` AND the landing UI `WEIGHTS` table.

| Event | Weight | Daily cap | Notes |
|---|---|---|---|
| `agent.collaboration.turn` | 40 | 50 | Priority #3 signal — highest single event |
| `agent.chat.turn` | 10 | 50 | MiladyAI teacher chat — the learning event |
| `identity.issued` | 5 | n/a | One-time per agent, wrapped in `MAX(...) * 5` |
| `building.visited` | 3 | 10 | One-shot, easy to script |
| Unique `agent.connected` session | 1 | none | Counted via `COUNT(DISTINCT session_id)` |
| `skill_md.fetched` | 1 | 11 | A curl is not engagement |
| `activity.match.placed` 1st | 12 | shared 10 | Placement counts share a single per-day cap; per-tier weighting preserved by proportional scaling when total > 10 |
| `activity.match.placed` 2nd | 6 | shared | |
| `activity.match.placed` 3rd | 3 | shared | |
| `activity.match.placed` other | 1 | shared | Participation tier |

**Player tier (no agent):** parallel `avatar_daily` CTE pulls events where `agent_id IS NULL AND avatar_id IS NOT NULL`. Same math, tagged `subject_type='avatar'`. Disjoint sets — never double-counted.

**Anti-farm:** every event row carries `fp_hash` + `ip_prefix_hash` from sha256 of `FINGERPRINT_SECRET || browser-fp` / `... || ip_first_3_octets`. `LEAST(count, cap)` per `(event_type, subject, day)`.

**Window param:** whitelisted enum `24h | 7d | 30d | all` mapped to interval literal via `sql.raw` AFTER the whitelist check, never user-interpolated.

---

## 6. Agent connection (Moltbook pattern)

External agents connect via an agent-initiated flow — human never pastes credentials.

```
Human                          ClawVille API                    AI Agent
  |-- POST /api/agent/connect-token ---->|                         |
  |<-- { token, connectUrl } ------------|                         |
  |-- paste connectUrl into agent chat ----------------------->     |
  |                                 |<- GET /api/skills/connect ---|
  |                                 |-- SKILL.md ----------------->|
  |                                 |<- POST /api/agent/connect ---|
  |                                 |    { connectionToken }
  |                                 |-- { sessionId, agentId } -->|
  |-- poll /connect-status/:token ->|                              |
  |<-- { connected: true } ---------|                              |
```

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/agent/connect-token` | Generate 5-min connection token | `clawville_session` cookie |
| GET | `/api/agent/connect-status/:token` | Frontend polls | none |
| GET | `/api/agent/connect-skill?token=xxx` | SKILL.md for agents (aliased `/api/skills/connect`) | none |
| POST | `/api/agent/connect` | Universal agent registration. Accepts `connectionToken`, `agentId`, or `miladyAgentId`. First call returns Phase 5.1 `identity` + `wallet` blocks. | token or identity |
| POST | `/api/agent/join` | Lighter-weight join (no connect token); same Phase 5.1 first-call response shape | identity |
| GET | `/api/agent/challenge` | Issue nonce for signed reconnect | none, rate-limited |
| POST | `/api/agent/reconnect` | Signed-challenge auth, mints session ticket | signature |
| POST | `/api/agent/disconnect` | Ed25519-signed logout | signature |
| GET | `/api/agent/session-status?agentId=` | Liveness probe — 200 / 410 / 404 | none, 60/min/IP |
| GET | `/api/agent/:s/perception` | World perception (self + nearby + conversations + combats) | session-resolved |
| POST | `/api/agent/:s/move`, `/chat`, `/visit-building`, `/building/:b/chat`, `/combat-action`, `/emote` | NPC actions | session-resolved |
| GET | `/api/agent/:s/knowledge`, `/stats`, `/events` (SSE) | Read-side | session-resolved |

**Identity types:** `openclaw | ironclaw | nanoclaw | milady | custom | anonymous`
**Wire protocols:** `openai-compat | anthropic | custom-webhook | nanoclaw` (pull-based SSE)

---

## 7. Auth phases (5, 5.1, 6)

### Phase 5 — agent-issued magic link (`b527636`)

Agent mints a one-time login URL for its human operator without password/OAuth.

- Table `agent_session_tickets`: 32-byte token, 5-min TTL, `consumed_at`.
- Service `session-ticket-service.ts`.
- Exchanger `GET /api/auth/enter?t=<ticket>` (`auth.ts:188-229`). Validates → marks consumed → mints Lucia cookie → 302 to `/game`. Expired/consumed → 302 with `?error=expired-link` → `ExpiredLinkBanner` on landing.

### Phase 5.1 — wallet identity + 'scape portal

Three keypair roles per user, all ed25519:

```
users.id (UUID PK, stable)                  ← identity handle; never rotates
├── identity keypair
│    pub: users.identity_pubkey             ← rotatable
│    priv (primary): agent config           clawville:identity:<userId>
│    priv (backup):  users.identity_encrypted_sk (envelope-encrypted, support recovery only)
│    purpose: sign reconnect challenges; derives portal principalId
│
└── avatar wallet keypair (Solana)
     row: wallets{subject_type='avatar', subject_id=avatar.id}
     pub: wallets.public_key                ← mirrored to avatars.walletAddress
     priv (server): wallets.encrypted_secret_key  (envelope-encrypted under CF KEK)
     priv (human):  shown ONCE in first-connect response
     priv (agent):  never holds
     purpose: holds $CLAWVILLE; server signs custodially
```

Plus a **service issuer keypair** (singleton). Private key in Cloudflare Secrets Store; public published at `GET /.well-known/clawville-issuer.json`. Signs outbound partner calls.

**Reconnect (signed-challenge):** `POST /api/agent/challenge` → nonce → `POST /api/agent/reconnect { userId, nonce, signature: ed25519.sign(nonce, identityPrivKey) }` → mint session ticket. Wallet key never involved.

**Atomic identity bootstrap:** `UPDATE users SET identity_pubkey=$1, ... WHERE id=$2 AND identity_pubkey IS NULL RETURNING`. Race losers get `needsHumanReauth: true`.

**Envelope encryption (`keypair-vault.ts`):** each encrypted secret has a random 32-byte DEK; DEK is wrapped by Cloudflare-held KEK via the Worker at `CLOUDFLARE_WORKER_URL` (POST `/wrap`, `/unwrap`, bearer-authed). Hetzner never sees plaintext KEK.

**Portal (ClawVille → 'scape):** `POST /api/portal/scape` → server builds canonical-JSON body → signs `sha256(body)` with service issuer SK → POSTs to `SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature` → emits `portal.scape.crossed` → returns `{ redirectUrl }`.

**Portal ('scape → ClawVille):** `POST /api/portal/mint-for-scape` — verifies `X-Scape-*` against `PARTNER_PUBKEYS.scape` allowlist env var, mints Phase 5 magic-link ticket.

**Account link (existing 'scape user):** `POST /api/portal/scape-link-code` (Lucia-authed) → user pastes in 'scape → `POST /api/portal/accept-scape-link` → consumes `pending_account_links` row atomically.

### Phase 6 — per-user building-character memory isolation (`51e97cb`)

Every user gets an isolated memory partition with each building character. One ElizaOS runtime per character; partitioned rooms per `(userId, locationId)`.

- Primitive `characterRoomId(locationId, userId) → UUIDv5` in `packages/agent-runtime/src/room-scoping.ts`. Namespace `8f3b1b27-5f2a-4a8d-9c1d-2e7b4d1f6a9c`.
- Read/write gate: `processMessage` in `@clawville/agent-runtime` keys every memory lookup on the derived `roomId`. Legacy string `roomId`s are ignored.

---

## 8. Database schema (`packages/database/src/schema/`)

All 35 schema files re-exported from `schema/index.ts`. **Single source of truth for column types — this table is a summary.**

| Table | Purpose |
|---|---|
| `users` / `sessions` | Lucia auth. Phase 5: `identity_fingerprint`. Phase 5.1: `identity_pubkey/encrypted_sk/iv/tag/dek_wrapped/encryption_version`, plus 'scape `scape_principal_id / scape_world_character_id / linked_scape_*`. Guest auto-create: `is_guest`, `guest_expires_at`. **Username (2026-05-19):** `username VARCHAR(20) UNIQUE`, check constraint `users_username_format = '^[a-zA-Z0-9_]{3,20}$'`. Seeded from `avatar.name` on first `POST /api/avatars`; editable via `PATCH /api/users/me/username`. Independent from `avatar.name` thereafter. See `GameFeatures.md §14a.bis`. |
| `agent_session_tickets` | Phase 5 magic-link store. 32-byte token, 5-min TTL, `consumed_at`. |
| `avatars` | One per user. Identity/species/color/archetype/stats/position. Phase 2: `model_key`, `agent_category`, `harness` (NOT NULL + CHECK). Guest: `is_guest`. |
| `avatar_inventory` | Knowledge books owned per avatar (quantity). |
| `map_locations` | 10 static building zones (seeded). |
| `location_agents` | Per-user agent config at each location. |
| `platform_agents` | ElizaOS agent records. System agents use `type='system-agent' + customization.slug=<slug>`. Partial unique index `platform_agents_system_singleton`. |
| `platform_agent_logs` | Agent activity logs. |
| `openclaw_bots` | External agent identity, gateway, learned knowledge, session count, `session_expires_at` (Phase 6 sliding 24h TTL). |
| `agent_configs` | Export/import bundles. |
| `building_skills` | Compiled SKILL.md cache keyed by `buildingId`. Served from `/api/skills/:b/skill.md`; rebuilt by `skill-generator`. |
| `npc_memories` | NPC convo memory for `npc-conversation-engine`. |
| `activity_log` | Append-only feed for sidebar. |
| `research_articles` | Cached external scrapes. |
| `wallets` | Unified `subject_type ∈ {avatar, agent, treasury}`. Encrypted Solana keypairs. Phase 5.1 envelope: `dek_wrapped`, `encryption_version` (1=legacy, 2=envelope). Dispatcher in `keypair-vault.decryptWalletRow`. |
| `treasury_wallets` | Phase 4 x402 merchant supply + vanity set. Coexists with `wallets` for legacy rows. `treasury_purpose` enum extended 2026-05-13 to include `'wager-settlement-authority'` — the ed25519 keypair the API uses to sign wager lobby lock/settle/authority-cancel txs against the `clawville_wager` program. |
| `vanity_keypairs` | Pre-generated vanity public keys, encrypted at rest. |
| `token_launches` | Per-agent token launches (Phase 4). |
| `claw_token_transactions` | **Canonical ClawToken ledger** — append-only. Every credit/debit goes through `claw-token-ledger.transferClawTokens()`. |
| `bazaar_listings`, `bazaar_transactions`, `bazaar_reviews` | Fixed-price skill listings + settled buys + ratings. ⏸ Writes paused. |
| `published_skills`, `skill_upvotes` | Free-tier publish + upvote. ⏸ Writes paused. |
| `auctions`, `auction_bids`, `auction_agent_configs` | Timed skill auctions + bid history + snapshotted agent configs. ⏸ Writes paused. |
| `quests`, `quest_submissions`, `quest_rewards` | Quest board + submissions + payouts (links to `claw_token_transactions`). |
| `bounties`, `bounty_rewards`, `bounty_attempts`, `bounty_reputation` | Community bounties + payouts + attempts + reputation rollup. |
| `events` | **Metrics spine.** Append-only. Cols: `id bigserial, ts, event_type, user_id FK, agent_id, avatar_id FK, building_id, session_id, payload jsonb, fp_hash, ip_prefix_hash`. Indexes on `(event_type, ts)`, `(agent_id, ts)`, `(avatar_id, ts)`, `(building_id, ts)`. |
| `event_write_failures` | Safety net for the metrics spine. Persists attempted row + error on primary insert failure. Partial index on unretried rows. |
| `pending_account_links` | Phase 5.1 one-time codes for existing-'scape-user linking. 10-min TTL. Consumed atomically by `POST /api/portal/accept-scape-link`. |
| `reef_race_personal_bests` | One row per `(avatarId, activityId)`. Cols: `bestLapMs`, `bestLapRecordedAt`, `sourceRoomId`, `ghostReplayData jsonb`. Composite index on `(best_lap_recorded_at DESC, best_lap_ms ASC) WHERE activity_id='reef-race'`. |
| `activity_results` | Per-participant match outcome. Cols include `matchBestStreak`, `matchPbDailyRank`, `acknowledged_at`. |
| `activity_seasons` | Q2-Q3 season catalogue. UNIQUE on `name`. |
| `activity_rooms` | One row per match. Persisted on PENDING → COUNTDOWN. `status: 'countdown' \| 'live' \| 'completed' \| 'aborted' \| 'aborted_crash'`. `started_at` / `ended_at` set on the LIVE / RESULTS transitions. |
| `activity_room_participants` | Per-participant rows for an `activity_rooms` row. Holds `avatar_id`, `subject_type`, joined/left timestamps, the per-room loadout snapshot. |
| `activity_queue_entries` | Matchmaking queue rows. `activity_id`, `avatar_id`, `subject_type`, `queued_at`. Cleared on match or leave-queue. |
| `activity_parties` | Pre-formed parties (e.g. group queue with friends). Drives matchmaker grouping. |
| `activity_replays` | Recorded match frames for post-game playback (currently used for Reef Race ghost replays). |
| `lobbies` | Per-match wager lobby. `lobby_id bigint UNIQUE` mirrors the on-chain seed (sequence `wager_lobby_id_seq`). State machine: `'open' → 'locked' → 'settled' | 'cancelled'` enforced via CHECK constraint. `activity_id` + `room_id` link to existing activity infra. `visibility` `'public' | 'private' | 'friends'`; `'private'` / `'friends'` use `invite_code`. `mode` `'multiplayer' | 'solo-bots'` (solo-bots skips escrow entirely). `wager_amount_lamports = 0` = free lobby. On-chain tx sigs tracked per state transition (`on_chain_{create,lock,settle,cancel}_sig`). |
| `lobby_players` | One row per joiner per lobby. UNIQUE `(lobby_id, user_id)` mirrors on-chain Player PDA. Tracks `deposit_amount_lamports`, `refunded` flag, `on_chain_join_sig` + `on_chain_refund_sig`. |
| `lobby_events` | Audit log keyed off `(lobby_id, occurred_at desc)`. `kind` enum: `created | joined | locked | settled | cancelled | refunded | cleanup`. `raw_event_json` holds decoded Anchor event when available. |
| `cosmetic_skus` / `cosmetic_variants` / `avatar_skins` | Q3 Phase 3.3 cosmetic engine. `cosmetic_skus` is the catalog, `cosmetic_variants` holds per-rig assets (sunglasses-on-Milady ≠ sunglasses-on-lobster), `avatar_skins` is the ownership ledger + equipped flag. Scope-aware (`scope='avatar' \| 'all' \| 'activity:reef-race'`). License-attribution columns for CC-BY assets. |
| `dashboard_phases` | Q3 plan §10 dashboard phase tracking — which phases of the gamification rollout are live / staged / gated. |
| `tutorial_quest_claims` | Append-only ledger of which avatars claimed which tutorial quests + when. Source for §13b progression analytics on `/dash`. |
| `slot_sessions` | **Phase 6.1 slice 3** (2026-05-19) — one row per "sit down at a slot machine." Holds commit-reveal pair (`server_seed` redacted while `status='open'`, `server_seed_hash` published at open), engine cursor (`nonce_counter`, monotone `cursor_counter`), money accounting (`starting_balance`, `current_balance`, `escrow_amount`, `total_staked`, `total_won` — all `text` so bigint precision survives), state machine (`status: open\|closed\|expired`), bonus-mode state (`mode: base\|free-spin`, `free_spins_remaining` integer; LIVE since 6.1.5). **Partial unique index** `slot_sessions_user_open_unique` (where `status='open'`) enforces at-most-one open session per user — race-safe even under concurrent `/session/open` calls. |
| `slot_spins` | **Phase 6.1 slice 3** — every spin within a session, full audit trail for the public verifier. RNG inputs (`nonce`, `cursor_before`, `cursor_after`) + outputs (`reels`, `winning_lines` jsonb, `win_amount` text) + idempotency (`idempotency_key`). Unique index `(session_id, idempotency_key)` is the race-safe backstop for retried `POST /spin`; duplicates throw 23505 and the route falls back to the cached row. |

`avatars.characterConfig` (JSONB) stores resolved archetype + learned knowledge.

---

## 9. State (`apps/web/src/stores/`)

| Store | Holds | Notes |
|---|---|---|
| `game.ts` | `controlMode`, `avatarPosition`, `avatarSpeed`, `movementDirection`, `nearLocation`/`nearCharacter` (proximity-to-character), `currentLocation`/`currentCharacter` (active chat target), `chatOpen`, `possessedNpcId`, `hasAgent`, `isSpectator`, `agentConnected`/`agentSessionId`/`agentConnectModalOpen`, building visit tracking (localStorage) | `controlMode: 'explore' \| 'npc' \| 'player' \| 'autonomous'`. `avatarPositionRef` is the per-frame ref shared with R3F. |
| `npc.ts` | Per-NPC position/direction/species/color/HP/combat/inventory, chat bubbles (with expiration), openclaw flags | Mutates positions IN PLACE (`npcFieldsEqual` excludes x/y/direction). React only sees identity changes. See `WorldContent.md` §3 for the canonical roster. |
| `activity.ts` | Per-activity room state, chat log, `selfStreak`, `lastMatchPbDelta`, `lastMatchStreakBest`, `lastMatchDailyRank`, `reefRace.selfBestGhostPath`, `errorBanner` | Driven by activity WS hub. Bumper Shells + Reef Race. |
| `quest.ts` | Quest tracker UI state | |
| `thoughtlog.ts` | Research SSE stream buffer | |

---

## 10. Control modes

| Mode | WASD | Camera | Use case |
|---|---|---|---|
| Explore | Pan camera | Free orbit | Browse world without an avatar |
| Player | Move avatar | Follows avatar | Normal gameplay (requires agent) |
| NPC | Move possessed NPC | Follows NPC | Control any NPC (no agent required) |
| Autonomous | Disabled | Follows agent | Watch AI agent play |

Toggle via `<ControlModeToggle>`. Without agent → Explore/NPC. With agent → Player/Autonomous.

---

## 11. NPC simulation

- 9 default wandering NPCs (Milady, Hermes, chibi, one crustacean) roam the town commons; server pathing keeps them inside the 900-2400wu free-roam annulus and away from central prop/building-ring AABBs.
- Each building has a dedicated location NPC at its entrance.
- Server-authoritative simulation (`npc-simulation.ts`) streams state to clients via SSE (`npc-sse.ts`). Spawn points are resolved through `findNearestWalkable`; accepted paths must pass `isPathCollisionFree`; a desired step into a solid AABB aborts/replans instead of clamp-sliding.
- Client-side wander (`stores/npc.ts`) takes over when disconnected. When connected, every SSE position is authoritative, including idle frames.

See `WorldContent.md` §3 for the canonical roster.

---

## 12. Deployment

Two Hetzner VPS hosts since the 2026-05-23 migration. Both orchestrated by Coolify, Cloudflare in front for DNS/CDN/DDoS. Real IPs, SSH keys, and app UUIDs in `scripts/deploy/.env.deploy` (gitignored — `PROD_VPS_IP=…` + `STAGING_VPS_IP=…`).

| Env | App | Coolify App ID | Git branch | Port | Domain |
|---|---|---|---|---|---|
| prod    | web | 3 | `master`  | 3000 | `clawville.world` (+ `new.clawville.world`) |
| prod    | api | 2 | `master`  | 4000 | `api.clawville.world` (+ `api-new.clawville.world`) |
| staging | web | 4 | `staging` | 3000 | `staging.clawville.world` |
| staging | api | 3 | `staging` | 4000 | `api-staging.clawville.world` |

SSH keys: PROD = `~/.ssh/clawville_hillsboro` (passphrase — load into Windows ssh-agent once), STAGING = `~/.ssh/clawville_deploy`. Coolify admin UIs: prod `https://coolify-new.clawville.world`, staging `https://coolify-staging.clawville.world`.

DB: Supabase Postgres (external, paid tier — endpoint in env). **Single instance shared across prod + staging** — any staging write touches prod data. Wallets / encryption keys / fingerprint secret are byte-identical between environments by design (makes staging a 30s DNS-swap rollback target).

**Push flow (set 2026-05-24):** `git push origin staging` → `.github/workflows/deploy-staging.yml` → STAGING Coolify (apps 3+4). Verify on staging URLs. Open PR `staging → master` via `gh pr create --base master --head staging`. Merging triggers `.github/workflows/deploy.yml` → PROD Coolify (apps 2+3). **Direct push to `master` is forbidden** unless the commit message contains the literal phrase `direct to master` (case-insensitive hotfix override, CI-logged). Manual redeploys via `php artisan tinker` queue inside the Coolify container — pattern in `CLAUDE.md` "Manual redeploy" section. Full playbook + emergency access in `DEPLOY-HETZNER.md`.

**Migrations:** Coolify does NOT run them. Run `bun run db:push` from root before deploy if you touched `packages/database/src/schema/*.ts`. Destructive migrations require `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.

**Testing rule:** never `bun run dev` locally — Three.js/WebGPU crashes Intel Iris Xe and requires a PC restart. Always push → Coolify deploys → test on prod URL.

**Curl note:** Git Bash on Windows uses schannel and rejects CRLs — always pass `--ssl-no-revoke`.

---

## § i18n

UI locale layer landed 2026-05-22 (Phase 1+2). English + Simplified Chinese ship; ja/ko are allow-listed but the JSON files have not been authored yet.

- **Allowlist:** `LOCALES = ['en','zh-CN','ja','ko']` exported from `packages/shared/src/constants/locales.ts` and mirrored at `apps/web/src/i18n/locales.ts` (client-bundle copy — same constants, identical `isLocale` type guard). Source-of-truth note in both files instructs same-diff edits.
- **Cookie:** `cv_locale` — `sameSite=lax`, `httpOnly=false` (client needs to read it for the language switcher and to ship it with chat fetches), `max-age=1y`, `path=/`. No `/[locale]/` URL prefix — the cookie is the sole locale signal so SEO-affecting URL shape stays stable.
- **Middleware:** `apps/web/middleware.ts` — runs on everything except `/api/*`, `/_next/static`, `/_next/image`, `favicon.ico`, and file requests. If the cookie is unset, parses `Accept-Language` (q-sorted, exact match before language-prefix fallback) and seeds the cookie. The middleware never rewrites the URL.
- **Request config:** `apps/web/src/i18n/request.ts` is wired via `createNextIntlPlugin('./src/i18n/request.ts')` in `apps/web/next.config.mjs`. It reads the cookie via `await cookies()` (Next 16 async API) and validates with the shared `isLocale()` guard before falling back to `DEFAULT_LOCALE='en'`. Messages load dynamically as `(await import(\`../../messages/${locale}.json\`)).default`.
- **Source dictionary:** `apps/web/messages/en.json` is namespaced (`common`, `lobby`, `nori`, `sidebar`, `tutorial`, `chat`, `loading`). 158 keys total at shipping time. Translation script `scripts/i18n/translate-with-gemini.ts` is the canonical regenerator — runs `gemini-2.5-flash` at `temperature=0`, enforces a brand-term + ICU-placeholder validator, fails closed on violation. The validator block at the bottom of the script is the same logic that gates manual translations.
- **Chat-route locale plumbing:** Phase 2 added an optional `locale` field to the Zod input of every system-prompt-emitting chat route — `apps/api/src/routes/{chat.ts,chat-transient.ts,agent-gateway.ts,openclaw.ts}`. Each route calls a per-file `buildLocaleAddendum(locale)` helper (English baseline returns `""`; non-English emits "respond in <language>" + a brand-term carve-out covering ClawVille, ClawTokens, Nori, OpenClaw, Hermes, Milady, Moltbook, Reef Race, Bumper Shells, and the 10 building names). The addendum is appended to `dynamicContext` (chat.ts, agent-gateway.ts, openclaw.ts) or to the inline `systemPrompt` string (chat-transient.ts).
- **Prompt-injection guard:** the Zod schema refines `locale` via shared `isLocale(v)`. Anything outside the allowlist (including `'pirate'`, `'en; ignore previous instructions'`, etc.) is rejected before the prompt is built.
- **Client cookie reader:** `apps/web/src/lib/api.ts::readClientLocale()` parses `document.cookie` and validates against `LOCALES`. The 4 chat-mutating fetches (`sendChat`, `sendSystemChat`, `openclawChat`, `openclawLocationChat`) all wrap their bodies with `{ ...body, locale: readClientLocale() }`.
- **Language switcher:** `apps/web/src/components/game/sidebar-menu.tsx` adds a `LanguageRow` in the SYSTEM category. On change the row rewrites the `cv_locale` cookie with the new value and calls `window.location.reload()` (full reload required so the server-side `getRequestConfig` re-runs against the new cookie).
- **Brand glossary:** `ClawVille, ClawTokens, Nori, Milady, Moltbook, Reef Race, Bumper Shells, OpenClaw, Hermes, ElizaOS, The Depths, SOL`, the 10 building names + 2 Phase-6 props (`Predictive Gaming Cove`, `Patrick's Rock`). Lives both in the translation script (post-translation validator) and in the chat-route addendum string.
- **Town Guide:** orientation bullet under `packages/agent-templates/src/locations/town-guide.ts` knowledge[]. Future locales add another orientation bullet, not a new section.

---

## 13. Recent material changes

Compact log. Single line per change with commit hash + one-line summary. When the change is described in detail in the body above, no need to repeat it here.

- 2026-05-22 — NPC pathfinding made collider-aware. `apps/api/src/services/pathfinding.ts` rasterizes every `getServerColliders()` AABB (10 buildings + 8 props) onto the walkability grid with per-axis pad `ceil(half/32)+4`, replacing the fixed `BUILDING_EXCLUSION_PAD=11` that under-covered messaging-channels/api-integrations and ignored all town-center prop AABBs (shisha-oasis, bazaar-stall, auction-podium, quest-bounty-pavilion, marketplace-stall, town-directory-sign, quest-npc, town-guide). New exports `isCollisionFreeWorld()` + `findNearestWalkable()` + `WORLD_COLLIDER_TILE_SIZE`. `apps/api/src/services/npc-simulation.ts`: new `stuckTicks` field on `NpcRuntimeState`, private `snapPlannerTarget()` helper applied to all 6 planners, abandon-on-clamp added to `moveTowardTarget` (previously path-step had it but direct-target walkers did not — silently wedged forever), stand-off-toward-chaser in `planApproachNpc`. Arena mode gated and unchanged. New shared constants `ENTITY_HALF_CHIBI`/`ENTITY_HALF_HUMANOID` re-exported from `world-colliders-data.ts` (server cannot import the browser-only client file). `bunx tsc --noEmit -p apps/api` exit 0; `-p packages/shared` exit 0; web typecheck no new errors related to these files.
- 2026-05-22 — i18n Phase 1+2 (en + zh-CN). `next-intl 4.x` wired via `apps/web/next.config.mjs` (`createNextIntlPlugin('./src/i18n/request.ts')`) + new `apps/web/middleware.ts` (Accept-Language negotiation against `['en','zh-CN','ja','ko']` allowlist, seeds `cv_locale` cookie — sameSite=lax, httpOnly=false, 1y max-age, no `/[locale]/` URL prefix). `apps/web/src/i18n/{locales.ts,request.ts}` + shared `packages/shared/src/constants/locales.ts` (mirrored — `LOCALES`, `LOCALE_NAMES`, `DEFAULT_LOCALE`, `isLocale`). 6 components extracted to `useTranslations`: `lobby-landing`, `nori-button`, `sidebar-menu` (adds a Language dropdown in the SYSTEM section), `tutorial-overlay`, `chat-panel`, `sea-loading-screen`. Source dict `apps/web/messages/en.json` (158 keys across 7 namespaces). zh-CN translation produced manually and validated against the brand-glossary + ICU-placeholder asserts in `scripts/i18n/translate-with-gemini.ts` (the script will re-generate it once Gemini billing is restored — `temperature=0` + brand-term + placeholder validators, fails closed on violation). Phase 2: each of the 4 chat routes (`apps/api/src/routes/{chat,chat-transient,agent-gateway,openclaw}.ts`) accepts an optional `locale` field on its Zod schema, validated via shared `isLocale()`. Each appends a "respond in ${LOCALE_NAMES[locale]}" addendum to the system prompt / dynamicContext when locale ≠ 'en'; the addendum names brand terms (ClawVille, ClawTokens, Nori, OpenClaw, Hermes, Milady, Moltbook, Reef Race, Bumper Shells, 10 building names) as English-only. Web client reads `cv_locale` cookie via `apps/web/src/lib/api.ts::readClientLocale()` and ships it on every chat fetch. Town Guide knowledge `packages/agent-templates/src/locations/town-guide.ts` gains one orientation bullet announcing language support. No DB schema change.
- 2026-05-19 — Concern 6.1.6 + 6.1.7 (slice 5): casino slots frontend wire + verifier UI. `apps/web/src/lib/casino/mock-engine.ts` DELETED. New `slot-api-client.ts` (TanStack Query — open/spin/close/session-detail/session-spins/paytable/verify hooks; `Idempotency-Key = crypto.randomUUID()` per spin press; BigInt as string on wire). New `verifier.ts` (WebCrypto port of `provable-rng` + `slot-engine.runSpin`; HMAC keyed by `hexToBytes(serverSeed)` raw bytes, sha256 over UTF-8 of hex string; identical bytes to server). New routes `/casino/verify` (anonymous manual replay form, local-vs-remote side-by-side, sha256 commit recompute) and `/casino/verify/[sessionId]` (auth-gated owner-only — re-derives every spin in a closed session, green/red per row, commit-hash check). `SlotScreenModal.tsx` rewired: lazy-open session on first spin, fairness chip + tooltip with deeplink, cash-out reveals seed, toast for 4xx/501. `SlotHUD` bet chips now `[20,40,100,200,500,1000]` (must be divisible by 20). `casino/page.tsx` gets top-right "🔐 Verify" link. `casino.ts` Zustand now tracks server session metadata. Tests at `apps/web/src/lib/casino/__tests__/verifier.test.ts` (20 pass) — TV1/TV2/TV3/TV5/TV6 byte-identity + `runSpinLocal` byte-identity (`reels=[[7,1,1],[1,3,0],[3,1,1],[1,4,3],[2,2,0]]`, `winAmount=55`, `cursorAfter=20`). No new API routes, no new DB tables.
- 2026-05-19 — Concern 6.1.5 (slice 4): Monte Carlo RTP CI gate + reel strip retune. New `scripts/casino/rtp-sim.ts` — 1M-spin simulator on top of `runSpin` + `CLASSIC_PAYTABLE`; flags `--spins <n>`, `--bet <n>`, `--seed <64hex>`, `--client-seed <hex>`, `--strict-rtp <lo>,<hi>`, `--exit-on-fail`; reports RTP + hit freq + max win + 6-bucket histogram + per-symbol middle-row hit rate. 1M spins in ~11s, 100k in ~1.1s on Iris Xe baseline. New `.github/workflows/rtp-gate.yml` — triggers on PR touching `slot-paytables.ts`/`slot-engine.ts`/`provable-rng.ts`/`rtp-sim.ts`/`rtp-gate.yml`; runs 100k Monte Carlo under `--strict-rtp 0.95,0.97 --exit-on-fail`; band wider than local 1M acceptance band [95.5%, 96.5%] to absorb CI-runner Monte Carlo stderr. New fixture test `apps/api/src/services/__tests__/rtp-fixture.test.ts` (10k spins inside `bun test`, asserts [92%, 100%] band + hit-freq sanity + max-win sanity ceiling — catches gross drift on every `bun test` run). Reel strips in `packages/shared/src/constants/slot-paytables.ts` retuned from L=80 third-pass (98.57% analytic / 98.54% sim — over-paying) to L=84 fourth-pass with per-reel composition (Cherry=22, Lemon=22, Orange=14, Plum=14, Bell=7, +1 each of BAR/Seven/WILD/BAR×2/BAR×3) → 96.00% analytic / 95.89% sim @ 1M spins (within ±0.5% target). Payout multipliers in `CLASSIC_SYMBOLS` and the engine itself (`slot-engine.ts`, `provable-rng.ts`) UNCHANGED — only reel strip CONTENTS rebalanced. Strip generator and analytic search helpers were used during tuning but deliberately not committed (one-shot scripts). Tuning rationale (in source comment): Plum 16→14 + Bell 9→7 + Cherry/Lemon 17→22 cuts the Plum-2 (-3.3% RTP) and Bell-2 (-2.5%) contributions; Cherry/Lemon 2-of-kind goes up only ~+5% combined because their 2× multiplier is half of Plum's 4×.
- 2026-05-19 — Concern 6.1.3 + 6.1.4 (slice 3): casino slots fun-money backend wire. New `packages/database/src/schema/casino.ts` — `slot_sessions` (partial unique index on `(user_id) WHERE status='open'`) + `slot_spins` (unique `(session_id, idempotency_key)`). Money columns as `text` so future lamport/µUSDC precision survives. New `apps/api/src/routes/casino-slots.ts` mounted at `/api/casino/slots/*` — open/spin/close/list/paytables/verify. Single-transaction spin path: row-locks session FOR UPDATE, asserts pre-engine counter snapshot still current (concurrent-spin guard), debits bet via `claw-token-ledger`, inserts spin row (idempotency-key 23505 maps to cached replay), updates session, credits winnings. ClawTokens currency live; SOL/USDC → 501 `CURRENCY_COMING_SOON`. Wire bigint serialization in `apps/api/src/routes/casino-slots.types.ts` (`serializeSpinResult` + `serializeWinningLine`) — NO `BigInt.prototype.toJSON` monkey-patch (rationale: global side effects bite event-logger sanitization + third-party deps). User-scoped (not IP-scoped) rate limit at 60 spins/min via in-process bucket. Events: `casino.slots.session.{opened,closed}` + `casino.slots.spin.executed`. Tests at `apps/api/src/routes/__tests__/casino-slots.test.ts` — paytable + verify run unconditionally; lifecycle tests gated on `DATABASE_URL`. Schema `bun run db:push` deferred to deploy environment (local has no DATABASE_URL per testing rule).
- 2026-05-18 — Concern 6.1.2: slot engine. New `apps/api/src/services/slot-engine.ts` (deterministic spin evaluator consuming `sampleIntFromBytes`; exports `runSpin` / `evaluateReels` / `getPaytableBundle`; bigint `winAmount` throughout; rejects bet not divisible by lineCount; `buildBundle` invariant assertions — positional symbol ids, line-row range, payouts length — guard against malformed paytables and are exported `@internal` for negative-test coverage). 40+ unit tests in `__tests__/slot-engine.test.ts` (37 prior + 4 new buildBundle-guard regressions, less 1 deleted placeholder). Zero new deps — pokie deliberately not pulled in (rationale in module docstring). Wire format: 5 reel samples × `sampleIntFromBytes`(range=stripLen=40); cursor advances ~20 bytes per spin (no rejection at this range). Cursor overflow guard lives once in slice 1's `deriveBytes`; engine layer trusts that with a code comment.
- 2026-05-18 — Concern 6.1.1: provably-fair RNG core. New `apps/api/src/services/provable-rng.ts` (commit-reveal HMAC-SHA256 — `createServerSeed` / `sha256Hex` / `deriveBytes` / `sampleIntFromBytes` with unbiased rejection sampling). Test vectors hand-computed against Node reference crypto in `apps/api/src/services/__tests__/provable-rng.test.ts` (35 passing). Zero new deps — Node `crypto` stdlib only. Pure functions, byte-deterministic across machines for replay verification. Next slice wires this into pokie's `RandomNumberGenerator` interface.
- 2026-05-18 — Concern 6.0.4 polish pass: slot UI redesign. `apps/web/src/styles/casino-tokens.css` (palette, spacing, motion, shared keyframes). `apps/web/src/lib/casino/useFX.ts` (5-tier FX state machine, bigint-safe tier derivation, prefers-reduced-motion honored). `apps/web/src/components/casino/ui/{NeonButton,NeonCard,NeonModal,BetChips}.tsx` (branded primitives). `packages/shared/src/constants/slot-symbols.ts` exported from `@clawville/shared` (`CLASSIC_SLOT_SYMBOL_ASSETS`). 8 SVG assets at `apps/web/public/assets/slot-symbols/`. Existing 5 casino components refactored to consume new tokens + primitives + FX hook. SpinResult contract + mock engine + Zustand store untouched. Frozen Phase 6.1 swap-in remains clean.
- 2026-05-18 — Concern 6.0.4: 2D slot screen (mock data, no backend). New modules: `apps/web/src/lib/casino/types.ts` (SpinResult/WinningLine contract frozen for Phase 6.1), `apps/web/src/lib/casino/mock-engine.ts` (outcome-forcing, Math.random only), `apps/web/src/stores/casino.ts` (Zustand: session balance/PnL/spin state), `apps/web/src/components/casino/{SlotScreenModal,SlotReels,SlotHUD,WinCelebration,PaytableModal}.tsx`. `packages/shared/src/constants/slot-paytables.ts` added (reel strips, 8 symbols, 20 paylines — publicly verifiable). `casino-interior.tsx` hotspot onClick wired to `openSlotScreen`; `casino/page.tsx` mounts `<SlotScreenModal />`. No new API routes, no DB changes, no real money.
- 2026-05-18 — Concern 6.0.3: New `components/transitions/SceneTransition.tsx` (rAF fade overlay, `useTransitionStore` Zustand store). No new API routes, no DB changes. Walk-in/walk-out flow wires `/game` ↔ `/casino` via `triggerTransition({ to, onMidway })`. Mid-fade state update uses `useGameStore.getState()` + `avatarPositionRef` direct mutation (zero React overhead).
- 2026-05-18 — Concern 6.0.2: New frontend-only route `app/casino/page.tsx` + `CasinoCanvas.tsx` + `casino-interior.tsx` + `CasinoLighting.tsx`. No new API routes, no DB changes. Draco GLB load via `three/addons/loaders/DRACOLoader.js` (Google CDN decoder).
- 2026-05-13 — Wager lobbies + escrow vertical slice merged from `worktree-gambling-contracts`. `clawville_wager` Anchor program live on devnet (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG`, rake_bps=500, config PDA `AbvtPhFtbQNQ9oT8vQumPEWDowRXibtPeLpmDvTz5i2a`). New `@clawville/wager-program` workspace package (IDL + PDA helpers). 3 new tables (`lobbies` / `lobby_players` / `lobby_events`) + `wager_lobby_id_seq` sequence + `treasury_purpose='wager-settlement-authority'` enum value. 7 new `/api/wager/*` routes wrapping Anchor signer service. Match-server bridge auto-locks on room → LIVE + auto-settles on room → RESULTS for Bumper Shells + Reef Race. Reusable `<LobbyLanding>` FE component gates 3D scene mount on every activity match page. New env vars: `SOLANA_RPC_URL`, `WAGER_SETTLEMENT_AUTHORITY_PUBKEY`, `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH`, `WAGER_PROGRAM_CLUSTER` (all set on Coolify api id 3 for devnet). Feature gates: `wager-spl-lobbies` (SPL routes refuse — schema-ready), `wager-mainnet-paid` (devnet-only RPC), `treasury-envelope-encryption` (treasury_wallets stays on v1 VANITY_ENCRYPTION_KEY until next rotation).
- 2026-05-13 — `269c56d` — building ring expanded 68 → 72 tiles (R = 2176 → 2304wu) for inner-band breathing room after decoration retune. All 10 building zone tile coords recomputed in `tilemap-data.ts`. Audit re-run: 60/60 decorations placed cleanly with +4 props in the 1500-2500wu inner band (6 → 10).
- 2026-05-13 — `c46e26d` — world-3d deadweight cut + scatter decoration retune: `DECO_INNER_EXCLUSION_R` 2700 → 1500, `TARGET_COUNT` 30 → 60, `MAX_VISIBLE_DIST` 4500 → 3800, sand `bumpFreq` 0.15 → 1.5, seaweed sparse-band acceptance 0.25 → 0.5. Removed dead `UnderwaterAtmosphere`/`UnderwaterLightRays` imports, duplicate `<TownDirectorySign />` mount, orphan `trail-renderer.tsx`.
- 2026-05-13 — `ae271b7` — pet → avatar rename completed across migration history + meta snapshots + `apps/promo-videos` Remotion app. Live DB audit confirmed zero pet-named objects post-migration.
- 2026-05-12 — `40e7ed4` — new canonical doc `WorldContent.md` + `CLAUDE.md` bidirectional sync rule. This doc's restructure into a tight manifest landed same-day.
- 2026-05-08 — Pets → Avatars rename pass. Table `pets` → `avatars`, `pet_inventory` → `avatar_inventory`, `pet_id` → `avatar_id` everywhere, `wallet_subject_type` enum `'pet'` → `'avatar'`, route `routes/pets.ts` → `routes/avatars.ts`, all `/api/pets/*` HTTP paths → `/api/avatars/*`, store fields `petPosition`/`petSpeed` → `avatarPosition`/`avatarSpeed`. The `avatar_type` / `avatar_url` columns kept their names — "avatar" there means the visual asset format (`glb`/`vrm`).
- 2026-04-29 — Reef Race SPEC 3 ramps shipped. `event.ramp_launch` added to `ServerFrame` union; tangent/normal-basis AABB collision in `resolveRamps()`; 500ms per-body cooldown; client `lastRampLaunchEvent` slice. No schema change.
- 2026-04-28 — Free agent leaderboard Q3 rebalance — weights retuned, daily caps added, avatar-keyed UNION for Player tier.
- 2026-04-25 — Reef Race Phase 4 — PB persistence (`reef_race_personal_bests` table), streak counter (`event.streak_milestone` at `[5,10,20,30,36]`), Lobster of the Day daily leaderboard (`GET /api/leaderboard/reef-race/daily-best-lap`), match-end summary. Reward pipeline awaits PB upsert before tx commit so dailyRank embedded in match-end frame is deterministic.
- 2026-04-24 — Reef Race Phase 3 — stat-driven body multipliers from `pets.level + pets.archetype` via `loadRacingProfiles`. `setLiveTransitionFn` widened to `Promise<void> | void`. Anti-cheat `REEF_KINEMATIC_TOLERANCE` 2.0 → 2.1.
- 2026-04-24 — Phase 6 — Agent Session Liveness + ClawVille Orientation Skill. `openclaw_bots.session_expires_at` (24h sliding TTL). New endpoints `GET /api/agent/session-status`, `POST /api/agent/disconnect`, `GET /api/auth/me/agent-session`. New shared `CLAWVILLE_ORIENTATION_KNOWLEDGE` consumed by town-guide template + `pets.ts:buildCharacterConfig` + `agent-export.ts:buildSkillPack`.
- 2026-04-23 — Guest avatar auto-create. `POST /api/auth/guest` (idempotent, 5/min/IP). `users.is_guest`, `guest_expires_at`, `avatars.is_guest` (additive migration `0004_guest_pet_columns.sql`). Brand carve-outs: guests excluded from agent leaderboard, per-activity leaderboards, and `/dash` teacher-chat metric.
- 2026-04-21 — Phase 5.1 — wallet identity + 'scape portal shipped. 4 new event types, `/api/portal/*` + `/api/agent/{challenge,reconnect}` + `/.well-known/clawville-issuer.json`. New `pending_account_links` schema; `users.identity_*` + `users.scape_*` + `users.linked_scape_*`; `wallets.dek_wrapped` + `wallets.encryption_version`. Cloudflare Secrets Store for crypto root-of-trust. New services `service-issuer`, `auth-challenge`.
- 2026-04-21 — Metrics spine. `events` + `event_write_failures` tables. `dashboard.ts` route module at `/api/dashboard`. `event-logger`, `alert-error`, `admin-only` services. 6 event types emitted at 7 sites. `bazaar.ts`/`marketplace.ts`/`auctions.ts` writes stubbed to 503 pending marketplace rework.
- 2026-04-10 — Ultrathink decommission. `plugin-anthropic` and `plugin-openai` ripped out. Gemini providers only (text + embedding).

Older history: `git log apps/api/ apps/web/src/lib/three/ packages/database/`.
