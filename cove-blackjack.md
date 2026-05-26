# Phase 6.4 — Cove Blackjack (engine donor + multi-mode + bidirectional skill loop)

**Status:** PLANNING — not implemented. Plan-first per CLAUDE.md Rule E1; no code lands until user types explicit approval.
**Date:** 2026-05-25
**Branch:** `staging` (no worktree — main checkout).
**Blocks:** future cove card games (poker variants, baccarat). Blackjack establishes the multi-mode + skill-loop pattern they'll all reuse.

---

## 0. Decisions locked in chat 2026-05-25

| # | Decision | Locked? |
|---|---|---|
| 1 | Cove gets blackjack as the next game alongside slots. Solitaire (ffalt/mah — mahjong, not cards) parks at the **Claw Machine Arcade (Phase 6.3 building)** as a single-player skill drill, not a wagering game. | ✅ |
| 2 | Engine donor: **`mhluska/blackjack-simulator`** (MIT, 66★, no runtime deps, npm-published, clean engine/renderer split, ships with `basic-strategy-checker.ts` + `hi-lo-deviation-checker.ts` which ARE the agent skill content). Vendor as `packages/cove-blackjack-engine` so we can patch the `Math.random` site to inject commit-reveal seed. | ✅ |
| 3 | **One protocol, three participant types** at every table: hosted-loopback (Milady/Hermes on our box) · connected-WebSocket (Moltbook magic-link agent) · bot (house dealer + deterministic basic-strategy opponent + chaos opponent). All speak the same event/action schema. | ✅ |
| 4 | **Bidirectional skill loop.** For hosted agents we write hand outcomes into their ElizaOS memory via the existing `elizaRuntime.createMemory()` path (same pattern as `apps/api/src/routes/items.ts:252` book-learning flow). For connected agents we **offer** a pre-formatted `memory_recommendation` payload in the outcome event; their runtime ingests or ignores. | ✅ |
| 5 | **Modes & agent role** in protocol: `mode: 'control' \| 'autonomous'` + `agent_role: 'decider' \| 'advisor'`. In Control mode the agent is `advisor` — sends advice to chat bar, NEVER directly to the decision channel. | ✅ |
| 6 | **Advisor timer.** 8s base from `decision-required` event. Resets to 15s on any keypress detected client-side. On expiry: agent's advised action becomes the decision; if no advice was emitted, fall back to auto-stand. | ✅ |
| 7 | **Disconnect policy for real-money tables (option A).** Pre-hand disconnect = sit out, bankroll preserved. Mid-hand disconnect = 15s reconnect grace (matches advisor timer for protocol symmetry) → auto-stand at current total. Split/double already initiated → auto-stand on each sub-hand at current total; never initiate new doubles/splits without consent. WebSocket heartbeat ping every 5s, dead after 2 missed pongs (~10s) starts the grace. Anti-grief check: dropping connection costs you the hand you would have played, so no upside to bailing. | ✅ |
| 8 | **Currencies:** ClawTokens (fun-money tier, existing ledger) + SOL + USDC (real-money tier via `clawville_wager` Anchor program — bet-per-hand escrow, mirrors slots SOL/USDC ix pattern). | ✅ |
| 9 | **RNG.** Provably-fair commit-reveal shuffle. Server commits hash of `(server_seed + shoe_id)` pre-deal, reveals at end-of-shoe. Client seed optional. Inject revealed seed into engine's `Math.random` site (single-file swap inside vendored package). Same mechanism as slots' pokie seed injection. | ✅ |
| 10 | **What goes outbound to a connected agent**: only what a human at the felt would see — own hand, dealer upcard, dealt-card history since last shuffle (the count history), shoe penetration, available actions, bet amount, table rules. We do NOT auto-send dealer hole card before reveal. We do NOT auto-compute true count for the agent. Counting becomes a real skill they have to do themselves. | ✅ |
| 11 | **Matchmaking when skill is asymmetric** — start with "skill IS the moat" (no bracketing). Add ELO/brackets only when `/dash` data justifies it. | ✅ |
| 12 | **Inbound skill claim from external agents** — start with **C tier only** (observable play: agent plays N hands vs house bot, we measure adherence to basic strategy, write a baseline memory entry). Defer B tier (signed memory blob import) until C is proven. | ✅ |

---

## 1. PRODUCTION reference (per Rule E1)

Cove slots, currently live at `apps/web/src/app/cove/page.tsx` + `apps/api/src/routes/cove-slots.ts`. Walk-in → 3D click hotspot on slot machine mesh → 2D modal overlay opens (`SlotReels3D.tsx` / `SlotHUD.tsx` / `PaytableModal.tsx`) → spin via `POST /api/cove/slots/spin` → outcome rendered. Wager escrow via `clawville_wager` Anchor program for SOL/USDC tier; ClawToken ledger for fun-money tier. Commit-reveal RNG with verifier at `/cove/verify`.

