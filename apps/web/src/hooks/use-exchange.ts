/**
 * use-exchange.ts — peer Exchange marketplace data layer.
 *
 * Backs the in-world 3D marketplace stand (lib/three/marketplace-stall.tsx —
 * the sidebar "Marketplace" entry was peer SKILL commerce and was removed
 * 2026-07-02; Exchange's only entry point is the 3D stand). Two listing modes:
 *   - NEED  : poster wants something done, escrows reward up-front, released
 *             to claimant on completion confirm.
 *   - OFFER : seller offers something, buyer escrows at order time, released
 *             to seller on buyer confirm. offer_mode ∈ {one_shot, repeatable}.
 *
 * Subscriptions are cut from v1 — the API doesn't ship them either. See
 * packages/database/src/schema/exchange.ts for the full escrow doc.
 *
 * Query / mutation conventions mirror use-cosmetics.ts:
 *   - `['exchange', 'browse', filters]`  — paginated listing feed
 *   - `['exchange', 'my-listings']`      — the caller's catalog
 *   - `['exchange', 'my-orders']`        — the caller's purchases/claims
 *   - `['exchange', 'detail', id]`       — single listing + its orders
 *   - mutations invalidate the relevant subtree + `['avatar']` when CT moves
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { ApiError } from '@/lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

/**
 * Build a typed ApiError from a failed write response so callers can branch on
 * the server's machine-readable `code` (e.g. `guest_not_allowed`) — NEVER on
 * message text. The guest-block body is `{ error, code }`; other refusals may
 * use `message`. Reads either so the surfaced message is always human copy.
 */
function toApiError(res: Response, body: unknown, fallback: string): ApiError {
  const b = (body ?? {}) as { error?: string; message?: string; code?: string };
  return new ApiError(b.error ?? b.message ?? `${fallback}: ${res.status}`, res.status, b.code);
}

/**
 * Backstop guard — a guest slipped past the preemptive UI gate (auth-me not
 * yet resolved) and the server 403'd. The consuming modal shows the sign-up
 * upsell; the hook onError below suppresses the raw toast for this code so a
 * guest NEVER sees the server string.
 */
export function isExchangeGuestBlocked(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'guest_not_allowed';
}

// ─── Types (mirror apps/api/src/routes/exchange.ts response shape) ──────────

export type ExchangeListingType = 'need' | 'offer';
export type ExchangeOfferMode = 'one_shot' | 'repeatable';
export type ExchangeListingStatus = 'open' | 'paused' | 'closed' | 'cancelled';
export type ExchangeOrderState =
  | 'open'
  | 'submitted'
  | 'completed'
  | 'disputed'
  | 'cancelled';

export interface ExchangeListing {
  id: string;
  creatorId: string;
  creatorName: string | null;
  listingType: ExchangeListingType;
  /** Null when listingType='need'; required for offers. */
  offerMode: ExchangeOfferMode | null;
  title: string;
  description: string;
  category: string | null;
  priceCt: number;
  /** null = unlimited (repeatable offers only). 1 for needs and one_shot offers. */
  capacity: number | null;
  status: ExchangeListingStatus;
  tags: string[];
  expiresAt: string | null;
  createdAt: string;
}

