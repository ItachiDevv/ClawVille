/**
 * Byte-layout unit tests for the SAP Escrow V2 instruction builders
 * (sap-escrow-v2.ts). PURE-COMPUTE — no DB, no network.
 *
 * These lock the WIRE of the founder-locked bounty settlement family against the
 * deployed 0.18.0 IDL: for each builder we assert
 *   1. the 8-byte discriminator (verbatim hex),
 *   2. the declared (named) account order + isSigner/isWritable flags,
 *   3. the argument byte-encoding (u64/i64 LE, u8, Option<Pubkey> tags, 32-byte
 *      hashes) — the full arg buffer for create_escrow_v2 incl. settlementSecurity
 *      + the co_signer/arbiter Option tags, in BOTH DisputeWindow and CoSigned shapes,
 *   4. that caller-assembled SPL `remaining` accounts are appended in order.
 *
 * A drift here means a malformed on-chain tx (wrong discriminator/account set/args),
 * so this is the first gate before any devnet dry-run.
 */

import { describe, it, expect } from 'bun:test';
import { PublicKey, Keypair, type TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  buildCreateEscrowV2Ix,
  buildDepositEscrowV2Ix,
  buildSettleCallsV2Ix,
  buildCreatePendingSettlementIx,
  buildFinalizeSettlementIx,
  buildFileDisputeIx,
  buildResolveDisputeIx,
  buildWithdrawEscrowV2Ix,
  buildCloseDisputeIx,
  buildClosePendingSettlementIx,
  SETTLEMENT_SECURITY,
  DISPUTE_OUTCOME,
} from '../sap-escrow-v2';

// ── deterministic-ish test fixtures ───────────────────────────────────────────
// Distinct fresh pubkeys per account slot so an order/identity mistake is caught by
// object identity (we hold the expected object). Args are fixed literals.
const PROGRAM_ID = new PublicKey('SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const pk = () => Keypair.generate().publicKey;

const depositor = pk();
const workerWallet = pk();
const agentPda = pk();
const agentStatsPda = pk();
const escrowPda = pk();
const pendingPda = pk();
const disputePda = pk();
const arbiter = pk();
const payer = pk();
const coSignerKey = pk();
const arbiterOptKey = pk();
const tokenMint = pk();

const NONCE = 7n;
const PRICE = 1_000_000n;
const MAX_CALLS = 10n;
const DEPOSIT = 5_000_000n;
const EXPIRES = 1_900_000_000n;
const WINDOW = 2160n;
const CALLS = 3n;
const AMOUNT = 3_000_000n;
const INDEX = 4n;
const HASH32 = Buffer.alloc(32, 0xab);
const EVIDENCE32 = Buffer.alloc(32, 0xcd);

// ── borsh arg re-encoders (independent of the builders, to catch drift) ───────
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

// ── helpers ────────────────────────────────────────────────────────────────────
function disc(ix: TransactionInstruction): string {
  return Buffer.from(ix.data).subarray(0, 8).toString('hex');
}
function expectKey(
  meta: AccountMeta,
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): void {
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
  it('has disc eb470a24ce3796bb + the full DisputeWindow arg buffer + named accounts', () => {
    const ix = buildCreateEscrowV2Ix({
      depositor,
      agentPda,
      escrowPda,
      programId: PROGRAM_ID,
      escrowNonce: NONCE,
      pricePerCall: PRICE,
      maxCalls: MAX_CALLS,
      initialDeposit: DEPOSIT,
      expiresAt: EXPIRES,
      tokenMint,
      tokenDecimals: 6,
      settlementSecurity: SETTLEMENT_SECURITY.DisputeWindow,
      disputeWindowSlots: WINDOW,
      coSigner: null, // DisputeWindow ⇒ None
      arbiter: arbiterOptKey, // DisputeWindow ⇒ Some(arbiter)
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

    // named accounts: [depositor(S,W), agent(ro), escrow(W), system(ro)] + remaining
    expect(ix.keys.length).toBe(4 + sampleRemaining.length);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], agentPda, false, false);
    expectKey(ix.keys[2], escrowPda, false, true);
    expectKey(ix.keys[3], SYSTEM_PROGRAM_ID, false, false);
    expectKey(ix.keys[4], remA, false, true);
    expectKey(ix.keys[5], remB, false, false);
  });

  it('encodes CoSigned as security=1 + Some(co_signer) + None(arbiter)', () => {
    const ix = buildCreateEscrowV2Ix({
      depositor,
      agentPda,
      escrowPda,
      programId: PROGRAM_ID,
      escrowNonce: NONCE,
      pricePerCall: PRICE,
      maxCalls: MAX_CALLS,
      initialDeposit: DEPOSIT,
      expiresAt: EXPIRES,
      tokenMint,
      tokenDecimals: 6,
      settlementSecurity: SETTLEMENT_SECURITY.CoSigned,
      disputeWindowSlots: WINDOW,
      coSigner: coSignerKey, // CoSigned ⇒ Some(co_signer)
      arbiter: null, // CoSigned ⇒ None
      remaining: [],
    });
    const tail = Buffer.concat([
      Buffer.from([SETTLEMENT_SECURITY.CoSigned]), // 1
      u64LE(WINDOW),
      optSome(coSignerKey),
      OPT_NONE,
    ]);
    // The last (1 + 8 + 33 + 1) = 43 bytes are the security/window/coSigner/arbiter tail.
    const data = Buffer.from(ix.data);
    expect(data.subarray(data.length - tail.length).equals(tail)).toBe(true);
  });
});

