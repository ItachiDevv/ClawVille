/**
 * PDA-PARITY — our sap-pdas.ts derivations MUST equal the official SDK's `/pda`
 * (singular) module for every account the escrow-V2 money path touches.
 *
 * WHY (trap-list T1): the SDK ships TWO PDA modules. `/pdas` (plural) is BROKEN —
 * it drops the depositor seed on the escrow, uses a 4-byte nonce, derives stake from
 * the wallet not the agent, and mis-seeds the dispute PDA → addresses that DO NOT
 * exist on-chain (fund lockout). We keep our own sap-pdas.ts and NEVER import `/pdas`.
 * This test pins our derivations to the CORRECT `/pda` (singular) module — the same
 * one the SDK's internal escrow module uses — so a future drift on either side is
 * caught before it produces an un-fundable / un-settleable address.
 */

import { describe, it, expect } from 'bun:test';
import { PublicKey } from '@solana/web3.js';
import {
  deriveAgent,
  deriveAgentStats,
  derivePricingMenu,
  deriveStake,
  deriveEscrowV2,
  derivePendingSettlement,
  deriveDispute,
  deriveGlobalRegistry,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} from '@oobe-protocol-labs/synapse-sap-sdk/pda';
import {
  findAgentPda,
  findStatsPda,
  findPricingPda,
  findStakePda,
  findEscrowPda,
  findPendingPda,
  findDisputePda,
  findGlobalPda,
} from '../sap-pdas';

const PROGRAM_ID = new PublicKey('SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ');
// Fixed vectors (deterministic derivations — any drift shows as a pubkey mismatch).
const wallet = new PublicKey('11111111111111111111111111111112');
const depositor = new PublicKey('So11111111111111111111111111111111111111112');
const NONCE = 7n;
const INDEX = 3n;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = (r: any): PublicKey => (Array.isArray(r) ? r[0] : r);

describe('PDA parity — our sap-pdas.ts === SDK /pda (singular)', () => {
  const [agent] = findAgentPda(PROGRAM_ID, wallet);
  const [escrow] = findEscrowPda(PROGRAM_ID, agent, depositor, NONCE);
  const [pending] = findPendingPda(PROGRAM_ID, escrow, INDEX);

  it('agent ["sap_agent", wallet]', () => {
    expect(agent.equals(sdk(deriveAgent(wallet, PROGRAM_ID)))).toBe(true);
  });
  it('agent_stats ["sap_stats", agent]', () => {
    expect(findStatsPda(PROGRAM_ID, agent)[0].equals(sdk(deriveAgentStats(agent, PROGRAM_ID)))).toBe(true);
  });
  it('pricing_menu ["sap_pricing", agent]', () => {
    expect(findPricingPda(PROGRAM_ID, agent)[0].equals(sdk(derivePricingMenu(agent, PROGRAM_ID)))).toBe(true);
  });
  it('stake ["sap_stake", agent] (NOT wallet — the /pdas bug)', () => {
    expect(findStakePda(PROGRAM_ID, agent)[0].equals(sdk(deriveStake(agent, PROGRAM_ID)))).toBe(true);
  });
  it('escrow_v2 ["sap_escrow_v2", agent, depositor, u64le(nonce)] (WITH depositor + 8-byte nonce)', () => {
    expect(escrow.equals(sdk(deriveEscrowV2(agent, depositor, Number(NONCE), PROGRAM_ID)))).toBe(true);
  });
  it('pending ["sap_pending", escrow, u64le(index)]', () => {
    expect(pending.equals(sdk(derivePendingSettlement(escrow, Number(INDEX), PROGRAM_ID)))).toBe(true);
  });
  it('dispute ["sap_dispute", pending] (NOT [escrow, index] — the /pdas bug)', () => {
    expect(findDisputePda(PROGRAM_ID, pending)[0].equals(sdk(deriveDispute(pending, PROGRAM_ID)))).toBe(true);
  });
  it('global ["sap_global"]', () => {
    expect(findGlobalPda(PROGRAM_ID)[0].equals(sdk(deriveGlobalRegistry(PROGRAM_ID)))).toBe(true);
  });
});
