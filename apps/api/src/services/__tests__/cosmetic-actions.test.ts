/**
 * services/cosmetic-actions.ts — the context-free cosmetic buy/equip logic
 * shared by the REST routes and the hosted-agent `[ACTION:]` verbs
 * (2026-10-22 quests wire). Pins: the failure contract (body = JSON response,
 * no body = the old HTTPException), the guest and ledger-capability gates,
 * the idempotent replays (no ledger call, no event), the ledger writes and the
 * single `cosmetic.purchased` event, and the USDC-rail event recorder.
 *
 * Every mock is leak-guarded (`intercept`) and spreads the real module, so
 * later files in a shared bun process keep real behavior.
 */

const HEX32 = '0'.repeat(64);
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = HEX32;
const databaseUrlWasSet = !!process.env.DATABASE_URL;
if (!databaseUrlWasSet) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';
import * as realEventLogger from '../event-logger';
import * as realLedger from '../claw-token-ledger';
import * as realTreasury from '../house-treasury-seeder';
import * as realBonus from '../cosmetic-signup-bonus';
import * as realNonGuest from '../../middleware/require-non-guest';

let intercept = true;
afterAll(() => {
  intercept = false;
});

// Originals captured BEFORE mock.module patches the namespaces in place.
const REAL_logEvent = realEventLogger.logEvent;
const REAL_debit = realLedger.debitClawTokens;
const REAL_credit = realLedger.creditClawTokens;
const REAL_treasury = realTreasury.getHouseTreasuryAvatarId;
const REAL_bonus = realBonus.spendCosmeticBonusInTx;
const REAL_isGuest = realNonGuest.isGuestUser;

type Row = Record<string, unknown>;
const SKU_ID = 'c0c0c0c0-0000-4000-8000-000000000001';
const baseSku = () => ({
  id: SKU_ID,
  slug: 'kelp-cape',
  category: 'cape',
  priceCt: 300,
  exclusiveCurrency: null as string | null,
  availableFrom: null as Date | null,
  availableUntil: null as Date | null,
  supplyCap: null as number | null,
  soldCount: 0,
});

// ── programmable state ──────────────────────────────────────────────────────
let avatarRow: Row | undefined;
let skuRow: Row | undefined;
/** select(...).from().where().limit() results, one per call (findOwnedSkin). */
let selectQueue: Row[][] = [];
/** grant insert behavior: rows (fresh), [] (conflict), or throw. */
let grantInsert: () => Row[] = () => [{ id: 'skin-new' }];
let equipRows: Row[] = [];
let guestUsers = new Set<string>();
let bonusUsed = 0;
let treasuryId: string | null = 'treasury-avatar';
let debitImpl: (input: realLedger.LedgerDebitInput) => Promise<unknown> = async () => ({
  ledgerId: 'ledger-1',
  balanceAfter: 700,
});
const ledgerCalls: Array<{ op: 'debit' | 'credit'; input: Row }> = [];
const logged: realEventLogger.EventInput[] = [];
let txRan = 0;

const fakeTx = {
  insert: (_t: unknown) => ({
    values: (_v: Row) => ({
      onConflictDoNothing: (_o: unknown) => ({ returning: async (_s: unknown) => grantInsert() }),
    }),
  }),
  select: (_s: unknown) => ({
    from: (_t: unknown) => ({
      where: (_w: unknown) => ({ limit: async (_n: number) => selectQueue.shift() ?? [] }),
    }),
  }),
};

const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  query: {
    ...(realDatabase as unknown as { db: { query: Record<string, unknown> } }).db.query,
    avatars: { findFirst: async (_o: unknown) => avatarRow },
    cosmeticSkus: { findFirst: async (_o: unknown) => skuRow },
  },
  select: fakeTx.select,
  update: (_t: unknown) => ({
    set: (values: { equipped: boolean }) => ({
      where: (_w: unknown) => ({
        returning: async () => equipRows.map((r) => ({ ...r, equipped: values.equipped })),
      }),
    }),
  }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    txRan += 1;
    return fn(fakeTx);
  },
};
const DELEGATE_DB = (realDatabase as unknown as { db: Record<string, unknown> }).db;
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (t, p, r) => (intercept ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB)),
  }),
}));

