import { TRADE_MINTS, TRADE_MIN_NOTIONAL_USD_DEFAULT } from './trading-floor';

export const TRADING_OBJECTIVES = [
  'momentum-board',
  'ansem-clawville-dca',
  'sol-usdc-mean-reversion',
  'intel-signal-follower',
  'conservative-rebalancer',
] as const;
export type TradingObjective = (typeof TRADING_OBJECTIVES)[number];

export const TRADING_OBJECTIVE_BRIEFS: Record<TradingObjective, string> = {
  'momentum-board': 'Buy strength and take profit back into SOL or USDC. The execution list is fixed; the board is information, not permission.',
  'ansem-clawville-dca': 'Accumulate $ANSEM and $CLAWVILLE steadily. One buy per cooldown, never the whole budget in a day, never sell into weakness.',
  'sol-usdc-mean-reversion': 'Trade only SOL against USDC. Buy SOL below its recent mean, sell back above it. No other token, ever.',
  'intel-signal-follower': 'Act on the intelligence snapshot in your desk block. If it is absent or stale, do not trade.',
  'conservative-rebalancer': 'Hold mostly USDC. Small tactical buys only when a position is far from target. Protect the float first.',
};

export const TRADING_OBJECTIVE_ALLOWED_OUTPUTS: Record<TradingObjective, readonly string[]> = {
  'momentum-board': [TRADE_MINTS.WSOL, TRADE_MINTS.USDC],
  'ansem-clawville-dca': [TRADE_MINTS.ANSEM, TRADE_MINTS.CLAWVILLE, TRADE_MINTS.USDC],
  'sol-usdc-mean-reversion': [TRADE_MINTS.WSOL, TRADE_MINTS.USDC],
  'intel-signal-follower': [TRADE_MINTS.WSOL, TRADE_MINTS.USDC, TRADE_MINTS.ANSEM],
  'conservative-rebalancer': [TRADE_MINTS.WSOL, TRADE_MINTS.USDC, TRADE_MINTS.CLAWVILLE],
};

export const TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT: Record<TradingObjective, number> = {
  'momentum-board': 0,
  'ansem-clawville-dca': 10,
  'sol-usdc-mean-reversion': 20,
  'intel-signal-follower': 10,
  'conservative-rebalancer': 60,
};

export const TRADING_SYMBOL_TO_MINT = {
  SOL: TRADE_MINTS.WSOL,
  USDC: TRADE_MINTS.USDC,
  CLAWVILLE: TRADE_MINTS.CLAWVILLE,
  ANSEM: TRADE_MINTS.ANSEM,
} as const;

export const TRADING_CODE_LIMITS = {
  dailyNotionalUsdPerAgent: 100,
  maxTradeUsd: 25,
  maxTradePctOfFloat: 25,
  maxSlippageBps: 300,
  maxQuoteImpactPct: 3,
  fleetDrawdownHaltPct: 25,
  minSolReserveLamports: 20_000_000,
  minUsdcReserveMicros: 2_000_000,
  /** Floor: env may only RAISE the cooldown (a zero cooldown would let one agent fire back-to-back). */
  minCooldownSeconds: 60,
  /** Ceiling: env may only LOWER the priority-fee cap (fee spend is real SOL). */
  maxPriorityFeeLamports: 1_000_000,
} as const;

function readFinite(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`[trading-floor] ${name} must be a non-negative number`);
  return value;
}

export interface EffectiveTradingLimits {
  dailyNotionalUsdPerAgent: number;
  maxTradeUsd: number;
  maxTradePctOfFloat: number;
  maxSlippageBps: number;
  maxQuoteImpactPct: number;
  fleetDrawdownHaltPct: number;
  minTradeUsd: number;
  minSolReserveLamports: bigint;
  minUsdcReserveMicros: bigint;
  cooldownSeconds: number;
  maxPriorityFeeLamports: bigint;
}

