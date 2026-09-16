/** Frozen Trading Floor contracts shared by the API and web clients. */
export const TRADE_MINTS = {
  ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  CLAWVILLE: 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  WSOL: 'So11111111111111111111111111111111111111112',
} as const;

export const TRADE_DEX_PROGRAMS = {
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
} as const;
export type TradeDex = keyof typeof TRADE_DEX_PROGRAMS;

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

export type TradeUnscoredReason =
  | 'below_min_notional'
  | 'price_unavailable'
  | 'price_stale_window'
  | 'pre_bind'
  | 'chain_time_unavailable'
  | 'pair_repeat_today'
  | 'daily_cap';

export const TRADE_UNSCORED_REASONS = [
  'below_min_notional',
  'price_unavailable',
  'price_stale_window',
  'pre_bind',
  'chain_time_unavailable',
  'pair_repeat_today',
  'daily_cap',
] as const satisfies readonly TradeUnscoredReason[];

export function resolveTradeMultiplierTier(
  inputMint: string,
  outputMint: string,
): TradeMultiplierTier {
  if (inputMint === TRADE_MINTS.ANSEM || outputMint === TRADE_MINTS.ANSEM) return 'ansem';
  if (inputMint === TRADE_MINTS.CLAWVILLE || outputMint === TRADE_MINTS.CLAWVILLE) return 'clv';
  return 'base';
}

export type TradeRefusalCode =
  | 'not_configured' | 'no_link' | 'armed_false' | 'agent_killed'
  | 'fleet_halted' | 'agent_halted' | 'same_mint' | 'mint_not_whitelisted'
  | 'objective_forbids_mint' | 'decimals_unresolved' | 'decimals_mismatch'
  | 'price_unavailable' | 'amount_below_min' | 'amount_above_max'
  | 'equity_unreadable' | 'exceeds_float_pct' | 'daily_notional_cap'
  | 'cooldown_active' | 'in_flight' | 'slippage_above_cap'
  | 'directive_replayed' | 'directive_moderation_failed' | 'wallet_obligated'
  | 'quote_failed' | 'quote_impact_above_cap' | 'tx_binding_failed'
  | 'writable_account_failed' | 'simulation_failed' | 'min_out_below_admitted'
  | 'keypair_mismatch' | 'sol_reserve_breached' | 'usdc_reserve_breached'
  | 'blockhash_expired' | 'chain_error';

export const TRADE_REFUSAL_COPY: Record<TradeRefusalCode, string> = {
  not_configured: 'Trading is not configured.', no_link: 'No trading account is linked.',
  armed_false: 'Trading is not armed.', agent_killed: 'This agent is stopped.',
  fleet_halted: 'The trading fleet is halted.', agent_halted: 'This agent is halted.',
  same_mint: 'The input and output mints must differ.', mint_not_whitelisted: 'This mint is not allowed.',
  objective_forbids_mint: 'The current objective does not allow this mint.', decimals_unresolved: 'Mint decimals are unavailable.',
  decimals_mismatch: 'Mint decimals do not match.', price_unavailable: 'A required price is unavailable.',
  amount_below_min: 'The amount is below the minimum.', amount_above_max: 'The amount is above the maximum.',
  equity_unreadable: 'Wallet equity is unavailable.', exceeds_float_pct: 'The amount exceeds the float limit.',
  daily_notional_cap: 'The daily notional limit is reached.', cooldown_active: 'The trading cooldown is active.',
  in_flight: 'Another trade is in progress.', slippage_above_cap: 'The slippage exceeds the limit.',
  directive_replayed: 'This directive was already used.', directive_moderation_failed: 'The directive did not pass moderation.',
  wallet_obligated: 'The wallet has an active obligation.', quote_failed: 'The quote request failed.',
  quote_impact_above_cap: 'The quote impact exceeds the limit.', tx_binding_failed: 'The transaction does not match the admitted trade.',
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
