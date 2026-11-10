# BrainChain restricted task cognition

Last Audited: 2026-11-09.

Drift note: The ordinary avatar runtime cannot safely serve as a restricted task runtime through an empty persona alone.
The explicit task profile now uses a separate capability path through actual Eliza core.

## Scope and authority

This module executes one bounded text generation through real Eliza `AgentRuntime.initialize()` and `useModel(TEXT_SMALL)`.
It does not start a worker, reserve money, sign a transaction, upload a result, or submit work.
The trusted coordinator supplies the immutable task binding and the proxy transport.
The task brief supplies neither authority nor an endpoint.
Provider errors terminate the attempt without fallback or retry.

The runtime restricts capabilities inside the process.
It does not establish filesystem, network, environment, or operating-system isolation.
An audited OS sandbox remains mandatory before hostile task execution.
Unit tests use a controlled proxy and do not call a paid model.

## Required clean entry

OS workers must import `@clawville/agent-runtime/isolated-task`.
This package subpath imports only the restricted modules, Node built-ins, and Eliza core.
It does not import avatar templates, SQL, gameplay actions, platform inference, embeddings, or ordinary knowledge providers.
The ordinary package entry retains its existing import behavior.
Its gameplay dependency can load the database package and dotenv outside production.
Therefore the ordinary package entry is unsuitable for the isolated OS worker.

Both package entries share one restricted implementation.
The ordinary `createElizaRuntime` factory also accepts the explicit restricted discriminant for trusted internal callers.
Its absent profile and explicit `avatar` profile retain the existing wrapper and character construction.
Direct `ElizaRuntime` construction rejects other profiles.

## Configuration contract

The restricted factory accepts exactly one outer property, `executionProfile`.
That profile accepts exactly `kind`, `binding`, `brief`, and `proxy`.
Its kind equals `isolated-task`.
Unknown keys and conflicting avatar configuration fail closed.
The runtime never accepts a caller character, plugin list, database URL, API key, gateway, or own-AI fallback.

The binding contains these fields:

| Field | Constraint |
| --- | --- |
| `jobId`, `avatarId`, `taskId`, `attemptId`, `reservationId`, `callId` | UUID strings from the trusted coordinator |
| `generation` | Positive safe integer |
| `model` | Fixed reviewed model identifier, at most 128 characters |
| `promptHash` | Lowercase SHA-256 of the exact UTF-8 prompt bytes |
| `maxInputTokens` | Positive integer, at most 131072 |
| `maxOutputTokens` | Positive integer, at most 8192 |
| `deadlineMs` | Absolute Unix milliseconds, no more than 120 seconds ahead |

The coordinator constructs the prompt through `buildIsolatedTaskPrompt(brief)` before it reserves the approved call.
It hashes those exact bytes through `isolatedTaskPromptHash(prompt)`.
The runtime reconstructs the prompt and refuses a different hash.
It copies and freezes the binding before initialization.
Later changes to the caller's configuration cannot alter dispatch authority.

The brief and complete prompt each have a 32768-byte UTF-8 limit.
The complete prompt's byte count must also fit the input-token allowance.
This conservative local guard does not establish provider pricing or billed-token semantics.
The proxy must verify its approved tokenizer, model limits, and worst-case reservation.

## Eliza capability inventory

Each factory call generates a fresh runtime UUID, separate from the avatar identifier.
The module constructs an internal character without avatar biography, knowledge, secrets, plugins, advanced planning, or advanced memory.
It passes the actual core `InMemoryDatabaseAdapter` to the actual core runtime.
This adapter contains task-local process state only.
Durable task state and frozen outputs remain in the trusted coordinator.

The runtime sets these constructor flags:

```typescript
disableBasicCapabilities: true
enableExtendedCapabilities: false
enableAutonomy: false
actionPlanning: false
llmMode: 'DEFAULT'
```

