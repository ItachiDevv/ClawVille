# Runtime probe budget design review

Last Audited: 2026-11-09. Reviewer: identity_audit. Team: brainchain-office.
Status: scoped design APPROVED; fixed embedding adapter checks PASS; durable ledger and runtime integration remain unapproved.
Scope: release-probe cost accounting, protected reservations, reconciliation, and dispatch boundaries.
This review does not revisit consent C1 or authorize a provider request.
No credential access, database mutation, provider request, or index change occurred.

## Baseline assessment

The existing protected root history already supplies separate cumulative OpenAI and OpenRouter caps of 10,000,000 microdollars each.
The existing budget table has a unique job/provider pair. Probe accounting must use that same pair and stable job.
Envelope allocation already consumes this cumulative pool. A probe must not create a separate owner, daily budget, or replacement genesis.
The signed reservation alone does not intercept runtime embedding fetches or enforce per-call replay protection.

The task-call schema cannot represent an embedding probe without changing intentional task controls.
It requires real task and attempt foreign keys, one call per attempt, and positive text output bounds.
Do not fabricate those records or weaken their constraints.
A separate probe-call ledger under existing envelopes is justified if the design needs durable call quotas and exact charge reconciliation.
Existing protected reservation semantics remain sufficient for root allocation; they do not require a second budget pool.
Charging the whole reservation conservatively is an alternative to partial refunds, but still needs durable dispatch and quota enforcement.

## Required interface and invariant constraints

| Boundary | Required behavior |
| --- | --- |
| Allocation | Share the existing stable job, provider budget, signed reservation, and envelope allocation. |
| Root authority | Verify current protected history before dispatch; never accept a request-supplied approval, endpoint, model, or job replacement. |
| Probe identity | Bind immutable run ID, fixture user/avatar/platform agent, source hashes, envelope, expiry, and quotas. |
| Input | Bind exact input hash and UTF-8 bytes; enforce a reviewed token upper bound and request-size ceiling before dispatch. |
| Provider | Pin OpenAI embedding endpoint, model, dimensions, pricing version, and response schema; refuse OpenRouter and unknown fallback paths. |
| Dispatch | Commit a single-use dispatched record before HTTP transmission; no automatic retry after ambiguous failure or restart. |
| Uncertainty | Retain maximum charge for dispatched or uncertain calls after abort, timeout, crash, cleanup, or run expiry. |
| Cancellation | Release a zero-charge reservation only with durable proof that dispatch never occurred. |
| Quotas | Count calls and starts durably; replay, reconnect, concurrency, or restart cannot create fresh quota. |
| Callback liveness | Enforce a caller-owned deadline and reject inside the transaction; a callback's cooperative signal alone is insufficient. |
| Late response | Late provider or authority completion cannot dispatch, settle twice, restore quota, or release uncertainty. |
| Reconciliation | Aggregate task and probe calls before envelope closure or root publication. |

## Reconciliation coupling

The current reconcileRootComputeDocument reads only brainchain_compute_calls.
A separate probe ledger must join its accounting before any protected reservation release can pass.
The same rule applies to closeEnvelope, budget allocation reductions, and replayed close results.
Both ledgers must agree with reserved, uncertain, and settled envelope counters under the same lock scope.
Concurrent task and probe calls must not spend the same residual allocation.
Use one lock order: provider budget, envelope, probe run, task calls, then probe calls.
Never introduce an inverse call-to-budget lock path.
Reserved and uncertain liabilities prevent closure; settled charge remains cumulative after closure.

Protected publication currently performs filesystem writes and directory synchronization while database locks remain held.
The new design must not add unbounded external callbacks there.
A timeout race around filesystem mutation can publish a late head after rollback; it is not a safe cancellation mechanism.
Document crash points around database reconciliation, history-file creation, head replacement, and directory synchronization.
Restart must compare protected history with durable accounting before permitting another dispatch or release.

## Required independent proofs

1. Combine existing task spend and probe allocation under each original provider cap.
2. Race task and probe reservations against the last available microdollars.
3. Crash after committed dispatch but before response persistence; retain maximum liability after restart.
4. Reject repeated call IDs with changed input, model, scope, or pricing.
5. Reject envelope closure and root release while either ledger has uncertain or reserved calls.
6. Hold a callback past its deadline; prove lock release before callback completion and no late dispatch.
7. Exercise both standalone and Eliza embedding entry points through the same transport.
8. Prove unexpected text, moderation, teacher, or fallback requests cannot bypass the probe policy.
9. Preserve actual runtime installation, chat, decision context, and the private workers receipt checks.

