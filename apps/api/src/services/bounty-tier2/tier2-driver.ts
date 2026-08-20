import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createMockTier2ChainAdapter, driveLeg, type Tier2ChainAdapter } from './tier2-send';
import {
  driverTransition,
  consumeFinalizeRelease,
  consumeRefundStart,
  consumeSettleSnapshot,
  payoutTransition,
  reconcilerTransition,
  recordProviderCapture,
  releaseLiability,
  withTier2AppRole,
  type Tier2Leg,
  type SettleSnapshotArgs,
  type Tier2State,
} from './tier2-db';
import { tier2DriverEnabled, tier2DriverPollMs, tier2EscrowEnabled } from './tier2-config';

export type Tier2DispatchDoor =
  | 'driverTransition' | 'reconcilerTransition' | 'payoutTransition'
  | 'consumeSettleSnapshot' | 'consumeFinalizeRelease' | 'consumeRefundStart'
  | 'consumeOperationConfirmed' | 'consumeOpsContinue' | 'opsTransition'
  | 'claim_or_approval' | 'slice_c_cleanup' | 'none';

export interface Tier2Dispatch {
  door: Tier2DispatchDoor;
  leg?: Tier2Leg;
  nextState?: Tier2State;
}

/** Frozen §3.5 table. Carve-outs never map to a generic transition door. */
export function dispatchTier2State(state: Tier2State): Tier2Dispatch {
  switch (state) {
    case 'fee_pending': return { door: 'driverTransition', leg: 'fee_charge', nextState: 'funding_pending' };
    case 'funding_pending': return { door: 'driverTransition', leg: 'funding_usdc', nextState: 'vault_pending' };
    case 'vault_pending': return { door: 'driverTransition', leg: 'vault_open', nextState: 'vault_confirmed' };
    case 'vault_confirmed':
    case 'vault_unconfirmed': return { door: 'reconcilerTransition', leg: 'vault_open', nextState: 'vault_held' };
    case 'vault_held': return { door: 'claim_or_approval', leg: 'settle' };
    case 'settle_snapshot_ops_pending': return { door: 'consumeSettleSnapshot', leg: 'settle', nextState: 'awaiting_finalize' };
    case 'awaiting_finalize': return { door: 'consumeFinalizeRelease', leg: 'finalize', nextState: 'payout_ready' };
    case 'payout_ready': return { door: 'payoutTransition', leg: 'payout', nextState: 'cleanup_pending' };
    case 'reconcile_payout_failed': return { door: 'driverTransition', leg: 'payout', nextState: 'payout_ready' };
    case 'cleanup_pending': return { door: 'slice_c_cleanup', nextState: 'paid' };
    case 'create_failed': return { door: 'consumeRefundStart', nextState: 'refund_pending' };
    case 'settle_exhausted': return { door: 'consumeOperationConfirmed', leg: 'refund_withdraw_usdc', nextState: 'refund_pending' };
    case 'refund_pending': return { door: 'slice_c_cleanup', nextState: 'refunded' };
    case 'arithmetic_branch_violation': return { door: 'opsTransition', nextState: 'payout_ready' };
    case 'finalize_exhausted':
    case 'price_blocked':
    case 'ops_hold': return { door: 'consumeOpsContinue' };
    default: return { door: 'none' };
  }
}

let adapter: Tier2ChainAdapter | null = null;
export interface Tier2CarveOutEvidenceAdapter {
  settleSnapshot(bountyId: string, settleEvidenceId: string): Promise<SettleSnapshotArgs>;
  finalizeRelease(bountyId: string, finalizeEvidenceId: string): Promise<{ operationId: string; captureId: string; note: string | null }>;
}
let carveOutEvidence: Tier2CarveOutEvidenceAdapter | null = null;
let driverTimer: ReturnType<typeof setInterval> | null = null;

/** Test-only Slice-A injection. Slice B supplies the real adapter before enabling the worker. */
export function setTier2ChainAdapter(value: Tier2ChainAdapter | null): void {
  adapter = value;
}

/** Offline harness seam; Slice B replaces this with corroborated evidence producers. */
export function setTier2CarveOutEvidenceAdapter(value: Tier2CarveOutEvidenceAdapter | null): void {
  carveOutEvidence = value;
}

