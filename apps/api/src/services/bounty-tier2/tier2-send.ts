import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { sql } from 'drizzle-orm';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import { decryptSecretKey } from '../keypair-vault';
import {
  claimOperation,
  consumeOperationConfirmed,
  loadDepositor,
  markBroadcastUnknown,
  openAutomaticGeneration,
  prepareSend,
  preBroadcastCheckpoint,
  preSignCheckpoint,
  rejectNotBroadcast,
  withTier2AppRole,
  type Tier2Leg,
} from './tier2-db';
import { asTier2Error, type Tier2ErrorCode } from './tier2-errors';
import { tier2FeeAtomic, tier2MerchantWallet } from './tier2-config';

export interface LegBuildContext {
  bountyId: string;
  leg: Tier2Leg;
  operationId: string;
  depositorPublicKey: string;
  depositorUsdcAta: string;
  generation: bigint;
  expectedDestination: string;
  expectedAmount: bigint;
  estimatedFeeLamports: bigint;
  paymentDigest: Uint8Array;
}

export interface BuiltTx {
  messageBytes: Uint8Array;
  signedBytes?: Uint8Array;
  blockhash: string;
  lastValidHeight: bigint;
  preparedSlot: bigint;
  decodedOk: boolean;
  destination: string;
  amount: bigint;
  estimatedFeeLamports: bigint;
  predictedAmount: bigint;
  formulaInputs: Record<string, unknown>;
  accountVersion: string;
  accountFingerprint: Uint8Array;
  formulaDigest: Uint8Array;
  preparedDigest: Uint8Array;
  paymentDigest: Uint8Array;
}

export interface Tier2ChainAdapter {
  buildLeg(ctx: LegBuildContext): Promise<BuiltTx>;
  sign(kp: Keypair, tx: BuiltTx): Promise<string>;
  broadcast(signed: Uint8Array): Promise<string>;
  readFinalizedStatus(signature: string): Promise<'succeeded' | 'failed' | 'unknown'>;
}

export type Tier2LegOutcome =
  | { kind: 'confirmed'; signature: string; evidenceId: string }
  | { kind: 'broadcast_unknown'; signature: string }
  | { kind: 'not_broadcast_retired'; code: Tier2ErrorCode }
  | { kind: 'failed'; code: Tier2ErrorCode };

export function classifyLiveOperationForRecovery(input: {
  operationId?: unknown;
  state?: unknown;
  signature?: unknown;
  sentAt?: unknown;
}): 'none' | 'retire_not_broadcast' | 'quarantine_broadcast' {
  if (typeof input.operationId !== 'string') return 'none';
  if (input.state === 'broadcast_unknown') return 'quarantine_broadcast';
  return typeof input.signature === 'string' && input.sentAt != null
    ? 'quarantine_broadcast'
    : 'retire_not_broadcast';
}

