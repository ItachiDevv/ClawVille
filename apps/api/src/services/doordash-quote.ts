import { createHash } from 'node:crypto';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function identity(value: unknown): boolean {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('quote identity exceeds depth limit');
  // Unknown vendor arrays may be ordered (for example [latitude, longitude]).
  // Preserve all array order; an extra fresh preview is safer than false equality.
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  const record = object(value);
  if (record) return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hash raw vendor identity BEFORE Zod removes unknown option fields. Only the
 * digest survives; raw items and addresses never leave the CLI boundary.
 * Observed paths: dd transcript 2986 (line/item IDs), 4211 (store ID), and
 * docs/ddcli-help/order-preview.txt (quantity, fulfillment, destination).
 * Keep complete line identity, including unknown nested option representations.
 * Quote ETA, price breakdown, promotions, and formatting are not identity.
 */
export function fingerprintDoordashQuote(value: unknown): string | null {
  const root = object(value);
  const quote = object(root?.quote);
  const cart = object(quote?.store_order_cart);
  const store = object(cart?.store);
  if (!identity(root?.cart_uuid) || !identity(store?.id)) return null;
  const pickup = cart?.is_consumer_pickup;
  if (typeof pickup !== 'boolean') return null;
  if (cart?.fulfillment_type !== undefined
    && cart.fulfillment_type !== (pickup ? 'PICKUP' : 'DELIVERY')) return null;
  const address = object(quote?.delivery_address);
  if (!pickup && (!address || typeof address.printable_address !== 'string' || !address.printable_address.trim())) return null;
  if (!Array.isArray(cart?.orders) || cart.orders.length === 0) return null;
  const lines: Record<string, unknown>[] = [];
  for (const order of cart.orders) {
    const items = object(order)?.order_items;
    if (!Array.isArray(items) || items.length === 0) return null;
    for (const raw of items) {
      const line = object(raw);
      const item = object(line?.item);
      if (!line || !identity(line.id) || !identity(item?.id)
        || !Number.isSafeInteger(line.quantity) || Number(line.quantity) <= 0) return null;
      // These price fields vary independently of identity. The bridge compares
      // the authoritative total separately, including a change to a lower price.
      const { unit_price_monetary_fields: _formattedPrice, unit_price: _unitPrice,
        price: _price, ...lineIdentity } = line;
      lines.push(lineIdentity);
    }
  }
  try {
    return createHash('sha256').update(canonical({ version: 1, cart: root!.cart_uuid,
      store: store!.id, pickup, address: pickup ? null : address, lines })).digest('hex');
  } catch { return null; }
}
