/**
 * SAP Escrow V2 — the CORRECT USDC escrow instruction builders (hand-assembled).
 *
 * ── DEPLOYED PROGRAM IS 0.25-FAMILY (empirically confirmed 2026-07-09) ────────
 * The devnet program `SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ` now runs the
 * **0.25-family** binary. A full DisputeWindow USDC lifecycle was driven END-TO-END
 * live on devnet (register → init_stake → update_agent(pricing) → create_escrow_v2
 * → settle_calls_v2 → finalize_settlement → withdraw_escrow_v2; funds moved; zero
 * PrivilegeEscalation). The account/arg/SPL shapes below are the EMPIRICAL,
 * devnet-verified truth captured from those transactions (sigs cited per-builder).
 *
 * ⚠️ BOTH vendored IDLs are WRONG, in DIFFERENT places — do NOT "correct" these
 * builders from either IDL:
 *   - `synapse_agent_sap.onchain.idl.json` (0.18.0) is STALE: `create_escrow_v2`
 *     is 4-acct (deployed is 7-acct), `register`/`update_agent` lack `pricing_menu`.
 *   - `synapse_agent_sap.idl.future-0.25.json` (0.25.0) is WRONG for
 *     `settle_calls_v2`: it declares a 6th named `settlement_receipt` account the
 *     DEPLOYED program does NOT take (passing it → InvalidProgramExecutable 3009),
 *     and `create_pending_settlement` is DEPRECATED on-chain (6161) — the deployed
 *     `settle_calls_v2` INITS the pending settlement itself.
 * The client loads the future-0.25 IDL for the Anchor-driven identity/stake/pricing
 * instructions (register/init_stake/deposit_stake/request_unstake/complete_unstake/
 * update_agent — whose account contexts match the deployed binary) and HAND-ROLLS
 * the escrow-V2 money family here to the empirical shapes.
 *
 * ── EMPIRICAL 0.25-family shapes (discriminators are name-derived, unchanged) ──
 *   create_escrow_v2 (eb470a24ce3796bb): 7 named accts
 *     [depositor(S,W), agent(ro), agent_stake(ro), agent_stats(W), pricing_menu(ro),
 *      escrow(W), system]; SPL remaining = [depositorAta, vaultAta, tokenProgram]
 *      (NO mint). initial_deposit MUST EXCEED price_per_call×max_calls (a ~0.44%
 *      protocol fee is charged from the vault at settle; deposit==obligation ⇒
 *      settle fails InsufficientEscrowBalance 6062). tx 2J6kxmaUF2mNkomYvs1VfC536wSa6k8NX3mCr8PMd5ZqCGwgmbBo4WkRFB4M9CoPeSamKTMty55hy24ZEJPN7nkv
 *   settle_calls_v2 (3a872bd72d600f91): 5 named accts (NOT 6 — no settlement_receipt)
 *     [wallet(worker,S,W), agent(ro), agent_stats(W), escrow(W), system]; SPL
 *     remaining = [vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda]
 *     (order LOAD-BEARING: tokenProgram idx2, treasury fee-leg idx3, pending PDA
 *     WRITABLE idx4). The deployed settle CHARGES the fee to treasury + INITS the
 *     pending settlement; it does NOT release principal. tx 512iPTGsnHdSry5XQ61ZFvpV9QGZswmc518GyRQCL1W8kbZLar2cYvVF6veGKomVwXopaZK54fw9EUbPDNGCqUnz
 *   create_pending_settlement (fc7c6c094753b804): DEPRECATED on-chain (6161). The
 *     builder is retained for reference ONLY; settle inits the pending itself.
 *   finalize_settlement (dc489877b2c419aa): 5 named (unchanged); SPL remaining =
 *     [vaultAta, workerAta, tokenProgram] (NO mint). Releases principal → worker
 *     after dispute_window_slots. tx 21QKsYjxm3PK8i79KWPKabPjXbwWQXhTAMTQSfMNdgKPqFg5cZor7Exo8KHu3vAkPJibHwyVHCugC3WxyMSSc7iy
 *   withdraw_escrow_v2 (3dc60724023e1747): [depositor(S,W), escrow(W)]; SPL
 *     remaining = [vaultAta, depositorAta, tokenProgram] (NO mint). tx 3TXwu7CnzNGQGMHS43b1VtMBLTcRRy6BY5zUKKHo4ZTRXPhDxyMZqw1zDSrbBwZiqZWWkUf3SFmkdCTvyzq69Frg
 *   resolve_dispute / CoSigned: NOT live-confirmed — assembleV2SplRemaining('resolve')
 *     keeps its TODO(devnet-confirm). Only the DisputeWindow flow is verified.
 *
 * ── SPL remaining_accounts ────────────────────────────────────────────────────
 * The token accounts are NOT in the IDL account lists — they ride as Anchor
 * `remaining_accounts`. Every builder takes its SPL/extra remaining accounts as an
 * EXPLICIT `remaining` param assembled by `assembleV2SplRemaining` (the SINGLE
 * source of truth for the wire order, below), rather than hard-coding it per-builder.
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
import { USDC_DECIMALS, TOKEN_PROGRAM_ID } from './sap-spl';

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
  /** agent_stake PDA (["sap_stake", agentPda]) — READONLY; the on-chain stake gate. */
  agentStakePda: PublicKey;
  /** agent_stats PDA (["sap_stats", agentPda]) — WRITABLE. */
  agentStatsPda: PublicKey;
  /** pricing_menu PDA (["sap_pricing", agentPda]) — READONLY; a matching tier MUST exist. */
  pricingMenuPda: PublicKey;
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
   * caller assembles them via `assembleV2SplRemaining('create', …)` — the
   * devnet-verified order [depositorAta, vaultAta, tokenProgram] (NO mint). Empty
   * for a native-SOL escrow.
   */
  remaining?: AccountMeta[];
}

