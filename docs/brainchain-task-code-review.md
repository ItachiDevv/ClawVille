# BrainChain task observations: independent code review

Last Audited: 2026-11-09. Team: brainchain-office. Role: independent reconciler.
Scope: migration 0101, task ownership, bounded RPC reads, indexing, and recovery-only leases.

## Disposition

SCOPED APPROVAL: the corrected observation and recovery-only code addresses P2-1 and P2-2.
Independent repeat probes reject stale batches, incomplete checkpoints, and amounts above the contract integer width.
No blocking issue remains in this reviewed phase.
This report does not approve signing, model execution, settlement, or a successful pilot.

## P2-1: cursor comparison permits stale ingestion after rewind

Status: corrected and independently rechecked. The following description records the initial defect.

`persistIndexBatch` compares only `nextBlock` against the batch's expected next block.
`suspendOrphanedBoard` resets that value to the deployment start block.
A batch read before suspension can therefore match the same value after suspension.
Its stale observations then restore `canonical:true` without a new chain read.
The local `syncs` map does not prevent this race across API processes.

The reviewer reproduced this through the actual service and isolated PostgreSQL on itachi222:

1. Persist a batch whose expected cursor equals the board deployment block.
2. Suspend the board and rewind its cursor.
3. Resubmit the identical batch from step one.
4. Observe successful persistence and the suspended task restored to `canonical:true`.

The same comparison also misses a concurrent cursor change when scans refresh status without advancing the next block.
Use a durable monotonically increasing cursor revision or board epoch.
Capture it before remote reads and compare it inside the persistence transaction.
Increment it on every accepted batch and every suspension, including a suspension before any cursor row exists.
Make the initial cursor creation atomic, so two processes cannot both treat an absent row as their own initial state.

Every path that restores task canonical status must use this fence.
`recordWorkerObservations` currently provides a separate ingestion path without cursor comparison.
Remove it from production ingestion, or require the same observed board epoch there.
Tests must reject the stale batch after rewind and a stale batch after a nonadvancing status refresh.

## P2-2: incomplete checkpoint and integer bounds

Status: corrected and independently rechecked. The following description records the initial defect.

The cursor CHECK permits a non-null checkpoint hash with a null checkpoint block.
SQL CHECK accepts UNKNOWN, so the expression's nullable comparisons do not enforce a complete pair.
Require both columns explicitly non-null in the populated branch.

The reviewer updated a fixture cursor to a null block and a valid non-null hash; PostgreSQL accepted it.
The reviewer also stored `2^128` as a bounty; PostgreSQL accepted that value.
Enforce the uint128 maximum for bounty and the uint256 maximum for task identity.
Keep service validation and the Drizzle declarations consistent with migration constraints.
The current ABI decoder restricts real chain values, but the database should preserve the same invariant.

## Correction evidence

The cursor now stores a monotonically increasing epoch.
Persistence compares both expected epoch and expected next block under the worker's database lock.
Every accepted batch increments the epoch, including a refresh that leaves the next block unchanged.
Suspension increments the epoch and creates a fenced cursor when none exists.
The unfenced `recordWorkerObservations` export no longer exists.

The reviewer independently repeated the original real-database reproduction with the corrected service.
The pre-reorg batch now fails and its task stays suspended.
A separate replay after a nonadvancing cursor refresh also fails.
The reviewer checked the removed export directly.

The migration and Drizzle constraints now require complete checkpoint pairs and uint256/uint128 bounds.
Independent updates with a half-null checkpoint and a `2^128` bounty now fail at the PostgreSQL boundary.
The reviewer corrected only its uniquely identified malformed probe row before migration validation.
The report retains the original failure evidence above.

The updated real task suite passed six tests and 34 assertions.
The RPC suite passed four tests and 54 assertions again.
The snapshot now explicitly returns `executionEligible:false` and a recent/stale classification with a 120-second age threshold.
That field remains false even for recent observations; the current phase grants no execution authority.

## Independent evidence

The reviewer checked the existing isolated PostgreSQL process before testing.
It listens on `127.0.0.1:55439` on itachi222 and uses the job-local fixture directory.
Only fixture records received writes. No staging or production database received changes.
The reviewer read the fixture password privately and printed no credential.

The initial task suite passed five tests and 27 assertions before corrections.
It covers duplicate ingestion, immutable ownership, concurrent recovery claims, foreign composite references, lease suspension, and changed-checkpoint detection.
The bounded RPC suite passed four tests and 54 assertions.
It covers decoded stake, fixed hosts, wrong chain, private DNS, redirects, response bounds, invalid envelopes, and timeout behavior.
These suites did not cover the stale-batch rewind race before this review.

The reviewer also queried the official testnet RPC through the actual read adapter.
At provisional block `0x13de`, `get(0)` decoded on all four pinned board releases: 3.5.0, 3.4.1, 3.4.0, and 3.1.0.
The zero task is only an ABI compatibility probe; it proves no hire or settlement.
The block age at this probe was 23,038 seconds.

## Reviewed properties

- Binding address ownership and task identity are immutable through migration triggers.
- Composite foreign keys constrain tasks, attempts, and cursors to the same binding, avatar, environment, and chain.
- Task identity uses chain, board, and task ID; manifest changes cannot create a second owner.
- Current and retired board addresses come from tracked constants, not caller input or a dynamic manifest.
- The indexer decodes the exact hire event and checks board, model, block range, removal flag, and hire-block hash.
- It reads task state at a selected block and checks that block's hash again before persistence.
- It checks prior cursor checkpoint hashes and suspends affected tasks when it detects a reorg.
- Suspensions preserve task identity and owner and invalidate existing recovery generations.
- Changed hire evidence also increments the task generation and suspends old inspectors.
- Recovery claim and completion lock the task row; completion checks owner, generation, canonical state, lease token, and wall-clock expiry.
- Recovery leases have only the `recovery` purpose. They contain no signing or model authority.
- RPC requests use fixed hosts, a method allowlist, DNS checks, manual redirects, response bounds, and a 30-second read-session deadline.
- Each sync handles one board, bounded block ranges, and bounded new and refreshed tasks.
- Dense event ranges shrink instead of discarding events or advancing an incomplete cursor.
- Human and agent route paths derive avatar ownership through the reviewed common identity gate.

## Execution and finality gates

Historical reads can remain useful when the provisional block is old.
Age alone must not authorize execution from that observation.
The corrected snapshot exposes stale/provisional status and keeps execution admission false.
The later signer must independently enforce current chain identity, task state, deadline, canonical evidence, and freshness.
The current phase has no execution admission path, signer, automatic scheduler, or model calls.

Head minus 12 is a provisional observation margin, not verified parent-chain finality.
The `eth_getCode` check proves nonempty code only; it does not prove the reviewed runtime code hash.
Both limits must remain explicit before later money or signer increments.

The backend reports full-schema fixture validation with 169 tables after migration application.
This reviewer independently ran the smaller real task fixture, not that separate full-schema replay.
No live deployment or full protocol pilot follows from either database fixture.

The PostgreSQL fixture remains available for corrections and repeat tests.
