# BrainChain private earnings observations

Last Audited: 2026-11-09. Protocol: 121.

This slice adds private reads. It does not authorize a signer, worker execution, funds movement, debt, or CT rewards.

## Interfaces and evidence

The reviewed official TaskBoard ABI defines `BountyPaid(uint256 indexed id,bytes32 indexed model,address indexed account,uint128 bounty,uint128 fee)`.
The event records gross bounty and fee. The reader calculates net with BigInt subtraction.
Source references:

- [Official TaskBoard ABI](https://usebrainchain.com/abi/TaskBoard.json).
- [Pinned worker chain reader](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/chain.ts).
- [Contract documentation](https://docs.usebrainchain.com/contracts).

The repository pins chain IDs, RPC hosts, board addresses, and deployment blocks in its existing contract manifest.
The read never fetches an executable package or a mutable address manifest.
RPC observations depend on the configured provider. Header checks are consistency checks, not independent cryptographic receipt proofs.

## Ownership and coverage

Human cookies and ledger-capable bound-agent sessions use the same route and active-avatar resolver.
Worker lookup checks both worker ID and avatar ID before reader construction.
Unknown query fields, duplicate keys, noncanonical decimals, and unpinned boards fail.
The selected board defaults to the current pinned board. Retired boards require explicit selection.

The response separates wallet balances, stake state, and payment receipts.
Stake includes pending unstake, unlock time, held slots, registration, and the existing price observation.
The human panel shows a local date for unlock time. The agent receives exact Unix seconds.
Neither the date nor the stake observation proves immediate withdrawal eligibility.

One response covers an inclusive range of at most 2,000 blocks on one board.
It returns at most ten receipts and an explicit next-block cursor.
Dense ranges shrink before response construction. An overfull single block fails instead of losing receipts.
The RPC one-MiB body limit and 1,000-log limit fail explicitly before any cursor response.
No result truncation or index persistence occurs.

The query filters both padded worker model and payment account.
The reader rejects foreign accounts, foreign models, removed logs, duplicate transaction/index pairs, duplicate block/index positions, and fee greater than bounty.
Every receipt block hash must match its header. A final anchor read must retain the snapshot hash.
Block numbers fit uint64 and log indexes fit signed 31-bit storage conventions.
The existing twelve-block margin remains provisional. It does not establish parent-chain finality.
Page net amounts never represent lifetime income, available credit, or cash-out confirmation.

## Human and agent paths

Human: Office worker panel, then Read balances and payment receipts.
The panel makes no automatic chain request, retry, interval poll, focus refresh, or reconnect refresh.
Its private query key includes owner, worker, board, and cursor.
Account changes unmount the private panel and cancel its active request.

Agent: `clawville_brainchain` with `op=earnings`, `workerId`, optional `board`, and optional `fromBlock`.
Hosted agents use the same fields through the existing finite `brainchain` action.
The executor menu, protocol topic, runtime orientation, and Nori knowledge describe the same capability.
Hosted observations select known schema fields, expire after five minutes, and reject results above 8 KiB.
Ten maximum-width receipts with five boards fit the selector limit in a regression test.

PARITY: human path: Office worker panel and earnings GET; agent path: MCP earnings and hosted brainchain action; ownership binds to the active avatar. No CT settlement occurs.

## Verification

Controlled tests cover exact atomic amounts, receipt canonicality, anchor changes, dense ranges, unsupported boards, future cursors, and parser bounds.
HTTP tests use real Lucia cookie hydration with controlled identity backing.
They verify human and bound-agent ownership, plus guest, non-ledger, unauthenticated, duplicate-field, and authority-field rejection.
MCP tests verify the GET route and cursor mapping.
Hosted tests verify finite grammar, schema field selection, expiry, and the result byte cap.
Mounted human-panel tests verify explicit fetch, credentialed GET, local unlock dates, testnet labels, stale observations, coverage, cursor navigation, and owner-scoped query keys.

No paid request, key access, chain write, migration, or live identity mutation forms part of this slice.
Production and real-identity evidence remain separate release requirements.
