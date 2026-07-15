# ClawVille Engineering Governance — Hard Rules

**Status:** canonical · **Established:** 2026-07-14 from the dual-fleet forensic audit (`docs/audit-2026-07-14/`) · **Baseline:** `origin/master` @ `61d7aa2c`

> These rules are **mechanical, not judgment-based.** They were extracted from ~57 findings surfaced by two independent audit fleets (Codex + Opus) against every subsystem. Each rule is written as **"WHEN <trigger>, the change MUST <requirement>"** so a reviewer can check it without interpretation. A PR that trips a trigger and skips the requirement is **not mergeable**.
>
> **Precedence (unchanged):** source code > the three canonical docs (`3dStructure.md` / `GameFeatures.md` / `ARCHITECTURE.md`) > `CLAUDE.md`/`README.md` > memory. This doc sits with `CLAUDE.md` as a project-invariants surface; where it and `CLAUDE.md` overlap, they must agree (fix both in the same diff).
>
> **How to use:** find the section matching your change; every rule there binds. The `→ Fxx` tags point to the motivating finding in `docs/audit-2026-07-14/FINDINGS.md`.

---

## G0 — Protected-surface gate (read before touching §1/§2 or partner code)

- **G0.1** WHEN a change touches the **security or money paths** (auth/session/wallet/partner-signing, or any code that mints/moves vCLAW/SOL/USDC/$CLAWVILLE), the change MUST be **Codex-authored + independently adversarially reviewed + staging-first + verified with the live harness** before "done," with a `PROTOCOL_VERSION` bump wherever the wire changes. No inline hot-fix. → *S1–S8, M1–M16*
- **G0.2** WHEN a change touches the **partner surface** (`portal.ts`, `partner-hatcher*.ts`, `agent-gateway.ts` join/tools, `skill-protocol.ts`, `partner-signature.ts`, `hatcher-config.ts`, `agent-substrate-client.ts`, the shared `openclaw` types) OR anything the partner depends on (agent-session bearer/TTL model, the `[ACTION:]` whitelist, leaderboard event names/weights, cognition body shape), it MUST be validated against the partner's real contract in `.hatcher-ref/`, run the mock-Hatcher harness green on staging, and carry a PARITY note. → *S1–S6, A1–A4*

---

## G1 — Money & ledger integrity

