# ClawVille Forensic Audit — Consolidated Findings Ledger
**Date:** 2026-07-14 · **Baseline:** `origin/master` @ `61d7aa2c` · **Method:** two independent fleets (5 Codex `gpt-5.6-sol` + 5 Opus), one pair per domain, cross-checked and de-duplicated here.

**Verdict legend**
- **CONFIRMED** — verified by me (read the cited code) or independently reported by BOTH fleets.
- **PLAUSIBLE** — reported by one fleet with a specific `file:line` citation; not independently re-verified here (flagged for triage before fixing).
- **REFUTED** — reported but shown to be a false positive / intended design.

**Severity** BLOCKER (money loss / breach / prod crash) · HIGH (wrong behavior / parity violation / exploitable) · MEDIUM (latent) · LOW (cleanup/drift).

> Every fix on the **security** or **money** paths (§1, §2) and anything under the **partner surface** (portal / partner-hatcher / agent-gateway / skill-protocol / SSRF) MUST run through the CLAUDE.md protected-surface process: Codex-authored + adversarial review + staging-first + live harness, `PROTOCOL_VERSION` bump where the wire changes. Do not hot-fix these inline.

---

## §1 — SECURITY (auth, sessions, custodial wallets, partner signing, SSRF)

### S1 · BLOCKER · Reverse-portal mint routes use the WINDOWLESS verifier → captured request replays forever into a victim-login ticket
`apps/api/src/routes/portal.ts:409,501,912,1011` · `services/partner-signature.ts:185`
**Fleets:** codex-D2 (BLOCKER) + opus-D2 (HIGH) — **CONFIRMED (both).** `mint-for-hatcher`/`mint-for-scape`/`accept-*-link` verify ed25519 over `sha256(rawBody)` with **no timestamp/nonce/window**, while the partner-hatcher WRITE path was deliberately upgraded to a ±5-min windowed verifier. These routes MINT LOGIN TICKETS, so a captured signed request replays indefinitely into a fresh `/enter?t=` magic link = account takeover. `hatcher` is a live partner → live in prod. Self-documented violation (CLAUDE.md lists `portal.ts` as PROTECTED SURFACE + states the ±5-min invariant).
**Fix:** route all four through `verifyPartnerWriteSignature` (add `X-<Partner>-Timestamp`) or a delete-on-read nonce; bump `PROTOCOL_VERSION`/spec.

