import { db, sql } from '@clawville/database';
import {
  LAND_PARCELS,
  MAX_PARCELS_PER_AVATAR,
  RENT_PERIOD_DAYS,
  holdThresholdForTier,
  tenureRentCtWeeklyForTier,
  type LandTier,
} from '@clawville/shared';
import type { ActivityIdentity } from '../middleware/require-auth-or-agent';
import { creditClawTokens, debitClawTokens, InsufficientTokensError } from './claw-token-ledger';
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';
import { withKeyedMutex } from './keyed-mutex';
import { getWalletClvBalance } from './linked-wallet-clv-balance';
import {
  autonomousLandCapAllows,
  autonomousLandDailyUsageQuery,
  parseAutonomousLandDailyUsage,
} from './autonomous-land-spend-cap';
import {
  parcelHasLiveDeedLock,
  reconcileArchivedStructureOnAcquire,
  type LandTx,
} from './land-tenure-helpers';

type LandTenure = 'rented' | 'owned' | 'starter' | 'deposit' | 'hold';
type ParcelStatus = 'available' | 'owned' | 'reserved' | 'retired';

export interface TenureParcelDTO {
  id: string;
  parcelCode: string;
  tier: LandTier;
  status: ParcelStatus;
  gridX: number;
  gridY: number;
  priceCt: number | null;
  ownerAvatarId: string | null;
  rentCtWeekly: number | null;
  claimRentCtWeekly: number | null;
  tenure: LandTenure | null;
  depositCt: number | null;
  depositRemainingCt: number | null;
  holdThresholdCt: number | null;
}

export class LandTenureSettlementError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'LandTenureSettlementError';
  }
}

interface CommonInput {
  identity: ActivityIdentity;
  expectedAvatarId: string;
  expectedUserId: string;
  expectedAgentId: string | null;
  parcelCode: string;
  idempotencyKey: string;
  /** True only for the future cognition executor adapter, never normal REST. */
  autonomous?: boolean;
}

type IdempotencyRow = {
  id: string;
  avatar_id: string;
  operation: string;
  fingerprint: string;
  response: Record<string, unknown>;
} & Record<string, unknown>;

type ParcelRow = {
  id: string;
  parcel_code: string;
  tier: LandTier;
  status: ParcelStatus;
  owner_avatar_id: string | null;
  acquired_at: string | Date | null;
  price_ct: number | string | null;
  rent_ct_weekly: number | string | null;
  tenure: LandTenure | null;
  deposit_ct: number | string | null;
  deposit_remaining_ct: number | string | null;
  hold_threshold_ct: number | string | null;
  grace_until: string | Date | null;
  grid_x: number | string;
  grid_y: number | string;
};

const RENDERED_PARCEL_CODES = new Set(LAND_PARCELS.map((parcel) => parcel.id));

function actorKind(identity: ActivityIdentity): 'human' | 'agent' {
  return identity.kind === 'user' ? 'human' : 'agent';
}

function fingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function parcelDto(row: ParcelRow, overrides: Partial<TenureParcelDTO> = {}): TenureParcelDTO {
  return {
    id: row.id,
    parcelCode: row.parcel_code,
    tier: row.tier,
    status: row.status,
    gridX: Number(row.grid_x),
    gridY: Number(row.grid_y),
    priceCt: row.price_ct == null ? null : Number(row.price_ct),
    ownerAvatarId: row.owner_avatar_id,
    rentCtWeekly: row.rent_ct_weekly == null ? null : Number(row.rent_ct_weekly),
    claimRentCtWeekly: tenureRentCtWeeklyForTier(row.tier),
    tenure: row.tenure,
    depositCt: row.deposit_ct == null ? null : Number(row.deposit_ct),
    depositRemainingCt: row.deposit_remaining_ct == null ? null : Number(row.deposit_remaining_ct),
    holdThresholdCt: row.hold_threshold_ct == null ? null : Number(row.hold_threshold_ct),
    ...overrides,
  };
}

