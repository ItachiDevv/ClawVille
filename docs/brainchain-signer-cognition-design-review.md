# BrainChain testnet signer and isolated cognition design

Last Audited: 2026-11-09. Team: brainchain-office. Role: independent design reconciler.
Scope: implementable design, source inspection, and constraints. No signer or runtime process starts during this review.

## Disposition

Implement the next increments separately: durable signer operations, restricted Eliza cognition, then an actual testnet pilot.
Keep the current recovery lease insufficient for signing or model execution.
The present runtime cannot provide the required isolation through configuration alone.
Its default providers and database initialization require a narrow, explicit restricted profile.
This design approves no mainnet action and does not claim successful hiring, grading, or settlement.

The latest job evidence reports 22 testnet hires stalled with Jev HTTP 403 at 14:00 UTC.
That dependency blocks a successful pilot, but it does not block implementation or deterministic tests.

## Source baseline

The reviewed worker version is 0.19.2, source commit `b71f3b24ddbda4fe31026dfa66fc23c12194c800`.
The official contract source snapshot is commit `0ba4bfc278c50fcc8ffcbaca3772120170946f24`.
Source inspection does not establish deployed bytecode equivalence.
Before signing, compare the reviewed deployment artifact and runtime code for each allowed contract.
Pin runtime code hashes and addresses; refuse an unexpected code or manifest change.

Sources:

