/** Client-side bet/raise sizing — the ONE home for this math, consumed by
 * both the 2D modal and the seated 3D HUD (via re-exports from
 * holdem-controller.ts). Pure module (no React/store imports) so it is
 * directly unit-testable. The server remains the final validator of every
 * amount. P3.1, 2026-07-15. */

import { HOLDEM_BIG_BLIND } from './holdem-types';

/** Structural subset of LiveHoldemHand the sizing math needs. */
export interface BetSizingHandView {
  currentBet: string;
  humanCommitted: string;
  humanStack: string;
}

export type RaiseOpenResult =
  | { kind: 'call' }
  | { kind: 'slider'; min: number; max: number; verb: 'bet' | 'raise' };

export interface RaisePreset {
  label: 'Min' | '⅓ Pot' | '½ Pot' | 'Pot';
  value: number;
}

function bigToNum(value: string | null | undefined): number {
  if (value == null) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

/**
 * Display-only quick sizes expressed as TOTAL street commitments, matching the
 * server wire. Pot/blind/current-commit arithmetic stays bigint-exact until the
 * final clamp into the already-number-bounded slider config.
 */
export function computeRaisePresets(
  config: { min: number; max: number },
  pot: string,
  _bigBlind: string,
  humanCommitted: string,
): RaisePreset[] {
  const min = BigInt(config.min);
  const max = BigInt(config.max);
  const committed = safeBigInt(humanCommitted);
  const potBig = safeBigInt(pot);
  const clamp = (candidate: bigint): number => Number(
    candidate < min ? min : candidate > max ? max : candidate,
  );
  return [
    { label: 'Min', value: config.min },
    { label: '⅓ Pot', value: clamp(committed + (potBig / 3n)) },
    { label: '½ Pot', value: clamp(committed + (potBig / 2n)) },
    { label: 'Pot', value: clamp(committed + potBig) },
  ];
}

export function computeRaiseOpen(live: BetSizingHandView): RaiseOpenResult {
  const currentBet = bigToNum(live.currentBet);
  const humanCommitted = bigToNum(live.humanCommitted);
  const humanStack = bigToNum(live.humanStack);
  const maxShove = humanCommitted + humanStack; // TOTAL street commitment ceiling
  // Can't out-bet the current bet — only a call/all-in is legal.
  if (maxShove <= currentBet) return { kind: 'call' };
  const verb: 'bet' | 'raise' = currentBet === 0 ? 'bet' : 'raise';
  // Min TOTAL street commitment: opening bet ≥ committed + BB; raise ≥
  // currentBet + BB (the server rejects a short raise that isn't an all-in).
  const minRaise = verb === 'bet'
    ? humanCommitted + HOLDEM_BIG_BLIND
    : currentBet + HOLDEM_BIG_BLIND;
  return { kind: 'slider', min: Math.min(minRaise, maxShove), max: maxShove, verb };
}

export function computeAllIn(
  live: BetSizingHandView,
): { action: 'call' } | { action: 'bet' | 'raise'; amount: number } {
  const currentBet = bigToNum(live.currentBet);
  const shoveTotal = bigToNum(live.humanCommitted) + bigToNum(live.humanStack);
  // If shoving still doesn't exceed the current bet, it's an all-in CALL.
  if (shoveTotal <= currentBet) return { action: 'call' };
  return { action: currentBet === 0 ? 'bet' : 'raise', amount: shoveTotal };
}
