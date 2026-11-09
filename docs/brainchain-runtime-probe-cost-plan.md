# BrainChain runtime probe cost plan

Last Audited: 2026-11-09. Status: source review and implementation proposal only.
No staging account, reservation, signature, provider request, or credential access occurred for this review.

## Decision

No existing configuration enforces a root-reserved worst-case bound for the complete hosted runtime probe.
The existing root budget verifier, protected history, provider-specific caps, and envelope accounting provide the authority foundation.
The missing primitive is a **root-only reserved transport for runtime-probe embeddings**, with durable call records and fail-closed external-provider coverage.
The current task-execution proxy cannot serve this purpose unchanged.
It requires a real canonical BrainChain task, execution attempt, authority, generation, and lease.
Do not fabricate those records or weaken that fence to run a release probe.

The smallest useful next implementation is a BrainChain-only lane.
It preserves actual Eliza runtime installation, chat composition, autonomous decisions, and a private workers action receipt.
It excludes unrelated Nori, appearance, canary-claim cognition, Hermes, and optional echo work from this new mode.
Legacy modes and the separate required onboarding checks remain available and explicit.
The source currently still runs those inherited flows; this simplification is a proposal, not implemented behavior.

The existing user authorization covers the separate cumulative 10 USD OpenAI and 10 USD OpenRouter caps.
No new user approval is required.
Root must issue a concrete reservation under the current protected job history before actual provider dispatch.
This document creates neither a reservation nor a new budget owner.

## Verified request paths

| Trigger | Exact source path and function | Present bound | Missing budget property |
| --- | --- | --- | --- |
| Protocol installation on runtime start | `apps/api/src/services/agent-orchestrator.ts`, `injectProtocolKnowledgeIntoRuntime`; `packages/agent-runtime/src/eliza-runtime.ts`, `injectProtocolKnowledge` | Source section list; runtime-state checks | Embeds each section before deterministic memory creation. Memory deduplication does not itself avoid another embedding request on another start. No cumulative root gate. |
| Building canary and BrainChain installation | `apps/api/src/services/building-skill-install.ts`, installer phase 2 and `dependencies.embed` | Per-agent content hash, section tracking, install locks, global install slot | Calls `embedText` for missing sections. Concurrency control is not a money cap. |
| Standalone embedding | `packages/agent-runtime/src/plugins/embed-text.ts`, `embedText` / `embedTexts` | Fixed OpenAI URL, model `text-embedding-3-small`, dimension 1536; 30-second fetch signal | No reservation, request quota, input-token cap, durable usage, or uncertain-charge record. `embedTexts` starts a parallel call per item. |
| Eliza embedding model | `packages/agent-runtime/src/plugins/openai-embedding-provider.ts`, `createOpenAIEmbeddingPlugin` / `embed` | Same fixed URL/model/dimension; boot null input uses a zero vector without a provider request | Real-input fetch has no explicit timeout in this function and no root budget gate. |
| Chat knowledge retrieval | `packages/agent-runtime/src/providers/knowledge.ts`, knowledge provider | One query embedding is reused across its building/protocol searches; top-k retrieval is bounded | The query embedding still calls standalone `embedText`. Retrieval count does not bound all background calls. |
| Runtime lesson/book retrieval and teacher corpus | `packages/agent-runtime/src/eliza-runtime.ts`, `recordEarnedSkillMemory`, `searchEarnedSkillMemories`, `searchBookKnowledgeMemories`, `injectTeacherCorpusKnowledge` | Local query and result limits; some caller soft deadlines | Standalone embedding remains outside root accounting. A caller timeout need not stop a provider request. |
| Autonomous knowledge and decision turns | `apps/api/src/services/agent-autonomy-driver.ts`, earned/book knowledge retrieval and `runtimeDecideFn`; `ElizaRuntime.decide` | Decision output cap, driver timeout, normal decision cadence | Embedding work can outlive a soft read deadline. Cadence and a wait timeout do not enforce cumulative spend or a run-wide call count. |
| Fixture text generation | `packages/agent-runtime/src/plugins/openclaw-provider.ts`, gateway handlers; probe `startDeclaredGatewayMock` | Fixture gateway handles TEXT_SMALL/TEXT_LARGE; mock replies contain only a fixed marker or safe read | Does not intercept embedding endpoints, teacher runtimes, or every external runtime integration. Unexpected paid fallback must be refused explicitly. |
| Ordinary text generation | `packages/agent-runtime/src/plugins/openai-text-provider.ts`, `generate`; `packages/agent-runtime/src/inference/inference-router.ts`, `generateText` / `callEndpoint` | Output token option, endpoint timeout, circuit breaker | Endpoint failover can dispatch another request. Usage counters are process-local and record successful responses, not a durable reserve-before-dispatch cap. |
| Nori legacy action | `apps/api/src/services/system-agent-chat.ts`, `runtime.processMessage`; orchestrator system-agent runtime | Conversational response cap and existing gameplay limits | Separate teacher runtime, retrieval, generation, and memory can invoke providers outside the fixture gateway. CT reward caps are not inference caps. Exclude from the BrainChain-only lane. |
| Moderation around chat | `apps/api/src/services/moderation-service.ts`, OpenAI backend | Fixed `/v1/moderations` model and timeout; source describes it as free | Still an external request. No new price guarantee is inferred here. Preserve an explicit endpoint/model allowlist and request quota, or refuse unsupported configuration. |
| Hermes legacy lane | Probe `runHermesLane` and repository mock | Local subprocess, loopback proxy, fixed mock response | This lane does not establish any bound for other runtime providers. Exclude from the smaller lane. |

