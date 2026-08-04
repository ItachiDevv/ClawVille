import { describe, expect, test } from 'bun:test';
import {
  KELP_FOREST_PORTAL_APPROACH_WORLD,
  KELP_FOREST_PORTAL_HALF_X_WU,
  KELP_FOREST_PORTAL_PROMPT_RADIUS_WU,
  KELP_FOREST_PORTAL_WORLD_CENTER,
  KELP_FOREST_GROVE_WORLD_CENTER,
} from '@clawville/shared';
import { useTransitionStore } from '@/components/transitions/SceneTransition';
import {
  didCrossKelpForestPortal,
  isKelpForestPortalProximate,
} from './character-positions';
import { getAllColliders } from './collision/world-colliders';
import {
  resetKelpForestWalkInLatch,
  triggerKelpForestWalkIn,
} from './kelp-forest-transition';

// Regression (founder-reported 2026-07-20): after the portal moved to the town
// center, the E-prompt proximity check silently kept measuring from the NE
// GROVE alias (KELP_FOREST_CENTER), so a player at the actual portal got no
// prompt - just the solid portal collider. The prompt anchor MUST be the
// portal, and must NOT fire at the grove.
describe('Kelp Forest portal prompt proximity', () => {
  test('fires at the town-center portal', () => {
    expect(
      isKelpForestPortalProximate(
        KELP_FOREST_PORTAL_WORLD_CENTER.x,
        KELP_FOREST_PORTAL_WORLD_CENTER.z,
      ),
    ).toBe(true);
    expect(
      isKelpForestPortalProximate(
        KELP_FOREST_PORTAL_WORLD_CENTER.x + KELP_FOREST_PORTAL_PROMPT_RADIUS_WU,
        KELP_FOREST_PORTAL_WORLD_CENTER.z,
      ),
    ).toBe(true);
  });

  test('does not fire just outside the prompt radius', () => {
    expect(
      isKelpForestPortalProximate(
        KELP_FOREST_PORTAL_WORLD_CENTER.x + KELP_FOREST_PORTAL_PROMPT_RADIUS_WU + 1,
        KELP_FOREST_PORTAL_WORLD_CENTER.z,
      ),
    ).toBe(false);
  });

  test('does not fire at the NE grove (scenery alias, the regressed anchor)', () => {
    expect(
      isKelpForestPortalProximate(
        KELP_FOREST_GROVE_WORLD_CENTER.x,
        KELP_FOREST_GROVE_WORLD_CENTER.z,
      ),
    ).toBe(false);
  });
});

describe('Kelp Forest portal plane crossing', () => {
  const portalX = KELP_FOREST_PORTAL_WORLD_CENTER.x;
  const portalZ = KELP_FOREST_PORTAL_WORLD_CENTER.z;

  test('fires for a close-range crossing inside the arch opening', () => {
    expect(didCrossKelpForestPortal(
      portalX,
      portalZ + 90,
      portalX,
      portalZ - 90,
    )).toBe(true);
  });

  test('does not fire while walking parallel near the portal', () => {
    expect(didCrossKelpForestPortal(
      portalX - 50,
      portalZ + 20,
      portalX + 50,
      portalZ + 20,
    )).toBe(false);
  });

  test('uses interpolated crossing X to reject a diagonal sprint past the edge', () => {
    expect(didCrossKelpForestPortal(
      portalX + KELP_FOREST_PORTAL_HALF_X_WU + 100,
      portalZ - 100,
      portalX + KELP_FOREST_PORTAL_HALF_X_WU - 50,
      portalZ + 200,
    )).toBe(false);
  });

  test('detects a long single-frame jump through the arch', () => {
    expect(didCrossKelpForestPortal(
      portalX,
      portalZ - 1_000,
      portalX,
      portalZ + 1_000,
    )).toBe(true);
  });

  test('return-spawn seed does not cross the portal plane', () => {
    expect(didCrossKelpForestPortal(
      KELP_FOREST_PORTAL_APPROACH_WORLD.x,
      KELP_FOREST_PORTAL_APPROACH_WORLD.z,
      KELP_FOREST_PORTAL_APPROACH_WORLD.x,
      KELP_FOREST_PORTAL_APPROACH_WORLD.z,
    )).toBe(false);
  });

  test('a consumed legacy transition releases its stale latch for a retry', () => {
    resetKelpForestWalkInLatch();

    triggerKelpForestWalkIn();
    expect(useTransitionStore.getState().pending?.to).toBe('/kelp');

    useTransitionStore.getState()._consume();
    triggerKelpForestWalkIn();
    expect(useTransitionStore.getState().pending?.to).toBe('/kelp');
    resetKelpForestWalkInLatch();
  });
});

test('client world collider list leaves the Kelp portal arch passable', () => {
  expect(getAllColliders().some((collider) => collider.id === 'kelp-forest-portal')).toBe(false);
});