After initialization, the module verifies the actual inventory before dispatch.
Only core's empty `bootstrap` plugin and `clawville-isolated-task-proxy` may exist.
Exactly one `TEXT_SMALL` model handler may exist.
Actions, context providers, evaluators, services, routes, embedding models, and character plugins must remain absent.
The module also supplies a fetch function that refuses direct runtime network access.
The proxy transport owns the separate, approved inference channel.
This function does not replace OS network controls.

The module never changes global runtime state or process environment.
Normal SQL migration flags, initialization mutexes, and provider priority remain unchanged.

## Proxy boundary and lifecycle

The proxy implements `generate({binding,prompt}, signal)`.
The request contains the frozen binding and exact internal prompt only.
The runtime checks expiry immediately before its one dispatch.
An execute guard rejects concurrent or repeated calls before asynchronous initialization.
The proxy must atomically enforce durable call identity, current execution generation, and the parent budget reservation.
The runtime itself does not replace that durable authority.

The response must repeat the approved call ID, model, and prompt hash.
It must include nonempty text and integer input/output usage within the approved ceilings.
The output has a 32768-byte UTF-8 limit.
The runtime returns the exact text without whitespace changes.
Model-produced action tags remain ordinary text and never enter an action dispatcher.

Expiry aborts the proxy signal and rejects the result.
An abort does not establish that a provider call costs nothing.
The coordinator must retain uncertain reservation liability until reconciliation.
The module stops the core runtime and closes its adapter after success or failure.
It exposes only a frozen inventory snapshot, bounded result, and stop operation.
It exposes no core runtime, database adapter, or action API.

## Evidence and release gates

The runtime tests execute actual core initialization and `useModel` through a controlled proxy.
They verify capability inventory, expiry, single dispatch, immutable authority, malformed output, and terminal provider failures.
They verify that hostile action text never dispatches.
The import test starts a child process with canary dotenv files and rejects platform module imports or network calls.
It checks the environment before and after the actual built package-subpath import.
Run the package build before this import test.
Ordinary avatar tests preserve character, history, and action behavior.

Source files:

- `packages/agent-runtime/src/isolated-task/index.ts`
- `packages/agent-runtime/src/isolated-task/types.ts`
- `packages/agent-runtime/src/isolated-task/profile.ts`
- `packages/agent-runtime/src/isolated-task/runtime.ts`
- `packages/agent-runtime/src/isolated-task/runtime.test.ts`
- `packages/agent-runtime/src/isolated-task/import.test.ts`
- `packages/agent-runtime/src/eliza-runtime.profile.test.ts`

## Clean child process and parent channel

The clean child entry is `packages/agent-runtime/src/isolated-task/process-entry.ts`.
The root bundles this entry for the audited OS container.
It imports the same restricted runtime implementation and executes actual Eliza core.
It reads no provider key, capability token, signer reference, or database URL.
The parent retains the one-use proxy capability and all budget authority.
The child receives only the approved binding and bounded task text.

The channel uses UTF-8 JSON lines with protocol version 1.
Each encoded frame permits at most 262144 bytes before its newline.
The runtime's separate 32768-byte prompt and output limits still apply.
The reader rejects malformed UTF-8, malformed JSON, unknown frame fields, and oversized data.
The first frame must arrive within five seconds.
All later operations use the binding's absolute deadline.
Writes and response waits have deadline bounds.

| Direction | Frame |
| --- | --- |
| Parent to child | `{type:'initialize',version:1,binding,brief}` |
| Child to parent, once | `{type:'generate',version:1,request:{binding,prompt}}` |
| Parent to child | `{type:'generated',version:1,response:{callId,model,promptHash,text,inputTokens,outputTokens}}` |
| Parent refusal | `{type:'refused',version:1,code:'budget_refused'}`; other fixed refusal codes remain in the frame type |
| Parent cancellation | `{type:'cancel',version:1}` |
| Child result | `{type:'result',version:1,result:{runtimeId,binding,text,inputTokens,outputTokens}}` |
| Child refusal | `{type:'error',version:1,code:<fixed sanitized code>}` |