export function readTradingLimits(): EffectiveTradingLimits {
  return {
    dailyNotionalUsdPerAgent: readFinite('TRADING_DAILY_NOTIONAL_USD_PER_AGENT', 60),
    maxTradeUsd: readFinite('TRADING_MAX_TRADE_USD', 25),
    maxTradePctOfFloat: readFinite('TRADING_MAX_TRADE_PCT_OF_FLOAT', 25),
    maxSlippageBps: readFinite('TRADING_MAX_SLIPPAGE_BPS', 150),
    maxQuoteImpactPct: readFinite('TRADING_MAX_QUOTE_IMPACT_PCT', 3),
    fleetDrawdownHaltPct: readFinite('TRADING_FLEET_DRAWDOWN_HALT_PCT', 20),
    minTradeUsd: readFinite('TRADING_MIN_TRADE_USD', 1),
    minSolReserveLamports: BigInt(Math.trunc(readFinite('TRADING_MIN_SOL_RESERVE_LAMPORTS', 20_000_000))),
    minUsdcReserveMicros: BigInt(Math.trunc(readFinite('TRADING_MIN_USDC_RESERVE_MICROS', 2_000_000))),
    cooldownSeconds: readFinite('TRADING_COOLDOWN_S', 300),
    maxPriorityFeeLamports: BigInt(Math.trunc(readFinite('TRADING_MAX_PRIORITY_FEE_LAMPORTS', 1_000_000))),
  };
}

export function assertTradingLimitsWithinCode(): EffectiveTradingLimits {
  const v = readTradingLimits();
  const ceilings: Array<[string, number, number]> = [
    ['TRADING_DAILY_NOTIONAL_USD_PER_AGENT', v.dailyNotionalUsdPerAgent, TRADING_CODE_LIMITS.dailyNotionalUsdPerAgent],
    ['TRADING_MAX_TRADE_USD', v.maxTradeUsd, TRADING_CODE_LIMITS.maxTradeUsd],
    ['TRADING_MAX_TRADE_PCT_OF_FLOAT', v.maxTradePctOfFloat, TRADING_CODE_LIMITS.maxTradePctOfFloat],
    ['TRADING_MAX_SLIPPAGE_BPS', v.maxSlippageBps, TRADING_CODE_LIMITS.maxSlippageBps],
    ['TRADING_MAX_QUOTE_IMPACT_PCT', v.maxQuoteImpactPct, TRADING_CODE_LIMITS.maxQuoteImpactPct],
    ['TRADING_FLEET_DRAWDOWN_HALT_PCT', v.fleetDrawdownHaltPct, TRADING_CODE_LIMITS.fleetDrawdownHaltPct],
    ['TRADING_MAX_PRIORITY_FEE_LAMPORTS', Number(v.maxPriorityFeeLamports), TRADING_CODE_LIMITS.maxPriorityFeeLamports],
  ];
  for (const [name, value, ceiling] of ceilings) {
    if (value > ceiling) throw new Error(`[trading-floor] ${name} exceeds compiled ceiling ${ceiling}`);
  }
  if (v.minTradeUsd < TRADE_MIN_NOTIONAL_USD_DEFAULT) {
    throw new Error('[trading-floor] TRADING_MIN_TRADE_USD is below the scoring minimum');
  }
  if (v.minSolReserveLamports < BigInt(TRADING_CODE_LIMITS.minSolReserveLamports)) {
    throw new Error('[trading-floor] TRADING_MIN_SOL_RESERVE_LAMPORTS is below the compiled reserve floor');
  }
  if (v.minUsdcReserveMicros < BigInt(TRADING_CODE_LIMITS.minUsdcReserveMicros)) {
    throw new Error('[trading-floor] TRADING_MIN_USDC_RESERVE_MICROS is below the compiled reserve floor');
  }
  if (v.cooldownSeconds < TRADING_CODE_LIMITS.minCooldownSeconds) {
    throw new Error('[trading-floor] TRADING_COOLDOWN_S is below the compiled cooldown floor');
  }
  return v;
}
