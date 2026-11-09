# Independent worker authority review

Last audited: 2026-11-09. Reviewer: durable_audit. Team: brainchain-office.

Verdict: W1 and W2 pass independent correction review. The execution gate remains closed.
This review does not approve the scheduler, provider composition, activation, or a live pilot.

## Correction review

The proxy now normalizes raw database timestamps through databaseDate.
Envelope and call timestamps use explicit text parameters with timestamptz casts.
This covers envelope replay, task fences, reservation, dispatch, status, and expiry checks.
Settlement and recovery retain their existing conservative accounting behavior.

WorkerJobs now locks binding and policy before the job row.
It then checks active policy, worker state, exact policy/generation/owner tuple, and database lease expiry.
The mutation retains a final expiry predicate while the transaction holds the row lock.
The changed path cannot clear a newer host's pending plan.

Independent rerun: owner-policy suite passed 10 tests with 89 assertions.
Its compute test uses canonical getPostgresClient for envelope replay, issuance, reserve, dispatch, replay, settlement, and unknown-charge accounting.
The proxy regression suite passed 14 tests with 116 assertions. Its Docker child test was skipped in this run.

The expanded independent probe separately held unchanged rows through persist and completeStage lease expiry.
It reported shared proxy accepted, persistedAfterExpiry false, completedAfterExpiry false, and planRetained true.
It also verified the next generation, retained takeover plan, stale completion refusal, and both mutation refusals after policy pause.
All probe checks include explicit failure assertions. No provider or key participated.
The fixture-only policy used by the probe remains paused with its retained audit plan.

These corrections close the two recorded defects for the inspected scope.
The mandatory autonomous proxy composition, external-read timeout boundary, and scheduler remain separate review gates.

## Original confirmed defects and reproduction history

### W1: shared Drizzle client prevents proxy envelope admission

The owner services use the retained PostgreSQL client. Drizzle changes that client's timestamp parser.
The proxy still treats raw timestamps as Date objects. Its approveEnvelope method calls time.now.getTime directly.
An independent probe initialized a client with drizzle(shared), then called the real proxy with a controlled root verifier.
The call failed with TypeError: time.now.getTime is not a function.
No provider adapter or credential participated. The transaction rolled back its budget insertion.

The existing shared-client owner test covers proof, start, lifecycle issuance, and pause.
Its compute tests use a separate PostgreSQL client without Drizzle initialization. They do not cover this composition.
Normalize all proxy timestamp reads and typed timestamp/JSON writes before the autonomous host uses the shared client.
Test envelope admission, reserve, dispatch, replay, and settlement with the actual shared-client serialization behavior.

### W2: job persistence accepts an expired lease after a row-lock wait

WorkerJobs.persist checks lease_until in an UPDATE predicate before PostgreSQL waits for the row lock.
A separate SELECT FOR UPDATE can hold that lock without changing the row.
The waiting UPDATE then writes after lease expiry because PostgreSQL does not reevaluate that unchanged row's predicate.

The independent probe claimed a 700 ms job lease and locked its row on another connection.
It started persist while the lease was current and released the lock after 950 ms.
The result was {persistedAfterExpiry:true,expired:true}.
The probe retains a fixture-only pending plan containing audit: expired-lock.

completeStage uses the same UPDATE predicate pattern. It can clear retained stage evidence after expiry.
Lock the job explicitly in a transaction before checking the database clock and full lease tuple.
Check generation, owner, policy, and expiry after the lock. Preserve the exact pending plan across takeover.
Add separate lock-wait regressions for persist and completeStage, including unchanged locked rows.

## Reviewed source and evidence

The review covered owner proof and policy narrowing, cumulative issuer reservations, job leases, embedded briefs, and migration 0109.
It also covered the proxy worker callback, signer final authority checks, and append-only receipt observations.

The owner proof binds account, avatar, worker, chain, payload hash, revision, nonce, domain, wallet, and expiry.
Agents cannot approve the human wallet proof. Wallet rotation revokes policies and derived authorities.
Policy replacement retains cumulative liability. Narrowing retains the original proof and checks non-increasing limits.

Lifecycle signing checks current authority after durable claim and private-file access.
Broadcast checks authority after URL validation, before dispatch. Captured bytes remain available after refusal.
Receipt persistence retains provisional inclusion evidence. Reorganized or inconsistent inclusion stops the stream.
The confirmed operation state represents nonce consumption, not financial finality or released liability.

Independent local PostgreSQL run: 14 tests passed with 159 assertions across owner policy, signer capture, receipts, and coordinator.
An additional owner-policy run passed 9 tests with 64 assertions and supplied a fresh job for the independent probe.
Fixed RPC send and embedded brief tests passed 2 tests with 68 assertions.
The ignored probe is .brainchain-work/audit-worker-boundaries.ts.
Run it after the owner-policy suite with BRAINCHAIN_DB_FIXTURE=1 and BRAINCHAIN_LOCAL_FIXTURE=1.

Linux signer fixture evidence was inspected, not independently rerun during this review.
No live keys, provider calls, uploads, transactions, deployment, or production database writes occurred.

## Remaining scope boundaries

The proxy callback remains optional for the existing direct-trial path. Autonomous composition must always supply it.
The future host must prove that an owner-issued execution cannot enter a root-only proxy instance.
The worker callback must check current assignment and policy at reserve and both dispatch boundaries.
External authority reads still need bounded cancellation in the final host composition.

The brief reader accepts only bounded embedded UTF-8 data with the exact stored hash and structured task type.
This review ran its parser tests, not a full chain-reader adversarial fixture.
Future reader tests must check returned block numbers as well as hashes at each requested anchor.

ARCHITECTURE.md now distinguishes the implemented issuer from the absent scheduler and closed activation gate.
Freshness policy changes require their separate review. This report does not approve longer observation validity.

PARITY: owner policy service shares avatar ownership for humans and bound agents; human wallet approval remains a separate operation.
Public action/manual integration and full scheduler parity remain outside this approval boundary.
