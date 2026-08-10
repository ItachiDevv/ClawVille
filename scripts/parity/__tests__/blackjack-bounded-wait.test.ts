import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Driver } from '../driver';
import type { BrowserParityJournalEntry } from '../journal';
import {
  driveScenario,
  submitBlackjackHitAndWait,
} from '../scenarios/runtime';
import type { ParityCheckpoint, WireRecord } from '../types';

class HitProgressDriver implements Driver {
  readonly waits: string[] = [];
  readonly actions: string[] = [];

  async evalJson<T>(js: string): Promise<T> {
    if (js.includes('CV_BLACKJACK_HIT_READY')) {
      return { terminal: false, actionSeq: 4 } as T;
    }
    if (js.includes('CV_ACTION_REVISION_FLOOR')) {
      return { revision: 8, correlationHand: 'hand-1' } as T;
    }
    if (js.includes('CV_BLACKJACK_HIT_PROGRESS')) {
      return {
        terminal: false,
        newerRevision: false,
        hitEnabled: true,
        actionStatus: 200,
      } as T;
    }
    const labelsSource = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    if (labelsSource) {
      this.actions.push(String((JSON.parse(labelsSource) as string[])[0]));
      return true as T;
    }
    throw new Error(`Unexpected eval: ${js.slice(0, 80)}`);
  }

  async waitFn(js: string): Promise<void> {
    this.waits.push(js);
  }

  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}

function signature(
  revision: number,
  dealStep: string,
  handId = 'hand-1',
): string {
  return JSON.stringify([
    'blackjack-3d',
    2,
    handId,
    7,
    'shoe-1',
    dealStep,
    'player-turn',
    'idle',
    [
      ['player-0-card-1', 'up', '8s', ''],
      ['player-0-card-2', 'up', '7h', ''],
      ...(revision > 1 ? [['player-0-card-3', 'up', '6c', '']] : []),
      ['dealer-card-1', 'up', 'Kd', ''],
      ['dealer-card-2', 'down', '', ''],
    ],
    [],
  ]);
}

function wire(
  seq: number,
  capturedAt: number,
  urlSuffix: 'blackjack/hand/deal' | 'blackjack/action',
  responseBody: unknown,
): WireRecord {
  return {
    seq,
    capturedAt,
    method: 'POST',
    url: `http://127.0.0.1:4002/api/cove/${urlSuffix}`,
    urlSuffix,
    status: 200,
    requestBody: urlSuffix.endsWith('/action')
      ? { handId: 'hand-1', action: 'hit' }
      : { shoeId: 'shoe-1', bet: 25 },
    responseBody,
    handId: 'hand-1',
    handNumber: 7,
    coupId: null,
    shoeId: 'shoe-1',
    idempotencyKey: 'fixture-key',
  };
}

const IN_PROGRESS_DEAL = wire(1, 100, 'blackjack/hand/deal', {
  handId: 'hand-1',
  shoeId: 'shoe-1',
  handIndex: 7,
  bet: '25',
  playerHand: [
    { rank: '8', suit: 'spades' },
    { rank: '7', suit: 'hearts' },
  ],
  dealerUpcard: { rank: 'K', suit: 'diamonds' },
  insuranceOffered: false,
  tookInsurance: false,
  balance: 975,
  status: 'in_progress',
});

class BlackjackNegativeTraversalDriver implements Driver {
  constructor(
    readonly journal: BrowserParityJournalEntry[],
    readonly wires: WireRecord[],
  ) {}

  async evalJson<T>(js: string): Promise<T> {
    const labelsSource = /const labels = (\[[^;]+\]);/.exec(js)?.[1];
    if (labelsSource) return true as T;
    return new Function('window', `return ${js}`)({
      __CV_READ_PARITY: () => ({
        renderRevision: this.journal[0]!.revision,
        dealStep: this.journal[0]!.dealStep,
        correlation: { hand: 'hand-1' },
      }),
      __CV_PARITY_JOURNAL: () => structuredClone(this.journal),
      __CV_WIRE_ALL: () => structuredClone(this.wires),
    }) as T;
  }

