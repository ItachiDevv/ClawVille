# BrainChain probe runtime injection design

Last audited: 2026-11-09. Source review only. No runtime configuration or paid authority exists from this document.

## Boundary and traps

The API process must hydrate authority before runtime creation. A probe-process registry cannot configure another process. The durable marker must distinguish marked fixture identities from ordinary players even when their active run disappears. Missing configuration must refuse, never select the house provider. Historical budget identity fields must survive fixture disposal without restrictive or cascading identity foreign keys. These scalar identifiers establish history, not present authorization.

The marker records immutable run/user/avatar/platform-agent/runtime-agent identifiers and manifest digest. Keep a unique historical marker after identity disposal. Every lookup also resolves the current canonical identity tuple. A missing or changed tuple refuses. Never recreate a deleted identity from historical identifiers. Run state, calls and root history remain durable. In-memory caches provide no authority.

Existing protocol injection catches embedding errors and skips sections. A scoped runtime must record a terminal run failure on admission or transport refusal. Stored-section and fresh-wire assertions must still fail. Never satisfy the probe with JSONB fallback, zero vectors for real text, truncation or an old section hash.

## Minimal file map

| File | Proposed narrow change |
| --- | --- |
| apps/api/src/services/agent-orchestrator.ts | Resolve trusted scope from canonical identity before createElizaRuntime and runtime.start. Marked fixtures bypass own-AI credential loading and normal house-key configuration. Pass scope explicitly. Reconstruct on every restart. |
| apps/api/src/services/brainchain/probe-runtime-scope.ts (new) | Server-only marker lookup, canonical tuple checks and scope hydration from reviewed durable budget service and deployment pins. No public registration route. |
| packages/agent-runtime/src/eliza-runtime.ts | Optional internal probe scope. Validate before initialization, key-to-env code, plugin loading and protocol injection. Route each direct embedding call through one instance helper. Preserve normal runtime behavior. |
| packages/agent-runtime/src/plugins/embed-text.ts | Optional explicit trusted transport context for scoped callers; unchanged ordinary callers. No global registry or process-wide fetch patch. embedTexts admits each string separately. |
| packages/agent-runtime/src/plugins/openai-embedding-provider.ts | Scoped TEXT_EMBEDDING handler invokes the transport. Null/empty initialization probe stays local. No API-key fallback in scoped mode. |
| packages/agent-runtime/src/providers/knowledge.ts | Provider factory captures the scope for query embedding. Keep the ordinary exported provider for normal runtimes. Resolve no authority from prompt text or model settings. |
| apps/api/src/services/building-skill-install.ts | After canonical target resolution, hydrate the same scope before getRuntime or dependency embedding. Bind source class to the resolved building, not request-selected authority. Preserve install locks and exact section storage. |
| packages/agent-runtime/src/index.ts | Export narrow trusted types only where the API needs them. Never export credential references through a shared DTO. |
| apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts | Accept only preallocated fixture identifiers through the reviewed server bootstrap contract. Verify exact durable identity association before connect. No root/provider parameters in API requests. Stop admission before runtime disposal. |

New schema and transport files belong to the budget owner. They include durable identity markers, run/call admission, immutable manifest, root checks and retained accounting. This map does not reserve migration numbers or prescribe a second ledger.

## Trusted configuration and startup order

Root bootstrap preallocates every fixture identifier and records the marker before connect. It verifies the source commit, staging database marker, manual and curriculum hashes, splitter counts and manifest digest. The API receives server-owned job/public-key/genesis pins, protected head/history access and a temporary credential reference. The probe supplies no key, endpoint, reservation or authority field.

On every creation, resolve canonical user/avatar/platform agent, query the persistent marker, and verify the exact immutable run. For marked identities, absent configuration or expired/stopped authority refuses before any ordinary provider initialization. Construct TrustedProbeRuntimeScope locally. Only its host transport holds the credential. Pass its embedding closure and current-run assertion into the runtime before start. Repeat current authority at actual durable admission and dispatch, not merely at hydration.

After Eliza initializes, assert the actual model-handler inventory. Allow only scoped TEXT_EMBEDDING and controlled mock-gateway TEXT_SMALL/TEXT_LARGE. Do not register the router text plugin or own-AI plugin in this profile. Reject additional model handlers, including bootstrap/plugin handlers which could reach a provider. Verify the exact gateway against the bootstrap-owned loopback configuration; user agent configuration cannot expand it.

## House-key and fallback consumers

