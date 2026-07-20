import { describe, expect, test } from 'bun:test';
import {
  healLegacyFingerprintInTransaction,
  identityFingerprint,
  resolvePublicOnboardingIdentityWithStore,
  resolveOrCreateUserByIdentityWithStore,
} from '../identity-service';
import type { IdentityResolutionStore } from '../identity-service';

type StoredUser = Awaited<ReturnType<IdentityResolutionStore['findByFingerprint']>> & {
  id: string;
};

class MemoryIdentityStore implements IdentityResolutionStore {
  readonly rows = new Map<string, NonNullable<StoredUser>>();
  readonly legacyProbes: string[] = [];
  private nextId = 1;

  seed(fingerprint: string, id = `user-${this.nextId++}`): NonNullable<StoredUser> {
    const row = { id, email: null, name: `Agent ${id}`, identityFingerprint: fingerprint };
    this.rows.set(fingerprint, row);
    return row;
  }

  async findByFingerprint(fingerprint: string) {
    return this.rows.get(fingerprint);
  }

  async tryHealLegacyFingerprint(
    legacyFingerprints: readonly string[],
    newFingerprint: string,
  ) {
    return healLegacyFingerprintInTransaction(legacyFingerprints, newFingerprint, {
      findByFingerprint: async (fingerprint) => {
        if (legacyFingerprints.includes(fingerprint)) this.legacyProbes.push(fingerprint);
        return this.rows.get(fingerprint);
      },
      updateFingerprintIfMatches: async (input) => {
        // Yield after both concurrent callers have observed the same legacy row.
        // The map check below is the in-memory equivalent of the production
        // WHERE id = ? AND identity_fingerprint = ? guarded UPDATE.
        await Promise.resolve();
        const current = this.rows.get(input.legacyFingerprint);
        if (!current || current.id !== input.userId) return undefined;
        this.rows.delete(input.legacyFingerprint);
        const healed = { ...current, identityFingerprint: input.newFingerprint };
        this.rows.set(input.newFingerprint, healed);
        return healed;
      },
    });
  }

  async insert(input: { name: string; identityFingerprint: string }) {
    if (this.rows.has(input.identityFingerprint)) {
      throw Object.assign(new Error('unique violation'), { code: '23505' });
    }
    return this.seed(input.identityFingerprint);
  }
}

describe('identity fingerprint heal-on-reconnect', () => {
  test('a legacy nanoclaw key presented as custom heals the same user in probe order', async () => {
    const store = new MemoryIdentityStore();
    const key = 'same-secret';
    const victim = store.seed(identityFingerprint('nanoclaw', key), 'victim');

    const coordinated = await resolvePublicOnboardingIdentityWithStore('nanoclaw', key, store);
    const result = coordinated.user;

    expect(coordinated.identityType).toBe('custom');
    expect(result.id).toBe(victim.id);
    expect(result.isNewUser).toBe(false);
    expect(result.identityFingerprint).toBe(identityFingerprint('custom', key));
    expect(store.legacyProbes).toEqual([
      identityFingerprint('nanoclaw', key),
    ]);
  });

  test('different novel framework labels with the same key resolve one canonical custom account', async () => {
    const store = new MemoryIdentityStore();
    const key = 'one-general-secret';
    const first = await resolvePublicOnboardingIdentityWithStore(
      'futureclaw',
      key,
      store,
    );
    const second = await resolvePublicOnboardingIdentityWithStore(
      'reef_agent-v2',
      key,
      store,
    );

    expect(first.identityType).toBe('custom');
    expect(second.identityType).toBe('custom');
    expect(first.user.isNewUser).toBe(true);
    expect(second.user.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.identityFingerprint).toBe(identityFingerprint('custom', key));
    expect(store.rows.size).toBe(1);
  });

  test('the second reconnect hits the new fingerprint without a legacy probe', async () => {
    const store = new MemoryIdentityStore();
    const key = 'repeat-secret';
    store.seed(identityFingerprint('anonymous', key), 'returning');

    await resolveOrCreateUserByIdentityWithStore('openclaw', key, store);
    const probeCount = store.legacyProbes.length;
    const second = await resolveOrCreateUserByIdentityWithStore('openclaw', key, store);

    expect(second.id).toBe('returning');
    expect(second.isNewUser).toBe(false);
    expect(store.legacyProbes).toHaveLength(probeCount);
  });

  test('two concurrent heals converge on one user', async () => {
    const store = new MemoryIdentityStore();
    const key = 'concurrent-secret';
    store.seed(identityFingerprint('ironclaw', key), 'one-account');

    const [first, second] = await Promise.all([
      resolveOrCreateUserByIdentityWithStore('hermes', key, store),
      resolveOrCreateUserByIdentityWithStore('hermes', key, store),
    ]);

    expect(first.id).toBe('one-account');
    expect(second.id).toBe('one-account');
    expect(store.rows.size).toBe(1);
    expect(store.rows.has(identityFingerprint('hermes', key))).toBe(true);
  });

  test('a wrong key under every supported type never resolves the victim', async () => {
    const store = new MemoryIdentityStore();
    const victimKey = 'victim-secret';
    store.seed(identityFingerprint('nanoclaw', victimKey), 'victim');

    for (const type of ['milady', 'hermes', 'openclaw', 'custom']) {
      const result = await resolveOrCreateUserByIdentityWithStore(type, `wrong-${type}`, store);
      expect(result.id).not.toBe('victim');
      expect(result.isNewUser).toBe(true);
    }
    expect(store.rows.get(identityFingerprint('nanoclaw', victimKey))?.id).toBe('victim');
  });

  test('brand-new supported keys create fresh users without disturbing one another', async () => {
    const store = new MemoryIdentityStore();
    const ids = new Set<string>();

    for (const type of ['milady', 'hermes', 'openclaw', 'custom']) {
      const result = await resolveOrCreateUserByIdentityWithStore(type, `fresh-${type}`, store);
      expect(result.isNewUser).toBe(true);
      ids.add(result.id);
    }

    expect(ids.size).toBe(4);
  });

  test('partner-only identities never enter the legacy-probe path', async () => {
    const store = new MemoryIdentityStore();
    const result = await resolveOrCreateUserByIdentityWithStore('hatcher', 'partner-key', store);

    expect(result.isNewUser).toBe(true);
    expect(store.legacyProbes).toEqual([]);
  });
});