export interface ExchangeOrder {
  id: string;
  listingId: string;
  buyerId: string;
  amountCt: number;
  state: ExchangeOrderState;
  deliveryUrl: string | null;
  deliveryNote: string | null;
  reviewNote: string | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface ExchangeListingsResponse {
  listings: ExchangeListing[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ExchangeOrdersResponse {
  orders: Array<ExchangeOrder & { listing: ExchangeListing }>;
}

export interface ExchangeDetailResponse {
  listing: ExchangeListing;
  orders: ExchangeOrder[];
}

// ─── Browse filters ─────────────────────────────────────────────────────────

export interface BrowseFilters {
  type?: ExchangeListingType;
  category?: string;
  page?: number;
  pageSize?: number;
}

async function fetchListings(filters: BrowseFilters): Promise<ExchangeListingsResponse> {
  const qs = new URLSearchParams();
  if (filters.type) qs.set('type', filters.type);
  if (filters.category && filters.category !== 'all') qs.set('category', filters.category);
  if (filters.page) qs.set('page', String(filters.page));
  if (filters.pageSize) qs.set('pageSize', String(filters.pageSize));
  const url = `${API_URL}/api/exchange${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Exchange browse failed: ${res.status}`);
  return (await res.json()) as ExchangeListingsResponse;
}

export function useExchangeListings(filters: BrowseFilters, enabled = true) {
  return useQuery({
    queryKey: ['exchange', 'browse', filters],
    queryFn: () => fetchListings(filters),
    staleTime: 30_000,
    enabled,
  });
}

// ─── My listings ────────────────────────────────────────────────────────────

async function fetchMyListings(): Promise<{ listings: ExchangeListing[] }> {
  const res = await fetch(`${API_URL}/api/exchange/my-listings`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`My listings failed: ${res.status}`);
  return (await res.json()) as { listings: ExchangeListing[] };
}

export function useMyExchangeListings(enabled = true) {
  return useQuery({
    queryKey: ['exchange', 'my-listings'],
    queryFn: fetchMyListings,
    staleTime: 30_000,
    enabled,
  });
}

// ─── My orders ──────────────────────────────────────────────────────────────

async function fetchMyOrders(): Promise<ExchangeOrdersResponse> {
  const res = await fetch(`${API_URL}/api/exchange/my-orders`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`My orders failed: ${res.status}`);
  return (await res.json()) as ExchangeOrdersResponse;
}

export function useMyExchangeOrders(enabled = true) {
  return useQuery({
    queryKey: ['exchange', 'my-orders'],
    queryFn: fetchMyOrders,
    staleTime: 30_000,
    enabled,
  });
}

// ─── Single-listing detail (for inspect / order management) ────────────────

async function fetchDetail(id: string): Promise<ExchangeDetailResponse> {
  const res = await fetch(`${API_URL}/api/exchange/${id}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Listing detail failed: ${res.status}`);
  return (await res.json()) as ExchangeDetailResponse;
}

export function useExchangeListing(id: string | null) {
  return useQuery({
    queryKey: ['exchange', 'detail', id],
    queryFn: () => fetchDetail(id!),
    enabled: !!id,
    staleTime: 15_000,
  });
}

// ─── Create listing ─────────────────────────────────────────────────────────

export interface CreateListingInput {
  listingType: ExchangeListingType;
  /** Required when listingType='offer'. */
  offerMode?: ExchangeOfferMode;
  title: string;
  description: string;
  category?: string;
  priceCt: number;
  capacity?: number;
  tags?: string[];
  expiresAt?: string;
}

async function postCreate(input: CreateListingInput): Promise<{ listing: ExchangeListing }> {
  const res = await fetch(`${API_URL}/api/exchange/create`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw toApiError(res, body, 'Create failed');
  }
  return body as { listing: ExchangeListing };
}

export function useCreateExchangeListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postCreate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchange'] });
      qc.invalidateQueries({ queryKey: ['avatar'] });
      useGameStore.getState().addToast('✦', 'Listing posted to the tide-board.');
    },
    onError: (err: Error) => {
      if (isExchangeGuestBlocked(err)) return; // guest sees the sign-up upsell, not a raw error
      useGameStore.getState().addToast('⚠', err.message || 'Post failed');
    },
  });
}

// ─── Order (claim a need / buy an offer) ────────────────────────────────────

async function postOrder(listingId: string): Promise<{ order: ExchangeOrder; listing: ExchangeListing }> {
  const res = await fetch(`${API_URL}/api/exchange/${listingId}/order`, {
    method: 'POST',
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw toApiError(res, body, 'Order failed');
  }
  return body as { order: ExchangeOrder; listing: ExchangeListing };
}

export function useOrderExchangeListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postOrder,
    onSuccess: (_, listingId) => {
      qc.invalidateQueries({ queryKey: ['exchange'] });
      qc.invalidateQueries({ queryKey: ['avatar'] });
      qc.invalidateQueries({ queryKey: ['exchange', 'detail', listingId] });
      useGameStore.getState().addToast('⛵', 'Order placed.');
    },
    onError: (err: Error) => {
      if (isExchangeGuestBlocked(err)) return; // guest sees the sign-up upsell, not a raw error
      useGameStore.getState().addToast('⚠', err.message || 'Order failed');
    },
  });
}

// ─── Submit deliverable ─────────────────────────────────────────────────────

