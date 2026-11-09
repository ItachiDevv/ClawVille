# BrainChain backend contract

Last Audited: 2026-11-09. Team: brainchain-office. Status: public adapter and durable identity implementation await independent review and migration validation.

Drift note: partner knowledge describes Solana exits; fresh mainnet observations still return 404.

## Implemented public surface

`apps/api/src/routes/brainchain.ts` exports `brainchainRoutes` for the `/api/brainchain` mount.
GET `/knowledge` returns the deterministic manual, its SHA-256, curriculum version, sections, networks, and reviewed capability declarations.
GET `/status` returns declarations separately from timestamped observations.
Declarations describe research; observations describe individual HTTP responses.
Neither grants execution authority.

The adapter calls three fixed endpoints: mainnet and testnet exit terms, and the mainnet unpaid task challenge.
The challenge uses POST with an empty JSON object and no payment header.
No caller URL or partner response URL can control a request.
Each request validates public DNS and rejects redirects.
Each request has a five-second deadline covering DNS, headers, and body reads.
JSON bodies have a 32 KiB streamed limit; challenge headers have a 32 KiB encoded limit.
Schema projection removes partner prose, executable extras, and unknown fields.
Public responses contain sanitized failure categories, never raw errors.
The status service coalesces concurrent callers and caches successful and failed observations for 60 seconds.
Routes limit requests to 60 per minute per IP.
Testnet exit terms identify Robinhood testnet payouts; they do not prove Solana payouts.
An advertised payment offer does not prove payment compatibility or authorize signing.

PARITY: human path: Office panel public reads; agent path: the same public reads; no settlement occurs in this adapter.

## Proposed durable schema: review before implementation

Use additive, repeatable SQL in the next unallocated numbered migration.
The current highest inspected migration is 0099; recheck before allocation.
Mirror every SQL constraint in the Drizzle schema.
Do not use a new environment flag to authorize money.

### Worker bindings

`brainchain_worker_bindings` needs:

- UUID primary key; avatar foreign key with restricted deletion.
- Environment enum (`testnet`, `mainnet`), chain ID, normalized EVM address, immutable contract-set hash.
- Custody enum (`external`, `isolated-testnet`); opaque signer reference for isolated testnet only.
- Verified proof hash, verified timestamp, requested lifecycle state, observed eligibility, observed block and timestamp.
- Created and updated timestamps; optional retired timestamp.

The pilot permanently permits one binding per avatar and environment.
The pilot permanently reserves each worker address per environment to its original avatar, including after shutdown.
No retirement, transfer, change-address, or delete API exists in this first implementation.
Retirement preserves prior tasks, receipts, and binding ownership.
A binding change cannot transfer old task credit or recovery rights.

### Wallet proof challenges

`brainchain_binding_challenges` needs nonce hash primary key, avatar ID, environment, chain ID, address, message hash, expiry, consumed timestamp.
The server constructs an EIP-191 message with domain, purpose, avatar, network, address, nonce, issued time, and expiry.
Verify the exact stored message with `viem` EIP-191 recovery.
Never verify a client-supplied replacement message.
Consume the challenge and create the binding in one transaction.
The same nonce cannot bind twice, even across API replicas.
Use a two-minute expiry and bounded per-avatar challenge issuance.
Require the standard bound-session resolver on issuance and consumption.
Reject agents whose session lacks ledger capability.
Fresh proof grants address association only; it grants no stake, loan, spend-cap increase, or signing authority.
Support external EOAs first. Contract-wallet proof needs a separate verified ERC-1271 design.

### Tasks and attempts

`brainchain_worker_tasks` needs UUID, binding ID, avatar ID snapshot, environment, chain ID, contract-set hash, board address, task ID.
Add public brief hash, task state, protocol deadline, observed block hash and number, lease owner, lease expiry, and timestamps.
Unique `(chain_id, board_address, task_id)` prevents duplicate ownership across manifest upgrades.
The contract-set hash remains an immutable evidence snapshot, not a uniqueness escape.
Only a verified chain hire event assigns a task to the worker.
Use block confirmation and rewind handling before treating an event as final.

`brainchain_task_attempts` needs UUID, task foreign key, attempt number, state, lease owner, deadline, model-cost reservation reference.
Add input hash, delivery hash, bounded output reference, submission transaction hash, failure category, and timestamps.
Unique `(task_id, attempt_number)` preserves retries under one task.
Every lease renewal and state transition compares its owner token.
After a crash, inspect the existing submission receipt and delivery hash before another submission.
Do not assume an expired lease proves no transaction exists.

### External operations and receipts

`brainchain_operations` needs UUID, avatar ID, environment, operation kind, canonical request hash, idempotency key, binding ID.
Add endpoint enum, state, network, asset, integer amount, recipient, destination, fee bounds, grant version, and spend reservation reference.
Persist signed authorization reference and transaction hash before broadcasting.
Add partner order ID, task ID, reconcile count, next reconcile time, lease owner, lease expiry, and timestamps.
Unique `(avatar_id, environment, operation_kind, endpoint, idempotency_key)` rejects request-hash conflicts.
Never reuse a key for different request bytes.
An unknown outcome keeps the original reservation and authorization.
The buyer order state remains separate from the protocol task state.

`brainchain_receipts` needs UUID, operation/task reference, chain ID, transaction hash, log index, asset, integer amount, recipient.
Add block number, block hash, confirmation count, receipt kind, verification timestamp, and verifier version.
Unique `(chain_id, transaction_hash, event_locator)` prevents duplicate economic effects.
For EVM receipts, the event locator is the log index.
Solana receipts need a verified instruction and inner-instruction transfer locator before that money path exists.
Receipts contain public transaction evidence, not signer secrets.
Balances distinguish stake, unlocked stake, pending income, settled income, and destination funds.
Destination funds become spendable only after destination receipt verification.
No receipt directly mints CT or leaderboard points.

## Isolated testnet runner authority

Run cognition outside the API process through the existing ElizaOS runtime.
The first task mode accepts bounded text and has no shell tools.
The executor receives only task ID, sanitized brief, deadline, and explicit output limits.
It receives no API credentials, wallet keys, signer socket, Docker socket, or ambient host environment.
Treat the brief as untrusted data within the task prompt.
Never include unrelated agent memories or private world conversations.

A separate signer service owns one dedicated testnet key.
Its key never enters the model process, task filesystem, API response, or database row.
The API stores an opaque signer reference only.
The signer checks actual RPC chain ID, pinned contract set, permitted methods, decoded calldata, value limits, and operation ownership.
Reject mainnet unconditionally in this pilot signer.
Do not trust a caller-provided chain label or arbitrary transaction payload.
Persist authorization and transaction identity before any broadcast.
Use restricted local IPC or mutually authenticated service access; tasks cannot reach it.
Gas, stake, bond, and compute budgets remain separate.

Pause disables new local task acquisition.
Drain preserves accepted tasks until their terminal protocol states.
Show on-chain hire eligibility separately until a supported protocol control proves its change.
Shutdown cannot promise to stop on-chain hiring merely because the process stopped.
Recovery starts by reconciling leases, existing receipts, and delivery hashes.

## Required reconciler checks

- Human and ledger-capable bound agents resolve the same avatar; request bodies cannot choose another avatar.
- Challenge replay, expiry, wrong chain, wrong address, wrong avatar, and cross-process races fail.
- Binding retirement preserves old task ownership and recovery.
- Duplicate hires, duplicate leases, stale owners, and crash-after-broadcast do not duplicate work or payments.
- Timeout retains the original spend reservation; retry cannot create fresh authority.
- Hostile task data cannot obtain signer material or invoke shell tools.
- Mainnet is unreachable through the testnet signer, including an RPC chain-ID mismatch.
- Public reads never expose private order bodies, raw errors, or another avatar's records.

## Current verification

