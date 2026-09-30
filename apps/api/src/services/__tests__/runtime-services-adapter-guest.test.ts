import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildRuntimeServices } from '../runtime-services-adapter';

// Security M9 (2026-09-30): a guest runs a demo economy that settles off the
// ledger, so the runtime services built for a guest must refuse every ledger
// call. Non-ledger services keep working (learn/list/check-balance actions).
describe('runtime services guest ledger backstop (security M9)', () => {
  const db = Object.freeze({ test: 'No database calls' });
  const params = { avatarId: 'guest-avatar', amount: 30, reason: 'buy', source: 'shop', metadata: {} };

  test('guestDemo services refuse credit and debit without touching the ledger', async () => {
    const services = buildRuntimeServices(db, { actorKind: 'human', guestDemo: true });
    await expect(services.debitClawTokens(params)).rejects.toThrow(/guest_demo_economy/);
    await expect(services.creditClawTokens(params)).rejects.toThrow(/guest_demo_economy/);
    expect(services.db).toBe(db);
    expect(typeof services.recordCovenantAction).toBe('function');
  });

  test('guestDemo false keeps the live ledger functions', () => {
    const live = buildRuntimeServices(db, { actorKind: 'human', guestDemo: false });
    const guest = buildRuntimeServices(db, { actorKind: 'human', guestDemo: true });
    expect(live.debitClawTokens).not.toBe(guest.debitClawTokens);
    expect(live.debitClawTokens.toString()).toContain('ledgerDebitClawTokens');
  });

  test('location chat builds guest services from the canonical users.is_guest flag', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', 'routes', 'chat.ts'), 'utf8');
    const guestResolved = src.indexOf('const canonicalGuest = avatar ? await isGuestUser(user.id) : false');
    const servicesBuilt = src.indexOf("buildRuntimeServices(db, { actorKind: 'human', guestDemo: canonicalGuest })");
    expect(guestResolved).toBeGreaterThan(-1);
    expect(servicesBuilt).toBeGreaterThan(guestResolved);
  });
});
