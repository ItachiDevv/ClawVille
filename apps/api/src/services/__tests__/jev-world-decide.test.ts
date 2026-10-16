import { describe, expect, it } from 'bun:test';
import { HATCHER_ACTION_MENU } from '@clawville/shared';
import { parseDriverAction } from '../agent-autonomy-driver';
import { JEV_DEMO_STATUS_PREFIX, JEV_ENDPOINT } from '../jev-decide-shadow';
import {
  JEV_WORLD_CAPS,
  JEV_WORLD_MIN_TOP_PROB,
  buildJevWorldQuestions,
  createJevWorldDecide,
  emoteNamesFromMenu,
  isJevWorldDecideConfigured,
  isJevWorldDecideEnabled,
  resolveJevWorldAction,
  type JevWorldDecideInput,
  type JevWorldEnv,
  type JevWorldLedger,
  type JevWorldPatch,
  type JevWorldTargets,
} from '../jev-world-decide';

const KEY = 'jev-test-key-SECRET-4a5b6c';
const AVATAR = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const STAGING: JevWorldEnv = {
  CLAWVILLE_ENV: 'staging',
  JEV_API_KEY: KEY,
  JEV_DECIDE_AVATAR_IDS: ` ${AVATAR.toUpperCase()} , not-a-uuid`,
};

const TARGETS: JevWorldTargets = {
  buildings: [
    { id: 'skill-forge', label: 'Skill Forge' },
    { id: 'bad id)', label: 'unsafe id is dropped' },
  ],
  quests: [{ id: 'land-1', label: 'First parcel' }],
  salvageNodes: [],
};

interface FakeRow { id: string; status: string; usd: number; patch?: JevWorldPatch; error?: string }

function fakeLedger(seedUsd = 0) {
  const rows: FakeRow[] = seedUsd > 0 ? [{ id: 'seed', status: 'demo_jev', usd: seedUsd }] : [];
  let n = 0;
  const ledger: JevWorldLedger = {
    async reserve(row, caps) {
      const total = rows.reduce((s, r) => s + r.usd, 0);
      if (total + row.estimateUsd > caps.totalUsd) return { ok: false, reason: 'total' };
      if (total + row.estimateUsd > caps.dailyUsd) return { ok: false, reason: 'daily' };
      const id = `row-${++n}`;
      rows.push({ id, status: 'demo_reserved', usd: row.estimateUsd });
      return { ok: true, id };
    },
    async finish(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('missing row');
      r.status = patch.status;
      r.patch = patch;
      if (patch.usd !== null) r.usd = patch.usd;
    },
    async recordSkippedCap(_row, reason) {
      rows.push({ id: `skip-${++n}`, status: 'demo_skip_cap', usd: 0, error: `cap_${reason}` });
    },
  };
  return { ledger, rows };
}

function body(verbProbs: Record<string, number>, extra: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = { ...extra };
  for (const [k, v] of Object.entries(verbProbs)) answers[k] = { noul: v };
  return { answers, usage: { input_tokens: 2_000 } };
}

