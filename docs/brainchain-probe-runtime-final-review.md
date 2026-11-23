# BrainChain probe runtime implementation review

Last Audited: 2026-11-09. Reviewer: runtime_audit. Team: brainchain-office.

Status: scoped PASS for the frozen runtime integration source and controlled evidence below.
Earlier findings describe the review history. The final verdict supersedes their pending status.
Scope excludes bootstrap authority, ledger accounting, and the rejected C1 consent review.
No credentials, provider requests, staging changes, or external messages occurred.

## Evidence and findings

The reviewer read the complete current handoff and the runtime injection design and design review.
The reviewer inspected the actual installed Eliza core registration, initialization, and model dispatch code.
The core registers plugin hooks before model handlers and initializes plugins concurrently.

R1 was independently reproduced with actual core initialization and a synthetic embedding transport.
An approved plugin threw an ordinary initialization error. A subsequent model call reached the transport once.
The owner added failure latches to delegated plugin registration, core initialization, and runtime start failures.
The original independent reproduction now refuses before transport.

Independent command: `bun test ./.brainchain-work/runtime-independent-review.test.ts`.
Current result: eight tests passed, twenty-two assertions. Unknown-model refusal also passed.
The retained callback test stops actual core services before stopping the boundary.
An earlier teardown order produced a bootstrap service rejection; it did not prove a retained callback failure.

Additional findings sent to the owner:

- Runtime stop originally omitted local probe cancellation. The owner added it.
  An independent wrapper test now refuses retained embedding work after stop.
- Internal `executeAction` originally retained the full action collection without a probe allowlist.
  Founder gateway chat supplies services to `processMessage`, so this dispatch path is reachable.
  The owner now denies internal actions for the probe. An independent synthetic handler remains uncalled.
- Cleanup deletes live database fixtures before gateway shutdown, contrary to the approved order.
  Gateway closure also needs a final disposal block when an earlier cleanup step throws.
- Expert consult, avatar chat, avatar directive, and agent building chat lack probe guards.
  The directive route calls moderation outside the scoped runtime.
  The five-stage probe itself calls that directive route, so its provider boundary is incomplete.
- BrainChain cleanup enabled autonomy but only disabled it when the separate legacy autonomous flag was set.
  Normal BrainChain mode must disable autonomy during disposal.

The actual five-stage founder chat calls the avatar chat route, not the agent gateway route.
It also requires an exact source-controlled text exception before ordinary moderation.
The owner added fixed chat text and a run-bound fixed directive, subject to active canonical scope checks.
Final route verification uses the exact helper and actual canonical middleware tests below.

The independent isolation test initializes scoped and ordinary actual Eliza cores together.
Scoped refusal leaves the ordinary handler and environment unchanged.
The ordinary core performs its normal local dimension probe before the explicit test call.
An unapproved lower-priority handler cannot register or receive an explicit provider-selected request.
The reviewer also reproduced the missing post-initialize inventory diagnostic.
The owner added an exact model-type and wrapped-handler-reference check.
A controlled direct inventory mutation now makes initialization refuse without invoking its handler.
The independent test observes the expected bootstrap service cancellation after that refusal.

Root approved a shared attributed-marker HTTP allowlist in the canonical auth paths and gateway resolver.
The proposed list permits exact required writes and enumerated diagnostics only.
Disposal operations must remain available after durable stop.
No containment claim applies to anonymous requests that omit fixture identity.

The reviewer reproduced an initial HTTP allowlist defect with actual Hono middleware ordering.
Global JSON parsing consumed the raw request before the helper attempted `Request.clone()`.
The exact autonomy-off request returned 500, preventing disposal.
The owner added a trusted callback to read Hono's cached parsed body.

Independent command: `bun test ./.brainchain-work/runtime-http-independent-review.test.ts`.
Current result: four tests passed, eleven assertions.
The test uses actual `jsonBodyGuard`, `sessionMiddleware`, and `requireAuth`, in that order.
It replaces only Lucia identity validation, marker database results, and fixed runtime constants.
Exact autonomy-off succeeds without an active deployment and survives both canonical middleware checks.
Extra disposal fields and arbitrary marked writes refuse before their handlers.
Ordinary authenticated requests retain their parsed body.
Exact active install, chat, directive, and autonomy bodies pass their controlled scope checks.
Changed chat text, extra install fields, and autonomy-on after stop refuse.

Current cleanup source disables autonomy in BrainChain mode and stops the gateway before fixture deletion.
The later sections record the independent cleanup and protected-artifact results.

An earlier design gap left terminal runtime failure instance-local.
The budget records uncertain calls while the durable run remains active until cleanup.
A second permitted runtime start can occur before cleanup; quotas do not expand.
The design's stronger wording about terminal run failure needs implementation or an explicit corrected requirement.
The reviewer sent this distinction to root and claims no durable terminal failure from local latches.
Root retained the durable requirement and requested an awaited trusted stop after embedding failure.
The failure boundary must also cover its own timeout and cancellation races.
Normal explicit runtime stop may still permit the planned second start.

