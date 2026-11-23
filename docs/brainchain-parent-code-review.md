# BrainChain parent coordinator review

Reviewed: 2026-11-09. Team: brainchain-office. Reviewer: durable_audit.

## Scope and verdict

Reviewed `packages/agent-runtime/src/isolated-task/parent.ts` and `apps/api/src/services/brainchain/isolated-process-coordinator.ts`, their tests, and their existing child/proxy coupling. The cleanup-expiry blocker now has a verified correction. No blocker remains within this inactive parent scope. No paid call, keyring access, or network transaction occurred in this review.

## Confirmed blocker: cleanup follows final confirmation

The parent validates the final durable receipt and deadline before returning. Its finally block then clears the deadline timer and awaits child termination. Termination can take three seconds. A deadline or task revocation can occur during this gap, after confirmation but before output reaches the caller.

An independent probe used a controlled child and proxy. The binding expired after 150 milliseconds. Child termination took 250 milliseconds. The parent returned success 109 milliseconds after expiry. It confirmed only once, before cleanup. Probe: `.brainchain-work/audit-parent-cleanup-expiry.ts`.

The correction keeps cancellation and deadline enforcement through cleanup. Final durable confirmation and the final deadline check now follow cleanup. The original independent probe refuses with `expired` and makes zero confirmation calls. New regressions also cover task revocation during termination. No second generation occurs.

## Properties confirmed in source

The parent copies the approved binding and requires one exact generate frame. The child cannot select a different prompt, model, avatar, task, call, reservation, or token limit. The parent uses its retained proxy method and capability. Neither the capability nor the provider credentials enter child input.

The parent compares the child's final text and token counts with the actual proxy response. It requires stdout closure and successful child exit. It rejects additional frames and checks a fresh durable response before its current return point. Forged success alone cannot create a verified result.

Stderr is drained concurrently and limited to 4,096 bytes. The parent returns only its byte count. Error details and stderr content do not enter result errors. Abort propagates to the proxy. A paid call's accounting remains the proxy's responsibility; process cancellation cannot release uncertain charges.

The launcher fixes the image digest, executable, environment names, non-root UID, disabled network, read-only root, dropped capabilities, no-new-privileges, disabled Docker logs, one read-only bundle mount, and resource flags. It verifies the bundle hash before launch and inspects the container before proxy dispatch. Only a generated container name reaches cleanup. The launcher accepts no user-selected command, image, environment, or cleanup target.

Deployment must keep the approved bundle immutable between verification and mount. The launcher reads a file hash and later mounts that path; it does not create an immutable content snapshot. The trusted Docker daemon and host filesystem remain part of the boundary. The known kernel swap warning limits memory-plus-swap claims.

## Independent evidence

- Parent and launcher-policy tests: 6 passed, 1 Docker-only test skipped, 53 assertions.
- Those tests include one actual clean Eliza child with a controlled proxy.
- Independent delayed-termination probe reproduced output after expiry.
- Corrected parent suite: 7 tests, 44 assertions passed. The original independent probe now refuses output after expiry.
- The lead previously supplied Docker and database/proxy integration results. This pass did not repeat those integration suites, and their results do not cover the new cleanup race.

## Gates

The cleanup race is resolved within the reviewed scope. A live provider adapter, root budget verifier, signing authorization, and task execution activation remain outside this review. No live pilot is claimed.
