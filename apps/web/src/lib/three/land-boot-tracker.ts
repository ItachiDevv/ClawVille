/**
 * land-boot-tracker.ts — slice-D land completion tracker (spec §4b, FROZEN
 * rev 5 [R2-F10][R3-F3][R3-F4], reworked per I1 findings 7–8).
 *
 * The land trio (LandShowroom / LandStructures / LandKitPieces) streams
 * post-boot-core WITHOUT per-resource warm attachments — this tracker is the
 * measurement-side contract:
 *
 *  - HYDRATION GENERATIONS [R3-F3][I1-F7]: EVERY data request (initial and
 *    refresh) bumps the revision clock at REQUEST START and at TERMINAL, and
 *    every bump INVALIDATES the current settlement — the stamp can never
 *    precede refresh work, and the stable interval can never overlap it.
 *    Settlement is additionally prohibited while any request is in flight.
 *  - EXACT SLOT IDENTITY [I1-F7]: each component declares its CURRENT slot
 *    id set (not a count) — replacing N slots with N different slots reads
 *    as unresolved until the new ids resolve. Resolved ids are sticky but
 *    only counted against the CURRENT expected set.
 *  - FAILURE ACCOUNTING [R3-F4][I1-F8]: data failures per request, GLB
 *    fallbacks (a primitive renders), and GLB FAILURES (nothing renders —
 *    the kit-source class) are distinct counters. Product keeps every
 *    fallback; MEASUREMENT validity requires all of them zero.
 *
 * The steady-state consequence — periodic refresh polls re-invalidate the
 * stamp — is handled on the MEASUREMENT side: the probe snapshots
 * `__W3D_PHASES` at the measured-window close (`phasesAtWindow`), so the
 * boot-assembly question is answered from the window snapshot, not from
 * whatever a 60s poll did at capture end [I1-F7].
 */

const QUIET_MS = 1_000;
const CHECK_MS = 500;

type SlotBook = { expected: Set<string>; resolved: Set<string> };

let inFlightRequests = 0;
let dataOk = 0;
let dataFailed = 0;
let glbOk = 0;
let glbFallback = 0;
let glbFailed = 0;
let lastRevisionAt = 0;
let settledAtMs: number | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
const slotBooks = new Map<string, SlotBook>();

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Every workload change: advance the revision clock AND invalidate the
 * current settlement [I1-F7]. */
function bump(): void {
  lastRevisionAt = nowMs();
  settledAtMs = null;
  ensureCheckLoop();
  stamp();
}

function stamp(): void {
  try {
    (window as any).__W3D_PHASES = (window as any).__W3D_PHASES ?? {};
    (window as any).__W3D_PHASES.landTracker = {
      inFlightRequests,
      dataOk,
      dataFailed,
      glbOk,
      glbFallback,
      glbFailed,
      slots: Object.fromEntries(
        [...slotBooks].map(([k, v]) => {
          let resolved = 0;
          for (const id of v.expected) if (v.resolved.has(id)) resolved += 1;
          return [k, { expected: v.expected.size, resolved }];
        }),
      ),
    };
    if (settledAtMs !== null) {
      (window as any).__W3D_PHASES.landSettledAt = Math.round(settledAtMs);
    } else {
      delete (window as any).__W3D_PHASES.landSettledAt;
    }
  } catch {
    /* telemetry never throws */
  }
}

function conditionsHold(): boolean {
  if (inFlightRequests > 0) return false;
  for (const book of slotBooks.values()) {
    for (const id of book.expected) {
      if (!book.resolved.has(id)) return false;
    }
  }
  return nowMs() - lastRevisionAt >= QUIET_MS;
}

function ensureCheckLoop(): void {
  if (checkTimer !== null || typeof window === 'undefined') return;
  checkTimer = setInterval(() => {
    if (settledAtMs !== null || !conditionsHold()) return;
    // The settle MOMENT is the quiet-window close after the last revision —
    // deterministic; a later bump nulls it and the loop re-stamps after the
    // next quiet.
    settledAtMs = lastRevisionAt + QUIET_MS;
    stamp();
  }, CHECK_MS);
}

/** Mark a land data request in flight (one call per REQUEST — a component
 * issuing public + owned fetches begins two generations [I1-F8]). Call the
 * returned function EXACTLY once with the outcome. */
export function beginLandHydration(): (ok: boolean) => void {
  inFlightRequests += 1;
  bump();
  let done = false;
  return (ok: boolean) => {
    if (done) return;
    done = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
    if (ok) dataOk += 1;
    else dataFailed += 1;
    bump();
  };
}

/** Declare the component's CURRENT expected slot id set [I1-F7]. Re-declare
 * whenever data or admission changes the set; identical sets are no-ops. */
export function declareLandSlots(component: string, ids: readonly string[]): void {
  const book = slotBooks.get(component) ?? { expected: new Set(), resolved: new Set() };
  const next = new Set(ids);
  let same = next.size === book.expected.size;
  if (same) {
    for (const id of next) {
      if (!book.expected.has(id)) {
        same = false;
        break;
      }
    }
  }
  if (same) {
    slotBooks.set(component, book);
    return;
  }
  book.expected = next;
  slotBooks.set(component, book);
  bump();
}

/** Report a slot's GLB subtree COMMITTED (from a commit effect, never
 * render-time). */
export function reportLandSlotResolved(component: string, slotKey: string): void {
  const book = slotBooks.get(component) ?? { expected: new Set(), resolved: new Set() };
  if (!book.resolved.has(slotKey)) {
    book.resolved.add(slotKey);
    slotBooks.set(component, book);
    glbOk += 1;
    bump();
  }
}

/** Report a slot falling back (load rejection → a PRIMITIVE renders). */
export function reportLandSlotFallback(component: string, slotKey: string): void {
  const book = slotBooks.get(component) ?? { expected: new Set(), resolved: new Set() };
  if (!book.resolved.has(slotKey)) {
    book.resolved.add(slotKey); // terminal — counts toward expected
    slotBooks.set(component, book);
    glbFallback += 1;
    bump();
  }
}

/** Report a slot FAILING with nothing rendered (the kit-source class
 * [I1-F8]) — a lighter-than-real workload, never valid ship evidence. */
export function reportLandSlotFailed(component: string, slotKey: string): void {
  const book = slotBooks.get(component) ?? { expected: new Set(), resolved: new Set() };
  if (!book.resolved.has(slotKey)) {
    book.resolved.add(slotKey); // terminal
    slotBooks.set(component, book);
    glbFailed += 1;
    bump();
  }
}

/** KitPieces merge-revision bump — any post-load merged-chunk mutation
 * re-opens the quiet window. */
export function bumpLandRevision(): void {
  bump();
}

export function getLandSettledAt(): number | null {
  return settledAtMs;
}

/** TEST-ONLY. */
export function __resetLandBootTrackerForTests(): void {
  inFlightRequests = 0;
  dataOk = 0;
  dataFailed = 0;
  glbOk = 0;
  glbFallback = 0;
  glbFailed = 0;
  lastRevisionAt = 0;
  settledAtMs = null;
  slotBooks.clear();
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
