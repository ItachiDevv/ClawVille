import type { Driver } from './driver';
import { expectedFromWire } from './expected-from-wire';
import type {
  CardParityRoot,
  ParityGame,
  WireRecord,
} from './types';

export interface VisibleProbe {
  name: string;
  selector: string;
  kind: 'text' | 'integer' | 'active' | 'on-felt';
}

export const VISIBLE_PROBES: Readonly<Record<ParityGame, readonly VisibleProbe[]>> =
  Object.freeze({
    holdem: Object.freeze([
      { name: 'banner-text', selector: '[data-testid="holdem-settlement-narration"]', kind: 'text' },
      { name: 'pot', selector: '[data-testid="holdem-pot-amount"]', kind: 'integer' },
      { name: 'self-stack', selector: '[data-testid="holdem-self-stack"]', kind: 'integer' },
      { name: 'on-felt', selector: '[data-cv-parity^="holdem-felt"]', kind: 'on-felt' },
    ]),
    blackjack: Object.freeze([
      { name: 'banner-text', selector: '[data-testid="bj-outcome-banner"]', kind: 'text' },
      { name: 'net', selector: '[data-testid="bj-banner-net"]', kind: 'integer' },
      { name: 'subhand-0', selector: '[data-testid="bj-subhand-0"]', kind: 'active' },
      { name: 'subhand-1', selector: '[data-testid="bj-subhand-1"]', kind: 'active' },
    ]),
    baccarat: Object.freeze([
      { name: 'banner-text', selector: '[data-testid="bac-outcome-banner"]', kind: 'text' },
      { name: 'net', selector: '[data-testid="bac-banner-net"]', kind: 'integer' },
      { name: 'stake', selector: '[data-testid="bac-bet-pill"]', kind: 'integer' },
      { name: 'bet-zone', selector: '[role="radio"][aria-checked="true"]', kind: 'text' },
    ]),
  } satisfies Record<ParityGame, readonly VisibleProbe[]>);

export async function probeVisibleSurface(
  driver: Driver,
  probe: VisibleProbe,
): Promise<string | number | boolean | null> {
  return driver.evalJson<string | number | boolean | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(probe.selector)});
    if (!element) return null;
    const kind = ${JSON.stringify(probe.kind)};
    if (kind === 'active') return element.getAttribute('data-active') === 'true';
    if (kind === 'on-felt') return element.getAttribute('data-on-felt') === 'true';
    const text = ${JSON.stringify(probe.name)} === 'banner-text'
      ? element.getAttribute('data-banner-text')
        ?? element.firstElementChild?.textContent
        ?? element.textContent
        ?? ''
      : element.textContent ?? '';
    if (kind === 'integer') {
      const match = text.replaceAll(',', '').match(/-?\\d+/);
      return match ? Number(match[0]) : null;
    }
    return text.trim();
  })()`);
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function visibleProbesFor(
  game: ParityGame,
  root: CardParityRoot,
  wire: WireRecord,
): readonly VisibleProbe[] {
  if (game !== 'blackjack') return VISIBLE_PROBES[game];
  const body = nestedRecord(wire.responseBody) ?? {};
  const outcome = nestedRecord(body.outcome) ?? body;
  const hands = Array.isArray(outcome.playerHands) ? outcome.playerHands : [];
  return VISIBLE_PROBES.blackjack.filter(
    (probe) => !probe.name.startsWith('subhand-') || hands.length === 2,
  );
}

export function expectedProbeValue(
  probe: VisibleProbe,
  game: ParityGame,
  root: CardParityRoot,
  wire: WireRecord,
  ba1Snapshot?: unknown,
  records: readonly WireRecord[] = [],
): string | number | boolean | null {
  const expected = expectedFromWire(
    game,
    root.surface,
    wire,
    ba1Snapshot,
    { root },
  );
  if (probe.name === 'banner-text') return expected.meta['banner-text'] ?? null;
  if (probe.name === 'pot') return Number(expected.meta.pot);
  if (probe.name === 'self-stack') {
    const body = wire.responseBody as Record<string, unknown>;
    const snapshot = nestedRecord(ba1Snapshot);
    if (snapshot && Array.isArray(snapshot.seats)) {
      const privateView = records
        .map((candidate) => nestedRecord(
          nestedRecord(candidate.responseBody)?.view,
        ))
        .find((view) => (
          view
          && Number(view.handNumber) === root.correlation.handNumber
          && Number.isSafeInteger(Number(view.seatIndex))
        ));
      const selfSeat = snapshot.seats
        .map(nestedRecord)
        .find((seat) => (
          seat && Number(seat.seatIndex) === Number(privateView?.seatIndex)
        ));
      if (selfSeat) return Number(selfSeat.endStack);
    }
    const view = nestedRecord(body.view);
    return Number(
      body.playerStack
      ?? body.humanStack
      ?? view?.chipStack
      ?? Number.NaN,
    );
  }
  if (probe.name === 'net') return Number(expected.meta.net);
  if (probe.name === 'stake') return Number(expected.meta.stake);
  if (probe.name.startsWith('subhand-')) {
    return Number(probe.name.at(-1)) === Number(expected.meta['active-slot']);
  }
  if (probe.name === 'bet-zone') return expected.meta.bet ?? null;
  if (probe.name === 'on-felt') return true;
  return null;
}

export async function assertVisibleSurface(
  driver: Driver,
  game: ParityGame,
  root: CardParityRoot,
  wire: WireRecord,
  ba1Snapshot?: unknown,
  records: readonly WireRecord[] = [],
): Promise<Record<string, {
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
  pass: boolean;
}>> {
  const results: Record<string, {
    expected: string | number | boolean | null;
    actual: string | number | boolean | null;
    pass: boolean;
  }> = {};
  for (const probe of visibleProbesFor(game, root, wire)) {
    const expected = expectedProbeValue(
      probe,
      game,
      root,
      wire,
      ba1Snapshot,
      records,
    );
    const actual = await probeVisibleSurface(driver, probe);
    const normalizedActual = probe.name === 'bet-zone' && typeof actual === 'string'
      ? actual.trim().toLowerCase()
      : actual;
    results[probe.name] = {
      expected,
      actual: normalizedActual,
      pass: expected !== null
        && normalizedActual !== null
        && expected === normalizedActual,
    };
  }
  return results;
}
