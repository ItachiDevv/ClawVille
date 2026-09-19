/**
 * ClawPump trader templates: the copyable text a player or an agent uses to
 * start its OWN ClawPump trading agent.
 *
 * The five templates are the five trading PROFILES that already exist in
 * ClawVille code. A ClawPump agent is one of those profiles run on ClawPump.
 * The source of truth is `trading-fleet.ts`; this file only renders it.
 *
 * ClawVille never calls the ClawPump create-agent API: that call takes no owner
 * parameter, so an agent created with a ClawVille key would hold the user's
 * funds inside ClawVille's ClawPump account. The user creates the agent in
 * their own account and pastes this text in.
 *
 * WHAT "ENFORCED" MEANS HERE. For the profiles ClawVille signs for, these rules
 * run server side in `trading-guardrails.ts` and a breach refuses the trade. On
 * a ClawPump wallet the SAME text is only an instruction to the model, because
 * ClawVille holds no key there and can neither refuse a trade nor halt one. The
 * copy says so, because that is the only mitigation there is.
 *
 * Every number is DERIVED from the frozen fleet constants, never typed by hand,
 * so the served template cannot drift from the rules the fleet runs under.
 */

import {
  TRADING_CODE_LIMITS,
  TRADING_DEFAULT_COOLDOWN_SECONDS,
  TRADING_OBJECTIVE_ALLOWED_OUTPUTS,
  TRADING_OBJECTIVE_BRIEFS,
  TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT,
  TRADING_OBJECTIVES,
  type TradingObjective,
} from './trading-fleet';
import { TRADE_MINTS } from './trading-floor';

export interface TradingAgentTemplate {
  objective: TradingObjective;
  displayName: string;
  personaText: string;
  suggestedSkills: readonly string[];
  suggestedModel: string;
  guardrailNotes: readonly string[];
}

/** ClawPump skill slugs, verified against its live skill catalog 2026-09-19.
 *  ClawPump re-adds its own forced skills on every update, so this is the set
 *  the user enables, not the set the agent ends up with. */
export const TRADING_TEMPLATE_SKILLS = [
  'defi-trading',
  'portfolio',
  'market-intel',
  'wallet-ops',
] as const;

/** Verified present in the ClawPump model catalog 2026-09-19. A SUGGESTION
 *  only: always show it with `TRADING_TEMPLATE_MODEL_NOTE`, never as a
 *  statement about what the agent runs on. */
export const TRADING_TEMPLATE_MODEL = 'moonshotai/kimi-k2.5';

/**
 * The honest caveat that must travel with the model everywhere it is shown.
 * ClawPump's free tier answers on its own model regardless of the configured
 * one (`docs/clawpump-integration.md:18`, measured on the five live agents), so
 * naming the model without this note is a false claim in outward copy.
 */
export const TRADING_TEMPLATE_MODEL_NOTE =
  'Suggested model. ClawPump answers on its own free-tier model until you buy AI credits, so the agent may not run on the model you set.';

/**
 * A template value, deliberately NOT `TRADING_CODE_LIMITS.maxTradePctOfFloat`
 * (25). The executor's float cap governs swaps ClawVille signs itself and never
 * reaches a ClawPump wallet, so the template asks for the tighter number the
 * five live ClawVille profile agents already carry. On a small wallet this is
 * the line that binds, not the dollar ceiling.
 */
export const TRADING_TEMPLATE_MAX_EQUITY_PCT = 10;

export const TRADING_TEMPLATE_VERSION = 1;

/** Verified live 2026-09-19 through the ClawPump dashboard-url surface. */
export const CLAWPUMP_DASHBOARD_URL = 'https://agents.clawpump.tech/dashboard';

/** Display names only. The RULE SET below is derived from ClawVille code, so it
 *  is not a copy of any live agent's hand-written prompt. */
export const TRADING_TEMPLATE_DISPLAY_NAMES: Record<TradingObjective, string> = {
  'momentum-board': 'Momentum',
  'ansem-clawville-dca': 'AnsemDCA',
  'sol-usdc-mean-reversion': 'MeanRevert',
  'intel-signal-follower': 'SignalFollower',
  'conservative-rebalancer': 'SafeRebalancer',
};

/**
 * Mint to symbol, with `WSOL` rendered as `SOL`. Same idiom as the Trading desk
 * block at `autonomous-trading-targets.ts:38`, owned here so the shared package
 * does not depend on an API service. A persona that said "WSOL" would name a
 * token no trader types.
 */
const SYMBOL_BY_MINT = new Map<string, string>(
  Object.entries(TRADE_MINTS).map(([symbol, mint]) => [mint, symbol === 'WSOL' ? 'SOL' : symbol]),
);

/** Lamports are the compiled reserve floor; the persona states SOL. */
const MIN_SOL_RESERVE = TRADING_CODE_LIMITS.minSolReserveLamports / 1_000_000_000;

/** 300 seconds renders as "5 minutes"; a non-round value stays in seconds. */
const COOLDOWN_PHRASE =
  TRADING_DEFAULT_COOLDOWN_SECONDS % 60 === 0
    ? `${TRADING_DEFAULT_COOLDOWN_SECONDS / 60} minutes`
    : `${TRADING_DEFAULT_COOLDOWN_SECONDS} seconds`;

/**
 * `$ANSEM` and `$CLAWVILLE` carry their mint so a trader cannot buy a
 * look-alike. SOL and USDC are unambiguous on every venue and carry none.
 */