/**
 * create_escrow_v2 — disc eb470a24ce3796bb. Opens + funds the escrow (fund-at-
 * create). DEVNET-VERIFIED 7 named accounts (0.25-family — the 0.18 4-acct form is
 * dead, and the SPL remaining drops the `mint` the base builders wrongly included):
 *   [depositor(S,W), agent(ro), agent_stake(ro), agent_stats(W), pricing_menu(ro),
 *    escrow(W), system_program] + SPL remaining [depositorAta, vaultAta, tokenProgram].
 * A matching pricing tier MUST be provisioned on `pricing_menu` first (update_agent)
 * or create fails PricingTierNotFound 6148. initial_deposit MUST EXCEED
 * price_per_call×max_calls (protocol fee at settle; deposit==obligation ⇒
 * InsufficientEscrowBalance 6062 later). The vault ATA must already exist — prepend
 * an idempotent create-ATA ix. For DisputeWindow pass settlementSecurity=2 +
 * arbiter=Some; for CoSigned pass settlementSecurity=1 + coSigner=Some.
 * (devnet-confirmed 2026-07-09 tx 2J6kxmaUF2mNkomYvs1VfC536wSa6k8NX3mCr8PMd5ZqCGwgmbBo4WkRFB4M9CoPeSamKTMty55hy24ZEJPN7nkv)
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
      { pubkey: args.agentStakePda, isSigner: false, isWritable: false },
      { pubkey: args.agentStatsPda, isSigner: false, isWritable: true },
      { pubkey: args.pricingMenuPda, isSigner: false, isWritable: false },
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
  /**
   * SPL remaining ([depositorAta, vaultAta, tokenProgram] — NO mint). INFERRED from
   * the devnet-confirmed create funding transfer (same depositor→vault shape); the
   * deposit_escrow_v2 top-up path itself was NOT independently devnet-exercised.
   */
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
   * remaining_accounts (DEVNET-VERIFIED, DisputeWindow — order LOAD-BEARING):
   *   [vaultAta(W), workerAta(W), tokenProgram(ro, idx2), treasuryAta(W, fee-leg idx3),
   *    pendingPda(W, idx4)].
   * The deployed settle CHARGES the ~0.44% protocol fee from the vault → treasury AND
   * INITS the pending settlement itself (pending PDA = ["sap_pending", escrow,
   * settlement_index]). It does NOT release principal (that is finalize_settlement).
   * This is NOT the old `remaining=[]` shape — see assembleV2SplRemaining('settle').
   */
  remaining?: AccountMeta[];
}

