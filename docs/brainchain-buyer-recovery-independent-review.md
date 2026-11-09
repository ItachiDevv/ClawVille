# Independent buyer recovery review

Date: 2026-11-09. Reviewer: root. Host: itachi222.
Verdict: scoped source approval for read-only discovery and the best-first task-form correction.
This review grants no payment activation, refund release, genuine settlement or staging approval.

## Reviewed boundary

Reviewed the frozen discovery scanner, fixed RPC cancellation, receipt cancellation, buyer reconciliation, migration0114, account liability query and human controls.
The scan derives addresses and message identity from the captured order. Callers cannot supply cursor values or RPC destinations.
Candidate acceptance requires the exact message and both transaction signatures, followed by finalized canonical receipt verification.
The scanner has page, candidate, response-size and time bounds. Missing evidence restores prior cursor progress.
The order transaction rechecks ownership, captured identity, prior cursor and competing remote/payment observations before persistence.
Payment observations remain separate from desk orders and task identifiers.

The shared liability query still includes uncertain, payment-observed, refunded and reorg-suspended orders with retained reservations.
No discovery result or refund label excludes these orders from spending limits.
The missing refund attribution contract remains explicit in human and agent results.
The human form submits the pass criterion before the fail criterion. Agent creation preserves its documented caller-supplied best-first order.

## Independent execution

- Discovery, RPC and receipt tests:9passed,112assertions.
- Actual Office component tests:7passed,28assertions, including the exact best-first submitted request.
- Additional PostgreSQL probes:2passed,13assertions, using the canonical retained getPostgresClient pool.

The first additional probe starts two history scans from the same cursor and releases their network waits together.
Exactly one scan persists its result; the other refuses the changed cursor.
Captured bytes, capture hash and reserved liability remain unchanged. The paid client receives no additional invocation.
The order remains uncertain without a remote order or payment identifier.

The second probe changes the avatar's database owner during the history request.
The original owner cannot persist the later evidence. Captured bytes, reservation, scan metadata and order state remain unchanged.
Both probes use unique local fixture rows and perform no schema changes or external requests.

The probe archive is `.brainchain-work/root-buyer-discovery-audit-original-layout.test.ts`.
Its relative imports require the original service-directory layout.
The temporary service test matched the archive hash before its exact removal.
The CI owner verified that its inventory excluded the hidden temporary test.

## Limits

No genuine positive transaction signed by the pinned fee payer appears in these tests.
Generated payer signatures and controlled RPC responses prove refusal and recovery controls, not protocol settlement.
The full updated PostgreSQL CI lane and final browser/device checks remain required.
No-ID discovery cannot establish a desk order or attribute a same-amount refund without the missing protocol contract.
No financial hold release, key access, payment or deployment occurred.

The separately assigned buyer reviewer failed at an automated service content check before producing a review.
Root performed this review directly and did not treat that failed invocation as evidence.
