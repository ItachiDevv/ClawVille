# BrainChain testnet liveness and observation policy

Date:2026-11-09. Status: design review required; existing execution gates remain unchanged.

## New evidence

The official Arbitrum sequencer documentation states that Nitro does not create empty blocks without transactions.
Source:https://developer.arbitrum.io/how-arbitrum-works/deep-dives/sequencer-transaction-flow.
An old block timestamp therefore does not alone prove that an idle Nitro chain is unavailable.

The read-only probe at16:59:30Z returned chain274630, Nitro3.11.5 and eth_syncing:false.
The latest head was0x13ec with timestamp age962seconds. It advanced two blocks from the earlier0x13ea observation.
The endpoint does not expose arb_syncStatus. No signature or transaction occurred.
Raw evidence:docs/research/brainchain-2026-11-09/testnet-liveness-investigation.json.

## Integration consequence

The current execution observer uses head-minus12 and requires recent block timestamps.
On a quiet chain, twelve later transactions can take hours. Even the latest block can be older than120seconds.
This can prevent autonomous admission and delivery without demonstrating a protocol failure.
The previous phrase stale testnet head described the measured age; it did not establish a stalled sequencer.

## Required review

Separate response freshness, source availability, canonical block identity, transaction inclusion and consensus finality.
A current HTTP response or eth_syncing:false is not proof of sequencer health or consensus finality.
A fixed number of L2 blocks is also not a proof of parent-chain finality.
Investigate supported safe/finalized tags and parent-chain inclusion data against the deployed Nitro configuration.
Select a documented observation rule appropriate to each action: read-only display, bounded signing, task execution and final money reconciliation.
Retain final sequential hash checks, immutable task hashes, original hire provenance, deadline checks and monotonic observation constraints.
Do not simply remove every age check or accept a caller-supplied timestamp.

Any correction needs an independent review and regression probes for quiet chains, stale endpoints, reorgs, changed heads and expiry during reads.
Do not open signing or purchase gates from this research alone.
The full goal still requires an actual testnet lifecycle; this document does not replace it.

## Supported finality interfaces observed

The testnet endpoint accepts safe and finalized block tags.
The observed safe head was0x13eb; finalized was0x13e9; latest was0x13ec.
The actual arb_getL1Confirmations method accepts a numeric block number, not a hash. It returned0for5100.
The first hash-form probe returned invalid-argument; its evidence remains preserved.
Primary method signature:https://github.com/OffchainLabs/nitro/blob/master/arbnode/api.go.
Evidence:testnet-finality-tags.json and testnet-parent-confirmations.json in the research folder.

Proposed review direction: use freshly fetched latest state for provisional bounded decisions and the supported finalized tag for final settlement evidence.
Keep observation response TTL and final sequential anchor checks separate from the block's historical timestamp.
This is a proposal, not an approved policy change. A synced RPC response does not establish a live sequencer.
If a sequencer stalls after a bounded operation, the durable uncertain-state and liability rules still apply.
Never describe latest or safe reads as finalized. Never release a full liability from a provisional receipt.

## Source coupling inventory after autonomous worker draft

A correction must cover every consumer, not only the signer observer.
The current source has the following separate checks:

| Consumer | Current rule | Review requirement |
|---|---|---|
| chain-client and signer-observation | Head minus twelve | Select an explicit provisional or finalized anchor; preserve same-block reads. |
| signer-policy and signer-rpc | Block timestamp age at most120seconds | Separate trusted RPC response freshness from historical block time. |
| execution, task-delivery, delivery-recovery | Observation TTL plus block age | Preserve final DB-clock deadlines and canonical hire/task anchoring. |
| worker-brief-reader | Final block hash plus block age | Apply the reviewed rule before freezing task bytes. |
| identity-credit and parent-reader | Parent block age and head depth | Review separately against the parent chain; do not change all chains globally. |
| purchase-receipts | BaseSepolia head depth and age | This is another chain; do not reuse a Nitro exception without evidence. |

