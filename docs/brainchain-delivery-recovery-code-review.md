# BrainChain expiry-only delivery recovery review

Last Audited: 2026-11-09. Reviewer: identity_audit. Team: brainchain-office.
Verdict: APPROVED for the scoped inactive expiry-only delivery recovery source after R1 correction.
No activation or live operation approval follows from this document.

## Scope

Migration 0107, immutable original hire evidence, delivery grants and leases, result signatures, submit linkage, and captured broadcast recovery.
The reviewer owns this report and ignored audit probes only. Backend owns source corrections.
Backend released fixture DDL before the reviewer ran database suites. Those runs used separate processes in sequence.

## Baseline constraints and observations

- Results preserve original task, attempt, compute call, generation, output, and hashes.
- Legacy rows without an original hire snapshot must refuse recovery.
- Delivery authority is distinct from compute authority and inspection-only recovery attempts.
- Recovery must refuse revoked compute authority, stopped or retired signer state, replacement hires, and changed canonical generations.
- Hired evidence requires a zero payee. Matching Submitted evidence requires the worker payee and frozen result hash.
- A signature acceptance without captured bytes must never cause another key use.
- Uncertain uploads remain evidence-only. Recovery must not repeat their POST.
- Broadcast recovery must retain the original operation, nonce, bytes, transaction hash, and gas liability.
- Every external wait and lock wait needs a current authority and clock check before further action.
- Existing Submitted evidence enters reconciliation without another submit or broadcast.

## Pre-freeze review feedback

The initial pinned evidence reader started its final block check concurrently with task and hire reads.
Backend moved that final check after both reads. The independent ignored recovery-anchor-audit.test.ts passes: 1 test, 1 assertion.
This fixture delays the task response and verifies that the final anchor read cannot precede it.

The initial broadcast verifier checked its clock before later operation locks.
Its outer repeated verification already retained those locks, so this observation did not independently prove an admission bypass.
Backend also added a final clock check inside verification and required operation generation to match the signer stream.
Database regression evidence remains pending.

### R1: Result-signature grant expiry after the recovery callback

The reviewer reproduced a result-signature expiry gap after the recovery callback.
The callback checks signer grant expiry, then the recovery wrapper performs another external evidence read.
That read can outlive a short signer grant while the delivery lease remains valid.
Independent probe: `.brainchain-work/recovery-signature-expiry-audit.test.ts`.
It invokes the actual authority method with a controlled transaction and recovery wrapper.
The grant expires at clock 2000; the wrapper advances clock 1000 to 3000 after the callback.
The authority method resolves instead of rejecting. One test fails with one assertion.
No database, key, or network operation is involved in this probe.
Backend received a request for a final signer-grant clock check and a delay regression before source freeze.

The correction awaits the recovery wrapper, then checks the separate signer grant against database clock_timestamp() on the same transaction.
The original independent probe now passes. The tracked result-signing-expiry.test.ts preserves that regression and also passes.
The grant and stream remain locked during that check. The correction does not add another signing attempt.

Pure signer, driver, result policy, and delivery protocol regressions pass: 13 tests, 106 assertions.

## Independent database verification after source freeze

| Scope | Result |
| --- | --- |
| Expiry delivery recovery | 7 passed; 45 assertions |
| Ordinary delivery and typed signature regressions | 9 passed; 60 assertions |
| Transaction pool ownership at max 1 and max 4 | 4 passed; 16 assertions |
| Tracked signer grant expiry regression | 1 passed; 1 assertion |
| Independent anchor ordering and signer grant expiry probes | 2 passed; 2 assertions |

The recovery suite applies migration 0107 twice against the disposable PostgreSQL fixture.
It covers one lease winner, unchanged compute expiry, replacement hire refusal, null legacy evidence, revoked compute authority, and stopped signer refusal.
It tests expiry behind a result lock, unknown upload refusal, and matching Submitted reconciliation without another submit.
Its signature fixture covers first capture under delivery authority and restart with captured or missing bytes after delivery revocation.
Both restart cases prohibit another signer call.
Its submit fixture retains one nonce and refuses revoked delivery authority.
Its broadcast fixture retains exact bytes and nonce, skips transport for matching Submitted evidence, and checks expiry behind the operation lock.

The independent read-only recovery-pool-audit.ts probe also returned refused with callback false using a max-one pool.
Its controlled evidence reader refused. This result establishes prompt refusal without a nested pool wait; it does not prove successful chain reads.

Database commands used BRAINCHAIN_DB_FIXTURE=1 and ran separately:

```powershell
bun test apps/api/src/services/brainchain/delivery-recovery.test.ts
bun test apps/api/src/services/brainchain/task-delivery-db.test.ts
bun test apps/api/src/services/brainchain/result-signing-pool.test.ts
```

Inspection confirms that composite foreign keys retain result ownership and compute lineage.
The existing result immutability trigger also protects the new hire snapshot fields.
The new authority, lease, reconciliation, and submit-lease triggers prevent later replacement of those records.
Broadcast recovery checks current signer generation and revoked intent/gas authority, while a fresh grant supplies the explicit expiry override.
All recovery transaction reads use the supplied transaction connection.
No unresolved scoped blocker remains. A fresh integrated audit remains separate.

## Verification boundaries

The root authorized ephemeral synthetic keys for the existing local delivery fixture. No private bytes were printed.
No real wallet key, payment, provider call, live upload, or chain transaction occurred in this review.
Controlled probes do not prove current testnet health, staging parity, production mounts, or full integration completion.
The activation gate must remain closed until the separate release requirements pass.
