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
});