Blackjack is the same shape with three deltas: (a) **per-hand decisions** instead of one-shot spin, requiring a stateful table → realtime channel; (b) **multi-seat** (≥1 player + dealer, optional other players/agents); (c) **bidirectional skill memory** as a first-class behavior, not just a bet-and-go.

---

## 2. SMALLEST visible diff that proves correctness (per Rule E1)

**The binary screenshot test:**

1. Player loads `/cove`, walks avatar to the blackjack table mesh (new click hotspot in the cove interior).
2. Click → 2D modal opens with a felt, dealer position, one player seat. Bet placed in ClawTokens.
3. Deal animation → player hand + dealer upcard render.
4. Player clicks **Hit** or **Stand** in modal. Decision sent. Dealer plays out. Outcome rendered. ClawToken bankroll updates.
5. Hand history line written to player's avatar's ElizaOS memory (verifiable via `npc_memories` table query or in-process probe — for hosted agents).
6. **All other phases (real money, connected agents, multi-seat, advisor timer, disconnect handling) are off-by-default until subsequent phases.**

If that one hand renders cleanly + the memory row appears in DB + the bankroll moves correctly, the slice is correct. The user eyeballs the modal vs the slots modal — same feel, different game.

---

## 3. GRANULARITY (per Rule E1)

| Concern | Granularity | Why |
|---|---|---|
| Game-engine state | **Per-hand** instance (`new Game()` per hand) | mhluska engine is designed this way; cheap to instantiate |
| RNG seed commit | **Per-shoe** (8 decks ≈ 416 cards) | Industry standard, matches commit-reveal cadence we want |
| Escrow / wager-program ix | **Per-hand** for real-money tier | Mirrors slots `bet → resolve` round-trip; one on-chain settle per hand outcome |
| Memory write | **Per-hand** for hosted, **per-hand event** for connected | Hand is the natural skill-event unit; per-decision would flood memory with low-signal entries |
| Table state machine | **Per-table** (long-lived WebSocket room) | Multi-seat requires shared state across participants |
| Chat-bar agent context | **Per-hand transcript** | Resets between hands so each hand is a fresh advisory loop |
| SKILL.md fetch | **Per-connect** (eager, version-tracked) | Per the three-surface rule just landed in CLAUDE.md |

---

## 4. PHASING

Each phase ships independently to staging → user visual verify → PR to master. No phase ships next until prior phase user-signed-off (per Rule E4).

### Phase 6.4.0 — Visual + flow shell (mock data, fun-money only)
- 3D click hotspot on blackjack table mesh inside cove interior GLB
- 2D modal: felt, dealer seat, single player seat, bet slider (ClawTokens only)
- Hand-rendering UI: card sprites, hit/stand buttons, bust/win celebration reusing slots' celebration components
- `POST /api/cove/blackjack/play-mock-hand` returns a deterministic mock outcome
- NO engine integration yet, NO memory writes, NO wager program
- **Screenshot test:** one mock hand plays end-to-end, bankroll moves by stub amount

### Phase 6.4.1 — Engine integration + hosted-agent skill memory (fun-money only)
- Vendor `mhluska/blackjack-simulator` as `packages/cove-blackjack-engine`. Patch `Utils.random` site to accept injected seed.
- Real `POST /api/cove/blackjack/{deal,hit,stand,double,split,surrender}` endpoints driving real engine
- Commit-reveal RNG: server commits shoe hash at session start, reveals on shuffle. Verifier UI mirrors slots' `/cove/verify`
- **Hosted-agent memory writes:** per hand, write a narrative+structured memory entry into the player's avatar's ElizaOS memory via `elizaRuntime.createMemory()` with `metadata.subtype: 'game-skill'`, `metadata.skill: 'blackjack'`, `metadata.subskill: 'hard-16-vs-10'` etc. After write, `agentOrchestrator.stopAgent()` so next chat reload sees it
- ClawToken ledger integration for bet/payout via `claw-token-ledger.transferClawTokens()` — NEVER direct write to `avatars.clawTokens`
- Chat-bar agent reads recent skill memories before each hand, advises in Control mode
- **This phase proves the skill loop AND the game in the same drop.** The brand-defining feature ships early, not last.

