/**
 * Shared-table baccarat: the process-wide `BaccaratTableManager` singleton.
 *
 * Its own module so the route (`routes/cove-baccarat-tables.ts`), the tick, the
 * scaler and the hosted-agent executor (`npc-simulation.ts`, lazy import) share ONE
 * instance (one per-table lock map, one public-state cache). Defaults: the real DB,
 * the real vCLAW ledger, the env round timings (`BAC_BETTING_WINDOW_MS`,
 * `BAC_REVEAL_PAUSE_MS`), and the visual-only bot pool wired to the house seeder.
 * The bots never bet, so there is no house-bank seam here.
 */

import { BaccaratTableManager } from './baccarat-table-manager';
import { baccaratHouseSeeder } from './baccarat-house-seeder';
import { baccaratBettingWindowMs, baccaratRevealPauseMs } from './baccarat-house-config';

export const baccaratTableManager = new BaccaratTableManager({
  bettingWindowMs: baccaratBettingWindowMs(),
  revealPauseMs: baccaratRevealPauseMs(),
  botPool: baccaratHouseSeeder,
});
