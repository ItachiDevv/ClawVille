# BrainChain typed result signature and submit review

Last Audited: 2026-11-09

Verdict: S1 resolved within the reviewed inactive typed signer scope. The signer activation gate remains closed. This review authorizes no live signature, upload, or transaction.

## S1: nested pool reads can deadlock capture

`ResultSignatureCoordinator.authority` calls `delivery.read` through the base PostgreSQL pool from inside an existing transaction. `TaskDeliveryCoordinator.withCurrentResult` repeats that external pool read. Each transaction already owns a pool connection. With one connection, the read cannot acquire a connection until its own transaction ends. Concurrent operations can exhaust a larger pool in the same way.

Independent probe: `.brainchain-work/audit-result-pool.ts`. It uses the disposable fixture at 127.0.0.1:55439 with `max:1`, selects an existing result, and calls `withCurrentResult` inside `sql.begin`. After 700 ms, it reports `{"result":"pool_wait_timeout","callback":false}`. The probe then closes only its own client. It performs no signature or row mutation. A stale result must refuse promptly; it must not wait for another pool connection.

The correction routes both owner reads through the supplied transaction. Independent inspection confirms that `authority` and `withCurrentResult` use `readInTransaction`, which supplies the existing connection to the shared read helper. Ownership and digest checks remain intact.

The original independent probe now reports `{"result":"refused","callback":false}`. The reviewer also ran the new read-only PostgreSQL regressions: 4 passed, 16 assertions. The helper cases occupy every pool connection behind a barrier before reading. Both max:1 and max:4 cases refuse stale execution authority promptly. The capture cases also refuse without any driver or journal call.

## Reviewed protections

- Result capture inserts durable acceptance before the coordinator journal claim and driver call. A prior operation enters recovery only.
- The exact EIP-191 message fixes chain, current board, task, and result hash. Signature recovery checks the permanent worker address.
- The driver copies and validates the typed intent before asynchronous work. It checks current authority before key access and again after file reads.
- Result journal filenames use a distinct namespace. Transaction and result payload grammars differ. Atomic driver claims prevent repeated key use after uncertainty.
- Recovery verifies captured bytes and reads them back from the protected journal. Recovery can preserve evidence after revocation without a new signature.
- Migration 0106 adds composite owner foreign keys, unique result/authority use, immutable signature intent, and immutable result-to-submit linkage.
- Submit preparation, nonce reservation, acceptance, and first key use check the linked frozen result and current execution fence. The SQL helper checks clocks after row locks.
- Submit calldata fixes the current board, task, hash, URI, and zero value. Intent and gas authorizations remain separate. Recovery retains the accepted nonce and bytes.
- Broadcast rechecks submit authority and retains uncertainty on failure. Captured evidence remains recoverable after revocation. Cross-system revocation is not atomic.

## Independent verification

The reviewer ran these suites sequentially against the existing disposable fixture:

- Delivery and typed capture database suite: 9 passed, 60 assertions.
- Signer database suite: 7 passed, 34 assertions.
- Capture crash-boundary database suite: 1 passed, 8 assertions.
- Typed result policy and delivery protocol: 5 passed, 55 assertions.
- Signer policy, driver restrictions, service, and RPC: 17 passed, 160 assertions.

The reviewer also reran the actual Linux fixture in a network-disabled container under UID 10001: 1 passed, 27 assertions. The fixture uses only the public-known synthetic scalar 1 and an isolated activation mock. It tests typed signatures, separate namespaces, capture recovery, revocation after file reads, typed submit restrictions, and replay without key reads.

The mounted fixture SHA256 was `e8bdba329eeda31a4bcae990a7be33348cec4fd1b835621fa094ff4c62bb3c5a`. The policy bundle SHA256 was `a3adf9b604e9378eee11916e8456c346ac3ac8a6d473c57c8becca4c4b6543ab`. Both match the owner's evidence document. The kernel warned that swap limits were unavailable. This run proves neither host power-loss durability nor a production key volume.

## Remaining gates

Keep artifact activation closed. Current mutable chain state, root authority provisioning, protected deployment mounts, and an authorized end-to-end pilot remain separate requirements. No live keyring, provider call, upload, payment, or transaction occurred in this audit.

## Delivery recovery design review

The root supplied the backend proposal after S1 review. Its separation is appropriate: immutable compute lineage remains evidence, while a fresh root-issued delivery authority and lease authorize only named delivery stages. This is design approval with the constraints below, not implementation approval.

1. Freeze the original hire fingerprint with the result. Include environment, chain, board, task number, model, brief hash, hire block hash, transaction hash, and log index. Existing rows without trustworthy original hire evidence must refuse recovery. A new authority cannot manufacture that evidence from a replacement hire.
2. Preserve the original attempt, compute call, result text, hashes, and generations. Do not revive or extend the compute authority. No delivery operation can request new cognition or change the output.
3. A root delivery grant must bind result identity and hashes, avatar, worker binding, original hire fingerprint, current canonical epoch, explicit stage, and expiry. Persist the grant separately from a short lease. Consume each grant atomically for one lease owner and generation. A later lease requires another explicit grant.
4. Support expiry recovery only in the first increment. Revoked compute authority, a stopped signer, foreign ownership, or changed original hire must refuse. Do not add an implicit override or treat historical consumption as current authorization.
5. Acquire task, authority, lease, and result locks in a documented common order. Recheck database clocks and exact relationships after waits and before acceptance. Recheck after external reads and file waits. Keep all transaction reads on their supplied connection.
6. A canonical current-board Hired observation with the same original hire and brief is required before a new upload or first submit. Check block hash, age, and task deadline. A reorg invalidates delivery leases even when the task number remains unchanged. Matching existing Submitted evidence should enter reconciliation; it must not cause a new submit operation.
7. A frozen result with no prior signature acceptance may use a separately authorized first typed signature. Once acceptance exists, recovery uses captured journal bytes only. Acceptance without a capture remains uncertain; it never permits a second key use.
8. Uploaded state resumes only the immutable hash and URI. An uncertain upload is evidence-only until reviewed partner semantics establish safe reconciliation. Do not reset it to frozen or retry its POST. Any future remote receipt fetch needs its own fixed-host, exact-byte/hash, deadline, and response-limit review.
9. Preserve one submit operation per result and its exact nonce, calldata, signed bytes, and gas liability. A fresh broadcast recovery grant must bind the existing operation, transaction hash, nonce, and retained gas ceiling. It must not allocate another nonce, replace bytes, or release unresolved gas liability. Original authority expiry can require a new delivery grant; original revocation cannot silently become expiry recovery.
10. Run one durable stage per coordinator tick. A crash after external dispatch preserves uncertainty. Only verified evidence advances the state. This increment must not add settlement, dispute, withdrawal, or reward methods.

Required independent tests include: expiry recovery without recomputation; revocation refusal; replacement hire refusal; unchanged result hashes; two lease claimants; lease expiry during lock waits; reorg during a lease; captured signature recovery without key access; absent capture without retry; uncertain upload without a second POST; matching Submitted reconciliation; exact submit bytes and nonce retention; one-connection pool saturation; and idempotent additive migrations with composite owner constraints.

The fresh delivery authority must use a different name and type from the existing inspection-only recovery attempt. Inspection leases grant no delivery rights. The final database-to-external-call race remains explicit; this design cannot promise atomic revocation across those systems.