### Phase 6.4.2 — Connected-agent protocol + SKILL.md infra (closes the connection-SKILL.md infra gap)
- Define event schema (`hand-start`, `decision-required`, `hand-complete`, `shoe-shuffle`, etc.) + action schema (`hit | stand | double | split | surrender`) + advisor schema (`advice` chat-bar event)
- Build the global connection SKILL.md endpoint + content-hash manifest (closes the rule-3 infra gap from the three-surface rule)
- WebSocket route via existing `bun-ws-adapter.ts` plumbing (already used by Q2 Activity Portals)
- Magic-link handshake returns manifest + initial state
- `memory_recommendation` payload included in `hand-complete` events for connected agents to optionally ingest
- Heartbeat ping/pong + disconnect detection
- Skill-test-on-entry (option C from chat): connected agent plays 10 hands vs house bot, observed basic-strategy adherence written as baseline memory entry
- Bot opponents implement the same protocol (loopback)

### Phase 6.4.3 — Multi-seat tables + lobby
- Lobby creation: any agent/player creates a table, sets stake range, sets max seats, sets table rules (S17/H17, DAS, double-after-split, surrender on/off)
- Invite-link join + (later) friend/username join
- Multi-seat dealing order, simultaneous decisions, dealer plays after all seats stand
- Per memory hook: "lobby creator sets game parameters like wager amounts"

### Phase 6.4.4 — Real-money tier (SOL + USDC via wager program)
- 8 new wager-program ix mirroring slots pattern: `init_blackjack_hand_sol/spl`, `settle_blackjack_hand_sol/spl`, `cancel_blackjack_hand_sol/spl`, `disconnect_settle_blackjack_hand_sol/spl`
- TS client regen via Codama
- Wallet-adapter modals for player signing
- **Disconnect logic enforced HERE** (option A): 15s grace → auto-stand at current total → on-chain settle as if player had stood
- Modular SOL+USDC support per memory hook "single wagering architecture that natively supports both SOL and USDC in the same flow"
- Devnet end-to-end before mainnet flip

### Phase 6.4.5 — Polish + leaderboard integration
- Blackjack skill leaderboard (EV gained vs basic-strategy adherence) at `/leaderboard?game=blackjack`
- Town Guide's `knowledge[]` includes blackjack tutorial, table rules, skill loop explanation
- Cove-internal directory sign / Nori prompt nudges players to try blackjack after slots

---

## 5. TEAM composition + `team_name` (per Rule E1)

Per CLAUDE.md collaborative-team rule, each phase that touches code gets its own full team in one parallel dispatch. No team for this plan doc — orchestrator (Claude) wrote it; user approves.

| Phase | Team name | Composition |
|---|---|---|
| 6.4.0 visual shell | `cove-blackjack-shell-2026-05-25` | 3D team: `3da` × 5 (impl-1, impl-2, spec, regress, adversary) + `blend007:mesh` blender-inspect for click hotspot UV verification |
| 6.4.1 engine + hosted memory | `cove-blackjack-engine-2026-05-26` | Backend team: `general-purpose` × 5 (impl-1, impl-2, spec, regress, adversary). NO solana-auditor yet (no contract changes). NO codex-rescue at launch — invoked later only if impl-1 stuck. Reconciler-manager required (high-stakes: ClawToken money path) |
| 6.4.2 protocol + SKILL.md infra | `cove-blackjack-protocol-2026-05-27` | Backend team × 5. Reconciler-manager required (high-stakes: handshake auth + version manifest is across-axis load-bearing) |
| 6.4.3 multi-seat / lobby | `cove-blackjack-multiseat-2026-05-28` | Backend team × 5 |
| 6.4.4 real money | `cove-blackjack-real-money-2026-05-29` | Backend team × 5 + **`solana-auditor`** + **reconciler-manager** (mandatory for custody) |
| 6.4.5 polish | `cove-blackjack-polish-2026-05-30` | Light team (2 agents: impl + combined-lens auditor) |

Each phase team gets a self-contained prompt with: "use ultrathink reasoning before writing code", addressable team name + role + other members, blocking deps via `addBlockedBy`, hard constraints from CLAUDE.md (Iris Xe, same-diff doc updates, three-surface knowledge sync, Rule E4 no-shipped-without-signoff).

---

## 6. REVERT plan if user says "broken" after first attempt (per Rule E1)

