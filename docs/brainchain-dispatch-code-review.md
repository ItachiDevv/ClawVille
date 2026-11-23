# BrainChain dispatch authority review

Reviewed2026-11-09 by the lead, independently from the runtime implementer.
Scope: the two root-reservation checks in inference-proxy.ts and their interaction with execution authority.

## Blocker R1: execution revocation during the final root read

The first execution fence runs inside the admission transaction.
The proxy then commits dispatch liability and awaits a second root reservation check.
After that read, it checks cancellation and the call deadline, but not the current execution authority.

The independent PostgreSQL probe held the third verifier invocation after the liability commit.
It committed revoked_at on the execution authority, then released the verifier.
The provider callback ran once after that revocation.
The receipt settled13fixture micro-USD. Output remained subject to the later output fence.
Withholding output does not prevent unauthorized computation expenditure.
No actual provider request or payment occurred.

Probe:.brainchain-work/audit-dispatch-revocation.test.ts.
Invocation:BRAINCHAIN_DB_FIXTURE=1 bun test ./.brainchain-work/audit-dispatch-revocation.test.ts --test-name-pattern "independent audit execution".
Result:0pass,1fail; expected providerCalls0, observed1.
The earlier invocation needed an explicit ./ path and API-local fixture dependencies.

Recheck current execution authority after the final asynchronous root read and before provider invocation.
Cover revocation, expiry, generation loss and local pause during that read.
Preserve committed uncertainty and one-shot dispatch when the final check refuses.
No correction can promise atomic revocation across PostgreSQL, the root store and a remote provider.
Independent recheck remains open. Paid activation remains unapproved.

## Independent correction review

Reviewed 2026-11-09 by durable_audit. R1 is resolved within the observed proxy scope. Paid activation remains unapproved.

The final external root read now precedes a new database transaction. That transaction checks execution authority, locks budget/envelope/call rows, and checks execution authority again. It requires the dispatched state, an open envelope, valid database clock bounds, and no cancellation. Refusal keeps the committed maximum liability uncertain. The provider does not run and replay cannot dispatch again.

The exact original independent probe now passes: `providerCalls:0`, receipt `state:uncertain`, and `chargedMicros:null`. This reviewer ran the actual PostgreSQL proxy suite: 14 passed, 1 Docker test skipped, 116 assertions. Cases include execution revocation, generation loss, pause, and authority expiry during the final root read. They also cover signed root revocation and a hung root source. The Docker result from the implementer was not independently rerun for this correction.

Each root read has a two-second bound and respects the call deadline and cancellation. Stored envelope fields supply the reservation identity and amount. The root check does not create a new budget. The final database transaction does not make root-store revocation, database revocation, and remote provider dispatch atomic. This remaining boundary does not authorize paid activation or a broader pilot claim.
