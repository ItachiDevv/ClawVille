import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { fingerprintDoordashQuote } from '../doordash-quote';
import { DOORDASH_CAPS } from '../doordash-caps';

// Isolated-process suite: no database driver, network, or CLI process is loaded.
// The fake implements row predicates, not a scripted sequence of return values.
type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
const rows: Row[] = [];
const calls: string[] = [];
let basket = 'Garlic knots';
let failMutation = false;
let failInvalidation = false;
let submitCalls = 0;
let destination = 'Test address';
let options = 'option-a';
let previewPause: (() => Promise<void>) | null = null;
const columns = new Proxy({}, { get: (_target, name) => String(name) });
const fakeDb = {
  execute: async () => [{ count: rows.filter((r) => ['submitted', 'submitting', 'failed'].includes(String(r.status))).length,
    spent: rows.filter((r) => ['submitted', 'submitting', 'failed'].includes(String(r.status)))
      .reduce((sum, r) => sum + Number(r.totalCents) + Number(r.tipCents ?? 0), 0) }],
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
  update: () => ({ set: (patch: Row) => ({ where: async (predicate: Predicate) => {
    if (failInvalidation && patch.failureCode === 'cart_changed') throw new Error('durable invalidation unavailable');
    for (const row of rows.filter(predicate)) Object.assign(row, patch);
  } }) }),
  insert: () => ({ values: async (row: Row) => {
    rows.push({ id: `row-${rows.length + 1}`, previewedAt: new Date(), tipCents: 0, ...row });
  } }),
  select: () => ({ from: () => ({ where: (predicate: Predicate) => {
    const result = { limit: async (count: number) => rows.filter(predicate).slice(0, count), for: (_mode: string) => result };
    return result;
  } }) }),
};
mock.module('@clawville/database', () => ({
  db: fakeDb, doordashOrders: columns,
  eq: (column: string, value: unknown): Predicate => (row) => row[column] === value,
  and: (...predicates: Predicate[]): Predicate => (row) => predicates.every((p) => p(row)),
  sql: () => ({}),
}));
mock.module('../alert-error', () => ({ alertError: async () => {}, sendTelegramText: async () => {} }));
mock.module('../doordash-cli', () => ({
  isDoordashAvailable: () => true,
  runDdCli: async (operation: string, args: string[]) => {
    calls.push(operation);
    if (operation === 'order-preview') {
      const data = { cart_uuid: args[0], quote: { total_before_tip: { unit_amount: 1500 },
        delivery_address: { printable_address: destination },
        store_order_cart: { is_consumer_pickup: false, store: { id: 'store', name: 'Test store' },
          orders: [{ order_items: [{ id: 'line-1', quantity: 1, item: { id: basket, name: basket }, nested_options: [{ id: options }] }] }] } } };
      if (previewPause) await previewPause();
      return { ok: true, durationMs: 0, data: { ...data, quoteFingerprint: fingerprintDoordashQuote(data) } };
    }
    if (operation === 'order-submit') {
      submitCalls++;
      return { ok: true, durationMs: 0, data: { order_uuid: 'test-order', processing_status: '' } };
    }
    if (operation === 'cart-add' || operation === 'cart-remove') {
      if (failMutation) return { ok: false, durationMs: 0, failure: 'ddcli_timeout', detail: 'unknown write result' };
      basket = 'Equal-price replacement';
      return { ok: true, durationMs: 0, data: { cart_uuid: 'cart-1', item_error_count: 0,
        cart: { items: [{ id: 'line-1', name: basket, quantity: 1 }] } } };
    }
    throw new Error(`Unmocked CLI operation: ${operation}`);
  },
}));
const { buildDoordashBridge } = await import('../doordash-operator');
const { resetDoordashContexts } = await import('../doordash-session');
const human = { userId: 'operator', avatarId: 'avatar', kind: 'human' as const, canSubmit: true };
const agent = { ...human, kind: 'agent' as const, canSubmit: false, agentSessionId: 'agent-session' };