/** Deterministic synthetic captures for the local Slice-A DB harness only. */
export function createMockTier2CarveOutEvidenceAdapter(
  seed = 'tier2-slice-a',
): Tier2CarveOutEvidenceAdapter {
  const bytes32 = (label: string) => createHash('sha256').update(`${seed}:${label}`).digest();
  return {
    async settleSnapshot(bountyId, settleEvidenceId) {
      return withTier2AppRole(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT e.chain_signature,o.prepared_msg_digest,ps.account_version,
            ps.account_fingerprint,ps.formula_inputs,ps.formula_digest,
            b.tier2_vault_usdc_ata,b.tier2_hunter_ata,b.payout_expected_atomic::text AS amount,
            d.public_key
          FROM public.bounty_tier2_evidence e
          JOIN public.bounty_tier2_operations o ON o.id=e.op_id
          JOIN public.bounty_tier2_prepared_sends ps ON ps.operation_id=o.id
          JOIN public.bounties b ON b.id=e.bounty_id
          JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
          WHERE e.id=${settleEvidenceId}::uuid AND e.bounty_id=${bountyId}::uuid
            AND e.leg='settle' AND e.kind='signature' AND e.chain_commitment='finalized'
            AND e.tx_succeeded IS TRUE
        `);
        const row = rows[0];
        if (!row?.chain_signature || !row.tier2_vault_usdc_ata || !row.tier2_hunter_ata) {
          throw new Error('tier2_mock_settle_proof_missing');
        }
        return {
          bountyId,
          pending: String(row.tier2_vault_usdc_ata),
          escrow: String(row.tier2_vault_usdc_ata),
          agent: String(row.tier2_hunter_ata),
          depositor: String(row.public_key),
          settlementIndex: 0n,
          calls: 1n,
          amount: null,
          provisional: true,
          serviceHash: bytes32(`${bountyId}:service`),
          releaseSlot: null,
          eventTimestamp: null,
          signature: String(row.chain_signature),
          settleSlot: 1n,
          preparedDigest: row.prepared_msg_digest as Uint8Array,
          accountVersion: String(row.account_version),
          accountFingerprint: row.account_fingerprint as Uint8Array,
          formulaInputs: row.formula_inputs as Record<string, unknown>,
          formulaDigest: row.formula_digest as Uint8Array,
          proofId: settleEvidenceId,
        };
      });
    },
    async finalizeRelease(bountyId, finalizeEvidenceId) {
      return withTier2AppRole(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT e.op_id::text AS operation_id,e.chain_signature,
            s.pending_settlement,s.escrow,s.agent_pda,s.depositor,
            s.settlement_index::text,b.payout_expected_atomic::text AS payout_amount,
            ps.formula_inputs->>'finalize_destination' AS destination
          FROM public.bounty_tier2_evidence e
          JOIN public.bounty_tier2_settle_snapshots s ON s.bounty_id=e.bounty_id
          JOIN public.bounties b ON b.id=e.bounty_id
          JOIN public.bounty_tier2_evidence se ON se.id=s.proof_id
          JOIN public.bounty_tier2_prepared_sends ps ON ps.operation_id=se.op_id
          WHERE e.id=${finalizeEvidenceId}::uuid AND e.bounty_id=${bountyId}::uuid
            AND e.leg='finalize' AND e.kind='signature' AND e.chain_commitment='finalized'
            AND e.tx_succeeded IS TRUE
        `);
        const row = rows[0];
        if (!row?.operation_id || !row.chain_signature) throw new Error('tier2_mock_finalize_proof_missing');
        const providers = await tx.execute(sql`
          SELECT p1.provider_id AS provider_id_1,p1.identity_version AS identity_version_1,
            p2.provider_id AS provider_id_2,p2.identity_version AS identity_version_2
          FROM public.tier2_rpc_providers p1
          JOIN public.tier2_rpc_providers p2
            ON ROW(p1.provider_id,p1.identity_version)<ROW(p2.provider_id,p2.identity_version)
           AND p1.endpoint_fingerprint<>p2.endpoint_fingerprint
           AND p1.operator_identity<>p2.operator_identity
           AND p1.failure_domain<>p2.failure_domain
          WHERE p1.active IS TRUE AND p1.archival IS TRUE
            AND p2.active IS TRUE AND p2.archival IS TRUE
          ORDER BY p1.provider_id,p1.identity_version,p2.provider_id,p2.identity_version LIMIT 1
        `);
        if (providers.length !== 1) throw new Error('tier2_mock_provider_independence_missing');
        const pair = providers[0];
        const providerPair = [
          { provider_id: pair.provider_id_1, identity_version: pair.identity_version_1 },
          { provider_id: pair.provider_id_2, identity_version: pair.identity_version_2 },
        ];
        const transactionBytes = Buffer.from(`${seed}:${bountyId}:finalize`);
        const transactionDigest = createHash('sha256').update(transactionBytes).digest();
        const candidateEvent = Buffer.from(`${seed}:${bountyId}:event`);
        const rawLogs = Buffer.from('mock-finalized');
        const captures: string[] = [];
        for (const provider of providerPair) {
          const providerId = String(provider.provider_id);
          const providerVersion = Number(provider.identity_version);
          const existing = await tx.execute(sql`
            SELECT id::text AS id FROM public.bounty_tier2_settle_captures
            WHERE signature=${String(row.chain_signature)} AND provider_id=${providerId}
            LIMIT 1 FOR UPDATE
          `);
          if (existing[0]?.id) {
            const exact = await tx.execute(sql`
              SELECT id::text AS id FROM public.bounty_tier2_settle_captures
              WHERE id=${String(existing[0].id)}::uuid AND bounty_id=${bountyId}::uuid
                AND signature=${String(row.chain_signature)} AND provider_id=${providerId}
                AND provider_identity_version=${providerVersion}
                AND capture_kind='finalize_transfer'
                AND operation_id=${String(row.operation_id)}::uuid AND operation_leg='finalize'
                AND observed_commitment='finalized' AND observed_slot=1
                AND transaction_bytes=${transactionBytes} AND transaction_digest=${transactionDigest}
                AND raw_log_bytes=${rawLogs} AND candidate_event_bytes=${candidateEvent}
                AND decoded_ok IS TRUE AND outer_instruction_index=0
                AND inner_instruction_index IS NULL AND stack_height=1
                AND stack_height_raw IS NULL AND descendant_outer_index=0
                AND descendant_inner_index=0 AND descendant_stack_height=2
                AND decoded_pending_settlement=${String(row.pending_settlement)}
                AND decoded_escrow=${String(row.escrow)}
                AND decoded_agent_pda=${String(row.agent_pda)}
                AND decoded_depositor=${String(row.depositor)}
                AND decoded_settlement_index=${String(row.settlement_index)}::numeric
                AND decoded_amount_atomic=${String(row.payout_amount)}::numeric
                AND decoded_destination=${String(row.destination)}
            `);
            if (exact.length !== 1) throw new Error('tier2_mock_capture_conflict');
            captures.push(String(exact[0].id));
            continue;
          }
          captures.push(await recordProviderCapture(tx, {
            bountyId,
            providerId,
            providerIdentityVersion: providerVersion,
            captureKind: 'finalize_transfer',
            operationId: String(row.operation_id),
            signature: String(row.chain_signature),
            commitment: 'finalized',
            observedSlot: 1n,
            transactionBytes,
            transactionDigest,
            rawLogs,
            candidateEvent,
            decodedOk: true,
            outer: 0,
            inner: null,
            stack: 1,
            stackRaw: null,
            descendantOuter: 0,
            descendantInner: 0,
            descendantStack: 2,
            pending: String(row.pending_settlement),
            escrow: String(row.escrow),
            agent: String(row.agent_pda),
            depositor: String(row.depositor),
            settlementIndex: BigInt(String(row.settlement_index)),
            amount: BigInt(String(row.payout_amount)),
            destination: String(row.destination),
          }));
        }
        return { operationId: String(row.operation_id), captureId: captures[0], note: 'mock-finalized' };
      });
    },
  };
}

