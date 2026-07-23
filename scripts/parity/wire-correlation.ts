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
    const coup = record.coupId
      ?? stringValue(findDeep(body, new Set(['coupId', 'coup_id'])));
    return coup === root.correlation.hand;
  }

  const hand = record.handId
    ?? stringValue(findDeep(body, new Set(['handId', 'hand_id'])));
  if (!root.surface.endsWith('-3d')) {
    return hand === root.correlation.hand;
  }

  if (root.correlation.handNumber !== null) {
    const handNumber = record.handNumber
      ?? numeric(findDeep(body, new Set(['handNumber', 'handIndex', 'hand_number'])));
    const tableId = stringValue(findDeep(body, new Set(['tableId', 'table_id'])))
      ?? /poker\/cash\/tables\/([^/?]+)/.exec(record.urlSuffix)?.[1]
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
    .sort((a, b) => endpointWeight(root, b) - endpointWeight(root, a));
  return matches[0] ?? null;
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
