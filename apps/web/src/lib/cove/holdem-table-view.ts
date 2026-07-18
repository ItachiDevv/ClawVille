const HOLDEM_SEAT_COUNT = 6;

const badgeElements: Array<HTMLDivElement | null> = Array.from(
  { length: HOLDEM_SEAT_COUNT },
  () => null,
);

let badgeRegistryVersion = 0;
let recenterEpoch = 0;

/**
 * Tiny render-only bridge between the DOM HUD and the R3F table camera.
 * It deliberately carries no game state and creates no work while the view
 * is idle. The camera mutates registered badge positions only while yawing
 * (or after a viewport/registry change), keeping React out of the frame loop.
 */
export function registerHoldemSeatBadge(
  seat: number,
  element: HTMLDivElement | null,
): void {
  if (seat < 0 || seat >= HOLDEM_SEAT_COUNT || badgeElements[seat] === element) return;
  badgeElements[seat] = element;
  badgeRegistryVersion += 1;
}

export function getHoldemSeatBadgeElement(seat: number): HTMLDivElement | null {
  return badgeElements[seat] ?? null;
}

export function getHoldemBadgeRegistryVersion(): number {
  return badgeRegistryVersion;
}

export function requestHoldemTableRecenter(): void {
  recenterEpoch += 1;
}

export function getHoldemTableRecenterEpoch(): number {
  return recenterEpoch;
}