beforeEach(() => {
  rows.length = 0; calls.length = 0; basket = 'Garlic knots';
  failMutation = false; failInvalidation = false; submitCalls = 0;
  destination = 'Test address'; options = 'option-a'; previewPause = null;
  resetDoordashContexts();
});
async function quote() {
  const result = await buildDoordashBridge(human, 'price it').preview({ cartUuid: 'cart-1' });
  if (!result.ok) throw new Error(result.failure);
  return result.data.confirmCode;
}
function submit(code: string, turn = `${code} tip 4`, tipCents = 400) {
  return buildDoordashBridge(human, turn).submit({ confirm: code, tipCents });
}
describe('DoorDash confirmation binds human authorization to the current cart', () => {
  test('independent review: an expired preview never reaches vendor repricing or submit', async () => {
    const code = await quote();
    rows[0].previewedAt = new Date(Date.now() - DOORDASH_CAPS.previewTtlMs - 1);
    calls.length = 0;
    expect((await submit(code)).ok).toBe(false);
    expect(calls).not.toContain('order-preview');
    expect(submitCalls).toBe(0);
  });
  test('independent review: preview expiry during repricing prevents submit', async () => {
    const code = await quote();
    previewPause = async () => {
      rows[0].previewedAt = new Date(Date.now() - DOORDASH_CAPS.previewTtlMs - 1);
    };
    expect((await submit(code)).ok).toBe(false);
    expect(rows[0].failureCode).toBe('expired');
    expect(submitCalls).toBe(0);
  });
  test('independent review: an agent cannot submit a human code', async () => {
    const code = await quote();
    const result = await buildDoordashBridge(agent, `${code} tip 4`).submit({ confirm: code, tipCents: 400 });
    expect(result.ok).toBe(false);
    expect(submitCalls).toBe(0);
    expect(rows[0].status).toBe('previewed');
  });
  test('independent review: pending and ambiguous submits consume the daily order cap', async () => {
    const code = await quote();
    rows.push({ id: 'pending-charge', status: 'submitting', totalCents: 1500, tipCents: 0 });
    rows.push({ id: 'unknown-charge', status: 'failed', totalCents: 1500, tipCents: 0 });
    expect((await submit(code)).ok).toBe(false);
    expect(rows[0].failureCode).toBe('cap_exceeded');
    expect(submitCalls).toBe(0);
  });
  test('independent review: tip participates in the per-order cap', async () => {
    const code = await quote();
    const tip = DOORDASH_CAPS.maxOrderCents - 1500 + 1;
    expect((await submit(code, `${code} tip ${tip} cents`, tip)).ok).toBe(false);
    expect(rows[0].failureCode).toBe('cap_exceeded');
    expect(submitCalls).toBe(0);
  });
  test('independent review: a prior charge plus this charge cannot exceed the daily dollar cap', async () => {
    const code = await quote();
    rows.push({ id: 'prior-charge', status: 'submitted', totalCents: DOORDASH_CAPS.dailySpendCents - 1899, tipCents: 0 });
    expect((await submit(code)).ok).toBe(false);
    expect(rows[0].failureCode).toBe('cap_exceeded');
    expect(submitCalls).toBe(0);
  });
  test('equal-price agent cart removal invalidates the human quote', async () => {
    const code = await quote();
    await buildDoordashBridge(agent, 'remove item').cartRemove({ cartUuid: 'cart-1', lineId: 'line-1' });
    const result = await submit(code);
    expect(result.ok).toBe(false);
    expect(submitCalls).toBe(0);
  });
  test('equal-price item addition invalidates a prior quote', async () => {
    const code = await quote();
    await buildDoordashBridge(human, 'add item').cartAdd({ storeId: 'store', menuId: 'menu', itemId: 'item', cartUuid: 'cart-1', quantity: 1 });
    expect((await submit(code)).ok).toBe(false);
    expect(submitCalls).toBe(0);
  });
  test('an item quantity cannot authorize a tip', async () => {
    const code = await quote();
    expect((await submit(code, `${code} add 4 garlic knots`, 400)).ok).toBe(false);
    expect(submitCalls).toBe(0);
  });
  test('dollar text cannot authorize the same numeric value in cents', async () => {
    const code = await quote();
    expect((await submit(code, `${code} tip 4`, 4)).ok).toBe(false);
    expect(submitCalls).toBe(0);
  });
  test('explicit dollar tip and an unchanged quote submit once', async () => {
    const code = await quote();
    expect((await submit(code)).ok).toBe(true);
    expect((await submit(code)).ok).toBe(false);
    expect(submitCalls).toBe(1);
  });
  test.each(['basket', 'destination', 'options'])('external %s drift with the same total requires a fresh quote', async (changed) => {
    const code = await quote();
    if (changed === 'basket') basket = 'Other item';
    if (changed === 'destination') destination = 'Other address';
    if (changed === 'options') options = 'option-b';
    expect((await submit(code)).ok).toBe(false);
    expect(submitCalls).toBe(0);
  });
  test('a legacy preview without fingerprint is refused without changing submitted history', async () => {
    const code = await quote();
    rows[0].quoteFingerprint = null;
    rows.push({ id: 'historic', status: 'submitted', quoteFingerprint: null });
    expect((await submit(code)).ok).toBe(false);
    expect(rows[0].status).toBe('refused');
    expect(rows[1].status).toBe('submitted');
    expect(submitCalls).toBe(0);
  });
  test('a timed-out cart write still revokes the earlier confirmation', async () => {
    const code = await quote(); failMutation = true;
    await buildDoordashBridge(agent, 'remove item').cartRemove({ cartUuid: 'cart-1', lineId: 'line-1' });
    expect((await submit(code)).ok).toBe(false);
    expect(submitCalls).toBe(0);
  });
  test('failed durable invalidation prevents the cart write', async () => {
    await quote(); failInvalidation = true;
    await expect(buildDoordashBridge(agent, 'remove item').cartRemove({ cartUuid: 'cart-1', lineId: 'line-1' }))
      .rejects.toThrow('durable invalidation unavailable');
    expect(calls).not.toContain('cart-remove');
  });
  test('two concurrent confirmations spend once', async () => {
    const code = await quote();
    const results = await Promise.all([submit(code), submit(code)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(submitCalls).toBe(1);
  });
  test('cart write cannot interleave between submit re-price and charge', async () => {
    const code = await quote();
    let resume!: () => void;
    let reached!: () => void;
    const atReprice = new Promise<void>((resolve) => { reached = resolve; });
    const resumeReprice = new Promise<void>((resolve) => { resume = resolve; });
    previewPause = async () => { reached(); await resumeReprice; };
    const charge = submit(code);
    await atReprice;
    const mutation = buildDoordashBridge(agent, 'remove item').cartRemove({ cartUuid: 'cart-1', lineId: 'line-1' });
    await Promise.resolve();
    expect(calls).not.toContain('cart-remove');
    resume();
    expect((await charge).ok).toBe(true);
    await mutation;
    expect(calls.indexOf('order-submit')).toBeLessThan(calls.indexOf('cart-remove'));
  });
});
