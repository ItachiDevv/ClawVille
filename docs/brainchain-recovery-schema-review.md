# Recovery and funding schema review

Last Audited: 2026-11-09. Status: migrations 0115 and 0116 scoped PASS; F2 correction passes independent probes; combined CI evidence remains separate.

Reviewer: identity_audit. Team: brainchain-office. Scope: migrations 0115 and 0116, their service predicates, and ordered CI replay.
This review does not replace the separate consent C1 review or approve deployment.
The reviewer owns this report, controlled probes, and CI fixture changes after source freeze.
Backend owns capture services and migration 0115. Fit owns funding services and migration 0116.

## Baseline constraints

| Boundary | Required evidence | Current result |
| --- | --- | --- |
| Ordinary expiry | Expired ordinary operations cannot gain first-key authority | 0115 owner suite independently rerun: 9 tests, 57 assertions |
| Exact capture | Original operation, nonce, fees, calldata, result, owner and generation remain bound | PASS: source review, owner suite, and direct SQL tuple oracle |
| Acceptance | PostgreSQL timestamp precision survives acceptance linkage; acceptance commits before key use | PASS: direct SQL equality and independent second-connection visibility |
| Replay and restart | Accepted or uncertain key-use gaps never sign again; captured bytes remain exact | PASS within controlled journal fixtures; physical host durability remains separate |
| Owner authority | Current human approval binds the same avatar and worker used by agent requests; guest and wallet rotation refuse | Awaiting independent schema and service probes |
| Funding identity | Worker, avatar, user, source wallet and chain form one consistent authority | Owner addresses composite binding checks |
| Funding immutability | Intent, source nonce, captured bytes, exposure and first-send evidence cannot change | Owner adds triggers; review pending |
| Funding holds | Unknown send, source receipt, desk report, reorg and expired approval cannot release liability | Service draft retains holds; probes pending |
| Nullable tuples | Partial captures and approvals cannot pass through PostgreSQL UNKNOWN | Capture tuple NULL trap sent to owner before freeze |
| Migration replay | Fresh schema and retained late captures survive repeated ordered runs | Existing fixture skips obsolete 0102 when signer tables exist; 0115/0116 replay pending |

## Phase 0 traps

The review reads the ownership registry and identity, protocol and token domain traps.
Read and write paths must resolve the same active avatar for human and bound-agent subjects.
Guest-owned agents do not gain financial authority. Account wallet rotation invalidates old approval, including A-to-B-to-A changes.
Locks require a consistent order and fresh predicates after waits. Caller-provided flags cannot replace durable authority.

Migration 0115 replaces the old acceptance-expiry CHECK with a separate exact-consent trigger.
Its ordinary acceptance path must retain the previous expiry rule.
An exact authority must not renew compute, clear revocations, increase fees, replace the nonce, or remove liability.
The acceptance timestamp must come from PostgreSQL, without a JavaScript millisecond round trip.

Migration 0116 must bind captured bytes and reservation identity permanently.
PostgreSQL CHECK accepts UNKNOWN. Each all-or-none tuple needs explicit NULL and non-NULL branches.
Source confirmation and destination attribution remain separate. Neither a source receipt nor a desk status proves destination payment.

## CI baseline

Before these migrations, the isolated PostgreSQL lane passed 19 suites and 125 tests with zero skips.
The additional scheduler-flow suite passed one test with zero skips.
The dedicated fixture uses port 55440 and contains only synthetic data.
The shared fixture on port 55439 requires owner coordination.
CI bootstrap and inventory remain unchanged until both schema owners freeze their changes.
No live key, provider call, payment, debt, partner message, or deployment belongs to this review.

PARITY: schema review checks common human and bound-agent owner bindings; it does not claim live staging parity.

## Prepared independent probes

The controlled probes use direct SQL and import no production service predicate.
They wrap all new rows and mutations in a transaction that rolls back.
They remain unexecuted until owner freeze and migration setup.

- `.brainchain-work/schema-0115-audit.ts`: ordinary expiry, live acceptance, acceptance immutability, exact PostgreSQL timestamp/nonce/fee tuples, and append-only capture records.
- `.brainchain-work/schema-0116-audit.ts`: human/agent owner parity, cross-avatar refusal, global source nonce uniqueness, partial tuples, immutable intent/capture/dispatch, and retained reservations across uncertain/source-observed/reorg states.

