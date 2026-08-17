/**
 * land-boot-tracker.ts — slice-D land completion tracker (spec §4b, FROZEN
 * rev 5 [R2-F10][R3-F3][R3-F4]).
 *
 * The land trio (LandShowroom / LandStructures / LandKitPieces) streams
 * post-boot-core WITHOUT per-resource warm attachments — this tracker is the
 * measurement-side contract that closed both round-3 escape hatches:
 *
 *  - HYDRATION GENERATIONS [R3-F3]: every initial AND refresh data request
 *    marks pending at REQUEST START and terminal at completion (each bumps
 *    the revision clock). Settlement is PROHIBITED while any request is in
 *    flight — an empty pre-hydration snapshot can never read as settled.
 *  - FAILURE ACCOUNTING [R3-F4]: data failures and GLB fallback/failure
 *    outcomes are counted separately. Product behavior keeps every fallback;
 *    MEASUREMENT validity requires all three failure counters at zero — a
 *    lighter-than-real land workload is never ship evidence.
 *
 * `landSettledAt` is revision-aware: it re-stamps to the LATEST moment the
 * settle condition (no in-flight requests, every expected slot resolved,
 * ≥1s revision quiet) holds — the probe reads the final value at capture
 * end. Product behavior reads nothing from this module.
 */

const QUIET_MS = 1_000;
const CHECK_MS = 500;

type SlotBook = { expected: number; resolved: Set<string> };

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

function bump(): void {
  lastRevisionAt = nowMs();
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
        [...slotBooks].map(([k, v]) => [k, { expected: v.expected, resolved: v.resolved.size }]),
      ),
    };
    if (settledAtMs !== null) {
      (window as any).__W3D_PHASES.landSettledAt = Math.round(settledAtMs);
    }
  } catch {
    /* telemetry never throws */
  }
}

function conditionsHold(): boolean {
  if (inFlightRequests > 0) return false;
  for (const book of slotBooks.values()) {
    if (book.resolved.size < book.expected) return false;
  }
  return nowMs() - lastRevisionAt >= QUIET_MS;
}

function ensureCheckLoop(): void {
  if (checkTimer !== null || typeof window === 'undefined') return;
  checkTimer = setInterval(() => {
    if (!conditionsHold()) return;
    // The settle MOMENT is when the quiet window after the last revision
    // closed — deterministic, and it only advances when a NEW revision
    // re-opened the window (first smoke bug: stamping `now` on every
    // passing check tick made the stamp read ≈ capture end, always).
    const candidate = lastRevisionAt + QUIET_MS;
    if (settledAtMs === null || candidate > settledAtMs) {
      settledAtMs = candidate;
      stamp();
    }
  }, CHECK_MS);
}

/** Mark a land data request in flight. Call the returned function EXACTLY
 * once with the outcome.
 *
 * Revision-clock rule (second-smoke finding): hydration generations BLOCK
 * settlement while in flight (the `inFlightRequests` guard) but only advance
 * the revision clock BEFORE the first settle. Post-settle steady-state
 * refresh polls (the components' 60s re-checks) whose data is UNCHANGED
 * must not hold the stamp at capture-end forever; a poll that DOES change
 * the workload re-opens the window through the slot/merge reporters, which
 * always bump. */
export function beginLandHydration(): (ok: boolean) => void {
  inFlightRequests += 1;
  if (settledAtMs === null) bump();
  else stamp();
  let done = false;
  return (ok: boolean) => {
    if (done) return;
    done = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
    if (ok) dataOk += 1;
    else dataFailed += 1;
    if (settledAtMs === null || !ok) bump();
    else stamp();
  };
}

/** Declare how many GLB slots a component currently expects (revision-aware:
 * re-declare whenever data changes the slot list). */
export function declareLandSlots(component: string, expected: number): void {
  const book = slotBooks.get(component) ?? { expected: 0, resolved: new Set() };
  if (book.expected !== expected) {
    book.expected = expected;
    slotBooks.set(component, book);
    bump();
  } else {
    slotBooks.set(component, book);
  }
}

/** Report a slot's GLB subtree COMMITTED (from a commit effect, never
 * render-time). */
export function reportLandSlotResolved(component: string, slotKey: string): void {
  const book = slotBooks.get(component) ?? { expected: 0, resolved: new Set() };
  if (!book.resolved.has(slotKey)) {
    book.resolved.add(slotKey);
    slotBooks.set(component, book);
    glbOk += 1;
    bump();
  }
}

/** Report a slot falling back (load rejection → primitive) or failing. */
export function reportLandSlotFallback(component: string, slotKey: string): void {
  const book = slotBooks.get(component) ?? { expected: 0, resolved: new Set() };
  if (!book.resolved.has(slotKey)) {
    book.resolved.add(slotKey); // terminal — counts toward expected
    slotBooks.set(component, book);
    glbFallback += 1;
    bump();
  }
}

export function reportLandGlbFailed(): void {
  glbFailed += 1;
  bump();
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
