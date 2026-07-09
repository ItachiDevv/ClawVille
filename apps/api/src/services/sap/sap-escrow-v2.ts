/**
 * SAP Escrow V2 — instruction builders, now BUILT BY ANCHOR off the OFFICIAL
 * `@oobe-protocol-labs/synapse-sap-sdk@1.0.0` IDL (no more hand-rolled
 * discriminators / borsh / account-meta arrays).
 *
 * ── Why this changed (2026-07-09) ─────────────────────────────────────────────
 * OOBE shipped the official SDK 1.0.0 + a refreshed on-chain IDL whose account
 * layouts MATCH the deployed 0.25-family program (and match what we had
 * empirically devnet-verified). We now load THAT IDL into the sap-client Anchor
 * `Program` and let Anchor assemble every V2 escrow instruction. A wire-parity
 * test (`__tests__/sap-escrow-v2.test.ts`) asserts the Anchor-built `data`
 * (discriminator + borsh args) and `keys` (named-account metas + order + flags)
 * are BYTE-IDENTICAL to the previously devnet-verified shapes, so the on-chain
 * wire is provably unchanged for create/deposit/settle/finalize/withdraw.
 *
 * The builders are now THIN async wrappers over `program.methods.X(...)
 * .accountsStrict({...}).remainingAccounts([...]).instruction()`. They are pure
 * in the sense that matters for the money path: `.instruction()` performs NO
 * network I/O and NO signing — it only encodes. The caller (sap-client) attaches
 * blockhash, fee payer, and signs via the custodial `executeTx` tail (dry-run /
 * mainnet-genesis-guard / decrypt-in-memory-sign / broadcast-confirm split are
 * UNCHANGED — we never call the SDK's send-methods, which would bypass them).
 *
 * ── Anti-replay is ON-CHAIN in 1.0.0 (the old "chain has no replay" note is dead)
 * The deployed program enforces at-most-once settlement ITSELF: each escrow keeps
 * a monotonic `settlement_index`; `settle_calls_v2` INITS a per-index
 * `PendingSettlement` PDA atomically, and a duplicate settle for a finalized /
 * reused index FAILS LOUD on-chain (SettlementReplay 6138 / EscrowNonceReused
 * 6097 / SettlementAlreadyFinalized 6099). The escrow-gate ledger stays in the
 * path as JOB-LEVEL hygiene (record intent → send → record sig) and as the
 * cross-process at-most-once claim, but it is no longer the ONLY replay guard —
 * the chain is authoritative.
 *
 * ── 1.0.0 account/arg deltas vs the old hand-rolled builders ──────────────────
 *   - settle_calls_v2 : 5 named accts [wallet(S,W), agent(ro), agent_stats(W),
 *       escrow(W), system_program]; NO settlement_receipt (the deployed program
 *       inits the PendingSettlement itself). SPL remaining carries the fee-leg +
 *       pending PDA (order LOAD-BEARING — see `assembleV2SplRemaining`).
 *   - create_escrow_v2 : 7 named accts [depositor(S,W), agent(ro), agent_stake(ro),
 *       agent_stats(W), pricing_menu(ro), escrow(W), system_program].
 *   - file_dispute : now takes TWO args — evidence_hash:[u8;32] AND dispute_type:u8
 *       (DisputeType enum). The old builder omitted dispute_type (malformed).
 *   - close_escrow_v2 : now 3 accts [depositor(S,W), escrow(W), agent_stats(W)].
 *   - resolve_dispute : REMOVED — it does not exist in the 1.0.0 program. Dispute
 *       resolution is now `auto_resolve_dispute` (permissionless, merkle/slash) +
 *       `submit_agent_evidence`. The old arbiter `resolve_dispute` path was never
 *       devnet-confirmed; it is dropped here (a future diff may wire auto_resolve).
 *   - create_pending_settlement : REMOVED — deprecated on-chain (6161); settle
 *       inits the pending itself.
 */

