# BrainChain durable backend: independent reconciler review

Last Audited: 2026-11-09.
Team: brainchain-office. Role: independent reconciler.
Scope: design review and independent constraint derivation. No migration, deployment, wallet action, or implementation edit occurs.
Drift note: durable implementation needs the constraints below before any signer or custody path activates.

## Disposition

The public read adapter does not grant money authority.
The durable schema design provides a useful starting point.
Its task uniqueness rule is correct: `(chain_id, board_address, task_id)`.
Its active address rule correctly excludes contract-set hashes.
The design needs stronger relational ownership, address-history attribution, signer fencing, and budget boundaries before implementation approval.
This report reviews design, not deployed behavior or a completed durable implementation.

## Existing primitives inspected

- `apps/api/src/middleware/require-auth-or-agent.ts`: live human/agent identity resolution, rotation checks, bound-avatar checks, and separate ledger capability gate.
- `apps/api/src/services/spend-policy.ts`: human-controlled cap changes and transaction-scoped `spend-policy:<avatar>` lock.
- `apps/api/src/services/spend-policy-proof.ts`: exact-value wallet proof; its current nonce store is process-local.
- `apps/api/src/services/outbound-x402.ts`: Solana-only exact USDC quote selection, pinned recipient, reservation, job fence, and capture-before-send.
- `apps/api/src/services/usdc-spend-admission.ts`: separate shared-wallet liquidity lock and open-liability accounting.
- `apps/api/src/services/wallet-withdraw-executor.ts`: durable signature capture before broadcast, then forward-only reconciliation.
- `packages/database/src/schema/vendor-spend-ledger.ts`: per-avatar idempotency and separate payer/settlement signature evidence.
- `packages/database/src/schema/agent-ai.ts`: atomic model-cost reservations, estimated usage, and daily accounting.
- `packages/agent-runtime/src/eliza-runtime.ts`: runtime initialization, SQL adapter, provider priority chain, shared state access, and model fallback.
- `apps/api/src/routes/brainchain.ts` and `apps/api/src/services/brainchain/public-client.ts`: current public read surface and bounded probes.

These are local implementation patterns, not blanket authorization to extend their domains.
The Solana x402 signer is not an EVM signer.
The process-local proof store is not a safe durable challenge template across replicas.

## Required constraints

### 1. Preserve ownership across every relationship

Independent UUID foreign keys do not prove that records share an owner.
Constrain task-to-binding ownership with a composite foreign key or an equivalent enforced database relation.
The relation must include binding ID, avatar ID, environment, and chain ID.
Constrain operation-to-binding and attempt-to-task relations the same way where ownership fields repeat.
Prevent an attempt from spending another avatar's compute reservation.
Prevent a receipt from joining an operation and task that belong to different bindings.
Use restricted deletion for history and recovery records.

Normalize EVM addresses before storage and enforce canonical lowercase form in the database.
Reject zero addresses and invalid chain/environment pairs.
Store EVM amounts as bounded nonnegative atomic integers, never floating-point numbers.
Use explicit checks for hashes, positive attempt numbers, timestamps, lease pairs, and permitted state transitions.
Nullable fields must not weaken uniqueness for active records.

### 2. Active address uniqueness alone leaves a historical attribution gap

Consider avatar A's worker hire before retirement.
Avatar A retires the binding before the indexer reads that hire.
Avatar B then binds the same address.
An indexer that selects the current binding attributes the old task to B.

Minimal pilot rule: permanently reserve each `(environment, address)` to one avatar across retirement.
A retired binding can reactivate only for that avatar under a fresh proof.
This rule preserves attribution without a new address-transfer protocol.
Still preserve immutable task ownership after creation.

If later releases permit ownership transfer, introduce explicit binding epochs.
Record their effective block numbers and hashes, not only API timestamps.
Attribute hires through the binding epoch active at the hire block.
Prohibit a new binding from claiming historical hires through delayed indexing or a reorg.
Keep old tasks, receipts, and recovery rights attached to their original binding.
Do not infer avatar ownership merely because a wallet currently signs a challenge.

### 3. Consume challenges with an atomic database condition

Use at least 32 random nonce bytes.
Bind the message to the API domain, proof version, purpose, avatar, environment, chain ID, address, nonce, issued time, and expiry.
Store the exact canonical message or every immutable field needed to reproduce it exactly.
Hashing an unspecified message alone does not define its reconstruction.
Never accept a replacement message from the client.