export async function driveLeg(
  bountyId: string,
  leg: Tier2Leg,
  adapter: Tier2ChainAdapter,
): Promise<Tier2LegOutcome> {
  let operationId: string | null = null;
  let preBroadcast = false;
  let signature: string | null = null;
  try {
    const recovery = await withTier2AppRole(async (tx): Promise<Tier2LegOutcome | null> => {
      const rows = await tx.execute(sql`
        SELECT o.id::text AS operation_id,o.state,s.signature,s.sent_at
        FROM public.bounty_tier2_op_control c
        JOIN public.bounty_tier2_operations o ON o.id=c.live_operation_id
        LEFT JOIN public.bounty_tier2_prepared_sends s ON s.operation_id=o.id
        WHERE c.bounty_id=${bountyId}::uuid AND c.leg=${leg}
        ORDER BY s.created_at DESC LIMIT 1
      `);
      const live = rows[0];
      const action = classifyLiveOperationForRecovery({
        operationId: live?.operation_id,
        state: live?.state,
        signature: live?.signature,
        sentAt: live?.sent_at,
      });
      if (action === 'none') return null;
      const liveOperationId = String(live.operation_id);
      const liveSignature = typeof live.signature === 'string' ? live.signature : null;
      if (live.state === 'broadcast_unknown' && liveSignature) {
        return { kind: 'broadcast_unknown', signature: liveSignature };
      }
      if (action === 'quarantine_broadcast' && liveSignature) {
        await markBroadcastUnknown(tx, bountyId, leg, liveOperationId, liveSignature);
        return { kind: 'broadcast_unknown', signature: liveSignature };
      }
      if (action !== 'retire_not_broadcast') throw new Error('tier2_live_operation_signature_missing');
      await rejectNotBroadcast(tx, bountyId, leg, liveOperationId);
      return null;
    });
    if (recovery) return recovery;

    const claimed = await withTier2AppRole(async (tx) => {
      const operation = await openAutomaticGeneration(tx, bountyId, leg);
      await claimOperation(tx, bountyId, leg, operation);
      const depositor = await loadDepositor(tx, bountyId, leg, operation);
      const planRows = await tx.execute(sql`
        SELECT o.generation::text AS generation,b.tier2_mint,
          CASE ${leg}
            WHEN 'funding_sol' THEN NULL
            WHEN 'funding_usdc' THEN NULL
            WHEN 'refund_withdraw_usdc' THEN NULL
            WHEN 'vault_open' THEN prefund.expected_dest
            WHEN 'payout' THEN reward.expected_dest
            WHEN 'settle' THEN b.tier2_hunter_ata
            WHEN 'finalize' THEN settle_send.formula_inputs->>'finalize_destination'
            ELSE b.tier2_poster_usdc_ata
          END AS destination,
          CASE ${leg}
            WHEN 'vault_open' THEN prefund.liability_atomic
            WHEN 'payout' THEN reward.liability_atomic
            WHEN 'funding_sol' THEN b.tier2_fee_budget_lamports
            WHEN 'fee_charge' THEN 1
            ELSE b.payout_expected_atomic
          END::text AS amount,
          (SELECT value_num::text FROM public.tier2_policy
            WHERE key='max_fee_per_send_lamports') AS estimated_fee
        FROM public.bounty_tier2_operations o
        JOIN public.bounties b ON b.id=o.bounty_id
        LEFT JOIN public.bounty_tier2_liabilities prefund
          ON prefund.bounty_id=b.id AND prefund.kind='poster_prefund'
          AND prefund.asset_kind='usdc' AND prefund.disposition='open'
        LEFT JOIN public.bounty_tier2_liabilities reward
          ON reward.bounty_id=b.id AND reward.kind='reward_payout'
          AND reward.asset_kind='usdc' AND reward.disposition='open'
        LEFT JOIN public.bounty_tier2_settle_snapshots snapshot ON snapshot.bounty_id=b.id
        LEFT JOIN public.bounty_tier2_evidence settle_proof ON settle_proof.id=snapshot.proof_id
        LEFT JOIN public.bounty_tier2_prepared_sends settle_send
          ON settle_send.operation_id=settle_proof.op_id
        WHERE o.id=${operation}::uuid AND o.bounty_id=${bountyId}::uuid AND o.leg=${leg}
      `);
      const plan = planRows[0];
      if (plan.amount == null || plan.generation == null || plan.estimated_fee == null) {
        throw new Error('tier2_send_plan_unavailable');
      }
      const feeDestination = leg === 'fee_charge'
        ? (await getAssociatedTokenAddress(
            new PublicKey(String(plan.tier2_mint)), tier2MerchantWallet(), false,
          )).toBase58()
        : null;
      const destination = feeDestination
        ?? (leg === 'funding_sol' ? depositor.publicKey
          : leg === 'funding_usdc' || leg === 'refund_withdraw_usdc'
            ? depositor.usdcAta : String(plan.destination ?? ''));
      if (!destination) throw new Error('tier2_send_plan_unavailable');
      return {
        operation,
        depositor,
        generation: BigInt(String(plan.generation)),
        destination,
        amount: leg === 'fee_charge' ? tier2FeeAtomic() : BigInt(String(plan.amount)),
        estimatedFee: BigInt(String(plan.estimated_fee)),
      };
    });
    operationId = claimed.operation;
    const built = await adapter.buildLeg({
      bountyId,
      leg,
      operationId,
      depositorPublicKey: claimed.depositor.publicKey,
      depositorUsdcAta: claimed.depositor.usdcAta,
      generation: claimed.generation,
      expectedDestination: claimed.destination,
      expectedAmount: claimed.amount,
      estimatedFeeLamports: claimed.estimatedFee,
      paymentDigest: paymentCoordinateDigest(
        bountyId, leg, operationId, claimed.generation, claimed.amount, claimed.destination,
      ),
    });
    await withTier2AppRole(async (tx) => {
      await prepareSend(tx, {
        bountyId,
        leg,
        operationId: operationId!,
        messageBytes: built.messageBytes,
        blockhash: built.blockhash,
        lastValidHeight: built.lastValidHeight,
        preparedSlot: built.preparedSlot,
        decodedOk: built.decodedOk,
        destination: built.destination,
        amount: built.amount,
        estimatedFee: built.estimatedFeeLamports,
        predictedAmount: built.predictedAmount,
        formulaInputs: built.formulaInputs,
        accountVersion: built.accountVersion,
        accountFingerprint: built.accountFingerprint,
        formulaDigest: built.formulaDigest,
        preparedDigest: built.preparedDigest,
        paymentDigest: built.paymentDigest,
      });
      await preSignCheckpoint(tx, bountyId, leg, operationId!);
    });
    const keypair = decryptSecretKey(
      claimed.depositor.encryptedSecretKey,
      claimed.depositor.encryptionIv,
      claimed.depositor.encryptionTag,
    );
    const signedSignature = await adapter.sign(keypair, built);
    signature = signedSignature;
    await withTier2AppRole(async (tx) => {
      await preBroadcastCheckpoint(tx, bountyId, leg, operationId!, signedSignature);
    });
    preBroadcast = true;
    const broadcastSignature = await adapter.broadcast(built.signedBytes ?? built.messageBytes);
    if (broadcastSignature !== signedSignature) throw new Error('tier2_broadcast_signature_mismatch');
    const status = await adapter.readFinalizedStatus(signedSignature);
    if (status === 'unknown') {
      await withTier2AppRole((tx) => markBroadcastUnknown(tx, bountyId, leg, operationId!, signedSignature));
      return { kind: 'broadcast_unknown', signature: signedSignature };
    }
    if (status === 'failed') {
      await withTier2AppRole((tx) => markBroadcastUnknown(
        tx, bountyId, leg, operationId!, signedSignature,
      ));
      return { kind: 'broadcast_unknown', signature: signedSignature };
    }
    const evidenceId = await withTier2AppRole((tx) => consumeOperationConfirmed(tx, {
      bountyId,
      leg,
      operationId: operationId!,
      signature: signedSignature,
      amount: built.amount,
      destination: built.destination,
      actualFeeLamports: built.estimatedFeeLamports,
    }));
    return { kind: 'confirmed', signature: signedSignature, evidenceId };
  } catch (error) {
    const tier2 = asTier2Error(error);
    if (operationId && preBroadcast && signature) {
      try {
        await withTier2AppRole((tx) => markBroadcastUnknown(
          tx, bountyId, leg, operationId!, signature!,
        ));
        return { kind: 'broadcast_unknown', signature };
      } catch {
        return { kind: 'failed', code: tier2.code };
      }
    }
    if (operationId) {
      try {
        await withTier2AppRole((tx) => rejectNotBroadcast(tx, bountyId, leg, operationId!));
        return { kind: 'not_broadcast_retired', code: tier2.code };
      } catch {
        // A conflicting pre-broadcast signature proves this generation is not
        // safely rejectable. Preserve the original refusal; never claim retired.
        return { kind: 'failed', code: tier2.code };
      }
    }
    return { kind: 'failed', code: tier2.code };
  }
}

