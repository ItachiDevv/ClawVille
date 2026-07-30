export const KELP_MOBILE_CLAIM_PANEL_MAX_HEIGHT_PX = 156;
export const KELP_MOBILE_CLAIM_PANEL_BOTTOM =
  'min(max(316px, calc(env(safe-area-inset-bottom, 0px) + 316px)), calc(100dvh - 156px))';
export const KELP_MOBILE_GUEST_BANNER_TOP =
  'min(72px, max(16px, calc(100dvh - 374px)))';

export function shouldShowKelpGuestEntryBanner(
  isGuest: boolean,
  nearCenter: boolean,
): boolean {
  return isGuest && !nearCenter;
}

export function shouldShowKelpSporeCounter(sporesTotal: number): boolean {
  return Number.isFinite(sporesTotal) && sporesTotal > 0;
}

/** Mirrors the CSS lift for viewport regression tests. */
export function calculateKelpMobileClaimPanelTop(
  viewportHeight: number,
  panelHeight: number,
  safeAreaBottom: number,
): number {
  const preferredLift = Math.max(316, safeAreaBottom + 316);
  const heightBoundedLift = Math.min(
    preferredLift,
    viewportHeight - KELP_MOBILE_CLAIM_PANEL_MAX_HEIGHT_PX,
  );
  return viewportHeight - heightBoundedLift - panelHeight;
}

/** Mirrors the short-landscape guest-banner lift for viewport tests. */
export function calculateKelpMobileGuestBannerTop(
  viewportHeight: number,
): number {
  return Math.min(72, Math.max(16, viewportHeight - 374));
}