mock.module('../event-logger', () => ({
  ...realEventLogger,
  logEvent: async (input: realEventLogger.EventInput) => {
    if (!intercept) return REAL_logEvent(input);
    logged.push(input);
  },
}));
mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  debitClawTokens: async (input: realLedger.LedgerDebitInput, tx?: unknown) => {
    if (!intercept) return REAL_debit(input, tx as never);
    ledgerCalls.push({ op: 'debit', input: input as unknown as Row });
    return debitImpl(input);
  },
  creditClawTokens: async (input: realLedger.LedgerCreditInput, tx?: unknown) => {
    if (!intercept) return REAL_credit(input, tx as never);
    ledgerCalls.push({ op: 'credit', input: input as unknown as Row });
    return { ledgerId: 'ledger-credit', balanceAfter: 0 };
  },
}));
mock.module('../house-treasury-seeder', () => ({
  ...realTreasury,
  getHouseTreasuryAvatarId: async () => (intercept ? treasuryId : REAL_treasury()),
}));
mock.module('../cosmetic-signup-bonus', () => ({
  ...realBonus,
  spendCosmeticBonusInTx: async (tx: never, userId: string, max: number) =>
    intercept ? Math.min(bonusUsed, max) : REAL_bonus(tx, userId, max),
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realNonGuest,
  isGuestUser: async (userId: string) => (intercept ? guestUsers.has(userId) : REAL_isGuest(userId)),
}));

const actions = await import('../cosmetic-actions');
if (!databaseUrlWasSet) delete process.env.DATABASE_URL;

const human: import('../cosmetic-actions').CosmeticActor = {
  kind: 'user',
  userId: 'user-1',
  avatarId: 'avatar-1',
  agentId: null,
};
const agent: import('../cosmetic-actions').CosmeticActor = {
  kind: 'agent',
  userId: 'owner-1',
  avatarId: 'agent-avatar-1',
  agentId: 'oc-agent-1',
  ledgerCapable: true,
};

beforeEach(() => {
  avatarRow = { id: 'avatar-1', clawTokens: 1000, isActive: true };
  skuRow = baseSku();
  selectQueue = [[]]; // pre-tx findOwnedSkin: not owned
  grantInsert = () => [{ id: 'skin-new' }];
  equipRows = [{ id: 'skin-1' }];
  guestUsers = new Set();
  bonusUsed = 0;
  treasuryId = 'treasury-avatar';
  debitImpl = async () => ({ ledgerId: 'ledger-1', balanceAfter: 700 });
  ledgerCalls.length = 0;
  logged.length = 0;
  txRan = 0;
});

const purchased = () => logged.filter((e) => e.eventType === 'cosmetic.purchased');