/** Deterministic, network-free adapter used only by Slice-A tests/harnesses. */
export function createMockTier2ChainAdapter(seed = 'tier2-slice-a'): Tier2ChainAdapter {
  return {
    async buildLeg(ctx) {
      const messageBytes = Buffer.from(`${seed}:${ctx.bountyId}:${ctx.leg}:${ctx.operationId}`);
      const digest = createHash('sha256').update(messageBytes).digest();
      return {
        messageBytes,
        blockhash: bs58.encode(digest),
        lastValidHeight: 1n,
        preparedSlot: 1n,
        decodedOk: true,
        destination: ctx.expectedDestination,
        amount: ctx.expectedAmount,
        estimatedFeeLamports: ctx.estimatedFeeLamports,
        predictedAmount: ctx.expectedAmount,
        formulaInputs: {
          mock: true,
          leg: ctx.leg,
          ...(ctx.leg === 'settle' ? { finalize_destination: ctx.expectedDestination } : {}),
        },
        accountVersion: 'mock-v1',
        accountFingerprint: digest,
        formulaDigest: digest,
        preparedDigest: digest,
        paymentDigest: ctx.paymentDigest,
      };
    },
    async sign(_kp, tx) {
      const signature = bs58.encode(createHash('sha512').update(tx.messageBytes).digest());
      tx.signedBytes = Buffer.concat([Buffer.from(signature), Buffer.from(':'), Buffer.from(tx.messageBytes)]);
      return signature;
    },
    async broadcast(signed) {
      const separator = signed.indexOf(58);
      return Buffer.from(separator === -1 ? signed : signed.subarray(0, separator)).toString();
    },
    async readFinalizedStatus() {
      return 'succeeded';
    },
  };
}

export function paymentCoordinateDigest(
  bountyId: string,
  leg: Tier2Leg,
  operationId: string,
  generation: bigint,
  amount: bigint,
  destination: string,
): Uint8Array {
  return createHash('sha256').update([
    'tier2-payment-v1', bountyId, leg, operationId,
    generation.toString(), amount.toString(), destination,
  ].join(String.fromCharCode(31)), 'utf8').digest();
}