import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { BN, type Program } from '@coral-xyz/anchor';
import { USDC_DECIMALS, TOKEN_PROGRAM_ID } from './sap-spl';

/** SettlementSecurity enum tags (u8) — verbatim from the 1.0.0 IDL enum order. */
export const SETTLEMENT_SECURITY = {
  SelfReport: 0,
  CoSigned: 1,
  DisputeWindow: 2,
} as const;
export type SettlementSecurityMode =
  (typeof SETTLEMENT_SECURITY)[keyof typeof SETTLEMENT_SECURITY];

/**
 * DisputeType enum tags (u8) for `file_dispute` — verbatim from the 1.0.0 IDL
 * `DisputeType` enum variant order. The depositor picks the reason it is
 * disputing a pending release.
 */
export const DISPUTE_TYPE = {
  NonDelivery: 0,
  PartialDelivery: 1,
  Overcharge: 2,
  Quality: 3,
} as const;
export type DisputeTypeTag = (typeof DISPUTE_TYPE)[keyof typeof DISPUTE_TYPE];

/**
 * DisputeOutcome enum tags — RETAINED for documentation / off-chain bookkeeping
 * of how a dispute resolved. NOTE: the 1.0.0 program has NO `resolve_dispute`
 * instruction (resolution is `auto_resolve_dispute` — permissionless, merkle/
 * slash), so there is no live builder that consumes these tags today.
 */
export const DISPUTE_OUTCOME = {
  Pending: 0,
  DepositorWins: 1, // refund the depositor (bounty creator)
  AgentWins: 2, // release to the worker (bounty hunter)
  AutoReleased: 3,
} as const;
export type DisputeOutcome =
  (typeof DISPUTE_OUTCOME)[keyof typeof DISPUTE_OUTCOME];

// ── helpers ───────────────────────────────────────────────────────────────────

/** bigint → Anchor `BN` (decimal string round-trip; keeps u64/i64 exact). */
function bn(value: bigint): BN {
  return new BN(value.toString());
}

