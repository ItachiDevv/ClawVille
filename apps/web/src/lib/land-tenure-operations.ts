'use client';

/**
 * land-tenure-operations.ts — the ONE registry for land settlement operations
 * that are in flight, and for the idempotency key each one carries.
 *
 * WHY IT IS NOT COMPONENT STATE
 * -----------------------------
 * The same settlement controls are rendered from TWO surfaces of the Land
 * Office: the focused single-parcel panel and the browse / My Land lists. The
 * keys used to live in `useRef` maps beside a `busy` useState inside
 * `AvailableParcelCard` / `OwnedTenureControls`, which survives a re-render but
 * NOT an unmount. Cross-surface navigation unmounts:
 *
 *   1. start a claim / prepay / release from the focused panel;
 *   2. while it is still pending, press "Browse all parcels" (or close and
 *      reopen the modal);
 *   3. the focused control unmounts and the list control mounts with FRESH
 *      refs and `busy = null`, so it reads as idle and accepts a second press;
 *   4. that press sends a SECOND request with a NEW idempotency key while the
 *      first is unresolved — the server sees two distinct operations, which is
 *      the double-charge shape.
 *
 * So both the key and the operation state live HERE, at module scope, keyed by
 * `(acting avatar, parcelCode, semantic operation)`. A component unmount does
 * not touch this map, and every surface reads the same entry through
 * `useLandOperationState` until the outcome is definitive.
 *
 * NOTHING ABOUT THE WIRE CHANGES. The same key value is still passed to the
 * same endpoint with the same body; only the storage location moved.
 *
 * SETTLEMENT STATE AND REFRESH STATE ARE SEPARATE (2026-08-10)
 * -----------------------------------------------------------
 * They used to be one boolean (`pending`), which conflated two very different
 * facts and gave a lost response no way back:
 *
 *   • a control stayed disabled for as long as the POST-settlement refresh
 *     took, with no bounded exit — a hung `refetch` left a permanently
 *     spinning button on a settlement that had already succeeded;
 *   • and nothing distinguished "the money moved, we just cannot see it yet"
 *     from "we do not know whether the money moved".
 *
 * The phases below name that difference, and EVERY exit path of an operation
 * lands on one of them (see `settleLandOperation`):
 *
 *   settling    — the request is on the wire. Outcome unknown. Controls locked.
 *   refreshing  — the settlement is CONFIRMED; the reads that show it have not
 *                 caught up. Controls stay locked (pressing again would mint a
 *                 FRESH key and charge twice), bounded by REFRESH_GRACE_MS.
 *   unrefreshed — confirmed, but the refresh failed or timed out. Controls stay
 *                 locked and the surface shows an explicit "it went through,
 *                 the view did not" notice WITH a retry-the-refresh action,
 *                 instead of an indefinite disabled button.
 *   retryable   — the settlement did NOT confirm (typed API error, network
 *                 rejection, abort). The key is KEPT so a retry collapses into
 *                 the first request server-side, and the control is ENABLED
 *                 again so the retry is actually possible.
 *
 * KEY LIFETIME
 *   • a NEW operation mints a key;
 *   • a RETRY of the same (avatar, parcel, operation) REUSES the key it already
 *     has, so the server can collapse a retried request into the first one;
 *   • a CONFIRMED settlement CONSUMES the key, so the next semantically
 *     distinct action mints a fresh one (a keyless replay double-charges).
 *
 * IDENTITY SCOPE + THE CROSS-TAB LIMIT
 * ------------------------------------
 * Every entry is filed under the acting avatar id, so avatar B never inherits
 * avatar A's locks or retry keys after a logout or an account switch, and
 * entries belonging to another identity are ignored by every read.
 *
 * This registry is per-TAB and deliberately stays that way. Cross-tab
 * coordination (Web Locks / BroadcastChannel) is NOT built here because the
 * SERVER is the authoritative idempotency boundary: every land settlement route
 * requires an idempotency key, records it against the avatar in
 * `land_tenure_settlements`, and flips the parcel status under a row lock, so a
 * genuine duplicate is refused or replayed there. The residual gap is honest
 * and narrow: two BROWSER TABS starting the same action at the same moment mint
 * two DIFFERENT keys, and the server sees two distinct operations.
 *
 * JOIN RULE: entries are keyed by `parcelCode`, never the DB uuid.
 */

import { useMemo, useSyncExternalStore } from 'react';

/**
 * The four settlement doors. The stored operation id is `<door>` or
 * `<door>:<variant>` (the variant is the week count, which is part of what
 * makes an operation semantically distinct), so the door is always the prefix.
 */
export type LandTenureDoor = 'hold' | 'rent' | 'prepay' | 'release';