The adapter suite runs with `bun test apps/api/src/services/brainchain/public-client.test.ts`.
It covers schema projection, DNS denial, redirects, 404, numeric bounds, streamed limits, DNS timeout, unsigned challenge parsing, and cache coalescing.
The route suite checks public human/agent content equality, exact manual hash, rate limits, and sanitized capability failures.
Both suites passed on itachi222: 13 tests, 102 assertions, including cancellation of a stalled response stream.
The actual adapter ran at 2026-11-09T13:24:02Z and observed three EVM payment offers, mainnet exit HTTP 404, and testnet exit HTTP 200.
The testnet terms specified payout chain 46630. The call sent no payment authorization.
## Implemented durable identity phase

Migration 0100 and its Drizzle schema define worker bindings and persistent proof challenges only.
They check chain/environment pairs, normalized nonzero addresses, hashes, states, and challenge lifetimes.
The binding owner tuple supports composite foreign keys when tasks and operations arrive.
Those later tables do not exist yet; their proposed constraints above remain requirements.

GET `/api/brainchain/workers` lists only the resolved avatar's binding records.
POST `/api/brainchain/workers/challenge` accepts only environment and address.
POST `/api/brainchain/workers/bind` accepts only nonce and EIP-191 signature.
Challenge issuance uses a database advisory lock and a five-per-minute avatar limit.
Verification admits at most five attempts per challenge through an atomic database update.
The server reconstructs the exact stored message before verification.
Final consumption compares all proof fields and database wall-clock expiry in the same transaction as binding creation.
It uses `clock_timestamp()` because PostgreSQL `now()` keeps the transaction-start time during lock waits.
A binding conflict rolls back challenge consumption; the admitted verification attempt remains counted.
Fresh proof for the same address refreshes verification without increasing authority.

POST `/api/brainchain/workers/:id/control` accepts only paused or draining requested states.
The update includes the resolved avatar in its database predicate.
It changes no on-chain eligibility or signing authority.
Observed eligibility stays null until a separate verified chain reader exists.

POST `/api/brainchain/install` upserts the exact code-generated curriculum and calls the existing agent-scoped installer.
It returns the installer status and canonical `sha256:` content hash.
The existing hosted installer may require embeddings; authorized execution must account for that provider cost.
Every private route resolves human or bound-agent identity, checks ledger capability, and rejects guest owners.
No request body controls an avatar ID.

PARITY: human path: authenticated Office controls; agent path: identical bound-session routes; all private records bind to the resolved avatar.

The crypto suite signs real EIP-191 test messages and rejects changed wallet, purpose, domain, avatar, nonce, chain, and expiry.
Migration 0100 ran twice on the authorized isolated PostgreSQL fixture at loopback port 55439 on itachi222.
Six real database tests passed with 22 assertions: proof races, ownership isolation, expiry after lock waits, constraints, issuance limits, and curriculum downgrade refusal.
The fixture uses its own database and minimal prerequisite tables; it does not prove staging schema compatibility.
Run it separately with `BRAINCHAIN_DB_FIXTURE=1` and the job-local fixture cluster.
No staging or production migration ran. Runtime installation and full live agent-session integration still need evidence.
Four HTTP composition tests passed with 12 assertions, using real cookie middleware and controlled identity backing.
Worker execution, signing, payments, and recovery remain implementation work.

## Local database fixture handoff

### Independent review corrections

The private route now runs canonical Lucia session hydration before identity resolution.
The router mounts before the global JSON parser and reads no more than 4 KiB before authentication.
Its HTTP regression rejects oversized chunked requests before the global parser runs.
Normal JSON uses Hono's body cache; malformed JSON returns 400.
The cookie regression uses real Lucia and session middleware with an in-memory session adapter.
Its identity backing and service calls remain controlled fixtures, not proof of the full live agent resolver.

The database expiry regression holds the binding advisory lock beyond a short proof lifetime.
Final consumption rejects that proof through `clock_timestamp()`, and the challenge remains unconsumed.
The real database suite now passes six tests with 22 assertions.

The Office installer opts into complete hosted-section readback under the existing installer lock.
Partial or silent persistence returns an explicit error while retaining valid sections for retry.
Other installer callers retain their previous behavior.
The wrapper rejects a returned content hash that does not match its declared curriculum version.
The new strict tests plus the existing installer suite pass 20 tests with 45 assertions.
Consumption remains separately unverified; complete storage is not proof that the deciding model used the text.

Machine: itachi222. PostgreSQL 18.6 listens only on `127.0.0.1:55439`.
The inspected process PID is 71056; recheck it before any process action.
The cluster lives in the ignored `.brainchain-work/postgres-data` directory inside this registered job worktree.
Its separate database is `brainchain_fixture`; it has no production or staging data.
The test harness reads its job-local password file privately. Never print that file.
The fixture role owns only this isolated cluster; it is not an application production role.
The reviewer can keep the cluster alive for repeat tests.

Run these commands from the job worktree on itachi222:

```powershell
$pgBin = 'C:\Users\itachi\scoop\apps\postgresql\current\bin\pg_ctl.exe'
& $pgBin -D .brainchain-work/postgres-data status
$env:BRAINCHAIN_DB_FIXTURE = '1'
bun test apps/api/src/services/brainchain/bindings-db.test.ts
Remove-Item Env:BRAINCHAIN_DB_FIXTURE
```

The fixture suite must run separately because it configures the database singleton before importing the service.
If the cluster is stopped, first verify port 55439 is free, then start the existing cluster:

```powershell
& $pgBin -D .brainchain-work/postgres-data -l .brainchain-work/postgres.log -o '-h 127.0.0.1 -p 55439' -w start
```

After the independent review finishes, stop only this cluster:

```powershell
& $pgBin -D .brainchain-work/postgres-data -m fast -w stop
```

Preserve the fixture files until the lead authorizes cleanup.
Do not remove a different PostgreSQL service, database, or directory.

Latest checks: database package build passed; full API typecheck passed; 16 ordinary tests passed with 124 assertions.
The separate real database suite passed six tests with 22 assertions.
PowerShell labels Bun's script banner on stderr as a native-command message; the typecheck process returned exit code zero without TypeScript diagnostics.

## Phase 2: pinned reads and durable recovery observations

Last audited: 2026-11-09. Drift: migration 0101 adds observations and recovery leases, without a signer or task runtime.

The fixed manifest includes current release 3.5 and retired board addresses with their deployment blocks.
The reader checks the actual chain ID before observations and verifies contract code at the observation block.
Only read-only RPC methods exist. Fixed RPC hosts pass outbound DNS checks; redirects and arbitrary hosts are rejected.
Each response has a 1 MiB limit. Each RPC has a five-second deadline within a 30-second reader session.
The provisional observation block is head minus 12. This margin does not prove parent-chain finality.
Snapshot responses include block age, raw atomic balances, stake, unstaking, unlock time, held bonds, and contract terms.
The snapshot cache coalesces by stored environment and address for 30 seconds, with a 256-entry bound.

The private routes are:

- `GET /api/brainchain/workers/:id/snapshot`: stored-address contract snapshot, with `provisional:true` and `blockAgeSeconds`.
- `GET /api/brainchain/workers/:id/tasks`: latest 100 stored tasks, canonical status, hire evidence, and observation block.
- `POST /api/brainchain/workers/:id/sync`: one explicit bounded scan; returns `observed` or `reorg_suspended`.

All routes resolve the bound avatar before the service reads its worker row.
No request accepts a worker address, RPC URL, event payload, or owner identity.
Chain read failures return `chain_read_unavailable` with 503; cursor conflicts return `task_state_conflict` with 409.
No scheduler starts. Concurrent scans coalesce per worker, with at most 16 active scans per API process.
Each scan handles at most 2,000 blocks, 25 new hires, and 25 prior tasks on one board.
Dense log ranges shrink before the cursor advances. Retired boards rotate through the same read path.