Verify the signature against the server message.
Within one database transaction, consume the challenge with:

```sql
UPDATE brainchain_binding_challenges
SET consumed_at = now()
WHERE nonce_hash = $1
  AND avatar_id = $2
  AND consumed_at IS NULL
  AND expires_at > now()
RETURNING nonce_hash;
```

Check environment, chain, address, purpose, and stored message hash in the same operation.
Create the binding in that transaction only after exactly one challenge row returns.
A failed binding insert rolls back consumption, or deliberately records a terminal refusal; choose one documented behavior.
Concurrent successful attempts must produce one binding.
Challenge expiry uses database time for the final condition.
Rate limits must cover issuance and verification across API processes.

Run `requireAuthOrAgentSession` followed by `requireLedgerCapableIdentity` before binding mutations.
Use `c.get('identity').avatarId`; never trust a body avatar ID.
Require fresh authorization for binding retirement or changes that affect pending operations.
Wallet proof associates an address. It grants no spending, borrowing, or signer authority.

### 4. Separate task execution leases from signer authority

Each attempt needs an unguessable lease token and a monotonically increasing fencing generation.
Every task update, output persistence, result upload, and signing request must compare that generation.
An expired lease permits recovery inspection, not a new economic action by itself.
The signer must reject a stale owner even if the API process still holds old work in memory.

The signer accepts a typed operation ID, not arbitrary calldata or an arbitrary RPC URL.
It loads the immutable binding, task, method, destination, amount, deadline, and authorization from durable records.
It checks the current fencing generation immediately before durable signing acceptance.
Do not provide a general `eth_sign`, arbitrary EIP-712 signing, or unrestricted transaction endpoint.
Allow only the methods needed for the current testnet phase.
Exclude proposal administration, credit consent, arbitrary approvals, minting, and task disputes until separately reviewed.

Record an EVM nonce and signed transaction hash before broadcast.
Keep any signed raw transaction in protected storage, never ordinary logs or task-visible records.
Enforce signer-address/chain/nonce uniqueness across workers and API replicas.
The signer must make durable signing acceptance idempotent by operation ID.
After timeout, inspect the recorded transaction and nonce before any replacement.
A replacement needs an explicit same-operation policy, bounded fees, and proof that it cannot duplicate the economic effect.
Do not copy Solana signature rules into EVM nonce handling without review.

One dedicated testnet key supports one pilot avatar under the address uniqueness rule.
Multiple avatars require separate keys and isolated signer references.
Reject mainnet in the signer regardless of client labels or feature flags.
Use a dedicated key that never holds mainnet value.

### 5. Make chain observations reversible without transferring ownership

Persist chain, board, task ID, log locator, block hash, and block number for acquisition evidence.
Verify the emitting board, hired model ID, topic, and decoded event against the pinned manifest.
Do not trust a task ID supplied by a client or partner response as assignment evidence.
Persist indexer cursors and bounded rewind checkpoints.

After a reorg, mark the observation orphaned and suspend affected execution or credit.
Do not delete task ownership or free its uniqueness constraint.
Accept a replacement canonical observation only for the same task identity.
Do not change the task's avatar because a new indexer pass sees a different current binding.
Define confirmation thresholds per chain and operation before release.
The unique receipt constraint prevents duplication; it does not verify a receipt.
Verify transaction success, event or instruction locator, token, recipient, exact amount, and canonical block independently.

### 6. Keep reservation categories and authorization separate

Model compute, testnet gas, testnet stake, application bonds, live purchases, and credit require distinct authority.
The founder's provider API budget does not authorize mainnet wallet spending.
The job's provider caps remain cumulative across sessions and retries, even if product budgets use daily windows.

For a future live purchase, take the existing per-avatar spend-policy lock before checking vendor grants and caps.
Recheck authority at the fenced signing boundary.
Respect per-call approval settings; a vendor grant does not disable them.
An outstanding signed authorization remains a liability after its task lease expires.
Do not reset that liability at UTC midnight or provider restart.
Do not release a reservation because a partner returns HTTP 402 after a signed request.

Shared custodial wallet liquidity has a different existing lock: `lockPosterUsdcSpend`.
Its liability query currently includes bounty, agent-payment, withdrawal, and trading reservations.
It does not include the proposed BrainChain records or the vendor spend ledger.
A future BrainChain live wallet path needs shared-liquidity accounting, in addition to daily vendor caps.
Coordinate that change with the token-economy owner and define one consistent lock order.
The dedicated testnet pilot avoids this live-wallet coupling.

