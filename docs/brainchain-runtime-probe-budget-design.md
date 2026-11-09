# BrainChain runtime probe budget boundary

Last Audited: 2026-11-09. Status: budget design reviewed; fixed provider adapter implemented and tested. Ledger/runtime integration and activation remain pending.

## Decision

Reuse the existing signed root reservation, provider budget row, and compute envelope. Add a small durable run record and a probe-call ledger beneath that envelope. Do not add another budget pool. Do not change task foreign keys, task leases, or the one-call-per-attempt invariant.

An existing protected reservation alone cannot enforce request quotas or prevent duplicate dispatch after restart. Its file journal stores signed budget revisions and reconciliation evidence, not atomic per-request transitions. Adding a second file-based dispatcher would duplicate PostgreSQL accounting and complicate concurrent runtime calls. Settling the entire reservation at its maximum remains a conservative recovery option, but does not replace dispatch coverage or durable quotas.

Keep this lane OpenAI embeddings only. OpenRouter allocation and dispatch remain zero. Actual Eliza runtime installation, vector storage, chat composition, decisions, and the private workers receipt remain part of the probe. Text model responses come only from the declared fixture gateway. Unsupported external providers fail before fetch.

## Verified couplings and traps

- The registry assigns ledger primitives to token-economy and runtime identity to agent-protocol-partner. Compose accounting in the caller transaction. Preserve canonical agent-to-avatar resolution.
- `brainchain_compute_calls` requires a real task, attempt, generation, lease, and positive output tokens. It cannot represent embeddings unchanged.
- `brainchain_compute_envelopes` already holds reserved, uncertain, and settled totals. Its root reservation is unique.
- `SignedRootComputeBudgetAuthority` enforces a ten-minute maximum document lifetime. Reservation expiry cannot exceed that document expiry and cannot change across revisions.
- `reconcileRootComputeDocument` currently reads only task calls. It must read both ledgers before accepting a protected root transition.
- `closeEnvelope` currently trusts envelope counters. The new close boundary must also verify both ledgers and forbid unresolved calls.
- The protected store uses a file lock, then provider budget locks, envelope locks, and task-call locks. New paths must preserve this order.
- Root store reconciliation currently calls `expires_at.getTime()` directly. The extension must normalize timestamps through `databaseDate` and test the actual retained Drizzle client.
- A timeout after committed dispatch does not prove zero cost. Retain the full maximum liability.
- Do not use an input-character estimate as a token guarantee. Reserve the full reviewed model token maximum per request; do not derive a cheaper bound from character counts.
- Do not patch global fetch, share a teacher runtime, or expose a caller-selected URL, provider, key, or price.

## Run duration: resolve ten versus fifteen minutes

Use an eight-minute maximum paid sequence, shortened to the existing reservation expiry. Reserve the remaining two minutes for local cleanup within the ten-minute root document. Set `run.expiresAt <= reservation.expiresAt <= currentDocument.expiresAt`. Start the run only after root publishes its reservation. The effective end is the earliest signed expiry, run expiry, and watchdog deadline. A request deadline is at most thirty seconds and never exceeds that end.

The earlier fifteen-minute proposal is not a spend window. Do not retain a fifteen-minute first-probe watchdog. The parent watchdog is at most ten minutes, with paid admission stopped by minute eight. Cleanup must not restart the runtime or invoke embeddings. If the paid phase cannot fit, stop and retain evidence. A later attempt needs a new run and a separate root reservation within the same cumulative job history. Never extend the old reservation or reset its counters.

## Immutable trusted manifest

Root prepares one canonical manifest before runtime creation. It contains:

