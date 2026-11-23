# BrainChain root compute budget

Last Audited: 2026-11-09

Drift note: Adds a signature verifier for root compute reservations. Dispatch also checks the current root reservation. This change creates no reservation and activates no paid provider.

## Authority boundary

`apps/api/src/services/brainchain/root-compute-budget.ts` exports `SignedRootComputeBudgetAuthority`.
It implements the existing `RootComputeBudgetAuthority.verifyReservation` contract.
The constructor accepts a pinned Ed25519 public key, job UUID, genesis document hash, trusted current-head callback, and signed-history loader.
The module does not read files, environment variables, private keys, or credential stores.
It does not sign documents or approve expenditure.

The pilot founder ledger is job-specific deployment input.
It is not authority for customer jobs.
Root must reserve expenditure and review the exact provider, amount, approval reference, and expiry before external signing.
No signed genesis or production key exists from this implementation.
The unsigned founder ledger remains separate and unchanged.

## Signed format

`RootComputeDocument` defines the strict version-one schema.
`rootComputeDocumentBytes` returns the canonical UTF-8 text for external signing.
Object keys use lexical order; array order remains unchanged.
`rootComputeDocumentHash` returns the lowercase SHA256 hash of those exact bytes.
The external signer uses Ed25519 without an additional digest argument.
The public key contains exactly 32 bytes, expressed as lowercase hexadecimal.
Each signature contains exactly 64 bytes, expressed as lowercase hexadecimal.

Each signed wrapper contains only `document` and `signatureHex`.
The document contains the kind, job UUID, revision, previous document hash, issue time, expiry, both provider totals, and reservation history.
The first revision is one and has no previous hash.
Each later revision links the previous document hash and increases the issue time.
The constructor pins the first document hash.
Every document has a maximum authorization lifetime of ten minutes.

Each provider has a separate 10,000,000 micro-USD cumulative cap.
Amounts use canonical decimal strings without signs, fractions, leading zeros, or exponents.
Spent amounts never decrease.
The verifier adds spent amounts to every reserved or uncertain allocation.
Expired or revoked allocations still count until a valid state transition removes the hold.

Each reservation freezes its UUID, provider, approval reference, limit, and expiry.
Approval references and reservation UUIDs are unique in each document.
Later documents retain every prior reservation and its immutable fields.
The target reservation must have state `reserved`, no revocation, and an unexpired exact match with the envelope approval.
A reservation expiry cannot exceed the containing document expiry.

Reserved allocations can remain reserved, become uncertain, settle, or release.
Uncertain allocations can remain uncertain or settle; they cannot release.
Settlement requires a charge no greater than the limit and a reconciliation reference.
Release requires a zero charge and a reconciliation reference.
Terminal records remain byte-equivalent across later revisions, including their known charge.
Revoked reservations cannot regain approval.
Root must reconcile the actual database envelope before signing a release or settlement.

## Freshness and retention

The trusted current-head callback returns job UUID, revision, document hash, and observation time.
The verifier checks that callback before and after history verification.
Each observation must be at most five seconds old and cannot have a future timestamp.
The callback must obtain its head from protected deployment state, independently of the history loader.
A callback that merely repeats the loaded document does not establish freshness.

The loader supplies the complete signed history from revision one.
The verifier accepts at most 64 snapshots, 128 reservations per snapshot, 65,536 bytes per document, and 1,048,576 document bytes in total.
Operators retain every snapshot and terminal reservation across restart.
There is no automatic truncation, compaction, new genesis, or cap reset.
Capacity exhaustion refuses further approval and requires independent review of any retention extension.
The full history detects divergent reservation fields after restart without a mutable verifier cache.

## Integration limits

The durable inference proxy calls this interface when it approves an envelope and at two dispatch boundaries.
Its database maps one immutable root reservation to one envelope and prevents duplicate envelope allocation.
The deployment supplies the verifier explicitly. The protected Linux store supplies concrete head/history callbacks, but no production store exists. No signing helper exists.
A valid signature alone does not establish the latest head.

Fresh-head checks reject stale approval documents.
Dispatch checks the stored exact reservation after database locks and again after the dispatch commit.
The proxy rechecks the execution fence and database clock before it commits liability.
After the final root read, it checks current execution authority, generation, pause state, lease, call state, and database time again.
Each dispatch root read has a two-second maximum and respects call expiry and cancellation.
A pre-commit refusal preserves the reserved hold.
A post-commit refusal retains full uncertainty, invokes no provider, and allows no retry or automatic release.