`ElizaRuntime.processMessage` selects a conversational token cap or a 1000-token response cap.
`ElizaRuntime.decide` defaults to 220 output tokens; the driver supplies its own decision cap.
These are request controls, not a verified complete spend envelope.
The installed Eliza/plugin SQL paths can also request embeddings during memory persistence.
The TEXT_EMBEDDING handler must therefore share the same transport as standalone embedding calls.
Any auxiliary model or network request outside the allowlist must fail the probe rather than use house credentials silently.

## Existing controls that cannot substitute

1. **InferenceRouter configuration:** route lists choose endpoints and allow failover. They do not carry a root reservation or durable cumulative cap.
2. **Own AI settings:** `apps/api/src/services/own-ai.ts` and the own-AI plugin reserve estimated per-avatar daily usage. They can fall back to ClawVille inference. Their day boundary, scope, estimate, and fallback differ from the root job cap. Do not reuse them as proof of this bound.
3. **Declared gateway:** its priority controls fixture text model calls. The embedding providers explicitly remain separate.
4. **Runtime timeouts:** a request can reach the provider before a timeout. Preserve the maximum liability after an uncertain response.
5. **Root reservation alone:** it protects cumulative allocation, but does not intercept a direct embedding fetch. Both authority and dispatch coverage are required.
6. **Existing durable task proxy:** `apps/api/src/services/brainchain/inference-proxy.ts` reserves against `brainchain_compute_budgets` and envelopes, then checks real task authority. Its call table has task/attempt foreign keys and one call per attempt. Those are intentional constraints.
7. **Existing reserved OpenAI adapter:** `apps/api/src/services/brainchain/openai-provider.ts` supports one pinned text model and request shape. It does not implement the embedding response contract. Do not change its model or fake an embedding as a text call.

## Proposed smallest lane

1. Keep strict staging URL, environment, catalog marker, unique fixture IDs, and mandatory cleanup.
2. Keep the unique canary database row only for the API/database pairing check. Do not claim or chat about that skill in BrainChain mode.
3. Install the actual BrainChain curriculum. Preserve the runtime's actual protocol installation and vector storage.
4. Verify source/served hashes and every agent-scoped stored section with the existing assertions.
5. Make one focused BrainChain founder-chat request. Verify the source payment paragraphs in provider context, outside history/user echo.
6. Start only the fixture's autonomous mode. Capture full source curriculum and the finite action menu on its real decide wire.
7. Emit one workers read through the mock. Capture its actual private, unexpired receipt on a later decide request.
8. Stop autonomy, stop the runtime, disconnect, and verify cleanup.

Do not run the inherited Nori or appearance blocks in this mode.
Do not remove the separate onboarding release checks or claim this lane verifies human wallet approval.
The fixture session remains agent_exchange, not a real password-login session.

## Concrete limits for root review

The following limits are proposed pilot policy, not measured requirements:

| Limit | Proposed setting | Enforcement point |
| --- | --- | --- |
| Run lifetime | 15 minutes, one immutable run ID | Parent watchdog plus dispatch deadline; stop autonomy on expiry |
| Runtime starts | At most two fixture starts | Trusted probe lifecycle accounting; each start consumes the protocol embedding allowance again |
| Founder chat | One BrainChain turn | Parent sequence and server transport request classification |
| Decision generations | At most eight, all mock-only | Mock request quota; no cloud text fallback |
| Workers actions | Exactly one | Existing one-shot mock action and receipt assertion |
| Embedding calls | `2*P + B + 32` maximum | Durable transport counter before each HTTP dispatch |
| Embedding input | Exact source section bytes, or a bounded query/message input | Frozen model-specific token/byte policy before dispatch |
| Provider attempts | One per admitted call, no automatic retry | Single-use dispatch row and transport |
| Embedding request time | At most 30 seconds, bounded by remaining run time | DNS/headers/body deadline and abort; ignore late completion |
| OpenRouter requests | Zero for this lane | No OpenRouter allocation/adapter; refuse that provider |

`P` is the actual number of protocol sections from the pinned source and API base.
`B` is the actual number of BrainChain curriculum sections.
The extra 32 requests cover query and persistence embeddings; they are an explicit ceiling, not an assertion about hidden core behavior.
Preflight must derive `P`, `B`, exact source hashes, and maximum source section sizes from the reviewed build.
If any request exceeds the reviewed model input bound, refuse the run. Do not truncate stored knowledge to make the probe pass.
If the call ceiling proves insufficient, fail the gate and review the observed call classes before increasing the reserved batch.

For each permitted embedding input `i`, reserve:

