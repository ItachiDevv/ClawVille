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
 * without a deploy, so any threshold written here would drift into a lie on a
 * live public surface. 2026-09-19: a fully numbered Genesis note (market-cap
 * band, per-trade size, position count, stop and take-profit multiples, trailing
 * percent, time limit, exit interval) was drafted and DELIBERATELY REJECTED for
 * exactly that reason, even though the owner supplied the numbers. Permission
 * does not remove the drift risk, it only moves who is responsible for it. The
 * rule has no exceptions; `house-trader-lineup.test.ts` enforces it on every
 * entry.
 *
 * P&L IS PUBLIC AND LIVE (founder order, 2026-09-20). The earlier "never claim
 * profitable, no P&L anywhere" rule was a misreading and is REVOKED. Each slot
 * on `GET /api/floor/house-traders` carries a `realised` block and the board
 * shows it. The rule that replaces it is narrower and stricter:
 *
 *   1. Every figure is SERVER-COMPUTED from the avatar's full verified history
 *      (`loadRealisedFromDb`). Never a hand-typed number, never a figure
 *      derived on a client, never a cached snapshot pasted into copy or a doc.
 *   2. The basis travels with the number: gross on the USDC leg, excluding
 *      network fees and rent. A bare figure without that is misleading.
 *   3. Still no BOAST wording. State the number; do not say a trader is
 *      crushing it, mooning or beating the market. A signed dollar figure and
 *      a win/loss count are facts; adjectives are a claim.
 *   4. `strategyNote` still carries NO digits. P&L numbers come from the
 *      route; strategy thresholds still do not belong in this file, because
 *      the rule loops change without a deploy.
 *
 * Gated by `house-trader-lineup.test.ts` (no digits in a note), by
 * `house-traders.test.tsx` (the panel renders the route's value and no literal)
 * and by `trading-floor-constants.test.ts` (the knowledge surfaces say the
 * board shows live P&L).
 *
 * This is NOT the five ClawPump trader TEMPLATES. Those are user starting
 * points a player copies into their own ClawPump account; this list is what
 * the house runs. The two lists are unrelated and must never be described as
 * matching.
 *
 * THE LINEUP IS TWO: Genesis (`momentum-board`) and ClawVille Runner
 * (`intel-signal-follower`), in that order.
 *
 * They are DISJOINT LANES, split on one condition (2026-09-20 03:45Z, clawPump).
 * Genesis takes small-cap memecoins that are NOT in a sharp five-minute dip;
 * the Runner takes ONLY coins that ARE. The condition partitions the universe,
 * so the two can never buy the same coin at the same moment. Both use the same
 * on-chain safety checks and both trail from the peak, the Runner wider.
 *
 * Do NOT describe them as "the same entries with different exits". That was
 * true of the 2026-09-19 lineup and is now FALSE: it would tell a reader the
 * pair is an exit-rule A/B test on one coin stream, when it is two
 * non-overlapping entry lanes. `house-trader-lineup.test.ts` fails on that
 * phrasing so the old paraphrase cannot come back.
 *
 * No avatar id, ClawPump agent id or wallet appears here, deliberately. A slot
 * fills from `clawpump_agent_links` by `objective` alone, so pairing and
 * unpairing happen in the database with no deploy, and a slot nobody has paired
 * yet reports its REAL status from the route. Never hard-code an identity here
 * and never invent a status such as "paper" for an empty slot.
 *
 * HISTORY, 2026-09-19: the lineup briefly dropped to ONE.
 * `sol-usdc-mean-reversion` / "Dip Hunter" was backtested, REJECTED and stopped
 * the same day, and it will never be paired, so publishing a slot for it would
 * advertise a trader that does not exist. It was REMOVED rather than left
 * `not-yet-running`, because that status means "nobody is paired to this slot
 * YET", which would have been a false promise. `sol-usdc-mean-reversion`
 * remains a valid `TradingObjective` because it is still one of the five
 * copyable TEMPLATES; it is only gone from the house lineup, and it must not
 * come back as one. `readHouseTraderSlots` filters candidates to this list
 * BEFORE selection, so a stray link on that objective is dropped and can never
 * resurrect a slot.
 */

import type { TradingObjective } from './trading-fleet';

/**
 * Genesis's strategy in one sentence, with NO thresholds.
 *
 * ONE constant on purpose. It is both the lineup entry's `strategyNote` (what
 * the watch panel renders) and the description the three seeded-knowledge
 * surfaces use: Nori (`town-guide.ts`), `CLAWVILLE_ORIENTATION_KNOWLEDGE` and
 * protocol manual section 17b. A second "short form" constant existed for one
 * revision and was collapsed into this: two strings saying the same thing is a
 * drift hazard with no benefit, and the panel and the manual should not be able
 * to describe the same live trader differently.
 *
 * It carries no LABEL prefix: the watch panel already renders `label` as the
 * card heading, so a leading "Genesis - " printed a stutter, and each knowledge
 * surface names Genesis in its own surrounding sentence.
 */
export const GENESIS_STRATEGY_NOTE =
  'Momentum on small-cap memecoins that are not in a sharp five-minute dip, with on-chain safety checks before every buy and a trailing stop from the peak. Rules only, no AI decisions.';

/**
 * ClawVille Runner's strategy in one sentence, with NO thresholds, under the
 * same rules as `GENESIS_STRATEGY_NOTE`: one constant, used both as the lineup
 * entry's `strategyNote` and by the seeded-knowledge surfaces, and no label
 * prefix because the panel renders `label` as the card heading above it.
 *
 * It names the Runner's OWN entry condition rather than describing it relative
 * to Genesis. The two notes state the two halves of one split: Genesis takes
 * coins NOT in a sharp five-minute dip, the Runner takes ONLY coins that are.
 * Read together they must remain mutually exclusive, because the lanes are.
 * "five-minute" is spelled out; the no-digits rule still applies to both.
 */
export const RUNNER_STRATEGY_NOTE =
  'Sharp five-minute dips on small-cap memecoins, the same safety checks, and a wider trailing stop from the peak. Rules only, no AI decisions.';

export interface HouseTraderLineupEntry {
  /** Join key into `clawpump_agent_links.objective`, not a description. */
  objective: TradingObjective;
  /** The slot title. Stays fixed even when the paired avatar is named else. */
  label: string;
  /** Plain words, no thresholds. See the header: the rule is absolute. */
  strategyNote: string;
}

export const HOUSE_TRADER_LINEUP: readonly HouseTraderLineupEntry[] = [
  {
    objective: 'momentum-board',
    label: 'Genesis',
    strategyNote: GENESIS_STRATEGY_NOTE,
  },
  {
    objective: 'intel-signal-follower',
    label: 'ClawVille Runner',
    strategyNote: RUNNER_STRATEGY_NOTE,
  },
];

/** The objectives the watch surface publishes, in lineup order. */
export const HOUSE_TRADER_OBJECTIVES: readonly TradingObjective[] =
  HOUSE_TRADER_LINEUP.map((entry) => entry.objective);