async function takeAvatarLockAndValidate(tx: LandTx, input: CommonInput): Promise<void> {
  const { identity } = input;
  if (
    identity.avatarId !== input.expectedAvatarId ||
    identity.userId !== input.expectedUserId ||
    (identity.kind === 'agent' ? identity.agentId : null) !== input.expectedAgentId
  ) {
    throw new LandTenureSettlementError('identity_binding_changed', 403);
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.expectedAvatarId}, 0))`,
  );
  const avatarRows = await tx.execute<{ user_id: string }>(
    sql`SELECT user_id FROM avatars WHERE id = ${input.expectedAvatarId} FOR UPDATE`,
  );
  if (avatarRows[0]?.user_id !== input.expectedUserId) {
    throw new LandTenureSettlementError('identity_binding_changed', 403);
  }
  if (input.expectedAgentId) {
    const agentRows = await tx.execute<{ user_id: string | null }>(
      sql`SELECT user_id FROM openclaw_bots
          WHERE agent_id = ${input.expectedAgentId} FOR SHARE`,
    );
    if (agentRows[0]?.user_id !== input.expectedUserId) {
      throw new LandTenureSettlementError('identity_binding_changed', 403);
    }
  }
}

async function readIdempotency(
  executor: Pick<typeof db, 'execute'> | LandTx,
  avatarId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const rows = await executor.execute<IdempotencyRow>(
    sql`SELECT id, avatar_id, operation, fingerprint, response
        FROM land_tenure_settlements
        WHERE avatar_id = ${avatarId} AND idempotency_key = ${key}
        LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function readLatestReleaseForParcel(
  tx: LandTx,
  parcelCode: string,
): Promise<IdempotencyRow | null> {
  const rows = await tx.execute<IdempotencyRow>(
    sql`SELECT id, avatar_id, operation, fingerprint, response
        FROM land_tenure_settlements
        WHERE operation = 'tenure_release'
          AND response -> 'parcel' ->> 'parcelCode' = ${parcelCode}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
  );
  return rows[0] ?? null;
}

function replayOrConflict<T extends Record<string, unknown>>(
  row: IdempotencyRow | null,
  operation: string,
  expectedFingerprint: string,
): (T & { fresh: false }) | null {
  if (!row) return null;
  if (row.operation !== operation || row.fingerprint !== expectedFingerprint) {
    throw new LandTenureSettlementError('idempotency_key_conflict', 409);
  }
  return { ...(row.response as T), fresh: false };
}

async function lockParcel(tx: LandTx, parcelCode: string): Promise<ParcelRow> {
  const rows = await tx.execute<ParcelRow>(
    sql`SELECT id, parcel_code, tier, status, owner_avatar_id, acquired_at,
               price_ct, rent_ct_weekly, tenure, deposit_ct,
               deposit_remaining_ct, hold_threshold_ct, grace_until, grid_x, grid_y
        FROM land_parcels WHERE parcel_code = ${parcelCode} FOR UPDATE`,
  );
  const parcel = rows[0];
  if (!parcel) throw new LandTenureSettlementError('parcel_not_found', 404);
  return parcel;
}

async function admitAutonomousSpend(
  tx: LandTx,
  input: CommonInput,
  requested: number,
): Promise<void> {
  // FEATURE_GATE: land-autonomous-spend-cap
  // Status: Active on the cognition executor; supervised REST remains autonomous=false.
  // Metric to graduate: Executor identity-binding and concurrent daily-cap DB tests green on staging.
  // Current reading: Executor wiring plus identity/daily-cap DB coverage green; concurrency test pending.
  // Review deadline: 2026-08-15
  // On deadline: Disable autonomous land spend unless the concurrency DB test is green.
  // Reference: GameFeatures.md §18b (Land P2 round 2)
  if (!input.autonomous) return;
  const rows = await tx.execute<{ used_vclaw: string }>(
    autonomousLandDailyUsageQuery(input.expectedAvatarId),
  );
  const used = parseAutonomousLandDailyUsage(Array.from(rows));
  if (!autonomousLandCapAllows(used, requested)) {
    throw new LandTenureSettlementError('autonomous_daily_cap', 429, {
      usedToday: used,
      requested,
    });
  }
}

async function writeIdempotency(
  tx: LandTx,
  input: CommonInput,
  operation: string,
  requestFingerprint: string,
  response: Record<string, unknown>,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO land_tenure_settlements
          (avatar_id, operation, idempotency_key, fingerprint, response)
        VALUES (${input.expectedAvatarId}, ${operation}, ${input.idempotencyKey},
                ${requestFingerprint}, ${JSON.stringify(response)}::jsonb)`,
  );
}

