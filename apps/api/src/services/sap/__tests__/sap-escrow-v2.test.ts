/**
 * WIRE-PARITY unit tests for the SAP Escrow V2 instruction builders
 * (sap-escrow-v2.ts) — now built by ANCHOR off the OFFICIAL SDK 1.0.0 IDL.
 *
 * These tests are the de-risk keystone of the "stop hand-rolling / adopt the SDK"
 * change: for each builder we assert the Anchor-built instruction's
 *   1. `data` = the DEVNET-VERIFIED discriminator (verbatim hex) + the exact borsh
 *      arg encoding (independently re-encoded here — u64/i64 LE, u8, Option<Pubkey>
 *      tags, 32-byte hashes), and
 *   2. `keys` = the declared named-account order + isSigner/isWritable flags, then
 *      the caller-assembled SPL `remaining` appended in order.
 * i.e. the on-chain WIRE is byte-identical to the previously devnet-verified shapes,
 * so swapping the hand-rolled builders for Anchor-off-IDL changed nothing on-chain.
 *
 * The builders are async (Anchor `.instruction()` encodes — no network, no signing).
 */

import { describe, it, expect } from 'bun:test';
import {
  Connection,
  PublicKey,
  Keypair,
  type TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import idl from '@oobe-protocol-labs/synapse-sap-sdk/idl/synapse_agent_sap.json';
import {
  buildCreateEscrowV2Ix,
  buildDepositEscrowV2Ix,
  buildSettleCallsV2Ix,
  buildFinalizeSettlementIx,
  buildFileDisputeIx,
  buildWithdrawEscrowV2Ix,
  buildCloseEscrowV2Ix,
  buildCloseDisputeIx,
  buildClosePendingSettlementIx,
  assembleV2SplRemaining,
  SETTLEMENT_SECURITY,
  DISPUTE_TYPE,
} from '../sap-escrow-v2';
import { TOKEN_PROGRAM_ID } from '../sap-spl';

// ── an OFFLINE Anchor Program off the official 1.0.0 IDL (no connection is used —
// `.instruction()` only encodes). The program id comes from idl.address. ────────
const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const pk = () => Keypair.generate().publicKey;
const dummyWallet = {
  publicKey: pk(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: async (t: any) => t,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signAllTransactions: async (t: any) => t,
};
const program = new Program(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new AnchorProvider(new Connection('http://127.0.0.1:8899'), dummyWallet as any, {}),
);

const depositor = pk();
const workerWallet = pk();
const agentPda = pk();
const agentStakePda = pk();
const agentStatsPda = pk();
const pricingMenuPda = pk();
const escrowPda = pk();
const pendingPda = pk();
const disputePda = pk();
const payer = pk();
const coSignerKey = pk();
const arbiterOptKey = pk();
const tokenMint = pk();
const vaultAta = pk();
const depositorAta = pk();
const workerAta = pk();
const treasuryAta = pk();

const NONCE = 7n;
const PRICE = 1_000_000n;
const MAX_CALLS = 10n;
const DEPOSIT = 5_000_000n;
const EXPIRES = 1_900_000_000n;
const WINDOW = 2160n;
const CALLS = 3n;
const AMOUNT = 3_000_000n;
const HASH32 = Buffer.alloc(32, 0xab);
const EVIDENCE32 = Buffer.alloc(32, 0xcd);

// ── borsh arg re-encoders (independent of Anchor, to catch drift) ─────────────
function u64LE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}
function i64LE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v, 0);
  return b;
}
function optSome(pubkey: PublicKey): Buffer {
  return Buffer.concat([Buffer.from([1]), pubkey.toBuffer()]);
}
const OPT_NONE = Buffer.from([0]);

function disc(ix: TransactionInstruction): string {
  return Buffer.from(ix.data).subarray(0, 8).toString('hex');
}
function expectKey(meta: AccountMeta, pubkey: PublicKey, isSigner: boolean, isWritable: boolean): void {
  expect(meta.pubkey.equals(pubkey)).toBe(true);
  expect(meta.isSigner).toBe(isSigner);
  expect(meta.isWritable).toBe(isWritable);
}
/** Two sample SPL remaining metas the caller assembles — used to assert append order. */
const remA = pk();
const remB = pk();
const sampleRemaining: AccountMeta[] = [
  { pubkey: remA, isSigner: false, isWritable: true },
  { pubkey: remB, isSigner: false, isWritable: false },
];

