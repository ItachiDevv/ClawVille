# BrainChain testnet funding and exit recovery

Last Audited: 2026-11-09. Source and controlled fixtures only. Transmission remains disabled.
Drift: durable preparation now replaces an instruction-only recovery description.

## Supported boundary

The parent ETH route calls the pinned testnet Inbox `depositEth()` from the bound worker EOA.
The exit route calls the pinned testnet USDG token `transfer(desk, amount)` from that same worker.
Both routes retain the worker address as the destination. They accept no caller destination or RPC URL.
The pinned worker source is [network.ts](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/network.ts), [bridge.ts](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/bridge.ts), and [exit.ts](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/exit.ts).

An unsigned GET on 2026-11-09 returned testnet exit terms and mainnet HTTP 404.
Testnet terms identified chain 46630, the pinned parent USDG token, 50 basis points, and a 10000-unit minimum fee.
The service validates the pinned desk, child token, parent chain, and parent token.
It freezes the complete parsed quote hash. It checks fresh terms before an enabled dispatch.
The fee uses integer arithmetic with the source minimum and amount cap.

The exit calldata enforces only token, desk, and source amount.
Maximum desk fee and minimum destination amount are **local approved quote limits**, not atomic payout guarantees.
A later discrepancy never releases the original reservation.

Solana conversion, Solana exit, mainnet writes, parent token bridge approvals, and alternative assets remain unsupported.
The pinned testnet worker has no parent token bridge mappings.
The pinned Solana funding route uses mainnet Solana. It cannot serve as a testnet adapter.

## Authority and durable state

The owner resolver uses the current account and its bound avatar. Guest accounts cannot create operations.
The server resolves the worker address from that avatar's testnet binding.
The current linked account approves the exact artifact hash, authority version, nonce, and expiry.
Wallet rotation invalidates this approval, including rotation away and back.
The external EVM worker separately signs the exact consent message and EIP1559 transaction.
The account proof does not grant access to the worker key.

Preparation reserves the operation before disclosure of unsigned terms.
The database reserves the source-chain/address/nonce globally and the idempotency key per avatar.
The server selects nonce and fees through the fixed source RPC.
The transaction fixes chain, source, destination, call, value, nonce, gas, and both gas prices.
The parser refuses access lists, another signer, another chain, and different transaction bytes.
The encrypted capture binds purpose, avatar, user, operation, artifact hash, and transaction hash.
Only the direct private capture endpoint receives external signatures. Agent results exclude captured bytes.

The pilot retains all reservations. Cumulative source limits are one test ETH and 200000000 test USDG per avatar.
The separate cumulative gas ceiling is one test ETH across both routes.
These are test-asset limits, not authorization to spend real assets or an exchange-rate valuation.
Preparation failure rolls back its reservation. A successful reservation has no release endpoint.
SQL triggers preserve owner, worker, artifact, source nonce, captured bytes, exposure time, and first-send time.
SQL validates the worker/avatar/user tuple and both guest flags on insertion.

## Recovery and evidence

The service persists capture before it can claim a send lease.
The final dispatch callback checks the current owner, fresh route terms, approval deadline, and lease after waits.
A first send also checks the original artifact expiry.
A lost reply leaves an uncertain operation with the original transaction hash and bytes.
Explicit recovery requires fresh owner approval and uses identical bytes. It never selects another nonce.
The service cannot atomically couple a remote chain dispatch with a local identity revocation.
Its final local check precedes the remote call. Transmission remains disabled pending independent review.

