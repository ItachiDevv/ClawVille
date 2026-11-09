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
The current fixture session omits created_via, so the existing probe cannot prove human wallet approval.
BrainChain-specific curriculum, manual, tool and decision-wire assertions require a separate scoped extension before this gate proves the integration.

## Evidence and remaining boundaries

Record actual authenticated route results, manual hashes, installed per-agent knowledge and outbound gateway evidence.
Inspect the Office in the final staging browser build across the required device sizes.
Check human and agent avatar binding, presence, real settlement and leaderboard effects wherever the tested action changes those states.
Do not invent a CT reward for external earnings or treat a read-only wallet response as settlement evidence.
Worker lifecycle and recovery tests additionally require eligible testnet workers and exact retained operations.
These authentication helpers do not provide those prerequisites.

PARITY: human path uses a dedicated normal account session; agent path uses its bound session; both resolve the same active avatar.
