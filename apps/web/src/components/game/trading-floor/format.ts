import {
  TRADE_MINT_LIQUIDITY_HINT,
  TRADE_MINTS,
  TRADE_REFUSAL_COPY,
  TRADE_UNSCORED_REASONS,
  isTradeRefusalCode,
  isTradeUnscoredReason,
  type TradeUnscoredReason,
} from '@clawville/shared';

import type {
  FloorDecision,
  FloorTrade,
} from '@/stores/trade-ticker';

export const TRADE_MINT_SYMBOLS: Readonly<Record<string, string>> = {
  [TRADE_MINTS.ANSEM]: '$ANSEM',
  [TRADE_MINTS.CLAWVILLE]: '$CLAWVILLE',
  [TRADE_MINTS.USDC]: 'USDC',
  [TRADE_MINTS.WSOL]: 'SOL',
};

const UNSCORED_COPY = {
  below_min_notional: 'Recorded. Too small to score.',
  daily_cap: "Recorded. You reached today's scoring limit.",
  pre_bind:
    'Recorded. This trade happened before you bound this wallet, so it does not score.',
  price_stale_window:
    'Recorded. Too old to price safely, so it does not score.',
  price_unavailable:
    'Recorded. We could not get a price, so it does not score.',
  pair_repeat_today: 'Recorded. This pair already scored today.',
  chain_time_unavailable:
    'Recorded. We could not read when this trade happened, so it does not score.',
} satisfies Record<TradeUnscoredReason, string>;

const REJECT_COPY: Readonly<Record<string, string>> = {
  dex_not_recognized: 'That is not a swap on a venue the floor reads.',
  dex_discriminator_unknown: 'The swap instruction is not recognized.',
  wallet_not_signer: 'A bound wallet did not sign that transaction.',
  token_account_not_owned: 'The token accounts do not belong to the signer.',
  vault_flow_mismatch: 'The swap vault movement does not match the trade.',
  multi_leg: 'That transaction has more than one leg. Report a single swap.',
  same_mint: 'Input and output are the same token.',
  single_sided: 'That is a transfer, not a swap.',
  no_net_movement: 'Nothing moved in that transaction.',
};

export const PENDING_UNCONFIRMED_AFTER_MS = 15 * 60_000;

export function shortSignature(signature: string): string {
  return signature.length <= 15
    ? signature
    : `${signature.slice(0, 7)}...${signature.slice(-6)}`;
}

export function shortMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 5)}...${mint.slice(-4)}`;
}

export function symbolForMint(mint: string): string {
  return TRADE_MINT_SYMBOLS[mint] ?? shortMint(mint);
}

export function pairLabel(trade: FloorTrade | FloorDecision): string {
  return `${symbolForMint(trade.inputMint)} / ${symbolForMint(trade.outputMint)}`;
}

export function formatNotionalUsd(usd: number | null): string {
  if (usd === null) return 'unpriced';
  if (usd > 0 && usd < 1) return '<$1';
  if (usd >= 1_000) return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${usd.toFixed(2)}`;
}

export function formatRequestedUsd(usd: number | null): string {
  return `${usd === null ? 'unpriced' : formatNotionalUsd(usd)} wanted`;
}

export function tierFromMultiplier(
  multiplier: number,
): 'base' | 'clv' | 'ansem' {
  if (multiplier === 2) return 'ansem';
  if (multiplier === 1.5) return 'clv';
  return 'base';
}

export function multiplierTone(
  trade: FloorTrade,
): 'neutral' | 'info' | 'positive' {
  if (!trade.scored) return 'neutral';
  if (trade.multiplier === 2) return 'positive';
  return trade.multiplier === 1.5 ? 'info' : 'neutral';
}

export function multiplierLabel(trade: FloorTrade): string | null {
  if (!trade.scored || trade.multiplier === 1) return null;
  const mint = trade.multiplierTier === 'ansem'
    ? TRADE_MINTS.ANSEM
    : TRADE_MINTS.CLAWVILLE;
  return `${trade.multiplier}x ${symbolForMint(mint)}`;
}

export function unscoredReasonCopy(reason: string | null): string {
  return isTradeUnscoredReason(reason)
    ? UNSCORED_COPY[reason]
    : 'Recorded. This trade does not score.';
}

export function rejectDetailCopy(detail: string | null): string {
  return (detail && REJECT_COPY[detail]) || 'That transaction is not an eligible swap.';
}

export function decisionReasonCopy(reason: string | null): string {
  return isTradeRefusalCode(reason)
    ? TRADE_REFUSAL_COPY[reason]
    : 'Blocked by a floor rule.';
}

export function tradeAgeLabel(
  blockTimeSec: number | null,
  nowMs: number,
): string {
  if (blockTimeSec === null) return 'time unavailable';
  const ageMs = Math.max(0, nowMs - blockTimeSec * 1_000);
  if (ageMs < 60_000) return 'now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

export function pendingState(
  atIso: string,
  nowMs: number,
): 'pending' | 'unconfirmed' {
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs) || atMs > nowMs) return 'pending';
  return nowMs - atMs >= PENDING_UNCONFIRMED_AFTER_MS
    ? 'unconfirmed'
    : 'pending';
}

export function decisionRowState(
  decision: FloorDecision,
  nowMs: number,
): 'pending' | 'unconfirmed' | 'executed' | 'blocked' {
  if (decision.verdict === 'refused') return 'blocked';
  if (decision.verdict === 'executed') return 'executed';
  return pendingState(decision.at, nowMs);
}

export function traderLabel(trade: FloorTrade | FloorDecision): string {
  return trade.subject?.avatarName ?? 'A trader';
}

export function dexLabel(dex: FloorTrade['dex']): string {
  if (dex === 'pumpswap') return 'PumpSwap';
  if (dex === 'pumpfun') return 'pump.fun';
  return 'Jupiter';
}

export function explorerUrl(signature: string): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}

export function operatorLabel(
  trade: { operatedByClawville: boolean; operator?: 'clawville' | 'clawpump' | null },
  density: 'tape' | 'panel',
): string | null {
  if (trade.operatedByClawville) return density === 'tape' ? 'HOUSE' : 'ClawVille-operated';
  if (trade.operator === 'clawpump') return density === 'tape' ? 'CLAWPUMP' : 'ClawPump-operated';
  return null;
}

export function liquidityHint(mint: string): string | null {
  return TRADE_MINT_LIQUIDITY_HINT[mint] ?? null;
}

export { TRADE_UNSCORED_REASONS };