Migration 0101 reserves task identity by chain, board, and task number.
Composite foreign keys bind each task, attempt, and cursor to its original avatar and worker.
Immutable triggers prevent worker or task ownership replacement.
Checkpoint and hire-block mismatches suspend tasks, invalidate lease generations, and rewind the board cursor.
Reorg recovery retains task identity and attribution. Replacement hire evidence also invalidates prior recovery leases.
Recovery attempts use a unique task/attempt number, unique generation, random owner token, and 60-second database lease.
Expired or foreign owners cannot finish a recovery attempt. These internal leases grant no spend or signer authority.

Evidence on 2026-11-09:

- `chain-client.test.ts`: four tests and 54 assertions passed for decoding, chain mismatch, response bounds, DNS, redirect, and timeout rejection.
- `tasks-db.test.ts`: six real PostgreSQL tests and 34 assertions passed for duplicate events, lease races, composite ownership, and reorg suspension.
- `bindings-db.test.ts`: six real PostgreSQL tests and 22 assertions passed after migration 0101's immutable triggers.
- The combined public, proof, and RPC suite passed 21 tests with 182 assertions.
- The isolated HTTP composition suite passed five tests with 25 assertions, including human and agent paths for all three worker-read routes.
- Full API typecheck returned exit zero after the tuple validation correction.
- `docs/research/brainchain-2026-11-09/worker-read-probe.json` contains unsigned real RPC evidence at 14:08 UTC.

The real probe decoded `get(0)` for all nine current and retired boards across both chains.
It read testnet stake terms at block 5086: 500 BRAIN minimum, 100 BRAIN bond, and 7,200-second timelock.
That provisional block was 22,788 seconds old. This evidence does not establish task execution readiness or current chain liveness.
The bound fixture probe at 14:10 UTC exercised the actual stored-address service and a real RPC scan into PostgreSQL.
It scanned blocks 2288 through 4287 and stored the checkpoint with zero hires.
Evidence: `docs/research/brainchain-2026-11-09/bound-worker-read-probe.json`.

Run task tests separately from other suites so the fixture sets the database singleton before service imports:

```powershell
$env:BRAINCHAIN_DB_FIXTURE = '1'
bun test apps/api/src/services/brainchain/tasks-db.test.ts
Remove-Item Env:BRAINCHAIN_DB_FIXTURE
```

A second loopback database, `brainchain_full_schema`, tests source-schema coexistence.
Offline Drizzle generation excluded BrainChain and produced 164 baseline tables.
The baseline required the existing `wager_lobby_id_seq` prerequisite, as documented by the repository bootstrap script.
Migrations 0100 and 0101 each applied twice, leaving 169 tables.
The ignored fixture artifacts are `.brainchain-work/baseline-schema.ts`, `baseline-drizzle.config.json`, `baseline-generated`, and `full-schema-fixture.ts`.
The bootstrap refuses a nonempty database. It does not overwrite prior evidence.
This check does not prove historical migration replay, Eliza schema compatibility, production data backfill, or target migration permissions.
The gated migration chain starts from an existing application baseline; migration 0001 cannot initialize an empty database alone.

PARITY: human path uses authenticated Office routes; agent path uses the same routes with the bound agent session; ownership binds to the canonical avatar resolver.
The next boundary requires independent review before any signer, task cognition, automatic scheduler, or chain write.

Phase 2 review corrections: the cursor now has a monotonic epoch.
Every batch compares the epoch captured before RPC reads and increments it on persistence.
Suspension increments the epoch even when it creates the first cursor.
A pre-reorg batch cannot reuse the rewound block number to restore canonical tasks.
The direct observation ingestion helper was removed; all persistence uses the epoch fence.
Database checks require both checkpoint fields or neither and enforce uint256 task IDs and uint128 bounty bounds.
Snapshot responses expose `executionEligible:false` and an explicit stale/recent state with a 120-second freshness threshold.
Historical reads remain available; stale observations grant no execution authority.

## Phase 3: inactive testnet signer records

Last audited: 2026-11-09. Drift: migration 0102 adds internal signer records without process activation.

The signer policy prepares only faucet, bounded allowance, stake, own-worker application, drain, and withdrawal intents.
Every intent uses chain 274630, zero native value, the permanently bound address, and fixed contract destinations.
The application embeds only `setWorkerAllowed(ownAddress,true)` in the pinned bonds proposal.
Profiles contain a bounded name and description in canonical base64 JSON.
The intent hash binds the exact canonical request; gas authority is separate and single-use.
The policy checks current balances, allowances, terms, application state, faucet interval, held tasks, and withdrawal time.
Evidence older than 30 seconds, or a block older than 120 seconds, cannot enter preparation.

The source snapshot currently lacks approved deployed-artifact equivalence.
`assertSignerArtifactAdmission` unconditionally rejects capture and broadcast before key, storage, database, or network access.
The lead owns independent compilation and immutable-slot verification.
A measured code hash or ABI decode alone cannot open this condition.

Migration 0102 creates three internal tables:

- `brainchain_signer_streams`: one dedicated signer reference per permanently owned testnet address, generation, next nonce, and stopped state.
- `brainchain_signer_authorities`: immutable, expiring owner-issued request or gas authority; revocation cannot be reversed.
- `brainchain_signer_operations`: frozen intent, unique idempotency request, unique authority usage, unique address/nonce, protected payload reference, and transaction hash.

Preparation requires preexisting authority rows. No HTTP route issues those rows or provisions signer references.
The current implementation admits no task delivery or result signature; these require future execution-purpose authority.
Recovery-only task leases remain insufficient.

Nonce reservation serializes binding, signer stream, and operation records.
Only one unresolved nonce can exist in a stream.
A repeated reservation returns the same operation and nonce; different intents cannot claim that nonce.
An unexplained canonical or pending nonce change commits a stopped stream before returning refusal.
Clock checks occur after locks. Stream generation changes invalidate unaccepted operations.

The capture coordinator accepts only an operation ID and trusted process adapters.
It loads a dedicated key reference, validates the driver's address, and compares every signed transaction field with the frozen intent.
It commits `accepting` and `accepted_at` before key use, then claims the operation in the protected journal.
Ambiguous key use retains the nonce and never permits another automatic signature.
Payload persistence and exact readback precede broadcast. Recovery reads the operation journal without calling a key.
The database stores no key or signed bytes. Only an opaque payload reference and transaction hash enter operation records.
The broadcaster marks uncertainty before transport and uses only the captured bytes.
Timeouts retain nonce and gas liabilities. No fee replacement or nonce cancellation exists.

Current evidence:

- Pure policy and closed-admission suites: six tests with 43 assertions passed.
- Real PostgreSQL signer suite: seven tests with 29 assertions passed, including nonce races, lock-wait expiry, and late capture recovery.
- Isolated capture fault test: one test with eight assertions passed. A separate database connection observes acceptance before the mock driver call.
- The capture fault test mocks only artifact admission. No private key or signing API is used.
- The full source-schema fixture accepted migrations 0101 through 0104 twice, leaving 176 tables.

These database checks do not prove signing, process isolation, receipt reconciliation, or broadcast recovery.
No signer key was loaded. No transaction was signed or broadcast.
The artifact gate remains closed. The concrete key driver and fixed broadcast transport require independent review and process integration.
The Linux protected journal requires a dedicated non-root UID, mode 0700 directory, and mode 0600 files.
It fsyncs payloads and directory entries, then publishes operation claims and payload references without overwrite.
The lead verified separate container write/read phases against one persistent volume using fake bytes and UID 10001.
This proves process restart persistence, not host reboot or power-loss durability.
`BRAINCHAIN_SIGNER_STORE_TEST_ROOT` selects only the private fixture directory for journal tests and the restart probe.
Result upload signatures and settlement evidence remain required increments.

