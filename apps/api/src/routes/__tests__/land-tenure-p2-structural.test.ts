import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CT_RENTABLE_TIERS,
  HATCHER_ACTION_MENU,
  HATCHER_ACTION_VERBS,
  LAND_HOLD_THRESHOLDS_CLV,
  LAND_RENT_LADDER,
  LAND_TIER_LADDER,
  LAND_TENURE_RENT_CT_WEEKLY,
  TOTAL_PARCEL_SUPPLY,
  generateParcelsForTier,
} from '@clawville/shared';
import { autonomousLandIdempotencyKey } from '../../services/npc-simulation';
import {
  autonomousLandCapAllows,
  DEFAULT_AGENT_LAND_DAILY_SPEND_VCLAW,
} from '../../services/autonomous-land-spend-cap';

const API_SRC = join(import.meta.dir, '..', '..');
const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const service = readFileSync(join(API_SRC, 'services', 'land-tenure-settlement.ts'), 'utf8');
const routes = readFileSync(join(API_SRC, 'routes', 'land.ts'), 'utf8');
const reader = readFileSync(join(API_SRC, 'services', 'linked-wallet-clv-balance.ts'), 'utf8');
const sweeper = readFileSync(join(API_SRC, 'services', 'land-rent-sweeper.ts'), 'utf8');
const capSource = readFileSync(join(API_SRC, 'services', 'autonomous-land-spend-cap.ts'), 'utf8');
const migration = readFileSync(
  join(ROOT, 'packages', 'database', 'migrations', '0052_land_p2_absorb_ghost_parcels.sql'),
  'utf8',
);
const coreMigration = readFileSync(
  join(ROOT, 'packages', 'database', 'migrations', '0051_land_p2_tenure_core.sql'),
  'utf8',
);
const seed = readFileSync(join(API_SRC, '..', 'scripts', 'seed-land-parcels.ts'), 'utf8');
const executor = readFileSync(join(API_SRC, 'services', 'npc-simulation.ts'), 'utf8');
const autonomy = readFileSync(join(API_SRC, 'services', 'agent-autonomy-driver.ts'), 'utf8');
const statusRoute = readFileSync(join(API_SRC, 'routes', 'agent-gateway.ts'), 'utf8');
const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');

describe('Land P2 frozen constants', () => {
  it('locks the rent and hold ladders and retires a/b claim points', () => {
    expect(LAND_TENURE_RENT_CT_WEEKLY).toEqual({
      starter: 1_000,
      c: 2_500,
      b: null,
      a: null,
      founder: null,
    });
    expect(LAND_HOLD_THRESHOLDS_CLV).toEqual({
      starter: 100_000,
      c: 250_000,
      b: null,
      a: null,
      founder: 10_000_000,
    });
    expect(TOTAL_PARCEL_SUPPLY).toBe(56);
    expect(CT_RENTABLE_TIERS).toEqual(['starter', 'c']);
  });

  it('uses one constant for the quote, first-week debit, and stamped weekly price', () => {
    expect(routes).toContain('claimRentCtWeekly: tenureRentCtWeeklyForTier(row.tier)');
    expect(routes).toContain('displayName: parcelDisplayName(row.parcelCode, row.tier)');
    expect(service).toContain('const weeklyCt = tenureRentCtWeeklyForTier(parcel.tier)');
    expect(service).toContain('amount: weeklyCt');
    expect(service).toContain('rent_ct_weekly = ${weeklyCt}');
  });
});

