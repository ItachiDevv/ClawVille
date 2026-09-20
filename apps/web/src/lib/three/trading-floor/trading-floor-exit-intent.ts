/**
 * trading-floor-exit-intent.ts
 *
 * One-shot "the player asked to leave the Trading Floor" channel.
 *
 * The in-world door hotspot lives inside the R3F tree; the navigation (router
 * push, avatar placement, stage handoff) belongs to the route page, which owns
 * the router. Rather than duplicate the exit sequence in both places, the 3D
 * side publishes an intent and the page performs it — the same split the cove
 * uses for its table-room hotspots (`useCoveStore.requestEnterTableRoom`).
 *
 * A plain listener set instead of a store or a DOM CustomEvent: it is testable
 * in bun with no jsdom, and it cannot leak stage-scoped state between visits.
 */

type TradingFloorExitListener = () => void;

const listeners = new Set<TradingFloorExitListener>();

/** Subscribe. Returns the unsubscribe function. */
export function onTradingFloorExitRequest(
  listener: TradingFloorExitListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish. No-op when nothing is mounted to perform the exit. */
export function requestTradingFloorExit(): void {
  // Snapshot: a listener that unsubscribes itself while leaving must not
  // mutate the set mid-iteration.
  for (const listener of [...listeners]) listener();
}

/** Test seam — drops every subscription. */
export function resetTradingFloorExitListenersForTests(): void {
  listeners.clear();
}

/** Test seam — how many subscribers are live. */
export function tradingFloorExitListenerCount(): number {
  return listeners.size;
}