describe('buildCreateEscrowV2Ix', () => {
  it('disc eb470a24ce3796bb + full DisputeWindow arg buffer + 7 named accounts + remaining', async () => {
    const ix = await buildCreateEscrowV2Ix(program, {
      depositor,
      agentPda,
      agentStakePda,
      agentStatsPda,
      pricingMenuPda,
      escrowPda,
      escrowNonce: NONCE,
      pricePerCall: PRICE,
      maxCalls: MAX_CALLS,
      initialDeposit: DEPOSIT,
      expiresAt: EXPIRES,
      tokenMint,
      tokenDecimals: 6,
      settlementSecurity: SETTLEMENT_SECURITY.DisputeWindow,
      disputeWindowSlots: WINDOW,
      coSigner: null,
      arbiter: arbiterOptKey,
      remaining: sampleRemaining,
    });

    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(disc(ix)).toBe('eb470a24ce3796bb');
    const expected = Buffer.concat([
      Buffer.from('eb470a24ce3796bb', 'hex'),
      u64LE(NONCE),
      u64LE(PRICE),
      u64LE(MAX_CALLS),
      u64LE(DEPOSIT),
      i64LE(EXPIRES),
      Buffer.alloc(4), // volume_curve: empty Vec (len 0)
      optSome(tokenMint), // token_mint: Some(USDC)
      Buffer.from([6]), // token_decimals
      Buffer.from([SETTLEMENT_SECURITY.DisputeWindow]), // 2
      u64LE(WINDOW),
      OPT_NONE, // co_signer: None
      optSome(arbiterOptKey), // arbiter: Some
    ]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);

    // 7 named accounts [depositor(S,W), agent(ro), agent_stake(ro), agent_stats(W),
    // pricing_menu(ro), escrow(W), system(ro)] + remaining.
    expect(ix.keys.length).toBe(7 + sampleRemaining.length);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], agentPda, false, false);
    expectKey(ix.keys[2], agentStakePda, false, false);
    expectKey(ix.keys[3], agentStatsPda, false, true);
    expectKey(ix.keys[4], pricingMenuPda, false, false);
    expectKey(ix.keys[5], escrowPda, false, true);
    expectKey(ix.keys[6], SYSTEM_PROGRAM_ID, false, false);
    expectKey(ix.keys[7], remA, false, true);
    expectKey(ix.keys[8], remB, false, false);
  });

  it('encodes CoSigned as security=1 + Some(co_signer) + None(arbiter)', async () => {
    const ix = await buildCreateEscrowV2Ix(program, {
      depositor,
      agentPda,
      agentStakePda,
      agentStatsPda,
      pricingMenuPda,
      escrowPda,
      escrowNonce: NONCE,
      pricePerCall: PRICE,
      maxCalls: MAX_CALLS,
      initialDeposit: DEPOSIT,
      expiresAt: EXPIRES,
      tokenMint,
      tokenDecimals: 6,
      settlementSecurity: SETTLEMENT_SECURITY.CoSigned,
      disputeWindowSlots: WINDOW,
      coSigner: coSignerKey,
      arbiter: null,
      remaining: [],
    });
    const tail = Buffer.concat([
      Buffer.from([SETTLEMENT_SECURITY.CoSigned]), // 1
      u64LE(WINDOW),
      optSome(coSignerKey),
      OPT_NONE,
    ]);
    const data = Buffer.from(ix.data);
    expect(data.subarray(data.length - tail.length).equals(tail)).toBe(true);
  });
});