- [Worker chain adapter](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/chain.ts)
- [Worker join and leave commands](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/cli.ts)
- [Worker result loop](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/work.ts)
- [Worker staking contract](https://github.com/usebrainchain/brainchain/blob/0ba4bfc278c50fcc8ffcbaca3772120170946f24/src/flywheel/WorkerStaking.sol)
- [Proposal bonds contract](https://github.com/usebrainchain/brainchain/blob/0ba4bfc278c50fcc8ffcbaca3772120170946f24/src/flywheel/ProposalBonds.sol)
- [Decision executor contract](https://github.com/usebrainchain/brainchain/blob/0ba4bfc278c50fcc8ffcbaca3772120170946f24/src/DecisionExecutor.sol)
- [Task board contract](https://github.com/usebrainchain/brainchain/blob/0ba4bfc278c50fcc8ffcbaca3772120170946f24/src/TaskBoard.sol)

## Contract lifecycle and signer allowlist

The signer supports only BrainChain testnet, chain ID 274630, through the fixed reviewed testnet RPC.
It checks the RPC chain ID at startup and before every signing acceptance.
It rejects all other chain IDs, mainnet bindings, supplied RPC URLs, and dynamic contract addresses.
No client flag can override this condition.
Every transaction has native value zero and an explicit gas-cost ceiling.

The testnet snapshot reports 500 BRAIN minimum stake, 100 BRAIN application bond, and a 7,200-second executor timelock.
Read current terms before preparation; refuse changed terms outside the approved test-token authorization.
Do not copy these figures to mainnet or hard-code them as permanent protocol rules.

| Operation | Exact allowed call | Additional signer checks |
| --- | --- | --- |
| Test BRAIN claim | Pinned BRAIN `faucet()` | Dedicated testnet wallet; inspect faucet interval and balance first |
| Stake allowance | Pinned BRAIN `approve(staking, amount)` | Only the pinned staking spender; exact approved increment, no unlimited allowance |
| Application allowance | Pinned BRAIN `approve(bonds, amount)` | Only the pinned bonds spender; exact current authorized bond |
| Stake | Pinned staking `stake(uint128 amount,uint128 price)` | Recorded amount and price; recheck balance, allowance, minimum, and authorization |
| Apply | Pinned bonds `propose(address target,bytes data,string uri)` | Target is the pinned board; data is exactly `setWorkerAllowed(signerAddress,true)`; profile is bounded canonical data URI |
| Deliver | Pinned board `submit(uint256 task,bytes32 hash,string uri)` | Owned canonical hire, current execution fence, frozen output hash, accepted service URI, valid deadline |
| Leave | Pinned staking `requestUnstake(uint128 amount)` | Explicit drain authority; amount equals recorded current stake; preserve all outstanding tasks |
| Withdraw test stake | Pinned staking `withdraw()` | Unstaking balance exists, cooldown elapsed, held count zero; verify receipt and same-wallet token return |

These calls form the first signer policy. They do not constitute general transaction signing.
Do not add `setPrice` merely because the CLI exposes it; initial stake already specifies the approved price.
Do not permit arbitrary proposals, direct board administration, approvals to other spenders, token transfers, credit, disputes, or appeals.
Use distinct authorization records for stake, application bond, gas, and compute.

The CLI skips an existing application and checks vetoes before proposing.
Its profile limits are 60 UTF-16 units for name and 500 for description.
It requires a nonempty application profile and preserves an existing worker price unless explicitly changed.
The ClawVille planner needs the same duplicate-application checks before it reserves another bond.

### Activation and application recovery

An application does not directly activate a worker.
Observe its proposal, decision, queued change, and eventual `workerAllowed(address)` state separately.
Executor `execute(uint256 changeId)` runs a queued call after its ETA and before its grace deadline, unless vetoed.
The first signer can leave execution to the official service while showing the exact queued state.

If activation recovery becomes necessary, add a separately reviewed `activate-own-worker` operation.
It must load the queued change and require its target and calldata to match this worker's exact application.
It must check ETA, grace period, executed state, and function veto before accepting the operation.
Never expose generic executor access through a change ID alone.

Proposal settlement returns an adopted bond or burns a rejected bond.
A proposal with no decision can expire after its deadline, but a timely decision prevents that expiry path.
Later `settle(id,decisionId)` and `expire(id)` recovery methods must constrain the proposal to the owned application.
Do not automatically reapply after rejection or timeout; a fresh bond needs fresh authority.

### Delivery and settlement

The task board accepts submission from its hired worker while the task remains Hired and its deadline permits submission.
It records the result hash and transitions to Submitted.
Grades and dispute windows precede settlement; an upload or successful submit receipt is not income.
The service normally drives grading and finalization.
The first signer does not need a general `finalize` method.

A later recovery increment can allow finalization for an owned task only.
It must derive the applicable deadline from that task's state and stored windows, then simulate the call.
Paid and Refunded are different terminal outcomes.
Verify the board event and token transfer, recipient, amount, transaction status, and canonical block before recording income.
The board can direct payouts through its configured payout mechanism; never assume the worker address is the actual recipient.

### Leaving does not discard existing work

`requestUnstake` moves stake out of the active amount and starts the cooldown.
Staking eligibility requires registration and sufficient active stake; board permission is an additional condition.
Withdrawing requires both cooldown expiry and zero held tasks.
The board still permits delivery from an inactive worker for work already assigned to it.
Therefore drain means: request unstaking, verify lost eligibility, preserve accepted work, deliver, await settlement, then withdraw.
Local pause alone provides none of these on-chain guarantees.

## The result signature is a separate authority

Use a dedicated typed operation `authorize-result-upload`; never expose generic `signMessage`.
The signer loads the frozen result bytes through a trusted output reference and computes their Keccak-256 hash.
It signs only this exact EIP-191 message, with normalized board address and decimal task ID:

```text
BrainChain result v2
chain 274630
board <lowercase pinned task board>
task <owned on-chain task id>
hash <keccak256 of exact UTF-8 result bytes>
```

The trusted delivery adapter posts `{task,text,signature}` to the fixed testnet `/results` endpoint.
It requires the returned hash to equal the signed bytes and the URI to remain on the official service origin.
It persists the response before preparing the board submission.
The official loop caps results at 100,000 bytes and avoids new computation within 300 seconds of the deadline.
The first ClawVille text pilot can impose a smaller output cap and a shorter compute deadline.
It must never modify whitespace, encoding, or text after freezing the signed hash.

The upload signature has no protocol expiry field.
After release, assume the service or a recipient can replay those same authorized bytes.
Lease expiry cannot revoke that signature; recovery must retain the frozen output and upload operation.
Do not generate a second conflicting output while its upload or transaction outcome remains uncertain.

## Durable signing acceptance

Use a dedicated testnet key per pilot avatar, outside the API and cognition process.
Store only an opaque signer reference in application records.
An external-wallet association does not authorize custody or permit a hosted signer to impersonate that wallet.
Provision and prove the dedicated testnet address under the existing avatar binding rules before any application operation.

Add signer operations after the read/index/recovery schema passes its separate audit.
Suggested records are `brainchain_signer_operations`, `brainchain_signed_transactions`, and `brainchain_compute_reservations`.
Allocate the migration number only after checking the backend owner's current migrations.

Each signer operation needs:

- Immutable avatar, binding, chain, manifest/code identity, operation kind, authorization ID, and canonical request hash.
- Task and attempt foreign keys where applicable, with composite owner constraints and immutable output identity.
- An idempotency key scoped to binding and operation; changed bytes produce conflict, not another attempt.
- Execution generation, authorized amount, gas ceiling, deadline, and state.
- Signing acceptance time, transaction nonce/hash, and a protected signed-payload reference where applicable.

The signer accepts only an operation ID over authenticated internal IPC.
It loads every transaction field from durable records and its reviewed policy.
It never accepts arbitrary calldata, a private key, or a replacement RPC from HTTP callers or model output.

Use one lock order: binding, task/attempt, signer-address nonce, then operation.
Lease acquisition, orphan suspension, and signer acceptance must share the task lock and generation checks.
Check expiry with `clock_timestamp()` after lock acquisition.
The current recovery lease purpose remains explicitly rejected.

Reserve nonce ownership under a durable unique `(chain_id,signer_address,nonce)` constraint.
Compare canonical and pending RPC nonces with all accepted local operations.
An unexplained externally used nonce is a reconciliation stop, not permission to select a new nonce silently.
Do not use the dedicated signer key outside this service.

Persist the exact transaction fields and reserved nonce before signing.
Persist signed bytes, their derived hash, and acceptance before broadcast or return to the caller.
Keep signed bytes in protected signer storage, not application logs, task memories, or public operation responses.
If the signer crashes before payload persistence, it can re-sign the identical reserved transaction after revalidation.
If payload persistence exists, recovery uses those exact bytes and hash.

Once signing acceptance commits, the operation survives task lease expiry.
A new worker generation can reconcile that accepted operation but cannot replace its economic intent.
A generation change before signing acceptance must reject the old worker.
This distinction closes the gap between revocable work ownership and an irrevocable signed authorization.

| Crash point | Recovery rule |
| --- | --- |
| Before acceptance | Recheck authority and current fence; no transaction exists |
| Nonce reserved, payload absent | Revalidate and sign the identical intent; never allocate a second nonce for that operation |
| Signed payload persisted, broadcast absent | Reconcile receipt and pending nonce, then broadcast the same bytes if appropriate |
| Broadcast timeout | Keep gas and operation liability; query the original hash and nonce |
| Receipt exists, local state stale | Verify and persist the receipt once |
| RPC reports nonce consumed without known receipt | Stop new signing for that nonce stream and investigate |
| Reorg after receipt | Mark evidence noncanonical; preserve ownership and accepted transaction history |

For the first pilot, prohibit automatic gas replacement and nonce cancellation.
Later replacement policy must retain the same nonce, intent, recipient, value, and calldata, with a separate bounded fee authorization.
Never copy the official CLI's post-broadcast hash callback as the durable signing boundary.

## Restricted Eliza runtime profile

Local code confirms that `ElizaRuntime.start()` creates a SQL adapter and can copy an OpenAI key into process environment.
`loadPlugins()` always installs platform text and embedding providers.
The own-AI provider falls back to the platform router on limits and provider errors.
Using a different agent ID or empty prompt does not remove these capabilities.

Add a discriminated internal profile to `ElizaRuntimeConfig`, for example `executionProfile: {kind:'isolated-task', ...}`.
This profile is not an HTTP setting and cannot come from the task brief.
Keep the ordinary avatar path unchanged.
Reject incompatible options rather than ignoring them: database URLs, API keys, own-AI, gateway overrides, customization knowledge, and arbitrary plugins.

The restricted branch still constructs the real Eliza `AgentRuntime` through `createElizaRuntime`.
It uses the real model execution path, for example the existing `decide()` method and `useModel(TEXT_SMALL)`.
It does not substitute a direct model call for Eliza.

Use these restricted choices:

1. Construct an internal task character with no imported avatar biography, memories, actions, advanced planning, or advanced memory.
2. Give each attempt a new task runtime UUID, separate from the avatar and any prior task.
3. Use Eliza core's actual `InMemoryDatabaseAdapter` as the per-attempt task store.
4. Keep durable task state and frozen outputs outside cognition, in the trusted coordinator's database and output store.
5. Do not load plugin-sql, normal providers, ordinary character plugins, or teacher/protocol memory injectors in this branch.
6. Set the installed core's `disableBasicCapabilities:true`, `enableExtendedCapabilities:false`, `enableAutonomy:false`, and `actionPlanning:false`.
7. Register exactly one text provider that calls the restricted inference proxy.
8. Register no embedding provider for the initial single-shot text path.
9. Assert the initialized model/action/provider inventory before accepting task input.
10. Stop the runtime after its bounded result and discard its in-memory task store.

The installed core exports the in-memory adapter and skips embedding setup when no embedding model exists.
These are actual core features, not stub implementations.
Keep the normal SQL lifecycle, migration flag, and provider settings untouched for ordinary runtimes.
If later retrieval requires embeddings, add a proxy operation with its own reservation before enabling them.

The restricted plugin must return provider errors to the task coordinator.
It must never call own-AI or the global inference router as fallback.
Fail the task on a missing proxy, unsupported model type, empty answer, budget refusal, or expired capability.
Model-produced action tags are ordinary output text; no action dispatcher consumes them.

## Actual process isolation

A process with a different name but the same unrestricted desktop user is not a sandbox.
The implementation must prove filesystem, identity, environment, and network restrictions before sending hostile task text to a model.
No new host is chosen by this design; follow the existing-host capacity and ownership audit before deployment.

For the initial text worker, use an audited restricted container or an equivalent isolated OS account and sandbox.
Mount only its immutable runtime bundle and an empty bounded task scratch directory.
Mount no desktop profile, repository checkout, keyring, avatar store, Docker socket, or signer socket.
Use a read-only root filesystem, no extra capabilities, bounded CPU/memory/process count, and an execution deadline.
Use a minimal environment allowlist; omit all inherited provider keys, database URLs, wallet keys, and proxy credentials unrelated to this task.

The only permitted network destination is the inference proxy through a task-scoped channel.
The process cannot reach the game API, RPC, result service, metadata addresses, or the signer.
The trusted coordinator fetches brief bytes through its bounded SSRF-safe reader and verifies their hash before delivery.
The cognition process receives text and typed task metadata, not a URL to fetch or a shell command.
Persist only bounded result bytes through a trusted parent channel; treat paths and instructions in output as untrusted text.

The root currently has process-launch lifecycle constraints and a queued Claude review.
That is an operational dependency, not permission to bypass the managed process workflow.
Do not claim sandbox verification from a unit test or merely stripped environment variables.

## Inference proxy and budget authority

Create a distinct internal proxy service with one fixed provider and model per approved reservation.
The proxy owns provider credentials; cognition receives only a short-lived capability for one attempt.
The capability binds job, avatar, task, attempt, generation, model, prompt hash, token ceilings, expiry, and reservation ID.
It permits one bounded generation and status lookup, not arbitrary provider URLs or general API use.

The coordinator persists a call ID and reserves cost before proxy dispatch.
The proxy atomically changes that call from reserved to dispatched once.
If a response is lost, repeat requests query the same call state; they do not issue another provider request.
An explicit retry needs another reservation within the same job cap.
The proxy rechecks the task fence before dispatch, but an already dispatched call remains a liability after lease expiry.

The root owns job budget reservations.
The ledger's OpenAI and OpenRouter caps are separately 10,000,000 micro-USD each.
They span all agents, retries, and resumed sessions, without a daily reset.
Keep `settled + uncertain + reserved <= cap` under one durable budget-owner lock.
Do not let the worker silently become a second budget owner.

For this pilot, the root can allocate an explicit provider envelope to the proxy as an outstanding ledger reservation.
All proxy calls must remain within that envelope through atomic sub-reservations.
Unused allowance returns to the root only after reconciliation proves that no dispatched call remains uncertain.
The root cannot spend the same envelope concurrently on another task.
Database accounting and the root ledger must share one reservation ID and reconciliation record.

Use integer micro-USD and provider/model price versions.
Compute a conservative maximum from bounded input tokens, maximum billed output/reasoning tokens, and known request charges.
Do not treat characters divided by four as a worst-case token bound.
Use the model tokenizer where verified, or a conservative documented byte/token ceiling with provider limits.
Refuse paid dispatch when pricing or maximum billed token semantics remain unknown.

Timeout, transport failure, or missing usage data retains the full reservation.
A canceled request can still cost money.
Only provider evidence or conservative full-cost settlement can release an uncertain reservation.
Do not use the normal own-AI daily reservation/release behavior for this job.
No provider fallback, hidden retry, startup embedding, or platform-funded model call is permitted.

## File ownership and implementation sequence

All paths below are proposed unless they already exist. Allocate them with the lead before edits.

| Increment | Owner and proposed files | Required evidence |
| --- | --- | --- |
| 1. Durable signing records | Backend: additive database migration, schema extension, `apps/api/src/services/brainchain/signer-operations.ts` | Real PostgreSQL owner constraints, nonce uniqueness, generation races, idempotency conflicts |
| 2. Pure signer policy | Backend with auth/custody co-review: `apps/api/src/services/brainchain/signer-policy.ts` and tests | Exact ABI allowlist, nested proposal decode, manifest/code pins, unconditional mainnet rejection |
| 3. Isolated signer service | Backend/custody: dedicated internal service entry and protected storage adapter | Capture-before-broadcast crash matrix, no key exposure, method and destination refusal |
| 4. Restricted runtime | Runtime owner: `packages/agent-runtime/src/eliza-runtime.ts`, new restricted-task provider/profile module, runtime tests | Real Eliza initialization and useModel, no SQL/avatar reads, no embedding/default fallback, ordinary avatar regression |
| 5. Budget proxy | Backend plus inference owner: internal inference proxy and compute-reservation service | Concurrent caps, restart/midnight invariance, lost response, usage mismatch, price refusal |
| 6. Task coordinator | Backend: internal runner, delivery adapter, brief/output stores | Canonical hire only, execution-purpose lease, hostile input isolation, stale output rejection |
| 7. Testnet lifecycle | Backend plus UI/parity owners | Apply, actual allow decision, activation, hire, delivery, grade, settlement, drain and recovery receipts |

Update ARCHITECTURE, the Office documentation, protocol/action surfaces, and parity notes with their owning code increments.
Extend the existing typed human and agent operations; do not expose internal signer or inference endpoints as generic tools.
Keep recovery-only routes honest until actual execution authority exists.

## Mandatory independent tests

- Mainnet binding with testnet label, wrong RPC chain, changed contract code, and injected manifest all fail before signing.
- Proposal target, nested calldata, worker address, profile, spender, amount, price, and native value each reject unauthorized changes.
- A stale generation cannot reserve, compute, freeze output, authorize upload, or accept a transaction.
- A generation change after signing acceptance preserves the original operation for reconciliation.
- Concurrent operations cannot claim one nonce; an externally consumed nonce stops the stream.
- Every crash point above recovers without another economic intent or unrecorded provider call.
- Expiry tests hold database locks beyond the deadline; transaction-start time must not pass them.
- A result signature cannot sign another task, board, chain, output, or an arbitrary message.
- A malicious brief cannot read host files, avatar memory, environment secrets, signer IPC, shell tools, or blocked network destinations.
- Real restricted Eliza initialization makes no provider call; its one text execution reaches only the approved proxy.
- A proxy error never invokes default inference, own-AI, embeddings, or another provider.
- Simultaneous callers and retries cannot exceed the root's allocated envelope or either total job cap.
- Unknown provider outcomes retain liability after restart, midnight, task cancellation, and lease expiry.
- Partial upload and uncertain submit retain the exact output and original transaction identity.
- Drain prevents new local acquisition, verifies actual protocol ineligibility, and preserves in-flight work and stake recovery.

## Gates that remain external or unproved

The deployed-code match, dedicated testnet signer identity, sandbox controls, proxy budget envelope, and signer custody review require implementation evidence.
The existing head-minus-12 reader is provisional; it does not establish parent-chain finality.
Define and verify the confirmation policy before treating a testnet payment as final.
Jev's observed HTTP 403 failures can prevent application, hire, or grade progress.
Record exact failed stages and continue independent implementation; do not replace the pilot with synthetic success.
Mainnet funds, live credit, production promotion, and release visual acceptance remain outside this design approval.
