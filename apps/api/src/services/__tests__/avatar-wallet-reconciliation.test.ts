import { describe, expect, test } from 'bun:test';
import {
  reconcileAvatarWallet,
  type AvatarWalletReconciliationAdapter,
  type AvatarWalletSnapshot,
  type CanonicalAvatarWallet,
} from '../avatar-wallet-reconciliation';

function harness(initial: {
  canonical: CanonicalAvatarWallet | null;
  mirrorAddress: string | null;
  valid?: boolean;
  raceWinner?: CanonicalAvatarWallet;
}) {
  let snapshot: AvatarWalletSnapshot = {
    avatarExists: true,
    canonical: initial.canonical,
    mirrorAddress: initial.mirrorAddress,
  };
  let creates = 0;
  let mirrorWrites = 0;
  const exceptions: string[] = [];

  const adapter: AvatarWalletReconciliationAdapter = {
    loadSnapshot: async () => structuredClone(snapshot),
    validateCanonical: async () => initial.valid ?? true,
    createValidatedCanonical: async (disclose) => {
      creates += 1;
      if (initial.raceWinner) {
        snapshot = { ...snapshot, canonical: initial.raceWinner };
        return { canonical: initial.raceWinner, inserted: false };
      }
      const canonical = {
        id: 'wallet-new',
        publicKey: 'canonical-new',
        custodyVerified: true,
      };
      snapshot = { ...snapshot, canonical };
      return {
        canonical,
        inserted: true,
        ...(disclose ? { firstTimeSecretKeyBase58: 'first-secret' } : {}),
      };
    },
    setCustodyVerified: async (walletId, verified) => {
      if (snapshot.canonical?.id === walletId) {
        snapshot.canonical = { ...snapshot.canonical, custodyVerified: verified };
      }
    },
    fillMirrorIfNull: async (address) => {
      if (snapshot.mirrorAddress === null) {
        mirrorWrites += 1;
        snapshot.mirrorAddress = address;
      }
      return snapshot.mirrorAddress === address ? 'equal' : 'mismatch';
    },
    trackException: (branch) => {
      exceptions.push(branch);
    },
  };

  return {
    adapter,
    state: () => structuredClone(snapshot),
    creates: () => creates,
    mirrorWrites: () => mirrorWrites,
    exceptions,
  };
}

describe('avatar wallet five-way promotion matrix', () => {
  test('1: valid canonical plus equal mirror promotes', async () => {
    const h = harness({
      canonical: { id: 'w1', publicKey: 'same', custodyVerified: false },
      mirrorAddress: 'same',
    });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    expect(result).toMatchObject({
      status: 'ready',
      branch: 'canonical-valid-mirror-equal',
      address: 'same',
    });
    expect(h.state().canonical?.custodyVerified).toBe(true);
    expect(h.mirrorWrites()).toBe(0);
  });

  test('2: valid canonical plus NULL mirror repairs NULL then promotes', async () => {
    const h = harness({
      canonical: { id: 'w2', publicKey: 'canonical', custodyVerified: false },
      mirrorAddress: null,
    });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    expect(result.branch).toBe('canonical-valid-mirror-null');
    expect(result.status).toBe('ready');
    expect(h.state().mirrorAddress).toBe('canonical');
    expect(h.mirrorWrites()).toBe(1);
  });

  test('3: non-null mismatch stays pending and never repoints the mirror', async () => {
    const h = harness({
      canonical: { id: 'w3', publicKey: 'canonical', custodyVerified: true },
      mirrorAddress: 'existing-mirror',
    });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    expect(result).toMatchObject({
      status: 'pending',
      branch: 'canonical-valid-mirror-mismatch',
    });
    expect(h.state()).toMatchObject({
      mirrorAddress: 'existing-mirror',
      canonical: { custodyVerified: false },
    });
    expect(h.mirrorWrites()).toBe(0);
  });

  test('4: absent canonical plus NULL mirror creates validated v2 winner and repairs NULL', async () => {
    const h = harness({ canonical: null, mirrorAddress: null });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: true });
    expect(result).toMatchObject({
      status: 'ready',
      branch: 'canonical-absent-mirror-null',
      address: 'canonical-new',
      inserted: true,
      firstTimeSecretKeyBase58: 'first-secret',
    });
    expect(h.creates()).toBe(1);
    expect(h.state().mirrorAddress).toBe('canonical-new');
  });

  test('5: mirror-only state stays pending without mint or repoint', async () => {
    const h = harness({ canonical: null, mirrorAddress: 'legacy-mirror' });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    expect(result).toMatchObject({
      status: 'pending',
      branch: 'canonical-absent-mirror-present',
    });
    expect(h.creates()).toBe(0);
    expect(h.state().mirrorAddress).toBe('legacy-mirror');
  });

  test('backfill rerun is idempotent and never creates or rewrites twice', async () => {
    const h = harness({ canonical: null, mirrorAddress: null });
    await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    const rerun = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    expect(rerun.branch).toBe('canonical-valid-mirror-equal');
    expect(h.creates()).toBe(1);
    expect(h.mirrorWrites()).toBe(1);
  });

  test('decrypt or public-key validation failure demotes and stays pending', async () => {
    const h = harness({
      canonical: { id: 'w-invalid', publicKey: 'canonical', custodyVerified: true },
      mirrorAddress: 'canonical',
      valid: false,
    });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: false });
    expect(result).toMatchObject({ status: 'pending', branch: 'canonical-invalid' });
    expect(h.state().canonical?.custodyVerified).toBe(false);
    expect(h.exceptions).toEqual(['canonical-invalid']);
  });

  test('unique-race loser reconciles the winner and never discloses its generated secret', async () => {
    const winner = {
      id: 'wallet-winner',
      publicKey: 'winner-address',
      custodyVerified: true,
    };
    const h = harness({ canonical: null, mirrorAddress: null, raceWinner: winner });
    const result = await reconcileAvatarWallet(h.adapter, { apply: true, disclose: true });
    expect(result).toMatchObject({
      status: 'ready',
      branch: 'canonical-valid-mirror-null',
      address: 'winner-address',
      inserted: false,
    });
    expect(result).not.toHaveProperty('firstTimeSecretKeyBase58');
    expect(h.creates()).toBe(1);
    expect(h.state().mirrorAddress).toBe('winner-address');
  });
});
