'use client';

/**
 * The open Studios requests of this tab, outside the life of the wallet modal
 * (Codex review 2026-11-06: a request key kept only in component state was
 * lost when the human closed the modal after a 202, so the same input sent
 * again got a new key and the server could charge twice).
 *
 * One slot per avatar and operation: the open request (input fingerprint,
 * request key, request id after a 202). The server is the authority on
 * repeats (409 with the first request id), so nothing here blocks an input.
 * Backed by `sessionStorage`, so a
 * reload in the same tab restores it; every storage read and write is wrapped
 * in try/catch, and the store still works in memory when storage throws.
 * A slot's open request is cleared only when the request ends.
 */

import { create } from 'zustand';
import type { StudiosOperation, StudiosPendingRequest } from './studios-card';

export const STUDIOS_REQUESTS_STORAGE_KEY = 'clawville.studios.requests.v1';

export interface StudiosRequestSlot {
  pending: StudiosPendingRequest | null;
}

type Slots = Record<string, StudiosRequestSlot>;

const OPERATIONS = new Set(['image', 'video', 'character_shots', 'recast']);
const KEY_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY: StudiosRequestSlot = { pending: null };

export function studiosSlotId(avatarId: string, operation: StudiosOperation): string {
  return `${avatarId}:${operation}`;
}

/** Only well-formed open requests come back from storage; anything else (an old blocked input too) is dropped. */
function readSlot(raw: unknown): StudiosRequestSlot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  let pending: StudiosPendingRequest | null = null;
  const p = r.pending as Record<string, unknown> | null | undefined;
  if (
    p && typeof p === 'object'
    && typeof p.operation === 'string' && OPERATIONS.has(p.operation)
    && typeof p.input === 'string' && p.input.length <= 20_000
    && typeof p.key === 'string' && KEY_RE.test(p.key)
    && (p.requestId === null || (typeof p.requestId === 'string' && UUID_RE.test(p.requestId)))
  ) {
    pending = { operation: p.operation as StudiosOperation, input: p.input, key: p.key, requestId: p.requestId as string | null };
  }
  return pending ? { pending } : null;
}

function load(): Slots {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.sessionStorage.getItem(STUDIOS_REQUESTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Slots = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>).slice(0, 64)) {
      const slot = readSlot(value);
      if (slot) out[id] = slot;
    }
    return out;
  } catch {
    return {};
  }
}

function save(slots: Slots): void {
  try {
    if (typeof window === 'undefined') return;
    const kept = Object.fromEntries(Object.entries(slots).filter(([, s]) => s.pending));
    if (Object.keys(kept).length === 0) window.sessionStorage.removeItem(STUDIOS_REQUESTS_STORAGE_KEY);
    else window.sessionStorage.setItem(STUDIOS_REQUESTS_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage is off or full: the slots still live in memory for this page.
  }
}

interface StudiosRequestStore {
  loaded: boolean;
  slots: Slots;
  /** Read sessionStorage once (the first form that mounts). */
  ensureLoaded: () => void;
  update: (slotId: string, patch: Partial<StudiosRequestSlot>) => void;
}

export const useStudiosRequestStore = create<StudiosRequestStore>((set, get) => ({
  loaded: false,
  slots: {},
  ensureLoaded: () => {
    if (get().loaded) return;
    set({ loaded: true, slots: { ...load(), ...get().slots } });
  },
  update: (slotId, patch) => {
    const slots = { ...get().slots, [slotId]: { ...(get().slots[slotId] ?? EMPTY), ...patch } };
    set({ slots });
    save(slots);
  },
}));

export function readStudiosSlot(slots: Slots, slotId: string | null): StudiosRequestSlot {
  return (slotId && slots[slotId]) || EMPTY;
}

/** Test-only: forget the memory copy, so the next mount reads sessionStorage again (a reload). */
export function resetStudiosRequestStoreForTests(): void {
  useStudiosRequestStore.setState({ loaded: false, slots: {} });
}
