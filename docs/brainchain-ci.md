# BrainChain CI coverage

Last Audited: 2026-11-09. Status: local implementation; remote workflow execution remains unverified.

The Gates workflow adds separate BrainChain pure and PostgreSQL/Linux lanes.
Existing Gates jobs remain unchanged. Every test file runs in a separate Bun process.
This prevents module mocks, DOM state, and database imports from contaminating another suite.

## Database boundary

The shared test helper never derives credentials from the application DATABASE_URL.
An explicit BRAINCHAIN_DB_FIXTURE=1 enables fixture access.
BRAINCHAIN_TEST_DATABASE_URL must use literal 127.0.0.1, an explicit unprivileged port, and the brainchain_fixture role and database.
URL options, remote hosts, other databases, and conflicting application database configuration fail before connection.
The database must already exist. Tests cannot create or inspect an administrator database.

On itachi222 only, BRAINCHAIN_LOCAL_FIXTURE=1 permits the existing ignored password file and port 55439.
CI refuses that fallback even when the flag exists. Credentials never appear in runner reports.

The PostgreSQL lane runs fixture DDL sequentially and preserves unrelated databases.
Before tests, its guarded bootstrap creates minimal owner tables and the canonical sessions shape.
It applies vendor ledger migration 0090 and BrainChain migrations 0100 through 0116.
Existing signer tables skip legacy migration 0102, whose old constraints exclude retained result signatures.
Migration 0106 supplies the current signer constraints.
After every suite, including failures, bootstrap restores migrations 0112 then 0115 and verifies the exact-consent function wrapper.
This prevents older migration replay, including 0109, from weakening later consent tests.
The required runner refuses absent opt-in, absent Docker opt-in, and zero executed tests.
It also runs the actual database/proxy/isolated-child exchange with controlled, zero-charge inference.

## Linux boundary

The workflow installs Docker 29.1.3 through a commit-pinned official action on a disposable GitHub runner.
It exposes that daemon and CLI at the production launcher's fixed locations.
These setup steps must never run on a shared development or production host.

The cognition fixture uses the production launcher: pinned Bun image, UID 10002, no network, read-only root, and dropped capabilities.
The signer and protected root-store fixtures use UID 10001 in the same pinned image.
They receive only five compiled fixture files through a read-only mount, plus private writable tmpfs directories.
The runner checks exact directory contents, regular files, and SHA-256 hashes immediately before each container startup.
Bundle compilation disables environment substitution and rejects imports outside built-ins, bun:test, and the compiled signer policy.
No checkout, ignored evidence, node_modules, host credential file, or host environment reaches the container.
They receive no provider credentials, wallet credentials, Docker socket mount, or network access.
Known synthetic signature material remains fixture-only.
Controlled fixture evidence does not prove host power-loss durability or production mount ownership.

## Commands

Build workspace dependencies before the test lanes.

```powershell
bunx turbo run build --filter=@clawville/agent-runtime
bun scripts/brainchain/ci-tests.ts pure
$env:BRAINCHAIN_DB_FIXTURE='1'
$env:BRAINCHAIN_LOCAL_FIXTURE='1'
$env:BRAINCHAIN_DOCKER_FIXTURE='1'
bun scripts/brainchain/ci-tests.ts postgres
```

On Linux with the pinned daemon and image:

```sh
bun scripts/brainchain/ci-tests.ts prepare-linux
bun scripts/brainchain/ci-tests.ts linux
```

The runner writes per-suite execution counts under ignored .brainchain-work/ci-*-results.json.
The pure lane discovers new service tests and rejects unclassified database fixtures.
It includes the EVM and Solana web wallet helpers.
Pure tests reject skips except the one Docker case, which the PostgreSQL lane executes.
A run replaces its previous report with a running marker before tests; only successful runs receive passed status.
Add new database suites to the explicit dependency order before promotion.
The dedicated PostgreSQL suite uses the minimal fixture schema; the existing full-schema migration gate remains separate.
Protected Linux counts must match the reviewed inventory: signer 1/0, journal 3/1, root store 4/3, and trial 4/1 (pass/skip).
Expected skips are Windows-only checks, the separate PostgreSQL check, and the child-only crash entry.
The root-store parent starts the actual crash child. PostgreSQL tests must have zero skips.

## Local evidence, 2026-11-09

The updated pure runner executed 65 isolated suites and 378 tests.
Its one skipped Docker case belongs to the required PostgreSQL lane.
The CI result parser separately passed one test and four assertions, including refusal of one pass plus one skip.
The retained-history PostgreSQL runner through 0115 passed 21 suites and 137 tests with zero skips.
This includes owner policy, signer receipts, scheduler flow, exact consent/capture, Base purchases, Solana purchases, and actual isolated cognition.
The funding suite separately passed four tests and 24 assertions on the real shared pool.
The current inventory contains 22 PostgreSQL suites, including funding and the separate isolated-cognition suite.
The combined 22-suite result remains pending after the funding callback-deadline correction.
The initial run exposed a stale signer receipt fixture; its owner added the required gas evidence before the passing run.
An empty disposable PostgreSQL 18.6 database passed full-schema migration replay through 0116 twice, with 200 tables.
Two retained-history bootstrap passes preserved 14 late capture records and four funding records exactly.
These schema results do not resolve funding F2, whose deferred identity callback retained transaction locks beyond 2300 ms.
Funding service approval remains withheld pending correction and independent liveness probes.
The protected Linux runner passed four suites and 12 tests under the declared Docker profile.
These protected fixtures use synthetic keys and local files. They do not contact providers or chains.
The required PostgreSQL runner also refused absent opt-in before connection.

Remote branch-protection requirements and the first remote workflow result remain release evidence requirements.

PARITY: CI covers the human route/UI and bound-agent action/MCP surfaces. It does not replace live staging parity checks.
