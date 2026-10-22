import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

// Quests wire 2026-10-22: a serverOnly quest (style-statement, big-spender,
// wallet-aware) paid only on the /game mount sweep, which skips a refused
// quest for TUTORIAL_CLAIM_REFUSAL_COOLDOWN_MS. claimQuestsAfterStep asks the
// server right after the step, ignores that cooldown once, and retries one
// refusal. These tests pin the request budget: one attempt + one retry per
// trigger, nothing for a claimed quest or an unstamped (guest) store.

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

const { useQuestStore, claimQuestsAfterStep, retryUnclaimedRewards, QUEST_STEP_CLAIM_DELAY_MS } =
  await import('./quest');
const { api } = await import('@/lib/api');

const session = new Map<string, string>();
const refusalKey = (account: string, questId: string) =>
  `clawville-quest-claim-refusal:${account}:${questId}`;

/** Answers in order; the last one repeats. */
let answers: Array<'refused' | 'ok' | 'server-error'> = ['refused'];
let posted: string[] = [];
const postsFor = (questId: string) => posted.filter((id) => id === questId).length;

const mutableApi = api as unknown as Record<string, unknown>;
const originalClaim = mutableApi.claimTutorialQuest;
// honoRequest throws on every non-2xx; mirror that shape.
mutableApi.claimTutorialQuest = async (questId: string) => {
  posted.push(questId);
  const answer = answers.length > 1 ? answers.shift()! : answers[0];
  if (answer === 'ok') return { ok: true, questId, credited: 30, balance: 130 };
  const status = answer === 'server-error' ? 503 : 400;
  throw Object.assign(new Error(status === 400 ? 'engagement_required' : 'unavailable'), { status });
};

const originalWarn = console.warn;
console.warn = () => {}; // the store logs every rejected claim

const FAST = { delayMs: 0 };

beforeEach(() => {
  posted = [];
  answers = ['refused'];
  session.clear();
  define('window', { sessionStorage: mapStorage(session) });
  useQuestStore.getState().resetQuestStore();
  useQuestStore.getState().setQuestOwner('acc-1');
});

afterAll(() => {
  mutableApi.claimTutorialQuest = originalClaim;
  console.warn = originalWarn;
  for (const [name, descriptor] of [['localStorage', previousLocalStorage], ['window', previousWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('claimQuestsAfterStep', () => {
  test('the default wait is about 2 s', () => {
    expect(QUEST_STEP_CLAIM_DELAY_MS).toBe(2_000);
  });

  test('a success on the first attempt sends one claim and marks the quest claimed', async () => {
    answers = ['ok'];
    await claimQuestsAfterStep(['wallet-aware'], FAST);
    expect(postsFor('wallet-aware')).toBe(1);
    expect(useQuestStore.getState().serverClaimed['wallet-aware']).toBe(true);
  });

  test('a refusal gets exactly one retry, and the retry can pay', async () => {
    answers = ['refused', 'ok'];
    await claimQuestsAfterStep(['style-statement'], FAST);
    expect(postsFor('style-statement')).toBe(2);
    expect(useQuestStore.getState().serverClaimed['style-statement']).toBe(true);
    expect(session.has(refusalKey('acc-1', 'style-statement'))).toBe(false);
  });

  test('two refusals stop the run at two claims and keep the sweep cooldown', async () => {
    await claimQuestsAfterStep(['big-spender'], FAST);
    expect(postsFor('big-spender')).toBe(2);
    expect(useQuestStore.getState().serverClaimed['big-spender']).toBeUndefined();
    expect(session.has(refusalKey('acc-1', 'big-spender'))).toBe(true);
    // The sweep still honours the recorded refusal.
    await retryUnclaimedRewards();
    expect(postsFor('big-spender')).toBe(2);
  });

  test('it asks inside the refusal cooldown that blocks the sweep', async () => {
    await retryUnclaimedRewards();
    expect(postsFor('wallet-aware')).toBe(1);
    await retryUnclaimedRewards();
    expect(postsFor('wallet-aware')).toBe(1); // the sweep skips it now
    answers = ['ok'];
    await claimQuestsAfterStep(['wallet-aware'], FAST);
    expect(postsFor('wallet-aware')).toBe(2);
    expect(useQuestStore.getState().serverClaimed['wallet-aware']).toBe(true);
  });

  test('a server outage is not retried by the step claim', async () => {
    answers = ['server-error'];
    await claimQuestsAfterStep(['wallet-aware'], FAST);
    // One step attempt; the claim helper's own bounded 5xx retries are 2 more.
    expect(postsFor('wallet-aware')).toBe(3);
  });

  test('a quest already claimed sends nothing', async () => {
    useQuestStore.getState().markServerClaimed('style-statement');
    await claimQuestsAfterStep(['style-statement'], FAST);
    expect(posted).toEqual([]);
  });

  test('a store with no signed-in non-guest owner sends nothing', async () => {
    useQuestStore.getState().resetQuestStore(); // owner back to null (guest or signed out)
    await claimQuestsAfterStep(['style-statement', 'big-spender', 'wallet-aware'], FAST);
    expect(posted).toEqual([]);
  });

  test('several quests from one step are each claimed', async () => {
    answers = ['ok'];
    await claimQuestsAfterStep(['style-statement', 'big-spender'], FAST);
    expect(postsFor('style-statement')).toBe(1);
    expect(postsFor('big-spender')).toBe(1);
  });

  test('a second trigger during a run sends no parallel claim, only one more round', async () => {
    const first = claimQuestsAfterStep(['style-statement'], { delayMs: 20 });
    const second = claimQuestsAfterStep(['style-statement'], { delayMs: 20 });
    await Promise.all([first, second]);
    // Round 1: attempt + retry, refused. The second trigger asked for round 2.
    expect(postsFor('style-statement')).toBe(4);

    posted = [];
    const third = claimQuestsAfterStep(['style-statement'], { delayMs: 20 });
    const fourth = claimQuestsAfterStep(['style-statement'], { delayMs: 20 });
    answers = ['ok'];
    await Promise.all([third, fourth]);
    // A credit ends the run: the queued round is not sent.
    expect(postsFor('style-statement')).toBe(1);
  });
});
