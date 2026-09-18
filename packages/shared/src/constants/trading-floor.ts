/** Frozen Trading Floor contracts shared by the API and web clients. */
export const TRADE_MINTS = {
  ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  CLAWVILLE: 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  WSOL: 'So11111111111111111111111111111111111111112',
} as const;

/**
 * Mainnet USDC is the one whitelisted mint with live authorities: Circle keeps
 * a mint authority and a freeze authority. Pinned from chain 2026-09-17 after
 * the staging $1 rung refused every trade with `decimals_unresolved` because the
 * whitelist demanded a null mint authority for all four mints. The other three
 * mints must carry NO authority of either kind.
 */
export const TRADE_USDC_AUTHORITIES = {
  mint: 'BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG',
  freeze: '7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar',
} as const;

export const TRADE_DEX_PROGRAMS = {
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
} as const;
export type TradeDex = keyof typeof TRADE_DEX_PROGRAMS;

/** Who places a bound wallet's trades. Display-only; never affects scoring. */
export type TradeOperator = 'clawville' | 'clawpump';

export function resolveTradeOperator(input: {
  operatedByClawville: boolean; source: string | null | undefined;
}): TradeOperator | null {
  if (input.operatedByClawville) return 'clawville';
  return input.source === 'clawpump' ? 'clawpump' : null;
}

export const TRADE_EVENT_TYPE = 'trade.verified' as const;
export const TRADE_TIER_WEIGHTS = { base: 20, clv: 30, ansem: 40 } as const;
export type TradeMultiplierTier = keyof typeof TRADE_TIER_WEIGHTS;
export const TRADE_DAILY_SCORED_CAP = 20;
export const TRADE_MIN_NOTIONAL_USD_FLOOR = 0.25;
export const TRADE_MIN_NOTIONAL_USD_DEFAULT = 0.5;
export const TRADE_TIER_MULTIPLIER: Record<TradeMultiplierTier, number> = {
  base: 1,
  clv: 1.5,
  ansem: 2,
};

export const TRADE_UNSCORED_REASONS = [
  'below_min_notional',
  'price_unavailable',
  'price_stale_window',
  'pre_bind',
  'chain_time_unavailable',
  'pair_repeat_today',
  'daily_cap',
] as const;
export type TradeUnscoredReason = (typeof TRADE_UNSCORED_REASONS)[number];

export function resolveTradeMultiplierTier(
  inputMint: string,
  outputMint: string,
): TradeMultiplierTier {
  if (inputMint === TRADE_MINTS.ANSEM || outputMint === TRADE_MINTS.ANSEM) return 'ansem';
  if (inputMint === TRADE_MINTS.CLAWVILLE || outputMint === TRADE_MINTS.CLAWVILLE) return 'clv';
  return 'base';
}

/**
 * Fleet-authored refusal vocabulary copied verbatim from the immutable client
 * spec `spec-clawpump-client-v7.md:26-45`. Order carries no meaning.
 */
export const TRADE_REFUSAL_CODES = [
  'not_configured',
  'no_link',
  'armed_false',
  'agent_killed',
  'fleet_halted',
  'agent_halted',
  'same_mint',
  'mint_not_whitelisted',
  'objective_forbids_mint',
  'decimals_unresolved',
  'decimals_mismatch',
  'price_unavailable',
  'equity_unreadable',
  'balance_unavailable',
  'amount_below_min',
  'amount_above_max',
  'exceeds_float_pct',
  'daily_notional_cap',
  'cooldown_active',
  'in_flight',
  'slippage_above_cap',
  'wallet_obligated',
  'directive_replayed',
  'directive_moderation_failed',
  'quote_failed',
  'quote_schema_invalid',
  'route_discontinuous',
  'quote_impact_above_cap',
  'leg_spec_inconsistent',
  'unsupported_shape',
  'tx_binding_failed',
  'writable_account_failed',
  'simulation_failed',
  'min_out_below_admitted',
  'keypair_mismatch',
  'sol_reserve_breached',
  'usdc_reserve_breached',
  'blockhash_expired',
  'chain_error',
] as const;
export type TradeRefusalCode = (typeof TRADE_REFUSAL_CODES)[number];

const UNSCORED_REASON_SET: ReadonlySet<string> = new Set(TRADE_UNSCORED_REASONS);
const REFUSAL_CODE_SET: ReadonlySet<string> = new Set(TRADE_REFUSAL_CODES);

/** Narrow an untrusted JSON value to the current unscored-reason vocabulary. */
export function isTradeUnscoredReason(x: unknown): x is TradeUnscoredReason {
  return typeof x === 'string' && UNSCORED_REASON_SET.has(x);
}

/** Narrow an untrusted JSON value to the current refusal-code vocabulary. */
export function isTradeRefusalCode(x: unknown): x is TradeRefusalCode {
  return typeof x === 'string' && REFUSAL_CODE_SET.has(x);
}

