import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db, landStructurePieces, sql } from '@clawville/database';
import {
  KIT_CATALOG,
  evaluatePlacement,
  isKitPaymentRailAllowed,
  kitPieceFeeCt,
  kitPieceFeeMaterials,
  resolveParcelPlacements,
  type KitPaymentRail,
  type KitPieceKey,
  type KitPieceSize,
  type LandStructureType,
  type LandTier,
  type PlacedFootprint,
  type PlacementRefusalCode,
  type StoredPlacement,
} from '@clawville/shared';
import type { ActivityIdentity } from '../middleware/require-auth-or-agent';
import { creditClawTokens, debitClawTokens } from './claw-token-ledger';
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';
import { debitMaterials } from './material-ledger';

export type LandKitTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LandStructurePieceDTO {
  id: string;
  parcelId: string;
  pieceKey: KitPieceKey;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}

export interface SettleKitPlacementInput {
  identity: ActivityIdentity;
  parcelId: string;
  pieceKey: string;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
  paymentRail: KitPaymentRail;
  idempotencyKey: string;
  tx?: LandKitTx;
}

export interface KitPlacementSettlementResult {
  kind: 'placed' | 'replay';
  piece: LandStructurePieceDTO;
  costCt: number;
  costMaterials: number;
  paymentRail: KitPaymentRail;
}

const kitPieceSnapshotSchema = z.object({
  id: z.string().uuid(),
  parcelId: z.string().uuid(),
  pieceKey: z.string(),
  gridX: z.number().int(),
  gridY: z.number().int(),
  rotationStep: z.number().int(),
  stackLevel: z.number().int(),
});

export function isKitPieceKey(pieceKey: string): pieceKey is KitPieceKey {
  return Object.prototype.hasOwnProperty.call(KIT_CATALOG, pieceKey);
}

/**
 * Refusal codes the placement predicate can return that are STATE CONFLICTS
 * (409) rather than malformed input (400). A conflict means "the request is
 * well-formed but the yard cannot accept it right now".
 */
const KIT_PLACEMENT_CONFLICT_CODES: ReadonlySet<PlacementRefusalCode> = new Set([
  'level_cap_exceeded',
  'stack_exceeds_height',
  'unsupported_stack',
  'outside_parcel',
  'intersects_shell',
  'intersects_piece',
]);

/** HTTP status for a placement refusal. Conflicts 409, bad input 400. */
export function kitPlacementRefusalStatus(code: PlacementRefusalCode): 400 | 409 {
  return KIT_PLACEMENT_CONFLICT_CODES.has(code) ? 409 : 400;
}

/**
 * Evaluate ONE kit-piece write (a new placement or a move) against the parcel's
 * current contents, using the shared `evaluatePlacement` predicate.
 *
 * GRANDFATHERING (Q5) is why this reads through `resolveParcelPlacements`
 * rather than re-validating the stored rows: that resolver never refuses and
 * never drops a row, so an existing paid piece the stricter predicate would now
 * reject still occupies space and still blocks a new overlap. Validation
 * applies to what is being WRITTEN, never to what is already stored — a legacy
 * row is neither deleted nor hidden, and its owner may move it to a legal spot
 * for free.
 *
 * `excludePieceRef` is the row being MOVED. It must be excluded from both the
 * occupancy set (a piece cannot collide with itself) and the piece counts (a
 * move is cap-neutral: removing then re-adding the same piece must not trip
 * `level_cap_exceeded` on a full yard).
 */
export async function evaluateKitWrite(
  tx: LandKitTx,
  args: {
    parcelId: string;
    parcelTier: LandTier;
    structureLevel: number;
    request: {
      pieceKey: KitPieceKey;
      gridX: number;
      gridY: number;
      rotationStep: number;
      stackLevel: number;
    };
    excludePieceRef?: string;
  },
): Promise<
  { ok: true; footprint: PlacedFootprint } | { ok: false; code: PlacementRefusalCode }
