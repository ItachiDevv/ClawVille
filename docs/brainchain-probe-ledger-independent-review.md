# Independent probe embedding ledger review

Last audited: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

Status: P1 passes independent correction review. No activation or provider-spend approval follows this report.

## P1 correction review

Reviewed service SHA256 f2e59de0f7caf96e564cc900c05f74ec84f169962344da69af37c317e3b82cb4.
The service now checks the caller signal and absolute deadline after admission and settlement transactions.
The persisted call deadline is at most thirty seconds after reservation and cannot extend through replay.
The provider deadline also respects the original invocation's thirty-second cap.

The original postcommit cancellation probe ran unchanged and passed: 1 test, 1 assertion, two scenarios.
Fresh settlement and settled replay both refused vectors after cancellation. Each fixture retained one provider call.
The independent expiry probe passed: 1 test, 7 assertions, two scenarios.
It verified no accepted vector, settled state, charge of one microUSD, and one provider call after both expiry cases.
The standard ledger suite passed 9 tests with 59 assertions, including all four fresh/replay and abort/expiry combinations.
Those cases verify the retained one-microUSD charge without another provider dispatch.

An additional independent probe held an unchanged budget row and advanced the host clock beyond the invocation deadline.
After lock release, the service refused the vector and made zero provider calls: 1 test, 2 assertions.
Probe: .brainchain-work/audit-probe-lock-deadline.test.ts.
The expiry probe is .brainchain-work/audit-probe-expiry.test.ts.

All correction tests ran against the guarded port-55440 fixture. No source edits or live provider calls occurred.
This review does not assert an integrated API typecheck; the author reported concurrent runtime export diagnostics.
Mixed task and probe rows in one envelope remain independently untested.
The fixture service requires a probe-specific immutable envelope approval reference, so existing ordinary task envelopes cannot be repurposed through registration.
No task authority or historical approval was fabricated to bypass that boundary.

## Original P1: committed vector return ignores caller cancellation

Both fresh settlement and settled replay check caller authority inside a transaction.
They return the vector after awaiting the transaction without another caller signal or absolute deadline check.
The transaction can finish after cancellation or expiry, leaving an accepted vector outside the authorized interval.

The independent probe uses actual PostgreSQL transactions and the concrete controlled provider adapter.
A wrapper aborts the caller after db.begin commits, before its promise returns to embedExact.
Fresh settlement and replay both returned vectors with canceledBeforeReturn true and acceptedVector true.
Each fixture had one provider call. The replay performed no second provider dispatch.
This demonstrates a deterministic caller-cancellation boundary, not atomicity with a future stop event.

Reproduction: .brainchain-work/audit-probe-return.test.ts, with the guarded port-55440 fixture.
Required correction: check caller signal and absolute deadline after every awaited transaction that precedes a vector return.
Retain the settled charge and refuse the vector. Add fresh-settlement and replay tests for cancellation and deadline expiry at this boundary.

## Independent frozen-source evidence

Reviewed the six-file manifest in .brainchain-work/probe-budget-freeze.json.
The service under test has SHA256 6e6b25f3b0fe1f2292643ca0015a4a5324e0c269fde220a5bac2b77b6a1877da.
The root-store manifest later changed only for the author's reported whitespace normalization.

The fresh full-schema database brainchain_probe_schema_review_118 accepted the baseline and migrations 0100 through 0118 twice.
It contains 203 public tables. Evidence: .brainchain-work/schema-full-118-replay-results.json.
Baseline SHA256: ed5cff2d913cbf02c93982f31f779d6818e1a4bb26b58199fd99e0e8b6391212.
The independent script .brainchain-work/audit-probe-schema-replay.ts refuses existing database overwrite and requires port 55440.

The standard ledger suite passed 8 tests with 39 assertions against port 55440.
It replays 0118 against retained history and covers accounting, stop, uncertainty, lock timeout, callback timeout, and settlement SQL checks.
The independent ownership and cross-instance probe passed 1 test with 6 assertions.
It deletes actual fixture user/avatar rows and verifies the historical marker remains available.
Marker UPDATE and DELETE refuse. A fresh run/envelope with a wrong manifest user raises probe manifest ownership mismatch.
Two independently constructed Drizzle clients racing the same request produce one provider call.
Probe: .brainchain-work/audit-probe-ownership.test.ts.

Current source combines task and probe call totals for local close and root reconciliation.
It locks budget/envelope before runs and calls, retains dispatched maxima, and rejects counter drift.
It freezes request inputs and validates returned vector shape, finite elements, exact call ID, usage, and charge.
The provider-response fence retains legitimate cost after stop while withholding its vector inside the transaction.
P1 concerns the remaining boundary after that transaction.

No live keys, paid calls, protected root publication, or port-55439 DDL occurred.
Mixed task/probe rows in one envelope and host-deadline lock waits were source-reviewed, not independently reproduced in this pass.
No full runtime injection or staging consumption claim follows these ledger checks.

## Earlier draft observations sent to the author

The current embedExact settlement path does not recheck run state, stop, caller cancellation, or deadline after provider return.
Its settled replay path returns the retained vector without a current scope fence.
Both paths must refuse accepted vectors after stop or expiry.

The draft bounds root and identity callbacks after acquiring database row locks.
The caller deadline must also bound those lock waits and transaction cleanup.
An outer timeout that leaves a live transaction is insufficient.

The provider call reads input.text after reservation awaits. Freeze the request before those awaits.
Require a consumed one-use dispatch ticket before accepting a provider response.
Validate vector shape, finite values, token bounds, and cost at the durable boundary.

The shared close and protected root aggregate must include probe calls alongside task compute calls.
Marker IDs must remain immutable historical scalars after fixture identity cleanup.
Missing or stopped run state must refuse runtime reconstruction rather than select ordinary provider behavior.

## Independently derived accounting checks

Registration allocates no second provider allowance. It consumes an existing root-reserved envelope.
Each new request reserves 200 microUSD and permanently consumes one run quota slot.
Duplicate request IDs must bind source and input hash. Two service instances must dispatch at most once.
Dispatch commits the maximum liability before the provider effect.
Cancellation releases only undispatched reservations. Stop retains dispatched and uncertain maximum liabilities.
Valid reviewed usage settles once. Missing usage, crash, late response, and provider failure retain uncertainty.
Conservative reconciliation charges the full maximum and cannot publish an accepted vector.
Close refuses any reservation or uncertainty and checks combined counters before releasing limit minus settled cost.
Root publication after local close must preserve allocation until the signed reconciliation revision is durable.

## Freeze-time verification plan

Use the canonical Drizzle client and a coordinated isolated fixture on port 55440.
Test concurrent reservation and dispatch across instances, duplicate identities, shared cap races, and exact close totals.
Hold unchanged rows across caller deadlines. Verify transaction release before delayed callbacks resolve.
Stop or expire the run during provider response and during settled replay. Require zero accepted vectors.
Test crash before dispatch, after commitment, and before settlement. Require retained maximum liability without a second provider call.
Test root revocation, identity replacement, immutable markers, and cleanup without accounting deletion.
Check mixed task/probe reconciliation and counter-drift refusal through the protected root store.

No keys, paid calls, live provider requests, shared port-55439 migrations, or index changes form part of this review.
