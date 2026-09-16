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

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const FEED_LIMIT = 25;

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
