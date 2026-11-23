# BrainChain signer and execution review

Reviewed: 2026-11-09. Reviewer: durable_audit, team brainchain-office.
Scope: local source and disposable PostgreSQL on port 55439. No signing authorization exists.

## Verdict

The two earlier signer blockers are resolved in the reviewed source. The signer remains inactive.
The additional canceled-charge SQL finding is also resolved. No blocker remains within this inactive implementation scope.
This review does not authorize deployment, paid inference, key access, transaction submission, or a live pilot.

## Corrections verified

1. Migration 0102 now installs all four signer CHECK constraints. An independent catalog query found each constraint. The previous uint64 overflow probe now fails with PostgreSQL SQLSTATE 23514. Each deliberate probe used transaction rollback.
2. Capture commits `accepting`, acceptance time, and the reserved nonce before key use. The protected journal claims one operation and frozen intent. Recovery looks up the operation without invoking the driver. A missing payload leaves uncertainty and retains the nonce. Stream retirement cannot erase accepted liability.
3. The capture fault test observes committed acceptance through a separate database connection. A driver timeout followed by late completion does not cause another key call.
4. The Linux journal publishes immutable files through exclusive hard links, file sync, and directory sync. An independent two-process test produced one `won` and one `lost` for the same operation. No key existed. The test used UID 10001, no network, a read-only root, dropped capabilities, and the existing fixture volume.

Journal evidence limits remain important. Process replacement and competing claims do not prove host power-loss behavior. A crash between link publication and temporary-link removal can leave a file with two links. The reader refuses that file. This preserves refusal of further key use but requires operator recovery. The service does not retry an ambiguous signature.

## Execution and compute review

Migration 0104 binds execution authority through composite foreign keys to task, worker, avatar, environment, chain, generation, and input hashes. Authority consumption is single-use. Execution checks the canonical Hired task, running worker, exact observed block, fresh observation, frozen brief and prompt, and database wall time after locks. Its lease has a 60-second ceiling. Recovery leases cannot authorize cognition. Reorg handling suspends execution and changes the generation.

The inference proxy reserves integer micro-USD before dispatch. It commits dispatch and uncertain cost before invoking the provider. A repeated capability cannot invoke the provider again. Provider ambiguity retains the maximum liability. Settlement survives lease loss; stale output does not leave the proxy. Envelope closure refuses outstanding reservations or uncertain costs. Provider caps remain distinct, and root envelope approval requires an external root-ledger verifier.

The policy now includes an explicit input-framing allowance. A concrete provider adapter must substantiate that allowance, token semantics, rates, output/reasoning bounds, and disabled retries. The current interface alone does not prove these external properties. The root-ledger verifier also remains a deployment dependency; fixture approvals are controlled test substitutes.

The restricted runtime uses actual Eliza core initialization and `useModel`. It has a fresh in-memory adapter, one model handler, no gameplay action surface, no embeddings, no default provider fallback, one dispatch, and a deadline. The clean import avoids platform database and provider initialization. This is a capability boundary, not an OS sandbox. New stdio tests passed during this review, but their new implementation requires a separate source review.

## Additional finding

Migration 0103's original canceled lifecycle branch compared nullable `charged_micros` with zero. PostgreSQL accepts NULL CHECK results. An independent rollback probe changed a reserved call to canceled with a NULL charge. The service wrote zero, so this review found no exposed service path. The owner added an explicit non-null condition and a direct SQL regression. The independent probe now refuses with SQLSTATE 23514 and constraint `brainchain_compute_call_lifecycle`.

## Test evidence

- Execution authority, envelope ownership, and inference proxy database suites: all 14 tests passed in the independent combined run.
- Corrected signer database suite: 7 tests, 29 assertions passed.
- Isolated capture fault suite: 1 test, 8 assertions passed. Only artifact admission was mocked in a separate test process.
- Restricted runtime, clean import, new process tests, and inference policy: 18 tests, 89 assertions passed. Process-test success is not source-review approval.
- Independent Linux competing-claim probe: two processes, one winning claim, zero keys.
- The first signer recovery run failed because random synthetic signature `r` did not always identify a curve point. The owner replaced it with a known curve-point coordinate. The corrected suite passed.

Independent scratch evidence lives in `.brainchain-work/audit-journal-race.ts`, its bundle, and its shell launcher. The launcher uses the existing labeled journal fixture volume. Initial Bun child spawning failed with EACCES. A shell launcher with LF line endings ran the two actual Bun processes. No implementation file changed during this audit.

## Artifact and activation gates

The five-contract release 3.5 evidence retains SHA256 `8b46e30860906b587f6ad65ee1e7561fcd201a100de5d93f281dc716837a7862`. The earlier independent check covered all 55 immutable slots across 11 variables. Metadata differs; executable equivalence is not exact metadata identity. Full observed runtime hash checks remain mandatory.

The additional dependency artifact evidence is supplied by the lead. This report does not independently approve its mutable owner, brain, or attestation state. Mainnet must remain rejected. Keep artifact activation closed until the remaining adapter, custody, isolated process, root budget, dependency state, and explicit signing-authorization gates pass. No successful paid or on-chain pilot is claimed.
