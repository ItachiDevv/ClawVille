# BrainChain CI coverage

Last Audited: 2026-11-09. Status: local implementation; remote workflow execution remains unverified.
Drift: the staging merge f42e5e0f6 moved BrainChain migrations from 0100-0118 to 0101-0119; see "Staging merge renumber" below.

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
It applies vendor ledger migration 0090 and BrainChain migrations 0101 through 0119.
Its filter selects only `01NN_brainchain_*.sql`, so staging's `0100_usepod_deposit.sql` stays outside the fixture.
Existing signer tables skip legacy migration 0103, whose old constraints exclude retained result signatures.
Migration 0107 supplies the current signer constraints.
After every suite, including failures, bootstrap restores migrations 0113, 0116, then 0118 and verifies the exact-consent function wrapper.
This prevents older migration replay, including 0110, from weakening later consent tests.
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
The current inventory contains 23 PostgreSQL suites, including funding and the separate isolated-cognition suite.
The final combined 23-suite result passed after configured-authority consumer and fixture corrections; see the final evidence below.
The initial run exposed a stale signer receipt fixture; its owner added the required gas evidence before the passing run.
An empty disposable PostgreSQL 18.6 database passed full-schema migration replay through 0116 twice, with 200 tables.
Two retained-history bootstrap passes preserved 14 late capture records and four funding records exactly.
The original F2 probe retained transaction locks beyond 2300 ms.
Independent correction probes now confirm owner and authority callbacks release locks before deferred completion, with zero late sends.
The corrected funding suite independently passed seven tests and 42 assertions; policy/client tests passed five tests and 32 assertions.
Combined CI and activation evidence remain separate requirements.
The protected Linux runner passed four suites and 12 tests under the declared Docker profile.
These protected fixtures use synthetic keys and local files. They do not contact providers or chains.
The required PostgreSQL runner also refused absent opt-in before connection.

Remote branch-protection requirements and the first remote workflow result remain release evidence requirements.

PARITY: CI covers the human route/UI and bound-agent action/MCP surfaces. It does not replace live staging parity checks.

## Migration 0117 inventory update

The fixture bootstrap includes migrations 0100 through 0117, with 0102 replay guarded for retained signer history.
Wrapper restoration applies 0112, 0115, then 0117 after each database suite.
The configured-authority database suite runs after signer prerequisites. It independently passed three tests and 12 assertions.
The pure lane also runs apps/api/scripts/brainchain/runtime-evidence.test.ts in its own process.
That controlled loopback suite independently passed five tests and 35 assertions. It makes no live provider request.
Fresh full-schema replay through 0117 passed twice with 200 tables.
Two retained-history bootstrap passes preserved 14 late capture records and 11 funding records.
These targeted results do not replace the pending combined lane result or a remote workflow result.
## First combined 0117 attempt

The PostgreSQL lane passed nine suites before worker-coordinator.test.ts refused a fixture observation without configured-policy evidence.
The pure lane stopped at result-signing-expiry.test.ts because its mock grant lacked the same evidence.
Backend owns both fixture corrections. Production checks remain intact.
The failed logs and reports remain under .brainchain-work with failed-coordinator-0117 and failed-expiry-0117 suffixes.
The protected Linux lane passed four suites and 12 tests, with exactly five reviewed skips.
It used the pinned image, isolated UID, disabled network, read-only root, and five-file verified mount.
These failures prevent a combined-lane approval. No remote CI or staging result is claimed.
## Combined 0117 retry evidence

The corrected pure lane passed 68 isolated suites and 424 tests, with one expected Docker skip.
The PostgreSQL retry passed the coordinator fixture, then stopped at worker-owner-policy.test.ts.
That suite reported eight passes and five failures, including missing configured-policy evidence and a dependent absent issuance.
Backend received the full preserved log: .brainchain-work/ci-postgres-failed-owner-policy-0117.log.
The capture suite had not run when this lane stopped. No complete PostgreSQL result is claimed.
The protected Linux result remains four suites and 12 tests, with five reviewed skips.
No protected-source correction occurred between that run and this retry.
## Final local lane evidence

The final PostgreSQL runner exited zero: 23 isolated suites, 151 tests, and zero skips.
Exact capture passed all ten tests, including the positive case and block/hash mismatch refusal.
Funding passed seven tests. Configured-authority SQL passed three tests. Actual isolated cognition passed both tests.
The exact capture source and test hashes match the recorded retry manifest after execution.
The pure result remains 68 isolated suites, 424 tests, and one expected Docker skip.
The protected Linux result remains four suites, 12 tests, and five explicitly reviewed skips.
The PostgreSQL lane executes the Docker case skipped by pure CI. No PostgreSQL test skipped.
Later fixture corrections changed only PostgreSQL coverage; no protected-source change required another Linux run.