function assert32(name: string, b: Buffer | Uint8Array): number[] {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes (got ${b.length})`);
  return Array.from(b);
}

// ── builders (async — Anchor `.instruction()` encodes, never signs/sends) ──────

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
   * SPL remaining accounts for the funding transfer (token escrow only), assembled
   * via `assembleV2SplRemaining('create', …)` — [depositorAta, vaultAta, tokenProgram]
   * (NO mint). Empty for a native-SOL escrow.
   */
  remaining?: AccountMeta[];
}

/**
 * create_escrow_v2 — opens + funds the escrow (fund-at-create). 7 named accounts;
 * a matching pricing tier MUST be provisioned first (update_agent) or create fails
 * PricingTierNotFound 6148, AND the worker must have staked ≥ the coverage
 * requirement (StakeBelowMinimum 6107 / insufficient coverage). initial_deposit
 * MUST EXCEED price_per_call×max_calls (protocol fee at settle). The vault ATA must
 * already exist — the caller prepends an idempotent create-ATA ix.
 */
export function buildCreateEscrowV2Ix(
  program: Program,
  args: CreateEscrowV2Args,
): Promise<TransactionInstruction> {
  return program.methods
    .createEscrowV2(
      bn(args.escrowNonce),
      bn(args.pricePerCall),
      bn(args.maxCalls),
      bn(args.initialDeposit),
      bn(args.expiresAt),
      [], // volume_curve: Vec<VolumeCurveBreakpoint> = []
      args.tokenMint,
      args.tokenDecimals,
      args.settlementSecurity,
      bn(args.disputeWindowSlots),
      args.coSigner,
      args.arbiter,
    )
    .accountsStrict({
      depositor: args.depositor,
      agent: args.agentPda,
      agentStake: args.agentStakePda,
      agentStats: args.agentStatsPda,
      pricingMenu: args.pricingMenuPda,
      escrow: args.escrowPda,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(args.remaining ?? [])
    .instruction();
}

export interface DepositEscrowV2Args {
  depositor: PublicKey;
  escrowPda: PublicKey;
  escrowNonce: bigint;
  amount: bigint;
  /** SPL remaining ([depositorAta, vaultAta, tokenProgram] — NO mint). */
  remaining?: AccountMeta[];
}

/** deposit_escrow_v2 — top up an existing escrow. Accounts: [depositor, escrow, system]. */
export function buildDepositEscrowV2Ix(
  program: Program,
  args: DepositEscrowV2Args,
): Promise<TransactionInstruction> {
  return program.methods
    .depositEscrowV2(bn(args.escrowNonce), bn(args.amount))
    .accountsStrict({
      depositor: args.depositor,
      escrow: args.escrowPda,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(args.remaining ?? [])
    .instruction();
}

export interface SettleCallsV2Args {
  /** the worker/agent registered wallet (the settle signer). */
  workerWallet: PublicKey;
  agentPda: PublicKey;
  agentStatsPda: PublicKey;
  escrowPda: PublicKey;
  escrowNonce: bigint;
  callsToSettle: bigint;
  /** 32-byte service hash = the Covenant/verification audit root. */
  serviceHash: Buffer | Uint8Array;
  /**
   * remaining_accounts (order LOAD-BEARING):
   *   [vaultAta(W), workerAta(W), tokenProgram(ro), treasuryAta(W), pendingPda(W)].
   * The deployed settle CHARGES the protocol fee from the vault → treasury AND
   * INITS the pending settlement itself (pending PDA = ["sap_pending", escrow,
   * settlement_index]). It does NOT release principal (that is finalize_settlement).
   */
  remaining?: AccountMeta[];
}

/**
 * settle_calls_v2 — 5 named accounts [wallet(worker,S,W), agent(ro), agent_stats(W),
 * escrow(W), system_program]. DisputeWindow: settle charges the fee to treasury +
 * INITS the pending settlement, then finalize releases principal after the window.
 * On-chain anti-replay: the monotonic settlement_index + per-index pending PDA
 * (SettlementReplay 6138 on a reused/finalized index).
 */
export function buildSettleCallsV2Ix(
  program: Program,
  args: SettleCallsV2Args,
): Promise<TransactionInstruction> {
  return program.methods
    .settleCallsV2(bn(args.escrowNonce), bn(args.callsToSettle), assert32('service_hash', args.serviceHash))
    .accountsStrict({
      wallet: args.workerWallet,
      agent: args.agentPda,
      agentStats: args.agentStatsPda,
      escrow: args.escrowPda,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(args.remaining ?? [])
    .instruction();
}

export interface FinalizeSettlementArgs {
  /** any fee-payer/crank (signer) — permissionless once the window elapses. */
  payer: PublicKey;
  /** the worker's wallet (release destination owner). */
  agentWallet: PublicKey;
  escrowPda: PublicKey;
  pendingPda: PublicKey;
  agentStatsPda: PublicKey;
  /** SPL remaining ([vaultAta, workerAta, tokenProgram] — NO mint). */
  remaining?: AccountMeta[];
}

/**
 * finalize_settlement — after the dispute window elapses with no dispute, releases
 * the PRINCIPAL vault → worker. No args. 5 named accounts [payer(S,W),
 * agent_wallet(W), escrow(W), pending_settlement(W), agent_stats(W)].
 */
export function buildFinalizeSettlementIx(
  program: Program,
  args: FinalizeSettlementArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .finalizeSettlement()
    .accountsStrict({
      payer: args.payer,
      agentWallet: args.agentWallet,
      escrow: args.escrowPda,
      pendingSettlement: args.pendingPda,
      agentStats: args.agentStatsPda,
    })
    .remainingAccounts(args.remaining ?? [])
    .instruction();
}

export interface FileDisputeArgs {
  /** the depositor (bounty creator) — the only party that can dispute. */
  depositor: PublicKey;
  escrowPda: PublicKey;
  pendingPda: PublicKey;
  disputePda: PublicKey;
  /** 32-byte hash of the depositor's dispute evidence. */
  evidenceHash: Buffer | Uint8Array;
  /**
   * DisputeType (u8) — REQUIRED, no silent default. dispute_type is payout-semantic:
   * it feeds the on-chain auto_resolve/merkle model (NonDelivery → full DepositorWins
   * vs PartialDelivery → split vs Overcharge → partial), so a wrong/assumed category
   * biases the resolution against a party. The caller MUST choose it explicitly.
   */
  disputeType: DisputeTypeTag;
}

/**
 * file_dispute — the depositor disputes a pending release within the window →
 * blocks finalize until resolution. 5 named accounts [depositor(S,W), escrow(ro),
 * pending_settlement(W), dispute(W), system_program]. args: evidence_hash:[u8;32]
 * + dispute_type:u8. dispute PDA = ["sap_dispute", pending].
 *
 * NOTE: this BUILDER is retained (correct 1.0.0 shape), but there is NO reachable
 * executor/route that files a dispute through the ClawVille surface — a filed dispute
 * sets pending.is_disputed and BLOCKS finalize, and 1.0.0 resolution is the
 * permissionless auto_resolve_dispute (merkle/slash) which is NOT wired. v1 posture =
 * DisputeWindow-as-timelock (no dispute filed through us; finalize releases after the
 * window). An external depositor can still file on-chain directly — an auto_resolve
 * crank is a REQUIRED follow-up before the rail serves untrusted depositors.
 */
export function buildFileDisputeIx(
  program: Program,
  args: FileDisputeArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .fileDispute(assert32('evidence_hash', args.evidenceHash), args.disputeType)
    .accountsStrict({
      depositor: args.depositor,
      escrow: args.escrowPda,
      pendingSettlement: args.pendingPda,
      dispute: args.disputePda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface WithdrawEscrowV2Args {
  depositor: PublicKey;
  escrowPda: PublicKey;
  amount: bigint;
  /** SPL remaining ([vaultAta, depositorAta, tokenProgram] — NO mint). */
  remaining?: AccountMeta[];
}

/**
 * withdraw_escrow_v2 — refund unspent USDC → depositor (creator reclaim after the
 * work-deadline expires, or on cancel; works on an ACTIVE escrow — recovery path).
 * 2 named accounts [depositor(S,W), escrow(W)] + SPL remaining. arg: amount:u64.
 */
export function buildWithdrawEscrowV2Ix(
  program: Program,
  args: WithdrawEscrowV2Args,
): Promise<TransactionInstruction> {
  return program.methods
    .withdrawEscrowV2(bn(args.amount))
    .accountsStrict({ depositor: args.depositor, escrow: args.escrowPda })
    .remainingAccounts(args.remaining ?? [])
    .instruction();
}

export interface CloseEscrowV2Args {
  depositor: PublicKey;
  escrowPda: PublicKey;
  /** agent_stats PDA — 1.0.0 added it to close_escrow_v2 (was absent in 0.18). */
  agentStatsPda: PublicKey;
}

/**
 * close_escrow_v2 — depositor closes a fully-settled/refunded escrow, reclaiming
 * rent. 1.0.0: 3 named accounts [depositor(S,W), escrow(W), agent_stats(W)].
 * On-chain refuses if balance ≠ 0 OR pending_amount ≠ 0 (EscrowNotEmpty/NotClosed).
 */
export function buildCloseEscrowV2Ix(
  program: Program,
  args: CloseEscrowV2Args,
): Promise<TransactionInstruction> {
  return program.methods
    .closeEscrowV2()
    .accountsStrict({
      depositor: args.depositor,
      escrow: args.escrowPda,
      agentStats: args.agentStatsPda,
    })
    .instruction();
}

export interface CloseDisputeArgs {
  depositor: PublicKey;
  disputePda: PublicKey;
}

/** close_dispute — reclaim a resolved dispute's rent. Accounts [depositor(S,W), dispute(W)]. */
export function buildCloseDisputeIx(
  program: Program,
  args: CloseDisputeArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .closeDispute()
    .accountsStrict({ depositor: args.depositor, dispute: args.disputePda })
    .instruction();
}

export interface ClosePendingSettlementArgs {
  payer: PublicKey;
  pendingPda: PublicKey;
}

/** close_pending_settlement — reclaim a finalized pending's rent. Accounts [payer(S,W), pending(W)]. */
export function buildClosePendingSettlementIx(
  program: Program,
  args: ClosePendingSettlementArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .closePendingSettlement()
    .accountsStrict({ payer: args.payer, pendingSettlement: args.pendingPda })
    .instruction();
}

// ── SPL remaining_accounts — the SINGLE source of truth for the V2 wire order ──
//
// The token accounts ride as Anchor `remaining_accounts` after the named accounts.
// Writable = token accounts that may be debited/credited; the SPL token program is
// READONLY. The deployed program does NOT take the `mint` here (the base builders
// wrongly included it), so create/deposit/settle/finalize/withdraw DROP the mint.

/** The ATAs / PDAs a V2 SPL remaining-account list may reference (per-kind subset). */
export interface V2SplAtas {
  vaultAta: PublicKey;
  /** Kept for call-site compatibility; the wire lists below never include the mint. */
  tokenMint: PublicKey;
  depositorAta?: PublicKey;
  workerAta?: PublicKey;
  /** SAP protocol treasury ATA — the settle fee-leg (settle only). */
  treasuryAta?: PublicKey;
  /** pending_settlement PDA — settle INITS it (settle only, WRITABLE, idx4). */
  pendingPda?: PublicKey;
}

/** Which V2 token-moving instruction an SPL remaining-account list is being built for. */
export type V2SplKind = 'create' | 'deposit' | 'settle' | 'finalize' | 'withdraw';

/**
 * Assemble the SPL `remaining_accounts` for a V2 token-moving instruction — the
 * SINGLE place the wire order lives. A missing required ATA/PDA is a programming
 * error (throws), never a silent wrong-account. Devnet-verified 2026-07-09 +
 * confirmed byte-identical to the official SDK 1.0.0 settle assembly:
 *   create/deposit → [depositorAta, vaultAta, tokenProgram]              (NO mint)
 *   settle         → [vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda]
 *                    (order LOAD-BEARING: tokenProgram idx2, treasury idx3, pending idx4)
 *   finalize       → [vaultAta, workerAta, tokenProgram]                 (NO mint)
 *   withdraw       → [vaultAta, depositorAta, tokenProgram]              (NO mint)
 */
export function assembleV2SplRemaining(kind: V2SplKind, atas: V2SplAtas): AccountMeta[] {
  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const tokenProgram = ro(TOKEN_PROGRAM_ID);
  const vault = w(atas.vaultAta);
  switch (kind) {
    case 'create':
    case 'deposit': {
      if (!atas.depositorAta) throw new Error(`assembleV2SplRemaining(${kind}): depositorAta required`);
      return [w(atas.depositorAta), vault, tokenProgram];
    }
    case 'settle': {
      // ORDER IS LOAD-BEARING: tokenProgram idx2, treasury fee-leg idx3, pending PDA (W) idx4.
      if (!atas.workerAta) throw new Error('assembleV2SplRemaining(settle): workerAta required');
      if (!atas.treasuryAta) throw new Error('assembleV2SplRemaining(settle): treasuryAta required');
      if (!atas.pendingPda) throw new Error('assembleV2SplRemaining(settle): pendingPda required');
      return [vault, w(atas.workerAta), tokenProgram, w(atas.treasuryAta), w(atas.pendingPda)];
    }
    case 'finalize': {
      if (!atas.workerAta) throw new Error('assembleV2SplRemaining(finalize): workerAta required');
      return [vault, w(atas.workerAta), tokenProgram];
    }
    case 'withdraw': {
      if (!atas.depositorAta) throw new Error('assembleV2SplRemaining(withdraw): depositorAta required');
      return [vault, w(atas.depositorAta), tokenProgram];
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
