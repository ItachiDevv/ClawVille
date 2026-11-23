# Protected root store and paid trial review

Last Audited: 2026-11-09

Verdict: T1 and T2 resolved within the reviewed preflight scope. The protected store has no confirmed blocker in this review. Neither verdict authorizes credentials, real ledger provisioning, or a paid call.

## T1: Hired payee check rejects genuine hires

The pinned release 3.5 TaskBoard sets `task.payee` inside `submit`, at source line 304. The Hired state precedes this assignment. Its payee remains the zero address. `paid-trial.ts` instead requires the Hired payee to equal the worker address. That condition rejects the genuine pre-submit state.

Check the Hired zero payee and exact worker model. Keep account ownership and current task evidence checks. Do not infer a pre-submit payee from a post-submit invariant.

## T2: WorkerHired topic count rejects genuine event evidence

The same pinned TaskBoard declares `WorkerHired(uint256 indexed id, bytes32 indexed model, uint256 indexed decisionId)` at line 133. Three indexed arguments plus the event selector produce four topics. Trial eligibility requires exactly three topics. It therefore rejects genuine WorkerHired evidence even after T1 changes.

Use strict event decoding with the pinned ABI. Check task, model, decision ID encoding, exact log position, transaction hash, block number/hash, removal state, and data shape. Do not accept a shortened event as a substitute.

Root and the owner received both blockers. The correction now requires zero payee and strictly decodes the four-topic event with the pinned ABI. It checks empty data, exact stored block number/hash, transaction hash, log index, removal state, task ID, model, and canonical decision ID encoding. The shared ABI now correctly marks decisionId indexed.

The reviewer rebuilt and reran the actual Linux trial suite: 4 passed, 1 skipped, 237 assertions. The positive fixture passes through the real RPC envelope, block, task, and log parsers, the real eligibility checks, signed root-history verification, reservation verification, and protected preflight journal write. Transport responses and SQL rows are controlled. The fixture creates only an ephemeral signed root store on private container tmpfs. It does not replace eligibility or construct a provider credential.

Negative fixtures reject wrong payee/model, missing or extra topics, malformed decision encoding, nonempty data, altered task/model/block/hash/transaction/log position, removed logs, revoked/expired/consumed authority, and a corrupt root signature. The separate chain-reader and earnings regression run passed 13 tests and 90 assertions, including the corrected event ABI.

## Protected store observations

The store pins job, Ed25519 public key, and genesis hash. Signed history and head checks share the existing budget verifier. Publication uses an exclusive local lock, an expected-head comparison, retained signed revisions, exclusive history writes, file synchronization, and atomic head rename. A competing revision or stale head refuses. A crash can leave a lock that requires explicit root recovery; the code does not delete an unknown lock automatically.

File reads reject symlinks, hardlinks, foreign owners, unsafe modes, excessive size, invalid UTF-8, and file identity or metadata changes during the read. Read operations have time bounds. The runtime receives no signing capability from this store. A privileged host can still roll back the head and pins; that threat remains outside the stated trusted-host model.

Publication reconciles actual database budget, envelope, and call rows. It compares reserved, uncertain, and settled totals. A terminal reservation requires a closed envelope and the exact reconciliation identifier and charge. Unresolved liability cannot release. Separate OpenAI and OpenRouter caps remain in the signed-history verifier.

## Trial observations

The trial bounds one request at 4096 input tokens, 256 output tokens, and 13312 micro-USD. It accepts an in-process single-use ticket. Durable preflight and started records prevent automatic restart dispatch. Execution authority and proxy reservation still enforce their own one-use rules. A restart reads accounting only. The correction demonstrates reachable preflight, not a paid run.

## Independent test evidence

- Windows and actual PostgreSQL suites: 16 passed, 6 skipped, 55 assertions.
- Actual Linux protected-store suite: 4 passed, 3 skipped, 22 assertions.
- Actual Linux trial suite: 2 passed, 1 skipped, 6 assertions.

Both Linux runs used UID 10002, a read-only root, no network, dropped capabilities, and a private tmpfs in the pinned Bun image. The kernel reported unavailable swap limits. The store crash tests use a controlled empty database facade. Separate PostgreSQL tests cover accounting reconciliation. The trial Linux test covers missing-hire refusal only, not successful admission.

All test containers used automatic removal. No actual credential, production root ledger, payment reservation, live RPC, or paid provider call occurred. The correction fixture does not prove actual hire availability, real database-to-chain agreement, or successful provider execution. Paid activation remains outside this approval.
