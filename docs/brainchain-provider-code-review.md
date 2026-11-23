# BrainChain OpenAI adapter review

Reviewed: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

## Scope and verdict

Reviewed `apps/api/src/services/brainchain/openai-provider.ts`, its tests, the provider adapter documentation, and its reserved-proxy contract. No blocker was found within this inactive adapter scope. This review does not authorize a paid call or prove live model availability, response identity, invoice totals, or root-ledger admission.

## Request and credential boundary

The adapter accepts one exact typed request. Zod parsing copies the permitted primitive fields before asynchronous work. The HTTP body contains the fixed model, endpoint, one approved user prompt, no tools, no stream, no storage, default service tier, no reasoning effort, and the reserved completion limit. A caller cannot select another endpoint, model, credential, or billing mode.

An independent deferred-response probe mutated the caller's prompt and output bound after invocation. The wire request retained `hello` and its original 32-token bound. Response validation retained the original bound. The probe used one controlled fetch and no network. Evidence source: `.brainchain-work/audit-provider-copy.ts`.

The credential lives in a JavaScript private field. The adapter reads no environment or keyring. It logs no secret, prompt, raw provider response, or raw exception. Header control characters fail constructor validation. Redirects are disabled. A changed response URL is rejected. The trusted injected fetch remains part of the host boundary; task input cannot replace it.

## Time, response, and accounting bounds

Each invocation calls fetch at most once. There is no SDK retry or fallback. A 30-second race covers fetch and body reads even when a controlled transport ignores abort. Parent cancellation uses the same abort path. Invalid HTTP status, malformed UTF-8/JSON, oversized bodies, or response validation errors return only a bounded uncertain error.

The adapter limits response bytes to 131,072 and text output to 32,768 UTF-8 bytes. It requires one successful assistant text choice, exact returned model, no refusal or tools, bounded positive usage, and consistent total tokens. Cached and reasoning details cannot exceed their containing token counts. The request completion ceiling includes reasoning tokens under the provider contract. Usage beyond the reservation never becomes accepted output; the durable proxy retains uncertainty.

The reviewed policy reserves up to 109,056 micro-USD per call. It prices all input at the cache-write-buffered rate and claims no cache discount. Settlement is conservative policy accounting, not invoice reconciliation. Cumulative job admission and the founder's provider cap remain the root ledger's responsibility.

## Public contract verification

The reviewer independently read the official [GPT-5.6 Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra) on 2026-11-09. It lists the requested model, Chat Completions, `none` reasoning effort, input at USD 2 per million tokens, output at USD 12, and cache writes at 1.25 times input price. These facts support the adapter's reviewed rate policy.

The exact live response model identifier remains unobserved. The adapter deliberately rejects an unreviewed dated identifier. The 1,024-token framing allowance is a conservative host policy, not a provider guarantee. Recheck availability, returned identity, pricing, and framing assumptions before a paid trial. Unknown billing outcomes must retain their reservation.

## Independent evidence

- Controlled provider suite: 8 tests, 153 assertions passed.
- The hard-deadline test returned at 30,009.22 milliseconds and performed one controlled invocation.
- Independent caller-mutation probe preserved original prompt and limits.
- No actual credential or provider request was used.

## Remaining gates

The concrete root-budget verifier was not frozen for this review. It needs independent review and end-to-end envelope checks. A real provider response and invoice were not observed. Keep task activation separate from this source verdict. Do not treat an adapter instance or a passing fixture as spend authority.
