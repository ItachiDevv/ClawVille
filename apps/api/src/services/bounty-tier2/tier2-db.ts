import { db, type Database } from '@clawville/database';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { asTier2Error, Tier2Error } from './tier2-errors';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type Tier2Leg =
  | 'fee_charge' | 'fee_refund' | 'funding_sol' | 'funding_usdc' | 'pricing_publish'
  | 'vault_open' | 'settle' | 'finalize' | 'payout' | 'house_refund_to_poster'
  | 'withdraw_dust_usdc' | 'sweep_dust_usdc' | 'refund_withdraw_usdc'
  | 'refund_sweep_usdc' | 'close_pending' | 'close_depositor_ata' | 'close_escrow'
  | 'sweep_sol' | 'bounty';

export type Tier2State =
  | 'fee_pending' | 'fee_unresolved' | 'funding_pending' | 'vault_pending'
  | 'vault_confirmed' | 'vault_unconfirmed' | 'vault_held' | 'settle_snapshot_ops_pending'
  | 'awaiting_finalize' | 'payout_ready' | 'reconcile_payout_failed' | 'cleanup_pending'
  | 'paid' | 'create_failed' | 'settle_exhausted' | 'finalize_exhausted'
  | 'price_blocked' | 'ops_hold' | 'refund_pending' | 'refunded'
  | 'arithmetic_branch_violation' | 'cancelled';

export type LiabilityKind =
  | 'poster_prefund' | 'protocol_fee' | 'reward_payout' | 'poster_refund'
  | 'house_poster_refund' | 'fee_refund' | 'sol_drain';

export interface AdmitBountyArgs {
  bountyId: string; mint: string; genesis: string; posterWallet: string; posterAta: string;
  vaultAta: string; solReturn: string; branch: 'A_plus_fee' | 'B_grossed_up' | 'C_house_funded';
  formulaVersion: number; payoutAtomic: bigint; hunterAta: string | null;
  depositorPublicKey: string; depositorUsdcAta: string; encryptedSecret: string;
  encryptionIv: string; encryptionTag: string;
}

export interface PrepareSendArgs {
  bountyId: string; leg: Tier2Leg; operationId: string; messageBytes: Uint8Array;
  blockhash: string; lastValidHeight: bigint; preparedSlot: bigint; decodedOk: boolean;
  destination: string; amount: bigint; estimatedFee: bigint; predictedAmount: bigint;
  formulaInputs: Record<string, unknown>; accountVersion: string; accountFingerprint: Uint8Array;
  formulaDigest: Uint8Array; preparedDigest: Uint8Array; paymentDigest: Uint8Array;
}

export interface ConfirmArgs {
  bountyId: string; leg: Tier2Leg; operationId: string; signature: string;
  amount: bigint; destination: string; actualFeeLamports: bigint;
}

export interface ProviderCaptureArgs {
  bountyId: string; providerId: string; providerIdentityVersion: number; captureKind: string;
  operationId: string; signature: string; commitment: string; observedSlot: bigint;
  transactionBytes: Uint8Array; transactionDigest: Uint8Array; rawLogs: Uint8Array;
  candidateEvent: Uint8Array; decodedOk: boolean; outer: number; inner: number | null;
  stack: number; stackRaw: number | null; descendantOuter: number; descendantInner: number | null;
  descendantStack: number; pending: string; escrow: string; agent: string; depositor: string;
  settlementIndex: bigint; amount: bigint; destination: string;
}

export interface SolBalanceCaptureArgs {
  bountyId: string; operationId: string; captureKind: string; signature: string;
  sourceAccount: string; sourceAccountIndex: number; observedSlot: bigint;
  preBalanceLamports: bigint; postBalanceLamports: bigint; providerId: string;
  providerIdentityVersion: number; captureBreadcrumb: Uint8Array;
}

export interface SettleSnapshotArgs {
  bountyId: string; pending: string; escrow: string; agent: string; depositor: string;
  settlementIndex: bigint; calls: bigint; amount: bigint | null; provisional: boolean;
  serviceHash: Uint8Array; releaseSlot: bigint | null; eventTimestamp: bigint | null; signature: string;
  settleSlot: bigint; preparedDigest: Uint8Array; accountVersion: string;
  accountFingerprint: Uint8Array; formulaInputs: Record<string, unknown>;
  formulaDigest: Uint8Array; proofId: string;
}

export interface DepositorRow {
  bountyId: string; publicKey: string; usdcAta: string; encryptedSecretKey: string;
  encryptionIv: string; encryptionTag: string;
}

