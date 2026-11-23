# Provider adapter decision, 2026-11-09

This is an implementation input. It does not reserve funds or permit dispatch.

## Current source facts

OpenAI's model pages now mark GPT-4.1 Mini and GPT-5 Mini deprecated.
The GPT-5 Mini page recommends GPT-5.6 Terra for new low-latency workloads.
The Terra page lists text Chat Completions support and reasoning effort none.
It lists input2USD/million and output12USD/million, with cache writes at1.25times the input rate.
Its default snapshot is the alias gpt-5.6-terra; no dated snapshot appears on the inspected page.
Long-context uplift starts above272000input tokens, outside this integration's limit.

Sources inspected on2026-11-09:
- https://developers.openai.com/api/docs/models/gpt-4.1-mini.md
- https://developers.openai.com/api/docs/models/gpt-5-mini.md
- https://developers.openai.com/api/docs/models/gpt-5.6-terra.md
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

The Chat Completions reference defines max_completion_tokens as the combined visible and reasoning token ceiling.
It states that all choices contribute to billed output. The adapter therefore fixes n=1.

## Proposed adapter contract

Use one fixed HTTPS endpoint, api.openai.com/v1/chat/completions, without redirects or retries.
Use a constructor-supplied credential from the trusted host. No task field can select a host or credential.
Use gpt-5.6-terra with reasoning_effort=none, n=1, stream=false, store=false, service_tier=default.
Send exactly one user message containing the approved full prompt. Do not add tools, audio, prediction, or external resources.
Set max_completion_tokens from the reserved call. Reject any response model outside the reviewed alias/snapshot policy.
Keep provider/model policy explicit and versioned; recheck model availability before the first paid test.

Reserve input at2.5USD/million to cover the listed cache-write surcharge without claiming a cache discount.
Reserve output at12USD/million. Cap the trial at32768prompt UTF-8 bytes plus1024framing tokens and2048output tokens.
The framing allowance is conservative policy, not a claim about exact provider tokenization.
Use the existing UTF-8 byte bound and reject usage beyond reserved bounds. Such a response remains charged or uncertain.
No automatic retry follows timeout, malformed output, unexpected usage, refusal, or HTTP failure.
Bound the response body and deadline. Suppress raw provider errors and authorization headers.
Require one textual choice, valid usage, expected model and terminal response before returning output.
Missing usage remains a full-cost reservation for manual reconciliation.

## Ledger work before a paid test

The tracked job ledger still has0spent and0reserved for each provider.
Create one stable job UUID and a root-owned sealed reservation before constructing a live envelope.
The verifier must bind job, provider, reservation ID, approval reference, cap and expiry exactly.
No API route or task process can mint that reservation.
Keep the original reservation across restart. Do not refund uncertain provider dispatch.
Cross-check the database envelope allocation against the root ledger before each trial.
The prototype's database cap cannot reset the founder's cumulative job cap.

No provider call occurred during this research. A separate implementation and independent review remain necessary.
