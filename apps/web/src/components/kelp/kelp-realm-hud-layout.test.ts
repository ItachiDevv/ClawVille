import { describe, expect, it } from 'bun:test';
import {
  KELP_MOBILE_CLAIM_PANEL_BOTTOM,
  calculateKelpMobileClaimPanelTop,
  shouldShowKelpGuestEntryBanner,
} from './kelp-realm-hud-layout';

describe('Kelp realm mobile claim HUD layout', () => {
  it('keeps the full claim panel visible on phone and iPad orientations', () => {
    const viewports = [
      { name: 'phone landscape', height: 390, safeAreaBottom: 34 },
      { name: 'phone portrait', height: 844, safeAreaBottom: 34 },
      { name: 'iPad landscape', height: 768, safeAreaBottom: 20 },
      { name: 'iPad portrait', height: 1024, safeAreaBottom: 20 },
    ] as const;

    for (const viewport of viewports) {
      const top = calculateKelpMobileClaimPanelTop(
        viewport.height,
        130,
        viewport.safeAreaBottom,
      );
      expect(top, viewport.name).toBeGreaterThanOrEqual(0);
      const panelBottomFromTop = top + 130;
      const joystickHandleTop = viewport.height
        - Math.max(viewport.safeAreaBottom + 60, 80)
        - 140;
      expect(panelBottomFromTop, viewport.name).toBeLessThanOrEqual(joystickHandleTop);
    }
  });

  it('pins the CSS height bound used by the rendered HUD', () => {
    expect(KELP_MOBILE_CLAIM_PANEL_BOTTOM)
      .toBe('min(max(316px, calc(env(safe-area-inset-bottom, 0px) + 316px)), calc(100dvh - 140px))');
  });

  it('hands guest messaging from the entry banner to the center claim panel', () => {
    expect(shouldShowKelpGuestEntryBanner(true, false)).toBe(true);
    expect(shouldShowKelpGuestEntryBanner(true, true)).toBe(false);
    expect(shouldShowKelpGuestEntryBanner(false, false)).toBe(false);
  });
});