For compute, reserve the worst-case model cost before dispatch.
Include retries, output tokens, embeddings, and applicable model fallback.
Unknown provider charges remain reserved until reconciled.
Do not silently fall back to platform-paid inference when the approved job provider reaches its limit.
The current runtime contains a provider fallback chain; the task configuration must enforce this budget boundary explicitly.

### 7. Use an actual isolation boundary for Eliza cognition

The existing runtime initializes a SQL adapter and can read agent memories.
It also configures model providers and can place an OpenAI key into its process environment.
Reusing an avatar's normal runtime therefore does not prove the proposed secret-free task boundary.

Create an isolated task runtime through the approved ElizaOS interface.
Use a separate task identity and a restricted database view or separate task store.
Do not mount ordinary avatar memory, unrelated chats, provider key files, host source files, or signer IPC.
Start the process with an explicit environment allowlist.
Use an inference proxy if the executor must hold no provider credentials.
Restrict that proxy to the task lease, chosen model, token ceiling, deadline, and budget reservation.
Disable tool actions, shell execution, dynamic plugin installation, and uncontrolled network requests.
Task prompts remain untrusted input even when wrapped in safety instructions.

### 8. Do not confuse local pause with protocol eligibility

Pause may stop local task dispatch while the protocol still hires the address.
Display both states.
Drain needs a verified protocol eligibility control or an explicit risk of additional hires.
Do not repeatedly restake or reapply during shutdown recovery.
Preserve pending tasks and authorized transactions through deploys and rollback.
Reconcile durable operations before starting a new execution loop.

## Minimal safe implementation sequence

1. Implement canonical validation, ownership constraints, challenge consumption, and read-only binding history.
2. Test the schema against a disposable local database. Do not infer database guarantees from mocked transaction tests.
3. Add pinned contract reads and a bounded event indexer with reorg fixtures.
4. Add durable tasks, attempts, leases, fencing, and output references without signing.
5. Add a dedicated testnet signer for one avatar, with method allowlists and capture-before-broadcast recovery.
6. Prove signer isolation and stale-worker rejection before connecting a model.
7. Add bounded Eliza task cognition and durable compute reservations with no unapproved fallback.
8. Run the authorized testnet pilot, including real protocol windows and failure recovery.
9. Expose the same records and operations through human and bound-agent paths.
10. Review live purchases, shared-liquidity accounting, cash-out, and credit as separate money-path increments.

The testnet public health snapshot lists stalled hires caused by Jev HTTP 403 responses.
A real worker pilot may therefore have an external dependency despite HTTP 200 health.
Keep that requirement explicit rather than replacing it with a mock success.

## Regression cases required before signing activation

| Area | Regression evidence |
| --- | --- |
| Ownership | Cross-avatar binding, task, attempt, receipt, and reservation references fail at the database boundary |
| Addresses | Mixed case normalizes; active address cannot bind twice; retirement cannot enable historical task theft |
| Challenge | Wrong avatar, domain, purpose, address, chain, message, expiry, or signature fails |
| Replay | Two processes consume one challenge concurrently; exactly one binding succeeds |
| Identity | Expired, rotated, unbound, and non-ledger agent sessions cannot mutate private records |
| Attribution | Delayed old hire after retirement stays with its original avatar |
| Task uniqueness | Repeated hire logs and changed manifest hashes cannot create another task row |
| Reorg | Orphaned hire suspends execution; canonical replay preserves ownership and receipt uniqueness |
| Leases | Old worker cannot renew, store output, upload, sign, or settle after another generation acquires the lease |
| Signing | Duplicate operation returns the same durable transaction; arbitrary method, value, target, RPC, and mainnet fail |
| Crashes | Crash before signing, after signing acceptance, after capture, after broadcast, and before receipt persistence recover without another economic effect |
| Budgets | Concurrent calls, provider retries, restart, midnight, stale grant, approval mode, and uncertain charge cannot exceed authority |
| Isolation | A hostile brief cannot access host files, normal avatar memory, credentials, signer IPC, shell actions, or an unrestricted inference route |
| Recovery | Pause, drain, lease expiry, provider refusal, missed deadline, held exit, and refund failure remain distinct states |

## Scope limits

No durable schema or signer implementation exists in the reviewed design alone.
This report approves no migration or live money test.
The implementer must return the resulting schema and code for an independent review of these constraints.
