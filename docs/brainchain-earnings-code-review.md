# BrainChain earnings code review

Last Audited: 2026-11-09

Verdict: approved within the reviewed private read-only earnings scope. No money action, live parity claim, or visual release approval follows from this review.

## Reviewed boundaries

The private route resolves the existing human or bound agent identity. `readOwnedWorkerEarnings` resolves worker ownership before it constructs the RPC reader. The database lookup checks both worker ID and avatar ID. Hosted actions use the same route and validate the current session attribution. The web query key includes the owner and worker.

The reader selects only pinned current or retired board addresses. It checks deployment bounds and chain identity. RPC filters contain both worker model and payee account. Event decoding checks both fields again. The pinned release 3.5 TaskBoard source emits gross bounty and fee after transferring bounty minus fee to the payee. The reader uses bigint arithmetic for those amounts.

Each page states board and block coverage. Dense ranges shrink until at most ten receipts remain. An overfull single block refuses instead of truncating receipts or advancing the cursor. Each receipt block hash must match a block read. The final anchor hash must match the initial anchor. These checks rely on the configured RPC; they do not provide consensus finality or an independent RPC quorum.

Wallet balances and receipt totals stay separate. The UI and manual state provisional status and selected-range coverage. They do not claim lifetime income, a cash-out destination, or final settlement. The API supports private human, connected-agent, and hosted-agent paths. Actual live parity remains outside this source review.

## Independent checks so far

`.brainchain-work/audit-earnings-bound.ts` exercises the actual hosted result selector with ten receipts, maximum uint256 task IDs and balances, uint128 money fields, uint64 block fields, and all five mainnet boards. After the final stake breakdown addition, the probe also includes maximum stake fields and int31 log indexes. The serialized result contains 6717 bytes and all ten receipts. The selector has an 8192-byte cap.

The owner received early constraints covering ownership before RPC, dual event filters, block hashes, dense-block coverage, response limits, and full-size hosted results. No confirmed blocker arose. After the freeze notice, this reviewer checked the stake breakdown and the added block/log position uniqueness and numeric bounds.

The independent owner probe passed 1 test and 5 assertions. It uses the real ownership wrapper with controlled ownership and reader seams. A foreign-owner refusal makes zero reader-construction calls. The underlying SQL predicate separately checks avatar and worker IDs.

Independent test runs after the freeze:

- Earnings reader and chain reader: 12 passed, 86 assertions.
- HTTP session composition: 6 passed, 41 assertions. Real Lucia cookie hydration runs with controlled identity backing and services.
- Hosted action and MCP tools: 111 passed, 832 assertions.
- Worker record, account, and browser request helpers: 10 passed, 45 assertions. These DOM tests do not establish visual or mobile layout quality.

## Scope limits

No live RPC, account credentials, paid provider calls, or network writes occurred in this audit. RPC receipt completeness remains a trust assumption. A response above the RPC byte or log cap refuses; it cannot establish empty coverage. A single overfull payment block also refuses without advancing. Pagination covers each returned range, not an immutable lifetime snapshot across pages. The UI exposes provisional coverage and separates token balances, stake, and receipt net amounts.
