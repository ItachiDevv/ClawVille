'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { FloorArenaApiError, floorArenaErrorCode, floorArenaErrorCopy, floorArenaKeys } from '@/hooks/use-floor-arena';
import { ApiError } from '@/lib/api';

// Data layer for the Trading Arena wallet WITHDRAW (P5, D34). Routes and
// payloads: ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §6 and §7.
// This is the HUMAN path. A connected agent calls the same routes with its
// session header through the clawville_arena_withdraw* tools.
// Every limit number (minimum, daily caps, cooldown, address delay, SOL keep,
// recommended SOL) comes from the `limits` object of GET /me/withdrawals, and
// every text has a version without numbers for when `limits` is not loaded.

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const BASE = '/api/floor/arena';
/** The panel shows the last 10 rows; the route sends at most 50. */
const HISTORY_LIMIT = 10;
/** Poll fast while a withdrawal is open, so its state changes show soon. */
const POLL_OPEN_MS = 10_000;
const POLL_IDLE_MS = 60_000;

export const floorArenaWithdrawKeys = {
  all: ['floor-arena', 'withdrawals'] as const,
};

// ---------------------------------------------------------------------------
// View types (contract §6 "Views"). Each reader drops a value it cannot read.
// ---------------------------------------------------------------------------

export type ArenaWithdrawAsset = 'USDC' | 'SOL';
export const ARENA_WITHDRAW_ASSETS: readonly ArenaWithdrawAsset[] = ['USDC', 'SOL'];

export const ARENA_WITHDRAW_STATES = [
  'requested',
  'dispatching',
  'sent',
  'confirmed',
  'cancelled',
  'refused',
  'failed',
  'unknown',
  'failed_no_send',
  'needs_review',
] as const;
export type ArenaWithdrawState = (typeof ARENA_WITHDRAW_STATES)[number];
/** At most one row per agent is in these states; the route refuses a new request while one exists. */
const OPEN_STATES: ReadonlySet<string> = new Set(['requested', 'dispatching', 'sent', 'unknown']);

export interface ArenaWithdrawAddressView {
  id: string;
  address: string;
  proof: 'signed' | 'linked_wallet' | null;
  setBy: 'human' | 'agent' | null;
  createdAt: string | null;
  activeAt: string | null;
  /** Anything but 'active' reads as 'pending', so the form never opens on an unclear state. */
  state: 'pending' | 'active';
}

export interface ArenaWithdrawalView {
  id: string;
  asset: ArenaWithdrawAsset;
  amountMode: 'exact' | 'max';
  /** Decimal string from the route; null for a `max` row before it is sent. */
  amount: string | null;
  destination: string | null;
  /** null for a state this client does not know. */
  state: ArenaWithdrawState | null;
  errorCode: string | null;
  txSignature: string | null;
  subjectKind: 'human' | 'agent';
  requestedAt: string | null;
  dispatchedAt: string | null;
  finalizedAt: string | null;
}

export interface ArenaLinkedWalletView {
  address: string;
  linkedAt: string | null;
  /** True when the account linked it more than 24 hours ago, so it works at once. */
  activeNow: boolean;
}

/** The fields of the route's `limits` object (FLOOR_ARENA_WITHDRAW_LIMITS) that the UI reads. */
export interface ArenaWithdrawLimits {
  minUsdcAtomic: number;
  minSolLamports: number;
  agentDailyRequests: number;
  agentDailyUsdcAtomic: number;
  cooldownMs: number;
  addressDelayMs: number;
  solKeepLamports: number;
  recommendedSolText: string;
}

export interface ArenaWithdrawWalletView {
  address: string | null;
  usdc: number | null;
  sol: number | null;
  updatedAt: string | null;
}

