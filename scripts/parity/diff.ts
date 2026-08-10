import type {
  CardParityRoot,
  ExpectedParity,
  ExpectedSlot,
  Mismatch,
} from './types';

function statusValue(slot: ExpectedSlot | undefined): string {
  return slot?.status ?? '';
}

export function diffParity(
  expected: ExpectedParity,
  mirror: CardParityRoot,
): { pass: boolean; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  const actualSlots = new Map<string, CardParityRoot['slots'][number]>();
  const duplicateSlots = new Set<string>();
  for (const slot of mirror.slots) {
    if (actualSlots.has(slot.slot)) duplicateSlots.add(slot.slot);
    else actualSlots.set(slot.slot, slot);
  }
  for (const slot of [...duplicateSlots].sort()) {
    mismatches.push({
      slot,
      field: 'card',
      expected: '<unique>',
      actual: '<duplicate>',
    });
  }
  const slotNames = new Set([
    ...Object.keys(expected.slots),
    ...actualSlots.keys(),
  ]);

  for (const slotName of [...slotNames].sort()) {
    const wanted = expected.slots[slotName];
    const actual = actualSlots.get(slotName);
    if (!wanted || !actual) {
      mismatches.push({
        slot: slotName,
        field: 'card',
        expected: wanted?.card ?? '<absent>',
        actual: actual?.card ?? '<absent>',
      });
      continue;
    }
    if (wanted.card !== actual.card) {
      mismatches.push({
        slot: slotName,
        field: 'card',
        expected: wanted.card,
        actual: actual.card,
      });
    }
    if (wanted.facing !== actual.facing) {
      mismatches.push({
        slot: slotName,
        field: 'facing',
        expected: wanted.facing,
        actual: actual.facing,
      });
    }
    if (statusValue(wanted) !== (actual.status ?? '')) {
      mismatches.push({
        slot: slotName,
        field: 'status',
        expected: statusValue(wanted),
        actual: actual.status ?? '',
      });
    }
  }

  const metaKeys = new Set([
    ...Object.keys(expected.meta),
    ...Object.keys(mirror.meta),
  ]);
  for (const key of [...metaKeys].sort()) {
    const wanted = expected.meta[key];
    const actual = mirror.meta[key];
    if (wanted !== actual) {
      mismatches.push({
        slot: '<root>',
        field: `meta:${key}`,
        expected: wanted ?? '<absent>',
        actual: actual ?? '<absent>',
      });
    }
  }
  return { pass: mismatches.length === 0, mismatches };
}
