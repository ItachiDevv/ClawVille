export const KELP_MOBILE_CLAIM_PANEL_MAX_HEIGHT_PX = 140;
export const KELP_MOBILE_CLAIM_PANEL_BOTTOM =
  'min(max(316px, calc(env(safe-area-inset-bottom, 0px) + 316px)), calc(100dvh - 140px))';

export function shouldShowKelpGuestEntryBanner(
  isGuest: boolean,
  nearCenter: boolean,
): boolean {
  return isGuest && !nearCenter;
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