Evidence: .brainchain-work/ci-postgres-results.json and .brainchain-work/ci-postgres-final-0117-retry2.log.
Pure and Linux evidence remain in .brainchain-work/ci-pure-results.json and .brainchain-work/ci-linux-results.json.
The first failure logs remain preserved. The earlier incomplete attempts do not override these final local results.
These are local fixture results. Remote branch protection, remote CI, staging parity, and live activation remain separate requirements.
## Protocol coverage checkpoint

The final source checkpoint found four existing protocol fixtures outside the BrainChain pure inventory, still pinned to version 120.
The fixture owner updated those version assertions to 127.
Two existing brand assertions then exposed CT wording in the new served topic.
The owner changed that reward term to vCLAW and preserved the assertions. No production behavior changed.
The pure runner now executes agent-paid-surface, skill-protocol-onboarding, floor-arena-knowledge, and trading-floor-constants in separate processes.
All four require zero skips. Their inclusion prevents the same inventory omission.
The prior pure report remains preserved as ci-pure-results.before-protocol-expansion.json.
The expanded pure lane exited zero: 72 isolated suites, 498 tests, and one expected Docker skip.
The four added protocol suites all executed with zero skips.
Evidence: .brainchain-work/ci-pure-final-protocol127.log and .brainchain-work/ci-pure-results.json.
This supersedes the earlier 68-suite pure result. PostgreSQL remains 23 suites/151 tests/zero skips; Linux remains four suites/12 tests/five expected skips.
No PostgreSQL, protected-source, or production behavior changed in this coverage correction.

## Migration 0118 CI preparation

Status: inventory preparation only; migration and runtime owners have not frozen all source.
The proposed probe ledger adds probe-embedding-budget.test.ts to the ordered PostgreSQL lane.
The provider suite probe-embedding-provider.test.ts already matches pure service discovery.
Runtime plugin/provider tests require explicit classification because isolated-task discovery does not cover those directories.

Shared close and root reconciliation now read probe tables through compute-accounting.ts.
Bootstrap must apply 0118 before inference-budget-db, inference-proxy-db, root-compute-store PostgreSQL, and worker-owner-policy execute.
Applying 0118 only inside the new probe suite is insufficient.
Preserve the retained-history 0102 guard and exact-consent restoration through 0117.
The current 0118 draft adds its own functions and triggers; no older wrapper replacement is evident in this pre-read.
Confirm that property again at migration freeze before deciding whether per-suite restoration also needs 0118.

The protected root-store bundle now includes the shared accounting dependency.
Rebuild and hash-check the same five-file mount after freeze, then rerun the protected Linux lane.
Its empty-accounting filesystem fixtures do not prove mixed-ledger PostgreSQL reconciliation.
The real PostgreSQL suite and new probe ledger tests must provide that evidence separately.
No combined lane ran during this preparation, and prior passing reports remain unchanged.
## Frozen 0118 registration and protected lane

Bootstrap now includes 19 migrations, 0100 through 0118, before any accounting suite.
The PostgreSQL inventory now contains 24 suites, including probe-embedding-budget.test.ts.
Migration 0118 adds new functions only. Per-suite wrapper restoration remains 0112, 0115, then 0117.
The historical 0102 guard remains intact.
The independent database reviewer owns the isolated fixture while fresh-schema and retained-history checks run.
Scoped CI accounting tests await that exclusive window; no combined runtime lane runs before runtime freeze.

The changed root accounting dependency required fresh protected bundles.
The five-file manifest and import checks passed, followed by four Linux suites and 12 tests with five expected skips.
Evidence: .brainchain-work/ci-linux-0118.log and .brainchain-work/ci-linux-results.json.
Previous protected results and manifest remain under before-0118 filenames.
These filesystem fixtures retain their declared synthetic-accounting scope; they do not replace mixed-ledger PostgreSQL proof.
## Runtime suite classification

The ordered PostgreSQL lane includes probe-bootstrap.test.ts after the probe budget suite.
The cleanup suite now lives at apps/api/scripts/brainchain/probe-runtime-cleanup.test.ts and has an explicit PostgreSQL entry before isolated cognition.
Its path keeps script imports outside the API source root. The runner restores database wrappers after this suite, including failures.
Cleanup uses the guarded actual PostgreSQL fixture and requires migration 0118; it cannot run in the pure lane.
The current PostgreSQL inventory contains 26 suites, including the separate actual isolated-cognition suite.
probe-runtime-scope.test.ts matches existing service pure discovery and runs in its own process, which isolates its module mocks.
packages/agent-runtime/src/probe-runtime.test.ts now has an explicit pure-lane entry.
It exercises the installed Eliza core with controlled embeddings and an in-memory database; it is not PostgreSQL evidence.
All three suites require zero skips in their assigned lanes.
No combined lane ran during this classification; runtime source freeze remains required first.

