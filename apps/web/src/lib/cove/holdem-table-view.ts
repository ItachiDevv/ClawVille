const HOLDEM_SEAT_COUNT = 6;

const badgeElements: Array<HTMLDivElement | null> = Array.from(
  { length: HOLDEM_SEAT_COUNT },
  () => null,
);

let badgeRegistryVersion = 0;
let recenterEpoch = 0;
let settledRevealHandId: string | null = null;
const settledRevealListeners = new Set<() => void>();

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
  const previous = badgeElements[seat];
  badgeElements[seat] = element;
  badgeRegistryVersion += 1;
  const observer = getBadgeResizeObserver();
  if (previous) observer?.unobserve(previous);
  if (element) observer?.observe(element);
}

let badgeResizeObserver: ResizeObserver | null | undefined;

/** A badge that grows (a last-action line appears) re-runs the camera's
 * badge projection, so `separateSeatBadges` sees the new height. Fires only
 * on a size change, never per frame. */
function getBadgeResizeObserver(): ResizeObserver | null {
  if (badgeResizeObserver !== undefined) return badgeResizeObserver;
  badgeResizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => {
        badgeRegistryVersion += 1;
      });
  return badgeResizeObserver;
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

/** Display-only settle cue shared by the narration HUD and felt renderer.
 * The HUD publishes only after its action/street playback has caught up, so
 * opponent faces appear on the same beat as the settlement narration. */
export function publishHoldemSettledReveal(handId: string | null): void {
  if (settledRevealHandId === handId) return;
  settledRevealHandId = handId;
  for (const listener of settledRevealListeners) listener();
}

export function subscribeHoldemSettledReveal(listener: () => void): () => void {
  settledRevealListeners.add(listener);
  return () => settledRevealListeners.delete(listener);
}

export function getHoldemSettledRevealHandId(): string | null {
  return settledRevealHandId;
}

const SEAT_BADGE_GAP_PX = 4;
const SEPARATION_ORDER: number[] = [];
const SEPARATION_GROUP: number[] = [];
const SEPARATION_SHIFT: number[] = [];
const SEPARATION_RECENTER: number[] = [];

function separationGroupRoot(slot: number): number {
  let root = slot;
  while (SEPARATION_GROUP[root] !== root) root = SEPARATION_GROUP[root]!;
  return root;
}

/**
 * Push visible seat badges apart on the vertical axis where their boxes
 * overlap. Badges are centred on their anchor (`translate(-50%, -50%)`), so
 * LEFT/TOP are box centres. On a short screen (844 x 390) two neighbour
 * anchors project about 33 px apart while a badge is 40-62 px tall, and one
 * badge covered the other (2026-10-21). The screen order of the badges never
 * changes: each badge, top to bottom, moves down below every earlier badge it
 * overlaps; then each touching group moves back up by its mean shift, so the
 * group stays centred on its anchors. Runs only when the projection runs
 * (yaw, viewport, or badge size change), never per idle frame.
 */
export function separateSeatBadges(
  left: ArrayLike<number>,
  top: Float64Array,
  width: ArrayLike<number>,
  height: ArrayLike<number>,
  shown: ArrayLike<number>,
  gapPx = SEAT_BADGE_GAP_PX,
): void {
  const order = SEPARATION_ORDER;
  order.length = 0;
  for (let slot = 0; slot < top.length; slot += 1) {
    SEPARATION_GROUP[slot] = slot;
    SEPARATION_SHIFT[slot] = 0;
    if (shown[slot]) order.push(slot);
  }
  if (order.length < 2) return;
  const overlapsHorizontally = (a: number, b: number) =>
    Math.abs(left[a]! - left[b]!) < (width[a]! + width[b]!) / 2 + gapPx;
  const minDy = (a: number, b: number) => (height[a]! + height[b]!) / 2 + gapPx;
  /** Top to bottom, each badge moves down below every earlier badge it
   * overlaps. Afterwards no horizontally overlapping pair overlaps vertically. */
  const sweepDown = (recordShift: boolean) => {
    order.sort((a, b) => top[a]! - top[b]! || a - b);
    for (let k = 1; k < order.length; k += 1) {
      const slot = order[k]!;
      const before = top[slot]!;
      for (let m = 0; m < k; m += 1) {
        const above = order[m]!;
        if (!overlapsHorizontally(above, slot)) continue;
        const needed = top[above]! + minDy(above, slot);
        if (top[slot]! < needed) top[slot] = needed;
      }
      if (recordShift) SEPARATION_SHIFT[slot] = top[slot]! - before;
    }
  };

  sweepDown(true);

  // Touching badges form a group; a group moves back up by its mean shift,
  // so it stays centred on its anchors.
  for (let k = 1; k < order.length; k += 1) {
    for (let m = 0; m < k; m += 1) {
      const a = order[m]!;
      const b = order[k]!;
      if (!overlapsHorizontally(a, b)) continue;
      if (top[b]! - top[a]! > minDy(a, b) + 0.5) continue;
      SEPARATION_GROUP[separationGroupRoot(b)] = separationGroupRoot(a);
    }
  }
  for (const slot of order) {
    const root = separationGroupRoot(slot);
    let sum = 0;
    let count = 0;
    for (const other of order) {
      if (separationGroupRoot(other) !== root) continue;
      sum += SEPARATION_SHIFT[other]!;
      count += 1;
    }
    SEPARATION_RECENTER[slot] = sum / count;
  }
  for (const slot of order) top[slot] = top[slot]! - SEPARATION_RECENTER[slot]!;

  // A recentred group can move into a neighbour group (Codex review
  // 2026-10-22); one more downward sweep removes every overlap again.
  sweepDown(false);
}