const DOORS: readonly LandTenureDoor[] = ['hold', 'rent', 'prepay', 'release'];

/** See the phase table in the file header. */
export type LandOperationPhase =
  | 'settling'
  | 'refreshing'
  | 'unrefreshed'
  | 'retryable';

/** How an attempt ended. Every call site must reach exactly one of these. */
export type LandOperationOutcome =
  /** The SETTLEMENT succeeded. Key consumed; now waiting on the refresh. */
  | 'confirmed'
  /** The settlement did NOT confirm. Key kept; the control is usable again. */
  | 'retryable'
  /** The post-settlement refresh landed. The operation is finished. */
  | 'refreshed'
  /** The refresh threw. Explicit unresolved UI; the spend stays locked. */
  | 'refresh_failed';

interface OperationEntry {
  readonly subject: string;
  readonly parcelCode: string;
  readonly operation: string;
  /** The idempotency key sent for this (avatar, parcel, operation). */
  readonly key: string;
  /**
   * The settlement this key belongs to is CONFIRMED, so the key must never be
   * reused for a new attempt. Any further attempt mints a fresh key, which is
   * exactly why a confirmed operation keeps its controls locked.
   */
  readonly keyConsumed: boolean;
  readonly phase: LandOperationPhase;
}

/**
 * How long a CONFIRMED settlement may sit in `refreshing` before the surface
 * stops showing a spinner and says plainly that the action went through but the
 * view did not update. Generous on purpose: the refresh chain is several reads
 * and this is a last-resort bound, not a request timeout.
 */
const REFRESH_GRACE_MS = 12_000;

/**
 * Soft bound on the map.
 *
 * ONLY key-consumed entries (`refreshing` / `unrefreshed`) are ever pruned. A
 * `retryable` entry is AMBIGUOUS — the request may well have completed
 * server-side with its response lost — so evicting it would let a later retry
 * mint a FRESH key, and if the original did land that is a second charge.
 * `land_tenure_settlements` rows have no expiry, so the server's idempotency
 * horizon outlives any page session and there is no safe client-side age at
 * which an ambiguous key stops mattering.
 *
 * Growth is bounded in practice anyway: the map is keyed by (avatar, one of 56
 * rendered parcels, one semantic operation), and only FAILED attempts are
 * retained.
 */
const MAX_TRACKED_OPERATIONS = 256;

const entries = new Map<string, OperationEntry>();
const listeners = new Set<() => void>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A NUL cannot appear in an avatar id, a parcelCode or an operation, so the
 * composed id is unambiguous. Written as the ESCAPE `\u0000`, never as a raw
 * byte: a literal NUL in source is mangled by diffs, editors and terminals
 * (git even reports the file as binary).
 */
const ID_SEPARATOR = '\u0000';