/**
 * settle_calls_v2 — disc 3a872bd72d600f91. DEVNET-VERIFIED 5 named accounts (NOT the
 * future-0.25 IDL's 6 — do NOT add a `settlement_receipt` account; passing it trips
 * InvalidProgramExecutable 3009):
 *   [wallet(worker,S,W), agent(ro), agent_stats(W), escrow(W), system_program]
 * + SPL remaining [vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda].
 * DisputeWindow: settle CHARGES the fee to treasury + INITS the pending settlement
 * (create_pending_settlement is DEPRECATED 6161 — do NOT bundle it), then finalize
 * releases principal after the window. `create_pending_settlement` builder below is
 * kept for reference only.
 * (devnet-confirmed 2026-07-09 tx 512iPTGsnHdSry5XQ61ZFvpV9QGZswmc518GyRQCL1W8kbZLar2cYvVF6veGKomVwXopaZK54fw9EUbPDNGCqUnz)
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
 * create_pending_settlement — disc fc7c6c094753b804.
 *
 * ⚠️ DEPRECATED ON-CHAIN (error 6161). The DEPLOYED 0.25-family `settle_calls_v2`
 * INITS the pending settlement ITSELF (it carries the pending PDA in its SPL
 * remaining, idx4). Calling this instruction against the live program now FAILS
 * with 6161. This builder is retained for REFERENCE / historical wire-shape ONLY —
 * the settle executor (`settleCallsV2Usdc`) MUST NOT bundle it. Do not wire it into
 * any live path.
 *
 * (historical) Accounts: [wallet(worker,S,W), agent(ro), escrow(ro), pending(W),
 * system_program]; pending PDA = ["sap_pending", escrow, settlement_index].
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
  /** SPL remaining (DEVNET-VERIFIED release: [vaultAta, workerAta, tokenProgram] — NO mint). */
  remaining?: AccountMeta[];
}

/**
 * finalize_settlement — disc dc489877b2c419aa (DisputeWindow). After the dispute
 * window elapses with no dispute, releases the PRINCIPAL vault → worker. NO args.
 * 5 named accounts (unchanged): [payer(S,W), agent_wallet(W), escrow(W), pending(W),
 * agent_stats(W)] + SPL remaining [vaultAta, workerAta, tokenProgram] (NO mint —
 * see assembleV2SplRemaining('finalize')).
 * (devnet-confirmed 2026-07-09 tx 21QKsYjxm3PK8i79KWPKabPjXbwWQXhTAMTQSfMNdgKPqFg5cZor7Exo8KHu3vAkPJibHwyVHCugC3WxyMSSc7iy)
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
  /** SPL remaining (DEVNET-VERIFIED refund: [vaultAta, depositorAta, tokenProgram] — NO mint). */
  remaining?: AccountMeta[];
}

/**
 * withdraw_escrow_v2 — disc 3dc60724023e1747. Refund unspent USDC → depositor
 * (bounty creator reclaim after the work-deadline expires, or on cancel; works on
 * an ACTIVE escrow — recovery path). Accounts: [depositor(S,W), escrow(W)] + SPL
 * remaining [vaultAta, depositorAta, tokenProgram] (NO mint — see
 * assembleV2SplRemaining('withdraw')). arg: amount:u64.
 * (devnet-confirmed 2026-07-09 tx 3TXwu7CnzNGQGMHS43b1VtMBLTcRRy6BY5zUKKHo4ZTRXPhDxyMZqw1zDSrbBwZiqZWWkUf3SFmkdCTvyzq69Frg)
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

// ── SPL remaining_accounts — the SINGLE source of truth for the V2 wire order ──
//
// DEVNET-VERIFIED 2026-07-09 (see the file header for the per-instruction tx sigs).
// The token accounts ride as Anchor `remaining_accounts` after the named accounts.
// Flags: token accounts that MAY be debited/credited are WRITABLE; the SPL token
// program is READONLY. The base/SDK builders WRONGLY included the `mint` in these
// lists — the deployed program does NOT take it (except the still-unconfirmed
// `resolve`), so create/deposit/settle/finalize/withdraw DROP the mint.

/** The ATAs / PDAs a V2 SPL remaining-account list may reference (per-kind subset). */
export interface V2SplAtas {
  vaultAta: PublicKey;
  /** Only used by the (unconfirmed) `resolve` list, which still carries the mint. */
  tokenMint: PublicKey;
  depositorAta?: PublicKey;
  workerAta?: PublicKey;
  /** SAP protocol treasury ATA — the settle fee-leg (settle only). */
  treasuryAta?: PublicKey;
  /** pending_settlement PDA — settle INITS it (settle only, WRITABLE, idx4). */
  pendingPda?: PublicKey;
}

/** Which V2 token-moving instruction an SPL remaining-account list is being built for. */
export type V2SplKind = 'create' | 'deposit' | 'settle' | 'finalize' | 'resolve' | 'withdraw';

