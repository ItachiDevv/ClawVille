# Independent scheduler and liveness review

Last audited: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

Verdict: BLOCKED on S1. Activation remains closed. Exact-result consent remains outside this review.

## S1: unbounded worker authority callbacks retain database locks

WorkerAuthorityIssuer.computeFence directly awaits trusted.root.verifyReservation and trusted.current inside the proxy transaction.
Neither call has a deadline or cancellation boundary. The proxy's bounded verifyDispatchRoot does not cover these additional reads.
The scheduler constructs this fence, so this path now participates in concrete scheduler execution.

The independent probe used existing execution fixtures on the guarded PostgreSQL database.
It delayed each callback separately for 2600 ms. Both transactions remained pending after the required two-second deadline.
A separate connection tried SELECT FOR UPDATE NOWAIT on the policy row. Both cases returned PostgreSQL code 55P03.
The transactions retained their locks until the probe manually resolved each callback.
After resolution, the same lock query succeeded.

Probe: .brainchain-work/audit-worker-fence-timeout.ts.
Run after the owner-policy suite supplies fresh execution fixtures, with both local fixture opt-ins.
Output for both root and current modes: readEntered true, settledWithinTwoSeconds false, transactionStillPending true, policyLockHeld true.
No key, provider, network request, or durable mutation participated in this probe.

Required correction:

- Bound both callback reads inside the transaction with the dispatch deadline and cancellation signal.
- Reject within two seconds or the earlier call deadline.
- Unwind the transaction so its row locks release without callback cooperation.
- Prevent late callback results from authorizing further work or provider dispatch.
- Preserve the reserved hold before dispatch commitment and full uncertainty after commitment.
- Prove retry does not call the provider after an uncertain transition.
- Bound initial execution assignment reads and issuer verification so the explicit host cannot hang indefinitely.

A timeout around the caller alone is insufficient if the callback transaction keeps its locks.
Add controlled callback regressions with independent lock checks after timeout.

## Reviewed behavior and independent evidence

The scheduler persists an exact parsed WorkerTick before coordinator effects.
Retained plans check worker and avatar identity. Receipt history checks precede retained plans and new grants.
Receipt-stage replay performs its own receipt check. More than 100 retained confirmed operations requires review.
The pending operation selector excludes confirmed and rejected rows without releasing liability.

The scheduler constructs the owner compute fence internally.
The proxy now refuses owner-issued execution through an instance without that fence.
The direct root-only trial path retains its separate authority model.

Job claims permit drain under active owner policy. New lifecycle and execution issuance refuse during drain.
The signer refuses first lifecycle key use after drain. Captured effects retain their original authorization checks.
Policy pause and revocation preserve pending plans and financial liabilities.
The owner regression covers wallet A-to-B-to-A and refuses reuse of revoked original policy.

Migration 0113 adds immutable observation policy fields and operation-to-authority policy foreign keys.
The new worker policy measures its 30-second interval from acquisition start.
It accepts an idle historical timestamp only under the explicit provisional policy and still rejects future timestamps.
The observer verifies pinned code, same-block reads, and the final block number, hash, and timestamp.
The transport repeats its final anchor after URL validation and checks authority before dispatch.
The public earnings and stable-block behavior remain outside the worker exception.
No observation policy authorizes financial release.

The brief reader pins the current board, code hash, canonical Posted event, exact UTF-8 bytes, and structured task schema.
It refuses external brief URLs and scans beyond its bounded history range.
The CLI requires an explicit absolute trusted module and bounded tick count and interval.
It has no API boot hook. S1 prevents a claim that each configured tick has a bounded duration.

Independent test runs:

- Signer observer: 10 tests, 276 assertions.
- Fixed send transport, isolated invocation: 1 test, 74 assertions.
- RPC, observation policy, and brief parser: 10 tests, 117 assertions.
- Guarded PostgreSQL owner policy and scheduler: 12 tests, 117 assertions, no skips.
- Capture faults, isolated invocation: 2 tests, 48 assertions, no skips.

The PostgreSQL tests use the canonical retained Drizzle pool for compute composition and scheduler receipt restart.
They cover lease waits, retained receipt plans through drain, orphaned receipt refusal, and zero key calls after drain during admission.
The owner suite replayed 0109. The consent owner received notice to restore its 0112 wrapper in the next controlled replay.
No production or staging database writes occurred.

## Unproven scope and next review gates

Automatic stage selection lacks full admission-to-result and lifecycle-to-hire coverage.
The concrete scheduler test proves receipt crash/restart. The coordinator suite does not prove every automatic scheduler branch.
Add stage-selection tests for lifecycle preparation, capture, broadcast, hire indexing, admission, compute, freeze, signature, upload, and submit.
Each external-effect boundary needs restart, drain, revocation, and retained-evidence cases where applicable.
Include a rejected-operation selector case and multiple-hire refusal through the real scheduler.

Exact-result consent 0112 remains under active implementation and has no approval here.
Existing expired unsigned operations still refuse capture. The scheduler does not infer new capture authority from preparation consent.
Root-reported JSONB consent comparison and paused-worker signer callback changes require that separate integration review.
No configured live host, full automatic lifecycle, real hire, provider call, upload, transaction, or financial release was verified.

PARITY: existing human and bound-agent owner controls retain their avatar ownership boundary.
This review grants no new public consent permission and no activation approval.