The capture probe requires a retained late-capture fixture from the controlled owner suite.
Its oracle compares the database records directly rather than calling the service's capture predicate.
No result from these pending probes counts as approval.

## Frozen 0115 evidence and scoped verdict

Verdict: PASS for the reviewed schema and controlled capture boundaries. This does not approve signer activation or deployment.
The separate consent C1 review remains outside this review. Funding migration 0116 remains pending.

| Item | Independent evidence | Scope and result |
| --- | --- | --- |
| Original expiry | Direct SQL rejects late ordinary acceptance and permits an unexpired ordinary acceptance | PASS; cloned synthetic grants prevent interference with existing unique authority records |
| Exact retained fields | Direct SQL compares acceptance timestamps, nonce and fee fields against the stored exact authority | PASS; seven direct SQL invariants, all mutations rolled back |
| Append-only records | Direct SQL attempts authority nonce mutation, authority deletion and acceptance deletion | PASS; each mutation refuses |
| Expiry after waits | Rerun owner tests wait on signer address and stream lock; independent delayed key callback waits beyond consent expiry | PASS; independent callback leaves durable uncertainty with zero key uses |
| Proven owner revocation | Rerun owner test signs once under fresh consent and compares original expiry/revocation rows before and after | PASS; original grants remain unchanged; unknown revocation separately refuses |
| Commit before key | Independent observer uses a separate PostgreSQL connection inside journal-claim and driver callbacks | PASS; both callbacks see committed accepting state and exact late acceptance timestamp |
| Replay and races | Rerun owner tests cover proposed/reserved nonce, two fresh consents, repeated byte recovery, and post-claim revocation | PASS in controlled journal fixtures; no production key or network call |
| Fresh full schema | Generated baseline plus migrations 0100 through 0115 run twice on an empty dedicated database | PASS; 199 tables; baseline SHA-256 recorded in evidence |
| Retained history | Two bootstrap/wrapper/0115 replays compare six existing late capture rows before and after | PASS; exact records remain unchanged; old 0102 check is not replayed over retained signer tables |

Commands independently ran the frozen owner PostgreSQL suite (9 tests/57 assertions) and pure policy suite (2/21).
The separate callback probe passed 2 tests/13 assertions. It reuses controlled fixture setup and adds independent boundary observations.
The direct SQL oracle imports no capture service predicate.
Source review confirms the transaction commits acceptance before protected-store claim, then supplies a fresh authority callback to the signer driver.
The observer probe verifies that ordering through another connection, rather than relying on source inspection alone.

Evidence:
- `.brainchain-work/schema-0115-audit-results.json`: seven independent SQL checks.
- `.brainchain-work/exact-capture-boundary-audit.test.ts`: committed visibility and delayed final callback.
- `.brainchain-work/schema-0115-retained-replay-results.json`: two passes, six late rows unchanged.
- `.brainchain-work/schema-full-115-replay-results.json`: fresh full-schema replay and baseline hash.

Initial probe setup reused an authority with a unique operation constraint. The reviewer corrected the probe to clone synthetic grants.
Ignored test imports also needed explicit workspace dependency paths. These were probe setup errors, not domain findings.

## Funding F2: unbounded callback holds the owner transaction

Original verdict: BLOCKING for the funding service. The correction review below resolves this finding within its stated scope.

Root identified owner callbacks inside transactions and the submit authority callback as a liveness risk.
The reviewer independently reproduced the owner callback case with a one-connection Drizzle pool.
A controlled owner callback waits on a gate after the service acquires avatar and user row locks.
After 2300 milliseconds, the service promise remains unsettled. A second connection receives SQLSTATE 55P03 from an avatar NOWAIT lock.
The probe then releases the callback and awaits the service. Both connections close normally.
SQL statement and lock timeouts do not bound JavaScript awaits.

Required correction: a shared absolute transaction deadline must bound owner and authority callbacks and reject inside the transaction.
Late callback completion must not resume a dispatch or hold the transaction.
The submit authority callback needs its own controlled refusal/dispatch evidence after correction.

