/**
 * M8 agent parity (2026-10-04): USDC rent prepay is NON-REFUNDABLE.
 *
 * The REST release response (routes/land.ts) carries `forfeitedUsdcPrepayCt`
 * and `forfeitReason`. The agent path (Hatcher `[ACTION: release_parcel]` ->
 * `npcSimulation.autonomousLandSettle`) must carry the same two fields, mapped
 * from the shared `settleTenureRelease` result. This suite runs the PRODUCTION
 * seam (not a test double of it) against a stubbed settlement module.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// Crash-loud module-load env, scoped to module init (see x402-checkout.test.ts).
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

import * as realSettlement from '../land-tenure-settlement';

// LEAK GUARD: mock.module is process-global; delegate to the real function
// once this suite is done. The original is captured BEFORE mock.module runs.
let intercept = true;
afterAll(() => {
  intercept = false;
});
const REAL_release = realSettlement.settleTenureRelease;

type ReleaseInput = Parameters<typeof realSettlement.settleTenureRelease>[0];
type ReleaseResult = Awaited<ReturnType<typeof realSettlement.settleTenureRelease>>;

let releaseCalls: ReleaseInput[] = [];
let nextRelease: ReleaseResult | null = null;

mock.module('../land-tenure-settlement', () => ({
  ...realSettlement,
  settleTenureRelease: async (input: ReleaseInput) => {
    if (!intercept) return REAL_release(input);
    releaseCalls.push(input);
    if (!nextRelease) throw new Error('test: nextRelease not set');
    return nextRelease;
  },
}));

const { npcSimulation } = await import('../npc-simulation');

const AVATAR = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AGENT = 'agent-forfeit-1';
const SESSION = 'session-forfeit-1';
const PARCEL_CODE = 'parcel-starter-01';

const identity = {
  kind: 'agent' as const,
  userId: USER,
  avatarId: AVATAR,
  agentId: AGENT,
  sessionId: SESSION,
  ledgerCapable: true as const,
};

function settlementResult(over: Partial<ReleaseResult>): ReleaseResult {
  return {
    fresh: true,
    released: true,
    refundedCt: 0,
    forfeitedUsdcPrepayCt: 0,
    parcel: { parcelCode: PARCEL_CODE, tier: 'starter' } as ReleaseResult['parcel'],
    tenancyAcquiredAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  releaseCalls = [];
  nextRelease = null;
});

describe('agent release_parcel result carries the M8 forfeit disclosure', () => {
  it('maps forfeitedUsdcPrepayCt + forfeitReason from the shared settlement', async () => {
    nextRelease = settlementResult({
      refundedCt: 300,
      forfeitedUsdcPrepayCt: 700,
      forfeitReason: 'usdc_rent_prepay_non_refundable',
    });

    const out = await npcSimulation.autonomousLandSettle({
      operation: { verb: 'release_parcel', parcelCode: PARCEL_CODE },
      identity,
      idempotencyKey: 'idem-forfeit-1',
    });

    expect(out).toEqual({
      kind: 'release',
      fresh: true,
      parcel: { parcelCode: PARCEL_CODE, tier: 'starter' },
      refundedCt: 300,
      forfeitedUsdcPrepayCt: 700,
      forfeitReason: 'usdc_rent_prepay_non_refundable',
    });
    // The agent path dispatches into the SAME shared settlement as REST, bound
    // to the session's agent/avatar/user (no guest fallback).
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toMatchObject({
      identity,
      expectedAgentId: AGENT,
      expectedAvatarId: AVATAR,
      expectedUserId: USER,
      parcelCode: PARCEL_CODE,
      idempotencyKey: 'idem-forfeit-1',
      autonomous: true,
    });
  });

  it('reports forfeitedUsdcPrepayCt: 0 and omits forfeitReason when nothing was forfeited', async () => {
    nextRelease = settlementResult({ refundedCt: 1_000, forfeitedUsdcPrepayCt: 0 });

    const out = await npcSimulation.autonomousLandSettle({
      operation: { verb: 'release_parcel', parcelCode: PARCEL_CODE },
      identity,
      idempotencyKey: 'idem-forfeit-2',
    });

    expect(out).toEqual({
      kind: 'release',
      fresh: true,
      parcel: { parcelCode: PARCEL_CODE, tier: 'starter' },
      refundedCt: 1_000,
      forfeitedUsdcPrepayCt: 0,
    });
    expect('forfeitReason' in out).toBe(false);
  });
});