agent-orchestrator.ts currently passes process.env.OPENAI_API_KEY to createElizaRuntime. eliza-runtime.ts can copy a supplied key into process.env.OPENAI_API_KEY. Scoped initialization must avoid both operations without changing the environment for other runtimes.

openai-embedding-provider.ts and embed-text.ts use a supplied key or process.env.OPENAI_API_KEY. Both require explicit scoped branches. Runtime direct embedding consumers include earned-skill persistence, earned-skill search, book search, teacher corpus replacement and protocol injection. knowledge.ts embeds retrieval queries independently. building-skill-install.ts defaults dependencies.embed to standalone embedText. Cover all these consumers before activation.

openai-text-provider.ts delegates to InferenceRouter. own-ai-provider.ts retains router fallback handlers. A higher-priority gateway alone does not establish refusal for these paths. Omit those plugins for the scoped profile. Inspect actual installed Eliza bootstrap handlers after initialize and refuse unapproved handlers. Do not alter normal avatar provider priorities.

## Lifetime, restart and cleanup

Use the earlier of the immutable run deadline and remaining eight-minute sequence budget. Reserve at least thirty seconds before the ten-minute root expiry for disposal. No restart resets quotas, creates a new run or renews root authority. Every background embedding inherits the same scope. Late responses cannot publish accepted vectors after expiry. Missing settled vectors do not authorize redispatch.

Stop durable paid admission first. Then disable autonomy, stop the runtime, disconnect the body and verify absence. Remove live identity rows only after disposal succeeds. Preserve marker, run, calls, reservations and unresolved liabilities. Root removes the temporary secret separately. Reconciliation works without that secret.

The current probe deliberately excludes sequence cancellation from cleanup HTTP requests. postAutonomy(false) passes respectProbeAbort=false. Runtime-stop, signed disconnect challenge/disconnect and body-absence reads also pass false. Each retains its own request timeout. This permits cleanup after the sequence controller aborts. Database cleanup has its own checks; it does not use the sequence signal. Current cleanup stops the mock gateway first and has no durable budget-run stop primitive yet. Add that stop before other disposal once the budget contract exists. Do not interpret successful local disposal as billing reconciliation.

## Controlled verification before staging

1. Initialize actual Eliza with a controlled transport and no provider credentials. Assert null dimension probing makes no transport call.
2. Exercise protocol injection, BrainChain installation, query retrieval, earned memory and corpus embeddings. Assert every call carries the exact scope and source class.
3. Make house fetch, router fallback and own-AI fallback fail the test if invoked. Exercise unknown model types and gateway failure.
4. Test marked identities with missing configuration, stopped runs, expiry and canonical identity mismatch. Assert refusal occurs before plugin initialization or house-key reads.
5. Recreate the orchestrator against the retained marker/run. Assert counters and request identities do not reset.
6. Defer an embedding, stop the run, then resolve it. Assert no accepted late vector, fallback or repeat dispatch.
7. Test cleanup after sequence abort. Assert disposal requests remain available while paid admission stays stopped.
8. Verify fixture identity disposal leaves accounting and markers intact. Verify historical identifiers cannot authorize another runtime.

Use mocked host transport and the actual core model path. Local adapter results establish integration behavior only. They do not establish provider settlement, staging consumption or human wallet approval.

PARITY: the release probe uses the real bound agent path. Its agent_exchange fixture does not prove human password login or wallet consent.

## Independent review corrections: initialization and external entry points

This section supersedes the earlier post-initialize-only inventory check. The inventory check remains a diagnostic, not the security boundary.

Before calling initialize, construct a per-instance dispatch guard on the actual core runtime. Its useModel boundary permits only the reviewed embedding handler and the exact controlled gateway text handlers. Its registration boundary rejects additional model handlers before plugin init hooks execute. Validate the complete constructor plugin/character-plugin list before core registration. Do not import caller-selected plugins. Bootstrap initialization can register handlers or invoke models; test those actual installed-core paths. If the installed core prevents an instance-only guard before hooks, refuse initialization until a reviewed constructor/subclass seam establishes that guard. Never substitute a global prototype patch or a check after initialization.

The guard must cover direct handler callbacks exposed to plugin initialization as well as useModel. Only source-reviewed SQL/core initialization hooks and scoped handler objects may execute. Unknown hooks refuse. Keep SQL initialization and genuine Eliza behavior; do not stub initialize. Root implementation review must verify the installed core ordering and the guarded handler references before activation.

Add these exact files to the proposed runtime map:

