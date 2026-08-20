import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { recordCovenantAction, type CovenantActorKind } from '../covenant-action-recorder';
import {
  bindHunterPayee,
  consumeApprovalOpenReward,
  withTier2AppRole,
} from './tier2-db';
import { asTier2Error, Tier2Error, type Tier2ErrorCode } from './tier2-errors';
import { tier2ClaimSweepMs, tier2ClaimTtlMs, tier2EscrowEnabled } from './tier2-config';

type ClaimActorKind = Extract<CovenantActorKind, 'human' | 'agent'>;
const claimActorContext = new AsyncLocalStorage<ClaimActorKind>();
const approvalContext = new AsyncLocalStorage<{
  reviewerAvatarId: string;
  actorKind: ClaimActorKind;
  reviewNote: string | null;
}>();

/** Route-only context keeps the frozen claimTier2Bounty signature while persisting auth provenance. */
export function withTier2ClaimActorKind<T>(kind: ClaimActorKind, fn: () => T): T {
  return claimActorContext.run(kind, fn);
}

export function withTier2ApprovalContext<T>(
  context: { reviewerAvatarId: string; actorKind: ClaimActorKind; reviewNote: string | null },
  fn: () => T,
): T {
  return approvalContext.run(context, fn);
}

export function selectTier2ClaimantWallet(
  kind: ClaimActorKind,
  row: { walletAddress: string | null; linkedWalletPubkey: string | null },
): string | null {
  return kind === 'agent' ? row.walletAddress : row.linkedWalletPubkey;
}

export async function claimTier2Bounty(input: {
  bountyId: string;
  hunterAvatarId: string;
  now: Date;
}): Promise<
  | { ok: true; attemptId: string; claimExpiresAt: Date }
  | { ok: false; code: 'not_open' | 'already_claimed' | 'not_tier2' }