The table shows TypeScript object notation; actual channel frames use JSON with double-quoted property names.
The parent validates the child request through the durable proxy and its retained capability.
It must not treat a child-supplied binding or result as fresh authority.
A refusal, cancellation, invalid response, or expiry produces no second generation request.
The child exits with code 0 after its result or code 1 after refusal.
It emits no raw exception, provider error, or secret value.
Controlled child tests verify empty stderr for their success and refusal cases.

The clean package entry exports `TaskFrameReader`, `encodeTaskFrame`, and the input/output frame types for the trusted parent.
The process runner does not register a network listener or launch a container.
Tests start actual local child processes with a minimal environment and controlled parent responses.
Those processes share the test user's OS identity and do not establish sandbox isolation.
The root separately verifies Linux container identity, mounts, environment, network restrictions, and process limits.

Root recorded a controlled Linux-container run at 2026-11-09T14:57:37.676Z.
Evidence: `docs/research/brainchain-2026-11-09/isolated-process-container-evidence.json`.
The actual bundled Eliza child returned one generation frame, preserved exact result text, and exited 0.
The container used UID 10002, network `none`, a read-only root filesystem, dropped capabilities, and no-new-privileges.
Its only mount was the read-only worker bundle.
The run used a pinned Bun image, a 256 MiB memory limit, a 64-process limit, and one CPU.
Its environment contained four runtime names and no provider or signer key.
The Docker host reported unsupported swap limits; the evidence does not establish a swap limit.
This controlled parent fixture used no paid provider and proves no BrainChain hire, grade, or settlement.
Hostile-task and production adapter verification remain separate gates.

## Trusted parent and fixed container adapter

`packages/agent-runtime/src/isolated-task/parent.ts` implements the parent channel without a command or endpoint selector.
It validates and freezes the approved binding and rebuilds the exact prompt before it sends initialization.
It accepts one exact generation request and calls the trusted parent proxy once.
It never sends the opaque capability or provider credentials to the child.
It rejects altered bindings, counterfeit success, duplicate generation requests, altered text, and altered token counts.

The parent requires the child to close stdout and exit 0 before it releases output.
The parent terminates the owned child and closes its streams before final confirmation.
The deadline and cancellation signal remain active throughout cleanup.
It then requests a fresh durable receipt with the current task fence.
Expiry or revocation during cleanup prevents output release.
That receipt must match the original proxy response exactly.
The returned text and token usage come from the confirmed proxy response, not the child declaration.
Cancellation aborts the proxy signal and terminates the owned process.
This cancellation does not release an uncertain charge.
The parent counts at most 4096 stderr bytes and never returns raw stderr contents.
Its process deadline and cleanup timeout bound waits for a stalled child.

`apps/api/src/services/brainchain/isolated-process-coordinator.ts` supplies the fixed Docker launch adapter.
It registers no public route and accepts no task-supplied command, image, environment, or mount list.
The trusted deployment supplies one absolute bundle path and its reviewed SHA-256 hash.
The adapter rejects symlink files and oversized or hash-mismatched bundles.
Linux bundle files must not permit group or other writes.
The deployment must protect the bundle and its parent directory from untrusted writers.
Windows deployments require equivalent protected artifact ACLs; a mode-bit check cannot establish Windows ACL safety.

The adapter uses `/usr/bin/docker` on Linux.
Windows uses the fixed system WSL executable and the fixed Ubuntu-24.04 distribution.
The Docker endpoint is the local Unix socket.
The adapter checks Docker client version 29.1.3 and refuses a different version.
The image is pinned to the digest in `BRAINCHAIN_COGNITION_IMAGE`.
Image pulls remain disabled.
The container uses UID 10002, network `none`, a read-only root, dropped capabilities, no-new-privileges, and IPC `none`.
It mounts only the worker bundle, read-only, and disables Docker log storage.
It fixes CPU, memory, process count, file-descriptor, and core-dump limits.
The host's earlier swap-limit warning still applies; a requested swap flag does not establish kernel support.

The adapter inspects the actual container before proxy dispatch.
It checks the pinned image, entry, arguments, mount, identity, environment names, network, privileges, logging, and resource fields.
Cleanup selects only the generated container name.
It never prunes Docker or modifies another container.
An unexpected cleanup failure refuses the result.