| File | Additional narrow seam |
| --- | --- |
| apps/api/src/services/hosted-agent-knowledge.ts | Resolve marked target before the default standalone embed dependency can execute. For this five-stage probe, refuse unrelated book/building-visit sync for marked fixtures. No marker means existing behavior. |
| packages/agent-runtime/src/plugins/clawville-plugin.ts | Create an instance plugin/provider collection for scoped runtimes. Preserve the exported ordinary singleton. |
| packages/agent-runtime/src/providers/index.ts | Expose a scoped provider factory if required. Replace only the knowledge provider in the new array. Never mutate allProviders. |
| packages/agent-runtime/src/plugins/openclaw-provider.ts | Scoped gateway handler pins loopback scheme/host/port/path, rejects redirects, bounds response bytes and parsing, and shares run deadline and decision quota. No provider fallback. |

eliza-runtime.ts currently reads clawvillePlugin.providers during prompt composition. Scoped composition must use its instance collection consistently, including fresh chat and later decide consumption. Changing only core registration would leave standalone knowledge retrieval outside the scope.

### Minimal denial outside the five stages

A marked fixture may only install the reviewed BrainChain curriculum, read knowledge/status/workers, perform its founder agent-gateway chat, and execute the safe workers action through the hosted decision path. Retain required connect, heartbeat, autonomy/directive and disposal operations. Registration/bootstrap owns this allowlist; model text and HTTP bodies cannot expand it.

Refuse unsupported marked-fixture actions before dispatch and before external helpers. In particular, deny items /learn and other hosted knowledge mutations, location/system/expert chat, Nori, appearance, arbitrary building installs, and economy actions. Location chat calls moderateText outside runtime plugins. Do not bypass moderation for normal users or invoke a teacher to test denial. Add an exact marked-fixture gate at the common authenticated identity/action boundary where possible; otherwise add small guards at the specific external-call entry points. The implementation must enumerate its final route/action guard files for approval. A runtime-only model guard cannot protect unrelated API moderation requests.

Read-only status/workers actions remain actual service calls. The founder chat must use the existing agent-gateway processMessage path. The separate human onboarding test remains required; these restrictions do not redesign ordinary product authority.

Stable embedding request identifiers and source classes originate in trusted runtime/installer contexts. Use run/start identity plus a durable per-operation identifier and section/query/memory context. Restart must not replay a completed logical call as a new request. The ledger owner defines uniqueness and retained results. Never derive source class, call quota or authority from model-selected fields.

### Correct cleanup order

Replace the existing gateway-first ordering for the new scoped mode. First stop durable admission. Next disable autonomy and stop the runtime. Disconnect and verify absence before stopping the mock gateway. Then remove live fixture records while retaining marker and accounting. Gateway shutdown still runs in a final disposal block if another step fails. Never delete fixtures when stop or disconnect remains unverified. The new mode rejects --keep; legacy keep behavior remains separate. Failure must retain evidence and liabilities, while finally still closes local servers and database clients.

The existing cleanup HTTP requests intentionally ignore sequence cancellation. Their request timeouts remain necessary. This does not authorize continued model or embedding dispatch. Durable stopped state must block those calls while disposal requests run.

### Additional controlled tests

- Have a constructor/bootstrap/plugin init hook attempt an unapproved model call. Assert refusal before any transport or house provider access.
- Have an init hook attempt handler replacement and invoke a retained unapproved callback. Assert refusal.
- Initialize a scoped runtime beside an ordinary runtime. Assert provider arrays and ordinary handlers remain unchanged.
- Call hosted-agent-knowledge and unsupported chat/moderation routes as the marked fixture. Assert denial before embedding or moderation fetch.
- Return a redirect, oversized body, malformed JSON or late response from the controlled gateway. Assert failure without external follow-up or fallback.
- Record cleanup ordering after sequence failure and deferred calls. Assert durable stop precedes runtime disposal and gateway closure follows disposal attempts.

## Ledger owner contract checkpoint

The budget owner currently proposes ProbeEmbeddingBudget.lookup(platformAgentId), returning null only when no persistent marker exists. A marker without a run refuses. Otherwise it returns manifest, manifestHash, state and expiresAt across all run states. The service also exposes start(runId, signal), assertCurrent(runId, signal), embedExact(runId, request) and stop(runId). Its trusted identity callback receives the existing transaction, avoiding nested base-pool reads. These files remain under budget-owner review; bind runtime imports only after their source freeze.

The runtime hydrator captures runId in its closure and exposes only the narrow transport. It must not treat lookup success as live admission. It checks the current canonical tuple, state and deadline before initialization, then uses the service's current checks on every admitted operation. Historical marker lookup remains available after identity cleanup.