The lead's deployment evidence now identifies release 3.5 source commit `348cc3726227a9a321d7593fd0e685904901d31e`.
It matches executable code after metadata exclusion and immutable-slot verification; metadata hashes remain different.
The newer `0ba4bfc278c50fcc8ffcbaca3772120170946f24` TaskBoard source does not match the deployed release.
`signer-code-evidence.ts` records the evidence digest and full observed runtime hash for each of five direct contracts.
Runtime admission compares full bytecode hashes, including metadata. It does not mask bytes during admission.
Independent approval remains absent, so capture and broadcast still reject before any side effect.

## Phase 4: bounded execution admission

Last audited: 2026-11-09. Drift: migration 0104 adds single-attempt execution authority and immutable attempt fences.
`execution.ts` exposes only the trusted internal `claimExecutionAttempt` coordinator function.
Root-issued authority binds one task, avatar, binding, next generation, onchain brief hash, input SHA256, and complete prompt SHA256.
It expires within ten minutes and cannot be widened or reused. It grants no signing or payment authority.
Admission requires a canonical Hired testnet task, matching observed block, fresh evidence, and internal worker state `running`.
Human and agent pause/drain routes retain the same avatar resolver. They cannot issue authority or set `running`.
The lease expires at the earliest authority expiry, chain deadline, or sixty seconds.
Admission rechecks database time after locks. Reorg suspension invalidates execution attempts and retains task attribution.
Recovery cannot replace a live execution attempt. Attempt owner, generation, hashes, deadline, and authority remain immutable.
Real PostgreSQL admission tests pass: four tests, sixteen assertions, including concurrent claims and expiry after a lock wait.
PARITY: human and bound-agent pause/drain controls use the same worker owner; the internal pilot coordinator exposes no separate user authority path.

## Concrete signer adapters

Last audited: 2026-11-09. Drift: concrete Linux custody and fixed testnet RPC adapters now exist under the closed activation gate.
`signer-linux-driver.ts` accepts a fixed reference, filename, and expected address registry from the trusted signer process.
It never reads the keyring or environment. The key directory must belong to the dedicated non-root Linux UID with mode 0700.
Key files must have mode 0600, one link, the same UID, and exactly 64 hexadecimal characters.
The driver opens files with `O_NOFOLLOW`, checks the open descriptor, verifies the derived address, and clears its byte buffer afterward.
JavaScript strings and library internals cannot guarantee complete secret erasure; process isolation remains mandatory.
The driver permits only typed testnet methods and fixed destinations. It rejects extra transaction fields and general proposals.
It copies and freezes transaction fields before the first await, then validates, hashes, signs, and verifies only that copy.
Latin-1 decoding preserves high bits so the hexadecimal parser rejects byte aliases.
Key access requires the closed activation check and a matching durable coordinator claim.
A second driver claim prevents repeated key use. Captured bytes persist inside the driver before return, including after caller timeout.
Replay verifies the frozen transaction and recovered address without opening the key file again.

`signer-rpc.ts` exposes fixed testnet chain verification, nonce reads, exact-byte broadcast, and receipt observation.
It accepts no runtime URL, credentials, replacement transaction, or retry policy.
Each RPC has a five-second ceiling and a 256 KiB response limit; compound checks have a bounded deadline.
Broadcast checks chain 274630, fresh head, and all five pinned direct-contract bytecode hashes before one submission.
It rechecks head age after code verification and after URL validation immediately before submission.
Mutable dependencies and additional contract artifacts remain separate activation requirements.
Receipt reads verify transaction identity and canonical block hash twice. Inclusion always remains provisional.
`observeSignerReceipt` returns `finalized:false`; missing or orphaned receipts retain captured bytes, nonce, and uncertain state.
No confirmation count releases authority or proves parent-chain finality.

Local evidence: adapter restriction/RPC suites pass eleven tests with 117 assertions; signer database tests pass seven tests with 34 assertions.
An isolated RPC fault suite passes one test with 43 assertions, including exact-byte submission, no blind retry, and expiry during code reads or URL validation.
The isolated Linux synthetic-key fixture requires a separate test process and mocks only the activation function after testing the real closed gate.
It never uses credentials or sends a network request. Its result is separate from activation approval.
The actual Linux synthetic-key test passed one test with fourteen assertions; evidence lives in `docs/research/brainchain-2026-11-09/signer-linux-driver-evidence.md`.

## Phase 5: immutable results and delivery preparation