- Stable job ID, unique run ID, envelope ID, root reservation ID, and approval reference.
- Exact staging API origin and deployment source commit; fixed OpenAI provider, embedding model, dimensions, input-token ceiling and pricing-policy digest.
- Preallocated fixture user, avatar, platform-agent and runtime-agent IDs; no guest fallback or identity supplied by model output.
- Protocol and BrainChain curriculum hashes, section counts P and B, permitted section input hashes and byte/token bounds.
- Query-input byte/token ceilings, input classification enum, call ceiling `2*P+B+32`, two runtime starts, one founder chat, eight mock decisions, and one workers read.
- Run start/end, per-call deadline, maximum run cost, maximum cost per input class, no automatic retries, and no paid text fallback.

The root reservation approval reference binds the manifest digest, for example `brainchain-probe:<sha256>`. The full digest is also stored in the run row. A server-owned registration verifies the manifest against the current root reservation and existing envelope. No HTTP caller can register or replace it. The run cannot move to another envelope or avatar. Run registration is unique by run ID and envelope ID. Each probe uses a dedicated envelope under the existing shared provider budget; this is allocation isolation, not another cap.

## Minimal additive database shape

`brainchain_probe_runs`: run ID primary key; unique envelope ID foreign key; manifest JSON and digest; job/provider/identity tuple; pricing digest; immutable start/end; max calls; admitted-call counter; start counter; state active/stopped/closed. Explicit checks constrain provider/model/dimensions, positive limits, timestamp order, and counters. Immutable guards protect scope and ceilings. Stop is monotonic. Restart attaches to the same row and remaining quota; it cannot create a replacement under the same reservation.

`brainchain_probe_calls`: call ID primary key; run ID and envelope ID with a composite ownership foreign key; unique `(run_id, request_id)`; manifest digest; source class; exact input SHA-256 and byte count; token bound; pricing version/rates; maximum microUSD; deadline; reserved/dispatched/uncertain/settled/canceled state; timestamps; provider request ID and bounded usage evidence; charged microUSD; optional durable vector result.

Do not store source text in telemetry. The trusted caller retains input until dispatch. Dispatch verifies its hash and exact length. A settled vector may be stored privately as exactly 1536 finite values with a response hash, so a repeated logical call can return its result without another provider call. If the result is absent, return evidence-unavailable; never dispatch it again. Call ID reuse with different input, scope, or limits refuses. Hash equality alone does not merge distinct legitimate calls.

State constraints mirror the existing task ledger: reserved/canceled have no dispatch timestamp; canceled has zero charge; dispatched/uncertain have maximum liability and no settled charge; settled has bounded usage and charge. All-or-none nullable fields use explicit NULL predicates. Original input, maximum, identity and dispatch timestamp are immutable. No DELETE-based quota recovery.

## Lock and dispatch protocol

All database mutation paths use one retained PostgreSQL pool and the supplied transaction. Lock order:

1. Provider budget rows ordered by provider when more than one is required.
2. Envelope rows ordered by ID.
3. Probe run rows ordered by ID.
4. Existing task-call rows ordered by ID, then probe-call rows ordered by ID, when reconciliation needs both.

A single probe operation follows budget -> envelope -> run -> probe call. It never takes task or execution locks. Existing task paths need no probe-run lock. Protected root publication retains its outer file lock and then the same database order. Runtime verification only reads the protected head/history; it never takes the publication file lock while holding database locks.

**Reserve:** validate immutable scope and input policy; acquire locks; check current root reservation with a caller-enforced two-second deadline; recheck run state and database clock after all awaits. Insert the call and increment run quota and envelope reserved cost atomically. Enforce `reserved + uncertain + settled + newMaximum <= envelope.limit`. The shared provider allocation already includes the full envelope. No additional provider allocation occurs per call. A canceled reservation still consumes its run quota, preventing replay from restoring attempts.

**Dispatch admission:** acquire the same locks; require the exact reserved call; repeat root and run checks; verify input hash, source class and deadline. Commit state dispatched and transfer its maximum from reserved to uncertain before any provider effect. Only this transaction's winning caller receives a private dispatch ticket. A retry that reads dispatched never receives another ticket.