Evidence: `.brainchain-work/funding-callback-liveness-audit.ts` and `.brainchain-work/funding-callback-liveness-audit-results.json`.
This is independent evidence for the owner callback case; submit callback liveness is source inspection until its separate probe runs.

## Frozen 0116 schema evidence

The reviewer independently reran the owner PostgreSQL suite: 4 tests and 24 assertions passed.
Funding policy and client tests independently passed 4 tests and 29 assertions.
The direct SQL oracle passed 18 invariants and rolled back all new rows and mutations.
These cover both actor types, cross-avatar refusal, guest-mirror mismatch, nonce uniqueness, partial tuples, immutable fields and retained holds.
A separate one-connection Drizzle probe confirms a finite foreign-owner refusal releases its transaction.
The next SQL query and own-operation read both finish within 1500 milliseconds.
This finite refusal does not resolve F2, whose callback never returns before the deadline.

Fresh full schema plus migrations 0100 through 0116 ran twice on a separate empty database: 200 tables.
Two retained-history bootstrap passes preserve 14 late capture records and four funding records without changes.
The complete retained-history PostgreSQL lane through 0115 passed 21 suites and 137 tests with zero skips.
Migration 0116 and its PG suite are now registered after the capture suite. Final combined CI evidence remains pending.

Evidence:
- `.brainchain-work/schema-0116-audit-results.json`: 18 SQL invariants.
- `.brainchain-work/funding-owner-rollback-audit-results.json`: finite refusal releases the sole connection.
- `.brainchain-work/schema-full-116-replay-results.json`: two fresh full-schema passes and baseline hash.
- `.brainchain-work/schema-0116-retained-replay-results.json`: retained capture and funding history unchanged.
- `.brainchain-work/ci-postgres-0115-replay.log`: full retained-history suite output.

## F2 correction: independent recheck

Verdict: scoped PASS for callback liveness. This verdict does not authorize activation or a live transfer.
The service gives each transaction one monotonic 1500-millisecond deadline.
Owner callbacks and the final authority callback consume the same budget.
Timeout rejects inside the transaction and aborts its signal. Late callback completion cannot resume the service continuation.
SQL lock and statement limits remain separate database safeguards; this review does not claim a 1500-millisecond bound for all database waits.

The original independent owner probe now settles with operation_uncertain before its callback gate opens.
At 2300 milliseconds, a second connection acquires the avatar NOWAIT lock.
The callback executes once. Late completion does not start another owner check.
A separate independent submit probe uses the agent actor and a retained synthetic capture.
Its deferred authority callback reaches the final send fence, then times out.
Before callback release, the transaction releases its avatar lock and retains uncertain state, capture bytes, capture hash, and nonce.
The signal is aborted. Late callback completion produces zero sends.
This probe extends only its synthetic approval deadline and uses no provider, real key, or network transmission.

Independent execution after the correction:
- Funding PostgreSQL suite: 7 tests, 42 assertions, zero skips.
- Funding policy and client suites: 5 tests, 32 assertions, zero skips.
- Original owner callback probe: refusal and lock release before gate release.
- Independent authority callback probe: refusal, lock release, retained liability, and zero late sends.

Evidence: .brainchain-work/funding-callback-liveness-recheck-results.json and .brainchain-work/funding-authority-liveness-recheck-results.json.
The earlier full PostgreSQL result remains 21 suites and 137 tests, before funding registration.
The targeted funding result adds seven passing tests; it does not claim a new combined lane execution or remote CI result.

## Configured-authority 0117 pre-read constraints

Migration 0117 is outside the frozen 0115/0116 verdict. Backend owns its source and design.
Historical rows must retain absent policy evidence. A migration must not fabricate a current policy backfill.
Version and digest need an explicit all-or-none NULL check. SQL CHECK UNKNOWN and MATCH SIMPLE must not admit partial evidence.
Updates must preserve both fields, including NULL-to-current transitions, with IS DISTINCT FROM comparisons.
Intent, gas, operation, execution and delivery lineage must reject mixed policy pairs.
New effects require the reviewed source version and digest. Format validation alone cannot authorize them.
Missing evidence must preserve read-only reconciliation, captured bytes, nonces and uncertain liabilities while refusing new effects.
Repeated migration and fixture execution must preserve historical NULL rows and exact captured records.
These constraints were sent directly to backend before its source freeze. No 0117 verdict is issued here.
## Frozen 0117 schema review

