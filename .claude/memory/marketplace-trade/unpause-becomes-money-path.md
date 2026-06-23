---
name: unpause-becomes-money-path
description: "Un-pausing the bazaar/auctions is a brand-new CT money path — the full checklist (ledger-only + idempotency anchor + E5 parity on write AND read + agent action surface/PROTOCOL bump + 3 knowledge surfaces + adversarial team + live staging smoke); never a quiet middleware delete. Includes the E5 gap, the no-idempotency gap, the auction resolver going live, and the agent-action bypass."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: unpause-becomes-money-path
description: Un-pausing the marketplace is a brand-new CT money path — the full graduation checklist; never a quiet middleware delete. Aggregates the E5 gap, idempotency gap, resolver-goes-live, and agent-action bypass.
category: constraint
confidence: 0.9
date: 2026-06-22
---

# Un-pause = a brand-new CT money path

**State: OPEN (latent until un-pause). All gaps below verified absent in code a4daf0d8.**

Lifting the 503 gate is NOT a cleanup — it turns the bazaar + auctions into REAL CT money paths overnight. It ships ONLY with the full contract, never a quiet `use('*')` removal.

## The 11-point un-pause checklist
1. **Ledger-only settle** — bazaar buy + auction escrow/refund/settle via `claw-token-ledger` debit/credit passed the route tx; NEVER write `avatars.clawTokens` directly. (The paused code already settles correctly through the ledger — bazaar.ts:743/751, auctions.ts:143/775/785/940/950/963 — keep it.)
2. **Atomic settle** in ONE `db.transaction` (bazaar atomic `UPDATE…WHERE status='active' RETURNING` claim; auctions FOR UPDATE).
3. **Idempotency anchor — MISSING GAP.** No client `Idempotency-Key` + DB partial-unique row exists; race-safe (status-flip + FOR UPDATE) but NOT replay-safe. Add the cove pattern (`Idempotency-Key` header + `(listingId|auctionId, idempotencyKey)` partial-unique index; 23505 aborts the tx, re-read outside as a replay). See cove `conservation-and-idempotency-patterns`.
4. **E5 parity on the WRITE path — MISSING GAP.** Every handler is `requireAuth` human-only (grep returns ZERO `requireAuthOrAgentSession`/`resolveAgentSession`/`getSubject` in the domain). Resolve `{user,agent}` (agent session → bound avatar), no guest fallback on a money route (guest → 403). Mirror `items.ts`, NOT `exchange.ts` (same human-only gap).
5. **E5 parity on the READ path — MISSING GAP.** Mirror the resolver on `/my-purchases`, `/my-bids`, `/my-listings` so an agent's bought skills / live bids don't vanish from its own view (the exact Cove getSubject write-vs-read bug, fixed PR #159).
6. **Owner checks** preserved (seller-only cancel/PATCH; self-buy/self-bid blocked; foreign 403/400).
7. **Conservation** preserved (bazaar buyer-debit == seller-credit + 15% fee sink; auction escrow ↔ refund ↔ 85% settle; resolver atomic claim prevents the double-settle faucet).
8. **The auction resolver goes LIVE.** `auctionResolver.start()` (auctions.ts:226) is already running un-gated; un-pausing bids makes every escrowed bid resolver-settleable on the next 10s tick. Audit `resolve()` conservation first. See `[[auction-resolver-ungated]]`.
9. **The agent buy action.** Reconcile `buy-bazaar-listing.ts` reachability with the un-pause + replace its compensating refunds with one `db.transaction`. See `[[agent-action-bypasses-gate]]`.
10. **Agent action surface** — expose buy/bid/list via `tools.json` whitelist + `[ACTION:]` executor (`npc-simulation.ts`) + `skill-protocol.ts` + a `PROTOCOL_VERSION` bump (crosses the protected `agent-protocol-partner` Hatcher surface → Codex adversarial pass + mock-Hatcher harness).
11. **3 operational-knowledge surfaces + docs + a PARITY note** — Nori `town-guide.ts knowledge[]` + connection SKILL.md + hosted-runtime announce the un-pause same-diff; ARCHITECTURE.md/GameFeatures.md; PARITY note 'human path: <endpoint/UI>; agent path: <endpoint/action>; settlement binds to <avatar resolution>'.

Then: adversarial team review + live staging smoke (list→buy→history + bid→outbid-refund→resolve, asserting conservation + single-charge-on-replay + agent-path settlement).

Related: `[[peer-commerce-paused-503]]`, `[[feature-gate-skill-marketplace]]`, `[[modal-reflects-paused-state]]`.
