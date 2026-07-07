/**
 * SAP Option C — OOBE USDC SelfReport escrow: RAW V1 instruction builders.
 *
 * The deployed program is BPF-upgradeable and its stored IDL is INCONSISTENT
 * with live behavior. So the USDC path is NOT built through Anchor's
 * `Program.methods` (which would derive the WRONG account list from the IDL).
 * Instead every instruction here is a hand-assembled `TransactionInstruction`
 * with:
 *   - the EXACT discriminator from `oobe-usdc-selfreport-spec.md` (extracted from
 *     real mainnet txs), and
 *   - the EXACT account order + signer/writable flags from the same spec, and
 *   - manually Borsh-encoded args.
 *
 * The entire USDC path uses the **V1 (non-versioned)** instructions
 * (`create_escrow` / `deposit_escrow` / `settle_calls` / `withdraw_escrow`), NOT
 * the `_v2` family (`_v2` = native-SOL only). DO NOT mix in the v2 client.
 *
 * Pure builders — no network, no DB, no signing. The caller (sap-escrow-gate /
 * sap-client execute tail) attaches the blockhash, fee payer, and signs.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  USDC_DECIMALS,
} from './sap-spl';
import { findAgentPda, findStatsPda, findEscrowV1Pda } from './sap-pdas';

// ── discriminators (8-byte instruction prefix, from real mainnet txs) ─────────
// Source: oobe-usdc-selfreport-spec.md §Discriminators. Hex → bytes.
const DISC_CREATE_ESCROW = Buffer.from('fdd7a574246c4450', 'hex');
const DISC_DEPOSIT_ESCROW = Buffer.from('e2709eb0b2769980', 'hex');
const DISC_SETTLE_CALLS = Buffer.from('649cc586dbf503aa', 'hex');
const DISC_WITHDRAW_ESCROW = Buffer.from('5154e280f52f6068', 'hex');

// ── manual Borsh arg writer (no @solana/spl-token / no IDL coder) ─────────────

/** Encode a bigint as 8-byte little-endian unsigned (u64). Range-checked. */
function u64LE(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

/** Encode a bigint as 8-byte little-endian SIGNED (i64). Range-checked. */
function i64LE(value: bigint): Buffer {
  const MIN = -(2n ** 63n);
  const MAX = 2n ** 63n - 1n;
  if (value < MIN || value > MAX) {
    throw new Error(`i64 out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value, 0);
  return buf;
}

/** Encode an Option<Pubkey>: 1-byte tag (0=None,1=Some) + (when Some) 32 bytes. */
function optionPubkey(value: PublicKey | null): Buffer {
  if (value === null) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), value.toBuffer()]);
}

/** Encode an EMPTY Vec<T>: a 4-byte little-endian length prefix of 0. */
function emptyVec(): Buffer {
  return Buffer.alloc(4); // length = 0
}

// ── deterministic-address resolver (shared by every USDC builder) ─────────────

export interface UsdcEscrowAddresses {
  agentPda: PublicKey;
  agentStatsPda: PublicKey;
  escrowPda: PublicKey;
  vaultAta: PublicKey;
  depositorAta: PublicKey;
  agentAta: PublicKey;
}

/**
 * Resolve every deterministic address the USDC lifecycle needs from the worker
 * wallet + depositor wallet + mint. Centralized so create/deposit/settle/
 * withdraw can never derive them inconsistently.
 *
 *   agentPda     = ["sap_agent", workerWallet]
 *   agentStats   = ["sap_stats", agentPda]
 *   escrowPda    = ["sap_escrow", agentPda, depositor]      (V1, no nonce)
 *   vaultAta     = ATA(mint, escrowPda, allowOwnerOffCurve=true)   ← PDA owner
 *   depositorAta = ATA(mint, depositorWallet)
 *   agentAta     = ATA(mint, workerWallet)   (settle destination)
 */
export function deriveUsdcEscrowAddresses(params: {
  programId: PublicKey;
  workerWallet: PublicKey;
  depositorWallet: PublicKey;
  mint: PublicKey;
}): UsdcEscrowAddresses {
  const { programId, workerWallet, depositorWallet, mint } = params;
  const [agentPda] = findAgentPda(programId, workerWallet);
  const [agentStatsPda] = findStatsPda(programId, agentPda);
  const [escrowPda] = findEscrowV1Pda(programId, agentPda, depositorWallet);
  const vaultAta = getAssociatedTokenAddress(mint, escrowPda, true);
  const depositorAta = getAssociatedTokenAddress(mint, depositorWallet, false);
  const agentAta = getAssociatedTokenAddress(mint, workerWallet, false);
  return { agentPda, agentStatsPda, escrowPda, vaultAta, depositorAta, agentAta };
}

// ── instruction builders ──────────────────────────────────────────────────────

export interface CreateEscrowUsdcArgs {
  depositor: PublicKey;
  addrs: UsdcEscrowAddresses;
  programId: PublicKey;
  mint: PublicKey;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
  /** Unix-seconds expiry (i64). 0 = no expiry. */
  expiresAt: bigint;
}

/**
 * create_escrow (V1, USDC) — disc fdd7a574246c4450.
 *
 * Accounts (spec §1, 4 named + 3 token = 7):
 *   0 depositor (S,W) · 1 agentPda · 2 escrowPda (W) · 3 system_program ·
 *   4 depositorAta (W) · 5 vaultAta (W) · 6 token_program
 *
 * Args: price_per_call:u64, max_calls:u64, initial_deposit:u64, expires_at:i64,
 *       volume_curve:Vec(empty), token_mint:Option=Some(USDC), token_decimals:u8=6
 *
 * NOTE: the vault ATA must already exist — the program does NOT init it. Prepend
 * a `createAssociatedTokenAccountIdempotent(vaultAta)` instruction (sap-spl) in
 * the SAME tx before this one.
 */
export function buildCreateEscrowUsdcIx(args: CreateEscrowUsdcArgs): TransactionInstruction {
  const { depositor, addrs, programId, mint, pricePerCall, maxCalls, initialDeposit, expiresAt } =
    args;
  const data = Buffer.concat([
    DISC_CREATE_ESCROW,
    u64LE(pricePerCall),
    u64LE(maxCalls),
    u64LE(initialDeposit),
    i64LE(expiresAt),
    emptyVec(), // volume_curve: Vec<VolumeCurveBreakpoint> = []
    optionPubkey(mint), // token_mint: Some(USDC)
    Buffer.from([USDC_DECIMALS]), // token_decimals: u8 = 6
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: addrs.agentPda, isSigner: false, isWritable: false },
      { pubkey: addrs.escrowPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: addrs.depositorAta, isSigner: false, isWritable: true },
      { pubkey: addrs.vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface DepositEscrowUsdcArgs {
  depositor: PublicKey;
  addrs: UsdcEscrowAddresses;
  programId: PublicKey;
  amount: bigint;
}

/**
 * deposit_escrow (V1, USDC) — disc e2709eb0b2769980. Top up an existing escrow.
 *
 * Accounts (spec §2):
 *   0 depositor (S,W) · 1 escrowPda (W) · 2 system_program ·
 *   3 depositorAta (W) · 4 vaultAta (W) · 5 token_program
 *
 * Args: amount:u64.
 */
export function buildDepositEscrowUsdcIx(args: DepositEscrowUsdcArgs): TransactionInstruction {
  const { depositor, addrs, programId, amount } = args;
  const data = Buffer.concat([DISC_DEPOSIT_ESCROW, u64LE(amount)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: addrs.escrowPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: addrs.depositorAta, isSigner: false, isWritable: true },
      { pubkey: addrs.vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface SettleCallsUsdcArgs {
  /** The worker agent's registered wallet — the ONLY settle signer (the gate key). */
  workerWallet: PublicKey;
  addrs: UsdcEscrowAddresses;
  programId: PublicKey;
  mint: PublicKey;
  callsToSettle: bigint;
  /** 32-byte service hash = the verification provider's audit root. */
  serviceHash: Buffer;
}

/**
 * settle_calls (V1, USDC) — disc 649cc586dbf503aa. RELEASES vault → agent ATA.
 *
 * Accounts (spec §3, 5 named + 3 token = 8). CRITICAL: the IDL names acct #4
 * `depositor` but that is STALE — it is the **vault ATA (source)**.
 *   0 workerWallet (S,W) · 1 agentPda · 2 agentStats (W) · 3 escrowPda (W) ·
 *   4 vaultAta (W)  ← IDL says "depositor" (STALE) ·
 *   5 agentAta (W) (destination) · 6 token_program · 7 usdc_mint
 *
 * Args: calls_to_settle:u64, service_hash:[u8;32]. NO fee / NO treasury.
 */
export function buildSettleCallsUsdcIx(args: SettleCallsUsdcArgs): TransactionInstruction {
  const { workerWallet, addrs, programId, mint, callsToSettle, serviceHash } = args;
  if (serviceHash.length !== 32) {
    throw new Error(`service_hash must be 32 bytes (got ${serviceHash.length})`);
  }
  const data = Buffer.concat([DISC_SETTLE_CALLS, u64LE(callsToSettle), serviceHash]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: workerWallet, isSigner: true, isWritable: true },
      { pubkey: addrs.agentPda, isSigner: false, isWritable: false },
      { pubkey: addrs.agentStatsPda, isSigner: false, isWritable: true },
      { pubkey: addrs.escrowPda, isSigner: false, isWritable: true },
      // acct #4 — the IDL's "depositor" label is STALE; it is the vault ATA (source).
      { pubkey: addrs.vaultAta, isSigner: false, isWritable: true },
      { pubkey: addrs.agentAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface WithdrawEscrowUsdcArgs {
  depositor: PublicKey;
  addrs: UsdcEscrowAddresses;
  programId: PublicKey;
  amount: bigint;
}

/**
 * withdraw_escrow (V1, USDC) — disc 5154e280f52f6068. Refund unspent → depositor.
 *
 * Accounts (spec §4 — NOTE a DIFFERENT order from create):
 *   0 depositor (S,W) · 1 escrowPda (W) · 2 vaultAta (W) ·
 *   3 depositorAta (W) · 4 token_program
 *
 * Args: amount:u64.
 */
export function buildWithdrawEscrowUsdcIx(args: WithdrawEscrowUsdcArgs): TransactionInstruction {
  const { depositor, addrs, programId, amount } = args;
  const data = Buffer.concat([DISC_WITHDRAW_ESCROW, u64LE(amount)]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: addrs.escrowPda, isSigner: false, isWritable: true },
      { pubkey: addrs.vaultAta, isSigner: false, isWritable: true },
      { pubkey: addrs.depositorAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