These checks do not provide instantaneous revocation.
A root update after the final successful check can race the provider invocation.
No transaction spans the protected root store, PostgreSQL, and the provider.
Already dispatched requests retain their accounting liability.
Root reads during envelope approval still require bounded concrete sources; the two-second wrapper applies to dispatch reads.
A root issuer can revoke future approval by publishing a signed revision and advancing protected head state.

PARITY: Human and bound-agent tasks use the same server-side budget authority; neither receives signing authority or a public reservation issuer.

## Verification

`apps/api/src/services/brainchain/root-compute-budget.test.ts` uses ephemeral fixture keys only.
Tests cover exact approval, separate caps, expired holds, signature and tuple mismatches, divergent signed history, missing IDs, forbidden transitions, and terminal charges.
Tests also cover stale heads, concurrent revisions, document expiry, canonical JSON, bounded input, restart verification, and uncertain settlement.
No test calls a paid provider or loads a production credential.

The dispatch fixture suite also exercises the actual PostgreSQL and network-none Docker path.
It checks genuine signed advanced-head revocation, lock waits, missing authority, source hangs, expiry, and retained uncertainty.
The controlled provider makes no paid request.


## Protected Linux store and publisher

Last Audited: 2026-11-09.
Drift note: Adds a Linux-only store, root publisher, actual accounting reconciliation, and a bounded trial entry.

`apps/api/src/services/brainchain/root-compute-store.ts` exports `ProtectedRootComputeStore`.
Windows direct use refuses before file access.
The configured UID must equal the current process UID.
Every directory ancestor must belong to that UID or root and prohibit group/other writes.
Protected files must belong to the configured UID, prohibit group/other access, and have one hard link.
The store rejects symlinks, nonregular files, oversized input, replacement during reads, and changed metadata.
Read operations have a one-second maximum.
Late reads cannot authorize dispatch.

The trusted constructor specifies absolute normalized paths for the pin file, current-head file, and history directory.
Pins and current head remain outside the history directory.
The pin file contains exactly jobId, publicKeyHex, and genesisDocumentHash.
The head file contains exactly jobId, revision, and documentHash.
Observation time comes from the completed protected read, not a timestamp saved in that file.
No file or directory appears automatically during normal opening.

These controls trust the Linux host account, kernel, protected directories, and database.
All processes with that account's permissions remain trusted.
The task container receives no store mount, provider credential, signing key, or database connection.
A privileged overwrite or rollback of the protected head or restart pins remains outside this threat model.
That includes a full-store rollback.
The publisher only advances the head, but it cannot prevent a privileged operator from bypassing the publisher.
A signature alone cannot detect that rollback.
Use separate OS identities if other host processes are untrusted.

Root must provision a persistent Linux filesystem with these permission guarantees before a trial.
A default NTFS mount does not establish Linux ownership or permission enforcement.
The Docker test directory is an ephemeral tmpfs, not persistent production authority.
No real pin, genesis, protected head, reservation, or signing key exists from these tests.

`publish` accepts an already signed next document and an exact expected previous head.
An exclusive head lock serializes publishers.
An existing lock refuses publication; the code never steals or expires it automatically.
Root must establish that its owner process exited before removing a stale lock.
The publisher validates the same signature/history policy as the runtime verifier.
`verifyCurrentDocument` shares that policy with `verifyReservation` and permits a zero-allocation pinned genesis.

Initialization requires an absent head, a pinned signed revision-one document, zero spent totals, and no reservations.
It also refuses an existing database budget for that job.
Initialization is explicit and cannot reset an existing head or database budget.
Every later revision retains the original genesis and complete history.
A conflicting orphan snapshot at the next revision refuses publication.
An identical orphan snapshot permits recovery of the same intended publication.

The publisher locks actual budget, envelope, and compute-call rows before terminal reconciliation.
It compares immutable reservation fields with the actual envelope.
It recomputes reserved, uncertain, and settled amounts from the actual calls.
It checks envelope totals and allocated provider budget totals.
Release or settlement requires a closed envelope, zero reserved/uncertain liability, exact known charge, and the actual reconciliation UUID.
A missing envelope, caller-supplied reconciliation claim, or unresolved call cannot authorize release.

After reconciliation, publication writes the immutable signed snapshot with exclusive creation.
It flushes the snapshot and its directory.
It then writes and flushes a temporary head, atomically renames it, and flushes the protected directory.
The head replacement commits publication.
The database transaction holds accounting locks through this replacement and changes no database accounting.
A crash can leave an orphan snapshot, temporary file, or stale lock.
It cannot make a partial head an authorization source.
Restart retains the previous head or the fully replaced head and never resets totals.