Controlled tests execute the actual parent, pinned container, and Eliza child.
A combined PostgreSQL fixture also uses the actual execution admission, reserve, dispatch, settlement, and fresh status path.
Its provider adapter returns controlled text and usage without a provider request.
This evidence proves the process-to-durable-receipt seam and no paid provider or BrainChain settlement.

## Durable budget and provider authority

`apps/api/src/services/brainchain/inference-proxy.ts` implements the trusted internal proxy service.
`apps/api/src/services/brainchain/inference-policy.ts` defines integer price calculations and trusted policy validation.
`packages/database/src/schema/brainchain-compute.ts` defines its accounting records.
Migration `packages/database/migrations/0104_brainchain_compute_reservations.sql` creates those records without changing recovery authority.
The service registers no public HTTP route and reads no provider credential or environment variable.

The root supplies a PostgreSQL connection, reviewed price policies, fixed provider adapters, and a root-budget verifier.
No default paid model or provider adapter exists.
Each provider adapter must disable SDK retries and provider fallback.
The adapter must enforce billed output limits, including reasoning tokens.
Unknown token or price semantics refuse policy admission.

The root-budget verifier confirms an existing sealed reservation in the root ledger.
It checks the stable job identifier, provider, reservation identifier, amount, expiry, and approval reference.
The proxy cannot approve an envelope without that verifier.
The verifier must not create another independent budget owner.
The root retains the external ledger hold until explicit reconciliation.
Unit-test verifiers represent fixture authority only and allocate no actual budget.

### Durable records and arithmetic

The provider budget uses a stable job UUID and separate `openai` and `openrouter` rows.
Each row has a fixed 10000000 micro-USD cap.
The database retains its allocation across process restarts and calendar boundaries.
Root envelopes allocate from that cap under a provider-budget row lock.
Concurrent envelopes cannot exceed the cap.
The root reservation identifier is globally unique.
An identical envelope approval returns its existing identifier; changed approval fields refuse.

Each envelope tracks reserved, uncertain, and settled amounts separately.
Their sum cannot exceed the envelope limit.
An allocation remains against the provider budget until the root closes the envelope.
Closure requires zero reserved and uncertain liabilities.
It returns the unused amount and a durable reconciliation identifier.
The root reconciles that identifier against its original ledger reservation separately.
Repeated closure returns the same reconciliation identifier without another release.

Each call records an immutable attempt, generation, lease owner, model, pricing version, prompt, prompt hash, token ceilings, deadline, and rates.
Each attempt permits only one call record.
Each call has a separate reservation UUID and a random 256-bit bearer capability.
Only the capability hash enters PostgreSQL.
The service returns the capability once through its trusted coordinator interface.
It never prints or places that capability in task output.

The maximum charge equals rounded-up input cost plus rounded-up output cost plus any fixed request charge.
Every amount uses integer micro-USD.
The model policy adds explicit reviewed `inputOverheadTokens` to the UTF-8 byte ceiling for prompt text.
That overhead covers all provider message framing, system wrappers, and other input outside the prompt.
The reservation refuses a token allowance that omits this overhead.
The call freezes the overhead and checks it again before dispatch.
The output ceiling includes billed reasoning tokens.
The root must review the actual provider's model, pricing version, tokenizer assumptions, and reasoning semantics before enabling a paid adapter.

### Coordinator and cognition interfaces

The trusted coordinator calls `approveEnvelope` only after the root ledger contains the sealed reservation.
It calls `reserve` with envelope, avatar, task, attempt, lease owner, generation, reviewed model/version, exact prompt, token limits, and deadline.
The result contains the immutable `IsolatedTaskBinding` and its one-use capability.
The binding's `reservationId` identifies the call reservation; the envelope separately records the parent root reservation.
The coordinator supplies `service.client(capability)` as the restricted runtime's proxy transport.
An OS worker instead uses the same contract over an audited narrow parent channel.
This implementation does not establish that OS transport boundary.

