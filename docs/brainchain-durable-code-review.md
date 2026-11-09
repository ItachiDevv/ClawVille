# BrainChain durable identity: independent code review

Last Audited: 2026-11-09. Team: brainchain-office. Role: independent reconciler and adversarial reviewer.

## Disposition

SCOPED APPROVAL: the reviewed identity and curriculum code addresses B1, B2, and B3.
The reviewer independently repeated the failure probes against the corrections.
No blocking issue remains in this code-review scope.
This review covers address association, local worker controls, and curriculum installation only.
It approves no signer, task executor, payment, migration promotion, or production deployment.

## Findings

The findings below describe the initial code. The correction evidence follows them.

### B1: human cookies do not resolve on private routes

`apps/api/src/routes/brainchain.ts` calls `requireAuthOrAgentSession` without `sessionMiddleware`.
`apps/api/src/index.ts` has no global session middleware.
The resolver expects an upstream middleware to populate `c.get('user')`.
A normal human cookie therefore reaches the missing-agent-header rejection instead of the human identity path.
Agent header support alone does not satisfy human/agent parity.

Required correction: run the canonical session middleware before private identity resolution.
Verify the human cookie path, bound agent path, guests, expired sessions, and unknown sessions through HTTP composition.
Keep public knowledge and status independent of authentication.

### B2: the body limit runs after JSON buffering

The initial API mount places BrainChain after global `jsonBodyGuard`.
That guard reads the full JSON body before the route's 4 KiB limit runs.
The route can return HTTP 413, but that response does not prove bounded memory consumption.

An independent stream probe reproduced the same middleware order on itachi222.
It supplied 16,392 bytes with no Content-Length header.
The application consumed all 16,392 bytes before returning HTTP 413 for its 4,096-byte limit.

Required correction: apply the BrainChain body bound before the global parser reads these requests.
Existing MCP and Studios OAuth mounts use this early-bound pattern.
Test malformed JSON, chunked oversized JSON, and normal requests after the change.

### B3: a lock wait permits consumption after proof expiry

The binding transaction starts before it waits for the avatar advisory lock.
PostgreSQL `now()` returns the transaction start time, not the time after that wait.
The final `expires_at > now()` condition therefore accepts a proof that expires while the transaction waits.

The reviewer reproduced this through the actual service and real fixture database.
The fixture held an exact canonical signed challenge with a 1.6-second lifetime.
A separate transaction held the avatar advisory lock for 2.3 seconds.
The binding succeeded after the challenge expired.
The fixture changed only its own challenge timestamps and matching canonical message before signing.

Required correction: compare final expiry against `clock_timestamp()` after lock acquisition.
Use wall-clock database time for the consumption timestamp too.
Add a regression that holds the lock until the signed challenge expires.

## Correction review

### B1: canonical human session hydration

Private routes now run the real `sessionMiddleware` before the identity and guest gates.
The HTTP suite passed four tests and 12 assertions with real Lucia cookie validation and the real session middleware.
Its in-memory Lucia adapter provides fixture sessions; identity backing and service calls remain controlled fixtures.
Human cookie hydration reaches the resolver. Unknown and expired cookies return HTTP 401.
Agent and guest fixture guards preserve their expected HTTP 200, 401, and 403 outcomes.
This evidence proves middleware composition, not full production agent-session validation.

### B2: bounded bytes before parsing

The API now mounts BrainChain before global `jsonBodyGuard`.
Its first middleware measures stream chunks and rejects bodies above 4,096 bytes before authentication or JSON parsing.
The reviewer independently supplied 512-byte chunks with a false Content-Length of one byte.
The actual router returned HTTP 413 after 4,608 bytes, canceled the stream, and never reached the global parser.
One chunk can cross the threshold; the router does not retain the full oversized body.
A separate invalid UTF-8 request returned HTTP 400.
The public route suite passed four tests and 77 assertions, including the early mount regression.

### B3: wall-clock expiry after the lock

Final challenge consumption now compares expiry against PostgreSQL `clock_timestamp()`.
The reviewer repeated the original independent 1.6-second proof and 2.3-second lock-wait probe.
The actual service returned `invalid_proof`, created zero bindings, and left the challenge unconsumed.
The updated real PostgreSQL suite passed six tests and 22 assertions.

### Complete hosted section persistence

The generic installer adds an optional `requireComplete` input; its default remains unchanged.
The Office supplies `true` and requires a database readback of every expected section before runtime success.
Partial writes remain available for retries. Missing or silent writes cannot produce Office runtime success.
The wrapper also rejects a returned content hash that differs from its code version's manual.
The existing installer suite passed 17 tests and 39 assertions.
The strict Office persistence suite passed three tests and six assertions.
Connected-agent markers still do not prove model consumption; the response explicitly states that limit.

## Independent database evidence

The reviewer verified the existing fixture process on itachi222 before testing.
PostgreSQL listened only on loopback port 55439, from the job's ignored fixture directory.
The reviewer used the fixture password privately and printed no credential.
No staging or production database received writes.

The existing real PostgreSQL suite passed: five tests and 19 assertions.
It applies migration 0100 twice, checks database constraints, races proof consumption, and rejects curriculum downgrade.

The reviewer also ran separate cases through the actual binding service and real PostgreSQL connections:

| Independent case | Observed result |
| --- | --- |
| Two avatars prove the same address concurrently | Exactly one binding succeeds |
| Losing address-owner conflict | Challenge consumption rolls back; one verification attempt remains counted |
| Twelve concurrent invalid signatures for one challenge | Zero bindings; exactly five admitted verification attempts |
| Valid signature after the attempt limit | `invalid_proof`; the exhausted challenge remains unusable |

These cases use generated test wallets only. They submit no chain transaction.

## Reviewed invariants

- Private services derive ownership from the route's resolved avatar, not request body fields.
- Worker reads and control updates constrain the avatar in their database predicates.
- Challenge messages include the fixed deployment domain, purpose, avatar, chain, address, nonce, and expiry.
- The service reconstructs the exact message and checks the current deployment domain before EIP-191 verification.
- Nonces contain 32 random bytes. The database stores their hashes.
- Final challenge consumption and binding creation share one transaction.
- Wall-clock database time controls final expiry after lock acquisition.
- A conflicting binding rolls back consumption.
- Address uniqueness includes environment and address. It does not include a changeable manifest hash.
- One avatar has at most one binding per environment. No delete or transfer endpoint exists.
- Local pause and drain controls cannot alter observed chain eligibility.
- Curriculum seeding rejects older versions and conflicting content at the same version.
- Installation calls the existing agent-scoped installer. Memory identifiers include the platform agent ID.
- The response states `consumptionVerified: false`; a connected-agent marker does not prove runtime consumption.
- HTTP errors use sanitized codes instead of database or provider exception details.

## Remaining evidence boundaries

The fixture has minimal prerequisite tables. It does not prove migration compatibility with the full staging schema.
The cookie suite validates real cookie middleware with fixture identity backing, not the complete live agent-session resolver.
Hosted installation, complete section persistence, model consumption, and reconnect refresh still need runtime evidence.
The Office requires full section readback. Other installer callers retain their prior optional partial-persistence behavior.
No task tables, signer, transaction recovery, or compute isolation exist in this reviewed phase.
Those later increments require independent review against the earlier reconciler design constraints.

The reviewer leaves the isolated PostgreSQL fixture available for the backend's regression checks.
