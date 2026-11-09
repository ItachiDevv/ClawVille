# Worker coordinator and signer observation review

Last Audited: 2026-11-09

Verdict: approved within the reviewed explicit-stage coordinator and read-only observer scope. The activation gate remains closed. This is not approval of an autonomous policy, scheduler, credential configuration, or paid pilot.

## Scope and constraints

Reviewed `worker-coordinator.ts`, `signer-observation.ts`, their tests, and `apps/api/scripts/brainchain/run-worker.ts`. Read the current handoff, ownership registry, and applicable identity/protocol invariants. The host supplies trusted runtime adapters. No HTTP caller selects executable configuration or supplies an authority factory.

The coordinator resolves avatar-bound testnet worker ownership before observation or action. It checks that service, runtime, and lock pools reach the same database endpoint. A separate reserved connection holds the per-worker advisory lock. Nested services retain their own connection capacity. Explicit stage inputs reference existing authorities; the coordinator issues none.

## Observed behavior

- A frozen result prevents another admission or compute call. An existing compute reservation or uncertain call returns evidence status instead of dispatching again.
- Accepted signature and transaction operations enter captured-byte recovery. The coordinator does not invoke another key-use attempt.
- Uploaded results skip another upload. Uploading and uncertain upload states return an evidence requirement. They do not reset their durable claim.
- Submit operations use the immutable result link and retained nonce. Receipt checks remain provisional. Delivery recovery uses existing grants and lease proofs; it creates no replacement compute result.
- The command parses its bounded request before it imports an explicitly selected trusted host module. Errors use a sanitized message. Runtime construction remains trusted operator code, not a sandbox or credential-provisioning mechanism.

## Observer checks

The observer resolves a live testnet signer binding before RPC. It checks chain ID, exact pinned runtime hashes, and release 3.5 getter layouts. All calls use one provisional block tag. A final sequential block read checks number, hash, and timestamp. The final clock check rejects a block that expires during preceding reads.

An open matching proposal sets pending status. When the worker is not allowed, the observer scans at most 32 executor changes. An exact unexecuted, unvetoed worker admission sets pending status. A larger history refuses instead of claiming no pending application. Durable indexing remains required to support larger histories.

## Independent evidence

The local PostgreSQL coordinator test passed 1 test with 21 assertions. It uses real admission, reservation, settlement, frozen-result, signature acceptance, and submit services. The child boundary, provider, transports, and protected journal are controlled. Synthetic signatures occur only in the fixture. The test preserves one compute call and one upload across restart paths.

The observer suite passed 7 tests with 162 assertions. It covers wrong binding, wrong chain, changed code, reorg, oversized queue, and final-read expiry.

An independent queued-application probe passed 1 test with 82 assertions. It supplies a contract-shaped pending `getChange` record, then marks that record executed. The observer reports pending only for the first state. Probe: `.brainchain-work/audit-observation-queue.test.ts`.

The first database invocation correctly refused because the new fixture helper required explicit local opt-in. The subsequent run set both `BRAINCHAIN_DB_FIXTURE=1` and `BRAINCHAIN_LOCAL_FIXTURE=1`. The reviewer coordinated the fixture window with the CI owner. No concurrent schema operation occurred.

## Limits

No live RPC, provider credential, upload, or signed network call occurred. The observer trusts the configured RPC and does not establish consensus finality. The coordinator tests do not establish an autonomous task selection policy, a persistent scheduler, a public session entrypoint, or deployment parity. The explicit host-module command remains a privileged operator interface. No new blocker arose within this scope.