/**
 * Assemble the SPL `remaining_accounts` for a V2 token-moving instruction — the
 * SINGLE place the wire order lives. A missing required ATA/PDA is a programming
 * error (throws), never a silent wrong-account.
 *
 * DEVNET-VERIFIED 2026-07-09 (create/settle/finalize/withdraw):
 *   create/deposit → [depositorAta, vaultAta, tokenProgram]              (NO mint)
 *   settle         → [vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda]
 *                    (order LOAD-BEARING: tokenProgram idx2, treasury idx3, pending idx4)
 *   finalize       → [vaultAta, workerAta, tokenProgram]                 (NO mint)
 *   withdraw       → [vaultAta, depositorAta, tokenProgram]              (NO mint)
 * UNCONFIRMED (best-support default; MUST be devnet-verified before a live flip):
 *   resolve        → flagged inline with TODO(devnet-confirm).
 */
export function assembleV2SplRemaining(kind: V2SplKind, atas: V2SplAtas): AccountMeta[] {
  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const tokenProgram = ro(TOKEN_PROGRAM_ID);
  const vault = w(atas.vaultAta);
  switch (kind) {
    case 'create':
    case 'deposit': {
      // devnet-confirmed 2026-07-09 tx 2J6kxmaUF2mNkomYvs1VfC536wSa6k8NX3mCr8PMd5ZqCGwgmbBo4WkRFB4M9CoPeSamKTMty55hy24ZEJPN7nkv
      if (!atas.depositorAta) throw new Error(`assembleV2SplRemaining(${kind}): depositorAta required`);
      return [w(atas.depositorAta), vault, tokenProgram];
    }
    case 'settle': {
      // devnet-confirmed 2026-07-09 tx 512iPTGsnHdSry5XQ61ZFvpV9QGZswmc518GyRQCL1W8kbZLar2cYvVF6veGKomVwXopaZK54fw9EUbPDNGCqUnz
      // ORDER IS LOAD-BEARING: tokenProgram idx2, treasury fee-leg idx3, pending PDA (W) idx4.
      if (!atas.workerAta) throw new Error('assembleV2SplRemaining(settle): workerAta required');
      if (!atas.treasuryAta) throw new Error('assembleV2SplRemaining(settle): treasuryAta required');
      if (!atas.pendingPda) throw new Error('assembleV2SplRemaining(settle): pendingPda required');
      return [vault, w(atas.workerAta), tokenProgram, w(atas.treasuryAta), w(atas.pendingPda)];
    }
    case 'finalize': {
      // devnet-confirmed 2026-07-09 tx 21QKsYjxm3PK8i79KWPKabPjXbwWQXhTAMTQSfMNdgKPqFg5cZor7Exo8KHu3vAkPJibHwyVHCugC3WxyMSSc7iy
      if (!atas.workerAta) throw new Error('assembleV2SplRemaining(finalize): workerAta required');
      return [vault, w(atas.workerAta), tokenProgram];
    }
    case 'withdraw': {
      // devnet-confirmed 2026-07-09 tx 3TXwu7CnzNGQGMHS43b1VtMBLTcRRy6BY5zUKKHo4ZTRXPhDxyMZqw1zDSrbBwZiqZWWkUf3SFmkdCTvyzq69Frg
      if (!atas.depositorAta) throw new Error('assembleV2SplRemaining(withdraw): depositorAta required');
      return [vault, w(atas.depositorAta), tokenProgram];
    }
    case 'resolve': {
      // TODO(devnet-confirm): resolve_dispute / CoSigned SPL order + identity NOT
      // dev-verified. Best-support default carries BOTH destinations (vault → depositor
      // on refund, vault → worker on release) + the mint; the program selects by outcome.
      // DisputeWindow is the only verified flow — do NOT flip resolve live off this guess.
      if (!atas.depositorAta || !atas.workerAta) {
        throw new Error('assembleV2SplRemaining(resolve): depositorAta + workerAta required');
      }
      return [vault, w(atas.depositorAta), w(atas.workerAta), ro(atas.tokenMint), tokenProgram];
    }
    default: {
      // Exhaustiveness guard — a new V2SplKind must add a case above.
      const _exhaustive: never = kind;
      throw new Error(`assembleV2SplRemaining: unhandled kind ${String(_exhaustive)}`);
    }
  }
}

/** Default USDC token decimals (re-exported for callers assembling escrow args). */
export { USDC_DECIMALS };
