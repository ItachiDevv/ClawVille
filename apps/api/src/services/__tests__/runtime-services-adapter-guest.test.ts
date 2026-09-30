import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realLedger from '../claw-token-ledger';

// Security M9 + Codex round 2 (2026-09-30): a guest runs a demo economy that
// settles off the ledger. The runtime ledger services now refuse a guest-owned
// avatar ON EVERY CALL (canonical users.is_guest), so no surface that builds the
// services can forget the guard. The real ledger is replaced by spies here.
const ledgerCalls: Array<{ fn: 'credit' | 'debit'; avatarId: string; tx: unknown }> = [];
mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: { avatarId: string }, tx?: unknown) => {
    ledgerCalls.push({ fn: 'credit', avatarId: input.avatarId, tx });
    return { balanceAfter: 1, ledgerId: 'l-credit' };
  },
  debitClawTokens: async (input: { avatarId: string }, tx?: unknown) => {
    ledgerCalls.push({ fn: 'debit', avatarId: input.avatarId, tx });
    return { balanceAfter: 0, ledgerId: 'l-debit' };
  },
}));

const { buildRuntimeServices } = await import('../runtime-services-adapter');

afterAll(() => {
  mock.module('../claw-token-ledger', () => realLedger);
});

/** Fake db/tx: answers the adapter's users.is_guest lookup per avatar id. */
function fakeDb(guestByAvatar: Record<string, boolean>) {
  const lookups: string[] = [];
  return {
    lookups,
    execute: async (query: { queryChunks?: unknown[] }) => {
      const id = (query.queryChunks ?? []).find((chunk) => typeof chunk === 'string') as string;
      lookups.push(id);
      return id in guestByAvatar ? [{ is_guest: guestByAvatar[id] }] : [];
    },
  };
}

const params = (avatarId: string) => ({ avatarId, amount: 30, reason: 'buy', source: 'shop', metadata: {} });

beforeEach(() => {
  ledgerCalls.length = 0;
});

describe('runtime services guest ledger backstop (security M9, decided in the adapter)', () => {
  test('every construction variant refuses a guest-owned avatar before the ledger', async () => {
    const db = fakeDb({ 'guest-avatar': true });
    for (const services of [
      buildRuntimeServices(db),
      buildRuntimeServices(db, { actorKind: 'human' }),
      buildRuntimeServices(db, { actorKind: 'agent' }),
      buildRuntimeServices(db, { actorKind: null, doordash: {} }),
    ]) {
      await expect(services.debitClawTokens(params('guest-avatar'))).rejects.toThrow(/guest_demo_economy/);
      await expect(services.creditClawTokens(params('guest-avatar'))).rejects.toThrow(/guest_demo_economy/);
    }
    expect(ledgerCalls).toHaveLength(0);
  });

  test('a real account reaches the ledger, with the caller tx forwarded (atomic BUY_ITEM)', async () => {
    const db = fakeDb({ 'real-avatar': false });
    const tx = fakeDb({ 'real-avatar': false });
    const services = buildRuntimeServices(db, { actorKind: 'human' });

    await services.debitClawTokens(params('real-avatar'), tx);
    await services.creditClawTokens(params('real-avatar'));

    expect(ledgerCalls).toEqual([
      { fn: 'debit', avatarId: 'real-avatar', tx },
      { fn: 'credit', avatarId: 'real-avatar', tx: undefined },
    ]);
    // The guest lookup runs on the same connection as the write.
    expect(tx.lookups).toEqual(['real-avatar']);
    expect(db.lookups).toEqual(['real-avatar']);
  });

  test('an id that is not an avatar is left to the ledger (it refuses unknown avatars)', async () => {
    const services = buildRuntimeServices(fakeDb({}), { actorKind: 'agent' });
    await services.debitClawTokens(params('openclaw-bot-id'));
    expect(ledgerCalls).toEqual([{ fn: 'debit', avatarId: 'openclaw-bot-id', tx: undefined }]);
  });
});