describe('shared settlement architecture', () => {
  it('exports exactly the three backend operations and keeps effects in adapters', () => {
    for (const name of ['settleTenureClaim', 'settleRentPrepay', 'settleTenureRelease']) {
      expect(service).toContain(`export async function ${name}`);
    }
    expect(service).not.toContain('broadcastLandEvent');
    expect(service).not.toContain('bustOwnedCache');
    expect(service).not.toContain('logEventFromContext');
  });

  it('takes the outer mutex, advisory lock, idempotency read, and parcel row lock', () => {
    expect(service).toContain('withKeyedMutex(`land-tenure:${input.expectedAvatarId}`');
    expect(service).toContain('pg_advisory_xact_lock(hashtextextended');
    expect(service).toContain('FROM land_tenure_settlements');
    expect(service).toContain('FROM land_parcels WHERE parcel_code = ${parcelCode} FOR UPDATE');
    expect(service).toContain('land_hold_wallet_pubkey FROM users');
    expect(service).toContain('FOR SHARE');
    expect(capSource).toContain("metadata ->> 'autonomousLand' = 'true'");
  });

  it('serializes the sweeper and assigns collateral oldest-first to marginal holds', () => {
    expect(sweeper).toContain('withKeyedMutex(`land-tenure:${mutexPeek.owner_avatar_id}`');
    expect(sweeper).toContain('pg_advisory_xact_lock(hashtextextended');
    expect(sweeper).toContain('ORDER BY lp.acquired_at ASC NULLS LAST');
    expect(sweeper).toContain('currentIsBacked = resolution.uiAmount >= requiredClv');
    expect(sweeper).toContain('isTrue(p.grace_elapsed) ? { maxAgeMs: 0, maxStaleAgeMs: 0 }');
    expect(sweeper).toContain("reason: 'hold_set_missing'");
    expect(sweeper.indexOf('if (!currentInHoldSet)')).toBeLessThan(
      sweeper.indexOf('if (!currentIsBacked)'),
    );
  });

  it('keeps first declaration parity-open but makes repoint human-only and hold-locked', () => {
    expect(service).toContain('export async function declareLandHoldWallet');
    expect(service).toContain("identity.kind !== 'user'");
    expect(service).toContain("'wallet_change_requires_human', 409");
    expect(service).toContain("'wallet_locked_by_hold', 409");
    expect(service).toContain("p.tenure = 'hold'");
    expect(service).toContain('p.tenure_terms_version = 2');
    expect(service).toContain("p.status <> 'available'");
    expect(service).not.toContain("p.status = 'owned'");
    expect(routes).toContain('await declareLandHoldWallet(identity, canonical)');
  });

  it('uses cached hold-wallet reads with a per-identity budget and keeps claims fresh', () => {
    expect(routes).toContain(
      'const holdWalletReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 })',
    );
    expect(routes).toContain('holdWalletReadLimiter.check(identity.userId)');
    expect(routes).toContain('await getWalletClvBalance(declaration.walletAddress)');
    expect(routes).not.toContain(
      'getWalletClvBalance(declaration.walletAddress, { maxAgeMs: 0, maxStaleAgeMs: 0 })',
    );
    expect(service).toContain('maxAgeMs: 0');
    expect(service).toContain('maxStaleAgeMs: 0');
  });

  it('accepts week-based REST prepay and derives its amount in the shared service', () => {
    expect(routes).toContain('? { weeks: body.data.weeks }');
    expect(service).toContain('weekly * input.weeks');
  });

  it('binds release replay to the persisted acquired-at fingerprint and latest release', () => {
    expect(service).toContain('acquiredAt: priorResponse.tenancyAcquiredAt');
    expect(service).toContain('readLatestReleaseForParcel(tx, input.parcelCode)');
    expect(service).toContain(
      'latestResponse?.tenancyAcquiredAt !== priorResponse.tenancyAcquiredAt',
    );
  });

  it('hard-disables claim-starter before auth and exposes the new guarded routes', () => {
    expect(routes).toContain(
      "post('/claim-starter', (c) => c.json({ error: 'tenure_model_active' }, 409))",
    );
    for (const path of [
      '/hold-wallet',
      '/parcels/:parcelId/claim-rent',
      '/parcels/:parcelId/claim-hold',
      '/parcels/:parcelId/deposit-topup',
      '/parcels/:parcelId/release',
    ]) {
      const start = routes.indexOf(`post('${path}'`);
      expect(start).toBeGreaterThan(-1);
      const handler = routes.slice(start, routes.indexOf('async (c)', start) + 9);
      expect(handler).toContain('requireAuthOrAgentSession');
      expect(handler).toContain('requireLedgerCapableIdentity');
      expect(handler).toContain('requireNonGuestIdentity');
    }
  });
});

