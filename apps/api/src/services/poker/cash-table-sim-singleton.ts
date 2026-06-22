/**
 * Poker CASH GAMES (P1) — the dedicated `PokerTableSim` instance for CASH (ring)
 * tables.
 *
 * A SEPARATE instance from `pokerTableSim` (the WS-demo singleton) and
 * `pokerMttSim` (the tournament sim) so the three products own non-overlapping
 * tableId namespaces and non-overlapping `setHandCompleteFn` handlers — the cash
 * `CashTableManager` claims the hand-complete handler on THIS sim, the way the
 * `TournamentManager` claims it on its own. Cash sim tableIds are `cash:<uuid>`.
 *
 * Uses the default `REAL_CLOCK`; tests construct their own `PokerTableSim(fakeClock)`.
 */

import { PokerTableSim } from './poker-table-sim';

/** The single live CASH-poker table sim for the API pod. */
export const cashTableSim = new PokerTableSim();
