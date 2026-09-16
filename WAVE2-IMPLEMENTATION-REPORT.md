# ClawVille Trading Floor Wave 2 Implementation Report

Date: 2026-09-16

Branch: feat/trading-floor

The request did not include an explicit report output path. This report uses the repository root.

## 1. Specification and source evidence

The implementation used spec-clawpump-client-FINAL.md as the only Wave 2 specification.

Specification SHA-256:

    788492b459e3b0c80768e916b5314d3e68d11919d71cf13b77023a4f49e3627c

The implementation read Wave 1 seams from repository code.

No live RPC, Jupiter, ClawPump, partner, spending, or secret command ran.

No agent, account, or trading link was created.

No file under apps/web changed.

PROTOCOL_VERSION remains 60.

## 2. Implemented files and specification mapping

### Shared contracts and action surfaces

- packages/shared/src/constants/trading-fleet.ts implements sections 2.9, 3, 5, 6.1, 6.9, and 6.10.
- packages/shared/src/constants/hatcher-actions.ts adds trade_token for sections 3a and 6.8.
- packages/shared/src/constants/building-tools.ts adds clawville_trade_token for sections 3a and 6.8.
- packages/shared/src/constants/orientation-skill.ts adds the fleet status and refusal contract.
- packages/shared/src/index.ts exports the Wave 2 shared contracts.
- packages/agent-templates/src/locations/town-guide.ts adds the Nori orientation text.

### Database contract

- packages/database/migrations/0064_clawpump_trading_floor.sql implements section 4.1.
- packages/database/src/schema/trading-fleet.ts mirrors all migration constraints.
- packages/database/src/schema/index.ts exports the Wave 2 schema.

The reservation status column uses explicit checks.

The migration contains no time based reservation release.

### Operator boundary and routes

- apps/api/src/middleware/money-operator-only.ts implements sections 2.8 and 6.11.
- apps/api/src/routes/admin-trading.ts implements nonce, arm, halt, unhalt, kill, state, and test trade routes.
- apps/api/src/routes/trading-floor.ts implements POST /api/floor/trade and GET /api/floor/state.

The middleware requires a Lucia user and session.

It requires ADMIN_USER_IDS, an allowed Origin, JSON content type, and a single use nonce.

The nonce lifetime is 60 seconds.

Provision and pair routes are blocked by the seams in section 4.

### Guardrails, wallet facts, equity, and links

- apps/api/src/services/trading-mint-info.ts implements sections 2.1, 6.1, 6.6, and 7.12.
- apps/api/src/services/trading-fleet-equity.ts implements sections 2.9, 6.7, and 7.13.
- apps/api/src/services/trading-links.ts implements link reads, arming, killing, and fleet state.
- apps/api/src/services/trading-guardrails.ts implements sections 2.5, 6.1, 6.2, 6.10, 6.12, and 7.13.
- apps/api/src/services/usdc-spend-admission.ts adds open trading reservations to liabilities.

Every new link schema default is armed false and killed true.

Only the protected arm function writes armed true.

The trade path refuses unarmed or killed links before provider calls.

The lock order matches the required five lock levels.

Only the bounded USDC balance read occurs inside the spend transaction.

Admission calls admitPosterUsdcSpend before reservation insertion.

The static whitelist resolves decimals, token program, authorities, and extensions.

Environment ceilings can only lower compiled ceilings.

Environment reserves can only raise compiled reserve floors.

Boot validation rejects the opposite direction.

### Jupiter, validation, signer, and durable execution

- apps/api/src/services/trading-jupiter.ts implements sections 2.2, 4.4, 6.4, and 7.5.
- apps/api/src/services/trading-swap-validator.ts implements sections 2.3, 6.4, 6.5, 7.1, and 7.2.
- apps/api/src/services/trading-signer.ts implements sections 2.4, 6.2, 6.3, 7.1, and 7.6.
- apps/api/src/services/trading-execution.ts implements sections 2.6, 6.3, 6.5, 6.6, and 7.14.

Jupiter parsing uses strict Zod schemas from all four fixtures.

The parser accepts a null instructionVersion and never asserts it.

The execution path accepts ExactIn and V1 route instructions only.

The validator decodes minimum output from the built transaction.

The signer captures the signature before any send.

It persists bytes, signature, blockhash, and height before commit.

The send path runs after commit and resends the same bytes.

Expiry proof uses historical status and getBlockHeight with minContextSlot.

The observer callback owns the single submitted to executed transition.

apps/api/src/services/clv-swap-live.ts has no Git diff.

apps/api/src/services/agent-pay.ts has no Git diff.

### Decision feed and autonomous consumption

- apps/api/src/services/trading-decision-feed.ts implements sections 2.7, 4.5, and 7.7.
- apps/api/src/services/autonomous-trading-targets.ts implements sections 2.9, 3a, and 7.8.
- apps/api/src/services/agent-autonomy-driver.ts adds the desk block and directive claim.
- apps/api/src/routes/world.ts consumes the decision broadcaster.

The public frame omits wallet addresses, signatures, quotes, atomic amounts, equity, and free text.

The autonomous prompt receives the full action menu and current trading state.

The prompt receives every refusal code.

Raw model replies are not logged.

### Hatcher parity and manuals

- apps/api/src/services/npc-simulation.ts implements the anchored grammar and runtime dispatch.
- apps/api/src/services/skill-protocol.ts adds the protocol manual text.
- apps/api/scripts/hatcher/selftest-e2e.ts tests every action and a positive effect.
- apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts adds autonomous prompt assertions.
- docs/hatcher-integration-spec.md records the protected surface drift.

The action grammar is anchored and limited to 400 bytes.

The grammar validates reason without the message rescue.

The executor resolves the live binding before execution.

The executor uses a 30 second process reservation guard.

### Boot wiring and documentation

- apps/api/src/index.ts mounts routes and registers the observer callback once.
- apps/api/src/index.ts starts the durable sweeper and drawdown poller.
- ARCHITECTURE.md documents the schema, services, routes, and environment contract.
- GameFeatures.md documents human, agent, and directed trading paths.
- FOUNDER-REVIEW.md records the six founder decisions.
- docs/clawpump-integration.md documents the disabled fleet and integration limits.

### Tests and fixtures

- apps/api/src/services/__tests__/trade-token-grammar.test.ts covers action parsing.
- apps/api/src/services/__tests__/trading-decision-feed.test.ts covers frame redaction.
- apps/api/src/services/__tests__/trading-jupiter-fixtures.test.ts covers fixture parsing.
- apps/api/src/services/__tests__/trading-limits.test.ts covers limit direction.
- apps/api/src/services/__tests__/trading-signer.test.ts covers signer capture.
- apps/api/src/services/__tests__/trading-swap-validator.test.ts covers the leg validator.
- apps/api/src/services/__tests__/trading-wave2-structure.test.ts covers structural rules.
- apps/api/src/services/__tests__/agent-autonomy-round1.test.ts covers prompt consumption.
- apps/api/src/services/__tests__/trading-floor-constants.test.ts covers shared contracts.

The structural suite checks the single executed publisher and eligibility writer.

It rejects fleet imports in scoring and ingest code.

It rejects verified_trades table access.

It checks the key vault boundary and refusal copy.

It checks reserve and ceiling direction.

Jupiter fixture SHA-256 values:

    f3cda1062769c520b230ad856b2f486374145ad628f59f0e00360f83504f0e07  quote-ansem-usdc.json
    ab4079a9ebf78d6dec79821d7493caa959025865ef82cbe0f547782db6b97956  quote-sol-ansem.json
    54229a5d86b49150d6d77261f56b84928ec37b1b528a828ad84341292d5ed0e3  quote-usdc-ansem.json
    b290998a0dee84323ecdffdbff4eda1a1d0634035acc3b0592b17258bf191a2f  quote-usdc-clv.json

## 3. Deviations and reasons

### Blocked scope

The implementation does not add clawpump-client.ts.

The specification gives no ClawPump endpoint paths or response schemas.

No supplied ClawPump fixtures exist.

The implementation does not add provision or pair routes.

The current provision seam creates nonzero economy state.

The repository lacks an agent row before the required wallet bind transaction.

The bind seam performs RPC inside the caller transaction.

It cannot accept a pre-read slot.

The hard rule prohibits stubs for these missing seams.

### Execution order

The implementation commits admission before it requests a Jupiter quote.

This follows section 6.1, which puts admission before quote checks.

Section 6.2 instead puts quote and simulation before admission.

A crash before quote completion can leave an admitted row.

The sweeper does not release admitted rows by elapsed time.

An operator must resolve such a row before the avatar trades again.

### Key decryption placement

The specification diagram puts decrypt inside the lock.

The repository decrypt helper calls a Cloudflare Worker.

The hard rule permits only one balance RPC inside the lock.

The implementation decrypts outside the lock.

The signer still checks the keypair against the bound wallet.

### Fixture derived schema

All supplied Jupiter fixtures contain otherRoutePlans as null.

The prose states that this field is an empty array.

The strict schema follows the supplied bytes.

### Result union

Section 2.6 omits submitted from ExecuteTradeResult.

Section 4.5 requires a submitted decision frame.

The implementation includes submitted in the internal result.

### Operator audit rows

The immutable schema has no operator audit table for arm and kill.

Test trade decisions and halt rows store operator identity.

Arm and kill mutations have no dedicated audit row.

### Runtime checks not executed

The static mint facts require a live mainnet read.

The hard rules prohibit that RPC during this work.

The hosted probe requires staging API, database, and RPC access.

The hard rules prohibit that probe during this work.

## 4. TODO seams and fixtures

- TODO-SEAM:hatcher-real-contract-reference: .hatcher-ref/CONTRACT.md is absent.
- TODO-FIXTURE:clawpump: no ClawPump JSONC fixture was supplied.
- TODO-SEAM:clawpump-endpoint-contract: the final specification has no endpoint contract.
- TODO-SEAM:fleet-zero-economy-provisioning: provisionAvatarAgent creates economy state.
- TODO-SEAM:bindCustodialTradingWallet-boundSlot: the bind seam cannot accept a pre-read slot.
- TODO-SEAM:fleet-agent-session-before-bind: no openclaw_bots row exists before activation.

TRADING_ARM_GRACE_S remains reserved because provisioning is blocked.

## 5. Specification and repository contradictions

1. Section 6.1 commits admission before quote checks.
2. Section 6.2 builds and simulates before admission.
3. The specification puts decrypt inside locks.
4. The repository decrypt seam performs network work.
5. The fixtures use null otherRoutePlans, while the prose says an empty array.
6. Section 2.6 omits submitted, while section 4.5 requires it.
7. Section 1 names eleven services, while section 8 calls them ten services.
8. The action grammar excludes a dollar prefix, while REST accepts it.
9. The nonce wire name is unspecified.
10. trading_decisions has no separate error code column.
11. The immutable schema has no arm and kill audit table.

The implementation follows repository behavior for existing seams.

## 6. Section 11 staging gates for the orchestrator

The orchestrator must run these gates on staging before promotion:

1. Run the public agent onboarding smoke test.
2. Run the hosted skill runtime probe with --autonomous-decision.
3. Run the mock Hatcher end to end harness.
4. Compare the surface with .hatcher-ref/CONTRACT.md when available.
5. Verify the served manual contains trade_token at version 60.
6. Verify tools.json contains clawville_trade_token.
7. Verify missing Jupiter credentials create a visible refusal.
8. Verify decision frames expose no wallet data.
9. Verify fleet accounts are not house accounts.
10. Run the execution disabled quote and simulation probe.
11. Record one paid host Jupiter fixture before any arm action.
12. Run the staging migration gate for migration 0064.
13. Verify the staging container SOURCE_COMMIT.

Do not run a live partner call as part of these gates.

## 7. Commit body parity line

PARITY note: human path: a human signs from their wallet and the core observer scores it; agent path: trade_token or clawville_trade_token calls POST /api/floor/trade and ClawVille signs from the fleet avatar wallet under guardrails; human directed path: a one shot directive uses the same verb and guardrails; settlement binds to the avatar from requireAuthOrAgentSession with subject kind agent.

## 8. Gate summary

Every requested API gate used DATABASE_URL unset.

Every API test used a 64 character hexadecimal FINGERPRINT_SECRET.

| Gate | Exit | Pass | Skip | Fail |
|---|---:|---:|---:|---:|
| API typecheck | 0 | n/a | n/a | 0 |
| Service tests | 0 | 2222 | 112 | 0 |
| Route main group | 0 | 451 | 163 | 0 |
| Route isolated files | 0 | 117 | 16 | 0 |
| Existing clv-swap-live suite | 0 | 78 | 0 | 0 |
| Shared typecheck | 0 | n/a | n/a | 0 |
| Database typecheck | 0 | n/a | n/a | 0 |
| Hatcher self-test | 0 | 86 | 0 | 0 |

The full text output follows.

Terminal line endings and trailing spaces are normalized.

### 8.1 API typecheck

Command: cd apps/api && bun run typecheck

Exit code: 0

```text
$ tsc --noEmit
```

### 8.2 Service tests

Command: cd apps/api && bun test src/services/__tests__/

Exit code: 0

```text
bun test v1.3.14 (0d9b296a)

src\services\__tests__\adversarial-x402-accounting-receipts.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ⌘ enable debugging { debug: true }
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=0, gross=10101 [0.29ms]
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=0, gross=99999 [0.02ms]
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=0, gross=100000
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=1, gross=10101 [0.04ms]
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=1, gross=99999
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=1, gross=100000
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=999, gross=10101
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=999, gross=99999
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=999, gross=100000
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=1000, gross=10101
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=1000, gross=99999
(pass) adversarial Meridian fee-accounting fuzz > conserves gross exactly at bps=1000, gross=100000
(pass) adversarial Meridian fee-accounting fuzz > F5 rejects a conserved settlement whose net is zero [0.04ms]
(pass) adversarial Meridian fee-accounting fuzz > proves the post-fee 10_000-atomic credit guard is load-bearing [0.04ms]
(pass) adversarial receipt-claim idempotency > replays the same legacy-shaped owner as same_owner without a second row [1.17ms]
(pass) adversarial receipt-claim idempotency > replays the same fee-carrying owner as same_owner without a second row [0.22ms]
(pass) adversarial receipt-claim idempotency > legacy then nonzero-fee claim cannot create or mutate ownership [0.29ms]
(pass) migration 0044 static double-apply safety (no local PostgreSQL available) > guards every ADD COLUMN and both ADD CONSTRAINT operations [0.20ms]
(pass) migration 0044 static double-apply safety (no local PostgreSQL available) > makes both data backfills repeatable with COALESCE plus NULL predicates [0.05ms]

src\services\__tests__\adversarial-x402-fallback.test.ts:
[x402-payai] verify threw (treated as invalid): Facilitator verify failed (503): {"error":"upstream_unavailable"}
(pass) adversarial x402 inbound fallback matrix > F1/F2 generic-503 falls back once and preserves PayAI failure observation [11.11ms]
[x402-payai] verify threw (treated as invalid): upstream_unavailable: structured provider outage
(pass) adversarial x402 inbound fallback matrix > F1/F2 structured-503 falls back once and preserves PayAI failure observation [1.86ms]
[x402-payai] verify threw (treated as invalid): free_tier_exhausted: monthly settlement quota exhausted
(pass) adversarial x402 inbound fallback matrix > F1/F2 free-tier-thrown falls back once and preserves PayAI failure observation [1.30ms]
(pass) adversarial x402 inbound fallback matrix > F1/F2 free-tier-returned falls back once and preserves PayAI failure observation [1.73ms]
(pass) adversarial x402 inbound fallback matrix > payment-invalid cannot fall through to Meridian [0.59ms]
[x402-payai] verify threw (treated as invalid): Facilitator verify failed (503): {"error":"upstream_unavailable"}
(pass) adversarial x402 inbound fallback matrix > verifyOnly never invokes either settle endpoint after a PayAI outage [0.52ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
(pass) adversarial x402 inbound fallback matrix > F3 skipPayAi goes directly to Meridian without a PayAI observation [4.20ms]
(pass) adversarial x402 inbound fallback matrix > the outbound preparation function contains no Meridian candidate builder [0.26ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
[agent-pay-breaker] open -> half_open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
[agent-pay-breaker] half_open -> open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
[agent-pay-breaker] open -> half_open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
(pass) shared PayAI circuit > F4 an unobserved half-open probe restarts the cooldown [0.31ms]
(pass) F7 live-proven Meridian wire facts > always emits description and a payer-partially-signed legacy transaction [17.96ms]

src\services\__tests__\agent-action-covenant.test.ts:
[NPC Simulation] Stopped
[Hatcher] play_cove_game dropped — rate limit (one play per 30 seconds)
(pass) in-world executor covenant hooks > settles one validated slots action at the cove and reserves the elapsed-time limiter [22.73ms]
[NPC Simulation] Stopped
[Hatcher] play_cove_game dropped — slots wager must be 20..1000 vCLAW in steps of 20
[Hatcher] play_cove_game dropped — body is 1001wu from the cove (need <=1000wu; use enter_cove first)
[Hatcher] play_cove_game dropped — agent_cove_daily_wager_cap_exceeded
[Hatcher] play_cove_game dropped — rate limit (one play per 30 seconds)
(pass) in-world executor covenant hooks > drops invalid/off-location play without consuming rate and rate-limits after a cap refusal [44.00ms]
[NPC Simulation] Stopped
[Hatcher] play_cove_game dropped — blackjack wager must be 5..500 vCLAW
(pass) in-world executor covenant hooks > settles one blackjack action with the exact live agent/avatar binding [15.51ms]
[NPC Simulation] Stopped
[Hatcher] place_kit_piece dropped - unknown parameter
[Hatcher] claim_parcel dropped â€” duplicate action reserved for 60 seconds
(pass) in-world executor covenant hooks > settles all four Land verbs through one live binding and reserves duplicate semantics [16.21ms]
[NPC Simulation] Stopped
[Hatcher] claim_parcel dropped â€” weeks is rent-only
[Hatcher] prepay_rent dropped â€” weeks must be 1..26
[Hatcher] release_parcel dropped â€” unknown parcelCode "parcel-does-not-exist"
[Hatcher] release_parcel dropped â€” agent session is not ledger-authorized
[Hatcher] place_kit_piece dropped â€” agent session is not ledger-authorized
(pass) in-world executor covenant hooks > drops malformed or non-ledger Land actions before settlement [16.75ms]
[NPC Simulation] Stopped
[Covenant] no avatar attribution for in-world agent body kit-unbound-body; actions continue without records
[Hatcher] place_kit_piece dropped - no bound agent/avatar attribution
[Hatcher] place_kit_piece dropped â€” live agent/avatar binding changed
(pass) in-world executor covenant hooks > drops unbound and live-binding-changed kit actions before settlement [30.18ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > broadcasts an owned+equipped emote and serializes its monotonic sequence [2.29ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > keeps legacy think immediate while an equipped think SKU adds its clip broadcast [0.34ms]
[NPC Simulation] Stopped
[Hatcher] emote dropped — unknown name "shrug"
[Hatcher] emote dropped — unknown name "not_owned"
(pass) in-world executor covenant hooks > drops owned-but-unequipped and unowned emote keys [0.21ms]
[NPC Simulation] Stopped
[Hatcher] emote dropped — unknown name "bad-name!"
[Hatcher] emote dropped — unknown name "constructor"
[Hatcher] emote dropped — unknown name "__proto__"
[Hatcher] emote dropped — unknown name "undefined"
[Hatcher] emote dropped — unknown name "7"
[Hatcher] emote dropped — unknown name "handstand"
(pass) in-world executor covenant hooks > shape/prototype/missing gates drop before any emote ownership query [0.28ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > does not apply an owned-emote result to a despawned/replaced body [0.19ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > completes owner-proven avatar attribution before connect returns [0.52ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > dispatches enter_kelp_forest through the public twelve-verb whitelist [2.08ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > records validated move/building/cove/poker/chat decisions with ids and hashes only [30.71ms]
[NPC Simulation] Stopped
[Hatcher] move dropped — out-of-bounds/invalid (x=-1, y=0)
[Hatcher] enter_building dropped — unknown buildingId "constructor"
[Autonomy] talk_to_npc gated — 3122wu from "api-integrations" (need <=1000wu)
(pass) in-world executor covenant hooks > records nothing for dropped actions or emotes [0.30ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > parses talk_to_npc message robustly: space-separated params and commas inside the message [0.39ms]
[NPC Simulation] Stopped
[Covenant] no avatar attribution for in-world agent body unattributed-body; actions continue without records
(pass) in-world executor covenant hooks > missing attribution executes without a record or throw and warns once per body [0.34ms]
[NPC Simulation] Stopped
(pass) in-world executor covenant hooks > resolves config.avatarId through dispatch and supports post-connect binding [0.23ms]
[NPC Simulation] Stopped
(pass) place_kit_piece seam source contract (finding 10) > forces the MATERIALS rail and ground placement — never a caller-supplied rail [0.08ms]
[NPC Simulation] Stopped
(pass) place_kit_piece seam source contract (finding 10) > resolves the parcel OWNERSHIP-SCOPED and revalidates the live binding under the locks [0.07ms]
[NPC Simulation] Stopped
(pass) place_kit_piece seam source contract (finding 10) > parses only the four whitelisted params — an explicit rail param is refused [0.12ms]

src\services\__tests__\agent-autonomy-activation.test.ts:
[AutonomyStandby] active -> active (reason: default)
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
(pass) (1) activate releases the Controlled-mode suppression (freeze bug) > clears BOTH the until-entry and the launch binding; the 5 Hz refresh cannot re-suppress [1.59ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=true)
(pass) (1) activate releases the Controlled-mode suppression (freeze bug) > kicks one immediate drive only after suppression is released [0.30ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=true)
(pass) (2) activation idempotency > second activate → reused:true, ONE body, ONE entry, phase machine untouched [0.37ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:b23113c0fbc7e3b8) [self-managed]
[AutonomyDriver] owner re-enrolled with a new agent — dropping stale b454f82c5857ebab
[AutonomyDriver] registered user agent f1d11edf5c5cbe84 (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent f1d11edf5c5cbe84 body:ocb-NDQ0NDQ0NDQtNDQ0NC00NDQ0LTg0NDQtNDQ0NDQ0NDQ0NDQ0 (reused=false)
(pass) (2) activation idempotency > one-per-owner: rebinding the avatar to a NEW platform agent drops the stale enrollment [0.35ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent c76577b5b1e89f4e (1/12 user, 0 house)
[AutonomyDriver] registered user agent 69b6cba3f45775d7 (2/12 user, 0 house)
[AutonomyDriver] registered user agent 4d6bd2498f12736d (3/12 user, 0 house)
[AutonomyDriver] registered user agent 3bacfd8002b6994c (4/12 user, 0 house)
[AutonomyDriver] registered user agent 4c285b371d1cd193 (5/12 user, 0 house)
[AutonomyDriver] registered user agent 9da4d8732cec6a64 (6/12 user, 0 house)
[AutonomyDriver] registered user agent 54dba96dedf23e39 (7/12 user, 0 house)
[AutonomyDriver] registered user agent 78648da3f7c152aa (8/12 user, 0 house)
[AutonomyDriver] registered user agent a5102795ab0fa767 (9/12 user, 0 house)
[AutonomyDriver] registered user agent 765b691d6ebd23e7 (10/12 user, 0 house)
[AutonomyDriver] registered user agent f16eadefaf2f8cbd (11/12 user, 0 house)
[AutonomyDriver] registered user agent 0f2215a41f55a729 (12/12 user, 0 house)
[AutonomyActivation] capacity full (12/12) — rejecting owner enrollment for agent b454f82c5857ebab
(pass) (3) capacity > over-cap activation → {ok:false, code:autonomy_capacity} and the §B.2 mint is NEVER called [0.33ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent c76577b5b1e89f4e (1/12 user, 0 house)
[AutonomyDriver] registered user agent 69b6cba3f45775d7 (2/12 user, 0 house)
[AutonomyDriver] registered user agent 4d6bd2498f12736d (3/12 user, 0 house)
[AutonomyDriver] registered user agent 3bacfd8002b6994c (4/12 user, 0 house)
[AutonomyDriver] registered user agent 4c285b371d1cd193 (5/12 user, 0 house)
[AutonomyDriver] registered user agent 9da4d8732cec6a64 (6/12 user, 0 house)
[AutonomyDriver] registered user agent 54dba96dedf23e39 (7/12 user, 0 house)
[AutonomyDriver] registered user agent 78648da3f7c152aa (8/12 user, 0 house)
[AutonomyDriver] registered user agent a5102795ab0fa767 (9/12 user, 0 house)
[AutonomyDriver] registered user agent 765b691d6ebd23e7 (10/12 user, 0 house)
[AutonomyDriver] registered user agent f16eadefaf2f8cbd (11/12 user, 0 house)
[AutonomyDriver] registered user agent 0f2215a41f55a729 (12/12 user, 0 house)
[AutonomyDriver] user-agent registry full (12) — rejecting 854db0f848f98003 (typed capacity rejection, surfaced as 429 autonomy_capacity)
(pass) (3) capacity > direct registerUserAgent over cap is a typed rejection, and idempotent re-register never trips it [0.25ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
(pass) (4) bridge/driver mutual exclusion > activation unregisters the idle-avatar bridge for the owner + marks the owner enrolled [0.27ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (5) deactivation > unenrolls + re-establishes binding AND an immediate suppression window [0.44ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (5) deactivation > is idempotent — a repeat deactivate is a safe no-op [0.23ms]
[NPC Simulation] Stopped
(pass) (5) deactivation > deactivate for a never-enrolled owner is a no-op (no phantom suppression) [0.09ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent ae6d5a55e03eeecb (1 total)
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 1 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
(pass) (6) house-path isolation > registerHouseAgent still works and warms isHouse:true; user entries warm isHouse:false [0.26ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent ae6d5a55e03eeecb (1 total)
(pass) (6) house-path isolation > unregisterUserAgent can NEVER remove a house agent (disjoint registries) [0.08ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent ae6d5a55e03eeecb (1 total)
[AutonomyDriver] refusing user enrollment for ae6d5a55e03eeecb — id collides with a HOUSE agent
(pass) (6) house-path isolation > a user enrollment colliding with a house agentId is refused loudly [0.11ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyDriver] registered house agent ae6d5a55e03eeecb (1 total)
(pass) (6) house-path isolation > user enrollments never consume house capacity (registerHouseAgent unaffected) [0.19ms]
[NPC Simulation] Stopped
(pass) (7) eligibility guards > no active avatar → no_avatar [0.14ms]
[NPC Simulation] Stopped
(pass) (7) eligibility guards > guest avatar → guest_forbidden (demo economy never goes autonomous) [0.13ms]
[NPC Simulation] Stopped
(pass) (7) eligibility guards > avatar without a bound platform agent → no_agent [0.24ms]
[NPC Simulation] Stopped
(pass) (7) eligibility guards > §B.2 refusal (null session) → not_eligible, nothing enrolled [0.14ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (8) enrollment must not outlive its session (logout + TTL teardown) > logout-unenrolls: deactivate keyed by userId tears down WITHOUT any cookie/bearer [0.19ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
(pass) (8) enrollment must not outlive its session (logout + TTL teardown) > ttl-expiry-unenrolls: the sweep primitive (unregisterUserAgent by agentId) drops the entry [0.24ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
(pass) (8) enrollment must not outlive its session (logout + TTL teardown) > browser-close-persists (regression): NO passive op unenrolls — only explicit teardown does [0.25ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b3d456c2aef86e1d (1 total)
(pass) (8) enrollment must not outlive its session (logout + TTL teardown) > teardown is idempotent + house-safe (the sweep calls it for EVERY swept agentId) [0.14ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
(pass) (9) durable enrollment flag lifecycle > activate PERSISTS the flag (by the session agentId) after a successful enroll [0.25ms]
[NPC Simulation] Stopped
(pass) (9) durable enrollment flag lifecycle > a REJECTED activation (guest) never persists the flag [0.16ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (9) durable enrollment flag lifecycle > deactivate CLEARS the flag (by owner userId) [0.24ms]
[NPC Simulation] Stopped
(pass) (9) durable enrollment flag lifecycle > deactivate/logout CLEARS the flag EVEN when not in-memory-enrolled (logout after restart) [0.12ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (9) durable enrollment flag lifecycle > clears the flag BEFORE the in-memory teardown (crash-safe ordering) [0.36ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (9) durable enrollment flag lifecycle > RETRIES a transient flag-clear failure then persists (money-safe, not a silent swallow) [115.36ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "AutonomyTestAgent" (oc-sess:c18fa79b421a0b42) [self-managed]
[AutonomyDriver] registered user agent b454f82c5857ebab (1/12 user, 0 house)
[AutonomyActivation] owner enrolled agent b454f82c5857ebab body:ocb-MjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIy (reused=false)
[AutonomyActivation] CRITICAL: could not clear autonomy_enrolled for owner bd7662a5eeb41614 after 3 attempts — the reconcile may RE-ENROLL a deactivated/logged-out user until a later teardown clears the row (the TTL sweep may NOT heal a re-enrolled row — action required): persistent DB failure
[AutonomyActivation] owner deactivated agent b454f82c5857ebab — handed back to Controlled (suppressed)
(pass) (9) durable enrollment flag lifecycle > exhausts retries on a persistent clear failure but STILL tears down in-memory (loud CRITICAL, never re-enroll-silently) [218.16ms]

src\services\__tests__\agent-autonomy-directive-preemption.test.ts:
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) human directive preemption > preempts walking and decides in the same cycle [3.84ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) human directive preemption > preempts an active talking linger without waiting for its cooldown [0.51ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) human directive preemption > consumes a deciding-phase pending flag exactly once [0.45ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) human directive preemption > clears the fast-path flag after the read while the durable directive remains retryable [0.83ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver][debug] drive t=0 2b9e23b94106ada8 phase=deciding runtime=yes
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver][debug] drive t=0 2b9e23b94106ada8 phase=deciding runtime=yes
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) human directive preemption > runs exactly one follow-up when a directive lands after the in-flight read [4.35ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver][debug] drive t=0 2b9e23b94106ada8 phase=deciding runtime=yes
[AutonomyDriver][debug] drive t=0 2b9e23b94106ada8 phase=deciding runtime=yes
(pass) human directive preemption > bounds the immediate follow-up when a cycle cannot consume the flag [0.46ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
(pass) human directive preemption > does not flag or drive when the enrolled platform identity mismatches [0.16ms]
[NPC Simulation] Stopped
(pass) directive expiry and durable acted issuance > parses the TTL config strictly and expires only after the boundary [0.19ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[Covenant] no avatar attribution for in-world agent body directive-preemption-body; actions continue without records
(pass) directive expiry and durable acted issuance > treats an expired directive as absent and compare-and-clears that issuance [1.09ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) directive expiry and durable acted issuance > hydrates a durable acted SHA on re-seat and fires neither event again [0.68ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) directive expiry and durable acted issuance > fires normally for a new issuance after an expired directive [1.15ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) directive expiry and durable acted issuance > keeps hydration unknown on read failure and persists before acted event [1.02ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) directive expiry and durable acted issuance > lets only one overlapping claimant emit for a standing issuance [0.84ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] directive acted marker failed for 2b9e23b94106ada8: write unavailable
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) directive expiry and durable acted issuance > keeps action dispatch fail-soft when the acted claim is unknown [0.83ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 2b9e23b94106ada8 (1/12 user, 0 house)
[AutonomyDriver] 2b9e23b94106ada8 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] 2b9e23b94106ada8 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) directive expiry and durable acted issuance > does not emit or dispatch when the directive is superseded mid-decision [0.53ms]

src\services\__tests__\agent-autonomy-p1.test.ts:
[NPC Simulation] Stopped
[Autonomy] talk_to_npc gated — 1622wu from "api-integrations" (need <=1000wu)
(pass) P1 proximity gate — executeHatcherAction talk_to_npc > DROPS a far talk_to_npc for a non-hatcher-proxy body [0.38ms]
[NPC Simulation] Stopped
(pass) P1 proximity gate — executeHatcherAction talk_to_npc > PASSES a near talk_to_npc for a non-hatcher-proxy body [0.14ms]
[NPC Simulation] Stopped
(pass) P1 proximity gate — executeHatcherAction talk_to_npc > PASSES at a large building where the OLD center-distance gate was unsatisfiable (the fix) [0.09ms]
[NPC Simulation] Stopped
(pass) P1 proximity gate — executeHatcherAction talk_to_npc > does NOT gate a hatcher-proxy body (far still passes — live-partner exemption) [0.08ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent ea0fe7156804d0a4 (1 total)
[earned-skill-memory] keyword fallback read failed (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] ea0fe7156804d0a4 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] ea0fe7156804d0a4 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] ea0fe7156804d0a4 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[Covenant] no avatar attribution for in-world agent body ocb-house-test; actions continue without records
(pass) P1 autonomy driver — decide → enter_building > picks a teacher (prompt lists teachers) and emits an enter_building action [2.39ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent c696aa13682ee577 (1 total)
[earned-skill-memory] keyword fallback read failed (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] c696aa13682ee577 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] c696aa13682ee577 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] c696aa13682ee577 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[Covenant] no avatar attribution for in-world agent body ocb-nomoney; actions continue without records
(pass) P1 autonomy driver — decide → enter_building > driver + executor settle ZERO CT during a decide → enter_building → talk turn (no-money invariant) [20.04ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent dad6f1c38af36b28 (1 total)
(pass) P1 autonomy driver — decide → enter_building > registry is bounded and register/unregister round-trips [0.15ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent a9f86fac1f412b39 (1 total)
[AutonomyDriver] runtime warm failed for a9f86fac1f412b39 — retry next tick
(pass) P1 autonomy driver — decide → enter_building > lazy-warms the runtime on tick when the brain is not ready, preserving isHouse (boot-timing) [0.94ms]
[NPC Simulation] Stopped
(pass) P1 house agent config + ambient-conversation exclusion > house avatar config registers the body as self-managed (B1) [0.11ms]
[NPC Simulation] Stopped
(pass) P1 house agent config + ambient-conversation exclusion > excludes a self-managed OpenClaw body from ambient-conversation selection, not a server-managed one (N4) [0.23ms]
[NPC Simulation] Stopped
(pass) F1 — resolveBuildingCenter prototype-key guard (real-CT money path) > resolveBuildingCenter returns null for prototype keys (credit path unreachable) [0.08ms]
[NPC Simulation] Stopped
(pass) F1 — resolveBuildingCenter prototype-key guard (real-CT money path) > resolveBuildingCenter returns real coords for a genuine buildingId [0.06ms]
[NPC Simulation] Stopped
(pass) F1 — resolveBuildingCenter prototype-key guard (real-CT money path) > demonstrates WHY the guard matters: a bare proto key yields a NaN distance the > RADIUS check cannot reject [0.09ms]
[NPC Simulation] Stopped
(pass) resolveBuildingId — label-tolerant slug resolution (dropped-decide-tick fix) > passes a genuine slug through unchanged [0.06ms]
[NPC Simulation] Stopped
(pass) resolveBuildingId — label-tolerant slug resolution (dropped-decide-tick fix) > resolves a human label to its canonical slug [0.09ms]
[NPC Simulation] Stopped
(pass) resolveBuildingId — label-tolerant slug resolution (dropped-decide-tick fix) > is case/punctuation-insensitive for labels and slugs [0.07ms]
[NPC Simulation] Stopped
(pass) resolveBuildingId — label-tolerant slug resolution (dropped-decide-tick fix) > returns null for prototype keys and unknown targets (no CT-farm alias) [0.09ms]
[NPC Simulation] Stopped
(pass) resolveBuildingId — label-tolerant slug resolution (dropped-decide-tick fix) > only ever returns an own-property teaching-building slug [0.06ms]
[AutonomyDriver] durable-autonomy reconcile failed (non-fatal): DATABASE_URL environment variable is not set

src\services\__tests__\agent-autonomy-reconcile.test.ts:
[AutonomyReconcile] candidates=2 enrolled=2 skipped=0 capacity=0 ineligible=0
(pass) reconcileDurableAutonomy > re-enrolls every flagged+live owner not already driving [0.41ms]
[AutonomyDriver] registered user agent 9d9b8a12235e3c4b (1/12 user, 0 house)
(pass) reconcileDurableAutonomy > SKIPS an owner already enrolled in this process (idempotent across restarts/passes) [0.19ms]
(pass) reconcileDurableAutonomy > SKIPS an owner the human is currently driving (suppression window live) [0.13ms]
[AutonomyReconcile] candidates=1 enrolled=0 skipped=0 capacity=1 ineligible=0
[AutonomyReconcile] candidates=1 enrolled=0 skipped=0 capacity=1 ineligible=0
(pass) reconcileDurableAutonomy > over-cap STAYS flagged + is tallied as capacity (never cleared, retries next pass) [0.13ms]
[AutonomyReconcile] candidates=1 enrolled=0 skipped=0 capacity=0 ineligible=1
(pass) reconcileDurableAutonomy > terminally-ineligible (e.g. no_agent) is left flagged (self-heals at TTL), tallied ineligible [0.12ms]
[AutonomyDriver] registered user agent 9d9b8a12235e3c4b (1/12 user, 0 house)
[AutonomyReconcile] candidates=1 enrolled=1 skipped=0 capacity=0 ineligible=0
(pass) reconcileDurableAutonomy > idempotent: a repeat pass after a successful enroll skips (no duplicate enroll) [0.18ms]
[AutonomyDriver] registered house agent 158fa88ddfe3cc8d (1 total)
(pass) reconcileDurableAutonomy > house registry is never touched (reconcile only lists non-house rows) [0.11ms]
[AutonomyReconcile] candidates=1 enrolled=1 skipped=0 capacity=0 ineligible=0
(pass) reconcileDurableAutonomy > overlap guard: a second pass while one is in flight returns early (no stacking) [0.17ms]

src\services\__tests__\agent-autonomy-round1.test.ts:
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 6eafb84d9f557b7d (1 total)
(pass) round 1 perception + decision prompt > derives map venues with exact executor syntax [0.39ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 36d0f2357a7e85e9 (1 total)
(pass) round 1 perception + decision prompt > renders directive first, then compact scope + full executor menu + cove place [0.28ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent fe36a12aeff67c20 (1 total)
(pass) round 1 perception + decision prompt > shows trading state only for a linked agent and keeps trade_token in the full menu [0.45ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent e41bbefd451d69c0 (1 total)
(pass) round 1 perception + decision prompt > renders closed, copyable owned and claimable land targets [0.33ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent c1956f86fd879591 (1 total)
(pass) round 1 perception + decision prompt > surfaces the terminal cove action when the agent is already in range [0.29ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent a199f0314b9de5ca (1 total)
(pass) round 1 perception + decision prompt > keeps the proximity block absent when every place is out of range [0.17ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 248d42329da92769 (1 total)
(pass) round 1 perception + decision prompt > renders at most three ordered, bounded book and visit knowledge snippets [0.18ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent e935b5a4a801d3d0 (1 total)
(pass) round 1 perception + decision prompt > keeps the prompt byte-identical when knowledge is omitted or empty [0.13ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent d28c98e5c4e113ce (1 total)
[AutonomyDriver] d28c98e5c4e113ce land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] d28c98e5c4e113ce quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] d28c98e5c4e113ce trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[Covenant] no avatar attribution for in-world agent body dispatch-agent; actions continue without records
[AutonomyDriver] d28c98e5c4e113ce land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] d28c98e5c4e113ce quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] d28c98e5c4e113ce trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) round 1 perception + decision prompt > dispatches a cove destination but keeps one-shot emote in deciding [1.21ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 6c62bc27f9b3f6cc (1 total)
[AutonomyDriver] covenant agent.visit record failed for 6c62bc27f9b3f6cc: DATABASE_URL environment variable is not set
(pass) round 1 perception + decision prompt > recognizes cove arrival without teacher talk or settlement [0.99ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent c6456d832ce952c6 (1/12 user, 0 house)
(pass) round 1 cadence > kicks only the actively-enrolled owner agent whose platform identity matches [0.21ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 9273ee0ca92f26a8 (1 total)
[AutonomyDriver][debug] drive t=2 9273ee0ca92f26a8 phase=deciding runtime=yes
(pass) round 1 cadence > warms then drives in the same cycle and passes the 6s local attempt budget [0.28ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent bd1db806f985b13b (1 total)
[AutonomyDriver] registered house agent 816c6d1ac3075e9a (2 total)
[AutonomyDriver][debug] drive t=3 816c6d1ac3075e9a phase=deciding runtime=yes
[AutonomyDriver][debug] drive t=3 bd1db806f985b13b phase=deciding runtime=yes
(pass) round 1 cadence > does not serialize a warm agent behind another agent cold-warming [6.86ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent d9e508db9c3e54b8 (1 total)
[AutonomyDriver][debug] drive t=3 d9e508db9c3e54b8 phase=deciding runtime=yes
(pass) round 1 cadence > skips an overlapping kick for the same agent instead of queueing it [2.19ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent f18e1b22aef189e5 (1 total)
[AutonomyDriver] evicting stale warm guard for f18e1b22aef189e5 — runtime warm never settled after 660000ms
[AutonomyDriver][debug] drive t=3 f18e1b22aef189e5 phase=deciding runtime=yes
(pass) round 1 cadence > evicts a never-settling warm guard so the agent cannot wedge forever [0.30ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent 0970582c1d3adcf0 (1/12 user, 0 house)
[AutonomyDriver][debug] drive t=3 0970582c1d3adcf0 phase=deciding runtime=yes
[AutonomyDriver] registered user agent 0970582c1d3adcf0 (1/12 user, 0 house)
[AutonomyDriver][debug] drive t=3 0970582c1d3adcf0 phase=deciding runtime=yes
(pass) round 1 cadence > preserves the guard across same-id unregister and re-register [0.37ms]

src\services\__tests__\agent-autonomy-round2.test.ts:
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent b6996329ead4b029 (1/12 user, 0 house)
(pass) round 2 owner status and thought feed > returns the exact public-safe owner shape and no private ids [0.42ms]
[NPC Simulation] Stopped
(pass) round 2 owner status and thought feed > narrates each economy action instead of falling back to generic noise [0.18ms]
[NPC Simulation] Stopped
(pass) round 2 owner status and thought feed > falls back safely for malformed economy parameters [0.10ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent b6996329ead4b029 (1/12 user, 0 house)
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[Covenant] no avatar attribution for in-world agent body round2-body; actions continue without records
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) round 2 owner status and thought feed > records a new directive once, acts once per sha, and caps thoughts at 20 [4.80ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent b6996329ead4b029 (1/12 user, 0 house)
[AutonomyDriver] b6996329ead4b029 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 salvage targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b6996329ead4b029 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) round 2 owner status and thought feed > narrates empty decisions and walk timeouts as observations [0.44ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered user agent b6996329ead4b029 (1/12 user, 0 house)
(pass) round 2 owner status and thought feed > records one cove arrival and retains the target label through linger [0.28ms]

src\services\__tests__\agent-autonomy-state.test.ts:
(pass) directiveBodySchema > accepts a valid directive string [0.19ms]
(pass) directiveBodySchema > trims and rejects a blank/whitespace-only directive [0.55ms]
(pass) directiveBodySchema > rejects a directive longer than the cap [0.14ms]
(pass) directiveBodySchema > accepts clear:true with no directive [0.06ms]
(pass) directiveBodySchema > rejects an empty body (neither directive nor clear) [0.04ms]
(pass) directiveBodySchema > strips unknown keys and rejects when only unknown keys are present [0.05ms]
(pass) buildDirectiveValue > trims + caps the text and stamps setAt/setBy [0.06ms]
(pass) buildDirectiveValue > hard-caps an over-length directive to DIRECTIVE_MAX_LEN [0.03ms]
(pass) parseStoredDirective > parses a well-formed stored value [0.05ms]
(pass) parseStoredDirective > returns null for absent/garbage/empty-text values [0.03ms]
(pass) parseStoredDirective > defaults an unknown setBy to "api" and missing setAt to epoch [0.03ms]
(pass) parseLastActedDirectiveSha > accepts only a complete lowercase SHA-256 marker [0.06ms]
(pass) classifyDirectiveActedClaimLoss > distinguishes an already-recorded issuance from replaced/missing state [0.06ms]
(pass) formatDirectiveContext (shared planner-bias formatter) > produces a top-priority block containing the directive text [0.03ms]
(pass) formatDirectiveContext (shared planner-bias formatter) > collapses whitespace and caps length [0.04ms]
(pass) formatDirectiveContext (shared planner-bias formatter) > returns "" for null/empty so callers stay byte-identical without a directive [0.02ms]
(pass) summarizeAutonomyEvents > returns "" for no rows [0.04ms]
(pass) summarizeAutonomyEvents > summarizes types with building + net hints [0.06ms]
(pass) summarizeAutonomyEvents > keeps only the last `max` rows and bounds total length [0.08ms]

src\services\__tests__\agent-autonomy-walk-budget.test.ts:
[NPC Simulation] Stopped
(pass) route-scaled autonomy walk budget > T1: applies the 120 second floor [0.27ms]
[NPC Simulation] Stopped
(pass) route-scaled autonomy walk budget > T2: scales a 13,000 wu route deterministically [0.05ms]
[NPC Simulation] Stopped
(pass) route-scaled autonomy walk budget > T3: applies the 180 second ceiling [0.04ms]
[NPC Simulation] Stopped
(pass) route-scaled autonomy walk budget > T4: maps junk lengths to the floor [0.08ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
[AutonomyDriver] b54d1f5273c798b4 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b54d1f5273c798b4 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b54d1f5273c798b4 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
[Covenant] no avatar attribution for in-world agent body walk-budget-body; actions continue without records
(pass) route-scaled autonomy walk budget > T5: walk start initializes all four episode fields [1.22ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T6: wedge re-routes without an LLM call [1.04ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T7: deadline overrun re-routes without an LLM call [0.74ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T8: an exhausted replan budget falls back to deciding [0.19ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T9: the episode ceiling forces a re-decision before another replan [0.15ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T10: a legacy entry keeps the flat-timeout re-decision behavior [0.23ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T11: a legacy entry is never wedge-checked [0.17ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T12: collider-edge arrival at large buildings never re-routes [32.62ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
[AutonomyDriver] b54d1f5273c798b4 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b54d1f5273c798b4 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b54d1f5273c798b4 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) route-scaled autonomy walk budget > T13: the cycle after timeout fallback really decides [0.51ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
[AutonomyDriver][debug] drive t=3 b54d1f5273c798b4 phase=walking runtime=not-required
(pass) route-scaled autonomy walk budget > T14: walking progresses even when no cognition runtime is available [0.75ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
[AutonomyDriver] runtime warm failed for b54d1f5273c798b4 — retry next tick
(pass) route-scaled autonomy walk budget > T15: pending directives still take the warm-runtime path [0.25ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
(pass) route-scaled autonomy walk budget > T16: arrival clears all walk episode state [0.23ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent b54d1f5273c798b4 (1 total)
[AutonomyDriver] b54d1f5273c798b4 land targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b54d1f5273c798b4 quest targets unavailable (non-fatal): DATABASE_URL environment variable is not set
[AutonomyDriver] b54d1f5273c798b4 trading desk unavailable (non-fatal): DATABASE_URL environment variable is not set
(pass) route-scaled autonomy walk budget > T17: directive preemption still outranks an active walk [0.31ms]

src\services\__tests__\agent-body-id-leak.test.ts:
[OpenClaw] Avatar injected: "LeakTestBot" (oc-sess:51926e48a51b52c8) [server-managed]
[OpenClaw] Unregistered: sess:51926e48a51b52c8
(pass) B1 root-fix — avatar body id is decoupled from the bearer sessionId > registers the body under `ocb-<base64url(agentId)>`, never `oc-<sessionId>` [1.89ms]
[OpenClaw] Avatar injected: "LeakTestBot" (oc-sess:51926e48a51b52c8) [server-managed]
[OpenClaw] Unregistered: sess:51926e48a51b52c8
(pass) B1 root-fix — avatar body id is decoupled from the bearer sessionId > reverse lookups still resolve via the bodyId ↔ sessionId map [0.15ms]
[OpenClaw] Avatar injected: "LeakTestBot" (oc-sess:51926e48a51b52c8) [server-managed]
[OpenClaw] Unregistered: sess:51926e48a51b52c8
(pass) B1 root-fix — avatar body id is decoupled from the bearer sessionId > NO sim serializer OR perception-input leaks the bearer for an avatar body [0.68ms]
[OpenClaw] Avatar injected: "LeakTestBot" (oc-sess:51926e48a51b52c8) [server-managed]
[OpenClaw] Unregistered: sess:51926e48a51b52c8
(pass) B1 root-fix — avatar body id is decoupled from the bearer sessionId > unregister removes the body and leaves no trace in the snapshot [0.13ms]
[OpenClaw] Avatar injected: "LeakTestBot" (oc-sess:51926e48a51b52c8) [server-managed]
[OpenClaw] Unregistered: sess:51926e48a51b52c8
(pass) B1 root-fix — avatar body id is decoupled from the bearer sessionId > conversations[]/combats[] participant ids stay CONSISTENT with npcs[].id (speech-bubble correlation) [0.28ms]

src\services\__tests__\agent-body-idle-sweeper.test.ts:
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Round1bAgent" (oc-sess:165fe7d5194848f5) [self-managed]
[AutonomyDriver] registered user agent c47b3d48e2d9d3bf (1/12 user, 0 house)
[OpenClaw] Unregistered: sess:165fe7d5194848f5
[BodyIdleSweeper] despawned 1 idle agent body (idle > 5min) — sessions stay restorable
(pass) user-agent idle body lifecycle > keeps a stale driver-enrolled body, then despawns it after unenrollment [1.11ms]

src\services\__tests__\agent-collaboration-attribution.test.ts:
[Collaboration] cron-automation consulting: memory-rag, api-integrations
(pass) agent collaboration event attribution > attributes every returned insight to an agent initiator using agent_id only [2.63ms]
[Collaboration] cron-automation consulting: memory-rag, api-integrations
(pass) agent collaboration event attribution > attributes every returned insight to a human initiator using avatar_id and user_id [0.22ms]
[Collaboration] cron-automation consulting: memory-rag, api-integrations
(pass) agent collaboration event attribution > keeps an unauthenticated consultation subjectless and marks it unattributed [0.17ms]
[Collaboration] cron-automation consulting: memory-rag, api-integrations
(pass) agent collaboration event attribution > emits exactly one event per returned insight even when a response is empty [0.20ms]

src\services\__tests__\agent-connect-normalization.test.ts:
(pass) universal /connect tolerant normalization matrix > legacy Milady signal keeps its exact fallback handle and hosted route [0.27ms]
(pass) universal /connect tolerant normalization matrix > explicit Milady needs no legacy field and legacy handle wins when both exist [0.07ms]
(pass) universal /connect tolerant normalization matrix > legacy Milady continuity keeps the plugin handle and ownership ticket [0.03ms]
(pass) universal /connect tolerant normalization matrix > Milady accepts and deterministically reports every unused gateway field [0.06ms]
(pass) universal /connect tolerant normalization matrix > Hermes ignores caller gateway fields and follows either gate state [0.06ms]
(pass) universal /connect tolerant normalization matrix > OpenClaw with a real gateway keeps its declared wire and cannot restore [0.05ms]
(pass) universal /connect tolerant normalization matrix > existing declared-gateway row keeps its stored protocol when reconnect omits it [0.05ms]
(pass) universal /connect tolerant normalization matrix > gateway-less OpenClaw accepts and restores under both gate states [0.06ms]
(pass) universal /connect tolerant normalization matrix > custom uses a real gateway or gateway-less pull from the same contract [0.05ms]
(pass) universal /connect tolerant normalization matrix > unknown bounded labels use the general custom adapter [0.05ms]
(pass) universal /connect tolerant normalization matrix > omitted identity defaults to custom with or without a gateway [0.05ms]
(pass) universal /connect tolerant normalization matrix > explicit nanoclaw wins over a supplied gateway and uses no secret [0.05ms]
(pass) universal /connect tolerant normalization matrix > explicit identity wins over the Milady signal without losing its fallback handle [0.04ms]
(pass) protected Hatcher restore classification > complete hatcher-proxy config stays restorable; missing config stays rejected [0.04ms]

src\services\__tests__\agent-control-handback.test.ts:
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Handback" (oc-sess:e18999c5db6753bb) [self-managed]
(pass) (a) suppression covers avatar-mode ocb- bodies (avatarBodyOwners) > marked avatar body is suppressed, and lapses after the TTL [0.35ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Handback" (oc-sess:1cd317330cba29e2) [self-managed]
(pass) (a) suppression covers avatar-mode ocb- bodies (avatarBodyOwners) > suppression survives owner-session churn (the exact pre-fix ocb- gap) [0.10ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Handback" (oc-sess:6b9aa12f0ddc72a4) [self-managed]
(pass) (a) suppression covers avatar-mode ocb- bodies (avatarBodyOwners) > buildPerception carries the humanControlled signal for the body [0.20ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Handback" (oc-sess:97c2062bda7951f7) [self-managed]
[OpenClaw] Unregistered: sess:97c2062bda7951f7
[OpenClaw] Avatar injected: "Handback" (oc-sess:a9041978dd63bc99) [self-managed]
[OpenClaw] Unregistered: sess:5457163eb5a95d63
(pass) (a) suppression covers avatar-mode ocb- bodies (avatarBodyOwners) > ownership-scoped teardown clears the avatarBodyOwners entry [0.13ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Handback" (oc-sess:6bf899cb4eb4e90a) [self-managed]
(pass) (b) bindAgentOwner — in-memory half of bind-at-redemption > fills a live config boundUserId and reports the update count [0.14ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "Handback" (oc-sess:653d044c2649eefd) [self-managed]
(pass) (b) bindAgentOwner — in-memory half of bind-at-redemption > never clobbers a config bound to a DIFFERENT user [0.08ms]
[NPC Simulation] Stopped
(pass) (b) bindAgentOwner — in-memory half of bind-at-redemption > returns 0 when the agent has no live session (row bind still stands) [0.04ms]
[NPC Simulation] Stopped
(pass) (c) canBindAgentOwner — the /enter SQL guard as a predicate > unowned row → bindable [0.03ms]
[NPC Simulation] Stopped
(pass) (c) canBindAgentOwner — the /enter SQL guard as a predicate > same owner → bindable (idempotent returning scenario) [0.08ms]
[NPC Simulation] Stopped
(pass) (c) canBindAgentOwner — the /enter SQL guard as a predicate > DIFFERENT owner → never clobbered [0.04ms]
[NPC Simulation] Stopped
(pass) (d) status shape — E5 honesty + read-side ledger predicate > UNBOUND session: stats/ownership forced null even when values were passed [0.09ms]
[NPC Simulation] Stopped
(pass) (d) status shape — E5 honesty + read-side ledger predicate > BOUND session: stats/ownership pass through; ledgerCapable mirrors the spend gate [0.06ms]
[NPC Simulation] Stopped
(pass) (d) status shape — E5 honesty + read-side ledger predicate > SECURITY: row-bound but UNPROVEN session (non-ledger reconnect to a victim agentId) must NOT leak the victim economy [0.05ms]
[NPC Simulation] Stopped
(pass) (d) status shape — E5 honesty + read-side ledger predicate > sessionLedgerCapable — the exact resolveAgentSession grant condition [0.06ms]

src\services\__tests__\agent-human-control-guard.test.ts:
(pass) external agent human-control guard > locks the complete production mutation inventory [0.07ms]
(pass) external agent human-control guard > wires every inventory constant to the production guard helper [0.90ms]
(pass) external agent human-control guard > returns 409 during the lease and succeeds after it lapses [0.89ms]
(pass) external agent human-control guard > leaves read-only requests and missing configs to existing handlers [0.51ms]
(pass) external agent human-control guard > authoritative liveness keeps stale-map controlled sessions on the existing 404 [0.22ms]
(pass) external agent human-control guard > poker read tools remain available and unknown tools keep their 404 precedence [0.49ms]

src\services\__tests__\agent-owner-binding-connect.test.ts:
(pass) connect owner binding > returning identity disclosure is nonsecret and actionable [0.08ms]
(pass) connect owner binding > connection-token claims require the stable agentId before reservation [0.05ms]
(pass) connect owner binding > bare agentId knowledge never proves ownership or ledger access [0.06ms]
(pass) connect owner binding > explicit identity heals an unbound row but needs an active avatar for ledger [0.04ms]
(pass) connect owner binding > a conflicting live owner wins a stale-read identity race [0.03ms]
(pass) connect owner binding > owned connection token retains intentional precedence [0.02ms]
(pass) connect owner binding > connection token wallet authorization is derived from the persisted bind [0.05ms]
(pass) connect owner binding > explicit identity wallet authorization is derived from the persisted bind
(pass) connect owner binding > Milady inferred wallet authorization is derived from the persisted bind
(pass) connect owner binding > gateway inferred wallet authorization is derived from the persisted bind
(pass) connect owner binding > conflicting owner wallet authorization is derived from the persisted bind
(pass) connect owner binding > anonymous wallet authorization is derived from the persisted bind

src\services\__tests__\agent-pay-resume.test.ts:
(pass) agent-pay resume worker > fulfills a landed captured payment exactly once across two ticks [1.37ms]
(pass) agent-pay resume worker > moves a stale captured on-chain error to reconcile without minting [0.38ms]
(pass) agent-pay resume worker > moves a stale payment with no captured signature to reconcile [0.14ms]
(pass) agent-pay resume worker > lets auto-reconcile own fresh stale alerts while preserving the >24h survivor alert [0.16ms]
(pass) agent-pay resume worker > re-asserts the expected signature at the reconcile mutation boundary [0.23ms]
(pass) agent-pay resume worker > uses strict 120-second candidate and stale-threshold boundaries [0.20ms]
(pass) agent-pay resume worker > treats a stale missing or metadata-less transaction as stale_settling [0.20ms]
(pass) agent-pay resume worker > survives one row throwing and continues to the next row [0.30ms]
(pass) agent-pay resume worker > expires dead pending rows before counting and only pages signed survivors [0.23ms]
(pass) agent-pay resume worker > keeps Tier-1 settlement payments retryable past the generic pending expiry [0.12ms]
(pass) agent-pay resume worker > continues to count and alert survivors when pending expiry throws [0.19ms]
(pass) agent-pay resume worker > pages a steady stale-pending backlog once, re-paging only when the count changes [0.14ms]
(pass) agent-pay resume worker > always resolves when both DB scans throw [0.17ms]
(pass) agent-pay resume worker > skips an overlapping pass and releases the guard afterward [0.30ms]
[agent-pay-resume] worker started — checking stranded payments every 1min (forward-only; never re-sends)
(pass) agent-pay resume worker > resolves poll cadence defaults/floor and starts/stops idempotently [0.18ms]

src\services\__tests__\agent-pay.test.ts:
(pass) agent-pay durable x402 machine > settles, mints full-basis EARNED once, and replays without a second settle/mint [3.21ms]
(pass) agent-pay durable x402 machine > same idempotency key with a different payload conflicts [0.25ms]
(pass) agent-pay durable x402 machine > concurrent duplicate calls take one CAS claim and settle/mint once [0.21ms]
(pass) agent-pay durable x402 machine > re-reads a lost capture and fulfills an already-captured signature [0.23ms]
(pass) agent-pay durable x402 machine > refuses insufficient USDC before facilitator execution [0.15ms]
(pass) agent-pay durable x402 machine > terminal-fails a missing recipient ATA before any PayAI interaction [0.24ms]
(pass) agent-pay durable x402 machine > fails open when the recipient ATA probe is indeterminate [0.25ms]
(pass) agent-pay durable x402 machine > proceeds unchanged when the recipient ATA exists [0.22ms]
(pass) agent-pay durable x402 machine > definitive facilitator failure becomes failed and mints nothing [0.25ms]
(pass) agent-pay durable x402 machine > rearms Tier-1 attempt 2 after a signature-free Meridian verify rejection [0.34ms]
(pass) agent-pay durable x402 machine > rearms Tier-1 attempt 2 after a signature-free Meridian settle failure [0.22ms]
(pass) agent-pay durable x402 machine > reconciles any Meridian failure carrying a signature and freezes Tier-1 retry [0.27ms]
(pass) agent-pay durable x402 machine > persists a definitive settle rejection as cap-exempt and replays without execution [0.24ms]
(pass) agent-pay durable x402 machine > keeps an unknown signature-less settle rejection countable [0.40ms]
(pass) agent-pay durable x402 machine > marks an unexpected verify-only reconcile as cap-exempt [0.21ms]
(pass) agent-pay durable x402 machine > a thrown post-claim facilitator call becomes reconcile and never retries [0.48ms]
(pass) agent-pay durable x402 machine > enforces intrinsic positive-integer validation and the configured maximum [0.15ms]
(pass) agent-pay durable x402 machine > lets a bounded platform policy supply its own per-payment ceiling [0.22ms]
(pass) agent-pay durable x402 machine > refuses a new payment below the configured minimum before admission or PayAI [0.20ms]
(pass) agent-pay durable x402 machine > settles the exact five-cent default minimum [0.17ms]
(pass) agent-pay durable x402 machine > dispatches a pre-existing two-cent pending replay despite the new minimum [0.17ms]
(pass) agent-pay durable x402 machine > refuses self-payment before looking up the wallet [0.13ms]
(pass) agent-pay durable x402 machine > resumes captured fulfillment without calling the facilitator again [0.28ms]
(pass) agent-pay durable x402 machine > strictly parses daily-cap env values with defaults and a 100-cent floor [0.10ms]
(pass) agent-pay durable x402 machine > strictly parses minimum and daily-count env values with defaults and a floor of one [0.13ms]
(pass) agent-pay durable x402 machine > admits the 50th sender payment and refuses the 51st with the count detail [0.48ms]
(pass) agent-pay durable x402 machine > excludes failed and cap-exempt rows from the sender payment count [0.31ms]
(pass) agent-pay durable x402 machine > exempts platform-mediated bounties from count only while retaining dollar caps [0.39ms]
(pass) agent-pay durable x402 machine > admits a payment whose cumulative sender and recipient usage equals each cap [0.24ms]
(pass) agent-pay durable x402 machine > blocks a sender already at cap before creating a pending row [0.18ms]
(pass) agent-pay durable x402 machine > blocks the recipient cap independently of unused sender capacity [0.15ms]
(pass) agent-pay durable x402 machine > excludes failed payments from daily usage [0.17ms]
(pass) agent-pay durable x402 machine > excludes a durable cap-exempt reconcile row from daily usage [0.22ms]
(pass) agent-pay durable x402 machine > counts an ambiguous reconcile row even when its failure reason matches an exempt row [0.18ms]
(pass) agent-pay durable x402 machine > counts pending, settling, and settled rows toward daily usage [0.32ms]
(pass) agent-pay durable x402 machine > does not let 5,295 proven no-broadcast reconciles consume the daily cap [4.46ms]
(pass) agent-pay durable x402 machine > replays an existing cap-exempt reconcile without re-running admission [0.20ms]
(pass) agent-pay durable x402 machine > does not count payments created before the current UTC day [0.25ms]
(pass) agent-pay durable x402 machine > serializes distinct senders near one recipient cap and admits at most the cap [0.30ms]
(pass) agent-pay durable x402 machine > uses strict circuit-breaker defaults and floors [0.08ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 2,
}
(pass) agent-pay durable x402 machine > opens after consecutive facilitator failures and fails fast before wallets or admission [0.43ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 2,
}
(pass) agent-pay durable x402 machine > counts PayAI outages hidden by successful Meridian fallback settlements [0.41ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 2,
}
[agent-pay-breaker] open -> half_open {
  facilitator: "payai",
  consecutiveFailures: 2,
}
[agent-pay-breaker] half_open -> closed {
  facilitator: "payai",
  consecutiveFailures: 0,
}
(pass) agent-pay durable x402 machine > allows exactly one half-open probe and closes on its success [0.63ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
[agent-pay-breaker] open -> half_open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
[agent-pay-breaker] half_open -> open {
  facilitator: "payai",
  consecutiveFailures: 2,
}
(pass) agent-pay durable x402 machine > re-opens after a failed half-open probe without duplicate outage alerts [0.34ms]
(pass) agent-pay durable x402 machine > does not count payment-specific facilitator rejections [0.28ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
(pass) agent-pay durable x402 machine > counts facilitator fee-payer discovery failures without executing settlement [0.26ms]
[agent-pay-breaker] closed -> open {
  facilitator: "payai",
  consecutiveFailures: 1,
}
(pass) agent-pay durable x402 machine > never gates captured-payment fulfillment while the circuit is open [0.25ms]

src\services\__tests__\agent-reconnect-session.test.ts:
[NPC Simulation] Stopped
(pass) (1) gateway-credential zod trio (connectSchema parity shapes) > accepts an all-absent body and a full valid trio [1.89ms]
[NPC Simulation] Stopped
(pass) (1) gateway-credential zod trio (connectSchema parity shapes) > rejects a non-URL gatewayUrl, an empty authToken, and an unknown protocol [0.66ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > mints a fail-soft nanoclaw config — never an armed outbound client [0.39ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > every real-gateway identity type dorms without credentials (openclaw/custom) [0.12ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > a restorable no-gateway type (hermes) is NOT dormant — its wire is natively fail-soft [0.09ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > native Milady/Hermes rows ignore and heal stale caller gateways [0.14ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > native Milady/Hermes ignore caller gateway credentials and do not persist them [0.15ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > stored explicit pull ignores stale gateway facts and heals them [0.17ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > requested explicit pull ignores supplied gateway credentials and persists only pull facts [0.14ms]
[NPC Simulation] Stopped
(pass) (2) dormant-inert fallback (real-gateway type, no credentials) > gateway-less OpenClaw is a non-dormant safe pull session when its local gate is off [0.09ms]
[NPC Simulation] Stopped
(pass) (3) full outbound rebuild when credentials are re-supplied > gatewayUrl + authToken + protocol → armed client config + persisted url/protocol [0.08ms]
[NPC Simulation] Stopped
(pass) (3) full outbound rebuild when credentials are re-supplied > authToken alone re-arms against the row-persisted REAL gateway [0.08ms]
[NPC Simulation] Stopped
(pass) (3) full outbound rebuild when credentials are re-supplied > authToken alone with no real row gateway becomes safe pull without persisting the credential [0.11ms]
[NPC Simulation] Stopped
(pass) (4) proof-carrying ledger rule > ledgerCapable true IFF the row is bound to the proven user [0.15ms]
[NPC Simulation] Stopped
(pass) (5) refusals — partner rows + unseatable overrides > a reserved partner identity type (hatcher) is never minted [0.06ms]
[NPC Simulation] Stopped
(pass) (5) refusals — partner rows + unseatable overrides > an override-mode row without a target NPC cannot be re-seated [0.05ms]
[NPC Simulation] Stopped
(pass) (6) old-hash invalidation > the persisted sessionKeyHash is the NEW bearer hash and differs from the old [0.07ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "ReconnectTest" (oc-sess:84154b84115836d6) [server-managed] [restored position]
[OpenClaw] Unregistered: sess:84154b84115836d6
[OpenClaw] Avatar injected: "ReconnectTest" (oc-sess:22c99b9c6fef606c) [server-managed] [restored position]
(pass) (7) reconnect replaces the body — never duplicates, never leaves the old bearer live > evict → re-register yields ONE ocb- body owned by the new session; old session is gone [0.34ms]

src\services\__tests__\agent-session-classify.test.ts:
(pass) isHostedAvatarAgentSessionRow — the un-spoofable discriminator > TRUE only when agentId == avatar.platformAgentId AND harness is hosted [1.69ms]
(pass) hosted avatar-agent → mode:hosted at ALL times > POST-mint (its own session row present) → hosted, not external-active [0.21ms]
(pass) hosted avatar-agent → mode:hosted at ALL times > PRE-mint (no bot row, hosted harness + platformAgentId) → hosted (fix 30352e60 preserved) [0.04ms]
(pass) hosted avatar-agent → mode:hosted at ALL times > the two hosted returns are BYTE-IDENTICAL (post-mint short-circuit == pre-mint branch) [0.05ms]
(pass) hosted avatar-agent → mode:hosted at ALL times > hosted short-circuit BEATS TTL — an EXPIRED or IDLE hosted-session row still reports hosted [0.10ms]
(pass) genuine BYO/external rows are unchanged > active BYO → external-active with the exact prior field shape [0.05ms]
(pass) genuine BYO/external rows are unchanged > a BYO row whose agentId collides-shape but harness is hosted still reports external (agentId != platformAgentId) [0.03ms]
(pass) genuine BYO/external rows are unchanged > expired BYO → external-expired [0.07ms]
(pass) genuine BYO/external rows are unchanged > idle BYO → external-idle [0.05ms]
(pass) genuine BYO/external rows are unchanged > a matching agentId but NON-hosted harness (custom) does NOT short-circuit → external [0.03ms]
(pass) genuine BYO/external rows are unchanged > SAME-USER BYO collision: matching agentId + hosted harness but non-Milady identity → external (Codex fix) [0.05ms]
(pass) genuine BYO/external rows are unchanged > expired external row + NON-hosted avatar (agent rows exist) stays external-expired (no hosted fallback) [0.03ms]
(pass) genuine BYO/external rows are unchanged > expired external row + UNPROVISIONED avatar (platformAgentId null) → cold-fallthrough (pending, not expired) [0.02ms]
(pass) no-bot branches > dismissed flag → mode:dismissed [0.04ms]
(pass) no-bot branches > dismissed takes precedence over the hosted-harness branch [0.03ms]
(pass) no-bot branches > no bot + non-hosted harness + no platformAgent → cold-fallthrough (route does the guest read) [0.02ms]
(pass) no-bot branches > no bot + hosted harness but NO platformAgentId → cold-fallthrough (not hosted) [0.02ms]
(pass) no-bot branches > dismissed + UNPROVISIONED hosted avatar → cold-fallthrough (dismissal must not block the lazy backfill) [0.02ms]
(pass) no-bot branches > dismissed + unprovisioned NON-hosted avatar stays dismissed (no backfill applies) [0.02ms]

src\services\__tests__\agent-session-config-hermes.test.ts:
(pass) resolveInWorldProtocol — hermes host-it-for-me gate > gate OFF → nanoclaw (fail-soft pull), for EVERY stored-protocol mislabel [0.05ms]
(pass) resolveInWorldProtocol — hermes host-it-for-me gate > gate ON → hermes-local, for EVERY stored-protocol mislabel [0.05ms]
(pass) resolveInWorldProtocol — hermes host-it-for-me gate > omitted gate param falls back to the boot-time env const [0.01ms]
(pass) resolveInWorldProtocol — hermes host-it-for-me gate > the gate NEVER leaks hermes-local to any other identity type [0.02ms]
(pass) hermes restorability — NO_GATEWAY membership > isRowRestorableFromFacts(hermes) → true (no secrets on the row) [0.02ms]
(pass) hermes restorability — NO_GATEWAY membership > isSessionRestorable(hermes, *) → true for any non-hatcher-proxy stored column [0.03ms]
(pass) hermes restorability — NO_GATEWAY membership > the hatcher-proxy presence flag is IGNORED for hermes rows [0.02ms]
(pass) hermes builders — 502 guard + mint ≡ restore > AVATAR: never a gateway-POSTing protocol; dummy gateway; empty authToken [0.08ms]
(pass) hermes builders — 502 guard + mint ≡ restore > AVATAR: mint ≡ restore on the spawn-relevant fields [0.07ms]
(pass) hermes builders — 502 guard + mint ≡ restore > OVERRIDE: same derivation + mint ≡ restore [0.07ms]
(pass) resolveAutonomyMode — hermes is always self-managed > forced self-managed even against an explicit server-managed request [0.02ms]
(pass) hatcher inertness — hermes gate cannot touch hatcher derivation > hatcher wire protocol is hatcher-proxy under BOTH gate states [0.02ms]
(pass) hatcher inertness — hermes gate cannot touch hatcher derivation > hatcher restorability rules unchanged (protocol-keyed, presence-refined) [0.02ms]
(pass) hatcher inertness — hermes gate cannot touch hatcher derivation > hatcher species fallback + reserved-model guard unchanged (hermes cannot claim hatcher VRMs) [0.02ms]
(pass) HERMES_LOCAL_GATEWAY_URL — hardcoded server-side constant > is exactly the documented localhost:8642 (never env/caller-derived)

src\services\__tests__\agent-session-config-openclaw.test.ts:
(pass) resolveInWorldProtocol — openclaw host-it-for-me gate > GATEWAY-LESS openclaw, gate OFF → fail-soft wire (no declared gateway to POST) [0.04ms]
(pass) resolveInWorldProtocol — openclaw host-it-for-me gate > GATEWAY-LESS openclaw, gate ON → openclaw-local (the hosted path) [0.04ms]
(pass) resolveInWorldProtocol — openclaw host-it-for-me gate > BYO openclaw WITH a declared gateway → declared protocol under BOTH gate states (the precedence pin) [0.03ms]
(pass) resolveInWorldProtocol — openclaw host-it-for-me gate > FAIL-SAFE: opts bag with the gate ON but NO gateway signal → declared (never hosted) [0.02ms]
(pass) resolveInWorldProtocol — openclaw host-it-for-me gate > the gate NEVER leaks openclaw-local to any other identity type [0.02ms]
(pass) openclaw restorability — fact-based > declared-gateway BYO is not restorable; gateway-less restores under either gate [0.02ms]
(pass) openclaw restorability — fact-based > session-status uses the same gateway fact [0.02ms]
(pass) openclaw builders — gated wire + mint ≡ restore (gateway-less) > AVATAR: gateway-less openclaw derives the boot-gate wire; dummy gateway; empty authToken [0.06ms]
(pass) openclaw builders — gated wire + mint ≡ restore (gateway-less) > AVATAR: mint ≡ restore on spawn-relevant fields (gateway-less openclaw) [0.04ms]
(pass) openclaw builders — gated wire + mint ≡ restore (gateway-less) > AVATAR: a BYO openclaw WITH a gateway keeps its declared protocol (unchanged) + real gateway [0.02ms]
(pass) openclaw builders — gated wire + mint ≡ restore (gateway-less) > OVERRIDE: gateway-less openclaw derives the boot-gate wire + mint ≡ restore [0.10ms]
(pass) resolveAutonomyMode — openclaw stays server-managed > openclaw honors the requested/default mode (NOT forced self-managed like hermes) [0.02ms]
(pass) PROTOCOL_CAPABILITIES — openclaw-local > emits in-world [ACTION:] (like hermes-local + hatcher-proxy) [0.03ms]
(pass) PROTOCOL_CAPABILITIES — openclaw-local > is NOT proximity-gate exempt (exemption is Hatcher-only, anti-abuse backbone) [0.02ms]
(pass) hatcher inertness — openclaw gate cannot touch hatcher derivation > hatcher wire protocol is hatcher-proxy regardless of the openclaw opts [0.03ms]
(pass) hatcher inertness — openclaw gate cannot touch hatcher derivation > hatcher restorability + species fallback unchanged [0.03ms]
(pass) hatcher inertness — openclaw gate cannot touch hatcher derivation > hatcher-proxy capabilities unchanged (emits + proximity-exempt) [0.01ms]
(pass) hermes inertness — openclaw gate cannot touch hermes derivation > hermes still resolves by ITS OWN gate (3rd param), never the openclaw opts [0.03ms]
(pass) OPENCLAW_LOCAL_GATEWAY_URL — hardcoded server-side constant > is exactly the documented localhost:8643 (never env/caller-derived) [0.01ms]

src\services\__tests__\agent-session-config.test.ts:
(pass) public identity canonicalization > preserves known labels and collapses novel labels to custom [0.04ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > explicit supported identities are preserved, including gateway-less named runtimes [0.03ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > Milady runtime signal infers milady; a generic declared gateway infers custom [0.02ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > omitted identity + no runtime/gateway fact defaults to custom [0.03ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > gateway-less custom, proven Milady, and Hermes remain valid [0.04ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > explicit Milady and conflicting legacy signals normalize tolerantly [0.04ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > gateway declarations are accepted for tolerant downstream normalization [0.04ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > declared-gateway fact excludes the internal localhost dummy [0.02ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > ticket identity reuses the validated label for inferred and explicit custom [0.06ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > ticket identity keeps explicit OpenClaw distinct and ignores dummy gateways [0.03ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > gateway-less OpenClaw clears stale BYO row state and restores by the same fact [0.04ms]
(pass) resolveDirectAgentIdentityType — supported-only request inference > validated request fact replaces stale URLs and clears every no-gateway runtime [0.04ms]
(pass) resolveInWorldProtocol — derives from identity, not stored column > milady → nanoclaw [0.02ms]
(pass) resolveInWorldProtocol — derives from identity, not stored column > openclaw → openai-compat
(pass) resolveInWorldProtocol — derives from identity, not stored column > custom → custom-webhook
(pass) resolveInWorldProtocol — derives from identity, not stored column > hatcher → hatcher-proxy
(pass) resolveInWorldProtocol — derives from identity, not stored column > a no-gateway type NEVER yields a gateway-POSTing protocol [0.03ms]
(pass) resolveInWorldProtocol — derives from identity, not stored column > custom selects declared-gateway cognition or gateway-less fail-soft pull from one fact [0.03ms]
(pass) isRowRestorableFromFacts — restore follows effective transport facts > no-gateway types ARE restorable from the row alone [0.04ms]
(pass) isRowRestorableFromFacts — restore follows effective transport facts > declared-gateway OpenClaw/custom are NOT restorable (auth_token never persisted) [0.02ms]
(pass) isRowRestorableFromFacts — restore follows effective transport facts > ignored stale gateways do not block native or explicit-pull restore [0.02ms]
(pass) isRowRestorableFromFacts — restore follows effective transport facts > every canonical no-real-gateway public row restores regardless of host gate [0.02ms]
(pass) isRowRestorableFromFacts — restore follows effective transport facts > hatcher is NOT covered by this predicate (handled by a separate restore branch)
(pass) resolveAgentSpecies — hatcher fallback is the hatcher default > hatcher with null species → DEFAULT_HATCHER_MODEL_KEY [0.01ms]
(pass) resolveAgentSpecies — hatcher fallback is the hatcher default > non-hatcher with null species → DEFAULT_AGENT_MODEL_KEY [0.03ms]
(pass) resolveAgentSpecies — hatcher fallback is the hatcher default > explicit species is passed through verbatim for every type [0.03ms]
(pass) resolveAutonomyMode > the internal nanoclaw wire forces self-managed regardless of identity [0.01ms]
(pass) resolveAutonomyMode > everything else defaults server-managed, honors explicit request [0.01ms]
(pass) resolveAutonomyMode > gateway-less custom is self-managed even when the persisted protocol uses its default [0.03ms]
(pass) gateway-less custom config builders > avatar config is fail-soft/self-managed while gateway custom remains unchanged [0.09ms]
(pass) gateway-less custom config builders > override config shares the same gateway-less custom decision [0.04ms]
(pass) gateway-less custom config builders > custom becomes restorable when gateway-less or stored as nanoclaw [0.02ms]
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > AVATAR milady: protocol=nanoclaw, species fallback, mint≡restore [0.14ms]
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > OVERRIDE milady: protocol=nanoclaw, mint≡restore [0.09ms]
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > AVATAR openclaw: protocol=openai-compat, species fallback, mint≡restore
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > OVERRIDE openclaw: protocol=openai-compat, mint≡restore
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > AVATAR custom: protocol=custom-webhook, species fallback, mint≡restore
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > OVERRIDE custom: protocol=custom-webhook, mint≡restore
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > AVATAR hatcher: protocol=hatcher-proxy, species fallback, mint≡restore [0.02ms]
(pass) mint ≡ restore — spawn-relevant config is byte-identical per type > OVERRIDE hatcher: protocol=hatcher-proxy, mint≡restore [0.02ms]
(pass) no-gateway avatar bodies cannot POST to a gateway (the 502 guard) > milady: protocol nanoclaw + dummy gateway [0.07ms]
(pass) isSessionRestorable — restore-aware session-status (D-2) + hatcher-proxy presence refinement > MIRRORS the restore module: hatcher-proxy + no-gateway types restorable, real-gateway NOT [0.05ms]
(pass) isSessionRestorable — restore-aware session-status (D-2) + hatcher-proxy presence refinement > session-status classifies ignored stale gateways by the effective wire [0.02ms]
(pass) isSessionRestorable — restore-aware session-status (D-2) + hatcher-proxy presence refinement > hatcher-proxy presence refinement: false ⇒ NOT restorable; true/omitted ⇒ restorable [0.02ms]
(pass) isSessionRestorable — restore-aware session-status (D-2) + hatcher-proxy presence refinement > presence flag is IGNORED for non-hatcher-proxy protocols [0.02ms]
(pass) slice 6 — hermes host-it-for-me gate (deterministic via explicit param) > gate OFF → fail-soft nanoclaw stub (no network) [0.01ms]
(pass) slice 6 — hermes host-it-for-me gate (deterministic via explicit param) > gate ON → hermes-local server-hosted runtime [0.02ms]
(pass) slice 6 — hermes host-it-for-me gate (deterministic via explicit param) > the gate is consulted ONLY on hermes — every other identity is gate-inert [0.04ms]
(pass) slice 6 — hermes host-it-for-me gate (deterministic via explicit param) > hermes across the OTHER resolvers: restorable, self-managed, default species [0.04ms]
(pass) slice 6 — registry fail-closed for unknown / prototype-key identity types > unknown legacy identity fails restore unless its stored wire explicitly proves pull [0.04ms]
(pass) slice 6 — registry fail-closed for unknown / prototype-key identity types > a prototype-key identity string cannot bypass into an inherited adapter [0.07ms]
(pass) slice 6 — registry fail-closed for unknown / prototype-key identity types > the storedProtocol==="nanoclaw" override still forces self-managed for ANY identity [0.02ms]
(pass) slice 6 — protocol capability table ([ACTION:] parity + proximity exemption) > emitsInWorldActions: TRUE only for the server-hosted-cognition protocols [0.04ms]
(pass) slice 6 — protocol capability table ([ACTION:] parity + proximity exemption) > proximityGateExempt: TRUE only for hatcher-proxy (hosted harnesses STAY gated) [0.03ms]
(pass) slice 6 — protocol capability table ([ACTION:] parity + proximity exemption) > the two capabilities are DISTINCT (not collapsed) for hermes-local [0.01ms]
(pass) slice 6 — protocol capability table ([ACTION:] parity + proximity exemption) > the table is keyed by PROTOCOL, not identity — "hatcher" (identity) grants nothing [0.02ms]
(pass) slice 6 — protocol capability table ([ACTION:] parity + proximity exemption) > FAIL-CLOSED: unknown / undefined / empty protocol grants NEITHER capability [0.03ms]
(pass) slice 6 — protocol capability table ([ACTION:] parity + proximity exemption) > prototype-key protocol strings cannot bypass into an inherited capability [0.05ms]
(pass) slice 6 — isHostedHarness: connect-namespace native-runtime hosting (NOT the /me/agent-session predicate) > milady is ALWAYS genuinely hosted, regardless of the hermes gate [0.04ms]
(pass) slice 6 — isHostedHarness: connect-namespace native-runtime hosting (NOT the /me/agent-session predicate) > a connect-namespace hermes identity is hosted ONLY when the host-it-for-me runtime is enabled [0.01ms]
(pass) slice 6 — isHostedHarness: connect-namespace native-runtime hosting (NOT the /me/agent-session predicate) > every external / self-managed / partner harness is NOT hosted [0.03ms]
(pass) slice 6 — isHostedHarness: connect-namespace native-runtime hosting (NOT the /me/agent-session predicate) > unknown / empty / prototype-key harness → NOT hosted (fail-closed; matches old Set.has("")) [0.03ms]

src\services\__tests__\agent-session-restore-attribution.test.ts:
(pass) session restore covenant attribution > returns the active avatar id when optional attribution resolves [0.37ms]
(pass) session restore covenant attribution > continues recordless when the optional attribution query fails [0.13ms]
(pass) session restore covenant attribution > does not query when the persisted session has no bound user [0.07ms]

src\services\__tests__\agent-session-restore-contract.test.ts:
(pass) agent-session restore protected contract > Hatcher proxy restore keeps the complete encrypted-envelope gate byte-identical [0.10ms]
(pass) agent-session restore protected contract > Hatcher proxy restore preserves its historical user-bound ledger status and config [0.21ms]
(pass) agent-session restore protected contract > public no-gateway restore is fact-based and noncanonical rows fail closed [0.08ms]
(pass) agent-session restore protected contract > the production restore seam honors native and explicit-pull precedence over stale URLs [0.07ms]
(pass) agent-session restore protected contract > restored public sessions never gain ledger authority and keep row binding only [0.04ms]

src\services\__tests__\agent-stream-config.test.ts:
(pass) AGENT_STREAM_EVENT_TYPES whitelist > includes the four cove settle types + the agent-scoped knowledge event [0.04ms]
(pass) AGENT_STREAM_EVENT_TYPES whitelist > includes agent-scoped world/teaching types + the reserved directive type [0.02ms]
(pass) AGENT_STREAM_EVENT_TYPES whitelist > EXCLUDES ephemeral + non-agent-scoped types [0.02ms]
(pass) AGENT_STREAM_EVENT_TYPES whitelist > has no duplicate entries [0.02ms]
(pass) parseReplayQuery — validation + clamping > applies defaults when both params omitted [0.12ms]
(pass) parseReplayQuery — validation + clamping > parses a valid after + limit [0.07ms]
(pass) parseReplayQuery — validation + clamping > accepts a large but in-range limit at the max [0.03ms]
(pass) parseReplayQuery — validation + clamping > preserves bigint precision beyond 2^53 [0.03ms]
(pass) parseReplayQuery — validation + clamping > rejects out-of-range / malformed input with null (→ handler 400) [0.21ms]
(pass) projectDurableEvent — SAFE columns only > projects exactly id/eventType/ts/payload and drops every other column [0.13ms]
(pass) projectDurableEvent — SAFE columns only > bigint id -> string; null payload preserved [0.03ms]
(pass) computeNextCursor > returns null for an empty page (caught up) [0.03ms]
(pass) computeNextCursor > returns the last (highest, ascending) id of the page [0.02ms]
(pass) parseCursorValue — Last-Event-ID / ?after > parses a numeric string to bigint [0.05ms]
(pass) parseCursorValue — Last-Event-ID / ?after > returns null for absent / non-numeric / negative (→ no replay, go live) [0.02ms]

src\services\__tests__\alert-error.test.ts:
(pass) alert-error Telegram delivery > non-deployed run (CLAWVILLE_ENV unset) logs instead of paging [0.41ms]
(pass) alert-error Telegram delivery > ALERT_TELEGRAM_FORCE=true pages even without CLAWVILLE_ENV [0.32ms]
(pass) alert-error Telegram delivery > production CLAWVILLE_ENV pages normally [0.13ms]
(pass) alert-error Telegram delivery > sends arbitrary alert content as plain text [0.34ms]
(pass) alert-error Telegram delivery > logs the full message to stdout when Telegram rejects the send [0.15ms]

src\services\__tests__\autonomous-avatar-id-scrub.test.ts:
(pass) autonomousAvatars public snapshot scrubs internal identity > drops userId + internal budget/action fields, derives avatarId, keeps render fields [1.82ms]
(pass) autonomousAvatars public snapshot scrubs internal identity > leaks NO raw UUID (avatarId OR userId) anywhere in the serialized public snapshot [0.20ms]

src\services\__tests__\autonomous-build-targets.test.ts:
(pass) autonomous build targets > fails soft to the frozen empty projection on a database error [0.19ms]
(pass) autonomous build targets > filters to owned active HOME structures in the production query [0.20ms]
(pass) autonomous build targets > bounds parcels and valid placements and renders exact material costs [1.28ms]

src\services\__tests__\autonomous-cove-wager-cap.test.ts:
(pass) autonomous cove daily wager usage > derives UTC midnight from the same PostgreSQL transaction clock as ledger created_at [0.70ms]

src\services\__tests__\autonomy-standby.test.ts:
[AutonomyStandby] active -> standby (reason: manual)
(pass) autonomy standby default resolution > defaults staging to standby and production/unset to active [0.17ms]
[AutonomyStandby] active -> standby (reason: manual)
(pass) autonomy standby default resolution > honors AUTONOMY_STANDBY_DEFAULT over the deploy environment [0.03ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] active -> active (reason: armed 15min)
(pass) autonomy standby state > keeps the default-active mode unbounded when arm is called [0.15ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 15min)
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 480min)
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 120min)
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 120min)
(pass) autonomy standby state > clamps arm windows and defaults invalid input to 120 minutes [0.08ms]
[AutonomyStandby] active -> standby (reason: manual)
(pass) autonomy standby state > lazy-expires to standby and logs expiry only once [0.11ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 30min)
[AutonomyStandby] active -> active (reason: armed 30min)
(pass) autonomy standby state > re-arm replaces and extends the active window [0.04ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyDriver] registered house agent a718c35b2a408671 (1 total)
[AutonomyDriver] registered user agent f8ed2e09fb0de2db (1/12 user, 1 house)
[AutonomyDriver] standby — skipping autonomy tick and reconcile
(pass) autonomy driver standby gate > heartbeats in standby and counts both house and user enrollments [0.17ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyDriver] registered house agent a718c35b2a408671 (1 total)
[AutonomyDriver] standby — skipping autonomy tick and reconcile
[AutonomyStandby] standby -> active (reason: armed 15min)
(pass) autonomy driver standby gate > skips the entire tick and reconcile in standby, then runs when armed [0.13ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyDriver] registered house agent a718c35b2a408671 (1 total)
[AutonomyStandby] standby -> active (reason: kick auto-arm)
(pass) autonomy driver standby gate > auto-arms a 30-minute window for an explicit kick [0.09ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyDriver] registered house agent a718c35b2a408671 (1 total)
(pass) autonomy driver standby gate > does not auto-arm or drive a reconcile-origin kick in standby [0.06ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 15min)
[AutonomyStandby] active -> standby (reason: manual)
(pass) autonomy driver standby gate > manual standby during the reconcile import prevents the pass from running [0.16ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 15min)
[AutonomyStandby] active -> standby (reason: manual)
(pass) autonomy driver standby gate > manual standby during an active reconcile cancels later enrollments [0.24ms]

src\services\__tests__\avatar-agent-provisioning.test.ts:
(pass) deriveSignupAvatarNameBase > prefers the signup name field over the email local-part [0.11ms]
(pass) deriveSignupAvatarNameBase > falls back to the email local-part when name is missing/empty [0.05ms]
(pass) deriveSignupAvatarNameBase > sanitizes to the users_username_format alphabet [0.03ms]
(pass) deriveSignupAvatarNameBase > clamps to 20 chars [0.04ms]
(pass) deriveSignupAvatarNameBase > falls back to 'Agent' when the sanitized base is under 3 chars [0.03ms]
(pass) deriveSignupAvatarNameBase > every derivation satisfies the username CHECK format [0.07ms]
(pass) suffixNameCandidate > appends a 4-digit suffix and stays within 20 chars [0.09ms]
(pass) suffixNameCandidate > suffix stays in 1000..9999 across the random range [0.08ms]
(pass) suffixNameCandidate > distinct random draws give distinct candidates (retry actually retries) [0.03ms]
(pass) runProvisioningFailSoft > passes the resolved value through [0.14ms]
[avatar-provisioning] test failed (fail-soft): 109 |     expect(out).toBe(42);
110 |   });
111 |
112 |   test('swallows a throw and returns null (signup must still 200)', async () => {
113 |     const out = await runProvisioningFailSoft('test', async () => {
114 |       throw new Error('provisioning exploded');
                      ^
error: provisioning exploded
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\avatar-agent-provisioning.test.ts:114:17)
      at runProvisioningFailSoft (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\avatar-agent-provisioning.ts:311:18)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\avatar-agent-provisioning.test.ts:113:23)

(pass) runProvisioningFailSoft > swallows a throw and returns null (signup must still 200) [0.36ms]
[avatar-provisioning] test failed (fail-soft): 116 |     expect(out).toBeNull();
117 |   });
118 |
119 |   test('swallows a typed AvatarNameTakenError too', async () => {
120 |     const out = await runProvisioningFailSoft('test', async () => {
121 |       throw new AvatarNameTakenError('Taken', true);
                  ^
AvatarNameTakenError: Could not find a free avatar name after retries (base: Taken)
 candidateName: "Taken",
  exhausted: true,

      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\avatar-agent-provisioning.test.ts:121:13)
      at runProvisioningFailSoft (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\avatar-agent-provisioning.ts:311:18)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\avatar-agent-provisioning.test.ts:120:23)

(pass) runProvisioningFailSoft > swallows a typed AvatarNameTakenError too [0.23ms]
(pass) isAgentProvisioningPending (Slice B predicate) > guests are NEVER pending regardless of avatar state [0.05ms]
(pass) isAgentProvisioningPending (Slice B predicate) > non-guest without an avatar is pending [0.02ms]
(pass) isAgentProvisioningPending (Slice B predicate) > non-guest with an avatar but no platform agent is pending [0.01ms]
(pass) isAgentProvisioningPending (Slice B predicate) > non-guest with avatar + platform agent is NOT pending [0.01ms]
(pass) buildSignupProvisionParams (D4 defaults) > the (modelKey, agentCategory, harness) triple is self-consistent [0.07ms]
(pass) buildSignupProvisionParams (D4 defaults) > harness is a hosted harness so /me/agent-session reports mode hosted [0.02ms]
(pass) buildSignupProvisionParams (D4 defaults) > archetype exists in the registry (curious-scholar, the /join precedent) [0.05ms]
(pass) buildSignupProvisionParams (D4 defaults) > species/color/gender/personality align with the web milady→legacy-species mapping [0.03ms]
(pass) calculateAvatarStats (moved verbatim from routes/avatars.ts) > signup default personality resolves to the create-route formula values [0.08ms]
(pass) calculateAvatarStats (moved verbatim from routes/avatars.ts) > a second known combination stays stable [0.02ms]
(pass) buildCharacterConfig (moved verbatim from routes/avatars.ts) > system prompt embeds name + model label; knowledge = archetype + orientation [0.13ms]
(pass) buildCharacterConfig (moved verbatim from routes/avatars.ts) > learningFocus injects the focus line [0.04ms]
(pass) buildCharacterConfig (moved verbatim from routes/avatars.ts) > unknown archetype throws loudly [0.04ms]

src\services\__tests__\avatar-manifest.test.ts:
(pass) canonicalize > is key-order independent [0.17ms]
(pass) canonicalize > sorts nested object keys but preserves array order [0.04ms]
(pass) canonicalize > handles null + primitives like JSON.stringify [0.02ms]
(pass) AGENT_MODEL_BODY_PATHS coverage > has a body path for every AGENT_MODEL_KEYS (drift guard) [0.04ms]
(pass) canonicalization parity with the service issuer > canonicalize(core) === signPayload(core).body [3.26ms]
(pass) build → sign → verify > round-trips a valid manifest [6.81ms]
(pass) build → sign → verify > omits owner/identity when absent, still verifies [6.00ms]
(pass) build → sign → verify > rejects a tampered body hash [5.51ms]
(pass) build → sign → verify > rejects a tampered payload field [4.81ms]
(pass) build → sign → verify > rejects when the signer is not the expected issuer [3.04ms]
(pass) build → sign → verify > does not throw on a malformed signature [1.94ms]
(pass) custody invariant > never serializes a secret key [1.86ms]

src\services\__tests__\avatar-settlement-resolver.test.ts:
(pass) avatar settlement resolver and fail-closed advertisement > verified canonical row is ready [1.44ms]
(pass) avatar settlement resolver and fail-closed advertisement > missing canonical row is pending and omits a fundable field [0.03ms]
(pass) avatar settlement resolver and fail-closed advertisement > unverified row, including a reconciliation exception, remains pending [0.04ms]

src\services\__tests__\avatar-wallet-reconciliation.test.ts:
(pass) avatar wallet five-way promotion matrix > 1: valid canonical plus equal mirror promotes [0.57ms]
(pass) avatar wallet five-way promotion matrix > 2: valid canonical plus NULL mirror repairs NULL then promotes [0.15ms]
(pass) avatar wallet five-way promotion matrix > 3: non-null mismatch stays pending and never repoints the mirror [0.15ms]
(pass) avatar wallet five-way promotion matrix > 4: absent canonical plus NULL mirror creates validated v2 winner and repairs NULL [0.14ms]
(pass) avatar wallet five-way promotion matrix > 5: mirror-only state stays pending without mint or repoint [0.07ms]
(pass) avatar wallet five-way promotion matrix > backfill rerun is idempotent and never creates or rewrites twice [0.08ms]
(pass) avatar wallet five-way promotion matrix > decrypt or public-key validation failure demotes and stays pending [0.09ms]
(pass) avatar wallet five-way promotion matrix > unique-race loser reconciles the winner and never discloses its generated secret [0.12ms]

src\services\__tests__\baccarat-engine.test.ts:
(pass) baccarat-engine — shoe integrity > 8-deck shoe has 416 cards [0.14ms]
(pass) baccarat-engine — shoe integrity > shoe holds exactly 8 of each (suit, rank) [0.19ms]
(pass) baccarat-engine — shoe integrity > shoe holds exactly 8 of each rank (32 total per rank: 8 decks × 4 suits) [0.09ms]
(pass) baccarat-engine — shoe integrity > reshuffle threshold is 75% of 416 = 312 [0.02ms]
(pass) baccarat-engine — shoe integrity > canonical order is deck-major → suit-major → rank-major [0.05ms]
(pass) baccarat-engine — card values > A = 1 [0.03ms]
(pass) baccarat-engine — card values > 2..9 = face value [0.02ms]
(pass) baccarat-engine — card values > 10/J/Q/K = 0 [0.02ms]
(pass) baccarat-engine — handTotal (mod 10) > 7 + 8 = 15 → 5 [0.05ms]
(pass) baccarat-engine — handTotal (mod 10) > 9 + 9 = 18 → 8 [0.02ms]
(pass) baccarat-engine — handTotal (mod 10) > K + Q = 0 + 0 = 0 [0.01ms]
(pass) baccarat-engine — handTotal (mod 10) > A + 10 + 9 = 1 + 0 + 9 = 10 → 0 [0.01ms]
(pass) baccarat-engine — handTotal (mod 10) > 5 + 6 + 7 = 18 → 8 [0.01ms]
(pass) baccarat-engine — bankerDraws tableau > banker 7 always stands (player drew or not) [0.04ms]
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 0 draws [0.02ms]
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 1 draws
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 2 draws
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 3 draws
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 4 draws
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 5 draws
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 6 stands [0.01ms]
(pass) baccarat-engine — bankerDraws tableau > player did NOT draw → banker draws on 0-5, stands on 6-7 > banker 7 stands
(pass) baccarat-engine — bankerDraws tableau > player DID draw → standard banker tableau > banker 0-2 always draws (every player 3rd card 0-9) [0.04ms]
(pass) baccarat-engine — bankerDraws tableau > player DID draw → standard banker tableau > banker 3 draws unless player 3rd is 8 [0.02ms]
(pass) baccarat-engine — bankerDraws tableau > player DID draw → standard banker tableau > banker 4 draws if player 3rd in 2-7 [0.02ms]
(pass) baccarat-engine — bankerDraws tableau > player DID draw → standard banker tableau > banker 5 draws if player 3rd in 4-7 [0.02ms]
(pass) baccarat-engine — bankerDraws tableau > player DID draw → standard banker tableau > banker 6 draws if player 3rd in 6-7 [0.02ms]
(pass) baccarat-engine — bankerDraws tableau > matches an independent reference for every (bankerTotal 0-6, player 3rd 0-9) [0.11ms]
(pass) baccarat-engine — settleBet payouts > PLAYER bet, player wins → 1:1 (gross = stake*2) [0.06ms]
(pass) baccarat-engine — settleBet payouts > PLAYER bet, banker wins → loss (gross 0) [0.02ms]
(pass) baccarat-engine — settleBet payouts > PLAYER bet, tie → PUSH (gross = stake) [0.02ms]
(pass) baccarat-engine — settleBet payouts > BANKER bet, banker wins → 0.95:1 by flooring the player winnings [0.01ms]
(pass) baccarat-engine — settleBet payouts > BANKER bet, banker wins → house-POSITIVE at EVERY stake (economy fix 2026-05-29) [0.04ms]
(pass) baccarat-engine — settleBet payouts > BANKER win: house take = commission = stake - payoutWinnings is ALWAYS ≥ 1 for stake ≥ 1 [0.64ms]
(pass) baccarat-engine — settleBet payouts > BANKER bet, player wins → loss (gross 0) [0.02ms]
(pass) baccarat-engine — settleBet payouts > BANKER bet, tie → PUSH (gross = stake) [0.02ms]
(pass) baccarat-engine — settleBet payouts > TIE bet, tie → 8:1 (gross = stake*9) [0.02ms]
(pass) baccarat-engine — settleBet payouts > TIE bet, player wins → loss [0.01ms]
(pass) baccarat-engine — settleBet payouts > TIE bet, banker wins → loss [0.01ms]
(pass) baccarat-engine — settleBet payouts > commission percent constant is 5 [0.01ms]
(pass) baccarat-engine — determinism > same inputs ⇒ byte-identical CoupResult [0.86ms]
(pass) baccarat-engine — determinism > replayCoup === playCoup [0.21ms]
(pass) baccarat-engine — determinism > different nonces yield (generally) different first cards [0.19ms]
(pass) baccarat-engine — determinism > deals at least 4 and at most 6 cards [2.63ms]
(pass) baccarat-engine — determinism > on a natural (8/9 two-card) NEITHER side draws a third card [12.15ms]
(pass) baccarat-engine — determinism > player stands on 6-7 (two-card, no natural on either side) [15.42ms]
(pass) baccarat-engine — determinism > winner matches the higher total; equal totals = tie [2.64ms]
(pass) baccarat-engine — shared shoe threading > playCoupWithState threads remaining/cursor/dealt across coups [0.31ms]
(pass) baccarat-engine — shared shoe threading > replayShoeUpToCoup reproduces the threaded result for nonce > 0 [0.41ms]
(pass) baccarat-engine — shared shoe threading > replayShoeUpToCoup throws on a wrong coups-length [0.12ms]
(pass) baccarat-engine — validation > rejects non-positive stake [0.06ms]
(pass) baccarat-engine — validation > rejects an illegal bet [0.04ms]
(pass) baccarat-engine — validation > rejects a negative nonce / cursor [0.06ms]
(pass) baccarat-engine — validation > rejects a remainingShoe of the wrong length [0.07ms]
(pass) baccarat-engine — validation > requires remainingShoe when dealtBefore > 0 [0.05ms]
(pass) baccarat-engine — serializeCoupResult > stringifies bigints + pins the engine version + kind discriminator [0.16ms]

src\services\__tests__\blackjack-basic-strategy.test.ts:
(pass) blackjack basic strategy — six-deck S17/DAS late surrender > uses the pair table before hard/soft totals [1.62ms]
(pass) blackjack basic strategy — six-deck S17/DAS late surrender > uses late surrender only on the textbook hard totals [0.09ms]
(pass) blackjack basic strategy — six-deck S17/DAS late surrender > covers soft doubling and fallback behavior [0.08ms]
(pass) blackjack basic strategy — six-deck S17/DAS late surrender > falls back to legal non-double and non-split actions [0.10ms]
(pass) blackjack basic strategy — six-deck S17/DAS late surrender > handles split-subhand capability flags without attempting a second split or surrender [0.04ms]
(pass) blackjack basic strategy — six-deck S17/DAS late surrender > covers the hard-total stand, double, and hit boundaries [0.06ms]

src\services\__tests__\blackjack-engine.test.ts:
(pass) blackjack-engine — totals + soft-ace demotion > counts A+K as soft 21 (blackjack) [0.07ms]
(pass) blackjack-engine — totals + soft-ace demotion > demotes ace when hard would bust: A+9+5 = 15 hard [0.05ms]
(pass) blackjack-engine — totals + soft-ace demotion > A+A = soft 12 (one ace 11, one ace 1) [0.03ms]
(pass) blackjack-engine — totals + soft-ace demotion > face cards are 10, ace base is 1 [0.03ms]
(pass) blackjack-engine — shoe > builds a 312-card 6-deck shoe with 6 of every (suit,rank) [0.23ms]
(pass) blackjack-engine — shoe > reshuffle threshold is 75% of the shoe [0.02ms]
(pass) blackjack-engine — determinism > same inputs produce byte-identical hands [1.00ms]
(pass) blackjack-engine — determinism > replayHand reproduces playHand exactly (provably-fair contract) [0.16ms]
(pass) blackjack-engine — determinism > different nonce → different first card with overwhelming probability [0.14ms]
(pass) blackjack-engine — determinism > cursorAfter advances past the bytes consumed by all draws [0.11ms]
(pass) blackjack-engine — known-seed golden case > nonce 0 / cursor 0 / bet 100 yields a stable outcome shape [0.13ms]
(pass) blackjack-engine — known-seed golden case > serializeHandResult stringifies bigints + tags kind=blackjack [0.23ms]
(pass) blackjack-engine — dealer S17 > dealer never hits a standing 17+ across many seeds (S17) [4.45ms]
(pass) blackjack-engine — payouts > blackjack pays 3:2 (net +150 on a 100 natural vs non-natural dealer) [0.62ms]
(pass) blackjack-engine — payouts > push on dual naturals returns the stake (net 0) [6.69ms]
(pass) blackjack-engine — insurance (resolved before main hand) > insurance only honored on dealer-Ace upcard; pays 2:1 on dealer BJ [0.82ms]
(pass) blackjack-engine — insurance (resolved before main hand) > insurance NOT created when dealer upcard is not an Ace [1.72ms]
(pass) blackjack-engine — double > double doubles the stake and draws exactly one card [0.11ms]
(pass) blackjack-engine: hit into a bust settles as a LOSS (no throw) > a raw trailing hit that busts returns a settled LOSS without throwing [0.28ms]
(pass) blackjack-engine: hit into a bust settles as a LOSS (no throw) > appending a stand AFTER a busting hit DOES throw (the exact crash the peek must avoid) [0.23ms]
(pass) blackjack-engine — surrender > surrender returns half the stake (net -50 on a 100 bet) [0.09ms]
(pass) blackjack-engine — split > split produces two hands each with its own stake [0.17ms]
(pass) blackjack-engine — split aces (one card only, standard rule) > split aces accept stand-only and end at exactly 2 cards each [0.38ms]
(pass) blackjack-engine — split aces (one card only, standard rule) > split aces accept an empty action list (implicit auto-stand) [0.25ms]
(pass) blackjack-engine — split aces (one card only, standard rule) > hitting a split ace throws (one-card rule) [0.31ms]
(pass) blackjack-engine — split aces (one card only, standard rule) > doubling a split ace throws (one-card rule) [0.25ms]
(pass) blackjack-engine — split aces (one card only, standard rule) > surrendering a split ace throws (one-card rule, also fromSplit-illegal) [0.27ms]
(pass) blackjack-engine — split aces (one card only, standard rule) > non-ace split pairs CAN still be hit (rule is ace-specific) [0.13ms]
(pass) blackjack-engine — multi-hand shoe replay (no-replacement) > replayShoeUpToHand reproduces a sequence of hands deterministically [0.29ms]
(pass) blackjack-engine — multi-hand shoe replay (no-replacement) > hand N draws do not overlap hand N+1 (cursor + dealt monotonic) [0.10ms]
(pass) blackjack-engine — multi-hand shoe replay (no-replacement) > no-replacement: across a 12-hand sequential shoe, no rank appears more than 24 times (4 suits × 6 decks) [0.36ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > rake percent constant is 5 [0.02ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > net win 100 → rake 5 → credited net 95 (task example) [0.04ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > a PUSH pays no rake (payout === bet → net winnings 0) [0.02ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > a LOSS pays no rake (payout < bet → net winnings 0, not negative) [0.03ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > rake is on WINNINGS only, never the returned stake [0.03ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > rake floors small winnings to 0 (net win 19 → floor(0.95)=0) [0.02ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > property: rake = floor(max(0, payout-bet)*5/100); credit = payout - rake; never negative payout [0.68ms]
(pass) blackjack-engine — computeBlackjackRake (net-winnings rake) > serializeHandResult carries rake + rakedPayout + rakedNet; gross fields unchanged [0.10ms]

src\services\__tests__\bounty-tier1-sweeper.test.ts:
(pass) Tier-1 bounty expiry sweeper > resolves the independent cadence default and one-minute floor [1.68ms]
[bounty-tier1] expiry sweeper started, releasing expired DB holds every 5min
(pass) Tier-1 bounty expiry sweeper > starts and stops idempotently [0.13ms]

src\services\__tests__\bounty-tier1.test.ts:
(pass) Tier-1 bounty rail and cap > defaults to $50 and floors an unsafe env override at $1 [0.22ms]
(pass) Tier-1 approval settlement > uses the deterministic key, count-only exemption, and books only confirmed payment [0.80ms]
(pass) Tier-1 approval settlement > keeps booking untouched on settle failure so the open hold remains retryable [0.29ms]
(pass) Tier-1 approval settlement > propagates an idempotent payment or booking replay [0.34ms]
(pass) poster-scoped USDC spend admission > ordinary sends reserve every open hold plus pending/settling liabilities [1.24ms]
(pass) poster-scoped USDC spend admission > settlement consumes exactly its own hold while every other dollar stays reserved [0.33ms]
(pass) poster-scoped USDC spend admission > blocks on an ambiguous agent-payment liability until operator resolution removes it [0.37ms]
(pass) poster-scoped USDC spend admission > blocks on an ambiguous withdrawal liability until its terminal resolution [0.34ms]
(pass) Tier-1 approve/expiry race > expiry wins first: completed expiry makes approval refuse [1.54ms]
(pass) Tier-1 approve/expiry race > approval wins first: approved-attempt reassertion makes expiry refuse [0.35ms]
(pass) Tier-1 cancel/approve race > cancel wins first: locked terminal CAS makes approval lose and permits release [1.16ms]
(pass) Tier-1 cancel/approve race > approval wins first: locked cancellation CAS refuses and the hold stays open [0.33ms]
(pass) Tier-1 bounded definitive settlement retry > rearms only a proven no-broadcast failure with the next attempt-scoped key [0.10ms]
(pass) Tier-1 bounded definitive settlement retry > freezes reconcile on its original key and never proposes another key [0.08ms]
(pass) Tier-1 bounded definitive settlement retry > stops after five total attempts and requires manual action [0.09ms]
(pass) Tier-1 bounded definitive settlement retry > resume drives the prepared retry generation and books a successful retry [1.00ms]
(pass) Tier-1 bounded definitive settlement retry > resume never calls settle for ambiguous or exhausted attempts and pages ops [0.96ms]
(pass) Tier-1 durable hold contracts > ships an idempotent additive hold table and count-only agent-pay column [0.07ms]
(pass) Tier-1 durable hold contracts > uses one poster spend lock and one admission function on every USDC path [0.27ms]
(pass) Tier-1 durable hold contracts > posts the hold in the bounty transaction and uses row-count CAS terminal writes [0.18ms]
(pass) Tier-1 durable hold contracts > fails closed on historical USDC rows before every work-lifecycle mutation [0.25ms]
(pass) Tier-1 durable hold contracts > keeps Tier-1 expiry in its own off-chain sweeper [0.12ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > rearms chain-proven no-money without changing cap exemptions and preserves archive guards [3.27ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes no-money proof with txSignature at plan and prepare levels [0.51ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes no-money proof with reconcileTxSignature at plan and prepare levels [0.15ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes no-money proof with settlePayer at plan and prepare levels [0.12ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > freezes plain failed rows without either proof at plan and prepare levels [0.32ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > does not advance after archive CAS loss and throws after generation CAS loss [0.60ms]
(pass) Tier-1 chain-proven no-money retry and read-only classification > ops classification reports frozen and exhausted holds and omits drivable rearm [0.75ms]
(pass) Tier-1 durable wedge alert delivery > defaults to 24 hours and floors overrides at one hour [0.10ms]
(pass) Tier-1 durable wedge alert delivery > frozen: first delivery stamps; fresh pass uses durable stamp; elapsed window re-alerts [0.60ms]
(pass) Tier-1 durable wedge alert delivery > exhausted: first delivery stamps; fresh pass uses durable stamp; elapsed window re-alerts [0.15ms]
(pass) Tier-1 durable wedge alert delivery > settle-failed: first delivery stamps; fresh pass uses durable stamp; elapsed window re-alerts [0.16ms]
[bounty-tier1] settlement resume failed for 11111111-1111-4111-8111-111111111111: 752 |     await didEnter;
753 |     expect(stamps).toBe(0);
754 |     release();
755 |     await run;
756 |     expect(stamps).toBe(1);
757 |     await resumeTier1BountySettlements(1, { ...deps, alert: async () => { throw new Error('test delivery rejected'); } });
                                                                                          ^
error: test delivery rejected
      at alert (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\bounty-tier1.test.ts:757:85)
      at resumeTier1BountySettlements (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\bounty-tier1.ts:713:17)
      at async <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\bounty-tier1.test.ts:757:11)

(pass) Tier-1 durable wedge alert delivery > does not stamp before delivery resolves or when delivery throws [1.30ms]

src\services\__tests__\building-reward.test.ts:
(pass) building-chat reward subject decisions > legitimate ledger-capable session uses its exact active avatar [0.06ms]
(pass) building-chat reward subject decisions > ownership-unproven reconnect may chat but cannot reward the bound victim avatar
(pass) building-chat reward subject decisions > ledger-capable session without an active avatar fails closed
(pass) building-chat reward subject decisions > unresolved session fails closed
(pass) building-chat reward subject decisions > wrong-avatar regression: only the resolved active avatar can flow [0.03ms]
(pass) building-chat reward subject decisions > real human [0.03ms]
(pass) building-chat reward subject decisions > canonical guest despite an avatar row
(pass) building-chat reward subject decisions > no active avatar
(pass) creditBuildingRewardOncePerDay (extracted, behavior-identical) > credits exactly once (amount 1, caller reason) when no same-day row exists → true [0.65ms]
(pass) creditBuildingRewardOncePerDay (extracted, behavior-identical) > returns false and NEVER touches the ledger when the same-day row exists (idempotency) [0.13ms]
(pass) creditBuildingRewardOncePerDay (extracted, behavior-identical) > second same-day call credits 0 (first credits, committed row then blocks the second) [0.12ms]
(pass) creditBuildingRewardOncePerDay (extracted, behavior-identical) > row-locks the avatars row (FOR UPDATE) BEFORE the existence probe (concurrency spine) [0.10ms]
(pass) creditBuildingRewardOncePerDay (extracted, behavior-identical) > binds the UTC-day bound as an ISO STRING, never a JS Date (postgres-js trap) [0.20ms]
(pass) creditBuildingRewardOncePerDay (extracted, behavior-identical) > the probe key binds avatarId + reason + buildingId (different building/reason/day = fresh key) [0.11ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > claims and credits exactly once in the same transaction [0.40ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > conflict loser returns false and never touches the ledger [0.10ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > uses one route-agnostic key across human and agent reasons [0.11ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > is wired into all three chat paths while visits retain the legacy helper [0.61ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > connected-agent chat mints only for the canonical ledger-capable session avatar [0.36ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > connected-agent visits reward and attribute only the canonical ledger-capable session subject [0.32ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > human chat authorizes the mint and XP from canonical users.is_guest, not the avatar mirror [0.16ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > system-agent chat checks canonical guest state before consuming its limiter [0.15ms]
(pass) creditBuildingChatRewardOncePerDay (shared durable claim) > 0037 commits guards before split backfill/index migrations [0.33ms]

src\services\__tests__\building-skill-install.test.ts:
(pass) installBuildingSkillIntoAgent > keeps exactly one current marker per building without disturbing other knowledge [0.17ms]
(pass) installBuildingSkillIntoAgent > writes heading chunks into the hosted agent main knowledge room with deterministic ids [1.55ms]
(pass) installBuildingSkillIntoAgent > returns already before embedding when every section exists [0.14ms]
(pass) installBuildingSkillIntoAgent > serializes different buildings for the same platform agent on one subject key [26.94ms]
(pass) installBuildingSkillIntoAgent > wraps only phase 2 in the global install slot and reuses the subject advisory key [2.41ms]
(pass) installBuildingSkillIntoAgent > routes every locked DB operation through the one advisory transaction store [0.30ms]
(pass) installBuildingSkillIntoAgent > continues from a no-table phase-1 precheck into runtime initialization and phase 2 [0.28ms]
(pass) installBuildingSkillIntoAgent > retries only missing sections after a partial prior install [0.21ms]
(pass) installBuildingSkillIntoAgent > uses the bounded connected-agent marker fallback when no hosted platform agent exists [0.12ms]
(pass) installBuildingSkillIntoAgent > fails explicitly when a player has neither a hosted nor connected agent [0.13ms]
[building-skill-install] Section 0 persist failed (non-fatal): embedding unavailable
(pass) installBuildingSkillIntoAgent > skips only the section whose embedding fails and remains fail-soft overall [0.32ms]
(pass) installBuildingSkillIntoAgent > returns runtime_unavailable when no section can be persisted [0.15ms]
[building-skill-install] Section 1 persist failed (non-fatal): second embedding unavailable
(pass) installBuildingSkillIntoAgent > keeps partial section success when a later section fails [0.25ms]
(pass) installBuildingSkillIntoAgent > serializes concurrent first claims so only one request embeds [0.42ms]
[building-skill-install] Section 1 persist failed (non-fatal): partial H2
(pass) installBuildingSkillIntoAgent > retires H1 only after a complete H2 install, never after partial H2 [0.51ms]
(pass) installBuildingSkillIntoAgent > does not report success when stale-section retirement cannot be verified [0.16ms]
(pass) installBuildingSkillIntoAgent > rejects the auto-installed entry skill before loading the DB row [0.09ms]

src\services\__tests__\bulk-reconcile.test.ts:
(pass) x402 bulk outage reconciliation > allows default-on auto consent while preserving operator double consent [0.99ms]
(pass) x402 bulk outage reconciliation > matches one exact transfer and leaves an unmatched young row waiting [3.43ms]
(pass) x402 bulk outage reconciliation > uses the reconcile update anchor when settling_started_at was cleared [0.89ms]
(pass) x402 bulk outage reconciliation > puts one-row/two-transfer ambiguity in MANUAL and never guesses [1.23ms]
(pass) x402 bulk outage reconciliation > pairs equal overlapping components strictly in chronological order [1.32ms]
(pass) x402 bulk outage reconciliation > applies verified capture once and a rerun captures nothing [1.22ms]
(pass) x402 bulk outage reconciliation > closes an unmatched old row only after a complete window [0.60ms]
(pass) x402 bulk outage reconciliation > never closes no-money when the signature cap exhausts before the boundary [0.71ms]
(pass) x402 bulk outage reconciliation > backs off and retries an RPC 429 while paging the target once [0.82ms]
(pass) x402 bulk outage reconciliation > enforces the row cap and derives bounds from selected rows plus margins [0.93ms]
(pass) x402 bulk outage reconciliation > requires double consent for CLI apply and parses operational bounds [0.21ms]

src\services\__tests__\claw-token-ledger.test.ts:
(pass) claw-token-ledger F1 — credit provenance > credit defaults to SOFT and moves only soft_balance [1.13ms]
(pass) claw-token-ledger F1 — credit provenance > credit with provenance:'bought' moves only bought_balance and stamps the bought tag [0.15ms]
(pass) claw-token-ledger F1 — credit provenance > a BOUGHT credit stamps usd_basis = the dollars paid (the V-Bucks revenue record) [0.13ms]
(pass) claw-token-ledger F1 — credit provenance > a SOFT credit REFUSES a usd_basis (only BOUGHT carries dollars; SOFT is play money) [0.13ms]
(pass) claw-token-ledger F1 — mintEarned chokepoint > mintEarned is the ONLY writer that produces an earned row / moves earned_balance [1.89ms]
(pass) claw-token-ledger F1 — mintEarned chokepoint > mintEarned stamps usd_basis + fp/ip anti-abuse hashes [0.18ms]
(pass) claw-token-ledger F1 — mintEarned chokepoint > mintEarned rejects an empty usdBasis (a cashable mint must carry a USD basis) [0.12ms]
(pass) claw-token-ledger F1 — mintEarned chokepoint > the RUNTIME guard refuses a forced earned provenance through creditClawTokens (belt-and-suspenders) [0.11ms]
(pass) claw-token-ledger F1 — transfer always credits SOFT > receiver gets SOFT even when the payer spends BOUGHT and EARNED [0.74ms]
(pass) claw-token-ledger F1 — spend order SOFT→BOUGHT→EARNED + per-tag rows > burns SOFT first, then BOUGHT, then EARNED, preserving the cashable balance [0.15ms]
(pass) claw-token-ledger F1 — spend order SOFT→BOUGHT→EARNED + per-tag rows > a multi-tag debit emits ONE ledger row per tag burned with a running total balanceAfter [0.27ms]
(pass) claw-token-ledger F1 — spend order SOFT→BOUGHT→EARNED + per-tag rows > a single-tag debit (soft only) emits exactly one row [0.13ms]
(pass) claw-token-ledger F1 — spend order SOFT→BOUGHT→EARNED + per-tag rows > debit throws InsufficientTokensError when the TOTAL is too low (and writes nothing) [0.17ms]
(pass) claw-token-ledger F1 — reconciler adversarial edges > debit of the FULL balance zeroes all three tags and emits one row per tag [0.26ms]
(pass) claw-token-ledger F1 — reconciler adversarial edges > debit exactly equal to soft burns ONLY soft and preserves bought+earned untouched [0.16ms]
(pass) claw-token-ledger F1 — reconciler adversarial edges > lazy-backfill reconciliation: a row with tags=0 but non-zero claw_tokens is treated as all-SOFT and leaves consistent [0.16ms]
(pass) claw-token-ledger F1 — reconciler adversarial edges > lazy-backfill reconciliation on a DEBIT: legacy all-SOFT row debits from soft only [0.15ms]
(pass) claw-token-ledger F1 — sum invariant holds after every op > credit, debit, transfer, and mintEarned all keep claw_tokens === sum(tags) [0.51ms]
(pass) claw-token-ledger F1 — DEFAULT-INSERT must satisfy the sum CHECK (regression for BLOCKING #1) > soft_balance DEFAULT mirrors claw_tokens DEFAULT (both 1000 after the A3 ¢-peg ×10) [0.04ms]
(pass) claw-token-ledger F1 — DEFAULT-INSERT must satisfy the sum CHECK (regression for BLOCKING #1) > bought_balance and earned_balance DEFAULT to 0 [0.02ms]
(pass) claw-token-ledger F1 — DEFAULT-INSERT must satisfy the sum CHECK (regression for BLOCKING #1) > a bare INSERT (all balance columns defaulted) satisfies claw_tokens === soft + bought + earned [0.02ms]
(pass) claw-token-ledger T0 — fee routing conservation (debit player + credit treasury in ONE tx) > purchase shape: player -P / treasury +P conserves supply; treasury credit is SOFT [0.23ms]
(pass) claw-token-ledger T0 — fee routing conservation (debit player + credit treasury in ONE tx) > rake shape: crediting the treasury the withheld rake never touches the player [0.18ms]

src\services\__tests__\clv-swap-custody.test.ts:
(pass) loadClvSwapKeypair > happy path: decrypts the real envelope, pubkey-checks, memoizes [1.28ms]
(pass) loadClvSwapKeypair > missing row: throws wallet_missing (never a silent null) [0.17ms]
(pass) loadClvSwapKeypair > unresolvable read path: throws wallet_missing [0.15ms]
(pass) loadClvSwapKeypair > row-column mismatch: throws pubkey_mismatch; message NEVER carries key bytes [0.51ms]
(pass) loadClvSwapKeypair > read-path drift: row is self-consistent but the read path disagrees → refuse [0.43ms]
(pass) loadX402MerchantKeypair > REFUSES without the env pin — fail closed, zero DB reads [0.21ms]
(pass) loadX402MerchantKeypair > happy path: pinned pubkey matches the decrypted row [0.39ms]
(pass) loadX402MerchantKeypair > pin mismatch: refuses to sign [0.61ms]
(pass) loadX402MerchantKeypair > missing row: throws wallet_missing [0.12ms]
(pass) getClvMainnetConnection > is ALWAYS mainnet (public fallback without HELIUS_API_KEY) and memoized [0.93ms]
(pass) getClvMainnetConnection > uses the Helius MAINNET endpoint when HELIUS_API_KEY is set [0.12ms]

src\services\__tests__\clv-swap-executor.test.ts:
(pass) planClips — price-impact caps > splits $1000 against a $22k pool (1% cap) into 10 clips ≤ $110, sum exact [0.37ms]
(pass) planClips — price-impact caps > an amount under the cap is a single clip [0.05ms]
(pass) planClips — price-impact caps > floors the per-clip cap DOWN to µUSD (house-favorable) [0.04ms]
(pass) planClips — price-impact caps > REFUSES on null / zero / negative / NaN pool liquidity [0.09ms]
(pass) planClips — price-impact caps > REFUSES a dust pool whose cap floors to 0 µUSD [0.04ms]
(pass) planClips — price-impact caps > REFUSES malformed / non-positive amounts [0.07ms]
(pass) planClips — price-impact caps > REFUSES absurd clip counts (total-function guard) [0.04ms]
(pass) planClips — price-impact caps > sanitizes the bps cap: floor 1, non-finite → default, spacing default [0.05ms]
(pass) enqueueClvBuy — input guards + insert composition > throws on non-positive / NaN / malformed amounts BEFORE any DB touch [0.29ms]
(pass) enqueueClvBuy — input guards + insert composition > throws on empty reason / sourceRef BEFORE any DB touch [0.11ms]
(pass) enqueueClvBuy — input guards + insert composition > happy path (no tx): opens its OWN transaction, stamps the oracle quote [0.37ms]
(pass) enqueueClvBuy — input guards + insert composition > oracle-down: records the intent with quotedPrice NULL [0.10ms]
(pass) enqueueClvBuy — input guards + insert composition > composes into a PROVIDED tx (no own transaction opened) [0.09ms]
(pass) enqueueClvBuy — input guards + insert composition > HARD MAX-NOTIONAL CAP: > $10,000 throws BEFORE any DB touch; == passes [0.15ms]
(pass) enqueueClvBuy — input guards + insert composition > UPSERTS on (reason, source_ref): the insert carries an onConflictDoUpdate [0.10ms]
(pass) enqueueClvBuy — input guards + insert composition > DOUBLE-ENQUEUE same source_ref: replay returns the EXISTING queueId (never a throw) [0.09ms]
(pass) enqueueClvBuy — input guards + insert composition > REPLAY AMOUNT MISMATCH: still returns the existing id, logs LOUD, never mutates [0.16ms]
(pass) HARD GATE — CLV_SWAP_EXECUTE=true refuses the dry-run path > assertNoLiveClvSwapExecution throws the EXACT refusal [0.08ms]
(pass) HARD GATE — CLV_SWAP_EXECUTE=true refuses the dry-run path > startClvSwapWorker refuses to start under the flag [0.09ms]
(pass) resolveClvSwapMaxImpactBps — env sanitation > default 100; floor 1; cap 10_000; garbage → default [0.09ms]

src\services\__tests__\clv-swap-live.test.ts:
(pass) GATES — the live path is default-off > every live entrypoint refuses when CLV_SWAP_EXECUTE is not "true" [2.56ms]
(pass) GATES — the live path is default-off > NETWORK GUARD: devnet USDC refuses (CLV is mainnet-only) [0.48ms]
(pass) GATES — the live path is default-off > NETWORK GUARD: unset network (devnet-first default) also refuses [0.08ms]
(pass) GATES — the live path is default-off > NETWORK GUARD: the mock facilitator refuses (fake money can never fund a swap) [0.12ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > happy path: claim → custody → capture BEFORE send → confirm → swept [7.38ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > DOUBLE-SWEEP: a second call replays the swept row — no claim, no custody, no send [0.63ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > in-flight sweep refuses; terminal (reconcile/failed) is NEVER retried [1.05ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > amounts tied to SETTLED MAINNET checkouts ONLY [1.56ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > insufficient merchant USDC: releases the claim PRE-send (retryable once funded) [0.80ms]
[clv-swap-live] sweep pre-send failure — funding=fund-11111111-1111-4111-8111-111111111111: rpc_token_account_invalid
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > frozen merchant USDC is not spendable availability and releases before signing [0.93ms]
[clv-swap-live] UNEXPECTED POST-SIGNING ERROR — funding=fund-11111111-1111-4111-8111-111111111111: signer threw after mutation; → reconcile (never release/retry)
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > sign failure after signing starts strands in reconcile and never releases [2.21ms]
[clv-swap-live] UNEXPECTED POST-SIGNING ERROR — funding=fund-11111111-1111-4111-8111-111111111111: capture store unavailable; → reconcile (never release/retry)
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > capture failure after signing starts strands in reconcile and never releases [2.09ms]
[clv-swap-live] AMBIGUOUS SWEEP SEND — funding=fund-11111111-1111-4111-8111-111111111111 tx=5BZ3vpVZz57eyphradFbftuGGf5YP4VUv16Pqrje34ZBUqyNuG6covWA5twhBV26fk73AxcK5Dsc6kmAGspwMxLY; money-state UNKNOWN → reconcile (no re-send): boom: transport died mid-send
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > AMBIGUOUS send: signature captured, row → reconcile, NEVER retried [4.00ms]
[clv-swap-live] SWEEP TX FAILED ON-CHAIN — funding=fund-11111111-1111-4111-8111-111111111111 tx=5BZ3vpVZz57eyphradFbftuGGf5YP4VUv16Pqrje34ZBUqyNuG6covWA5twhBV26fk73AxcK5Dsc6kmAGspwMxLY; no USDC moved; row → failed (manual re-run decision)
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > definitive on-chain failure: row → failed (no money moved), loud terminal [4.78ms]
[clv-swap-live] SWEPT-MARK MISSED after confirmed sweep — funding=fund-11111111-1111-4111-8111-111111111111 tx=5BZ3vpVZz57eyphradFbftuGGf5YP4VUv16Pqrje34ZBUqyNuG6covWA5twhBV26fk73AxcK5Dsc6kmAGspwMxLY; the signature IS captured; manual verify required
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > confirmed sweep with a lost terminal CAS goes to reconcile, never reports success [5.60ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > treats an invalid post snapshot for a fresh transient wallet ATA as closed [7.37ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > still rejects a closed canonical CLV ATA post snapshot [4.69ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > still rejects a closed transient ATA that held a pre-simulation balance [3.73ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > credits rent in a CPI-created writable wallet-authority token account [5.60ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > accepts the one-time rent for the wallet's derived Pump user-volume accumulator [4.71ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not accept a newly-created Pump-owned account at a different address [4.59ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not accept the derived Pump user-volume accumulator above the rent cap [4.76ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not credit wallet-owned token-account rent recoverable by a foreign close authority [4.36ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > credits wallet-owned token-account rent when the wallet is the close authority [3.43ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not credit writable token-account rent controlled by a foreign authority [4.07ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not credit a writable Token-2022 multisig with incidental account-like bytes [4.13ms]
(pass) decodeJupiterV6RouteInstruction — route-agnostic trailing args > decodes a route whose final hop is Pump.fun Amm variant 99 without an AMM allowlist [0.25ms]
(pass) decodeJupiterV6RouteInstruction — route-agnostic trailing args > rejects a truncated route and an unknown discriminator [0.07ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > refuses when the funding is not swept — the claim is never taken [0.45ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > HAPPY PATH: $100 clip cap splits the row; conservation exact; executed [24.02ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accounts from ExactIn threshold, never optimistic Jupiter outAmount [6.21ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > DOUBLE-CLAIM: the second executor loses the claim and never touches custody [7.39ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > RESTART-MID-TICK: a row left "executing" by a crash is NEVER re-claimed [0.42ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > does not call DexScreener on the money path [6.41ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > a thrown pre-sign dependency error releases the empty claim to planned [0.56ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > refuses Jupiter price impact above maxImpactBps before requesting a swap [0.70ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed priceImpactPct "" [0.99ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed priceImpactPct "   " [0.66ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a zero-output Jupiter quote before requesting or signing a swap [0.55ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > ignores the informational wire threshold and accounts from the decoded instruction floor [10.35ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts optional route fee metadata when the complete pair is bounded [5.02ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: amount_only [0.55ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: mint_only [0.39ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: excessive [0.38ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: wrong_mint [0.48ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > fresh wallet omits destinationTokenAccount so Jupiter can create the canonical CLV ATA [5.06ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > existing initialized CLV ATA is pinned as destinationTokenAccount [4.76ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > refuses an existing uninitialized CLV ATA before requesting or signing a swap [0.70ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts a current Jupiter V1 route with compute budget, Token-2022 role, repeated wallet/CLV metas, and ALT keys [5.18ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an ALT-loaded writable token account controlled through malicious_wallet_token before signing [3.35ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an ALT-loaded writable token account controlled through malicious_wallet_delegate before signing [3.53ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an ALT-loaded writable token account controlled through malicious_wallet_close before signing [3.40ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a correct-payer transaction containing an arbitrary outer program before sign/capture/send [2.33ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a transaction requiring any signer besides the exact payer [2.27ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts a real multi-hop route with three wallet-owned idempotent ATA setups [5.72ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an idempotent ATA setup whose owner is not the swap wallet [2.82ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts a high CU price when the decoded total priority fee stays within budget [4.80ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects invalid total-priority-fee shape: priority_over_budget [2.37ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects invalid total-priority-fee shape: priority_without_limit [2.22ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects simulation when CLV output is below the decoded on-chain minimum [4.10ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects simulation when another wallet-owned token account decreases [5.61ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > bounds native lamport loss by the transaction actual priority fee, not the global maximum [5.68ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > releases an empty unsigned claim if malformed simulation data throws during parsing [4.85ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a Jupiter route whose encoded input is not the accepted exact clip [2.66ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > NEVER signs a swap tx whose fee payer is not our wallet [2.94ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > per-row max_slippage (fraction) overrides the env bps, clamped to the ceiling [16.61ms]
[clv-swap-live] AMBIGUOUS CLIP SEND — queue=q-1 clip=0 tx=3y4SzRkLsTzv9yhTeNmwL5daqsLKHHSvwPcTNbuUMv1aWWvVDHbvUHU5L7Xb4zsFnw7q7dGK23zY8TNCgzWdhVWf; money-state UNKNOWN → row stays 'executing', NEVER auto-retried: boom: transport died mid-send
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > AMBIGUOUS clip send: fill already captured, row stays executing, never auto-retried [5.37ms]
[clv-swap-live] CLIP TX FAILED ON-CHAIN — queue=q-1 clip=0 tx=3MAGWWSrEecBJY5JjeXA9L3JhKbP8XLo8d78HCZJ2ARNua5VdrBy1mUXj4QeWR2xndDfQyag5m9Z2HaWrmC7Fz5f; no funds moved this clip; row stays 'executing' (manual decision)
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > definitive post-signature clip failure keeps the captured claim executing [5.36ms]
(pass) runLiveClvSwapTick — sweep-then-execute per planned row > one planned row: sweeps its funding then executes the buy [9.22ms]
[clv-swap-live] STALE 'executing' CLAIM — queue=q-stale claimed_at=2026-09-16T12:57:52.586Z amount=$5.000000; crashed claim — manual reconcile required (NEVER auto-resumed)
(pass) runLiveClvSwapTick — sweep-then-execute per planned row > STALE-CLAIM ALERTING: a row stuck 'executing' past the floor pages ops — no retry, no mutation [0.56ms]
(pass) runLiveClvSwapTick — sweep-then-execute per planned row > a FRESH executing claim (younger than the stale floor) is NOT paged [0.29ms]
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > unset → the keyless lite-api default [0.10ms]
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > api.jup.ag (the paid base) is accepted; trailing slashes trimmed [0.15ms]
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'evil.example.com') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'jup.ag.evil.example') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > an OFF-ALLOWLIST https host falls back to the default (never a silent redirect of the money wire) [0.13ms]
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'lite-api.jup.ag') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'api.jup.ag') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL is not a parseable URL — falling back to https://lite-api.jup.ag
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > non-https / embedded credentials / garbage all fall back to the default [0.13ms]
(pass) resolveClvSwapExecutingStaleMs — default + hard floor > default 300s; below-floor values refuse to the default; valid override honored [0.09ms]
(pass) resolveClvSwapSlippageBps — executable default + bounds > defaults to 200 bps while remaining environment-overridable [0.06ms]
(pass) pure sizing helpers > sizeClipMicro caps every clip at exactly $100 USDC and preserves the remainder [0.05ms]

src\services\__tests__\cosmetic-signup-bonus.test.ts:
(pass) cosmetic signup bonus — allocateCosmeticSpend > grant fully covers a cheap SKU: grantUsed = price, realCt = 0 [1.45ms]
(pass) cosmetic signup bonus — allocateCosmeticSpend > grant partially covers a pricier SKU: grantUsed = grant, realCt = remainder [0.04ms]
(pass) cosmetic signup bonus — allocateCosmeticSpend > grant exactly equals the price [0.02ms]
(pass) cosmetic signup bonus — allocateCosmeticSpend > no grant left: grantUsed = 0, realCt = full price [0.02ms]
(pass) cosmetic signup bonus — allocateCosmeticSpend > negative/garbage grant remaining is clamped to 0 (never a negative draw) [0.02ms]
(pass) cosmetic signup bonus — allocateCosmeticSpend > CONSERVATION: grantUsed + realCt === priceCt for every combination [0.21ms]
(pass) cosmetic signup bonus — allocateCosmeticSpend > the signup-bonus constant is the post-redenomination $5 value (500 units at the ¢-peg) [0.02ms]

src\services\__tests__\cove-test-fixture.test.ts:
(pass) BA-2 fixture safety gate > imports when enabled only on the literal staging environment [136.96ms]
(pass) BA-2 fixture safety gate > derives the holdem-cash scenario family from the authoritative arm catalog [0.12ms]
(pass) BA-2 fixture safety gate > crashes at module load when enabled outside staging [132.51ms]
(pass) BA-2 fixture safety gate > keeps stale-shoe force-close before stale-run closure on replacement run [5.02ms]
(pass) BA-2 fixture safety gate > recovers linked resources from terminal as well as active prior runs [0.37ms]
(pass) BA-2 fixture safety gate > rotates a stale blocked run credential once before returning recovery 409 [0.50ms]
(pass) BA-2 fixture safety gate > serializes run replacement by owner and keeps a unique-active database backstop [0.56ms]
(pass) BA-2 fixture safety gate > fails closed when a fixture open loses the fresh-resource insert race [0.77ms]
(pass) BA-2 fixture safety gate > replacement recovery discards guest-demo practice only and refuses ledger loss [0.23ms]
(pass) BA-2 fixture safety gate > refuses unsafe blackjack/cash teardown and voids cash only after Walk Away [0.50ms]
(pass) BA-2 fixture safety gate > preserves fixture provenance with restrictive foreign keys [1.45ms]
(pass) BA-2 fixture safety gate > revalidates every practice deal/action/settle mutation under its lock transaction [0.33ms]
(pass) BA-2 fixture safety gate > rejects a delayed cash action when the live sim advanced to another hand [0.28ms]
(pass) BA-2 fixture safety gate > rejects a wrong cash arm before exposure or ledger mutation [0.83ms]
(pass) BA-2 fixture safety gate > authenticates fixture baccarat resume before threshold rotation and never commit-then-409s [0.41ms]
(pass) BA-2 fixture safety gate > commits initial-arm expiry before callers surface 402 and preserves closed status [0.29ms]
(pass) BA-2 token and state transitions > binds an authenticated Lucia guest to its active avatar and rejects anonymous fixture auth [0.30ms]
(pass) BA-2 token and state transitions > issues a 32-byte base64url token and persists only its sha256 digest [0.14ms]
(pass) BA-2 token and state transitions > consumes a seed arm exactly once [0.07ms]
(pass) BA-2 token and state transitions > accounts exposure atomically and rejects a leg beyond the budget [0.10ms]
(pass) BA-2 token and state transitions > blocks new exposure after exhaustion but permits zero-cost completion [0.12ms]
(pass) BA-2 token and state transitions > rejects a wrong resource run, owner, token, and expired run [0.26ms]
(pass) BA-2 deterministic catalog > pins all 13 frozen scenario ids [0.04ms]
(pass) BA-2 deterministic catalog > replays the blackjack outcomes and opening conditions [0.25ms]
(pass) BA-2 deterministic catalog > replays baccarat naturals, third cards, tie, and threshold state [0.31ms]
(pass) BA-2 deterministic catalog > makes the history verifier load and replay the persisted baccarat fixture offset [0.28ms]
(pass) BA-2 deterministic catalog > replays holdem showdown and fold-win scripts [2.86ms]
(pass) BA-2 deterministic catalog > replays cash advisor flow as a three-way showdown and deterministic fold win [149.51ms]

src\services\__tests__\cove-verify-compat.test.ts:
(pass) blackjackOutcomesMatch — new-rake-field back-compat > a PRE-RAKE stored net-win row (no rake keys) verifies TRUE [0.65ms]
(pass) blackjackOutcomesMatch — new-rake-field back-compat > a POST-FIX stored row (all keys, identical) verifies TRUE strictly [0.20ms]
(pass) blackjackOutcomesMatch — new-rake-field back-compat > a POST-FIX row with a WRONG rake value verifies FALSE [0.13ms]
(pass) blackjackOutcomesMatch — new-rake-field back-compat > a tampered GROSS field (totalPayout) verifies FALSE even on a pre-fix row [0.12ms]
(pass) blackjackOutcomesMatch — new-rake-field back-compat > cursorBefore/dealtBefore differences are ignored (persisted-only metadata) [0.12ms]
(pass) holdemOutcomesMatch — new-rake-field back-compat > a PRE-RAKE stored fold row (no rake keys) verifies TRUE [1.09ms]
(pass) holdemOutcomesMatch — new-rake-field back-compat > a PRE-RAKE stored row with a NON-ZERO rake (played hand) verifies TRUE [0.75ms]
(pass) holdemOutcomesMatch — new-rake-field back-compat > a POST-FIX stored row (all keys, identical) verifies TRUE strictly [0.41ms]
(pass) holdemOutcomesMatch — new-rake-field back-compat > a POST-FIX row with a WRONG rake value verifies FALSE [0.37ms]
(pass) holdemOutcomesMatch — new-rake-field back-compat > a tampered GROSS field (humanPayout) verifies FALSE even on a pre-fix row [0.38ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > PRE-FIX banker win at stake 5 (old monetary values) verifies TRUE [0.38ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > PRE-FIX banker win at stake 7 (old monetary values) verifies TRUE [0.12ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > PRE-FIX banker win at stake 10 (old monetary values) verifies TRUE [0.08ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > PRE-FIX banker win at stake 19 (old monetary values) verifies TRUE [0.08ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > PRE-FIX banker win at stake 30 (old monetary values) verifies TRUE [0.08ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > PRE-FIX banker win at stake 41 (old monetary values) verifies TRUE [0.08ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > a POST-FIX banker-win row (new values, identical) verifies TRUE strictly [0.11ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > a row with the WRONG payout (neither old nor new) verifies FALSE [0.12ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > a tampered NON-monetary field (winner) verifies FALSE [0.11ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > a tampered card (player.cards) verifies FALSE [0.12ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > cursorBefore/dealtBefore differences are ignored [0.10ms]
(pass) baccaratOutcomesMatch — banker-win changed-value back-compat > a PLAYER bet (unchanged by the fix) verifies TRUE both pre/post (no divergence) [0.11ms]
(pass) verify comparators are key-order-insensitive (jsonb reorder) > blackjack: a reordered-key stored row (jsonb sim) verifies TRUE [0.31ms]
(pass) verify comparators are key-order-insensitive (jsonb reorder) > hold’em: a reordered-key stored row (jsonb sim) verifies TRUE [0.55ms]
(pass) verify comparators are key-order-insensitive (jsonb reorder) > baccarat: a reordered-key stored row (jsonb sim) verifies TRUE [0.21ms]
(pass) verify comparators are key-order-insensitive (jsonb reorder) > canonicalJsonEq (slots winningLines): reordered object keys are equal, array order matters [0.10ms]

src\services\__tests__\covenant-action-stream.test.ts:
(pass) canonicalJson > sorts keys recursively and deterministically [0.11ms]
(pass) canonicalJson > drops undefined properties (matches JSON.stringify semantics) [0.02ms]
(pass) canonicalJson > keeps arrays in place (never sorts them) [0.06ms]
(pass) canonicalJson > payload hash is recomputable from the canonical encoding [0.12ms]
(pass) computeRecordHash > is stable (pinned vector — a change here breaks every verifier) [0.19ms]
(pass) computeRecordHash > every field is load-bearing [0.16ms]
(pass) computeRecordHash > NUL separation prevents field-boundary collisions [0.04ms]
(pass) computeRecordHash > toCanonicalIso normalizes Date and string identically [0.05ms]
(skip) covenant stream (DB) > recordCovenantAction inserts a row whose payload_hash is recomputable
(skip) covenant stream (DB) > in-tx record rolls back with the business write (no orphan record)
(skip) covenant stream (DB) > sealer chains unsealed rows in order and is re-runnable
(skip) covenant stream (DB) > tamper trigger: UPDATE of identity columns and DELETE are refused
(skip) covenant stream (DB) > dedupe key: a retry appends exactly one record (Codex r1 HIGH #2)
(skip) covenant stream (DB) > pre-sealed INSERT is refused by the guard trigger (Codex r1 HIGH #5)
(skip) covenant stream (DB) > sealer refuses a row whose stored payload_hash mismatches (Codex r1 HIGH #5)
(skip) covenant stream (DB) > ledger credit/debit emit coupled economy records atomically

src\services\__tests__\db-canary.test.ts:
(pass) DB canary configuration > applies defaults, floors, and the normalized exit kill switch [0.53ms]
(pass) DB canary classification and recovery > skips the fresh client on shared success and resets a prior wedge streak [0.94ms]
(pass) DB canary classification and recovery > reuses one unresolved shared probe across deadline failures [0.32ms]
(pass) DB canary classification and recovery > alerts, grants one second, and exits only at the configured wedge threshold [0.41ms]
(pass) DB canary classification and recovery > keeps alerting but never sleeps or exits when DB_CANARY_EXIT=false [0.28ms]
(pass) DB canary classification and recovery > classifies both probes failing as DB-down, never exits above threshold, and breaks the wedge streak [0.50ms]
(pass) fresh-client cleanup > ends a successful fresh client with a one-second timeout [0.22ms]
(pass) fresh-client cleanup > ends a fresh client whose probe errors or exceeds its deadline [0.40ms]
(pass) fresh-client cleanup > does not let cleanup failure change a successful fresh-probe classification [0.20ms]
(pass) driver liveness and worker lifecycle > warns only for an enrolled driver whose heartbeat is stale [0.22ms]
(pass) driver liveness and worker lifecycle > absorbs failures from optional seams and never rejects the tick [0.19ms]
[DbCanary] started — probing every 30000ms
(pass) driver liveness and worker lifecycle > starts/stops idempotently and skips overlapping scheduled ticks [0.28ms]

src\services\__tests__\directive-resolver.test.ts:
(pass) resolveDirectiveBuildingId > matches by building id token (memory-rag) [0.22ms]
(pass) resolveDirectiveBuildingId > matches by DISPLAY NAME even when the id is not present (Advisory-1) [0.06ms]
(pass) resolveDirectiveBuildingId > returns null for a directive that names no known building (bare topic / free text) [0.07ms]
(pass) resolveDirectiveBuildingId > prefers the LONGEST needle so a specific label beats a shorter accidental token [0.07ms]
(pass) resolveDirectiveBuildingId > respects token boundaries — a building id embedded in a larger word does NOT match [0.06ms]
(pass) resolveDirectiveBuildingId > is id-only (no throw, byte-identical) when no labels are supplied [0.05ms]

src\services\__tests__\earned-clawback.test.ts:
(pass) E2 administrative EARNED claw-back > is idempotent, debits available EARNED, records deficit, and releases exact remaining backing [1.58ms]

src\services\__tests__\earned-cutover.test.ts:
(pass) EARNED migration/deploy old-writer reconciliation > turns an old-writer post-migration mint into an explicit unbacked lot [0.56ms]
(pass) EARNED migration/deploy old-writer reconciliation > replays an old-writer spend against existing backing and releases it [0.27ms]
(pass) EARNED migration/deploy old-writer reconciliation > cannot hide a backed spend with an equal old unbacked mint [0.20ms]

src\services\__tests__\earned-import-policy.test.ts:
(pass) earned import founder-locked policy > never accepts devnet backing proof in production, even under a test runner [0.14ms]
(pass) earned import founder-locked policy > allows devnet backing proof only in isolated staging/test environments [0.06ms]
(pass) earned import founder-locked policy > keeps the entry rake disabled and converts cents with integer exactness [0.21ms]
(pass) earned import founder-locked policy > reserves current backing, retained fees, and unswept principal before minting [0.14ms]
(pass) earned import founder-locked policy > refuses new backing while a captured funding transfer is ambiguous [0.05ms]
(pass) earned import founder-locked policy > refuses a swept principal without a confirmed slot for an RPC freshness floor [0.04ms]
(pass) earned import founder-locked policy > replays only an identical immutable backing proof and skips chain RPC [0.90ms]
(pass) earned import founder-locked policy > refuses a custody balance observation older than the latest confirmed sweep [1.19ms]

src\services\__tests__\earned-redemption.test.ts:
(pass) E3 integer economics + dark gate > is default-off and accepts only the literal true [0.39ms]
(pass) E3 integer economics + dark gate > never hides durable reconcile/refused states on idempotent replay [0.13ms]
(pass) E3 integer economics + dark gate > computes gross, 444-bps retained fee, and net buy integer-exact [0.10ms]
(pass) E3 integer economics + dark gate > defaults the floor to 100 vCLAW and rejects unsafe env values [0.08ms]
(pass) request service with transactional DB adapter > persists one debit and replays the same durable row for one subject/key [1.00ms]
(pass) request service with transactional DB adapter > returns idempotency_conflict without a second debit when terms change [0.18ms]
(pass) request service with transactional DB adapter > durably refuses an unbacked rail-④ lot and replays that same refusal [0.22ms]
(pass) request service with transactional DB adapter > refuses a devnet-backed lot before the mainnet-only E3 machine [0.13ms]
(pass) request service with transactional DB adapter > refuses pending, rejected, unvested, and unstamped-vesting lots before any debit [0.32ms]
(pass) request service with transactional DB adapter > allocates oldest-first with integer-exact backing conservation [0.11ms]
(pass) request service with transactional DB adapter > never floors a short or misaligned backing row into a partial cash-out [0.06ms]
(pass) conservative queue output > sums signed fill minima and binds exact net-USDC clip inputs [0.22ms]
(pass) conservative queue output > refuses empty, optimistic-only, malformed, zero, or negative fills [0.04ms]
(pass) delivery capture-before-send kernel > commits the claim before custody preparation/signing and captures before send [0.24ms]
(pass) delivery capture-before-send kernel > does zero custody/signing work when the durable claim loses its CAS [0.09ms]
(pass) delivery capture-before-send kernel > durably captures before send and only then marks delivered [0.22ms]
(pass) delivery capture-before-send kernel > never sends when capture loses the CAS [0.10ms]
(pass) delivery capture-before-send kernel > quarantines ambiguous send after capture and never retries [0.17ms]
(pass) delivery capture-before-send kernel > treats an RPC-echo signature mismatch as ambiguous after capture [0.14ms]
(pass) promote-only captured-delivery reconcile sweep > promotes delivery_confirm_ambiguous and stale_captured_delivery only on exact on-chain proof [0.97ms]
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-transaction absent","verdict":"indeterminate"}
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-transaction failed","verdict":"not_delivered"}
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-amount mismatch","verdict":"indeterminate"}
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-different owner","verdict":"indeterminate"}
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-wrong mint","verdict":"indeterminate"}
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-source debit mismatch","verdict":"indeterminate"}
(pass) promote-only captured-delivery reconcile sweep > never resets to bought, never clears the signature, and never re-sends without exact proof [0.37ms]
{"event":"earned_redemption_reconcile_skip","redemptionId":"redemption-reconcile-1","verdict":"indeterminate"}
(pass) promote-only captured-delivery reconcile sweep > does not promote an exact destination credit funded by a different identifiable source owner [0.20ms]
(pass) promote-only captured-delivery reconcile sweep > rejects malformed or nonpositive expected atomic amounts before any RPC call [0.21ms]
(pass) promote-only captured-delivery reconcile sweep > does not touch other reconcile reasons or rows already marked delivered [0.15ms]
(pass) promote-only captured-delivery reconcile sweep > treats a lost delivered CAS as a benign no-op with no double-write [0.19ms]
{"event":"earned_redemption_reconcile_row_failed","redemptionId":"rpc-error","error":"reconcile_sweep_row_error"}
(pass) promote-only captured-delivery reconcile sweep > continues with later rows after one RPC check throws [0.30ms]
(pass) physical backing solvency calculation > fails closed with durable reasons for every structural backing wall [0.14ms]
(pass) physical backing solvency calculation > counts unswept net buy principal in addition to backing and retained fees [0.05ms]
(pass) physical backing solvency calculation > is indeterminate and false-green-proof for a captured ambiguous funding send [0.05ms]
(pass) physical backing solvency calculation > is indeterminate when a swept funding row lacks its captured proof [0.04ms]
(pass) physical backing solvency calculation > requires a positive persisted sweep slot and rejects a stale RPC context [0.14ms]
(pass) physical backing solvency calculation > never resets a stale no-signature claim after another worker reclaims it [0.06ms]
(pass) physical backing solvency calculation > never quarantines a stale captured snapshot after the active sender advances it [0.06ms]
(pass) physical backing solvency calculation > quarantines a sweeping null claimedAt without resetting or reclaiming it [0.17ms]

src\services\__tests__\earned-skill-memory.test.ts:
(pass) projectEarnedSkillRows > keeps only earned-skill rows, dropping other subtypes and empty content [0.12ms]
(pass) projectEarnedSkillRows > filters to a single building when buildingId is given [0.03ms]
(pass) projectEarnedSkillRows > respects the limit [0.02ms]
(pass) projectEarnedSkillRows > returns [] when no row carries the earned-skill subtype [0.02ms]
(pass) recordEarnedSkillLesson > returns 'none' for an empty lesson and touches neither store [0.20ms]
(pass) recordEarnedSkillLesson > writes to ElizaOS ('eliza') when the runtime is warm and accepts [0.13ms]
(pass) recordEarnedSkillLesson > falls back to the keyword store ('npc_memories') when no runtime is warm [0.11ms]
(pass) recordEarnedSkillLesson > falls back to the keyword store when the ElizaOS write returns false (embed failed) [0.11ms]
(pass) recordEarnedSkillLesson > never lazy-starts a runtime (ensureAgentRuntime throws if called) [0.06ms]
(pass) readEarnedSkillLessons > returns [] for a missing avatarId without touching any store [0.07ms]
(pass) readEarnedSkillLessons > returns RAG lessons from the warm runtime when it has any [0.10ms]
(pass) readEarnedSkillLessons > falls back to the keyword store when no runtime is warm, projecting earned-skill only [0.09ms]
(pass) readEarnedSkillLessons > falls back to the keyword store when the warm runtime has no lessons yet (mid-migration) [0.10ms]
(pass) readEarnedSkillLessons > never lazy-starts a runtime on the read path [0.06ms]

src\services\__tests__\earned-verification.test.ts:
(pass) E2 payer verification state machine > merges sibling payer wallets by first funder and enforces the cluster/earner cap [1.84ms]
(pass) E2 payer verification state machine > transitions pending to rejected while preserving spendable EARNED balance and releasing backing [0.29ms]
(pass) E2 payer verification state machine > keeps devnet and mainnet payer/cluster cap domains isolated [0.45ms]
(pass) E2 payer verification state machine > persists a cap-rejected payer mapping and rejects a later conflicting inspection [0.67ms]
(pass) E2 payer verification state machine > serializes concurrent conflicting first-funder observations for one payer [1.14ms]

src\services\__tests__\event-logger-redact-bearer.test.ts:
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves hatcher:my-cool-agent untouched [0.09ms]
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves milady:miu untouched
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves oc-mybot untouched
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves agent-1720000000000-ab12cd untouched
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves 550e8400-e29b-41d4-a716-446655440000 untouched
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves a1b2c3d4e5f60718 untouched
(pass) redactBearer — canonical agentId handles pass through UNCHANGED > leaves a non-string untouched [0.02ms]
(pass) redactBearer — a RAW bearer IS digested (never lands as agent_id) > digests ag-AAA… to a 16-hex correlation id [0.06ms]
(pass) redactBearer — a RAW bearer IS digested (never lands as agent_id) > digests oc-012… to a 16-hex correlation id
(pass) redactBearer — a RAW bearer IS digested (never lands as agent_id) > digests hat-zz… to a 16-hex correlation id
(pass) redactBearer — a RAW bearer IS digested (never lands as agent_id) > digests claw-B… to a 16-hex correlation id
(pass) redactBearer — a RAW bearer IS digested (never lands as agent_id) > a near-miss (wrong length) is NOT digested — it is a handle, not a bearer [0.03ms]

src\services\__tests__\gateway-parity.test.ts:
(pass) P3 slice 3 — gateway-parity (config-path proof) > routes TEXT cognition through openclaw-provider to a customization.gateway endpoint [11.59ms]

src\services\__tests__\hatcher-config.test.ts:
(pass) validateHatcherProxyUrl — protocol + creds > rejects non-https [0.17ms]
(pass) validateHatcherProxyUrl — protocol + creds > rejects embedded credentials [0.04ms]
(pass) validateHatcherProxyUrl — protocol + creds > rejects a malformed URL [0.07ms]
(pass) validateHatcherProxyUrl — protocol + creds > accepts a default-allowlisted https host [0.51ms]
(pass) validateHatcherProxyUrl — protocol + creds > accepts a subdomain of an allowlisted bare domain [0.04ms]
(pass) validateHatcherProxyUrl — protocol + creds > rejects a non-allowlisted host [0.04ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects AWS/GCP metadata link-local (https://169.254.169.254/latest/meta-data/) [0.16ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects IPv4 loopback (https://127.0.0.1) [0.02ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects RFC1918 10/8 (https://10.0.0.5) [0.01ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects RFC1918 172.16/12 (https://172.16.0.1) [0.01ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects RFC1918 172.31 edge (https://172.31.255.255) [0.01ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects RFC1918 192.168/16 (https://192.168.1.1) [0.01ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects CGNAT 100.64/10 (https://100.64.0.1) [0.01ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects 0/8 this-network (https://0.0.0.0) [0.01ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects IPv6 loopback (https://[::1]) [0.15ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects IPv6 link-local (https://[fe80::1]) [0.04ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects IPv6 unique-local (https://[fc00::1]) [0.03ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > rejects IPv4-mapped loopback (https://[::ffff:127.0.0.1]) [0.17ms]
(pass) validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1) > does not reject a non-RFC1918 172 host (172.32 is public) [0.07ms]
(pass) getHatcherAllowedHosts — env parsing > falls back to defaults when env unset [0.04ms]
(pass) getHatcherAllowedHosts — env parsing > parses a comma-separated env list (lowercased, trimmed) [0.08ms]
(pass) validateHatcherProxyUrlResolved — DNS-aware (SSRF #2) > short-circuits a sync failure without DNS [0.26ms]
(pass) validateHatcherProxyUrlResolved — DNS-aware (SSRF #2) > rejects an allowlisted host that resolves to a private IP [0.91ms]
(pass) validateHatcherProxyUrlResolved — DNS-aware (SSRF #2) > fails closed (not silently allowed) when DNS cannot resolve [23.08ms]
(pass) validateHatcherProxyUrlResolved — DNS-aware (SSRF #2) > passes an IP-literal allowlisted host without a second DNS round-trip [0.19ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > rejects private/loopback/link-local IP literals (no allowlist needed) [0.41ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > allows a PUBLIC IP literal over http OR https (no allowlist, scheme not restricted) [0.09ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > rejects a host that RESOLVES to a private IP (DNS-rebind) without any allowlist [0.46ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > rejects embedded credentials [0.08ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > rejects a non-http(s) scheme [0.07ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > rejects a malformed URL [0.12ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > fails closed when DNS cannot resolve (never silently allowed) [18.90ms]
(pass) validateOutboundUrlResolved — generic gateway SSRF (no allowlist) > allows an ordinary public host (no allowlist constraint) — the legit gateway case [19.60ms]

src\services\__tests__\holdem-betting-machine.test.ts:
(pass) betting-machine — 1. BB option > folded to BB preflop: BB checks → round closes with no further action [0.44ms]
(pass) betting-machine — 1. BB option > BB exercises the option to RAISE (currentBet>0 → verb is raise, reopens) [0.13ms]
(pass) betting-machine — 2. below-min raise rejected (non-all-in) > a non-all-in raise below the min-raise THROWS [0.14ms]
(pass) betting-machine — 2. below-min raise rejected (non-all-in) > a below-min BET (opening, non-all-in) THROWS [0.09ms]
(pass) betting-machine — 3. full raise reopens action > a FULL raise reopens: an already-acted seat acts again WITH raise rights [0.09ms]
(pass) betting-machine — 4. short all-in does not reopen > short all-in via raise: does NOT reopen, min-raise unchanged, re-raise by acted seat THROWS [0.06ms]
(pass) betting-machine — 4. short all-in does not reopen > already-acted seat re-raising OVER a short all-in is ILLEGAL (throws) — the BUG let it raise [0.10ms]
(pass) betting-machine — 4. short all-in does not reopen > min-raise unchanged proven via a YET-TO-ACT seat: a raise legal under the SHRUNK min is rejected under the correct min [0.10ms]
(pass) betting-machine — 5. yet-to-act seat keeps full rights vs a short all-in > a seat that has NOT acted may RAISE over a short all-in (to the original min-raise) [0.12ms]
(pass) betting-machine — 6. multi-way all-in side pots > three seats all-in at different levels form correct side pots with chip conservation [0.24ms]
(pass) betting-machine — 7. round termination > round ends when all live non-all-in seats have acted and matched the bet [0.13ms]
(pass) betting-machine — 7. round termination > checks around close the round (everyone checks postflop, no bet) [0.08ms]
(pass) betting-machine — BUG 5: multi-winner rake conserves chips > three-way split of a real pot: sum(rakedWon) + rake === pot, no chip dropped [0.17ms]
(pass) betting-machine — BUG 5: multi-winner rake conserves chips > tiny pot where a winner's whole award is consumed by rake: leftover REASSIGNED, not dropped [0.08ms]
(pass) betting-machine — BUG 5: multi-winner rake conserves chips > multi-winner pot<=5 (rake 0) keeps full awards — conservation trivially holds [0.06ms]

src\services\__tests__\holdem-engine.test.ts:
(pass) holdem-engine — deck > buildDeck has 52 unique cards [0.14ms]
(pass) holdem-engine — deck > shuffleDeck yields 52 unique cards (no dup/loss) [0.21ms]
(pass) holdem-engine — deck > shuffleDeck is deterministic for identical inputs [0.28ms]
(pass) holdem-engine — deck > shuffleDeck differs across nonces [0.24ms]
(pass) holdem-engine — evaluator > royal flush [0.13ms]
(pass) holdem-engine — evaluator > straight flush (king-high) [0.05ms]
(pass) holdem-engine — evaluator > four of a kind with kicker [0.05ms]
(pass) holdem-engine — evaluator > full house (trips over pair) [0.03ms]
(pass) holdem-engine — evaluator > full house from two trips picks higher trips + lower as pair [0.04ms]
(pass) holdem-engine — evaluator > flush ordered by ranks [0.07ms]
(pass) holdem-engine — evaluator > straight (regular) [0.05ms]
(pass) holdem-engine — evaluator > wheel straight A-2-3-4-5 = five-high [0.04ms]
(pass) holdem-engine — evaluator > three of a kind + 2 kickers [0.07ms]
(pass) holdem-engine — evaluator > two pair + kicker [0.05ms]
(pass) holdem-engine — evaluator > one pair + 3 kickers [0.04ms]
(pass) holdem-engine — evaluator > high card [0.05ms]
(pass) holdem-engine — evaluator > compareHandRank ranks categories correctly [0.06ms]
(pass) holdem-engine — evaluator > compareHandRank breaks ties by kicker [0.05ms]
(pass) holdem-engine — evaluator > identical hands compare equal (split) [0.04ms]
(pass) holdem-engine — evaluator > wheel straight flush is five-high not ace-high [0.04ms]
(pass) holdem-engine — strength estimate > AA preflop beats 72o preflop [0.05ms]
(pass) holdem-engine — strength estimate > postflop made flush beats a pair [0.09ms]
(pass) holdem-engine — strength estimate > is deterministic [0.04ms]
(pass) holdem-engine — side pots > single pot when all committed equally [0.07ms]
(pass) holdem-engine — side pots > multi all-in builds layered side pots [0.08ms]
(pass) holdem-engine — side pots > folded short-stack chips stay in pot as dead money but seat ineligible [0.07ms]
(pass) holdem-engine — full hand > human folds preflop → loses only blinds owed (often 0) [0.46ms]
(pass) holdem-engine — full hand > replay reproduces the live result byte-for-byte [0.84ms]
(pass) holdem-engine — full hand > chip conservation: total won === total committed across all seats [7.18ms]
(pass) holdem-engine — full hand > button/blind seats are correct [0.52ms]
(pass) holdem-engine — full hand > bots are deterministic given identical inputs [0.47ms]
(pass) holdem-engine — full hand > SEATS hole cards + board are all distinct (no card reuse) [0.40ms]
(pass) holdem-engine — full hand > exactly one pot winner set is non-empty (someone wins) [4.03ms]
(pass) holdem-engine — full hand > human raise all-in is legal and resolves [0.29ms]
(pass) holdem-engine — full hand > illegal check (owing chips) throws [0.19ms]
(pass) holdem-engine — full hand > running out of human actions throws (route must record every turn) [0.19ms]
(pass) holdem-engine — full hand > split pot: chip conservation holds even on ties [0.35ms]
(pass) holdem-engine — full hand > serialized outcome has stringified bigints + holdem discriminator [0.45ms]
(pass) holdem-engine — full hand > humanNet = humanPayout - humanBet [2.01ms]
(pass) holdem-engine — all-in through full play > human shoves a short stack; chips conserve + eligibility respected [5.80ms]
(pass) holdem-engine — all-in through full play > a human all-in for less than the bet can win at most the matched portion [0.46ms]
(pass) holdem-engine — constants > 6-max, SB=1, BB=2 [0.04ms]
(pass) holdem-engine — in-progress view board truncation (fairness) > visibleBoardCountForStreet maps streets to dealt-card counts [0.08ms]
(pass) holdem-engine — in-progress view board truncation (fairness) > every in-progress peek board length === the visible-street count, NEVER more [129.29ms]
(pass) holdem-engine — in-progress view board truncation (fairness) > PREFLOP decision reveals ZERO board cards (the originally-reported leak) [16.53ms]
(pass) holdem-engine — in-progress view board truncation (fairness) > the in-progress view NEVER leaks any bot hole cards [8.36ms]
(pass) holdem-engine — in-progress view board truncation (fairness) > a deeper street peek is a strict prefix of the eventual full board [118.93ms]
(pass) holdem-engine — computeHoldemRake > rake constants are 5% capped at 5 CT [0.10ms]
(pass) holdem-engine — computeHoldemRake > rake == min(floor(pot*5/100), 5) AND sum(rakedWon) + rake === pot (chip conservation) [13.87ms]
(pass) holdem-engine — computeHoldemRake > a 200-chip pot rakes exactly the 5 CT cap (floor(200*5/100)=10 → capped to 5) [0.20ms]
(pass) holdem-engine — computeHoldemRake > a tiny pot (3 chips) rakes 0 (floor(3*5/100)=0); winner keeps the whole pot [0.07ms]
(pass) holdem-engine — computeHoldemRake > split pot: rake is taken ONCE total then distributed proportionally (conservation holds) [0.10ms]
(pass) holdem-engine — computeHoldemRake > serialized outcome carries rake + humanRakedPayout + humanRakedNet [0.27ms]
(pass) holdem-engine — computeHoldemRake > idempotent replay of a POST-rake row returns the stored RAKED figures [0.37ms]
(pass) holdem-engine — computeHoldemRake > idempotent replay of a PRE-rake row falls back to GROSS figures (regression) [0.32ms]

src\services\__tests__\hosted-agent-knowledge.test.ts:
(pass) hosted agent knowledge synchronization > merges each knowledge surface independently and preserves customization siblings [1.37ms]
(pass) hosted agent knowledge synchronization > rejects a mismatched owner or an avatar without a platform agent [0.19ms]
(pass) hosted agent knowledge synchronization > creates a knowledge memory with the requested source metadata [0.69ms]
[hosted-agent-knowledge] Memory persist failed (non-fatal): embedding store offline
(pass) hosted agent knowledge synchronization > keeps a committed merge successful when memory creation fails [0.44ms]
(pass) hosted agent knowledge synchronization > does not start or stop the runtime when the merge found nothing new [0.15ms]
(pass) hosted agent knowledge read > returns a warm-runtime semantic hit without reading the database [0.18ms]
(pass) hosted agent knowledge read > falls through from a warm empty runtime to the newest database tail [0.19ms]
(pass) hosted agent knowledge read > uses the authoritative database fallback when the runtime is cold [0.10ms]
(pass) hosted agent knowledge read > returns an empty array when the database fallback fails [0.10ms]

src\services\__tests__\hosted-avatar-agent-session.test.ts:
[NPC Simulation] Stopped
(pass) (1) hostedAvatarAgentId > returns the platformAgentId verbatim (opaque, deterministic, non-reserved) [0.23ms]
[NPC Simulation] Stopped
(pass) (1) hostedAvatarAgentId > throws on empty and on a reserved partner namespace [0.15ms]
[NPC Simulation] Stopped
(pass) (2) buildHostedAvatarAgentConfig > binds ledgerCapable=true AND boundUserId=owner (both, or the cove 403s) [0.05ms]
[NPC Simulation] Stopped
(pass) (2) buildHostedAvatarAgentConfig > is a self-managed, fail-soft nanoclaw avatar body (no outbound POST) [0.05ms]
[NPC Simulation] Stopped
(pass) (2) buildHostedAvatarAgentConfig > renders as the avatar (species = the owner-avatar model key), sessionId = bearer [0.04ms]
[NPC Simulation] Stopped
(pass) (3) hostedAvatarBotRowValues > is a non-house, owner-bound Milady avatar row using the fail-soft wire [0.06ms]
[NPC Simulation] Stopped
(pass) (3) hostedAvatarBotRowValues > carries a NON-NULL future TTL (null = expired downstream) + the one-way hash, never the raw bearer [0.11ms]
[NPC Simulation] Stopped
(pass) (4) isHostedSessionReusable > reuses ONLY when RAM-live AND body-present [0.06ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "TestHostedAgent" (oc-sess:ea6ebfb218a5bee2) [self-managed]
(pass) (5) sim mechanics > registers ONE deterministic ocb- body with the gate-relevant ledger config [0.28ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "TestHostedAgent" (oc-sess:0563f917f568cddf) [self-managed]
[OpenClaw] Avatar injected: "TestHostedAgent" (oc-sess:84b5438c10150f65) [self-managed]
[OpenClaw] Unregistered: sess:0563f917f568cddf
(pass) (5) sim mechanics > re-mint (register new → evict old) keeps ONE body owned by the new bearer; old bearer dies [0.31ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "TestHostedAgent" (oc-sess:be1e0254d7294297) [self-managed]
(pass) (5) sim mechanics > a reaped body with a surviving session is NOT reusable (getNpcById, not getNpcIdForSession) [0.11ms]
[NPC Simulation] Stopped
[OpenClaw] Avatar injected: "TestHostedAgent" (oc-sess:52f934a8e6d9e8c3) [self-managed]
[OpenClaw] Avatar injected: "TestHostedAgent" (oc-sess:d9dabb53aa628208) [self-managed]
(pass) (5) sim mechanics > after a "restart" (Map cleared) the old bearer is NOT reusable → re-mint restores a live body [0.13ms]

src\services\__tests__\hosted-gateway-prewarm.test.ts:
(pass) isPrewarmableProtocol — trigger predicate > the two server-hosted LOCAL runtimes are prewarmable [0.12ms]
(pass) isPrewarmableProtocol — trigger predicate > BYO gateways / fail-soft / partner protocols are NOT prewarmable [0.05ms]
(pass) isPrewarmableProtocol — trigger predicate > fail-closed on unknown / undefined / empty [0.03ms]
(pass) predicate composed with resolveInWorldProtocol — gate-off & BYO fall out of the real wire > hermes: gate ON ⇒ prewarmable, gate OFF ⇒ not [0.03ms]
(pass) predicate composed with resolveInWorldProtocol — gate-off & BYO fall out of the real wire > openclaw: gateway-LESS + gate ON ⇒ prewarmable; gate OFF ⇒ not [0.03ms]
(pass) predicate composed with resolveInWorldProtocol — gate-off & BYO fall out of the real wire > openclaw: BYO (declared gateway) is NEVER prewarmable, even with the gate ON [0.03ms]
(pass) predicate composed with resolveInWorldProtocol — gate-off & BYO fall out of the real wire > non-hosted identities never resolve to a prewarmable protocol [0.05ms]
(pass) maybePrewarmHostedGateway — orchestration > a non-prewarmable protocol never warms [13.86ms]
(pass) maybePrewarmHostedGateway — orchestration > a prewarmable agent warms exactly once, and re-connect is idempotent [30.73ms]
(pass) maybePrewarmHostedGateway — orchestration > a pre-warm failure never propagates AND releases the slot [30.93ms]
(pass) maybePrewarmHostedGateway — orchestration > concurrency is bounded to 2 in flight; the rest drain as slots free [48.86ms]
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-66
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-67
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-68
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-69
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-70
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-71
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-72
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-73
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-74
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-75
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-76
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-77
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-78
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-79
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-80
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-81
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-82
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-83
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-84
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-85
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-86
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-87
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-88
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-89
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-90
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-91
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-92
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-93
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-94
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-95
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-96
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-97
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-98
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-99
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-100
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-101
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-102
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-103
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-104
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-105
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-106
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-107
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-108
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-109
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-110
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-111
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-112
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-113
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-114
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-115
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-116
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-117
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-118
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-119
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-120
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-121
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-122
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-123
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-124
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-125
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-126
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-127
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-128
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-129
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-130
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-131
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-132
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-133
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-134
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-135
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-136
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-137
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-138
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-139
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-140
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-141
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-142
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-143
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-144
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-145
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-146
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-147
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-148
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-149
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-150
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-151
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-152
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-153
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-154
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-155
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-156
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-157
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-158
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-159
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-160
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-161
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-162
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-163
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-164
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-165
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-166
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-167
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-168
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-169
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-170
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-171
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-172
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-173
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-174
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-175
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-176
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-177
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-178
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-179
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-180
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-181
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-182
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-183
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-184
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-185
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-186
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-187
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-188
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-189
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-190
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-191
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-192
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-193
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-194
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-195
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-196
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-197
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-198
[Prewarm] queue saturated (64) — skipping warm-up for agent sat-199
(pass) maybePrewarmHostedGateway — orchestration > a saturated queue drops the excess instead of growing unbounded [639.03ms]

src\services\__tests__\identity-service.test.ts:
(pass) identity fingerprint heal-on-reconnect > a legacy nanoclaw key presented as custom heals the same user in probe order [0.95ms]
(pass) identity fingerprint heal-on-reconnect > different novel framework labels with the same key resolve one canonical custom account [0.18ms]
(pass) identity fingerprint heal-on-reconnect > the second reconnect hits the new fingerprint without a legacy probe [0.10ms]
(pass) identity fingerprint heal-on-reconnect > two concurrent heals converge on one user [0.14ms]
(pass) identity fingerprint heal-on-reconnect > a wrong key under every supported type never resolves the victim [0.27ms]
(pass) identity fingerprint heal-on-reconnect > brand-new supported keys create fresh users without disturbing one another [0.24ms]
(pass) identity fingerprint heal-on-reconnect > partner-only identities never enter the legacy-probe path [0.07ms]

src\services\__tests__\inference-usage-reporter.test.ts:
(pass) inference usage report gate > defaults on only in production and honors exact on/off overrides [0.25ms]
(pass) inference usage report tick > subtracts the previous successful cumulative snapshot on the second run [1.54ms]
(pass) inference usage report tick > sends the zero-activity heartbeat [0.27ms]
(pass) inference usage report tick > always shows current local box reachability independent of traffic [0.25ms]
(pass) inference usage report tick > estimates known OpenAI models and leaves unknown-model tokens unpriced [0.64ms]
(pass) inference usage report tick > shows only non-zero blackout and currently-open breaker warnings [0.30ms]
(pass) inference usage report tick > swallows sender failures and retries the same since-boot window [0.41ms]
(pass) inference box status watcher > requires two consecutive open checks before alerting [0.49ms]
(pass) inference box status watcher > recovers immediately only after an offline alert was confirmed [0.21ms]
(pass) inference box status watcher > names the surviving local box when only one box goes offline [0.16ms]
(pass) inference box status watcher > appends the all-boxes escalation only when the last local is confirmed offline [0.18ms]
(pass) inference box status watcher > alerts after two checks when a box is already offline at boot [0.15ms]
(pass) inference box status watcher > retries an offline transition on the next check when sending throws [0.40ms]
(pass) inference box status watcher > watches OpenAI with the same debounce and recovery transitions [0.20ms]
(pass) inference box status watcher > does not evaluate stats or send when the shared gate is off [0.10ms]

src\services\__tests__\keyed-mutex.test.ts:
(pass) withKeyedMutex > serializes same-key sections (no interleave) [23.12ms]
(pass) withKeyedMutex > runs different-key sections concurrently [15.50ms]
(pass) withKeyedMutex > returns the section result and propagates per-caller [0.16ms]
(pass) withKeyedMutex > releases the lock when a section throws (no wedge) and a later waiter still runs [15.28ms]
(pass) withKeyedMutex > drains the key map after all sections settle (no unbounded growth) [43.97ms]
(pass) withKeyedMutex > a prior caller failing does not reject a queued caller acquire [2.49ms]

src\services\__tests__\land-hold-transfer-verify.test.ts:
(pass) spec §9 frozen signatures > exports every frozen signature with the frozen shape [0.60ms]
(pass) spec §9 frozen signatures > carries the frozen LandHoldVerifyError constructor shape [0.27ms]
(pass) T4 mainnet RPC seam > builds the Helius mainnet endpoint from HELIUS_API_KEY [0.22ms]
(pass) T4 mainnet RPC seam > falls back to public mainnet-beta, never a devnet endpoint [0.23ms]
(pass) T4 mainnet RPC seam > never couples to cluster-selected RPC config [0.76ms]
(pass) configuration > clamps every knob to its documented floor [0.35ms]
(pass) configuration > uses the documented defaults when unset or unparseable [0.23ms]
(pass) transfer door availability > reports the provisioned verify address [0.87ms]
(pass) transfer door availability > reports unavailable when the verify wallet is unprovisioned and refuses to open [0.69ms]
(pass) transfer door availability > fails soft to unavailable when the treasury read throws [0.33ms]
(pass) openTransferChallenge > mints an exact dust amount bound to the declared wallet [1.04ms]
(pass) openTransferChallenge > refuses when the account has not declared that wallet [0.78ms]
(pass) openTransferChallenge > refuses a syntactically invalid wallet without touching the store [0.48ms]
(pass) T5 drain guard > refuses the per-user daily attempt over the cap and pages ops once [1.51ms]
(pass) T5 drain guard > counts the cap per user, so one user cannot lock another out [1.42ms]
(pass) T5 drain guard > counts ONLY our fee against the global cap, never the refunded principal [9.65ms]
(pass) T5 drain guard > the global daily refund cap defers the send, pages ops, and never revokes verification [9.29ms]
(pass) T5 drain guard > admits a refund that fits under the cap [3.56ms]
(pass) T6 exact-amount uniqueness > regenerates a distinct amount on every collision [0.51ms]
(pass) T6 exact-amount uniqueness > gives up rather than reusing an amount when the space is saturated [0.33ms]
(pass) T6 exact-amount uniqueness > surfaces exhaustion as an unavailable door plus a critical page, never a reused amount [1.00ms]
(pass) T6 exact-amount uniqueness > two concurrent challenges from the SAME sender get different amounts and attribute independently [2.94ms]
(pass) attribution > settles on an exact single-instruction transfer signed by the declared wallet [0.66ms]
(pass) attribution > IDENTIFIES a transfer nested in inner instructions, without treating it as proof [0.99ms]
(pass) attribution > rejects an off-by-one lamport amount [0.86ms]
(pass) attribution > rejects the same amount sent by a DIFFERENT wallet (wrong sender) [0.85ms]
(pass) attribution > rejects a transfer to a destination that is not our verify address [0.79ms]
(pass) attribution > rejects a FAILED transaction even when the transfer leg matches exactly [0.57ms]
(pass) attribution > rejects a matching transfer when the declared wallet did not sign [0.79ms]
(pass) attribution > ignores transferWithSeed, whose source is signed for by a different base key [0.63ms]
(pass) attribution > settles an exact, correctly signed transfer that carries no memo [0.78ms]
(pass) attribution > ignores a different challenge's memo [0.81ms]
(pass) attribution > ignores a CPI-emitted memo when the transfer itself is top level [0.69ms]
(pass) attribution > accepts a TOP-LEVEL memo in raw base58 form [0.70ms]
(pass) attribution > REFUSES a CPI-emitted transfer leg even with a top-level memo [0.64ms]
(pass) attribution > sums EVERY leg from the sender, so a double-paid transfer is fully refundable [0.97ms]
(pass) attribution > parses a decorated memo from the v1 program but does not depend on it [0.77ms]
(pass) attribution > does not use the challenge id as a settlement predicate [0.80ms]
(pass) attribution > ignores a non-system program that mimics the parsed transfer shape [0.69ms]
(pass) attribution > accepts only block times inside the challenge window [0.42ms]
(pass) T7 one signature, one challenge > a repeated scan of the same signature is a no-op [5.13ms]
(pass) T7 one signature, one challenge > one signature cannot satisfy a second challenge with the same amount [0.76ms]
(pass) T7 one signature, one challenge > binds one signature at most once across a poll and submit race [1.07ms]
(pass) T7 one signature, one challenge > pages ops when one transaction pays two challenges, so the unsettled dust is not silently kept [0.76ms]
(pass) T8 finalized only > reads signatures and transactions at finalized commitment [3.19ms]
(pass) T8 finalized only > never grants on a merely confirmed signature [0.86ms]
(pass) T8 finalized only > an expired-TTL challenge is refunded but NEVER verified [3.45ms]
(pass) T8 finalized only > still verifies a transfer that lands inside the block-time skew tolerance [0.78ms]
(pass) T8 finalized only > expires a lapsed challenge with nothing attributed [0.85ms]
(pass) T9 grant and refund discipline > grants verification with method transfer bound to the declared pubkey [0.90ms]
(pass) T9 grant and refund discipline > recovers an observed row on the next poll after the first grant attempt fails [0.99ms]
(pass) T9 grant and refund discipline > recovers an observed row on the next sweep when the panel is closed [4.00ms]
(pass) T9 grant and refund discipline > fails CLOSED when the declaration changed under an in-flight proof, and still refunds [4.72ms]
(pass) T9 grant and refund discipline > captures the refund signature BEFORE any send [5.23ms]
(pass) T9 grant and refund discipline > refunds exactly once across repeated sweeps (idempotent replay) [4.81ms]
(pass) T9 grant and refund discipline > an ambiguous send goes to reconcile, pages ops, and is NEVER re-sent [5.30ms]
(pass) T9 grant and refund discipline > an ambiguous send that actually LANDED resolves to sent without a second send [3.89ms]
(pass) T9 grant and refund discipline > a refund that landed REVERTED quarantines to reconcile rather than re-sending [5.10ms]
(pass) T9 grant and refund discipline > a refund failure never revokes an already-granted verification [4.81ms]
(pass) T9 grant and refund discipline > refuses to refund from a ROTATED verify wallet rather than spending the wrong treasury [1.77ms]
(pass) T9 grant and refund discipline > refuses to sign when the decrypted key does not match the stored public key [2.17ms]
(pass) memo compatibility, end to end > settles an exact transfer with no memo and refunds it [4.42ms]
(pass) memo compatibility, end to end > settles a transfer carrying another challenge's memo [4.34ms]
(pass) memo compatibility, end to end > ignores a CPI-emitted memo and settles the top-level transfer [3.38ms]
(pass) memo compatibility, end to end > accepts a TOP-LEVEL memo end to end [0.90ms]
(pass) memo compatibility, end to end > publishes the memo on the open result, the poll status and the challenge id [0.76ms]
(pass) memo compatibility, end to end > tells a smart-wallet holder their wallet cannot be verified, instead of hanging pending [3.30ms]
(pass) scan cost control > keeps live polls from re-parsing signatures with an active defer [1.25ms]
(pass) scan cost control > aborts the remaining harvest parse batch after a 429 [1.21ms]
(pass) scan cost control > shares one in-flight destination harvest across concurrent polls [1.24ms]
(pass) scan cost control > runs the broad seven-day harvest between narrow polls inside the destination floor [1.47ms]
(pass) scan cost control > bounds and lazily prunes completed harvest windows across one-off destinations [82.30ms]
(pass) scan cost control > skips signatures outside the candidate window before spending a parse [6.97ms]
(pass) scan cost control > parses an OUTBOUND in-window signature once, however many passes run [1.42ms]
(pass) scan cost control > never caches an INBOUND miss, so another user’s payment is not blinded [3.67ms]
(pass) scan cost control > never re-parses our OWN refund, which lands on the verify address [3.12ms]
(pass) scan cost control > ages the resolve window from the lease it JUST took, not a pre-takeover stamp [3.51ms]
(pass) amount reuse and destination rotation > never re-issues an amount a lapsed row is still being scanned for [0.56ms]
(pass) amount reuse and destination rotation > gives one transfer to the NEWEST matching challenge, not the lapsed one [2.84ms]
(pass) amount reuse and destination rotation > scans EVERY destination, so dust paid to a retired verify address is not stranded [1.58ms]
(pass) top-level transfer enforcement > refuses the full attack shape because the payment is CPI-emitted [3.53ms]
(pass) top-level transfer enforcement > rejects a CPI-emitted PAYMENT even when the memo is top level [3.45ms]
(pass) BLOCKER 2 — the refund-fee cap is bound to an authorization window > an AGED backlog cannot spend past the cap when processing resumes [4.74ms]
(pass) BLOCKER 2 — the refund-fee cap is bound to an authorization window > stamps the authorization day + policy immutably on the row it admits [3.48ms]
(pass) BLOCKER 2 — the refund-fee cap is bound to an authorization window > refuses when this process disagrees with the day’s recorded cap policy [0.78ms]
(pass) BLOCKER 3 — cheap spam cannot eclipse a real deposit > defers a null-parse head so the immediate broader pass reaches older entries [2.27ms]
(pass) BLOCKER 3 — cheap spam cannot eclipse a real deposit > finds a payment buried behind a page of newer spam, and parses each spam once [6.06ms]
(pass) BLOCKER 3 — cheap spam cannot eclipse a real deposit > matches a challenge against facts parsed on an EARLIER pass, with no re-parse [5.65ms]
(pass) BLOCKER 4 — duplicate refund signatures are quarantined, never double-sent > carries a per-challenge memo so two refunds can never share bytes [4.14ms]
(pass) BLOCKER 4 — duplicate refund signatures are quarantined, never double-sent > quarantines a colliding signature UNSENT rather than recording two payments [3.04ms]
(pass) BLOCKER 5 — every received leg is refunded > refunds the FULL amount when one transaction pays the exact leg twice [2.67ms]
(pass) BLOCKER 5 — every received leg is refunded > records the exact amount when the transaction pays exactly once [0.62ms]
(pass) HARDENING 6 — the door closes when the signer cannot pay > reports unavailable and pages ops when the verify wallet has no float [4.63ms]
(pass) HARDENING 6 — the door closes when the signer cannot pay > reports unavailable when the stored key does not decrypt to the stored pubkey [0.86ms]
(pass) HARDENING 6 — the door closes when the signer cannot pay > reports unavailable when the balance cannot be read at all [0.66ms]
(pass) HARDENING 6 — the door closes when the signer cannot pay > stays open with a healthy signer and float [0.50ms]
(pass) HARDENING 7 — only a confirmed status closes a refund as paid > does NOT go terminal on a merely processed status [2.85ms]
(pass) HARDENING 8 — terminal transitions are bound to their owner > refuses a finish that names neither the claim nor the captured signature [0.42ms]
(pass) HARDENING 8 — terminal transitions are bound to their owner > refuses a stale worker finishing a row another worker captured [0.62ms]
(pass) submitTransferSignature > verifies from the signature the user hands us [0.67ms]
(pass) submitTransferSignature > cannot settle ANOTHER account’s challenge with a stolen challenge id [0.68ms]
(pass) submitTransferSignature > refuses a transaction that pays a DIFFERENT challenge, without consuming this one [0.75ms]
(pass) submitTransferSignature > rejects a transfer whose source did not sign, and refunds it [2.14ms]
(pass) submitTransferSignature > refuses a transaction that is not finalized (or does not exist) [0.57ms]
(pass) submitTransferSignature > treats a finalized transaction with null block time as retryable without consuming the challenge [0.56ms]
(pass) submitTransferSignature > is idempotent on replay, and refuses a SECOND different signature [0.63ms]
(pass) submitTransferSignature > refuses an amount mismatch without consuming the challenge [0.59ms]
(pass) submitTransferSignature > settles a memo-less transfer and refunds it [2.73ms]
(pass) submitTransferSignature > refuses a malformed signature before any RPC work [1.03ms]
(pass) submitTransferSignature > refuses a failed transaction [0.92ms]
(pass) submitTransferSignature > cannot be eclipsed: a payment behind thousands of newer signatures still verifies [2.08ms]
(pass) ROUND 3 — refund obligations are DURABLE, never just an alert > records an obligation for a deposit that arrives with no submission [1.27ms]
(pass) ROUND 3 — refund obligations are DURABLE, never just an alert > records an obligation for ANOTHER sender’s legs in a settled transaction [1.21ms]
(pass) ROUND 3 — refund obligations are DURABLE, never just an alert > records an obligation when the verify wallet rotated and we cannot sign [1.10ms]
(pass) ROUND 3 — scan facts are stored WHOLE or not at all > leaves an over-sized transaction unscanned and pages ops, never truncated [5.74ms]
(pass) ROUND 3 — scan facts are stored WHOLE or not at all > stores facts whole when the transaction fits [0.49ms]
(pass) ROUND 3 — cap-policy health closes the door > closes the door when the recorded policy disagrees with this pod [0.43ms]
(pass) ROUND 3 — cap-policy health closes the door > stays open when the recorded policy agrees [0.36ms]
(pass) submit versus sweep > verifies an in-window payment when the closed sweep wins before a late submit [2.37ms]
(pass) submit versus sweep > refunds an out-of-window closed payment without granting verification [3.32ms]
(pass) submit versus sweep > preserves the unclaimed refund when a closed candidate full fetch is unavailable [3.66ms]
(pass) submit versus sweep > keeps a post-grace row scannable after one thrown closed-row full fetch [1.37ms]
(pass) submit versus sweep > writes unclaimed and authorizes its refund after three consecutive thrown full fetches [3.19ms]
(pass) submit versus sweep > counts one shared signature at most once per sweep across destination groups [3.82ms]
(pass) submit versus sweep > uses unclaimed fallback on a thrown fetch inside the final two sweep slots [2.90ms]
(pass) submit versus sweep > retries the oldest defer before fifty newer defers consume the final-margin tail [12.61ms]
(pass) submit versus sweep > scopes a multi-destination parse defer through final-margin attribution [3.24ms]
(pass) submit versus sweep > the sweep settles a live paid challenge when the panel is closed [2.25ms]
(pass) submit versus sweep > a submission already settled beats a later sweep (opposite ordering) [3.03ms]
(pass) submit versus sweep > enforces the closed-window rule in the STORE, not only in the batch query [0.68ms]
(pass) sweeper startup > executes one pass immediately before the first interval tick [0.70ms]
(pass) orphan threshold > can NEVER be shorter than the configured challenge TTL [0.25ms]
(pass) orphan threshold > does not book a LIVE challenge’s money as an orphan debt [2.31ms]
(pass) orphan threshold > voids an orphan obligation if the challenge path later refunds the same funds [0.66ms]
(pass) obligation writes are atomic with the attribution > records the retained leg in the SAME call that attributes the inbound [1.25ms]
(pass) rotated-destination obligation is atomic with the terminalization > writes the obligation in the SAME call that marks the row skipped [1.25ms]
(pass) rotated-destination obligation is atomic with the terminalization > a crash between the two leaves NOTHING half-done [1.51ms]
(pass) a settled obligation blocks a later double-pay > quarantines the refund instead of paying the same deposit twice [1.09ms]
(pass) a settled obligation blocks a later double-pay > still refunds normally when the obligation is only OPEN [3.04ms]
(pass) one transaction funding two verify destinations > DISCOVERS the retired-address debt end to end, with nothing inserted by hand [2.73ms]
(pass) one transaction funding two verify destinations > discovers it through the SWEEP too, not only through submission [2.19ms]
(pass) one transaction funding two verify destinations > records the retired debt even when the set was read BEFORE the rotation [0.97ms]
(pass) one transaction funding two verify destinations > derives rotated debts from a FRESH read, never a captured set [0.61ms]
(pass) one transaction funding two verify destinations > REFUSES to attribute when the destination set is unavailable (submit) [1.20ms]
(pass) one transaction funding two verify destinations > REFUSES to attribute when the destination set is unavailable (sweep) [2.48ms]
(pass) one transaction funding two verify destinations > ignores legs paid to addresses that are not ours at all [0.73ms]
(pass) one transaction funding two verify destinations > represents them as two INDEPENDENT debts, and voids only the right one [0.72ms]
(pass) T10 secret hygiene > never logs, alerts, or returns the verify wallet secret [2.24ms]
(pass) pollTransferChallenge > refuses another account’s challenge [0.53ms]
(pass) pollTransferChallenge > refuses a malformed id without touching the store [0.26ms]
(pass) pollTransferChallenge > expires only the requested lapsed row on the GET path [0.93ms]
(pass) pollTransferChallenge > settles a memo-less exact transfer via scan discovery and full-fetch verification [2.58ms]
(pass) pollTransferChallenge > skips a poll candidate with null block time and leaves it pending for retry [0.79ms]
(pass) pollTransferChallenge > continues past an earlier null-block-time candidate and verifies the later payment [1.23ms]
(pass) pollTransferChallenge > stops a multi-candidate batch after one destination-set attribution outage [1.04ms]
(pass) pollTransferChallenge > attributes the earliest matching block time first [0.61ms]
(pass) pollTransferChallenge > attributes source_not_signer through the same poll path and refunds it [2.99ms]
(pass) pollTransferChallenge > attributes transfer_not_top_level through the same poll path and refunds it [3.33ms]
(pass) pollTransferChallenge > uses the full fetch when scan facts disagree and refunds a rejected candidate [2.41ms]
(pass) pollTransferChallenge > does no scan or RPC work for a settled row [0.70ms]
(pass) pollTransferChallenge > returns pending without throwing when scan RPC fails [0.63ms]
(pass) pollTransferChallenge > reports the full frozen status shape [0.52ms]
(pass) alert throttling > collapses a repeated condition into one page per window [4.37ms]
(pass) fee accounting > charges our own base fee against the global cap on every refund [0.26ms]

src\services\__tests__\log-redact.test.ts:
(pass) redactBearerTokens > redacts each real bearer shape (oc-/ag-/hat-/ct- + 32 base64url chars), keeping the prefix [1.67ms]
(pass) redactBearerTokens > redacts the SSE + move + legacy-unregister path shapes [0.04ms]
(pass) redactBearerTokens > redacts the ct- connect ticket on the polled connect-status path [0.03ms]
(pass) redactBearerTokens > redacts the sess- magic-link ticket (full Lucia login credential) [0.03ms]
(pass) redactBearerTokens > redacts multiple bearers on one line [0.03ms]
(pass) redactBearerTokens > does NOT redact the oc/ag/hat letters embedded in ordinary words [0.02ms]
(pass) redactBearerTokens > does NOT redact short non-bearer ids (below the 24-char tail floor) [0.01ms]
(pass) redactBearerTokens > is a safe no-op on empty / non-string input [0.01ms]

src\services\__tests__\market-deed-transfer-executor.test.ts:
(pass) GATE — the executor is dark by default > every entrypoint refuses when MARKET_DEED_TRANSFER_ENABLED is not "true" [0.66ms]
(pass) GATE — the executor is dark by default > zod refuses a non-uuid settlement id before any DB touch [0.21ms]
(pass) HAPPY PATH — one-tx claim → verify → flip → stamp → release > flips ownership, transfers structures, stamps the deed, releases the lock [0.84ms]
(pass) HAPPY PATH — one-tx claim → verify → flip → stamp → release > IDEMPOTENT: an already-transferred deed replays as a no-op [0.19ms]
(pass) HAPPY PATH — one-tx claim → verify → flip → stamp → release > DOUBLE-CLAIM: a row locked by a concurrent worker is skipped, nothing mutates [0.13ms]
[market-deed-transfer] SELLER NO LONGER OWNS PARCEL — settlement=22222222-2222-4222-8222-222222222222 parcel=parcel-1 owner=someone-else seller=seller-1; terminal conflict; deed lock stays HELD; payout will never run (deed precondition)
(pass) CONFLICTS — never force a flip > seller no longer owns the parcel → TERMINAL conflict; lock stays HELD [0.23ms]
[market-deed-transfer] PARCEL MISSING — settlement=22222222-2222-4222-8222-222222222222 parcel=parcel-1; terminal conflict (buyer refund = ops, checkout trail on checkout=chk-1)
(pass) CONFLICTS — never force a flip > parcel missing → TERMINAL conflict (parcel_missing) [0.11ms]
[market-deed-transfer] LIVE ESCROW ON DEED PARCEL — settlement=22222222-2222-4222-8222-222222222222 parcel=parcel-1 deposit_remaining_ct=500 tenure=deposit; refusing the flip (escrow conservation); terminal conflict
(pass) CONFLICTS — never force a flip > ESCROW GUARD: a live deposit escrow refuses the flip (conservation) [0.15ms]
(pass) CONFLICTS — never force a flip > non-deed kinds are refused (the executor never touches them) [0.15ms]
(pass) CRASH/RESUME — one tx, rollback, re-run completes > a mid-tx failure rolls EVERYTHING back; the re-run succeeds [0.29ms]
[market-deed-transfer] transfer failed (rolled back, resumable) — settlement=22222222-2222-4222-8222-222222222222: boom: flip died mid-tx
(pass) CRASH/RESUME — one tx, rollback, re-run completes > runDeedTransferTick survives a per-settlement tx failure (logged, resumable) [0.27ms]

src\services\__tests__\market-listing-expiry-sweeper.test.ts:
(pass) resolveExpirySweepPeriodMs > defaults to 1h when unset [0.12ms]
(pass) resolveExpirySweepPeriodMs > floors a too-small value back to default [0.05ms]
(pass) resolveExpirySweepPeriodMs > honors a valid override [0.04ms]
(pass) processExpiredListing > expires an active+expired land_deed and releases the deed lock, in fulfiller lock order [0.63ms]
(pass) processExpiredListing > no-ops when the listing is gone [0.08ms]
(pass) processExpiredListing > no-ops (never touches) a settled listing — the deed executor owns that lock [0.08ms]
(pass) processExpiredListing > no-ops a pending_settlement listing [0.06ms]
(pass) processExpiredListing > no-ops a still-live (not-yet-expired) active listing [0.07ms]
(pass) processExpiredListing > no-ops an active listing with NULL expires_at (never expires) [0.06ms]
(pass) processExpiredListing > no-ops when a concurrent cancel/settle wins the flip (0-row UPDATE) [0.11ms]
(pass) processExpiredListing > skips the advisory + parcel locks for a non-deed kind [0.13ms]
(pass) sweepExpiredListings > no-ops on an empty candidate set [0.24ms]
[MarketExpirySweeper] listing c failed (non-fatal): warn: boom on c
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\market-listing-expiry-sweeper.test.ts:203:11)

[MarketExpirySweeper] expired 1 listing(s), released 1 deed lock(s), 1 no-op(s) this pass
(pass) sweepExpiredListings > aggregates across candidates and isolates a per-listing failure [0.30ms]

src\services\__tests__\market-payout-executor.test.ts:
(pass) GATES — the executor is dark by default > every entrypoint refuses when MARKET_PAYOUT_EXECUTE is not "true" [1.55ms]
(pass) GATES — the executor is dark by default > NETWORK GUARD: devnet/mock can never reach a real CLV send [0.16ms]
[market-payout] MARKET_RAKE_TREASURY_PUBKEY is not a valid base58 pubkey
(pass) GATES — the executor is dark by default > rake treasury pin: unset env resolves null (fail closed) [0.14ms]
(pass) ORDERING — deed first; claim before custody; capture before send > DEED PRECONDITION: an untransferred deed refuses with NO claim taken [0.22ms]
(pass) ORDERING — deed first; claim before custody; capture before send > HAPPY PATH (agent seller): claim → resolve → custody → capture → send ×2 → paid [5.88ms]
(pass) ORDERING — deed first; claim before custody; capture before send > replay: a paid settlement replays idempotently (no claim, no sends) [4.32ms]
(pass) ORDERING — deed first; claim before custody; capture before send > DOUBLE-CLAIM: a row already in "sending" refuses (payout_in_flight) [0.12ms]
(pass) E5 PARITY — the destination branch must exist; guests never paid > HUMAN seller: stamped pubkey re-validated against the CURRENT linked wallet [4.63ms]
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=human_linked_wallet_mismatch (relinked); → reconcile (operator resolution)
(pass) E5 PARITY — the destination branch must exist; guests never paid > HUMAN mismatch (re-linked wallet): TERMINAL reconcile, zero custody/sends [0.38ms]
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=agent_custodial_wallet_missing; → reconcile (operator resolution)
(pass) E5 PARITY — the destination branch must exist; guests never paid > AGENT with no custodial wallet: TERMINAL (destination missing) [0.15ms]
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=guest_seller_refused; → reconcile (operator resolution)
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=guest_seller_refused; → reconcile (operator resolution)
(pass) E5 PARITY — the destination branch must exist; guests never paid > GUEST seller is ALWAYS refused — terminal, loud, zero sends [0.22ms]
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=seller_subject_unresolvable; → reconcile (operator resolution)
(pass) E5 PARITY — the destination branch must exist; guests never paid > unresolvable seller subject kind: TERMINAL (never guess the branch) [0.12ms]
(pass) CONSERVATION — never pay CLV that was not bought > exact-integer floor math (house-favorable) [0.07ms]
[market-payout] CONSERVATION VIOLATED — settlement=33333333-3333-4333-8333-333333333333 seller=68257142857 + rake=3171428571 > bought=1000 (rate=0.000070000000); REFUSING — never pay CLV that wasn't bought
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=conservation_violated; → reconcile (operator resolution)
(pass) CONSERVATION — never pay CLV that was not bought > seller+rake exceeding the recorded fills: TERMINAL, zero custody, zero sends [0.14ms]
(pass) CONSERVATION — never pay CLV that was not bought > C3 buy not executed yet: claim RELEASED for a clean later retry [0.17ms]
[market-payout] TERMINAL REFUSAL — settlement=33333333-3333-4333-8333-333333333333 reason=no_recorded_fills; → reconcile (operator resolution)
(pass) CONSERVATION — never pay CLV that was not bought > no recorded fills: TERMINAL (the buy cannot prove what it bought) [0.18ms]
(pass) CONSERVATION — never pay CLV that was not bought > ZERO rake (rake_bps 0): one send only, rakeTxSignature null, paid [2.75ms]
(pass) CONSERVATION — never pay CLV that was not bought > insufficient swap-wallet CLV: claim released PRE-capture (retry once funded) [0.19ms]
(pass) CONSERVATION — never pay CLV that was not bought > rake treasury unpinned: claim released BEFORE custody (fail closed) [0.17ms]
[market-payout] AMBIGUOUS SELLER SEND — settlement=33333333-3333-4333-8333-333333333333 tx=pidGA4PxA3dz4oPNYh4kP2Bn4Xo4EbTpSvsnfjLGcVbN4QZvFTfrp2ra5RzAdhF9jni5MWyk5PwprUNkb1FrCz7; money-state UNKNOWN → reconcile (no re-send): boom: transport died mid-send
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > AMBIGUOUS seller send: signature captured, TERMINAL reconcile, retry refused [2.42ms]
[market-payout] SELLER TX FAILED ON-CHAIN — settlement=33333333-3333-4333-8333-333333333333 tx=pidGA4PxA3dz4oPNYh4kP2Bn4Xo4EbTpSvsnfjLGcVbN4QZvFTfrp2ra5RzAdhF9jni5MWyk5PwprUNkb1FrCz7; no CLV moved; → reconcile (manual re-run decision)
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > DEFINITIVE seller on-chain failure: reconcile (no CLV moved), never auto-retried [2.21ms]
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > capture lost (claim stolen): abort WITHOUT sending [1.23ms]
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > RESTART-AFTER-SEND-BEFORE-MARK: seller sig confirmed on chain → RESUME runs ONLY the rake leg (no re-send) [2.84ms]
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > resume with BOTH signatures confirmed: mark paid with ZERO sends [0.20ms]
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > resume with a captured sig NOT provable on chain: TERMINAL reconcile, no re-send [0.19ms]
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > resume with NOTHING captured: nothing was sent → clean release for re-claim [0.14ms]
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > resume never steals a LIVE claim (fresh payout_claimed_at → in_flight) [0.12ms]
[market-payout] resume chain-check errored (transient) — settlement=33333333-3333-4333-8333-333333333333: boom: rpc status check died; row stays 'sending' for a later resume
(pass) EXACTLY-ONCE — ambiguous never retried; resume never re-sends > resume chain-check transport error: transient — row stays "sending" for later [0.28ms]
(pass) runMarketPayoutTick — resume stale, then execute fresh > a fresh eligible settlement executes end-to-end in one tick [4.44ms]
(pass) runMarketPayoutTick — resume stale, then execute fresh > deed-untransferred settlements are NOT eligible (structurally unpayable) [0.17ms]

src\services\__tests__\market.test.ts:
(pass) marketplace_purchase — registration + rake split > fulfiller self-registered under marketplace_purchase via side-effect import [0.28ms]
(pass) marketplace_purchase — registration + rake split > rake split is EXACT µUSD conservation at every amount (444 + 9556 = 10000 bps) [0.80ms]
(pass) marketplace_purchase — registration + rake split > rake split rejects non-positive/fractional cents (0) [0.33ms]
(pass) marketplace_purchase — registration + rake split > rake split rejects non-positive/fractional cents (-5) [0.05ms]
(pass) marketplace_purchase — registration + rake split > rake split rejects non-positive/fractional cents (2.5) [0.03ms]
(pass) checkSellerLicense — CLV Resident license > human BELOW threshold refuses seller_license_required (reports both numbers) [0.83ms]
(pass) checkSellerLicense — CLV Resident license > human EXACTLY AT the 50,000 threshold passes; wallet pubkey returned for payout stamping [0.19ms]
(pass) checkSellerLicense — CLV Resident license > FAIL-SOFT ⇒ REFUSE: available:false refuses clv_balance_unavailable (never fail-open) [0.19ms]
(pass) checkSellerLicense — CLV Resident license > human with no linked wallet refuses wallet_not_linked [0.19ms]
(pass) checkSellerLicense — CLV Resident license > AGENT reads its custodial avatars.wallet_address (E5 split), passes at threshold [0.47ms]
(pass) checkSellerLicense — CLV Resident license > agent with no custodial wallet refuses wallet_not_linked; agent fail-soft refuses too [0.26ms]
(pass) checkSellerLicense — CLV Resident license > MARKET_SELLER_MIN_CLV retunes the threshold; invalid/non-positive env falls back to 50,000 [0.35ms]
(pass) createMarketListing — (create) → active + deed lock > earned_bundle refuses earned_not_available with ZERO DB touches (trap 6) [0.42ms]
(pass) createMarketListing — (create) → active + deed lock > happy path: land lock order (advisory → parcel FOR UPDATE) then listing + deed lock in ONE tx [1.55ms]
(pass) createMarketListing — (create) → active + deed lock > non-owner refuses not_parcel_owner (no INSERT ever runs) [0.47ms]
(pass) createMarketListing — (create) → active + deed lock > non-deed-able tenure "rented" refuses not_transferable_tenure [0.32ms]
(pass) createMarketListing — (create) → active + deed lock > non-deed-able tenure "deposit" refuses not_transferable_tenure [0.08ms]
(pass) createMarketListing — (create) → active + deed lock > non-deed-able tenure "starter" refuses not_transferable_tenure [0.06ms]
(pass) createMarketListing — (create) → active + deed lock > non-deed-able tenure null refuses not_transferable_tenure [0.05ms]
(pass) createMarketListing — (create) → active + deed lock > tenure 'hold' refuses hold_transfer_not_supported — the CLV-hold obligation can't transfer yet [0.23ms]
(pass) createMarketListing — (create) → active + deed lock > tenure 'owned' still lists (the only deed-able tenure) [0.23ms]
(pass) createMarketListing — (create) → active + deed lock > missing parcel refuses parcel_not_found [0.24ms]
(pass) createMarketListing — (create) → active + deed lock > deed-lock conflict (parcel already locked) aborts the WHOLE tx → parcel_already_listed [0.22ms]
(pass) createMarketListing — (create) → active + deed lock > live-item partial-UNIQUE 23505 on the listing INSERT maps to parcel_already_listed [0.32ms]
(pass) cancelMarketListing — active → cancelled + lock release > happy cancel: listing FOR UPDATE → status cancelled + escrow_state NULL + DELETE lock row [0.83ms]
(pass) cancelMarketListing — active → cancelled + lock release > someone else cannot cancel your listing (not_your_listing) [0.14ms]
(pass) cancelMarketListing — active → cancelled + lock release > cancel from "settled" refuses listing_not_cancellable (only active cancels) [0.11ms]
(pass) cancelMarketListing — active → cancelled + lock release > cancel from "cancelled" refuses listing_not_cancellable (only active cancels) [0.04ms]
(pass) cancelMarketListing — active → cancelled + lock release > cancel from "pending_settlement" refuses listing_not_cancellable (only active cancels) [0.03ms]
(pass) cancelMarketListing — active → cancelled + lock release > unknown listing refuses listing_not_found [0.08ms]
(pass) marketplace_purchase — FLAG GATE (default OFF) > fulfiller refuses CheckoutFulfillmentRefusal('marketplace_settle_disabled') BEFORE any DB touch [0.52ms]
(pass) marketplace_purchase — FLAG GATE (default OFF) > quote resolver refuses the same code with ZERO DB reads — no 402 is issuable while gated [0.18ms]
(pass) marketplace_purchase — FLAG GATE (default OFF) > only the literal string true enables — "false" stays disabled [0.13ms]
(pass) marketplace_purchase — FLAG GATE (default OFF) > only the literal string true enables — "TRUE" stays disabled [0.04ms]
(pass) marketplace_purchase — FLAG GATE (default OFF) > only the literal string true enables — "1" stays disabled [0.03ms]
(pass) marketplace_purchase — FLAG GATE (default OFF) > only the literal string true enables — "yes" stays disabled [0.03ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > quote resolver prices from the LISTING row server-side; refuses expired/own/inactive [0.39ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > happy settle: intents recorded, FULL USDC enqueued same-tx, ZERO internal vCLAW, payout QUEUED pending_review [0.63ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > REPLAY DOES NOT DOUBLE-PAY: an existing settlement for the checkoutId is a no-op (trap 3) [0.18ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > seller lost the parcel under the lock ⇒ refusal, tx rolls back, nothing enqueued [0.15ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > missing deed lock under a live listing ⇒ deed_lock_missing refusal [0.13ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > self-buy + price drift refuse under the lock (own_listing / price_mismatch) [0.15ms]
(pass) marketplace_purchase — settlement intent (flag ON in-test only) > cancelled/expired listing refuses at fulfillment (listing_not_active / listing_expired) [0.14ms]

src\services\__tests__\material-ledger.test.ts:
(skip) material-ledger (real DB) > (unnamed)
(skip) material-ledger (real DB) > reads zero for an avatar that has never earned a material
(skip) material-ledger (real DB) > credits lazily create the balance row and accumulate
(skip) material-ledger (real DB) > debits decrement the pooled balance
(skip) material-ledger (real DB) > a spend at balance + 1 refuses and writes NOTHING
(skip) material-ledger (real DB) > a spend of the ENTIRE balance succeeds and lands exactly on zero
(skip) material-ledger (real DB) > a composed debit rolls back with the caller transaction
(skip) material-ledger (real DB) > concurrent credits conserve the total (no lost update)
(skip) material-ledger (real DB) > concurrent oversubscribed debits admit exactly the affordable count and never go negative
(skip) material-ledger (real DB) > rejects a credit for an avatar that does not exist
(skip) material-ledger (real DB) > rejects non-positive and non-integer amounts on both primitives
(skip) material-ledger (real DB) > (unnamed)

src\services\__tests__\message-memory-sweeper.test.ts:
(pass) message-memory retention parsing > defaults to 7 days when the env var is unset or invalid [0.18ms]
(pass) message-memory retention parsing > clamps positive values below the 1-day floor to 1 [0.02ms]
[MessageMemorySweeper] pruned 0 message rows older than 7d in 1ms (1 batches)
(pass) message-memory sweep > deletes only type='messages' rows and binds the retention days [0.54ms]
(pass) message-memory sweep > disables all execution when retention is 0 and logs boot once [0.15ms]
[MessageMemorySweeper] pruned 2003 message rows older than 7d in 0ms (3 batches)
(pass) message-memory sweep > continues batch deletes until a batch reports 0 rows [0.14ms]
[MessageMemorySweeper] pruned 100000 message rows older than 7d in 0ms (50 batches)
(pass) message-memory sweep > stops and warns at the 50-batch runaway cap [0.41ms]
(pass) message-memory sweep > catches executor failures without rejecting the sweep [0.23ms]

src\services\__tests__\moderation-service.test.ts:
[moderation] BLOCKED {
  surface: "test",
  direction: "input",
  backend: "fake",
  categories: [ "hate", "violence" ],
  hash: "87e3d364d41b",
  latencyMs: 0,
}
(pass) moderateText — verdict handling > BLOCKS on a flagged verdict and surfaces categories [0.51ms]
(pass) moderateText — verdict handling > ALLOWS on a clean verdict [0.11ms]
[moderation] backend error — failing OPEN {
  surface: "test",
  direction: "input",
  backend: "boom",
  failOpen: 1,
  errorClass: "Error",
}
(pass) moderateText — fail-open > FAILS OPEN when the backend throws (availability > coverage) [0.16ms]
[moderation] no backend for MODERATION_BACKEND='granite-does-not-exist-yet' — failing OPEN {
  failOpen: 2,
  surface: "test",
  direction: "input",
}
(pass) moderateText — fail-open > FAILS OPEN when MODERATION_BACKEND names an unregistered backend [0.11ms]
(pass) moderateText — kill switch + short-circuits > ALLOWS without calling the backend when MODERATION_ENABLED=false [0.09ms]
(pass) moderateText — kill switch + short-circuits > ALLOWS empty/whitespace text without a backend round-trip [0.07ms]
[moderation] BLOCKED {
  surface: "test",
  direction: "input",
  backend: "openai",
  categories: [ "harassment" ],
  hash: "3f018d3ce934",
  latencyMs: 0,
}
(pass) OpenAI backend — real transport shape (global fetch mocked) > maps a flagged OpenAI moderations response to a block [0.42ms]
[moderation] backend error — failing OPEN {
  surface: "test",
  direction: "input",
  backend: "openai",
  failOpen: 3,
  errorClass: "Error",
}
(pass) OpenAI backend — real transport shape (global fetch mocked) > FAILS OPEN on a non-2xx OpenAI response [0.23ms]
[moderation] backend error — failing OPEN {
  surface: "test",
  direction: "input",
  backend: "openai",
  failOpen: 4,
  errorClass: "Error",
}
(pass) OpenAI backend — real transport shape (global fetch mocked) > FAILS OPEN (never blocks) when OPENAI_API_KEY is missing [0.19ms]

src\services\__tests__\npc-ambient-pathfind-budget.test.ts:
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P1: the chokepoint distinguishes ok, budget-exhausted, and no-path [0.79ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P2: a deferral does not change the route returned after the budget resets [0.30ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P3: one pass spends one search and denied bodies retry next pass [0.48ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P4: a spent pass performs no second snap [0.20ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P5: every fully eligible pass searches exactly the expected round-robin body [2.21ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P6: executor and driver reroutes remain outside the ambient budget [8.50ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P7: a random planner reaches a second candidate next pass without a false cooldown [0.55ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P8: planApproachNpc searches random points on the stand-off circle [1.96ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P9a: forcing the wander family performs exactly one real fallback search [0.32ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P9b: forcing the approach family still approaches the nearby target with one search [0.19ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P9c: a real approach miss consumes one search and retries without a futile nested fallback [0.13ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P10: moveNpcs still performs zero A* [0.27ms]
[NPC Simulation] Stopped
(pass) ambient pathfinding budget > P11: the exported budget remains one search per pass [0.05ms]

src\services\__tests__\npc-conversation-directed-release.test.ts:
[NPC Simulation] Stopped
[Covenant] no avatar attribution for in-world agent body chibi-eliza; actions continue without records
(pass) conversation release preserves directed routes > C0: enter_cove plus emote resumes the same route, clears the timer, and arrives [3.03ms]
[NPC Simulation] Stopped
(pass) conversation release preserves directed routes > C1: a lone directed enter keeps route identity and presentation fields [0.13ms]
[NPC Simulation] Stopped
(pass) conversation release preserves directed routes > C2: an ambient participant keeps the historical reset payload [0.10ms]
[NPC Simulation] Stopped
(pass) conversation release preserves directed routes > C3: the released body walks without any tick-time A* [0.14ms]
[NPC Simulation] Stopped
(pass) conversation release preserves directed routes > C4: a missing second participant is a no-op [0.12ms]

src\services\__tests__\npc-directed-route.test.ts:
[NPC Simulation] Stopped
(pass) directed NPC routes > T1: moveNpcs adds zero A* calls for a multi-body tick [0.40ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T2: exports the exact 44 wu x 5 Hz speed mirror [0.05ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T3: moves exactly 44 wu on a long straight free segment [0.12ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T4: a directed graze wall-slides without abandoning [0.32ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T5: an ambient graze keeps the original abandon behavior [0.20ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T6: a directed wall-slide makes progress without losing route ownership [0.86ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T7: stuckTicks >= 4 does not abandon a directed route [0.21ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T8: stuckTicks >= 4 still abandons an ambient route [0.18ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T9: a server-managed directed route survives expiry and ambient planning [0.14ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T10: directed bodies are excluded from ambient conversation selection [0.13ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T11: ordinary ambient bodies remain selectable and replannable [0.17ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T12: reports exact remaining polyline length [0.11ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T13: re-routes teaching, cove, and portal destinations exactly once each [4.70ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T14: invalid destinations and unknown bodies fail before A* [0.15ms]
[NPC Simulation] Stopped
(pass) directed NPC routes > T15: clearing a destination de-directs the existing path array [0.25ms]

src\services\__tests__\npc-gateway-enter-freeze.test.ts:
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G1: enter_cove moves on the FIRST focused movement step [3.32ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G2: enter_poker_room moves on the FIRST focused movement step [1.10ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G3: enter_kelp_forest moves on the FIRST focused movement step [0.29ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G4: setNpcPath clears a stale clock for gateway and move routes [0.70ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G5: gateway arrival lifecycle parks, excludes, and explicitly releases in one lifecycle [0.72ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G6: enter_kelp_forest arrival parks too [0.34ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G7a: enter_building arrival is NOT stranded [25.75ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G7b: REST /move?buildingId sim-call mirror arrival is NOT stranded [0.15ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G7c: ambient arrival preserves release byte-identity [0.24ms]
[NPC Simulation] Stopped
(pass) OQ-1 gateway enter freeze > G8: emote still intentionally holds the pose across focused movement steps [0.11ms]

src\services\__tests__\npc-overlap-deadlock.test.ts:
(pass) resolveNpcNpcOverlaps — deadlock-yield > lex-lower NPC yields after 3 consecutive overlap ticks [2.15ms]
(pass) resolveNpcNpcOverlaps — deadlock-yield > non-overlapping pair never yields, overlapTicks stays at 0 [0.16ms]
(pass) resolveNpcNpcOverlaps — deadlock-yield > overlap that resolves before threshold does not yield [0.12ms]
(pass) resolveNpcNpcOverlaps — deadlock-yield > does not yield NPCs that are in conversation [0.10ms]
(pass) resolveNpcNpcOverlaps — deadlock-yield > asymmetric yield: hi-id NPC is never the yielder [0.18ms]

src\services\__tests__\npc-overlap-directed-recover.test.ts:
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > O0: a non-chibi head-on wedge is real and survives the old 3-tick threshold [0.50ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > O1: a directed route survives a transient overlap and completes [0.31ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > O2: both members of a persistent directed head-on wedge abandon on tick 10 [0.32ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > O3: a wall-pinned directed lex-higher body recovers beside a pathless lower [0.28ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > O4: a wall-pinned nonzero three-body pile remains recorded through tick 9, then all abandon [0.51ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > MF1-i: exact-coincident active directed bodies pinned at a wall abandon by tick 10 [0.28ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > MF1-ii: an exact-overlapped parked empty directed route is byte-stable beyond the grace [0.26ms]
[NPC Simulation] Stopped
(pass) directed overlap grace and bounded recovery > MF1-iii: an exact-coincident all-ambient pair remains the historical no-op [0.14ms]

src\services\__tests__\npc-watcher-gate.test.ts:
(pass) ambient-banter watcher gate > is unwatched once the grace window has passed [0.12ms]
(pass) ambient-banter watcher gate > a visibility heartbeat arms the gate for the grace window only [0.05ms]
(pass) ambient-banter watcher gate > SSE listeners do NOT arm the gate (hidden tabs hold streams open) [0.11ms]
(pass) ambient-banter hourly LLM budget > caps consumption within a window and rolls over hourly [0.14ms]
(pass) ambient-banter hourly LLM budget > cap of 0 disables LLM banter entirely [0.06ms]
(pass) ambient-banter hourly LLM budget > unset cap applies the 120 default (not 0) [0.33ms]
(pass) ambient-banter hourly LLM budget > blank and whitespace-only caps apply the default [0.09ms]
(pass) ambient-banter hourly LLM budget > invalid and negative caps apply the default [0.09ms]
(pass) ambient-banter hourly LLM budget > explicit positive cap is honored [0.08ms]
(pass) gated agent conversations keep partner cognition alive (Codex round 2 HIGH #2) > refused paid legs still run client.chat + action dispatch; npc legs are canned [0.78ms]
[InferenceRouter] attempt failed route=default by=openai 1ms: [InferenceRouter:openai] missing OPENAI_API_KEY
[NPC Convo] inference failed: [InferenceRouter:openai] missing OPENAI_API_KEY
[InferenceRouter] attempt failed route=default by=openai 0ms: [InferenceRouter:openai] missing OPENAI_API_KEY
[NPC Convo] inference failed: [InferenceRouter:openai] missing OPENAI_API_KEY
[InferenceRouter] attempt failed route=default by=openai 0ms: [InferenceRouter:openai] missing OPENAI_API_KEY
[NPC Convo] inference failed: [InferenceRouter:openai] missing OPENAI_API_KEY
[InferenceRouter] attempt failed route=default by=openai 0ms: [InferenceRouter:openai] missing OPENAI_API_KEY
[NPC Convo] inference failed: [InferenceRouter:openai] missing OPENAI_API_KEY
[InferenceRouter] attempt failed route=default by=openai 0ms: [InferenceRouter:openai] missing OPENAI_API_KEY
[NPC Convo] inference failed: [InferenceRouter:openai] missing OPENAI_API_KEY
(pass) gated agent conversations keep partner cognition alive (Codex round 2 HIGH #2) > a single budget unit never funds two paid legs in one conversation [2.60ms]

src\services\__tests__\openclaw-body-ownership.test.ts:
[OpenClaw] Avatar injected: "OwnershipBot" (oc-sess:a57145b65e1c1cf5) [server-managed]
[OpenClaw] Avatar injected: "OwnershipBot" (oc-sess:0e7bbd53b28bf9c2) [server-managed]
[OpenClaw] Unregistered: sess:a57145b65e1c1cf5
[OpenClaw] Unregistered: sess:0e7bbd53b28bf9c2
(pass) unregisterAgentBot is ownership-scoped for the shared ocb- body > a STALE session does NOT tear down the shared body a newer session owns (M1 race) [2.39ms]
[OpenClaw] Avatar injected: "OwnershipBot" (oc-sess:a57145b65e1c1cf5) [server-managed]
[OpenClaw] Unregistered: sess:a57145b65e1c1cf5
(pass) unregisterAgentBot is ownership-scoped for the shared ocb- body > the SOLE owner still tears the body down (no regression) [0.10ms]
[OpenClaw] Avatar injected: "OwnershipBot" (oc-sess:a57145b65e1c1cf5) [server-managed]
[OpenClaw] Avatar injected: "OwnershipBot" (oc-sess:0e7bbd53b28bf9c2) [server-managed]
[OpenClaw] Unregistered: sess:a57145b65e1c1cf5
[OpenClaw] Unregistered: sess:0e7bbd53b28bf9c2
(pass) unregisterAgentBot is ownership-scoped for the shared ocb- body > mirrors the sweeper: a session registered AFTER the snapshot is NOT swept, a genuinely-expired one IS [0.22ms]

src\services\__tests__\provable-rng.test.ts:
(pass) createServerSeed > produces a 64-char lowercase hex seed and matching sha256 commit [0.09ms]
(pass) createServerSeed > produces distinct seeds across calls [0.03ms]
(pass) sha256Hex > matches the well-known sha256 of the empty string [0.02ms]
(pass) sha256Hex > hashes the UTF-8 representation of the hex seed, not the decoded bytes [0.02ms]
(pass) deriveBytes — hand-computed vectors > TV1: zero seed, clientSeed="a", nonce=0, cursor=0, byteCount=8 [0.06ms]
(pass) deriveBytes — hand-computed vectors > TV2: zero seed, clientSeed="deadbeef", nonce=42, cursor=0, byteCount=32 [0.04ms]
(pass) deriveBytes — hand-computed vectors > TV3: crosses block boundary at cursor=0, byteCount=33 (needs blocks 0 + 1) [0.08ms]
(pass) deriveBytes — hand-computed vectors > TV4: cursor mid-block (10), byteCount=32 — spans blocks 0 + 1 [0.05ms]
(pass) deriveBytes — hand-computed vectors > TV5: non-zero seed, mixed-case clientSeed="CafeBabe" lowercased, 96 bytes [0.05ms]
(pass) deriveBytes — hand-computed vectors > TV6: uppercase serverSeed produces identical output to the lowercase equivalent [0.04ms]
(pass) deriveBytes — input validation > rejects negative nonce [0.10ms]
(pass) deriveBytes — input validation > rejects non-integer nonce [0.06ms]
(pass) deriveBytes — input validation > rejects negative cursor [0.08ms]
(pass) deriveBytes — input validation > rejects zero byteCount [0.06ms]
(pass) deriveBytes — input validation > rejects negative byteCount [0.04ms]
(pass) deriveBytes — input validation > rejects serverSeed of wrong length [0.07ms]
(pass) deriveBytes — input validation > rejects serverSeed with non-hex chars [0.07ms]
(pass) deriveBytes — input validation > rejects empty clientSeed [0.05ms]
(pass) deriveBytes — input validation > rejects non-hex clientSeed [0.04ms]
(pass) deriveBytes — input validation > rejects clientSeed exceeding CLIENT_SEED_MAX_LENGTH [0.09ms]
(pass) deriveBytes — input validation > rejects byteCount exceeding MAX_BYTE_COUNT [0.05ms]
(pass) deriveBytes — input validation > rejects cursor + byteCount overflow [0.05ms]
(pass) deriveBytes — input validation > rejects nonce exceeding MAX_SAFE_INTEGER [0.07ms]
(pass) sampleIntFromBytes — hand-computed vectors > TV-S1: range=100 → 431317760 % 100 = 60, bytesConsumed=4 [0.06ms]
(pass) sampleIntFromBytes — hand-computed vectors > TV-S2: range=100 with min offset → (431317760 % 100) + 10 = 70 [0.04ms]
(pass) sampleIntFromBytes — hand-computed vectors > TV-S3: range=256 (power of 2) → low byte = 0, threshold = 2^32 → never reject [0.04ms]
(pass) sampleIntFromBytes — hand-computed vectors > TV-S4: range=2^32 (full uint32) → identity, value=u32 itself [0.06ms]
(pass) sampleIntFromBytes — hand-computed vectors > TV-S5: range=1 → only value is min, threshold = 2^32, no rejection [0.07ms]
(pass) sampleIntFromBytes — hand-computed vectors > determinism: same inputs always give the same output [0.05ms]
(pass) sampleIntFromBytes — input validation > rejects max <= min [0.12ms]
(pass) sampleIntFromBytes — input validation > rejects range > 2^32 [0.04ms]
(pass) sampleIntFromBytes — input validation > rejects non-integer min/max [0.07ms]
(pass) sampleIntFromBytes — input validation > rejects negative nonce [0.05ms]
(pass) sampleIntFromBytes — input validation > rejects negative cursorStart [0.06ms]
(pass) commit-reveal end-to-end > client can re-derive bytes from a revealed server seed [0.07ms]

src\services\__tests__\quest-house-exclusion.test.ts:
(pass) quest faucet excludes the house fleet (structural) > resolves quest actors through the QUEST resolver, never the cove one [0.09ms]
(pass) quest faucet excludes the house fleet (structural) > routes the quest resolver to the connected-session path plus a house refusal [0.05ms]
(pass) REST faucet path carries the same house barrier (structural) > refuses a house agent on the REST tutorial claim, before settlement [0.05ms]
(skip) quest faucet excludes the house fleet (real DB) > identifies the live house fleet and refuses every one of them
(skip) quest faucet excludes the house fleet (real DB) > still refuses a house agentId presented with a plausible session id
(skip) quest faucet excludes the house fleet (real DB) > does not treat an ordinary (non-house) agentId as house

src\services\__tests__\reconcile-checkouts.test.ts:
(pass) reconcile classifier > capture_lost + signature ⇒ verify_signature / capture_fulfill (money is ours) [1.83ms]
(pass) reconcile classifier > signature_conflict + signature ⇒ verify_signature / refund_required (contested) [0.05ms]
(pass) reconcile classifier > settle_ambiguous ⇒ probe_merchant with the ¢-peg atomic amount + payer + window [0.06ms]
(pass) reconcile classifier > stale_settling ⇒ probe_merchant; falls back to createdAt when no settlingStartedAt [0.05ms]
(pass) reconcile classifier > a signature-carrying reason WITHOUT a signature ⇒ manual_review [0.10ms]
(pass) reconcile classifier > an unrecognized reason ⇒ manual_review [0.04ms]
(pass) reconcile apply gate > assertNoReconcileApply is a no-op while unset/false [0.09ms]
(pass) reconcile apply gate > assertNoReconcileApply no longer rejects env enablement; explicit caller consent is separate [0.04ms]

src\services\__tests__\redenomination-math.test.ts:
(pass) A3 ¢-peg redenomination math > ×10 preserves the F1 sum invariant (claw = soft + bought + earned) [0.14ms]
(pass) A3 ¢-peg redenomination math > ×10 preserves USD purchasing power (old × $0.10 === new × $0.01) [0.05ms]
(pass) A3 ¢-peg redenomination math > usdToCt uses the new ¢-peg rate (CT_PER_USDC=100) [0.05ms]
(pass) A3 ¢-peg redenomination math > the signup bonus is worth $5 before AND after (50 @ $0.10 === 500 @ $0.01) [0.02ms]
(pass) A3 ¢-peg redenomination math > a top-up buys the same USD value of coins at the new rate (×10 units) [0.02ms]

src\services\__tests__\reserved-agent-namespaces.test.ts:
(pass) isReservedPartnerAgentId > rejects a `hatcher:`-prefixed id (exact partner namespace) [0.04ms]
(pass) isReservedPartnerAgentId > allows ordinary public ids (no reserved prefix) [0.03ms]
(pass) isReservedPartnerAgentId > allows the milady namespace (server-generated, NOT reserved for a signed partner) [0.03ms]
(pass) isReservedPartnerAgentId > is case-sensitive — only the exact lower-case partner literal is reserved [0.03ms]
(pass) isReservedPartnerAgentId > does not match an id that merely CONTAINS the prefix mid-string [0.02ms]
(pass) isReservedPartnerAgentId > covers every entry in RESERVED_PARTNER_AGENT_PREFIXES [0.04ms]
(pass) isReservedPartnerIdentityType > flags the `hatcher` identity type (the existing-row mutation guard key) [0.03ms]
(pass) isReservedPartnerIdentityType > allows non-partner identity types [0.04ms]
(pass) isReservedPartnerIdentityType > treats null/undefined as not reserved (fail-open is correct here — the agentId-prefix guard is the primary gate; this is defense in depth for a typed row) [0.02ms]
(pass) isReservedPartnerIdentityType > covers every entry in RESERVED_PARTNER_IDENTITY_TYPES [0.02ms]

src\services\__tests__\room-registry.test.ts:
(pass) RoomRegistry — NPC swap > removes a species-matching NPC when one exists [0.75ms]
(pass) RoomRegistry — NPC swap > falls back to lex-first NPC when no species match [0.13ms]
(pass) RoomRegistry — NPC swap > returns null when room.npcs is already exhausted [0.39ms]
(pass) RoomRegistry — NPC swap > a rejoining session does NOT re-swap (idempotent) [0.15ms]
(pass) RoomRegistry — overflow + invite codes > 21st invite join is rejected at the hard cap and spills to a fresh room [0.61ms]
(pass) RoomRegistry — overflow + invite codes > honors an invite code when the room exists and has capacity [0.16ms]
(pass) RoomRegistry — overflow + invite codes > mints the requested code when the room doesn't exist yet (auth'd only — see B2) [0.07ms]
(pass) RoomRegistry — overflow + invite codes > falls back to auto-fill when the requested room is full [0.34ms]
(pass) RoomRegistry — soft-cap flexible fill > auto-fill packs into the FULLEST room still under the soft cap [0.20ms]
(pass) RoomRegistry — soft-cap flexible fill > tie-breaks on lowest id when two rooms are equally full [0.21ms]
(pass) RoomRegistry — soft-cap flexible fill > the 13th auto-join mints a fresh room (soft boundary) [0.26ms]
(pass) RoomRegistry — soft-cap flexible fill > auto-fill never seeds a room already in the 12-to-20 headroom band [0.30ms]
(pass) RoomRegistry — soft-cap flexible fill > an invite code STILL fills the 12-to-20 headroom band (friend group join) [0.23ms]
(pass) RoomRegistry — soft-cap flexible fill > an invite code into a room AT the hard cap (20) is rejected and spills [0.30ms]
(pass) RoomRegistry — soft-cap flexible fill > distribution: 29 sequential auto-joins settle into 12 / 12 / 5 [0.36ms]
(pass) RoomRegistry — rejoin cancels pending restore (B1 punch list) > a fast rejoin within the grace window restores the original NPC and does NOT permanently lose a slot [0.43ms]
(pass) RoomRegistry — rejoin cancels pending restore (B1 punch list) > regression: three rage-rejoin cycles leak ZERO NPC slots (without B1 fix each cycle leaked one) [0.15ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > recreates the named room after a restart and re-lands the session there [0.11ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > re-converges a group of three into the same recreated room [0.18ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > recovery works for GUESTS (no auth) — the ticket, not auth, is the proof [0.06ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > recovery into an existing room with capacity lands there (re-converge survivors) [0.11ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > recovery may exceed the SOFT cap (the whole point — reconverge up to 20) [0.17ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > recovery into a room at the HARD cap (20) spills to auto-fill, never breaching 20 [0.27ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > recoveryRoomId takes precedence over requestedRoomId when both are present [0.08ms]
(pass) RoomRegistry — sticky-room recovery (2026-06-12) > an already-seated session ignores recoveryRoomId (idempotent refresh wins) [0.08ms]
(pass) RoomRegistry — guests cannot mint invite IDs (B2 punch list) > an unauthenticated caller requesting an unknown 4-char ID falls through to auto-fill [0.10ms]
(pass) RoomRegistry — guests cannot mint invite IDs (B2 punch list) > an authenticated caller CAN mint a never-before-seen ID (back-compat with the deeplink-host flow) [0.06ms]
(pass) RoomRegistry — guests cannot mint invite IDs (B2 punch list) > a guest joining an EXISTING valid invite code still lands in that room [0.08ms]
(pass) RoomRegistry — guests cannot mint invite IDs (B2 punch list) > legacy plain-string requestedRoomId still works (back-compat — treated as un-authed) [0.06ms]
(pass) RoomRegistry — tick subscriber fanout (B3 punch list) > subscribers receive the kicked-session list — used by world.ts to purge positionLastSeen [0.13ms]
(pass) RoomRegistry — tick subscriber fanout (B3 punch list) > subscribe returns an unsubscribe handle [0.11ms]
[RoomRegistry] tick subscriber threw: 589 |   });
590 |
591 |   it('a throwing subscriber does NOT abort the tick or other subscribers', () => {
592 |     const { registry } = makeRegistry();
593 |     let goodCalls = 0;
594 |     registry.subscribeTick(() => { throw new Error('boom'); });
                                                   ^
error: boom
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\room-registry.test.ts:594:46)
      at tick (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\room-registry.ts:598:15)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\room-registry.test.ts:596:39)

(pass) RoomRegistry — tick subscriber fanout (B3 punch list) > a throwing subscriber does NOT abort the tick or other subscribers [0.52ms]
(pass) RoomRegistry — leave + restore > schedules an NPC restore exactly RESTORE_GRACE_MS after leave [0.11ms]
(pass) RoomRegistry — leave + restore > does NOT restore while the swap-owning player is still in the room [0.06ms]
(pass) RoomRegistry — GC > kicks players idle for more than STALE_PLAYER_MS [0.08ms]
(pass) RoomRegistry — GC > refreshes lastPositionUpdateAt on updatePosition so an active player is NOT kicked [0.14ms]
(pass) RoomRegistry — GC > GCs an empty room after EMPTY_ROOM_MS [0.10ms]
(pass) RoomRegistry — concurrency invariants > two joiners with the same species must swap two different NPCs [0.06ms]
(pass) RoomRegistry — concurrency invariants > FREE_ROAMER_NPC_IDS matches the source NPC_DEFINITIONS roster [0.06ms]
(pass) RoomRegistry — identity dedup (one body per account, 2026-06-19) > a FRESH join for the same userId evicts the prior session and leaks no NPC slot [0.15ms]
(pass) RoomRegistry — identity dedup (one body per account, 2026-06-19) > a RECOVERY rejoin (roomTicket replayed) does NOT evict — it is refused as superseded [0.14ms]
(pass) RoomRegistry — identity dedup (one body per account, 2026-06-19) > agents are NEVER evicted by userId — a human and their agent(s) co-exist [0.10ms]
(pass) RoomRegistry — identity dedup (one body per account, 2026-06-19) > guests (userId null) are NOT deduped — two guest sessions co-exist [0.05ms]
(pass) RoomRegistry — identity dedup (one body per account, 2026-06-19) > an idempotent same-session rejoin never evicts itself [0.05ms]

src\services\__tests__\room-ticket.test.ts:
(pass) room-ticket — sign/verify round-trip > a freshly-signed ticket verifies and returns its claims [0.34ms]
(pass) room-ticket — sign/verify round-trip > survives a "restart" — verify with a different clock instant still works while fresh [0.06ms]
(pass) room-ticket — secret-bound subject > deriveTicketSubject is deterministic for the same sessionId [0.02ms]
(pass) room-ticket — secret-bound subject > different sessionIds derive different subjects [0.02ms]
(pass) room-ticket — secret-bound subject > the subject is NOT the wire-public publicId construction (distinct salt) [0.04ms]
(pass) room-ticket — secret-bound subject > a ticket minted for session A carries A's subject, redeemable only by re-deriving A [0.05ms]
(pass) room-ticket — route redemption decision (MUST-FIX #2b: id-pinning lock) > the minted-for session recovers its room id [0.06ms]
(pass) room-ticket — route redemption decision (MUST-FIX #2b: id-pinning lock) > a DIFFERENT session replaying A's ticket is REJECTED → falls through (no id pin) [0.04ms]
(pass) room-ticket — route redemption decision (MUST-FIX #2b: id-pinning lock) > a tampered roomId (valid-looking but re-signed payload) is REJECTED [0.05ms]
(pass) room-ticket — route redemption decision (MUST-FIX #2b: id-pinning lock) > an expired ticket is REJECTED → falls through (no perpetual id pin) [0.03ms]
(pass) room-ticket — route redemption decision (MUST-FIX #2b: id-pinning lock) > no ticket → no recovery room (first-time joins untouched) [0.02ms]
(pass) room-ticket — expiry (fail-closed) > rejects a ticket exactly at expiry [0.03ms]
(pass) room-ticket — expiry (fail-closed) > rejects a ticket past expiry [0.03ms]
(pass) room-ticket — expiry (fail-closed) > accepts a ticket one ms before expiry [0.05ms]
(pass) room-ticket — tamper + malformed rejection (fail-closed) > rejects a payload mutated after signing (MAC mismatch) [0.06ms]
(pass) room-ticket — tamper + malformed rejection (fail-closed) > rejects a ticket with a forged/wrong MAC (wrong-key signature stand-in) [0.05ms]
(pass) room-ticket — tamper + malformed rejection (fail-closed) > rejects empty / dotless / truncated tickets [0.03ms]
(pass) room-ticket — tamper + malformed rejection (fail-closed) > rejects an over-length input without throwing [0.03ms]
(pass) room-ticket — tamper + malformed rejection (fail-closed) > rejects a payload whose MAC does not match (defense-in-depth — shape guard never reached without a valid MAC) [0.03ms]

src\services\__tests__\rtp-fixture.test.ts:
(pass) classic-3x5 RTP fixture > 10k-spin Monte Carlo lands within [92%, 100%] (wide acceptance band) [178.30ms]

src\services\__tests__\salvage-approach.test.ts:
(pass) issueApproachToken > refuses the first probe and records an anchor [0.60ms]
(pass) issueApproachToken > refuses an unknown node outright [0.07ms]
(pass) issueApproachToken > refuses while out of range, however long you loiter [0.14ms]
(pass) issueApproachToken > refuses until the dwell has actually elapsed [0.11ms]
(pass) issueApproachToken > issues a token once the dwell is served in range [0.27ms]
(pass) issueApproachToken > restarts the dwell when you switch nodes [0.10ms]
(pass) issueApproachToken > teleport poisoning > refuses an impossible jump and quotes how long the walk would have taken [0.11ms]
(pass) issueApproachToken > teleport poisoning > keeps refusing during the poisoned window even while standing on the node [0.08ms]
(pass) issueApproachToken > teleport poisoning > accrues NO dwell while poisoned — the penalty is not free waiting time [0.09ms]
(pass) issueApproachToken > teleport poisoning > allows movement that IS possible at the speed cap [0.08ms]
(pass) verifyApproachToken > accepts a token for the subject and node it was issued to [0.24ms]
(pass) verifyApproachToken > rejects a token replayed by a DIFFERENT avatar [0.12ms]
(pass) verifyApproachToken > rejects a token spent at a DIFFERENT node [0.13ms]
(pass) verifyApproachToken > rejects a token signed with a different secret [0.10ms]
(pass) verifyApproachToken > expires [0.15ms]
(pass) verifyApproachToken > rejects malformed and forged tokens without throwing [0.11ms]
(pass) verifyApproachToken > rejects a token stamped in the future beyond clock skew [0.11ms]

src\services\__tests__\salvage-settlement.test.ts:
(skip) salvage settlement (real DB) > (unnamed)
(skip) salvage settlement (real DB) > HMAC yield > is deterministic for the same (avatar, node, ordinal)
(skip) salvage settlement (real DB) > HMAC yield > stays inside the 1-3 band for a long ordinal run
(skip) salvage settlement (real DB) > HMAC yield > uses all three outcomes rather than collapsing to one
(skip) salvage settlement (real DB) > HMAC yield > DEPENDS ON THE SECRET — this is what makes it unfarmable
(skip) salvage settlement (real DB) > HMAC yield > separates avatars and nodes in the derivation
(skip) salvage settlement (real DB) > fingerprint > excludes the ordinal, so a legitimate replay is not a conflict
(skip) salvage settlement (real DB) > fingerprint > changes with the layout version, so a re-layout cannot alias an old key
(skip) salvage settlement (real DB) > a fresh claim > (unnamed)
(skip) salvage settlement (real DB) > a fresh claim > credits materials, sets a cooldown, and burns exactly one admission
(skip) salvage settlement (real DB) > a fresh claim > refuses the same node again — the cooldown is live
(skip) salvage settlement (real DB) > a fresh claim > consumes NO admission on the refused cooldown claim
(skip) salvage settlement (real DB) > a fresh claim > refuses a node outside the frozen layout without touching state
(skip) salvage settlement (real DB) > a fresh claim > stamps the UTC day from the DATABASE clock, not the node process
(skip) salvage settlement (real DB) > idempotency > (unnamed)
(skip) salvage settlement (real DB) > idempotency > replays the original response and pays only once
(skip) salvage settlement (real DB) > idempotency > replays WITHOUT consuming a cooldown or an admission
(skip) salvage settlement (real DB) > idempotency > 409s the same key aimed at a DIFFERENT node
(skip) salvage settlement (real DB) > idempotency > still replays verbatim after a LATER claim advanced other ordinals
(skip) salvage settlement (real DB) > per-avatar daily cap > (unnamed)
(skip) salvage settlement (real DB) > per-avatar daily cap > admits EXACTLY 20 of 21 concurrent unique-node claims
(skip) salvage settlement (real DB) > per-avatar daily cap > leaves the counter exactly at the cap — never over
(skip) salvage settlement (real DB) > per-avatar daily cap > credited exactly what it issued — no material appears from nowhere
(skip) salvage settlement (real DB) > per-avatar daily cap > does NOT charge the owner budget for the claim it refused
(skip) salvage settlement (real DB) > per-owner daily cap (the anti-fleet bound) > (unnamed)
(skip) salvage settlement (real DB) > per-owner daily cap (the anti-fleet bound) > refuses once the owner budget is spent, even with avatar budget left
(skip) salvage settlement (real DB) > per-owner daily cap (the anti-fleet bound) > the conditional upsert alone admits exactly the cap under raw concurrency
(skip) salvage settlement (real DB) > eligibility > (unnamed)
(skip) salvage settlement (real DB) > eligibility > refuses a HOUSE actor — the fleet earns nothing from a faucet
(skip) salvage settlement (real DB) > eligibility > refuses when the live session no longer matches the captured binding
(skip) salvage settlement (real DB) > eligibility > refuses a session that is no longer ledger-capable
(skip) salvage settlement (real DB) > eligibility > refuses when the session resolver returns nothing at all
(skip) salvage settlement (real DB) > eligibility > refuses when the avatar no longer belongs to the locked principal
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > (unnamed)
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > is off, and reports off
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > pays ZERO vCLAW and leaves the balance untouched on a real claim
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > only reads the exact string "true" — no fuzzy booleans on a money rail
(skip) salvage settlement (real DB) > readSalvageState > (unnamed)
(skip) salvage settlement (real DB) > readSalvageState > reports every node, with the claimed one cooling
(skip) salvage settlement (real DB) > readSalvageState > carries the node geometry the renderer draws, unchanged
(skip) salvage settlement (real DB) > (unnamed)

src\services\__tests__\service-slot-rent-sweeper.test.ts:
(skip) service slot rent sweeper (real DB) > (unnamed)
(skip) service slot rent sweeper (real DB) > skips a listing whose week is already paid
(skip) service slot rent sweeper (real DB) > charges exactly one week when due and advances the cursor
(skip) service slot rent sweeper (real DB) > does NOT charge a second time for the same week
(skip) service slot rent sweeper (real DB) > charges once, not twice, when two sweeps race the same due week
(skip) service slot rent sweeper (real DB) > adds the featured rent on its own cursor when featured is on
(skip) service slot rent sweeper (real DB) > SUSPENDS rather than deleting when the owner cannot pay, and charges nothing
(skip) service slot rent sweeper (real DB) > restores a suspended listing automatically once the owner can pay
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > (unnamed)
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > grants the genuine free week to a shop FIRST listing
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > does NOT grant a second free week on delist + recreate
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > makes a recreated listing due immediately when the shop already lapsed
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > (unnamed)
(skip) service slot rent sweeper (real DB) > public-board featured ordering > ranks only a PAID featured listing first
(skip) service slot rent sweeper (real DB) > public-board featured ordering > pins an UNPAID featured-pending row first without the COALESCE (regression lock)
(skip) service slot rent sweeper (real DB) > public-board featured ordering > uses the COALESCE form on the actual public board query
(skip) service slot rent sweeper (real DB) > skips a delisted listing entirely
(skip) service slot rent sweeper (real DB) > (unnamed)

src\services\__tests__\skill-event-bus.test.ts:
(pass) skill-event-bus — type-scoped drains on one queue > drainKnowledgeEvents returns only knowledge and LEAVES stream events queued [0.39ms]
(pass) skill-event-bus — type-scoped drains on one queue > drainAgentStreamEvents returns only stream events and LEAVES knowledge queued [0.08ms]
(pass) skill-event-bus — type-scoped drains on one queue > second drain of the same type returns empty (drain removes what it matched) [0.05ms]
(pass) skill-event-bus — type-scoped drains on one queue > queues are isolated per session [0.07ms]
(pass) skill-event-bus — type-scoped drains on one queue > clearSessionQueue drops BOTH types [0.04ms]
(pass) skill-event-bus — type-scoped drains on one queue > empty drains never throw [0.03ms]
(pass) skill-event-bus — per-session cap bounds RAM (durable tier is authoritative) > drops OLDEST past the 512 cap; newest survive [0.92ms]
(pass) skill-event-bus — per-session cap bounds RAM (durable tier is authoritative) > totalQueueDepth reflects queued events and returns to 0 after drains [0.14ms]

src\services\__tests__\skill-protocol-onboarding.test.ts:
(pass) open-agent onboarding manuals > explains the bounded late-expiry recovery and unclaimed binding [1.49ms]
(pass) open-agent onboarding manuals > public entry manual retains play, auth, tool, and ACK guidance [5.02ms]
(pass) open-agent onboarding manuals > invited entry manual retains magic-link details within the full world manual [0.24ms]
(pass) open-agent onboarding manuals > all served manuals share the universal connect contract [0.87ms]
(pass) open-agent onboarding manuals > connect pointers hash the exact served protocol bytes [1.30ms]
(pass) open-agent onboarding manuals > derives none/current/stale from the stored manual acknowledgement [0.99ms]
(pass) open-agent onboarding manuals > reports ACK posture only for BYO/self-managed connect rows [0.17ms]

src\services\__tests__\slot-engine.test.ts:
(pass) runSpin — determinism > same inputs ⇒ byte-identical SpinResult [0.33ms]
(pass) runSpin — determinism > different server seeds ⇒ different reels [0.11ms]
(pass) runSpin — determinism > different nonces ⇒ different reels [0.10ms]
(pass) runSpin — determinism > different cursors ⇒ different reels [0.09ms]
(pass) runSpin — reel correctness > reels match an independent sampleIntFromBytes derivation [0.24ms]
(pass) runSpin — reel correctness > each reel emits 3 valid symbol ids [0.11ms]
(pass) runSpin — reel correctness > cursorAfter advances by at least 5 * 4 bytes (one sample each) [0.06ms]
(pass) runSpin — reel correctness > cursorAfter on a known-deterministic input matches independent derivation [0.09ms]
(pass) evaluateReels — wild substitution > 5 wilds on middle line pays 5-of-kind Wild [0.20ms]
(pass) evaluateReels — wild substitution > Wild,Wild,Cherry,Cherry,Cherry on middle line pays 5-of-kind Cherry [0.09ms]
(pass) evaluateReels — wild substitution > Cherry,Cherry,Wild,Cherry,Cherry on middle line pays 5-of-kind Cherry [0.08ms]
(pass) evaluateReels — wild substitution > Cherry,Cherry,Cherry,Wild,Wild on middle line pays 5-of-kind Cherry [0.09ms]
(pass) evaluateReels — wild substitution > Lemon,Lemon,Wild,Cherry,Cherry on middle line pays 3-of-kind Lemon (wild extends) [0.08ms]
(pass) evaluateReels — wild substitution > Lemon,Lemon,Orange,Cherry,Cherry on middle line pays 2-of-kind Lemon (real gap) [0.07ms]
(pass) evaluateReels — wild substitution > leading wilds followed by Seven across the line pays 5-of-kind Seven [0.09ms]
(pass) evaluateReels — wild substitution > symbols array on the winning line matches the visible symbols left-to-right [0.07ms]
(pass) evaluateReels — loss + predict math > no-match grid returns no winning lines and 0n total [0.05ms]
(pass) evaluateReels — loss + predict math > perLinePredict math: predict=20n, 5-of-kind Cherry on middle line ⇒ 20n win on that line [0.07ms]
(pass) evaluateReels — loss + predict math > perLinePredict math: predict=400n, 2-of-kind Cherry ⇒ 40n win on that line [0.06ms]
(pass) evaluateReels — loss + predict math > perLinePredict math: predict=2000n, 5-of-kind Seven ⇒ 80_000n win on that line [0.05ms]
(pass) evaluateReels — loss + predict math > rejects predict of 0n [0.07ms]
(pass) evaluateReels — loss + predict math > rejects predict not divisible by 20 (lineCount) [0.06ms]
(pass) evaluateReels — loss + predict math > rejects non-bigint predict [0.06ms]
(pass) evaluateReels — payline scan > full Cherry middle row + Lemon top/bot wins exactly on line 0 (5-of-kind Cherry) [0.09ms]
(pass) evaluateReels — payline scan > full Cherry grid wins on every line with the right multiplier and total [0.09ms]
(pass) evaluateReels — payline scan > every winningLine.symbols has length 5 and matches the grid via line.rows [0.10ms]
(pass) runSpin — top-level invariants > totalWin equals sum of winningLines.winAmount [0.85ms]
(pass) runSpin — top-level invariants > freeSpinsAwarded is always 0 and isFreeSpin always false in 6.1 MVP [0.32ms]
(pass) runSpin — top-level invariants > rejects unknown paytableId [0.06ms]
(pass) runSpin — top-level invariants > rejects predict=0n [0.05ms]
(pass) runSpin — top-level invariants > rejects predict not divisible by lineCount [0.04ms]
(pass) runSpin — top-level invariants > rejects non-integer cursor [0.04ms]
(pass) runSpin — top-level invariants > rejects negative cursor [0.04ms]
(pass) runSpin — 1000-spin snapshot > 1000 spins are pure-function deterministic across two runs [33.77ms]
(pass) runSpin — 1000-spin snapshot > 1000 spins do not blow up (RTP sanity: total payout in [0, 50x] of total stake) [14.55ms]
(pass) getPaytableBundle > returns the classic-3x5 bundle with correct shape [0.11ms]
(pass) getPaytableBundle > throws on unknown paytable id [0.05ms]
(pass) buildBundle invariant guards > control: a well-formed synthetic paytable builds successfully [0.10ms]
(pass) buildBundle invariant guards > throws on non-positional symbol id (symbols[i].id !== i) [0.07ms]
(pass) buildBundle invariant guards > throws on out-of-range line.rows entry (row index > 2) [0.13ms]
(pass) buildBundle invariant guards > throws on symbol with payouts.length !== 4 [0.06ms]
(pass) buildBundle invariant guards > evaluateReels throws on caller-supplied reel cell with symbol id out of range [0.06ms]
(pass) wildMultiplierForDraw — mapping table > draw=0 → 2× (head of 60% bucket) [0.07ms]
(pass) wildMultiplierForDraw — mapping table > draw=59 → 2× (tail of 60% bucket) [0.02ms]
(pass) wildMultiplierForDraw — mapping table > draw=60 → 3× (head of 30% bucket)
(pass) wildMultiplierForDraw — mapping table > draw=89 → 3× (tail of 30% bucket)
(pass) wildMultiplierForDraw — mapping table > draw=90 → 5× (head of 10% bucket)
(pass) wildMultiplierForDraw — mapping table > draw=99 → 5× (tail of 10% bucket) [0.01ms]
(pass) wildMultiplierForDraw — mapping table > rejects out-of-range draws [0.06ms]
(pass) bonus paytable bundle > builds with scatterId=10 and wildId=7 [0.04ms]
(pass) bonus paytable bundle > every bonus reel strip has exactly 3 scatters [0.10ms]
(pass) bonus paytable bundle > scatter symbol has payouts [0,0,0,0] (line-pay path skips it) [0.06ms]
(pass) runSpin classic-3x5-bonus — base mode determinism > same inputs ⇒ byte-identical SpinResult including wildMultipliers + scatterPayout [0.18ms]
(pass) runSpin classic-3x5-bonus — base mode determinism > classic-3x5 spins still draw no wildMultipliers + scatterPayout=0 [0.05ms]
(pass) evaluateReels classic-3x5-bonus — scatter does NOT extend lines > Cherry,Cherry,Scatter,Cherry,Cherry on middle line pays 2-of-kind Cherry only [0.11ms]
(pass) evaluateReels classic-3x5-bonus — scatter does NOT extend lines > Scatter on the leading cell of a line pays nothing (cannot be a kind) [0.06ms]
(pass) evaluateReels classic-3x5-bonus — wild multiplier products > Wild on the middle line with mult=3 triples a 5-of-kind Cherry line [0.12ms]
(pass) evaluateReels classic-3x5-bonus — wild multiplier products > Two wilds on one line multiply their multipliers together (×2 × ×5 = ×10) [0.09ms]
(pass) evaluateReels classic-3x5-bonus — wild multiplier products > Wild OUTSIDE the matchLen prefix does NOT apply its multiplier [0.11ms]
(pass) evaluateReels classic-3x5-bonus — wild multiplier products > throws if wildMultiplier points at a non-WILD cell (adversarial guard) [0.08ms]
(pass) runSpin classic-3x5-bonus — scatter pay anywhere > 3+ scatters anywhere → scatterPayout matches table × predict [11.69ms]
(pass) runSpin classic-3x5-bonus — free-spin vs base mode behaviour > FS line wins >= base line wins (multipliers only apply in FS) [11.06ms]
(pass) runSpin classic-3x5-bonus — free-spin vs base mode behaviour > wild multiplier values are identical between base and FS (no FS doubling) [5.22ms]
(pass) runSpin classic-3x5-bonus — wild multiplier distribution > 1000-spin empirical distribution is ~60/30/10 (within tolerance) [19.30ms]
(pass) FREE_SPIN_RULES — invariants > AWARD_RETRIGGER < AWARD_BASE (retriggers cheaper than initial trigger) [0.06ms]
(pass) FREE_SPIN_RULES — invariants > CAP_REMAINING is large enough to chain 4 retriggers (4×5+10=30) without clipping [0.03ms]
(pass) FREE_SPIN_RULES — invariants > TRIGGER_THRESHOLD is 3 [0.01ms]

src\services\__tests__\special-event-manager.test.ts:
(pass) SpecialEventManager — pure helpers > toBigIntStrict accepts integers + decimal strings, rejects garbage/negatives/fractions [0.35ms]
(pass) SpecialEventManager — create + gate validation > rejects a half-configured hold gate (mint without bps) [0.63ms]
(pass) SpecialEventManager — create + gate validation > rejects a bad slug [0.10ms]
(pass) SpecialEventManager — FREE event (all gates null) > any human or agent signs up + is confirmed [1.86ms]
(pass) SpecialEventManager — FREE event (all gates null) > signup is idempotent (re-signup → same row, no second charge) [0.36ms]
(pass) SpecialEventManager — HOLD gate (configured RPC) > threshold met → FREE entry with hold snapshot in proof [0.31ms]
(pass) SpecialEventManager — HOLD gate (configured RPC) > below threshold + NO fallback → rejected (402) [0.19ms]
(pass) SpecialEventManager — HOLD gate (configured RPC) > below threshold + SOL fallback → must pay SOL; verified tx confirms, underpaid rejected [0.46ms]
(pass) SpecialEventManager — SOL gate + replay protection > confirms only on a verified tx; a REPLAYED tx (2nd avatar) is rejected [0.36ms]
(pass) SpecialEventManager — SOL gate + replay protection > one SOL payment can NOT satisfy entry to TWO concurrent SOL-gated events (cross-event replay closed) [0.41ms]
(pass) SpecialEventManager — SOL gate + replay protection > DB partial-unique backstop: a 23505 on the SOL INSERT (race past the SELECT guard) surfaces as sol_tx_already_used [0.52ms]
(pass) SpecialEventManager — CT gate > debits the ledger on confirm; insufficient balance throws [0.27ms]
(pass) SpecialEventManager — closeSignupAndStart (DEPENDENCY DIRECTION + prepaid) > creates a tournament whose special_event_id === event.id, seats all confirmed signups, NO double-charge [1.20ms]
(pass) SpecialEventManager — closeSignupAndStart (DEPENDENCY DIRECTION + prepaid) > refuses to start with < 2 confirmed signups [0.26ms]
(pass) SpecialEventManager — settleEvent (reads the linked tournament UP the FK) > reads results via special_event_id and marks completed once the tournament settled [0.77ms]
(pass) SpecialEventManager — settleEvent (reads the linked tournament UP the FK) > early admin refusal is repaired by tournament completion and automatic replay is idempotent [0.48ms]
(pass) SpecialEventManager — settleEvent (reads the linked tournament UP the FK) > exact-id reconciliation never revives draft, signup-open, or cancelled parents [0.43ms]

src\services\__tests__\special-event-settlement-worker.test.ts:
(pass) SpecialEventSettlementWorker > automatically repairs a fail-once completion callback during the boot pass [1.17ms]
(pass) SpecialEventSettlementWorker > bounds each pass and continues after one event fails [0.38ms]
(pass) SpecialEventSettlementWorker > skips an overlapping pass while the current reconciliation is in flight [0.37ms]
(pass) SpecialEventSettlementWorker > releases the overlap guard after a scan error so a later pass can recover [0.29ms]

src\services\__tests__\trade-observer.test.ts:
(pass) trade-verified callback registration > replaces and warns on double registration without stale unregister damage [2.89ms]
(pass) trade observer wallet isolation > alerts a strict failure and continues with the next wallet [2.05ms]
(skip) trade observer delta integration (requires DATABASE_URL) > stores a trade at the binding slot as pre_bind without a leaderboard event
(skip) trade observer delta integration (requires DATABASE_URL) > scores a same-second trade when its slot is greater than the binding slot
(skip) trade observer delta integration (requires DATABASE_URL) > invokes the callback once for a fresh verified signature
(skip) trade observer delta integration (requires DATABASE_URL) > keeps an unregistered callback as a silent no-op
(skip) trade observer delta integration (requires DATABASE_URL) > awaits the callback before broadcasting the verified frame
(skip) trade observer delta integration (requires DATABASE_URL) > contains a throwing callback after scoring and alerts exactly once
(skip) trade observer delta integration (requires DATABASE_URL) > rolls back and returns a retryable report error when strict event insertion fails
(skip) trade observer delta integration (requires DATABASE_URL) > rolls back and rethrows the strict event failure to the observer caller
(skip) trade observer delta integration (requires DATABASE_URL) > notifies with the enriched decision before the enrichment frame
(skip) trade observer delta integration (requires DATABASE_URL) > lets prime win the insert race without observer overwrite or duplicate effects
(skip) trade observer delta integration (requires DATABASE_URL) > looks up a verified signature without returning its wallet address
(skip) trade observer delta integration (requires DATABASE_URL) > returns verified false for an unknown signature

src\services\__tests__\trade-price.test.ts:
(pass) trade price > uses the transaction USDC leg without a fetch [0.99ms]
(pass) trade price > uses a transaction USDC output without a fetch [0.26ms]
(pass) trade price > takes the lower live-price leg and uses transaction decimals [1.36ms]
(pass) trade price > refuses an old non-USDC trade [0.29ms]
(pass) trade price > fails closed on HTTP and schema errors [1.05ms]
(pass) trade price > treats a missing chain time as stale without a fetch [0.31ms]
[trade-price] Invalid TRADE_JUPITER_PRICE_BASE_URL; using the pinned host.
[trade-price] Invalid TRADE_JUPITER_PRICE_BASE_URL; using the pinned host.
[trade-price] Invalid TRADE_JUPITER_PRICE_BASE_URL; using the pinned host.
(pass) trade price > allows only the two credential-free HTTPS Jupiter hosts [0.28ms]
(pass) trade price > chunks price requests at fifty mints [0.65ms]
(pass) trade price > omits absent rows and supports explicit cache bypass [0.63ms]

src\services\__tests__\trade-token-grammar.test.ts:
(pass) trade_token strict grammar > parses symbols and USD micros without floating point [0.32ms]
(pass) trade_token strict grammar > rejects amount NaN [0.03ms]
(pass) trade_token strict grammar > rejects amount Infinity
(pass) trade_token strict grammar > rejects amount 1e3
(pass) trade_token strict grammar > rejects amount +5
(pass) trade_token strict grammar > rejects amount .5
(pass) trade_token strict grammar > rejects amount 5.
(pass) trade_token strict grammar > rejects amount 1.234
(pass) trade_token strict grammar > rejects reordered, duplicate, forbidden, non-ASCII, and oversized input [0.10ms]
(pass) trade_token strict grammar > rejects bounded printable delimiter mutations [0.05ms]

src\services\__tests__\trade-verifier.test.ts:
(pass) trade verifier > returns not_found for a null RPC payload [0.92ms]
(pass) trade verifier > decodes a synthetic PumpSwap wallet-owned two-leg delta [1.49ms]
(pass) trade verifier > rejects a wallet that did not sign [0.37ms]
(pass) trade verifier > prefers an executed Jupiter route over an executed PumpSwap route [0.55ms]
(pass) trade verifier > rejects in-memory discriminator mutations built from recorded fixtures [7.57ms]
(pass) trade verifier > distinguishes failed and malformed transactions [0.52ms]
(pass) trade verifier > rejects cleanly when the approved swap has extra or missing wallet legs [1.01ms]
(pass) trade verifier > rejects wallet legs that are unrelated to the qualifying DEX instruction [0.39ms]
(pass) trade verifier > resolves inner instruction membership through ALT keys without using position [0.91ms]
(pass) trade verifier > requires the wallet system account when native SOL is a swap leg [0.84ms]
(pass) trade verifier > diagnoses a qualifying swap that pays its output to a third party [0.39ms]
(pass) trade verifier > keeps an ambiguous single-sided flow when only the same-mint pool vault moved [0.44ms]
(pass) trade verifier > rejects a same-mint transfer instead of netting it into no movement [0.48ms]
(pass) trade verifier > scores ANSEM before CLAWVILLE and compares transaction slot with bound slot [0.69ms]
(pass) trade verifier > scores a same-second post-bind trade when its slot is strictly greater [0.26ms]
(pass) trade verifier > keeps the documented not_a_swap detail list identical to the runtime array [2.68ms]
(pass) trade verifier > keeps multiplier tiers direction-independent [0.70ms]
(pass) trade verifier > decodes the recorded Jupiter v6 route fixture [1.38ms]
(pass) trade verifier > decodes the recorded PumpSwap buy and sell fixtures [2.43ms]
(pass) trade verifier > recognises the recorded PumpSwap buy_exact_quote_in instruction [3.12ms]
(pass) trade verifier > decodes the recorded pump.fun buy and sell fixtures [1.68ms]
(pass) trade verifier > rejects the recorded failed Jupiter transaction before swap decoding [0.89ms]
(pass) trade verifier > pins every recorded program discriminator, including the failed Jupiter fixture [3.97ms]
(skip) trade verifier > TODO-FIXTURE: no recorded spl-transfer-not-a-swap.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded unused-jupiter-key.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded memo-carrying-dex-address.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded pumpswap-liquidity-deposit.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded pumpswap-liquidity-withdraw.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded pumpfun-creator-fee-claim.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded dex-tx-with-unrelated-transfer.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded sponsored-swap.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded alt-resolved-execution.json was supplied

src\services\__tests__\trading-decision-feed.test.ts:
(pass) Trading Floor decision feed redaction > publishes only the agent subject, bounded trade facts, and refusal code [2.73ms]
(pass) Trading Floor decision feed redaction > never exposes unknown verdict text as a refusal reason [0.06ms]

src\services\__tests__\trading-floor-constants.test.ts:
(pass) Trading Floor frozen constants > pins protocol version 60 and the multiplier contracts [0.04ms]
(pass) Trading Floor frozen constants > pins the approved mints and DEX programs [0.03ms]
(pass) Trading Floor frozen constants > derives both wire guards from their runtime arrays [0.13ms]
(pass) Trading Floor frozen constants > keeps refusal copy exhaustive over the authoritative vocabulary [0.10ms]
(pass) Trading Floor frozen constants > publishes the complete protocol and decision knowledge [0.74ms]
(pass) Trading Floor frozen constants > keeps tools.json discovery aligned with the documented REST paths [0.16ms]

src\services\__tests__\trading-floor-route-integrity.test.ts:
(pass) Trading Floor route integrity > registers every Trading Floor route before the dynamic exchange route [0.09ms]
(pass) Trading Floor route integrity > keeps writes dual-authenticated, non-guest, and the feed public [0.56ms]
(pass) Trading Floor route integrity > keeps the world publisher narrow and the privacy payload closed [0.19ms]
(pass) Trading Floor route integrity > keeps verified-trade lookup server-internal [0.05ms]
(pass) Trading Floor route integrity > keeps strict settlement failure retryable on reports and contained in the observer [0.06ms]

src\services\__tests__\trading-floor-structure.test.ts:
(pass) Trading Floor structural invariants > keeps migration constraint and index names in the Drizzle schema [0.55ms]
(pass) Trading Floor structural invariants > keeps refusal copy within founder language rules [0.13ms]
(pass) Trading Floor structural invariants > keeps the seven-value unscored vocabulary in the SQL check [0.14ms]

src\services\__tests__\trading-jupiter-fixtures.test.ts:
(pass) Trading Jupiter fixture contract > parses byte-identical quote-usdc-ansem.json [0.60ms]
(pass) Trading Jupiter fixture contract > parses byte-identical quote-usdc-clv.json [0.20ms]
(pass) Trading Jupiter fixture contract > parses byte-identical quote-sol-ansem.json [0.15ms]
(pass) Trading Jupiter fixture contract > parses byte-identical quote-ansem-usdc.json [0.17ms]
(pass) Trading Jupiter fixture contract > fixture inventory contains exactly the frozen four [0.15ms]
(pass) Trading Jupiter fixture contract > rejects additive fields and accepts nullable instructionVersion [0.38ms]
(pass) Trading Jupiter fixture contract > refuses ExactOut, a non-null platform fee, and discontinuous routes [1.42ms]
(pass) Trading Jupiter fixture contract > requests ExactIn V1 and sends only the frozen swap-build fields [1.44ms]

src\services\__tests__\trading-limits.test.ts:
(pass) Trading Floor environment directions > risk environments may lower a ceiling but cannot raise it [0.34ms]
(pass) Trading Floor environment directions > reserve environments may raise a floor but cannot lower it [0.09ms]
(pass) Trading Floor environment directions > the trade minimum cannot undercut the core scoring minimum [0.06ms]

src\services\__tests__\trading-signer.test.ts:
(pass) Trading Floor signer > validates signatures by decoded byte length [0.13ms]
(pass) Trading Floor signer > captures signed bytes and signature before any caller can send [2.51ms]
(pass) Trading Floor signer > refuses a built minimum below the admitted minimum without capture [1.14ms]
(pass) Trading Floor signer > refuses a keypair that differs from the bound wallet [1.33ms]

src\services\__tests__\trading-swap-validator.test.ts:
(pass) Trading Floor leg validator > accepts every ordered pair of distinct static mints in both SOL modes [2.71ms]
(pass) Trading Floor leg validator > refuses each inconsistent leg shape before an RPC can exist [0.76ms]
(pass) Trading Floor leg validator > checks token deltas and keeps ATA rent neutral in a token route [2.33ms]
(pass) Trading Floor leg validator > bounds native input by the admitted amount plus the exact fee [0.73ms]
(pass) Trading Floor leg validator > credits native output with the exact transaction fee [0.62ms]

src\services\__tests__\trading-wave2-structure.test.ts:
(pass) Trading Floor Wave 2 structural boundaries > only execution imports the fleet signer [2.08ms]
(pass) Trading Floor Wave 2 structural boundaries > only the signer imports the key vault inside the Wave 2 service set [0.22ms]
(pass) Trading Floor Wave 2 structural boundaries > Wave 2 services never access the verified_trades table directly [0.13ms]
(pass) Trading Floor Wave 2 structural boundaries > the executed decision CAS has one publisher [0.13ms]
(pass) Trading Floor Wave 2 structural boundaries > refusal copy covers every refusal code exactly [0.23ms]
(pass) Trading Floor Wave 2 structural boundaries > compiled ceiling and reserve directions stay distinct [0.18ms]
(pass) Trading Floor Wave 2 structural boundaries > no scoring or ingest module imports fleet tables [0.30ms]
(pass) Trading Floor Wave 2 structural boundaries > fleet arming has one true writer and schema defaults are unarmed and killed [16.66ms]
(pass) Trading Floor Wave 2 structural boundaries > migration holds ambiguous reservations and has 0061-style checks [0.18ms]
(pass) Trading Floor Wave 2 structural boundaries > every migration constraint and partial index is mirrored in the Drizzle schema [0.48ms]
(pass) Trading Floor Wave 2 structural boundaries > the admin trading router has no dashboard-only auth bypass [0.14ms]
(pass) Trading Floor Wave 2 structural boundaries > the locked admission preserves the required lock order and contains no provider work [0.15ms]
(pass) Trading Floor Wave 2 structural boundaries > floor services do not touch CT balances or treat trading wallet row ids as addresses [0.15ms]
(pass) Trading Floor Wave 2 structural boundaries > the observer callback is registered exactly once [16.09ms]
(pass) Trading Floor Wave 2 structural boundaries > fleet labels stay outside the leaderboard scoring CTE [0.39ms]
(pass) Trading Floor Wave 2 structural boundaries > reservation terminal states use the database vocabulary [0.06ms]

src\services\__tests__\transient-db-error.test.ts:
(pass) isTransientDbConnectionError > classifies CONNECTION_CLOSED code properties [0.11ms]
(pass) isTransientDbConnectionError > classifies CONNECTION_ENDED code properties
(pass) isTransientDbConnectionError > classifies CONNECTION_DESTROYED code properties
(pass) isTransientDbConnectionError > classifies CONNECT_TIMEOUT code properties
(pass) isTransientDbConnectionError > classifies stringified postgres.js connection errors [0.12ms]
(pass) isTransientDbConnectionError > classifies write ECONNRESET errors [0.03ms]
(pass) isTransientDbConnectionError > does not classify a plain Error [0.02ms]
(pass) isTransientDbConnectionError > does not classify Postgres constraint violations [0.03ms]
(pass) isTransientDbConnectionError > does not classify HTTPException-like errors [0.05ms]
(pass) isTransientDbConnectionError > does not classify connection-token near misses [0.02ms]

src\services\__tests__\tutorial-quest-settlement.test.ts:
(skip) tutorial quest settlement (real DB) > (unnamed)
(skip) tutorial quest settlement (real DB) > settles a legacy quest on the vCLAW rail and leaves the materials rail at zero
(skip) tutorial quest settlement (real DB) > settles a land quest on the MATERIALS rail with no vCLAW and no ledger row
(skip) tutorial quest settlement (real DB) > replays an already-claimed quest without paying twice, whichever subject asks
(skip) tutorial quest settlement (real DB) > admits exactly one of eight concurrent claims of the same quest
(skip) tutorial quest settlement (real DB) > refuses an unknown quest and an unqualified one, writing nothing either way
(skip) tutorial quest settlement (real DB) > lets the database refuse a double-railed or rewardless claim row
(skip) tutorial quest settlement (real DB) > runs the REAL land predicates against canonical land state
(skip) tutorial quest settlement (real DB) > (unnamed)

src\services\__tests__\usdc-spend-admission.test.ts:
(pass) USDC spend admission reconcile liabilities > counts an ambiguous agent payment until it is proven no-broadcast/resolved [0.47ms]
(pass) USDC spend admission reconcile liabilities > counts an ambiguous withdrawal until an operator moves it to a resolved terminal state [0.14ms]
(pass) USDC spend admission reconcile liabilities > binds those behaviors to the production SQL predicates [0.26ms]

src\services\__tests__\wager-intent-reconciliation.test.ts:
[wager-intent-reconciler] intent ambiguous failed: 12 |         { id: 'ambiguous', lobbyId: 'lobby-1', status: 'reconcile' },
13 |         { id: 'stale-prepared', lobbyId: 'lobby-2', status: 'prepared' },
14 |       ],
15 |       processCandidate: async (candidate) => {
16 |         processed.push(candidate.id);
17 |         if (candidate.id === 'ambiguous') throw new Error('rpc still unavailable');
                                                         ^
error: rpc still unavailable
      at processCandidate (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\wager-intent-reconciliation.test.ts:17:53)
      at sweepOutstandingWagerIntents (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\wager-intent-reconciler.ts:85:42)
      at async <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\__tests__\wager-intent-reconciliation.test.ts:9:26)

(pass) wager intent operational reconciliation > sweeps every candidate and remains fail-soft per row [0.60ms]
(pass) wager intent operational reconciliation > caps an operator-supplied sweep limit at 100 [0.11ms]
(pass) wager lifecycle fence structural lock > capture and lifecycle transitions share the same advisory lock helper [0.08ms]
(pass) wager lifecycle fence structural lock > lock, settle, cancel, refund, and activity bridge all use the fence [0.11ms]
(pass) wager lifecycle fence structural lock > terminal create/join retries reconcile before state rejection [0.05ms]
(pass) wager lifecycle fence structural lock > agent-owned reads key mine and private invite recovery by bound avatar [0.07ms]

src\services\__tests__\wager-program-client.test.ts:
(pass) assertWagerBroadcastCluster > accepts the exact full devnet genesis hash [0.45ms]
(pass) assertWagerBroadcastCluster > returns devnet proof despite a localnet config label and enforces namespace [0.36ms]
(pass) assertWagerBroadcastCluster > returns a true-local proof only after the loopback triple gate [0.17ms]
(pass) assertWagerBroadcastCluster > rejects the truncated CAIP-2 devnet prefix [0.09ms]
(pass) assertWagerBroadcastCluster > allows unknown local-validator genesis only behind non-prod loopback triple gate [0.09ms]
(pass) assertWagerBroadcastCluster > rejects mainnet even when proxied through localnet loopback [0.08ms]
(pass) assertWagerBroadcastCluster > rejects an unknown remote cluster despite localnet env [0.07ms]
(pass) assertWagerBroadcastCluster > rejects official testnet even through a local loopback proxy [0.09ms]
(pass) assertWagerBroadcastCluster > rejects localnet in production [0.13ms]
(pass) assertWagerBroadcastCluster > fails closed when the genesis probe throws [0.13ms]
(pass) isDefinitelyUnsentWagerBroadcastError > classifies web3 preflight simulation rejection as definitely unsent [0.07ms]
(pass) isDefinitelyUnsentWagerBroadcastError > keeps transport timeout ambiguous because the node may have accepted bytes [0.03ms]
(pass) strict wager PDA reconciliation decoding > accepts a lobby account only when every committed field matches [0.22ms]
(pass) strict wager PDA reconciliation decoding > rejects wrong lobby id on a predictable lobby PDA [0.07ms]
(pass) strict wager PDA reconciliation decoding > rejects wrong creator on a predictable lobby PDA [0.02ms]
(pass) strict wager PDA reconciliation decoding > rejects wrong wager on a predictable lobby PDA [0.02ms]
(pass) strict wager PDA reconciliation decoding > rejects wrong max players on a predictable lobby PDA [0.05ms]
(pass) strict wager PDA reconciliation decoding > rejects wrong state on a predictable lobby PDA [0.03ms]
(pass) strict wager PDA reconciliation decoding > rejects a player PDA owned by the wrong avatar wallet [0.25ms]
(pass) strict wager PDA reconciliation decoding > rejects an already-refunded player account as a fresh join witness [0.07ms]
(pass) assertWagerLobbyIdInEnvNamespace > production accepts ids in [1, 2^32) [0.08ms]
(pass) assertWagerLobbyIdInEnvNamespace > production rejects 0 and ids at/above 2^32 [0.07ms]
(pass) assertWagerLobbyIdInEnvNamespace > staging accepts [2^32, 2*2^32) and rejects prod-range ids [0.08ms]
(pass) assertWagerLobbyIdInEnvNamespace > dev/unset env gets the third range hermetically [0.17ms]
(pass) assertWagerLobbyIdInEnvNamespace > only verified unknown/local genesis is exempt [0.11ms]
(pass) assertWagerLobbyIdInEnvNamespace > rejection carries namespace_violation code and the setval repair command [0.08ms]
(pass) assertWagerLobbyIdInEnvNamespace > Production fails closed without a setval hint [0.08ms]
(pass) assertWagerLobbyIdInEnvNamespace > prod fails closed without a setval hint [0.02ms]
(pass) assertWagerLobbyIdInEnvNamespace > STAGING fails closed without a setval hint [0.02ms]
(pass) assertWagerLobbyIdInEnvNamespace > falls back to process.env when no overrides are injected [0.09ms]
(pass) namespace violation route contract and draft repair > maps namespace_violation to a terminal server-configuration 500 [0.15ms]
(pass) namespace violation route contract and draft repair > allocation refuses an out-of-range sequence value before insert [1.33ms]
(pass) namespace violation route contract and draft repair > owner mismatch stays DB-only and skips genesis/transaction [0.15ms]
(pass) namespace violation route contract and draft repair > confirmed replay stays DB-only and skips genesis/transaction [0.04ms]
(pass) namespace violation route contract and draft repair > terminal replay stays DB-only and skips genesis/transaction [0.02ms]
(pass) namespace violation route contract and draft repair > self-heals an unsigned stranded draft and updates its intent target [1.67ms]
(pass) namespace violation route contract and draft repair > refuses to remint when the intent has broadcast evidence [0.47ms]

src\services\__tests__\wallet-link-challenge.test.ts:
(pass) wallet-link-challenge > issues a base58 nonce with a future ISO expiry [2.45ms]
(pass) wallet-link-challenge > consumes a valid nonce exactly once for the issuing user [0.09ms]
(pass) wallet-link-challenge > refuses a nonce issued to a DIFFERENT user (cross-account replay guard) [0.04ms]
(pass) wallet-link-challenge > refuses an unknown / never-issued nonce [0.02ms]
(pass) wallet-link-challenge > two issues to the same user produce distinct nonces, each single-use [0.04ms]
(pass) wallet-link-challenge > issues an account-bound human-readable messageToSign (anti blind-signing) [0.04ms]
(pass) wallet-link-challenge > messages for different accounts differ even with the same nonce (binding) [0.04ms]

src\services\__tests__\wallet-unification-source-gate.test.ts:
(pass) wallet unification source gates > no executable agent-subject wallet mint caller exists [410.82ms]
(pass) wallet unification source gates > the v2 insert round-trips ciphertext before the canonical insert [0.25ms]
(pass) wallet unification source gates > the settlement resolver is a canonical-only read with no decrypt or mutation [0.23ms]
(pass) wallet unification source gates > no GET route directly calls a wallet provisioner [17.51ms]
(pass) wallet unification source gates > Hatcher resolves the current binding before every stats cache hit [0.26ms]
(pass) wallet unification source gates > Hatcher public records never advertise the bot mirror [0.18ms]
(pass) wallet unification source gates > connect binds first and advertises only resolver-approved wallet fields [0.27ms]
(pass) wallet unification source gates > controlled backfill never references the bot mirror table [0.13ms]

src\services\__tests__\wallet-withdraw-executor.test.ts:
(pass) GATES — dark by default; mainnet-only > flag OFF: every entrypoint refuses with a clean typed withdraw_disabled [1.18ms]
(pass) GATES — dark by default; mainnet-only > NETWORK GUARD: devnet/testnet/localhost endpoints can never reach a send [0.84ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > amounts: zero / non-integer / over-u64 refused as amount_invalid [0.18ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > destination: non-base58 / wrong length / OFF-CURVE (PDA) refused [0.45ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > self-send: destination == the caller custodial wallet refused [0.21ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > missing custodial wallet row: wallet_missing [0.12ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > SOL over-balance: insufficient_balance [0.31ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > SOL rent-exempt + fee headroom: the source is NEVER drained below it [2.98ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > token over-balance: insufficient_balance [0.27ms]
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > token send with MISSING dest ATA reserves its rent in the fee headroom [3.42ms]
[wallet-withdraw] balance read failed (refusing, fail-closed): boom: rpc balance died
(pass) VALIDATION — before any claim/sign; nothing persisted on refusal > balance read failure: REFUSE (fail-closed), never fail-open [0.34ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > atomicToDecimalString: exact 6dp strings, no float math [0.12ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > over-hold CLV withdrawal WITHOUT ack: typed hold_at_risk with the payload; NO row, nothing signed [0.33ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > acknowledgeHoldLoss: the SAME Idempotency-Key retry proceeds cleanly (gate skipped, one row, one send) [2.70ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > acknowledgeHoldLoss bypasses ONLY the consent gate — every other guard still refuses [0.45ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > post-withdrawal balance ≥ the requirement proceeds without ack (boundary: exactly equal passes) [4.73ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > req = 0 (no agent-subject holds — incl. grandfathered/user-subject-only owners) proceeds [2.42ms]
[wallet-withdraw] hold-threshold query failed (fail-open, consent gate skipped): boom: hold-threshold query died
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > FAIL-OPEN: a thrown threshold query never blocks the withdrawal (consent, not enforcement) [4.66ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > SOL and USDC withdrawals SKIP the gate entirely (agent holds are CLV-backed only) [7.86ms]
(pass) CLV HOLD CONSENT GATE — pre-row informed consent; sweeper owns enforcement > SOURCE-VERIFIED: the default threshold SQL mirrors the sweeper — agent-subject, non-grandfathered hold parcels only [0.79ms]
(pass) Tier-1 USDC bounty hold withdrawal guard > refuses pre-row with non-overridable bounty_hold_active even when acknowledged [2.02ms]
[wallet-withdraw] USDC hold/liability admission failed (refusing, fail-closed): boom: bounty hold query died
(pass) Tier-1 USDC bounty hold withdrawal guard > fails closed before row creation when bounty hold admission cannot be queried [1.31ms]
(pass) RESUME WORKER — dark-gated boot worker; pages ops on reconcile > resolveWithdrawResumePollMs: default 300000; floor 60000; invalid → default [0.22ms]
(pass) RESUME WORKER — dark-gated boot worker; pages ops on reconcile > DARK-SAFE: the worker refuses to start while the flag is off [0.65ms]
[wallet-withdraw] resume worker started — sweeping stale 'sending' claims every 5min (forward-only; a captured sig is never re-sent)
(pass) RESUME WORKER — dark-gated boot worker; pages ops on reconcile > start/stop are idempotent (flag on) [0.19ms]
(pass) RESUME WORKER — dark-gated boot worker; pages ops on reconcile > a pass PAGES OPS (warning) for a row that resolves to reconcile — ids/sigs only, no key material [2.08ms]
(pass) RESUME WORKER — dark-gated boot worker; pages ops on reconcile > a pass does NOT page for forward progress (confirmed → sent) [0.52ms]
(pass) RESUME WORKER — dark-gated boot worker; pages ops on reconcile > a pass is a silent no-op while the flag is off (dark) [0.14ms]
(pass) HAPPY PATHS — each asset; capture-before-send ordering > SOL: SystemProgram.transfer, claim→custody→capture→send→confirm→sent [2.44ms]
(pass) HAPPY PATHS — each asset; capture-before-send ordering > USDC: classic-SPL TransferChecked + idempotent dest-ATA create [3.06ms]
(pass) HAPPY PATHS — each asset; capture-before-send ordering > CLV: Token-2022 TransferChecked (mint + 6 dp pinned) [2.89ms]
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > IDEMPOTENCY REPLAY: a retried key can never create a second withdrawal [2.01ms]
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > IDEMPOTENCY CONFLICT: a key reused with a DIFFERENT request refuses loudly [1.96ms]
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > DOUBLE-CLAIM: a lost atomic claim refuses with zero custody/sends [0.22ms]
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > replay of an in-flight (sending) row reports withdrawal_in_flight — no touch [0.13ms]
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > CAPTURE LOST: claim no longer ours at capture time ⇒ NOTHING is sent [0.64ms]
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > SIGNATURE CONFLICT at capture: released for a clean retry, nothing sent [0.62ms]
[wallet-withdraw] AMBIGUOUS SEND — withdrawal=2dced3a2-6f37-46b9-9198-99b831a945bb tx=5KPCeLdoaY4JN2ofLMWAiyxibYZaj86pyC3UAr2Y3kV2kQfdRLjCAxs1RgR8tpkKcft6keyNup6U1NRZ2XvE3VNL; money-state UNKNOWN → reconcile (no re-send): boom: transport died mid-send
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > AMBIGUOUS SEND: terminal reconcile; a retry NEVER re-sends the captured sig [1.88ms]
[wallet-withdraw] AMBIGUOUS CONFIRM — withdrawal=23956657-70e2-48c0-8def-bede08635f5f tx=5KPCeLdoaY4JN2ofLMWAiyxibYZaj86pyC3UAr2Y3kV2kQfdRLjCAxs1RgR8tpkKcft6keyNup6U1NRZ2XvE3VNL; money-state UNKNOWN → reconcile (no re-send): boom: confirm died
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > AMBIGUOUS CONFIRM: terminal reconcile (money-state unknown) [1.55ms]
[wallet-withdraw] TX FAILED ON-CHAIN — withdrawal=3620c6f5-3d30-445a-a295-a129f96fcdc6 tx=5KPCeLdoaY4JN2ofLMWAiyxibYZaj86pyC3UAr2Y3kV2kQfdRLjCAxs1RgR8tpkKcft6keyNup6U1NRZ2XvE3VNL; no assets moved; → failed
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > DEFINITIVE on-chain failure: terminal failed (no assets moved) [1.50ms]
[wallet-withdraw] CUSTODY REFUSAL — withdrawal=37dd05b8-1449-45f8-a45b-51e869a0fb2b: mismatch
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > CUSTODY refusal (pubkey mismatch): terminal failed, zero sends [0.25ms]
[wallet-withdraw] pre-capture failure — withdrawal=bde5d2c9-9aaf-4142-8492-29beb1d3acc5: boom: rpc blockhash died
(pass) EXACTLY-ONCE — idempotency, claims, ambiguity, resume > PRE-CAPTURE transient failure: claim released; the SAME key then completes [2.16ms]
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > captured + confirmed on chain → sent (zero sends) [0.17ms]
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > captured + on-chain err → failed (definitive; zero sends) [0.10ms]
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > captured + not_found → TERMINAL reconcile (the tx may still land — never re-send) [0.11ms]
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > nothing captured → nothing was ever sent → clean release to pending [0.09ms]
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > a LIVE (fresh) claim is never stolen [0.12ms]
[wallet-withdraw] resume chain-check errored (transient) — withdrawal=b6ccf832-e8a2-40c2-9f2e-e38fdbe4013c: boom: rpc status check died; row stays 'sending' for a later resume
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > transient chain-check error: row stays sending for a later resume [0.23ms]
(pass) RESUME — forward-only; a captured signature is NEVER re-sent > runWithdrawResumeTick sweeps stale claims [0.13ms]
(pass) E5 PARITY — agents withdraw as themselves; guests/non-ledger refused > resolveWithdrawSubject: non-ledger agent session refused; ledger agent → its avatar [0.09ms]
(pass) E5 PARITY — agents withdraw as themselves; guests/non-ledger refused > AGENT PARITY end-to-end: an agent subject withdraws from ITS avatar wallet [1.83ms]
(pass) E5 PARITY — agents withdraw as themselves; guests/non-ledger refused > ROUTE WIRING (source-verified): auth + non-guest + strict zod + Idempotency-Key [0.39ms]
(pass) E5 PARITY — agents withdraw as themselves; guests/non-ledger refused > LEDGER-UNTOUCHED (source-verified): no claw-token-ledger import anywhere [0.32ms]
(pass) GET /balances — read-only, live regardless of the flag > reports all three assets (atomic + ui) off the custodial wallet [0.44ms]
[wallet-withdraw] SOL balance read failed (non-fatal): boom: rpc balance died
(pass) GET /balances — read-only, live regardless of the flag > missing wallet → wallet_missing; a failed read degrades per-asset [0.30ms]

src\services\__tests__\world-guest-binding.test.ts:
(pass) world guest binding > round-trips a signed presence key and expires fail-closed [0.47ms]
(pass) world guest binding > fails closed on malformed, tampered, truncated, and over-length values [0.10ms]
(pass) world guest binding > binds exp inside the MAC-protected payload [0.09ms]
(pass) world guest binding > derives a deterministic, non-exposing guest key [0.17ms]
(pass) world guest binding > mirrors production and local Lucia cookie attributes [0.10ms]
(pass) world guest binding > serializes as a session cookie with no Max-Age or Expires [0.85ms]

src\services\__tests__\world-position-apply.test.ts:
(pass) world-position-apply > shares a 10 Hz admission slot keyed by session [0.08ms]
(pass) world-position-apply > consumes the slot on admission even when caller parsing later fails [0.02ms]
(pass) world-position-apply > returns not_in_room, then mutates the joined registry row [0.15ms]
(pass) world-position-apply > forgetWorldPositionThrottle clears the session entry [0.05ms]
(pass) world-position-apply > refreshes Hatcher suppression only for a human, with no TTL argument [0.14ms]

src\services\__tests__\world-presence-ws-hub.test.ts:
(pass) WorldPresenceWsHub registration and fencing > sends presence.ready first with the /join public identity [0.39ms]
(pass) WorldPresenceWsHub registration and fencing > reports membership failure after upgrade and releases the IP slot [0.17ms]
(pass) WorldPresenceWsHub registration and fencing > revalidates membership on open to close the upgrade TOCTOU window [0.11ms]
(pass) WorldPresenceWsHub registration and fencing > newest socket wins, old is fenced first, and stale close/frame are harmless [0.47ms]
(pass) WorldPresenceWsHub registration and fencing > fences a socket when membership moves to a different room [0.20ms]
(pass) WorldPresenceWsHub inbound frames > shares the 10 Hz cap across reconnects and HTTP/WS transports [0.22ms]
(pass) WorldPresenceWsHub inbound frames > rejects binary, oversized, invalid JSON, and invalid schemas as strikes [0.34ms]
(pass) WorldPresenceWsHub inbound frames > defaults activity to idle [0.13ms]
(pass) WorldPresenceWsHub inbound frames > uses an honest fixed window and closes a sustained flood [1.59ms]
(pass) WorldPresenceWsHub inbound frames > pongs refresh liveness without pose mutation or position throttling [0.50ms]
(pass) WorldPresenceWsHub heartbeat, cleanup, and caps > keeps a ponging background presence alive for four simulated minutes [0.59ms]
(pass) WorldPresenceWsHub heartbeat, cleanup, and caps > reaps a half-open socket by pong deadline even if pose membership remains [0.16ms]
(pass) WorldPresenceWsHub heartbeat, cleanup, and caps > drops sockets when registry stale GC removes membership [0.18ms]
(pass) WorldPresenceWsHub heartbeat, cleanup, and caps > reserves IP slots atomically, releases idempotently, and expires leaks [0.28ms]
(pass) WorldPresenceWsHub heartbeat, cleanup, and caps > supports silent leave, penalty-free reopen, and shutdown drain [0.34ms]

src\services\__tests__\world-teacher-settle.test.ts:
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent d49e51f7689a6bd2 (1 total)
[AutonomyDriver][debug] talk d49e51f7689a6bd2 replyLen=90 reply="Hello! [ACTION: talk_to_npc(buildingId=api-integrations, message=teach me about webhooks)]"
[Covenant] no avatar attribution for in-world agent body ocb-s4-a; actions continue without records
[AutonomyDriver][debug] talk skipped (cooldown) d49e51f7689a6bd2 building=api-integrations
(pass) slice 4 — driver conducts + settles the teacher turn > conducts the turn with the parsed message; success stamps the cooldown + the lesson feeds the next decision [1.02ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 1b0143e903a81eba (1 total)
[AutonomyDriver][debug] talk 1b0143e903a81eba replyLen=73 reply="[ACTION: talk_to_npc(buildingId=api-integrations, message=hello teacher)]"
[Covenant] no avatar attribution for in-world agent body ocb-s4-b; actions continue without records
[AutonomyDriver][debug] talk 1b0143e903a81eba replyLen=73 reply="[ACTION: talk_to_npc(buildingId=api-integrations, message=hello teacher)]"
(pass) slice 4 — driver conducts + settles the teacher turn > a FAILED turn (null) stamps NO cooldown — the next arrival retries [0.41ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 937a631ca520daa5 (1 total)
[AutonomyDriver][debug] talk 937a631ca520daa5 replyLen=27 reply="Just musing, no action tag."
[Covenant] no avatar attribution for in-world agent body ocb-s4-c; actions continue without records
(pass) slice 4 — driver conducts + settles the teacher turn > no parseable talk_to_npc message ⇒ NO conducted turn (no settle path reached) [0.22ms]
[NPC Simulation] Stopped
[AutonomyDriver] registered house agent 791892be49690d2e (1 total)
(pass) slice 4 — driver conducts + settles the teacher turn > walking→arrived fires the arrival settle with the dedicated avatarId, and walking stays LLM-free [0.36ms]
[NPC Simulation] Stopped
(pass) extractTalkMessage — executor-parity param parse > extracts the message param from a talk_to_npc tag [0.06ms]
[NPC Simulation] Stopped
(pass) extractTalkMessage — executor-parity param parse > returns null when there is no tag, no message param, or an empty message [0.05ms]
[NPC Simulation] Stopped
(pass) extractTalkMessage — executor-parity param parse > parses space-separated params and keeps commas inside the message (executor parity) [0.08ms]
[NPC Simulation] Stopped
[WorldTeacherChat] teacher turn gated — dfca68a788ade23a is 5122wu from "api-integrations" (need <=1000wu)
(pass) world-teacher-chat — fail-closed proximity (no walk → no reward) > conductTeacherTurn returns null for a FAR body (gated before any teacher/DB work) [0.61ms]
[NPC Simulation] Stopped
[WorldTeacherChat] teacher turn dropped — body missing for ead6ef03d61ee60c
[WorldTeacherChat] teacher turn dropped — unknown building "constructor" for 2df5b5d9c949991f
(pass) world-teacher-chat — fail-closed proximity (no walk → no reward) > conductTeacherTurn returns null for a MISSING body and an UNKNOWN/prototype building [0.17ms]
[NPC Simulation] Stopped
[WorldTeacherChat] arrival settle gated — e8e21916320cc488 is 5122wu from "api-integrations" (need <=1000wu)
(pass) world-teacher-chat — fail-closed proximity (no walk → no reward) > settleBuildingArrival never throws and settles nothing for a far body [0.23ms]
[NPC Simulation] Stopped
(pass) leaderboard — house-agent public-board carve-out (P4 gate (a), landed early) > both daily CTEs exclude house agents via a DURABLE subject-level JOIN against openclaw_bots.is_house (not a payload tag) [0.40ms]

src\services\__tests__\world-ws-upgrade-decision.test.ts:
(pass) world WS upgrade decision > returns the ordered table result 0 [0.05ms]
(pass) world WS upgrade decision > returns the ordered table result 1
(pass) world WS upgrade decision > returns the ordered table result 2
(pass) world WS upgrade decision > returns the ordered table result 3
(pass) world WS upgrade decision > returns the ordered table result 4
(pass) world WS upgrade decision > returns the ordered table result 5
(pass) world WS upgrade decision > returns the ordered table result 6
(pass) world WS upgrade decision > pins first-match ordering [0.03ms]
(pass) world WS upgrade decision > cannot return a membership-class rejection [0.05ms]

src\services\__tests__\x402-auto-reconcile.test.ts:
(pass) x402 recurring auto-reconcile > does not touch the sweep or stores when explicitly disabled [0.53ms]
(pass) x402 recurring auto-reconcile > annotates every swept verdict after auto apply and continues after a failed stamp [0.82ms]
(pass) x402 recurring auto-reconcile > is default-on and applies interval floor plus bounded row cap [0.10ms]
(pass) x402 recurring auto-reconcile > runs the shared sweep in auto-apply mode under the advisory lock [0.31ms]
(pass) x402 recurring auto-reconcile > does not alert on quiet ticks and deduplicates an unchanged manual set [0.26ms]
(pass) x402 recurring auto-reconcile > alerts an indeterminate row only after it survives 24 hours [0.24ms]
(pass) x402 recurring auto-reconcile > skips cleanly when another replica owns the advisory lock [0.14ms]

src\services\__tests__\x402-chain-verifier.test.ts:
(pass) x402 Solana chain verifier > resolves friendly and CAIP-2 network ids and refuses unknown networks [0.04ms]
(pass) x402 Solana chain verifier > confirms one exact transferChecked and reports its payer + block time [0.70ms]
(pass) x402 Solana chain verifier > finds a transferChecked in inner instructions [0.38ms]
(pass) x402 Solana chain verifier > rejects a confirmed transfer with the wrong amount [0.40ms]
(pass) x402 Solana chain verifier > rejects a confirmed transfer with the wrong mint [0.21ms]
(pass) x402 Solana chain verifier > rejects a confirmed transfer with the wrong destination [0.30ms]
(pass) x402 Solana chain verifier > rejects a confirmed transfer with the wrong payer [0.28ms]
(pass) x402 Solana chain verifier > rejects N plus an extra inbound amount from the same payer [0.33ms]
(pass) x402 Solana chain verifier > live settlement mode accepts an overpay but still rejects an underpay [0.53ms]
(pass) x402 Solana chain verifier > allows unrelated destination/payer transfers while binding the expected payer total [0.47ms]
(pass) x402 Solana chain verifier > refuses two payer groups that each exactly match when no payer was expected [0.30ms]
(pass) x402 Solana chain verifier > distinguishes a failed transaction from a missing transaction [0.53ms]
(pass) x402 Solana chain verifier > throws on malformed successful RPC data instead of calling it no-money [0.33ms]
(pass) x402 merchant/recipient ATA probe > returns one exact unbound match and scans the derived destination ATA [1.00ms]
(pass) x402 merchant/recipient ATA probe > returns ambiguous when two eligible inbound payments match [0.72ms]
(pass) x402 merchant/recipient ATA probe > excludes signatures already bound across all three payment tables [0.54ms]
(pass) x402 merchant/recipient ATA probe > returns indeterminate when the hard cap is exhausted before the since boundary [0.99ms]
(pass) x402 merchant/recipient ATA probe > stops at the since boundary and ignores older signatures [0.51ms]
(pass) x402 merchant/recipient ATA probe > returns indeterminate when an ATA candidate cannot be fetched [0.51ms]

src\services\__tests__\x402-checkout.test.ts:
(pass) x402-checkout — fulfiller registry > shipped fulfillers self-registered via side-effect import; unclaimed kind is undefined [0.17ms]
(pass) x402-checkout — fulfiller registry > duplicate registration throws (wiring-bug tripwire) [0.14ms]
(pass) x402-checkout — fulfiller registry > settle of an UNREGISTERED kind refuses BEFORE the facilitator is called [1.62ms]
(pass) x402-checkout — fulfiller registry > quote of an UNREGISTERED kind refuses with no pending row [0.42ms]
(pass) x402-checkout — quote > rejects priceVclaw=0 BEFORE any row insert [0.11ms]
(pass) x402-checkout — quote > rejects priceVclaw=-5 BEFORE any row insert [0.02ms]
(pass) x402-checkout — quote > rejects priceVclaw=2.5 BEFORE any row insert [0.01ms]
(pass) x402-checkout — quote > rejects priceVclaw=1000001 BEFORE any row insert
(pass) x402-checkout — quote > happy quote: pending row + ¢-pegged 402 requirement (usdCents === priceVclaw) [0.44ms]
(pass) x402-checkout — quote > refuses on_ramp_unconfigured (no merchant wallet) with no row insert [0.17ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > happy settle: CLAIM (settling) → facilitator → CAPTURE (signature) → FULFILL (settled) [1.61ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > idempotency-key reuse on ANOTHER checkout ⇒ claim 23505 ⇒ conflict, NO money moves [0.37ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > DEFINITIVE verify rejection ⇒ terminal failed; no fulfillment, no money [0.20ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > VERIFY-phase transport error ⇒ RELEASE the claim to pending (no money moved, no failed) [0.24ms]
[x402-checkout] AMBIGUOUS SETTLE — facilitator /settle threw; money-state unknown; checkout=checkout-1 → reconcile (no re-settle)
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > SETTLE-phase error (ambiguous) ⇒ reconcile, NEVER pending (Codex round-2 BLOCKING) [0.52ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > post-settle independent proof failure preserves the signature and fulfills nothing [0.23ms]
[x402-checkout] SIGNATURE CONFLICT — settled tx SIG_TEST_1 already owned by another checkout; checkout=checkout-1 → reconcile (no fulfillment)
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > SIGNATURE CONFLICT: capture 23505 (sig owned by another checkout) ⇒ reconcile, fulfiller ZERO [0.35ms]
[x402-checkout] FULFILLMENT REFUSED AFTER SETTLE — USDC moved but could not be fulfilled; manual refund required. checkout=checkout-1 kind=tournament_entry refusal=inventory_changed tx=SIG_TEST_1
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > CAPTURE then REFUSAL preserves the receipt and blocks reuse by a top-up rail [0.45ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > RESUME: a captured row (settling + signature) re-fulfills WITHOUT re-calling the facilitator [0.34ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > settled row on load ⇒ idempotent replay; facilitator + fulfiller untouched [0.14ms]
[x402-checkout] settled row checkout-1 has NO tx_signature — refusing replay (corruption)
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > settled row WITHOUT a signature ⇒ replay REFUSED (Codex finding 5, corruption guard) [0.11ms]
[x402-checkout] STALE SETTLING CLAIM — checkout=checkout-1 settling 600s with no signature; money-state UNKNOWN → reconcile (no facilitator re-call)
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > STALE settling claim (no signature, aged) ⇒ reconcile, facilitator NOT re-called [0.33ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > FRESH settling claim (no signature, recent) ⇒ settle_in_flight (a concurrent settle owns it) [0.13ms]
(pass) x402-checkout — settle: durable claim → capture → resumable fulfill > foreign checkoutId (caller-bound row load misses) ⇒ checkout_not_found, facilitator untouched [0.11ms]
(pass) cosmetic_purchase fulfiller — conservation > grants the skin + enqueues the CLV buy on the SAME tx — ZERO ledger calls, no treasury credit [0.60ms]
(pass) cosmetic_purchase fulfiller — conservation > sub-second ownership race: no-op grant reports alreadyOwned, settle still completes, CLV buy still owed [0.29ms]
(pass) cosmetic_purchase fulfiller — conservation > sub-second stock race: refuses through the durable refund-required path and enqueues no CLV buy [0.27ms]
(pass) cosmetic_purchase fulfiller — conservation > quote resolver refuses a zero-priced SKU (unquotable as USDC) and an already-owned SKU [0.64ms]
(pass) cosmetic_purchase fulfiller — conservation > refuses the reward-only Kelp collectible on every purchasable checkout rail [0.10ms]
(pass) cosmetic_purchase fulfiller — conservation > quote resolver refuses a sold-out SKU for a non-owner [0.11ms]
(pass) cosmetic_purchase fulfiller — conservation > quote resolver detects ownership granted by an old rollout pod even when soldCount is stale [0.13ms]
(pass) rent_payment fulfiller — backed escrow emission > escrow += amount with NO avatar debit; audit row carries usd_basis; land lock order held [0.79ms]
(pass) rent_payment fulfiller — backed escrow emission > owner mismatch under the lock ⇒ CheckoutFulfillmentRefusal, NO escrow write [0.13ms]
(pass) rent_payment fulfiller — backed escrow emission > non-deposit tenure ⇒ refusal; NULL weekly rent ⇒ invalid_escrow_state; under-week top-up ⇒ grace NOT cleared [0.24ms]

src\services\__tests__\x402-facilitator-selection.test.ts:
(pass) x402 facilitator selection > keeps Meridian disabled as a strict no-op [0.09ms]
(pass) x402 facilitator selection > never falls back for payment-invalid/non-outage failures [0.02ms]
(pass) x402 facilitator selection > allows an inbound outage fallback independent of transaction size [0.02ms]
(pass) x402 facilitator selection > applies the $0.10 outbound crossover at the exact boundary [0.04ms]
(pass) x402 facilitator selection > rejects zero and negative outbound amounts [0.02ms]
(pass) x402 facilitator selection > does not select Meridian when a one-cent gross would net zero vCLAW [0.02ms]
(pass) x402 facilitator selection > classifies only structured transport/timeout/5xx failures as outages [0.11ms]
(pass) x402 Meridian settlement accounting > conserves gross at 0 platform basis points [0.07ms]
(pass) x402 Meridian settlement accounting > conserves gross at 1 platform basis points [0.01ms]
(pass) x402 Meridian settlement accounting > conserves gross at 250 platform basis points
(pass) x402 Meridian settlement accounting > conserves gross at 999 platform basis points
(pass) x402 Meridian settlement accounting > conserves gross at 1000 platform basis points
(pass) x402 Meridian settlement accounting > uses zero platform fee while retaining Meridian's 100 bps treasury fee [0.04ms]
(pass) x402 Meridian settlement accounting > uses the captured 1000 bps platform cap [0.06ms]
(pass) x402 Meridian settlement accounting > preserves legacy PayAI receipt semantics [0.04ms]
(pass) x402 Meridian settlement accounting > rejects a conserved settlement whose recipient net is zero [0.06ms]

src\services\__tests__\x402-inbound-custodial-wiring.test.ts:
(pass) B.1 inbound custodial activation wiring > requires explicit custodial:true and rejects mixing it with a client-signed header [0.08ms]
(pass) B.1 inbound custodial activation wiring > loads only the middleware-bound avatar wallet and pins both inbound rails to the merchant [0.06ms]
(pass) B.1 inbound custodial activation wiring > OPEN circuit preparation is Meridian-only and direct Meridian never records a PayAI failure [0.07ms]
(pass) B.1 inbound custodial activation wiring > both capture paths carry exact fee accounting into their durable global receipt [0.08ms]
(pass) B.1 inbound custodial activation wiring > does not alter or advertise a second accepts entry [0.07ms]

src\services\__tests__\x402-meridian-conformance.test.ts:
(pass) Meridian transfer_with_authorization capture fixture > locks discriminator, 66-byte layout, accounts, and sequential fee split [1.70ms]
(pass) Meridian transfer_with_authorization capture fixture > uses the program-id readonly placeholder at zero platform fee [0.81ms]
(pass) Meridian transfer_with_authorization capture fixture > derives the captured treasury USDC ATA with the platform-account helper [0.42ms]
(pass) Meridian transfer_with_authorization capture fixture > fails closed when a nonzero platform fee has no destination token account [0.53ms]
(pass) Meridian transfer_with_authorization capture fixture > rejects a noncanonical mint even when it is a valid Solana public key [0.36ms]
(pass) Meridian transfer_with_authorization capture fixture > rejects treasury fee drift from the captured 100 bps accounting contract [0.51ms]
(pass) Meridian v1 wire envelope > builds a partially signed v1 transaction with plain network strings [3.28ms]
(pass) Meridian v1 wire envelope > derives the platform token account from a trusted owner when bps is nonzero [4.46ms]
(pass) Meridian v1 wire envelope > refuses preparation for a non-merchant recipient when Meridian is enabled [0.57ms]
(pass) Meridian verify-to-settle sequencing > settles only after valid verify and sends the API key [5.42ms]
(pass) Meridian verify-to-settle sequencing > does not settle after a payment-invalid verify [0.72ms]
(pass) Meridian verify-to-settle sequencing > refuses a non-merchant payTo before calling Meridian [0.38ms]
(pass) Meridian verify-to-settle sequencing > classifies only HTTP 5xx as an outage while never throwing [3.90ms]
(pass) Meridian verify-to-settle sequencing > requires a nonempty settlement signature [1.20ms]
(pass) Meridian verify-to-settle sequencing > supports verify-only without reaching settle [0.68ms]
(pass) Meridian disabled configuration > is a no-op with every MERIDIAN_* variable unset [0.32ms]

src\services\__tests__\x402-meridian-fallback.test.ts:
[x402-payai] verify threw (treated as invalid): Facilitator verify failed (500): {"error":"mock_forced_facilitator_error"}
(pass) PayAI-primary Meridian fallback execution seam > uses Meridian after a PayAI verify HTTP 500 [2.89ms]
(pass) PayAI-primary Meridian fallback execution seam > does not fall back after PayAI rejects an invalid payment [0.61ms]
(pass) PayAI-primary Meridian fallback execution seam > skips PayAI entirely for a direct Meridian settlement [0.78ms]
(pass) PayAI-primary Meridian fallback execution seam > direct Meridian verify-only is non-ambiguous and never settles [0.47ms]
(pass) PayAI-primary Meridian fallback execution seam > classifies a Meridian verify rejection as definitive with no signature [0.55ms]
(pass) PayAI-primary Meridian fallback execution seam > classifies an explicit Meridian settle failure without a signature as definitive [0.72ms]
(pass) PayAI-primary Meridian fallback execution seam > promotes a signature on an explicit Meridian settle failure to reconciliation [0.67ms]

src\services\__tests__\x402-payai-auth.test.ts:
(pass) x402-payai — facilitator signed-JWT authentication > builds the historical anonymous client when neither credential is configured [0.22ms]
(pass) x402-payai — facilitator signed-JWT authentication > uses PayAI Bearer JWT auth for verify, settle, and supported [1.10ms]
(pass) x402-payai — facilitator signed-JWT authentication > stays anonymous when only the ID or only the secret is configured [0.17ms]
(pass) x402-payai — facilitator signed-JWT authentication > rebuilds the memoized client when credentials change [0.61ms]
(pass) x402-payai — facilitator signed-JWT authentication > never includes the API key secret in console output [0.16ms]

src\services\__tests__\x402-payai-conformance.test.ts:
(pass) PayAI exact-SVM golden wire vector > matches the documented PayAI v2 accepted requirement shape [24.69ms]
[x402-payai] verify threw (treated as invalid): Facilitator verify failed (400): {"error":"mock_forced_facilitator_client_error"}
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > maps verify-error-400 to settled:false without throwing or settling [1.29ms]
[x402-payai] verify threw (treated as invalid): Facilitator verify failed (500): {"error":"mock_forced_facilitator_error"}
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > maps verify-error to settled:false without throwing or settling [0.25ms]
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > gates settle when verify returns isValid:false [0.38ms]
[x402-payai] settle threw (treated as unsettled): Facilitator settle failed (400): {"error":"mock_forced_settlement_client_error"}
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > maps settle-error-400 to settled:false after a passing verify [1.14ms]
[x402-payai] settle threw (treated as unsettled): Facilitator settle failed (500): {"error":"mock_forced_settlement_error"}
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > maps settle-error to settled:false after a passing verify [0.52ms]
[x402-payai] settle threw (treated as unsettled): free_tier_exhausted: Mock facilitator quota exhausted.
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > marks the allowlisted free_tier_exhausted rejection as no-broadcast [0.74ms]
[x402-payai] settle threw (treated as unsettled): unknown reason: Mock rejection: FREE_TIER_EXHAUSTED.
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > matches an allowlisted typed rejection through its message when errorReason is absent [0.79ms]
[x402-payai] settle threw (treated as unsettled): not_free_tier_exhausted: Incidental message mentions free_tier_exhausted.
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > keeps a signature-less typed settle-rejected-unknown rejection ambiguous [0.72ms]
[x402-payai] settle threw (treated as unsettled): free_tier_exhausted_maybe: Mock rejection has no proven pre-broadcast reason.
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > keeps a signature-less typed settle-rejected-suffixed rejection ambiguous [0.47ms]
[x402-payai] settle threw (treated as unsettled): unknown reason: Mock rejection has no proven pre-broadcast reason.
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > keeps a signature-less typed settle-rejected-no-reason rejection ambiguous [0.42ms]
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > keeps a signature-less success:false response with an unknown reason ambiguous [0.65ms]
[x402-payai] settle threw (treated as unsettled): Facilitator settle failed (503): {"error":"free_tier_exhausted"}
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > does not trust allowlist text from a generic post-settle HTTP error [0.47ms]
[x402-payai] settle threw (treated as unsettled): free_tier_exhausted: Mock facilitator quota exhausted.
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > keeps a signature-bearing settle rejection ambiguous [0.55ms]
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > treats success:true with an empty transaction signature as unsettled [0.57ms]
(pass) PayAI verify-to-settle sequencing against the in-repo mock facilitator > forwards partner verifyOnly:true and never reaches settle [3.04ms]
(pass) agent-pay policy seam > refuses an above-cap payment before the signer-preparation seam is reached [0.21ms]

src\services\__tests__\x402-payai.test.ts:
(pass) x402-payai facilitator-level failure classification > counts exact quota, HTTP 5xx, and transport failures [0.13ms]
(pass) x402-payai facilitator-level failure classification > does not count payment-specific rejections [0.09ms]
(pass) x402-payai — A3 ¢-peg store buy-price ($0.01/coin) > CT_PER_USDC is 100 (the A3 ¢-peg rate, was 10 at the F2 $0.10/coin rate) [0.02ms]
(pass) x402-payai — A3 ¢-peg store buy-price ($0.01/coin) > usdToCt($10) = 1000 vCLAW — the headline store price [0.02ms]
(pass) x402-payai — A3 ¢-peg store buy-price ($0.01/coin) > usdToCt($1) = 100 vCLAW (1 USDC buys 100 coins at the ¢-peg) [0.03ms]
(pass) x402-payai — A3 ¢-peg store buy-price ($0.01/coin) > usdToCt($100) = 10000 vCLAW (linear in the amount) [0.02ms]
(pass) x402-payai — A3 ¢-peg store buy-price ($0.01/coin) > mints a whole coin per cent at the ¢-peg (1¢ → 1 unit, no longer floors to 0) [0.02ms]
(pass) x402-payai — A3 ¢-peg store buy-price ($0.01/coin) > rejects a non-positive / non-integer cents amount [0.06ms]
(pass) x402-payai — USDC atomic conversion is rate-independent > 1 cent → "10000" atomic micro-USDC (6-decimal USDC, 2-decimal USD) [0.04ms]
(pass) x402-payai — USDC atomic conversion is rate-independent > $1 (100 cents) → "1000000" = 1 USDC [0.01ms]
(pass) x402-payai — USDC atomic conversion is rate-independent > $10 (1000 cents) → "10000000" = 10 USDC (the on-chain amount the buyer pays) [0.01ms]
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > buildPartnerPurchaseQuote binds payTo to the partner payout pubkey + the on-chain USDC amount [0.14ms]
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > HAPPY: verify→settle against the partner payout pubkey settles with a non-empty tx signature [1.78ms]
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > NO-CUSTODY binding: payTo ≠ expectedPayoutPubkey settles NOTHING and never calls the facilitator [0.12ms]
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > NO-CUSTODY binding: an empty expectedPayoutPubkey also settles NOTHING [0.09ms]
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > INVALID: facilitator verify rejection → not settled, settle never runs [0.42ms]
[x402-payai] verify threw (treated as invalid): Facilitator verify failed (500): {"error":"mock_forced_facilitator_error"}
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > NEVER-THROWS (facilitator HTTP 500 on verify): resolves to settled:false, not a throw [0.39ms]
[x402-payai] verify threw (treated as invalid): Unable to connect. Is the computer able to access the url?
(pass) x402-payai — partner direct-USDC primitives (mock-facilitator harness) > NEVER-THROWS (facilitator unreachable): resolves to settled:false, not a throw [0.54ms]
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > buildTopupQuote includes extra.feePayer when provided (and keeps provenance keys) [0.06ms]
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > buildTopupQuote WITHOUT feePayer omits the key entirely (mock-path back-compat) [0.04ms]
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > buildPartnerPurchaseQuote passes feePayer through to the shared primitive [0.05ms]
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > resolveFacilitatorFeePayer: X402_FEE_PAYER env override wins without any fetch [0.28ms]
[x402-payai] X402_FEE_PAYER is set but not a base58 pubkey — ignoring
[x402-payai] X402_FEE_PAYER is set but not a base58 pubkey — ignoring
[x402-payai] X402_FEE_PAYER is set but not a base58 pubkey — ignoring
[x402-payai] X402_FEE_PAYER is set but not a base58 pubkey — ignoring
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > resolveFacilitatorFeePayer: malformed env override is IGNORED (not propagated) [0.96ms]
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > resolveFacilitatorFeePayer: unreachable facilitator → null, never throws [0.25ms]
(pass) x402-payai — facilitator feePayer (SVM exact scheme requirement) > resolveFacilitatorFeePayer: reads kinds[].extra.feePayer from /supported and memoizes [6.41ms]

src\services\__tests__\x402-reconcile-apply.test.ts:
(pass) reconcile durable observation stores > excludes a signature observed only in another agent payment reconcile column [0.62ms]
(pass) reconcile durable observation stores > merges verdict metadata under the reconcile status guard without changing anchors [0.58ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"applied_capture_fulfill","detail":"verified signature captured; settle-machine fulfillment invoked","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > captures a verified checkout and invokes its own fulfiller exactly once; second scan is a no-op [1.50ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"applied_refund_required","detail":"durable refund-required evidence recorded; no refund sent","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > turns a capture signature conflict into durable refund-required and never fulfills [0.35ms]
[reconcile] ct_topups ct_topups-1 reason=signature_conflict → verify_signature (refund_required, sig=verified-signature) — signature owned by another checkout; contested → refund-required-with-signature
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"ct_topups-1","action":"applied_refund_required","detail":"durable refund-required evidence recorded; no refund sent","signature":"verified-signature"}
[reconcile] ct_topups ct_topups-1 reason=signature_conflict → manual_review — refund already durably required; awaiting operator executor
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"ct_topups-1","action":"manual_review","detail":"refund already durably required; awaiting operator executor","signature":null}
(pass) x402 reconcile apply orchestration > records an explicit refund-required recommendation once; repeat is manual with no second alert [0.21ms]
[reconcile] ct_topups old reason=stale_settling → probe_merchant (amount=1000000 atomic, payer=unknown, since=2026-07-11T00:01:00.000Z) — stale_settling: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"old","action":"applied_no_money","detail":"no payment found after grace; reconcile→failed","signature":null}
[reconcile] ct_topups young reason=stale_settling → probe_merchant (amount=1000000 atomic, payer=unknown, since=2026-07-13T11:30:00.000Z) — stale_settling: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)
{"event":"x402_reconcile_action","table":"ct_topups","rowId":"young","action":"skipped","detail":"no match, but row remains inside no-money grace window","signature":null}
(pass) x402 reconcile apply orchestration > fails an old no-money row but leaves a younger row untouched [0.40ms]
(pass) x402 reconcile apply orchestration > defaults blank, unset, and non-numeric no-money grace to 24h; explicit numbers retain the 1h floor [0.06ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"skipped","detail":"capture CAS lost","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > does not mutate or fulfill when the capture CAS is lost [0.14ms]
[reconcile] agent_payments agent_payments-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"agent_payments","rowId":"agent_payments-1","action":"applied_capture_fulfill","detail":"verified signature captured; settle-machine fulfillment invoked","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > captures and fulfills agent_payments using recipientWallet and metadata.network fallback [0.19ms]
(pass) x402 reconcile apply orchestration > F6 restores exact Meridian fee columns from durable reconcile evidence before fulfillment [0.22ms]
(pass) x402 reconcile apply orchestration > F6 refuses to infer Meridian when durable reconcile accounting is incomplete or non-conserving [0.14ms]
(pass) x402 reconcile apply orchestration > normalizes observed agent reconcile signatures to capture_lost and unknown no-signature failures to ambiguous [0.04ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
[reconcile] scanned 1 reconcile row(s) across x402_checkouts + ct_topups + agent_payments (DRY-RUN — no state changed)
(pass) x402 reconcile apply orchestration > defaults to dry-run even when env consent is present and performs no chain/apply calls [0.11ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=settle_ambiguous → probe_merchant (amount=1000000 atomic, payer=unknown, since=2026-07-11T00:01:00.000Z) — settle_ambiguous: probe merchant wallet for a matching inbound USDC payment (found → capture+fulfill; none → no-money terminal)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"skipped","detail":"probe indeterminate: lookback_cap_exhausted","signature":null}
(pass) x402 reconcile apply orchestration > treats a capped/indeterminate probe as skipped, never no-money [0.15ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"applied_capture_pending","detail":"signature captured; settle-machine fulfillment returned non-success and remains resumable","signature":"verified-signature"}
(pass) x402 reconcile apply orchestration > keeps a captured row resumable when its native fulfiller returns non-success [0.20ms]
[reconcile] x402_checkouts x402_checkouts-1 reason=capture_lost → verify_signature (capture_fulfill, sig=verified-signature) — settled but capture-lost; verify on-chain then capture + fulfill (money is ours)
{"event":"x402_reconcile_action","table":"x402_checkouts","rowId":"x402_checkouts-1","action":"skipped","detail":"fail-soft: config unavailable","signature":null}
(pass) x402 reconcile apply orchestration > fails soft per row when config resolution throws [0.31ms]
(pass) x402 reconcile apply orchestration > requires explicit apply plus env consent and validates CLI row selectors [0.34ms]

src\services\__tests__\x402-settlement-guards.test.ts:
(pass) production facilitator origin guard > allows only the exact production origins over credential-free HTTPS [0.31ms]
(pass) production facilitator origin guard > does not constrain staging or local test facilitators [0.06ms]
(pass) global receipt owner identity > resumes only the exact same immutable owner [0.07ms]
(pass) post-decode RPC setup failure > retains the signed payer and refuses unbound capture when no payer was decoded [0.05ms]
(pass) independent settlement transaction binding > accepts the submitted message and rejects an older matching-payer transaction [3.74ms]

src\services\__tests__\x402-verify-only.test.ts:
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > a PASSING verify in verifyOnly mode NEVER calls /settle and reports the sentinel [1.40ms]
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > a FAILING verify in verifyOnly mode reports isValid:false (and still no /settle) [0.36ms]
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > LIVE mode still settles only after a passing verify (regression guard) [0.63ms]
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > LIVE mode with a failing verify never reaches /settle (unchanged contract) [0.29ms]
[x402-payai] independent settlement proof failed {
  reason: "independent_chain_mismatch",
  txPrefix: "FakeSig1",
}
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > post-settle independent mismatch preserves the observed signature for reconciliation [0.64ms]
[x402-payai] independent settlement proof failed {
  reason: "independent_chain_unavailable",
  txPrefix: "FakeSig1",
}
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > a thrown independent verifier is fail-closed with durable signature evidence [0.63ms]
[x402-payai] independent settlement proof failed {
  reason: "independent_chain_unavailable",
  txPrefix: "FakeSig1",
}
(pass) verifyAndSettle — verifyOnly (payai dry-run posture) > chain-unavailable reconciliation uses signed-payload payer, never facilitator payer [0.73ms]

src\services\__tests__\xp-service.test.ts:
(pass) awardXp concurrency > serializes threshold-crossing awards and mints one level-up bonus [1.33ms]
(pass) awardXp concurrency > rolls back XP metadata when the ledger mint fails [0.28ms]

112 tests skipped:
(skip) covenant stream (DB) > recordCovenantAction inserts a row whose payload_hash is recomputable
(skip) covenant stream (DB) > in-tx record rolls back with the business write (no orphan record)
(skip) covenant stream (DB) > sealer chains unsealed rows in order and is re-runnable
(skip) covenant stream (DB) > tamper trigger: UPDATE of identity columns and DELETE are refused
(skip) covenant stream (DB) > dedupe key: a retry appends exactly one record (Codex r1 HIGH #2)
(skip) covenant stream (DB) > pre-sealed INSERT is refused by the guard trigger (Codex r1 HIGH #5)
(skip) covenant stream (DB) > sealer refuses a row whose stored payload_hash mismatches (Codex r1 HIGH #5)
(skip) covenant stream (DB) > ledger credit/debit emit coupled economy records atomically
(skip) material-ledger (real DB) > (unnamed)
(skip) material-ledger (real DB) > reads zero for an avatar that has never earned a material
(skip) material-ledger (real DB) > credits lazily create the balance row and accumulate
(skip) material-ledger (real DB) > debits decrement the pooled balance
(skip) material-ledger (real DB) > a spend at balance + 1 refuses and writes NOTHING
(skip) material-ledger (real DB) > a spend of the ENTIRE balance succeeds and lands exactly on zero
(skip) material-ledger (real DB) > a composed debit rolls back with the caller transaction
(skip) material-ledger (real DB) > concurrent credits conserve the total (no lost update)
(skip) material-ledger (real DB) > concurrent oversubscribed debits admit exactly the affordable count and never go negative
(skip) material-ledger (real DB) > rejects a credit for an avatar that does not exist
(skip) material-ledger (real DB) > rejects non-positive and non-integer amounts on both primitives
(skip) material-ledger (real DB) > (unnamed)
(skip) quest faucet excludes the house fleet (real DB) > identifies the live house fleet and refuses every one of them
(skip) quest faucet excludes the house fleet (real DB) > still refuses a house agentId presented with a plausible session id
(skip) quest faucet excludes the house fleet (real DB) > does not treat an ordinary (non-house) agentId as house
(skip) salvage settlement (real DB) > (unnamed)
(skip) salvage settlement (real DB) > HMAC yield > is deterministic for the same (avatar, node, ordinal)
(skip) salvage settlement (real DB) > HMAC yield > stays inside the 1-3 band for a long ordinal run
(skip) salvage settlement (real DB) > HMAC yield > uses all three outcomes rather than collapsing to one
(skip) salvage settlement (real DB) > HMAC yield > DEPENDS ON THE SECRET — this is what makes it unfarmable
(skip) salvage settlement (real DB) > HMAC yield > separates avatars and nodes in the derivation
(skip) salvage settlement (real DB) > fingerprint > excludes the ordinal, so a legitimate replay is not a conflict
(skip) salvage settlement (real DB) > fingerprint > changes with the layout version, so a re-layout cannot alias an old key
(skip) salvage settlement (real DB) > a fresh claim > (unnamed)
(skip) salvage settlement (real DB) > a fresh claim > credits materials, sets a cooldown, and burns exactly one admission
(skip) salvage settlement (real DB) > a fresh claim > refuses the same node again — the cooldown is live
(skip) salvage settlement (real DB) > a fresh claim > consumes NO admission on the refused cooldown claim
(skip) salvage settlement (real DB) > a fresh claim > refuses a node outside the frozen layout without touching state
(skip) salvage settlement (real DB) > a fresh claim > stamps the UTC day from the DATABASE clock, not the node process
(skip) salvage settlement (real DB) > idempotency > (unnamed)
(skip) salvage settlement (real DB) > idempotency > replays the original response and pays only once
(skip) salvage settlement (real DB) > idempotency > replays WITHOUT consuming a cooldown or an admission
(skip) salvage settlement (real DB) > idempotency > 409s the same key aimed at a DIFFERENT node
(skip) salvage settlement (real DB) > idempotency > still replays verbatim after a LATER claim advanced other ordinals
(skip) salvage settlement (real DB) > per-avatar daily cap > (unnamed)
(skip) salvage settlement (real DB) > per-avatar daily cap > admits EXACTLY 20 of 21 concurrent unique-node claims
(skip) salvage settlement (real DB) > per-avatar daily cap > leaves the counter exactly at the cap — never over
(skip) salvage settlement (real DB) > per-avatar daily cap > credited exactly what it issued — no material appears from nowhere
(skip) salvage settlement (real DB) > per-avatar daily cap > does NOT charge the owner budget for the claim it refused
(skip) salvage settlement (real DB) > per-owner daily cap (the anti-fleet bound) > (unnamed)
(skip) salvage settlement (real DB) > per-owner daily cap (the anti-fleet bound) > refuses once the owner budget is spent, even with avatar budget left
(skip) salvage settlement (real DB) > per-owner daily cap (the anti-fleet bound) > the conditional upsert alone admits exactly the cap under raw concurrency
(skip) salvage settlement (real DB) > eligibility > (unnamed)
(skip) salvage settlement (real DB) > eligibility > refuses a HOUSE actor — the fleet earns nothing from a faucet
(skip) salvage settlement (real DB) > eligibility > refuses when the live session no longer matches the captured binding
(skip) salvage settlement (real DB) > eligibility > refuses a session that is no longer ledger-capable
(skip) salvage settlement (real DB) > eligibility > refuses when the session resolver returns nothing at all
(skip) salvage settlement (real DB) > eligibility > refuses when the avatar no longer belongs to the locked principal
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > (unnamed)
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > is off, and reports off
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > pays ZERO vCLAW and leaves the balance untouched on a real claim
(skip) salvage settlement (real DB) > the §2.10 vCLAW bounty (DARK per founder ruling Q1) > only reads the exact string "true" — no fuzzy booleans on a money rail
(skip) salvage settlement (real DB) > readSalvageState > (unnamed)
(skip) salvage settlement (real DB) > readSalvageState > reports every node, with the claimed one cooling
(skip) salvage settlement (real DB) > readSalvageState > carries the node geometry the renderer draws, unchanged
(skip) salvage settlement (real DB) > (unnamed)
(skip) service slot rent sweeper (real DB) > (unnamed)
(skip) service slot rent sweeper (real DB) > skips a listing whose week is already paid
(skip) service slot rent sweeper (real DB) > charges exactly one week when due and advances the cursor
(skip) service slot rent sweeper (real DB) > does NOT charge a second time for the same week
(skip) service slot rent sweeper (real DB) > charges once, not twice, when two sweeps race the same due week
(skip) service slot rent sweeper (real DB) > adds the featured rent on its own cursor when featured is on
(skip) service slot rent sweeper (real DB) > SUSPENDS rather than deleting when the owner cannot pay, and charges nothing
(skip) service slot rent sweeper (real DB) > restores a suspended listing automatically once the owner can pay
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > (unnamed)
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > grants the genuine free week to a shop FIRST listing
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > does NOT grant a second free week on delist + recreate
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > makes a recreated listing due immediately when the shop already lapsed
(skip) service slot rent sweeper (real DB) > free-week grant (delist/recreate bypass) > (unnamed)
(skip) service slot rent sweeper (real DB) > public-board featured ordering > ranks only a PAID featured listing first
(skip) service slot rent sweeper (real DB) > public-board featured ordering > pins an UNPAID featured-pending row first without the COALESCE (regression lock)
(skip) service slot rent sweeper (real DB) > public-board featured ordering > uses the COALESCE form on the actual public board query
(skip) service slot rent sweeper (real DB) > skips a delisted listing entirely
(skip) service slot rent sweeper (real DB) > (unnamed)
(skip) trade observer delta integration (requires DATABASE_URL) > stores a trade at the binding slot as pre_bind without a leaderboard event
(skip) trade observer delta integration (requires DATABASE_URL) > scores a same-second trade when its slot is greater than the binding slot
(skip) trade observer delta integration (requires DATABASE_URL) > invokes the callback once for a fresh verified signature
(skip) trade observer delta integration (requires DATABASE_URL) > keeps an unregistered callback as a silent no-op
(skip) trade observer delta integration (requires DATABASE_URL) > awaits the callback before broadcasting the verified frame
(skip) trade observer delta integration (requires DATABASE_URL) > contains a throwing callback after scoring and alerts exactly once
(skip) trade observer delta integration (requires DATABASE_URL) > rolls back and returns a retryable report error when strict event insertion fails
(skip) trade observer delta integration (requires DATABASE_URL) > rolls back and rethrows the strict event failure to the observer caller
(skip) trade observer delta integration (requires DATABASE_URL) > notifies with the enriched decision before the enrichment frame
(skip) trade observer delta integration (requires DATABASE_URL) > lets prime win the insert race without observer overwrite or duplicate effects
(skip) trade observer delta integration (requires DATABASE_URL) > looks up a verified signature without returning its wallet address
(skip) trade observer delta integration (requires DATABASE_URL) > returns verified false for an unknown signature
(skip) trade verifier > TODO-FIXTURE: no recorded spl-transfer-not-a-swap.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded unused-jupiter-key.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded memo-carrying-dex-address.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded pumpswap-liquidity-deposit.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded pumpswap-liquidity-withdraw.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded pumpfun-creator-fee-claim.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded dex-tx-with-unrelated-transfer.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded sponsored-swap.json was supplied
(skip) trade verifier > TODO-FIXTURE: no recorded alt-resolved-execution.json was supplied
(skip) tutorial quest settlement (real DB) > (unnamed)
(skip) tutorial quest settlement (real DB) > settles a legacy quest on the vCLAW rail and leaves the materials rail at zero
(skip) tutorial quest settlement (real DB) > settles a land quest on the MATERIALS rail with no vCLAW and no ledger row
(skip) tutorial quest settlement (real DB) > replays an already-claimed quest without paying twice, whichever subject asks
(skip) tutorial quest settlement (real DB) > admits exactly one of eight concurrent claims of the same quest
(skip) tutorial quest settlement (real DB) > refuses an unknown quest and an unqualified one, writing nothing either way
(skip) tutorial quest settlement (real DB) > lets the database refuse a double-railed or rewardless claim row
(skip) tutorial quest settlement (real DB) > runs the REAL land predicates against canonical land state
(skip) tutorial quest settlement (real DB) > (unnamed)

 2222 pass
 112 skip
 0 fail
 18864 expect() calls
Ran 2334 tests across 145 files. [6.99s]
```

### 8.3 Route main group

Command: cd apps/api && bun test <all route test files except the CI isolated list>

Exit code: 0

```text
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\activities-party.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ⌘ enable debugging { debug: true }
(skip) activities party routes (requires DATABASE_URL) > (unnamed)
(skip) activities party routes (requires DATABASE_URL) > runs create -> me -> join -> kick -> leave with named members and leader succession
(skip) activities party routes (requires DATABASE_URL) > returns 404 for an unknown valid short code and 400 for non-Crockford input
(skip) activities party routes (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\agent-control-link-schema.test.ts:
[AutonomyStandby] active -> active (reason: default)
(pass) agent control-link identity schema > accepts exactly the four supported public identity types [7.06ms]

src\routes\__tests__\agent-paid-surface.test.ts:
[x402] Paywall DISABLED (set X402_ENABLED=true to activate).
(pass) agent paid surfaces > declares exact x402 prices for both real offerings [0.20ms]
(pass) agent paid surfaces > registers payment and both paid offerings in the universal tool bundle [0.09ms]
(pass) agent paid surfaces > publishes the additive commerce and default-off exit contract [0.97ms]
(pass) agent paid surfaces > rejects malformed expert requests before service execution [3.67ms]
(pass) agent paid surfaces > makes an empty expert result non-settleable [0.03ms]
(pass) agent paid surfaces > rejects an overlong analytics id before querying the leaderboard [0.35ms]

src\routes\__tests__\agent-pay-rate-limit.test.ts:
(pass) POST /api/agent-pay subject rate limit > allows six requests per resolved avatar and returns the 429 wire on the seventh [2.36ms]
(pass) POST /api/agent-pay subject rate limit > keeps another resolved avatar in an independent bucket [0.05ms]

src\routes\__tests__\agent-session-ack.test.ts:
(pass) POST /api/agent/session/ack > returns 401 when no Lucia or agent session is present [1.12ms]
(pass) POST /api/agent/session/ack > rejects a resolved Lucia human with 403 [0.36ms]
(pass) POST /api/agent/session/ack > rejects a liveness-only (ownership-unproven) agent session with 403 [0.09ms]
(pass) POST /api/agent/session/ack > accepts the exact current manual hash and optional matching version [0.48ms]
(pass) POST /api/agent/session/ack > rejects stale manual version/hash without storing [0.30ms]
(pass) POST /api/agent/session/ack > normalizes skill wire/DB hash formats (sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa vs aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) [0.18ms]
(pass) POST /api/agent/session/ack > normalizes skill wire/DB hash formats (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa vs sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) [0.03ms]
(pass) POST /api/agent/session/ack > treats a %s DB content_hash as unknown and stores nothing [0.12ms]
(pass) POST /api/agent/session/ack > treats a not-a-hash DB content_hash as unknown and stores nothing [0.02ms]
(pass) POST /api/agent/session/ack > returns canonical latest for an unknown skill hash and stores nothing [0.14ms]
(pass) POST /api/agent/session/ack > returns the transaction-observed latest when a concurrent regeneration wins [0.24ms]
(pass) POST /api/agent/session/ack > limits a stable agent subject to 30 acknowledgements per minute [6.34ms]
(pass) mergeAgentBotAck > preserves manual and sibling skills across repeat ACKs while dropping unknown ids [0.43ms]

src\routes\__tests__\auth-json-body.test.ts:
(pass) public auth JSON body parsing > returns 400 for an empty login body without touching the database [1.32ms]
(pass) public auth JSON body parsing > returns 400 for a malformed login body without touching the database [0.16ms]
(pass) public auth JSON body parsing > keeps the anti-enumeration generic 200 for empty and malformed forgot-password bodies [0.47ms]
18 | function getDb() {
19 |     if (_db)
20 |         return _db;
21 |     const connectionString = process.env.DATABASE_URL;
22 |     if (!connectionString) {
23 |         throw new Error('DATABASE_URL environment variable is not set');
                       ^
error: DATABASE_URL environment variable is not set
      at getDb (C:\Users\itachi\Documents\Crypto\cv-floor\packages\database\dist\index.js:23:19)
      at get (C:\Users\itachi\Documents\Crypto\cv-floor\packages\database\dist\index.js:62:16)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\auth.ts:1297:9)
      at async dispatch (C:\Users\itachi\Documents\Crypto\cv-floor\node_modules\.bun\hono@4.12.12\node_modules\hono\dist\compose.js:22:23)

(pass) public auth JSON body parsing > does not 400 a bodyless guest signup (coerces to {} — the pre-fix contract) [0.88ms]
(skip) public auth JSON body parsing (requires DATABASE_URL) > keeps valid-shape unknown credentials on the existing 401 path

src\routes\__tests__\autonomy-standby-route.test.ts:
(pass) dashboard autonomy standby routes > rejects a non-admin caller [1.33ms]
[AutonomyStandby] active -> standby (reason: manual)
[AutonomyStandby] standby -> active (reason: armed 120min)
[AutonomyStandby] active -> standby (reason: manual)
(pass) dashboard autonomy standby routes > round-trips arm and standby state for an admin [1.36ms]
(pass) dashboard autonomy standby routes > Zod-rejects invalid arm input [0.23ms]

src\routes\__tests__\bounties-create.test.ts:
(pass) bounty create reward floors > accepts a USDC-funded bounty at 5 vCLAW [1.09ms]
(pass) bounty create reward floors > rejects a USDC-funded bounty below 5 vCLAW [0.21ms]
(pass) bounty create reward floors > accepts the Tier-1 $50 cap and rejects one cent above [0.23ms]
(pass) bounty create reward floors > does not let env raise the founder-frozen $50 ceiling [0.43ms]
(pass) bounty create reward floors > accepts an in-game bounty at 5 vCLAW and defaults its rail to vclaw [0.10ms]
(pass) bounty create reward floors > rejects an in-game bounty below 5 vCLAW [0.15ms]

src\routes\__tests__\chat-moderation.test.ts:
[moderation] BLOCKED {
  surface: "test-chat",
  direction: "input",
  backend: "test",
  categories: [ "hate" ],
  hash: "727f0b0e1543",
  latencyMs: 0,
}
(pass) chat moderation — behavior > blocked input → 400 content_blocked and the LLM is never called [1.05ms]
(pass) chat moderation — behavior > clean input → reaches the LLM and returns ok [0.26ms]
(pass) chat moderation — structural regression lock > chat.ts moderates input at surface 'system-chat' and blocks with content_blocked [0.32ms]
(pass) chat moderation — structural regression lock > chat.ts moderates input at surface 'location-chat' and blocks with content_blocked [0.10ms]
(pass) chat moderation — structural regression lock > chat-transient.ts moderates input at surface 'transient-chat' and blocks with content_blocked [0.10ms]
(pass) chat moderation — structural regression lock > avatars.ts moderates input at surface 'avatar-chat' and blocks with content_blocked [0.18ms]
(pass) chat moderation — structural regression lock > avatars.ts moderates input at surface 'avatar-directive' and blocks with content_blocked [0.16ms]
(pass) chat moderation — structural regression lock > chat.ts moderates OUTPUT for both public personas (system + location) [0.16ms]

src\routes\__tests__\cosmetic-supply-guard.test.ts:
(pass) cosmetic supply rolling-deploy guard > claims stock at the avatar_skins insertion boundary for old and new pods [0.04ms]
(pass) cosmetic supply rolling-deploy guard > ON CONFLICT idempotent retries cannot consume stock [0.04ms]

src\routes\__tests__\cove-autonomous-settlement.db.test.ts:
(skip) autonomous Cove settlement — real PostgreSQL money path > (unnamed)
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: one autonomous spin writes the gross stake debit and exact net avatar delta
(skip) autonomous Cove settlement — real PostgreSQL money path > house/hosted: an inactive bound house avatar settles real slots and blackjack through the world action
(skip) autonomous Cove settlement — real PostgreSQL money path > house resolver: a non-house agent with an invalid session still drops before settlement
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: daily cap consumes gross tagged debits and a refused second play writes no debit
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: changed live binding is rejected before any ledger write
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: an avatar deactivated after inner resolution is rejected by the transaction binding lock
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: owner-scoped action replay survives session rotation and mismatched args return 409
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: invalid, non-ledger, and unbound resolution never reaches settlement
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: the real internal spin rate gate refuses request 61 with no settlement write
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: a raked autonomous hand settles stake, payout, treasury, history, and balance invariants
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: 4x worst-case cap rejects before shoe, cards, history, or ledger mutation
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: action replay is owner-scoped across shoe rotation and never settles twice
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: daily usage is counted by DB UTC date_trunc(now()), including midnight and excluding the prior second
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: binding, active-avatar, non-ledger, and unbound failures write no hand or debit
(skip) autonomous Cove settlement — real PostgreSQL money path > (unnamed)

src\routes\__tests__\cove-baccarat.route.test.ts:
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > derives a literal-first provisional bucket without retaining an agent bearer [0.26ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > builds a settled-coup recovery DTO with no balance or replay marker [0.12ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > replays after shoe close before the status gate [0.34ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > replays after balance falls below stake before affordability [0.11ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > rechecks replay when a concurrent settle drains affordability after the first miss [0.34ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > replays a threshold-crossing lost response while a fresh coup is gated [0.23ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > returns 409 for a settled key reused with a different tuple [0.07ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > serializes two concurrent first requests into one settle plus one replay [0.53ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > reads shoe, newest coup, and current balance coherently under the shoe lock [0.40ms]
(pass) Cove Baccarat Wave W-D route contract (DB-free injected gates) > guest rotation reveals only the closed seed and conserves demo balance [0.33ms]

src\routes\__tests__\cove-blackjack.test.ts:
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > (unnamed)
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > GET /hand/current — visible view only (no hole/undealt/seed) > returns player cards + dealer UPCARD and leaks NO hidden state
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > POST /hand/deal — stale_agent_deal epoch guard > rejects a deal at an old handCounter epoch, accepts at the current one
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > POST /action — stale_agent_decision version guard > rejects an action at a stale handVersion, accepts at the live one
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > POST /action — stale_agent_decision version guard > insure honors expectedHandVersion (parity fix) and replays a settled hand
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > settleHand — binds the hand to the locked shoe (hand_shoe_mismatch) > a caller-owned shoeId + a foreign handId resolves to 409, never settles it
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\cove-blackjack-autonomous-basic-strategy.test.ts:
(pass) autonomous cove blackjack basic-strategy hand builder > resolves deterministic hands with bounded exposure and valid terminal scripts [75.49ms]

src\routes\__tests__\cove-guest-demo-routing.test.ts:
(pass) cove guest-account → demo-subject routing lock > cove-slots.ts > imports isGuestUser from the shared require-non-guest middleware [0.31ms]
(pass) cove guest-account → demo-subject routing lock > cove-slots.ts > getSubject's if(user) branch checks isGuestUser BEFORE returning kind:'user' [0.16ms]
(pass) cove guest-account → demo-subject routing lock > cove-slots.ts > getSubject does NOT 403 a guest account (guests keep playing on demo CT) [0.18ms]
(pass) cove guest-account → demo-subject routing lock > cove-blackjack.ts > imports isGuestUser from the shared require-non-guest middleware [0.25ms]
(pass) cove guest-account → demo-subject routing lock > cove-blackjack.ts > getSubject's if(user) branch checks isGuestUser BEFORE returning kind:'user' [0.02ms]
(pass) cove guest-account → demo-subject routing lock > cove-blackjack.ts > getSubject does NOT 403 a guest account (guests keep playing on demo CT) [0.02ms]
(pass) cove guest-account → demo-subject routing lock > cove-baccarat.ts > imports isGuestUser from the shared require-non-guest middleware [0.15ms]
(pass) cove guest-account → demo-subject routing lock > cove-baccarat.ts > getSubject's if(user) branch checks isGuestUser BEFORE returning kind:'user' [0.01ms]
(pass) cove guest-account → demo-subject routing lock > cove-baccarat.ts > getSubject does NOT 403 a guest account (guests keep playing on demo CT) [0.01ms]
(pass) cove guest-account → demo-subject routing lock > cove-holdem.ts > imports isGuestUser from the shared require-non-guest middleware [0.23ms]
(pass) cove guest-account → demo-subject routing lock > cove-holdem.ts > getSubject's if(user) branch checks isGuestUser BEFORE returning kind:'user' [0.02ms]
(pass) cove guest-account → demo-subject routing lock > cove-holdem.ts > getSubject does NOT 403 a guest account (guests keep playing on demo CT) [0.02ms]
(pass) cove guest-account → demo-subject routing lock > the shared guestDemoSubject(...) constructor exists in every file (DRY demo-subject path) [0.29ms]

src\routes\__tests__\cove-holdem-resync.test.ts:
(pass) cove-holdem — buildInProgressHandView (resync view builder) > every view board length === the visible-street count, NEVER more [212.84ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > a fresh hand (actions=[]) at a preflop decision reveals ZERO board cards [25.27ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > NEVER exposes a `seats` array or any bot hole cards — humanHole is exactly seat 0 [22.73ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > NEVER exposes the table serverSeed on the wire view [0.25ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > smallBlindSeat / bigBlindSeat derive from buttonSeat mod SEATS for every button [1.99ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > handId round-trips from the row unchanged [0.18ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > a deeper street view is a strict prefix of the eventual full board [158.22ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > actions field accepts a non-array value defensively (treated as empty) [0.48ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > public logs grow as strict prefixes and the settled log extends every view [142.13ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > never includes the synthetic fold or any post-fold continuation [0.12ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > includes both blind posts in the first preflop public view [0.51ms]
(pass) cove-holdem — buildInProgressHandView (resync view builder) > does not build an in-progress peek after the human goes all-in [0.21ms]
(pass) deriveHoldemPublicSeats > uses last-per-street commitments across a raise re-commit and a fold [0.23ms]
(pass) deriveHoldemPublicSeats > keeps decimal bigint strings exact beyond Number.MAX_SAFE_INTEGER [0.06ms]

src\routes\__tests__\cove-slots.test.ts:
(pass) Cove Slots — paytable + verify (no DB) > resolves the autonomous daily wager cap with a 10000 default and 20 hard floor [0.23ms]
(pass) Cove Slots — paytable + verify (no DB) > refuses an already-over-cap mismatched session before close/open mutation [1.21ms]
(pass) Cove Slots — paytable + verify (no DB) > fails a changed autonomous agent/avatar/user binding before session or cap reads [0.37ms]
(pass) Cove Slots — paytable + verify (no DB) > replays the owner-scoped settled action from S1 before reading or mutating S2 [0.56ms]
(pass) Cove Slots — paytable + verify (no DB) > does not replay another owner's coincident action key [0.32ms]
(pass) Cove Slots — paytable + verify (no DB) > rejects a same-owner action replay with a different wager before mutation [0.21ms]
(pass) Cove Slots — paytable + verify (no DB) > authoritatively catches a cross-session replay after a stale adapter miss [0.43ms]
(pass) Cove Slots — paytable + verify (no DB) > transaction recheck rejects a cross-session wager conflict before money work [0.20ms]
(pass) Cove Slots — paytable + verify (no DB) > locks the exact autonomous avatar and rejects inactive or wrong-owner rows [0.35ms]
(pass) Cove Slots — paytable + verify (no DB) > permits an inactive autonomous avatar only with a live exact house binding [0.11ms]
(pass) Cove Slots — paytable + verify (no DB) > GET /paytables/classic-3x5 returns the public bundle [3.88ms]
(pass) Cove Slots — paytable + verify (no DB) > GET /paytables/unknown returns 404 [0.32ms]
(pass) Cove Slots — paytable + verify (no DB) > POST /verify replays a known-seed spin and matches the engine [1.95ms]
(pass) Cove Slots — paytable + verify (no DB) > POST /verify rejects malformed serverSeed [0.60ms]
(pass) Cove Slots — paytable + verify (no DB) > POST /verify rejects non-positive predict [0.28ms]
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > (unnamed)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > returns 200 + hash + clientSeed (no serverSeed leak)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > is idempotent — second /open returns 200 with the existing session
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > refuses 409 when an existing open session has a different paytable
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > returns 501 for SOL/USDC currency stubs
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > returns 401 without auth
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /spin + close + verifier round-trip > runs a spin, replays it via idempotency key, closes + reveals seed
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /spin + close + verifier round-trip > 404s on unknown session, 403s on foreign-user session
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /spin + close + verifier round-trip > rate-limits at 61st spin/minute
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > spin lifecycle preserves net-balance invariant (no token burn or mint)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > idempotency-key replay with mismatched predict returns 409
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > spin schema rejects client-supplied nonce/cursor in body (.strict())
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > currentBalance can be negative after losing spins (signed P&L)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > opens a session with paytableId=classic-3x5-bonus
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > GET /paytables/classic-3x5-bonus returns 11 symbols + bonus reel strips
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > spin awards free spins when 3+ scatters land; mode flips to free-spin
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > free-spin mode does not debit balance; credits wins; decrements freeSpinsRemaining
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > free-spin retrigger caps at CAP_REMAINING (50)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\dashboard-reconcile.test.ts:
(pass) read-only reconcile dashboard > projects all three tables, durable bounty context, and narrow metadata without writes [0.96ms]
(pass) read-only reconcile dashboard > handles missing holds and malformed stamps without leaking extra stamp fields [0.19ms]
(pass) read-only reconcile dashboard > rejects anonymous requests on the real dashboard route [0.72ms]
(pass) read-only reconcile dashboard > keeps the registered route private and uncached for an admin cookie [0.61ms]

src\routes\__tests__\dashboard-skill-acks.test.ts:
(pass) dashboard agent skill ACK posture > counts BYO posture from the canonical hash and excludes hosted cohorts [1.28ms]
(pass) dashboard agent skill ACK posture > returns at most 20 stale/none agents, newest first across both groups [0.38ms]

src\routes\__tests__\guest-economy-guard-coverage.test.ts:
(pass) guest→real-CT guard coverage lock > wager.ts > POST /lobbies is chained with requireNonGuestIdentity [0.49ms]
(pass) guest→real-CT guard coverage lock > wager.ts > POST /lobbies/:id/join is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > wager.ts > POST /lobbies/:id/refund is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > wager.ts > POST /lobbies/:id/cancel is chained with requireWagerCancelCaller [0.04ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > POST /create is chained with requireNonGuestIdentity [0.20ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > POST /attempts/:attemptId/review is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > POST /:id/claim is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > POST /:id/submit is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > POST /:id/abandon is chained with requireNonGuestIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > PATCH /:id is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > bounties.ts > DELETE /:id is chained with requireNonGuestIdentity [0.04ms]
(pass) guest→real-CT guard coverage lock > exchange.ts > POST /create is chained with requireNonGuestIdentity [0.17ms]
(pass) guest→real-CT guard coverage lock > exchange.ts > POST /:id/order is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > exchange.ts > POST /orders/:orderId/submit is chained with requireNonGuestIdentity [0.04ms]
(pass) guest→real-CT guard coverage lock > exchange.ts > POST /orders/:orderId/confirm is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > exchange.ts > POST /orders/:orderId/cancel is chained with requireNonGuestIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > exchange.ts > POST /:id/cancel is chained with requireNonGuestIdentity [0.04ms]
(pass) guest→real-CT guard coverage lock > ct-topup.ts > POST /quote is chained with requireNonGuestIdentity [0.19ms]
(pass) guest→real-CT guard coverage lock > ct-topup.ts > POST /settle is chained with requireNonGuestIdentity [0.03ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /hold-wallet is chained with requireNonGuestIdentity [0.26ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/claim-rent is chained with requireNonGuestIdentity [0.25ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/claim-hold is chained with requireNonGuestIdentity [0.06ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/deposit-topup is chained with requireNonGuestIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/release is chained with requireNonGuestIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/structure is chained with requireNonGuestIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/pieces is chained with requireNonGuestIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > land.ts > PATCH /pieces/:pieceId is chained with requireNonGuestIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > DELETE /pieces/:pieceId is chained with requireNonGuestIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > PATCH /structures/:structureId/appearance is chained with requireNonGuestIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /structures/:structureId/upgrade is chained with requireNonGuestIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /structures/:structureId/services is chained with requireNonGuestIdentity [0.09ms]
(pass) guest→real-CT guard coverage lock > land.ts > PATCH /services/:listingId is chained with requireNonGuestIdentity [0.09ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /services/:listingId/buy is chained with requireNonGuestIdentity [0.09ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /hold-wallet is chained with requireLedgerCapableIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/claim-rent is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/claim-hold is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/deposit-topup is chained with requireLedgerCapableIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/release is chained with requireLedgerCapableIdentity [0.04ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/structure is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /parcels/:parcelId/pieces is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > PATCH /pieces/:pieceId is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > DELETE /pieces/:pieceId is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > PATCH /structures/:structureId/appearance is chained with requireLedgerCapableIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /structures/:structureId/upgrade is chained with requireLedgerCapableIdentity [0.05ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /spawn-preference is chained with requireLedgerCapableIdentity [0.08ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /structures/:structureId/services is chained with requireLedgerCapableIdentity [0.06ms]
(pass) guest→real-CT guard coverage lock > land.ts > PATCH /services/:listingId is chained with requireLedgerCapableIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > land.ts > POST /services/:listingId/buy is chained with requireLedgerCapableIdentity [0.07ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /:id/accept is chained with requireNonGuestIdentity [0.20ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /:id/start is chained with requireNonGuestIdentity [0.03ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /:id/submit is chained with requireNonGuestIdentity [0.02ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /tutorial/:id/claim is chained with requireNonGuestIdentity [0.03ms]
(pass) guest→real-CT guard coverage lock > quests.ts > GET /tutorial/claims is chained with requireNonGuestIdentity [0.04ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /:id/accept is chained with requireLedgerCapableIdentity [0.01ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /:id/start is chained with requireLedgerCapableIdentity [0.01ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /:id/submit is chained with requireLedgerCapableIdentity [0.01ms]
(pass) guest→real-CT guard coverage lock > quests.ts > POST /tutorial/:id/claim is chained with requireLedgerCapableIdentity [0.02ms]
(pass) guest→real-CT guard coverage lock > quests.ts > GET /tutorial/claims is chained with requireLedgerCapableIdentity [0.02ms]
(pass) guest→real-CT guard coverage lock > cove-cash-poker.ts > POST /tables is chained with requireNonGuestUser [0.14ms]
(pass) guest→real-CT guard coverage lock > cove-cash-poker.ts > POST /tables/join-by-code is chained with requireNonGuestUser [0.02ms]
(pass) guest→real-CT guard coverage lock > cove-cash-poker.ts > POST /tables/:id/sit is chained with requireNonGuestUser [0.02ms]
(pass) guest→real-CT guard coverage lock > cove-cash-poker.ts > POST /tables/:id/leave is chained with requireNonGuestUser [0.02ms]
(pass) guest→real-CT guard coverage lock > cove-cash-poker.ts > POST /tables/:id/action is chained with requireNonGuestUser [0.03ms]
(pass) guest→real-CT guard coverage lock > cove-poker-mtt.ts > POST /:id/register is chained with requireNonGuestUser [0.15ms]
(pass) guest→real-CT guard coverage lock > cove-poker-mtt.ts > POST /action is chained with requireNonGuestUser [0.03ms]
(pass) guest→real-CT guard coverage lock > special-events.ts > POST /:slug/signup is chained with requireNonGuestUser [0.12ms]
(pass) guest→real-CT guard coverage lock > cosmetics.ts > POST /:skuId/buy is chained with requireNonGuestIdentity [0.12ms]
(pass) guest→real-CT guard coverage lock > partner-storefront.ts > POST /quote is chained with requireNonGuestIdentity [0.11ms]
(pass) guest→real-CT guard coverage lock > partner-storefront.ts > POST /settle is chained with requireNonGuestIdentity [0.02ms]
(pass) guest→real-CT guard coverage lock > require-non-guest.ts exports the shared guards [0.19ms]
(pass) guest→real-CT guard coverage lock > cosmetic guest + agent read parity > POST /:skuId/equip preserves the authenticated guest happy path [0.10ms]
(pass) guest→real-CT guard coverage lock > cosmetic guest + agent read parity > POST /:skuId/unequip preserves the authenticated guest happy path [0.03ms]
(pass) guest→real-CT guard coverage lock > cosmetic guest + agent read parity > GET /owned accepts a live ledger-capable agent identity [0.06ms]
(pass) guest→real-CT guard coverage lock > guest-owned-agent demo-resolution locks > items.ts /buy demo-classifies a guest-OWNED agent (not just kind:'user') [0.13ms]
(pass) guest→real-CT guard coverage lock > guest-owned-agent demo-resolution locks > building-reward.ts skips the REAL-CT building reward for a guest owner [0.13ms]
(pass) guest→real-CT guard coverage lock > guest-owned-agent demo-resolution locks > resolveAgentSession demotes a guest-owned session to non-ledger [0.18ms]
(pass) guest→real-CT guard coverage lock > guest-owned-agent demo-resolution locks > connect-token 403s a guest at the source [0.40ms]

src\routes\__tests__\json-body-guard.test.ts:
(pass) jsonBodyGuard > returns invalid_json for a truncated JSON body [1.28ms]
(pass) jsonBodyGuard > returns invalid_json for a non-JSON body [0.34ms]
(pass) jsonBodyGuard > keeps valid JSON available to downstream c.req.json() [0.38ms]
(pass) jsonBodyGuard > passes an empty JSON request through so the route decides [0.27ms]
(pass) jsonBodyGuard > leaves garbage without a JSON content-type untouched [0.32ms]
(pass) jsonBodyGuard > passes exempt raw-body prefixes through byte-for-byte [0.31ms]
(pass) jsonBodyGuard with authRoutes > returns 400 for malformed JSON on the real login route [0.70ms]

src\routes\__tests__\land-appearance-allowlist.test.ts:
(pass) land appearance allowlists > matches the full type × level × tier × shell boundary matrix [1.77ms]
(pass) land appearance allowlists > keeps D2 capacity-only: starter/c never unlock premium or founder shells [0.19ms]
(pass) land appearance allowlists > exposes exactly three palettes at Lv1 and all eight from Lv2 [0.30ms]
(pass) land appearance allowlists > pins the home shell roster and its founder-tunable unlock levels [0.15ms]
(pass) land appearance allowlists > points every catalog row at a GLB that actually exists on disk [0.97ms]
(pass) land appearance allowlists > keeps classic as an identity tint and names the premium shell tiers [0.09ms]
(pass) D2 SKU independence guard > does not change any isSkuAllowedForTier result [0.54ms]
(pass) 0048 appearance migration > is additive/idempotent and deterministically backfills both defaults [0.17ms]

src\routes\__tests__\land-appearance-routes.test.ts:
(pass) PATCH /structures/:structureId/appearance > is strict, partial, and rejects an empty patch [0.47ms]
(pass) PATCH /structures/:structureId/appearance > accepts the owner and gives an agent session the exact same avatar-bound path [0.08ms]
(pass) PATCH /structures/:structureId/appearance > rejects a non-owner before applying appearance choices [0.02ms]
(pass) PATCH /structures/:structureId/appearance > rejects denormalized ownership drift after authoritative parcel ownership [0.02ms]
(pass) PATCH /structures/:structureId/appearance > rejects archived structures [0.02ms]
(pass) PATCH /structures/:structureId/appearance > rejects wrong-type/unknown shells and current-level gates [0.04ms]
(pass) PATCH /structures/:structureId/appearance > 401s without human or agent auth before any DB access [1.75ms]
(pass) PATCH /structures/:structureId/appearance > chains auth, ledger capability, and guest protection [0.41ms]
(pass) GET /structures/public DTO > returns only the frozen public shape with explicit rolling-deploy fallbacks [0.12ms]
(pass) GET /structures/public DTO > is a public, cached, rate-limited active-only join [0.32ms]

src\routes\__tests__\land-deed-lock-guard.test.ts:
(pass) parcelHasLiveDeedLock — structural (pure, no DB) > row presence == HELD: any returned row → locked (true) [0.24ms]
(pass) parcelHasLiveDeedLock — structural (pure, no DB) > no rows → unlocked (false) [0.07ms]
(pass) parcelHasLiveDeedLock — structural (pure, no DB) > undefined-table 42P01 (market tables not migrated) → unlocked, not thrown [0.14ms]
(pass) parcelHasLiveDeedLock — structural (pure, no DB) > 42P01 nested under `cause` (a wrapping driver/ORM layer) → unlocked, not thrown [0.10ms]
(pass) parcelHasLiveDeedLock — structural (pure, no DB) > any OTHER error is rethrown — a money path never silently swallows a real fault [0.12ms]
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > (unnamed)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > /release → 409 { error, code: deed_locked_by_listing } while a HELD deed-lock row exists — parcel + structure UNCHANGED
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > sweeper on a grace-ELAPSED deed-locked parcel returns parked and does NOT revert (grace untouched)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > /release → 409 deed_locked_by_listing when NO deed-lock row exists but a live active land_deed listing references the parcel
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > CONTROL: with the lock + listing cleared, /release succeeds (the guard never over-blocks)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > CONTROL: with the lock + listing cleared, the sweeper evicts the grace-elapsed parcel normally
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > (unnamed)

src\routes\__tests__\land-hold-wallet-proof.test.ts:
(pass) door 1 — hold-wallet challenge store > issues the frozen four-line message bound to BOTH the account and the wallet [14.51ms]
(pass) door 1 — hold-wallet challenge store > consumes a nonce exactly once — a replay is refused [3.38ms]
(pass) door 1 — hold-wallet challenge store > refuses a nonce presented by a different account (cross-account replay) [3.17ms]
(pass) door 1 — hold-wallet challenge store > refuses a nonce presented for a different declared wallet (repoint replay) [6.08ms]
(pass) door 1 — hold-wallet challenge store > refuses an expired nonce [3.23ms]
(pass) door 1 — hold-wallet challenge store > refuses an unknown nonce [2.96ms]
(pass) door 1 — hold-wallet challenge store > keeps the 120s TTL, the size cap and the unref-d janitor of the wallet-link sibling [0.08ms]
(pass) door 1 — ed25519 proof over the exact message bytes > verifies a real signature made by the declared wallet [12.42ms]
(pass) door 1 — ed25519 proof over the exact message bytes > rejects a signature produced by a different signer (wrong-signer) [11.73ms]
(pass) door 1 — ed25519 proof over the exact message bytes > rejects a signature over a message naming a different account [9.52ms]
(pass) door 1 — ed25519 proof over the exact message bytes > rejects a signature over a message naming a different wallet [10.61ms]
(pass) trap T1 — verification is PUBKEY-BOUND, never row-bound > treats a proof for a DIFFERENT pubkey as unverified (declare-A verify-A change-to-B) [0.24ms]
(pass) trap T1 — verification is PUBKEY-BOUND, never row-bound > reports verified only when the proven pubkey IS the declared pubkey [0.05ms]
(pass) trap T1 — verification is PUBKEY-BOUND, never row-bound > reports grandfathered only when the one-shot stamp IS the declared pubkey [0.05ms]
(pass) trap T1 — verification is PUBKEY-BOUND, never row-bound > is unverified with no declaration at all, whatever the other columns say [0.04ms]
(pass) trap T1 — verification is PUBKEY-BOUND, never row-bound > prefers a real proof over the grandfather stamp [0.03ms]
(pass) trap T3 — BOTH claim-hold reads are gated on the same proof tuple > gates the pre-transaction read and throws wallet_not_verified [0.14ms]
(pass) trap T3 — BOTH claim-hold reads are gated on the same proof tuple > re-reads the SAME tuple under FOR SHARE inside the transaction [0.10ms]
(pass) trap T3 — BOTH claim-hold reads are gated on the same proof tuple > reads one shared column list so the two gates can never drift apart [0.08ms]
(pass) trap T3 — BOTH claim-hold reads are gated on the same proof tuple > keeps wallet_not_declared ahead of the verification gate [0.07ms]
(pass) traps T1 + T2 — a declaration change destroys the proof > nulls the verification tuple AND the grandfather stamp in the repoint UPDATE [0.04ms]
(pass) traps T1 + T2 — a declaration change destroys the proof > never writes a NON-NULL grandfather value anywhere in the API source [39.50ms]
(pass) traps T1 + T2 — a declaration change destroys the proof > only reaches the clearing UPDATE on an actual change, never on a re-declare [0.15ms]
(pass) migration 0060 — schema contract > adds the four proof columns to users [0.17ms]
(pass) migration 0060 — schema contract > constrains the method vocabulary and the all-or-nothing verification tuple [0.06ms]
(pass) migration 0060 — schema contract > stamps the grandfather column ONCE against a HARD-CODED literal cutoff (T2) [0.07ms]
(pass) migration 0060 — schema contract > makes pending challenge amounts unique so attribution cannot collide (T6) [0.06ms]
(pass) migration 0060 — schema contract > lets one inbound signature satisfy at most one challenge (T7) [0.04ms]
(pass) migration 0060 — schema contract > pairs the refund claim lease columns like the gas sponsor does [0.04ms]
(pass) migration 0060 — schema contract > bounds the status and refund_state vocabularies [0.05ms]
(pass) migration 0060 — schema contract > carries the rejected-reason vocabulary and its all-or-nothing pairing [0.07ms]
(pass) migration 0060 — schema contract > records refund obligations durably, so an alert is never the only record [0.31ms]
(pass) migration 0060 — schema contract > DISCOVERS a retired-destination debt from the parsed transaction (round 6) [0.28ms]
(pass) migration 0060 — schema contract > writes the rotated-destination obligation atomically with the terminalize [0.12ms]
(pass) migration 0060 — schema contract > never lets the scan terminalize a challenge that is still open (round 4) [0.12ms]
(pass) migration 0060 — schema contract > derives the orphan threshold from the TTL, never a standalone constant [0.13ms]
(pass) migration 0060 — schema contract > documents the best-effort orphan-discovery limitation with a FEATURE_GATE [2.63ms]
(pass) migration 0060 — schema contract > does not claim recoverability we cannot guarantee (round 5) [4.35ms]
(pass) migration 0060 — schema contract > never promises a guaranteed refund on the three knowledge surfaces (round 5) [3.27ms]
(pass) migration 0060 — schema contract > never records TRUNCATED scan facts (round 3) [0.21ms]
(pass) migration 0060 — schema contract > never CASCADES a user delete over the live money ledger (H9) [0.10ms]
(pass) migration 0060 — schema contract > makes refund signatures unique and records the received total (B4 + B5) [0.07ms]
(pass) migration 0060 — schema contract > stamps an immutable refund authorization window + cap policy (B2) [0.18ms]
(pass) migration 0060 — schema contract > keeps a durable scan ledger with parsed FACTS, not a bare seen flag (B3) [0.15ms]
(pass) migration 0060 — schema contract > binds every terminal refund transition to its owner (H8) [0.09ms]
(pass) migration 0060 — schema contract > requires a confirmed commitment before a refund is called paid (H7) [0.12ms]
(pass) migration 0060 — schema contract > proves the verify signer can sign AND pay before opening the door (H6) [0.19ms]
(pass) migration 0060 — schema contract > drops the memo predicate but keeps the top-level paying leg as proof [0.20ms]
(pass) migration 0060 — schema contract > reserves an amount while a lapsed row is still being scanned for it [0.14ms]
(pass) migration 0060 — schema contract > keeps the treasury enum value ALONE in its own file and the index after it [0.43ms]
(pass) migration 0060 — schema contract > is idempotent DDL throughout [0.06ms]
(pass) trap T11 — E5 parity on every verify route > registers all six routes, including signature submission [0.43ms]
(pass) trap T11 — E5 parity on every verify route > runs the identical identity chain the declaration routes use [0.17ms]
(pass) trap T11 — E5 parity on every verify route > resolves the acting account from the middleware identity, never from the body [0.14ms]
(pass) verify-route input hardening > uses a strict body schema that never carries a wallet pubkey [0.11ms]
(pass) verify-route input hardening > length-checks the bs58 pubkey and signature BEFORE nacl verify (T13) [0.08ms]
(pass) verify-route input hardening > verifies against the SERVER-read declared wallet, not a client value [0.07ms]
(pass) verify-route input hardening > re-reads the CURRENT custodial wallet inside the attest transaction [0.08ms]
(pass) verify-route input hardening > re-checks the declaration under FOR UPDATE before persisting a proof [0.04ms]
(pass) GET /hold-wallet verification block > serves the server-derived state and never derives it in the route [0.09ms]
(pass) GET /hold-wallet verification block > derives door-2 availability from provisioning, not from a dark flag [0.07ms]
(pass) GET /hold-wallet verification block > suppresses a stale method/timestamp when the proof no longer matches [0.04ms]
(pass) trap T12 — grandfathered holders keep what they have, and nothing more > leaves the rent sweeper free of any verification gate [0.12ms]
(pass) trap T12 — grandfathered holders keep what they have, and nothing more > refuses a NEW hold claim on a grandfathered declaration (adversarial review) [0.04ms]
(pass) trap T12 — grandfathered holders keep what they have, and nothing more > opens the door the moment that same wallet is actually proven [0.03ms]
(pass) trap T12 — grandfathered holders keep what they have, and nothing more > still REPORTS grandfathered on the GET surface, so the UI keeps prompting [0.04ms]
(pass) trap T12 — grandfathered holders keep what they have, and nothing more > names the state in the refusal so the UI can say which case it is [0.03ms]
(pass) poll-primary verification with exact-signature fallback > exposes a submit route with a strict, length-bounded body [0.10ms]
(pass) poll-primary verification with exact-signature fallback > routes submit and scan through one shared authoritative attribution path [0.20ms]
(pass) poll-primary verification with exact-signature fallback > routes closed-row discovery through shared attribution before unclaimed fallback [0.16ms]
(pass) poll-primary verification with exact-signature fallback > polling invokes bounded scan settlement for a live pending row [0.09ms]
(pass) poll-primary verification with exact-signature fallback > closes the door on cap-policy disagreement, not just signer health [0.08ms]
(pass) round 4 — refund copy never asserts a verification outcome > states the refund situation without claiming verification is complete [0.11ms]
(pass) round 4 — refund copy never asserts a verification outcome > does not promise the UI refund unconditionally either (round 6) [0.07ms]
(pass) round 4 — refund copy never asserts a verification outcome > still refuses to call a skipped refund "not needed" [0.06ms]
(pass) round 4 — refund copy never asserts a verification outcome > keeps user-facing verification copy free of em dashes [0.05ms]
(pass) protocol manual parity > retains the single current protocol version declaration [0.16ms]
(pass) protocol manual parity > documents the requirement, the REST signature door, custodial attest and the error [0.41ms]
(pass) protocol manual parity > publishes the EXACT message bytes a BYO agent must sign [0.24ms]
(pass) round 2 poll-primary regressions > keeps expired unbound storage through the late horizon and drops it afterwards [0.33ms]
(pass) round 2 poll-primary regressions > shows signature recovery but hides send instructions for expired unbound state [0.33ms]
(pass) round 2 poll-primary regressions > scopes storage by wallet, migrates legacy entries, and guards cleanup by challenge id [0.16ms]
(pass) round 2 poll-primary regressions > documents polling as primary and exact-signature submission as the memo-free fallback [0.08ms]
(pass) round 2 poll-primary regressions > renders the live countdown as zero-padded MM:SS [0.21ms]

src\routes\__tests__\land-hold-wallet-proof-db.test.ts:
(skip) Land hold-wallet ownership proof — executed DB contract > (unnamed)
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a hold claim on an unverified declaration with wallet_not_verified
(skip) Land hold-wallet ownership proof — executed DB contract > opens the verification gate once the wallet is proven
(skip) Land hold-wallet ownership proof — executed DB contract > destroys the proof when the declaration is repointed (T1)
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a proof written against a declaration that moved underneath it
(skip) Land hold-wallet ownership proof — executed DB contract > auto-attests a declared wallet that IS the avatar custodial wallet
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a custodial attest for a wallet the avatar does not hold
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a custodial attest with no declaration at all
(skip) Land hold-wallet ownership proof — executed DB contract > cannot be grandfathered by a FRESH declare (T2 discriminator)
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a NEW hold claim on a grandfathered wallet, leaving the existing hold alone
(skip) Land hold-wallet ownership proof — executed DB contract > rejects a half-written verification tuple and an unknown method
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > keeps PENDING amounts unique so attribution can never collide (T6)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > lets one inbound signature satisfy at most one challenge (T7)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > bounds the status and refund_state vocabularies and the amount
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > pairs a rejected row with its reason, and bounds the vocabulary
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > lets at most ONE row own a given refund signature (B4)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > keeps the refund cap stamp all-or-nothing, and the policy table positive (B2)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > rejects a non-positive received total (B5)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > stores parsed scan FACTS so a later challenge can match without re-parsing (B3)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > represents two verify destinations funded by ONE transaction as separate debts
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > lets a RETIRED verify wallet coexist with the active one (round 7)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > bounds the obligation reason and state vocabularies
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > pairs the refund claim lease columns (capture-before-send)
(skip) Land hold-wallet ownership proof — executed DB contract > (unnamed)

src\routes\__tests__\land-kit-material-rail.test.ts:
(pass) the rail gate > allows both rails on a HOME yard [0.07ms]
(pass) the rail gate > REFUSES materials on a SHOP yard, and only materials [0.03ms]
(pass) the rail gate > is total over the declared rail set [0.07ms]
(pass) material pricing > prices small below large, for every catalog piece [0.10ms]
(pass) material pricing > matches the design sizing (8 small / 30 large) [0.03ms]
(pass) material pricing > keeps the vCLAW ladder untouched — this slice added a rail, it did not reprice [0.05ms]
(pass) material pricing > paces a full Lv3 home yard at roughly a week of salvage [0.05ms]
(pass) placement-audit readers > reads back a material placement [0.11ms]
(pass) placement-audit readers > treats a PRE-P5b audit row as vCLAW, which is what it factually was [0.04ms]
(pass) placement-audit readers > refuses to invent a rail or a cost from junk [0.08ms]
(skip) material spend conservation (real DB) > (unnamed)
(skip) material spend conservation (real DB) > charges exactly the piece price and nothing more
(skip) material spend conservation (real DB) > refuses a spend at balance MINUS ONE without writing
(skip) material spend conservation (real DB) > rolls the debit back when the placement fails after it
(skip) material spend conservation (real DB) > never lets the pooled balance go negative under concurrent spends
(skip) material spend conservation (real DB) > (unnamed)

src\routes\__tests__\land-kit-migration.test.ts:
(pass) 0049 land structure pieces migration > creates only the additive idempotent piece table and parcel index [0.10ms]
(pass) 0049 land structure pieces migration > pins cascade ownership, bounds, rotation, stacking, and occupancy [0.11ms]
(pass) 0049 land structure pieces migration > contains no renderer, asset, collider, or pathfinding columns [0.04ms]
(pass) 0050 land kit integrity migration > creates the scoped durable kit-placement idempotency backstop [0.03ms]
(pass) 0050 land kit integrity migration > replaces the owner FK with avatar-delete cascade semantics [0.02ms]
(pass) 0050 land kit integrity migration > contains no table/data destruction or enum mutation [0.04ms]

src\routes\__tests__\land-kit-placement-db.test.ts:
(skip) kit placement predicate wiring (real DB) > (unnamed)
(skip) kit placement predicate wiring (real DB) > admits a legal perimeter placement on an empty yard
(skip) kit placement predicate wiring (real DB) > refuses the shell reservation at the grid centre — the D-1 case
(skip) kit placement predicate wiring (real DB) > refuses a piece that overlaps one already standing
(skip) kit placement predicate wiring (real DB) > excludes the moved piece from its own occupancy — a move never self-collides
(skip) kit placement predicate wiring (real DB) > refuses a stack with nothing underneath it
(skip) kit placement predicate wiring (real DB) > refuses a stack above the level ladder height
(skip) kit placement predicate wiring (real DB) > GRANDFATHERS an illegal stored row (Q5): it still blocks, is never dropped
(skip) kit placement predicate wiring (real DB) > (unnamed)

src\routes\__tests__\land-kit-routes.test.ts:
(pass) land kit request and ladder validation > requires an 8..64 idempotency key and rejects stray create fields [0.57ms]
(pass) land kit request and ladder validation > makes move strict and unable to change the piece key or provide money [0.19ms]
(pass) land kit ownership and money discipline > uses authoritative parcel ownership and fails closed on either denormalized drift [0.13ms]
(pass) land kit ownership and money discipline > requires an active structure for create/move but not owner removal [0.05ms]
(pass) land kit ownership and money discipline > derives the exact D5 fee from the server catalog [0.15ms]
(pass) land kit ownership and money discipline > places under one atomic exact debit+house credit and audits both ledger ids [0.30ms]
(pass) land kit ownership and money discipline > gates the MATERIAL rail on the locked structure type, and only debits [0.14ms]
(pass) land kit ownership and money discipline > checks durable replay before debit and returns the stored original piece [0.08ms]
(pass) land kit ownership and money discipline > rejects idempotency replay when any stored placement target field differs [0.11ms]
(pass) land kit ownership and money discipline > runs the SHARED placement predicate before the ledger and keeps the DB backstop [0.14ms]
(pass) land kit ownership and money discipline > has exactly ONE geometry authority — the anchor-only validators are gone [0.31ms]
(pass) land kit ownership and money discipline > refuses an unsupported stack through the shared predicate, not a local rule [0.07ms]
(pass) land kit ownership and money discipline > keeps move and removal free with no refund path [0.11ms]
(pass) land kit middleware and public feed contract > chains all three mutations with auth, ledger-capability, and non-guest guards [0.33ms]
(pass) land kit middleware and public feed contract > 401s before DB access without a human or agent session [2.18ms]
(pass) land kit middleware and public feed contract > serves owner piece IDs through a private, ledger-capable read-only route [0.21ms]
(pass) land kit middleware and public feed contract > 401s the owner piece-ID read before DB access without auth [1.46ms]
(pass) land kit middleware and public feed contract > maps exactly the six-field public no-PII DTO [0.13ms]
(pass) land kit middleware and public feed contract > serves an unauthenticated parcelCode join with the frozen cache headers [0.08ms]
(pass) land kit middleware and public feed contract > excludes an archived structure's parcel pieces from the public feed [0.05ms]
(pass) land kit middleware and public feed contract > purges stale pieces on different-owner re-acquire and mirrors structure cache busts [0.47ms]
(pass) land kit middleware and public feed contract > documents structure_required as 404 and the DELETE response shape [0.09ms]
(pass) land kit middleware and public feed contract > contains no collider, pathfinding, GLB, or asset mapping write [0.21ms]

src\routes\__tests__\land-services.test.ts:
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > accepts a minimal valid body (description optional) [0.22ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects an empty title [0.15ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects a title over 80 chars [0.10ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > accepts a title at exactly 80 chars (boundary) [0.05ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects a description over 500 chars [0.12ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects a negative priceCt [0.08ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects priceCt over 1_000_000 [0.06ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > accepts priceCt at exactly 1_000_000 (boundary) and 0 (free service) [0.07ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects a non-integer priceCt [0.06ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > listServiceBodySchema > rejects a stray key (.strict()) [0.09ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > updateServiceBodySchema > rejects an empty patch (refine — at least one field required) [0.18ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > updateServiceBodySchema > accepts a status-only patch [0.10ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > updateServiceBodySchema > accepts a priceCt-only patch [0.08ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > updateServiceBodySchema > rejects an invalid status enum value [0.16ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > updateServiceBodySchema > rejects a stray key (.strict()) [0.16ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > buyServiceBodySchema > requires idempotencyKey (missing body field) [0.10ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > buyServiceBodySchema > rejects a key under 8 chars [0.10ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > buyServiceBodySchema > accepts a key at exactly 8 chars (boundary) [0.05ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > buyServiceBodySchema > rejects a key over 64 chars [0.07ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > buyServiceBodySchema > accepts a key at exactly 64 chars (boundary) and a fresh UUID [0.07ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > buyServiceBodySchema > rejects a stray key (.strict()) [0.05ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > servicesPageQuerySchema > accepts page/limit as coerced query strings [0.08ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > servicesPageQuerySchema > accepts an empty query (both optional) [0.05ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > servicesPageQuerySchema > rejects page=0 (min 1) [0.17ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > servicesPageQuerySchema > rejects limit over 50 [0.09ms]
(pass) land services — zod schema mirrors (deterministic, no DB) > servicesPageQuerySchema > accepts limit at exactly 50 (boundary) [0.04ms]
(pass) land services — routing integrity + pre-DB validation > GET /structures/:id/services with a non-uuid id -> 400 invalid_structure_id (no DB touch) [2.30ms]
(pass) land services — routing integrity + pre-DB validation > GET /services with limit over 50 -> 400 invalid_query (no DB touch) [2.26ms]
(pass) land services — routing integrity + pre-DB validation > GET /services with page=0 -> 400 invalid_query (no DB touch) [2.11ms]
(pass) land services — routing integrity + pre-DB validation > POST /structures/:id/services with NO auth material -> 401 (mounted under requireAuthOrAgentSession, no DB touch) [1.53ms]
(pass) land services — routing integrity + pre-DB validation > PATCH /services/:id with NO auth material -> 401 (no DB touch) [0.88ms]
(pass) land services — routing integrity + pre-DB validation > POST /services/:id/buy with NO auth material -> 401 (no DB touch) [0.78ms]
(pass) land services — routing integrity + pre-DB validation > GET /services/mine with NO auth material -> 401 (mounted under requireAuthOrAgentSession, no DB touch) [0.73ms]
(skip) land services — money-path route tests (requires DATABASE_URL) > (unnamed)
(skip) land services — money-path route tests (requires DATABASE_URL) > a non-owner cannot list a service on someone else’s shop -> 403 not_structure_owner
(skip) land services — money-path route tests (requires DATABASE_URL) > the shop owner lists a service -> 200 active, and it appears on the public structure read
(skip) land services — money-path route tests (requires DATABASE_URL) > listing cap: the 7th active listing on a structure -> 409 listing_cap_reached
(skip) land services — money-path route tests (requires DATABASE_URL) > buy happy path: conservation holds (buyer −P, seller +P, sum unchanged) and land.service.sold fires exactly once, keyed to the SELLER
(skip) land services — money-path route tests (requires DATABASE_URL) > idempotent replay (same key) -> cached:true, no double charge, no second event
(skip) land services — money-path route tests (requires DATABASE_URL) > self-purchase -> 409 self_purchase (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > insufficient funds -> 400 insufficient_clawtokens (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > unknown listing -> 404 listing_not_found
(skip) land services — money-path route tests (requires DATABASE_URL) > an inactive (delisted) listing -> 409 listing_not_active
(skip) land services — money-path route tests (requires DATABASE_URL) > a non-owner cannot PATCH someone else’s listing -> 403 not_listing_owner
(skip) land services — money-path route tests (requires DATABASE_URL) > PATCH an unknown listing id -> 404 listing_not_found
(skip) land services — money-path route tests (requires DATABASE_URL) > the owner can pause their own listing, and it is excluded from the public structure read
(skip) land services — money-path route tests (requires DATABASE_URL) > buy against a listing whose structure was ARCHIVED (rent-lapse eviction) -> 409 structure_unavailable (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > buy against a listing whose parcel OWNER CHANGED (transfer) -> 409 structure_unavailable (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > buy against a NON-PEER (USDC partner) listing -> 409 not_a_peer_listing (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > GET /services/mine returns the caller’s own listings across statuses (active + paused), owner-scoped, and does not leak to others
(skip) land services — money-path route tests (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\land-tenure-p2-db.test.ts:
(skip) Land P2 executed staging DB contract > (unnamed)
(skip) Land P2 executed staging DB contract > charges week one irrevocably, replays claim/release once, and rejects a stale release after reacquire
(skip) Land P2 executed staging DB contract > allows agent first-declare, blocks live-hold repoint, and requires a human for any change
(skip) Land P2 executed staging DB contract > enforces autonomous daily admission and the five-parcel admission cap in the real DB
(skip) Land P2 executed staging DB contract > executes both new CHECK constraints and keeps malformed legacy escrow outside the v2 scope
(skip) Land P2 executed staging DB contract > (unnamed)

src\routes\__tests__\land-tenure-p2-structural.test.ts:
(pass) Land P2 frozen constants > locks the rent and hold ladders and retires a/b claim points [0.11ms]
(pass) Land P2 frozen constants > uses one constant for the quote, first-week debit, and stamped weekly price [0.32ms]
(pass) shared settlement architecture > exports exactly the three backend operations and keeps effects in adapters [0.23ms]
(pass) shared settlement architecture > takes the outer mutex, advisory lock, idempotency read, and parcel row lock [0.08ms]
(pass) shared settlement architecture > serializes the sweeper and assigns collateral oldest-first to marginal holds [0.13ms]
(pass) shared settlement architecture > keeps first declaration parity-open but makes repoint human-only and hold-locked [0.17ms]
(pass) shared settlement architecture > uses cached hold-wallet reads with a per-identity budget and keeps claims fresh [0.20ms]
(pass) shared settlement architecture > accepts week-based REST prepay and derives its amount in the shared service [0.10ms]
(pass) shared settlement architecture > binds release replay to the persisted acquired-at fingerprint and latest release [0.06ms]
(pass) shared settlement architecture > hard-disables claim-starter before auth and exposes the new guarded routes [0.16ms]
(pass) ghost absorption and freshness guards > carries the frozen exact 18-row manifest and an all-or-nothing DELETE-only disposition [0.46ms]
(pass) ghost absorption and freshness guards > scopes the escrow-shape constraint to v2 and restores never-abort sweeps [0.08ms]
(pass) ghost absorption and freshness guards > removes the b/a seed branch and bounds stale-high reads [0.07ms]
(pass) autonomous cap arithmetic > admits exactly through the cap and rejects one over [0.15ms]
(pass) autonomous cap arithmetic > tracks the autonomous spend gate in the mandated six-field form [0.10ms]
(pass) agent land action surface > keeps the executor whitelist and decide menu in lockstep for all three verbs [0.49ms]
(pass) agent land action surface > derives durable semantic keys whose bucket agrees with the reservation window [0.25ms]
(pass) agent land action surface > re-resolves the cove-grade binding and exposes a bounded status array plus count [0.62ms]

src\routes\__tests__\leaderboard-guest-scoring.test.ts:
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > (unnamed)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > CONTROL: a real (non-guest) Player scores placement + teacher-chat points
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > LEAK FIX: a guest with an activity WIN never appears on the board
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > LEAK FIX: a guest teacher-chat WITHOUT a payload.isGuest tag (Nori-style) is still excluded
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > REGRESSION: a bot-tagged placement (subjectType=bot) still scores 0
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > AGENT-LEG LEAK FIX (flag-join): a guest who BOUND an agent, with NO durable isGuest stamp, is excluded via the live flag-join
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > AGENT-LEG CONTROL: a non-guest Trainer with a bound agent still scores
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > DURABILITY (rebind): a stamped guest-agent event stays excluded after the bot is rebound to a non-guest
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > DURABILITY (deletion): a stamped guest-agent event stays excluded after the guest user is deleted
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER: logEvent freezes subject_was_guest=true for a from-birth guest userId (and false for a real user)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER (avatar path): freezes true from the avatar owner is_guest
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER (agent path): no false-poison on missing row; resolves fresh across a rebind (never cached)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER (mixed id): definitive-false userId + unresolvable agentId → NULL stamp, not false
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > NO OVER-EXCLUSION: a real Trainer stamped false stays ranked after the bot rebinds to a guest owner
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > EVIDENCE: every live guest-owned agent-only scored row is durably stamped (0 latent leaks)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\leaderboard-land-service-scoring.test.ts:
(pass) land.service.sold — registered weight/cap (drift guard) > is weight 40 in the shared registry [0.06ms]
(pass) land.service.sold — registered weight/cap (drift guard) > is cap 50/day in the shared registry [0.03ms]
(pass) land.service.sold — registered weight/cap (drift guard) > has the canonical event-type literal the CTE FILTERs on [0.02ms]
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > (unnamed)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > scores a single paid sale at weight 40 on the agent (Trainer) leg
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > PAID-ONLY: a priceCt=0 sale is rank-inert (adds no count, no score)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > DISTINCT-BUYER: 50 paid sales from ONE buyer collapse to a single credit (wash defense)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > CAP: distinct buyers are capped at 50/day (LEAST) even with 60 distinct buyers
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > BOTH AXES: a Player (avatar-leg) seller scores identically to a Trainer
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > HOUSE-EXCLUSION: a house agent (is_house) never appears on the board despite paid sales
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > HOUSE-EXCLUSION (avatar leg): a house user's avatar is suppressed via the user_id join
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\leaderboard-trade-scoring.test.ts:
(pass) Trading Floor leaderboard drift guards > pins the three tier weights [0.06ms]
(pass) Trading Floor leaderboard drift guards > pins the tier multiplier ratios against base [0.05ms]
(pass) Trading Floor leaderboard drift guards > pins the shared daily scored cap [0.02ms]
(pass) Trading Floor leaderboard drift guards > keeps agent and avatar UTC trade-day CTEs [0.14ms]
(pass) Trading Floor leaderboard drift guards > caps both subject legs before score projection [0.12ms]
(pass) Trading Floor leaderboard drift guards > never casts multiplierTier in a FILTER predicate [0.05ms]
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores one base trade as 20 points on the agent leg
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores one ANSEM trade as 40 points
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores one CLAWVILLE trade as 30 points
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > caps 30 base trades at 20 scored trades and 400 points
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > preserves the tier gradient under the proportional cap
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores the avatar leg identically to the agent leg
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > excludes house agents
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > excludes guest-owned subjects
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > labels only active ClawVille-operated wallets and handles null avatars
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > keeps the fleet label outside scoring
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > (unnamed)

src\routes\__tests__\partner-hatcher-p5.test.ts:
[NPC Simulation] Starting in world mode with 16 NPCs
[OpenClaw] Override registered: milady-kyoko -> sess:5b70dd3bb4b7ce19 (server-managed)
[OpenClaw] Unregistered: sess:5b70dd3bb4b7ce19
(pass) Hatcher P5-2 — in-memory override-occupied + restore primitives > registerAgentBot throws the TYPED OverrideTargetUnavailableError when the target is occupied (P5-2 trigger; nit #1 sentinel) [0.92ms]
[OpenClaw] Override registered: milady-vivi -> sess:8c43be57ea64cf25 (server-managed)
[OpenClaw] Unregistered: sess:8c43be57ea64cf25
[OpenClaw] Override registered: milady-vivi -> sess:09f7d9ae82b32971 (server-managed)
[OpenClaw] Unregistered: sess:09f7d9ae82b32971
[OpenClaw] Override registered: milady-vivi -> sess:8c43be57ea64cf25 (server-managed)
[OpenClaw] Unregistered: sess:8c43be57ea64cf25
(pass) Hatcher P5-2 — in-memory override-occupied + restore primitives > a failed override re-register can RESTORE the prior body from the captured snapshot (P5-2 PATCH path) [0.50ms]

src\routes\__tests__\partner-hatcher-wallet-cache.test.ts:
(pass) Hatcher settlement wallet advertisement > stats merge replaces any cached wallet with the current resolver result [4.02ms]
(pass) Hatcher settlement wallet advertisement > pending public fields omit every fundable address [0.06ms]

src\routes\__tests__\partner-storefront.test.ts:
(pass) partner-storefront — routing integrity + gate > (a) does NOT shadow the live /api/partner/hatcher surface [0.78ms]
(pass) partner-storefront — routing integrity + gate > (b) POST /register with NO partner signature → 401 unauthorized (no DB touch) [5.57ms]
(pass) partner-storefront — routing integrity + gate > (c) POST /admin/fulfillment with no admin credential → 401 (partner key can never flip the gate) [1.01ms]
(pass) partner-storefront — routing integrity + gate > (d) the gate predicate is true for every not-yet-enabled storefront [0.08ms]

src\routes\__tests__\quests-agent-parity.test.ts:
(pass) quest player routes — agent-or-auth gate (Rule E5) > GET /api/quests/my-quests → 401 with zero auth material (no public/guest fallback) [2.36ms]
(pass) quest player routes — agent-or-auth gate (Rule E5) > GET /api/quests/quest-log → 401 with zero auth material (no public/guest fallback) [0.28ms]
(pass) quest player routes — agent-or-auth gate (Rule E5) > POST /api/quests/3f2b8a1c-0000-4000-8000-000000000000/accept → 401 with zero auth material (no public/guest fallback) [0.22ms]
(pass) quest player routes — agent-or-auth gate (Rule E5) > POST /api/quests/3f2b8a1c-0000-4000-8000-000000000000/start → 401 with zero auth material (no public/guest fallback) [0.35ms]
(pass) quest player routes — agent-or-auth gate (Rule E5) > POST /api/quests/3f2b8a1c-0000-4000-8000-000000000000/submit → 401 with zero auth material (no public/guest fallback) [0.39ms]
(skip) quest player routes — agent-or-auth gate (Rule E5) > with a database > an invalid agent-session bearer is rejected 401 (fail-closed), not demoted
(pass) quest player routes — agent-or-auth gate (Rule E5) > non-UUID quest id 404s pre-DB on the write paths [0.60ms]
(pass) requireLedgerCapableIdentity — ownership-proof gate (Codex HIGH #1) > fails closed when identity resolution middleware was omitted [0.92ms]
(pass) requireLedgerCapableIdentity — ownership-proof gate (Codex HIGH #1) > 403s a bound-but-ownership-UNPROVEN agent session BEFORE the handler [1.30ms]
(pass) requireLedgerCapableIdentity — ownership-proof gate (Codex HIGH #1) > passes a ledger-capable agent session [0.66ms]
(pass) requireLedgerCapableIdentity — ownership-proof gate (Codex HIGH #1) > passes a human identity untouched [0.49ms]
(pass) quest admin routes — unchanged human-only surface > POST /api/quests/admin/create → 401 without a Lucia cookie [0.90ms]
(pass) tutorial ladder — the P6 parity flip (was tracked debt) > POST /api/quests/tutorial/say-hi-nori/claim → 401 naming the agent header, not a cookie-only rejection [0.58ms]
(pass) tutorial ladder — the P6 parity flip (was tracked debt) > GET /api/quests/tutorial/claims → 401 naming the agent header, not a cookie-only rejection [0.24ms]
(skip) tutorial ladder — agent-session resolution (DB tier) > POST /api/quests/tutorial/say-hi-nori/claim → rejects an unresolvable agent session (401, session-aware)
(skip) tutorial ladder — agent-session resolution (DB tier) > GET /api/quests/tutorial/claims → rejects an unresolvable agent session (401, session-aware)
(skip) quest race guards (DB) > concurrent duplicate active-submission inserts: exactly one wins (unique index)
(skip) quest race guards (DB) > CAS submit predicate cannot reopen an approved submission (round-2 HIGH #1)
(skip) quest race guards (DB) > round 3: one payout per (quest, avatar) — duplicate reward 23505; approved row blocks the accept predicate
(skip) quest race guards (DB) > round 3: expired active quest fails the accept lookup predicate
(skip) quest race guards (DB) > round 5: native quest actions fail closed on unresolvable + guest identities
(skip) quest race guards (DB) > completion-slot consume: second approval of a 1-max quest gets 0 rows

src\routes\__tests__\skills-claim.test.ts:
(pass) POST /:buildingId/claim auth boundary > rejects a request with no subject [1.21ms]
(pass) POST /:buildingId/claim auth boundary > does not treat a partner key alone as a claim subject [0.28ms]
(pass) executeBuildingSkillClaim > rejects an ownership-unproven agent before service execution [0.71ms]
(pass) executeBuildingSkillClaim > passes the exact ownership-proven agent subject and emits one event for runtime [0.31ms]
(pass) executeBuildingSkillClaim > passes the exact ownership-proven agent subject and emits one event for marker [0.04ms]
(pass) executeBuildingSkillClaim > passes the exact ownership-proven agent subject and emits one event for already [0.03ms]
(pass) executeBuildingSkillClaim > passes a Lucia subject without inventing a proven agent id [0.21ms]
(pass) executeBuildingSkillClaim > returns the entry-skill hint as 400 [0.43ms]
(pass) executeBuildingSkillClaim > returns an unknown building as 404 [0.18ms]
(pass) executeBuildingSkillClaim > rejects a guest user before installer or event execution [0.16ms]
(pass) executeBuildingSkillClaim > limits the resolved subject to 30 claims per minute [0.67ms]
(pass) executeBuildingSkillClaim > emits the organic event shape with canonical subject attribution [0.91ms]
(pass) executeBuildingSkillClaim > attributes a human claim to the resolved user and avatar only [0.32ms]
(pass) executeBuildingSkillClaim > keeps a persisted claim successful when analytics throws [0.22ms]
(pass) executeBuildingSkillClaim > emits nothing when install fails with agent_not_connected [0.21ms]
(pass) executeBuildingSkillClaim > emits nothing when install fails with runtime_unavailable [0.07ms]

src\routes\__tests__\tokenomics-earn-gate.test.ts:
(pass) tokenomics E1/E2 dark route gate > returns the typed 503 while the route is default-off [0.33ms]

src\routes\__tests__\tokenomics-redeem.test.ts:
(pass) tokenomics redeem dark gate > returns typed 503 before auth/body parsing on POST and GET [1.36ms]

src\routes\__tests__\trading-wallet-bind.test.ts:
(pass) trading wallet bind proof > renders the exact four-line avatar message [0.08ms]
(pass) trading wallet bind proof > renders the exact four-line agent message [0.02ms]
(pass) trading wallet bind proof > keeps avatar and agent subject keys stable and distinct [0.07ms]
(pass) trading wallet bind proof > consumes a matching challenge [0.12ms]
(pass) trading wallet bind proof > consumes each nonce only once [0.03ms]
(pass) trading wallet bind proof > destroys a probed nonce after a subject mismatch [0.04ms]
(pass) trading wallet bind proof > rejects a wallet mismatch [0.03ms]
(pass) trading wallet bind proof > rejects an expired challenge [0.08ms]
(pass) trading wallet bind proof > verifies a real detached ed25519 signature [6.79ms]
(pass) trading wallet bind proof > keeps a real signature bound to its subject [8.38ms]
(pass) trading wallet bind proof > rejects 63-byte signatures and 31-byte public keys before binding [2.22ms]
(pass) trading wallet bind proof > rejects a non-base58 public key before binding [0.09ms]
(skip) trading wallet agent-session routes (requires DATABASE_URL) > binds through a real agent gateway session and rejects cross-kind revoke

src\routes\__tests__\tutorial-claims-restore.test.ts:
(pass) GET /api/quests/tutorial/claims — quest-board restore read > rejects zero-auth requests with 401 (authed surface, no public fallback) [1.18ms]
(pass) GET /api/quests/tutorial/claims — quest-board restore read > is not shadowed by the public GET /:id quest lookup [0.25ms]

src\routes\__tests__\world-autonomy-status.test.ts:
(pass) GET /api/world/autonomy/status wallet contract > attaches balance and signed-ledger UTC-day sums to an enrolled response [0.91ms]
(pass) GET /api/world/autonomy/status wallet contract > returns wallet null when any wallet read fails [0.20ms]
(pass) GET /api/world/autonomy/status wallet contract > does not read the wallet for an unenrolled owner [0.12ms]
(pass) GET /api/world/autonomy/status wallet contract > caches successes and failures per owner for 30 seconds [0.98ms]

163 tests skipped:
(skip) activities party routes (requires DATABASE_URL) > (unnamed)
(skip) activities party routes (requires DATABASE_URL) > runs create -> me -> join -> kick -> leave with named members and leader succession
(skip) activities party routes (requires DATABASE_URL) > returns 404 for an unknown valid short code and 400 for non-Crockford input
(skip) activities party routes (requires DATABASE_URL) > (unnamed)
(skip) public auth JSON body parsing (requires DATABASE_URL) > keeps valid-shape unknown credentials on the existing 401 path
(skip) autonomous Cove settlement — real PostgreSQL money path > (unnamed)
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: one autonomous spin writes the gross stake debit and exact net avatar delta
(skip) autonomous Cove settlement — real PostgreSQL money path > house/hosted: an inactive bound house avatar settles real slots and blackjack through the world action
(skip) autonomous Cove settlement — real PostgreSQL money path > house resolver: a non-house agent with an invalid session still drops before settlement
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: daily cap consumes gross tagged debits and a refused second play writes no debit
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: changed live binding is rejected before any ledger write
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: an avatar deactivated after inner resolution is rejected by the transaction binding lock
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: owner-scoped action replay survives session rotation and mismatched args return 409
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: invalid, non-ledger, and unbound resolution never reaches settlement
(skip) autonomous Cove settlement — real PostgreSQL money path > slots: the real internal spin rate gate refuses request 61 with no settlement write
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: a raked autonomous hand settles stake, payout, treasury, history, and balance invariants
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: 4x worst-case cap rejects before shoe, cards, history, or ledger mutation
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: action replay is owner-scoped across shoe rotation and never settles twice
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: daily usage is counted by DB UTC date_trunc(now()), including midnight and excluding the prior second
(skip) autonomous Cove settlement — real PostgreSQL money path > blackjack: binding, active-avatar, non-ledger, and unbound failures write no hand or debit
(skip) autonomous Cove settlement — real PostgreSQL money path > (unnamed)
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > (unnamed)
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > GET /hand/current — visible view only (no hole/undealt/seed) > returns player cards + dealer UPCARD and leaks NO hidden state
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > POST /hand/deal — stale_agent_deal epoch guard > rejects a deal at an old handCounter epoch, accepts at the current one
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > POST /action — stale_agent_decision version guard > rejects an action at a stale handVersion, accepts at the live one
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > POST /action — stale_agent_decision version guard > insure honors expectedHandVersion (parity fix) and replays a settled hand
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > settleHand — binds the hand to the locked shoe (hand_shoe_mismatch) > a caller-owned shoeId + a foreign handId resolves to 409, never settles it
(skip) Cove Blackjack — route regressions (requires DATABASE_URL) > (unnamed)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > (unnamed)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > returns 200 + hash + clientSeed (no serverSeed leak)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > is idempotent — second /open returns 200 with the existing session
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > refuses 409 when an existing open session has a different paytable
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > returns 501 for SOL/USDC currency stubs
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /session/open > returns 401 without auth
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /spin + close + verifier round-trip > runs a spin, replays it via idempotency key, closes + reveals seed
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /spin + close + verifier round-trip > 404s on unknown session, 403s on foreign-user session
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > POST /spin + close + verifier round-trip > rate-limits at 61st spin/minute
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > spin lifecycle preserves net-balance invariant (no token burn or mint)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > idempotency-key replay with mismatched predict returns 409
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > spin schema rejects client-supplied nonce/cursor in body (.strict())
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Money-safety invariants > currentBalance can be negative after losing spins (signed P&L)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > opens a session with paytableId=classic-3x5-bonus
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > GET /paytables/classic-3x5-bonus returns 11 symbols + bonus reel strips
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > spin awards free spins when 3+ scatters land; mode flips to free-spin
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > free-spin mode does not debit balance; credits wins; decrements freeSpinsRemaining
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > Bundle B — classic-3x5-bonus paytable + free-spin lifecycle > free-spin retrigger caps at CAP_REMAINING (50)
(skip) Cove Slots — session lifecycle (requires DATABASE_URL) > (unnamed)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > (unnamed)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > /release → 409 { error, code: deed_locked_by_listing } while a HELD deed-lock row exists — parcel + structure UNCHANGED
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > sweeper on a grace-ELAPSED deed-locked parcel returns parked and does NOT revert (grace untouched)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > /release → 409 deed_locked_by_listing when NO deed-lock row exists but a live active land_deed listing references the parcel
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > CONTROL: with the lock + listing cleared, /release succeeds (the guard never over-blocks)
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > CONTROL: with the lock + listing cleared, the sweeper evicts the grace-elapsed parcel normally
(skip) deed-lock guard E2E (requires DATABASE_URL + migration 0017) > (unnamed)
(skip) Land hold-wallet ownership proof — executed DB contract > (unnamed)
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a hold claim on an unverified declaration with wallet_not_verified
(skip) Land hold-wallet ownership proof — executed DB contract > opens the verification gate once the wallet is proven
(skip) Land hold-wallet ownership proof — executed DB contract > destroys the proof when the declaration is repointed (T1)
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a proof written against a declaration that moved underneath it
(skip) Land hold-wallet ownership proof — executed DB contract > auto-attests a declared wallet that IS the avatar custodial wallet
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a custodial attest for a wallet the avatar does not hold
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a custodial attest with no declaration at all
(skip) Land hold-wallet ownership proof — executed DB contract > cannot be grandfathered by a FRESH declare (T2 discriminator)
(skip) Land hold-wallet ownership proof — executed DB contract > refuses a NEW hold claim on a grandfathered wallet, leaving the existing hold alone
(skip) Land hold-wallet ownership proof — executed DB contract > rejects a half-written verification tuple and an unknown method
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > keeps PENDING amounts unique so attribution can never collide (T6)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > lets one inbound signature satisfy at most one challenge (T7)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > bounds the status and refund_state vocabularies and the amount
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > pairs a rejected row with its reason, and bounds the vocabulary
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > lets at most ONE row own a given refund signature (B4)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > keeps the refund cap stamp all-or-nothing, and the policy table positive (B2)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > rejects a non-positive received total (B5)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > stores parsed scan FACTS so a later challenge can match without re-parsing (B3)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > represents two verify destinations funded by ONE transaction as separate debts
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > lets a RETIRED verify wallet coexist with the active one (round 7)
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > bounds the obligation reason and state vocabularies
(skip) Land hold-wallet ownership proof — executed DB contract > door-2 challenge table invariants > pairs the refund claim lease columns (capture-before-send)
(skip) Land hold-wallet ownership proof — executed DB contract > (unnamed)
(skip) material spend conservation (real DB) > (unnamed)
(skip) material spend conservation (real DB) > charges exactly the piece price and nothing more
(skip) material spend conservation (real DB) > refuses a spend at balance MINUS ONE without writing
(skip) material spend conservation (real DB) > rolls the debit back when the placement fails after it
(skip) material spend conservation (real DB) > never lets the pooled balance go negative under concurrent spends
(skip) material spend conservation (real DB) > (unnamed)
(skip) kit placement predicate wiring (real DB) > (unnamed)
(skip) kit placement predicate wiring (real DB) > admits a legal perimeter placement on an empty yard
(skip) kit placement predicate wiring (real DB) > refuses the shell reservation at the grid centre — the D-1 case
(skip) kit placement predicate wiring (real DB) > refuses a piece that overlaps one already standing
(skip) kit placement predicate wiring (real DB) > excludes the moved piece from its own occupancy — a move never self-collides
(skip) kit placement predicate wiring (real DB) > refuses a stack with nothing underneath it
(skip) kit placement predicate wiring (real DB) > refuses a stack above the level ladder height
(skip) kit placement predicate wiring (real DB) > GRANDFATHERS an illegal stored row (Q5): it still blocks, is never dropped
(skip) kit placement predicate wiring (real DB) > (unnamed)
(skip) land services — money-path route tests (requires DATABASE_URL) > (unnamed)
(skip) land services — money-path route tests (requires DATABASE_URL) > a non-owner cannot list a service on someone else’s shop -> 403 not_structure_owner
(skip) land services — money-path route tests (requires DATABASE_URL) > the shop owner lists a service -> 200 active, and it appears on the public structure read
(skip) land services — money-path route tests (requires DATABASE_URL) > listing cap: the 7th active listing on a structure -> 409 listing_cap_reached
(skip) land services — money-path route tests (requires DATABASE_URL) > buy happy path: conservation holds (buyer −P, seller +P, sum unchanged) and land.service.sold fires exactly once, keyed to the SELLER
(skip) land services — money-path route tests (requires DATABASE_URL) > idempotent replay (same key) -> cached:true, no double charge, no second event
(skip) land services — money-path route tests (requires DATABASE_URL) > self-purchase -> 409 self_purchase (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > insufficient funds -> 400 insufficient_clawtokens (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > unknown listing -> 404 listing_not_found
(skip) land services — money-path route tests (requires DATABASE_URL) > an inactive (delisted) listing -> 409 listing_not_active
(skip) land services — money-path route tests (requires DATABASE_URL) > a non-owner cannot PATCH someone else’s listing -> 403 not_listing_owner
(skip) land services — money-path route tests (requires DATABASE_URL) > PATCH an unknown listing id -> 404 listing_not_found
(skip) land services — money-path route tests (requires DATABASE_URL) > the owner can pause their own listing, and it is excluded from the public structure read
(skip) land services — money-path route tests (requires DATABASE_URL) > buy against a listing whose structure was ARCHIVED (rent-lapse eviction) -> 409 structure_unavailable (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > buy against a listing whose parcel OWNER CHANGED (transfer) -> 409 structure_unavailable (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > buy against a NON-PEER (USDC partner) listing -> 409 not_a_peer_listing (no charge)
(skip) land services — money-path route tests (requires DATABASE_URL) > GET /services/mine returns the caller’s own listings across statuses (active + paused), owner-scoped, and does not leak to others
(skip) land services — money-path route tests (requires DATABASE_URL) > (unnamed)
(skip) Land P2 executed staging DB contract > (unnamed)
(skip) Land P2 executed staging DB contract > charges week one irrevocably, replays claim/release once, and rejects a stale release after reacquire
(skip) Land P2 executed staging DB contract > allows agent first-declare, blocks live-hold repoint, and requires a human for any change
(skip) Land P2 executed staging DB contract > enforces autonomous daily admission and the five-parcel admission cap in the real DB
(skip) Land P2 executed staging DB contract > executes both new CHECK constraints and keeps malformed legacy escrow outside the v2 scope
(skip) Land P2 executed staging DB contract > (unnamed)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > (unnamed)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > CONTROL: a real (non-guest) Player scores placement + teacher-chat points
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > LEAK FIX: a guest with an activity WIN never appears on the board
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > LEAK FIX: a guest teacher-chat WITHOUT a payload.isGuest tag (Nori-style) is still excluded
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > REGRESSION: a bot-tagged placement (subjectType=bot) still scores 0
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > AGENT-LEG LEAK FIX (flag-join): a guest who BOUND an agent, with NO durable isGuest stamp, is excluded via the live flag-join
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > AGENT-LEG CONTROL: a non-guest Trainer with a bound agent still scores
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > DURABILITY (rebind): a stamped guest-agent event stays excluded after the bot is rebound to a non-guest
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > DURABILITY (deletion): a stamped guest-agent event stays excluded after the guest user is deleted
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER: logEvent freezes subject_was_guest=true for a from-birth guest userId (and false for a real user)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER (avatar path): freezes true from the avatar owner is_guest
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER (agent path): no false-poison on missing row; resolves fresh across a rebind (never cached)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > RESOLVER (mixed id): definitive-false userId + unresolvable agentId → NULL stamp, not false
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > NO OVER-EXCLUSION: a real Trainer stamped false stays ranked after the bot rebinds to a guest owner
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > EVIDENCE: every live guest-owned agent-only scored row is durably stamped (0 latent leaks)
(skip) leaderboard guest exclusion — scoring CTE (requires DATABASE_URL) > (unnamed)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > (unnamed)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > scores a single paid sale at weight 40 on the agent (Trainer) leg
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > PAID-ONLY: a priceCt=0 sale is rank-inert (adds no count, no score)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > DISTINCT-BUYER: 50 paid sales from ONE buyer collapse to a single credit (wash defense)
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > CAP: distinct buyers are capped at 50/day (LEAST) even with 60 distinct buyers
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > BOTH AXES: a Player (avatar-leg) seller scores identically to a Trainer
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > HOUSE-EXCLUSION: a house agent (is_house) never appears on the board despite paid sales
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > HOUSE-EXCLUSION (avatar leg): a house user's avatar is suppressed via the user_id join
(skip) land.service.sold — scoring CTE (requires DATABASE_URL) > (unnamed)
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores one base trade as 20 points on the agent leg
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores one ANSEM trade as 40 points
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores one CLAWVILLE trade as 30 points
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > caps 30 base trades at 20 scored trades and 400 points
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > preserves the tier gradient under the proportional cap
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > scores the avatar leg identically to the agent leg
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > excludes house agents
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > excludes guest-owned subjects
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > labels only active ClawVille-operated wallets and handles null avatars
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > keeps the fleet label outside scoring
(skip) Trading Floor leaderboard scoring (requires DATABASE_URL) > (unnamed)
(skip) quest player routes — agent-or-auth gate (Rule E5) > with a database > an invalid agent-session bearer is rejected 401 (fail-closed), not demoted
(skip) tutorial ladder — agent-session resolution (DB tier) > POST /api/quests/tutorial/say-hi-nori/claim → rejects an unresolvable agent session (401, session-aware)
(skip) tutorial ladder — agent-session resolution (DB tier) > GET /api/quests/tutorial/claims → rejects an unresolvable agent session (401, session-aware)
(skip) quest race guards (DB) > concurrent duplicate active-submission inserts: exactly one wins (unique index)
(skip) quest race guards (DB) > CAS submit predicate cannot reopen an approved submission (round-2 HIGH #1)
(skip) quest race guards (DB) > round 3: one payout per (quest, avatar) — duplicate reward 23505; approved row blocks the accept predicate
(skip) quest race guards (DB) > round 3: expired active quest fails the accept lookup predicate
(skip) quest race guards (DB) > round 5: native quest actions fail closed on unresolvable + guest identities
(skip) quest race guards (DB) > completion-slot consume: second approval of a 1-max quest gets 0 rows
(skip) trading wallet agent-session routes (requires DATABASE_URL) > binds through a real agent gateway session and rejects cross-kind revoke

 451 pass
 163 skip
 0 fail
 7411 expect() calls
Ran 614 tests across 46 files. [2.41s]
```

### 8.4 Route isolated files

Command: cd apps/api && bun test <each CI isolated file in a separate Bun process>

Exit code: 0

```text
﻿===== agent-frontdoor-connect | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\agent-frontdoor-connect.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ auth for agents [www.vestauth.com]
[AutonomyStandby] active -> active (reason: default)
(pass) logged-out front-door agent connect > strict Zod schemas reject unknown or malformed public inputs [2.83ms]
(pass) logged-out front-door agent connect > rejects a malformed public status token before pending lookup [6.31ms]
(pass) logged-out front-door agent connect > mints without Lucia, remains unbound, and stores only poll-secret digest [2.76ms]
(pass) logged-out front-door agent connect > hard-limits public mint to five requests per minute per trusted IP [1.57ms]
(pass) logged-out front-door agent connect > caps slow public minting at twenty-five requests per IP each day [3.69ms]
(pass) logged-out front-door agent connect > does not reserve an unbound public token when identityKey is missing [4.23ms]
[AgentConnect] identity credential owner mismatch for agentId=frontdoor-owned-agent; preserving existing owner
(pass) logged-out front-door agent connect > preserves a different existing owner and issues no public handoff [2.40ms]
[OpenClaw] Avatar injected: "frontdoor-expiry-race-ag" (oc-sess:e93cda9b37e14f36) [self-managed]
[OpenClaw] Unregistered: sess:e93cda9b37e14f36
(pass) logged-out front-door agent connect > preserves an in-progress claim across the original token expiry [11.51ms]
[OpenClaw] Avatar injected: "Front Door" (oc-sess:cf094ff51dce0800) [self-managed]
[OpenClaw] Unregistered: sess:cf094ff51dce0800
(pass) logged-out front-door agent connect > claims into a real user/avatar and returns one fingerprint-bound enterUrl only [2.19ms]

 9 pass
 0 fail
 87 expect() calls
Ran 9 tests across 1 file. [728.00ms]

===== agent-public-identity-schema | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\agent-public-identity-schema.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ suppress logs { quiet: true }
[AutonomyStandby] active -> active (reason: default)
(pass) public agent identity input > trims, lowercases, and accepts bounded framework labels [1.77ms]
(pass) public agent identity input > /connect and /join accept novel labels which share the canonical custom value [1.16ms]
(pass) public agent identity input > presented nanoclaw is schema-valid and canonicalizes to custom for PV23 healing [0.22ms]
(pass) public agent identity input > presented Hatcher stays reserved before catch-all canonicalization [0.14ms]
(pass) public agent identity input > actual /connect rejects public Hatcher without reserving its pending token [9.62ms]
(pass) public agent identity input > actual /connect missing-signal 400 keeps its envelope and adds machine guidance [2.25ms]
[OpenClaw] Avatar injected: "Pull Wire Test" (oc-sess:a570f701396e08e9) [self-managed]
[OpenClaw] Unregistered: sess:a570f701396e08e9
(pass) public agent identity input > gateway-less custom client is no-fetch fail-soft and its live session can move [13.67ms]

 7 pass
 0 fail
 30 expect() calls
Ran 7 tests across 1 file. [795.00ms]

===== cosmetic-guest-equip-handler | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\cosmetic-guest-equip-handler.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ enable debugging { debug: true }
(pass) authenticated guest cosmetic equip handler > equips a cosmetic owned by the guest avatar [6.86ms]
(pass) authenticated guest cosmetic equip handler > unequips a cosmetic owned by the guest avatar [0.53ms]

 2 pass
 0 fail
 6 expect() calls
Ran 2 tests across 1 file. [548.00ms]

===== cove-history | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\cove-history.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ custom filepath { path: '/custom/path/.env' }
(skip) Cove History â€” subject resolution (agent parity hotfix) > (unnamed)
(skip) Cove History â€” subject resolution (agent parity hotfix) > agent-session request scopes history by the BOUND userId (FIX A)
(skip) Cove History â€” subject resolution (agent parity hotfix) > guest-only request (no agent header) does NOT see the agent-owned event
(skip) Cove History â€” subject resolution (agent parity hotfix) > unknown agent session falls through to guest scoping (read-only, no leak)
(skip) Cove History â€” subject resolution (agent parity hotfix) > (unnamed)

 0 pass
 5 skip
 0 fail
Ran 5 tests across 1 file. [458.00ms]

===== ct-topup-settle | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\ct-topup-settle.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ enable debugging { debug: true }
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > happy settle: CLAIM (settling+idem) â†’ facilitator â†’ CAPTURE (signature) â†’ CREDIT BOUGHT [10.96ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > RESUME: a captured row (settling+sig) credits WITHOUT re-calling the facilitator [0.62ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > settled row on load â‡’ idempotent replay; facilitator + credit untouched [0.35ms]
[ct-topup] settled row topup-1 has NO tx_signature â€” refusing replay (corruption)
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > settled row WITHOUT a signature â‡’ replay REFUSED (corruption guard) [0.19ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > idem-key reuse on ANOTHER top-up â‡’ claim 23505 â‡’ 409 conflict, NO money [0.57ms]
[ct-topup] SIGNATURE CONFLICT â€” settled tx SIG_TOPUP_1 already owned by another top-up; topup=a1a1a1a1-0000-4000-8000-000000000001 â†’ reconcile (no credit)
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > SIGNATURE CONFLICT: capture 23505 (sig owned by another top-up) â‡’ 409 reconcile, credit ZERO [0.78ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > DEFINITIVE verify rejection â‡’ 402 terminal failed; no credit [0.28ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > VERIFY-phase transport error â‡’ 402, claim RELEASED to pending (no money, no failed) [0.36ms]
[ct-topup] AMBIGUOUS SETTLE â€” facilitator /settle threw; money-state unknown; topup=a1a1a1a1-0000-4000-8000-000000000001 â†’ reconcile (no re-settle)
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > SETTLE-phase error (ambiguous) â‡’ 409 reconcile, NEVER pending (Codex round-2 BLOCKING) [0.35ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > post-settle independent proof failure preserves the signature and credits nothing [0.28ms]
[ct-topup] STALE SETTLING CLAIM â€” topup=topup-1 settling 600s with no signature; money-state UNKNOWN â†’ reconcile (no facilitator re-call)
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > STALE settling claim (no signature, aged) â‡’ 409 reconcile, facilitator NOT re-called [0.39ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > FRESH settling claim (no signature, recent) â‡’ 409 settle_in_flight [0.25ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > client-echo mismatch (usdCents disagrees with the row) â‡’ 400 quote_mismatch, no claim [0.20ms]
(pass) ct-topup settle â€” durable claim â†’ capture â†’ resumable credit > foreign topupId (caller-bound load misses) â‡’ 404, facilitator untouched [0.16ms]

 14 pass
 0 fail
 75 expect() calls
Ran 14 tests across 1 file. [721.00ms]

===== kelp | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\kelp.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: â—ˆ secrets for agents [www.dotenvx.com]
(pass) Kelp Forest authenticated traversal and collectible claim > starts only at entry and reveals adjacent descriptors without hidden graph paths [5.54ms]
(pass) Kelp Forest authenticated traversal and collectible claim > rejects a missing predecessor and a non-adjacent predecessor [1.96ms]
(pass) Kelp Forest authenticated traversal and collectible claim > rejects forged, cross-avatar, and expired predecessor tokens [2.43ms]
(pass) Kelp Forest authenticated traversal and collectible claim > enforces the shared physical time floor, then permits the adjacent visit [1.17ms]
(pass) Kelp Forest authenticated traversal and collectible claim > carries the signed spore mask and marks a visited spore beacon [0.67ms]
(pass) Kelp Forest authenticated traversal and collectible claim > shuffles adjacency deterministically per avatar and beacon [10.66ms]
(pass) Kelp Forest authenticated traversal and collectible claim > returns spores_missing without granting when the center mask is incomplete [0.78ms]
(pass) Kelp Forest authenticated traversal and collectible claim > grants the center reward once and returns idempotent success thereafter [0.73ms]
(pass) Kelp Forest authenticated traversal and collectible claim > concurrent duplicate claims both succeed with one ownership row and one completion [0.83ms]
(pass) Kelp Forest authenticated traversal and collectible claim > blocks guests from the reward claim [0.32ms]
(pass) Kelp Forest authenticated traversal and collectible claim > returns a logged 500 when the stable collectible SKU is missing [0.37ms]
(pass) Kelp Forest authenticated traversal and collectible claim > returns a logged 500 when the stable collectible SKU is misconfigured [0.27ms]
(pass) Kelp Forest authenticated traversal and collectible claim > resolves the named agent-session header to its bound avatar for the identical claim path [0.38ms]
(pass) Kelp Forest authenticated traversal and collectible claim > fails closed for an agent session without ledger capability [0.66ms]
(pass) Kelp Forest authenticated traversal and collectible claim > looks up the stable slug at claim time without category hard-binding [0.41ms]
(pass) Kelp Forest authenticated traversal and collectible claim > fails closed before insert when the stable claim-time slug is missing [0.15ms]
(pass) Kelp Forest authenticated traversal and collectible claim > keeps the reward-only sentinel out of the public cosmetics catalog query [3.40ms]

 17 pass
 0 fail
 100 expect() calls
Ran 17 tests across 1 file. [486.00ms]

===== land-tenure-phaseb | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\land-tenure-phaseb.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ override existing { override: true }
[AutonomyStandby] active -> active (reason: default)
(pass) phase B â€” hold stacking math (pure) > per-tier thresholds match the founder-locked ladder [0.10ms]
(pass) phase B â€” hold stacking math (pure) > 500k CLV holds starter+c but NOT starter+c+c (thresholds stack account-wide) [0.07ms]
(pass) phase B â€” hold stacking math (pure) > a single founder hold needs 10M â€” a 9_999_999 wallet fails, 10M passes [0.03ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > full exhaustion: 2000 deposit at 100/wk drains in exactly 20 full draws, then graces, then lapses with forfeit 0 [0.47ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > early release: 3 draws then release refunds EXACTLY deposit âˆ’ draws [0.07ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > mid-life lapse: 5 draws then elapsed grace forfeits the WHOLE remainder to the house â€” nothing refunds [0.07ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > top-up conservation: claim + topup both count as escrow-in; draws + refund equal the combined total [0.10ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > sub-week remainder is preserved: 250 at 100/wk draws 100, 100, then leaves 50 for refund/forfeit [0.09ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > a sub-week remainder opens grace without drawing or advancing the week [0.06ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > sweep idempotency SHAPE: after the advance the week is no longer due â†’ decision is skip (draws nothing) [0.05ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > zero remainder with rent due â†’ grace (never a draw of 0, never a lapse before grace elapses) [0.04ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > anomalous weekly rent (0 / negative / non-integer) â†’ skip, never a draw or grace [0.07ms]
(pass) phase B â€” escrow conservation over decideDepositSweep (pure) > elapsed grace always lapses and forfeits max(0, remainder) â€” even mid-balance [0.04ms]
(pass) phase B â€” deposit-topup zod mirror (deterministic, no DB) > accepts preferred week bounds and the legacy amount bounds [10.13ms]
(pass) phase B â€” deposit-topup zod mirror (deterministic, no DB) > rejects invalid bounds, mixed forms, missing fields, and stray keys [0.76ms]
(pass) P2 retired starter door > POST /claim-starter is a stable pre-auth 409 dead end [6.33ms]
(pass) phase B â€” routing integrity (no DB touch) > POST /parcels/:id/buy -> 409 tenure_model_active for everyone (dead route, pre-auth) [1.89ms]
(pass) phase B â€” routing integrity (no DB touch) > POST /parcels/:id/rent -> 409 tenure_model_active for everyone (dead route, pre-auth) [1.72ms]
(pass) phase B â€” routing integrity (no DB touch) > the three NEW authed writes 401 with zero auth material (mounted under requireAuthOrAgentSession) [2.13ms]
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > (unnamed)
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > grandfathered hold pays weekly upkeep (owner debit â†’ treasury) with NO CLV check, exactly once per due week
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > insufficient CT on a hold opens grace (no partial debit); elapsed grace evicts and clears every hold field
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > claim-hold without a declared wallet -> 403 wallet_not_declared (fail-closed, parcel untouched)
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > deposit-topup on a NON-deposit parcel -> 409 not_deposit_tenure; on someone else's -> 403
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > mixed-subject stacked holds (per-subject CLV re-check) > (unnamed)
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > mixed-subject stacked holds (per-subject CLV re-check) > KEEPS a fully-funded agent hold when a user hold coexists (agent wallet == agent-subject sum; subject-blind sum would grace)
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > mixed-subject stacked holds (per-subject CLV re-check) > KEEPS a fully-funded user hold in the symmetric direction (user wallet == user-subject sum)
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > mixed-subject stacked holds (per-subject CLV re-check) > still GRACES when the subject's OWN wallet is short â€” the fix scoped the sum, it did not disable the check
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > mixed-subject stacked holds (per-subject CLV re-check) > (unnamed)
(skip) phase B â€” money-path E2E (requires DATABASE_URL + migration 0013) > (unnamed)

 19 pass
 11 skip
 0 fail
 64 expect() calls
Ran 30 tests across 1 file. [777.00ms]

===== moonpay | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\moonpay.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ enable debugging { debug: true }
(pass) webhook â€” DB-enforced idempotency by external_tx_id > FIRST delivery (terminal): inserts with processed_at claimed â†’ 200 replay:false [9.53ms]
(pass) webhook â€” DB-enforced idempotency by external_tx_id > REPLAY of a processed tx: insert conflicts + guarded update matches 0 rows â†’ 200 replay:true, ZERO re-processing [1.36ms]
(pass) webhook â€” DB-enforced idempotency by external_tx_id > PROGRESSION pending â†’ completed: guarded update claims processed_at exactly once [1.36ms]
(pass) webhook â€” DB-enforced idempotency by external_tx_id > non-terminal replay (pending again on a processed row) is still replay:true [0.66ms]
(pass) webhook â€” signature + input hygiene (never 5xx on bad input) > missing signature â†’ 401, NO DB touch [0.50ms]
(pass) webhook â€” signature + input hygiene (never 5xx on bad input) > tampered body under a valid-format signature â†’ 401, NO DB touch [0.64ms]
(pass) webhook â€” signature + input hygiene (never 5xx on bad input) > valid signature over malformed JSON â†’ 400 [0.70ms]
(pass) webhook â€” signature + input hygiene (never 5xx on bad input) > valid signature over a body missing data.id â†’ 400 [0.99ms]
(pass) webhook â€” signature + input hygiene (never 5xx on bad input) > unconfigured webhook key â†’ 503 (MoonPay retries once provisioned) [0.50ms]
(pass) verifyMoonpayWebhookSignature â€” crypto unit > accepts the real t.body hex HMAC and rejects tampering [0.08ms]
(pass) verifyMoonpayWebhookSignature â€” crypto unit > rejects malformed headers cleanly (no throw) [0.04ms]
(pass) buildSignedWidgetUrl + computeCardFee â€” config unit > signs a sandbox URL whose signature recomputes over url.search [0.35ms]
[moonpay] MOONPAY_API_KEY is not a pk_test_ key â€” refusing (test-mode only build)
(pass) buildSignedWidgetUrl + computeCardFee â€” config unit > REFUSES a live (non-pk_test_) publishable key â€” test-mode pin [0.06ms]
(pass) buildSignedWidgetUrl + computeCardFee â€” config unit > returns null when keys are missing [0.06ms]
(pass) buildSignedWidgetUrl + computeCardFee â€” config unit > computeCardFee: +4.5% default, fee rounds UP (house-favorable) [0.12ms]
(pass) /widget-url â€” auth gate present (E5 middleware chain) > no cookie + no agent header â†’ 401 before any handler logic [0.57ms]

 16 pass
 0 fail
 53 expect() calls
Ran 16 tests across 1 file. [502.00ms]

===== partner-covenant | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\partner-covenant.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ multiple files { path: ['.env.local', '.env'] }
(pass) parseCovenantAllowedIps > parses a comma list with surrounding + empty-segment whitespace [0.30ms]
(pass) parseCovenantAllowedIps > returns [] for missing/blank input [0.06ms]
(pass) isCovenantIpAllowed > is exact-match membership [0.12ms]
(pass) covenant config gate > isCovenantConfigured requires BOTH pubkey and an allowed IP [0.38ms]
(pass) getClientIp (CF-aware extraction reused by the gate) > prefers cf-connecting-ip over x-forwarded-for [0.10ms]
(pass) getClientIp (CF-aware extraction reused by the gate) > falls back to the LAST x-forwarded-for entry when no cf header [0.08ms]
(pass) requireCovenantPartner middleware > 503 partner_not_configured when env is unset [4.33ms]
(pass) requireCovenantPartner middleware > 503 when pubkey is set but the IP allowlist is empty [0.73ms]
(pass) requireCovenantPartner middleware > 403 when configured but the client IP is not allowlisted [0.66ms]
(pass) requireCovenantPartner middleware > 401 when the IP is allowed but the signature is missing [0.47ms]
(pass) requireCovenantPartner middleware > 401 when the signature is present but forged (wrong key) [10.58ms]
(pass) requireCovenantPartner middleware > 401 when the timestamp is stale (outside the Â±5 min window) [2.72ms]
(pass) requireCovenantPartner middleware > passes to the handler on a valid signature from an allowed IP [7.02ms]
(pass) requireCovenantPartner middleware > exposes the covenant partner id as "covenant" [0.06ms]
(pass) partner-covenant handler response shapes (mocked db) > GET /bounties returns EXACTLY {bounties, limit, offset} + fixed item keys [7.37ms]
(pass) partner-covenant handler response shapes (mocked db) > GET /bounties/:id/verification returns EXACTLY the 6-key bundle + fixed nested keys [7.15ms]
(pass) partner-covenant handler response shapes (mocked db) > GET /agents/:avatarId returns EXACTLY {avatar, reputation, agentIdentity} + fixed nested keys [5.35ms]
(pass) partner-covenant handler response shapes (mocked db) > GET /agents/:avatarId returns opaque 404 when the avatar is unknown [5.65ms]

 18 pass
 0 fail
 51 expect() calls
Ran 18 tests across 1 file. [259.00ms]

===== partner-hatcher-p5-handler | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\partner-hatcher-p5-handler.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: â—ˆ encrypted .env [www.dotenvx.com]
[AutonomyStandby] active -> active (reason: default)
[NPC Simulation] Starting in world mode with 16 NPCs
[OpenClaw] Avatar injected: "p5-held-tx" (oc-sess:dc77590409f7f686) [server-managed]
[OpenClaw] Unregistered: sess:dc77590409f7f686
(pass) Hatcher P5-1 + P5-2 â€” handler-driven (mocked db, real sim) > P5-1 (commit-first): register spawns AFTER the DB tx commits, not inside it [17.76ms]
[OpenClaw] Override registered: milady-aria -> sess:1883edf5331ddeea (server-managed)
[Hatcher/register] in-world spawn failed: 1521 |   registerAgentBot(config: AgentSubstrateRegistration, client: AgentSubstrateClient, restoredState?: { lastX?: number; lastY?: number; knowledge?: string[] }) {
1522 |     if (config.mode === 'override') {
1523 |       if (!this.npcs.has(config.targetNpcId)) throw new Error(`NPC "${config.targetNpcId}" not found`);
1524 |       // Typed sentinel (not a bare Error) so the partner-hatcher P5-2 path can map
1525 |       // an occupied target to 409 via `instanceof`, never message-string matching.
1526 |       if (this.npcOverrides.has(config.targetNpcId)) throw new OverrideTargetUnavailableError(config.targetNpcId);
                                                                  ^
OverrideTargetUnavailableError: NPC "milady-aria" is already overridden
 targetNpcId: "milady-aria",

      at registerAgentBot (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\npc-simulation.ts:1526:60)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\partner-hatcher.ts:1147:21)
      at async withKeyedMutex (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\keyed-mutex.ts:58:18)
      at async <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\partner-hatcher.ts:881:25)

[OpenClaw] Unregistered: sess:1883edf5331ddeea
(pass) Hatcher P5-1 + P5-2 â€” handler-driven (mocked db, real sim) > P5-2: OVERRIDE register whose target NPC is occupied -> 409 override_target_unavailable, NO sessionId, no live body [8.22ms]
[OpenClaw] Avatar injected: "p6-patch-override" (oc-sess:b729d7f31b2e0851) [server-managed]
[OpenClaw] Override registered: milady-hana -> sess:7cb922c4eaad24aa (server-managed)
[OpenClaw] Unregistered: sess:b729d7f31b2e0851
[Hatcher/patch] re-register failed: 1521 |   registerAgentBot(config: AgentSubstrateRegistration, client: AgentSubstrateClient, restoredState?: { lastX?: number; lastY?: number; knowledge?: string[] }) {
1522 |     if (config.mode === 'override') {
1523 |       if (!this.npcs.has(config.targetNpcId)) throw new Error(`NPC "${config.targetNpcId}" not found`);
1524 |       // Typed sentinel (not a bare Error) so the partner-hatcher P5-2 path can map
1525 |       // an occupied target to 409 via `instanceof`, never message-string matching.
1526 |       if (this.npcOverrides.has(config.targetNpcId)) throw new OverrideTargetUnavailableError(config.targetNpcId);
                                                                  ^
OverrideTargetUnavailableError: NPC "milady-hana" is already overridden
 targetNpcId: "milady-hana",

      at registerAgentBot (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\npc-simulation.ts:1526:60)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\partner-hatcher.ts:1613:29)
      at async withKeyedMutex (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\keyed-mutex.ts:58:18)
      at async <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\partner-hatcher.ts:1305:25)

[OpenClaw] Avatar injected: "p6-patch-override" (oc-sess:b729d7f31b2e0851) [server-managed]
[OpenClaw] Unregistered: sess:7cb922c4eaad24aa
[OpenClaw] Unregistered: sess:b729d7f31b2e0851
(pass) Hatcher P5-1 + P5-2 â€” handler-driven (mocked db, real sim) > P6-2: PATCH override to an occupied target -> 409 AND the committed row is compensated back to the PRIOR body (mode/target/token), not the failed target [17.37ms]
[OpenClaw] Override registered: milady-yumi -> sess:a9b6e9fa963448c2 (server-managed)
[OpenClaw] Unregistered: sess:a9b6e9fa963448c2
[OpenClaw] Override registered: milady-ren -> sess:375a17b129216fe0 (server-managed)
[Hatcher/patch] re-register failed: 1521 |   registerAgentBot(config: AgentSubstrateRegistration, client: AgentSubstrateClient, restoredState?: { lastX?: number; lastY?: number; knowledge?: string[] }) {
1522 |     if (config.mode === 'override') {
1523 |       if (!this.npcs.has(config.targetNpcId)) throw new Error(`NPC "${config.targetNpcId}" not found`);
1524 |       // Typed sentinel (not a bare Error) so the partner-hatcher P5-2 path can map
1525 |       // an occupied target to 409 via `instanceof`, never message-string matching.
1526 |       if (this.npcOverrides.has(config.targetNpcId)) throw new OverrideTargetUnavailableError(config.targetNpcId);
                                                                  ^
OverrideTargetUnavailableError: NPC "milady-ren" is already overridden
 targetNpcId: "milady-ren",

      at registerAgentBot (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\npc-simulation.ts:1526:60)
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\partner-hatcher.ts:1613:29)
      at async withKeyedMutex (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\services\keyed-mutex.ts:58:18)
      at async <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\partner-hatcher.ts:1305:25)

[OpenClaw] Unregistered: sess:375a17b129216fe0
(pass) Hatcher P5-1 + P5-2 â€” handler-driven (mocked db, real sim) > P6-2 (minted sub-case): PATCH override fail when NO live body exists -> 409 AND the prior bearer hash is RESTORED (failed PATCH is a full session no-op), row compensated to prior body [12.64ms]

 4 pass
 0 fail
 38 expect() calls
Ran 4 tests across 1 file. [638.00ms]

===== world-ws-identity | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\world-ws-identity.test.ts:
(pass) world presence identity resolver > resolves a valid Lucia cookie as human [4.01ms]
(pass) world presence identity resolver > falls through an invalid Lucia cookie to guest [0.96ms]
(pass) world presence identity resolver > resolves a valid agent bearer and fails an invalid bearer closed to guest [0.37ms]
(pass) world presence identity resolver > keeps Lucia precedence over an agent bearer [0.18ms]
(pass) world presence identity resolver > /join stamps a session-scoped cookie committing to its exact guest key [1.55ms]
(pass) world presence identity resolver > pins guest identity across IP-prefix and User-Agent changes [0.81ms]
(pass) world presence identity resolver > pins a tier-1 fingerprint join to a headerless upgrade-shaped request [0.35ms]
(pass) world presence identity resolver > with cookies blocked, remains as consistent as the fingerprint fallback [0.65ms]

 8 pass
 0 fail
 21 expect() calls
Ran 8 tests across 1 file. [61.00ms]

===== x402-stats | exit 0 =====
bun test v1.3.14 (0d9b296a)

src\routes\__tests__\x402-stats.test.ts:
â—‡ injected env (0) from ..\..\.env.local // tip: âŒ˜ multiple files { path: ['.env.local', '.env'] }
[x402/stats] aggregate failed: 56 |   selectError = null;
57 | });
58 |
59 | describe.serial('GET /api/x402/stats', () => {
60 |   it('returns 503 when the aggregate fails before any snapshot is cached', async () => {
61 |     selectError = new Error('database unavailable');
                           ^
error: database unavailable
      at <anonymous> (C:\Users\itachi\Documents\Crypto\cv-floor\apps\api\src\routes\__tests__\x402-stats.test.ts:61:23)

(pass) GET /api/x402/stats > returns 503 when the aggregate fails before any snapshot is cached [2.89ms]
(pass) GET /api/x402/stats > returns the summed all-time x402 volume and payment count [0.34ms]
(pass) GET /api/x402/stats > serves a cache hit without querying the database again [0.25ms]

 3 pass
 0 fail
 12 expect() calls
Ran 3 tests across 1 file. [141.00ms]

```

### 8.5 Existing clv-swap-live suite

Command: cd apps/api && bun test src/services/__tests__/clv-swap-live.test.ts

Exit code: 0

```text
bun test v1.3.14 (0d9b296a)

src\services\__tests__\clv-swap-live.test.ts:
◇ injected env (0) from ..\..\.env.local // tip: ⌘ custom filepath { path: '/custom/path/.env' }
(pass) GATES — the live path is default-off > every live entrypoint refuses when CLV_SWAP_EXECUTE is not "true" [15.56ms]
(pass) GATES — the live path is default-off > NETWORK GUARD: devnet USDC refuses (CLV is mainnet-only) [0.89ms]
(pass) GATES — the live path is default-off > NETWORK GUARD: unset network (devnet-first default) also refuses [0.11ms]
(pass) GATES — the live path is default-off > NETWORK GUARD: the mock facilitator refuses (fake money can never fund a swap) [0.20ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > happy path: claim → custody → capture BEFORE send → confirm → swept [13.75ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > DOUBLE-SWEEP: a second call replays the swept row — no claim, no custody, no send [0.59ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > in-flight sweep refuses; terminal (reconcile/failed) is NEVER retried [1.17ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > amounts tied to SETTLED MAINNET checkouts ONLY [1.83ms]
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > insufficient merchant USDC: releases the claim PRE-send (retryable once funded) [1.05ms]
[clv-swap-live] sweep pre-send failure — funding=fund-11111111-1111-4111-8111-111111111111: rpc_token_account_invalid
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > frozen merchant USDC is not spendable availability and releases before signing [1.14ms]
[clv-swap-live] UNEXPECTED POST-SIGNING ERROR — funding=fund-11111111-1111-4111-8111-111111111111: signer threw after mutation; → reconcile (never release/retry)
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > sign failure after signing starts strands in reconcile and never releases [2.83ms]
[clv-swap-live] UNEXPECTED POST-SIGNING ERROR — funding=fund-11111111-1111-4111-8111-111111111111: capture store unavailable; → reconcile (never release/retry)
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > capture failure after signing starts strands in reconcile and never releases [2.25ms]
[clv-swap-live] AMBIGUOUS SWEEP SEND — funding=fund-11111111-1111-4111-8111-111111111111 tx=2tXgjVeQgqo6PYVfcacGUVopTu5qiJ6AStTK6bDHpoFKuiDUk15FarH4YYEhwbAGPvKVivo5YsMCAcqBtZnJMat3; money-state UNKNOWN → reconcile (no re-send): boom: transport died mid-send
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > AMBIGUOUS send: signature captured, row → reconcile, NEVER retried [5.27ms]
[clv-swap-live] SWEEP TX FAILED ON-CHAIN — funding=fund-11111111-1111-4111-8111-111111111111 tx=2tXgjVeQgqo6PYVfcacGUVopTu5qiJ6AStTK6bDHpoFKuiDUk15FarH4YYEhwbAGPvKVivo5YsMCAcqBtZnJMat3; no USDC moved; row → failed (manual re-run decision)
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > definitive on-chain failure: row → failed (no money moved), loud terminal [3.79ms]
[clv-swap-live] SWEPT-MARK MISSED after confirmed sweep — funding=fund-11111111-1111-4111-8111-111111111111 tx=2tXgjVeQgqo6PYVfcacGUVopTu5qiJ6AStTK6bDHpoFKuiDUk15FarH4YYEhwbAGPvKVivo5YsMCAcqBtZnJMat3; the signature IS captured; manual verify required
(pass) FUNDING SWEEP — exactly-once merchant→swap-wallet USDC > confirmed sweep with a lost terminal CAS goes to reconcile, never reports success [3.63ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > treats an invalid post snapshot for a fresh transient wallet ATA as closed [8.58ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > still rejects a closed canonical CLV ATA post snapshot [3.40ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > still rejects a closed transient ATA that held a pre-simulation balance [4.24ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > credits rent in a CPI-created writable wallet-authority token account [5.64ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > accepts the one-time rent for the wallet's derived Pump user-volume accumulator [4.69ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not accept a newly-created Pump-owned account at a different address [4.73ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not accept the derived Pump user-volume accumulator above the rent cap [3.86ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not credit wallet-owned token-account rent recoverable by a foreign close authority [3.67ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > credits wallet-owned token-account rent when the wallet is the close authority [4.39ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not credit writable token-account rent controlled by a foreign authority [4.54ms]
(pass) validateJupiterSwapSimulation — closed transient ATA handling > does not credit a writable Token-2022 multisig with incidental account-like bytes [5.75ms]
(pass) decodeJupiterV6RouteInstruction — route-agnostic trailing args > decodes a route whose final hop is Pump.fun Amm variant 99 without an AMM allowlist [0.25ms]
(pass) decodeJupiterV6RouteInstruction — route-agnostic trailing args > rejects a truncated route and an unknown discriminator [0.07ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > refuses when the funding is not swept — the claim is never taken [0.39ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > HAPPY PATH: $100 clip cap splits the row; conservation exact; executed [24.28ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accounts from ExactIn threshold, never optimistic Jupiter outAmount [7.03ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > DOUBLE-CLAIM: the second executor loses the claim and never touches custody [9.94ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > RESTART-MID-TICK: a row left "executing" by a crash is NEVER re-claimed [0.45ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > does not call DexScreener on the money path [6.61ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > a thrown pre-sign dependency error releases the empty claim to planned [0.66ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > refuses Jupiter price impact above maxImpactBps before requesting a swap [0.83ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed priceImpactPct "" [0.92ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed priceImpactPct "   " [0.42ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a zero-output Jupiter quote before requesting or signing a swap [0.52ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > ignores the informational wire threshold and accounts from the decoded instruction floor [5.10ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts optional route fee metadata when the complete pair is bounded [5.70ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: amount_only [0.60ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: mint_only [0.45ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: excessive [0.43ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects malformed or unbounded optional route fee metadata: wrong_mint [0.51ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > fresh wallet omits destinationTokenAccount so Jupiter can create the canonical CLV ATA [5.17ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > existing initialized CLV ATA is pinned as destinationTokenAccount [4.89ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > refuses an existing uninitialized CLV ATA before requesting or signing a swap [0.77ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts a current Jupiter V1 route with compute budget, Token-2022 role, repeated wallet/CLV metas, and ALT keys [4.63ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an ALT-loaded writable token account controlled through malicious_wallet_token before signing [3.23ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an ALT-loaded writable token account controlled through malicious_wallet_delegate before signing [3.52ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an ALT-loaded writable token account controlled through malicious_wallet_close before signing [4.16ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a correct-payer transaction containing an arbitrary outer program before sign/capture/send [2.57ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a transaction requiring any signer besides the exact payer [2.33ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts a real multi-hop route with three wallet-owned idempotent ATA setups [5.61ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects an idempotent ATA setup whose owner is not the swap wallet [4.19ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > accepts a high CU price when the decoded total priority fee stays within budget [5.97ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects invalid total-priority-fee shape: priority_over_budget [2.65ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects invalid total-priority-fee shape: priority_without_limit [2.71ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects simulation when CLV output is below the decoded on-chain minimum [9.30ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects simulation when another wallet-owned token account decreases [6.33ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > bounds native lamport loss by the transaction actual priority fee, not the global maximum [6.40ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > releases an empty unsigned claim if malformed simulation data throws during parsing [5.15ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > rejects a Jupiter route whose encoded input is not the accepted exact clip [2.56ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > NEVER signs a swap tx whose fee payer is not our wallet [2.67ms]
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > per-row max_slippage (fraction) overrides the env bps, clamped to the ceiling [9.97ms]
[clv-swap-live] AMBIGUOUS CLIP SEND — queue=q-1 clip=0 tx=3ajpAFVQSrXgAWiZNpmkmEPoZvb88pXpUoZsPy3nTfbfJqn4xbQzcbs2iHSGNPeN9hKULxWVvcv5EhL74G6zpJnk; money-state UNKNOWN → row stays 'executing', NEVER auto-retried: boom: transport died mid-send
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > AMBIGUOUS clip send: fill already captured, row stays executing, never auto-retried [5.19ms]
[clv-swap-live] CLIP TX FAILED ON-CHAIN — queue=q-1 clip=0 tx=2F1o88ior44M8EmcSdNFA8mAMLJ9N7Qk3TTVrHrjtpt9bGyPaTTvVffDfDMcaG3SP3Jv9kFwfVR1gdJvwd5tjMXe; no funds moved this clip; row stays 'executing' (manual decision)
(pass) LIVE EXECUTION — atomic claim + fixed-clip Jupiter swaps > definitive post-signature clip failure keeps the captured claim executing [4.94ms]
(pass) runLiveClvSwapTick — sweep-then-execute per planned row > one planned row: sweeps its funding then executes the buy [7.60ms]
[clv-swap-live] STALE 'executing' CLAIM — queue=q-stale claimed_at=2026-09-16T12:57:51.487Z amount=$5.000000; crashed claim — manual reconcile required (NEVER auto-resumed)
(pass) runLiveClvSwapTick — sweep-then-execute per planned row > STALE-CLAIM ALERTING: a row stuck 'executing' past the floor pages ops — no retry, no mutation [0.53ms]
(pass) runLiveClvSwapTick — sweep-then-execute per planned row > a FRESH executing claim (younger than the stale floor) is NOT paged [0.28ms]
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > unset → the keyless lite-api default [0.07ms]
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > api.jup.ag (the paid base) is accepted; trailing slashes trimmed [0.13ms]
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'evil.example.com') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'jup.ag.evil.example') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > an OFF-ALLOWLIST https host falls back to the default (never a silent redirect of the money wire) [0.14ms]
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'lite-api.jup.ag') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL (host 'api.jup.ag') is not an allowed Jupiter base — must be https, credential-free, host ∈ {lite-api.jup.ag, api.jup.ag} — falling back to https://lite-api.jup.ag
[clv-swap-live] CLV_SWAP_JUPITER_BASE_URL is not a parseable URL — falling back to https://lite-api.jup.ag
(pass) resolveJupiterBaseUrl — HOST ALLOWLIST (SSRF guard) > non-https / embedded credentials / garbage all fall back to the default [0.15ms]
(pass) resolveClvSwapExecutingStaleMs — default + hard floor > default 300s; below-floor values refuse to the default; valid override honored [0.10ms]
(pass) resolveClvSwapSlippageBps — executable default + bounds > defaults to 200 bps while remaining environment-overridable [0.06ms]
(pass) pure sizing helpers > sizeClipMicro caps every clip at exactly $100 USDC and preserves the remainder [0.04ms]

 78 pass
 0 fail
 298 expect() calls
Ran 78 tests across 1 file. [1149.00ms]
```

### 8.6 Shared typecheck

Command: cd packages/shared && bun run typecheck

Exit code: 0

```text
$ tsc --noEmit
```

### 8.7 Database typecheck

Command: cd packages/database && bun run typecheck

Exit code: 0

```text
$ tsc --noEmit
```

### 8.8 Hatcher self-test

Command: cd apps/api && bun run scripts/hatcher/selftest-e2e.ts

Exit code: 0

```text
=== Hatcher partner-integration self-test (v2 — shipping HEAD) ===
partner pubkey (test): GhV9wKZa1GxhKXZzYJQgbpYYA2tJopkXPCehhQpbSP8b
issuer  pubkey (test): 7iRL1NHc6ef3G78dmNmGoB1RmXgzkA6dsG3BQYZBhFfr

[PASS] A0 loadPartnerPubkeys parses PARTNER_PUBKEYS env
        loadPartnerPubkeys() => {"hatcher":"GhV9wKZa1GxhKXZzYJQgbpYYA2tJopkXPCehhQpbSP8b"} ; expected hatcher=GhV9wKZa1GxhKXZzYJQgbpYYA2tJopkXPCehhQpbSP8b
[PASS] A0b loadPartnerPubkeys returns null on malformed env
        malformed PARTNER_PUBKEYS '{not json' => null (expect null)
[PASS] A1 WRITE accepts a correct signature
        verifyPartnerSignature(correct) => {"ok":true,"partnerId":"hatcher"} (expect {ok:true,partnerId:'hatcher'})
[PASS] A2 WRITE rejects a tampered body
        verify(tampered body, original sig) => {"ok":false,"reason":"bad_signature"} (expect ok:false reason:bad_signature)
[PASS] A3 WRITE rejects a wrong key not in the allowlist
        verify(evil pubkey) => {"ok":false,"reason":"unknown_partner"} (expect ok:false reason:unknown_partner)
[PASS] A4 WRITE rejects missing headers
        missing pubkey => {"ok":false,"reason":"missing_signature"} ; missing sig => {"ok":false,"reason":"missing_signature"} (both expect missing_signature)
[PASS] A5 WRITE rejects a valid sig by a DIFFERENT signer matching no allowlist pubkey
        verify(allowlisted pubkey, sig from other key) => {"ok":false,"reason":"bad_signature"} (expect bad_signature)
[PASS] A6 WRITE rejects bad base58 signature encoding
        verify(bad-b58 sig) => {"ok":false,"reason":"bad_signature_encoding"} (expect a decode/length/sig reject)
[PASS] A7 WRITE verifies signature over EMPTY body (DELETE raw-bytes case)
        verify(empty body, sig over '') => {"ok":true,"partnerId":"hatcher"} (expect ok:true — server verifies the exact empty string)
[PASS] A8 WRITE rejects a sig made over a CANONICALIZED re-serialization (raw-bytes-only contract)
        canonicalForm({"agentId":"selftest-agent-1","cognition":{},"zeta":"last-ke...) != rawBytes({"zeta":"last-key-first","agentId":"selftest-agent-1","cogni...) => differ=true
        verify(sig-over-canonical, transmit-raw) => {"ok":false,"reason":"bad_signature"} (expect bad_signature)
[PASS] W0 partnerWriteChallenge format is exact (domain-separated, body-hash bound, LF-joined)
        partnerWriteChallenge({post,/x,99,'hello'}) => "clawville-partner-write\nPOST\n/x\n99\n2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        expected "clawville-partner-write\nPOST\n/x\n99\n2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
[PASS] W1 WRITE accepts a fresh, correct signature within the window
        verifyPartnerWriteSignature(fresh) => {"ok":true,"partnerId":"hatcher"} (expect ok:true)
[PASS] W2 WRITE rejects a missing X-Hatcher-Timestamp (tsHeader null)
        verify(ts=null) => {"ok":false,"reason":"missing_signature"} (expect missing_signature)
[PASS] W3 WRITE rejects an expired timestamp (outside the window, past)
        verify(ts=window+1ms old) => {"ok":false,"reason":"stale_timestamp"} (expect stale_timestamp); window=300000ms
[PASS] W4 WRITE rejects a future timestamp beyond the window
        verify(ts=window+1ms future) => {"ok":false,"reason":"stale_timestamp"} (expect stale_timestamp)
[PASS] W5 WRITE rejects a non-digit timestamp header
        verify(ts='123abc') => {"ok":false,"reason":"bad_timestamp"} (expect bad_timestamp)
[PASS] W6 WRITE rejects a body tamper (sig over original body, verify with mutated body)
        verify(sig-over-original, mutated-body) => {"ok":false,"reason":"bad_signature"} (expect bad_signature)
[PASS] W7 WRITE rejects a wrong method (sign POST, verify PATCH)
        verify(sig-for-POST, method=PATCH) => {"ok":false,"reason":"bad_signature"} (expect bad_signature, cross-verb replay blocked)
[PASS] W8 WRITE rejects a wrong path (sign /a, verify /b)
        verify(sig-for-/a, path=/b) => {"ok":false,"reason":"bad_signature"} (expect bad_signature, cross-path replay blocked)
[PASS] W9 DOMAIN SEPARATION (a GET-scheme signature does NOT verify as a write)
        verify(GET-domain sig, WRITE verifier, same path/ts) => {"ok":false,"reason":"bad_signature"} (expect bad_signature, a GET sig must NOT verify as a write)
[PASS] W10 WRITE rejects a wrong key not in the allowlist (unknown_partner); and missing pubkey/sig (missing_signature)
        evil-key => {"ok":false,"reason":"unknown_partner"} (expect unknown_partner); missing pubkey => {"ok":false,"reason":"missing_signature"}; missing sig => {"ok":false,"reason":"missing_signature"} (both expect missing_signature)
[PASS] B0 partnerGetChallenge format is exact (uppercased method, LF-joined)
        partnerGetChallenge({get,/test,1234}) => "clawville-partner-get\nGET\n/test\n1234" ; expected "clawville-partner-get\nGET\n/test\n1234"
[PASS] B1 GET accepts a fresh, correct signature within the window
        verifyPartnerGetSignature(fresh) => {"ok":true,"partnerId":"hatcher"} (expect ok:true)
[PASS] B2 GET rejects an expired timestamp (outside replay window)
        verify(ts=window+1ms old) => {"ok":false,"reason":"stale_timestamp"} (expect stale_timestamp); window=300000ms
[PASS] B3 GET rejects a wrong path (signed path != request path)
        verify(sig for other path) => {"ok":false,"reason":"bad_signature"} (expect bad_signature)
[PASS] B3b GET path must EXCLUDE query string (signing with ?query fails)
        verify(signed path incl ?foo=bar, request path-only) => {"ok":false,"reason":"bad_signature"} (expect bad_signature)
[PASS] B4 GET rejects a tampered signature
        verify(tampered sig) => {"ok":false,"reason":"bad_signature"} (expect a sig reject)
[PASS] B5 GET rejects a non-digit timestamp header
        verify(ts='123abc') => {"ok":false,"reason":"bad_timestamp"} (expect bad_timestamp)
◇ injected env (0) from ..\..\.env.local // tip: ⌘ custom filepath { path: '/custom/path/.env' }
[AutonomyStandby] active -> active (reason: default)
[PASS] C1 publicAgentRecord() strips hatcher: prefix + carries protocol pointer + OMITS all token fields
        keys=["agentId","uuid","identityType","mode","targetNpcId","name","species","color","cognitionBackend","proxyUrl","walletAddress","walletPending","userId","sessionExpiresAt","registeredAt","updatedAt","protocol"]
        agentId=test-agent-123 protocol={"version":60,"contentHash":"sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81","url":"/api/skills/protocol/skill.md"}
        tokenKeyPresent=false ciphertextLeaked=false
[PASS] C2 publicAgentRecord() protocol.contentHash matches the served manual hash (single source)
        record.protocol.contentHash=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81
        live contentHashOf(buildProtocolManual)=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81
        version=60 (PROTOCOL_VERSION=60)
[PASS] C3 publicAgentRecord() carries the bound userId (CT/leaderboard settlement binds to the agent — Rule E5)
        userId=real-user-uuid-42 walletAddress=SoLAvatarWallet22222222222222222222222222222 mode=override targetNpcId=milady-miu (a bound agent must echo its ledger userId + avatar wallet so it plays AS ITSELF, not as a guest)
[NPC Simulation] Starting in world mode with 16 NPCs
[OpenClaw] Override registered: milady-miu -> sess:984d7ab421db1e5d (server-managed)
[Covenant] no avatar attribution for in-world agent body milady-miu; actions continue without records
[PASS] D1 move(x,y) sets a path via findPath
        before path.len=0 after path.len=218 activity=walking
        cleaned speech="On my way."
[PASS] D2 emote(name=wave) sets activity+emoji from HATCHER_EMOTE_MAP
        activity=socializing emoji=👋 cleaned="Hi!" (expect socializing/wave-emoji/'Hi!')
[PASS] D3 enter_building(buildingId) walks toward a whitelisted building
        path.len=309 destinationBuildingId=messaging-channels (expect messaging-channels)
        cleaned="Heading in."
[PASS] D4 talk_to_npc(npcId,message) actually injects an agent_chat event (observed, not inferred)
        agent_chat events with "d4-positive-1789563948812": before=0 after=1 (expect +1) cleaned="" target=milady-kyoko
[Hatcher] action dropped — not in whitelist: "selfdestruct"
[PASS] D5 unknown verb is DROPPED (no state change) and stripped
        activity stayed=idle cleaned="Doing something weird." (unknown verb must not execute, tag stripped)
[Hatcher] emote dropped — unknown name "constructor"
[PASS] D6 prototype-pollution emote(name=constructor) is DROPPED (Object.hasOwn guard)
        activity after=idle (expect idle) cleaned=""
[Hatcher] enter_building dropped — unknown buildingId "__proto__"
[PASS] D6b prototype-pollution enter_building(buildingId=__proto__) is DROPPED
        destinationBuildingId after=messaging-channels (unchanged=messaging-channels) cleaned=""
[Hatcher] action cap (4) reached for milady-miu — remaining tags stripped, not executed
[PASS] D7 action cap=4 — EXACTLY 4 executed (5th/6th never applied to state)
        4th(scan) emoji=🔍 6th(celebrate) emoji=🎉 finalEmojiAfter6Tags=🔍 (final == 4th, != 6th => exactly 4 executed) cleaned="done"
[Hatcher] action cap (4) reached for milady-miu — remaining tags stripped, not executed
[PASS] D8 over-length reply (50 tags) bounded by cap, never throws, all stripped
        input had 50 tags; cleaned="tail" (no throw, all tags stripped, only first 4 executed)
[Hatcher] move dropped — out-of-bounds/invalid (x=10, y=99999)
[PASS] D9 out-of-bounds move params are DROPPED
        path.len after=0 (expect 0 — out-of-bounds dropped) cleaned=""
[Hatcher] move dropped — out-of-bounds/invalid (x=abc, y=200)
[PASS] D9b non-finite move params (x=abc) are DROPPED
        path.len after=0 (expect 0 — Number.isFinite guard) cleaned=""
[Hatcher] talk_to_npc dropped — unknown target "no-such-npc-xyz"
[PASS] D10 talk_to_npc with unknown target is DROPPED (no agent_chat event)
        agent_chat events with "d10-negative-1789563948813": before=0 after=0 (expect unchanged) cleaned=""
[PASS] D11 enter_cove() HAPPY PATH — walks to the Cove, tags dest=cove, stays 'walking' with the 🎰 wire emoji and no activity clock
        path.len=71 (expect >0) destinationBuildingId=cove (expect 'cove') activity=walking (expect 'walking') emoji=🎰 (expect 🎰) activityEndsAt=0 (expect 0) cleaned="To the casino"
[PASS] E1 buildHatcherWorldState returns documented public fields, NO secret/token field
        shapeOk=true leaked=false playersClean=true npcsClean=true bldClean=true
        self={"name":"Miu","mode":"override","x":9329,"y":12704,"hp":95,"activity":"walking"} nearbyBuildings[0]={"id":"deployment-ops","name":"Lighthouse","cryptoFocus":"agent fleet management, blue-green deployments, Docker containerization, observability dashboards, and scaling agent infrastructure"}
[PASS] E2 buildHatcherWorldState returns null for an unknown npcId
        buildHatcherWorldState(unknown) => null (expect null)
[PASS] F1 signPayload produces a partner-verifiable ed25519 signature over canonical JSON
        nacl.sign.detached.verify(sha256(body), sig, pubkey) => true
        pubkey matches env issuer pubkey: true
        body={"clawville":{"orientation":{"url":"/api/skills/protocol/skill.md","version":60},"playerMessage":"hello"},"max_tokens":5...
[PASS] F2 signPayload canonical JSON is deterministic + key-sorted regardless of input order (OUTBOUND canonicalizes — the trap twin of A8)
        bodyA={"a":1,"b":2,"nested":{"x":2,"y":1}}
        bodyB={"a":1,"b":2,"nested":{"x":2,"y":1}}
        same body=true same sig=true (OUTBOUND signs canonical; INBOUND (A8) signs raw bytes — asymmetric by design)
[PASS] F3 signPayload throws when CLAWVILLE_SERVICE_ISSUER_SK is missing
        signPayload() with no SK env threw=true (expect true)
[PASS] F4 chatHatcherProxy FAILS SOFT on network throw (returns empty, no throw, no token leak)
        threw=false reply="" tokenLeaked=false
        logs=["[Hatcher] proxy cognition failed for agent hatcher:f4: Network error (stubbed) — failing soft"]
[Hatcher] proxy cognition returned 500 for agent hatcher:f5 — failing soft
[PASS] F5 chatHatcherProxy FAILS SOFT on non-2xx response
        threw=false reply="" (500 -> expect '')
[Hatcher] proxy cognition attempted redirect (status 301) for agent hatcher:f6 — refusing to follow, failing soft
[PASS] F6 chatHatcherProxy FAILS SOFT on 3xx redirect (refuses to follow)
        threw=false reply="" (301 -> expect '', no SSRF follow)
[PASS] F7 chatHatcherProxy reply cap = 4000 chars (DoS guard before [ACTION:] parser)
        proxy returned 5000 chars; client truncated to length=4000 (expect 4000)
[Hatcher] proxy URL rejected for agent hatcher:f8: not_https — failing soft
[PASS] F8 chatHatcherProxy FAILS SOFT on SSRF-rejected proxy URL (non-https)
        reply="" fetchCalled=false (http:// proxy -> SSRF reject, no outbound fetch)
[Hatcher] proxy URL rejected for agent hatcher:f8b: resolves_to_private_ip — failing soft
[PASS] F8b chatHatcherProxy DNS-aware reject at call time — allowlisted host resolving to private IP -> no outbound fetch (R2-3)
        reply="" fetchCalled=false threw=false (allowlisted localhost -> resolves 127.0.0.1 -> DNS-aware reject, no outbound fetch)
[OpenClaw] gatewayUrl rejected for agent oc-f8c1: private_ip — failing soft
[OpenClaw] gatewayUrl rejected for agent oc-f8c2: resolves_to_private_ip — failing soft
[PASS] F8c chatOpenAI/chatCustomWebhook SSRF — gatewayUrl pointing at a private IP -> no outbound fetch, fail soft (R2-6)
        both private-gateway cognition calls failed soft with no outbound fetch (R2-6)
[OpenClaw] gatewayUrl attempted redirect (status 302) for agent oc-f8d1 — refusing to follow
[OpenClaw] gatewayUrl (custom webhook) attempted redirect (status 302) for agent oc-f8d2 — refusing to follow, failing soft
[PASS] F8d chatOpenAI/chatCustomWebhook SSRF — gatewayUrl on a PUBLIC host that 302s to a private IP -> redirect NOT followed, fail soft (R2-6 redirect hop)
        both cognition calls hard-failed the 302 and returned no usable reply, no redirected body read (R2-6 redirect hop)
[PASS] F9 SSRF rejects private/link-local/loopback IP literals + non-https; allows allowlisted https
        ok https://169.254.169.254 => {"ok":false,"reason":"private_ip"} (expect ok=false reason=private_ip)
        ok https://192.168.1.1 => {"ok":false,"reason":"private_ip"} (expect ok=false reason=private_ip)
        ok https://127.0.0.1 => {"ok":false,"reason":"private_ip"} (expect ok=false reason=private_ip)
        ok https://[::1] => {"ok":false,"reason":"private_ip"} (expect ok=false reason=private_ip)
        ok http://api.hatcher.host => {"ok":false,"reason":"not_https"} (expect ok=false reason=not_https)
        ok https://api.hatcher.host => {"ok":true,"url":"https://api.hatcher.host/"} (expect ok=true)
        ok https://proxy.hatcher.host => {"ok":true,"url":"https://proxy.hatcher.host/"} (expect ok=true)
        ok https://evil.example.com => {"ok":false,"reason":"host_not_allowlisted"} (expect ok=false reason=host_not_allowlisted)
        ok https://user:pass@api.hatcher.host => {"ok":false,"reason":"credentials_in_url"} (expect ok=false reason=credentials_in_url)
[PASS] F10 DNS-aware SSRF rejects an allowlisted host that resolves to a private IP (localhost)
        validateHatcherProxyUrlResolved('https://localhost', allow=localhost) => {"ok":false,"reason":"resolves_to_private_ip"} (expect resolves_to_private_ip)
[PASS] G1 protocolPointer().contentHash === contentHashOf(buildProtocolManual()) ; version === PROTOCOL_VERSION (single source)
        pointer.contentHash=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81
        contentHashOf(manual)=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81
        protocolContentHash()=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81
        version=60 (PROTOCOL_VERSION=60) url=/api/skills/protocol/skill.md
[PASS] G2 buildProtocolManual is deterministic for a fixed apiBase
        hash run1=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81
        hash run2=sha256:ce1bf5f957b2aa642afe3d24f380af6ed0048928b9656d773269aa09da2eaa81 (must be byte-identical — no randomness/LLM in builder)
[PASS] G3 served manual DOCUMENTS [ACTION: enter_cove()] + the Cove blackjack play flow
        documents enter_cove=true documents cove-play tools=true version-line(v60)=true
[PASS] G4 EXECUTOR verb-set === MANUAL verb-set (whitelist-parity, the same-diff MANDATORY rule)
        executor accepts=[move,emote,enter_building,enter_cove,play_cove_game,claim_parcel,prepay_rent,release_parcel,place_kit_piece,enter_poker_room,enter_kelp_forest,claim_tutorial_quest,salvage_node,trade_token,talk_to_npc] (expect all 15) bogusRejected=true undocumented=[] positiveEffect=true
[PASS] H1 POST /agents with NO signature -> 401 (before persistence)
        status=401 body={"error":"unauthorized"} (expect 401)
[PASS] H2 POST /agents with BAD signature -> 401 (before persistence)
        status=401 body={"error":"unauthorized"} (expect 401)
[PASS] H3 POST /agents with VALID signature but Zod-INVALID body -> 400 (stops before persistence)
        status=400 body={"error":"Invalid request","details":{"formErrors":[],"fieldErrors":{"agentId":["Required"],"cognition":["Invalid literal value, expected \"hatcher-proxy\"","Required","Required"]}}} (expect 400 Invalid request — Zod reject after auth, before DB)
[PASS] H4 GET /agents/:id/stats with NO signature (partner-key-gated read) -> 401
        status=401 body={"error":"unauthorized"} (expect 401 — partner-signed GET required)
[PASS] H5 PATCH /agents/:id with NO signature -> 401
        status=401 body={"error":"unauthorized"} (expect 401)
[Hatcher/patch] DB update transaction failed: 1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED ::1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "::1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)
1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED 127.0.0.1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "127.0.0.1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)

[PASS] H6 PATCH /agents/:id with VALID signature -> auth-ACCEPTED (passes the 401 gate, reaches DB read; no write)
        status=500 body={"error":"update_failed"} (auth-reject twin H5 = clean 401 unauthorized; a SIGNED PATCH must get PAST that — here it reached the un-mocked DB read, proving acceptance; no row returned => no mutation)
1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED ::1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "::1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)
1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED 127.0.0.1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "127.0.0.1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)

[PASS] H7 DELETE /agents/:id with VALID signed body -> auth-ACCEPTED (passes the 401 gate, reaches DB read; no write)
        status=500 body=Internal Server Error (no-sig twin H8 = clean 401 unauthorized; a SIGNED DELETE must get PAST that — reached the un-mocked DB read, proving acceptance; no tombstone written)
[PASS] H8 DELETE /agents/:id with NO signature -> 401
        status=401 body={"error":"unauthorized"} (expect 401)
[PASS] H-REPLAY POST /agents with a correctly-signed but EXPIRED timestamp -> 401 (replay window enforced at the route)
        status=401 body={"error":"unauthorized"} (expect 401 unauthorized: stale_timestamp rejected inside readSignedBody before any DB write); window=300000ms
[Hatcher/register] upsert+hash transaction failed: 1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED ::1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "::1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)
1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED 127.0.0.1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "127.0.0.1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)

[PASS] H9 POST /agents signed, DB-tx FAILS -> 503 session_persist_failed, NO sessionId, NO live body (P4-2)
        status=503 body={"error":"session_persist_failed"} liveBody=false (expect 503 session_persist_failed, no sessionId, no in-memory body)
[OpenClaw] DB upsert error: 1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED ::1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "::1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)
1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED 127.0.0.1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "127.0.0.1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)

[PASS] H10 legacy /api/openclaw/register DB-FAIL -> 500, NO in-memory session (P4-3)
        status=500 body={"error":"Registration failed — could not persist agent. Please retry.","code":"registration_failed"} liveBody=false (expect 500 registration_failed, no sessionId, no in-memory body)
[OpenClaw] Avatar injected: "P4C" (oc-sess:cf620637ea6f81af) [server-managed]
[OpenClaw] Unregistered: sess:cf620637ea6f81af
[OpenClaw] Avatar injected: "P4C" (oc-sess:2bef1b75299f715f) [server-managed]
[OpenClaw] Unregistered: sess:2bef1b75299f715f
[PASS] H11 two concurrent same-agent registers -> ONE body + ONE bearer (P4-1 serialization)
        bodies=1 liveSessions=1 surviving=p4c-dno16ld00e minted=[p4c-rvo880j4rx8,p4c-dno16ld00e] (expect exactly 1 body + 1 live bearer; serialized cleanup evicts the first)
[PASS] I1 GET cove/blackjack/tools.json (live agent session) -> 200, 4 real-CT tools, bet bounds 5..500
        status=200 tools=["cove_blackjack_action","cove_blackjack_close_session","cove_blackjack_deal","cove_blackjack_open_session"] dealBetBounds={"type":"integer","minimum":5,"maximum":500} (expect 4 tools + bet 5..500 real-CT)
[PASS] I2 GET cove/blackjack/tools.json (UNKNOWN session) -> 404 (session-gated)
        status=404 (expect 404 — only a live agent can fetch the bundle)
[PASS] I3 POST cove/blackjack/:tool (UNKNOWN session) -> 404 (no anonymous play)
        status=404 body={"error":"Invalid or expired agent session"} (expect 404 — invalid agent session)
[PASS] I4 POST cove/blackjack/:tool prototype-pollution tool name (constructor) -> 404 unknown_tool (Object.hasOwn guard)
        status=404 body={"error":"unknown_tool","tool":"constructor","knownTools":["cove_blackjack_open_session","cove_blackjack_deal","cove_blackjack_action","cove_blackjack_close_session"]} (expect 404 unknown_tool — inherited prototype key must NOT map to a cove endpoint)
[PASS] I5 cove route getSubject — agent-session header for an UNREGISTERED session -> 401, NOT a silent guest demotion (Rule E5)
        status=401 body=invalid_or_expired_agent_session (expect 401 invalid_or_expired_agent_session — never fall through to guest)
[PASS] I6 resolveAgentSession(unknown) === null (the parity gate that blocks unbound play)
        resolveAgentSession(unknown) => null (expect null — an unknown session can never bind to an avatar/CT)
[OpenClaw] Unregistered: sess:984d7ab421db1e5d
[PASS] J1 validateLiveAgentSession — rotated-away bearer (row hash changed) -> null (R2-2 fail-closed)
        validateLiveAgentSession(old bearer after rotation) => null (expect null — a rotated-away in-memory bearer must not keep passing real-CT gates)
[OpenClaw] Override registered: milady-miu -> sess:984d7ab421db1e5d (server-managed)
[PASS] J2 validateLiveAgentSession — re-aligned + re-registered bearer -> LIVE (legit single-session still passes)
        validateLiveAgentSession(aligned bearer) => LIVE hatcher:selftest-d (expect LIVE — the session that minted the current row hash must still validate)
[PASS] J3 validateLiveAgentSession — NULL row hash + live Map entry -> LIVE (R2-2 fixer carve-out: partner-mint null-window must not lock out)
        validateLiveAgentSession(null-hash live session) => LIVE hatcher:selftest-d (expect LIVE — a not-yet-persisted / non-fatal-persist-failed freshly-minted partner session must fall through to the TTL gate, never be locked out)
[PASS] K1 POST /api/agent/connect with agentId "hatcher:hijack" -> 400 (reserved namespace, no row mutation)
        status=400 (expect 400 — reserved partner namespace refused before any DB write)
[SessionSweeper] Failed to extend TTL for hatcher:selftest-d: warn: connect ECONNREFUSED ::1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "::1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)
warn: connect ECONNREFUSED 127.0.0.1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "127.0.0.1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)

[AgentConnect] DB error: 1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED ::1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "::1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)
1173 |   afterConnect(status, self._handle, req, readable, writable);
1174 | }
1175 | function createConnectionError(req, status) {
1176 |   let details;
1177 |   if (req.localAddress && req.localPort)
1178 |   let ex = new ExceptionWithHostPort(status, "connect", req.address, req.port);
                  ^
error: connect ECONNREFUSED 127.0.0.1:5432
   errno: -4078,
 syscall: "connect",
    port: 5432,
 address: "127.0.0.1",
    code: "ECONNREFUSED"

      at createConnectionError (node:net:1178:12)
      at afterConnectMultiple (node:net:1167:35)
      at connectError (node:net:352:48)

[PASS] K2 POST /api/agent/connect with an ORDINARY agentId is NOT blocked by the reserved guard (regression: legit connect still reaches its normal path)
        status=500 body={"error":"Database error during agent registration"} (expect NOT the reserved-namespace 400 — an ordinary id must pass the gate)
[NPC Simulation] Stopped

========================================================
SUMMARY: 86 PASS / 0 FAIL / 0 SKIP  (total 86)
BUGS FOUND: none
========================================================
HARNESS EXIT: 0
```

### 8.9 Git diff stat

Command: git diff --stat

Exit code: 0

```text
 ARCHITECTURE.md                                    |   45 +
 FOUNDER-REVIEW.md                                  |   11 +
 GameFeatures.md                                    |   16 +
 WAVE2-IMPLEMENTATION-REPORT.md                     | 6257 ++++++++++++++++++++
 .../agent-connect/hosted-skill-runtime-probe.ts    |  136 +-
 apps/api/scripts/hatcher/selftest-e2e.ts           |   15 +-
 apps/api/src/index.ts                              |   31 +
 apps/api/src/middleware/money-operator-only.ts     |   64 +
 apps/api/src/routes/admin-trading.ts               |   82 +
 apps/api/src/routes/trading-floor.ts               |   57 +
 apps/api/src/routes/world.ts                       |    2 +-
 .../__fixtures__/jupiter/quote-ansem-usdc.json     |    1 +
 .../__fixtures__/jupiter/quote-sol-ansem.json      |    1 +
 .../__fixtures__/jupiter/quote-usdc-ansem.json     |    1 +
 .../__fixtures__/jupiter/quote-usdc-clv.json       |    1 +
 .../__tests__/agent-autonomy-round1.test.ts        |   52 +
 .../services/__tests__/trade-token-grammar.test.ts |   48 +
 .../__tests__/trading-decision-feed.test.ts        |   74 +
 .../__tests__/trading-floor-constants.test.ts      |    4 +
 .../__tests__/trading-jupiter-fixtures.test.ts     |  102 +
 .../src/services/__tests__/trading-limits.test.ts  |   40 +
 .../src/services/__tests__/trading-signer.test.ts  |  117 +
 .../__tests__/trading-swap-validator.test.ts       |  198 +
 .../__tests__/trading-wave2-structure.test.ts      |  162 +
 apps/api/src/services/agent-autonomy-driver.ts     |   31 +-
 .../api/src/services/autonomous-trading-targets.ts |  104 +
 apps/api/src/services/npc-simulation.ts            |  197 +-
 apps/api/src/services/skill-protocol.ts            |   23 +
 apps/api/src/services/trading-decision-feed.ts     |   44 +
 apps/api/src/services/trading-execution.ts         |  389 ++
 apps/api/src/services/trading-fleet-equity.ts      |  138 +
 apps/api/src/services/trading-guardrails.ts        |  367 ++
 apps/api/src/services/trading-jupiter.ts           |  181 +
 apps/api/src/services/trading-links.ts             |   77 +
 apps/api/src/services/trading-mint-info.ts         |  109 +
 apps/api/src/services/trading-signer.ts            |  105 +
 apps/api/src/services/trading-swap-validator.ts    |  272 +
 apps/api/src/services/usdc-spend-admission.ts      |    6 +
 docs/clawpump-integration.md                       |   36 +
 docs/hatcher-integration-spec.md                   |    2 +
 .../agent-templates/src/locations/town-guide.ts    |    1 +
 .../migrations/0064_clawpump_trading_floor.sql     |   79 +
 packages/database/src/schema/index.ts              |    1 +
 packages/database/src/schema/trading-fleet.ts      |  116 +
 packages/shared/src/constants/building-tools.ts    |   14 +
 packages/shared/src/constants/hatcher-actions.ts   |    7 +-
 packages/shared/src/constants/orientation-skill.ts |    4 +
 packages/shared/src/constants/trading-fleet.ts     |  107 +
 packages/shared/src/index.ts                       |    1 +
 49 files changed, 9911 insertions(+), 17 deletions(-)
```

### 8.10 Git status

Command: git status --short

Exit code: 0

```text
 M ARCHITECTURE.md
 M FOUNDER-REVIEW.md
 M GameFeatures.md
 A WAVE2-IMPLEMENTATION-REPORT.md
 M apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts
 M apps/api/scripts/hatcher/selftest-e2e.ts
 M apps/api/src/index.ts
 A apps/api/src/middleware/money-operator-only.ts
 A apps/api/src/routes/admin-trading.ts
 A apps/api/src/routes/trading-floor.ts
 M apps/api/src/routes/world.ts
 A apps/api/src/services/__tests__/__fixtures__/jupiter/quote-ansem-usdc.json
 A apps/api/src/services/__tests__/__fixtures__/jupiter/quote-sol-ansem.json
 A apps/api/src/services/__tests__/__fixtures__/jupiter/quote-usdc-ansem.json
 A apps/api/src/services/__tests__/__fixtures__/jupiter/quote-usdc-clv.json
 M apps/api/src/services/__tests__/agent-autonomy-round1.test.ts
 A apps/api/src/services/__tests__/trade-token-grammar.test.ts
 A apps/api/src/services/__tests__/trading-decision-feed.test.ts
 M apps/api/src/services/__tests__/trading-floor-constants.test.ts
 A apps/api/src/services/__tests__/trading-jupiter-fixtures.test.ts
 A apps/api/src/services/__tests__/trading-limits.test.ts
 A apps/api/src/services/__tests__/trading-signer.test.ts
 A apps/api/src/services/__tests__/trading-swap-validator.test.ts
 A apps/api/src/services/__tests__/trading-wave2-structure.test.ts
 M apps/api/src/services/agent-autonomy-driver.ts
 A apps/api/src/services/autonomous-trading-targets.ts
 M apps/api/src/services/npc-simulation.ts
 M apps/api/src/services/skill-protocol.ts
 A apps/api/src/services/trading-decision-feed.ts
 A apps/api/src/services/trading-execution.ts
 A apps/api/src/services/trading-fleet-equity.ts
 A apps/api/src/services/trading-guardrails.ts
 A apps/api/src/services/trading-jupiter.ts
 A apps/api/src/services/trading-links.ts
 A apps/api/src/services/trading-mint-info.ts
 A apps/api/src/services/trading-signer.ts
 A apps/api/src/services/trading-swap-validator.ts
 M apps/api/src/services/usdc-spend-admission.ts
 A docs/clawpump-integration.md
 M docs/hatcher-integration-spec.md
 M packages/agent-templates/src/locations/town-guide.ts
 A packages/database/migrations/0064_clawpump_trading_floor.sql
 M packages/database/src/schema/index.ts
 A packages/database/src/schema/trading-fleet.ts
 M packages/shared/src/constants/building-tools.ts
 M packages/shared/src/constants/hatcher-actions.ts
 M packages/shared/src/constants/orientation-skill.ts
 A packages/shared/src/constants/trading-fleet.ts
 M packages/shared/src/index.ts
?? AGENTS.md
?? CLAUDE.md
```

### 8.11 Diff integrity checks

Command results:

```text
git diff --check                         exit 0
git diff --exit-code -- apps/web        exit 0
git diff --exit-code -- apps/api/src/services/clv-swap-live.ts  exit 0
clv clean-filter hash: dd358d81e6724142fc1e8d3e4a4c36e6679d66ce
clv HEAD blob hash:    dd358d81e6724142fc1e8d3e4a4c36e6679d66ce
```