The reviewer independently injected failure into every cleanup stage using synthetic callbacks.
Command: `bun test ./.brainchain-work/runtime-cleanup-independent-review.test.ts`.
Initial result: one test passed, one failed, seventeen assertions.
Admission, autonomy, runtime, and disconnect failures retained rows and closed the database.
The successful path placed gateway shutdown before fixture deletion.
A gateway shutdown exception skipped database closure inside the final block.
The owner received a request for nested final disposal and a rerun of this reproduction.
After the owner added nested final disposal, the independent reproduction passed two tests and seventeen assertions.
Gateway failure now preserves fixture rows and still closes the database.

## Durable terminal failure composition

The final candidate uses one trusted termination closure, `failRun`, bound to the exact durable budget run.
The raw host embedding closure delegates directly. It does not independently terminate intentional cancellation.
Runtime start failure uses `failLocal`; ordinary runtime shutdown uses explicit intentional cancellation.
The only production consumer of the raw scoped embedding closure is `ProbeRuntimeBoundary.embed`.

Independent boundary command: `bun test ./.brainchain-work/runtime-terminal-independent-review.test.ts`.
Result: three tests passed, fourteen assertions.
An ignored transport deadline waits for the stop promise before reporting terminal refusal.
Initial admission refusal and malformed vectors also invoke termination.
Persistence failure returns `probe_runtime_terminal_stop_unavailable` without a fallback.

Independent database command: `bun test ./.brainchain-work/runtime-terminal-pg-independent-review.test.ts`.
Result: one test passed, fifteen assertions, against the controlled PostgreSQL fixture on port 55440.
The test uses the actual budget service, adapter, runtime boundary, and retained accounting tables.
Its synthetic provider never sends a network request.
After timeout, actual durable stop prevents actual budget start and retains 200 microUSD of uncertain liability.
After intentional local shutdown, the actual second start returns ordinal two and retains the same uncertain liability.
The database client closed. No migration replay or historical-row deletion occurred.

The bootstrap reviewer separately tested the prepared-artifact reader and writer on Linux: three tests, twenty-six assertions.
Those results appear in the bootstrap review and require comparison against the final freeze.
They do not prove a mid-read mutation race or isolate wrong-UID refusal from parent-directory refusal.

The reviewer independently ran the prepared attachment test: one test passed, nine assertions.
Changed cookies, source text, manifest identity, session origin, and stopped runs refused.
The source query uses exact canonical identity joins and performs no allocation or replacement.
This attachment test uses controlled rows; it does not claim actual PostgreSQL attachment execution.
The final frozen-source comparison passed, as recorded below.

The reviewer sent the additional route scope to root before requesting owner changes.
Ordinary moderation must remain unchanged. A model-selected directive cannot grant additional paid authority.

## Final frozen-source verdict

Verdict: scoped PASS for this runtime integration candidate. No unresolved finding remains within this reviewed source scope.
The reviewer independently compared all 33 paths in .brainchain-work/runtime-injection-freeze.json. Every hash matched.
Manifest SHA256: `116E5FE627B0F8013720EFCDB9C2F668059E56C1C7597E79929A2062B5E71875`.
The final service-failure observer latches local failure without changing intentional shutdown classification.
The reviewer reran the actual-core independent suite after that last source change: eight tests and twenty-two assertions passed.

| Evidence | Independent result | Scope |
| --- | --- | --- |
| Actual core and wrapper | 8 tests, 22 assertions | Init latch, inventory, foreign handler refusal, ordinary isolation, retained callbacks, internal actions |
| HTTP boundary | 4 tests, 11 assertions | Actual Hono/auth ordering, exact stage bodies, stopped disposal, ordinary behavior |
| Cleanup | 2 tests, 17 assertions | Failure at every disposal stage, retained rows, gateway ordering, database closure |
| Terminal failure boundary | 3 tests, 14 assertions | Timeout, admission, malformed vector, awaited stop, unavailable persistence |
| Actual shared PostgreSQL pool | 1 test, 15 assertions | Durable stop/start composition, intentional restart, retained uncertain liability |
| Prepared attach rerun | 1 test, 9 assertions | Exact controlled identity, cookie, source, session origin, and run validation |
| Protected Linux artifact review | 3 tests, 26 assertions | Separate bootstrap reviewer; unchanged exact wrapper and root primitive |

The reviewer compared the Linux-tested wrapper substring against the final source; its hash matches.
Wrapper SHA256: `4328847401EBBB244489D06BBF6C1C54C75CDB1D2DAA633BA5930575ADC90A45`.
Root-store SHA256: `304A051DE026E2F12702BE41C48B4875B8E175F437CC5BD5FFF12B32E613DD66` also matches.

Source inspection covers stable section IDs, per-instance providers, canonical marker lookup, early API hydration, and every changed guard entry point.
The bootstrap authority and ledger reviews retain their separate scopes.
This verdict permits the next integration checks; it does not establish the full release goal.

Actual staging consumption, live API startup, real provider settlement, and wallet approval remain unproved here.
Prepared attachment used controlled rows, not actual PostgreSQL attachment execution.
The Linux test does not isolate wrong-UID refusal or reproduce a mid-read mutation.
Anonymous requests that omit fixture identity remain outside the attributed-marker restriction.
No live credential, paid provider, production deployment, external message, or index mutation occurred in this review.