describe('ghost absorption and freshness guards', () => {
  it('carries the regenerated exact 18-row manifest and an all-or-nothing DELETE-only disposition', () => {
    const manifestRows = [
      ...migration.matchAll(/\('(parcel-[ab]-\d\d)','([ab])',(\d+),(\d+),(\d+),(\d+)\)/g),
    ].map((match) => match.slice(1).map((value, index) => (index < 2 ? value : Number(value))));
    const interpolate = (
      band: { minCt: number | null; maxCt: number | null },
      index: number,
      count: number,
    ) => Math.round(band.maxCt! - (band.maxCt! - band.minCt!) * (index / (count - 1)));
    const expectedRows = (
      [
        ['b', 12],
        ['a', 6],
      ] as const
    ).flatMap(([tier, count]) =>
      generateParcelsForTier(tier, count).map((parcel) => [
        parcel.id,
        tier,
        Math.floor((parcel.cx + 11_264) / 32),
        Math.floor((parcel.cz + 11_264) / 32),
        interpolate(LAND_TIER_LADDER[tier], parcel.indexInTier, count),
        interpolate(LAND_RENT_LADDER[tier], parcel.indexInTier, count),
      ]),
    );
    expect(manifestRows).toEqual(expectedRows);
    expect(migration).toContain('SELECT pg_advisory_xact_lock(510020260801)');
    expect(migration).not.toContain('hashtextextended');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("t.kind::text = 'parcel_relocation'");
    expect(migration).toContain('DELETE FROM land_parcels');
    expect(migration).not.toMatch(/UPDATE\s+land_parcels/i);
    expect(migration).toContain("RAISE EXCEPTION 'land P2 absorb refused");
    expect(migration).toContain('FROM land_structure_pieces sp WHERE sp.parcel_id = p.id');
    expect(migration.indexOf('final parcel count is not 56')).toBeLessThan(
      migration.lastIndexOf('END IF;'),
    );
  });

  it('scopes the escrow-shape constraint to v2 and restores never-abort sweeps', () => {
    expect(coreMigration).toContain('"tenure_terms_version" <> 2');
    expect(coreMigration).toContain('land_tenure_settlements_release_parcel_created_idx');
    expect(coreMigration).toContain("(\"response\" -> 'parcel' ->> 'parcelCode')");
    expect(coreMigration).toContain("WHERE \"operation\" = 'tenure_release'");
    expect(sweeper).not.toContain("throw new Error('house_treasury_unavailable')");
  });

  it('removes the b/a seed branch and bounds stale-high reads', () => {
    expect(seed).not.toContain('BA_SEED_PLAN');
    expect(seed).not.toContain('generateParcelsForTier,');
    expect(seed).toContain('const EXPECTED_TOTAL = TOTAL_PARCEL_SUPPLY');
    expect(reader).toContain('CLV_BALANCE_HARD_STALE_MS');
    expect(reader).toContain('maxStaleAgeMs');
    expect(reader).toContain('MAX_CACHE_ENTRIES');
  });
});

describe('autonomous cap arithmetic', () => {
  it('admits exactly through the cap and rejects one over', () => {
    expect(autonomousLandCapAllows(9_000, 1_000)).toBe(true);
    expect(autonomousLandCapAllows(9_001, 1_000)).toBe(false);
    expect(DEFAULT_AGENT_LAND_DAILY_SPEND_VCLAW).toBe(10_000);
    expect(envExample).toContain('AGENT_LAND_DAILY_SPEND_VCLAW=10000');
  });

  it('tracks the autonomous spend gate in the mandated six-field form', () => {
    for (const field of [
      'Status:',
      'Metric to graduate:',
      'Current reading:',
      'Review deadline:',
      'On deadline:',
      'Reference:',
    ]) {
      expect(service).toContain(field);
    }
  });
});

describe('agent land action surface', () => {
  it('keeps the executor whitelist and decide menu in lockstep for all three verbs', () => {
    for (const verb of ['claim_parcel', 'prepay_rent', 'release_parcel'] as const) {
      expect(HATCHER_ACTION_VERBS).toContain(verb);
      expect(HATCHER_ACTION_MENU.find((item) => item.verb === verb)).toBeDefined();
      expect(executor).toContain(`case '${verb}'`);
    }
    expect(autonomy).toContain('Land targets (server-derived; copy parcelCode exactly):');
    expect(autonomy).toContain('Claimable parcels (nearest first):');
    expect(autonomy).toContain('prepaidWeeks=');
  });

  it('derives durable semantic keys whose bucket agrees with the reservation window', () => {
    const action = {
      verb: 'prepay_rent' as const,
      parcelCode: 'parcel-starter-01',
      weeks: 3,
    };
    const first = autonomousLandIdempotencyKey('avatar-1', action, 120_001);
    expect(first).toBe(autonomousLandIdempotencyKey('avatar-1', action, 179_999));
    expect(first).not.toBe(autonomousLandIdempotencyKey('avatar-1', action, 180_000));
    expect(first).not.toBe(autonomousLandIdempotencyKey('avatar-1', { ...action, weeks: 4 }, 120_001));
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(executor).toContain('this.autonomousLandActionLastAdmittedAt.set(reservationKey, admittedAt)');
  });

  it('re-resolves the cove-grade binding and exposes a bounded status array plus count', () => {
    expect(executor).toContain('await this.autonomousCoveAgentResolve(');
    expect(executor).toContain("ledgerCapable: true as const");
    expect(executor).toContain('expectedAgentId: input.identity.agentId');
    expect(executor).toContain('expectedAvatarId: input.identity.avatarId');
    expect(executor).toContain('expectedUserId: input.identity.userId');
    expect(statusRoute).toContain('.orderBy(asc(landParcels.parcelCode))');
    expect(statusRoute).toContain('.limit(5)');
    expect(statusRoute).toContain('landParcels: landCount');
    expect(statusRoute).toContain('landParcelDetail: { count: landCount, parcels: ownedLand }');
    expect(statusRoute).toContain('displayName: parcelDisplayName(parcel.parcelCode, parcel.tier)');
  });
});