function setup(opts: { env?: JevWorldEnv; seedUsd?: number; response?: unknown; fail?: boolean } = {}) {
  const fl = fakeLedger(opts.seedUsd);
  const logs: string[] = [];
  const fetchCalls: Array<{ url: string; body: string }> = [];
  const runner = createJevWorldDecide({
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: init.body });
      if (opts.fail) throw new Error(`boom ${KEY}`);
      return { ok: true, status: 200, json: async () => opts.response ?? body({ enter_cove: 0.9 }) };
    },
    ledger: fl.ledger,
    env: () => opts.env ?? STAGING,
    now: () => Date.parse('2026-10-16T12:00:00Z'),
    log: { warn: (line) => logs.push(line) },
  });
  let localCalls = 0;
  const input = (over: Partial<JevWorldDecideInput> = {}): JevWorldDecideInput => ({
    prompt: 'FULL decide prompt with the action menu',
    avatarId: AVATAR,
    isHouse: false,
    targets: TARGETS,
    localDecide: async () => { localCalls += 1; return 'Reason. [ACTION: emote(name=wave)]'; },
    localVerbOf: (text) => parseDriverAction(text)?.verb ?? null,
    ...over,
  });
  return { runner, fl, logs, fetchCalls, input, localCalls: () => localCalls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('jev-world-decide gate', () => {
  it('is impossible in production even with a key and a listed avatar', () => {
    expect(isJevWorldDecideEnabled(AVATAR, { ...STAGING, CLAWVILLE_ENV: 'production' })).toBe(false);
    expect(isJevWorldDecideConfigured({ ...STAGING, CLAWVILLE_ENV: 'production' })).toBe(false);
  });
  it('refuses unset env, missing key and unlisted avatars', () => {
    expect(isJevWorldDecideEnabled(AVATAR, { ...STAGING, CLAWVILLE_ENV: undefined })).toBe(false);
    expect(isJevWorldDecideEnabled(AVATAR, { ...STAGING, JEV_API_KEY: '  ' })).toBe(false);
    expect(isJevWorldDecideEnabled(OTHER, STAGING)).toBe(false);
    expect(isJevWorldDecideEnabled(AVATAR, STAGING)).toBe(true);
  });
  it('production run never calls Jev and uses local', async () => {
    const t = setup({ env: { ...STAGING, CLAWVILLE_ENV: 'production' } });
    const out = await t.runner.decide(t.input());
    expect(out.source).toBe('local');
    expect(t.fetchCalls.length).toBe(0);
    expect(t.fl.rows.length).toBe(0);
    expect(t.localCalls()).toBe(1);
  });
  it('unlisted avatar never calls Jev', async () => {
    const t = setup();
    const out = await t.runner.decide(t.input({ avatarId: OTHER }));
    expect(out.source).toBe('local');
    expect(t.fetchCalls.length).toBe(0);
  });
});

describe('jev-world-decide decisions', () => {
  it('uses Jev and skips local when the top verb clears the threshold', async () => {
    const t = setup({ response: body({ enter_cove: 0.8, emote: 0.3 }) });
    const out = await t.runner.decide(t.input());
    await flush();
    expect(out).toEqual({ reply: '[ACTION: enter_cove()]', source: 'jev' });
    expect(t.localCalls()).toBe(0);
    expect(t.fetchCalls[0]?.url).toBe(JEV_ENDPOINT);
    const sent = JSON.parse(t.fetchCalls[0]!.body) as { state: string; questions: Record<string, unknown> };
    // Consumption mandate: same prompt as state, every menu verb asked.
    expect(sent.state).toBe('FULL decide prompt with the action menu');
    for (const item of HATCHER_ACTION_MENU) expect(sent.questions[item.verb]).toBeDefined();
    expect(t.fl.rows[0]?.status).toBe('demo_jev');
    expect(t.fl.rows[0]?.patch?.jevVerb).toBe('enter_cove');
  });

  it('falls back to local below the threshold and records the local verb', async () => {
    const t = setup({ response: body({ enter_cove: JEV_WORLD_MIN_TOP_PROB - 0.01 }) });
    const out = await t.runner.decide(t.input());
    await flush();
    expect(out.source).toBe('local_fallback');
    expect(out.reply).toContain('emote(name=wave)');
    expect(t.localCalls()).toBe(1);
    expect(t.fl.rows[0]?.status).toBe('demo_fallback');
    expect(t.fl.rows[0]?.patch?.error).toBe('below_threshold');
    expect(t.fl.rows[0]?.patch?.localVerb).toBe('emote');
  });

  it('falls back on a cap refusal without calling Jev', async () => {
    const t = setup({ seedUsd: JEV_WORLD_CAPS.totalUsd });
    const out = await t.runner.decide(t.input());
    expect(out.source).toBe('local_fallback');
    expect(t.fetchCalls.length).toBe(0);
    expect(t.fl.rows.some((r) => r.status === 'demo_skip_cap' && r.error === 'cap_total')).toBe(true);
    // Latched: the next decision does not even reserve.
    const again = await t.runner.decide(t.input());
    expect(again.source).toBe('local');
  });

  it('falls back on a Jev error and never logs the key', async () => {
    const t = setup({ fail: true });
    const out = await t.runner.decide(t.input());
    await flush();
    expect(out.source).toBe('local_fallback');
    expect(t.logs.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(t.fl.rows)).not.toContain(KEY);
  });

  it('picks a param with a choice question over the listed targets', async () => {
    const t = setup({
      response: body({ enter_building: 0.7 }, { param_building: { choice: 'skill-forge', probabilities: { 'skill-forge': 1 } } }),
    });
    const out = await t.runner.decide(t.input());
    expect(out).toEqual({ reply: '[ACTION: enter_building(buildingId=skill-forge)]', source: 'jev' });
  });

  it('falls back when the param choice is not a listed target', async () => {
    const t = setup({ response: body({ enter_building: 0.7 }, { param_building: { choice: 'bad id)' } }) });
    const out = await t.runner.decide(t.input());
    expect(out.source).toBe('local_fallback');
  });

  it('falls back for money and free-text verbs', async () => {
    for (const verb of ['trade_token', 'play_cove_game', 'claim_parcel', 'talk_to_npc', 'chat_nori', 'move']) {
      const t = setup({ response: body({ [verb]: 0.99 }) });
      const out = await t.runner.decide(t.input());
      expect(out.source).toBe('local_fallback');
    }
  });
});

describe('jev-world-decide output goes through the driver parser', () => {
  it('every Jev reply parses with parseDriverAction to the same verb and params', () => {
    const questions = buildJevWorldQuestions({
      buildings: [{ id: 'skill-forge', label: 'x' }],
      quests: [{ id: 'land-1', label: 'y' }],
      salvageNodes: [{ id: 'node-07', label: 'z' }],
    });
    const cases: Array<[Record<string, number>, Record<string, unknown>, string, Record<string, string>]> = [
      [{ enter_trading_floor: 0.9 }, {}, 'enter_trading_floor', {}],
      [{ emote: 0.9 }, { param_emote: { choice: emoteNamesFromMenu()[0] } }, 'emote', { name: emoteNamesFromMenu()[0]! }],
      [{ claim_tutorial_quest: 0.9 }, { param_quest: { choice: 'land-1' } }, 'claim_tutorial_quest', { questId: 'land-1' }],
      [{ salvage_node: 0.9 }, { param_salvage: { choice: 'node-07' } }, 'salvage_node', { nodeId: 'node-07' }],
    ];
    for (const [verbs, extra, verb, params] of cases) {
      const resolved = resolveJevWorldAction(body(verbs, extra).answers, questions);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(parseDriverAction(resolved.reply)).toEqual({ verb, params });
    }
  });
  it('demo status prefix matches the 5-char left(status, 5) ledger split', () => {
    expect(JEV_DEMO_STATUS_PREFIX.length).toBe(5);
    for (const status of ['demo_reserved', 'demo_skip_cap', 'demo_fallback']) expect(status.length).toBeLessThanOrEqual(16);
  });
  it('emote names come from the menu syntax', () => {
    expect(emoteNamesFromMenu()).toContain('wave');
  });
});
