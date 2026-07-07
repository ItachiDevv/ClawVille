/**
 * SAP Escrow V2 — the CORRECT USDC escrow instruction builders (hand-assembled).
 *
 * ── WHY THIS REPLACES sap-escrow-usdc.ts (the V1 path) ────────────────────────
 * The prior USDC path (sap-escrow-usdc.ts) was built on the **V1** instructions
 * (`create_escrow` / `settle_calls`) from a stale `oobe-usdc-selfreport-spec.md`.
 * A live devnet smoke proved that path DEAD: `settle_calls` (V1, disc
 * 649cc586…) is the deprecated **native-SOL** 5-account instruction, so jamming
 * USDC token accounts into it trips `ConstraintRaw 2003`, and `SelfReport`
 * settlement-security is rejected on-chain (`SelfReportDeprecated`).
 *
 * The Covenant/OOBE dev then confirmed (live devnet test against the deployed
 * 0.18.0 program `SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ`) that USDC
 * settlement is the **V2 escrow family** + **CoSigned or DisputeWindow** mode.
 * Every discriminator / account order / arg / PDA seed below is verified against
 * the DEPLOYED on-chain 0.18.0 IDL (`synapse_agent_sap.onchain.idl.json`), NOT
 * the SDK's compiled builders (which target a FUTURE 0.25.0 program and add a
 * `settlement_receipt` account the deployed program does not have).
 *
 * ── THE TWO SETTLEMENT MODES (SettlementSecurity) ─────────────────────────────
 *   0 SelfReport   — DEPRECATED on-chain (rejected). Never used.
 *   1 CoSigned     — a `co_signer` (Covenant) must sign the settle; funds release
 *                    immediately in the single `settle_calls_v2` ix. The co_signer
 *                    rides in `remaining_accounts` (dev-confirmed order:
 *                    [co_signer(signer,ro), treasury, ...spl]).
 *   2 DisputeWindow — ClawVille's DEFAULT for bounties. `settle_calls_v2` only
 *                    bumps `pending_amount`/`settlement_index` (no token move);
 *                    `create_pending_settlement` records the pending release;
 *                    after `dispute_window_slots` anyone calls `finalize_settlement`
 *                    to release vault → worker. If the depositor disputes within
 *                    the window (`file_dispute`), the `arbiter` (ClawVille admin)
 *                    calls `resolve_dispute` with DepositorWins (refund) or
 *                    AgentWins (release). This maps 1:1 to the bounty UX:
 *                    post→fund→accept→complete→approve|reject→admin-arbitrates.
 *
 * ── SPL remaining_accounts ────────────────────────────────────────────────────
 * The token accounts are NOT in the IDL account lists — they ride as Anchor
 * `remaining_accounts`. Their exact order is program-defined and the dev gave the
 * settle order explicitly ([co_signer, treasury, ...spl]); for the other token-
 * moving ixs the order is the SDK's `attachSplAccounts` convention. To keep the
 * wire honest and devnet-verifiable, every builder takes its SPL/extra remaining
 * accounts as an EXPLICIT `remaining` param assembled by the caller
 * (sap-client), rather than hard-coding a guessed order here.
 *
 * Pure builders — no network, no DB, no signing. The caller attaches blockhash,
 * fee payer, and signs.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { USDC_DECIMALS } from './sap-spl';

// ── discriminators (8-byte prefix; verbatim from the on-chain 0.18.0 IDL) ─────
const DISC_CREATE_ESCROW_V2 = Buffer.from('eb470a24ce3796bb', 'hex');
const DISC_DEPOSIT_ESCROW_V2 = Buffer.from('6c35504ec8445bbd', 'hex');
const DISC_SETTLE_CALLS_V2 = Buffer.from('3a872bd72d600f91', 'hex');
const DISC_CREATE_PENDING = Buffer.from('fc7c6c094753b804', 'hex');
const DISC_FINALIZE_SETTLEMENT = Buffer.from('dc489877b2c419aa', 'hex');
const DISC_FILE_DISPUTE = Buffer.from('d23fdd72d461c39c', 'hex');
const DISC_RESOLVE_DISPUTE = Buffer.from('e706ca0660670ce6', 'hex');
const DISC_WITHDRAW_ESCROW_V2 = Buffer.from('3dc60724023e1747', 'hex');
const DISC_CLOSE_DISPUTE = Buffer.from('3c125caa64c392c4', 'hex');
const DISC_CLOSE_PENDING = Buffer.from('d36439c417be6bb2', 'hex');

/** SettlementSecurity enum tags (u8), verbatim from the IDL enum order. */
export const SETTLEMENT_SECURITY = {
  SelfReport: 0,
  CoSigned: 1,
  DisputeWindow: 2,
} as const;
export type SettlementSecurityMode =
  (typeof SETTLEMENT_SECURITY)[keyof typeof SETTLEMENT_SECURITY];