describe('buildDepositEscrowV2Ix', () => {
  it('disc 6c35504ec8445bbd + [nonce,amount] args + accounts + remaining', async () => {
    const ix = await buildDepositEscrowV2Ix(program, {
      depositor,
      escrowPda,
      escrowNonce: NONCE,
      amount: AMOUNT,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('6c35504ec8445bbd');
    const expected = Buffer.concat([Buffer.from('6c35504ec8445bbd', 'hex'), u64LE(NONCE), u64LE(AMOUNT)]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    expect(ix.keys.length).toBe(3 + sampleRemaining.length);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, true);
    expectKey(ix.keys[2], SYSTEM_PROGRAM_ID, false, false);
    expectKey(ix.keys[3], remA, false, true);
    expectKey(ix.keys[4], remB, false, false);
  });
});

describe('buildSettleCallsV2Ix', () => {
  it('disc 3a872bd72d600f91 + [nonce,calls,hash32] args + 5 named accounts + appended remaining', async () => {
    const ix = await buildSettleCallsV2Ix(program, {
      workerWallet,
      agentPda,
      agentStatsPda,
      escrowPda,
      escrowNonce: NONCE,
      callsToSettle: CALLS,
      serviceHash: HASH32,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('3a872bd72d600f91');
    const expected = Buffer.concat([Buffer.from('3a872bd72d600f91', 'hex'), u64LE(NONCE), u64LE(CALLS), HASH32]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [worker(S,W), agent(ro), agentStats(W), escrow(W), system(ro)] + remaining — NO settlement_receipt.
    expect(ix.keys.length).toBe(5 + sampleRemaining.length);
    expectKey(ix.keys[0], workerWallet, true, true);
    expectKey(ix.keys[1], agentPda, false, false);
    expectKey(ix.keys[2], agentStatsPda, false, true);
    expectKey(ix.keys[3], escrowPda, false, true);
    expectKey(ix.keys[4], SYSTEM_PROGRAM_ID, false, false);
    expectKey(ix.keys[5], remA, false, true);
    expectKey(ix.keys[6], remB, false, false);
  });

  it('rejects a non-32-byte service hash', () => {
    expect(() =>
      buildSettleCallsV2Ix(program, {
        workerWallet,
        agentPda,
        agentStatsPda,
        escrowPda,
        escrowNonce: NONCE,
        callsToSettle: CALLS,
        serviceHash: Buffer.alloc(31, 1),
      }),
    ).toThrow();
  });
});

describe('buildFinalizeSettlementIx', () => {
  it('disc dc489877b2c419aa (NO args) + 5 named accounts + remaining', async () => {
    const ix = await buildFinalizeSettlementIx(program, {
      payer,
      agentWallet: workerWallet,
      escrowPda,
      pendingPda,
      agentStatsPda,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('dc489877b2c419aa');
    expect(Buffer.from(ix.data).equals(Buffer.from('dc489877b2c419aa', 'hex'))).toBe(true);
    // [payer(S,W), agentWallet(W), escrow(W), pending(W), agentStats(W)] + remaining
    expect(ix.keys.length).toBe(5 + sampleRemaining.length);
    expectKey(ix.keys[0], payer, true, true);
    expectKey(ix.keys[1], workerWallet, false, true);
    expectKey(ix.keys[2], escrowPda, false, true);
    expectKey(ix.keys[3], pendingPda, false, true);
    expectKey(ix.keys[4], agentStatsPda, false, true);
    expectKey(ix.keys[5], remA, false, true);
    expectKey(ix.keys[6], remB, false, false);
  });
});

describe('buildFileDisputeIx (1.0.0 — evidence_hash + dispute_type)', () => {
  it('disc d23fdd72d461c39c + [evidence32, disputeType:u8] args + 5 accounts', async () => {
    const ix = await buildFileDisputeIx(program, {
      depositor,
      escrowPda,
      pendingPda,
      disputePda,
      evidenceHash: EVIDENCE32,
      disputeType: DISPUTE_TYPE.Quality,
    });
    expect(disc(ix)).toBe('d23fdd72d461c39c');
    const expected = Buffer.concat([
      Buffer.from('d23fdd72d461c39c', 'hex'),
      EVIDENCE32,
      Buffer.from([DISPUTE_TYPE.Quality]), // 3
    ]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [depositor(S,W), escrow(ro), pending(W), dispute(W), system(ro)]
    expect(ix.keys.length).toBe(5);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, false);
    expectKey(ix.keys[2], pendingPda, false, true);
    expectKey(ix.keys[3], disputePda, false, true);
    expectKey(ix.keys[4], SYSTEM_PROGRAM_ID, false, false);
  });

  it('encodes NonDelivery (0) as the trailing dispute_type byte (zero-case)', async () => {
    const ix = await buildFileDisputeIx(program, {
      depositor,
      escrowPda,
      pendingPda,
      disputePda,
      evidenceHash: EVIDENCE32,
      disputeType: DISPUTE_TYPE.NonDelivery, // REQUIRED — no silent default
    });
    const data = Buffer.from(ix.data);
    expect(data[data.length - 1]).toBe(DISPUTE_TYPE.NonDelivery);
  });

  it('rejects a non-32-byte evidence hash', () => {
    expect(() =>
      buildFileDisputeIx(program, {
        depositor,
        escrowPda,
        pendingPda,
        disputePda,
        evidenceHash: Buffer.alloc(16, 1),
        disputeType: DISPUTE_TYPE.NonDelivery,
      }),
    ).toThrow();
  });
});

describe('buildWithdrawEscrowV2Ix', () => {
  it('disc 3dc60724023e1747 + [amount] arg + [depositor,escrow] + remaining', async () => {
    const ix = await buildWithdrawEscrowV2Ix(program, {
      depositor,
      escrowPda,
      amount: AMOUNT,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('3dc60724023e1747');
    const expected = Buffer.concat([Buffer.from('3dc60724023e1747', 'hex'), u64LE(AMOUNT)]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    expect(ix.keys.length).toBe(2 + sampleRemaining.length);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, true);
    expectKey(ix.keys[2], remA, false, true);
    expectKey(ix.keys[3], remB, false, false);
  });
});

describe('buildCloseEscrowV2Ix (1.0.0 — now 3 accounts incl. agent_stats)', () => {
  it('disc 8d8ff2eb33e76284 (NO args) + [depositor(S,W), escrow(W), agent_stats(W)]', async () => {
    const ix = await buildCloseEscrowV2Ix(program, { depositor, escrowPda, agentStatsPda });
    expect(disc(ix)).toBe('8d8ff2eb33e76284');
    expect(Buffer.from(ix.data).equals(Buffer.from('8d8ff2eb33e76284', 'hex'))).toBe(true);
    expect(ix.keys.length).toBe(3);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, true);
    expectKey(ix.keys[2], agentStatsPda, false, true);
  });
});

describe('buildCloseDisputeIx / buildClosePendingSettlementIx', () => {
  it('close_dispute disc 3c125caa64c392c4 + [depositor(S,W), dispute(W)]', async () => {
    const ix = await buildCloseDisputeIx(program, { depositor, disputePda });
    expect(disc(ix)).toBe('3c125caa64c392c4');
    expect(Buffer.from(ix.data).equals(Buffer.from('3c125caa64c392c4', 'hex'))).toBe(true);
    expect(ix.keys.length).toBe(2);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], disputePda, false, true);
  });

  it('close_pending disc d36439c417be6bb2 + [payer(S,W), pending(W)]', async () => {
    const ix = await buildClosePendingSettlementIx(program, { payer, pendingPda });
    expect(disc(ix)).toBe('d36439c417be6bb2');
    expect(Buffer.from(ix.data).equals(Buffer.from('d36439c417be6bb2', 'hex'))).toBe(true);
    expect(ix.keys.length).toBe(2);
    expectKey(ix.keys[0], payer, true, true);
    expectKey(ix.keys[1], pendingPda, false, true);
  });
});

// ── SPL remaining_accounts wire order — the DEVNET-VERIFIED SSOT (byte-identical to
// the official SDK 1.0.0 settle assembly). A drift is a malformed fee/pending leg. ──
describe('assembleV2SplRemaining (devnet-verified wire order)', () => {
  it('create → [depositorAta(W), vaultAta(W), tokenProgram(ro)] (NO mint)', () => {
    const metas = assembleV2SplRemaining('create', { vaultAta, depositorAta, tokenMint });
    expect(metas.length).toBe(3);
    expectKey(metas[0], depositorAta, false, true);
    expectKey(metas[1], vaultAta, false, true);
    expectKey(metas[2], TOKEN_PROGRAM_ID, false, false);
  });

  it('deposit → [depositorAta(W), vaultAta(W), tokenProgram(ro)] (same as create)', () => {
    const metas = assembleV2SplRemaining('deposit', { vaultAta, depositorAta, tokenMint });
    expect(metas.length).toBe(3);
    expectKey(metas[0], depositorAta, false, true);
    expectKey(metas[1], vaultAta, false, true);
    expectKey(metas[2], TOKEN_PROGRAM_ID, false, false);
  });

  it('settle → [vaultAta(W), workerAta(W), tokenProgram(ro,idx2), treasuryAta(W,idx3), pendingPda(W,idx4)]', () => {
    const metas = assembleV2SplRemaining('settle', { vaultAta, workerAta, treasuryAta, pendingPda, tokenMint });
    expect(metas.length).toBe(5);
    expectKey(metas[0], vaultAta, false, true);
    expectKey(metas[1], workerAta, false, true);
    expectKey(metas[2], TOKEN_PROGRAM_ID, false, false);
    expectKey(metas[3], treasuryAta, false, true);
    expectKey(metas[4], pendingPda, false, true);
  });

  it('finalize → [vaultAta(W), workerAta(W), tokenProgram(ro)] (NO mint)', () => {
    const metas = assembleV2SplRemaining('finalize', { vaultAta, workerAta, tokenMint });
    expect(metas.length).toBe(3);
    expectKey(metas[0], vaultAta, false, true);
    expectKey(metas[1], workerAta, false, true);
    expectKey(metas[2], TOKEN_PROGRAM_ID, false, false);
  });

  it('withdraw → [vaultAta(W), depositorAta(W), tokenProgram(ro)] (NO mint)', () => {
    const metas = assembleV2SplRemaining('withdraw', { vaultAta, depositorAta, tokenMint });
    expect(metas.length).toBe(3);
    expectKey(metas[0], vaultAta, false, true);
    expectKey(metas[1], depositorAta, false, true);
    expectKey(metas[2], TOKEN_PROGRAM_ID, false, false);
  });

  it('throws when a required ATA/PDA is missing (programming-error guard)', () => {
    expect(() => assembleV2SplRemaining('create', { vaultAta, tokenMint })).toThrow();
    expect(() => assembleV2SplRemaining('settle', { vaultAta, workerAta, treasuryAta, tokenMint })).toThrow();
    expect(() => assembleV2SplRemaining('finalize', { vaultAta, tokenMint })).toThrow();
    expect(() => assembleV2SplRemaining('withdraw', { vaultAta, tokenMint })).toThrow();
  });
});