export interface ProviderRegistration {
  providerId: string; endpointFingerprint: string; identityVersion: number;
  operatorIdentity: string; failureDomain: string; archival: boolean;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const APP_ROLE_ENV = 'TIER2_APP_DB_ROLE';
const OPS_ROLE_ENV = 'TIER2_OPS_DB_ROLE';

function roleFromEnv(kind: 'app' | 'ops'): string {
  const value = (process.env[kind === 'app' ? APP_ROLE_ENV : OPS_ROLE_ENV] ??
    (kind === 'app' ? 'clawville_app' : 'clawville_ops')).trim();
  if (!IDENTIFIER.test(value)) throw new Tier2Error('tier2_role_unconfigured');
  return value;
}

let opsDb: Database | null = null;
let opsDbUrl: string | null = null;

function getOpsDb(): Database {
  const url = process.env.TIER2_OPS_DATABASE_URL?.trim();
  if (!url) throw new Tier2Error('ops_surface_unconfigured');
  if (url === process.env.DATABASE_URL?.trim()) {
    throw new Tier2Error('tier2_boot_ops_connection_not_separate');
  }
  if (opsDb && opsDbUrl === url) return opsDb;
  const client = postgres(url, {
    prepare: false,
    max: 2,
    idle_timeout: 30,
    connect_timeout: 10,
    keep_alive: 30,
  });
  opsDb = drizzle(client) as unknown as Database;
  opsDbUrl = url;
  return opsDb;
}

async function inRoleTransaction<T>(database: Database, role: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    // Statement 1 is deliberately the role switch. No query, lock, or definer may precede it.
    await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
    const identity = await tx.execute(sql`SELECT current_user AS role`);
    if (identity[0]?.role !== role) throw new Tier2Error('tier2_role_unconfigured');
    return fn(tx);
  });
}

export async function withTier2AppRole<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRoleTransaction(db, roleFromEnv('app'), fn);
}

export async function withTier2OpsRole<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRoleTransaction(getOpsDb(), roleFromEnv('ops'), fn);
}

async function scalar<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  try {
    const rows = await tx.execute(query);
    return rows[0]?.value as T;
  } catch (error) {
    throw asTier2Error(error);
  }
}

const numeric = (value: bigint) => sql`CAST(${value.toString()} AS numeric)`;
const numericOrNull = (value: bigint | null) => value === null ? sql`NULL` : numeric(value);
const uuidOrNull = (value: string | null) => sql`CAST(${value} AS uuid)`;
const json = (value: Record<string, unknown>) => sql`CAST(${JSON.stringify(value)} AS jsonb)`;

export async function admitBounty(tx: Tx, a: AdmitBountyArgs): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_admit_bounty(
    ${a.bountyId}::uuid,${a.mint},${a.genesis},${a.posterWallet},${a.posterAta},${a.vaultAta},
    ${a.solReturn},${a.branch},${a.formulaVersion},${numeric(a.payoutAtomic)},${a.hunterAta},
    ${a.depositorPublicKey},${a.depositorUsdcAta},${a.encryptedSecret},${a.encryptionIv},${a.encryptionTag}
  ) AS value`);
}

export async function openAutomaticGeneration(tx: Tx, bountyId: string, leg: Tier2Leg): Promise<string> {
  return scalar(tx, sql`SELECT public.tier2_open_automatic_generation(${bountyId}::uuid,${leg})::text AS value`);
}

export async function claimOperation(tx: Tx, bountyId: string, leg: Tier2Leg, opId: string): Promise<string> {
  return scalar(tx, sql`SELECT public.tier2_claim_operation(${bountyId}::uuid,${leg},${opId}::uuid)::text AS value`);
}

export async function loadDepositor(tx: Tx, bountyId: string, leg: Tier2Leg, opId: string): Promise<DepositorRow> {
  try {
    const rows = await tx.execute(sql`SELECT bounty_id::text AS "bountyId",public_key AS "publicKey",
      usdc_ata AS "usdcAta",encrypted_secret_key AS "encryptedSecretKey",encryption_iv AS "encryptionIv",
      encryption_tag AS "encryptionTag" FROM tier2_trusted.load_depositor(${bountyId}::uuid,${leg},${opId}::uuid)`);
    return rows[0] as unknown as DepositorRow;
  } catch (error) {
    throw asTier2Error(error);
  }
}

export async function prepareSend(tx: Tx, a: PrepareSendArgs): Promise<string> {
  return scalar(tx, sql`SELECT public.tier2_prepare_send(
    ${a.bountyId}::uuid,${a.leg},${a.operationId}::uuid,${a.messageBytes},${a.blockhash},
    ${a.lastValidHeight.toString()}::bigint,${numeric(a.preparedSlot)},${a.decodedOk},${a.destination},
    ${numeric(a.amount)},${numeric(a.estimatedFee)},${numeric(a.predictedAmount)},${json(a.formulaInputs)},
    ${a.accountVersion},${a.accountFingerprint},${a.formulaDigest},${a.preparedDigest},${a.paymentDigest}
  )::text AS value`);
}

export async function preSignCheckpoint(tx: Tx, bountyId: string, leg: Tier2Leg, opId: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_pre_sign_checkpoint(${bountyId}::uuid,${leg},${opId}::uuid) AS value`);
}

