import type {
  CardFacing,
  CardParityRoot,
  Surface,
} from './types';

export interface BrowserParityJournalEntry {
  surface: Surface;
  instanceId: string;
  revision: number;
  dealStep: string;
  transition: CardParityRoot['transition'];
  signature: string;
  ts: number;
}

type SignatureSlot = [
  slot: string,
  facing: CardFacing,
  card: string,
  status: string,
];
type SignatureMeta = [key: string, value: string];

/**
 * The landed journal deliberately stores a canonical semantic signature, not
 * duplicate mutable roots. Reconstructing a past root from that immutable
 * signature lets the harness assert fast intermediate reveal steps without
 * adding any publisher field.
 */
export function rootFromJournalEntry(
  entry: BrowserParityJournalEntry,
): CardParityRoot {
  const parsed = JSON.parse(entry.signature) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 10) {
    throw new Error(`Invalid parity journal signature at revision ${entry.revision}`);
  }
  const [
    surface,
    version,
    hand,
    handNumber,
    shoe,
    dealStep,
    phase,
    transition,
    rawSlots,
    rawMeta,
  ] = parsed;
  if (surface !== entry.surface || version !== 2 || dealStep !== entry.dealStep) {
    throw new Error(`Parity journal signature drift at revision ${entry.revision}`);
  }
  if (!Array.isArray(rawSlots) || !Array.isArray(rawMeta)) {
    throw new Error(`Invalid slots/meta in parity journal revision ${entry.revision}`);
  }
  const slots = (rawSlots as SignatureSlot[]).map(
    ([slot, facing, card, status]) => {
      if (facing === 'up') {
        return {
          slot,
          facing,
          card: card as CardParityRoot['slots'][number]['card'],
          ...(status ? { status } : {}),
        };
      }
      return {
        slot,
        facing,
        card: '' as const,
        ...(status ? { status } : {}),
      };
    },
  ) as CardParityRoot['slots'];
  return {
    surface: surface as Surface,
    version: 2,
    instanceId: entry.instanceId,
    renderRevision: entry.revision,
    correlation: {
      hand: String(hand),
      handNumber: typeof handNumber === 'number' ? handNumber : null,
      ...(shoe ? { shoe: String(shoe) } : {}),
    },
    dealStep: String(dealStep),
    phase: String(phase),
    transition: transition as CardParityRoot['transition'],
    slots,
    meta: Object.fromEntries(rawMeta as SignatureMeta[]),
  };
}

export function rootsFromJournal(
  entries: readonly BrowserParityJournalEntry[],
): CardParityRoot[] {
  return entries
    .slice()
    .sort((left, right) => left.revision - right.revision)
    .map(rootFromJournalEntry);
}