  async waitFn(): Promise<void> {}
  async openWithInitScript(): Promise<void> {}
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async screenshot(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async close(): Promise<void> {}
}

function journalEntry(
  revision: number,
  dealStep: string,
  ts: number,
): BrowserParityJournalEntry {
  return {
    surface: 'blackjack-3d',
    instanceId: 'fixture-instance',
    revision,
    dealStep,
    transition: 'idle',
    signature: signature(revision, dealStep),
    ts,
  };
}

async function nextCheckpoints(
  driver: Driver,
  count: number,
): Promise<Array<IteratorResult<ParityCheckpoint>>> {
  const traversal = driveScenario(
    'blackjack',
    'B-neg',
    'blackjack-3d',
    ['every-in-progress-read'],
    driver,
  );
  const results: Array<IteratorResult<ParityCheckpoint>> = [];
  for (let index = 0; index < count; index += 1) {
    results.push(await traversal.next());
    if (results.at(-1)?.done) break;
  }
  await traversal.return(undefined);
  return results;
}

describe('blackjack bounded action waits', () => {
  test('a pending Hit waits for a response/revision/terminal proof', async () => {
    const driver = new HitProgressDriver();
    expect(await submitBlackjackHitAndWait(
      driver,
      'blackjack-2d',
      'hand-1',
    )).toEqual({ revision: 8, correlationHand: 'hand-1' });
    expect(driver.actions).toEqual(['Hit']);
    expect(driver.waits[0]).toContain("startsWith('Hit') && !button.disabled");
    expect(driver.waits[1]).toContain('response.status >= 200');
    expect(driver.waits[1]).toContain('newerRevision');
    expect(driver.waits[1]).toContain('terminal');
  });

  test('B-neg stops before a revision paired to the terminal Hit wire', async () => {
    const journal = [
      journalEntry(1, 'hole', 120),
      // G0c can still honestly publish the masked player-turn view here even
      // though the justifying Hit response has already settled the hand.
      journalEntry(2, 'player-turn', 200),
    ];
    const terminalHit = wire(2, 190, 'blackjack/action', {
      handId: 'hand-1',
      shoeId: 'shoe-1',
      handIndex: 7,
      status: 'settled',
      outcome: {
        playerHands: [{
          cards: [
            { rank: '8', suit: 'spades' },
            { rank: '7', suit: 'hearts' },
            { rank: '6', suit: 'clubs' },
          ],
          total: 21,
          isSoft: false,
          isBust: false,
          outcome: 'win',
        }],
        dealer: { cards: [], total: 0, isSoft: false, isBust: false },
      },
      balance: 1025,
      totalBet: '25',
      totalPayout: '50',
      net: '25',
      dealtCount: 5,
      reshuffleSuggested: false,
      idempotencyReplay: false,
    });

    const results = await nextCheckpoints(
      new BlackjackNegativeTraversalDriver(
        journal,
        [IN_PROGRESS_DEAL, terminalHit],
      ),
      2,
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      done: false,
      value: { expectRenderRevision: 1, expectCorrelationHand: 'hand-1' },
    });
    expect(results[1]).toEqual({ value: undefined, done: true });
    const lastCheckpoint = results[0]!.value;
    const lastEntry = journal.find(
      (entry) => entry.revision === lastCheckpoint.expectRenderRevision,
    )!;
    const pairedWire = [IN_PROGRESS_DEAL, terminalHit]
      .filter((record) => record.capturedAt! <= lastEntry.ts)
      .at(-1)!;
    expect(pairedWire.responseBody).toMatchObject({
      handId: 'hand-1',
      status: 'in_progress',
    });
  });

  test('B-neg keeps traversing after a non-terminal Hit', async () => {
    const journal = [
      journalEntry(1, 'hole', 120),
      journalEntry(2, 'player-turn', 200),
    ];
    const inProgressHit = wire(2, 190, 'blackjack/action', {
      handId: 'hand-1',
      status: 'in_progress',
      playerHands: [{
        cards: [
          { rank: '8', suit: 'spades' },
          { rank: '7', suit: 'hearts' },
          { rank: '2', suit: 'clubs' },
        ],
        total: 17,
        isSoft: false,
        isBust: false,
        isResolved: false,
      }],
      dealerUpcard: { rank: 'K', suit: 'diamonds' },
      didSplit: false,
    });

    const results = await nextCheckpoints(
      new BlackjackNegativeTraversalDriver(
        journal,
        [IN_PROGRESS_DEAL, inProgressHit],
      ),
      2,
    );

    expect(results[1]).toMatchObject({
      done: false,
      value: {
        label: 'every-in-progress-read-2',
        expectRenderRevision: 2,
        expectCorrelationHand: 'hand-1',
      },
    });
  });

  test('B-neg/B5 no longer use fixed 100/120ms sleeps', () => {
    const source = readFileSync(
      new URL('../scenarios/runtime.ts', import.meta.url),
      'utf8',
    );
    const blackjackStart = source.indexOf(
      "if (game === 'blackjack')",
      source.indexOf('export async function* driveScenario'),
    );
    const baccaratStart = source.indexOf(
      "if (game === 'baccarat')",
      blackjackStart,
    );
    const blackjackDrive = source.slice(blackjackStart, baccaratStart);
    expect(blackjackDrive).not.toContain('setTimeout(resolveWait, 100)');
    expect(blackjackDrive).not.toContain('setTimeout(resolveWait, 120)');
  });
});