`dispatch` validates the exact request shape and copies its bounded prompt and binding before asynchronous work.
It compares every binding field with the durable call record.
It refuses an alternate prompt, model, avatar, task, attempt, generation, reservation, token ceiling, or deadline.
No request supplies a provider URL or credential.

The proxy locks the task row before it locks the provider budget, envelope, and call.
It requires a canonical testnet hire with execution purpose, executing state, current generation, matching lease owner, and sufficient deadline margin.
It checks database wall time again after lock waits.
A recovery lease cannot reserve or dispatch computation.
Execution admission requires the separately reviewed coordinator migration and authority path.

The admission transaction changes `reserved` to `dispatched` once and moves the full maximum into uncertain liability.
Only after that transaction commits does the adapter receive its one bounded request.
A replay reads the existing call state and never dispatches again.
The service aborts the adapter signal at expiry and rejects late output.
The restricted runtime also retains its own independent deadline guard.

Missing usage, a provider error, a transport error, malformed output, cancellation, or timeout retains the full uncertain hold.
No automatic retry, alternative model, or fallback provider occurs.
Known bounded usage permits settlement against the frozen price version.
Charge accounting survives a lost task lease, but the proxy withholds output from a stale generation.
Output in a provider receipt does not freeze or submit an on-chain task result.

The short-lived capability permits status lookup before expiry.
Root recovery uses `inspectCall` after expiry and receives accounting fields without task output.
Only undispatched calls can use `cancelReserved` to release a reservation without charge evidence.
Root reconciliation can use `settleFullCost` to charge the conservative maximum for an uncertain outcome.
The service provides no unsupported zero-cost release for an uncertain call.

### Evidence boundaries

Provider-free PostgreSQL fixtures verify simultaneous envelope caps, root reservation replay, immutable approval fields, restart persistence, and expiry after a lock wait.
Dispatch fixtures use the actual execution-admission function and exact root-authority records.
They verify one adapter invocation under replay, recovery refusal, framing allowance, unknown-charge holds, revocation, stale output refusal, and timeout abort.
Pure tests verify integer rounding and refusal of unknown billing assumptions.
These tests use the existing isolated local fixture and create no real root reservation.
Successful fixture dispatch is not evidence of a paid provider call or a completed BrainChain task.

Remaining external gates include the production root-ledger verifier, reviewed paid provider adapters, OS sandbox evidence, signer custody review, and an actual testnet task.
No test result establishes successful hiring, grading, settlement, or mainnet support.

PARITY: this internal runtime grants no human or agent economy action; future Office controls must use the same bound-avatar authorization.


## Root authority at dispatch admission

Last Audited: 2026-11-09.
Drift note: Provider dispatch now rechecks the root reservation after database lock waits and after the dispatch commit.

The proxy captures the trusted verifier method at construction.
New dispatch requires that authority; an absent authority refuses dispatch.
Controlled fixtures supply an explicit no-charge authority.
They do not demonstrate production root authorization.

The first check follows task, provider budget, envelope, and call locks.
It uses the stored immutable job, provider, root reservation, approval reference, limit, and expiry.
After the check, the proxy rechecks the execution fence and database clock before it commits liability.
A refusal before that commit leaves the call reserved and preserves its hold.

The commit moves the full maximum cost into uncertainty before any provider invocation.
A second root check follows that commit.
A final database transaction follows that root read before adapter invocation.
It rechecks execution authority, generation, worker pause state, lease, call state, envelope state, and database time.
Cancellation and deadline checks also precede adapter invocation.
Root reads have a two-second maximum and cannot extend the call deadline.
Late source responses cannot authorize a provider invocation.
The read source itself remains responsible for resource cancellation after a timeout.

A refusal, timeout, or cancellation after commit leaves the call uncertain.
The proxy makes no provider invocation and does not release that liability automatically.
A replay observes accounting and cannot invoke the adapter again.
Root reconciliation remains necessary before any release.
Root release must reconcile the actual local envelope before another consumer reuses the allocation.

