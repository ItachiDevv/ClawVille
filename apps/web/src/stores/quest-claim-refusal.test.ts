import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';

// The reward sweep re-POSTed every refused serverOnly quest on every /game
// load: staging 18de236e, account landtest1, four HTTP 400
// engagement_required per load (2026-10-02). A server refusal is now
// remembered per account + quest in sessionStorage for
// TUTORIAL_CLAIM_REFUSAL_COOLDOWN_MS. The silent sweep skips it; a claim the
// player starts (non-silent) always asks the server.

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function mapStorage(backing: Map<string, string>): Storage {
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

// The store binds its persist storage when the module loads.
define('localStorage', mapStorage(new Map()));

const { useQuestStore, retryUnclaimedRewards, triggerQuestCheck, TUTORIAL_CLAIM_REFUSAL_COOLDOWN_MS } =
  await import('./quest');
const { api } = await import('@/lib/api');

const COOLDOWN = TUTORIAL_CLAIM_REFUSAL_COOLDOWN_MS;
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
/** The tab's sessionStorage. */
const session = new Map<string, string>();
const refusalKey = (account: string, questId: string) =>
  `clawville-quest-claim-refusal:${account}:${questId}`;

type Answer = 'refused' | 'ok' | 'conflict' | 'already-claimed-body';
let answer: Answer = 'refused';
let posted: string[] = [];
const postsFor = (questId: string) => posted.filter((id) => id === questId).length;

const mutableApi = api as unknown as Record<string, unknown>;
const originalClaim = mutableApi.claimTutorialQuest;
// honoRequest throws on every non-2xx; mirror that shape.
mutableApi.claimTutorialQuest = async (questId: string) => {
  posted.push(questId);
  if (answer === 'ok') return { ok: true, questId, credited: 5, balance: 5 };
  if (answer === 'already-claimed-body') return { ok: false, error: 'already_claimed', credited: 0, balance: 5 };
  const status = answer === 'conflict' ? 409 : 400;
  throw Object.assign(new Error(status === 400 ? 'engagement_required' : 'already_claimed'), { status });
};

const originalWarn = console.warn;
console.warn = () => {}; // the store logs every rejected claim

async function flush(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  posted = [];
  answer = 'refused';
  session.clear();
  define('window', { sessionStorage: mapStorage(session) });
  setSystemTime(new Date(T0));
  useQuestStore.getState().resetQuestStore();
  useQuestStore.getState().setQuestOwner('acc-1');
});

afterEach(() => {
  setSystemTime();
});

afterAll(() => {
  mutableApi.claimTutorialQuest = originalClaim;
  console.warn = originalWarn;
  for (const [name, descriptor] of [['localStorage', previousLocalStorage], ['window', previousWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('the claim sweep remembers a server refusal', () => {
  test('two sweeps inside the cooldown after a 400 engagement_required send the claim once', async () => {
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(1);
    expect(postsFor('crossover')).toBe(1);

    setSystemTime(new Date(T0 + COOLDOWN - 1));
    await retryUnclaimedRewards();
    // Every refused quest is remembered, not only the first one.
    expect(postsFor('on-the-board')).toBe(1);
    expect(postsFor('crossover')).toBe(1);
  });

  test('a sweep once the cooldown has passed asks the server again', async () => {
    await retryUnclaimedRewards();
    setSystemTime(new Date(T0 + 60_000));
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(1);

    setSystemTime(new Date(T0 + COOLDOWN));
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(2);
  });

  test('a claim the player starts ignores the cooldown and asks the server', async () => {
    // Locally completed, not server-claimed: the sweep claims it silently.
    useQuestStore.setState((s) => ({
      progress: { ...s.progress, 'say-hi-nori': { status: 'completed', completedAt: T0 } },
    }));
    await retryUnclaimedRewards();
    await retryUnclaimedRewards();
    expect(postsFor('say-hi-nori')).toBe(1);

    // triggerQuestCheck is the non-silent claim path (a quest the player just
    // completed). It must reach the server inside the cooldown.
    useQuestStore.setState((s) => ({
      progress: { ...s.progress, 'say-hi-nori': { status: 'active' } },
      counters: { ...s.counters, systemAgentMessagesSent: 1 },
    }));
    triggerQuestCheck();
    await flush();
    expect(postsFor('say-hi-nori')).toBe(2);
  });

  test('a success clears the refusal', async () => {
    await retryUnclaimedRewards();
    expect(session.has(refusalKey('acc-1', 'on-the-board'))).toBe(true);

    answer = 'ok';
    setSystemTime(new Date(T0 + COOLDOWN));
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(2);
    expect(session.has(refusalKey('acc-1', 'on-the-board'))).toBe(false);
    expect(useQuestStore.getState().serverClaimed['on-the-board']).toBe(true);
  });

  for (const reply of ['conflict', 'already-claimed-body'] as const) {
    test(`already_claimed (${reply}) clears the refusal`, async () => {
      await retryUnclaimedRewards();
      expect(session.has(refusalKey('acc-1', 'crossover'))).toBe(true);

      answer = reply;
      setSystemTime(new Date(T0 + COOLDOWN));
      await retryUnclaimedRewards();
      expect(session.has(refusalKey('acc-1', 'crossover'))).toBe(false);
      expect(useQuestStore.getState().serverClaimed.crossover).toBe(true);
    });
  }

  test('a refusal belongs to one account, and an identity reset forgets it', async () => {
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(1);

    useQuestStore.getState().setQuestOwner('acc-2');
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(2);

    useQuestStore.getState().setQuestOwner('acc-1');
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(2);

    // Sign-out / expiry / account switch (clearIdentityState) resets the store.
    useQuestStore.getState().resetQuestStore();
    useQuestStore.getState().setQuestOwner('acc-1');
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(3);
  });

  test('a sessionStorage that throws does not break the sweep', async () => {
    define('window', {
      get sessionStorage(): Storage {
        throw new Error('SecurityError: storage is disabled');
      },
    });
    await retryUnclaimedRewards();
    await retryUnclaimedRewards();
    // No memory without storage: every sweep asks, as before the fix.
    expect(postsFor('on-the-board')).toBe(2);

    const fail = () => {
      throw new Error('QuotaExceededError');
    };
    define('window', {
      sessionStorage: {
        getItem: fail,
        setItem: fail,
        removeItem: fail,
        clear: fail,
        key: fail,
        get length(): number {
          return fail();
        },
      },
    });
    await retryUnclaimedRewards();
    answer = 'ok';
    await retryUnclaimedRewards();
    expect(postsFor('on-the-board')).toBe(4);
    expect(useQuestStore.getState().serverClaimed['on-the-board']).toBe(true);
    expect(() => useQuestStore.getState().resetQuestStore()).not.toThrow();
  });
});