```text
maximum_i = ceil((verified_token_bound_i * input_microUSD_per_million) / 1_000_000) + reviewed_request_fee
batch_maximum = sum(maximum_i for every permitted call slot)
```

Use a reviewed model/tokenizer/billing policy. Do not assume a character-count/4 estimate is a worst-case bound.
Do not copy the existing text adapter's prices or framing allowance into an embedding policy.
This review adds no embedding price or provider billing guarantee.
Root must verify that policy before it can publish a numeric reservation.
The batch maximum must fit the current signed OpenAI reservation and the existing cumulative provider head.
All earlier spend, active allocations, and uncertain allocations still count across restarts.
The OpenRouter allowance remains separate and unused; it cannot supplement the OpenAI cap.

## Narrow missing transport and accounting seam

Reuse `SignedRootComputeBudgetAuthority`, the protected root head/history, existing job/provider budget rows, and envelope approval.
`DurableInferenceProxy.approveEnvelope` itself does not require a fabricated task, but its dispatch methods correctly do.
Add a root-only probe dispatch record with a probe identity instead of worker-task foreign keys.
Use the **same** provider budget/envelope locks and counters. Do not create a second independent 10 USD pool.

A minimal immutable call record needs run ID, call ID, envelope ID, provider/model/pricing version, exact input hash, token bound, maximum cost, state, timestamps, and bounded usage evidence.
Persist reserved state before dispatch. Commit single-use dispatched state before the HTTP request.
After any possibly transmitted error, keep the maximum as uncertain. Do not refund automatically or retry after restart.
Restart resumes reconciliation; it cannot reset the run's call slots or reuse dispatched call IDs.
Root publication/release reconciliation must inspect these records alongside existing compute calls.
Current `reconcileRootComputeDocument` reads only `brainchain_compute_calls`; it must not release a probe envelope while separate probe calls remain unresolved.

An internal transport can expose a narrow `embedExact` operation.
Its authority comes from a trusted root manifest, never a request body, character customization, agent tool, environment URL, or model output.
The manifest binds the existing stable job, run ID, fixture user/avatar/platform-agent IDs, envelope, hashes, limits, and expiry.
Preallocate the fixture IDs in that manifest. The current probe generates them internally, so this is one required probe adaptation.
Only the dedicated root staging bootstrap registers that immutable scope.

Required transport consumers are:

- Standalone `embedText` / `embedTexts`, including building installation and query retrieval.
- `createOpenAIEmbeddingPlugin`, including real-input Eliza calls.
- `ElizaRuntime` protocol/corpus/lesson/knowledge embedding calls and its provider context.

Pass the trusted transport through server-owned runtime configuration or a private runtime registry.
The building installer resolves it from the already-proven target platform agent.
Do not add a caller-controlled endpoint or key field.
Keep production defaults and fixed model/dimension/endpoint pins unchanged.
Do not mutate a shared teacher runtime or a global fetch function to make this probe cheap.
The smaller lane removes the need to attach this scope to Nori.

An unexpected cloud text path must refuse before its provider fetch.
The fixture's declared mock gateway stays the real text model handler for the actual Eliza runtime.
The probe must not substitute a fake runtime, fake stored curriculum, or fake workers receipt.
Inspect auxiliary provider coverage before activation; a transport that covers only the obvious install call is insufficient.

## Proposed file ownership for a later implementation

| Responsibility | Candidate source seam |
| --- | --- |
| Root-only probe call accounting | New module beside `apps/api/src/services/brainchain/inference-proxy.ts`; additive schema/migration coordinated with the database owner |
| Shared release reconciliation | Narrow addition to `apps/api/src/services/brainchain/root-compute-store.ts` |
| Fixed embedding request/response adapter | New reserved embedding adapter beside `openai-provider.ts` |
| Trusted runtime transport plumbing | `packages/agent-runtime/src/plugins/embed-text.ts`, `openai-embedding-provider.ts`, `providers/knowledge.ts`, and `eliza-runtime.ts` |
| Root-only fixture scope registration | Narrow orchestrator/bootstrap seam; no public authority issuer |
| Installer context | Narrow target-agent transport lookup in `apps/api/src/services/building-skill-install.ts` |
| Probe-only branch and quotas | `apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts` and its dedicated helper |

These are proposed edits. No file in this table changed during this planning task.
The accountable owners must confirm the exact split before implementation.

## Verification before actual spend

Test real installed Eliza model calls and real memory storage through a controlled transport.
Test concurrent embedding requests against the same reserved envelope.
Test deadline expiry, root-head revocation, process crash after dispatch, restart, duplicate IDs, and delayed provider replies.
Test cumulative existing task spend plus probe spend under both provider caps.
Test that an unknown cloud request cannot bypass the transport or fall back to house funds.
Test that expiry and cleanup do not release uncertain cost.
Test that the BrainChain-specific hash, storage, chat, decide, action, and later-receipt assertions still execute.
Then obtain independent review of the complete dispatch coverage and accounting integration.

Root can reserve and run the actual staging lane after those code-level blockers close.
The present source/controlled-test evidence does not establish a safe numeric live reservation.