/** DisputeOutcome enum tags (u8) for `resolve_dispute`. */
export const DISPUTE_OUTCOME = {
  Pending: 0,
  DepositorWins: 1, // refund the depositor (bounty creator)
  AgentWins: 2, // release to the worker (bounty hunter)
  AutoReleased: 3,
} as const;
export type DisputeOutcome =
  (typeof DISPUTE_OUTCOME)[keyof typeof DISPUTE_OUTCOME];

// ── Borsh arg writers ─────────────────────────────────────────────────────────

function u64LE(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

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

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`u8 out of range: ${value}`);
  }
  return Buffer.from([value]);
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

function assert32(name: string, b: Buffer | Uint8Array): Buffer {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes (got ${b.length})`);
  return Buffer.from(b);
}

// ── builders ──────────────────────────────────────────────────────────────────

export interface CreateEscrowV2Args {
  depositor: PublicKey;
  /** agent PDA (["sap_agent", workerWallet]). */
  agentPda: PublicKey;
  /** escrow PDA (["sap_escrow_v2", agentPda, depositor, escrowNonce]). */
  escrowPda: PublicKey;
  programId: PublicKey;
  escrowNonce: bigint;
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
  /** absolute unix-seconds work-deadline (i64). REQUIRED (> 0) for a bounty. */
  expiresAt: bigint;
  /** SPL token mint (USDC). null ⇒ native-SOL escrow. */
  tokenMint: PublicKey | null;
  tokenDecimals: number;
  settlementSecurity: SettlementSecurityMode;
  /** slots the pending settlement is held before finalize (DisputeWindow). */
  disputeWindowSlots: bigint;
  /** Some(Covenant) for CoSigned; None otherwise. */
  coSigner: PublicKey | null;
  /** Some(ClawVille admin) for DisputeWindow; None otherwise. */
  arbiter: PublicKey | null;
  /**
   * SPL remaining accounts for the funding transfer (token escrow only). The
   * caller assembles them (dev/SDK order: [depositorAta, vaultAta, tokenMint,
   * tokenProgram]). Empty for a native-SOL escrow.
   */
  remaining?: AccountMeta[];
}

/**
 * create_escrow_v2 — disc eb470a24ce3796bb. Opens + funds the escrow (fund-at-
 * create). Accounts: [depositor(S,W), agent(ro), escrow(W), system_program] +
 * SPL remaining. NOTE: the vault ATA must already exist — prepend an idempotent
 * create-ATA ix. For DisputeWindow pass settlementSecurity=2 + arbiter=Some;
 * for CoSigned pass settlementSecurity=1 + coSigner=Some.
 */
export function buildCreateEscrowV2Ix(args: CreateEscrowV2Args): TransactionInstruction {
  const data = Buffer.concat([
    DISC_CREATE_ESCROW_V2,
    u64LE(args.escrowNonce),
    u64LE(args.pricePerCall),
    u64LE(args.maxCalls),
    u64LE(args.initialDeposit),
    i64LE(args.expiresAt),
    emptyVec(), // volume_curve: Vec<VolumeCurveBreakpoint> = []
    optionPubkey(args.tokenMint),
    u8(args.tokenDecimals),
    u8(args.settlementSecurity),
    u64LE(args.disputeWindowSlots),
    optionPubkey(args.coSigner),
    optionPubkey(args.arbiter),
  ]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.agentPda, isSigner: false, isWritable: false },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...(args.remaining ?? []),
    ],
    data,
  });
}

export interface DepositEscrowV2Args {
  depositor: PublicKey;
  escrowPda: PublicKey;
  programId: PublicKey;
  escrowNonce: bigint;
  amount: bigint;
  /** SPL remaining ([depositorAta, vaultAta, tokenMint, tokenProgram]). */
  remaining?: AccountMeta[];
}

/**
 * deposit_escrow_v2 — disc 6c35504ec8445bbd. Top up an existing escrow.
 * Accounts: [depositor(S,W), escrow(W), system_program] + SPL remaining.
 */
export function buildDepositEscrowV2Ix(args: DepositEscrowV2Args): TransactionInstruction {
  const data = Buffer.concat([DISC_DEPOSIT_ESCROW_V2, u64LE(args.escrowNonce), u64LE(args.amount)]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...(args.remaining ?? []),
    ],
    data,
  });
}

export interface SettleCallsV2Args {
  /** the worker/agent registered wallet (the settle signer). */
  workerWallet: PublicKey;
  agentPda: PublicKey;
  agentStatsPda: PublicKey;
  escrowPda: PublicKey;
  programId: PublicKey;
  escrowNonce: bigint;
  callsToSettle: bigint;
  /** 32-byte service hash = the Covenant/verification audit root. */
  serviceHash: Buffer | Uint8Array;
  /**
   * remaining_accounts:
   *   - CoSigned mode: [co_signer(signer,ro), treasury(W), ...spl] (dev-confirmed).
   *   - DisputeWindow mode: [] — this ix only bumps pending_amount; the token move
   *     happens later in finalize_settlement.
   */
  remaining?: AccountMeta[];
}

/**
 * settle_calls_v2 — disc 3a872bd72d600f91. Accounts:
 * [wallet(worker,S,W), agent(ro), agent_stats(W), escrow(W), system_program] +
 * remaining. Behavior depends on the escrow's settlement_security:
 *   - CoSigned: releases immediately (needs co_signer sig + SPL + treasury remaining).
 *   - DisputeWindow: bumps pending_amount + settlement_index (no token move).
 */
export function buildSettleCallsV2Ix(args: SettleCallsV2Args): TransactionInstruction {
  const serviceHash = assert32('service_hash', args.serviceHash);
  const data = Buffer.concat([
    DISC_SETTLE_CALLS_V2,
    u64LE(args.escrowNonce),
    u64LE(args.callsToSettle),
    serviceHash,
  ]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.workerWallet, isSigner: true, isWritable: true },
      { pubkey: args.agentPda, isSigner: false, isWritable: false },
      { pubkey: args.agentStatsPda, isSigner: false, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...(args.remaining ?? []),
    ],
    data,
  });
}

export interface CreatePendingSettlementArgs {
  /** the worker/agent registered wallet (signer). */
  workerWallet: PublicKey;
  agentPda: PublicKey;
  escrowPda: PublicKey;
  pendingPda: PublicKey;
  programId: PublicKey;
  settlementIndex: bigint;
  callsToSettle: bigint;
  amount: bigint;
  serviceHash: Buffer | Uint8Array;
}

/**
 * create_pending_settlement — disc fc7c6c094753b804 (DisputeWindow). Records the
 * pending release the finalize/dispute path acts on. Accounts:
 * [wallet(worker,S,W), agent(ro), escrow(ro), pending(W), system_program].
 * The pending PDA = ["sap_pending", escrow, settlement_index]. Bundle in the SAME
 * tx as settle_calls_v2 using the PRE-increment settlement_index (the value the
 * PDA seed uses), per the SDK's auto-bundle discipline.
 */
export function buildCreatePendingSettlementIx(
  args: CreatePendingSettlementArgs,
): TransactionInstruction {
  const serviceHash = assert32('service_hash', args.serviceHash);
  const data = Buffer.concat([
    DISC_CREATE_PENDING,
    u64LE(args.settlementIndex),
    u64LE(args.callsToSettle),
    u64LE(args.amount),
    serviceHash,
  ]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.workerWallet, isSigner: true, isWritable: true },
      { pubkey: args.agentPda, isSigner: false, isWritable: false },
      { pubkey: args.escrowPda, isSigner: false, isWritable: false },
      { pubkey: args.pendingPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface FinalizeSettlementArgs {
  /** any fee-payer/crank (signer) — permissionless once the window elapses. */
  payer: PublicKey;
  /** the worker's wallet (release destination owner). */
  agentWallet: PublicKey;
  escrowPda: PublicKey;
  pendingPda: PublicKey;
  agentStatsPda: PublicKey;
  programId: PublicKey;
  /** SPL remaining (release vault → worker ATA, + optional treasury fee). */
  remaining?: AccountMeta[];
}

/**
 * finalize_settlement — disc dc489877b2c419aa (DisputeWindow). After the dispute
 * window elapses with no dispute, releases vault → worker. NO args. Accounts:
 * [payer(S,W), agent_wallet(W), escrow(W), pending(W), agent_stats(W)] + SPL.
 */
export function buildFinalizeSettlementIx(args: FinalizeSettlementArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.agentWallet, isSigner: false, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
      { pubkey: args.pendingPda, isSigner: false, isWritable: true },
      { pubkey: args.agentStatsPda, isSigner: false, isWritable: true },
      ...(args.remaining ?? []),
    ],
    data: DISC_FINALIZE_SETTLEMENT,
  });
}

export interface FileDisputeArgs {
  /** the depositor (bounty creator) — the only party that can dispute. */
  depositor: PublicKey;
  escrowPda: PublicKey;
  pendingPda: PublicKey;
  disputePda: PublicKey;
  programId: PublicKey;
  /** 32-byte hash of the depositor's dispute evidence. */
  evidenceHash: Buffer | Uint8Array;
}

/**
 * file_dispute — disc d23fdd72d461c39c (DisputeWindow). The depositor disputes a
 * pending release within the window → blocks finalize until the arbiter resolves.
 * Accounts: [depositor(S,W), escrow(ro), pending(W), dispute(W), system_program].
 * dispute PDA = ["sap_dispute", pending].
 */
export function buildFileDisputeIx(args: FileDisputeArgs): TransactionInstruction {
  const evidenceHash = assert32('evidence_hash', args.evidenceHash);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: false },
      { pubkey: args.pendingPda, isSigner: false, isWritable: true },
      { pubkey: args.disputePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC_FILE_DISPUTE, evidenceHash]),
  });
}

export interface ResolveDisputeArgs {
  /** the arbiter (ClawVille admin) — signs the resolution. */
  arbiter: PublicKey;
  depositor: PublicKey;
  agentWallet: PublicKey;
  escrowPda: PublicKey;
  pendingPda: PublicKey;
  disputePda: PublicKey;
  agentStatsPda: PublicKey;
  programId: PublicKey;
  /** DepositorWins ⇒ refund creator; AgentWins ⇒ release worker. */
  outcome: DisputeOutcome;
  /** SPL remaining (release-or-refund transfer). */
  remaining?: AccountMeta[];
}

/**
 * resolve_dispute — disc e706ca0660670ce6 (DisputeWindow). The arbiter (ClawVille
 * admin) settles a filed dispute. Accounts: [arbiter(S,W), depositor(W),
 * agent_wallet(W), escrow(W), pending(W), dispute(W), agent_stats(W)] + SPL.
 * arg: outcome:u8 (DisputeOutcome).
 */
export function buildResolveDisputeIx(args: ResolveDisputeArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.arbiter, isSigner: true, isWritable: true },
      { pubkey: args.depositor, isSigner: false, isWritable: true },
      { pubkey: args.agentWallet, isSigner: false, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
      { pubkey: args.pendingPda, isSigner: false, isWritable: true },
      { pubkey: args.disputePda, isSigner: false, isWritable: true },
      { pubkey: args.agentStatsPda, isSigner: false, isWritable: true },
      ...(args.remaining ?? []),
    ],
    data: Buffer.concat([DISC_RESOLVE_DISPUTE, u8(args.outcome)]),
  });
}

export interface WithdrawEscrowV2Args {
  depositor: PublicKey;
  escrowPda: PublicKey;
  programId: PublicKey;
  amount: bigint;
  /** SPL remaining (refund vault → depositor ATA). */
  remaining?: AccountMeta[];
}

/**
 * withdraw_escrow_v2 — disc 3dc60724023e1747. Refund unspent USDC → depositor
 * (bounty creator reclaim after the work-deadline expires, or on cancel).
 * Accounts: [depositor(S,W), escrow(W)] + SPL remaining. arg: amount:u64.
 */
export function buildWithdrawEscrowV2Ix(args: WithdrawEscrowV2Args): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.escrowPda, isSigner: false, isWritable: true },
      ...(args.remaining ?? []),
    ],
    data: Buffer.concat([DISC_WITHDRAW_ESCROW_V2, u64LE(args.amount)]),
  });
}

export interface CloseDisputeArgs {
  depositor: PublicKey;
  disputePda: PublicKey;
  programId: PublicKey;
}

/** close_dispute — disc 3c125caa64c392c4. Reclaim a resolved dispute's rent. */
export function buildCloseDisputeIx(args: CloseDisputeArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.disputePda, isSigner: false, isWritable: true },
    ],
    data: DISC_CLOSE_DISPUTE,
  });
}

export interface ClosePendingSettlementArgs {
  payer: PublicKey;
  pendingPda: PublicKey;
  programId: PublicKey;
}

/** close_pending_settlement — disc d36439c417be6bb2. Reclaim a finalized pending's rent. */
export function buildClosePendingSettlementIx(
  args: ClosePendingSettlementArgs,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.pendingPda, isSigner: false, isWritable: true },
    ],
    data: DISC_CLOSE_PENDING,
  });
}

/** Default USDC token decimals (re-exported for callers assembling escrow args). */
export { USDC_DECIMALS };
