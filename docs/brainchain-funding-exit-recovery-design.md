# Funding and exit recovery implementation contract

Date:2026-11-09. Status: researched design; implementation and independent review remain required.
No funding, exit, signature or wallet transfer occurred.

## Source evidence

The pinned worker funds gas and stake through separate Solana-to-parent conversions, then bridges the acquired assets to BrainChain.
The parent bridge can require token approval before deposit. A parent deposit receipt does not prove child-chain arrival.
Relay status distinguishes success, refund, failure and pending. A failure can precede later recovery.
Sources: [Solana funding](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/solana.ts), [parent bridge](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/bridge.ts), [Relay adapter](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/relay.ts).

The exit source appends a Solana destination to a token transfer's calldata.
It permits Solana exits only on mainnet and describes an automatic parent-asset fallback when conversion costs exceed its limits.
Held exits require manual desk resolution. A Relay request identifier alone does not prove a destination receipt.
Source: [exit implementation](https://github.com/usebrainchain/brainchain-worker/blob/b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/exit.ts).

## Required durable model

Use one owner-bound funding operation with immutable separately authorized legs.
Record source chain, asset, amount, source wallet, worker destination, quote hash, expiry and exact cost limits for each leg.
Keep provider request IDs, original signed bytes, transaction IDs, observed receipts and child retryable identifiers separately.
Maintain acquired-but-not-deposited parent assets as a distinct recovery state.
Do not infer acquisition solely from a wallet balance change; unrelated deposits must not become this operation's funds.

Persist intent and reserve authority before signatures or dispatch.
Represent each leg as prepared, captured, possibly transmitted, observed, finalized, refused or unresolved.
Freeze captured bytes and preserve uncertain liability across restarts.
Record approval separately from token deposit so recovery cannot repeat an already-authorized debit blindly.
If a later leg fails, resume that exact leg after reconciliation. Do not restart the original Solana conversion.
An expired quote requires a new explicit authorization for an unsent leg; it never replaces an uncertain transaction.

## Destination and exit rules

Use separate owner consent for exit amount, maximum total fee, minimum destination amount, destination wallet, network and asset.
The worker lifecycle grant does not authorize an exit or a parent bridge transaction.
An account identity signature does not replace the external source wallet's transaction signature.
Validate every returned contract, program, instruction, signer and destination against the approved route.

If the desk can automatically choose another destination asset, require explicit alternative-destination consent before sending.
If the user authorizes only Solana USDC and the protocol cannot enforce that choice, refuse the exit before signing.
Do not describe a parent payout as a completed Solana payout.

For held exits, expose the immutable source transaction and a safe status link with the reported reason.
Refresh only that operation. Do not transfer again, change its destination or release liability from the held label.
For returned exits, verify exact source-chain refund ownership and amount.
For paid exits, verify destination-chain recipient, mint/token, amount and finalized evidence under that chain's policy.
Unknown or partial evidence remains unresolved, with every verified leg visible.

## Parity and tests

Human controls and bound-agent tools use the same operation service and active-avatar ownership checks.
Show source funds, parent assets, child arrivals, pending income and destination funds separately.
Keep signed bytes and credentials outside model observations.
Test success followed by each later-leg failure, lost responses, duplicate retries, ownership rotation and changed quotes.
Test unrelated balance arrivals, reorgs, destination substitution, excessive fees, held exits and partial refunds.
Add restart tests between approval, deposit receipt and child arrival.

## External limits

Existing evidence shows testnet parent exits, but not Solana exits; mainnet exit terms returned404.
The current session does not authorize mainnet money movement.
Implement verified interfaces and controlled tests; preserve unavailable routes as unmet requirements.
Do not substitute a mainnet Relay route into testnet or activate from this design alone.
