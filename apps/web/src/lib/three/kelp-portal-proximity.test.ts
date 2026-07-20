import { describe, expect, test } from 'bun:test';
import {
  KELP_FOREST_PORTAL_PROMPT_RADIUS_WU,
  KELP_FOREST_PORTAL_WORLD_CENTER,
  KELP_FOREST_GROVE_WORLD_CENTER,
} from '@clawville/shared';
import { isKelpForestPortalProximate } from './character-positions';

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
