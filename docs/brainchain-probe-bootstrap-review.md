# Probe trusted bootstrap pre-read

Last Audited: 2026-11-09. Reviewer: identity_audit. Team: brainchain-office.
Status: implementation constraints issued; frozen-source review remains pending.
Scope: protected staging bootstrap, existing envelope registration, identity preparation, and runtime hydration.
No credentials, live database, provider request, application edit, or index action occurred.

## Baseline and accepted contract

The design separates root registration from API hydration.
API boot must not create a genesis, sign a reservation, allocate an envelope, or register a run.
The registration CLI uses an existing signed reservation and the canonical database pool.
The API hydrates before fixture startup, using protected deployment configuration and the dedicated credential reference.
The existing root store remains the authority for protected history.
The optional-provider constructor supports registration without a fake credential or dummy provider.

## Required envelope-ID correction

Current approveEnvelope generates a random ID after validating the root reservation.
The proposed manifest already contains its envelope ID, and its digest forms the signed approval reference.
An optional trusted expectedId can resolve this ordering without changing ordinary callers.

Required invariants:
- Validate expectedId as a UUID before mutation.
- Preserve random allocation when the field is absent.
- Require exact expectedId equality on prior-reservation retries, alongside every existing owner, amount, expiry, and approval comparison.
- Refuse an ID collision with another reservation, job, or provider; never adopt or overwrite that row.
- Roll back all allocation changes on a collision or mismatch.
- Retain allocation after an interrupted later run registration; permit only exact replay against the same manifest.
- Keep this input internal. A request body or model output cannot select accounting authority.

The signed approval reference binds the manifest digest, which includes the expected envelope ID.
Registration must compare that digest before allocating and again before registering the run.
No refund or replacement reservation follows automatically from partial registration failure.

## Protected read and hydration order

Validate configured staging mode before protected file or credential reads.
Read the bounded protected configuration and open the existing protected store.
Use the retained canonical pool to read the exact run, marker, envelope, and current canonical identity tuple.
Verify source commit, exact protocol hash, curriculum hash, immutable manifest digest, root reservation, state, and deadlines before reading the dedicated credential.
After asynchronous setup, repeat current root, run, identity, and deadline checks before installing the scope.
Reject unknown configuration fields, aliases, noncanonical paths, unsafe ownership, symlinks, hardlinks, and oversized files.
Do not search keyrings, read house provider credentials, or log key contents.
Missing configured deployment must not disable the runtime's independent persistent-marker refusal.

The identity callback uses its supplied transaction, avoiding a nested base-pool read.
Require exact platform-agent/user/avatar ownership and non-guest state, plus the manifest runtime identity.
Historical scalar IDs survive cleanup but cannot authorize a live runtime after deletion or rebind.
The scoped character ID must equal the reviewed runtime/platform ID, rather than a character override.

Source hashes come from actual builders and the deployed commit.
The protocol hash uses buildProtocolManual with the exact staging API origin.
API boot must not fetch its own unavailable listener to establish source identity.
Registration separately checks served evidence before attach; caller-supplied hash strings are insufficient.

## Startup and fixture sequence

The current API has detached warm tasks and runtime restoration paths.
The bootstrap await must precede every path that can create a marked fixture runtime, not only the main listener.
Preparation creates exact fixture identities without connect, autonomy, or runtime startup.
Root then publishes the reservation and registers accounting.
The API hydrates the registered scope before the probe attaches to those same identities.
Attach must refuse changed IDs or identity associations; it must not silently create a replacement fixture.
A failed setup must retain accounting and allow independent cleanup without authorizing embeddings.

An absent provider must make embedExact refuse before reservation, quota, or counter writes.
This applies to replay requests as well; registration mode is not a runtime transport.
Stop and read-only reconciliation remain available without a credential.

## Required verification before approval

Test explicit-ID creation, exact retry, prior-ID mismatch, cross-reservation collision, and unchanged random-ID callers.
Test crashes between signed publication, envelope allocation, marker/run registration, API hydration, and attach.
Test wrong environment refusal before file reads and stale source/identity refusal before credential reads.
Test concurrent or repeated bootstrap and prevent silent scope replacement.
Test optional-provider refusal with unchanged database counters and quota.
Test startup ordering against warm and restore tasks using controlled callbacks.
Protected-file behavior needs actual Linux checks. Database identity and replay need the retained real client.

Constraints were sent to backend and the runtime owner before source freeze.
This report does not approve implementation, credential provisioning, root registration, or paid dispatch.
