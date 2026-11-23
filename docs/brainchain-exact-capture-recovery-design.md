# Exact submit capture recovery contract

Date: 2026-11-09. Status: design; implementation and independent review remain required.

## Observed gap

The signer primitives retain the original operation, intent authority, gas authority and expiry.
Fresh delivery consent does not renew those authorities.
An unsigned operation can therefore remain blocked after its original authority expires or receives an owner revocation.
The scheduler reports `exact-capture-consent-required` rather than replacing the operation.

The current signer callback also requires a running or draining worker.
The exact-consent owner is addressing that predicate for newly issued, narrowly bound recovery operations.
That change must not authorize unrelated operations while the worker remains paused.

Source boundaries: `signer-operations.ts`, `signer-service.ts`, `exact-result-recovery-consent.ts`, `exact-result-recovery-issuer.ts`, and `worker-scheduler.ts` under `apps/api/src/services/brainchain`.

## Required separate authority

1. Keep the original operation, original authority rows, revocation timestamps and captured bytes immutable.
2. Limit recovery to testnet submit operations for the exact frozen result and original canonical hire.
3. Require fresh human approval from the current linked account wallet, with its monotonic wallet version.
4. Bind consent to operation ID, result hashes, calldata, destination, chain, signer generation, nonce and exact fee bounds.
5. If no nonce exists, display and sign one exact proposed nonce. Refuse any later stream mismatch.
6. Store a separate append-only capture authorization linked to the consent and original operation.
7. Permit expiry recovery and proven owner revocation only. Unknown, security and root revocations still refuse.
8. Never restore compute authority, restart the worker, increase provider budgets or clear retained liabilities.

## Final key boundary

Lock the signer stream, original operation, consent and current owner records in the documented common order.
Require no prior key acceptance, no captured payload and no protected-store key-use claim for this operation.
Repeat current authority, generation, canonical hire, nonce and expiry checks after asynchronous operations and lock waits.
The physical signer must receive the exact transaction approved by this consent.
The final signer callback must validate the separate consent linkage, rather than accept a caller-provided override flag.
Commit the durable acceptance before key use, then use the existing protected capture and readback path.

Any existing acceptance or uncertain key-use record remains evidence-only.
A missing payload is not proof that signing never occurred.
Never issue a replacement transaction, increase fees or change the nonce to escape an uncertain result.

## Verification requirements

Use the canonical shared PostgreSQL pool and the concrete signer callback.
Test expiry, owner pause and owner revoke after preparation but before acceptance.
Test both an already reserved nonce and an explicitly approved nonce for an unreserved operation.
Prove the original operation and original revocations remain unchanged.
Test concurrent recovery, worker ownership changes, A-to-B-to-A wallet changes and signer generation changes.
Test consent expiry during locks and signer awaits, protected-store disagreement, changed calldata and changed fees.
Prove every refusal makes zero key calls and retains financial liability.
Prove accepted or uncertain operations use only byte recovery.
An independent reviewer must inspect the final key boundary before activation.

This contract preserves the full recovery requirement. It does not claim implementation or testnet execution.

## Current consent review evidence

Root tested PostgreSQL JSONB key ordering with a read-only query against the isolated fixture on itachi222.
The provenance object returned `rawEqual: false` and `canonicalEqual: true`.
The query changed no tables and used no external service.
The approval method compared nested objects without canonicalization at review time.
That comparison can refuse an unchanged owner-revocation or captured-operation snapshot.
The implementation owner received the reproduction and a request for a positive PostgreSQL regression.
Probe: `.brainchain-work/exact-recovery-jsonb-order-probe.ts`.

These findings are interim source observations. The consent implementation has not received independent approval.


## Source freeze checkpoint (2026-11-09)

Migration 0115 and the exact capture policy, snapshot, and recovery services now implement this contract. Append-only authorities and acceptances bind the existing consent, operation, result, worker, and avatar. The existing human wallet challenge signs the exact transaction snapshot. No second wallet proof system exists.

The service commits acceptance before key use. It uses the existing protected journal, physical driver callback, transaction verifier, and captured-byte recovery reader. First-key checks include current consent, wallet version, session, original hire, signer generation, exact intent, and expiry. Database acceptance timestamps retain their microseconds through a database subquery. Accepted or uncertain operations cannot obtain another signature.

A revoked original exact-delivery consent still refuses capture recovery because it lacks classified capture revocation provenance. Proven owner policy revocation can use fresh exact consent. Unknown security revocation remains refused. Explicit trusted-host recovery invokes the service; no automatic paused-worker discovery exists.

Human users select capture-submit in the retained-result panel and inspect exact unsigned terms before wallet approval. Bound agents request the same stage through recovery_request. Only the current linked human wallet can approve. Protocol 127, the curriculum, orientation, and Nori describe these limits.

Verification: exact-capture-policy.test.ts passed 2 tests and 21 assertions. exact-capture-recovery.test.ts passed 9 tests and 57 assertions on the canonical shared Drizzle pool. The PostgreSQL suite covers reserved and unreserved nonce capture, distinct-consent concurrency, owner revocation, wallet rotation, security refusal, lock expiry, signer-await expiry, direct SQL constraints, and nonzero timestamp microseconds. Migration 0115 applied twice over retained late acceptance rows. This fixture does not prove production migration rollout.

The human panel suite passed 6 tests and 41 assertions. Shared and database builds exited 0. API and web typechecks exited 0. Independent schema and signer review remains required. No live credential, paid provider call, upload, transaction, financial release, or activation occurred. The external pilot remains unproved.

PARITY: human path: Office retained-result panel and private recovery endpoints; agent path: bound recovery_request/recovery_narrow/recovery_revoke. Both paths resolve the same avatar and require fresh human wallet approval for capture.