Signer faucet cooldown and stake withdrawal compare contract timestamps.
Those contract eligibility checks must remain distinct from response freshness.
An idle chain may have an old latest timestamp even when wall-clock cooldown has passed.
A submitted transaction can advance the chain timestamp; its contract execution remains authoritative.
Do not replace a contract deadline with caller time or label a simulation result as settlement.

Suggested test matrix for the separate correction:
- Fresh response with an old but unchanged canonical latest block.
- Delayed response beyond the observation TTL.
- Reorg between the initial and final sequential block reads.
- Latest advances while the selected anchor remains canonical.
- Finalized tag is unavailable, behind the receipt, or inconsistent.
- Owner or root authority expires during final RPC reads.
- Original hire block or task content changes.
- An uncertain operation survives restart without another effect or released liability.

No source policy changed from this inventory.

## Concrete correction contract for implementation review

The root rechecked the official finality documentation on2026-11-09.
Nitro's `finalized` tag represents parent-chain batch-data finality; it does not prove an assertion completed or a withdrawal became executable.
Dedicated-chain configuration and parent-chain tag semantics require verification before financial release.
Sources: https://developer.arbitrum.io/how-arbitrum-works/reference/finality-and-reorgs and https://developer.arbitrum.io/how-arbitrum-works/deep-dives/finality.

The following is a proposed implementation contract, not an activation approval:

1. Use one explicitly testnet274630 provisional-observation policy for worker actions. Keep other chain policies unchanged.
2. Select an actual latest block once; freeze its number, hash and timestamp for all state reads.
3. Record observation start time before the first RPC, not only after the final RPC. Enforce the existing30second total read budget.
4. Re-read that exact block after all dependent reads. Reject a changed hash, number or timestamp.
5. At each effect boundary, enforce observation TTL and the current DB clock, owner grant, root grant and job lease.
6. An old block timestamp alone does not reject this provisional testnet evidence. Preserve future-timestamp rejection and contract-time eligibility checks.
7. Retain original hire provenance, immutable task/result hashes, exact nonce ownership and uncertain liabilities across reorgs or stalled sequencing.
8. Persist the evidence policy/version with operation authority so historical evidence cannot silently gain broader authority.
9. Keep finality-based money release separate. An unavailable or inconsistent finalized tag keeps the hold; no fixed-depth fallback releases it.
10. Do not classify a responsive RPC as a healthy sequencer. Report response time, head age and confirmation level separately.

Source review found an additional timing detail: signer-observation currently stamps observedAt only after its final RPC.
The transport has a30second session deadline, but downstream TTL currently permits another30seconds after that stamp.
The correction must define whether TTL measures acquisition start or completion and test the maximum end-to-end exposure.
Use acquisition start for the proposed30second authority window; final checks must not reset it.

The worker snapshot currently calls head-minus12 stableBlock and reports block age as freshness.
Keep compatibility for existing consumers until each consumer selects an explicit observation policy.
Do not change stableBlock globally because earnings and other readers share it.
Add an explicit provisional latest-block selector for worker decisions, then audit every caller in the table above.

Before finality-based release, verify the deployed testnet parent chain, its finality tags and the node's finality mapping.
The observed different latest/safe/finalized heights demonstrate interface support only.
They do not prove the configured tags provide the required financial guarantee.

## Parent interface check at17:50UTC

BrainChain's network page identifies testnet274630 as a child of Robinhood testnet46630.
Robinhood's official wallet configuration lists https://rpc.testnet.chain.robinhood.com.
The root's four unsigned calls to that endpoint returned HTTP403 on itachi222: chain ID and latest/safe/finalized headers.
Evidence: research/brainchain-2026-11-09/testnet-parent-finality-probe.json.
Sources: https://docs.usebrainchain.com/network and https://docs.robinhood.com/chain/add-network-to-wallet/.
This result does not prove the parent chain lacks finality tags. It leaves the public endpoint verification unavailable from this host.
No credential was loaded and no authority changed. A verified alternative parent RPC or operator configuration remains necessary for finality release evidence.