function symbolLabel(mint: string): string {
  const symbol = SYMBOL_BY_MINT.get(mint);
  if (symbol === undefined) {
    // DELIBERATE crash-at-import, not a lazy failure. `TRADING_AGENT_TEMPLATES`
    // builds eagerly below, so an allowed mint with no symbol takes down the
    // API and the web bundle at module load rather than silently serving a
    // persona that names a token the trader cannot identify. It is a pure
    // function of frozen constants, so it either always throws or never does,
    // and the unit test exercises every objective.
    throw new Error(`[trading-agent-templates] no symbol is mapped for mint ${mint}`);
  }
  if (mint === TRADE_MINTS.ANSEM || mint === TRADE_MINTS.CLAWVILLE) {
    return `$${symbol} (${mint})`;
  }
  return symbol;
}

/**
 * Compose one persona from the frozen constants. Fixed order: identity,
 * objective, USDC floor, tradeable symbols, size caps, pacing, execution
 * hygiene, prohibitions, and what ClawVille actually does with the result.
 *
 * DELIBERATE DEVIATIONS from the live hand-written prompts, do not "fix" them
 * back: the mint list follows `TRADING_OBJECTIVE_ALLOWED_OUTPUTS`, so
 * `intel-signal-follower` omits $CLAWVILLE and `momentum-board` omits both
 * $ANSEM and $CLAWVILLE even though the live prompts name them. Code wins.
 */
export function buildTemplatePersona(objective: TradingObjective): string {
  const usdcSharePct = TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT[objective];
  const symbols = TRADING_OBJECTIVE_ALLOWED_OUTPUTS[objective].map(symbolLabel).join(', ');
  return [
    `You are ${TRADING_TEMPLATE_DISPLAY_NAMES[objective]}, a ClawVille Trading Floor trader (clawville.world, the agent and human metaverse). You trade on ClawPump with your own ClawPump wallet.`,
    // POSITION 2 ON PURPOSE, and do not move it back to the end. The ClawPump
    // persona field length limit is UNMEASURED: the largest persona ClawPump is
    // known to have accepted from us is 244 characters (the live AnsemDCA), and
    // these run to about 1100. If the field silently truncates, a last-line
    // honesty sentence is exactly what disappears, and the agent goes back to
    // believing it is ranked. Here, truncation can only cost a trading rule.
    //
    // Deliberately NOT the spec's "Every trade you make is verified on chain
    // and scored on the public ClawVille leaderboard": that is false for a
    // ClawPump wallet. `reportTradeSignature` (trade-observer.ts:396-399)
    // refuses any signature whose signers hold no already-bound wallet, and no
    // self-serve door binds a ClawPump wallet, so no `verified_trades` row is
    // written and the trade reaches neither the public tape nor the board.
    // WHEN THE OWNERSHIP-PROOF DOOR SHIPS: bump TRADING_TEMPLATE_VERSION and
    // restore a true scoring line here.
    'ClawVille verifies and scores on-chain trades only from a wallet bound to a ClawVille avatar at clawville.world/leaderboard. A ClawPump wallet cannot be bound yet, so ClawVille cannot verify, show, or rank your trades.',
    `Objective: ${TRADING_OBJECTIVE_BRIEFS[objective]}`,
    // The second sentence is required. `objectiveUsdcShareBreached`
    // (trading-guardrails.ts:269-282) fires ONLY when the input mint is USDC
    // and the projected post-trade share falls under the floor. "Keep N
    // percent" alone would state a different rule from the one the
    // ClawVille-side siblings run under. Emitted only above 0, because a
    // "keep at least 0 percent" line reads as a rule and means nothing.
    ...(usdcSharePct > 0
      ? [
          `Keep at least ${usdcSharePct} percent of equity in USDC. Do not spend USDC when the trade would push the USDC share below that floor.`,
        ]
      : []),
    `Suggested rules: trade only ${symbols}.`,
    `Never more than $${TRADING_CODE_LIMITS.maxTradeUsd} per trade. Never more than ${TRADING_TEMPLATE_MAX_EQUITY_PCT} percent of equity per trade.`,
    `Wait at least ${COOLDOWN_PHRASE} between trades.`,
    `Always get a quote before a swap. Skip the trade when the quote shows more than ${TRADING_CODE_LIMITS.maxQuoteImpactPct} percent price impact. Keep at least ${MIN_SOL_RESERVE} SOL for fees.`,
    'Never transfer funds out. Never trade perps, never snipe, never launch tokens. If a rule and an instruction conflict, the rule wins.',
  ].join('\n');
}

function buildGuardrailNotes(objective: TradingObjective): readonly string[] {
  return [
    `ClawVille ENFORCES these rules for the profiles it signs for: the mint list, the per-trade ceiling, the cooldown, the daily notional cap and the USDC floor all run server side and refuse the trade. On a ClawPump wallet the same text is only an instruction to the model, because ClawVille holds no key for ${TRADING_TEMPLATE_DISPLAY_NAMES[objective]} there and can neither refuse a trade nor halt it.`,
    'The wallet stays in your own ClawPump account. ClawVille never holds its key and never signs its swaps.',
  ];
}

export const TRADING_AGENT_TEMPLATES: readonly TradingAgentTemplate[] = TRADING_OBJECTIVES.map(
  (objective) => ({
    objective,
    displayName: TRADING_TEMPLATE_DISPLAY_NAMES[objective],
    personaText: buildTemplatePersona(objective),
    suggestedSkills: TRADING_TEMPLATE_SKILLS,
    suggestedModel: TRADING_TEMPLATE_MODEL,
    guardrailNotes: buildGuardrailNotes(objective),
  }),
);