The pure lane now explicitly includes apps/api/scripts/agent-connect/hosted-skill-runtime-probe.test.ts in its own process.
This closes the scripts-directory discovery gap for prepared attach, phase options, gateway capture, and cleanup-order tests.
These tests use controlled transports and SQL responses; they do not prove actual PostgreSQL or protected Linux file behavior.
The actual Hono request tests remain in probe-runtime-scope.test.ts, which service discovery already includes in a separate process.
The actual PostgreSQL cleanup suite remains in the ordered PostgreSQL lane.
Independent protected-artifact probes remain separate evidence in docs/brainchain-probe-bootstrap-review.md; this inventory change does not add them to CI.
No combined test lane ran for this inventory change. Final runtime source freeze remains required.

## Final runtime checkpoint lanes

The frozen runtime checkpoint passed 26 PostgreSQL suites and 173 tests with zero skips on the isolated 55440 fixture.
This includes prepared bootstrap, actual cleanup, exact capture, and the actual isolated-cognition exchange.
Fresh protected bundles passed four Linux suites and 12 tests with five declared skips.
All 33 runtime manifest hashes matched before and after these lanes.
The prepared artifact wrapper substring and shared root-store hashes also matched their independent Linux evidence.
Evidence: .brainchain-work/ci-postgres-runtime-final.log, .brainchain-work/ci-linux-runtime-final.log, and the corresponding result JSON files.

The first pure attempt failed three human-cookie cases because old database mocks lacked the new canonical marker lookup.
The owner corrected only test fixtures and retained rejection of unexpected raw SQL.
The failed log remains at .brainchain-work/ci-pure-runtime-auth-failure.log.
The pure inventory now includes four explicit, separate middleware and gateway suites for owner proof, TTL renewal, owner reads, and Hydra chat.
Their targeted tests passed before the combined pure retry. This evidence does not claim remote CI or staging execution.
The final pure retry passed 80 isolated suites and 609 tests, with one expected Docker-case skip.
The PostgreSQL lane executes that Docker case separately; it passed there with zero skips.
Evidence: .brainchain-work/ci-pure-runtime-final-retry.log and .brainchain-work/ci-pure-results.json.
All 33 runtime source hashes and all four corrected fixture hashes matched after the final pure run.
The final local process handles exited zero: PostgreSQL 29418 and pure retry 76658.
The first pure handle 50850 exited one; its evidence remains preserved and is not a passing result.

## Staging merge renumber

Merge f42e5e0f6 brought staging commit d81d5d472, which owns `0100_usepod_deposit.sql` and was already applied on the staging database.
The BrainChain migrations had never reached a deployed database, so each moved up by one number. File contents are unchanged.
Mapping: old 0100-0118 = new 0101-0119, in the same order. Sections above this one keep their historical numbers.
Example: historical "0117 configured authority" is now `0118_brainchain_configured_authority.sql`; "0118 probe embeddings" is now 0119.
The trial merge found a real defect: the old bootstrap filter `^01(0\d|1[0-8])_` matched the staging file and refused the 20-file inventory.
The filter now selects only BrainChain files, and the legacy-signer guard names `0103_brainchain_signer_records.sql` exactly.
The merged manual is PROTOCOL 128, because both lines had used 120 for different content.
The first PostgreSQL run on the merged tree failed three purchase tests: `vendor_spend_ledger.signed_tx_b64` was absent.
Staging's schema adds five ledger columns in 0100, and the fixture builds that table from 0090 plus explicit columns.
The bootstrap now adds those five columns and the credit-status check; real databases receive them from 0100.
Merged-tree results, 2026-11-09, itachi222 via a one-shot scheduled task:
pure 80 suites/610 passes/one expected Docker skip; PostgreSQL 26 suites/173 passes/zero skips.
API and web strict TypeScript checks exited zero. The doc path guard passed 808 references with 70 baseline entries.
Protected Linux did not rerun: no protected test or imported service changed. Its result stays 4 suites/12 passes/5 expected skips.
Evidence: .brainchain-work/merge128-*.log, ci-pure-results.merge128.json, ci-postgres-results.merge128-pg2.json.
The failed log remains at .brainchain-work/merge128-postgres.failed-vendor-columns.log. No remote CI result exists.
