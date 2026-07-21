# SAP On-Chain Identity — Follow-Up Scope (2026-07-21)

> Pickup doc for a parallel session. Goal: close the gap between "on-chain identity proven"
> and "EVERY agent has an on-chain identity + reputation." Written 2026-07-21 after the
> roadmap session review. Companion memory topic: `project_sap_onchain_agents.md`
> (in the Claude project memory dir) — read it FIRST, it has every tx sig, account, and trap.

## Where this actually stands (verified, not aspirational)

The old blockers are DEAD:
- OOBE redeployed the program to the 0.25 family on BOTH clusters and shipped
  `@oobe-protocol-labs/synapse-sap-sdk@1.0.0`. The settle bug (PrivilegeEscalation) is fixed
  and verified live. They have also released an MCP now (unevaluated — see task 0).
- Our client is migrated to SDK 1.0.0 with byte-parity tests pinned against real devnet txs.
- The FULL rail is proven with real money: register → stake → escrow → settle → finalize →
  x402 payout, conservation-exact, on prod MAINNET (composed bounty rail live on prod since
  2026-07-12; house agent Coralia registered + staked on mainnet).

Two remaining upstream SDK bugs, BOTH worked around (forward to the OOBE dev, but nothing blocks):
1. SDK `/pdas` module (plural) derives WRONG addresses (escrow drops depositor seed + nonce;
   stake uses wallet not agentPda). We import `/pda` (singular) only. NEVER touch `/pdas`.
2. SDK `deposit()` builds SPL remaining-accounts WITH the token mint but the DEPLOYED program
   wants the no-mint shape on all 4 ops. We build deposits empirically (proven vs landed txs).

## What's missing for "every agent has an on-chain identity" — all OUR side now

### 0. (First step) Evaluate OOBE's new MCP
Founder flagged they released an MCP server. Check whether it simplifies registration /
attestation / pricing flows vs our direct SDK client. Do NOT swap proven wire builders for
MCP calls on money paths without byte-parity re-verification — evaluate for the identity
(non-money) leg first.

### 1. Auto-registration at provisioning (backend slice)
`register_agent` only runs when we invoke it manually (house + test agents). Nothing hooks
agent creation → on-chain registration.
- Needs: provisioning hook + durable retry queue (RPC flakes must not lose registrations).
- Register requires non-empty description (on-chain 6024 otherwise) — route zod already enforces.
- Policy decision (see 2) gates WHICH agents and WHEN (at creation vs first economic action).

- [x] **Local implementation + unit verification landed; staging/founder sign-off pending.**
  First-economic-action admission now persists one self-funded identity row per eligible
  avatar; the durable worker owns balance parking, registration adoption/proof recovery,
  bounded retries, and cross-process claim serialization.

### 2. Cost policy (decision, not code)
- Registration parks ~0.056 SOL rent per agent (recoverable via close_agent).
- Stake (ONLY needed for escrow work): 0.1 SOL hard minimum, refundable, 7-day unstake cooldown.
- At $150/SOL: ~$8.40 parked per registered agent; ~$23.40 if staked. 1,000 agents ≈ 56 SOL parked.
- Decide: who funds (house treasury?), which agents qualify (all vs economically-active),
  and cluster (mainnet identity for real agents = real SOL; devnet = free but not "real").
- Recommendation on the table: register on FIRST ECONOMIC ACTION, not at birth.

### 3. Database-backed EIP-8004 registration document (small)
`GET /agents/:sapAgentPda/eip-8004.json` (routes/agent-eip8004.ts) serves a HAND-PINNED
in-code registry with ONE entry (clawville_genesis). Replace with a DB lookup for any
registered agent (keep the honesty contract: only serve agents with real on-chain
registration + tx sigs). URL shape is LOAD-BEARING and immutable once minted.

- [x] **Local implementation + unit verification landed; staging/founder sign-off pending.**
  Genesis remains authoritative and first; both immutable documents share a DB resolver
  that serves only success-state rows carrying a real 64-byte Solana registration
  signature. Pending/failed/unproven identities remain opaque 404s.

### 4. Automate the Metaplex AgentIdentity attach (small-medium)
The 1DREG registry asset (mpl-agent-014 `RegisterIdentityV1`) pointing each agent's on-chain
identity at its eip-8004.json URL was minted ONCE, by hand, for the genesis agent. Automate
that step in the same provisioning flow so verifiers can walk asset → URL → PDA for every agent.

- [x] **Local implementation + unit verification landed; staging/founder sign-off pending.**
  The registrar now uses the SDK Metaplex Core bridge, the avatar's own custodial signer,
  immutable production metadata/EIP URLs, broadcast-safe asset reconciliation, and
  read-only `verifyLink` before recording terminal attachment.

### 5. Reputation writes (the meaty one)
SAP feedback + attestation instructions are BUILT and devnet-proven (create_attestation /
revoke_attestation, subject-never-signs shape confirmed live 2026-06-21) but NO game event
triggers them. Wire: verified bounty completions (Covenant-checked verdicts) → on-chain
attestation/feedback against the hunter agent. This is what turns identity into
identity + reputation. Founder framing (2026-07-21): reputation lives on the SAP network;
Covenant verifies the actions that feed it.

- [x] **Local implementation + unit verification landed; staging/founder sign-off pending.**
  The shared composed-bounty PAID CAS now admits one durable job per bounty after commit.
  Coralia creates/adopts the hunter's standing verified attestation and gives/updates the
  unique feedback pair using the paid-completion score ramp. Pair probes, per-hunter locks,
  oldest-job ordering, exact ambiguous-broadcast adoption, bounded retry/alerting, and the
  default-on `SAP_REPUTATION_WRITES_ENABLED` rollback lever protect the write path. No money
  executor, escrow builder, or settlement gate changed.

## Suggested order for the parallel session
1. Task 0 (MCP eval, quick) → 3 (DB-backed doc) → 1 (auto-register hook + queue) with the
   task-2 decision made inline with founder.
2. Second pass: 4 (identity-asset automation) → 5 (reputation writes).

## Traps (from the memory topic — do not relearn these)
- Deployed program ≠ published on-chain IDL (fetchIdl is STALE 0.18.0) — trust the SDK 1.0.0
  bundled IDL + our empirically-pinned shapes.
- Devnet ≠ mainnet bytecode (different hash/length) — a devnet-green smoke is not mainnet proof.
- `cv-sap*` worktrees: bun auto-loads a parent `.env.local` with a PROD DATABASE_URL —
  neutralize DATABASE_URL before running SAP scripts there.
- Devnet SOL: Helius paid-plan faucet works (`requestAirdrop` on devnet.helius-rpc.com with the
  key from the piq-orchestrator container on the staging box), 1 SOL/24h.
- Deploy-race rule: never hand-trigger Coolify within ~90s of a push; check queue rows first.