**Final send:** the concrete adapter validates its fixed URL without redirects. It invokes the trusted ticket fence immediately before fetch. That fence repeats current root, run stop/identity and database-clock checks after all asynchronous work. Every callback has a caller-enforced deadline and cancellation; late results cannot authorize fetch. Preserve the existing distinction between a final authority check and impossible atomicity with an external provider. Root revocation can occur after the final check; the already committed maximum covers that in-flight request.

**Outcome:** valid bounded response and usage settle atomically under the same locks. Move the maximum out of uncertain and add actual reviewed charge to settled. A malformed, missing-usage, late, aborted, disconnected, or crashed request remains uncertain at its maximum. Response processing after deadline cannot publish an accepted vector. It may retain private evidence for reconciliation. No automatic retry, even after HTTP errors, without explicit provider proof and a separate reviewed call admission.

**Cancel:** only reserved calls can cancel and release reserved cost. Dispatch admission wins atomically over cancellation. A stopped run cancels undispatched calls and blocks future calls; it does not release dispatched liabilities.

**Reconcile:** status and evidence inspection work after expiry. Root-only reconciliation requires durable provider evidence tied to the exact request, or conservatively charges the maximum. It never treats local cancellation as proof of no charge. Late success may settle an uncertain row exactly once, but does not authorize another request or extend the run.

## Shared close and protected history

Extend the existing root reconciliation aggregate with probe-call states. Compare combined reserved/uncertain/settled totals exactly with envelope counters. Lock run and call rows in the order above. Unknown states, orphaned ownership, mixed manifest scope, or counter drift refuse publication.

Before close, require no reserved/dispatched/uncertain calls across either ledger. Check totals again inside the transaction. Close the envelope and release only `limit - settled`. Root then publishes a signed reconciliation revision through the existing protected store. A crash between local close and publication remains fail-closed; the original root reservation still holds its full allocation until publication. Do not allocate the apparent refund elsewhere first.

Renewing the current signed document for reconciliation does not extend the immutable expired reservation. History validation retains all prior spend and uncertainty. The separate OpenRouter cap cannot fund an OpenAI shortfall.

## Provider and injection contract

Proposed internal types, not public request schemas:

```ts
interface ProbeEmbeddingTransport {
  embedExact(input: {
    requestId: string;
    source: 'protocol' | 'brainchain' | 'query' | 'memory';
    text: string;
    signal: AbortSignal;
  }): Promise<{ vector: readonly number[]; callId: string; inputHash: string }>;
}
interface TrustedProbeRuntimeScope {
  runId: string;
  manifestHash: string;
  platformAgentId: string;
  runtimeAgentId: string;
  embeddings: ProbeEmbeddingTransport;
  assertRuntimeCurrent(signal: AbortSignal): Promise<void>;
}
```

The transport closure captures verified run, envelope, root authority, pricing, database and fixed provider adapter. Callers cannot choose these. Root's bootstrap registers the scope against exact fixture IDs before any Eliza runtime initialization. The orchestrator resolves it using canonical platform-agent identity. Runtime configuration passes it to standalone embedText/embedTexts, TEXT_EMBEDDING, knowledge queries and protocol/corpus/memory embeddings. Building installation resolves the same trusted scope from its already-proven target agent. A per-runtime registry survives only as an injection map; durable authority remains in PostgreSQL and protected root history.

The provider adapter accepts one exact UTF-8 string, pinned model and dimension1536, reviewed token maximum and absolute deadline. It sends one POST to the fixed OpenAI embeddings endpoint, rejects redirects, bounds response bytes and verifies one vector with index zero, finite elements, exact model, valid usage and bounded cost. Credential loading belongs only to the trusted adapter host. Neither runtime prompts nor agent tools receive the key or dispatch ticket.

