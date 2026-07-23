import type { Driver } from './driver';
import type { CardParityRoot, WireRecord } from './types';

/**
 * Minimal recorded page used by --self-test. Slots are stored as rendered
 * data-* values and parsed back into a root, so corruption happens at the page
 * mirror boundary rather than by passing a hand-edited object to diffParity.
 */
export class RecordedParityPage implements Driver {
  private readonly rootMeta: Omit<CardParityRoot, 'slots'>;
  private readonly renderedSlots: Array<{
    slot: string;
    card: string;
    facing: CardParityRoot['slots'][number]['facing'];
    status?: CardParityRoot['slots'][number]['status'];
  }>;

  constructor(
    root: CardParityRoot,
    private readonly records: readonly WireRecord[],
  ) {
    const { slots: _slots, ...meta } = structuredClone(root);
    this.rootMeta = meta;
    this.renderedSlots = root.slots.map((slot) => ({ ...slot }));
  }

  injectWrongCard(slot: string, card: string): void {
    const element = this.renderedSlots.find((candidate) => candidate.slot === slot);
    if (!element) throw new Error(`No rendered parity <li> for ${slot}`);
    element.card = card;
  }

  readRoot(): CardParityRoot {
    return {
      ...structuredClone(this.rootMeta),
      slots: this.renderedSlots.map((slot) => ({
        ...slot,
        card: slot.card,
      })) as CardParityRoot['slots'],
    };
  }

  async evalJson<T>(js: string): Promise<T> {
    if (js.includes('__CV_READ_PARITY')) return this.readRoot() as T;
    if (js.includes('__CV_WIRE_ALL')) return structuredClone(this.records) as T;
    throw new Error(`RecordedParityPage cannot evaluate: ${js}`);
  }

  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async waitFn(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}
