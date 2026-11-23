# Probe trusted bootstrap pre-read

Last Audited: 2026-11-09. Reviewer: identity_audit. Team: brainchain-office.
Status: frozen bootstrap source scoped PASS; runtime startup integration and live provisioning remain separate.
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

## Draft source finding and protected-file evidence

The initial identity callback queried agents and joined an avatar only through its user.
Canonical schema uses platform_agents and avatars.platform_agent_id.
The draft test created a synthetic agents table, which masked that mismatch.
Backend corrected the callback and test fixture to the canonical table and exact avatar binding.
Final frozen-source PostgreSQL verification remains pending; the draft checkpoint is superseded.

An independent actual Linux test passed one test and seven assertions against readRootTrialRecord.
It accepted a private regular file and refused symlink, hardlink, unsafe mode, oversized content, wrong UID, and unsafe parent directory.
The container used the pinned Bun image, UID10001, disabled network, read-only root, dropped capabilities, and a private tmpfs.
Only the compiled synthetic test file entered the mount. Compilation disabled environment substitution.
Evidence source: .brainchain-work/bootstrap-protected-reader.test.ts.
This establishes protected-reader behavior, not end-to-end bootstrap identity or signed reservation proof.
## Frozen-source verdict

Verdict: scoped PASS for bootstrap source, canonical identity, envelope-ID registration, and providerless registration boundaries.
All seven paths match .brainchain-work/probe-bootstrap-freeze.json after independent execution.
Bootstrap SHA-256: 54d3b28c830ed96ad2fc56d39888ab5a4ed5ff567818f42b2c4e3bc7e6989256.
Envelope service SHA-256: a44cb9d0a400dd70b26a6cd97cacf3f536508293ef62f4d9b38a79fd7f7941ee.
Budget service SHA-256: 41f80558257780eafa547967889df5055e2fefab9ef822b04649613ce87df506.

Independent isolated PostgreSQL execution passed bootstrap six tests/31 assertions, envelope five/23, and ledger ten/63.
A separate adversarial probe passed three tests/11 assertions.
It detached a same-owner avatar inside a rollback scope and proved canonical refusal and subsequent transaction usability.
It raced no real payment: a synthetic cross-provider envelope-ID collision rolled back the new allocation row.
Exact replay retained the original envelope; a different expected ID refused.
A providerless embedding call refused before root or identity callbacks or reservation work.
The ledger suite separately verifies unique committed concurrent start ordinals and retained counters.

Bootstrap tests verify registration reads no credential, exact registration replay, source mismatch refusal, and canonical detachment before key access.
They also delete identity or revoke root authority during the synthetic credential await and confirm no scope installation.
Source evidence tests compare actual protocol and curriculum builders and the installer splitter.
Actual Linux protected-file evidence remains one test/seven assertions, described above.
The independent probe is .brainchain-work/bootstrap-independent.test.ts.

The registration CLI delegates to the reviewed registrar, reports only run ID and manifest digest, and creates no genesis or signature.
Protected bootstrap reads and provider construction remain separate from provider dispatch.
The root verifier and credential reader in PostgreSQL tests are controlled fixtures; no real reservation or credential was used.
The Linux reader test covers the real file primitive, not a live API deployment.
Actual API startup ordering, runtime guards, prepare/attach behavior, and final cleanup belong to the separate runtime integration review.
No live credential provisioning, signed registration, provider call, deployment, or whole-runtime approval follows from this scoped verdict.

### Prepared fixture artifact Linux review

The corrected artifact wrappers passed three independent Linux tests with 26 assertions and zero skips.
The probe used Bun image `oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`.
The container used UID 10001, no network, a read-only root, no capabilities, and no-new-privileges.
Only the compiled synthetic test and a synthetic invalid artifact entered the container.
The test used private tmpfs paths. No credentials, database connections, or provider calls occurred.

The bundle copied the exact schema and exported read/write wrapper substring from the source file.
It imported the actual root-store implementation. Only the zod import path changed for dependency resolution.
This extraction avoided executing unrelated CLI initialization. It does not prove full CLI import behavior.
The compiled bundle imports only Bun and Node built-ins; no external source mount was required.
The ignored probe is .brainchain-work/prepared-artifact-linux.test.ts.
Bundle SHA256: `719842E5718574F044E2ED6BD7F8563756CCD5BB9FEC81AA7FD29C3B624FA3FC`.
Root-store source SHA256: `304A051DE026E2F12702BE41C48B4875B8E175F437CC5BD5FFF12B32E613DD66`.
Hosted probe source SHA256 at extraction: `B220B615FECCB8D747447499BFA78571F866365C3016B69BC3EEA36D8978FE09`.
Exact schema/wrapper substring SHA256: `4328847401EBBB244489D06BBF6C1C54C75CDB1D2DAA633BA5930575ADC90A45`.

Positive evidence covers private roundtrip, UID 10001 creation, mode 0600, one link, and preservation after duplicate creation refusal.
Concurrent exclusive creation produced exactly one success.
Negative evidence covers symlinks, hardlinks, broad file permissions, writable ancestors, symlink parents, and bounded FIFO refusal.
It also covers expired or excessive future timestamps, extra fields, malformed or oversized contents, and invalid UTF-8.
Changed content at rest refused. This test does not reproduce a mutation between the two file-stat calls.
The root-owned mount refused, but its permissions and contents were also invalid; this is not isolated wrong-UID proof.
Source inspection confirms UID and post-read mode, size, mtime, and link checks in the shared primitive.
The earlier duplicate reader lacked O_NONBLOCK. The owner removed it before an independent reproduction.
No original FIFO failure is claimed.

Scoped verdict: the tested corrected artifact wrappers pass these controlled Linux cases.
Final owner-freeze hash comparison remains required. Runtime HTTP, SQL attach authority, and cleanup order belong to the runtime reviewer.