Last audited: 2026-11-09. Drift: migration 0105 adds private frozen results and single-use upload claims.
The [official worker adapter](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/chain.ts) verifies the result-v2 signature format and POST `/results` body.
The [worker instructions](https://docs.usebrainchain.com/run-a-worker) require a separate upload for each task and exact use of the returned URI.
Release 3.5 TaskBoard source verifies `submit(id,hash,uri)` requires the hired worker, Hired status, and an unexpired task deadline.
Historical current-board events establish the observed URI form in `docs/research/brainchain-2026-11-09/result-uri-observations.json`.
The adapter pins that form and fails closed if the partner changes it.

`task-delivery.ts` reads settled compute output directly from PostgreSQL; callers cannot supply replacement output.
Composite foreign keys bind the result to its task, attempt, worker, avatar, generation, lease owner, prompt, and compute call.
Only one result exists per task, attempt, and call. Exact UTF-8 text, SHA256, and Keccak hashes remain immutable.
The pilot caps output at 32 KiB and rejects invalid Unicode or NUL rather than changing bytes.
Freezing requires a current execution fence and rechecks wall time after locks.
Replay after lease loss only reads the original result. It never computes new text or restores authority.

Upload authorization exposes the exact typed message for a future reviewed signer; it creates no signature.
The coordinator verifies a supplied internal signature against the bound worker and commits its upload claim before transport.
The fixed testnet transport rejects redirects, limits replies to 8 KiB, and imposes a five-second deadline without retries.
Response hash and exact `/records/<hash>.txt` URI must match the frozen bytes. No returned URI is fetched.
Ambiguous upload outcomes remain durable and cannot trigger another upload automatically.
A process crash after dispatch but before response persistence needs external recovery evidence; the coordinator does not invent retry semantics.
No raw output enters telemetry, public knowledge, or agent memories.

Submission preparation requires verified upload, current ownership/generation, and fresh matching task observation.
It stores exact zero-value testnet submit calldata and returns `signingAvailable:false`.
Phase 6 extends the inactive signer with typed upload signing and submit authority; independent review remains required.
Retired-board records remain readable. The result service adapter admits only the current testnet board until retired-board upload support is verified.
The production activation gate blocks uploads. Controlled tests mock that gate only within separate test processes.
PARITY: no public write route is added; future human and agent delivery controls must share the existing bound-avatar resolver.

Local PostgreSQL delivery tests pass eight tests with 42 assertions. Protocol tests pass three tests with 41 assertions.
These tests cover concurrent freeze/upload claims, immutable bytes, foreign ownership, ambiguous transport, reorg suspension, and expiry during lock waits.
The initial delivery API typecheck exited zero before concurrent earnings edits. The current-source full-schema fixture applies migrations 0101–0105 twice and retains 177 tables.
That fixture proves additive coexistence and rerun behavior; it does not prove historical production migration replay.
No test sends a live upload or authorizes a signer. Independent review remains required for this increment.

D1 correction rechecks the full execution fence after the result-row lock and after each claim/preparation update.
Upload also rechecks authority after claim commit before it calls transport. A refusal after commit retains uncertainty without dispatch.
Separate PostgreSQL tests hold the result row across expiry for upload and preparation; both refuse without a committed action.
Revoked authority and generation loss also refuse actions while preserving private result reads.
The original independent lock probe now returns `prepared:false` with `Current settled execution fence required`.
The correction typecheck reports no delivery diagnostics, but concurrent earnings changes prevent a full API pass until their owner resolves them.

## Phase 6: typed result signatures and submit authority

Last audited: 2026-11-09. Drift: migration 0106 adds result-signature acceptance and immutable submit ownership.
The root grants a separate `result-signature` authority over the exact domain, result identity, task, hash, worker, and key reference.
Its amount must equal zero. The coordinator reads output identity from the settled result and commits acceptance before journal or key access.
Concurrent requests recover one accepted operation. A timeout, process interruption, or missing capture never permits another signature attempt.
The driver accepts a typed result object, constructs the fixed result-v2 message, and verifies the recovered worker address.
It snapshots primitive fields before any await and checks current execution authority after journal work and private file reads.
Signature bytes use strict ASCII hex, a separate `result-v2-` journal namespace, and separate payload validation.
Transaction journal validation still requires EIP-1559 transaction bytes. Neither journal accepts the other payload type.
The driver stores the signature before return. PostgreSQL stores its opaque reference, never the signature or private key.

Submit requests bind result ID, task number, result hash, and exact verified URI to separate root intent and gas authorities.
An immutable relational link permits only one submit operation per result. Composite foreign keys preserve binding and avatar ownership.
Preparation, nonce reservation, capture acceptance, concrete key use, and broadcast admission check current execution/result authority.
The database function locks task, result, attempt, execution authority, worker, and settled compute evidence before its final clock check.
Fresh task observation must match the signer observation block hash. Mainnet and foreign board calls remain unavailable.
Accepted transactions retain their original nonce, bytes, hash, and liabilities through restart or revocation.
Read recovery can return captured evidence after lease loss. A submit broadcast requires the current fence; recovery never creates replacement bytes.

Cross-process revocation limitation: PostgreSQL locks end before the isolated process performs local cryptography or external transport.
The driver rechecks immediately before first signature construction, but revocation can still race after the callback returns.
Durable acceptance defines the prior authorization boundary; a later revocation cannot erase a signature that already exists.
No claim of atomic database revocation plus external signing is made. The activation gate remains false pending independent review.

Local evidence: real PostgreSQL delivery/signature/submit tests pass nine tests with 60 assertions.
They include concurrent acceptance, simulated interruption after protected capture, revoked authority, immutable links, nonce retention, and exact-byte recovery.
Existing signer database tests pass seven tests with 34 assertions; capture fault injection passes one test with eight assertions.
Pure signer/RPC tests pass seventeen tests with 160 assertions. Typed result/protocol tests pass five tests with 55 assertions.
The actual isolated Linux synthetic-key fixture passes one test with 27 assertions under the existing network-none policy.
The full-source schema fixture applies migrations 0101–0106 twice and retains 179 tables; this is not historical rollout evidence.
The latest API typecheck reports only concurrent root-compute-store return diagnostics; that owner has the errors.
PARITY: these internal modules expose no new public route. Future human and agent controls must use the same bound-avatar resolver.

S1 correction: result ownership reads inside transaction callbacks now use that transaction connection.
The signature authority helper and result helper share this read path; neither requests another pool connection.
Read-only PostgreSQL regressions pass four tests with 16 assertions for pool limits one and four.
The four-connection regression holds every transaction connection before it releases the owner-read barrier.
Capture regressions use forbidden signer/journal adapters and prove zero calls. Timeout remains a test failure.
The original independent pool probe now returns `refused` with `callback:false`, without its previous pool timeout.
Pure typed-result/protocol regressions pass five tests with 55 assertions. These correction checks use no signature construction or row writes.
The API typecheck exits zero after the correction.

## Phase 7: expiry-only delivery recovery

Last audited: 2026-11-09. Drift: delivery can now resume after compute expiry through a separate root grant and lease.
Migration 0107 stores the original hire snapshot with frozen output. Legacy results without that snapshot refuse recovery.
The snapshot binds board, task, worker model, expected payee, brief hash, hire block/hash, transaction hash and log index.
Release 3.5 TaskBoard.sol lines 297–307 set payee during submit. Hired has zero payee; Submitted must name the bound worker.
DeliveryRecovery compares that original snapshot with current canonical task evidence and a sequential final block check.
Grants bind one result, stage, owner, current task generation and immutable result hashes. Leases last at most 60 seconds.
Recovery never revives compute authority. Revoked compute authority, stopped signer, retired signer generation and replacement hire refuse.
Signature authority receives another database clock check after the recovery wrapper finishes its external evidence read.
Unknown uploads remain evidence-only. Accepted signatures without capture never repeat key use. Captured signatures recover without keys.
Broadcast recovery retains the original nonce, payload reference, transaction hash and gas liability. Matching Submitted records evidence without another send.
Database clocks run after locks and evidence waits. Cross-process revocation remains non-atomic with an external side effect after the final check.
The activation gate remains false. These modules expose no new route, scheduler, credential loader or live network write.
PARITY: future human and agent controls share bound-avatar ownership; these internal recovery grants confer no public spending authority.

Local evidence: recovery PostgreSQL suite passes 7 tests with 45 assertions. The independent signature-expiry reproduction passes 1 assertion.
The suite covers concurrent claims, restart, revoked authority, original hire replacement, result-lock expiry, captured-byte broadcast and operation-lock expiry.
It also covers first signature capture under expiry recovery authority, missing-capture refusal and captured-signature recovery without key access.
Controlled readers return evidence one second old to avoid Windows/fixture clock precision differences; production freshness checks remain unchanged.
The separate current-source schema fixture applies migrations 0101–0107 twice and contains 183 tables. This does not prove historical production rollout.

## Phase 8: explicit worker coordinator and concrete observation

Last audited: 2026-11-09. Drift: one host invocation now composes one explicit durable stage.
The coordinator calls concrete index, admission, inference proxy, isolated parent, freeze, signature, upload, submit and receipt services.
Explicit lifecycle stages also prepare, capture, broadcast and observe the existing typed faucet, approval, stake, apply, leave and withdraw intents.
The coordinator never issues root authority or budget. Its separate lock pool must match the runtime and existing global service database.
Frozen results prohibit compute reruns. Existing compute calls require evidence or freezing. Unknown uploads never retry.
Restart recovers exact captured signature and transaction bytes. Accepted operations without capture remain uncertain.
The CLI requires absolute trusted local module and JSON request paths. The module exports createWorkerRuntime; it is executable operator configuration, never HTTP input.
The CLI replaces injected observation with the concrete fixed testnet observer. It discovers no credentials and starts no scheduler.
The observer resolves the stored signer binding, then reads head minus 12 at one block. This remains provisional, never parent finality.
It verifies five pinned runtime hashes and reads gas, BRAIN, staking/minimum/held, allowances, bond, workerAllowed and faucet timing.
The exact application subject uses changeSubject(board,setWorkerAllowed(boundAddress,true)). Nonzero openProposal requires a matching open record.
Unexecuted matching queued calls count as pending. More than 32 executor changes for an unapproved worker refuses ambiguous observation.
Final anchor and clock checks occur after all reads. Gas availability does not replace root gas ceilings.
Source: release348cc3726227a9a321d7593fd0e685904901d31e ProposalBonds, DecisionExecutor and testnet/TestBRAIN getters.
Local PostgreSQL integration passes1test/21assertions with concrete durable services and controlled OS/provider/key/chain boundaries.
It simulates interruption after protected signature and transaction capture. Restart makes no second key call or compute call.
Pure observation tests pass7tests/162assertions: same-block fields, reorg, code mismatch, owner refusal, wrong chain, ambiguous queue and final-wait expiry.
These checks do not prove live execution or a Linux child launch. Existing separate Linux tests cover those boundaries.
PARITY: this internal runner adds no public route; existing human and agent paths retain bound-avatar ownership. The gate remains false.

Next scope: owner policy binds avatar, worker, testnet, allowed actions, maximum stake/bond/gas, daily compute budget and expiry.
A transactional issuer must reserve liabilities and issue exact short-lived authorities. Task text and model output never approve policy.
Policy revocation must fence later key use. Captured bytes retain their original liabilities and recovery identity.
The policy implementation below replaces this earlier planning gap. Scheduler composition and independent review remain pending.
Manual stage execution is not autonomous worker operation.

## Owner policy implementation in progress (Last Audited: 2026-11-09)

Drift note: migration0109 adds owner wallet proofs and cumulative worker liabilities. It does not enable execution.
The worker policy service accepts human and bound-agent requests, narrowing, pause, and revocation.
Only a current human session can approve a policy with its linked Solana wallet.
The signed challenge binds the canonical payload hash, worker, account, avatar, domain, nonce, revision, and expiry.
Proof consumption uses a database wall clock after the final session check. Wallet rotation revokes policies and derived authorities.
Migration0109 preserves all policies, proofs, issuances, and cumulative liabilities. Composite authority references enforce worker and avatar ownership.
Policy replacement never resets the liability counters. A narrower revision retains its original owner proof.

The trusted issuer reserves gas, BRAIN, and provider ceilings before it creates short-lived authorities.
Task execution also requires an existing root compute envelope and an immutable trusted host assignment.
The proxy's optional trusted worker fence checks the assignment at reserve and both dispatch boundaries.
The autonomous host must supply that fence. Existing reviewed direct trials retain their separate root authority behavior.
Each fence uses the caller's transaction. It verifies policy, execution lineage, prompt hash, assignment digest, provider, envelope, and cost ceiling.
The proxy repeats execution and database-clock checks after asynchronous authority reads.

The human panel uses exact decimal conversion and refuses excess precision. It never rounds owner limits.
The panel requires the linked wallet to sign the displayed policy hash. Testnet execution remains disabled.
Post-pause delivery recovery needs a separate exact-result owner grant. Current policy controls retain results and explain that limitation.
No public request selects a provider credential, signer key, trusted assignment, or root reservation.

Local evidence: policy, issuer, proxy, and job PostgreSQL suite passes 10 tests with 89 assertions.
It covers proof races, agent grant refusal, wallet rotation, retained liabilities, final-session expiry, concurrent caps, assignment changes, and dispatch replay.
The amount conversion suite passes 1 test with 8 assertions. The database package build exits zero.
Migration0109 applied twice to the guarded fixture and the separate full-source schema fixture.
The full-source fixture reports 25 issuance constraints. This does not prove every historical migration path.
Independent review remains pending.
No live wallet, provider, or chain mutation ran. Scheduler composition remains pending.
PARITY: human path uses the worker policy panel and session routes; agents use the same canonical avatar-bound policy service.
Owner grant approval remains a human wallet operation. Bound agents can request, narrow, pause, and revoke authority.

### Current review boundary: job leases, signer fences, and receipts

Last Audited: 2026-11-09. Drift note: the following source changes require independent review before activation.

Explicit start requires the current policy revision and opaque worker control version. It cannot restore a paused or revoked policy.
The owner signature explicitly permits autonomous processing after start. Agent tool and protocol-version integration remains pending.
The policy service uses the canonical retained PostgreSQL client. JSON and timestamp boundaries support the actual Drizzle serializers.
A max-one-connection fixture exercises owner proof, authority issuance, start replay refusal, and pause refusal with those serializers.

WorkerJobs retains one exact pending plan across host restarts. Each takeover increments its generation after the previous database lease expires.
Old hosts cannot replace the retained plan or clear the new host's state. Job leases grant no spending or key authority.
Issuer grants expire no later than the job lease and owner policy. Compute also retains the independent root envelope ceiling.
The embedded brief reader verifies the exact Posted event, task hash, canonical blocks, UTF-8 bytes, and structured task type.
It never fetches a task-supplied URL. Trusted official HTTPS brief support remains outside this increment.

Lifecycle signatures now require current authority after journal admission and after private key-file access, immediately before key use.
The final checks include binding state, signer generation, authority revocation, and database-clock expiry.
Lifecycle broadcast repeats that authority check after URL validation. Captured bytes and nonce liabilities survive refusal.
The concrete driver still refuses all live activation. Existing captured-byte inspection does not create new signing permission.

Receipt observations append immutable operation, generation, hash, and block evidence.
The same transaction records provisional inclusion and marks the consumed nonce confirmed for subsequent nonce admission.
Here, confirmed means provisional canonical inclusion. It does not mean parent-chain finality or released financial liability.
Orphaned inclusion or inconsistent block, status, or gas evidence stops the signer stream and retains its bytes and nonce.
The future scheduler must recheck prior receipts before the next grant. This source does not start that scheduler.

Verification: signer capture passes 2 tests with 40 assertions. Fixed RPC send passes 1 test with 62 assertions.
The isolated Linux signer fixture passes 1 test with 35 assertions using synthetic keys and no network.
Receipt persistence and existing coordinator regression pass 3 tests with 55 assertions on the guarded PostgreSQL fixture.
The embedded brief parser passes 1 test with 6 assertions. The full-source fixture applies the latest migration0109 twice.
The database package build and API typecheck pass. These local checks do not establish a live worker lifecycle.

Next composition must construct the mandatory proxy fence, persist each stage before its effect, and recover retained stages without regeneration.
It must add owner-policy delivery grants for expiry recovery without reviving revoked compute authority.
Post-pause exact-result recovery still requires separate owner consent. Idle-chain freshness policy also needs independent review.

### W1 and W2 correction evidence (Last Audited: 2026-11-09)

Drift note: independent review found shared-client timestamp failures and job writes after lease expiry during a row-lock wait.
The proxy now normalizes every database timestamp used for admission, matching, dispatch, and status.
Its timestamp parameters use explicit text types and PostgreSQL casts. It does not write JSON parameters.
The regression uses getPostgresClient from the canonical database package, after Drizzle initializes that same retained pool.
It covers envelope admission and replay, owner-issued execution, reservation, dispatch, settlement, assignment revocation, expiry, and capability replay.
An unknown provider outcome retains the complete reserve. Conservative reconciliation charges the maximum before envelope closure.
All provider adapters in these tests are local controlled functions. No external provider request occurs.

Job persistence and completion now lock the binding, policy, and job before checking the exact lease tuple and database clock.
The controls require a current active policy and running binding. A paused policy cannot write or clear the retained plan.
Separate unchanged-row lock tests cross expiry during persist and completion. Both refuse, retain evidence, and allow a valid later takeover.
Stale generations cannot clear replacement state. Existing generation and owner CAS constraints remain in place.

The owner suite passes 10 tests with 89 assertions. The existing proxy suite passes 14 tests with 116 assertions.
The proxy suite skips its separate Docker case in this local command. This correction does not claim that Docker case ran.
The original independent probe now reports shared proxy accepted and persistedAfterExpiry false with expired true.
Independent re-review remains required. No schema, activation, live credential, payment, or deployment change forms part of these corrections.


### Scheduler composition draft (Last Audited: 2026-11-09)

Drift note: worker-scheduler.ts now composes concrete durable services. This draft is not an approved autonomous lifecycle.
It creates the owner-authority proxy fence internally and persists each exact WorkerTick before its external effect.
The final proxy also refuses owner-issued execution when a root-only instance attempts reserve or dispatch.
Root-only direct trial grants keep their separate reviewed behavior.
A host restart replays the persisted stage against retained service records. It does not regenerate frozen output.
Before a later grant, the scheduler rechecks every retained provisional receipt within a bounded history.
A changed receipt stops progression and retains nonce and financial liability.
The real shared-pool scheduler regression crosses job expiry after receipt persistence, then replays after takeover.
It verifies one receipt checkpoint, preserved pending plan, and refusal before the next grant after an orphaned receipt.
This case passes one test with ten assertions. It uses controlled RPC only; no key, provider, or send occurs.

The coordinator now runs its admission-through-submit regression on the canonical retained Drizzle pool: one test,22assertions.
Recovery, task delivery, and typed result signing normalize raw timestamp and JSON boundaries on that same pool.
The recovery suite passes eight tests with50assertions, including shared-pool claim and idempotent Submitted reconciliation.
Owner compute tests pass ten tests with99assertions, including refusal through a root-only proxy.

Remaining draft work: exact-result post-pause human consent and revocation provenance in0112, scheduler recovery issuance, and explicit worker liveness policy.
The worker-observation-policy module currently has only pure tests. No existing consumer uses its provisional exception yet.
Protocol124 action/manual parity, drain behavior, and the executable autonomous host entry also remain pending.
Existing activation remains false. These tests do not establish end-to-end autonomous work or live protocol eligibility.


### Worker observation and scheduler increment (2026-11-09, review pending)

Last Audited: 2026-11-09. Drift: explicit worker observation policy now propagates through authority issuance and concrete consumers. Activation remains false.

Migration0113 adds immutable observation policy fields to signer authorities, signer operations and execution authorities. Existing rows retain legacy-depth12-age120-v1. New trusted scheduler configuration selects nitro-testnet-latest-v1. The public earnings reader and shared stable-block selector retain their original behavior. Neither observation policy permits financial release.

The new worker policy starts its 30-second acquisition interval before RPC. It uses one latest testnet block and rejects a changed final anchor or a future block timestamp. An old block timestamp does not prove an endpoint outage on an idle Nitro chain. Transport dispatch repeats the final anchor after URL validation, then checks current authority and the original acquisition deadline. The exact policy must match persisted authority and operation records. Issuance replay refuses a policy mismatch.

The explicit host entry at `apps/api/scripts/brainchain/run-worker-scheduler.ts` composes fixed readers, fixed transport, recovery evidence and the mandatory owner compute fence. The operator selects an absolute trusted configuration module, worker UUID, bounded tick count and interval. The entry does not discover credentials or run at API boot. It emits finite state metadata, without briefs or model output. No invocation with real configuration or credentials occurred.

Scheduler jobs permit drain under an active owner grant. Drain blocks new lifecycle and execution issuance. Existing admitted execution and exact captured effects retain their original authority checks. Pause and revoke retain all liabilities. Exact-result consent after pause belongs to the separate 0112 integration. Matching Submitted reconciliation and consent integration still require coordinator tests before an autonomy claim.

Verification: transport send1/74; signer observer10/276; fixed RPC/brief decoder/observation policy10/117; worker delivery evidence4/11. Real PostgreSQL owner policy plus scheduler12/117 passed after the drain changes and0112 provenance trigger correction. The issuer regression holds a job row past lease expiry and proves zero authority issuance. The capture fault suite2/48 passed, including drain after the durable claim with zero key calls. API typecheck38935 exited0. Migration0113 applied twice to the isolated full-source schema database, which reports29 signer-operation constraints. No network payment, key use, live upload or deployment occurred.

PARITY: humans and bound agents retain the same explicit start/pause/revoke paths and durable worker records. Only live human owner proof grants monetary policy. Protocol124 worker controls are present; protocol125 adds the separate Solana buyer scope.


The scheduler exposes a separate recover(workerId,resultId,consentId) path. It verifies an exact owner consent through the recovery issuer and selects one durable result stage. It does not restart an active-policy job or allocate provider funds. Existing accepted capture gaps use byte recovery only; pending broadcast observes receipts. Unknown upload permits only evidence reconciliation. The explicit CLI accepts optional --recover-result and --consent arguments. Joint stage tests await the recovery owner's final submit SQL fence and retained-issuance implementation.

The worker wallet rotation trigger permanently revokes original policies when the linked key or proof timestamp changes. The real PostgreSQL regression now covers A-to-B-to-A and proves that job claim and signer-authority issuance still refuse. The generation-based exact recovery consent remains separate. Receipt rechecks now run before retained plans as well as new plans; a receipt stage performs its own check. Terminal rejected signer operations no longer enter the pending-operation selector. No liability decrement follows that selector change.


### Scheduler implementation review checkpoint (2026-11-09)

The worker scheduler, drain guards and provisional-observation source are frozen for independent review. Exact-result recovery remains a joint integration draft. Retained unsigned submit operations return exact-capture-consent-required; this scheduler does not infer capture permission from prepare-submit. The recovery owner is adding explicit capture-submit consent. Expired or revoked original capture grants still refuse in signer primitives. A separate exact capture authority design requires lead review before that recovery case can progress.

Verified commands from the registered job worktree:

- `bun test apps/api/src/services/brainchain/signer-observation.test.ts`:10 tests,276 assertions.
- `bun test apps/api/src/services/brainchain/signer-rpc-send.test.ts`:1 test,74 assertions; run alone because of test-only module replacements.
- `bun test apps/api/src/services/brainchain/worker-delivery-evidence.test.ts`:4 tests,11 assertions; run alone.
- `bun test apps/api/src/services/brainchain/signer-rpc.test.ts apps/api/src/services/brainchain/worker-observation-policy.test.ts apps/api/src/services/brainchain/worker-brief-reader.test.ts`:10 tests,117 assertions.
- With guarded fixture variables, `bun test apps/api/src/services/brainchain/worker-owner-policy.test.ts apps/api/src/services/brainchain/worker-scheduler.test.ts`:12 tests,117 assertions. This requires latest0112 and0113 before test execution.
- With guarded fixture variables, `bun test apps/api/src/services/brainchain/signer-capture-db.test.ts`:2 tests,48 assertions; run alone.
- API `bun run typecheck`: exit0, process38935. A later typecheck also passed before the final safe recovery refusal.

The full-schema fixture accepted0113 twice with29 signer-operation constraints. No claim of production rollout follows that fixture. No real RPC signing, key loading, provider invocation, upload or payment occurred.

Remaining evidence: independent scheduler/liveness review; integrated exact-consent capture/reconcile tests after the recovery owner freezes0112; actual automatic stage-selection coverage beyond receipt crash/restart; a configured host run after activation approval. Embedded brief support remains limited to exact hashed JSON with the supported text-task schema. Fixed-host remote brief retrieval remains outside this source increment. The bounded host loop is explicit; no API boot starts it.


### S1 callback deadline correction (2026-11-09, independent recheck pending)

Last Audited: 2026-11-09. Drift: every external root-reservation and assignment callback in WorkerAuthorityIssuer now has a bounded read. The timeout rejects inside the transaction await, so rollback releases locks even if the callback ignores cancellation. Late results cannot resume authority issuance or provider dispatch.

The root and assignment reread share a two-second maximum. Database-derived policy, envelope, assignment, execution and job expiries can shorten it. Compute calls also retain their absolute host deadline; database clock skew cannot extend that deadline. Missing call deadline uses the bounded persisted attempt deadline; non-finite explicit deadlines refuse. Initial assignment reads also receive an abort signal and a two-second or earlier job deadline.

The actual shared Drizzle pool regression covers root timeout, assignment timeout and post-dispatch timeout. A separate PostgreSQL connection acquires the policy row with NOWAIT after timeout, before the delayed callback resolves. Reserved calls keep their hold before dispatch commitment. Calls after commitment become uncertain and retain the full maximum. Late resolution and replay produce zero provider calls. Automatic scheduler tests now execute concrete owner issuance and signer preparation, then check drain refusal, terminal rejected selection and multiple-hire refusal. Full admission-to-delivery automatic stage selection remains a separate evidence gap.


S1 final owner evidence: guarded owner-policy and scheduler PostgreSQL suites passed15 tests with192 assertions. The host-clock skew regression advances the host clock by two seconds and retains a350ms absolute call deadline; refusal plus lock release completed in approximately389ms. Shared root-plus-assignment timeout, initial assignment timeout, earlier job expiry, late completion, reserved hold, uncertain hold and no provider replay all passed. Scheduler tests execute real owner issuance and signer operation preparation, then check drain, rejected selection and multiple hires. No test replaces the coordinator graph. API typecheck result is recorded in the review handoff.

S1 changed-file scope: worker-authority-issuer.ts; inference-proxy.ts (deadlineMs type exposure only); worker-owner-policy.test.ts; worker-scheduler.test.ts; this document; ARCHITECTURE.md. The signer and recovery implementation remain outside this correction. The fixture is released; the recovery owner must restore0112 after the owner suite replays0109. Tests made no external network, provider, key or financial call.


### Automatic scheduler flow evidence (2026-11-09)

Last Audited: 2026-11-09. Drift: the automatic stage-selection evidence now includes a concrete service flow on the canonical shared Drizzle pool. The separate S1 independent review passed. The current exact-consent review remains separate.

The new worker-scheduler-flow.test.ts runs alone because it replaces test-only transport and activation boundaries. It creates actual owner proof, policy, assignment, envelope, signer stream, and durable records. Automatic ticks select faucet preparation, capture, exact-byte recovery, broadcast, receipt, and hire indexing. They then select admission, compute, frozen result, result signature, upload, submit preparation, capture, broadcast, and receipt. A new scheduler instance handles every tick. Protected captures survive synthetic crashes before return. Repeated pending receipt checks retain one provider call, one upload, three key calls, two sends, one frozen result, and the full gas liability.

The test uses actual authority, proxy, indexer, ABI decoder, delivery, signer, coordinator, and scheduler services. Controlled boundaries are the OS child, RPC responses, protected byte stores, synthetic fixture signer, upload, and transaction transport. The child boundary invokes the real proxy dispatch. No root-only proxy replaces the owner fence. This test does not prove a live chain, actual Linux custody, remote upload, paid inference, or an activated host.

Guarded local PostgreSQL commands: bun test apps/api/src/services/brainchain/worker-scheduler-flow.test.ts passed1 test/25 assertions. The signer-db.test.ts suite passed7 tests/34 assertions after its included receipt fixture gained gasUsed and effectiveGasPrice. Production receipt validation is unchanged. Test variables remain BRAINCHAIN_DB_FIXTURE=1 plus the guarded local or explicit test database setting. CI runs these files in isolated processes.

PARITY: these tests exercise the shared worker policy and scheduler used after human owner consent; bound agents retain the same worker controls. This test-only change adds no public action or authority.


### Exact retained submit capture recovery - Last Audited 2026-11-09

Migration0115 adds append-only exact capture authorities and acceptances. The signed consent binds the original operation, result, hire, signer generation, nonce, destination, calldata, and fees. The original operation expiry and original authority rows remain immutable. Late first acceptance requires a separate database trigger check; ordinary acceptance retains its original expiry rule. The operation still moves from prepared to reserved to accepting. Database timestamp equality preserves microseconds.

The exact-capture service reuses the existing human wallet challenge, physical signer driver, protected journal, and captured-byte reader. It validates owner revocation provenance and current canonical hire evidence. Unknown security revocation and stopped signer streams refuse. Accepted or uncertain operations cannot obtain another signature. A revoked original exact-delivery consent remains refused because that consent lacks classified capture revocation provenance.

The human retained-result panel exposes capture-submit and exact unsigned terms before approval. Bound agents use the existing recovery_request operation with the capture-submit stage. Agents can request, narrow, or revoke; only the current linked human wallet can approve. Protocol127 carries this scope through the manual, orientation, and Nori. Explicit trusted-host recovery invokes the new service. No paused-worker discovery or hidden scheduler starts it.

PARITY: human path: Office retained-result panel and existing private recovery endpoints; agent path: clawville_brainchain recovery_request/recovery_narrow/recovery_revoke and hosted brainchain action; authority binds the same resolved avatar. Fresh human wallet approval remains mandatory for both paths. No compute budget or financial release follows capture.

Independent schema and signer review remains required before activation. The real external pilot remains unproved. See docs/brainchain-exact-capture-recovery-design.md for exact constraints and local test evidence.

Freeze evidence: exact capture PostgreSQL suite passed 9 tests/57 assertions; pure intent suite passed 2/21; human panel passed 6/41. Shared/database builds and API/web typechecks exited 0. Independent review remains pending; no live pilot claim follows these results.

### Dependency runtime admission - Last Audited 2026-11-09

Drift: the immutable signer code map now includes DecisionLog, ModelRegistry, and TestUSDG, alongside the original five contracts. Their full deployed runtime hashes come from the independent artifact readiness review at block 0x13ec. The original map evidence digest and block remain attributed to the earlier five-contract review. Executable equivalence excludes metadata; full deployed runtime hashes include metadata.

The existing observation, pure policy, and final RPC transport consumers all enforce these entries. Explicit dependency regressions reject missing and mismatched code for each named contract. Policy tests passed 9/54, observation tests passed 16/333, and isolated transport tests passed 1/128. These controlled tests made no network requests. Final anchor and deadline behavior remains unchanged.

Both approvedForSigning and artifact review verified remain false. Mutable governance and attestation admission remains a separate review gate. This change does not alter consent, lifecycle authority, migrations, or public actions. PARITY: human and bound-agent worker paths share this admission boundary; neither path gains signing authority.

Evidence: docs/brainchain-testnet-artifact-readiness-review.md. This implementation does not change that independent report's verdict; the original reviewer must verify the correction.

Capture fixture follow-up: draft/approve helpers now type only consumed fields. A positive setup failed its original 1.5-second consent deadline during concurrent compilation. The setup window now permits five seconds, then waits for natural expiry. Explicit recovery expiry cases retain their short deadlines. Production authority and SQL remain unchanged.

Final capture timing verification passed 9 tests/57 assertions in 84.61 seconds. The test runner now allows 60 seconds per case, including its two explicit multi-fixture limits. Intermediate runs exposed those old limits after the setup window increased; the final run passed without retries inside any test. API typecheck exited 0.


### Configured testnet authority admission - Last Audited 2026-11-09

Drift: worker effects now require brainchain-testnet-configured-authority-v1. Its digest binds chain 274630, release 3.5.0, source commit348cc3726227a9a321d7593fd0e685904901d31e, eight full runtime hashes, and fourteen exact authority getter values. The digest is21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6. This bounded test-token policy trusts the configured brain. Zero attestation count is a change detector, not a TDX guarantee.

The reader checks canonical single-word ABI results at one block, then rechecks the anchor and original caller deadline. Signer observation and final transport read the policy independently. Direct execution admission, compute reserve/dispatch, delivery, result signing, lifecycle key callbacks, and exact recovery also require fresh policy evidence. Trusted host readers share the existing two-second effect budget and earlier authority deadline. No task or public request chooses a getter, endpoint, reader, or accepted policy.

Migration0117 adds nullable immutable version/digest pairs to signer authorities and operations, execution authorities, delivery authorities, and exact capture authorities. Explicit NULL pair checks preserve historical rows. Operation linkage rejects mixed intent/gas policy pairs. A new effect cannot silently inherit current policy. Fresh exact recovery consent signs the policy pair and links a new recovery authority to retained operation/hash/nonce/gas evidence. Original operation fields, bytes, revocations, and liabilities remain unchanged. Receipt/status reconciliation and protected captured-byte inspection remain available.

Both activation flags remain false. Controlled fixture migration replay and tests do not establish live activation, full migration rollout, or a testnet lifecycle. Independent reader review passed; consumer and schema review remain separate. Design and trust limits: docs/brainchain-configured-authority-design.md and docs/brainchain-testnet-artifact-readiness-review.md.

PARITY: human and bound-agent worker paths consume the same persisted owner/recovery authorities and policy checks. Fresh human approval remains mandatory for exact recovery. This change adds no public approval shortcut.
