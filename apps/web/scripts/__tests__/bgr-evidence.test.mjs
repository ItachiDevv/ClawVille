// bgr-evidence.test.mjs — the machine-enforced BGR ship-evidence validator
// (spec D5 [R2-NF7]): every condition individually rejects, and only the
// full composite-dismissal shape passes.
import { describe, expect, test } from 'bun:test';
import { computeBgrEvidence } from '../bgr-evidence.mjs';

const VALID_PHASES = {
  bootBuildingsMode: 'glb',
  loadingDismissReason: 'composite',
  bootBuildingsPresentedAt: 6100,
  loadingDismissedAt: 6150,
  bootCorePresentedGen: 1,
  bootBuildingsPresentedGen: 1,
  loadingDismissGen: 1,
  // Guide amendment A1 shape [nori-NF3]:
  bootGuideRevealRequired: 1,
  bootRevealPresentedRequired: 12,
  bootRevealPresentedFailed: 0,
};

describe('computeBgrEvidence', () => {
  test('accepts the full composite-dismissal shape', () => {
    const v = computeBgrEvidence(VALID_PHASES);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  test('FAIL-CLOSED [impl-B8]: missing generation stamps reject (never default)', () => {
    const { bootCorePresentedGen, ...rest } = VALID_PHASES;
    const v = computeBgrEvidence(rest);
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toContain('generation stamp(s) missing');
  });

  test('FAIL-CLOSED [impl-B8]: explicit-null timestamps reject (Number(null) is 0)', () => {
    const v = computeBgrEvidence({ ...VALID_PHASES, loadingDismissedAt: null });
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toContain('loadingDismissedAt missing');
  });

  test('rejects a missing phases capture', () => {
    expect(computeBgrEvidence(null).valid).toBe(false);
    expect(computeBgrEvidence(undefined).valid).toBe(false);
  });

  test("rejects non-'glb' mode (absent AND undeclared)", () => {
    expect(
      computeBgrEvidence({ ...VALID_PHASES, bootBuildingsMode: 'absent' }).valid,
    ).toBe(false);
    const { bootBuildingsMode, ...rest } = VALID_PHASES;
    expect(computeBgrEvidence(rest).valid).toBe(false);
  });

  test('rejects every fuse/fallback dismissal reason', () => {
    for (const reason of ['milestone-fallback', 'visibility-fuse', 'force-ready']) {
      const v = computeBgrEvidence({ ...VALID_PHASES, loadingDismissReason: reason });
      expect(v.valid).toBe(false);
      expect(v.reasons.join(' ')).toContain(reason);
    }
  });

  test('rejects presented-after-dismissal (a late settle cannot fake a gated reveal)', () => {
    const v = computeBgrEvidence({
      ...VALID_PHASES,
      bootBuildingsPresentedAt: 7000,
      loadingDismissedAt: 6150,
    });
    expect(v.valid).toBe(false);
  });

  test('rejects missing presented/dismissed stamps', () => {
    const { bootBuildingsPresentedAt, ...noPresent } = VALID_PHASES;
    expect(computeBgrEvidence(noPresent).valid).toBe(false);
    const { loadingDismissedAt, ...noDismiss } = VALID_PHASES;
    expect(computeBgrEvidence(noDismiss).valid).toBe(false);
  });

  test('rejects cross-generation stamps (renderer swap mid-boot)', () => {
    const v = computeBgrEvidence({ ...VALID_PHASES, bootBuildingsPresentedGen: 2 });
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toContain('generations differ');
  });

  test('A1 [nori-NF3]: rejects the LEGACY pre-guide report shape', () => {
    const { bootGuideRevealRequired, bootRevealPresentedRequired, bootRevealPresentedFailed, ...legacy } =
      VALID_PHASES;
    const v = computeBgrEvidence(legacy);
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toContain('legacy');
  });

  test('A1: guide required ⇒ milestone must have stamped against 12 members', () => {
    const v = computeBgrEvidence({ ...VALID_PHASES, bootRevealPresentedRequired: 11 });
    expect(v.valid).toBe(false);
  });

  test('A1: guide explicitly NOT required ⇒ 11 members is the valid shape', () => {
    expect(
      computeBgrEvidence({
        ...VALID_PHASES,
        bootGuideRevealRequired: 0,
        bootRevealPresentedRequired: 11,
      }).valid,
    ).toBe(true);
    expect(
      computeBgrEvidence({
        ...VALID_PHASES,
        bootGuideRevealRequired: 0,
        bootRevealPresentedRequired: 12,
      }).valid,
    ).toBe(false);
  });

  test('A1: any failed-only token at presentation rejects', () => {
    const v = computeBgrEvidence({ ...VALID_PHASES, bootRevealPresentedFailed: 1 });
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toContain('failed-only');
  });
});