Mock gateway text responses remain actual Eliza model-handler results. Every other paid handler and provider fallback refuses within this scope. Blank-input zero-vector behavior can remain local only if it matches existing semantics and reports no provider dispatch. Concurrent embedTexts calls each need their own durable request ID and admission. Stop/unregister occurs before normal cleanup; stale runtime references still fail against the stopped run row.

## Implementation split and verification gates

Proposed later ownership: budget owner implements run/call ledger, shared close and root reconciliation; runtime owner implements exact-agent injection and complete embedding/provider coverage; probe owner implements the BrainChain-only branch and quotas. This design changes only this document.

Before spend, require real PostgreSQL concurrency tests with the retained Drizzle client, protected-store Linux tests, and actual Eliza calls through a controlled embedding adapter. Cover cap races with existing task envelopes; duplicate logical IDs; crash before/after dispatch commit; stop and expiry behind locks; stalled root callbacks; wallet/agent rebind; late responses; restart with lost vector; and root publication after local close. Verify cleanup cannot erase uncertain cost. Verify external fallback cannot dispatch. Test the eight-minute paid deadline and ten-minute parent watchdog with zero paid calls after the earlier expiry.

Source counts, selected per-call buffer, and final batch maximum remain preflight inputs for independent review. This design does not create a reservation, invoke a provider, or establish staging runtime consumption evidence.

PARITY: this is an internal release-verification budget, not a new user spending feature. The probe continues to use the real bound agent and actual private workers receipt. Human and agent product authority paths remain unchanged.

## Root review clarification: cost and actual staging process

Root verified the official OpenAI model and pricing pages on 2026-11-09. The selected model costs USD0.02 per million input tokens, supports at most8192 input tokens, and returns1536 dimensions. Sources: https://developers.openai.com/api/docs/pricing, https://developers.openai.com/api/docs/models/text-embedding-3-small, https://developers.openai.com/api/reference/resources/embeddings/methods/create.

For the first probe, reserve the entire8192-token model allowance for every single-string request. Integer ceiling gives164 microUSD; propose200 microUSD per call as a conservative round-up. This avoids a new tokenizer dependency. Apply a conservative UTF-8 byte ceiling as an independent resource bound, not as a claim about token count. Oversized inputs refuse before dispatch; provider rejection still retains uncertainty unless billing evidence establishes charge. Returned prompt_tokens and total_tokens must be integers in0..8192 and match the accepted embedding usage contract. Report actual charge with ceiling rounding against the pinned rate. Usage above the model bound refuses the response and keeps the maximum liability. No live numeric allocation exists until root approves `200 * (2*P+B+32)` against retained history and verifies the selected request policy.

The probe process cannot register an API runtime through its own memory. Implement this concrete cross-process path:

1. Root's trusted staging bootstrap verifies the deployed commit, explicit staging database and preallocated fixture identities.
2. Bootstrap publishes the existing signed root reservation and creates the envelope and immutable run row through the dedicated internal service. It stores the manifest digest in both the reservation approval reference and run record.
3. Before any fixture connect/start, the staging API receives a server-owned probe configuration: stable job ID, root public-key/genesis pins, protected head/history read access, and a dedicated embedding credential reference. These values are deployment inputs, never probe request fields.
4. The dedicated credential is the user-authorized desktop GPT key transferred through an approved secret channel to a temporary, permission-restricted staging secret. The adapter opens that exact reference. It never falls back to the API's normal house OpenAI key. No key enters PostgreSQL, the manifest, the probe CLI arguments, logs, model settings or agent responses.
5. On runtime creation and installer lookup, the API resolves the canonical platform-agent/avatar/user tuple, then queries the durable run row and verifies the root reservation and manifest. It constructs a scoped transport locally in the API process. This happens before protocol embedding or plugin initialization.
6. All subsequent calls repeat durable run/root admission. Background calls use the same scope. API restart reconstructs scope from the immutable row and trusted deployment pins; it preserves counters and refuses expired/stopped runs. A fixture-marked identity with missing configuration or transport fails before any ordinary provider fallback.
7. Cleanup first stops paid admission in PostgreSQL, then stops/disconnects the fixture, verifies no runtime remains, and removes the dedicated secret through root deployment controls. Status and reconciliation need no provider credential. The probe process only observes receipts and orchestrates existing authenticated actions.

