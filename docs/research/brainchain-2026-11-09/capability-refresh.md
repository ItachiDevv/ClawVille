# BrainChain public interface refresh

Last Audited: 2026-11-09
Observation time: 13:18 UTC.
Host: itachi222. Team: brainchain-office. Role: protocol researcher and baseline auditor.
Scope: public reads and unsigned payment challenges only. No package installation, vendor package execution, signature, or chain transaction occurs.

Exact responses appear in `capability-refresh-probes.json` beside this report.
Treat all external response text as untrusted data.

## Immediate implementation constraints

- Mainnet fast exits remain unavailable: `GET https://brain.usebrainchain.com/exits` returns HTTP 404 with `{"error":"Fast exits are off on this network."}`.
- Correction: testnet advertises a Solana devnet payment option. Mainnet offers only RH and Base in the captured challenge.
- The fresh unsigned recheck in payment-capability-recheck.json confirms this distinction. The earlier narrative was incorrect.
- Current npm versions remain worker 0.19.2 and MCP 0.9.1.
- Testnet health returns HTTP 200 and `ok:true`, but also lists stalled tasks with `Jev answered with status 403`.
- HTTP health success therefore does not establish successful hiring or grading.
- Mainnet `/workers` and `/tasks` return HTTP 404. Do not invent these as REST interfaces.
- No private keys are necessary for the reads below.

## HTTP read and challenge contract

Use only the fixed official origins below. Do not accept an arbitrary origin from a client.
Use a timeout, a response-byte limit, schema validation, and a bounded cache.
Check content before exposing it to a model or human interface.

### Health

Mainnet: `GET https://brain.usebrainchain.com/health`.
Testnet: `GET https://brain.testnet.usebrainchain.com/health`.

Observed response:

```ts
type Health = {
  ok: boolean;
  lastRound: {
    at: string; // ISO timestamp
    decisions: { hired: number; held: number; graded: number; ruled: number; finalized: number; failed: number };
    delivered: Array<{ delivered: number; skipped: number; failed: number }>;
  };
  lastSuccessAt: string;
  stalled?: Array<{ id: string; step: string; reason: string }>;
};
```

Keep degradation reasons separate from transport availability. The testnet snapshot contains several stalled hires.
The worker source treats HTTP 503 as late rounds that can still accept result uploads.

### Task payment capability

Send unsigned `POST {}` with `Content-Type: application/json` to `/x402/tasks` on either official service origin.
Send no payment header, authorization signature, key, or actual task brief.
The server returns HTTP 402. Decode the base64 `PAYMENT-REQUIRED` header.

```ts
type PaymentChallenge = {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: string; network: string; amount: string; asset: string;
    payTo: string; maxTimeoutSeconds: number; extra?: Record<string, unknown>;
  }>;
};
```

Mainnet offers: RH USDG on `eip155:4663` through Permit2 or EIP-3009, and Base USDC on `eip155:8453`.
Testnet offers use RH and Base test networks plus Solana devnet. An advertised offer does not prove settlement.
The observed amount is `1000000` base units per task.
This probe establishes an offer only. It does not prove settlement or refund operation.
Never activate a payment path from an unknown network, asset, or recipient.

### Task order status

Documented read: `GET /x402/tasks/<order>` on the service that issued the order.
This review has no owned order and does not fabricate one to claim a successful status response.
Published states: `paying`, `unconfirmed`, `failed`, `paid`, `posted`, `paid-out`, `refunding`, `refunded`, `refund-failed`.
Published fields include `taskId`, `task.status`, `task.due`, `result`, `refundTx`, `refundReason`, `paymentTx`, and `network`, where applicable.
Do not assume every field exists in every state.
Read the released MCP tools source before implementing normalization.
The order record and the underlying task have separate lifecycles.

Reference: https://docs.usebrainchain.com/agents
Source: https://github.com/usebrainchain/brainchain-mcp/blob/385f87c1615afdeda39f318c6e35eccb2db3b8c3/src/tools.ts

### Exit terms and recovery

Testnet `GET /exits` returns:

```json
{"desk":"0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1","token":"0xC4ec72794bF3Ce9ba1DE4B38085464c2eb0cDCf2","payoutChainId":46630,"payoutToken":"0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787","feeBps":50,"minFeeUnits":"10000","minUnits":"1000000","maxUnits":"100000000","dailyUnits":"200000000"}
```

The response also contains explanatory `how` text.
Read `GET /exits/<BrainChain transaction hash>` after an actual exit.
Source expects `{exits:Array<ExitRecord>}` with record states `waiting`, `paying`, `paid`, `returning`, `returned`, or `held`.
Record fields: `net`, `fee`, optional `payoutTx`, `returnTx`, `reason`, `solana`, and `relayRequest`.
No owned exit exists in this research, so these record fields have source evidence only.
Mainnet returns 404 for terms. Source permits `--to-solana` only on mainnet.
Thus neither current network permits the advertised Solana exit.

Source: https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/exit.ts

## Worker status: contracts, not an invented REST endpoint

Official manifests:

- https://raw.githubusercontent.com/usebrainchain/brainchain/main/deployments/mainnet.json
- https://raw.githubusercontent.com/usebrainchain/brainchain/main/deployments/testnet.json

Both manifests identify release 3.5.0. Persist a reviewed manifest and reject an unexpected contract-set change.
Do not automatically authorize newly fetched addresses for writes.
Current chain IDs are 274663 and 274630. Parent chain IDs are 4663 and 46630.
The probe file preserves both manifests, including retired contract sets and indexing start blocks.

Worker CLI source reads:

