import { assertParityCheckpoint } from './assertion-engine';
import { RECORDED_CASES } from './fixtures/recorded';
import { RecordedParityPage } from './offline-page';

export interface SelfTestResult {
  pass: boolean;
  output: string;
}

export async function runHarnessSelfTest(): Promise<SelfTestResult> {
  const recorded = RECORDED_CASES[0]!;
  const checkpoint = {
    label: recorded.id,
    surface: recorded.root.surface,
    expectRevisionAdvance: true as const,
    expectDealStep: recorded.expectedDealStep,
    expectCorrelationHand: recorded.root.correlation.hand,
    final: recorded.final,
  };
  const page = new RecordedParityPage(recorded.root, recorded.records);
  const correctRoot = await page.evalJson<typeof recorded.root>(
    `window.__CV_READ_PARITY?.(${JSON.stringify(recorded.root.surface)})`,
  );
  const correct = assertParityCheckpoint({
    game: recorded.game,
    checkpoint,
    root: correctRoot,
    records: recorded.records,
  });

  const target = correctRoot.slots.find((slot) => slot.facing === 'up');
  if (!target || target.facing !== 'up') {
    throw new Error('Self-test fixture has no face-up card to corrupt');
  }
  page.injectWrongCard(target.slot, target.card === 'As' ? 'Kh' : 'As');
  const injectedCard = target.card === 'As' ? 'Kh' : 'As';
  const wrong = await page.evalJson<typeof recorded.root>(
    `window.__CV_READ_PARITY?.(${JSON.stringify(recorded.root.surface)})`,
  );
  const injected = assertParityCheckpoint({
    game: recorded.game,
    checkpoint,
    root: wrong,
    records: recorded.records,
  });
  const detectedExactly = !injected.pass
    && injected.mismatches.length === 1
    && injected.mismatches[0]?.slot === target.slot
    && injected.mismatches[0]?.field === 'card'
    && injected.mismatches[0]?.expected === target.card
    && injected.mismatches[0]?.actual === injectedCard;
  const pass = correct.pass && detectedExactly;
  const output = [
    `SELF-TEST correct recorded payload: ${correct.pass ? 'PASS' : 'FAIL'}`,
    `SELF-TEST injected wrong card: ${injected.pass ? 'PASS (HARNESS BLIND)' : 'FAIL (expected; lie detected)'}`,
    `SELF-TEST overall: ${pass ? 'PASS' : 'FAIL'}`,
  ].join('\n');
  return { pass, output };
}
