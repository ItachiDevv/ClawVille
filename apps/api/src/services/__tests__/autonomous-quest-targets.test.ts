/**
 * Quest readiness for the hosted decide prompt: READY quests (the real gate
 * already passes) come first; a validator error is "not ready"; one readiness
 * pass per avatar per 60 s. `db.execute` is stubbed (no DB opens) and the
 * validator is injected.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as database from '@clawville/database';

const AVATAR = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000c1';
let claimedRows: Array<{ quest_id: string }> = [];

mock.module('@clawville/database', () => ({
  ...database,
  db: { execute: async () => claimedRows },
}));
const { readAutonomousQuestTargets, selectQuestTargets, clearAutonomousQuestReadinessCache } =
  await import('../autonomous-quest-targets');

const calls: string[] = [];
const validatorFor = (ready: ReadonlySet<string>, failing: ReadonlySet<string> = new Set()) =>
  async (_userId: string, _avatarId: string, questId: string) => {
    calls.push(questId);
    if (failing.has(questId)) throw new Error('db down');
    return { ok: ready.has(questId) };
  };

beforeEach(() => {
  claimedRows = [];
  calls.length = 0;
  clearAutonomousQuestReadinessCache();
});

describe('selectQuestTargets with readiness', () => {
  test('default (none ready) keeps the old order and marks nothing ready', () => {
    const targets = selectQuestTargets(new Set());
    expect(targets.map((quest) => quest.questId)).toEqual(
      ['say-hi-nori', 'town-briefing', 'town-tour', 'style-statement', 'wallet-aware', 'homesteader'],
    );
    expect(targets.every((quest) => quest.ready === false)).toBe(true);
  });

  test('READY quests come first (round-robin by tier), then the not-ready actionable ones by tier', () => {
    const targets = selectQuestTargets(new Set(), new Set(['wallet-aware', 'style-statement']));
    expect(targets.map((quest) => quest.questId)).toEqual(
      ['style-statement', 'wallet-aware', 'say-hi-nori', 'town-briefing', 'town-tour', 'big-spender'],
    );
    expect(targets.map((quest) => quest.ready)).toEqual([true, true, false, false, false, false]);
  });
});

describe('readAutonomousQuestTargets readiness', () => {
  test('runs the gate only for unclaimed hosted-actionable quests, and orders READY first', async () => {
    claimedRows = [{ quest_id: 'say-hi-nori' }];
    const targets = await readAutonomousQuestTargets({
      avatarId: AVATAR,
      userId: USER,
      validate: validatorFor(new Set(['style-statement', 'wallet-aware'])),
      nowMs: 1_000_000,
    });
    expect(calls).not.toContain('say-hi-nori');
    expect(calls.length).toBeLessThanOrEqual(12);
    expect(new Set(calls)).toEqual(new Set([
      'town-briefing', 'first-steps', 'door-knocker', 'town-tour', 'star-pupil', 'cartographer',
      'style-statement', 'big-spender', 'wallet-aware', 'homesteader', 'yard-work',
    ]));
    expect(targets.slice(0, 2).map((quest) => [quest.questId, quest.ready])).toEqual([
      ['style-statement', true],
      ['wallet-aware', true],
    ]);
    expect(targets.slice(2).every((quest) => !quest.ready)).toBe(true);
  });

  test('a validator that throws makes that quest not ready and never throws out', async () => {
    const targets = await readAutonomousQuestTargets({
      avatarId: AVATAR,
      userId: USER,
      validate: validatorFor(new Set(['style-statement', 'wallet-aware']), new Set(['style-statement'])),
      nowMs: 1_000_000,
    });
    expect(targets.find((quest) => quest.questId === 'style-statement')?.ready).toBe(false);
    expect(targets[0]).toMatchObject({ questId: 'wallet-aware', ready: true });
  });

  test('a cache hit inside 60 s skips the validator; after 60 s it runs again', async () => {
    const validate = validatorFor(new Set(['wallet-aware']));
    await readAutonomousQuestTargets({ avatarId: AVATAR, userId: USER, validate, nowMs: 1_000_000 });
    const firstPass = calls.length;
    expect(firstPass).toBeGreaterThan(0);
    const cached = await readAutonomousQuestTargets({ avatarId: AVATAR, userId: USER, validate, nowMs: 1_059_999 });
    expect(calls.length).toBe(firstPass);
    expect(cached[0]).toMatchObject({ questId: 'wallet-aware', ready: true });
    await readAutonomousQuestTargets({ avatarId: AVATAR, userId: USER, validate, nowMs: 1_060_000 });
    expect(calls.length).toBe(firstPass * 2);
  });

  test('no userId: no readiness read, nothing ready', async () => {
    const targets = await readAutonomousQuestTargets({ avatarId: AVATAR, validate: validatorFor(new Set(['wallet-aware'])) });
    expect(calls).toEqual([]);
    expect(targets.every((quest) => !quest.ready)).toBe(true);
  });
});
