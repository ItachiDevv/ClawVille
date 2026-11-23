# BrainChain isolated process review

Reviewed: 2026-11-09. Team: brainchain-office. Role: independent adversarial auditor.

## Scope and verdict

Reviewed `stdio.ts`, `process.ts`, `process-entry.ts`, the strict runtime profile, and actual child tests under `packages/agent-runtime/src/isolated-task`.
No blocker was found in the current single-shot child protocol. This verdict does not approve a paid parent adapter, a deployment launcher, or a live worker pilot.

## Protocol properties

The reader bounds its pending input to 262,145 bytes and accepts one UTF-8 JSON line per frame. Fatal UTF-8 decoding rejects malformed bytes. Exact outer keys reject unknown fields. The runtime validates every initial binding field before Eliza initialization. The prompt hash binds the complete generated prompt to the approved task brief.

The child emits at most one generate request. The child receives no provider credential, signer reference, raw capability token, or database connection. Its binding contains identifiers and limits. These identifiers do not grant spend authority by themselves. The parent must retain the opaque capability and submit the exact child request through the durable proxy's capability and binding checks.

The runtime validates response call ID, model, prompt hash, token usage, text size, and deadline. A response cannot change the approved binding. Action-like text remains output data. The child never executes that text as an action or command.

Initialization has a five-second frame deadline. The validated task deadline governs model response and writes. Cancellation and host refusal stop the one-shot runtime. Errors use a small fixed code set. Raw errors and rejected frame contents do not enter the error frame. The entry point emits framed stdout and exits with the returned status.

The process rejects extra input already buffered after the accepted response. It does not promise to detect arbitrary later bytes after it exits. This does not create a second generation path. The parent must still close input and terminate a child that exceeds its external process deadline.

## Independent evidence

The reviewer ran actual child fault probes with a controlled host and no provider or key:

| Probe | Result | Exit | Child stderr |
| --- | --- | --- | --- |
| Response with another call ID | runtime_refused | 1 | empty |
| Initial binding with an extra fake secret field | runtime_refused | 1 | empty |
| Host closes input after generation request | input_closed | 1 | empty |
| Two generated replies in one write | unexpected_frame | 1 | empty |

The fake canary text did not appear in any error frame. Probe source: `.brainchain-work/audit-stdio-faults.ts`.

The existing tests exercise actual core model execution, exact output preservation, refusal, cancellation, oversized input, missing host response, invalid UTF-8, and clean import. Their fresh independent run passed. The earlier combined runtime and policy run passed 18 tests with 89 assertions.

The lead's container evidence at `docs/research/brainchain-2026-11-09/isolated-process-container-evidence.json` records one actual Eliza exchange. It records UID 10002, network disabled, a read-only root, dropped capabilities, no provider credentials, and one read-only worker bundle. This reviewer inspected that evidence; the reviewer did not repeat that Docker launch. The recorded swap-limit warning belongs to Docker, not the child error protocol.

## Integration gates

The future parent launcher must enforce a minimal environment, separate UID, no signer mount, no database access, no network, resource limits, and an external kill deadline. The pure process function does not establish those controls.

The parent must treat all child output as untrusted. It must check the exact request against its retained capability. It must associate the final result with the original binding and durable proxy response. A child-supplied success frame alone cannot authorize task completion, delivery, settlement, or another paid request.

Keep the provider adapter and root budget verifier outside the child. Provider timeout must retain the durable uncertain charge. Do not use child cancellation as evidence that a provider charged nothing. Keep signing activation closed and reject mainnet.
