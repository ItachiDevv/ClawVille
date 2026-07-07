/**
 * Poker CASH GAMES (P1) — the process-wide `CashTableManager` singleton.
 *
 * Lives in its own module so the route (`cove-cash-poker.ts`) and the boot wiring
 * import the SAME instance. Defaults: the real DB, the real ClawToken ledger, and
 * the dedicated `cashTableSim`.
 *
 * HOUSE BOTS (2026-06-22): the two CT-supply seams are now WIRED to the house
 * seeder (`cash-house-seeder.ts`) so `source='house'` tables fill with seeded bots
 * backed by a real house-bank bankroll. Both seams are set TOGETHER (never one
 * without the other) — the manager's fill guard rejects a seeded provider with no
 * house bank, so the faucet can never open.
 *
 * CT-SUPPLY CONSERVATION (concern g): `seededAgentProvider` is wired ONLY alongside
 * a `houseBankAvatarProvider` that resolves the REAL house-bank avatar holding a CT
 * bankroll — the manager DEBITS the house bank for every seeded chip and credits it
 * back on the seeded agent's leave/reclaim, so a human winning seeded chips does NOT
 * mint CT. The manager THROWS (`seeded_agent_requires_house_bank`) at fill time if a
 * seeded provider is ever set without a house bank.
 */

import { CashTableManager } from './cash-table-manager';
import { cashHouseSeeder, CashBotPoolExhaustedError } from './cash-house-seeder';

/**
 * Wire the two CT-supply seams to the house seeder (founder-locked house bots):
 *   - `houseBankAvatarProvider` → the single seeded house-bank avatar that every
 *     seeded bot chip is DEBITED from at seat time and CREDITED back to at reclaim
 *     time, so seeded chips are REAL CT moved out of the bank, never minted.
 *   - `seededAgentProvider` → the bot pool's `claim(tableId, seatIndex)`, returning
 *     `{ avatarId, agentId, name }` for a free bot (or throwing-by-the-manager if the
 *     bank is somehow unwired — the no-faucet guard).
 *
 * BOOT ORDER: `cashHouseSeeder.ensure()` MUST run before the first sit/fill (it is
 * awaited in `index.ts` before the scaler/tick start). The providers are lazy
 * closures — they call into the seeder only when a seat is actually filled, by which
 * point `ensure()` has populated `houseBankAvatarId()` / the bot slots. If `ensure()`
 * has not run, `houseBankAvatarId()` throws (caught as a fill error, never a faucet)
 * and `claim()` returns null (the manager seats fewer bots — never mints).
 *
 * SCOPE: the manager only ever calls these for `source='house'` tables' seeded slots;
 * player-public / private tables carry `seededAgentSlots=0` so the seam is never hit
 * for them.
 */
export const cashTableManager = new CashTableManager({
  houseBankAvatarProvider: () => cashHouseSeeder.houseBankAvatarId(),
  seededAgentProvider: (tableId, seatIndex) => {
    const bot = cashHouseSeeder.claim(tableId, seatIndex);
    if (!bot) {
      // Pool exhausted — surface a structured, catchable error so the manager's
      // per-seat fill loop SKIPS this seat (seats fewer bots) rather than minting.
      // RUNTIME-IMPLEMENTER NOTE: wrap the per-seat `seededAgentProvider(...)` call
      // in `fillSeededAgents` in try/catch(CashBotPoolExhaustedError) → `break`, so
      // a (very unlikely, M=24 ≫ 15 concurrent) exhaustion never aborts a human sit.
      throw new CashBotPoolExhaustedError(tableId, seatIndex);
    }
    return bot;
  },
});
