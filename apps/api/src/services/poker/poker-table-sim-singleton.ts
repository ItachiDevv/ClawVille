/**
 * Phase P1.2b — the process-wide `PokerTableSim` singleton.
 *
 * Lives in its own module (not inline in `index.ts` or the WS hub) so BOTH the
 * activity WS hub (which calls `applyAction` on an inbound `poker.action`) and
 * `index.ts` (which registers the broadcast / per-seat / hand-complete
 * callbacks + drives `startHand` on the LIVE transition) import the SAME
 * instance without a circular import between the hub and the boot wiring.
 *
 * Uses the default `REAL_CLOCK` (real `setTimeout`) — tests construct their own
 * `PokerTableSim(fakeClock)` and do NOT use this singleton.
 */

import { PokerTableSim } from './poker-table-sim';

/** The single live-poker table sim for the API pod (single-pod, like the room manager). */
export const pokerTableSim = new PokerTableSim();