- **G1.1 (canonical ledger)** WHEN any code mutates `avatars.clawTokens` or a per-tag balance column (`soft/bought/earned_balance`), it MUST go through `claw-token-ledger` (`credit/debit/transferClawTokens`, `mintEarned`, `debitEarnedForRedemption`) **inside a transaction with the avatar row `FOR UPDATE`-locked**. The ONLY permitted raw write is the guest-demo, soft-only, CHECK-safe, no-ledger-row branch (`items.ts` pattern) that never touches the real economy and stays guest-gated forever. → *M4, M21*
- **G1.2 (no faucet / conservation)** WHEN a provably-fair game credits a win, the game MUST stay net-neutral-or-negative to total vCLAW supply: the rake/vig is either **carved OUT** of the player payout (player gets `payout − rake`, treasury gets `rake`, sum = `payout`) **OR** realized implicitly in the payout rate — **NEVER both.** Crediting a treasury fee *on top of* an already-vig-reduced payout is a supply mint and is forbidden. → *M6 (baccarat)*
- **G1.3 (idempotent value writes)** WHEN a reward/level/quest/activity/settlement path credits vCLAW or on-chain value, it MUST be idempotent **at the DB layer** — a `UNIQUE` claim row, a status CAS (`UPDATE … WHERE <state> RETURNING`), or a per-(subject,day) cap — never guarded only by in-memory FSM state or an unlocked read-modify-write. Insert/claim FIRST, credit only on the fresh claim. → *M7 (awardXp), M13 (activity), M16*
- **G1.4 (global settlement receipts)** WHEN any x402-backed rail accepts a settlement, it MUST atomically claim the `tx_signature` in ONE **global, cross-rail** receipt registry before minting/fulfilling/releasing — per-table uniqueness is insufficient. → *M1*
- **G1.5 (independent chain proof)** WHEN crediting value from an external payment, the change MUST independently fetch and verify the on-chain transaction (success, recipient ATA, mint, atomic amount, payer, network) — a facilitator/relayer's success response is NOT proof. Production facilitator/RPC URLs MUST be exact, HTTPS, credential-free, allow-listed origins; custom endpoints are staging-only. → *M5*
- **G1.6 (capture-before-send + reconcile)** WHEN a service broadcasts SOL/USDC/$CLAWVILLE, it MUST persist a durable signed-intent + signature BEFORE the wire call; any post-send ambiguity enters **forward-only reconciliation** and MUST NEVER delete/reset/re-sign/resend. On-chain deposit + off-chain row MUST be recoverable together. → *M8 (wager), M1*
- **G1.7 (network assertion in code)** WHEN a money path signs an on-chain transaction, it MUST assert its cluster (devnet/mainnet) **in code, at boot**, and crash loudly on mismatch — a documented-but-absent guard counts as no guard (code wins). Mainnet requires a separately-reviewed code gate, never just an env var. → *M9 (wager), M5*
- **G1.8 (report from chain)** WHEN reporting payout/rake/escrow/refund, use confirmed on-chain evidence or an immutable creation-time snapshot — never mutable discovery state or a hard-coded current rate. → *M16*
- **G1.9 (EARNED chokepoint)** WHEN EARNED vCLAW is minted, it MUST go through `mintEarned` only; a `backed` lot MUST carry exact house custody (`amount × 10,000` µUSDC in `earned-backing`) and only a verified/vested/non-clawed/external-payer lot may enter the E3 exit rail. Solvency (on-chain reserve ≥ outstanding backing + retained fees + unswept buy principal) MUST hold before either gate moves. → *(verified-clean; keep)*
- **G1.10 (no operator faucet)** WHEN a script or migration can touch balances, it MUST require an explicit disposable/staging DB identity and use the ledger API — never raw balance SQL against an ambient `.env.local`. → *M4*

---

## G2 — Human/Agent parity (E5)

- **G2.1** WHEN a route mutates economy or user-facing/persistent avatar state (spend/earn vCLAW, buy/equip cosmetics, wager, quests incl. tutorial, land, exchange, bounties, activities, avatar profile/appearance, location-agent, research), it MUST gate on `requireAuthOrAgentSession` (+ `requireLedgerCapableIdentity`/`requireNonGuestIdentity` for real settlement), resolve the subject from `identity.avatarId`, set `actorKind` from `identity.kind`, keep guests demo/read-only server-side, and carry a **PARITY note**. A bare `requireAuth`/`requireNonGuestUser` on such a route is an automatic **BLOCKING** parity defect. → *M2, M3, P1, P2*
- **G2.2** WHEN parity is added on the write path, the same diff MUST expose the feature on the agent action surface (the `[ACTION:]` whitelist and/or agent tools) AND document it in the protocol SKILL.md with a `PROTOCOL_VERSION` bump — a route that accepts an agent header but whose contract the agent is never taught does NOT satisfy E5. → *A4 (3 cove games), M2*
- **G2.3** WHEN equivalent human and agent actions earn rewards, they MUST apply the same durable cooldown, cap, amount, and leaderboard semantics to both (no human-uncapped / agent-once-daily asymmetry). → *M7b (location chat)*
- **G2.4 (open debt — do not walk past)** The following are known open parity gaps and MUST be fixed or formally scoped (not silently carried): **wager** (M2), **cosmetics buy/equip** (M3), **tutorial claim** (P1), **avatar/location-agent/research** (P2). Update the CLAUDE.md E5 "RESOLVED" note to list them until closed. → *§3 of FINDINGS*

---

## G3 — Security, auth & partner signing