These checks do not create an atomic transaction across the protected root store, PostgreSQL, and the provider.
Revocation after the final successful root check can race the provider invocation.
A root update cannot undo a provider request that already starts.
The root checks reject changes visible at either root check; they do not promise instantaneous revocation.
The final database check rejects execution changes committed during the last root read.
A database change after the final transaction can still race provider invocation.
No database lock remains held during the provider request.
Existing output and liability remain subject to the task fence and accounting rules.

The PostgreSQL fixture suite covers signed advanced-head revocation, lock waits, source hangs, expiry, missing authority, preserved holds, and one-shot replay.
The combined fixture also executes the actual Eliza child inside the pinned network-none container with a controlled no-charge provider.
No production root key, signed root document, reservation, or paid call exists from these tests.

The final execution regression covers revocation, generation loss, pause, and actual execution-authority expiry during the asynchronous root read.
The independent revocation probe observes zero provider calls and a retained uncertain hold.


## Root-only bounded trial

Last Audited: 2026-11-09.
Drift note: Adds protected Linux root-head/history provisioning and a private bounded trial coordinator.

The protected store and trial contracts appear in docs/brainchain-root-budget.md.
The store uses the reviewed signature/history verifier with bounded protected file reads.
Root publishes already signed documents through the exclusive, flush-before-rename publisher.
Actual database envelope/call accounting gates release and settlement.
No signing helper, live reservation, provider credential discovery, or public budget issuer exists.

The trial requires a fresh real testnet hire and the existing exact execution authority before root supplies an adapter.
It limits the reviewed OpenAI request to 4096 input tokens and 256 output tokens, for a maximum 13312 micro-USD.
It uses the actual admission, proxy, container, Eliza runtime, and durable receipt paths.
A protected journal makes restart inspection possible without automatic model retries.
It performs no BrainChain upload, task-result signature, or on-chain submission.
A positive paid run remains unverified until root authorizes and executes it.

The Linux crash/restart tests use ephemeral documents and controlled accounting fixtures.
They do not prove a real hire, paid inference, BrainChain result acceptance, or settlement.
All existing root-store/provider/database race limitations remain in force.

T1/T2 correction: preflight requires zero payee before submit and strictly decodes all four WorkerHired topics.
The contract-shaped positive fixture exercises actual chain parsing, authority checks, signed-root verification, and protected journal creation without credentials.
It proves admission reachability through controlled transports, not a live hire or paid execution.

### Explicit worker host - 2026-11-09

The worker coordinator connects existing durable services one stage per invocation. It creates no budget or authority.
Run bun apps/api/scripts/brainchain/run-worker.ts --trusted-config <absolute module> --request <absolute JSON>.
The trusted module exports createWorkerRuntime with separate runtime/lock pools and approved compute/signer resources.
The CLI constructs the fixed bound-worker observer. Frozen results prevent compute reruns; unknown effects require evidence.
No scheduler or credential discovery exists. Autonomous owner-policy issuance remains a required next scope.
PARITY: this internal host entry does not replace bound-avatar human and agent controls.


### Explicit autonomous host composition (2026-11-09)

Last Audited: 2026-11-09. Drift: the bounded worker scheduler now composes the existing isolated runtime through the mandatory owner compute fence. Activation remains false.

The host entry is `apps/api/scripts/brainchain/run-worker-scheduler.ts`. Trusted configuration supplies the existing root reservation, restricted process bundle and protected signer adapters. The entry fixes the testnet observer and transport itself. It accepts an explicit worker, tick count and interval. It never discovers credentials or starts from the API boot path. Finite status output excludes task prompts and model output.

Worker-issued execution authorities cannot dispatch through a root-only proxy. The final consumer requires the current immutable assignment, policy, execution generation, lease and deadline. A frozen result prevents another compute run. Unknown provider usage retains the reserved liability. Drain permits already admitted work but refuses new execution authority. Pause and revoke require separate exact-result recovery consent; they never restore provider scope.

PARITY: human Office controls and bound hosted/MCP controls select the same durable worker state. Live human wallet proof remains required for monetary grants. Independent review and a configured host run remain release evidence gaps.
