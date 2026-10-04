import { describe, expect, test } from 'bun:test';

import { releaseParcelToastMessage } from './tenure-office-panels';

// M8 (2026-10-04): USDC rent prepay is non-refundable. The release toast keeps
// its old copy and appends a plain-language forfeit sentence only when the
// server reports forfeitedUsdcPrepayCt > 0.

const NON_REFUNDABLE =
  'vCLAW of USDC-funded rent was not returned (USDC rent prepay is non-refundable).';

describe('releaseParcelToastMessage', () => {
  test('refund only: unchanged copy', () => {
    expect(releaseParcelToastMessage('Starter Lot 1', { refundedCt: 1200, forfeitedUsdcPrepayCt: 0 }))
      .toBe(`Released Starter Lot 1; ${(1200).toLocaleString()} vCLAW escrow returned.`);
  });

  test('nothing returned and field absent (older API): unchanged copy', () => {
    expect(releaseParcelToastMessage('Starter Lot 1', { refundedCt: 0 })).toBe('Released Starter Lot 1.');
  });

  test('refund + forfeit: appends the non-refundable sentence', () => {
    const msg = releaseParcelToastMessage('Starter Lot 1', { refundedCt: 300, forfeitedUsdcPrepayCt: 700 });
    expect(msg).toBe(
      `Released Starter Lot 1; ${(300).toLocaleString()} vCLAW escrow returned. 700 ${NON_REFUNDABLE}`,
    );
  });

  test('forfeit only: plain release line + the non-refundable sentence', () => {
    const msg = releaseParcelToastMessage('Starter Lot 1', { refundedCt: 0, forfeitedUsdcPrepayCt: 2500 });
    expect(msg).toBe(`Released Starter Lot 1. ${(2500).toLocaleString()} ${NON_REFUNDABLE}`);
  });

  test('copy rules: says vCLAW, never CT, and has no em dash', () => {
    const msg = releaseParcelToastMessage('Starter Lot 1', { refundedCt: 300, forfeitedUsdcPrepayCt: 700 });
    expect(msg).not.toMatch(/\bCT\b/);
    expect(msg).not.toContain('—');
  });
});
