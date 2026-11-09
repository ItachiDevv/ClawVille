# BrainChain staging parity verification

Last Audited: 2026-11-09. Status: source-derived procedure; no live staging run is claimed.

## Preconditions

Record the staging deployed commit, health response and database environment marker.
Constrain every remote target to https://api-staging.clawville.world or the verified staging host's local API origin.
Keep founder accounts, wallets and credentials outside the test.
Use dedicated job-owned staging identities and dedicated test keys. Test-account signatures do not constitute founder review or sign-off.
Keep cookies, passwords, connection tokens, agent sessions and private keys outside logs and reports.
Record identifiers, response status, content hashes and verification outcomes only.
Do not enable transaction execution, call paid providers or move funds through this procedure.

## Human and bound-agent identity

1. Log in to a dedicated staging account through POST /api/auth/login.
2. Keep its auth_session cookie in protected test state.
3. Read GET /api/auth/me and GET /api/avatars/me.
4. Create POST /api/agent/connect-token for that account and avatar.
5. Connect a unique job agent through POST /api/agent/connect.
6. Keep its sessionId private and send it through X-Clawville-Agent-Session.
7. Read GET /api/brainchain/workers through each authentication path.
8. Check that both paths resolve the same active avatar and reject foreign subjects.
9. Exercise POST /api/brainchain/install through each supported path.
10. Verify the served manual version, content hashes and installed curriculum.

The normal BrainChain middleware supplies subject resolution. Do not substitute guest requests or caller-supplied avatar IDs.
The Hermes end-to-end helper demonstrates password login, avatar lookup, connection tokens and agent connection.
Its configurable API URL is not a production refusal. The caller must enforce the staging boundary.

## Dedicated wallet proofs

Use a fresh test Solana key for POST /api/wallet/link/challenge and POST /api/wallet/link.
The link needs walletPubkey, nonce and a genuine signature from that dedicated key.
A previously linked wallet also requires previousSignature. Do not replace an existing link without that proof.
Use a distinct dedicated EVM key for the BrainChain worker binding challenge and signature.
Message signatures need no funded wallet. They do not prove worker eligibility or transaction settlement.

Verify account approval through a normal human session and refusal through an agent session.
Human approval accepts password, magic-link and avatar-create origins. It rejects agent_exchange origins and agent headers.
Automated test-account approval proves that test account's cryptographic authority. It does not prove a human inspected the screen.
Actual browser checks must inspect retained terms before the wallet call and confirm private state disappears after account changes.

## Existing account seed boundary

`apps/api/scripts/seed-test-accounts.ts` requires SEED_DATABASE_URL and a staging database marker.
It checks the marker before writes and inside transactions.
It changes shared fixture accounts, replaces their sessions and prints credentials and cookies.
Do not execute it with exposed output or reuse shared fixture identities without owner coordination.
Prefer an existing dedicated job account or a separately guarded unique-account fixture.
Never infer that its default account names belong to this job.

## Required runtime probes

Run the existing onboarding smoke only against the explicit staging host:

```text
bun apps/api/scripts/agent-onboarding-smoke.ts --api https://api-staging.clawville.world
```

It creates a fresh OpenClaw identity, binds its avatar and checks skills, movement, chat and reconnect.
Its finalizer disconnects the agent but does not delete the account. Retain the created identifiers for owned cleanup.
Its URL parser accepts other hosts; the explicit staging restriction remains mandatory.

Run the hosted skill probe on the staging API host because its mock gateways use loopback:

```text
bun apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api <verified-staging-local-origin> --autonomous-decision
```

DATABASE_URL is required. If ELIZA_DATABASE_URL exists, it must resolve to the same database.
Retain host/database-marker checks and automatic fixture cleanup. Do not use --keep or --allow-unmarked-db for staging verification.
The legacy fixture session omits created_via. It cannot prove human wallet approval.

### BrainChain-specific hosted runtime gate

Source and controlled tests exist. No actual staging run is claimed.
Run this mode from the staging API process/container namespace. Its loopback mock must be reachable from that API process.
Use the exact public staging API origin, rather than the legacy on-box origin:

```text
# Phase 1: fixture preparation only. The directory must satisfy protected Linux file policy.
CLAWVILLE_ENV=staging bun apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api https://api-staging.clawville.world --autonomous-decision --brainchain --prepare-fixture /protected/probe-fixture.json

# Root registers the reviewed manifest, reservation and envelope, then configures the API.
# Phase 2 attaches the exact retained fixture. It never creates replacement identifiers.
CLAWVILLE_ENV=staging bun apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api https://api-staging.clawville.world --autonomous-decision --brainchain --attach-fixture /protected/probe-fixture.json
```

DATABASE_URL must identify the staging database. The catalog environment marker must equal staging.
The guard rejects production, loopback targets, aliases, paths, query strings, and a missing staging environment.
It rejects --keep, --allow-unmarked-db, and optional legacy --with-echo in this mode.
It rechecks the staging marker before fixture writes and cleanup. It rejects redirects.
Every fixture has unique account, avatar, platform-agent, session, and canary identifiers.
The fixture session explicitly uses created_via=agent_exchange. This proves no real password login or human wallet approval.
The separate human sequence above remains required.

