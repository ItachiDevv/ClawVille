import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  appearanceBodySchema,
  landRoutes,
  toPublicLandStructureDTO,
  validateAppearanceMutation,
  type AppearanceAuthority,
} from '../land';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const authority: AppearanceAuthority = {
  ownerAvatarId: OWNER_ID,
  status: 'active',
  structureType: 'home',
  level: 2,
  tier: 'starter',
};

describe('PATCH /structures/:structureId/appearance', () => {
  it('is strict, partial, and rejects an empty patch', () => {
    expect(appearanceBodySchema.safeParse({ shellKey: 'driftwood-cabin' }).success).toBe(true);
    expect(appearanceBodySchema.safeParse({ paletteKey: 'seafoam' }).success).toBe(true);
    expect(appearanceBodySchema.safeParse({}).success).toBe(false);
    expect(appearanceBodySchema.safeParse({ shellKey: 'coastal-cottage', level: 5 }).success).toBe(
      false,
    );
  });

  it('accepts the owner and gives an agent session the exact same avatar-bound path', () => {
    expect(
      validateAppearanceMutation(authority, OWNER_ID, {
        shellKey: 'driftwood-cabin',
        paletteKey: 'deep-current',
      }),
    ).toBeNull();

    // `requireAuthOrAgentSession` resolves both humans and agents to avatarId;
    // the pure gate intentionally has no identity-kind branch.
    const agentSessionAvatarId = OWNER_ID;
    expect(validateAppearanceMutation(authority, agentSessionAvatarId, { paletteKey: 'classic' }))
      .toBeNull();
  });

  it('rejects a non-owner before applying appearance choices', () => {
    expect(validateAppearanceMutation(authority, OTHER_ID, { shellKey: 'coastal-cottage' })).toBe(
      'not_structure_owner',
    );
  });

  it('rejects archived structures', () => {
    expect(
      validateAppearanceMutation(
        { ...authority, status: 'archived' },
        OWNER_ID,
        { paletteKey: 'classic' },
      ),
    ).toBe('structure_archived');
  });

  it('rejects wrong-type/unknown shells and current-level gates', () => {
    expect(validateAppearanceMutation(authority, OWNER_ID, { shellKey: 'premium-mall' })).toBe(
      'shell_not_allowed',
    );
    expect(
      validateAppearanceMutation(
        { ...authority, level: 1 },
        OWNER_ID,
        { shellKey: 'driftwood-cabin' },
      ),
    ).toBe('shell_not_allowed');
    expect(
      validateAppearanceMutation(
        { ...authority, level: 1 },
        OWNER_ID,
        { paletteKey: 'deep-current' },
      ),
    ).toBe('palette_not_allowed');
    expect(
      validateAppearanceMutation(
        { ...authority, level: 4, tier: 'c' },
        OWNER_ID,
        { shellKey: 'premium-tower' },
      ),
    ).toBe('shell_not_allowed');
  });

  it('401s without human or agent auth before any DB access', async () => {
    const app = new Hono();
    app.route('/api/land', landRoutes);
    const response = await app.request(
      `/api/land/structures/${OWNER_ID}/appearance`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paletteKey: 'classic' }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('X-Clawville-Agent-Session');
  });

  it('chains auth + guest protection and deliberately has no ledger gate', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'land.ts'), 'utf8');
    const route = source.match(
      /landRoutes\.patch\(\s*'\/structures\/:structureId\/appearance'([\s\S]*?)async \(c\)/,
    )?.[1];
    expect(route).toContain('requireAuthOrAgentSession');
    expect(route).toContain('requireNonGuestIdentity');
    expect(route).not.toContain('requireLedgerCapableIdentity');
  });
});

describe('GET /structures/public DTO', () => {
  it('returns only the frozen public shape with explicit rolling-deploy fallbacks', () => {
    const dto = toPublicLandStructureDTO({
      parcelCode: 'parcel-starter-00',
      gridX: 10,
      gridY: 20,
      tier: 'starter',
      structureType: 'home',
      level: 1,
      shellKey: null,
      paletteKey: null,
    });
    expect(dto).toEqual({
      parcelCode: 'parcel-starter-00',
      gridX: 10,
      gridY: 20,
      tier: 'starter',
      structureType: 'home',
      level: 1,
      shellKey: 'coastal-cottage',
      paletteKey: 'classic',
    });
    expect(dto).not.toHaveProperty('ownerAvatarId');
    expect(dto).not.toHaveProperty('parcelId');
  });

  it('is a public, cached, rate-limited active-only join', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'land.ts'), 'utf8');
    const route = source.match(
      /landRoutes\.get\('\/structures\/public'([\s\S]*?)\n\}\);/,
    )?.[1];
    expect(route).toContain('publicReadLimiter.check');
    expect(route).toContain('getPublicStructuresCache');
    expect(route).toContain("eq(landStructures.status, 'active')");
    expect(route).toContain('.innerJoin(landParcels');
    expect(route).not.toContain('requireAuthOrAgentSession');
  });
});
