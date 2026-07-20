import { beforeEach, describe, expect, it } from 'bun:test';
import {
  deriveKelpRealmClaimPrompt,
  describeKelpClaimFailure,
  describeKelpVisitFailure,
  getKelpRealmClaimSnapshot,
  markKelpRealmBeaconVisited,
  resetKelpRealmBeaconVisits,
  setKelpRealmBeaconTotalCount,
  setKelpRealmCenterProximity,
  subscribeKelpRealmBeaconVisits,
  subscribeKelpRealmClaimState,
} from './kelp-realm-visit-state';

describe('Kelp realm explicit collectible claim state', () => {
  beforeEach(() => resetKelpRealmBeaconVisits());

  it('publishes unique beacon progress and the center token without duplicate frame churn', () => {
    let emissions = 0;
    const unsubscribe = subscribeKelpRealmClaimState(() => { emissions += 1; });

    setKelpRealmCenterProximity(false);
    expect(emissions).toBe(0);
    setKelpRealmBeaconTotalCount(12);
    markKelpRealmBeaconVisited('entry', 'entry-token', 12, { found: 0, total: 3 });
    markKelpRealmBeaconVisited('entry', 'entry-token', 12, { found: 0, total: 3 });
    setKelpRealmCenterProximity(true);
    setKelpRealmCenterProximity(true);
    markKelpRealmBeaconVisited('center', 'center-token', 12, { found: 1, total: 3 });

    expect(getKelpRealmClaimSnapshot()).toMatchObject({
      nearCenter: true,
      centerToken: 'center-token',
      visitedCount: 2,
      totalCount: 12,
      sporesFound: 1,
      sporesTotal: 3,
    });
    expect(emissions).toBe(4);
    unsubscribe();
  });

  it('derives loud guest, incomplete-chain, and explicit ready prompts', () => {
    setKelpRealmBeaconTotalCount(12);
    setKelpRealmCenterProximity(true);
    expect(deriveKelpRealmClaimPrompt(getKelpRealmClaimSnapshot(), false)).toEqual({
      message: 'The pearl resists — light more beacons on the way in (0/12 lit)',
      canClaim: false,
    });
    markKelpRealmBeaconVisited('entry', 'entry-token', 12);
    expect(deriveKelpRealmClaimPrompt(getKelpRealmClaimSnapshot(), false)?.message)
      .toBe('The pearl resists — light more beacons on the way in (1/12 lit)');
    markKelpRealmBeaconVisited('center', 'center-token', 12);
    expect(deriveKelpRealmClaimPrompt(getKelpRealmClaimSnapshot(), false)).toEqual({
      message: 'Claim the collectible [E]',
      canClaim: true,
    });

    const base = {
      nearCenter: true,
      centerToken: null,
      visitedCount: 4,
      totalCount: 12,
      sporesFound: 2,
      sporesTotal: 3,
      notice: null,
    } as const;
    expect(deriveKelpRealmClaimPrompt(base, true)).toEqual({
      message: 'Sign in to claim the collectible at the center.',
      canClaim: false,
    });
    expect(deriveKelpRealmClaimPrompt(base, false)).toEqual({
      message: 'The pearl resists — light more beacons on the way in (4/12 lit)',
      canClaim: false,
    });
    expect(deriveKelpRealmClaimPrompt({ ...base, centerToken: 'center-token' }, false)).toEqual({
      message: 'Claim the collectible [E]',
      canClaim: true,
    });
  });

  it('turns anonymous entry, too-fast, and claim configuration failures into specific copy', () => {
    expect(describeKelpVisitFailure(401)).toContain('signed-in or guest session');
    expect(describeKelpVisitFailure(429, 'too_fast', 1_250)).toContain('wait 2s');
    expect(describeKelpVisitFailure(400, 'non_adjacent_beacon')).toContain('not connected');
    expect(describeKelpClaimFailure(500, 'collectible_sku_unavailable'))
      .toBe('The collectible is not ready to reveal yet. The team has been alerted.');
    expect(describeKelpClaimFailure(403, 'guest_not_allowed'))
      .toBe('Sign in to claim the collectible at the center.');
    expect(describeKelpClaimFailure(409, 'spores_missing', 2, 3))
      .toBe('The pearl resists - find the glowing spores (2/3)');
  });

  it('publishes a reset event so collected spore geometry can brighten again', () => {
    const visits: string[] = [];
    let resets = 0;
    const unsubscribe = subscribeKelpRealmBeaconVisits(
      (beaconId) => visits.push(beaconId),
      () => { resets += 1; },
    );
    markKelpRealmBeaconVisited('dead-end-1', 'token', 12, { found: 1, total: 3 });
    resetKelpRealmBeaconVisits();
    expect(visits).toEqual(['dead-end-1']);
    expect(resets).toBe(1);
    expect(getKelpRealmClaimSnapshot()).toMatchObject({
      sporesFound: 0,
      sporesTotal: 0,
    });
    unsubscribe();
  });
});
