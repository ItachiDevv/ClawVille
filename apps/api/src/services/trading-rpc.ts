import { Connection } from '@solana/web3.js';

/**
 * ONE mainnet RPC knob for the Trading Floor fleet.
 *
 * 2026-09-16 incident: wave 2 introduced a private `HELIUS_RPC_URL` reader in four
 * files while every box only carries the repo's canonical `HELIUS_API_KEY` (the
 * observer derives its Helius URL from it). The fleet sweeper opened a connection on
 * every pass, threw "RPC is not configured", and the fails-visible catch paged the
 * founder every five minutes from both boxes for a day.
 *
 * Resolution order (first hit wins):
 *   1. `HELIUS_RPC_URL` — explicit override (must be https and a mainnet host).
 *   2. `HELIUS_API_KEY` — the canonical knob; Helius mainnet URL is derived.
 *   3. null — execution refuses `not_configured`; background loops stay idle.
 * The public mainnet-beta endpoint is deliberately NOT a fallback for execution.
 */
export function tradingMainnetRpcUrl(): string | null {
  const explicit = process.env.HELIUS_RPC_URL?.trim();
  if (explicit) {
    const url = new URL(explicit);
    if (url.protocol !== 'https:' || !url.hostname.toLowerCase().includes('mainnet')) {
      throw new Error('[trading-floor] HELIUS_RPC_URL is not an https mainnet endpoint');
    }
    return explicit;
  }
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return null;
}

export function tradingRpcConfigured(): boolean {
  try {
    return tradingMainnetRpcUrl() !== null;
  } catch {
    return false;
  }
}

/** Throws the historical "not configured" message when no mainnet RPC is available. */
export function tradingConnection(): Connection {
  const url = tradingMainnetRpcUrl();
  if (!url) throw new Error('[trading-floor] RPC is not configured');
  return new Connection(url, 'confirmed');
}

const lastAlertAt = new Map<string, number>();
export const TRADING_ALERT_REPEAT_MS = 60 * 60 * 1000;

/**
 * Background loops must be fails-visible but never a pager storm: the same cause
 * alerts once, then at most once per hour, per process. Returns true when the
 * caller should alert now.
 */
export function shouldAlertTradingLoop(key: string, nowMs = Date.now()): boolean {
  const last = lastAlertAt.get(key);
  if (last !== undefined && nowMs - last < TRADING_ALERT_REPEAT_MS) return false;
  lastAlertAt.set(key, nowMs);
  return true;
}

export function resetTradingLoopAlertsForTest(): void {
  lastAlertAt.clear();
}
