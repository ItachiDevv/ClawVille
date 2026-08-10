/**
 * Quest-board restore state machine (2026-07-29) — regression tests for the
 * Codex adversarial findings on the restore hotfix:
 *
 *   R1-B1: NO store write may happen pre-hydration (zustand persist writes
 *          localStorage on EVERY set(), so a pre-hydration write clobbers
 *          the un-read blob — the original silent wipe vector).
 *   R1-B2: a response is applied ONLY when its server-echoed userId matches
 *          the account the sync started for (mid-flight cookie switch).
 *   R2-B1: a store reset must NOT cancel a pending post-hydration apply —
 *          the watcher's own reconcile resets a stale foreign blob BEFORE
 *          the pending apply for the CURRENT account fires in the same
 *          hydration pass; the apply's owner guard is what makes stale
 *          applies safe.
 *   R2-SF1: duplicate sync calls for the same account share the SAME
 *          in-flight promise (restore-before-sweep sequencing).
 *
 * Tests in this file are ORDER-DEPENDENT: persist hydration is one-way
 * (hasHydrated never resets), so the pre-hydration scenario runs first.
 */

import { describe, it, expect } from 'bun:test';

// localStorage shim — must exist before the store module is imported.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

const PERSIST_KEY = 'clawville-quest-progress';

// Seed a STALE FOREIGN blob (another account's progress) before the store
// module loads — the exact shape the 2026-07-29 incident begins from.
backing.set(
  PERSIST_KEY,
  JSON.stringify({
    state: {
      progress: {},
      counters: { booksBought: 7 },
      distinct: {},
      serverClaimed: {},
      ownerUserId: 'stale-user',
    },
    version: 3,
  }),
);

const { useQuestStore, syncTutorialClaimsFromServer } = await import('../quest');
const { api } = await import('@/lib/api');
const { QUEST_DEFINITIONS } = await import('@/lib/quests');

// Mutable fetch mock + call counter.
let fetchCount = 0;
let mockImpl: () => Promise<unknown> = () =>
  Promise.resolve({ ok: true, userId: 'nobody', claims: [] });
(api as Record<string, unknown>).getTutorialQuestClaims = () => {
  fetchCount += 1;
  return mockImpl();
};

const root = QUEST_DEFINITIONS.find((q) => q.prerequisites.length === 0)!;
const child = QUEST_DEFINITIONS.find(
  (q) =>
    q.prerequisites.length > 0 && q.prerequisites.every((p) => p === root.id),
);
const otherRoot = QUEST_DEFINITIONS.filter(
  (q) => q.prerequisites.length === 0 && q.id !== root.id,
)[0]!;
const CLAIMED_AT = '2026-07-01T00:00:00.000Z';

describe('quest-board restore state machine', () => {
  it('pre-hydration: sync never writes the store, and the pending apply SURVIVES the watcher reset (R1-B1 + R2-B1)', async () => {
    expect(useQuestStore.persist.hasHydrated()).toBe(false);

    // Simulate the watcher's reconcile listener — registered FIRST, exactly
    // as in production (auth resolves before the sync fetch returns): at
    // hydration it finds the stale foreign blob, resets, and stamps the
    // resolved account.
    const unsubWatcherSim = useQuestStore.persist.onFinishHydration(() => {
      const s = useQuestStore.getState();
      if (s.ownerUserId !== null && s.ownerUserId !== 'acc1') {
        s.resetQuestStore();
      }
      useQuestStore.getState().setQuestOwner('acc1');
    });

    mockImpl = () =>
      Promise.resolve({
        ok: true,
        userId: 'acc1',
        claims: [{ questId: root.id, claimedAt: CLAIMED_AT }],
      });
    await syncTutorialClaimsFromServer('acc1');

    // R1-B1: nothing wrote through — the un-read blob is intact.
    expect(JSON.parse(backing.get(PERSIST_KEY)!).state.ownerUserId).toBe(
      'stale-user',
    );
    expect(useQuestStore.getState().progress[root.id]?.status).not.toBe(
      'completed',
    );

    await useQuestStore.persist.rehydrate();

    // R2-B1: the watcher reset ran first (stale blob → defaults → owner
    // acc1), and the pending apply STILL fired afterwards.
    const s = useQuestStore.getState();
    expect(s.ownerUserId).toBe('acc1');
    expect(s.progress[root.id]?.status).toBe('completed');
    expect(s.serverClaimed[root.id]).toBe(true);
    // The foreign blob's counters did not leak through the reset.
    expect(s.counters.booksBought).toBe(0);
    // Unlock cascade: a quest gated only on the restored root is active.
    if (child) expect(s.progress[child.id]?.status).toBe('active');
    unsubWatcherSim();
  });

  it('rejects a response whose server-echoed userId differs from the sync target, and clears the dedup marker (R1-B2)', async () => {
    const before = fetchCount;
    mockImpl = () =>
      Promise.resolve({
        ok: true,
        userId: 'someone-else',
        claims: [{ questId: otherRoot.id, claimedAt: CLAIMED_AT }],
      });
    await syncTutorialClaimsFromServer('acc2');
    expect(fetchCount).toBe(before + 1);
    expect(useQuestStore.getState().progress[otherRoot.id]?.status).not.toBe(
      'completed',
    );

    // Marker was cleared on the mismatch → the same account can re-sync.
    // This time the subject matches but the stamped owner is still acc1 —
    // the owner guard must block the apply.
    mockImpl = () =>
      Promise.resolve({
        ok: true,
        userId: 'acc2',
        claims: [{ questId: otherRoot.id, claimedAt: CLAIMED_AT }],
      });
    await syncTutorialClaimsFromServer('acc2');
    expect(fetchCount).toBe(before + 2);
    expect(useQuestStore.getState().progress[otherRoot.id]?.status).not.toBe(
      'completed',
    );
  });

  it('duplicate sync calls for one account share the same in-flight promise (R2-SF1)', async () => {
    const before = fetchCount;
    let release!: (v: unknown) => void;
    mockImpl = () => new Promise((resolve) => (release = resolve));
    const p1 = syncTutorialClaimsFromServer('acc3');
    const p2 = syncTutorialClaimsFromServer('acc3');
    expect(p2).toBe(p1);
    expect(fetchCount).toBe(before + 1);
    release({ ok: true, userId: 'acc3', claims: [] });
    await p1;
  });

  it('a reset clears the dedup marker so the SAME account re-syncs and re-applies after re-login', async () => {
    const before = fetchCount;
    useQuestStore.getState().resetQuestStore(); // logout/expiry wipe
    useQuestStore.getState().setQuestOwner('acc3'); // re-login, watcher stamp
    mockImpl = () =>
      Promise.resolve({
        ok: true,
        userId: 'acc3',
        claims: [{ questId: root.id, claimedAt: CLAIMED_AT }],
      });
    await syncTutorialClaimsFromServer('acc3');
    expect(fetchCount).toBe(before + 1);
    const s = useQuestStore.getState();
    expect(s.progress[root.id]?.status).toBe('completed');
    expect(s.serverClaimed[root.id]).toBe(true);
    // And the restore persisted through to localStorage for the next load.
    const blob = JSON.parse(backing.get(PERSIST_KEY)!);
    expect(blob.state.progress[root.id]?.status).toBe('completed');
    expect(blob.state.ownerUserId).toBe('acc3');
  });
});