- **G3.1** WHEN a partner-signed request mutates state or mints any credential/ticket, the signature MUST bind partner-id + method + canonical path + timestamp + body-digest + a unique request-id, enforce ±5 min, and atomically reject a consumed id. The windowless `verifyPartnerSignature` MUST NOT gate a state-mutating or ticket-minting route. → *S1, S2*
- **G3.2** WHEN an operation returns or rotates an auth bearer, it MUST be treated as **non-idempotent**: an identical (even validly-signed, in-window) request MUST NEVER mint or disclose another usable bearer. → *S2*
- **G3.3** WHEN a public route addresses an existing agent by `agentId`, it MUST require proof of control (current bearer / signed agent-identity challenge / the already-bound user's session) before changing ownership, gateway, session hash, wallet, or avatar binding. Connection tokens MUST be scoped to an explicit agent-id. Legacy register paths MUST be insert-only. → *S3*
- **G3.4** WHEN an agent bearer is exchanged for a human Lucia session, the change MUST verify an explicit identity attestation + ownership; mere possession of a generic agent bearer MUST NOT create a user session. A route that creates a guest MUST set `isGuest:true` + a bounded `guestExpiresAt` in the same insert. → *S4*
- **G3.5** WHEN a bearer authorizes custody or real-vCLAW actions, it MUST be transported ONLY in an `Authorization`/`X-Clawville-Agent-Session` header — never a path, query, log, or persisted URL — and validated through `validateLiveAgentSession` (DB `session_expires_at > now`, NULL = expired, hash-rotation aware). Map membership alone MUST NEVER authorize. → *S5, (verified-clean auth core)*
- **G3.6** WHEN the server fetches a caller/partner-influenced URL, the **connected destination** MUST be constrained after DNS resolution (address pinning with preserved Host/SNI, peer-address verification, or deny-by-default egress) — a preflight lookup alone is NOT SSRF protection. Compile-time-constant URLs MUST be inlined at the call site, never sourced from config/rows. → *S6*
- **G3.7** WHEN an admin action moves money, selects settlement, or enables real-money fulfillment, it MUST require a short-lived, revocable, individually-attributable admin session + step-up auth. A shared static dashboard cookie MUST NOT authorize money routes, and rotating the shared password MUST invalidate issued cookies. → *S7*
- **G3.8** WHEN issuing a magic-link / reconnect / password-reset / session ticket, store ONLY a one-way digest, return the raw value once, and consume by digest with an atomic unused+unexpired predicate. → *S8*
- **G3.9** WHEN a custodial secret is created, emit its plaintext EXACTLY ONCE from the winning first insert; race-losers and all subsequent reads/logs/errors MUST omit it. Keys/DEKs leave process-local plaintext only envelope-encrypted under the KEK. → *(verified-clean; keep)*
- **G3.10** WHEN `ALLOW_TEST_PARTNER_PUBKEY` is set, module init MUST fail unless `CLAWVILLE_ENV==='staging'` (crash-loud). → *(verified-clean; keep)*

---

## G4 — Agent runtime, ElizaOS & protocol parity

- **G4.1 (single `[ACTION:]` governance)** WHEN any code parses/executes the `[ACTION: verb(args)]` grammar, that executor MUST be registered under the ONE whitelist-parity governance: its verb set documented in `skill-protocol.ts` §3a (or a named sibling), `PROTOCOL_VERSION`-tracked, and covered by the mock-Hatcher/self-test harness. There MUST NOT be a second ungoverned executor. → *A1*
- **G4.2 (verb/manual parity)** WHEN a verb/param/bound changes in the executor, update the manual bounds in the same diff and bump `PROTOCOL_VERSION`; drive both validation and manual rendering from ONE machine-readable descriptor with a set-equality test. A structured-invocation `validate()` MUST treat a present required param as the intent signal (never keyword-only against an empty-text message), and every dispatch loop MUST enforce the documented per-reply action cap. → *A6, A7, A8*
- **G4.3 (functional three-surface sync)** WHEN a game-flow/mechanic/verb/table-rule/currency/timer/weight changes, update all three surfaces same-diff — Nori `town-guide.ts knowledge[]`, the connection SKILL.md (`buildProtocolManual`), and hosted-runtime protocol injection — AND ensure surface #3 is **functionally read**: injected protocol memory MUST be retrievable by a live provider from both chat and autonomous decisions, selecting the newest complete version. Persisted-but-unread rows do NOT satisfy the rule. → *A2*
- **G4.4 (ElizaOS mandate + honest scope)** WHEN avatar chat, location/teacher chat, or the orchestrator is modified, cognition MUST continue through the ElizaOS runtime (`createElizaRuntime`→`processMessage`/`useModel`); a direct LLM/API call replacing that path is a violation. Ambient NPC banter and BYO/proxy agent cognition are the ONLY sanctioned non-ElizaOS surfaces and MUST be labeled as such in docs. → *(A-domain; verified-clean core)*
- **G4.5 (autonomy honesty)** WHEN a directive names an economy/gameplay goal, the autonomous planner MUST either execute the documented authenticated tool flow or return a typed unsupported-goal state — it MUST NOT silently reinterpret every goal as "visit a teacher," and docs MUST NOT claim full-scope autonomy the driver can't deliver. → *A3*
- **G4.6 (session classification)** WHEN classifying an agent session (hosted vs BYO vs pending), resolve hosted-runtime liveness independently; an idle/expired external row MUST NOT erase a live hosted agent, and the hosted discriminator MUST require ALL conjuncts (platformAgentId + `identityType` + harness). → *A5*

---

## G5 — Backend, DB & deploy integrity

- **G5.1** WHEN correctness assumes case-folded uniqueness, one active row, positive quantity, a valid enum, or one result per participant, that assumption MUST be encoded as a DB `UNIQUE`/partial-index/`CHECK`/FK — not just an app-level precheck. → *B3, B4, M13, M14*
- **G5.2** WHEN a mutation spans multiple rows or external state, it MUST use a transaction + an idempotent reconciliation boundary so a partial failure can't consume/grant/publish half. Party entry MUST resolve every member's principal independently and commit all-or-none. → *B3, M8, M18*
- **G5.3** WHEN a leaderboard event is emitted, its subject MUST be derived from authenticated server state (never caller headers), it MUST carry salted `fp_hash`+`ip_prefix_hash`, preserve guest status, and score with `LEAST(count,cap)`; a NEW event sub-kind MUST update the scoring CTE filters in the SAME diff (explicit include/exclude). → *M11, M12, B6*
- **G5.4** WHEN schema changes are required for deployed code, the SQL MUST live in the directory the CI migration runner consumes, and deploy MUST fail before app rollout if the schema is incompatible. A DB command that can target a persistent environment MUST use ordered migrations and refuse destructive `push` unless the target is explicitly disposable. → *B1, M4*
- **G5.5** WHEN an endpoint accepts JSON, impose a body-size limit before buffering, validate body/query/params with Zod, and map malformed input to a stable 4xx `ApiError` (never a 500). → *B5, B7*
- **G5.6** WHEN an HTTP GET is public/cacheable, it MUST perform NO persistent state transition; settlement belongs in an idempotent command or worker. → *M17*
- **G5.7** WHEN an SSE/streaming response carries subject-specific data, authenticate the subscriber and filter events by server-derived ownership — never a client-supplied channel id, never a global broadcast of private artifacts. → *M10*
- **G5.8** WHEN a route starts expensive global work (scrape/seed/refresh), it MUST be admin/internal-scheduler-gated + rate-limited + idempotent. → *B2*

---

## G6 — 3D / render / performance (Iris-Xe floor is the shipped target)

- **G6.1** WHEN adding 3D text/labels to a game/world scene, use a DOM overlay (`WorldLabelsOverlay`/`<Html>`) — NEVER drei `<Text>`/`<Billboard>` (hard-crash Iris Xe). → *(verified-clean; keep)*
- **G6.2** WHEN rendering many-of-something, the instanced material MUST be a built-in/node-safe material — `InstancedMesh + ShaderMaterial` silently crashes WebGPU; use merged `BufferGeometry` + TSL `positionNode` for animated fields. → *(verified-clean; keep)*
- **G6.3** WHEN writing any `useFrame` body, allocate nothing (`new THREE.*`, `.clone()`, `.filter()/.map()` building arrays) — reuse module/`useMemo` scratch; event-driven enqueue allocations are tolerated only if provably not steady-state. → *R10*
- **G6.4** WHEN classifying front/behind for DOM/HUD label placement, use view-space z / camera-forward dot — NEVER NDC-z (backend-unstable under reversed-Z). Use NDC only for x/y bounds. → *R2*
- **G6.5** WHEN world dimensions or camera travel change, recompute camera-far, fog-far, fog-color, and clear-color together and corner-view-verify; preserve `fog.far ≤ camera.far` with fog fully opaque before the far-plane (nothing visible past the clip). → *R9 (this is why R9 is not a bug)*
- **G6.6** WHEN renderer init falls back, the fallback MUST present to the currently-mounted R3F canvas (a forced-failure test must show a visible frame) — never a detached canvas. → *R1*
- **G6.7** WHEN a static GLB/VRM/cosmetic at a stable URL is mutated, bump `?v=N` at EVERY reference AND bump `sw.js CACHE_VERSION` if precached (SW is cache-first + Cloudflare 7-day edge, no purge scope). Any GLB/VRM on an interactive critical path MUST fit the SW per-entry + total-cache budget, or the same change revises the budget with offline+memory evidence; `compileAsync` MUST run only after Suspense geometry is mounted. → *R3*
- **G6.8** WHEN device class affects controls/DPR/renderer/NPC-limits/features, all consumers MUST use ONE shared touch-capability detector including `maxTouchPoints` (never coarse-pointer- or `md:`-only), and pattern lists MUST match the documented device-class intent (code + comment agree same-diff). → *R4, R7*
- **G6.9** WHEN rendering a humanoid VRM at ANY site (player/NPC/activity/preview/room), use `computeVRMAvatarFit()` (never a flat scale), face via `atan2(vx,vz)`, unique `instanceId` per visible entity (never share a parsed VRM), `frustumCulled=false` on cloned SkinnedMeshes, throttled spring bones for idle NPCs. → *R5*
- **G6.10** WHEN any module-level emit/enqueue helper is called (`emitParticles`), the diff MUST guarantee a mounted consumer drains the queue, or the helper no-ops/bounds the queue — an undrained module array is a session-lifetime leak (and a paid SKU that renders nothing is also an economy defect). → *R6*

---

## G7 — Naming & outward copy

- **G7.1** WHEN token terminology is rendered to a human or a conversational agent (UI copy, error strings, Nori knowledge, connection manual prose), use **`$CLAWVILLE`** for the token and **vCLAW** only as the internal unit; NEVER `CT` and NEVER user-facing `CLV`. `vclaw`/`amountVclaw`/legacy enum values stay confined to wire/DB identifiers. → *A10, M(cosmetics "CLV" error), FINDINGS §4/§5*
- **G7.2** WHEN referring to the games surface outward, say "the cove" / "card tables" / "provably-fair games" — never "casino." (Code comments exempt.)

---

## Same-diff doc rule (unchanged, reinforced)
Every change above MUST update its matching canonical doc in the same diff (`3dStructure.md` / `GameFeatures.md` / `ARCHITECTURE.md` / `CLAUDE.md`) and bump its "Last Audited". The audit found repeated **doc drift** (E5 "resolved" but 4 open gaps; wager guard claimed but absent; `PROTOCOL_VERSION` doc says 6, code says 18; `CLV_SWAP_EXECUTE` doc says "never true," code boots it live) — drift is a defect, not a footnote.