`scripts/brainchain/publish-root-budget.ts` is the root-only executable wrapper.
Root invokes it with `bun --no-env-file scripts/brainchain/publish-root-budget.ts` on the approved Linux host.
JSON stdin contains store, databaseUrl, signed, and expectedHead.
The store object contains pinPath, headPath, historyDirectory, and expectedUid.
The signed object contains the already signed canonical document and signatureHex.
expectedHead is null only for explicit initial publication; otherwise it omits observedAtMs.
Root supplies the explicit loopback PostgreSQL connection through protected stdin.
The wrapper discovers no credentials, reads no environment key, and prints no document or connection string.
It has a ten-second process deadline and prints only the resulting head on success.
An interruption requires head inspection and root recovery before another invocation.

## Bounded trial entry

`apps/api/src/services/brainchain/paid-trial.ts` exports `BoundedBrainchainPaidTrial`.
It registers no HTTP route and reads no credential file, environment key, or keyring.
Root supplies the protected store, existing database, protected journal directory, and reviewed process bundle.
The constructor refuses Windows direct use.

Root first calls preflight with one run UUID, avatar, task, execution authority, root reservation, and exact brief.
Preflight requires an existing canonical testnet Hired task and a running bound worker.
It requires an unused, unrevoked execution authority with the exact input/prompt hashes and next generation.
It reads the actual fixed-host chain and checks the indexed observation against the current stable block.
It checks current task state, worker model, brief hash, deadline, and the zero payee required before submit.
The pinned release assigns payee during submit, after the Hired state.
It verifies the stored hire transaction/log against actual canonical block and event evidence.
Strict ABI decoding requires four WorkerHired topics, including the indexed decision ID, and empty event data.
It checks event task/model, decision-topic encoding, log block/position, transaction hash, and removal state.
A stale index, absent hire, nonzero Hired payee, or unknown board refuses preflight.
These checks prove provisional chain observations, not final settlement.

Preflight checks the signed root reservation and actual database accounting.
It writes an exclusive protected preflight journal before returning a process-local ticket.
No credential is necessary for preflight.
Root supplies `OpenAIReservedProviderAdapter` only after preflight succeeds.
A missing real hire remains a refusal; no fixture hire can establish protocol proof.

The exact full prompt must fit 4096 input tokens under the reviewed byte-plus-1024-overhead policy.
The output ceiling is 256 tokens, including reasoning under the adapter contract.
The exact maximum reservation is 13312 micro-USD.
A policy change or larger prompt refuses this trial.
OpenRouter has no trial adapter here and retains its separate cumulative cap.

The run consumes its process-local ticket before asynchronous work.
It repeats eligibility checks and verifies that the canonical admission service uses the same database identity.
It calls actual execution admission, envelope approval, proxy reservation, and the isolated-process coordinator.
Protected immutable journal files record start, attempt, call, and receipt phases before the corresponding next operation.
The bearer capability stays in host memory and never enters the journal or child.
The receipt journal stores identifiers, actual charge, and a text hash, not raw provider text or credentials.

Restart inspection reads actual calls through the saved execution authority and prompt hash.
It never reconstructs a capability or automatically resumes a started run.
A crash between admission/reservation and journal persistence requires root inspection through the saved authority/task identity.
Uncertain dispatch remains fully held until the existing reconciliation path supplies evidence.
This trial performs computation only; it does not upload or sign a BrainChain delivery.

PARITY: Both avatar types use the same execution and budget services. Root approval remains external owner authority, never an agent-minted permission.

## Store and trial evidence

Linux tests run in the pinned Bun image with network none, a read-only root, UID10002, dropped capabilities, and a private tmpfs.
They verify publication, restart, unsafe paths/modes/links, concurrent publishers, oversized reads, and actual child-process crashes before and after publication.
The filesystem tests use explicitly controlled empty-accounting fixtures.
Separate PostgreSQL tests read actual local envelopes and calls and reject unresolved or mismatched terminal reconciliation.
The trial tests verify the exact price ceiling, oversized prompts, Windows refusal, and missing-hire refusal inside Linux.
A positive contract-shaped preflight uses the actual chain parser, an unused current authority fixture, and an ephemeral signed root reservation.
It reaches a protected preflight journal without a provider credential or invocation.
Mismatch cases reject nonzero Hired payee, malformed hire evidence, changed task/model, invalid authority, and invalid root signature.
Its database and RPC transports are controlled fixtures; it proves admission reachability, not a live hire.
No positive paid trial or owned live hire is claimed.

Drift note: T1/T2 correction requires zero Hired payee and the pinned four-topic WorkerHired event. No live authority is provisioned.