function isUniqueViolation(err: unknown): boolean {
  const error = err as { code?: string; cause?: { code?: string } } | undefined;
  return error?.code === '23505' || error?.cause?.code === '23505';
}

export type HoldWalletDeclarationResult = {
  walletAddress: string;
  firstDeclaration: boolean;
  changed: boolean;
};

/** Account declaration: parity-open first declare, human-only guarded repoint. */
export async function declareLandHoldWallet(
  identity: ActivityIdentity,
  canonicalWallet: string,
): Promise<HoldWalletDeclarationResult> {
  try {
    return await db.transaction(async (tx): Promise<HoldWalletDeclarationResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.userId}, 0))`,
      );
      const rows = await tx.execute<{ land_hold_wallet_pubkey: string | null }>(
        sql`SELECT land_hold_wallet_pubkey FROM users
            WHERE id = ${identity.userId} FOR UPDATE`,
      );
      if (rows.length === 0) {
        throw new LandTenureSettlementError('identity_binding_changed', 403);
      }
      const current = rows[0]!.land_hold_wallet_pubkey;
      if (current === canonicalWallet) {
        return { walletAddress: canonicalWallet, firstDeclaration: false, changed: false };
      }

      if (current != null) {
        if (identity.kind !== 'user') {
          throw new LandTenureSettlementError('wallet_change_requires_human', 409);
        }
        const liveHolds = await tx.execute<{ hit: number }>(
          sql`SELECT 1 AS hit
              FROM land_parcels p
              JOIN avatars a ON a.id = p.owner_avatar_id
              WHERE a.user_id = ${identity.userId}
                AND p.status <> 'available'
                AND p.tenure = 'hold'
                AND p.tenure_terms_version = 2
                AND p.grandfathered = false
              LIMIT 1`,
        );
        if (liveHolds.length > 0) {
          throw new LandTenureSettlementError('wallet_locked_by_hold', 409);
        }
      }

      await tx.execute(
        sql`UPDATE users
            SET land_hold_wallet_pubkey = ${canonicalWallet},
                land_hold_wallet_declared_at = now(), updated_at = now()
            WHERE id = ${identity.userId}`,
      );
      return {
        walletAddress: canonicalWallet,
        firstDeclaration: current == null,
        changed: true,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new LandTenureSettlementError('wallet_already_declared', 409);
    }
    throw err;
  }
}

export type TenureClaimResult = {
  fresh: boolean;
  parcel: TenureParcelDTO;
  door: 'rent' | 'hold';
  weeks?: number;
  weeklyCt?: number;
  requiredClv?: number;
  heldClv?: number;
};

export async function settleTenureClaim(
  input: CommonInput & ({ door: 'rent'; weeks: number } | { door: 'hold' }),
): Promise<TenureClaimResult> {
  const operation = `claim_${input.door}`;
  const tierMatch = /^parcel-(starter|c|b|a|founder)-/.exec(input.parcelCode);
  const hintedTier = tierMatch?.[1] as LandTier | undefined;
  const hintedWeekly = hintedTier ? tenureRentCtWeeklyForTier(hintedTier) : null;
  const requestFingerprint = fingerprint({
    parcelCode: input.parcelCode,
    door: input.door,
    weeks: input.door === 'rent' ? input.weeks : null,
    weeklyCt: input.door === 'rent' ? hintedWeekly : null,
  });

  return withKeyedMutex(`land-tenure:${input.expectedAvatarId}`, async () => {
    const early = replayOrConflict<TenureClaimResult>(
      await readIdempotency(db, input.expectedAvatarId, input.idempotencyKey),
      operation,
      requestFingerprint,
    );
    if (early) return early;

    let heldClv: number | null = null;
    let declaredWallet: string | null = null;
    if (input.door === 'hold') {
      const declaredRows = await db.execute<{
        land_hold_wallet_pubkey: string | null;
      }>(sql`SELECT land_hold_wallet_pubkey FROM users WHERE id = ${input.expectedUserId}`);
      declaredWallet = declaredRows[0]?.land_hold_wallet_pubkey ?? null;
      if (!declaredWallet) throw new LandTenureSettlementError('wallet_not_declared', 403);
      const clv = await getWalletClvBalance(declaredWallet, {
        maxAgeMs: 0,
        maxStaleAgeMs: 0,
      });
      if (!clv.available || clv.uiAmount == null) {
        throw new LandTenureSettlementError('clv_balance_unavailable', 503);
      }
      heldClv = clv.uiAmount;
    }

    const treasuryId = input.door === 'rent' ? await getHouseTreasuryAvatarId() : null;
    if (input.door === 'rent' && !treasuryId) {
      throw new LandTenureSettlementError('house_treasury_unavailable', 503);
    }

    try {
      return await db.transaction(async (tx): Promise<TenureClaimResult> => {
        await takeAvatarLockAndValidate(tx, input);
        const replay = replayOrConflict<TenureClaimResult>(
          await readIdempotency(tx, input.expectedAvatarId, input.idempotencyKey),
          operation,
          requestFingerprint,
        );
        if (replay) return replay;

        if (input.door === 'hold') {
          const walletRows = await tx.execute<{
            land_hold_wallet_pubkey: string | null;
          }>(
            sql`SELECT land_hold_wallet_pubkey FROM users
                WHERE id = ${input.expectedUserId} FOR SHARE`,
          );
          if (walletRows[0]?.land_hold_wallet_pubkey !== declaredWallet) {
            throw new LandTenureSettlementError('wallet_declaration_changed', 409);
          }
        }

        const parcel = await lockParcel(tx, input.parcelCode);
        if (input.door === 'rent' && parcel.tier === 'founder') {
          throw new LandTenureSettlementError('founder_no_rent_door', 400);
        }
        if (parcel.status !== 'available') {
          throw new LandTenureSettlementError('parcel_not_available', 409);
        }
        if (!RENDERED_PARCEL_CODES.has(parcel.parcel_code)) {
          throw new LandTenureSettlementError('parcel_not_rendered', 409);
        }
        const countRows = await tx.execute<{ n: number | string }>(
          sql`SELECT COUNT(*)::int AS n FROM land_parcels
              WHERE owner_avatar_id = ${input.expectedAvatarId}`,
        );
        if (Number(countRows[0]?.n ?? 0) >= MAX_PARCELS_PER_AVATAR) {
          throw new LandTenureSettlementError('parcel_cap_reached', 409);
        }

        let result: TenureClaimResult;
        if (input.door === 'rent') {
          const weeklyCt = tenureRentCtWeeklyForTier(parcel.tier);
          if (weeklyCt == null || weeklyCt !== hintedWeekly) {
            throw new LandTenureSettlementError('tier_not_claimable', 400);
          }
          const totalCt = weeklyCt * input.weeks;
          await admitAutonomousSpend(tx, input, totalCt);
          const commonMetadata = {
            parcelId: parcel.id,
            parcelCode: parcel.parcel_code,
            tier: parcel.tier,
            idempotencyKey: input.idempotencyKey,
            autonomousLand: input.autonomous === true,
          };
          const firstWeekDebit = await debitClawTokens(
            {
              avatarId: input.expectedAvatarId,
              amount: weeklyCt,
              reason: 'land_parcel_rent',
              source: input.autonomous ? 'system' : 'api',
              metadata: {
                ...commonMetadata,
                period: 'first_week',
                irrevocable: true,
              },
              actorKind: actorKind(input.identity),
            },
            tx,
          );
          const firstWeekCredit = await creditClawTokens(
            {
              avatarId: treasuryId!,
              amount: weeklyCt,
              reason: 'house_fee_land_rent',
              source: 'system',
              metadata: {
                ...commonMetadata,
                holderAvatarId: input.expectedAvatarId,
              },
              actorKind: 'system',
            },
            tx,
          );
          const escrowCt = totalCt - weeklyCt;
          let escrowDebitId: string | null = null;
          if (escrowCt > 0) {
            const escrowDebit = await debitClawTokens(
              {
                avatarId: input.expectedAvatarId,
                amount: escrowCt,
                reason: 'land_deposit_escrow',
                source: input.autonomous ? 'system' : 'api',
                metadata: {
                  ...commonMetadata,
                  weeks: input.weeks - 1,
                  refundable: true,
                },
                actorKind: actorKind(input.identity),
              },
              tx,
            );
            escrowDebitId = escrowDebit.ledgerId;
          }
          await tx.execute(
            sql`UPDATE land_parcels SET
                  status = 'owned', owner_avatar_id = ${input.expectedAvatarId},
                  tenure = 'deposit', tenure_terms_version = 2, acquired_at = now(),
                  rent_ct_weekly = ${weeklyCt}, rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                  grace_until = NULL, deposit_ct = ${escrowCt}, deposit_remaining_ct = ${escrowCt},
                  hold_threshold_ct = NULL, hold_subject = NULL, grandfathered = false,
                  updated_at = now()
                WHERE id = ${parcel.id}`,
          );
          await reconcileArchivedStructureOnAcquire(tx, parcel.id, input.expectedAvatarId);
          const firstMeta = JSON.stringify({
            ...commonMetadata,
            firstWeek: true,
            irrevocable: true,
            weeklyCt,
          });
          await tx.execute(
            sql`INSERT INTO land_transactions
                  (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, credit_ledger_tx_id, metadata)
                VALUES ('rent_payment', ${parcel.id}, ${input.expectedAvatarId}, ${weeklyCt},
                        ${firstWeekDebit.ledgerId}, ${firstWeekCredit.ledgerId}, ${firstMeta}::jsonb)`,
          );
          if (escrowCt > 0) {
            const escrowMeta = JSON.stringify({
              ...commonMetadata,
              refundable: true,
              weeklyCt,
            });
            await tx.execute(
              sql`INSERT INTO land_transactions
                    (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
                  VALUES ('land_deposit_escrow', ${parcel.id}, ${input.expectedAvatarId},
                          ${escrowCt}, ${escrowDebitId}, ${escrowMeta}::jsonb)`,
            );
          }
          result = {
            fresh: true,
            door: 'rent',
            weeks: input.weeks,
            weeklyCt,
            parcel: parcelDto(parcel, {
              status: 'owned',
              ownerAvatarId: input.expectedAvatarId,
              tenure: 'deposit',
              rentCtWeekly: weeklyCt,
              depositCt: escrowCt,
              depositRemainingCt: escrowCt,
              holdThresholdCt: null,
            }),
          };
        } else {
          const threshold = holdThresholdForTier(parcel.tier);
          if (threshold == null) {
            throw new LandTenureSettlementError('tier_not_claimable', 400);
          }
          const sumRows = await tx.execute<{ s: number | string }>(
            sql`SELECT COALESCE(SUM(p.hold_threshold_ct), 0)::int AS s
                FROM land_parcels p
                JOIN avatars a ON a.id = p.owner_avatar_id
                WHERE a.user_id = ${input.expectedUserId}
                  AND p.tenure = 'hold' AND p.tenure_terms_version = 2
                  AND p.grandfathered = false`,
          );
          const requiredClv = Number(sumRows[0]?.s ?? 0) + threshold;
          if (heldClv! < requiredClv) {
            throw new LandTenureSettlementError('insufficient_clv_hold', 403, {
              requiredClv,
              heldClv,
            });
          }
          await tx.execute(
            sql`UPDATE land_parcels SET
                  status = 'owned', owner_avatar_id = ${input.expectedAvatarId},
                  tenure = 'hold', tenure_terms_version = 2, acquired_at = now(),
                  rent_ct_weekly = NULL, rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                  grace_until = NULL, deposit_ct = NULL, deposit_remaining_ct = NULL,
                  hold_threshold_ct = ${threshold}, hold_subject = ${input.identity.kind},
                  grandfathered = false, updated_at = now()
                WHERE id = ${parcel.id}`,
          );
          await reconcileArchivedStructureOnAcquire(tx, parcel.id, input.expectedAvatarId);
          const metadata = JSON.stringify({
            parcelCode: parcel.parcel_code,
            tier: parcel.tier,
            holdThresholdClv: threshold,
            requiredClv,
            heldClv,
            declaredWallet,
          });
          await tx.execute(
            sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
                VALUES ('hold_claim', ${parcel.id}, ${input.expectedAvatarId}, 0, ${metadata}::jsonb)`,
          );
          result = {
            fresh: true,
            door: 'hold',
            requiredClv,
            heldClv: heldClv!,
            parcel: parcelDto(parcel, {
              status: 'owned',
              ownerAvatarId: input.expectedAvatarId,
              tenure: 'hold',
              rentCtWeekly: null,
              depositCt: null,
              depositRemainingCt: null,
              holdThresholdCt: threshold,
            }),
          };
        }
        const persisted = { ...result } as Record<string, unknown>;
        delete persisted.fresh;
        await writeIdempotency(tx, input, operation, requestFingerprint, persisted);
        return result;
      });
    } catch (err) {
      if (err instanceof InsufficientTokensError) {
        throw new LandTenureSettlementError('insufficient_clawtokens', 400);
      }
      if (isUniqueViolation(err)) {
        const replay = replayOrConflict<TenureClaimResult>(
          await readIdempotency(db, input.expectedAvatarId, input.idempotencyKey),
          operation,
          requestFingerprint,
        );
        if (replay) return replay;
        throw new LandTenureSettlementError('concurrent_retry', 409);
      }
      throw err;
    }
  });
}

