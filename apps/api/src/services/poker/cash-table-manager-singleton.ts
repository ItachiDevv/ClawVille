/**
 * Poker CASH GAMES (P1) — the process-wide `CashTableManager` singleton.
 *
 * Lives in its own module so the route (`cove-cash-poker.ts`) and any future
 * boot wiring import the SAME instance. Defaults: the real DB, the real ClawToken
 * ledger, and the dedicated `cashTableSim`. The seeded-agent provider is left
 * unset here (P1 house tables seed agents via an injected provider in a later
 * phase, or the route configures it); with no provider, empty seats simply stay
 * empty and a single human waits for a second sit-in — hands still require ≥2.
 *
 * CT-SUPPLY CONSERVATION (concern g): `seededAgentProvider` MUST NOT be wired
 * without a `houseBankAvatarProvider` that resolves a REAL house/treasury avatar
 * with a CT bankroll — the manager DEBITS the house bank for every seeded chip and
 * credits it back on the seeded agent's leave, so a human winning seeded chips does
 * NOT mint CT. The manager THROWS (`seeded_agent_requires_house_bank`) at fill time
 * if a seeded provider is set without a house bank, so the faucet can never open
 * accidentally. Both stay unset in P1.
 */

import { CashTableManager } from './cash-table-manager';

export const cashTableManager = new CashTableManager();
