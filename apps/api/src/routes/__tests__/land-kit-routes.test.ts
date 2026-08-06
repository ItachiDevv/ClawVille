import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  createKitPieceBodySchema,
  hasKitStackSupport,
  kitPlacementFeeForKey,
  landRoutes,
  matchesKitPlacementReplay,
  moveKitPieceBodySchema,
  toPublicLandStructurePieceDTO,
  validateKitAuthority,
  validateKitPlacementInput,
} from '../land';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const IDEM = 'kit-place-0001';
const source = readFileSync(join(import.meta.dir, '..', 'land.ts'), 'utf8');
const sweeperSource = readFileSync(
  join(import.meta.dir, '..', '..', 'services', 'land-rent-sweeper.ts'),
  'utf8',
);
const deedTransferSource = readFileSync(
  join(import.meta.dir, '..', '..', 'services', 'market-deed-transfer-executor.ts'),
  'utf8',
);

function routeSpan(method: 'get' | 'post' | 'patch' | 'delete', path: string): string {
  const needle = `landRoutes.${method}(`;
  let start = source.indexOf(needle);
  while (start >= 0) {
    const nextRegistration = source.indexOf('landRoutes.', start + needle.length);
    const end = nextRegistration >= 0 ? nextRegistration : source.length;
    const span = source.slice(start, end);
    if (span.includes(`'${path}'`)) return span;
    start = source.indexOf(needle, start + needle.length);
  }
  throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
}

describe('land kit request and ladder validation', () => {
  const validCreate = {
    pieceKey: 'fence-picket',
    gridX: 0,
    gridY: 0,
    rotationStep: 0,
    stackLevel: 1,
    idempotencyKey: IDEM,
  };

  it('requires an 8..64 idempotency key and rejects stray create fields', () => {
    expect(createKitPieceBodySchema.safeParse(validCreate).success).toBe(true);
    expect(createKitPieceBodySchema.safeParse({ ...validCreate, idempotencyKey: 'short' }).success)
      .toBe(false);
    expect(createKitPieceBodySchema.safeParse({ ...validCreate, priceCt: 1 }).success).toBe(false);
    const { idempotencyKey: _omitted, ...withoutKey } = validCreate;
    expect(createKitPieceBodySchema.safeParse(withoutKey).success).toBe(false);
  });

  it('makes move strict and unable to change the piece key or provide money', () => {
    const move = { gridX: 15, gridY: 15, rotationStep: 2, stackLevel: 1 };
    expect(moveKitPieceBodySchema.safeParse(move).success).toBe(true);
    expect(moveKitPieceBodySchema.safeParse({ ...move, pieceKey: 'statue-shell' }).success).toBe(
      false,
    );
    expect(moveKitPieceBodySchema.safeParse({ ...move, feeCt: 0 }).success).toBe(false);
  });

  it('rejects unknown keys, bounds, and every center-reserved boundary', () => {
    expect(validateKitPlacementInput({ ...validCreate, level: 1, pieceKey: 'unknown' })).toBe(
      'unknown_piece_key',
    );
    expect(validateKitPlacementInput({ ...validCreate, level: 1, gridX: -1 })).toBe(
      'cell_out_of_bounds',
    );
    expect(validateKitPlacementInput({ ...validCreate, level: 1, gridY: 16 })).toBe(
      'cell_out_of_bounds',
    );
    for (const [gridX, gridY] of [[3, 3], [3, 12], [12, 3], [12, 12]]) {
      expect(validateKitPlacementInput({ ...validCreate, level: 1, gridX, gridY })).toBe(
        'cell_reserved',
      );
    }
  });

  it('enforces rotation by level and stack height by the authoritative structure level', () => {
    expect(validateKitPlacementInput({ ...validCreate, level: 1, rotationStep: 1 })).toBe(
      'rotation_not_allowed',
    );
    expect(validateKitPlacementInput({ ...validCreate, level: 2, rotationStep: 7 })).toBe(
      'rotation_not_allowed',
    );
    expect(validateKitPlacementInput({ ...validCreate, level: 3, rotationStep: 7 })).toBeNull();
    expect(validateKitPlacementInput({ ...validCreate, level: 1, stackLevel: 2 })).toBe(
      'stack_not_allowed',
    );
    expect(validateKitPlacementInput({ ...validCreate, level: 2, stackLevel: 2 })).toBeNull();
    expect(validateKitPlacementInput({ ...validCreate, level: 3, stackLevel: 3 })).toBe(
      'stack_not_allowed',
    );
    expect(validateKitPlacementInput({ ...validCreate, level: 4, stackLevel: 3 })).toBeNull();
  });

  it('enforces both current-count caps and permits a move without consuming a new cap slot', () => {
    expect(validateKitPlacementInput({ ...validCreate, level: 1, currentSmall: 6 })).toBe(
      'piece_cap_reached',
    );
    expect(
      validateKitPlacementInput({
        ...validCreate,
        level: 2,
        pieceKey: 'statue-shell',
        currentLarge: 0,
      }),
    ).toBe('piece_cap_reached');
    expect(
      validateKitPlacementInput({
        ...validCreate,
        level: 5,
        pieceKey: 'statue-shell',
        currentLarge: 4,
        addingPiece: false,
      }),
    ).toBeNull();
  });
});

