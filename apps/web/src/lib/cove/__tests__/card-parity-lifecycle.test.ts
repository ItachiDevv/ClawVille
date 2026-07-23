import { afterEach, describe, expect, test } from 'bun:test';
import {
  beginTransition,
  clearFeltParity,
  completeTransition,
  getParitySnapshot,
  publishFeltParity,
  type CardParityPayload,
  type Surface,
} from '../card-parity-mirror';

const OWNERS = [
  'parity-store-owner',
  'parity-store-other',
  'parity-transition-owner',
  'parity-cap-owner',
  'parity-journal-owner',
] as const;

afterEach(() => {
  for (const owner of OWNERS) clearFeltParity(owner);
});

function payload(
  surface: Surface,
  dealStep: string,
): CardParityPayload {
  return {
    surface,
    version: 2,
    correlation: { hand: 'hand-lifecycle', handNumber: 12 },
    dealStep,
    phase: dealStep,
    transition: 'idle',
    slots: [{ slot: 'board-1', facing: 'empty', card: '' }],
    meta: {},
  };
}

describe('per-surface parity store', () => {
  test('coexists for felt and tray under one owner, semantically dedups, and clears both', () => {
    const feltRevision = publishFeltParity(
      'parity-store-owner',
      payload('holdem-felt-practice', 'flop'),
    );
    const trayRevision = publishFeltParity(
      'parity-store-owner',
      payload('holdem-tray-practice', 'flop'),
    );
    const duplicateRevision = publishFeltParity(
      'parity-store-owner',
      payload('holdem-felt-practice', 'flop'),
    );

    expect(feltRevision).toBeGreaterThan(0);
    expect(trayRevision).toBeGreaterThan(feltRevision);
    expect(duplicateRevision).toBe(feltRevision);
    expect(getParitySnapshot('holdem-felt-practice')?.instanceId)
      .toBe('parity-store-owner');
    expect(getParitySnapshot('holdem-tray-practice')?.instanceId)
      .toBe('parity-store-owner');

    const rejectedRevision = publishFeltParity(
      'parity-store-other',
      payload('holdem-felt-practice', 'turn'),
    );
    expect(rejectedRevision).toBe(feltRevision);
    expect(getParitySnapshot('holdem-felt-practice')?.dealStep).toBe('flop');

    clearFeltParity('parity-store-owner');
    expect(getParitySnapshot('holdem-felt-practice')).toBeNull();
    expect(getParitySnapshot('holdem-tray-practice')).toBeNull();

    const transferredRevision = publishFeltParity(
      'parity-store-other',
      payload('holdem-felt-practice', 'turn'),
    );
    expect(transferredRevision).toBeGreaterThan(trayRevision);
    expect(getParitySnapshot('holdem-felt-practice')?.instanceId)
      .toBe('parity-store-other');
  });

  test('enforces each surface cap loudly without truncating legal slots', () => {
    const caps: readonly [Surface, number][] = [
      ['holdem-felt-3d', 16],
      ['holdem-tray-3d', 7],
      ['holdem-felt-practice', 16],
      ['holdem-tray-practice', 7],
      ['blackjack-2d', 64],
      ['blackjack-3d', 64],
      ['baccarat-2d', 6],
      ['baccarat-3d', 6],
    ];

    for (const [surface, cap] of caps) {
      const atCap: CardParityPayload = {
        ...payload(surface, `at-cap-${cap}`),
        slots: Array.from({ length: cap }, (_, index) => ({
          slot: `slot-${index}`,
          facing: 'empty' as const,
          card: '' as const,
        })),
      };
      publishFeltParity('parity-cap-owner', atCap);
      expect(getParitySnapshot(surface)?.slots).toHaveLength(cap);

      const overCap: CardParityPayload = {
        ...atCap,
        dealStep: `over-cap-${cap + 1}`,
        slots: [
          ...atCap.slots,
          { slot: `slot-${cap}`, facing: 'empty', card: '' },
        ],
      };
      expect(() => publishFeltParity('parity-cap-owner', overCap))
        .toThrow(`${surface} parity slot cap exceeded`);
      expect(getParitySnapshot(surface)?.slots).toHaveLength(cap);
    }
  });

  test('installs a bounded, ordered per-surface journal window hook', () => {
    const previousWindow = globalThis.window;
    const browserWindow = {} as Window;
    Object.defineProperty(globalThis, 'window', {
      value: browserWindow,
      configurable: true,
      writable: true,
    });
    try {
      for (let index = 0; index < 270; index += 1) {
        publishFeltParity(
          'parity-journal-owner',
          payload('baccarat-3d', `step-${index}`),
        );
      }

      const journal = browserWindow.__CV_PARITY_JOURNAL?.('baccarat-3d');
      expect(journal).toHaveLength(256);
      expect(journal?.[0]?.dealStep).toBe('step-14');
      expect(journal?.at(-1)?.dealStep).toBe('step-269');
      for (let index = 1; index < (journal?.length ?? 0); index += 1) {
        expect(journal![index]!.revision).toBeGreaterThan(journal![index - 1]!.revision);
      }
      expect(browserWindow.__CV_READ_PARITY?.('baccarat-3d')?.dealStep)
        .toBe('step-269');
    } finally {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: previousWindow,
          configurable: true,
          writable: true,
        });
      }
    }
  });
});

describe('transition span lifecycle', () => {
  test('survives intermediate revisions and rejects a superseded completion', () => {
    const initialRevision = publishFeltParity(
      'parity-transition-owner',
      payload('holdem-tray-practice', 'hole'),
    );
    const firstSpan = beginTransition(
      'parity-transition-owner',
      'holdem-tray-practice',
      'revealing',
    );
    const flopRevision = publishFeltParity(
      'parity-transition-owner',
      payload('holdem-tray-practice', 'flop'),
    );
    const turnRevision = publishFeltParity(
      'parity-transition-owner',
      payload('holdem-tray-practice', 'turn'),
    );

    expect(flopRevision).toBeGreaterThan(initialRevision);
    expect(turnRevision).toBeGreaterThan(flopRevision);
    expect(getParitySnapshot('holdem-tray-practice')).toMatchObject({
      dealStep: 'turn',
      transition: 'revealing',
    });

    const supersedingSpan = beginTransition(
      'parity-transition-owner',
      'holdem-tray-practice',
      'revealing',
    );
    expect(completeTransition(
      'parity-transition-owner',
      'holdem-tray-practice',
      firstSpan,
    )).toBe(false);
    expect(getParitySnapshot('holdem-tray-practice')?.transition).toBe('revealing');

    expect(completeTransition(
      'parity-transition-owner',
      'holdem-tray-practice',
      supersedingSpan,
    )).toBe(true);
    const completed = getParitySnapshot('holdem-tray-practice');
    expect(completed?.transition).toBe('idle');
    expect(completed?.renderRevision).toBeGreaterThan(turnRevision);
    expect(completeTransition(
      'parity-transition-owner',
      'holdem-tray-practice',
      supersedingSpan,
    )).toBe(false);
    expect(getParitySnapshot('holdem-tray-practice')?.renderRevision)
      .toBe(completed?.renderRevision);
  });
});