Reconciliation checks the exact source transaction and canonical finalized-block evidence.
A source receipt does not prove child-chain arrival or a destination payout.
Official Nitro documentation distinguishes the parent receipt, derived child identifier, and child receipt.
Source: [bridge transaction traceability](https://developer.arbitrum.io/arbitrum-bridge/bridge-transaction-traceability).
This implementation leaves destination attribution unresolved rather than infer arrival from a balance increase.

Exit status comes only from the pinned HTTPS path for the stored source hash.
The response can report waiting, paying, paid, returning, returned, or held.
These labels do not establish a matching payout or refund receipt.
The current response lacks the exact joint source/destination/amount association required for financial release.
The UI exposes only a safe stored status URL and validated status fields. Vendor reason text never reaches agent instructions.
Failed source revalidation marks previous source evidence reorg-suspended. It preserves the reservation.

## Human and agent paths

Humans use the testnet worker panel in `/brainchain`.
Agents use `clawville_brainchain` funding operations and the same owner-bound service.
Both can create, list, inspect, and reconcile their operations.
Only the current human session requests or approves the account-owner challenge.
The human panel displays exact external signature instructions and accepts externally signed bytes.
An authorized external agent client can use the same capture endpoint without passing signatures through model tools.
Neither path discovers a key, signs automatically, substitutes a destination, or enables transmission.

REST: `/api/brainchain/funding-exit`, `/:operationId`, and `/:operationId/{challenge,approve,intent,capture,submit,recover,reconcile}`.
The strict create draft contains environment, workerId, idempotencyKey, kind, amountAtomic, maxGasCostWei, maxFeeAtomic, and minimumDestinationAtomic.
Amounts use decimal integer strings. Kinds are parent_eth and parent_exit. Environment is testnet only.
Agent verbs are funding_list, funding_create, funding_get, funding_intent, funding_submit, funding_recover, and funding_reconcile.
funding_create uses a base64url JSON draft. Other operation verbs use operationId.
Human proof and capture endpoints stay outside the model tool inventory.

PARITY: human path: private worker panel; agent path: funding tools/private capture; ownership binds to the current session's avatar.

## Verification and remaining gates

Policy tests use real signatures from generated fixture keys. They do not use production keys.
RPC tests use controlled transport and strict production endpoint pins.
PostgreSQL tests use the installed Drizzle/postgres.js composition, owner rotation, lost replies, replay, and source reorgs.
Migration 0116 applies twice to the separate full-schema fixture.
No test proves a genuine parent deposit, desk payout, child arrival, or refund.
Independent review, complete CI, device/browser checks, exact destination attribution, and authorized test-token evidence remain release gates.

Verification checkpoint: policy/RPC/hosted/MCP suites passed 109 tests and 936 assertions. The prior combined run with buyer action regressions passed 113 tests and 954 assertions before the nonce-zero additions. The guarded funding PostgreSQL suite passed four tests and 24 assertions. The human panel suite passed three tests and 21 assertions, including stored terms and operation ID at the mocked wallet call. Shared/database builds and web typecheck exited zero. Final API typecheck reports only a separate capture-recovery fixture type error; funding diagnostics are absent. Migration0116 applies twice to the full-schema fixture with 34 constraints. No independent funding approval or browser evidence is claimed.

### F2 transaction callback deadline correction - 2026-11-09

Each funding transaction receives one 1500ms monotonic host deadline after BEGIN. All account callbacks and the final chain authority check share its remaining budget. A callback timeout rejects inside the transaction, so rollback releases row locks and the reserved connection before that callback resolves. The service passes an AbortSignal to callbacks and chain reads where supported. It ignores late responses. The host deadline does not derive from database or wall-clock timestamps. A final host check rejects a transaction whose work exceeded that deadline. SQL lock and statement timeouts remain separate controls; the JavaScript deadline does not cancel an already active SQL statement.

The chain client propagates abort to fetch and rejects even when a transport ignores abort. A timed-out chain check cannot proceed to another RPC or a transaction send after a late response. A post-claim timeout preserves encrypted capture and liability. Its cleanup marks uncertainty when the current owner remains verifiable; otherwise the retained send lease expires without releasing funds. There is no automatic retry. The PostgreSQL regression uses a max-one pool with actual Drizzle composition, NOWAIT avatar lock checks, late callback resolution, retained capture, and cumulative callback waits. The suite passed seven tests and 42 assertions. The policy/client suite also covers abort with an uncooperative transport. Schema and panel sources remain unchanged by F2. Independent F2 recheck remains required.