function entryId(subject: string, parcelCode: string, operation: string): string {
  return `${subject}${ID_SEPARATOR}${parcelCode}${ID_SEPARATOR}${operation}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearRefreshTimer(id: string): void {
  const timer = refreshTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    refreshTimers.delete(id);
  }
}

/**
 * Drop CONSUMED entries (their key can never be reused, so losing them cannot
 * cause a double charge), oldest first, until the map is back inside its bound.
 * An ambiguous `retryable` entry and a live `settling` entry are never touched;
 * if the map is entirely made of those, it is simply left over the bound.
 */
function pruneConsumed(): void {
  if (entries.size <= MAX_TRACKED_OPERATIONS) return;
  for (const [id, entry] of entries) {
    if (entries.size <= MAX_TRACKED_OPERATIONS) return;
    if (entry.keyConsumed) {
      clearRefreshTimer(id);
      entries.delete(id);
    }
  }
}

/** Forget every entry that does not belong to the acting identity. */
function dropForeignSubjects(subject: string): void {
  for (const [id, entry] of entries) {
    if (entry.subject !== subject) {
      clearRefreshTimer(id);
      entries.delete(id);
    }
  }
}

/**
 * Claim the (avatar, parcel, operation) slot and return the idempotency key to
 * send. Reuses the existing key when this exact operation has already been
 * attempted AND that attempt did not confirm; a confirmed attempt has consumed
 * its key, so a genuinely new action after it mints a fresh one.
 */
export function beginLandOperation(
  subject: string,
  parcelCode: string,
  operation: string,
): string {
  dropForeignSubjects(subject);
  const id = entryId(subject, parcelCode, operation);
  clearRefreshTimer(id);
  const existing = entries.get(id);
  const key = existing && !existing.keyConsumed ? existing.key : crypto.randomUUID();
  entries.set(id, {
    subject,
    parcelCode,
    operation,
    key,
    keyConsumed: false,
    phase: 'settling',
  });
  pruneConsumed();
  emit();
  return key;
}

/**
 * Move the slot to the state its outcome implies. See `LandOperationOutcome`.
 *
 * Safe to call for an id that is not tracked (a no-op), so a `finally` can call
 * it unconditionally.
 */
export function settleLandOperation(
  subject: string,
  parcelCode: string,
  operation: string,
  outcome: LandOperationOutcome,
): void {
  const id = entryId(subject, parcelCode, operation);
  const existing = entries.get(id);
  if (!existing) return;
  clearRefreshTimer(id);

  if (outcome === 'refreshed') {
    entries.delete(id);
    emit();
    return;
  }

  if (outcome === 'retryable') {
    // The settlement did NOT confirm. Keep the key so a retry collapses into
    // the first request, and unlock the control so the retry can happen.
    entries.set(id, { ...existing, phase: 'retryable' });
    emit();
    return;
  }

  if (outcome === 'refresh_failed') {
    entries.set(id, { ...existing, keyConsumed: true, phase: 'unrefreshed' });
    pruneConsumed();
    emit();
    return;
  }

  // 'confirmed' — bounded wait for the reads to catch up.
  entries.set(id, { ...existing, keyConsumed: true, phase: 'refreshing' });
  const timer = setTimeout(() => {
    refreshTimers.delete(id);
    const current = entries.get(id);
    if (!current || current.phase !== 'refreshing') return;
    entries.set(id, { ...current, phase: 'unrefreshed' });
    emit();
  }, REFRESH_GRACE_MS);
  refreshTimers.set(id, timer);
  pruneConsumed();
  emit();
}

/** The door an operation id belongs to (`rent:3` → `rent`), or null. */
export function landOperationDoor(operation: string | null): LandTenureDoor | null {
  if (operation === null) return null;
  const head = operation.split(':', 1)[0];
  return DOORS.find((door) => door === head) ?? null;
}

/**
 * Phases that BLOCK every settlement control on the parcel. `retryable` is
 * absent on purpose: that is the whole point of separating the two states.
 */
const BLOCKING_PHASE_RANK: Record<LandOperationPhase, number> = {
  settling: 0,
  refreshing: 1,
  unrefreshed: 2,
  retryable: Number.POSITIVE_INFINITY,
};

/** The state one parcel's settlement controls read. */
export interface LandOperationState {
  /** The blocking operation id (`rent:3`), or null when nothing blocks. */
  readonly operation: string | null;
  /** That operation's door, or null. */
  readonly door: LandTenureDoor | null;
  /** That operation's phase, or null. */
  readonly phase: LandOperationPhase | null;
  /** True while any settlement on this parcel is unresolved or unreflected. */
  readonly blocked: boolean;
}

const IDLE_STATE: LandOperationState = Object.freeze({
  operation: null,
  door: null,
  phase: null,
  blocked: false,
});

/**
 * A STRING snapshot, so `useSyncExternalStore` compares by value. Returning a
 * fresh object from `getSnapshot` would re-render forever.
 */
function blockingSnapshot(subject: string | null, parcelCode: string): string | null {
  if (!subject) return null;
  let best: OperationEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.subject !== subject || entry.parcelCode !== parcelCode) continue;
    if (entry.phase === 'retryable') continue;
    if (
      best === null
      || BLOCKING_PHASE_RANK[entry.phase] < BLOCKING_PHASE_RANK[best.phase]
    ) {
      best = entry;
    }
  }
  return best ? `${best.operation}${ID_SEPARATOR}${best.phase}` : null;
}

/**
 * The operation currently blocking one parcel, shared across every surface that
 * renders its controls. A control that remounts on the OTHER surface reads the
 * same answer, so a pending operation still reads as busy after the remount and
 * cannot be submitted twice.
 *
 * `subject` is the acting avatar id. Passing null (identity not resolved) never
 * matches an entry, which is correct: without an identity nothing may be spent
 * anyway.
 */
export function useLandOperationState(
  subject: string | null,
  parcelCode: string,
): LandOperationState {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => blockingSnapshot(subject, parcelCode),
    () => null,
  );
  return useMemo(() => {
    if (snapshot === null) return IDLE_STATE;
    const separator = snapshot.lastIndexOf(ID_SEPARATOR);
    const operation = snapshot.slice(0, separator);
    const phase = snapshot.slice(separator + 1) as LandOperationPhase;
    return {
      operation,
      door: landOperationDoor(operation),
      phase,
      blocked: true,
    };
  }, [snapshot]);
}

/** Test/diagnostic escape hatch. Never call this from a render path. */
export function resetLandOperationsForTest(): void {
  for (const id of refreshTimers.keys()) clearRefreshTimer(id);
  entries.clear();
  emit();
}
