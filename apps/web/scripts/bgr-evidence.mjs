// bgr-evidence.mjs — buildings-gated-reveal ship-evidence validator
// (spec D5 [R2-NF7]). Machine-enforced: a probe report is valid BGR ship
// evidence ONLY when the overlay dismissed via the composite predicate, in
// 'glb' mode, with the buildings presented BEFORE the dismissal, and all
// three gated milestones stamped by the SAME renderer generation. A
// fuse/fallback dismissal is fine as product fail-open but NEVER as a ship
// number. Frozen gate evaluators (--slice-d / --slice-e) are untouched —
// this is a separate, additive verdict; `validForPerformance` semantics are
// NOT redefined.

/**
 * @param {Record<string, unknown> | null | undefined} phases
 *   The probe's `__W3D_PHASES` capture (the END-of-run capture, which
 *   includes the dismissal stamps; the windowed snapshot may predate them).
 * @returns {{ valid: boolean, reasons: string[] }}
 */
export function computeBgrEvidence(phases) {
  const reasons = [];
  if (!phases || typeof phases !== 'object') {
    return { valid: false, reasons: ['no __W3D_PHASES capture'] };
  }
  const p = phases;

  if (p.bootBuildingsMode !== 'glb') {
    reasons.push(
      `buildings mode is ${JSON.stringify(p.bootBuildingsMode ?? null)} (need 'glb')`,
    );
  }
  if (p.loadingDismissReason !== 'composite') {
    reasons.push(
      `dismiss reason is ${JSON.stringify(p.loadingDismissReason ?? null)} (need 'composite')`,
    );
  }
  // FAIL-CLOSED [impl-B8]: only a real finite number is a stamp — an
  // absent/null value never launders (Number(null) is 0, which is finite).
  const stampOf = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const presentedAt = stampOf(p.bootBuildingsPresentedAt);
  const dismissedAt = stampOf(p.loadingDismissedAt);
  if (presentedAt === null) {
    reasons.push('bootBuildingsPresentedAt missing');
  }
  if (dismissedAt === null) {
    reasons.push('loadingDismissedAt missing');
  }
  if (presentedAt !== null && dismissedAt !== null && presentedAt > dismissedAt) {
    reasons.push(
      `bootBuildingsPresentedAt (${presentedAt}) > loadingDismissedAt (${dismissedAt})`,
    );
  }
  // Generation provenance: all three gated stamps must be PRESENT and from
  // ONE renderer. The current code stamps a generation beside every gated
  // milestone, so absence is evidence of a malformed/legacy report — it
  // REJECTS, never defaults [impl-B8].
  const coreGen = stampOf(p.bootCorePresentedGen);
  const buildingsGen = stampOf(p.bootBuildingsPresentedGen);
  const dismissGen = stampOf(p.loadingDismissGen);
  if (coreGen === null || buildingsGen === null || dismissGen === null) {
    reasons.push(
      `generation stamp(s) missing: core=${coreGen} buildings=${buildingsGen} dismiss=${dismissGen}`,
    );
  } else if (coreGen !== buildingsGen || buildingsGen !== dismissGen) {
    reasons.push(
      `renderer generations differ: core=${coreGen} buildings=${buildingsGen} dismiss=${dismissGen}`,
    );
  }
  return { valid: reasons.length === 0, reasons };
}