export interface SubmitInput {
  deliveryUrl?: string;
  deliveryNote?: string;
}

async function postSubmit(orderId: string, input: SubmitInput): Promise<{ order: ExchangeOrder }> {
  const res = await fetch(`${API_URL}/api/exchange/orders/${orderId}/submit`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw toApiError(res, body, 'Submit failed');
  }
  return body as { order: ExchangeOrder };
}

export function useSubmitExchangeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, input }: { orderId: string; input: SubmitInput }) =>
      postSubmit(orderId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchange'] });
      useGameStore.getState().addToast('📦', 'Delivery submitted — awaiting confirm.');
    },
    onError: (err: Error) => {
      if (isExchangeGuestBlocked(err)) return; // guest sees the sign-up upsell, not a raw error
      useGameStore.getState().addToast('⚠', err.message || 'Submit failed');
    },
  });
}

// ─── Confirm (release escrow) ───────────────────────────────────────────────

async function postConfirm(orderId: string, reviewNote?: string): Promise<{ order: ExchangeOrder }> {
  const res = await fetch(`${API_URL}/api/exchange/orders/${orderId}/confirm`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewNote }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw toApiError(res, body, 'Confirm failed');
  }
  return body as { order: ExchangeOrder };
}

export function useConfirmExchangeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, reviewNote }: { orderId: string; reviewNote?: string }) =>
      postConfirm(orderId, reviewNote),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchange'] });
      qc.invalidateQueries({ queryKey: ['avatar'] });
      useGameStore.getState().addToast('✓', 'Escrow released. Trade complete.');
    },
    onError: (err: Error) => {
      if (isExchangeGuestBlocked(err)) return; // guest sees the sign-up upsell, not a raw error
      useGameStore.getState().addToast('⚠', err.message || 'Confirm failed');
    },
  });
}

// ─── Cancel order ───────────────────────────────────────────────────────────

async function postCancelOrder(orderId: string): Promise<{ order: ExchangeOrder }> {
  const res = await fetch(`${API_URL}/api/exchange/orders/${orderId}/cancel`, {
    method: 'POST',
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw toApiError(res, body, 'Cancel failed');
  }
  return body as { order: ExchangeOrder };
}

export function useCancelExchangeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postCancelOrder,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchange'] });
      qc.invalidateQueries({ queryKey: ['avatar'] });
      useGameStore.getState().addToast('↺', 'Order cancelled — escrow refunded.');
    },
    onError: (err: Error) => {
      if (isExchangeGuestBlocked(err)) return; // guest sees the sign-up upsell, not a raw error
      useGameStore.getState().addToast('⚠', err.message || 'Cancel failed');
    },
  });
}

// ─── Cancel listing (author) ────────────────────────────────────────────────

async function postCancelListing(listingId: string): Promise<{ listing: ExchangeListing }> {
  const res = await fetch(`${API_URL}/api/exchange/${listingId}/cancel`, {
    method: 'POST',
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw toApiError(res, body, 'Cancel failed');
  }
  return body as { listing: ExchangeListing };
}

export function useCancelExchangeListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postCancelListing,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchange'] });
      qc.invalidateQueries({ queryKey: ['avatar'] });
      useGameStore.getState().addToast('↺', 'Listing cancelled.');
    },
    onError: (err: Error) => {
      if (isExchangeGuestBlocked(err)) return; // guest sees the sign-up upsell, not a raw error
      useGameStore.getState().addToast('⚠', err.message || 'Cancel failed');
    },
  });
}

// ─── Categories (shared between Browse filter chips + Post form select) ─────

export const EXCHANGE_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'code', label: 'Code' },
  { id: 'art', label: 'Art' },
  { id: 'chat', label: 'Chat' },
  { id: 'data', label: 'Data' },
  { id: 'training', label: 'Training' },
  { id: 'other', label: 'Other' },
] as const;
export type ExchangeCategory = (typeof EXCHANGE_CATEGORIES)[number]['id'];

/**
 * Category → symbolic glyph used in the card chip + post form select.
 * Picked from sea-floor / signage flavour so the type read is fast
 * even when copy is truncated.
 */
export const CATEGORY_GLYPHS: Record<ExchangeCategory, string> = {
  all: '◈',
  code: '⌘',
  art: '✦',
  chat: '◌',
  data: '⌬',
  training: '⌖',
  other: '◇',
};
