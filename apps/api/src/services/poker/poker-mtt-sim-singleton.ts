/**
 * Poker MTT (P3) — the DEDICATED process-wide `PokerTableSim` instance that the
 * TournamentManager drives.
 *
 * ── WHY A SEPARATE INSTANCE FROM `pokerTableSim` (the WS-demo singleton) ──────
 * `poker-table-sim-singleton.ts` exports the sim the activity WS hub + `index.ts`
 * boot wiring use for the cove "texas-holdem" DEMO (one hand per activity room,
 * NO CT). `index.ts` registers `setHandCompleteFn(...)` on THAT instance at
 * server-start with a demo single-hand handler that transitions the activity room
 * to RESULTS and tears the table down.
 *
 * `setHandCompleteFn` is a SINGLE-FIELD setter (not append). If the TM owned its
 * hand-complete callback on the SAME shared singleton, the LAST writer would win:
 * the production `tournamentManager` singleton sets the TM handler at module-load
 * time, then `index.ts`'s boot body (runs AFTER all imports resolve) OVERWRITES
 * it with the demo handler. A real MTT would then play hand 1, fire the demo
 * handler (no `mtt:<id>` activity room → `stopTable`), and the TM's multi-hand
 * loop would NEVER re-enter — no chip-delta apply, no bust/placement, no settle,
 * no refund. Buy-ins debited into `prize_pool_ct` would be escrowed FOREVER.
 *
 * Giving the TM its OWN sim instance fully isolates the MTT hand-complete loop
 * from the demo wiring — neither clobbers the other, regardless of import/boot
 * order. The MTT sim has its own table namespace (`mtt:<tournamentId>` table ids),
 * so there is no id collision with the demo singleton's room-id tables either.
 *
 * P3 drives the MTT sim DIRECTLY from the TM (auto-actor / scripted in tests; the
 * live human/agent action transport over WS for MTT tables is a later phase). The
 * WS hub's `applyAction` still targets the demo singleton — there is intentionally
 * no live MTT WS action path this phase, so the two sims never need to share state.
 *
 * Uses the default `REAL_CLOCK`. Tests construct their own `PokerTableSim(fakeClock)`
 * and inject it via `TournamentManagerDeps.sim`, so they never touch this instance.
 */

import { PokerTableSim } from './poker-table-sim';

/** The single MTT-tournament table sim for the API pod, owned by the TournamentManager. */
export const pokerMttSim = new PokerTableSim();