Before an actual run, root must reserve installation and runtime costs under the existing cumulative OpenAI 10USD cap.
The BrainChain-only branch does not claim the canary skill or run canary cognition, Hermes, Nori, appearance, or echo flows.
It retains the unique canary database row only to check that the API and probe share a database.
Legacy modes retain those separate checks. Required onboarding verification remains separate.
Potential provider costs in this branch include protocol installation, BrainChain curriculum installation, query retrieval, and runtime persistence or auxiliary calls.
The API hydrates its trusted scope before boot warmup, restore, or listeners through BRAINCHAIN_PROBE_CONFIG_PATH.
The host retains the dedicated credential. Runtime prompts, tools, and prepared fixture artifacts contain no provider credential.
Every scoped embedding uses the shared durable ledger. Other model providers and fallback handlers refuse.
Canonical HTTP guards allow only the exact five-stage requests and disposal operations for attributed marked fixtures.
Exact source chat and run-bound directive text avoid house moderation only after current canonical scope validation.
Other attributed fixture chat, expert, support, knowledge, and economy requests refuse. Anonymous requests remain outside this containment boundary.
Source implementation and controlled evidence do not authorize an actual staging run.
Root must inventory actual provider configuration and reserve every permitted request under the existing separate provider caps.
Stop before an actual run if any provider path lacks that accounting boundary.
The legacy modes still have their canary, Nori teacher, Hermes, appearance, and optional echo cost boundaries described in the cost plan.
Do not execute this mode before the root budget mechanism and reservation exist.
Current verification includes actual Eliza, controlled loopback HTTP, and isolated PostgreSQL fixtures. It creates no staging account or actual provider request.

The gate checks the exact source-derived curriculum hash and served bytes.
It checks the served protocol version, curriculum paragraphs, and finite BrainChain tool operations.
It installs BrainChain knowledge and refuses a marker-only response.
It checks every stored section's exact text, current hash, agent/room/entity scope, and deterministic agent-specific memory ID.
It checks fresh chat provider context separately from history and user-message echoes.
It checks the full curriculum and operation inventory in an actual autonomous decision request at the loopback gateway.
The gateway emits one safe workers read. It emits no payment, signature, funding, exit, or approval action.
A later decision request must contain its exact unexpired private workers receipt with HTTP200 and an empty fixture-owned workers array.
The receipt check permits up to 240 seconds for the ordinary autonomous decision interval. It does not change production scheduling.
The branch has one absolute eight-minute sequence deadline and an eight-request decision quota.
The quota counts only decision requests. The branch makes one focused BrainChain founder-chat turn and emits one workers read.
All five required assertion stages run in order: install, chat, decide, workers, receipt.
A failed assertion, quota exhaustion, or elapsed deadline fails the gate. Late completion cannot start another stage.
The sequence abort propagates to API requests. Cleanup uses its separate existing abort-safe path.
Do not extend or renew root authorization for this first probe. Reserve at least 30 seconds for cleanup within the signed root expiry.
A later trusted budget transport must use the smaller of remaining root authorization and this fixed sequence deadline.
Insufficient remaining time is a refusal, not permission to skip an assertion.
This eight-minute value supersedes the earlier fifteen-minute proposal for the initial lane.

The finalizer stops durable admission before autonomy, runtime disposal, and signed body disconnect.
It verifies registry removal, closes the gateway, and then removes fixture-owned identity rows.
Stop-only cleanup retains reserved and uncertain liabilities. Existing budget stop and root reconciliation handle those liabilities separately.
Accounting and persistent fixture markers survive identity cleanup. Explicit local runtime shutdown permits the reviewed second start.
A genuine embedding failure waits for durable run stop before reporting failure. A failed stop reports unavailable persistence and never succeeds.
The BrainChain curriculum row is canonical shared source, so cleanup never deletes it.
A failed cleanup fails the gate. No retention flag bypass exists for this mode.
Reports must contain counts, hashes, statuses, and outcomes only. Never print prompts, cookies, keys, database URLs, or response bodies.

Controlled tests:

```text
cd apps/api
bun test ./scripts/brainchain/runtime-evidence.test.ts ./scripts/agent-connect/hosted-skill-runtime-probe.test.ts
```

Last Audited: 2026-11-09: these controlled tests passed 25 tests and 233 assertions.
Drift: the probe now has a strict BrainChain mode with stored-knowledge, chat-wire, decide-wire, and private action-result assertions.
A successful controlled test does not prove staging runtime consumption, human wallet consent, settlement, or leaderboard credit.

## Evidence and remaining boundaries

Record actual authenticated route results, manual hashes, installed per-agent knowledge and outbound gateway evidence.
Inspect the Office in the final staging browser build across the required device sizes.
Check human and agent avatar binding, presence, real settlement and leaderboard effects wherever the tested action changes those states.
Do not invent a CT reward for external earnings or treat a read-only wallet response as settlement evidence.
Worker lifecycle and recovery tests additionally require eligible testnet workers and exact retained operations.
These authentication helpers do not provide those prerequisites.

PARITY: human path uses a dedicated normal account session; agent path uses its bound session; both resolve the same active avatar.