export type RentPrepayResult = {
  fresh: boolean;
  parcelCode: string;
  amountCt: number;
  weeks?: number;
  depositRemainingCt: number;
  graceCleared: boolean;
};

export async function settleRentPrepay(
  input: CommonInput & ({ amountCt: number; weeks?: never } | { weeks: number; amountCt?: never }),
): Promise<RentPrepayResult> {
  const operation = 'rent_prepay';
  const requestFingerprint = fingerprint({
    parcelCode: input.parcelCode,
    amountCt: input.amountCt ?? null,
    weeks: input.weeks ?? null,
  });
  return withKeyedMutex(`land-tenure:${input.expectedAvatarId}`, async () => {
    const early = replayOrConflict<RentPrepayResult>(
      await readIdempotency(db, input.expectedAvatarId, input.idempotencyKey),
      operation,
      requestFingerprint,
    );
    if (early) return early;
    try {
      return await db.transaction(async (tx): Promise<RentPrepayResult> => {
        await takeAvatarLockAndValidate(tx, input);
        const replay = replayOrConflict<RentPrepayResult>(
          await readIdempotency(tx, input.expectedAvatarId, input.idempotencyKey),
          operation,
          requestFingerprint,
        );
        if (replay) return replay;
        const parcel = await lockParcel(tx, input.parcelCode);
        if (parcel.owner_avatar_id !== input.expectedAvatarId) {
          throw new LandTenureSettlementError('not_parcel_owner', 403);
        }
        if (parcel.tenure !== 'deposit') {
          throw new LandTenureSettlementError('not_deposit_tenure', 409);
        }
        const remaining =
          parcel.deposit_remaining_ct == null ? null : Number(parcel.deposit_remaining_ct);
        const weekly = parcel.rent_ct_weekly == null ? null : Number(parcel.rent_ct_weekly);
        if (remaining == null || weekly == null || weekly <= 0) {
          throw new LandTenureSettlementError('invalid_escrow_state', 409);
        }
        const amountCt = input.weeks == null ? input.amountCt : weekly * input.weeks;
        if (!Number.isSafeInteger(amountCt) || amountCt <= 0 || amountCt > 1_000_000) {
          throw new LandTenureSettlementError('invalid_prepay_amount', 400);
        }
        await admitAutonomousSpend(tx, input, amountCt);
        const debit = await debitClawTokens(
          {
            avatarId: input.expectedAvatarId,
            amount: amountCt,
            reason: 'land_deposit_topup',
            source: input.autonomous ? 'system' : 'api',
            metadata: {
              parcelId: parcel.id,
              parcelCode: parcel.parcel_code,
              idempotencyKey: input.idempotencyKey,
              refundable: true,
              autonomousLand: input.autonomous === true,
            },
            actorKind: actorKind(input.identity),
          },
          tx,
        );
        const newRemaining = remaining + amountCt;
        const coversWeek = newRemaining >= weekly;
        const graceCleared = coversWeek && parcel.grace_until != null;
        await tx.execute(
          sql`UPDATE land_parcels SET
                deposit_remaining_ct = COALESCE(deposit_remaining_ct, 0) + ${amountCt},
                grace_until = CASE WHEN ${coversWeek} THEN NULL ELSE grace_until END,
                updated_at = now()
              WHERE id = ${parcel.id}`,
        );
        const metadata = JSON.stringify({
          newRemaining,
          graceCleared,
          refundable: true,
          idempotencyKey: input.idempotencyKey,
        });
        await tx.execute(
          sql`INSERT INTO land_transactions
                (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
              VALUES ('land_deposit_topup', ${parcel.id}, ${input.expectedAvatarId},
                      ${amountCt}, ${debit.ledgerId}, ${metadata}::jsonb)`,
        );
        const result: RentPrepayResult = {
          fresh: true,
          parcelCode: parcel.parcel_code,
          amountCt,
          ...(input.weeks == null ? {} : { weeks: input.weeks }),
          depositRemainingCt: newRemaining,
          graceCleared,
        };
        const persisted = { ...result } as Record<string, unknown>;
        delete persisted.fresh;
        await writeIdempotency(tx, input, operation, requestFingerprint, persisted);
        return result;
      });
    } catch (err) {
      if (err instanceof InsufficientTokensError) {
        throw new LandTenureSettlementError('insufficient_clawtokens', 400);
      }
      if (isUniqueViolation(err)) throw new LandTenureSettlementError('concurrent_retry', 409);
      throw err;
    }
  });
}