describe('buildDepositEscrowV2Ix', () => {
  it('has disc 6c35504ec8445bbd + [nonce,amount] args + accounts + remaining', () => {
    const ix = buildDepositEscrowV2Ix({
      depositor,
      escrowPda,
      programId: PROGRAM_ID,
      escrowNonce: NONCE,
      amount: AMOUNT,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('6c35504ec8445bbd');
    const expected = Buffer.concat([
      Buffer.from('6c35504ec8445bbd', 'hex'),
      u64LE(NONCE),
      u64LE(AMOUNT),
    ]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [depositor(S,W), escrow(W), system(ro)] + remaining
    expect(ix.keys.length).toBe(3 + sampleRemaining.length);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, true);
    expectKey(ix.keys[2], SYSTEM_PROGRAM_ID, false, false);
    expectKey(ix.keys[3], remA, false, true);
    expectKey(ix.keys[4], remB, false, false);
  });
});

describe('buildSettleCallsV2Ix', () => {
  it('has disc 3a872bd72d600f91 + [nonce,calls,hash32] args + accounts (DisputeWindow remaining=[])', () => {
    const ix = buildSettleCallsV2Ix({
      workerWallet,
      agentPda,
      agentStatsPda,
      escrowPda,
      programId: PROGRAM_ID,
      escrowNonce: NONCE,
      callsToSettle: CALLS,
      serviceHash: HASH32,
      remaining: [],
    });
    expect(disc(ix)).toBe('3a872bd72d600f91');
    const expected = Buffer.concat([
      Buffer.from('3a872bd72d600f91', 'hex'),
      u64LE(NONCE),
      u64LE(CALLS),
      HASH32,
    ]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [worker(S,W), agent(ro), agentStats(W), escrow(W), system(ro)]
    expect(ix.keys.length).toBe(5);
    expectKey(ix.keys[0], workerWallet, true, true);
    expectKey(ix.keys[1], agentPda, false, false);
    expectKey(ix.keys[2], agentStatsPda, false, true);
    expectKey(ix.keys[3], escrowPda, false, true);
    expectKey(ix.keys[4], SYSTEM_PROGRAM_ID, false, false);
  });

  it('rejects a non-32-byte service hash', () => {
    expect(() =>
      buildSettleCallsV2Ix({
        workerWallet,
        agentPda,
        agentStatsPda,
        escrowPda,
        programId: PROGRAM_ID,
        escrowNonce: NONCE,
        callsToSettle: CALLS,
        serviceHash: Buffer.alloc(31, 1),
      }),
    ).toThrow();
  });
});

describe('buildCreatePendingSettlementIx', () => {
  it('has disc fc7c6c094753b804 + [index,calls,amount,hash32] args + accounts', () => {
    const ix = buildCreatePendingSettlementIx({
      workerWallet,
      agentPda,
      escrowPda,
      pendingPda,
      programId: PROGRAM_ID,
      settlementIndex: INDEX,
      callsToSettle: CALLS,
      amount: AMOUNT,
      serviceHash: HASH32,
    });
    expect(disc(ix)).toBe('fc7c6c094753b804');
    const expected = Buffer.concat([
      Buffer.from('fc7c6c094753b804', 'hex'),
      u64LE(INDEX),
      u64LE(CALLS),
      u64LE(AMOUNT),
      HASH32,
    ]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [worker(S,W), agent(ro), escrow(ro), pending(W), system(ro)]
    expect(ix.keys.length).toBe(5);
    expectKey(ix.keys[0], workerWallet, true, true);
    expectKey(ix.keys[1], agentPda, false, false);
    expectKey(ix.keys[2], escrowPda, false, false);
    expectKey(ix.keys[3], pendingPda, false, true);
    expectKey(ix.keys[4], SYSTEM_PROGRAM_ID, false, false);
  });
});

describe('buildFinalizeSettlementIx', () => {
  it('has disc dc489877b2c419aa (NO args) + accounts (NO system) + remaining', () => {
    const ix = buildFinalizeSettlementIx({
      payer,
      agentWallet: workerWallet,
      escrowPda,
      pendingPda,
      agentStatsPda,
      programId: PROGRAM_ID,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('dc489877b2c419aa');
    // discriminator only (finalize takes no args)
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

describe('buildFileDisputeIx', () => {
  it('has disc d23fdd72d461c39c + [evidence32] arg + accounts', () => {
    const ix = buildFileDisputeIx({
      depositor,
      escrowPda,
      pendingPda,
      disputePda,
      programId: PROGRAM_ID,
      evidenceHash: EVIDENCE32,
    });
    expect(disc(ix)).toBe('d23fdd72d461c39c');
    const expected = Buffer.concat([Buffer.from('d23fdd72d461c39c', 'hex'), EVIDENCE32]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [depositor(S,W), escrow(ro), pending(W), dispute(W), system(ro)]
    expect(ix.keys.length).toBe(5);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, false);
    expectKey(ix.keys[2], pendingPda, false, true);
    expectKey(ix.keys[3], disputePda, false, true);
    expectKey(ix.keys[4], SYSTEM_PROGRAM_ID, false, false);
  });

  it('rejects a non-32-byte evidence hash', () => {
    expect(() =>
      buildFileDisputeIx({
        depositor,
        escrowPda,
        pendingPda,
        disputePda,
        programId: PROGRAM_ID,
        evidenceHash: Buffer.alloc(16, 1),
      }),
    ).toThrow();
  });
});

describe('buildResolveDisputeIx', () => {
  it('has disc e706ca0660670ce6 + [outcome:u8] arg + accounts (NO system) + remaining', () => {
    const ix = buildResolveDisputeIx({
      arbiter,
      depositor,
      agentWallet: workerWallet,
      escrowPda,
      pendingPda,
      disputePda,
      agentStatsPda,
      programId: PROGRAM_ID,
      outcome: DISPUTE_OUTCOME.AgentWins,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('e706ca0660670ce6');
    const expected = Buffer.concat([
      Buffer.from('e706ca0660670ce6', 'hex'),
      Buffer.from([DISPUTE_OUTCOME.AgentWins]), // 2
    ]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [arbiter(S,W), depositor(W), agentWallet(W), escrow(W), pending(W), dispute(W), agentStats(W)] + remaining
    expect(ix.keys.length).toBe(7 + sampleRemaining.length);
    expectKey(ix.keys[0], arbiter, true, true);
    expectKey(ix.keys[1], depositor, false, true);
    expectKey(ix.keys[2], workerWallet, false, true);
    expectKey(ix.keys[3], escrowPda, false, true);
    expectKey(ix.keys[4], pendingPda, false, true);
    expectKey(ix.keys[5], disputePda, false, true);
    expectKey(ix.keys[6], agentStatsPda, false, true);
    expectKey(ix.keys[7], remA, false, true);
    expectKey(ix.keys[8], remB, false, false);
  });

  it('encodes DepositorWins (1) as the outcome byte', () => {
    const ix = buildResolveDisputeIx({
      arbiter,
      depositor,
      agentWallet: workerWallet,
      escrowPda,
      pendingPda,
      disputePda,
      agentStatsPda,
      programId: PROGRAM_ID,
      outcome: DISPUTE_OUTCOME.DepositorWins,
    });
    expect(Buffer.from(ix.data)[8]).toBe(1);
  });
});

describe('buildWithdrawEscrowV2Ix', () => {
  it('has disc 3dc60724023e1747 + [amount] arg + accounts (NO system) + remaining', () => {
    const ix = buildWithdrawEscrowV2Ix({
      depositor,
      escrowPda,
      programId: PROGRAM_ID,
      amount: AMOUNT,
      remaining: sampleRemaining,
    });
    expect(disc(ix)).toBe('3dc60724023e1747');
    const expected = Buffer.concat([Buffer.from('3dc60724023e1747', 'hex'), u64LE(AMOUNT)]);
    expect(Buffer.from(ix.data).equals(expected)).toBe(true);
    // [depositor(S,W), escrow(W)] + remaining
    expect(ix.keys.length).toBe(2 + sampleRemaining.length);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], escrowPda, false, true);
    expectKey(ix.keys[2], remA, false, true);
    expectKey(ix.keys[3], remB, false, false);
  });
});

describe('buildCloseDisputeIx / buildClosePendingSettlementIx', () => {
  it('close_dispute has disc 3c125caa64c392c4 + [depositor(S,W), dispute(W)]', () => {
    const ix = buildCloseDisputeIx({ depositor, disputePda, programId: PROGRAM_ID });
    expect(disc(ix)).toBe('3c125caa64c392c4');
    expect(Buffer.from(ix.data).equals(Buffer.from('3c125caa64c392c4', 'hex'))).toBe(true);
    expect(ix.keys.length).toBe(2);
    expectKey(ix.keys[0], depositor, true, true);
    expectKey(ix.keys[1], disputePda, false, true);
  });

  it('close_pending has disc d36439c417be6bb2 + [payer(S,W), pending(W)]', () => {
    const ix = buildClosePendingSettlementIx({ payer, pendingPda, programId: PROGRAM_ID });
    expect(disc(ix)).toBe('d36439c417be6bb2');
    expect(Buffer.from(ix.data).equals(Buffer.from('d36439c417be6bb2', 'hex'))).toBe(true);
    expect(ix.keys.length).toBe(2);
    expectKey(ix.keys[0], payer, true, true);
    expectKey(ix.keys[1], pendingPda, false, true);
  });
});
