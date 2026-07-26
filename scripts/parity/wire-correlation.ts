import type { CardParityRoot, WireRecord } from './types';

let activeRecords: readonly WireRecord[] = [];

export function setCapturedWireRecords(records: readonly WireRecord[]): void {
  activeRecords = records;
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function findDeep(value: unknown, keys: ReadonlySet<string>): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (keys.has(key) && child !== null && child !== undefined) return child;
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return undefined;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function recordMatches(root: CardParityRoot, record: WireRecord): boolean {
  const body = record.responseBody;
  if (root.surface.startsWith('blackjack')) {
    const hand = record.handId
      ?? stringValue(findDeep(body, new Set(['handId', 'hand_id'])));
    return hand === root.correlation.hand;
  }
  if (root.surface.startsWith('baccarat')) {
    // Prefer the response body's coup correlation over the capture summary.
    // A session/current response can carry lastCoup.coupId for the current
    // checkpoint while an older capture-level value is still present.
    const coup = stringValue(findDeep(body, new Set(['coupId', 'coup_id'])))
      ?? record.coupId;
    return coup === root.correlation.hand;
  }

  const hand = record.handId
    ?? stringValue(findDeep(body, new Set(['handId', 'hand_id'])));
  if (!root.surface.endsWith('-3d')) {
    return hand === root.correlation.hand;
  }

  if (root.correlation.handNumber !== null) {
    if (
      root.dealStep !== 'showdown'
      && /last-settled/.test(record.urlSuffix)
    ) {
      return false;
    }
    const handNumber = record.handNumber
      ?? numeric(findDeep(body, new Set(['handNumber', 'handIndex', 'hand_number'])));
    // The live simulator intentionally namespaces its internal snapshot key as
    // `cash:<persisted uuid>`, while both the route and parity root carry the
    // persisted table UUID. The exact captured endpoint is therefore the
    // immutable external table identity for cash-row correlation.
    const tableId = /poker\/cash\/tables\/([^/?]+)/.exec(record.urlSuffix)?.[1]
      ?? stringValue(findDeep(body, new Set(['tableId', 'table_id'])))
      ?? null;
    if (root.correlation.hand.includes(':')) {
      const expectedTable = root.correlation.hand.slice(
        0,
        root.correlation.hand.lastIndexOf(':'),
      );
      return handNumber === root.correlation.handNumber
        && tableId === expectedTable;
    }
  }
  return hand === root.correlation.hand;
}

export function explainWireCorrelation(
  root: CardParityRoot,
  record: WireRecord,
): {
  matches: boolean;
  rootHandNumber: number | null;
  wireHandNumber: number | null;
  expectedTable: string | null;
  wireTable: string | null;
} {
  const rootSeparator = root.correlation.hand.lastIndexOf(':');
  return {
    matches: recordMatches(root, record),
    rootHandNumber: root.correlation.handNumber,
    wireHandNumber: record.handNumber
      ?? numeric(findDeep(
        record.responseBody,
        new Set(['handNumber', 'handIndex', 'hand_number']),
      )),
    expectedTable:
      rootSeparator > 0
        ? root.correlation.hand.slice(0, rootSeparator)
        : null,
    wireTable:
      /poker\/cash\/tables\/([^/?]+)/.exec(record.urlSuffix)?.[1]
      ?? stringValue(findDeep(
        record.responseBody,
        new Set(['tableId', 'table_id']),
      ))
      ?? null,
  };
}

function endpointWeight(root: CardParityRoot, record: WireRecord): number {
  const suffix = record.urlSuffix;
  let weight = 0;
  if (root.surface.startsWith('blackjack')) {
    if (root.dealStep === 'settled' && /settle|stand|action|current/.test(suffix)) weight += 20;
    if (root.dealStep === 'dealer-reveal' && /stand|action|current/.test(suffix)) weight += 15;
    if (/deal|action|current/.test(suffix)) weight += 5;
  } else if (root.surface.startsWith('baccarat')) {
    if (/coup|current/.test(suffix)) weight += 10;
  } else if (/last-settled/.test(suffix) && root.dealStep === 'showdown') {
    weight += 20;
  } else if (
    /state-for-agent/.test(suffix)
    && root.surface === 'holdem-tray-3d'
    && root.dealStep !== 'showdown'
  ) {
    // Cash hand numbers intentionally identify the same hand from deal through
    // settlement. A later last-settled poll can therefore correlate by number
    // while describing terminal truth, but a nonterminal tray checkpoint must
    // use the private live view that owns its hole cards and current pot.
    weight += 20;
  } else if (
    root.surface === 'holdem-felt-3d'
    && /poker\/cash\/tables\/[^/?]+$/.test(suffix)
    && root.dealStep !== 'showdown'
  ) {
    // The felt is the public table projection. Correlate it to the public
    // table wire instead of a private state-for-agent poll that may lead the
    // visible board by one simulator transition.
    weight += 20;
  } else if (/hand|action|current|table/.test(suffix)) {
    weight += 5;
  }
  return weight + record.seq / 1_000_000;
}

/**
 * Resolve by fields the application already exposes. The optional records
 * argument exists for deterministic offline tests; live callers seed the same
 * capture set with setCapturedWireRecords().
 */
export function resolveWireForRoot(
  root: CardParityRoot,
  records: readonly WireRecord[] = activeRecords,
): WireRecord | null {
  const matches = records
    .filter((record) => record.status >= 200 && record.status < 300)
    .filter((record) => recordMatches(root, record))
    .sort((a, b) => {
      const endpointOrder =
        Math.floor(endpointWeight(root, b))
        - Math.floor(endpointWeight(root, a));
      if (endpointOrder !== 0) return endpointOrder;
      if (
        root.observedAt !== undefined
        && a.capturedAt !== undefined
        && b.capturedAt !== undefined
      ) {
        const temporalOrder =
          Math.abs(a.capturedAt - root.observedAt)
          - Math.abs(b.capturedAt - root.observedAt);
        if (temporalOrder !== 0) return temporalOrder;
      }
      return b.seq - a.seq;
    });
  return matches[0] ?? null;
}

/**
 * Resolve a checkpoint only after its immutable application correlation has
 * advanced from the prior checkpoint. Multi-coup rows can briefly republish a
 * settled journal root from the preceding coup after "Next Coup"; accepting
 * that root attributes the current visible UI to the preceding wire.
 */
export function resolveWireForCheckpoint(
  root: CardParityRoot,
  records: readonly WireRecord[],
  previousCorrelation: string | null,
): WireRecord | null {
  if (
    previousCorrelation !== null
    && root.correlation.hand === previousCorrelation
  ) {
    return null;
  }
  return resolveWireForRoot(root, records);
}

export function immutableFieldsFromBodies(
  requestBody: unknown,
  responseBody: unknown,
): Pick<
  WireRecord,
  'handId' | 'handNumber' | 'coupId' | 'shoeId' | 'idempotencyKey'
> {
  const both = { requestBody, responseBody };
  return {
    handId: stringValue(findDeep(both, new Set(['handId', 'hand_id']))),
    handNumber: numeric(findDeep(both, new Set(['handNumber', 'handIndex', 'hand_number']))),
    coupId: stringValue(findDeep(both, new Set(['coupId', 'coup_id']))),
    shoeId: stringValue(findDeep(both, new Set(['shoeId', 'shoe_id']))),
    idempotencyKey: stringValue(
      objectValue(requestBody, 'idempotencyKey')
      ?? objectValue(requestBody, 'idempotency_key'),
    ),
  };
}
