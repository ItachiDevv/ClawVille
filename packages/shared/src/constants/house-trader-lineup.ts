/**
 * The house traders ClawVille actually runs, and the ONLY slots the public
 * watch surface shows. Founder-approved lineup, 2026-09-19.
 *
 * A house trader runs the OPERATOR'S OWN rule loop on ClawPump, outside this
 * repo. So `TRADING_OBJECTIVE_BRIEFS` and `TRADING_OBJECTIVE_ALLOWED_OUTPUTS`
 * in `trading-fleet.ts` do NOT describe a house trader: Genesis holds the
 * `momentum-board` slot but trades small-cap memecoins on any venue, which is
 * far outside that profile's allowed outputs. Rendering the profile brief or
 * mint list on a house card would therefore be a false claim about a live
 * trader. Render `label` and `strategyNote` instead, never the profile text.
 *
 * `objective` stays the join key because that is what `clawpump_agent_links`
 * records and what the discriminator matches on. It is an identifier here, not
 * a description.
 *
 * NO NUMBERS in a strategyNote. The rule loops live outside the repo and change
 * without a deploy, so any threshold written here would drift into a lie.
 *
 * This is NOT the five ClawPump trader TEMPLATES. Those are user starting
 * points a player copies into their own ClawPump account; these two are what
 * the house runs. The two lists are unrelated and must never be described as
 * matching.
 */

import type { TradingObjective } from './trading-fleet';

export interface HouseTraderLineupEntry {
  /** Join key into `clawpump_agent_links.objective`, not a description. */
  objective: TradingObjective;
  /** The slot title. Stays fixed even when the paired avatar is named else. */
  label: string;
  /** Plain words, no thresholds. */
  strategyNote: string;
}

export const HOUSE_TRADER_LINEUP: readonly HouseTraderLineupEntry[] = [
  {
    objective: 'momentum-board',
    label: 'Genesis',
    strategyNote: 'Momentum on small-cap memecoins, any venue.',
  },
  {
    objective: 'sol-usdc-mean-reversion',
    label: 'Dip Hunter',
    strategyNote: 'Buys sharp dips in strong mid-cap coins.',
  },
];

/** The objectives the watch surface publishes, in lineup order. */
export const HOUSE_TRADER_OBJECTIVES: readonly TradingObjective[] =
  HOUSE_TRADER_LINEUP.map((entry) => entry.objective);
