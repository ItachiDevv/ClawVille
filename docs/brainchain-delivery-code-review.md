# BrainChain delivery code review

Last Audited: 2026-11-09

Verdict: D1 resolved in the reviewed inactive delivery scope. This review does not authorize signer activation, live upload, or transaction submission.

## Scope

Reviewed `task-delivery.ts`, `task-delivery-protocol.ts`, their tests, database schema `brainchain-delivery.ts`, migration 0105, composite indexes, and the schema export. Reviewed the recorded current-board result URI observations. Those observations support the URI format; they do not prove current service availability.

## D1: execution expiry after result lock wait

`prepareSubmission` checks the execution fence before it acquires the result row with `FOR UPDATE`. The later clock check covers observation freshness only. A result row lock can therefore delay preparation past the execution lease and authority expiry.

Independent reproduction: `.brainchain-work/audit-delivery-lock.ts`, against the disposable PostgreSQL fixture at 127.0.0.1:55439. The probe uses cloned fixture records and a synthetic uploaded result. It holds the result row for 2.2 seconds across a two-second authority and attempt lease. The coordinator returned `{"prepared":true}`. No signature, network upload, or transaction occurred.

The upload claim has the same ordering risk: its result UPDATE follows the execution fence and can wait on that row. Recheck the full execution clock fence after result acquisition and before acceptance. Add separate result-lock expiry tests for preparation and upload. The upload test must prove zero transport calls and no committed upload claim.

Backend and root received the finding and reproduction path. Independent correction review confirms full fences after result acquisition and after each state UPDATE. Upload also checks the fence after claim commit, before transport. A refusal after commit retains uncertainty and prevents retry.

The original independent probe now returns `{"prepared":false,"error":"Current settled execution fence required"}`. The full database suite passes 8 tests and 42 assertions. Separate expiry tests cover both result-lock paths, including zero upload calls and no committed upload claim.

## Observed protections

- Composite foreign keys bind result rows to task, avatar, binding, environment, chain, attempt, generation, lease owner, and prompt hash.
- Unique indexes enforce one result per task, attempt, and compute call. The immutable trigger checks settled source output and prevents result changes.
- The service freezes actual settled output. It recomputes exact UTF-8 SHA256 and keccak hashes on reads. It rejects invalid surrogate text, NUL, empty output, and oversized output.
- Upload verifies the worker signature over the exact task, board, chain, and result hash. A durable claim precedes transport. Uncertain claims cannot retry.
- Transport uses a fixed testnet endpoint, no redirects, no credentials, a five-second bound, and an 8192-byte response limit. Returned URI and hash must match the frozen result.
- Submission preparation emits pinned current-board submit calldata with zero value. It returns `signingAvailable:false` and has no signer or nonce capability.
- The activation gate prevents actual upload. Read-only result replay remains possible after execution expiry; action admission requires a live execution fence.

## Independent checks

`bun test apps/api/src/services/brainchain/task-delivery-protocol.test.ts`: 3 passed, 0 failed, 41 assertions. These tests use controlled responses and an isolated activation mock.

The independent PostgreSQL lock probe first demonstrated D1 and then confirmed refusal after correction. Root explicitly permitted synthetic fixture signatures for the correction review. The full database suite used only ephemeral fixture signatures and controlled transports.

An initial full run had one deadlock against concurrent fixture DDL. The next invocation stopped on a temporary shared build syntax error. After shared files stabilized, all 8 database tests passed. No implementation changes came from this reviewer.

## Remaining gates

Keep the signer activation gate closed. Typed upload-signature authority, final transaction admission, current chain health, and an authorized end-to-end pilot remain separate reviews. Database commit and remote transport cannot provide atomic revocation across systems. This report makes no live integration claim.
