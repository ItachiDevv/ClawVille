# Probe runtime injection design review

Last Audited: 2026-11-09. Reviewer: identity_audit. Team: brainchain-office.
Status: corrected design approved for implementation entry; final implementation and runtime evidence remain pending.
No application changes, database mutations, provider requests, credentials, or index actions occurred.

## Accepted boundaries

The design correctly places scope hydration in the API process before runtime creation.
Persistent fixture marking remains independent of an active run lookup.
Current canonical identity checks prevent historical IDs from authorizing new effects.
The design preserves ordinary runtimes and avoids a global fetch patch or shared environment credential mutation.
It covers direct runtime embeddings, the Eliza embedding handler, building installation, and query retrieval.
Terminal probe failure on scoped embedding refusal prevents skipped sections from becoming apparent success.

## Required minimal corrections

| Finding | Source evidence | Required correction |
| --- | --- | --- |
| R1: post-initialize inventory is too late | Installed Eliza core initialize registers bootstrap and character plugins before completion. ElizaRuntime.start calls initialize before marking the runtime running. | Establish approved plugin and dispatch boundaries before constructor/init hooks. Audit installed handlers afterward as a second check. Test an init hook that attempts an unsupported model. |
| R2: standalone hosted knowledge path is absent | hosted-agent-knowledge.ts defaultDependencies uses embedText. items.ts /learn calls syncHostedAgentKnowledge after its database merge. | Add this service to the scope map or refuse unsupported marked-fixture actions before embedding. Resolve scope from the canonical platform agent, not user text. |
| R3: knowledge provider is a singleton | providers/index.ts places ordinary knowledgeProvider in allProviders. clawvillePlugin references that array. eliza-runtime.ts consumes clawvillePlugin.providers. | Construct the scoped provider list per runtime. Do not mutate allProviders or the shared plugin object. Prove ordinary runtime behavior remains separate. |
| R4: loopback URL alone does not bound the gateway | openclaw-provider.ts uses default redirect handling, multiple protocols, and unbounded response JSON. | Pin scoped gateway protocol/path, refuse redirects, bound response size, enforce run deadline and mock quota, and refuse fallback. Keep ordinary gateway behavior unchanged. |
| R5: cleanup stops gateway first | hosted-skill-runtime-probe.ts cleanup calls declaredMock.server.stop before autonomy/runtime disposal. | Stop durable paid admission, disable autonomy, stop runtime and disconnect, then stop the gateway. Preserve independent cleanup timeouts after sequence abort. Define failure and keep-mode behavior explicitly. |

The installed core useModel rejects an absent handler, but also accepts provider-specific model selection.
The scoped runtime must not retain an unapproved lower-priority handler that can be selected explicitly.
Core bootstrap initialization also needs review; a clean model list after initialization cannot undo an earlier request.
Advanced planning/memory and unexpected character plugins must not expand the scoped handler set.

## API and auxiliary operations

Founder chat uses the agent-gateway runtime path, which can use the scoped provider set.
Location chat and expert-consult routes call moderation outside runtime plugins.
A workers-only mock instruction does not prove that every possible marked-fixture action respects the paid boundary.
Use a narrow marked-fixture operation allowlist or explicit scoped transport coverage for unsupported paid paths.
Do not change ordinary product budgets to implement this release probe.
An unsupported marked-fixture paid action must refuse before provider work, including standalone embedding or moderation.

## Ledger interface constraints

The runtime receives a transport closure, not a key, envelope selector, price, endpoint, or public authority issuer.
Each embedding supplies a durable logical request ID, exact text, trusted source class, and cancellation signal.
The host closure captures the immutable run and identity scope and repeats current checks at actual admission and dispatch.
Concurrent strings require separate durable admissions. Restart cannot regenerate a fresh quota or redispatch an old logical call.
Blank initialization probes may return the existing local zero vector; nonempty text may not use that shortcut.
Provider refusal remains terminal for probe success even if ordinary knowledge code normally catches errors.
Cleanup preserves historical scalar IDs and accounting while live identity deletion prevents further calls.

These constraints were sent directly to the runtime owner and root before implementation.
The budget owner retains schema and ledger ownership; this review creates no second budget interface.
Required controlled proofs include actual Eliza initialization, provider-specific and unknown model requests, all embedding entry points, and cleanup after abort.
No staging consumption, credential setup, provider settlement, or implementation approval follows from this source review.

## Corrected design implementation-entry verdict

Verdict: APPROVED for implementation entry within the corrected design. This is not final implementation approval.
The appended corrections resolve R1 through R5 at design level.
They add pre-initialization guards, standalone knowledge denial, instance provider collections, bounded gateway behavior, and gateway-last disposal.
They also require a marked-fixture API/action allowlist before external moderation or unrelated paid helpers.
Reviewed design SHA-256: D84B63520ACA791560DC474E83789D16AC4413378A3A0B8815DE686B93E692D2.

## Installed-core seam verification

The reviewer inspected the installed core bundle at packages/agent-runtime/node_modules/@elizaos/core/dist/node/index.node.js.
Bundle SHA-256: 1D8D44D20FA49A326E24C275A01D36BAB303AB2BA0BB6CF9E23BC12C02E27567.
Its constructor stores characterPlugins and accepts an instance fetch option; it does not invoke their plugin initialization hooks.
Its initialize method calls this.registerPlugin for bootstrap and character plugins, then awaits their promises together.
Its registerPlugin method invokes the plugin init hook before registering that plugin's model handlers.
Therefore a registerModel-only guard is too late. Guard registerPlugin before delegating to the original method.
The instance exposes registerPlugin, registerModel, useModel, and getModel as ordinary methods.
These provide an instance-only pre-initialize guard seam without a global prototype patch.
No required method seam was missing in the inspected bundle.

The core initializes plugins concurrently. A rejected hook must latch terminal failure and prevent other hooks or background callbacks from dispatching.
A useModel guard alone cannot stop a plugin from invoking an unapproved callback or global fetch directly.
Only reviewed plugin objects and hooks may enter initialization; scoped handlers must retain their own durable dispatch guards.
Do not import caller-selected plugins or allow lower-priority paid handlers through provider-specific selection.
Runtime-scoped fetch denial can reinforce the boundary but cannot replace explicit standalone transport coverage.

## Mandatory implementation evidence

Use actual Eliza instances, genuine initialize, and controlled transports for the acceptance tests.
Prove guards exist before bootstrap and plugin hooks run, including an attempted handler replacement and direct retained callback invocation.
Prove concurrent initialization failure stops later calls and does not silently select an ordinary provider.
Test a scoped and ordinary runtime together; provider arrays, environment, and ordinary behavior must remain separate.
Exercise hosted-agent-knowledge, moderation entry points, unknown model types, provider-specific selection, redirects, and late gateway responses.
Exercise stopped or missing runs, deleted or rebound identities, restart, and cleanup after sequence abort.
The ledger owner must freeze the exact lookup/start/assertCurrent/embedExact/stop contract before runtime imports bind to it.
This review performs no live initialization, provider request, credential provisioning, or database action.