export async function preBroadcastCheckpoint(tx: Tx, bountyId: string, leg: Tier2Leg, opId: string, signature: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_pre_broadcast_checkpoint(${bountyId}::uuid,${leg},${opId}::uuid,${signature}) AS value`);
}

export async function markBroadcastUnknown(tx: Tx, bountyId: string, leg: Tier2Leg, opId: string, signature: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_mark_broadcast_unknown(${bountyId}::uuid,${leg},${opId}::uuid,${signature}) AS value`);
}

export async function rejectNotBroadcast(tx: Tx, bountyId: string, leg: Tier2Leg, opId: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_reject_not_broadcast(${bountyId}::uuid,${leg},${opId}::uuid) AS value`);
}

export async function consumeOperationConfirmed(tx: Tx, a: ConfirmArgs): Promise<string> {
  return scalar(tx, sql`SELECT public.consume_operation_confirmed(${a.bountyId}::uuid,${a.leg},${a.operationId}::uuid,
    ${a.signature},${numeric(a.amount)},${a.destination},${numeric(a.actualFeeLamports)})::text AS value`);
}

export async function recordProviderCapture(tx: Tx, a: ProviderCaptureArgs): Promise<string> {
  return scalar(tx, sql`SELECT public.tier2_record_provider_capture(
    ${a.bountyId}::uuid,${a.providerId},${a.providerIdentityVersion},${a.captureKind},${a.operationId}::uuid,
    ${a.signature},${a.commitment},${numeric(a.observedSlot)},${a.transactionBytes},${a.transactionDigest},
    ${a.rawLogs},${a.candidateEvent},${a.decodedOk},${a.outer},${a.inner},${a.stack},${a.stackRaw},
    ${a.descendantOuter},${a.descendantInner},${a.descendantStack},${a.pending},${a.escrow},${a.agent},
    ${a.depositor},${numeric(a.settlementIndex)},${numeric(a.amount)},${a.destination})::text AS value`);
}

export async function recordSolBalanceCapture(tx: Tx, a: SolBalanceCaptureArgs): Promise<string> {
  return scalar(tx, sql`SELECT public.tier2_record_sol_balance_capture(
    ${a.bountyId}::uuid,${a.operationId}::uuid,${a.captureKind},${a.signature},${a.sourceAccount},
    ${a.sourceAccountIndex},${numeric(a.observedSlot)},${numeric(a.preBalanceLamports)},
    ${numeric(a.postBalanceLamports)},${a.providerId},${a.providerIdentityVersion},${a.captureBreadcrumb}
  )::text AS value`);
}

export async function consumeSolNoSendDisposition(tx: Tx, bountyId: string, opId: string, captureId: string): Promise<string> {
  return scalar(tx, sql`SELECT public.consume_sol_no_send_disposition(${bountyId}::uuid,${opId}::uuid,${captureId}::uuid)::text AS value`);
}

export async function consumeSettleSnapshot(tx: Tx, a: SettleSnapshotArgs): Promise<boolean> {
  return scalar(tx, sql`SELECT public.consume_settle_snapshot(
    ${a.bountyId}::uuid,${a.pending},${a.escrow},${a.agent},${a.depositor},${numeric(a.settlementIndex)},
    ${numeric(a.calls)},${numericOrNull(a.amount)},${a.provisional},${a.serviceHash},${numericOrNull(a.releaseSlot)},
    ${a.eventTimestamp === null ? sql`NULL` : sql`${a.eventTimestamp.toString()}::bigint`},${a.signature},${numeric(a.settleSlot)},${a.preparedDigest},
    ${a.accountVersion},${a.accountFingerprint},${json(a.formulaInputs)},${a.formulaDigest},${a.proofId}::uuid
  ) AS value`);
}

export async function consumeApprovalOpenReward(tx: Tx, bountyId: string, attemptId: string, amount: bigint, expectedDest: string): Promise<string> {
  return scalar(tx, sql`SELECT public.consume_approval_open_reward(${bountyId}::uuid,${attemptId}::uuid,
    ${numeric(amount)},${expectedDest})::text AS value`);
}

export async function consumeCancelIntent(tx: Tx, bountyId: string, actorId: string): Promise<Date> {
  return scalar(tx, sql`SELECT public.consume_cancel_intent(${bountyId}::uuid,${actorId}::uuid) AS value`);
}

export async function consumeRefundStart(tx: Tx, bountyId: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.consume_refund_start(${bountyId}::uuid) AS value`);
}