Verdict: scoped PASS for schema checks and replay. Consumer admission and complete CI remain outside this verdict.
Frozen migration SHA-256: E52001E23CC6BDB8E34BD60247DFE3D60194562AAB36601735BC0F6B982ED91B.
The reviewer verified all five owner-supplied file hashes before reporting this result.
The database suite independently passed three tests and 12 assertions with zero skips.
An independent predicate oracle tested six pair combinations against each of the five installed CHECK constraints.
All 30 cases matched the independent expected truth table, including both half-NULL cases.
Direct updates refused historical NULL-to-current changes in all five tables.
The signer-operation linkage trigger refused that rewrite before the immutable trigger; the probe records the actual refusal order.
Direct inserts with current policy over historical delivery origins and capture consents produced their specific configured-lineage errors.
These two refusals did not depend on a later unrelated unique or foreign-key error.
The owner suite separately rejected a mixed current-intent and historical-gas operation.
Source review confirms operation linkage checks both grants and preserves the existing ownership foreign keys.
Source review confirms fresh exact-consent delivery/capture grants can carry policy evidence without rewriting the original operation.
These new-effect consumers remain under backend implementation review; no end-to-end effect approval follows from this schema verdict.

The full generated baseline and migrations 0100 through 0117 replayed twice in a new isolated database: 200 tables.
Two fixture bootstrap passes preserved 14 late capture records and 11 funding records exactly.
No policy backfill or destructive history rewrite occurred.
Evidence: .brainchain-work/schema-0117-audit-results.json, .brainchain-work/schema-0117-retained-replay-results.json, and .brainchain-work/schema-full-117-replay-results.json.
CI now registers configured-authority-db.test.ts and the controlled runtime-evidence.test.ts suite.
The latter independently passed five tests and 35 assertions.
The existing complete lane evidence remains historical until consumer and positive-fixture changes freeze.
## Configured reader callback: corrected-source probe

Root identified a possible injected-reader stall inside execution admission locks.
Backend added the caller-owned observeConfiguredAuthority timeout before this independent probe ran.
The reviewer therefore makes no original-source reproduction claim.
The corrected source passed one independent database test with five assertions on isolated port 55440.
A deferred reader ignored its abort signal until the probe released its gate.
At 2300 milliseconds, admission had rejected and a second connection acquired the task NOWAIT lock.
After gate release, the execution authority remained unconsumed and no attempt existed.
The test reused owner fixture setup, then applied independent deferred-reader and lock observations.
Evidence: .brainchain-work/execution-reader-liveness-results.json records the exact execution and reader source hashes.
This evidence covers execution admission only. Other consumer paths need their own integration review.
Verdict: scoped PASS for corrected execution-reader callback liveness.
Execution SHA-256: 3ebbf3b5a7a3eb09f6ac83ef1cd80bba203437060b32e8439f27e0d2eac46f40.
Reader SHA-256: 6f4e63ff5e3baf721e254015b03acb39a08266a1e9130f6da2b9efad5320a5b3.

## Final local CI evidence after frozen corrections

The final PostgreSQL lane passed 23 isolated suites and 151 tests, with zero skips.
It includes ten exact-capture tests and both actual isolated-cognition tests.
The corrected capture source and regression hashes match the recorded retry manifest after this run.
Pure CI passed 68 suites and 424 tests, with one Docker test assigned to the PostgreSQL lane.
Protected Linux passed four suites and 12 tests, with five explicitly expected skips.
No protected-source change occurred after that Linux run.
Earlier fixture failures remain preserved and documented in the CI report.
These results establish local fixture coverage only. They do not establish remote CI, staging parity, deployment, or live activation.
Evidence: .brainchain-work/ci-postgres-final-0117-retry2.log and the three ci-*-results.json reports.
Final protocol coverage expansion: pure CI now passes 72 isolated suites and 498 tests, with one expected Docker skip.
Four previously omitted protocol fixtures now execute individually and require zero skips.
The observed stale version pins and CT-to-vCLAW wording correction are documented in docs/brainchain-ci.md.
The PostgreSQL and protected Linux results remain unchanged.
