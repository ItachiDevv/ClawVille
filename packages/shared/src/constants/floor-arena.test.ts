import { describe, expect, test } from 'bun:test';

import {
  FLOOR_ARENA_ADDON_CALL_STATES,
  FLOOR_ARENA_ADDONS,
  FLOOR_ARENA_AGENT_KINDS,
  FLOOR_ARENA_AGENT_STATUSES,
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_ENTRY_FILL_SOURCES,
  FLOOR_ARENA_EVENT_TYPES,
  FLOOR_ARENA_EXIT_FILL_SOURCES,
  FLOOR_ARENA_EXIT_REASONS,
  FLOOR_ARENA_FILTER_KEYS,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_MODES,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_PARAM_CHANGE_SOURCES,
  FLOOR_ARENA_PARAM_PATHS,
  FLOOR_ARENA_POSITION_STATUSES,
  FLOOR_ARENA_PROVISION_STATES,
  FLOOR_ARENA_RANK_BY,
  FLOOR_ARENA_RANK_BY_LABELS,
  FLOOR_ARENA_SUGGESTION_STATES,
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_VERSION,
  applyFloorArenaParamChange,
  cloneFloorArenaParams,
  diffFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaBound,
  type FloorArenaParams,
} from './floor-arena';

/** A mutable, JSON-shaped copy (what the API receives in a request body). */
function genesis(): FloorArenaParams {
  return JSON.parse(JSON.stringify(floorArenaTemplateById('genesis')!.params)) as FloorArenaParams;
}