export async function consumeFinalizeRelease(tx: Tx, bountyId: string, opId: string, captureId: string, note: string | null): Promise<string> {
  return scalar(tx, sql`SELECT public.consume_finalize_release(${bountyId}::uuid,${opId}::uuid,${captureId}::uuid,${note})::text AS value`);
}

export async function releaseLiability(tx: Tx, bountyId: string, kind: LiabilityKind, asset: 'usdc' | 'sol', epoch: number, evidenceId: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.release_liability(${bountyId}::uuid,${kind},${asset},${epoch},${evidenceId}::uuid) AS value`);
}

export async function consumeOpsContinue(tx: Tx, bountyId: string, leg: Tier2Leg, reason: string): Promise<bigint> {
  const value = await scalar<string>(tx, sql`SELECT public.consume_ops_continue(${bountyId}::uuid,${leg},${reason})::text AS value`);
  return BigInt(value);
}

async function transition(tx: Tx, door: 'driver' | 'reconciler' | 'payout', bountyId: string, oldState: Tier2State, newState: Tier2State, evidenceKind: string, leg: string, evidenceId: string | null): Promise<boolean> {
  const fn = door === 'driver' ? sql.raw('public.tier2_driver_transition')
    : door === 'reconciler' ? sql.raw('public.tier2_reconciler_transition')
      : sql.raw('public.tier2_payout_transition');
  return scalar(tx, sql`SELECT ${fn}(${bountyId}::uuid,${oldState},${newState},${evidenceKind},${leg},${uuidOrNull(evidenceId)}) AS value`);
}

export async function driverTransition(tx: Tx, bountyId: string, oldState: Tier2State, newState: Tier2State, evidenceKind: string, leg: string, evidenceId: string | null): Promise<boolean> {
  return transition(tx, 'driver', bountyId, oldState, newState, evidenceKind, leg, evidenceId);
}

export async function reconcilerTransition(tx: Tx, bountyId: string, oldState: Tier2State, newState: Tier2State, evidenceKind: string, leg: string, evidenceId: string | null): Promise<boolean> {
  return transition(tx, 'reconciler', bountyId, oldState, newState, evidenceKind, leg, evidenceId);
}

export async function payoutTransition(tx: Tx, bountyId: string, oldState: Tier2State, newState: Tier2State, evidenceKind: string, leg: string, evidenceId: string | null): Promise<boolean> {
  return transition(tx, 'payout', bountyId, oldState, newState, evidenceKind, leg, evidenceId);
}

export async function bindHunterPayee(tx: Tx, bountyId: string, hunterAta: string): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_bind_hunter_payee(${bountyId}::uuid,${hunterAta}) AS value`);
}

export async function registerProviderOps(tx: Tx, p: ProviderRegistration): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_register_provider(${p.providerId},${p.endpointFingerprint},
    ${p.identityVersion},${p.operatorIdentity},${p.failureDomain},${p.archival}) AS value`);
}

export async function deactivateProviderOps(tx: Tx, providerId: string, identityVersion: number): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_deactivate_provider(${providerId},${identityVersion}) AS value`);
}

export async function consumeArithmeticViolationOps(tx: Tx, bountyId: string, evidenceId: string): Promise<bigint> {
  const value = await scalar<string>(tx, sql`SELECT public.consume_arithmetic_violation(${bountyId}::uuid,${evidenceId}::uuid)::text AS value`);
  return BigInt(value);
}

export async function opsTransitionOps(tx: Tx, bountyId: string, oldState: Tier2State, newState: Tier2State, evidenceKind: string, leg: string, evidenceId: string | null): Promise<boolean> {
  return scalar(tx, sql`SELECT public.tier2_transition(${bountyId}::uuid,${oldState},${newState},
    ${evidenceKind},${leg},${uuidOrNull(evidenceId)}) AS value`);
}