Per phase:
- **6.4.0:** revert single PR. Leaves cove interior with no blackjack table click hotspot. Slots unaffected. Modal component deleted.
- **6.4.1:** revert engine integration PR but leave `packages/cove-blackjack-engine` vendored (it's just imports until something uses it). Remove route file, remove memory-write call site, restore mock endpoint. ClawToken bankroll un-touched in DB since transfers were on the now-gone path.
- **6.4.2:** WebSocket route deleted, SKILL.md endpoint deleted, manifest endpoint deleted. Connected agents fall back to "not yet supported." Hosted-agent loop from 6.4.1 still works.
- **6.4.3:** lobby route + multi-seat state-machine deleted. Single-seat from 6.4.1/6.4.2 still works.
- **6.4.4:** on-chain ix not yet mainnet → devnet redeploy with old IDL is safe. TS client regen rolled back. Wallet-adapter modal removed from UI. Fun-money tier (6.4.1) still works.
- **6.4.5:** revert is trivial — polish only.

DB: every phase's schema migration is reversible (additive only; no DROPs). Bet escrow rows for in-flight real-money hands at moment of revert get auto-stand resolution per the disconnect logic, so player funds always settle.

---

## 7. Same-diff doc updates per phase (per the three-surface rule + the three canonical docs)

| Phase | `town-guide.ts` `knowledge[]` | Connection SKILL.md | Hosted-agent skill memory inj | `3dStructure.md` | `GameFeatures.md` | `ARCHITECTURE.md` |
|---|---|---|---|---|---|---|
| 6.4.0 | New game in cove (Phase 1 stub) | n/a yet | n/a yet | New click hotspot mesh + position | New game section | n/a yet (mock route) |
| 6.4.1 | Skill loop explanation | n/a yet | NEW BAKE (first time) | n/a | Skill-memory section | New routes + DB tables |
| 6.4.2 | Connected-agent connect flow update | NEW MANIFEST + FULL CONTENT | UPDATE | n/a | Connected-agent section | WebSocket route + SKILL.md endpoint + manifest |
| 6.4.3 | Lobby flow | UPDATE (multi-seat events) | UPDATE | n/a | Lobby section | Lobby routes + tables |
| 6.4.4 | Real-money tier explanation | UPDATE (settle events + disconnect schema) | UPDATE | n/a | Real-money section | Wager-program ix + TS client + wallet modal |
| 6.4.5 | Polish-only sweep for accuracy | Version bump only | Version bump only | n/a | Polish notes | Leaderboard route |

Skip any column = unmergeable PR per the rule.

---

## 8. Open / deferred (revisit when /dash data warrants)

- **ELO / skill-bracket matchmaking** — deferred. Start with "skill IS the moat." Revisit if novice retention drops or if leaderboard becomes dominated by a few veteran agents.
- **Inbound signed-memory blob import (option B)** — deferred to post-6.4.5. Need a published portable schema + trust model first.
- **Voice chat at table** — deferred indefinitely. Not in brand priorities.
- **Side bets (insurance, even-money, perfect pairs)** — deferred to post-6.4.5. Engine supports them; UI/wager scope is separate.
- **Mahjong solitaire** — separate plan doc `arcade-mahjong-solitaire.md` for Phase 6.3 (the Claw Machine Arcade building).
- **Other card games (3-card poker, baccarat, video poker)** — separate plan docs. This blackjack plan deliberately establishes the multi-mode + skill-loop + protocol pattern they'll inherit.
- **PvP heads-up blackjack** — implementation falls out naturally from 6.4.3 multi-seat once seat-vs-seat settlement (no house edge) is wired. Could either fold into 6.4.3 or be its own micro-phase.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `mhluska/blackjack-simulator` Math.random injection site doesn't have a clean seam | low | Vendored copy in `packages/cove-blackjack-engine`; we patch it once. Engine has zero runtime deps → no transitive surprises |
| WebSocket protocol drift between hosted and connected agents | medium | The three-surface rule binds. Single shared event-schema TypeScript file in `packages/shared` consumed by both sides |
| Connected agent floods us with bad decisions to stress-test | medium | Per-session rate limit on action channel; reject malformed actions silently with `error` event |
| Skill-memory writes flood the ElizaOS RAG and degrade chat quality | medium | Per-agent skill-memory cap (e.g. keep most recent 500 hands + summarized aggregates); test in 6.4.1 |
| Counting via memory recall is so strong it breaks house edge | unknown | Real concern. Track house EV per shoe in /dash. If trending negative across a meaningful sample, change table rules (more decks, deeper cut, no resplit aces) BEFORE changing the skill loop |
| Disconnect attacks (player drops on bad hand to dodge double-bust risk) | low | Auto-stand at current total = same outcome as standing. No exploit |
| Real-money disconnect during split/double mid-bet creates unfunded position | medium | Per-hand escrow already includes the double/split bet at the moment of action; if connection dies before that action commits on-chain, the bet was never escrowed. Auto-stand resolves cleanly |

---

## 10. Approval gate

Per Rule E1, no `Edit`/`Write`/mutating-`Bash` against `apps/`, `packages/`, or `contracts/` until the user types one of: **approved · go · ship it · yes start**. Until then this plan doc is the only artifact. Doc edits to CLAUDE.md / AGENTS.md / memory files made in chat 2026-05-25 (the three-surface rule) are already in place.

When approved, phases execute in order, each gated by user visual signoff (Rule E4) before the next dispatches.
