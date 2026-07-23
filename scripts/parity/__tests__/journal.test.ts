import { describe, expect, test } from 'bun:test';
import { RECORDED_CASES } from '../fixtures/recorded';
import { rootFromJournalEntry } from '../journal';

describe('canonical landed journal signatures', () => {
  test('reconstructs an immutable past root without publisher fields', () => {
    const root = RECORDED_CASES[3]!.root;
    const signature = JSON.stringify([
      root.surface,
      root.version,
      root.correlation.hand,
      root.correlation.handNumber,
      root.correlation.shoe ?? '',
      root.dealStep,
      root.phase,
      root.transition,
      root.slots.map((slot) => [
        slot.slot,
        slot.facing,
        slot.card,
        slot.status ?? '',
      ]),
      Object.keys(root.meta).sort().map((key) => [key, root.meta[key]]),
    ]);
    expect(rootFromJournalEntry({
      surface: root.surface,
      instanceId: root.instanceId,
      revision: root.renderRevision,
      dealStep: root.dealStep,
      transition: root.transition,
      signature,
      ts: 1,
    })).toEqual(root);
  });
});