describe('land kit ownership and money discipline', () => {
  it('uses authoritative parcel ownership and fails closed on either denormalized drift', () => {
    expect(
      validateKitAuthority(
        {
          parcelOwnerAvatarId: OWNER_ID,
          pieceOwnerAvatarId: OWNER_ID,
          structureOwnerAvatarId: OWNER_ID,
          structureStatus: 'active',
        },
        OWNER_ID,
        true,
      ),
    ).toBeNull();
    expect(
      validateKitAuthority(
        { parcelOwnerAvatarId: OTHER_ID, structureOwnerAvatarId: OWNER_ID, structureStatus: 'active' },
        OWNER_ID,
        true,
      ),
    ).toBe('not_parcel_owner');
    expect(
      validateKitAuthority(
        { parcelOwnerAvatarId: OWNER_ID, pieceOwnerAvatarId: OTHER_ID },
        OWNER_ID,
        false,
      ),
    ).toBe('ownership_desync');
    expect(
      validateKitAuthority(
        { parcelOwnerAvatarId: OWNER_ID, structureOwnerAvatarId: OTHER_ID, structureStatus: 'active' },
        OWNER_ID,
        true,
      ),
    ).toBe('ownership_desync');
  });

  it('requires an active structure for create/move but not owner removal', () => {
    expect(
      validateKitAuthority({ parcelOwnerAvatarId: OWNER_ID }, OWNER_ID, true),
    ).toBe('structure_required');
    expect(
      validateKitAuthority(
        { parcelOwnerAvatarId: OWNER_ID, structureOwnerAvatarId: OWNER_ID, structureStatus: 'archived' },
        OWNER_ID,
        true,
      ),
    ).toBe('structure_not_active');
    expect(validateKitAuthority({ parcelOwnerAvatarId: OWNER_ID }, OWNER_ID, false)).toBeNull();
  });

  it('derives the exact D5 fee from the server catalog', () => {
    expect(kitPlacementFeeForKey('fence-picket')).toBe(15);
    expect(kitPlacementFeeForKey('banner-pole')).toBe(15);
    expect(kitPlacementFeeForKey('arch-driftwood')).toBe(60);
    expect(kitPlacementFeeForKey('statue-anchor')).toBe(60);
    expect(kitPlacementFeeForKey('unknown')).toBeNull();
  });

  it('places under one atomic exact debit+house credit and audits both ledger ids', () => {
    const create = routeSpan('post', '/parcels/:parcelId/pieces');
    expect(create).toContain('const feeCt = KIT_PIECE_FEE_CT[size]');
    expect(create).toContain("reason: 'land_kit_piece_fee'");
    expect(create).toContain("reason: 'house_fee_land_kit_piece'");
    expect(create.match(/amount: feeCt/g)).toHaveLength(2);
    expect(create).toContain('house_treasury_unavailable');
    expect(create).toContain('debit_ledger_tx_id, credit_ledger_tx_id');
    expect(create).toContain('${debit.ledgerId}, ${credit.ledgerId}');
  });

  it('checks durable replay before debit and returns the stored original piece', () => {
    const create = routeSpan('post', '/parcels/:parcelId/pieces');
    expect(create).toContain("metadata->>'operation' = 'kit_piece_placement'");
    expect(create).toContain("metadata->>'idempotencyKey'");
    expect(create.indexOf("metadata->>'idempotencyKey'")).toBeLessThan(
      create.indexOf('debitClawTokens'),
    );
    expect(create).toContain('pieceFromPlacementAudit(prior.metadata)');
    expect(create).toContain('idempotencyReplay: true');
  });

  it('rejects idempotency replay when any stored placement target field differs', () => {
    const piece = {
      id: '33333333-3333-4333-8333-333333333333',
      parcelId: OWNER_ID,
      pieceKey: 'fence-picket' as const,
      gridX: 0,
      gridY: 1,
      rotationStep: 2,
      stackLevel: 1,
    };
    const request = {
      parcelId: OWNER_ID,
      pieceKey: 'fence-picket',
      gridX: 0,
      gridY: 1,
      rotationStep: 2,
      stackLevel: 1,
    };
    expect(matchesKitPlacementReplay(piece, request)).toBe(true);
    for (const mismatch of [
      { parcelId: OTHER_ID },
      { pieceKey: 'statue-shell' },
      { gridX: 1 },
      { gridY: 2 },
      { rotationStep: 4 },
      { stackLevel: 2 },
    ]) {
      expect(matchesKitPlacementReplay(piece, { ...request, ...mismatch })).toBe(false);
    }
    const create = routeSpan('post', '/parcels/:parcelId/pieces');
    expect(create).toContain('matchesKitPlacementReplay(piece, { parcelId, ...body })');
    expect(create).toContain("message: 'idempotency_key_conflict'");
  });

  it('checks occupancy before the ledger and maps the DB unique backstop to 409', () => {
    const create = routeSpan('post', '/parcels/:parcelId/pieces');
    expect(create.indexOf("message: 'cell_occupied'")).toBeLessThan(
      create.indexOf('debitClawTokens'),
    );
    expect(create).toContain("constraint === 'land_structure_pieces_cell_stack_unique'");
    expect(create).toContain("constraint === 'land_tx_kit_piece_idem_unique'");
    expect(routeSpan('patch', '/pieces/:pieceId')).toContain("message: 'cell_occupied'");
  });

  it('requires the immediately lower piece before placing above stack level one', () => {
    expect(hasKitStackSupport([], { gridX: 0, gridY: 0, stackLevel: 1 })).toBe(true);
    expect(hasKitStackSupport([], { gridX: 0, gridY: 0, stackLevel: 2 })).toBe(false);
    expect(
      hasKitStackSupport(
        [{ gridX: 0, gridY: 0, stackLevel: 1 }],
        { gridX: 0, gridY: 0, stackLevel: 2 },
      ),
    ).toBe(true);
    expect(
      hasKitStackSupport(
        [{ gridX: 0, gridY: 0, stackLevel: 1 }],
        { gridX: 0, gridY: 0, stackLevel: 3 },
      ),
    ).toBe(false);
    const create = routeSpan('post', '/parcels/:parcelId/pieces');
    expect(create.indexOf('hasKitStackSupport(currentPieces, body)')).toBeLessThan(
      create.indexOf('debitClawTokens'),
    );
    expect(create).toContain("message: 'stack_support_required'");
  });

  it('keeps move and removal free with no refund path', () => {
    const move = routeSpan('patch', '/pieces/:pieceId');
    const remove = routeSpan('delete', '/pieces/:pieceId');
    for (const span of [move, remove]) {
      expect(span).not.toContain('debitClawTokens');
      expect(span).not.toContain('creditClawTokens');
      expect(span).toContain('bustPublicPiecesCache');
    }
    expect(remove).toContain('performs no refund ledger write');
  });
});

