/**
 * Cold-load telemetry stamps (docs/perf-cold-load-diet-2026-07-31.md M0;
 * extended for the rung-4 slice-A head decomposition,
 * docs/perf-cold-load-rung4-handoff.md §2 Slice A).
 *
 * MUST be impossible to throw: a frozen/sealed/accessor-poisoned global, or a
 * primitive squatting on __W3D_PHASES, must never affect the boot path — some
 * stamps run before readiness publication, so an exception here would strand
 * the reveal. Numbers are rounded; non-object squatters are replaced when
 * writable and silently abandoned when not.
 *
 * The cold-load probe (scripts/cold-load-probe.mjs) captures the WHOLE
 * __W3D_PHASES blob, so new keys ride along without probe changes.
 */
export function stampColdLoadPhase(key: string, value: number | string): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as any;
    let phases = w.__W3D_PHASES;
    if (phases === null || typeof phases !== 'object') {
      phases = {};
      w.__W3D_PHASES = phases;
    }
    phases[key] = typeof value === 'number' ? Math.round(value) : value;
  } catch {
    /* telemetry never throws */
  }
}

/**
 * First-boot-only stamp: writes the key ONCE per page lifetime. Used for
 * events that legitimately re-fire (component re-renders, SPA re-mounts,
 * effect re-runs) where the COLD-BOOT value is the evidence and a later
 * overwrite would silently corrupt the head decomposition.
 */
export function stampColdLoadPhaseOnce(
  key: string,
  value: number | string,
): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as any;
    const phases = w.__W3D_PHASES;
    if (phases !== null && typeof phases === 'object' && key in phases) return;
  } catch {
    return;
  }
  stampColdLoadPhase(key, value);
}