export interface ArenaWithdrawStateView {
  agentId: string | null;
  address: ArenaWithdrawAddressView | null;
  linkedWallet: ArenaLinkedWalletView | null;
  withdrawals: ArenaWithdrawalView[];
  limits: ArenaWithdrawLimits | null;
  wallet: ArenaWithdrawWalletView | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const parsed = read(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function readAsset(value: unknown): ArenaWithdrawAsset | null {
  return value === 'USDC' || value === 'SOL' ? value : null;
}

function readAddress(value: unknown): ArenaWithdrawAddressView | null {
  const row = record(value);
  const id = str(row?.id);
  const address = str(row?.address);
  if (!row || !id || !address) return null;
  return {
    id,
    address,
    proof: row.proof === 'signed' || row.proof === 'linked_wallet' ? row.proof : null,
    setBy: row.setBy === 'human' || row.setBy === 'agent' ? row.setBy : null,
    createdAt: str(row.createdAt),
    activeAt: str(row.activeAt),
    state: row.state === 'active' ? 'active' : 'pending',
  };
}

function readWithdrawal(value: unknown): ArenaWithdrawalView | null {
  const row = record(value);
  const id = str(row?.id);
  const asset = readAsset(row?.asset);
  if (!row || !id || !asset) return null;
  return {
    id,
    asset,
    amountMode: row.amountMode === 'max' ? 'max' : 'exact',
    amount: str(row.amount),
    destination: str(row.destination),
    state: (ARENA_WITHDRAW_STATES as readonly string[]).includes(row.state as string) ? (row.state as ArenaWithdrawState) : null,
    errorCode: str(row.errorCode),
    txSignature: str(row.txSignature),
    subjectKind: row.subjectKind === 'agent' ? 'agent' : 'human',
    requestedAt: str(row.requestedAt),
    dispatchedAt: str(row.dispatchedAt),
    finalizedAt: str(row.finalizedAt),
  };
}

function readLinkedWallet(value: unknown): ArenaLinkedWalletView | null {
  const row = record(value);
  const address = str(row?.address);
  if (!row || !address) return null;
  return { address, linkedAt: str(row.linkedAt), activeNow: row.activeNow === true };
}

const LIMIT_NUMBER_FIELDS = [
  'minUsdcAtomic',
  'minSolLamports',
  'agentDailyRequests',
  'agentDailyUsdcAtomic',
  'cooldownMs',
  'addressDelayMs',
  'solKeepLamports',
] as const;

/** All fields or nothing: a half-read limits object would put a wrong number in the copy. */
function readLimits(value: unknown): ArenaWithdrawLimits | null {
  const row = record(value);
  const recommendedSolText = str(row?.recommendedSolText);
  if (!row || !recommendedSolText) return null;
  const numbers: Partial<Record<(typeof LIMIT_NUMBER_FIELDS)[number], number>> = {};
  for (const field of LIMIT_NUMBER_FIELDS) {
    const raw = row[field];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return null;
    numbers[field] = raw;
  }
  return { ...(numbers as Omit<ArenaWithdrawLimits, 'recommendedSolText'>), recommendedSolText };
}

function readWallet(value: unknown): ArenaWithdrawWalletView | null {
  const row = record(value);
  if (!row) return null;
  return { address: str(row.address), usdc: num(row.usdc), sol: num(row.sol), updatedAt: str(row.updatedAt) };
}

/** GET /me/withdrawals. A body of another shape reads as "no address, no rows, no limits". */
export function readWithdrawState(body: Record<string, unknown>): ArenaWithdrawStateView {
  return {
    agentId: str(body.agentId),
    address: readAddress(body.address),
    linkedWallet: readLinkedWallet(body.linkedWallet),
    withdrawals: list(body.withdrawals, readWithdrawal),
    limits: readLimits(body.limits),
    wallet: readWallet(body.wallet),
  };
}

/** The open withdrawal, if any (requested, dispatching, sent or unknown). */
export function arenaOpenWithdrawal(state: Pick<ArenaWithdrawStateView, 'withdrawals'>): ArenaWithdrawalView | null {
  return state.withdrawals.find((row) => row.state !== null && OPEN_STATES.has(row.state)) ?? null;
}

// ---------------------------------------------------------------------------
// Number and text helpers
// ---------------------------------------------------------------------------

/** Chain facts of the two assets, not policy limits. */
const ASSET_DECIMALS: Record<ArenaWithdrawAsset, number> = { USDC: 6, SOL: 9 };

/**
 * Atomic units to a decimal string, with no rounding: 100000 USDC -> "0.10",
 * 500000000 USDC -> "500", 900000 SOL -> "0.0009". A USDC amount with a
 * fraction shows at least two decimals, like a price.
 */
export function formatArenaAtomic(amount: number, asset: ArenaWithdrawAsset): string {
  if (!Number.isSafeInteger(amount)) return 'n/a';
  const decimals = ASSET_DECIMALS[asset];
  const digits = String(Math.abs(amount)).padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  let fraction = digits.slice(-decimals).replace(/0+$/, '');
  if (asset === 'USDC' && fraction.length === 1) fraction += '0';
  return `${amount < 0 ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** "24 hours" for the address delay; minutes when it is shorter than one hour. */
export function arenaWithdrawDelayText(limits: ArenaWithdrawLimits | null): string | null {
  if (!limits) return null;
  if (limits.addressDelayMs < 3_600_000) return minutesText(limits.addressDelayMs);
  const hours = Math.round(limits.addressDelayMs / 3_600_000);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** Local date and time for an ISO stamp; the stamp itself when it does not parse. */
export function arenaWithdrawLocalTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
}

/** The minimum, with the numbers from `limits`. */
export function arenaWithdrawMinimumCopy(limits: ArenaWithdrawLimits | null): string {
  return limits
    ? `The minimum is ${formatArenaAtomic(limits.minUsdcAtomic, 'USDC')} USDC or ${formatArenaAtomic(limits.minSolLamports, 'SOL')} SOL.`
    : 'The amount is less than the minimum.';
}

/** Copy for one route or row code; null when this file has no copy for it. */
export function arenaWithdrawCodeCopy(
  code: string,
  limits: ArenaWithdrawLimits | null,
  extras: { activeAt?: string | null } = {},
): string | null {
  switch (code) {
    case 'needs_sol':
      return limits
        ? `The wallet needs more SOL for the network fee. Send at least ${limits.recommendedSolText} SOL to it, then try again.`
        : 'The wallet needs more SOL for the network fee. Send SOL to it, then try again.';
    case 'insufficient_balance':
      return 'The wallet does not hold that much.';
    case 'below_minimum':
      return arenaWithdrawMinimumCopy(limits);
    case 'address_pending': {
      const time = arenaWithdrawLocalTime(extras.activeAt ?? null);
      return time ? `Your new address works from ${time}.` : 'Your new address does not work yet.';
    }
    case 'withdrawal_open':
      return 'One withdrawal is in progress. Wait until it ends.';
    case 'cooldown':
      return limits ? `Wait ${minutesText(limits.cooldownMs)} between withdrawals.` : 'Wait some minutes between withdrawals.';
    case 'daily_count_cap':
      return limits
        ? `You can withdraw ${limits.agentDailyRequests} times a day. Try again after 00:00 UTC.`
        : 'You used all withdrawals for today. Try again after midnight UTC.';
    case 'agent_daily_cap':
      return limits
        ? `You can withdraw at most ${formatArenaAtomic(limits.agentDailyUsdcAtomic, 'USDC')} USDC a day.`
        : 'This is more USDC than the daily limit lets you withdraw.';
    case 'no_withdraw_address':
      return 'Add a withdraw address first.';
    case 'invalid_signature':
      return 'The wallet signature did not match. Try again.';
    case 'invalid_challenge':
      return 'The sign request expired. Try again.';
    case 'idempotency_conflict':
      return 'This request changed. Press Withdraw again.';
    case 'address_not_allowed':
      return 'You cannot use this address.';
    case 'same_address':
      return 'This address is already set.';
    // Codes below are not in the contract copy list; same ASD-STE100 rules.
    case 'invalid_amount':
      return 'Type a correct amount: at most 6 decimals for USDC and 9 for SOL, and more than 0.';
    case 'invalid_address':
      return 'This is not a correct Solana address.';
    case 'wallet_not_ready':
      return 'Your trader wallet is not ready yet.';
    case 'no_linked_wallet':
      return 'Your account has no linked wallet.';
    case 'too_many_challenges':
      return 'Too many sign requests. Wait some minutes, then try again.';
    case 'address_not_found':
    case 'already_revoked':
      return 'This address was already removed.';
    case 'withdrawal_not_found':
      return 'This withdrawal was not found.';
    case 'not_cancellable':
      return 'This withdrawal started, so you cannot cancel it now.';
    case 'address_revoked':
      return 'The withdraw address changed or was removed before the send.';
    case 'agent_changed':
    case 'source_mismatch':
      return 'The trader wallet changed before the send.';
    default:
      return null;
  }
}

/** Plain-words copy for a refused withdraw route. Falls back to the arena copy. */
export function arenaWithdrawErrorCopy(error: unknown, limits: ArenaWithdrawLimits | null = null): string {
  const code = floorArenaErrorCode(error);
  if (code) {
    const extras = error instanceof ArenaWithdrawApiError ? { activeAt: error.activeAt } : {};
    const copy = arenaWithdrawCodeCopy(code, limits, extras);
    if (copy) return copy;
  }
  return floorArenaErrorCopy(error);
}

/** The words for a row state; a refused row adds the reason. */
export function arenaWithdrawStateCopy(row: Pick<ArenaWithdrawalView, 'state' | 'errorCode'>, limits: ArenaWithdrawLimits | null): string {
  switch (row.state) {
    case 'requested':
      return 'Waiting to send';
    case 'dispatching':
      return 'Sending';
    case 'sent':
      return 'Sent. Waiting for the chain.';
    case 'confirmed':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'refused': {
      const reason = row.errorCode ? arenaWithdrawCodeCopy(row.errorCode, limits) : null;
      return `Not sent: ${reason ?? 'the request was refused.'}`;
    }
    case 'failed':
    case 'failed_no_send':
      return 'Not sent';
    case 'unknown':
      return 'Checking the chain';
    case 'needs_review':
      return 'An operator checks this withdrawal';
    default:
      return 'Status not known';
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * A refused withdraw route. It is a FloorArenaApiError (branch on `code` and
 * `status`) and also carries the times some refusals send.
 */
export class ArenaWithdrawApiError extends FloorArenaApiError {
  /** `address_pending`: when the new address starts to work. */
  readonly activeAt: string | null;
  /** `cooldown` and `daily_count_cap`: when a new request can pass. */
  readonly retryAt: string | null;

  constructor(
    message: string,
    status: number,
    code: unknown,
    errors: string[],
    extras: { activeAt: string | null; retryAt: string | null; withdrawalId: string | null },
  ) {
    super(message, status, code, errors);
    this.name = 'ArenaWithdrawApiError';
    this.activeAt = extras.activeAt;
    this.retryAt = extras.retryAt;
    if (extras.withdrawalId) this.withdrawalId = extras.withdrawalId;
  }
}

async function withdrawRequest(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`${API_URL}${BASE}${path}`, {
    method,
    credentials: 'include',
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const parsed = record(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.message === 'string'
        ? parsed.message
        : `Request failed: ${response.status}`;
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((line): line is string => typeof line === 'string')
      : [];
    throw new ArenaWithdrawApiError(message, response.status, parsed.code, errors, {
      activeAt: str(parsed.activeAt),
      retryAt: str(parsed.retryAt),
      withdrawalId: str(parsed.withdrawalId),
    });
  }
  return parsed;
}

/** A 4xx answer is a refusal: asking again gives the same answer. */
function retryReads(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * The owner's withdraw address, linked wallet, last 10 withdrawals, limits
 * and wallet balance. Polls every 10 s while a withdrawal is open, else 60 s.
 */
export function useFloorArenaWithdrawals(enabled: boolean) {
  return useQuery({
    queryKey: floorArenaWithdrawKeys.all,
    queryFn: async () => readWithdrawState(await withdrawRequest('GET', `/me/withdrawals?limit=${HISTORY_LIMIT}`)),
    enabled,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data && arenaOpenWithdrawal(query.state.data) ? POLL_OPEN_MS : POLL_IDLE_MS,
    refetchIntervalInBackground: false,
    retry: retryReads,
  });
}

// ---------------------------------------------------------------------------
// Mutations. Each one re-reads the withdraw state and GET /me when it ends,
// also after a refusal, because a refusal can mean the state changed.
// Mutations never retry: a withdraw retry is a new press with the same key.
// ---------------------------------------------------------------------------

function useWithdrawMutation<TInput, TResult>(write: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    retry: false,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: floorArenaWithdrawKeys.all });
      void client.invalidateQueries({ queryKey: floorArenaKeys.me });
    },
  });
}

export interface ArenaWithdrawChallenge {
  nonce: string;
  messageToSign: string;
  expiresAt: string | null;
  address: string;
}

/** POST /me/withdraw-address/challenge: the text the DESTINATION key must sign. */
export function useArenaWithdrawChallenge() {
  return useWithdrawMutation(async (input: { address: string }): Promise<ArenaWithdrawChallenge> => {
    const body = await withdrawRequest('POST', '/me/withdraw-address/challenge', { body: { address: input.address } });
    const nonce = str(body.nonce);
    const messageToSign = str(body.messageToSign);
    if (!nonce || !messageToSign) {
      throw new ArenaWithdrawApiError('The sign request could not be read.', 502, 'challenge_unreadable', [], {
        activeAt: null,
        retryAt: null,
        withdrawalId: null,
      });
    }
    return { nonce, messageToSign, expiresAt: str(body.expiresAt), address: str(body.address) ?? input.address };
  });
}

export type ArenaWithdrawAddressInput =
  | { proof: 'signed'; address: string; nonce: string; signature: string }
  | { proof: 'linked_wallet' };

/** POST /me/withdraw-address: set a signed address or the linked wallet. A new address replaces the old one. */
export function useSetArenaWithdrawAddress() {
  return useWithdrawMutation(async (input: ArenaWithdrawAddressInput): Promise<ArenaWithdrawAddressView | null> => {
    const body = await withdrawRequest('POST', '/me/withdraw-address', {
      body:
        input.proof === 'signed'
          ? { proof: 'signed', address: input.address, nonce: input.nonce, signature: input.signature }
          : { proof: 'linked_wallet' },
    });
    return readAddress(body.address);
  });
}

/** POST /me/withdraw-address/revoke: remove the address at once. */
export function useRevokeArenaWithdrawAddress() {
  return useWithdrawMutation((input: { addressId: string }) =>
    withdrawRequest('POST', '/me/withdraw-address/revoke', { body: { addressId: input.addressId } }),
  );
}

export interface ArenaWithdrawRequestInput {
  asset: ArenaWithdrawAsset;
  /** A decimal string ("1.5") or "max". */
  amount: string;
  /** Made once per submit attempt and kept for a retry of the same values. */
  idempotencyKey: string;
}

/** POST /me/withdrawals with the Idempotency-Key header. 202 = new request; 200 + replay = the same request again. */
export function useRequestArenaWithdrawal() {
  return useWithdrawMutation(
    async (input: ArenaWithdrawRequestInput): Promise<{ withdrawal: ArenaWithdrawalView | null; replay: boolean }> => {
      const body = await withdrawRequest('POST', '/me/withdrawals', {
        body: { asset: input.asset, amount: input.amount },
        idempotencyKey: input.idempotencyKey,
      });
      return { withdrawal: readWithdrawal(body.withdrawal), replay: body.replay === true };
    },
  );
}

/** POST /me/withdrawals/:id/cancel: only a row that is still `requested`. */
export function useCancelArenaWithdrawal() {
  return useWithdrawMutation(async (input: { withdrawalId: string }) => {
    const body = await withdrawRequest('POST', `/me/withdrawals/${encodeURIComponent(input.withdrawalId)}/cancel`);
    return readWithdrawal(body.withdrawal);
  });
}

/** A new Idempotency-Key. Falls back to getRandomValues where randomUUID needs a secure context. */
export function newArenaWithdrawKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