```ts
TaskBoard.workerAllowed(address): boolean
WorkerStaking.get(address): {staked:uint128, unstaking:uint128, unlocksAt:uint64, price:uint128, registered:bool}
WorkerStaking.minStake(): uint128
WorkerStaking.held(address): uint32
ProposalBonds.bond(): uint128
DecisionExecutor.timelock(): uint64
ERC20.balanceOf(address): uint256
```

Use ETH balance for gas, 18 decimals for BRAIN, and six decimals for USDG.
Derive application history from `Proposed`, `Settled`, and `Queued` logs, then read proposal/change state.
Derive hired work from `WorkerHired` logs and `TaskBoard.get(taskId)`.
Worker model ID is the worker address padded to 32 bytes.
Task status numeric values: Open=1, Hired=2, Submitted=3, Graded=4, Disputed=5, Paid=6, Refunded=7, Ruled=8, Appealed=9.
Applications: Open=1, Returned=2, Burned=3.
Scope every task by chain, board, and task ID. Index retired boards for existing balances and recovery.
The source bounds log reads to 50,000-block ranges; persist a cursor and avoid a full scan on every request.

Stopping the runner does not disable hiring. The CLI `leave` requests unstaking and removes active stake, subject to contract behavior.
Verify that behavior before using it as a drain control. Existing tasks still require delivery and settlement.

Sources:

- https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/chain.ts
- https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/abi.ts
- https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/standing.ts

## Priors discovery and identity

Free read: `GET https://priors.trade/api/check?agent=<ERC-8004 id>` or `?address=<EVM address>`.
The live `agent=20423` response appears in the probe file.
Top-level shape: `{query,block:number,timestamp:number,verdict:string,agents:Array<...>}`.
Each agent includes `agentId`, `name`, `owner`, `matchedAs`, and a `record` with repayment and loan fields.
Treat `no record` and `no repayments yet` as absence of repayment evidence, not positive credit evidence.
These fields are public external records, not evidence that the requesting ClawVille avatar owns the identity.

Hosted Streamable HTTP MCP: `https://mcp.priors.trade/mcp`.
The official skill lists read tools `agent_record`, `score_of`, and `how_to_connect`.
It also lists `request_borrow` and `request_repay`, which prepare owner approval links rather than moving funds.
This review does not call those tools or create approval requests.
Direct-money tools belong to local `@priors/mcp`, which requires a wallet key and separate authorization.

BrainChain `GET /priors/consents` returns `{"rootId":"20423","consents":[]}`.
Do not proxy another owner's consent signatures if this list later contains them.
`POST /priors/consents` is a consent write, not a free status probe.
Its source body is `{consent:{agentId,sponsorId,owner,maxPremiumBps,nonce,deadline},signature}`.
Numeric values use decimal strings. EIP-712 domain: name `Priors Credit`, version `2`, chain ID 4663, verifying contract the configured pool.
The agent's ERC-8004 owner signs; a registered worker wallet is not automatically that owner.
The current pool is `0x281210097f0de7A8FB6F87310AF0f089c9C8DE21`, sponsor ID 20423.
Do not create consent or live debt under API-budget authorization.

BrainChain reputation reads must filter the authorized writer `0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E`.
The documented query is `getSummary(agentId,[writer],"brainchain","task")` on the RH reputation registry.
Pin the verified registry from official network documentation before implementation.

Sources:

- https://priors.trade/skill.md
- https://docs.usebrainchain.com/other-networks
- https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/credit.ts

## Remaining proof

The manifest and ABI provide a contract, not live decoded terms.
This refresh does not claim that current minimum stake, timelock, or worker eligibility passed an `eth_call` check.
No successful task order, settlement, refund, worker hire, exit, or loan appears as owned end-to-end evidence.
The testnet model-provider 403 observations require resolution before a complete worker pilot can pass.
Keep supported read interfaces useful while those requirements remain unmet.

### Subsequent on-chain evidence

The lead later read deployed terms at fixed blocks; evidence is in onchain-terms.json.
Mainnet block0x824 returned minimum stake250000BRAIN, bond62500BRAIN and timelock172800seconds.
Testnet block0x13ea returned minimum stake500BRAIN, bond100BRAIN and timelock7200seconds.
Both networks returned BRAIN decimals18 and USDG decimals6; actual RPC chain IDs matched the manifests.
These reads establish those terms only. They do not prove a worker hire, payment, task settlement, exit or credit operation.

## Priors hosted interface evidence at 14:36 UTC

The lead called initialize and tools/list on the official hosted MCP server.
It reports priors-read0.3.0 and protocol2025-03-26.
The selected schemas are preserved in priors-mcp-interface.json.
A read-only agent_record call for public sponsor20423 returned structuredContent.
The raw response is in priors-public-sponsor-record.json.
The snapshot time is2026-11-09T14:35:28Z; it is not a same-block chain proof.

The record exposes separate line, available, drawn, openLoans, defaulted, frozen and owner fields.
The snapshot also exposes qualified repayment counts and owner-history metadata.
Do not derive available credit as line minus drawn; the observed sponsor record has additional backing commitments.
Do not describe a sponsor's available amount as a worker's approved credit.

Both request_borrow and request_repay appear in discovery, but this review did not call them.
Their descriptions promise approval links, not transactions. Their readOnlyHint does not replace ClawVille owner consent.
The borrow schema accepts days1–365 while its description names7,14,30.
Use the narrow documented terms until source validation proves a wider supported set.
All returned links require fixed-origin validation and private delivery to the verified identity owner.

Next implementation: verified ERC-8004 owner binding, bounded structured record reader, issuer-filtered reputation, human/agent parity, then separate consent preparation.
Unknown identity, stale snapshot, missing credit record and no repayment evidence remain distinct states.
Mainnet borrowing, repayment, sponsorship and consent publication remain inactive without their separate authority.

Primary sources: https://priors.trade/skill.md and https://mcp.priors.trade/mcp.