describe('buyCosmeticForActor', () => {
  it('fresh buy: debits the buyer, credits the treasury, grants, logs ONE cosmetic.purchased', async () => {
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID }, { fpHash: 'fp-1', ipPrefixHash: 'ip-1' });
    expect(out).toEqual({
      ok: true,
      body: { ok: true, alreadyOwned: false, avatarSkinId: 'skin-new', clawTokens: 700, bonusApplied: 0 },
    });
    expect(ledgerCalls.map((c) => c.op)).toEqual(['debit', 'credit']);
    expect(ledgerCalls[0]!.input).toMatchObject({
      avatarId: 'avatar-1',
      amount: 300,
      reason: 'buy_cosmetic',
      actorKind: 'human',
    });
    expect(ledgerCalls[1]!.input).toMatchObject({
      avatarId: 'treasury-avatar',
      amount: 300,
      reason: 'house_fee_cosmetic_purchase',
    });
    expect(purchased()).toHaveLength(1);
    expect(purchased()[0]).toMatchObject({
      userId: 'user-1',
      avatarId: 'avatar-1',
      fpHash: 'fp-1',
      ipPrefixHash: 'ip-1',
      payload: { skuId: SKU_ID, pricePaid: 300, bonusApplied: 0, realCtCharged: 300, balanceAfter: 700, subjectKind: 'user' },
    });
  });

  it('agent actor: debit is tagged agent, and an omitted meta leaves the row untagged', async () => {
    avatarRow = { id: 'agent-avatar-1', clawTokens: 1000, isActive: true };
    const out = await actions.buyCosmeticForActor(agent, { skuId: SKU_ID, variantId: null });
    expect(out.ok).toBe(true);
    expect(ledgerCalls[0]!.input).toMatchObject({ avatarId: 'agent-avatar-1', actorKind: 'agent' });
    expect(purchased()).toHaveLength(1);
    expect(purchased()[0]).toMatchObject({ userId: 'owner-1', avatarId: 'agent-avatar-1', fpHash: null, ipPrefixHash: null, payload: { subjectKind: 'agent' } });
  });

  it('a bonus-funded buy debits only the real-CT remainder', async () => {
    bonusUsed = 120;
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out.ok && out.body.bonusApplied).toBe(120);
    expect(ledgerCalls.map((c) => c.input.amount)).toEqual([180, 180]);
    expect(purchased()[0]?.payload).toMatchObject({ bonusApplied: 120, realCtCharged: 180 });
  });

  it('refuses a guest owner with the requireNonGuestIdentity JSON, before any read', async () => {
    guestUsers.add('owner-1');
    const out = await actions.buyCosmeticForActor(agent, { skuId: SKU_ID });
    expect(out).toEqual({
      ok: false,
      status: 403,
      code: 'guest_not_allowed',
      message: 'Guests run a demo economy. Create a free account to use this feature.',
      body: {
        error: 'Guests run a demo economy. Create a free account to use this feature.',
        code: 'guest_not_allowed',
      },
    });
    expect(txRan).toBe(0);
    expect(ledgerCalls).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('refuses an agent actor that is not ledger-capable (fail closed when omitted)', async () => {
    const { ledgerCapable: _omit, ...unproven } = agent;
    const out = await actions.buyCosmeticForActor(unproven, { skuId: SKU_ID });
    expect(out).toMatchObject({ ok: false, status: 403, code: 'agent_session_not_ledger_authorized' });
    expect(out.ok === false && out.body).toBeFalsy();
    expect(txRan).toBe(0);
  });

  it('already owned: returns the replay body, zero ledger calls, zero events', async () => {
    selectQueue = [[{ id: 'skin-old', equipped: true }]];
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out).toEqual({
      ok: true,
      body: { ok: true, alreadyOwned: true, avatarSkinId: 'skin-old', equipped: true, clawTokens: 1000 },
    });
    expect(txRan).toBe(0);
    expect(ledgerCalls).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('concurrent double-buy race: rolls back and answers alreadyOwned with equipped:false, no event', async () => {
    grantInsert = () => [];
    selectQueue = [[], [{ id: 'skin-winner', equipped: false }]];
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out).toEqual({
      ok: true,
      body: { ok: true, alreadyOwned: true, avatarSkinId: 'skin-winner', equipped: false, clawTokens: 1000 },
    });
    expect(logged).toEqual([]);
  });

  it('insufficient vCLAW: 400 without a body (the old HTTPException) and the exact message', async () => {
    debitImpl = async (input) => {
      throw new realLedger.InsufficientTokensError(input.avatarId, 50, input.amount);
    };
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out).toEqual({
      ok: false,
      status: 400,
      code: 'insufficient_tokens',
      message: 'Not enough vCLAW. Need 300, have 50.',
    });
    expect(logged).toEqual([]);
  });

  it('sold out at the insert boundary: 409 { error: "sold_out" }', async () => {
    grantInsert = () => {
      throw { code: '23514', constraint: 'cosmetic_skus_supply_cap_enforced' };
    };
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out).toMatchObject({ ok: false, status: 409, code: 'sold_out', body: { error: 'sold_out' } });
    expect(logged).toEqual([]);
  });

  it('sold out before the tx: the owner of the final unit still gets the replay body', async () => {
    skuRow = { ...baseSku(), supplyCap: 1, soldCount: 1 };
    selectQueue = [[{ ownershipCount: 1 }], [{ id: 'skin-last', equipped: false }]];
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out).toMatchObject({ ok: true, body: { alreadyOwned: true, avatarSkinId: 'skin-last' } });
    skuRow = { ...baseSku(), supplyCap: 1, soldCount: 1 };
    selectQueue = [[{ ownershipCount: 1 }], []];
    const other = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(other).toMatchObject({ ok: false, status: 409, body: { error: 'sold_out' } });
  });

  it('maps every SKU refusal to the old status and message, with no body', async () => {
    const cases: Array<[string, Row | undefined, number, string]> = [
      ['not-a-uuid', baseSku(), 400, 'Invalid skuId'],
      [SKU_ID, undefined, 404, 'Cosmetic not found'],
      [SKU_ID, { ...baseSku(), availableFrom: new Date(Date.now() + 60_000) }, 400, 'Not yet available'],
      [SKU_ID, { ...baseSku(), availableUntil: new Date(Date.now() - 60_000) }, 400, 'No longer available'],
      [SKU_ID, { ...baseSku(), exclusiveCurrency: 'SOL' }, 400, 'This item must be purchased with SOL.'],
    ];
    for (const [skuId, sku, status, message] of cases) {
      skuRow = sku;
      const out = await actions.buyCosmeticForActor(human, { skuId });
      expect(out).toMatchObject({ ok: false, status, message });
      expect(out.ok === false && out.body).toBeFalsy();
    }
    expect(txRan).toBe(0);
  });

  it('no active avatar: 404 without a body', async () => {
    avatarRow = undefined;
    const out = await actions.buyCosmeticForActor(human, { skuId: SKU_ID });
    expect(out).toEqual({ ok: false, status: 404, code: 'no_active_avatar', message: 'No active avatar found' });
  });
});