> {
  const rows = await tx.execute<{
    id: string;
    piece_key: string;
    grid_x: number | string;
    grid_y: number | string;
    rotation_step: number | string;
    stack_level: number | string;
  }>(
    sql`SELECT id, piece_key, grid_x, grid_y, rotation_step, stack_level
        FROM land_structure_pieces WHERE parcel_id = ${args.parcelId}`,
  );
  const stored: StoredPlacement[] = [];
  let currentSmall = 0;
  let currentLarge = 0;
  for (const row of Array.from(rows)) {
    if (args.excludePieceRef && row.id === args.excludePieceRef) continue;
    if (!isKitPieceKey(row.piece_key)) {
      // A stored key the catalog no longer knows. The caller's own drift guard
      // raises on it; skip here so one bad row cannot silently widen free space.
      continue;
    }
    if (KIT_CATALOG[row.piece_key].size === 'small') currentSmall += 1;
    else currentLarge += 1;
    stored.push({
      pieceRef: row.id,
      pieceKey: row.piece_key,
      gridX: Number(row.grid_x),
      gridY: Number(row.grid_y),
      rotationStep: Number(row.rotation_step),
      stackLevel: Number(row.stack_level),
    });
  }
  const occupied = resolveParcelPlacements(stored, args.parcelTier).map((row) => row.footprint);
  return evaluatePlacement(args.request, {
    parcelTier: args.parcelTier,
    structureLevel: args.structureLevel,
    currentSmall,
    currentLarge,
    occupied,
  });
}

export type KitAuthorityError =
  | 'not_parcel_owner'
  | 'ownership_desync'
  | 'structure_required'
  | 'structure_not_active';

export interface KitAuthority {
  parcelOwnerAvatarId: string | null;
  pieceOwnerAvatarId?: string;
  structureOwnerAvatarId?: string | null;
  structureStatus?: 'active' | 'archived' | null;
}

/** Authoritative parcel ownership is checked before either denormalized owner. */
export function validateKitAuthority(
  authority: KitAuthority,
  avatarId: string,
  requireActiveStructure: boolean,
): KitAuthorityError | null {
  if (authority.parcelOwnerAvatarId !== avatarId) return 'not_parcel_owner';
  if (
    authority.pieceOwnerAvatarId !== undefined
    && authority.pieceOwnerAvatarId !== authority.parcelOwnerAvatarId
  ) return 'ownership_desync';
  if (requireActiveStructure) {
    if (!authority.structureOwnerAvatarId || !authority.structureStatus) return 'structure_required';
    if (authority.structureOwnerAvatarId !== authority.parcelOwnerAvatarId) return 'ownership_desync';
    if (authority.structureStatus !== 'active') return 'structure_not_active';
  }
  return null;
}

/**
 * Placement fee for a piece on a given structure type (founder ruling Q3: homes
 * are a third of the shop price). `structureType` is read from the LOCKED
 * `land_structures` row, never from the request body.
 */
export function kitPlacementFeeForKey(
  pieceKey: string,
  structureType: LandStructureType,
): number | null {
  return isKitPieceKey(pieceKey)
    ? kitPieceFeeCt(structureType, KIT_CATALOG[pieceKey].size)
    : null;
}

export function throwKitAuthorityError(error: KitAuthorityError): never {
  const status = error === 'not_parcel_owner' ? 403 : error === 'structure_required' ? 404 : 409;
  throw new HTTPException(status, { message: error });
}

export function toLandStructurePieceDTO(row: {
  id: string;
  parcelId: string;
  pieceKey: string;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}): LandStructurePieceDTO {
  if (!isKitPieceKey(row.pieceKey)) {
    throw new Error(`[land] unknown persisted kit piece key: ${row.pieceKey}`);
  }
  return { ...row, pieceKey: row.pieceKey };
}

export function pieceFromPlacementAudit(metadata: unknown): LandStructurePieceDTO | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = kitPieceSnapshotSchema.safeParse((metadata as { piece?: unknown }).piece);
  if (!parsed.success || !isKitPieceKey(parsed.data.pieceKey)) return null;
  return { ...parsed.data, pieceKey: parsed.data.pieceKey };
}

export function railFromPlacementAudit(metadata: unknown): KitPaymentRail {
  if (!metadata || typeof metadata !== 'object') return 'vclaw';
  return (metadata as { paymentRail?: unknown }).paymentRail === 'materials' ? 'materials' : 'vclaw';
}