export type TenureReleaseResult = {
  fresh: boolean;
  released: true;
  refundedCt: number;
  parcel: TenureParcelDTO;
  /** Persisted only to bind the idempotency key to this exact tenancy. */
  tenancyAcquiredAt: string;
};

export async function settleTenureRelease(input: CommonInput): Promise<TenureReleaseResult> {
  const operation = 'tenure_release';
  return withKeyedMutex(`land-tenure:${input.expectedAvatarId}`, async () => {
    try {
      return await db.transaction(async (tx): Promise<TenureReleaseResult> => {
        await takeAvatarLockAndValidate(tx, input);
        const prior = await readIdempotency(tx, input.expectedAvatarId, input.idempotencyKey);
        if (prior) {
          if (prior.operation !== operation || prior.response.parcel == null) {
            throw new LandTenureSettlementError('idempotency_key_conflict', 409);
          }
          const priorResponse = prior.response as unknown as Omit<TenureReleaseResult, 'fresh'>;
          if (priorResponse.parcel.parcelCode !== input.parcelCode) {
            throw new LandTenureSettlementError('idempotency_key_conflict', 409);
          }
          const replayFingerprint = fingerprint({
            parcelCode: input.parcelCode,
            ownerAvatarId: input.expectedAvatarId,
            acquiredAt: priorResponse.tenancyAcquiredAt,
          });
          if (prior.fingerprint !== replayFingerprint) {
            throw new LandTenureSettlementError('idempotency_key_conflict', 409);
          }
          const current = await lockParcel(tx, input.parcelCode);
          if (current.owner_avatar_id != null || current.acquired_at != null) {
            throw new LandTenureSettlementError('idempotency_key_conflict', 409);
          }
          const latestRelease = await readLatestReleaseForParcel(tx, input.parcelCode);
          const latestResponse = latestRelease?.response as
            | Omit<TenureReleaseResult, 'fresh'>
            | undefined;
          if (
            latestRelease?.id !== prior.id ||
            latestRelease?.avatar_id !== input.expectedAvatarId ||
            latestResponse?.tenancyAcquiredAt !== priorResponse.tenancyAcquiredAt
          ) {
            throw new LandTenureSettlementError('idempotency_key_conflict', 409);
          }
          return { ...priorResponse, fresh: false };
        }

        const parcel = await lockParcel(tx, input.parcelCode);
        if (parcel.owner_avatar_id !== input.expectedAvatarId) {
          throw new LandTenureSettlementError('not_parcel_owner', 403);
        }
        if (await parcelHasLiveDeedLock(tx, parcel.id)) {
          throw new LandTenureSettlementError('deed_locked_by_listing', 409);
        }
        if (parcel.tenure !== 'deposit' && parcel.tenure !== 'hold') {
          throw new LandTenureSettlementError('not_releasable_tenure', 409);
        }
        const acquiredAt = parcel.acquired_at;
        if (!acquiredAt) throw new LandTenureSettlementError('invalid_tenure_state', 409);
        const acquiredAtIso = new Date(acquiredAt).toISOString();
        const requestFingerprint = fingerprint({
          parcelCode: parcel.parcel_code,
          ownerAvatarId: input.expectedAvatarId,
          acquiredAt: acquiredAtIso,
        });
        let refundedCt = 0;
        if (parcel.tenure === 'deposit') {
          if (parcel.deposit_remaining_ct == null) {
            throw new LandTenureSettlementError('invalid_escrow_state', 409);
          }
          refundedCt = Number(parcel.deposit_remaining_ct);
          let creditId: string | null = null;
          if (refundedCt > 0) {
            const credit = await creditClawTokens(
              {
                avatarId: input.expectedAvatarId,
                amount: refundedCt,
                reason: 'land_deposit_refund',
                source: input.autonomous ? 'system' : 'api',
                metadata: {
                  parcelId: parcel.id,
                  parcelCode: parcel.parcel_code,
                },
                actorKind: actorKind(input.identity),
              },
              tx,
            );
            creditId = credit.ledgerId;
          }
          const metadata = JSON.stringify({
            reason: 'voluntary_release',
            tenure: 'deposit',
            refundedCt,
          });
          await tx.execute(
            sql`INSERT INTO land_transactions
                  (kind, parcel_id, avatar_id, amount_ct, credit_ledger_tx_id, metadata)
                VALUES ('land_deposit_refund', ${parcel.id}, ${input.expectedAvatarId},
                        ${refundedCt}, ${creditId}, ${metadata}::jsonb)`,
          );
        } else {
          const metadata = JSON.stringify({
            reason: 'voluntary_release',
            tenure: 'hold',
          });
          await tx.execute(
            sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
                VALUES ('eviction', ${parcel.id}, ${input.expectedAvatarId}, 0, ${metadata}::jsonb)`,
          );
        }
        await tx.execute(
          sql`UPDATE land_parcels SET
                status = 'available', owner_avatar_id = NULL, tenure = NULL,
                tenure_terms_version = NULL, acquired_at = NULL,
                rent_paid_through = NULL, grace_until = NULL,
                deposit_ct = NULL, deposit_remaining_ct = NULL,
                hold_threshold_ct = NULL, hold_subject = NULL,
                grandfathered = false, updated_at = now()
              WHERE id = ${parcel.id}`,
        );
        await tx.execute(
          sql`UPDATE land_structures SET status = 'archived', updated_at = now()
              WHERE parcel_id = ${parcel.id} AND status = 'active'`,
        );
        const result: TenureReleaseResult = {
          fresh: true,
          released: true,
          refundedCt,
          tenancyAcquiredAt: acquiredAtIso,
          parcel: parcelDto(parcel, {
            status: 'available',
            ownerAvatarId: null,
            tenure: null,
            depositCt: null,
            depositRemainingCt: null,
            holdThresholdCt: null,
          }),
        };
        const persisted = { ...result } as Record<string, unknown>;
        delete persisted.fresh;
        await writeIdempotency(tx, input, operation, requestFingerprint, persisted);
        return result;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new LandTenureSettlementError('concurrent_retry', 409);
      throw err;
    }
  });
}