describe('setCosmeticEquippedForActor', () => {
  it('equips and logs cosmetic.equipped against the actor avatar', async () => {
    const out = await actions.setCosmeticEquippedForActor(agent, SKU_ID, true);
    expect(out).toEqual({ ok: true, equipped: true });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      eventType: 'cosmetic.equipped',
      userId: 'owner-1',
      avatarId: 'agent-avatar-1',
      payload: { skuId: SKU_ID, subjectKind: 'agent' },
    });
  });

  it('unequip logs cosmetic.unequipped only', async () => {
    const out = await actions.setCosmeticEquippedForActor(human, SKU_ID, false);
    expect(out).toEqual({ ok: true, equipped: false });
    expect(logged.map((e) => e.eventType)).toEqual(['cosmetic.unequipped']);
  });

  it('a guest may equip (no ledger involved)', async () => {
    guestUsers.add('user-1');
    const out = await actions.setCosmeticEquippedForActor(human, SKU_ID, true);
    expect(out).toEqual({ ok: true, equipped: true });
  });

  it('not owned: 404 with the route JSON body, no event', async () => {
    equipRows = [];
    const out = await actions.setCosmeticEquippedForActor(human, SKU_ID, true);
    expect(out).toMatchObject({
      ok: false,
      status: 404,
      code: 'not_owned',
      body: { ok: false, error: 'not_owned', message: 'You do not own this cosmetic.' },
    });
    expect(logged).toEqual([]);
  });

  it('malformed skuId: 400 without a body; unproven agent: 403', async () => {
    expect(await actions.setCosmeticEquippedForActor(human, 'nope', true)).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_sku_id',
      message: 'Invalid skuId',
    });
    const out = await actions.setCosmeticEquippedForActor({ ...agent, ledgerCapable: false }, SKU_ID, true);
    expect(out).toMatchObject({ ok: false, status: 403, code: 'agent_session_not_ledger_authorized' });
    expect(logged).toEqual([]);
  });
});

describe('recordUsdcCosmeticPurchaseInTx', () => {
  const input = {
    checkoutId: 'checkout-1',
    userId: 'user-1',
    avatarId: 'avatar-1',
    subjectKind: 'user' as const,
    skuId: SKU_ID,
    avatarSkinId: 'skin-usdc',
    priceVclaw: 500,
    usdCents: 500,
  };

  it('inserts one cosmetic.purchased (rail usdc, realCtCharged 0) inside a savepoint of the passed tx', async () => {
    const inserts: Row[] = [];
    let savepoints = 0;
    const sp = { insert: (_t: unknown) => ({ values: async (v: Row) => void inserts.push(v) }) };
    const tx = {
      transaction: async (fn: (s: typeof sp) => Promise<void>) => {
        savepoints += 1;
        await fn(sp);
      },
    };
    await actions.recordUsdcCosmeticPurchaseInTx(tx as never, input);
    expect(savepoints).toBe(1);
    expect(inserts).toEqual([
      {
        eventType: 'cosmetic.purchased',
        userId: 'user-1',
        avatarId: 'avatar-1',
        payload: {
          skuId: SKU_ID,
          avatarSkinId: 'skin-usdc',
          rail: 'usdc',
          checkoutId: 'checkout-1',
          subjectKind: 'user',
          pricePaid: 500,
          usdCents: 500,
          bonusApplied: 0,
          realCtCharged: 0,
        },
        fpHash: null,
        ipPrefixHash: null,
      },
    ]);
  });

  it('never throws when the savepoint insert fails (the paid grant must still settle)', async () => {
    const tx = {
      transaction: async () => {
        throw new Error('insert or update on table "events" violates foreign key constraint');
      },
    };
    await expect(actions.recordUsdcCosmeticPurchaseInTx(tx as never, input)).resolves.toBeUndefined();
  });
});