export function materialsCostFromPlacementAudit(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object') return 0;
  const cost = (metadata as { costMaterials?: unknown }).costMaterials;
  return typeof cost === 'number' && Number.isInteger(cost) && cost >= 0 ? cost : 0;
}

export function matchesKitPlacementReplay(
  piece: LandStructurePieceDTO,
  request: Omit<SettleKitPlacementInput, 'identity' | 'paymentRail' | 'idempotencyKey' | 'tx'>,
): boolean {
  return piece.parcelId === request.parcelId
    && piece.pieceKey === request.pieceKey
    && piece.gridX === request.gridX
    && piece.gridY === request.gridY
    && piece.rotationStep === request.rotationStep
    && piece.stackLevel === request.stackLevel;
}

async function settleInTransaction(
  input: SettleKitPlacementInput,
  tx: LandKitTx,
): Promise<KitPlacementSettlementResult> {
  const avatarId = input.identity.avatarId;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);
  const parcelRows = await tx.execute<{
    id: string;
    owner_avatar_id: string | null;
    tier: LandTier;
  }>(sql`SELECT id, owner_avatar_id, tier FROM land_parcels
          WHERE id = ${input.parcelId} FOR UPDATE`);
  const parcel = parcelRows[0];
  if (!parcel) throw new HTTPException(404, { message: 'parcel_not_found' });

  const structureRows = await tx.execute<{
    id: string;
    owner_avatar_id: string;
    status: 'active' | 'archived';
    level: number | string;
    structure_type: LandStructureType;
  }>(sql`SELECT id, owner_avatar_id, status, level, structure_type FROM land_structures
          WHERE parcel_id = ${input.parcelId} FOR UPDATE`);
  const structure = structureRows[0] ?? null;
  const authorityError = validateKitAuthority({
    parcelOwnerAvatarId: parcel.owner_avatar_id,
    structureOwnerAvatarId: structure?.owner_avatar_id ?? null,
    structureStatus: structure?.status ?? null,
  }, avatarId, true);
  if (authorityError) throwKitAuthorityError(authorityError);

  const priorRows = await tx.execute<{ metadata: unknown; amount_ct: number | string }>(
    sql`SELECT metadata, amount_ct FROM land_transactions
        WHERE kind = 'structure_placement'
          AND avatar_id = ${avatarId}
          AND metadata->>'operation' = 'kit_piece_placement'
          AND metadata->>'idempotencyKey' = ${input.idempotencyKey}
        ORDER BY created_at DESC LIMIT 1`,
  );
  const prior = priorRows[0];
  if (prior) {
    const piece = pieceFromPlacementAudit(prior.metadata);
    if (!piece) throw new HTTPException(409, { message: 'idempotency_record_corrupt' });
    const priorRail = railFromPlacementAudit(prior.metadata);
    if (!matchesKitPlacementReplay(piece, input) || priorRail !== input.paymentRail) {
      throw new HTTPException(409, { message: 'idempotency_key_conflict' });
    }
    return {
      kind: 'replay',
      piece,
      costCt: Number(prior.amount_ct),
      costMaterials: materialsCostFromPlacementAudit(prior.metadata),
      paymentRail: priorRail,
    };
  }

  if (!isKitPieceKey(input.pieceKey)) {
    throw new HTTPException(400, { message: 'unknown_piece_key' });
  }
  const placeLevel = Number(structure!.level);
  if (!Number.isInteger(placeLevel) || placeLevel < 1 || placeLevel > 5) {
    throw new HTTPException(400, { message: 'structure_level_invalid' });
  }
  const driftRows = await tx.execute<{ piece_key: string }>(
    sql`SELECT piece_key FROM land_structure_pieces WHERE parcel_id = ${input.parcelId}`,
  );
  for (const row of Array.from(driftRows)) {
    if (!isKitPieceKey(row.piece_key)) {
      throw new HTTPException(409, { message: 'piece_catalog_drift' });
    }
  }

  const verdict = await evaluateKitWrite(tx, {
    parcelId: input.parcelId,
    parcelTier: parcel.tier,
    structureLevel: placeLevel,
    request: {
      pieceKey: input.pieceKey,
      gridX: input.gridX,
      gridY: input.gridY,
      rotationStep: input.rotationStep,
      stackLevel: input.stackLevel,
    },
  });
  if (!verdict.ok) {
    throw new HTTPException(kitPlacementRefusalStatus(verdict.code), { message: verdict.code });
  }

  const pieceKey = input.pieceKey;
  const size: KitPieceSize = KIT_CATALOG[pieceKey].size;
  const structureType = structure!.structure_type;
  const paymentRail = input.paymentRail;
  if (!isKitPaymentRailAllowed(paymentRail, structureType)) {
    throw new HTTPException(400, { message: 'payment_rail_not_allowed' });
  }

  let feeCt = 0;
  let feeMaterials = 0;
  let debitLedgerId: string | null = null;
  let creditLedgerId: string | null = null;
  if (paymentRail === 'materials') {
    feeMaterials = kitPieceFeeMaterials(size);
    await debitMaterials({
      avatarId,
      amount: feeMaterials,
      reason: 'land_kit_piece_fee',
      source: 'build',
    }, tx);
  } else {
    feeCt = kitPieceFeeCt(structureType, size);
    const treasuryId = await getHouseTreasuryAvatarId();
    if (!treasuryId) throw new HTTPException(503, { message: 'house_treasury_unavailable' });
    const debit = await debitClawTokens({
      avatarId,
      amount: feeCt,
      reason: 'land_kit_piece_fee',
      source: 'api',
      metadata: {
        parcelId: input.parcelId,
        pieceKey,
        size,
        structureType,
        idempotencyKey: input.idempotencyKey,
      },
      actorKind: input.identity.kind === 'user' ? 'human' : 'agent',
    }, tx);
    const credit = await creditClawTokens({
      avatarId: treasuryId,
      amount: feeCt,
      reason: 'house_fee_land_kit_piece',
      source: 'system',
      metadata: {
        parcelId: input.parcelId,
        pieceKey,
        size,
        structureType,
        ownerAvatarId: avatarId,
        idempotencyKey: input.idempotencyKey,
      },
      actorKind: 'system',
    }, tx);
    debitLedgerId = debit.ledgerId;
    creditLedgerId = credit.ledgerId;
  }

  const inserted = await tx.insert(landStructurePieces).values({
    parcelId: input.parcelId,
    ownerAvatarId: avatarId,
    pieceKey,
    gridX: input.gridX,
    gridY: input.gridY,
    rotationStep: input.rotationStep,
    stackLevel: input.stackLevel,
  }).returning({
    id: landStructurePieces.id,
    parcelId: landStructurePieces.parcelId,
    pieceKey: landStructurePieces.pieceKey,
    gridX: landStructurePieces.gridX,
    gridY: landStructurePieces.gridY,
    rotationStep: landStructurePieces.rotationStep,
    stackLevel: landStructurePieces.stackLevel,
  });
  const piece = toLandStructurePieceDTO(inserted[0]!);
  const auditMetadata = JSON.stringify({
    operation: 'kit_piece_placement',
    idempotencyKey: input.idempotencyKey,
    size,
    piece,
    paymentRail,
    costMaterials: feeMaterials,
  });
  await tx.execute(sql`INSERT INTO land_transactions
    (kind, parcel_id, structure_id, avatar_id, amount_ct,
     debit_ledger_tx_id, credit_ledger_tx_id, metadata)
    VALUES ('structure_placement', ${input.parcelId}, ${structure!.id}, ${avatarId}, ${feeCt},
            ${debitLedgerId}, ${creditLedgerId}, ${auditMetadata}::jsonb)`);
  return { kind: 'placed', piece, costCt: feeCt, costMaterials: feeMaterials, paymentRail };
}

export async function settleKitPlacement(
  input: SettleKitPlacementInput,
): Promise<KitPlacementSettlementResult> {
  return input.tx
    ? settleInTransaction(input, input.tx)
    : db.transaction((tx) => settleInTransaction(input, tx));
}