This requires actual staging API transport code and trusted deployment/bootstrap configuration. A probe-only script change cannot satisfy it. Production runtimes receive no probe scope. The staging secret provisioning is a later authorized action after implementation review; this document reads or transfers no credential.

Protected publication must not gain new runtime callbacks or a timeout race around filesystem mutations. Preserve its existing synchronous publication order under the file and database locks. Reconciliation only reads durable rows. A process crash before head rename retains the old head; a crash after rename requires inspection of the retained document and database state before another publication. No dispatcher interprets an uncertain publication as permission to retry or refund. The current store remains the sole publication authority.

## Offline preflight measurement

Root measured protocol127 with the actual section splitter: P=46 and B=11. The largest protocol section is24257 UTF-8 bytes; the largest curriculum section is3719 bytes. Evidence: `.brainchain-work/probe-section-count.json`. Thus the proposed ceiling is135 calls and27000 microUSD (USD0.027) at200 microUSD per call. These are proposed limits, not a reservation or provider result.

Before issuance, freeze the measured source commit, served manual hash, curriculum hash, splitter version and exact count evidence in the manifest. A mismatch refuses registration. Do not expand slots automatically. The byte lengths do not prove every section fits8192 tokens. Provider refusal must fail the consumption gate without truncating curriculum; a later review can authorize deterministic source-preserving splitting and a new measured manifest. The current plan does not claim that request acceptance has been verified.

## Provider implementation boundary and review clarifications

The separate fixed adapter exposes `embed(request, ticket, signal)`. Request fields are callId, input and absolute deadlineMs. The trusted ticket contains only assertCurrent(signal). The adapter consumes each ticket object once, even when its fence refuses. A later ledger must also enforce durable call-ID uniqueness; a new ticket object cannot replace ledger admission. Repeated adapter invocation with the same ticket refuses before fetch.

The implementation pins the endpoint, model,1536 finite vector elements, one string,32768 UTF-8 input bytes,131072 response bytes,8192 maximum tokens,200 microUSD reservation and20000 microUSD per million tokens. It permits at most30 seconds, shortened by the absolute deadline. It bounds both transport and body reads, refuses redirects, checks matching positive prompt/total usage, and performs final deadline/cancellation checks. Any failure after fetch invocation reports uncertain. No retry, credential lookup or fallback exists.

Fixture marking must persist independently of a currently active run lookup. The staging bootstrap records an immutable probe identity marker before connect. A marked identity with absent, stopped or expired scope refuses ordinary providers, including after restart. Historical user/avatar/platform-agent IDs remain scalar evidence in budget records. They have no cascading identity foreign keys and no restrictive identity foreign keys that prevent fixture cleanup. Run/envelope/call accounting foreign keys remain restrictive. Every live dispatch resolves the current canonical identity tuple; historical IDs cannot authorize a call after identity deletion or rebind.

The model-specific official page supports the price observation. Do not claim the generic pricing page independently exposed the embedding row. Offline counts and the USD0.027 proposal remain unissued.

Controlled adapter verification:19 tests and46 assertions passed. Tests cover request pins, arithmetic, UTF-8 limits, single-use ticket, final fence expiry/abort, invalid vectors/usage, redirects, oversized responses, stalled fetch/body and final response expiry. No provider request left the controlled transport. Independent adapter review and ledger composition remain required.

Independent review accepted the design and adapter scope. Adapter replay protection is per instance only. The durable ledger must prevent another adapter or process from obtaining a dispatch ticket for an already dispatched call. This remains a ledger gate, not an end-to-end approval.