> {
  if (!tier2EscrowEnabled()) return { ok: false, code: 'not_tier2' };
  const actorKind = claimActorContext.getStore();
  if (!actorKind) throw new Tier2Error('payee_provenance_unverified', 'Claim identity kind was not authenticated.');
  const ttl = tier2ClaimTtlMs();
  if (!Number.isSafeInteger(ttl) || ttl < 600_000) throw new Tier2Error('claim_ttl_invalid');
  const claimExpiresAt = new Date(input.now.getTime() + ttl);

  return withTier2AppRole(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id,creator_id,status,settlement_tier2,composition_state,current_attempts,max_attempts,
        tier2_cancel_intent_at
      FROM public.bounties WHERE id=${input.bountyId}::uuid FOR UPDATE
    `);
    const bounty = locked[0];
    if (!bounty || bounty.settlement_tier2 !== true) return { ok: false, code: 'not_tier2' } as const;
    if (bounty.status !== 'open' || bounty.composition_state !== 'vault_held'
      || bounty.tier2_cancel_intent_at != null) {
      return { ok: false, code: 'not_open' } as const;
    }
    if (bounty.creator_id === input.hunterAvatarId) return { ok: false, code: 'not_open' } as const;

    const active = await tx.execute(sql`
      SELECT 1 FROM public.bounty_attempts
      WHERE bounty_id=${input.bountyId}::uuid AND status IN ('claimed','in_progress','submitted','approved')
      LIMIT 1
    `);
    if (active.length > 0 || Number(bounty.current_attempts) >= 1) {
      return { ok: false, code: 'already_claimed' } as const;
    }

    const inserted = await tx.execute(sql`
      INSERT INTO public.bounty_attempts
        (bounty_id,hunter_id,status,claim_expires_at,claimed_at,created_at,updated_at)
      VALUES (${input.bountyId}::uuid,${input.hunterAvatarId}::uuid,'claimed',${claimExpiresAt.toISOString()}::timestamptz,
        ${input.now.toISOString()}::timestamptz,statement_timestamp(),statement_timestamp())
      RETURNING id::text AS id
    `);
    const attemptId = String(inserted[0]?.id);
    const updated = await tx.execute(sql`
      UPDATE public.bounties SET current_attempts=current_attempts+1,updated_at=statement_timestamp()
      WHERE id=${input.bountyId}::uuid AND current_attempts=0 AND max_attempts>=1
      RETURNING id
    `);
    if (updated.length !== 1) throw new Tier2Error('already_claimed');
    await recordCovenantAction({
      action: 'bounty.claim',
      subjectType: 'avatar',
      subjectId: input.hunterAvatarId,
      actorKind,
      payload: { bountyId: input.bountyId, attemptId },
      dedupeKey: `bounty:${input.bountyId}:attempt:${attemptId}:claim`,
    }, tx);
    return { ok: true, attemptId, claimExpiresAt } as const;
  });
}

export async function sweepExpiredTier2Claims(
  now = new Date(),
  limit = 100,
): Promise<{ reverted: number }> {
  if (!tier2EscrowEnabled()) return { reverted: 0 };
  const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
  return withTier2AppRole(async (tx) => {
    const rows = await tx.execute(sql`
      WITH expired AS (
        SELECT a.id,a.bounty_id FROM public.bounty_attempts a
        JOIN public.bounties b ON b.id=a.bounty_id
        WHERE b.settlement_tier2 IS TRUE
          AND a.status IN ('claimed','in_progress')
          AND a.claim_expires_at IS NOT NULL AND a.claim_expires_at<=${now.toISOString()}::timestamptz
        ORDER BY a.claim_expires_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT ${bounded}
      ), reverted AS (
        UPDATE public.bounty_attempts a SET status='abandoned',claim_expires_at=NULL,
          updated_at=statement_timestamp()
        FROM expired e WHERE a.id=e.id RETURNING e.bounty_id
      ), counts AS (
        SELECT bounty_id,count(*)::integer AS n FROM reverted GROUP BY bounty_id
      ), adjusted AS (
        UPDATE public.bounties b SET current_attempts=GREATEST(0,b.current_attempts-c.n),
          updated_at=statement_timestamp()
        FROM counts c WHERE b.id=c.bounty_id RETURNING b.id
      ) SELECT count(*)::integer AS reverted FROM reverted
    `);
    return { reverted: Number(rows[0]?.reverted ?? 0) };
  });
}

export async function bindAndOpenReward(input: {
  bountyId: string;
  attemptId: string;
  hunterAvatarId: string;
  amount: bigint;
}): Promise<{ ok: true; evidenceId: string } | { ok: false; code: Tier2ErrorCode }> {
  try {
    const review = approvalContext.getStore();
    if (!review) throw new Tier2Error('payee_provenance_unverified');
    return await withTier2AppRole(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT a.hunter_id::text AS hunter_id,a.status,b.creator_id::text AS creator_id,
          b.settlement_tier2,b.composition_state,
          b.tier2_mint,av.wallet_address,u.linked_wallet_pubkey,
          claim.actor_kind,claim.claim_count
        FROM public.bounty_attempts a
        JOIN public.bounties b ON b.id=a.bounty_id
        JOIN public.avatars av ON av.id=a.hunter_id
        JOIN public.users u ON u.id=av.user_id
        LEFT JOIN LATERAL (
          SELECT min(c.actor_kind) AS actor_kind,count(*)::integer AS claim_count
          FROM public.covenant_action_records c
          WHERE c.action='bounty.claim' AND c.subject_type='avatar' AND c.subject_id=a.hunter_id::text
            AND c.payload->>'bountyId'=a.bounty_id::text
            AND c.payload->>'attemptId'=a.id::text
            AND c.dedupe_key='bounty:'||a.bounty_id::text||':attempt:'||a.id::text||':claim'
        ) claim ON true
        WHERE a.id=${input.attemptId}::uuid AND a.bounty_id=${input.bountyId}::uuid
        FOR UPDATE OF a,b
      `);
      const row = rows[0];
      if (!row || row.settlement_tier2 !== true) throw new Tier2Error('not_tier2');
      if (row.creator_id !== review.reviewerAvatarId) {
        throw new Tier2Error('payee_provenance_unverified');
      }
      if (row.hunter_id !== input.hunterAvatarId || row.status !== 'submitted') {
        throw new Tier2Error('payee_provenance_unverified');
      }
      if (Number(row.claim_count) !== 1 || (row.actor_kind !== 'human' && row.actor_kind !== 'agent')) {
        throw new Tier2Error('payee_provenance_unverified');
      }
      const wallet = selectTier2ClaimantWallet(row.actor_kind, {
        walletAddress: typeof row.wallet_address === 'string' ? row.wallet_address : null,
        linkedWalletPubkey: typeof row.linked_wallet_pubkey === 'string' ? row.linked_wallet_pubkey : null,
      });
      if (typeof wallet !== 'string' || typeof row.tier2_mint !== 'string') {
        throw new Tier2Error('payee_provenance_unverified');
      }
      let derivedAta;
      try {
        derivedAta = await getAssociatedTokenAddress(
          new PublicKey(row.tier2_mint),
          new PublicKey(wallet),
          false,
        );
      } catch (cause) {
        throw new Tier2Error('payee_provenance_unverified', undefined, { cause });
      }
      const destination = derivedAta.toBase58();
      await bindHunterPayee(tx, input.bountyId, destination);
      const approved = await tx.execute(sql`
        UPDATE public.bounty_attempts SET status='approved',review_note=${review.reviewNote},
          reviewed_at=statement_timestamp(),updated_at=statement_timestamp(),claim_expires_at=NULL
        WHERE id=${input.attemptId}::uuid AND bounty_id=${input.bountyId}::uuid
          AND hunter_id=${input.hunterAvatarId}::uuid AND status='submitted'
        RETURNING id
      `);
      if (approved.length !== 1) throw new Tier2Error('tier2_approval_cas_lost');
      await recordCovenantAction({
        action: 'bounty.approve',
        subjectType: 'avatar',
        subjectId: input.hunterAvatarId,
        actorKind: review.actorKind,
        payload: {
          bountyId: input.bountyId,
          attemptId: input.attemptId,
          reviewerAvatarId: review.reviewerAvatarId,
          ...(review.reviewNote ? { reviewNote: review.reviewNote } : {}),
        },
        dedupeKey: `bounty:${input.bountyId}:attempt:${input.attemptId}:approve`,
      }, tx);
      const evidenceId = await consumeApprovalOpenReward(
        tx,
        input.bountyId,
        input.attemptId,
        input.amount,
        destination,
      );
      return { ok: true, evidenceId } as const;
    });
  } catch (error) {
    return { ok: false, code: asTier2Error(error).code };
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startTier2ClaimSweeper(): void {
  if (!tier2EscrowEnabled() || sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepExpiredTier2Claims().catch((error) => {
      console.error('[tier2] claim sweeper failed:', asTier2Error(error).code);
    });
  }, tier2ClaimSweepMs());
  sweepTimer.unref?.();
}

export function stopTier2ClaimSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
