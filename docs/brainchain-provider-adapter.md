# BrainChain reserved OpenAI provider adapter

Last audited: 2026-11-09.

This adapter implements the trusted `ReservedProviderAdapter` interface.
It registers no HTTP route, obtains no credential, creates no reservation, and performs no ledger write.
The trusted host must inject its credential through the constructor.
The constructor also accepts a trusted fetch implementation for controlled tests.
Task input cannot replace the transport, host, credential, model policy, or provider parameters.

## Domain constraints

This work follows the agent-protocol-partner ownership and secret/egress constraints.
It preserves existing Hatcher signing, wallet, identity, and action surfaces.
The fixed destination and manual redirect policy prevent task-selected egress.
The adapter logs no prompt, credential, header, provider body, or raw exception.
Its credential uses a JavaScript private field and does not appear in serialized adapter objects.

## Fixed request

- Endpoint: `https://api.openai.com/v1/chat/completions`.
- Model and accepted response model: exactly `gpt-5.6-terra`.
- One user message contains the full approved prompt.
- Parameters: `reasoning_effort=none`, `n=1`, `stream=false`, `store=false`, `service_tier=default`.
- `max_completion_tokens` equals the reserved output bound, capped at 2048.
- No tools, audio, prediction, external resources, fallback, SDK retry, or application retry.
- Each generate invocation calls fetch at most once, with `redirect=manual`.
- A nonempty response URL must equal the fixed endpoint; redirected responses fail.

The adapter validates the exact request keys, UUID call ID, model, prompt bytes, and token bounds before fetch.
It uses no environment variable, keyring, browser credential, or user wallet.

## Proposed price policy

Policy version: `openai_terra_20261109_v1`.

| Field | Value | Reason |
|---|---:|---|
| Input price | 2,500,000 micro-USD per million tokens | Reviewed input price 2 USD with a 25% cache-write buffer |
| Output price | 12,000,000 micro-USD per million tokens | Reviewed output price 12 USD |
| Fixed request price | 0 micro-USD | No separate charge appears in the reviewed source |
| Prompt limit | 32,768 UTF-8 bytes | Existing proxy prompt ceiling |
| Provider framing allowance | 1,024 tokens | Conservative policy allowance, not exact tokenization |
| Maximum input reservation | 33,792 tokens | Prompt byte bound plus framing allowance |
| Maximum output reservation | 2,048 tokens | Includes visible and reasoning output |
| Maximum call reservation | 109,056 micro-USD | 0.109056 USD at both maxima |

The adapter claims no cache discount.
Policy-based settlement remains conservative; it is not a provider invoice reconciliation.
The root ledger must authorize cumulative job spend separately.
This module cannot create an envelope or a root reservation.

The source facts and links appear in `docs/research/brainchain-2026-11-09/provider-adapter-decision.md`.
They include the cache-write surcharge, model deprecation facts, and Chat Completions token-ceiling semantics.
The 1024-token framing allowance is a deployment policy, not a documented provider guarantee.
Response usage beyond its reservation fails closed after dispatch and remains uncertain.

## Bounded response and failure behavior

The entire operation has a 30-second hard deadline, including fetch and streamed body reads.
The deadline race also bounds a transport that ignores its abort signal.
Parent cancellation aborts the same operation.
The body limit is 128 KiB of decoded HTTP response bytes, with or without Content-Length.
The adapter cancels rejected streams and validates strict UTF-8 before JSON parsing.

Accepted responses require HTTP 200, JSON content type, the exact model, and one indexed assistant text choice.
The finish reason must be `stop`.
Refusals, tool/function calls, audio, empty text, multiple choices, and truncated output fail.
The output limit is 32,768 UTF-8 bytes.
Prompt/completion usage must contain bounded positive integer counts and a consistent total.
Cached-token and reasoning-token details cannot exceed their containing counts.
Unrequested audio and prediction-token usage must remain zero.
Benign unknown response metadata does not override any checked billing or result field.

Before dispatch, invalid input and an already aborted signal produce bounded local error codes.
After dispatch, all failures produce only `BrainChain compute refused: uncertain` without a raw cause.
The existing durable inference proxy retains uncertain reservations for reconciliation.
There is no timeout refund, automatic retry, or partial-success output.

## Unverified provider semantics and release gates

The reviewed model page exposes an alias without a dated snapshot.
The live provider may return a dated model identifier; no such identifier is invented or accepted here.
The adapter must reject it until the host reviews and versions an exact allowlist change.
Model availability, pricing, and the response identifier need a fresh official-source check before a paid trial.
No live provider response or invoice proves the adapter contract in this implementation.

Before any paid test, the root must supply a stable job UUID and a sealed existing root-ledger reservation.
The reservation must bind job, provider, approval reference, limit and expiry.
The host must cross-check the durable envelope allocation against the root ledger.
A task process and a public API must never construct that authorization.
The founder's cumulative 10 USD per provider cap cannot reset on restart or envelope replacement.

## Controlled verification

All fetch implementations in the tests are local controlled functions.
They issue no network request and access no real credential.
Tests cover fixed wire fields, policy cost, request overrides, model/usage/result rejection, body limits, safe errors, cancellation, and no retry.
The hard-deadline test holds a transport promise unresolved and observes one uncertain failure at approximately 30 seconds.
Independent review and root-ledger integration remain separate gates.

PARITY: no new user or agent action is exposed; both paths consume the same existing reserved-proxy interface when the trusted host wires this adapter.

Observed local verification: 8 tests pass with 153 assertions; the hard-deadline test completes in 30003.91 ms. API TypeScript exits zero.