/** One-call install for the fully offline app-role DB harness. */
export function installMockTier2DriverAdapters(seed = 'tier2-slice-a'): () => void {
  setTier2ChainAdapter(createMockTier2ChainAdapter(seed));
  setTier2CarveOutEvidenceAdapter(createMockTier2CarveOutEvidenceAdapter(seed));
  return () => {
    setTier2ChainAdapter(null);
    setTier2CarveOutEvidenceAdapter(null);
  };
}

async function confirmedEvidenceId(bountyId: string, leg: Tier2Leg): Promise<string | null> {
  const rows = await withTier2AppRole((tx) => tx.execute(sql`
    SELECT id::text AS id FROM public.bounty_tier2_evidence
    WHERE bounty_id=${bountyId}::uuid AND leg=${leg} AND kind='signature'
      AND chain_commitment='finalized' AND tx_succeeded IS TRUE
    ORDER BY created_at,id LIMIT 1
  `));
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensureConfirmedLeg(
  bountyId: string,
  leg: Tier2Leg,
  chain: Tier2ChainAdapter,
): Promise<string | null> {
  const existing = await confirmedEvidenceId(bountyId, leg);
  if (existing) return existing;
  const outcome = await driveLeg(bountyId, leg, chain);
  return outcome.kind === 'confirmed' ? outcome.evidenceId : null;
}

export async function runTier2DriverPass(limit = 25): Promise<{ advanced: number }> {
  if (!tier2EscrowEnabled() || !tier2DriverEnabled() || !adapter) return { advanced: 0 };
  const rows = await withTier2AppRole((tx) => tx.execute(sql`
    SELECT b.id::text AS id,b.composition_state AS state,
      (b.tier2_cancel_intent_at IS NOT NULL) AS cancel_intent,
      (b.tier2_hunter_ata IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
         WHERE l.bounty_id=b.id AND l.kind='reward_payout' AND l.asset_kind='usdc'
           AND l.disposition='open')
       AND EXISTS (SELECT 1 FROM public.bounty_attempts a
         WHERE a.bounty_id=b.id AND a.status='approved')) AS settle_ready
    FROM public.bounties b WHERE b.settlement_tier2 IS TRUE
      AND composition_state NOT IN ('paid','refunded','cancelled')
    ORDER BY b.updated_at,b.id LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}
  `));
  let advanced = 0;
  for (const row of rows) {
    const bountyId = String(row.id);
    const state = row.state as Tier2State;
    if (row.cancel_intent === true && (
      state === 'fee_pending' || state === 'funding_pending' || state === 'vault_pending'
    )) {
      // No Slice-A not-broadcast proof producer exists for these early states.
      // Freeze rather than initiate another value send after poster close.
      continue;
    }
    const dispatch = dispatchTier2State(state);
    if (dispatch.door === 'driverTransition' && dispatch.nextState) {
      if (state === 'reconcile_payout_failed') {
        const moved = await withTier2AppRole((tx) => driverTransition(
          tx, bountyId, state, dispatch.nextState!, '', '', null,
        ));
        if (moved) advanced++;
        continue;
      }
      if (state === 'funding_pending') {
        const solEvidence = await ensureConfirmedLeg(bountyId, 'funding_sol', adapter);
        if (!solEvidence) continue;
      }
      const evidenceId = await ensureConfirmedLeg(bountyId, dispatch.leg!, adapter);
      if (!evidenceId) continue;
      const moved = await withTier2AppRole(async (tx) => {
        if (state === 'vault_pending' && dispatch.leg === 'vault_open') {
          await releaseLiability(tx, bountyId, 'poster_prefund', 'usdc', 1, evidenceId);
        }
        return driverTransition(
          tx, bountyId, state, dispatch.nextState!, 'signature', dispatch.leg!, evidenceId,
        );
      });
      if (moved) advanced++;
    } else if (dispatch.door === 'reconcilerTransition' && dispatch.nextState) {
      const evidence = await withTier2AppRole((tx) => tx.execute(sql`
        SELECT id::text AS id FROM public.bounty_tier2_evidence
        WHERE bounty_id=${bountyId}::uuid AND leg='vault_open' AND kind='signature'
          AND chain_commitment='finalized' AND tx_succeeded IS TRUE
        ORDER BY created_at,id LIMIT 1
      `));
      if (!evidence[0]?.id) continue;
      const moved = await withTier2AppRole((tx) => reconcilerTransition(
        tx, bountyId, state, dispatch.nextState!, 'signature', 'vault_open', String(evidence[0].id),
      ));
      if (moved) advanced++;
    } else if (dispatch.door === 'payoutTransition' && dispatch.nextState) {
      const evidenceId = await ensureConfirmedLeg(bountyId, 'payout', adapter);
      if (!evidenceId) continue;
      const moved = await withTier2AppRole(async (tx) => {
        await releaseLiability(tx, bountyId, 'reward_payout', 'usdc', 1, evidenceId);
        return payoutTransition(
          tx, bountyId, state, dispatch.nextState!, 'signature', 'payout', evidenceId,
        );
      });
      if (moved) advanced++;
    } else if (dispatch.door === 'consumeSettleSnapshot' && carveOutEvidence) {
      const settleEvidenceId = await confirmedEvidenceId(bountyId, 'settle');
      if (!settleEvidenceId) continue;
      const input = await carveOutEvidence.settleSnapshot(bountyId, settleEvidenceId);
      if (input.bountyId !== bountyId) throw new Error('tier2_settle_snapshot_bounty_mismatch');
      const moved = await withTier2AppRole((tx) => consumeSettleSnapshot(tx, input));
      if (moved) advanced++;
    } else if (dispatch.door === 'consumeFinalizeRelease' && carveOutEvidence) {
      const finalizeEvidenceId = await ensureConfirmedLeg(bountyId, 'finalize', adapter);
      if (!finalizeEvidenceId) continue;
      const input = await carveOutEvidence.finalizeRelease(bountyId, finalizeEvidenceId);
      await withTier2AppRole((tx) => consumeFinalizeRelease(
        tx, bountyId, input.operationId, input.captureId, input.note,
      ));
      advanced++;
    } else if (dispatch.door === 'claim_or_approval' && row.cancel_intent === true) {
      const evidenceId = await ensureConfirmedLeg(bountyId, 'refund_withdraw_usdc', adapter);
      if (evidenceId) advanced++;
    } else if (dispatch.door === 'claim_or_approval' && carveOutEvidence && row.settle_ready === true) {
      const settleEvidenceId = await ensureConfirmedLeg(bountyId, 'settle', adapter);
      if (!settleEvidenceId) continue;
      const input = await carveOutEvidence.settleSnapshot(bountyId, settleEvidenceId);
      if (input.bountyId !== bountyId) throw new Error('tier2_settle_snapshot_bounty_mismatch');
      const moved = await withTier2AppRole((tx) => consumeSettleSnapshot(tx, input));
      if (moved) advanced++;
    } else if (dispatch.door === 'consumeRefundStart' && row.cancel_intent === true) {
      const moved = await withTier2AppRole((tx) => consumeRefundStart(tx, bountyId));
      if (moved) advanced++;
    } else if (dispatch.door === 'consumeOperationConfirmed' && dispatch.leg) {
      const evidenceId = await ensureConfirmedLeg(bountyId, dispatch.leg, adapter);
      if (evidenceId) advanced++;
    }
    // Ops decisions and Slice-C terminal cleanup remain deliberately dormant:
    // no app worker may synthesize an ops authorization or a cleanup proof.
  }
  return { advanced };
}

export function startTier2Driver(): void {
  if (!tier2EscrowEnabled() || !tier2DriverEnabled() || driverTimer) return;
  // Slice A is intentionally dormant without an injected adapter; Slice B owns the real adapter.
  if (!adapter) return;
  driverTimer = setInterval(() => void runTier2DriverPass().catch((error) => {
    console.error('[tier2] driver pass failed:', error instanceof Error ? error.message : error);
  }), tier2DriverPollMs());
  driverTimer.unref?.();
}

export function stopTier2Driver(): void {
  if (driverTimer) clearInterval(driverTimer);
  driverTimer = null;
}
