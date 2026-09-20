'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  isTradeRefusalCode,
  isTradeUnscoredReason,
  type TradeUnscoredReason,
} from '@clawville/shared';

import {
  connectSolanaWallet,
  signMessageWithSolanaWallet,
} from '@/lib/solana-wallet';
import { ApiError } from '@/lib/api';
import {
  useTradeTickerStore,
  type FloorDecision,
  type FloorTrade,
} from '@/stores/trade-ticker';
import { useWorldStreamStore } from '@/stores/world-stream-state';
import { tierFromMultiplier } from '@/components/game/trading-floor/format';
import {
  normaliseHouseTraderRisk,
  type HouseTraderPairingStatus,
  type HouseTraderRiskView,
} from '@/components/game/trading-floor/house-trader-risk';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const FEED_LIMIT = 25;

/**
 * How often the house-trader surfaces re-read the route, and how long a result
 * is considered fresh. ONE constant for both, because a `staleTime` above the
 * interval would silently cancel it: react-query serves the cached value and
 * the poll becomes a no-op. Exported so a test can pin the wiring rather than
 * re-type the number. See `useHouseTraders` for why the interval exists at all.
 */
export const HOUSE_TRADERS_POLL_MS = 15_000;

export interface TradingWallet {
  pubkey: string;
  source: 'linked' | 'clawpump' | 'custodial' | 'signed';
  subjectKind: 'avatar' | 'agent';
  boundAt: string;
  lastPolledAt: string | null;
  operatedByClawville: boolean;
}

export interface ObserverHealth {
  enabled: boolean;
  lastTickAt: string | null;
  stale: boolean;
}

export interface FloorFeed {
  trades: FloorTrade[];
  generatedAt: string;
  observer: ObserverHealth;
}