These constraints were sent to backend and root before implementation review.
The proposed design document was absent during this baseline review. No design or implementation approval is issued here.

## Authored design review

The proposed design now covers the principal allocation and dispatch boundaries.
It reuses the original provider budget and envelopes, and adds only durable run and call records.
It extends both close and protected reconciliation to aggregate task and probe liabilities.
It preserves real task authority requirements and supplies no public probe authority issuer.
The API process reconstructs scope from durable records and trusted deployment pins before runtime or installer initialization.
The dedicated desktop-key reference has no house-key fallback. The probe process cannot register authority through its own memory.
The paid sequence ends within eight minutes and cannot exceed the existing ten-minute signed document expiry.
Cleanup and restart retain uncertainty and cannot extend the old reservation.

One design clarification remains before approval: fixture cleanup removes user/avatar/platform-agent rows.
The ledger must retain immutable identity IDs without cascading deletion or restrictive identity foreign keys that block cleanup.
Live dispatch must verify the current tuple; historical identity evidence alone cannot authorize an effect.
Run, envelope, and call ownership links remain restrictive and cannot disappear during cleanup.
Fixture marking must also survive missing active-run lookup so the runtime cannot fall back to ordinary provider credentials.
A private dispatch ticket must enforce one adapter invocation, including repeated send or fence attempts.

Root measured protocol P=46 and curriculum B=11 in the current source.
The proposed ceiling is 135 calls at 200 microdollars each, or 27,000 microdollars total.
These are preflight measurements, not a reservation. Exact hashes, counts, and selected policy must match at bootstrap and dispatch.
Root identifies the official model page as the readable pricing evidence; the generic pricing page did not expose that embedding row.
Usage above 8192 tokens must quarantine the result and retain maximum liability.
Implementation review must confirm all provider entry points, actual retained-client transactions, crash cases, and cleanup semantics.
## Final scoped design verdict

The updated design resolves the three pending constraints. Scoped design verdict: APPROVED.
Historical scalar identity IDs survive fixture cleanup without cascading cost deletion or identity foreign keys that block cleanup.
Live dispatch still checks the canonical identity tuple.
Persistent fixture marking prevents ordinary-provider fallback when active scope is missing, stopped, or expired.
The adapter consumes each ticket once within its instance, including a refused fence.
This approval covers design only; it does not approve durable ledger implementation, runtime coverage, credential provisioning, or paid dispatch.

Reviewed design SHA-256: 19A06A12F76AB3D0102440F5F0F7409710FF28E3548E6E9C0F0B72BFF3DEAA8B.
Reviewed adapter SHA-256: CA718B1A2368863EAB1F0BFDA043F666683F8C5CF220A6376AA52AC2D9B8B8D6.
Reviewed adapter test SHA-256: C3DEAE55706F0F196F95387DC2C7A9D5F063F38FC907CDA5B8060D90FD7C91F2.

## Fixed adapter independent checks

The owner adapter suite independently passed 19 tests and 46 assertions.
A separate adversarial probe passed three tests and 15 assertions.
It raced two invocations with one ticket, confirmed refused-fence consumption, and released an uncooperative fetch after timeout.
It also supplied invalid UTF-8, fractional token usage, and a wrong embedding index.
Each malformed transmitted response remained uncertain. The late response caused no second fetch.
The owner suite separately covers stalled fences, abort, body timeout, vector shape, token ceiling, wrong model, redirects, and response limits.
All transports were controlled local functions. No provider, key lookup, or database action occurred.
Evidence: .brainchain-work/probe-embedding-independent.test.ts and the tracked adapter suite.

The WeakSet replay guard belongs to one adapter instance. It is not durable or cross-instance authority.
The forthcoming ledger must prevent another ticket or adapter from redispatching an already dispatched call.
An adapter uncertainty error alone does not persist liability; the ledger must retain the committed maximum.
Input-byte bounds do not prove model-token acceptance. No source truncation or automatic quota expansion is approved.
Final implementation approval still requires shared ledger reconciliation, runtime coverage, actual-client concurrency, restart, and cleanup proofs.