import { describe, expect, it } from 'bun:test';
import {
  KELP_MOBILE_CLAIM_PANEL_BOTTOM,
  KELP_MOBILE_GUEST_BANNER_TOP,
  calculateKelpMobileClaimPanelTop,
  calculateKelpMobileGuestBannerTop,
  shouldShowKelpGuestEntryBanner,
  shouldShowKelpSporeCounter,
} from './kelp-realm-hud-layout';
import { parseKelpClaimErrorPayload } from './KelpRealmClaimHud';

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
      .toBe('min(max(316px, calc(env(safe-area-inset-bottom, 0px) + 316px)), calc(100dvh - 156px))');
  });

  it('separates the guest banner from the claim panel in short landscape', () => {
    expect(KELP_MOBILE_GUEST_BANNER_TOP)
      .toBe('min(72px, max(16px, calc(100dvh - 374px)))');
    expect(calculateKelpMobileGuestBannerTop(390)).toBe(16);
    expect(calculateKelpMobileGuestBannerTop(844)).toBe(72);

    const claimTop = calculateKelpMobileClaimPanelTop(390, 70, 0);
    expect(claimTop).toBe(86);
    expect(calculateKelpMobileGuestBannerTop(390) + 59)
      .toBeLessThan(claimTop);
  });

  it('hands guest messaging from the entry banner to the center claim panel', () => {
    expect(shouldShowKelpGuestEntryBanner(true, false)).toBe(true);
    expect(shouldShowKelpGuestEntryBanner(true, true)).toBe(false);
    expect(shouldShowKelpGuestEntryBanner(false, false)).toBe(false);
  });

  it('reveals the spore chip only after a successful visit reports its total', () => {
    expect(shouldShowKelpSporeCounter(0)).toBe(false);
    expect(shouldShowKelpSporeCounter(3)).toBe(true);
  });

  it('accepts only complete numeric spores-missing claim details', () => {
    expect(parseKelpClaimErrorPayload({ code: 'spores_missing', found: 2, total: 3 }))
      .toEqual({ code: 'spores_missing', found: 2, total: 3 });
    expect(parseKelpClaimErrorPayload({ code: 'spores_missing', found: '2', total: 3 }))
      .toEqual({});
    expect(parseKelpClaimErrorPayload({ code: 'spores_missing', found: 2 }))
      .toEqual({});
    expect(parseKelpClaimErrorPayload({ code: 'spores_missing', found: 2, total: 3, extra: true }))
      .toEqual({});
  });
});