### S2 · BLOCKER · Hatcher registration replay mints a fresh real-vCLAW bearer within the 5-min window
`apps/api/src/routes/partner-hatcher.ts:737,806,895,1216`
**Fleets:** codex-D2 — **CONFIRMED (specific).** The partner-signature policy allows identical signed writes within ±5 min "because writes are idempotent" — but registration is NOT idempotent: each replay generates a new `hat-` session id, overwrites the stored session hash + expiry (keeping the victim's user binding), marks it ledger-capable, and returns a NEW plaintext bearer. A replayer gets a live ledger-capable bearer bound to the victim; the prior bearer fails hash validation.
**Fix:** require a unique signed request id, atomically reject consumed ids; never mint a second bearer for a replay.

### S3 · HIGH · Caller-controlled `agentId` rebinds/takes over an existing agent
`apps/api/src/routes/agent-gateway.ts:493,506,516` · `routes/openclaw.ts:123,218,248`
**Fleets:** codex-D2 — **PLAUSIBLE (specific).** Public `/api/agent/connect` accepts a caller-selected `agentId`; if it exists, the route unconditionally updates identity/gateway/bearer-hash/`userId`. A connection token proves the caller owns *some* account, not the named agent → User B rebinds User A's agent to B, evicting A's sessions. Legacy unauthenticated `/api/openclaw/register` similarly overwrites an existing agent's hash/gateway.
**Fix:** treat an existing agent binding as immutable without proof via current bearer / signed agent-identity challenge / bound-user session; scope connection tokens to an explicit agent id; make legacy register insert-only.

### S4 · HIGH · Milady session-exchange mints a NON-guest account from any agent bearer
`apps/api/src/routes/auth.ts:974,1010,1024` · `packages/database/src/schema/users.ts:171`
**Fleets:** codex-D2 (HIGH) + opus-D2 (MEDIUM) — **CONFIRMED (both).** `/milady-session-exchange` validates any live agent session (no Milady attestation / owner / ledger check), then inserts a user WITHOUT `isGuest:true` despite the code calling it a "milady guest". `isGuest` defaults false → the guest→non-ledger backstop never fires → a public agent bearer becomes a general non-guest Lucia login with real-economy access.
**Fix:** require Milady identity attestation + owner check; OR if it's meant to be a demo guest, set `isGuest:true` + bounded `guestExpiresAt`. An arbitrary agent bearer must never mint a full user session.

### S5 · HIGH · Real-vCLAW session bearers embedded in URL paths/query (log leakage)
`apps/api/src/routes/agent-gateway.ts:975,987,1000,1476,4377`
**Fleets:** codex-D2 — **PLAUSIBLE (specific).** The agent session id (a bearer trusted for real-vCLAW actions) appears in generated URL *paths* and a wallet `sessionId` *query param* and the blackjack proxy path. Paths/queries are retained in proxy/CDN logs, histories, tracing → anyone with log access replays the bearer before expiry.
**Fix:** transport bearers only in `Authorization`/`X-Clawville-Agent-Session` headers; non-secret ids in paths; redact; rotate sessions after deploy.

### S6 · HIGH · Outbound URL validation vulnerable to DNS rebinding (validation-to-fetch race)
`apps/api/src/services/hatcher-config.ts:247,263` · `services/agent-substrate-client.ts:190,202,762`
**Fleets:** codex-D2 + opus-D2 (related) — **CONFIRMED (code acknowledges the race in-comment).** `validateOutboundUrlResolved` resolves+checks the host, then returns a URL still containing the *hostname*; a later independent `fetch()` re-resolves. An attacker controlling DNS returns a public IP at preflight and an internal/metadata IP at fetch.
**Fix:** pin the validated address for the socket (preserve Host/SNI) or force egress through a proxy that denies private/loopback/link-local/metadata post-resolution; verify the connected peer address.

### S7 · HIGH · Static `cv_dash` admin cookie is unrevocable AND authorizes money routes
`apps/api/src/middleware/admin-only.ts:41,48,75` · `routes/dash-auth.ts:30,86` · `routes/wager.ts:586` · `routes/partner-storefront.ts:353`
**Fleets:** codex-D2 + codex-D3 — **CONFIRMED (both).** The cookie is a deterministic HMAC of the constant `"dash-access"` under `FINGERPRINT_SECRET` — no identity, issue-time, expiry, or password-version. Rotating `DASH_SHARED_PASSWORD` does NOT invalidate issued cookies (the middleware comment claims it does). It's valid 30 days across `.clawville.world` and gates **wager settlement** + **real-USDC storefront enablement**.
**Fix:** short-lived, server-side, revocable, individually-attributable admin sessions bound to a password/key version; step-up auth for settlement/real-money config; the shared cookie must not authorize money routes.

### S8 · MEDIUM · Magic-link session tickets stored as plaintext (not hashed)
`apps/api/src/services/session-ticket-service.ts:83,124,140` · `schema/agent-session-tickets.ts:37`
**Fleets:** codex-D2 — **PLAUSIBLE (specific).** The raw ticket is the PK and is stored/queried in plaintext (the general auth-token service hashes its tokens). A DB read / backup / export yields immediately-usable login tickets.
**Fix:** store only a SHA-256/HMAC digest, return the raw ticket once, consume by digest with an atomic unused+unexpired predicate.

### S9 · LOW · Envelope-DEK not AAD-bound to its row · `keypair-vault.ts:296-321` (opus-D2). Defense-in-depth; GCM tag already blocks cross-row swaps.
### S10 · LOW · `X-CV-Fingerprint` fully client-controlled · `middleware/fingerprint.ts:82` (opus-D2). Anti-farm value is advisory; ledger caps anchor on server identity.

---

## §2 — ECONOMY & MONEY PATHS

> **Core rails are HIGH-health (opus-D1, no BLOCKER):** canonical ledger, CLV swap guard, EARNED redemption (exact 444bps: 444 + 9,556 = 10,000 µUSD conserving), on-ramp, and withdraw executor are production-grade (row-locked, capture-before-send, claim-first, reconcile-on-ambiguous, on-chain delivery verification, enforced EARNED chokepoint). The findings below are adjacent/older paths.

### M1 · BLOCKER · x402 payment-signature uniqueness is per-table, not global → cross-rail double-credit
`packages/database/src/schema/land.ts:685` · `schema/checkout.ts:140` · `services/x402-payai.ts:213`
**Fleets:** codex-D1 — **PLAUSIBLE (structural; live PayAI resubmit behavior UNVERIFIED).** `tx_signature` uniqueness is enforced *inside* `ct_topups` and *separately* inside `x402_checkouts`. Both rails derive identical payment requirements from `buildTopupQuote`. The same signed payload submitted to both settle machines can bind once in each table and credit/fulfill twice.
**Fix:** a global `x402_settlement_receipts` table keyed by `tx_signature`, claimed transactionally by every settle/reconcile path before any credit/fulfillment. Keep per-table indexes as defense-in-depth.

### M2 · BLOCKER (parity) · SOL wager routes are human-only (E5)
`apps/api/src/routes/wager.ts:197,450,686,778`
**Fleets:** codex-D1 + opus-D1 — **CONFIRMED (both).** create/join/cancel/refund are `requireAuth,requireNonGuestUser` resolving `c.get('user')` — no `requireAuthOrAgentSession`. Wagers escrow **real SOL**; a connected/hosted agent is structurally locked out of a money feature — the exact Cove-precedent E5 violation.
**Fix:** `requireAuthOrAgentSession` + `requireLedgerCapableIdentity` + `requireNonGuestIdentity`; bind to `identity.avatarId`; expose on the agent action surface + SKILL.md + `PROTOCOL_VERSION` bump; PARITY note.

### M3 · BLOCKER (parity) · Cosmetic vCLAW purchase + equip are human-only (E5)
`apps/api/src/routes/cosmetics.ts:386,353,358`
**Fleets:** opus-D3 + codex-D3 — **CONFIRMED (I verified: `/buy` = `requireAuth,requireNonGuestUser` + `actorKind:'human'`; sibling `items.ts:69 /buy` = `requireAuthOrAgentSession`).** An agent that earned vCLAW cannot buy or equip a cosmetic. Directly contradicts CLAUDE.md's "E5 retroactive debt RESOLVED."
**Fix:** `requireAuthOrAgentSession` + `requireLedgerCapableIdentity`; resolve `identity.avatarId`; `actorKind` from `identity.kind`.

### M4 · BLOCKER (ops) · `grant-test-tokens.ts` has no prod guard + destructive `db:push --force` still wired
`packages/database/scripts/grant-test-tokens.ts:16,50` · `packages/database/package.json:14`
**Fleets:** codex-D1 + codex-D3 — **CONFIRMED.** `grant-test-tokens.ts` loads ordinary `.env.local`, defaults to granting 5,000 vCLAW to a fixed avatar via raw SQL, no staging assertion → points at prod = mints 5,000 vCLAW on mainnet. Separately `migrate`/`push` both run `drizzle-kit push --force` (the documented table-drop hazard).
**Fix:** require an explicit disposable-DB identity for test grants; convert scripts to the ledger API; make destructive push fail-closed outside a marked disposable DB; point `migrate` only at `migrate-ci.ts`.

### M5 · HIGH · Arbitrary x402 facilitator can fabricate successful payments (no independent chain verification)
`apps/api/src/services/x402-config.ts:154` · `services/x402-payai.ts:452,496` · `routes/ct-topup.ts:603`
**Fleets:** codex-D1 — **PLAUSIBLE-serious.** Any non-empty `X402_FACILITATOR_URL` overrides presets with no protocol/host validation; the prod boot guard only checks for `mock`, not the resolved URL. `verifyAndSettle` declares success on the facilitator returning `isValid/success` + any non-empty `transaction` string, and the top-up credits BOUGHT vCLAW **without independently proving the tx on-chain**. A rubber-stamp facilitator mints vCLAW with no USDC moved.
**Fix:** allow only exact HTTPS credential-free facilitator origins on prod (staging-only override); before any credit, independently fetch+verify tx success, recipient ATA, USDC mint, atomic amount, payer, network.

### M6 · HIGH · Baccarat over-mints the banker commission to the treasury (supply inflation)
`apps/api/src/routes/cove-baccarat.ts:856,881-901`
**Fleets:** opus-D1 — **CONFIRMED (specific logic verified).** On a banker win it credits the player the FULL engine payout (which already embodies the 0.95 rate) AND credits the treasury `r.commission` on top → mints vCLAW from nothing. Blackjack/hold'em correctly CARVE rake out of the payout. Flips a −1.06%-edge game net-inflationary; invisible to the `cove-economy.ts` faucet monitor (commission lands only in `claw_token_transactions`). House-ward SOFT → HIGH not BLOCKER.
**Fix:** remove the treasury commission credit (881-901); the vig is already realized in the 0.95 payout. If a spendable edge balance is wanted, mint the NET edge via aggregate accounting, not per-coup gross commission.

### M7 · HIGH · `awardXp` double-credits the level-up token under concurrency (non-atomic RMW)
`apps/api/src/services/xp-service.ts:31-76`
**Fleets:** opus-D1 — **CONFIRMED.** Read (no `FOR UPDATE`, no tx) → compute level-ups in JS → bare update → separate `creditClawTokens(50/level)`. Two concurrent `awardXp` (fire-and-forget from NPC chat) both see the pre-level state and both mint 50 → 100 vCLAW for one legit level-up (SOFT, but uncapped-under-concurrency).
**Fix:** wrap in `db.transaction`, `SELECT … FOR UPDATE` the avatar, compute off the locked row, pass the same `tx` into `creditClawTokens`.

### M7b · HIGH · Location chat mints 1 vCLAW/message uncapped + human/agent asymmetry
`apps/api/src/routes/chat.ts:336-353` · `routes/agent-gateway.ts:2582-2601`
**Fleets:** codex-D3 — **CONFIRMED (I verified).** Every successful non-guest location-chat message mints 1 vCLAW + 5 XP with no route-local cooldown/cap/idempotency (the 50/day cap is leaderboard-*scoring* only). Connected agents get 1/building/day → parity asymmetry. SOFT (non-cashable) so in-world inflation, not a cash faucet.
**Fix:** one durable per-(subject,building,day) reward policy for both humans and agents; idempotent ledger mint.

### M8 · HIGH · Wager broadcasts are not durable across chain/DB ambiguity
`apps/api/src/routes/wager.ts:294,478,643` · `services/wager-program-client.ts:256`
**Fleets:** codex-D1 + opus-D1 (LOWs) — **CONFIRMED.** `.rpc()` (send+confirm) with chain-first/DB-second, and creation deletes the draft on any thrown error. A post-send timeout after the tx lands leaves on-chain state with no DB row → `/refund` returns `not_in_lobby`; deposit stranded.
**Fix:** persist durable intent + deterministic PDA before broadcast; capture signature before send; `prepared→sending→confirmed/reconcile`; never delete/reset an ambiguous tx; add a chain reconciliation worker.

### M9 · HIGH · Wager devnet/mainnet guard is documented but ABSENT
`apps/api/src/services/wager-program-client.ts:84-88` · `routes/wager.ts:35-42`
**Fleets:** codex-D1 + opus-D1 — **CONFIRMED (both).** The FEATURE_GATE claims a `SOLANA_RPC_URL` devnet guard "in this file"; no such assertion exists (contrast the real `assertMainnetWithdrawConnection`). Any `SOLANA_RPC_URL` builds+signs settlement txs; only luck (devnet PROGRAM_ID absent on mainnet) limits blast radius.
**Fix:** add a devnet/genesis assertion before any `.rpc()`; gate mainnet behind an explicit reviewed signal; correct the FEATURE_GATE text.

### M10 · HIGH · Research SSE globally broadcasts private artifacts, unauthenticated
`apps/api/src/routes/research-sse.ts:8-75` · `routes/research.ts:48-77`
**Fleets:** codex-D3 — **CONFIRMED (I verified: `/stream` "No auth required", global `ResearchEventBus` Set, no per-subject filter).** Events carry session id, avatar id, synthesized knowledge, and the full generated `skillMd` → any anonymous listener receives every user's research artifact + identifiers; `/trigger` accepts client-supplied session ids.
**Fix:** authenticate the stream, derive subject/channel server-side, filter per authorized principal, require ownership of referenced sessions.

### M11 · HIGH · Public skill fetch can forge scored agent identities (leaderboard integrity)
`apps/api/src/routes/skills.ts:556-560` · `services/event-logger.ts:531`
**Fleets:** codex-D3 — **PLAUSIBLE-serious.** The public play-skill route logs `agentId`/`sessionId` from caller headers; the logger stores the claimed id unvalidated and leaderboard SQL treats any non-null `agent_id` as an agent subject → `X-Clawville-Agent-Id: victim` attributes `skill_md.fetched` to the victim, or invented ids create phantom subjects.
**Fix:** derive scored identity only from a validated live session/partner principal; leave anonymous fetches unscored.

### M12 · HIGH · Activity placement events omit mandatory anti-farm fingerprints
`apps/api/src/services/activity/reward-pipeline.ts:552-569`
**Fleets:** codex-D3 — **PLAUSIBLE.** `activity.match.placed` emits without `fpHash`/`ipPrefixHash`; leaderboard scores them anyway → one browser/IP farms 10 daily placements per account with no anti-farm correlation.
**Fix:** capture trusted fp/ip-prefix hashes at enqueue, carry through settlement, exclude untagged user-controlled placement events from scoring.

### M13 · HIGH/MEDIUM · Activity rewards have no persistent idempotency (double-credit on retry)
`apps/api/src/services/activity/reward-pipeline.ts:454-505` · `schema/activity-results.ts:36`
**Fleets:** codex-D1 + opus-D1 + codex-D3 — **CONFIRMED (three auditors).** No `UNIQUE(room_id, avatar_id)` on `activity_results` and no `rewards_issued` flag; re-issuance is blocked only by in-memory FSM state. A crash-recovery re-adoption / duplicate manager / manual re-trigger re-inserts results and re-credits base placement vCLAW.
**Fix:** `UNIQUE(room_id, avatar_id)` (insert-as-claim, credit only on fresh insert) or a `rewards_issued_at` CAS on `activity_rooms`.

### M14 · HIGH · Cosmetic limited supply cap declared but never enforced (oversell)
`apps/api/src/routes/cosmetics.ts:206,492` · `schema/cosmetics.ts:93`
**Fleets:** codex-D3 — **PLAUSIBLE.** `supplyCap` is a schema hard-max but purchase grants ownership without counting sold units or locking supply → 101 sequential (or boundary-concurrent) buys all succeed.
**Fix:** enforce supply under the purchase tx via a locked counter / atomic conditional update; mark sold-out unavailable.

### M15 · MEDIUM · Hold'em house edge lives entirely in bot AI; 5-CT rake cap can't reclaim a beatable-bot faucet
`apps/api/src/routes/cove-holdem.ts:136,1374` · `holdem-engine.ts` (not read)
**Fleets:** opus-D1 — **FLAGGED (needs engine EV audit).** Settlement conserves, but the edge is in bot decision quality. A player can win ≤500 CT of minted real vCLAW from virtual bot stacks in one all-in while rake caps at 5 CT/hand. If bots are exploitable/deterministic, the table is a net faucet.
**Fix:** EV-audit `holdem-engine.ts` for a provable house edge (or raise/uncap rake) before any real-money tier.

### M16 · MEDIUM · Wager payout/rake reported from mutable DB + hard-coded `500n` (past its own 2026-07-01 deadline) · `wager-program-client.ts:594` (codex-D1). Report from confirmed on-chain values / immutable snapshot.
### M17 · MEDIUM · Special-events GET performs settlement writes · `routes/special-events.ts:241` (codex-D3). Keep GET pure; move settlement to a worker/idempotent command.
### M18 · MEDIUM · Item read→consume not atomic · `routes/items.ts:318` (codex-D3). Lock+decrement in one tx; idempotent knowledge apply.
### M19 · LOW · Bounty cancel-refund downgrades EARNED/BOUGHT→SOFT provenance · `bounties.ts:2660` (opus-D1). Snapshot+restore tags or document.
### M20 · LOW · Blackjack floor-rake rounds to 0 for net < 20 CT · `cove-blackjack.ts computeBlackjackRake` (opus-D1). Optional 1-CT min.
### M21 · REFUTED · "Guest `items.ts` writes `avatars.clawTokens` outside the ledger" (codex-D1/D3 called BLOCKER) — **REFUTED:** opus-D1 + opus-D3 verified it is the *sanctioned* guest-demo carve-out (soft-only, `FOR UPDATE`, decrements `claw_tokens`+`soft_balance` together to satisfy the CHECK, no ledger row, no treasury credit). Documented in GameFeatures.md §5. **Keep guest-gated forever.** (The real risk in that finding is the `grant-test-tokens.ts` script — see M4.)

---

## §3 — HUMAN/AGENT PARITY (E5) — the consolidated open debt

The E5 "retroactive debt RESOLVED 2026-06-15" claim is **optimistic**. Confirmed open human-only economy/state paths:
- **M2** SOL wager (real SOL) — BLOCKER
- **M3** cosmetic vCLAW purchase + equip — BLOCKER
- **P1** tutorial-quest reward claim (`quests.ts:1401`, ~175 vCLAW) — codex-D1 + codex-D3 + opus-D3, **CONFIRMED**; known "P2b" debt, needs a founder decision (agent-reachable path vs formally scope human-only).
- **P2** avatar profile/appearance mutations (`avatars.ts:506`), location-agent management (`locations.ts:64`), research learning (`research.ts:86`) — codex-D3, **PLAUSIBLE** parity gaps (persistent user-facing state, no agent path).

---

## §4 — AGENT RUNTIME / ElizaOS / PROTOCOL PARITY

> ElizaOS is genuinely load-bearing (real `AgentRuntime`, not a stub) — verified by both fleets. Findings are governance/parity gaps.

### A1 · HIGH · A SECOND, ungoverned `[ACTION:]` executor exists
`packages/agent-runtime/src/eliza-runtime.ts:1123-1204`
**Fleets:** opus-D4 — **CONFIRMED.** `processMessage`/`executeAction` runs the identical `[ACTION: NAME(...)]` grammar against `clawvillePlugin.actions` (8 economy/utility verbs incl. `ACCEPT_QUEST`/`SUBMIT_QUEST`, which DO execute), reachable by connected/hosted agents (`agent-gateway.ts:2266`). It escapes the CLAUDE.md whitelist-parity rule (which names only `npc-simulation.ts`), is not `PROTOCOL_VERSION`-tracked, and the manual falsely says "economy never flows through the free-text parser." Blast radius bounded (`avatarId` server-set) → HIGH.
**Fix:** bring under the single whitelist governance (document the live subset in §3a/§12 + version bump, or route through the central constant); correct the manual copy; CLAUDE.md must acknowledge the second executor.

### A2 · HIGH · Injected protocol knowledge is WRITE-ONLY for hosted agents (three-surface sync is mechanically-but-not-functionally satisfied)
`packages/agent-runtime/src/eliza-runtime.ts:914-947` vs `providers/knowledge.ts:42-49`
**Fleets:** codex-D4 — **CONFIRMED (I verified: injector writes room `generateRoomId(agentId,'protocol-knowledge')`; the only provider queries `roomId/entityId=agentId` — a different room; the code comment admits a "future protocol-aware reader" is needed).** Surface #3 of the three-surface rule persists rows nothing reads; autonomous decisions call raw `useModel`, bypassing providers entirely. (opus-D4's "auto-picked-up" claim is superseded by this verification.)
**Fix:** add a protocol-knowledge provider that queries the exact injected room + selects the newest complete version; include it in autonomous decision composition; integration-test that an injected fact reaches both chat and `decide()`.

### A3 · HIGH · "Autonomous" is scope-limited to teacher visits, not the full-scope economic participant the docs promise
`apps/api/src/services/agent-autonomy-driver.ts:802-848`
**Fleets:** codex-D4 (opus-D4 confirms the loop is real) — **CONFIRMED (reconciled).** The driver IS wired (perceive→decide→act) but its decision prompt only ever presents teaching buildings and mandates one `enter_building`; it cannot act on "grind vCLAW in the cove" / "run my shop" directives Nori + the manual invite.
**Fix:** replace the teacher-only planner with a goal/action state machine over the documented authenticated tools; until then, narrow Nori/manual copy to "choose and visit teachers."

### A4 · HIGH · Three live Cove agent paths (baccarat, cash hold'em, slots) are missing from the connection manual despite E5 "resolved"
`apps/api/src/services/skill-protocol.ts:581,646` vs the live routes
**Fleets:** codex-D4 — **PLAUSIBLE-serious.** The routes resolve agent sessions for real settlement, but the manual teaches only blackjack + tournament poker; the other three appear only as replay event names. A route that accepts an agent header but whose contract the agent is never taught is not a fully-reachable agent feature (E5 mandate #2).
**Fix:** publish session-bound tool bundles / REST contracts for all three, update Nori + hosted knowledge same-diff, bump `PROTOCOL_VERSION`; contract-test every agent-capable game has a manual/tool entry.

### A5 · HIGH · A dead BYO row shadows a live hosted-agent classification · `auth.ts:119` (codex-D4, PLAUSIBLE). Stale external row → `/me/agent-session` reports `connected:false` for a live hosted avatar → frontend hides Autonomous + shows reconnect.
### A6 · MEDIUM · 6 of 8 plugin actions are DEAD via `[ACTION:]` (empty-text `validate()`) · `eliza-runtime.ts:1182` (opus-D4, CONFIRMED). Only `ACCEPT/SUBMIT_QUEST` got the `getParam` fix; the model claims success while nothing executes.
### A7 · MEDIUM · `processMessage` dispatch has NO per-reply action cap (manual promises ≤4) · `eliza-runtime.ts:1338` (opus-D4, CONFIRMED).
### A8 · MEDIUM · `enter_poker_room` missing from the §3a "exact" whitelist · `skill-protocol.ts:397` (codex-D4). ### A9 · MEDIUM · Manual promises poker skill accumulation that doesn't exist · `game-skill-memory.ts:41` (codex-D4).
### A10 · LOW · Nori + manual render `vCLAW`/"CT tournament" in outward copy · `town-guide.ts:157`, `skill-protocol.ts:584` (codex-D4). Should be `$CLAWVILLE`.

---

## §5 — BACKEND / DB / DEPLOY INTEGRITY

### B1 · BLOCKER (ops) · CI migration discovery omits `migrations-manual/` → fresh-env 500s
`packages/database/scripts/migrate-ci.ts:84-118` · `migrations-manual/2026-07-10_add_events_subject_was_guest.sql`
**Fleets:** codex-D3 — **CONFIRMED-plausible.** The CI runner discovers only `migrations/`, but deployed event code writes `subject_was_guest` (in `migrations-manual/`). A fresh environment deploys the API, the first scoring event references the absent column → failed-event handling + leaderboard 500s.
**Fix:** move deploy-required SQL into the CI-consumed dir; add a pre-deploy schema-compat assertion; prohibit new deploy-required SQL under `migrations-manual`.

### B2 · HIGH · Any authenticated user can launch global scrape/seed jobs · `routes/research.ts:160` (codex-D3). No admin gate/limiter/idempotency → cost + racing content refresh. Fix: admin-only / internal scheduler.
### B3 · HIGH · Party enqueue is partial + misattributes non-leader identity · `routes/activities.ts:301` (codex-D3). Non-leaders get null user/agent ids + inherit leader `subjectType`; non-atomic partial queue on error. Fix: resolve each member's principal, prevalidate, commit atomically.
### B4 · HIGH · Username uniqueness is race-prone + only case-sensitive in DB · `routes/users.ts:99`, `schema/users.ts:35` (codex-D3). Fix: unique index on `lower(username)` / CITEXT.
### B5 · HIGH · No global body-size limit; malformed JSON → 500 · `index.ts:376`, many handlers (codex-D3 + opus-D3). Fix: conservative global limit + centralized `parseJsonBody` → 400.
### B6 · LOW · Nori system-chat scores as teacher-chat on the public leaderboard · `chat.ts:147` + `leaderboard.ts:588` (opus-D3). The `/dash` metric splits them; the leaderboard CTE doesn't → 500 rank-pts/day of orientation chatter at the learning weight.
### B7 · LOW · ~13 handlers `await c.req.json()` unguarded → 500 not 400 (opus-D3 + codex-D3).

> **Verified-clean baseline (opus-D3, useful for governance):** auth core `require-auth-or-agent.ts` (fail-closed liveness, rotation invalidation, rebind-theft eviction, guest→non-ledger demotion); leaderboard weights + caps match the CLAUDE.md spec EXACTLY with `LEAST(count,cap)` + bot/house/guest exclusions; `avatars` schema CHECK/unique constraints; no balance faucet in any D3 route; IDOR guarded; mass-assignment safe.

---

## §6 — 3D / RENDER / PERF

> The render layer is the **most disciplined subsystem** (both fleets): NO drei `<Text>`/`<Billboard>` in world scenes, NO `InstancedMesh + ShaderMaterial`, point-lights ≤5, VRM sizing/facing/cache invariants hold, `camera-cull.ts` uses view-space (not NDC-z).

### R1 · HIGH (rare) · Renderer fallback draws into a DETACHED canvas → blank world
`apps/web/src/components/three/World3DCanvas.tsx:2207-2220`
**Fleets:** codex-D5 (BLOCKER) — **CONFIRMED but rare (I verified).** If `createWebGPURenderer` (which itself has WebGL2 fallback) throws entirely, the catch builds a renderer bound to a fresh `document.createElement('canvas')` never inserted into the DOM → frames present to a detached canvas. Low-probability second-order path, so I rate HIGH not BLOCKER.
**Fix:** reuse `defaultProps.canvas` after disposing the failed context, or substitute the visible canvas + reconnect R3F; add a forced-init-failure test asserting a visible frame.

### R2 · HIGH · World-label overlay uses NDC-z as a behind-camera test (backend-unstable under reversed-Z)
`apps/web/src/lib/three/world-labels-overlay.tsx:666` · `activities/shared/world-to-screen.ts:52`
**Fleets:** codex-D5 — **CONFIRMED (distinct from the already-fixed `camera-cull.ts`).** Hides a label on `z > 1`; `worldToScreen` doesn't reject `z < -1` as its comment claims. WebGPU (reversed-Z) vs WebGL fallback makes the NDC-depth heuristic non-stable → ghost/disappearing DOM labels.
**Fix:** classify front/behind in view space (`matrixWorldInverse` / camera-forward dot); use NDC only for x/y bounds.

### R3 · HIGH · Cove's 18.8 MB primary GLB exceeds the SW per-file cache limit + compiles before Suspense resolves
`apps/web/src/lib/three/cove-interior.tsx:66` · `public/sw.js:60,255` · `CoveCanvas.tsx:51`
**Fleets:** codex-D5 — **CONFIRMED-plausible.** `cove-interior-cleaned-v1-ktx.glb?v=5` is 18,832,136 B; the SW refuses assets > 10 MB → the largest interior payload can't be cached (offline 503) and its parse cost hits the direct-web critical path. `PreCompilePipelines` runs one RAF after commit while the interior is still Suspense-null → pipelines compile on first visible frame (the entry hitch it's meant to prevent).
**Fix:** ship a smaller/chunked KTX2 asset (or raise the limit with a budget analysis); await compilation after the interior mounts.

### R4 · MEDIUM · Device-class detection is inconsistent (renderer/controls use coarse-pointer-only, not `maxTouchPoints`)
`apps/web/src/lib/three/gpu-tier.ts:114` · `World3DCanvas.tsx:1620` · `CoveCanvas.tsx:38` vs `hooks/use-is-mobile.ts:20`
**Fleets:** codex-D5 + opus-D5 — **CONFIRMED.** Landscape iPad w/ trackpad reports `pointer:fine` + desktop width but `maxTouchPoints=5`; subsystems classify it differently → mobile HUD but desktop DPR/controls.
**Fix:** one shared synchronous capability detector (with `maxTouchPoints`) for renderer + controls; subscribe to changes.

### R5 · MEDIUM · Reef Race bypasses `computeVRMAvatarFit` (flat 5.6 scale, no foot offset) · `reef-race/ReefRacePlayer.tsx:343` (codex-D5).
### R6 · MEDIUM · Dead particle cosmetic + unbounded queue leak (paid SKU renders nothing) · `particle-system.tsx:149` + `cosmetic-loader.tsx:736` (opus-D5). `<ParticleSystem>` mounted nowhere; `emitParticles` (~2/s) grows `pendingRequests[]` for the session.
### R7 · MEDIUM · Apple M-series desktop force-routed to WebGL2 + 0.5 DPR · `gpu-tier.ts:33` vs `World3DCanvas.tsx:2043` (opus-D5). `/apple gpu/i` in `INTEL_PATTERNS` contradicts the "M-series still get WebGPU" comment.
### R8 · MEDIUM · SW eviction re-materializes the whole cache per deletion (quadratic) · `public/sw.js:143,156` (codex-D5).
### R9 · REFUTED · "camera `far=11500` too small for the 22,528-wu world" (codex-D5 BLOCKER) — **REFUTED:** the code comment at `World3DCanvas.tsx:2257-2263` shows it's deliberate — fog is fully opaque at 10,500 wu so nothing is visible past it; the building ring is ≤8,320 wu across. opus-D5's `fog.far ≤ camera.far` invariant is the correct one. Not a bug.
### R10 · LOWs · `filter()`/`new Color()` in (rare/unmounted) `useFrame` paths; stale `179.2` vs `270` comment; FPS floor doc says 60 but governor triggers at 58 (opus-D5).

---

## Cross-fleet notes
- **Both fleets agreed** on: S1 portal replay, S4 Milady exchange, S7 admin cookie, M2 wager parity, M9 wager guard, M13 activity idempotency, M3 cosmetics parity (opus-D3+codex-D3), R4 touch detection. High confidence.
- **Divergences resolved by my verification:** A2 (write-only protocol knowledge → codex right, opus superseded), R9 (camera far → refuted), M21 (guest items write → refuted as BLOCKER, it's sanctioned).
- **Coverage gaps flagged for a follow-up pass:** poker `cash-table-manager.ts`/`tournament-manager.ts` conservation (UNVERIFIED); `holdem-engine.ts` bot EV; `market-*.ts` deed-transfer conservation; experimental meshlet `?meshlets=1` Iris-Xe crash surface; the `reconcileUnaccountedEarnedLedger` replay under every interleaving.