describe('land kit middleware and public feed contract', () => {
  it('chains all three mutations with auth, ledger-capability, and non-guest guards', () => {
    for (const [method, path] of [
      ['post', '/parcels/:parcelId/pieces'],
      ['patch', '/pieces/:pieceId'],
      ['delete', '/pieces/:pieceId'],
    ] as const) {
      const span = routeSpan(method, path);
      expect(span).toContain('requireAuthOrAgentSession');
      expect(span).toContain('requireLedgerCapableIdentity');
      expect(span).toContain('requireNonGuestIdentity');
      expect(span).toContain('pg_advisory_xact_lock');
      expect(span).toMatch(/land_parcels[\s\S]*FOR UPDATE|FOR UPDATE OF kp, p/);
    }
  });

  it('401s before DB access without a human or agent session', async () => {
    const app = new Hono();
    app.route('/api/land', landRoutes);
    const response = await app.request(`/api/land/parcels/${OWNER_ID}/pieces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pieceKey: 'fence-picket',
        gridX: 0,
        gridY: 0,
        rotationStep: 0,
        stackLevel: 1,
        idempotencyKey: IDEM,
      }),
    });
    expect(response.status).toBe(401);
  });

  it('maps exactly the six-field public no-PII DTO', () => {
    const dto = toPublicLandStructurePieceDTO({
      parcelCode: 'parcel-starter-00',
      pieceKey: 'fence-rope',
      gridX: 2,
      gridY: 4,
      rotationStep: 2,
      stackLevel: 1,
    });
    expect(dto).toEqual({
      parcelCode: 'parcel-starter-00',
      pieceKey: 'fence-rope',
      gridX: 2,
      gridY: 4,
      rotationStep: 2,
      stackLevel: 1,
    });
    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('ownerAvatarId');
    expect(dto).not.toHaveProperty('parcelId');
  });

  it('serves an unauthenticated parcelCode join with the frozen cache headers', () => {
    const feed = routeSpan('get', '/pieces/public');
    expect(feed).toContain('getPublicPiecesCache');
    expect(feed).toContain('setPublicPiecesCache');
    expect(feed).toContain("c.header('Cache-Control', 'public, max-age=30')");
    expect(feed).toContain('.innerJoin(landParcels');
    expect(feed).toContain('toPublicLandStructurePieceDTO');
    expect(feed).not.toContain('requireAuthOrAgentSession');
  });

  it("excludes an archived structure's parcel pieces from the public feed", () => {
    const feed = routeSpan('get', '/pieces/public');
    expect(feed).toContain('.innerJoin(landStructures');
    expect(feed).toContain(".where(eq(landStructures.status, 'active'))");
  });

  it('purges stale pieces on different-owner re-acquire and mirrors structure cache busts', () => {
    expect(source).toMatch(
      /else \{[\s\S]*?DELETE FROM land_structure_pieces WHERE parcel_id[\s\S]*?DELETE FROM land_structures/,
    );
    const claimHold = routeSpan('post', '/parcels/:parcelId/claim-hold');
    expect(claimHold).toContain('reconcileArchivedStructureOnAcquire');
    expect(claimHold).toContain('bustPublicStructuresCache();');
    expect(claimHold).toContain('bustPublicPiecesCache();');

    const structureBusts = [...source.matchAll(/bustPublicStructuresCache\(\);/g)];
    expect(structureBusts).toHaveLength(6);
    for (const bust of structureBusts) {
      expect(source.slice(bust.index, bust.index + 100)).toContain('bustPublicPiecesCache();');
    }
    expect(sweeperSource).toMatch(
      /bustPublicStructuresCache\(\);\s*bustPublicPiecesCache\(\);/,
    );
    expect(deedTransferSource).toContain('land_structure_pieces');
    expect(deedTransferSource).toContain('FLAG for land review');
  });

  it('documents structure_required as 404 and the DELETE response shape', () => {
    expect(source).toContain("error === 'structure_required' ? 404 : 409");
    expect(source).toContain('200: { deleted: true, piece: LandStructurePieceDTO }');
  });

  it('contains no collider, pathfinding, GLB, or asset mapping write', () => {
    for (const span of [
      routeSpan('post', '/parcels/:parcelId/pieces'),
      routeSpan('patch', '/pieces/:pieceId'),
      routeSpan('delete', '/pieces/:pieceId'),
    ]) {
      expect(span).not.toMatch(/collider|pathfinding|\.glb|assetPath/i);
    }
  });
});
