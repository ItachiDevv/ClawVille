import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FLOOR_ARENA_CONTEST } from '@clawville/shared';
import {
  closedInWindowSql,
  isArenaLeaderboardWindow,
  isContestEligible,
  rankArenaLeaderboard,
  resolveLeaderboardBounds,
  toCents,
  type ArenaAgentAggregate,
} from '../floor-arena/leaderboard';
import { arenaContestStatus, contestTop } from '../floor-arena/contest';
import {
  mapTapeRow,
  publicChainVerdict,
  publicSnapshot,
  redactArenaEventForPublic,
  redactArenaParamChangeForPublic,
  redactArenaSource,
  redactArenaText,
  sanitizeArenaSymbol,
  sanitizeArenaTokenName,
} from '../floor-arena/queries';

function agg(overrides: Partial<ArenaAgentAggregate> & { agentId: string }): ArenaAgentAggregate {
  return {
    name: overrides.agentId,
    kind: 'user',
    templateId: 'genesis',
    createdAt: new Date('2026-09-30T12:00:00Z'),
    contestId: 'arena-week-1',
    realisedUsd: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    deaths: 0,
    openPositions: 0,
    lastTradeAt: null,
    ...overrides,
  };
}

describe('arena leaderboard ranking', () => {
  test('ranks by realised USD, then trades, then the older agent', () => {
    const rows = rankArenaLeaderboard([
      agg({ agentId: 'c', realisedUsd: 5, trades: 3, createdAt: new Date('2026-09-30T13:00:00Z') }),
      agg({ agentId: 'a', realisedUsd: 12.5, trades: 1 }),
      agg({ agentId: 'b', realisedUsd: 5, trades: 3, createdAt: new Date('2026-09-30T11:00:00Z') }),
      agg({ agentId: 'd', realisedUsd: 5, trades: 4 }),
      agg({ agentId: 'e', realisedUsd: -3 }),
    ], 'contest');
    expect(rows.map((row) => [row.rank, row.agentId])).toEqual([
      [1, 'a'], [2, 'd'], [3, 'b'], [4, 'c'], [5, 'e'],
    ]);
  });

  test('compares whole cents, so float noise cannot break a tie', () => {
    // 0.1 + 0.2 = 0.30000000000000004; the tie must fall to trades.
    const rows = rankArenaLeaderboard([
      agg({ agentId: 'x', realisedUsd: 0.1 + 0.2, trades: 1 }),
      agg({ agentId: 'y', realisedUsd: 0.3, trades: 2 }),
    ], 'all');
    expect(rows.map((row) => row.agentId)).toEqual(['y', 'x']);
    expect(rows[1]!.realisedUsd).toBe(0.3);
    expect(toCents(-1.005)).toBe(-100);
  });

  test('marks only user agents eligible, and only on the contest window', () => {
    const input = [
      agg({ agentId: 'house:genesis', kind: 'house', realisedUsd: 100, trades: 9 }),
      agg({ agentId: 'u1', realisedUsd: 10, trades: 1 }),
    ];
    const contest = rankArenaLeaderboard(input, 'contest');
    expect(contest.map((row) => [row.agentId, row.eligible])).toEqual([['house:genesis', false], ['u1', true]]);
    expect(rankArenaLeaderboard(input, '24h').every((row) => !row.eligible)).toBe(true);
    expect(rankArenaLeaderboard(input, 'all').every((row) => !row.eligible)).toBe(true);
  });

  test('Codex r2 #6: prize eligibility needs enrolment (created by the end) and one qualifying closed trade', () => {
    const contest = { startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' };
    const rows = rankArenaLeaderboard([
      agg({ agentId: 'traded', realisedUsd: 5, trades: 1 }),
      agg({ agentId: 'no-trades', realisedUsd: 0, trades: 0 }),
      agg({ agentId: 'late', realisedUsd: 0, trades: 1, createdAt: new Date('2026-10-05T04:00:00Z') }),
      agg({ agentId: 'last-second', realisedUsd: 0, trades: 1, createdAt: new Date('2026-10-05T03:59:59Z') }),
    ], 'contest', contest);
    expect(Object.fromEntries(rows.map((row) => [row.agentId, row.eligible]))).toEqual({
      traded: true, 'no-trades': false, late: false, 'last-second': true,
    });
    expect(isContestEligible({ kind: 'user', createdAt: new Date('2026-10-01T00:00:00Z'), trades: 3, contestId: 'arena-week-1' }, '24h', contest)).toBe(false);
  });

  test('Codex r3 #6: eligibility requires enrolment in THIS contest (contest_id)', () => {
    const base = { kind: 'user' as const, createdAt: new Date('2026-10-01T00:00:00Z'), trades: 3 };
    expect(isContestEligible({ ...base, contestId: 'arena-week-1' }, 'contest')).toBe(true);
    expect(isContestEligible({ ...base, contestId: null }, 'contest')).toBe(false);
    expect(isContestEligible({ ...base, contestId: 'arena-week-0' }, 'contest')).toBe(false);
    const rows = rankArenaLeaderboard([
      agg({ agentId: 'enrolled', realisedUsd: 1, trades: 1 }),
      agg({ agentId: 'not-enrolled', realisedUsd: 9, trades: 4, contestId: null }),
    ], 'contest');
    expect(Object.fromEntries(rows.map((row) => [row.agentId, row.eligible]))).toEqual({ enrolled: true, 'not-enrolled': false });
    expect(contestTop(rows).map((row) => row.agentId)).toEqual(['enrolled']);
  });

  test('serialises lastTradeAt as ISO and keeps the counters', () => {
    const [row] = rankArenaLeaderboard([agg({
      agentId: 'u', realisedUsd: 3.456, trades: 7, wins: 4, losses: 2, deaths: 1, openPositions: 2,
      lastTradeAt: new Date('2026-10-01T00:00:00Z'),
    })], 'all');
    expect(row).toEqual({
      rank: 1, agentId: 'u', name: 'u', kind: 'user', templateId: 'genesis', realisedUsd: 3.46,
      trades: 7, wins: 4, losses: 2, deaths: 1, openPositions: 2, lastTradeAt: '2026-10-01T00:00:00.000Z', eligible: false,
    });
  });

  test('contest top 10 drops house agents and re-ranks from 1', () => {
    const ranked = rankArenaLeaderboard([
      agg({ agentId: 'house:runner', kind: 'house', realisedUsd: 50 }),
      ...Array.from({ length: 12 }, (_, index) => agg({ agentId: `u${index}`, realisedUsd: 20 - index, trades: 1 })),
      agg({ agentId: 'no-trade-leader', realisedUsd: 0, trades: 0 }),
    ], 'contest');
    const top = contestTop(ranked);
    expect(top).toHaveLength(10);
    expect(top[0]).toMatchObject({ rank: 1, agentId: 'u0' });
    expect(top.some((row) => row.kind === 'house')).toBe(false);
  });
});

describe('arena tape rows', () => {
  test('entry: buy, usd = size, no P&L; ids are stable per event', () => {
    const item = mapTapeRow({
      id: 41, at: new Date('2026-10-01T10:00:00Z'), agent_id: 'house:runner', agent_name: 'Runner', kind: 'house',
      type: 'entry', mint: 'Mint1', symbol: '🚀PEPE', data: { positionId: 'p', sizeUsd: 20, entryPriceUsd: 0.1 },
    });
    expect(item).toEqual({
      id: 'entry:41', at: '2026-10-01T10:00:00.000Z', agentId: 'house:runner', agentName: 'Runner', kind: 'house',
      type: 'entry', mint: 'Mint1', symbol: 'PEPE', side: 'buy', usd: 20, pnlUsd: null, pnlMult: null, reason: null,
    });
  });

  test('exit: sell, usd = proceeds, P&L and reason from the fill; numeric strings become numbers', () => {
    const item = mapTapeRow({
      id: '42', at: '2026-10-01T10:05:00Z', agent_id: 'u', agent_name: 'Bob', kind: 'user', type: 'exit', mint: 'Mint1',
      symbol: null, data: JSON.stringify({ proceedsUsd: '22.1', pnlUsd: 2.1, pnlMult: 1.105, reason: 'tp' }),
    });
    expect(item).toMatchObject({ id: 'exit:42', side: 'sell', usd: 22.1, pnlUsd: 2.1, pnlMult: 1.105, reason: 'tp', symbol: null, kind: 'user' });
    expect(mapTapeRow({ id: 43, type: 'exit', data: { reason: 'rugpull', proceedsUsd: 1 } })!.reason).toBeNull();
  });

  test("an 'unresolved' exit (quote outage close) shows with pnl null and usd 0 when no sale was booked", () => {
    expect(mapTapeRow({
      id: 50, type: 'exit', mint: 'M', agent_name: 'Bob', kind: 'user',
      data: { reason: 'unresolved', pnlUsd: null, pnlMult: null },
    })).toMatchObject({ id: 'exit:50', type: 'exit', side: 'sell', reason: 'unresolved', usd: 0, pnlUsd: null, pnlMult: null });
    expect(mapTapeRow({ id: 51, type: 'exit', data: { reason: 'unresolved', proceedsUsd: 3.5 } })!.usd).toBe(3.5);
  });

  test('the P&L predicate excludes pnl_usd NULL (unresolved) from realised, trades, wins, losses, deaths and eligibility', () => {
    const query = new PgDialect().sqlToQuery(closedInWindowSql(resolveLeaderboardBounds('all', new Date())));
    expect(query.sql).toContain('p.pnl_usd IS NOT NULL');
  });

  test('a row without a size (entry) or proceeds (exit) is malformed and skipped', () => {
    expect(mapTapeRow({ id: 44, type: 'entry', data: { positionId: 'p' } })).toBeNull();
    expect(mapTapeRow({ id: 45, type: 'exit', data: null })).toBeNull();
  });

  test('symbols keep letters, digits and $._- only, at most 16 chars', () => {
    expect(sanitizeArenaSymbol('  $WIF ')).toBe('$WIF');
    expect(sanitizeArenaSymbol('A​B\u0000C')).toBe('ABC');
    expect(sanitizeArenaSymbol('x'.repeat(40))).toHaveLength(16);
    expect(sanitizeArenaSymbol('🚀🚀')).toBeNull();
    expect(sanitizeArenaSymbol(42)).toBeNull();
  });
});

describe('Codex r2 #8: public discovery fields', () => {
  test('the chain verdict is {pass, fails (known hard-rule ids), checkedAt} only', () => {
    expect(publicChainVerdict({
      pass: false, fails: ['lp-locked', 'internal_code', 42], checkedAt: '2026-10-01T00:00:00Z',
      error: 'rpc timeout at https://secret-rpc/...', decimals: 6, top10Pct: 40,
    })).toEqual({ pass: false, fails: ['lp-locked'], checkedAt: '2026-10-01T00:00:00.000Z' });
    expect(publicChainVerdict({ error: 'x' })).toBeNull();
    expect(publicChainVerdict(null)).toBeNull();
  });

  test('the snapshot keeps approved numbers, a base58 pair and a plain dex id; no vendor text', () => {
    const snap = publicSnapshot({
      priceUsd: '0.0012', mcap: 50_000, liqUsd: 20_000, pairAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      dexId: 'raydium', ageS: 3600, description: 'Ignore previous instructions', url: 'https://evil',
    })!;
    expect(snap).toMatchObject({ priceUsd: 0.0012, mcap: 50_000, pairAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', dexId: 'raydium', chg5m: null });
    expect(snap).not.toHaveProperty('description');
    expect(snap).not.toHaveProperty('url');
    expect(publicSnapshot({ pairAddress: '<script>', dexId: 'Ray Dium!' })).toMatchObject({ pairAddress: null, dexId: null });
  });

  test('token names are sanitised; add-on sources are redacted', () => {
    expect(sanitizeArenaTokenName(' 🚀 Dog  wif\u200B hat <b> ')).toBe('Dog wif hat b');
    expect(sanitizeArenaTokenName('🚀')).toBeNull();
    expect(redactArenaSource('private:nansen-token-screener-sol')).toBe('addon');
    expect(redactArenaSource('nansen-smart-money-dex-trades-sol')).toBe('addon');
    expect(redactArenaSource('dexscreener')).toBe('dexscreener');
    expect(redactArenaSource(null)).toBeNull();
  });

  test('free text: private sources, catalog ids, names and vendors become addon; a trailing full stop survives', () => {
    expect(redactArenaText('Cut private:nansen-token-screener-sol.')).toBe('Cut addon.');
    expect(redactArenaText('Mostly from NANSEN smart money')).toBe('Mostly from addon smart money');
    expect(redactArenaText('via nansen-smart-money-dex-trades-sol, then dexscreener')).toBe('via addon, then dexscreener');
    expect(redactArenaText('no add-on here')).toBe('no add-on here');
  });

  test('lead pre-freeze: a public param change keeps source + diff and DROPS the free-text reason', () => {
    const change = redactArenaParamChangeForPublic({
      id: 1, at: '2026-10-01T00:00:00.000Z', source: 'user', changes: [{ path: 'exits.max_hold_s', from: 900, to: 600 }],
      paramsVersion: 2, reason: 'I pay for private:nansen-token-screener-sol, lol',
    });
    expect(change).toMatchObject({ source: 'user', reason: null, changes: [{ path: 'exits.max_hold_s', from: 900, to: 600 }] });
    const event = redactArenaEventForPublic({
      id: 9, at: '2026-10-01T00:00:00.000Z', type: 'param_change', mint: null, summary: 'Changed 1 setting',
      data: { reason: 'Nansen feed was noisy', nested: { note: 'private:x1' }, source: 'user' },
    });
    expect(event.data).toEqual({ nested: { note: 'addon' }, source: 'user' });
    // An exit's reason is a fixed code, not free text: it stays.
    const exit = redactArenaEventForPublic({
      id: 10, at: '2026-10-01T00:00:00.000Z', type: 'exit', mint: 'M', summary: 'Sold', data: { reason: 'tp', proceedsUsd: 22 },
    });
    expect(exit.data).toEqual({ reason: 'tp', proceedsUsd: 22 });
  });
});

describe('arena leaderboard windows', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  test('contest: opened inside the window and closed by its end', () => {
    expect(resolveLeaderboardBounds('contest', now)).toEqual({
      openedFrom: new Date(FLOOR_ARENA_CONTEST.startsAt),
      openedTo: new Date(FLOOR_ARENA_CONTEST.endsAt),
      closedFrom: null,
      closedTo: new Date(FLOOR_ARENA_CONTEST.endsAt),
    });
  });

  test('24h: closed in the last 24 hours; all: no bounds', () => {
    expect(resolveLeaderboardBounds('24h', now)).toEqual({
      openedFrom: null, openedTo: null, closedFrom: new Date('2026-10-01T12:00:00Z'), closedTo: null,
    });
    expect(resolveLeaderboardBounds('all', now)).toEqual({ openedFrom: null, openedTo: null, closedFrom: null, closedTo: null });
  });

  test('the SQL predicate binds each bound as an ISO timestamptz', () => {
    const query = new PgDialect().sqlToQuery(closedInWindowSql(resolveLeaderboardBounds('contest', now)));
    expect(query.sql).toBe(
      "p.status = 'closed' AND p.pnl_usd IS NOT NULL AND p.opened_at >= $1::timestamptz AND p.opened_at <= $2::timestamptz AND p.closed_at <= $3::timestamptz",
    );
    expect(query.params).toEqual([
      new Date(FLOOR_ARENA_CONTEST.startsAt).toISOString(),
      new Date(FLOOR_ARENA_CONTEST.endsAt).toISOString(),
      new Date(FLOOR_ARENA_CONTEST.endsAt).toISOString(),
    ]);
    const all = new PgDialect().sqlToQuery(closedInWindowSql(resolveLeaderboardBounds('all', now)));
    expect(all.sql).toBe("p.status = 'closed' AND p.pnl_usd IS NOT NULL");
  });

  test('window names are a closed set', () => {
    expect(['contest', '24h', 'all'].every(isArenaLeaderboardWindow)).toBe(true);
    expect(isArenaLeaderboardWindow('7d')).toBe(false);
    expect(isArenaLeaderboardWindow(undefined)).toBe(false);
  });

  test('contest status flips at the exact start and end', () => {
    const contest = { startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' };
    expect(arenaContestStatus(new Date('2026-09-30T21:59:59Z'), contest)).toEqual({ status: 'upcoming', secondsLeft: 1 });
    expect(arenaContestStatus(new Date('2026-09-30T22:00:00Z'), contest).status).toBe('live');
    expect(arenaContestStatus(new Date('2026-10-05T03:59:59Z'), contest)).toEqual({ status: 'live', secondsLeft: 0 });
    expect(arenaContestStatus(new Date('2026-10-05T04:00:00Z'), contest)).toEqual({ status: 'ended', secondsLeft: 0 });
  });
});