function errorsOf(p: unknown): string[] {
  const result = validateFloorArenaParams(p);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

function nullFilters(): FloorArenaParams['filters'] {
  return Object.fromEntries(FLOOR_ARENA_FILTER_KEYS.map((key) => [key, null])) as unknown as FloorArenaParams['filters'];
}

const EM_DASH = String.fromCharCode(0x2014);

/** Player-facing copy: trimmed, ends with a full stop, no em dash, never the word "casino". */
function expectPlainCopy(text: string): void {
  expect(text.trim()).toBe(text);
  expect(text.endsWith('.')).toBe(true);
  expect(text.includes(EM_DASH)).toBe(false);
  expect(/casino/i.test(text)).toBe(false);
}

/** Plain copy that is also exactly one sentence. */
function expectPlainSentence(text: string): void {
  expectPlainCopy(text);
  expect(/[.!?]\s+\S/.test(text.slice(0, -1))).toBe(false);
}


describe('floor arena templates and house agents', () => {
  test('ships exactly five templates with unique ids', () => {
    expect(FLOOR_ARENA_VERSION).toBe(1);
    expect(FLOOR_ARENA_TEMPLATES.map((t) => t.id)).toEqual([
      'genesis',
      'runner',
      'dip-hunter',
      'midcap-climber',
      'late-bloomer',
    ]);
  });

  test('every template validates and round-trips unchanged', () => {
    for (const template of FLOOR_ARENA_TEMPLATES) {
      const result = validateFloorArenaParams(JSON.parse(JSON.stringify(template.params)));
      if (!result.ok) throw new Error(`${template.id}: ${result.errors.join('; ')}`);
      expect(result.params).toEqual(cloneFloorArenaParams(template.params));
      expect(diffFloorArenaParams(template.params, result.params)).toEqual([]);
    }
  });

  test('templates and house agents map 1:1', () => {
    expect(FLOOR_ARENA_HOUSE_AGENTS).toHaveLength(FLOOR_ARENA_TEMPLATES.length);
    for (const template of FLOOR_ARENA_TEMPLATES) {
      const house = FLOOR_ARENA_HOUSE_AGENTS.filter((agent) => agent.templateId === template.id);
      expect(house).toHaveLength(1);
      expect(house[0].id).toBe(`house:${template.id}`);
      expect(template.houseAgentId).toBe(house[0].id);
      expect(house[0].name).toBe(template.displayName);
    }
    expect(new Set(FLOOR_ARENA_HOUSE_AGENTS.map((agent) => agent.id)).size).toBe(5);
  });

  test('only Genesis and Runner carry a live ClawPump agent id', () => {
    const ids = Object.fromEntries(FLOOR_ARENA_HOUSE_AGENTS.map((agent) => [agent.templateId, agent.clawpumpAgentId]));
    expect(ids).toEqual({
      genesis: '0f600d73-05a0-4c2e-8215-ab2a770ba192',
      runner: '1a0a153e-cc2c-4b2a-8a38-04e4417ce3c1',
      'dip-hunter': null,
      'midcap-climber': null,
      'late-bloomer': null,
    });
  });

  test('Genesis is the locked paper wide-4 set', () => {
    expect(floorArenaTemplateById('genesis')!.params).toEqual({
      filters: {
        ...nullFilters(),
        mcap_min: 10_000,
        mcap_max: 250_000,
        liq_min: 15_000,
        age_min_s: 1_800,
        age_max_s: 21_600,
      },
      entry: { discovered_within_s: null, rank_by: 'vol_over_mcap', entries_per_tick: 1 },
      exits: { tp: [[1.1, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 900 },
      limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
    });
  });

  test('Runner is the locked paper C1 set, clamped to 3 entries per tick', () => {
    expect(floorArenaTemplateById('runner')!.params).toEqual({
      filters: { ...nullFilters(), liq_min: 5_000, chg5m_max: 41.48, chg6h_min: 680.4 },
      entry: { discovered_within_s: 120, rank_by: 'newest', entries_per_tick: 3 },
      exits: { tp: [[1.2, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 900 },
      limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
    });
  });

  test('the three new templates carry the lead-approved params', () => {
    expect(floorArenaTemplateById('dip-hunter')!.params).toEqual({
      filters: { ...nullFilters(), mcap_min: 250_000, mcap_max: 50_000_000, liq_min: 50_000, age_min_s: 21_600, chg1h_max: -5, chg24h_min: 0 },
      entry: { discovered_within_s: null, rank_by: 'lowest_vol_over_mcap', entries_per_tick: 1 },
      exits: { tp: [[1.08, 1]], stop_mult: 0.9, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 7_200 },
      limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
    });
    expect(floorArenaTemplateById('midcap-climber')!.params).toEqual({
      filters: {
        ...nullFilters(),
        mcap_min: 500_000,
        mcap_max: 5_000_000,
        liq_min: 30_000,
        age_min_s: 3_600,
        age_max_s: 86_400,
        chg5m_min: 0,
        chg1h_min: 5,
        chg1h_max: 60,
      },
      entry: { discovered_within_s: null, rank_by: 'txns1h', entries_per_tick: 1 },
      exits: { tp: [[1.1, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 3_600 },
      limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
    });
    expect(floorArenaTemplateById('late-bloomer')!.params).toEqual({
      filters: {
        ...nullFilters(),
        mcap_min: 50_000,
        mcap_max: 500_000,
        liq_min: 15_000,
        age_min_s: 21_600,
        age_max_s: 172_800,
        chg5m_min: 2,
        chg1h_min: 20,
      },
      entry: { discovered_within_s: null, rank_by: 'txns1h', entries_per_tick: 1 },
      exits: { tp: [[1.1, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 1_800 },
      limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
    });
  });

  test('no template sets a holder cap (an unmeasured top-10 share would fail every coin)', () => {
    for (const template of FLOOR_ARENA_TEMPLATES) expect(template.params.filters.top10_max_pct).toBeNull();
    expect(FLOOR_ARENA_PARAM_BOUNDS.filters.top10_max_pct).toMatchObject({ min: 1, max: 100, nullable: true });
  });

  test('add-on notes state the daily cost at the catalog interval', () => {
    for (const addon of FLOOR_ARENA_ADDONS) {
      const perDay = (addon.priceUsd * 86_400) / addon.minIntervalS;
      expect(addon.note).toContain(`About $${perDay.toFixed(2)} per day`);
    }
  });

  test('player-facing copy is plain: one-sentence tagline and risk, thesis may run longer', () => {
    for (const template of FLOOR_ARENA_TEMPLATES) {
      expectPlainSentence(template.tagline);
      expectPlainSentence(template.risk);
      expectPlainCopy(template.thesis);
      expect(template.displayName.length).toBeGreaterThan(0);
    }
  });

  test('floorArenaTemplateById returns undefined for an unknown id', () => {
    expect(floorArenaTemplateById('volume-surge')).toBeUndefined();
  });

  test('templates are frozen and cloneFloorArenaParams gives an independent copy', () => {
    const template = floorArenaTemplateById('genesis')!;
    expect(() => {
      (template.params.filters as { mcap_min: number | null }).mcap_min = 1;
    }).toThrow();
    expect(() => {
      template.params.exits.tp.push([2, 0.5]);
    }).toThrow();
    const copy = cloneFloorArenaParams(template.params);
    copy.filters.mcap_min = 20_000;
    copy.exits.tp[0][0] = 1.5;
    expect(template.params.filters.mcap_min).toBe(10_000);
    expect(template.params.exits.tp[0][0]).toBe(1.1);
  });
});

describe('floor arena static tables', () => {
  test('hard rules are the D5 list in display order', () => {
    expect(FLOOR_ARENA_HARD_RULES).toEqual([
      { id: 'lp-locked', label: 'LP burned or locked (95% or more)' },
      { id: 'mint-authority', label: 'Mint authority revoked' },
      { id: 'freeze-authority', label: 'Freeze authority revoked' },
      { id: 't22-fee', label: 'Token-2022: no transfer fee or risky extension' },
      { id: 'pool-reserves', label: 'Pool reserves present' },
      { id: 'min-liquidity', label: 'Liquidity of $5,000 or more' },
    ]);
  });

  test('bounds cover every filter and lock the position size', () => {
    expect(Object.keys(FLOOR_ARENA_PARAM_BOUNDS.filters)).toEqual([...FLOOR_ARENA_FILTER_KEYS]);
    const size = FLOOR_ARENA_PARAM_BOUNDS.limits.position_usd;
    expect(size).toMatchObject({ min: 20, max: 20, locked: true, nullable: false });
    expect(FLOOR_ARENA_PARAM_BOUNDS.filters.liq_min).toMatchObject({ min: 5_000, max: 50_000_000, nullable: false });
    expect(FLOOR_ARENA_PARAM_BOUNDS.exits.max_hold_s).toMatchObject({ min: 60, max: 86_400, nullable: false });
    for (const section of Object.values(FLOOR_ARENA_PARAM_BOUNDS)) {
      for (const b of Object.values(section) as FloorArenaBound[]) {
        expect(b.min).toBeLessThanOrEqual(b.max);
        expect(b.step).toBeGreaterThan(0);
        expect(b.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('rank_by options all have labels', () => {
    expect(Object.keys(FLOOR_ARENA_RANK_BY_LABELS)).toEqual([...FLOOR_ARENA_RANK_BY]);
  });

  test('param paths list every leaf once, in canonical order', () => {
    expect(FLOOR_ARENA_PARAM_PATHS).toHaveLength(19 + 3 + 5 + 3);
    expect(new Set(FLOOR_ARENA_PARAM_PATHS).size).toBe(FLOOR_ARENA_PARAM_PATHS.length);
    expect(FLOOR_ARENA_PARAM_PATHS[0]).toBe('filters.mcap_min');
    expect(FLOOR_ARENA_PARAM_PATHS).toContain('exits.tp');
    expect(FLOOR_ARENA_PARAM_PATHS.at(-1)).toBe('limits.reentry_cooldown_s');
  });

  test('paper costs, add-on catalog and add-on caps', () => {
    expect(FLOOR_ARENA_PAPER_COSTS).toEqual({ buy_haircut_pct: 2.5, sell_haircut_pct: 1.0 });
    expect(FLOOR_ARENA_ADDONS.map((addon) => addon.id)).toEqual([
      'nansen-token-screener-sol',
      'nansen-smart-money-dex-trades-sol',
    ]);
    expect(FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD).toBe(1);
    expect(FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD).toBe(5);
  });

  test('every catalog add-on is well formed and callable through a host allowlist', () => {
    expect(new Set(FLOOR_ARENA_ADDONS.map((addon) => addon.id)).size).toBe(FLOOR_ARENA_ADDONS.length);
    for (const addon of FLOOR_ARENA_ADDONS) {
      const url = new URL(addon.url);
      expect(url.protocol).toBe('https:');
      // A bare DNS host (no port, no credentials, no IP literal) is what an allowlist can pin.
      expect(url.port).toBe('');
      expect(url.username + url.password).toBe('');
      expect(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(url.hostname)).toBe(true);
      expect(addon.priceUsd).toBeGreaterThan(0);
      expect(addon.priceUsd).toBeLessThanOrEqual(FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD);
      // D9: an add-on is polled at most once every 10 minutes.
      expect(addon.minIntervalS).toBeGreaterThanOrEqual(600);
      expect(addon.mintPath.length).toBeGreaterThan(0);
      expectPlainCopy(addon.note);
      if (addon.method === 'POST') {
        expect(addon.body).not.toBeNull();
        expect(addon.query).toBeNull();
      } else {
        expect(addon.body).toBeNull();
      }
      if (addon.dedupeVary) {
        const [first, second] = addon.dedupeVary.values;
        expect(first).not.toBe(second);
        // The path must name a real body field that starts at the first value.
        const start = addon.dedupeVary.path
          .split('.')
          .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], addon.body);
        expect(start).toBe(first);
      }
    }
  });

  test('the catalog is frozen, so a caller must copy the body before it varies a field', () => {
    const body = FLOOR_ARENA_ADDONS[0].body as { pagination: { per_page: number } };
    expect(() => {
      body.pagination.per_page = 49;
    }).toThrow();
  });

  test('database value sets match docs §4', () => {
    expect(FLOOR_ARENA_AGENT_KINDS).toEqual(['house', 'user']);
    expect(FLOOR_ARENA_MODES).toEqual(['paper', 'live']);
    expect(FLOOR_ARENA_AGENT_STATUSES).toEqual(['active', 'paused', 'stopped']);
    expect(FLOOR_ARENA_PROVISION_STATES).toEqual(['none', 'pending', 'creating', 'ready', 'failed']);
    expect(FLOOR_ARENA_POSITION_STATUSES).toEqual(['open', 'closed']);
    expect(FLOOR_ARENA_EXIT_REASONS).toEqual(['tp', 'stop', 'trail', 'time', 'manual', 'unresolved']);
    expect(FLOOR_ARENA_ENTRY_FILL_SOURCES).toEqual(['quote']);
    expect(FLOOR_ARENA_EXIT_FILL_SOURCES).toEqual(['quote', 'mark_fallback', 'quote_confirmed', 'unresolved']);
    expect(FLOOR_ARENA_EVENT_TYPES).toEqual([
      'scan',
      'pass',
      'skip',
      'entry',
      'exit',
      'param_change',
      'report',
      'status',
      'addon',
    ]);
    expect(FLOOR_ARENA_SUGGESTION_STATES).toEqual([
      'none',
      'pending',
      'applied',
      'dismissed',
      'auto_applied',
      'rejected',
    ]);
    expect(FLOOR_ARENA_PARAM_CHANGE_SOURCES).toEqual(['user', 'house-tuner', 'admin', 'suggestion']);
    expect(FLOOR_ARENA_ADDON_CALL_STATES).toEqual(['reserved', 'done']);
  });
});

describe('floor arena contest window', () => {
  const start = Date.parse(FLOOR_ARENA_CONTEST.startsAt);
  const end = Date.parse(FLOOR_ARENA_CONTEST.endsAt);

  test('matches D6 exactly', () => {
    expect(FLOOR_ARENA_CONTEST.id).toBe('arena-week-1');
    expect(new Date(start).toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(new Date(end).toISOString()).toBe('2026-10-05T03:59:59.000Z');
  });

  test('starts at 6 PM EDT and ends at 11:59:59 PM EDT on Sunday Oct 4', () => {
    const edtOffsetMs = 4 * 3_600_000;
    const startEdt = new Date(start - edtOffsetMs);
    const endEdt = new Date(end - edtOffsetMs);
    expect([startEdt.getUTCHours(), startEdt.getUTCMinutes()]).toEqual([18, 0]);
    expect(endEdt.getUTCDay()).toBe(0);
    expect(endEdt.getUTCDate()).toBe(4);
    expect([endEdt.getUTCHours(), endEdt.getUTCMinutes(), endEdt.getUTCSeconds()]).toEqual([23, 59, 59]);
    expect(end - start).toBe(4 * 86_400_000 + 5 * 3_600_000 + 59 * 60_000 + 59_000);
  });

  test('pays 1M / 500k / 250k $CLAWVILLE', () => {
    expect(FLOOR_ARENA_CONTEST.prizes).toEqual([
      { place: 1, amount: 1_000_000, token: '$CLAWVILLE' },
      { place: 2, amount: 500_000, token: '$CLAWVILLE' },
      { place: 3, amount: 250_000, token: '$CLAWVILLE' },
    ]);
  });

  test('has 6 to 9 plain one-sentence rules that state the key terms', () => {
    const rules = FLOOR_ARENA_CONTEST.rules;
    expect(rules.length).toBeGreaterThanOrEqual(6);
    expect(rules.length).toBeLessThanOrEqual(9);
    expect(rules).toContain(
      'To be eligible for a prize, your agent must be launched before the contest ends and have at least one position opened and closed inside the contest window.',
    );
    for (const rule of rules) expectPlainSentence(rule);
    const all = rules.join(' ');
    for (const term of ['paper', '$20', '5 open', 'one arena agent', 'guests', 'House agents', 'realised paper P&L', 'desk', 'disqualify']) {
      expect(all).toContain(term);
    }
  });
});

describe('validateFloorArenaParams', () => {
  test('rejects non-objects', () => {
    expect(errorsOf(null)).toEqual(['params: must be an object']);
    expect(errorsOf([])).toEqual(['params: must be an object']);
    expect(errorsOf('genesis')).toEqual(['params: must be an object']);
  });

  test('rejects unknown keys at every level', () => {
    expect(errorsOf({ ...genesis(), extra: 1 })).toContain('params.extra: unknown key');
    const p = genesis() as unknown as { filters: Record<string, unknown>; exits: Record<string, unknown> };
    p.filters.holders_min = 100;
    p.exits.moon = true;
    const errors = errorsOf(p);
    expect(errors).toContain('filters.holders_min: unknown key');
    expect(errors).toContain('exits.moon: unknown key');
  });

  test('rejects missing keys', () => {
    const p = genesis() as unknown as { entry: Record<string, unknown> };
    delete p.entry.rank_by;
    expect(errorsOf(p)).toContain('entry.rank_by: required');
    const q = genesis() as unknown as Record<string, unknown>;
    delete q.limits;
    expect(errorsOf(q)).toContain('params.limits: required');
  });

  test('rejects min >= max and accepts min < max', () => {
    const p = genesis();
    p.filters.mcap_max = p.filters.mcap_min;
    expect(errorsOf(p)).toEqual(['filters.mcap_min: must be below filters.mcap_max']);
    p.filters.mcap_max = 10_001;
    expect(validateFloorArenaParams(p).ok).toBe(true);
    const q = genesis();
    q.filters.chg1h_min = 50;
    q.filters.chg1h_max = 10;
    expect(errorsOf(q)).toEqual(['filters.chg1h_min: must be below filters.chg1h_max']);
  });

  test('locks the position size at $20', () => {
    const p = genesis();
    p.limits.position_usd = 25;
    expect(errorsOf(p)).toEqual(['limits.position_usd: is fixed at 20']);
  });

  test('enforces the $5,000 liquidity floor and requires liq_min', () => {
    const p = genesis();
    p.filters.liq_min = 4_999;
    expect(errorsOf(p)).toEqual(['filters.liq_min: must be between 5000 and 50000000']);
    p.filters.liq_min = null;
    expect(errorsOf(p)).toEqual(['filters.liq_min: must be set']);
  });

  test('requires at least one exit besides max_hold_s', () => {
    const p = genesis();
    p.exits.tp = [];
    expect(errorsOf(p)).toEqual(['exits: needs a take-profit leg, a stop_mult or a trail_from_peak']);
    p.exits.stop_mult = 0.9;
    expect(validateFloorArenaParams(p).ok).toBe(true);
    p.exits.stop_mult = null;
    p.exits.trail_from_peak = 0.12;
    expect(validateFloorArenaParams(p).ok).toBe(true);
  });

  test('rejects take-profit fractions that sum above 1 and tolerates float rounding at exactly 1', () => {
    const p = genesis();
    p.exits.tp = [
      [1.1, 0.6],
      [1.2, 0.5],
    ];
    expect(errorsOf(p)).toEqual(['exits.tp: fractions must sum to 1 or less']);
    p.exits.tp = [
      [1.1, 0.35],
      [1.2, 0.35],
      [1.3, 0.3],
    ];
    expect(validateFloorArenaParams(p).ok).toBe(true);
  });

  test('rejects more than 3 legs, malformed legs and non-ascending multiples', () => {
    const p = genesis();
    p.exits.tp = [
      [1.1, 0.25],
      [1.2, 0.25],
      [1.3, 0.25],
      [1.4, 0.25],
    ];
    expect(errorsOf(p)).toEqual(['exits.tp: at most 3 legs']);
    p.exits.tp = [[1.1, 0.5, 9]] as unknown as Array<[number, number]>;
    expect(errorsOf(p)).toEqual(['exits.tp[0]: must be [multiple, fraction]']);
    p.exits.tp = [
      [1.2, 0.5],
      [1.1, 0.5],
    ];
    expect(errorsOf(p)).toEqual(["exits.tp[1][0]: must be above the previous leg's multiple"]);
    p.exits.tp = [[1.0, 1]];
    expect(errorsOf(p)).toEqual(['exits.tp[0][0]: must be between 1.01 and 10']);
    p.exits.tp = [[1.1, 0.01]];
    expect(errorsOf(p)).toEqual(['exits.tp[0][1]: must be between 0.05 and 1']);
  });

  test('checks stop, trail and the trail arm', () => {
    const p = genesis();
    p.exits.stop_mult = 1;
    expect(errorsOf(p)).toEqual(['exits.stop_mult: must be between 0.3 and 0.99']);
    p.exits.stop_mult = null;
    p.exits.trail_arm_mult = 1.1;
    expect(errorsOf(p)).toEqual(['exits.trail_arm_mult: needs exits.trail_from_peak']);
    p.exits.trail_from_peak = 0.7;
    expect(errorsOf(p)).toEqual(['exits.trail_from_peak: must be between 0.02 and 0.6']);
    p.exits.trail_from_peak = 0.12;
    expect(validateFloorArenaParams(p).ok).toBe(true);
  });

  test('checks entry fields', () => {
    const p = genesis();
    p.entry.entries_per_tick = 4;
    expect(errorsOf(p)).toEqual(['entry.entries_per_tick: must be between 1 and 3']);
    p.entry.entries_per_tick = 1.5;
    expect(errorsOf(p)).toEqual(['entry.entries_per_tick: must be a whole number']);
    p.entry.entries_per_tick = 1;
    p.entry.discovered_within_s = 10;
    expect(errorsOf(p)).toEqual(['entry.discovered_within_s: must be between 30 and 86400']);
    p.entry.discovered_within_s = 120;
    (p.entry as { rank_by: string }).rank_by = 'hottest';
    expect(errorsOf(p)[0]).toStartWith('entry.rank_by: must be one of');
  });

  test('checks limits', () => {
    const p = genesis();
    p.limits.max_open = 6;
    expect(errorsOf(p)).toEqual(['limits.max_open: must be between 1 and 5']);
    p.limits.max_open = 0;
    expect(errorsOf(p)).toEqual(['limits.max_open: must be between 1 and 5']);
    p.limits.max_open = 5;
    p.limits.reentry_cooldown_s = 604_801;
    expect(errorsOf(p)).toEqual(['limits.reentry_cooldown_s: must be between 0 and 604800']);
  });

  test('rejects non-finite numbers, strings and a missing max hold', () => {
    const p = genesis() as unknown as { filters: Record<string, unknown>; exits: Record<string, unknown> };
    p.filters.mcap_min = Number.NaN;
    p.filters.mcap_max = '250000';
    p.filters.chg5m_min = Number.POSITIVE_INFINITY;
    p.exits.max_hold_s = null;
    const errors = errorsOf(p);
    expect(errors).toEqual([
      'filters.mcap_min: must be a number',
      'filters.mcap_max: must be a number',
      'filters.chg5m_min: must be a number',
      'exits.max_hold_s: must be set',
    ]);
  });

  test('returns a fresh mutable object, not the input', () => {
    const template = floorArenaTemplateById('dip-hunter')!;
    const result = validateFloorArenaParams(template.params);
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.params).not.toBe(template.params);
    expect(result.params.exits.tp).not.toBe(template.params.exits.tp);
    expect(Object.isFrozen(result.params)).toBe(false);
    result.params.exits.tp[0][0] = 1.2;
    expect(template.params.exits.tp[0][0]).toBe(1.08);
  });
});

describe('diffFloorArenaParams and applyFloorArenaParamChange', () => {
  test('reports leaf changes in canonical order with copied values', () => {
    const a = genesis();
    const b = genesis();
    b.limits.max_open = 3;
    b.filters.mcap_min = 20_000;
    b.exits.tp = [
      [1.08, 0.5],
      [1.2, 0.5],
    ];
    const diff = diffFloorArenaParams(a, b);
    expect(diff).toEqual([
      { path: 'filters.mcap_min', from: 10_000, to: 20_000 },
      {
        path: 'exits.tp',
        from: [[1.1, 1]],
        to: [
          [1.08, 0.5],
          [1.2, 0.5],
        ],
      },
      { path: 'limits.max_open', from: 5, to: 3 },
    ]);
    (diff[1].to as number[][])[0][0] = 9;
    expect(b.exits.tp[0][0]).toBe(1.08);
  });

  test('treats null and a number as different and equal scalars as equal', () => {
    const a = genesis();
    const b = genesis();
    b.filters.chg1h_max = 0;
    expect(diffFloorArenaParams(a, b)).toEqual([{ path: 'filters.chg1h_max', from: null, to: 0 }]);
    expect(diffFloorArenaParams(b, cloneFloorArenaParams(b))).toEqual([]);
  });

  test('apply sets one leaf on a copy and is the inverse of diff', () => {
    const template = floorArenaTemplateById('late-bloomer')!;
    const next = applyFloorArenaParamChange(template.params, 'exits.max_hold_s', 2_400);
    expect(diffFloorArenaParams(template.params, next)).toEqual([
      { path: 'exits.max_hold_s', from: 1_800, to: 2_400 },
    ]);
    expect(template.params.exits.max_hold_s).toBe(1_800);
    expect(validateFloorArenaParams(next).ok).toBe(true);
    const tp = applyFloorArenaParamChange(template.params, 'exits.tp', [[1.15, 1]]);
    expect(tp.exits.tp).toEqual([[1.15, 1]]);
  });

  test('apply refuses an unknown path and leaves bound checks to validation', () => {
    const template = floorArenaTemplateById('genesis')!;
    expect(() => applyFloorArenaParamChange(template.params, 'filters.holders_min', 1)).toThrow();
    expect(() => applyFloorArenaParamChange(template.params, 'limits', 1)).toThrow();
    const bad = applyFloorArenaParamChange(template.params, 'limits.position_usd', 50);
    expect(validateFloorArenaParams(bad).ok).toBe(false);
  });
});