export interface ReportTradeResult {
  trade: FloorTrade;
  scored: boolean;
  reason: TradeUnscoredReason | null;
  replayed: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function normaliseTrade(
  raw: unknown,
  mode: 'sse' | 'public' | 'mine',
): FloorTrade | null {
  const row = record(raw);
  if (!row || typeof row.signature !== 'string' || row.signature.length === 0) {
    return null;
  }
  if (
    typeof row.inputMint !== 'string' ||
    typeof row.outputMint !== 'string' ||
    typeof row.dex !== 'string' ||
    !['jupiter', 'pumpswap', 'pumpfun'].includes(row.dex) ||
    typeof row.multiplier !== 'number' ||
    ![1, 1.5, 2].includes(row.multiplier) ||
    typeof row.scored !== 'boolean'
  ) {
    return null;
  }
  const notionalUsd = nullableNumber(row.notionalUsd);
  const blockTime = nullableNumber(row.blockTime);
  const decisionId = row.decisionId === undefined
    ? null
    : nullableString(row.decisionId);
  if (
    notionalUsd === undefined ||
    blockTime === undefined ||
    decisionId === undefined
  ) {
    return null;
  }

  let subject: FloorTrade['subject'] = null;
  if (mode !== 'mine') {
    const rawSubject = record(row.subject);
    if (
      !rawSubject ||
      !['avatar', 'agent'].includes(String(rawSubject.type)) ||
      typeof rawSubject.id !== 'string'
    ) {
      return null;
    }
    const avatarName = nullableString(rawSubject.avatarName);
    if (avatarName === undefined) return null;
    subject = {
      type: rawSubject.type as 'avatar' | 'agent',
      id: rawSubject.id,
      avatarName,
    };
  }

  const wallet =
    mode === 'mine' && typeof row.wallet === 'string' ? row.wallet : null;
  const multiplier = row.multiplier as 1 | 1.5 | 2;
  const unscoredReason = isTradeUnscoredReason(row.unscoredReason)
    ? row.unscoredReason
    : null;
  const keys = decisionId
    ? [`t:${row.signature}`, `d:${decisionId}`]
    : [`t:${row.signature}`];

  return {
    kind: 'trade',
    keys,
    signature: row.signature,
    subject,
    wallet,
    inputMint: row.inputMint,
    outputMint: row.outputMint,
    notionalUsd,
    dex: row.dex as FloorTrade['dex'],
    blockTime,
    multiplier,
    multiplierTier: tierFromMultiplier(multiplier),
    decisionId,
    scored: row.scored,
    unscoredReason,
    operatedByClawville: row.operatedByClawville === true,
    operator: row.operatedByClawville === true ? 'clawville' : row.operator === 'clawpump' ? 'clawpump' : null,
  };
}

export function normaliseSseTrade(raw: unknown): FloorTrade | null {
  return normaliseTrade(raw, 'sse');
}

export function normalisePublicTrade(raw: unknown): FloorTrade | null {
  return normaliseTrade(raw, 'public');
}

export function normaliseMyTrade(raw: unknown): FloorTrade | null {
  return normaliseTrade(raw, 'mine');
}

export function normaliseDecisionEvent(raw: unknown): FloorDecision | null {
  const row = record(raw);
  const subject = record(row?.subject);
  if (
    !row ||
    typeof row.decisionId !== 'string' ||
    row.decisionId.length === 0 ||
    typeof row.verdict !== 'string' ||
    !['submitted', 'refused', 'executed'].includes(row.verdict) ||
    !subject ||
    subject.type !== 'agent' ||
    typeof subject.id !== 'string' ||
    typeof row.inputMint !== 'string' ||
    typeof row.outputMint !== 'string' ||
    typeof row.at !== 'string'
  ) {
    return null;
  }
  const avatarName = nullableString(subject.avatarName);
  const requestedUsd = nullableNumber(row.requestedUsd);
  if (avatarName === undefined || requestedUsd === undefined) return null;

  const verdict = row.verdict as FloorDecision['verdict'];
  const reason =
    verdict === 'refused' && isTradeRefusalCode(row.reason)
      ? row.reason
      : null;

  return {
    kind: 'decision',
    keys: [`d:${row.decisionId}`],
    decisionId: row.decisionId,
    subject: { type: 'agent', id: subject.id, avatarName },
    verdict,
    reason,
    inputMint: row.inputMint,
    outputMint: row.outputMint,
    requestedUsd,
    operatedByClawville: row.operatedByClawville === true,
    at: row.at,
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({}));
  return record(body) ?? {};
}

function toApiError(
  response: Response,
  body: Record<string, unknown>,
  fallback: string,
): ApiError {
  const message =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : `${fallback}: ${response.status}`;
  return new ApiError(message, response.status, body.code, {
    detail: typeof body.detail === 'string' ? body.detail : undefined,
  });
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}${path}`, { credentials: 'include' });
  const body = await responseBody(response);
  if (!response.ok) throw toApiError(response, body, 'Request failed');
  return body;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await responseBody(response);
  if (!response.ok) throw toApiError(response, parsed, 'Request failed');
  return parsed;
}

async function fetchFloorFeed(): Promise<FloorFeed> {
  const body = await getJson(`/api/exchange/trades/feed?limit=${FEED_LIMIT}`);
  const trades = Array.isArray(body.trades)
    ? body.trades
        .map(normalisePublicTrade)
        .filter((trade): trade is FloorTrade => trade !== null)
    : [];
  const observer = record(body.observer);
  return {
    trades,
    generatedAt:
      typeof body.generatedAt === 'string'
        ? body.generatedAt
        : new Date(0).toISOString(),
    observer: {
      enabled: observer?.enabled === true,
      lastTickAt:
        typeof observer?.lastTickAt === 'string' ? observer.lastTickAt : null,
      stale: observer?.stale === true,
    },
  };
}

export function useFloorFeed(enabled: boolean) {
  const generation = useWorldStreamStore((state) => state.generation);
  const baseline = useRef(generation);
  const wasEnabled = useRef(false);
  const query = useQuery({
    queryKey: ['trading-floor', 'feed', FEED_LIMIT],
    queryFn: fetchFloorFeed,
    enabled,
    staleTime: 60_000,
  });
  const { refetch } = query;

  useEffect(() => {
    if (!enabled) {
      baseline.current = generation;
      wasEnabled.current = false;
      return;
    }
    if (!wasEnabled.current) {
      baseline.current = generation;
      wasEnabled.current = true;
      return;
    }
    if (generation === baseline.current) return;
    baseline.current = generation;
    void refetch();
  }, [enabled, generation, refetch]);

  return query;
}

export function useMyTrades(enabled: boolean) {
  return useQuery({
    queryKey: ['trading-floor', 'mine'],
    queryFn: async () => {
      const body = await getJson('/api/exchange/trades/mine?limit=25');
      return {
        trades: Array.isArray(body.trades)
          ? body.trades
              .map(normaliseMyTrade)
              .filter((trade): trade is FloorTrade => trade !== null)
          : [],
      };
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useMyTradingWallets(enabled: boolean) {
  return useQuery({
    queryKey: ['trading-floor', 'wallets'],
    queryFn: async () => {
      const body = await getJson('/api/exchange/wallets/mine');
      const wallets = Array.isArray(body.wallets)
        ? body.wallets.flatMap((value): TradingWallet[] => {
            const wallet = record(value);
            if (
              !wallet ||
              typeof wallet.pubkey !== 'string' ||
              !['linked', 'clawpump', 'custodial', 'signed'].includes(String(wallet.source)) ||
              !['avatar', 'agent'].includes(String(wallet.subjectKind)) ||
              typeof wallet.boundAt !== 'string' ||
              !(wallet.lastPolledAt === null || typeof wallet.lastPolledAt === 'string') ||
              typeof wallet.operatedByClawville !== 'boolean'
            ) {
              return [];
            }
            return [{
              pubkey: wallet.pubkey,
              source: wallet.source as TradingWallet['source'],
              subjectKind: wallet.subjectKind as TradingWallet['subjectKind'],
              boundAt: wallet.boundAt,
              lastPolledAt: wallet.lastPolledAt,
              operatedByClawville: wallet.operatedByClawville,
            }];
          })
        : [];
      return { wallets };
    },
    enabled,
    staleTime: 30_000,
  });
}

function useBindMutation(
  mutationFn: () => Promise<TradingWallet>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['trading-floor', 'wallets'] });
    },
  });
}

export function useBindLinkedWallet() {
  return useBindMutation(async () => {
    const body = await postJson('/api/exchange/wallets/bind/linked', {});
    return body.wallet as unknown as TradingWallet;
  });
}

export function useBindCustodialWallet() {
  return useBindMutation(async () => {
    const body = await postJson('/api/exchange/wallets/bind/custodial', {});
    return body.wallet as unknown as TradingWallet;
  });
}

export function useBindSignedWallet() {
  return useBindMutation(async () => {
    const walletPubkey = await connectSolanaWallet();
    const challenge = await postJson('/api/exchange/wallets/bind/challenge', {
      walletPubkey,
    });
    if (
      typeof challenge.nonce !== 'string' ||
      typeof challenge.messageToSign !== 'string'
    ) {
      throw new ApiError('The wallet challenge was invalid.', 502);
    }
    const proof = await signMessageWithSolanaWallet(
      challenge.messageToSign,
      walletPubkey,
    );
    const body = await postJson('/api/exchange/wallets/bind', {
      walletPubkey: proof.walletPubkey,
      nonce: challenge.nonce,
      signature: proof.signatureBase58,
    });
    return body.wallet as unknown as TradingWallet;
  });
}

export function useRevokeTradingWallet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ pubkey }: { pubkey: string }) => {
      await postJson(
        `/api/exchange/wallets/${encodeURIComponent(pubkey)}/revoke`,
        {},
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['trading-floor', 'wallets'] });
    },
  });
}

export function useReportTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ signature }: { signature: string }) => {
      const body = await postJson('/api/exchange/trades/report', { signature });
      const trade = normaliseMyTrade(body.trade);
      if (!trade) throw new ApiError('The trade response was invalid.', 502);
      return {
        trade,
        scored: body.scored === true,
        reason: isTradeUnscoredReason(body.reason) ? body.reason : null,
        replayed: body.replayed === true,
      } satisfies ReportTradeResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['trading-floor', 'mine'] });
      void queryClient.invalidateQueries({ queryKey: ['trading-floor', 'feed'] });
    },
  });
}

export function floorErrorCode(error: unknown): string | null {
  return error instanceof ApiError && typeof error.code === 'string'
    ? error.code
    : null;
}

export function isFloorGuestBlocked(error: unknown): boolean {
  return floorErrorCode(error) === 'guest_not_allowed';
}

export function isFloorSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function floorForbiddenCopy(error: unknown): 'guest' | string {
  if (isFloorGuestBlocked(error)) return 'guest';
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session ended. Sign in again.';
  }
  if (error instanceof ApiError && error.status === 403 && !error.code) {
    return 'Create an avatar first.';
  }
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

export function useFloorStreamState() {
  return useWorldStreamStore((state) => state.state);
}

let clockHandle: ReturnType<typeof setInterval> | null = null;
let nowMs = Date.now();
const subscribers = new Set<() => void>();

function subscribeVisibleConsumer(callback: () => void): () => void {
  let active = true;
  subscribers.add(callback);
  useTradeTickerStore.getState().addConsumer();
  if (clockHandle === null) {
    nowMs = Date.now();
    clockHandle = setInterval(() => {
      nowMs = Date.now();
      subscribers.forEach((subscriber) => subscriber());
    }, 60_000);
  }
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(callback);
    useTradeTickerStore.getState().removeConsumer();
    if (subscribers.size === 0 && clockHandle !== null) {
      clearInterval(clockHandle);
      clockHandle = null;
    }
  };
}

/** One slot of the public house-trader watch surface. Always five, whatever
 *  the data says, so the panel never has to guess a shape. */
export interface HouseTraderSlotView {
  objective: string;
  slotName: string;
  strategyNote: string;
  status: HouseTraderPairingStatus;
  /** The same shape and the same id the public tape publishes, so one
   *  identifier policy governs both surfaces. Never the avatar UUID. */
  subject: { type: 'avatar' | 'agent'; id: string; avatarName: string | null } | null;
  counts: { verified: number; scored: number; lastTradeAt: string | null };
  /**
   * WHY THE DESK IS OR IS NOT OPENING POSITIONS, from the route (founder,
   * 2026-09-20). `null` means the route did not send a block we could read,
   * which includes the route that has not shipped the field yet, and both
   * public surfaces then render exactly as they did before it existed.
   *
   * A pause is never inferred from trade silence. See `house-trader-risk.ts`.
   */
  risk: HouseTraderRiskView | null;
  /**
   * PUBLIC live realised P&L, server-computed over the FULL history. Every
   * figure comes from the route; the panel never derives one.
   *
   * `null` means WE COULD NOT READ IT: the block was missing, or a money field
   * failed the runtime guard. That is a statement about our read, and it is a
   * DIFFERENT fact from a valid block with `closedPositions === 0`, which is a
   * statement about the trader. Collapsing the two would make the panel say "no
   * closed trades yet" about a live desk whose figures we simply failed to
   * parse, which is a false claim about a real trader. Raised by tf3d-screen,
   * who ships the same three-way split on the 3D board.
   */
  realised: HouseTraderRealisedView | null;
  recentTrades: FloorTrade[];
}

/** Mirrors `HouseTraderRealised` on the API. See `house-traders.ts` for the
 *  basis: gross on the USDC leg, excluding network fees and rent. */
export interface HouseTraderRealisedView {
  closedPositions: number;
  wins: number;
  losses: number;
  /** SIGNED USD. Negative is a real, normal value. */
  realisedUsd: number;
  /** `null` when nothing has closed, which is NOT the same as 0. */
  bestUsd: number | null;
  worstUsd: number | null;
  openPositions: number;
  /** Cost basis tied up in open lots, USD. Not a result. */
  openCostUsd: number;
  basis: string;
  costBasis: string;
  noExitHours: number;
  /** Lots written off as a total loss by the no-exit rule. */
  noExitClosures: number;
  unmatchedSells: number;
  /** Positions skipped for a non-USDC quote leg. Disclosed, not hidden. */
  excludedNonUsdc: number;
  /** Rows the figure was computed over. Compare with `counts.verified` to
   *  detect a truncated read downstream. */
  computedOverTrades: number;
  /** Legs excluded for want of a usable timestamp. Never dated to epoch 0. */
  undatedLegs: number;
  /** Legs excluded for a negative or zero notional: impossible, not unknown. */
  invalidLegs: number;
  /** SERVER-set: the headline does not cover everything. Includes causes the
   *  client cannot see, such as a truncated read. */
  partial: boolean;
  note: string;
  preBindIncluded: boolean;
  /** Above 0 means the headline figure is partial. */
  unpricedLegs: number;
  unclassifiedLegs: number;
  /** Non-empty: an unparseable payload yields `null` for the whole block
   *  rather than a block with a missing timestamp. */
  computedAt: string;
}

const EMPTY_REALISED_VIEW: HouseTraderRealisedView = {
  closedPositions: 0, wins: 0, losses: 0, realisedUsd: 0,
  bestUsd: null, worstUsd: null, openPositions: 0, openCostUsd: 0,
  basis: 'gross_usdc_leg', costBasis: 'round_trip_fifo',
  noExitHours: 24, noExitClosures: 0, unmatchedSells: 0, excludedNonUsdc: 0,
  computedOverTrades: 0, undatedLegs: 0, invalidLegs: 0, partial: false,
  note: 'Gross realised on the USDC leg, excludes network fees.',
  preBindIncluded: false, unpricedLegs: 0, unclassifiedLegs: 0, computedAt: '',
};

/** A number ONLY when the wire really sent a finite one. A missing or NaN
 *  field must never render as 0, because 0 is a meaningful P&L value. */
function wireNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function wireNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * `null` when the block is unreadable, NEVER a zero-filled stand-in.
 *
 * The five money-bearing fields must each be a finite number on the wire. A
 * missing or NaN one means we do not know this trader's result, and the only
 * honest render for that is "unavailable". Descriptive fields still fall back,
 * because a missing `note` does not make the figures wrong.
 */
/** Test seam: the guard is the whole point of the three-way split, so it is
 *  exercised directly rather than only through a rendered slot. */
export function normaliseHouseSlotRealisedForTest(value: unknown): HouseTraderRealisedView | null {
  return normaliseRealised(value);
}

/**
 * Test seam for the WHOLE slot, not a field.
 *
 * The risk block's contract has two halves and only one of them is about the
 * block: an unreadable `risk` must become `null` AND must leave every other
 * field of the slot standing. A per-field seam can only prove the first half,
 * and the half that would actually hurt, a bad `risk` collapsing the slot and
 * taking the P&L down with it, is the second.
 */
export function normaliseHouseSlotForTest(value: unknown): HouseTraderSlotView | null {
  return normaliseHouseSlot(value);
}

/** Per-field seam, alongside the whole-slot one above. The guard is exercised
 *  directly as well as through a slot, matching how `realised` is tested. */
export function normaliseHouseSlotRiskForTest(value: unknown): HouseTraderRiskView | null {
  return normaliseHouseTraderRisk(value);
}

function normaliseRealised(value: unknown): HouseTraderRealisedView | null {
  const row = record(value);
  if (!row) return null;

  // EVERY field is validated, not just the headline five. A silent per-field
  // fallback is worse than no figure: `bestUsd: "12.34"` would become null and
  // read as "no best trade", `openCostUsd: NaN` would become 0 and hide money
  // at risk, and `noExitHours: "48"` would become 24 and make the panel STATE A
  // METHOD THE SERVER DID NOT USE. A payload we cannot fully parse is a payload
  // we do not understand, so the only honest render is "P&L unavailable".
  // MONEY: signed and fractional by nature. A loss is negative and cents are
  // real, so these are only required to be finite.
  for (const key of ['realisedUsd', 'openCostUsd'] as const) {
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) return null;
  }
  // COUNTS: a tally of things. `-1 wins` and `1.5 closed positions` are not
  // small errors, they are impossible, and letting them through would render a
  // confident headline beside a nonsense breakdown. `noExitHours` belongs here
  // too: it is a whole-hour window, and a fractional or negative one would
  // describe a method that cannot exist.
  const counts = [
    'closedPositions', 'wins', 'losses', 'openPositions', 'noExitClosures',
    'excludedNonUsdc', 'unpricedLegs', 'unclassifiedLegs', 'undatedLegs',
    'invalidLegs', 'unmatchedSells', 'computedOverTrades', 'noExitHours',
  ] as const;
  for (const key of counts) {
    const v = row[key];
    // `isSafeInteger`, NOT `isInteger`: beyond 2^53-1 a JSON integer has
    // already lost precision by the time it reaches us, so 9007199254740993
    // arrives as 9007199254740992 and passes as a "valid" count that is not
    // the number the server sent. 1e21 passes `isInteger` too. A count we
    // cannot represent exactly is a count we should not publish.
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
  }
  // The ONLY legitimately nullable numbers: "nothing has closed" is a real
  // state. Anything other than a finite number or null is still a reject.
  for (const key of ['bestUsd', 'worstUsd'] as const) {
    const v = row[key];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) return null;
  }
  for (const key of ['basis', 'costBasis', 'note', 'computedAt'] as const) {
    if (typeof row[key] !== 'string' || row[key] === '') return null;
  }
  for (const key of ['preBindIncluded', 'partial'] as const) {
    if (typeof row[key] !== 'boolean') return null;
  }

  return {
    closedPositions: row.closedPositions as number,
    wins: row.wins as number,
    losses: row.losses as number,
    realisedUsd: row.realisedUsd as number,
    bestUsd: row.bestUsd as number | null,
    worstUsd: row.worstUsd as number | null,
    openPositions: row.openPositions as number,
    openCostUsd: row.openCostUsd as number,
    basis: row.basis as string,
    costBasis: row.costBasis as string,
    noExitHours: row.noExitHours as number,
    noExitClosures: row.noExitClosures as number,
    unmatchedSells: row.unmatchedSells as number,
    excludedNonUsdc: row.excludedNonUsdc as number,
    computedOverTrades: row.computedOverTrades as number,
    undatedLegs: row.undatedLegs as number,
    invalidLegs: row.invalidLegs as number,
    partial: row.partial as boolean,
    note: row.note as string,
    preBindIncluded: row.preBindIncluded as boolean,
    unpricedLegs: row.unpricedLegs as number,
    unclassifiedLegs: row.unclassifiedLegs as number,
    computedAt: row.computedAt as string,
  };
}

function normaliseHouseSlot(value: unknown): HouseTraderSlotView | null {
  const row = record(value);
  if (!row) return null;
  if (typeof row.objective !== 'string' || typeof row.slotName !== 'string') return null;
  const subject = record(row.subject);
  const counts = record(row.counts);
  return {
    objective: row.objective,
    slotName: row.slotName,
    strategyNote: typeof row.strategyNote === 'string' ? row.strategyNote : '',
    // Anything the client does not recognise reads as not running. An unknown
    // status must never imply activity.
    status: row.status === 'live-observed'
      ? 'live-observed'
      : row.status === 'stopped'
        ? 'stopped'
        : 'not-yet-running',
    subject: subject && typeof subject.id === 'string'
      ? {
          type: subject.type === 'avatar' ? 'avatar' : 'agent',
          id: subject.id,
          avatarName: typeof subject.avatarName === 'string' ? subject.avatarName : null,
        }
      : null,
    counts: {
      verified: typeof counts?.verified === 'number' ? counts.verified : 0,
      scored: typeof counts?.scored === 'number' ? counts.scored : 0,
      lastTradeAt: typeof counts?.lastTradeAt === 'string' ? counts.lastTradeAt : null,
    },
    realised: normaliseRealised(row.realised),
    // ADDITIVE and independent: an unreadable risk block yields `null` and the
    // slot keeps every other field, including its P&L. Collapsing the slot
    // here would turn a metadata problem into "P&L unavailable" on a desk whose
    // figures we read perfectly well.
    risk: normaliseHouseTraderRisk(row.risk),
    recentTrades: Array.isArray(row.recentTrades)
      ? row.recentTrades
          .map(normalisePublicTrade)
          .filter((trade): trade is FloorTrade => trade !== null)
      : [],
  };
}

async function fetchHouseTraders(): Promise<HouseTraderSlotView[]> {
  const body = await getJson('/api/floor/house-traders');
  return Array.isArray(body.slots)
    ? body.slots
        .map(normaliseHouseSlot)
        .filter((slot): slot is HouseTraderSlotView => slot !== null)
    : [];
}

/**
 * THE ONLY POLLER FOR BOTH PUBLIC SURFACES. The Exchange panel and the 3D board
 * share this one react-query key, so a single interval feeds both and neither
 * adds a second fetch. Live TRADE rows still arrive through the ticker store;
 * the risk verdict and the counts come from here.
 *
 * `refetchInterval` IS THE FEATURE, not a tuning knob. Without it this query
 * fetched once when the scene activated and then never again: react-query
 * refetches on mount, on window focus and on reconnect, and a player who simply
 * STANDS IN THE ROOM AND WATCHES THE BOARD triggers none of the three. `active`
 * comes from `useSceneActive()`, which is stable for as long as the player is
 * in the Trading Floor, so nothing was remounting either. The server could have
 * merged a pause and the edge cache could have dropped to one second, and the
 * board would still have shown the snapshot it fetched on arrival, forever.
 * That was the end-to-end gap under the whole feature (tfs-audit).
 *
 * 15 s, not 5 s (lead, 2026-09-20): web performance is priority one and one
 * small JSON fetch per 15 s is the budget. Worst case for a pause or a recovery
 * reaching an open board is therefore about 20 s, the poll plus the route's 5 s
 * edge cache.
 *
 * A POLL IS NOT A REPAINT, and that is what makes this affordable. The board
 * redraws only when `floorScreenSignature` changes, and that signature is
 * derived from `readRiskForBoard`, which deliberately excludes `ageSeconds` and
 * `at`. So a refetch that changes nothing the board draws produces an identical
 * signature, no canvas redraw and no texture upload. Had the ticking fields
 * gone into the signature, this interval would have meant a 1.28 MB upload
 * (5.13 MB at 2x) every 15 s forever.
 *
 * `refetchIntervalInBackground: false` is the default and is stated anyway: a
 * hidden tab stops polling, and the scene is paused there regardless.
 */
export function useHouseTraders(enabled: boolean) {
  return useQuery({
    queryKey: ['trading-floor', 'house-traders'],
    queryFn: fetchHouseTraders,
    enabled,
    staleTime: HOUSE_TRADERS_POLL_MS,
    refetchInterval: HOUSE_TRADERS_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

const subscribeHidden = () => () => undefined;
const getClockSnapshot = () => nowMs;

export function useFloorConsumer(visible: boolean): { nowMs: number } {
  const snapshot = useSyncExternalStore(
    visible ? subscribeVisibleConsumer : subscribeHidden,
    getClockSnapshot,
    getClockSnapshot,
  );
  return { nowMs: snapshot };
}

export function getFloorClockDiagnosticsForTest() {
  return { subscribers: subscribers.size, intervalActive: clockHandle !== null };
}

export function resetFloorClockForTest(): void {
  subscribers.clear();
  if (clockHandle !== null) clearInterval(clockHandle);
  clockHandle = null;
  nowMs = Date.now();
  useTradeTickerStore.setState({ consumers: 0 });
}