export const TRADE_REFUSAL_COPY: Record<TradeRefusalCode, string> = {
  not_configured: 'Trading is not configured.', no_link: 'No trading account is linked.',
  armed_false: 'Trading is not armed.', agent_killed: 'This agent is stopped.',
  fleet_halted: 'The trading fleet is halted.', agent_halted: 'This agent is halted.',
  same_mint: 'The input and output mints must differ.', mint_not_whitelisted: 'This mint is not allowed.',
  objective_forbids_mint: 'The current objective does not allow this mint.', decimals_unresolved: 'Mint decimals are unavailable.',
  decimals_mismatch: 'Mint decimals do not match.', price_unavailable: 'A required price is unavailable.',
  balance_unavailable: 'A required wallet balance is unavailable.',
  amount_below_min: 'The amount is below the minimum.', amount_above_max: 'The amount is above the maximum.',
  equity_unreadable: 'Wallet equity is unavailable.', exceeds_float_pct: 'The amount exceeds the float limit.',
  daily_notional_cap: 'The daily notional limit is reached.', cooldown_active: 'The trading cooldown is active.',
  in_flight: 'Another trade is in progress.', slippage_above_cap: 'The slippage exceeds the limit.',
  directive_replayed: 'This directive was already used.', directive_moderation_failed: 'The directive did not pass moderation.',
  wallet_obligated: 'The wallet has an active obligation.', quote_failed: 'The quote request failed.',
  quote_schema_invalid: 'The quote response is invalid.', route_discontinuous: 'The quote route is discontinuous.',
  quote_impact_above_cap: 'The quote impact exceeds the limit.', tx_binding_failed: 'The transaction does not match the admitted trade.',
  leg_spec_inconsistent: 'The trade legs are inconsistent.', unsupported_shape: 'The trade shape is not supported.',
  writable_account_failed: 'The transaction can write to an unapproved account.', simulation_failed: 'The transaction simulation failed.',
  min_out_below_admitted: 'The transaction minimum output is too low.', keypair_mismatch: 'The signing key does not match the bound wallet.',
  sol_reserve_breached: 'The trade would reduce the SOL reserve below its minimum.', usdc_reserve_breached: 'The trade would reduce the USDC reserve below its minimum.',
  blockhash_expired: 'The transaction blockhash expired.', chain_error: 'The chain rejected the transaction.',
};

export const TRADE_MINT_LIQUIDITY_HINT: Record<string, string> = {
  [TRADE_MINTS.ANSEM]: 'Use small orders because liquidity can change quickly.',
  [TRADE_MINTS.CLAWVILLE]: 'Use small orders and check quote impact before approval.',
  [TRADE_MINTS.USDC]: 'USDC is the stable quote asset for Trading Floor notional values.',
  [TRADE_MINTS.WSOL]: 'Keep enough SOL for fees and the required reserve.',
};

export interface TradingFleetExecutionRules {
  executionWhitelist: readonly string[] | null;
  dailyNotionalUsdPerAgent: number | null;
  perTradeMaxUsd: number | null;
  perTradeMaxPctOfFloat: number | null;
  maxSlippageBps: number | null;
  maxQuoteImpactPct: number | null;
  minCooldownS: number | null;
  maxFleetDrawdownHaltPct: number | null;
}

export interface TradingFloorRules {
  mints: typeof TRADE_MINTS;
  programs: typeof TRADE_DEX_PROGRAMS;
  dailyScoredCap: number;
  minNotionalUsd: number;
  multiplierTiers: typeof TRADE_TIER_MULTIPLIER;
  executionWhitelist: readonly string[] | null;
  guardrails: TradingFleetExecutionRules;
}

export function buildTradingFleetExecutionRules(
  input: Partial<TradingFleetExecutionRules> = {},
): TradingFleetExecutionRules {
  return {
    executionWhitelist: input.executionWhitelist ?? null,
    dailyNotionalUsdPerAgent: input.dailyNotionalUsdPerAgent ?? null,
    perTradeMaxUsd: input.perTradeMaxUsd ?? null,
    perTradeMaxPctOfFloat: input.perTradeMaxPctOfFloat ?? null,
    maxSlippageBps: input.maxSlippageBps ?? null,
    maxQuoteImpactPct: input.maxQuoteImpactPct ?? null,
    minCooldownS: input.minCooldownS ?? null,
    maxFleetDrawdownHaltPct: input.maxFleetDrawdownHaltPct ?? null,
  };
}

export const TRADING_FLOOR_RULES: TradingFloorRules = {
  mints: TRADE_MINTS,
  programs: TRADE_DEX_PROGRAMS,
  dailyScoredCap: TRADE_DAILY_SCORED_CAP,
  minNotionalUsd: TRADE_MIN_NOTIONAL_USD_DEFAULT,
  multiplierTiers: TRADE_TIER_MULTIPLIER,
  executionWhitelist: null,
  guardrails: buildTradingFleetExecutionRules(),
};

export const TRADE_SCORING_RULE_LINES = [
  `A verified trade scores at least ${TRADE_TIER_WEIGHTS.base} points.`,
  `Only the first ${TRADE_DAILY_SCORED_CAP} eligible trades per avatar and UTC day score.`,
  `The minimum scoring notional is $${TRADE_MIN_NOTIONAL_USD_DEFAULT.toFixed(2)}.`,
];

export const TRADING_FLOOR_GUARDRAIL_LINES: string[] = [];
export const TRADING_FLOOR_RULES_SUMMARY_LINES = [
  ...TRADE_SCORING_RULE_LINES,
  ...TRADING_FLOOR_GUARDRAIL_LINES,
];
