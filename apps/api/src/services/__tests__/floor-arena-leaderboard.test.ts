import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FLOOR_ARENA_CONTEST, FLOOR_ARENA_HOUSE_AGENTS } from '@clawville/shared';
import {
  closedInWindowSql,
  isArenaLeaderboardWindow,
  isContestEligible,
  openInWindowSql,
  rankArenaLeaderboard,
  resolveLeaderboardBounds,
  toCents,
  windowPnlMultSql,
  windowPnlUsdSql,
  type ArenaAgentAggregate,
} from '../floor-arena/leaderboard';
import { ARENA_CONTEST_FINAL_GRACE_MS, arenaContestStandings, arenaContestStatus, contestTop } from '../floor-arena/contest';
import { floorArenaNameKey, isFloorArenaReservedName } from '../floor-arena/names';
import { FLOOR_ARENA_EXTRA_FOLDS } from '../floor-arena/name-folds';
import { ENTRY_TX_TIMEOUT_MS } from '../floor-arena/engine';
import {
  FLOOR_ARENA_CONFUSABLES,
  FLOOR_ARENA_CONFUSABLES_DATE,
  FLOOR_ARENA_CONFUSABLES_EXTRA_KEYS,
  FLOOR_ARENA_CONFUSABLES_VERSION,
} from '../floor-arena/confusables.generated';
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
    windowOpenPositions: 0,
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

  test('D30: eligibility counts the same window trades as the score, a trade closed after the end included (rule 6)', () => {
    // `trades` on the contest window = closed positions opened inside it, whatever the close time.
    const rows = rankArenaLeaderboard([
      agg({ agentId: 'closed-after-end', realisedUsd: 4, trades: 1 }),
      agg({ agentId: 'still-open-only', realisedUsd: 0, trades: 0, windowOpenPositions: 1 }),
    ], 'contest');
    expect(rows.map((row) => [row.agentId, row.eligible])).toEqual([['closed-after-end', true], ['still-open-only', false]]);
    expect(contestTop(rows).map((row) => row.agentId)).toEqual(['closed-after-end']);
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

  test('24h and all: the P&L predicate excludes pnl_usd NULL (unresolved) from realised, trades, wins, losses and deaths', () => {
    for (const window of ['24h', 'all'] as const) {
      const bounds = resolveLeaderboardBounds(window, new Date());
      const dialect = new PgDialect();
      expect(dialect.sqlToQuery(closedInWindowSql(bounds)).sql).toStartWith("p.status = 'closed' AND p.pnl_usd IS NOT NULL");
      expect(dialect.sqlToQuery(windowPnlUsdSql(bounds)).sql).toBe('p.pnl_usd');
      expect(dialect.sqlToQuery(windowPnlMultSql(bounds)).sql).toBe('p.pnl_mult');
    }
  });

  test('D31: on the contest window an unresolved close counts, as a loss of its open stake', () => {
    const bounds = resolveLeaderboardBounds('contest', new Date());
    const dialect = new PgDialect();
    expect(bounds.unresolvedAsLoss).toBe(true);
    expect(dialect.sqlToQuery(closedInWindowSql(bounds)).sql)
      .toStartWith("p.status = 'closed' AND (p.pnl_usd IS NOT NULL OR p.exit_reason = 'unresolved')");
    // realised_usd = gross proceeds of earlier TP legs; the rest of the stake sells for 0.
    expect(dialect.sqlToQuery(windowPnlUsdSql(bounds)).sql).toBe('COALESCE(p.pnl_usd, p.realised_usd - p.size_usd)');
    expect(dialect.sqlToQuery(windowPnlMultSql(bounds)).sql).toBe('COALESCE(p.pnl_mult, p.realised_usd / p.size_usd)');
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

  test('D30 contest: opened inside the window, whatever the close time', () => {
    expect(resolveLeaderboardBounds('contest', now)).toEqual({
      openedFrom: new Date(FLOOR_ARENA_CONTEST.startsAt),
      openedTo: new Date(FLOOR_ARENA_CONTEST.endsAt),
      closedFrom: null,
      closedTo: null,
      unresolvedAsLoss: true,
    });
  });

  test('24h: closed in the last 24 hours; all: no bounds', () => {
    expect(resolveLeaderboardBounds('24h', now)).toEqual({
      openedFrom: null, openedTo: null, closedFrom: new Date('2026-10-01T12:00:00Z'), closedTo: null, unresolvedAsLoss: false,
    });
    expect(resolveLeaderboardBounds('all', now)).toEqual({
      openedFrom: null, openedTo: null, closedFrom: null, closedTo: null, unresolvedAsLoss: false,
    });
  });

  test('D30: the contest score predicate has NO close-time bound (a window position closing after the end counts)', () => {
    const start = new Date(FLOOR_ARENA_CONTEST.startsAt).toISOString();
    const end = new Date(FLOOR_ARENA_CONTEST.endsAt).toISOString();
    const query = new PgDialect().sqlToQuery(closedInWindowSql(resolveLeaderboardBounds('contest', now)));
    expect(query.sql).toBe(
      "p.status = 'closed' AND (p.pnl_usd IS NOT NULL OR p.exit_reason = 'unresolved') AND p.opened_at >= $1::timestamptz AND p.opened_at <= $2::timestamptz",
    );
    expect(query.sql).not.toContain('closed_at');
    expect(query.params).toEqual([start, end]);
    // Provisional standings: positions opened inside the window and still open.
    const open = new PgDialect().sqlToQuery(openInWindowSql(resolveLeaderboardBounds('contest', now)));
    expect(open.sql).toBe("p.status = 'open' AND p.opened_at >= $1::timestamptz AND p.opened_at <= $2::timestamptz");
    expect(open.params).toEqual([start, end]);
  });

  test('the SQL predicate binds each bound as an ISO timestamptz; 24h and all keep their old SQL', () => {
    const day = new PgDialect().sqlToQuery(closedInWindowSql(resolveLeaderboardBounds('24h', now)));
    expect(day.sql).toBe("p.status = 'closed' AND p.pnl_usd IS NOT NULL AND p.closed_at >= $1::timestamptz");
    expect(day.params).toEqual(['2026-10-01T12:00:00.000Z']);
    const all = new PgDialect().sqlToQuery(closedInWindowSql(resolveLeaderboardBounds('all', now)));
    expect(all.sql).toBe("p.status = 'closed' AND p.pnl_usd IS NOT NULL");
  });

  test('window names are a closed set', () => {
    expect(['contest', '24h', 'all'].every(isArenaLeaderboardWindow)).toBe(true);
    expect(isArenaLeaderboardWindow('7d')).toBe(false);
    expect(isArenaLeaderboardWindow(undefined)).toBe(false);
  });

  test('D30: standings are null before the end; provisional while a window position is open or inside the grace; then final', () => {
    const contest = { startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' };
    const end = new Date(contest.endsAt).getTime();
    const at = (ms: number) => new Date(end + ms);
    expect(arenaContestStandings(new Date('2026-10-01T00:00:00Z'), 3, contest)).toEqual({ standings: null, openWindowPositions: null });
    expect(arenaContestStandings(at(0), 0, contest)).toEqual({ standings: null, openWindowPositions: null });
    expect(arenaContestStandings(at(1_000), 0, contest)).toEqual({ standings: 'provisional', openWindowPositions: 0 });
    expect(arenaContestStandings(at(1_000), 2, contest)).toEqual({ standings: 'provisional', openWindowPositions: 2 });
    // 5 min: the engine stamps opened_at inside the entry transaction (insert time), and the database
    // ends that transaction after ENTRY_TX_TIMEOUT_MS; the margin must stay above that bound.
    expect(ARENA_CONTEST_FINAL_GRACE_MS).toBe(5 * 60_000);
    expect(ARENA_CONTEST_FINAL_GRACE_MS).toBeGreaterThan(ENTRY_TX_TIMEOUT_MS);
    expect(arenaContestStandings(at(4 * 60_000), 0, contest).standings).toBe('provisional');
    expect(arenaContestStandings(at(ARENA_CONTEST_FINAL_GRACE_MS - 1), 0, contest).standings).toBe('provisional');
    expect(arenaContestStandings(at(ARENA_CONTEST_FINAL_GRACE_MS), 0, contest)).toEqual({ standings: 'final', openWindowPositions: 0 });
    // A position held to the 24 h cap plus the 30-min unresolved rule keeps the standings provisional.
    expect(arenaContestStandings(at(24.5 * 3_600_000), 1, contest)).toEqual({ standings: 'provisional', openWindowPositions: 1 });
  });

  test('D30: a position inserted after the end is outside the contest set and the open count, so final stays final', () => {
    // The engine stamps opened_at with the insert-time clock (engine.ts openPosition `insertMs`), so a
    // position inserted after the end has opened_at > endsAt. Both contest predicates bound opened_at
    // by endsAt, inclusive, with the same bound value.
    const end = new Date(FLOOR_ARENA_CONTEST.endsAt).toISOString();
    const bounds = resolveLeaderboardBounds('contest', now);
    for (const predicate of [closedInWindowSql(bounds), openInWindowSql(bounds)]) {
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toContain('p.opened_at <= $2::timestamptz');
      expect(query.params[1]).toBe(end);
    }
    // No position can join the open count after the end, so once final, every later read is final.
    const contest = { startsAt: FLOOR_ARENA_CONTEST.startsAt, endsAt: FLOOR_ARENA_CONTEST.endsAt };
    const endMs = new Date(contest.endsAt).getTime();
    for (const later of [ARENA_CONTEST_FINAL_GRACE_MS, 3_600_000, 24.5 * 3_600_000, 7 * 86_400_000]) {
      expect(arenaContestStandings(new Date(endMs + later), 0, contest)).toEqual({ standings: 'final', openWindowPositions: 0 });
    }
  });

  test('contest status flips at the exact start and end', () => {
    const contest = { startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' };
    expect(arenaContestStatus(new Date('2026-09-30T21:59:59Z'), contest)).toEqual({ status: 'upcoming', secondsLeft: 1 });
    expect(arenaContestStatus(new Date('2026-09-30T22:00:00Z'), contest).status).toBe('live');
    expect(arenaContestStatus(new Date('2026-10-05T03:59:59Z'), contest)).toEqual({ status: 'live', secondsLeft: 0 });
    expect(arenaContestStatus(new Date('2026-10-05T04:00:00Z'), contest)).toEqual({ status: 'ended', secondsLeft: 0 });
  });
});

describe('reserved arena names (house agents)', () => {
  const reserved = (name: string) => ({ name, reserved: isFloorArenaReservedName(name) });

  test('the look-alike table is generated from Unicode confusables.txt (UTS #39)', () => {
    expect(FLOOR_ARENA_CONFUSABLES_VERSION).toBe('18.0.0');
    expect(FLOOR_ARENA_CONFUSABLES_DATE).toBe('2026-08-06, 01:05:35 GMT');
    expect(Object.keys(FLOOR_ARENA_CONFUSABLES).length).toBe(2263);
    // Every prototype is ASCII letters/digits or extra-fold keys (the chain: Cyrillic small en -> U+029C -> h).
    expect(Object.values(FLOOR_ARENA_CONFUSABLES).every((target) =>
      target.length > 0 && [...target].every((ch) => /^[A-Za-z0-9]$/.test(ch) || ch in FLOOR_ARENA_EXTRA_FOLDS))).toBe(true);
    // The generated file was made with the current extra folds (re-run the generator after a change).
    expect([...FLOOR_ARENA_CONFUSABLES_EXTRA_KEYS]).toEqual(Object.keys(FLOOR_ARENA_EXTRA_FOLDS).sort());
    expect(FLOOR_ARENA_CONFUSABLES).toMatchObject({ '\u0193': 'G', '\u018a': 'D', '\u0491': 'r' });
    expect(FLOOR_ARENA_CONFUSABLES).toMatchObject({
      '\u039d': 'N', '\u03bd': 'v', '\u13c0': 'G', '\u13ac': 'E', '\u13da': 'S', '\u13a5': 'i', '\u0435': 'e',
      '0': 'O', '1': 'l', 'I': 'l', '|': 'l', 'm': 'rn',
    });
  });

  test('the extra folds (not in UTS #39) never override the generated table and map to one ASCII letter', () => {
    for (const [source, target] of Object.entries(FLOOR_ARENA_EXTRA_FOLDS)) {
      expect({ source, inTable: source in FLOOR_ARENA_CONFUSABLES, oneLetter: /^[a-z]$/.test(target) })
        .toEqual({ source, inTable: false, oneLetter: true });
    }
    expect(Object.keys(FLOOR_ARENA_EXTRA_FOLDS).sort()).toEqual([
      '3', '4', '5', '7', '9', '\u0262', '\u0274', '\u0280', '\u0299', '\u029c', '\u029f',
      '\u1d00', '\u1d05', '\u1d07', '\u1d0a', '\u1d0b', '\u1d0d', '\u1d18', '\u1d1b',
    ].sort());
  });

  test('every house name and its spacing, punctuation and case variants are reserved', () => {
    for (const name of [
      'Genesis', 'genesis', 'GENESIS', 'gEnEsIs', ' Genesis ', 'Gen.esis', 'Runner', 'run-ner', 'R_u_n_n_e_r', 'Dip Hunter',
      'DipHunter', 'dip.hunter', 'Mid-Cap Climber', 'midcap climber', 'MID-cap climber', 'Mid Cap-Climber', 'Late Bloomer',
      'LATE BLOOMER', 'late_bloomer', "Late'Bloomer",
    ]) {
      expect(reserved(name)).toEqual({ name, reserved: true });
    }
  });

  test('Codex r19/r20: bypass attempts are reserved', () => {
    for (const name of [
      'Ge\u039desis',                              // Greek CAPITAL Nu (Codex r19): reads as N, not v
      '\u13c0\u13acne\u13da\u13a5s',               // Cherokee look-alikes (Codex r20)
      '\u13a1unner',                               // Cherokee letter E reads as R
      'GEN\u0395SIS',                              // Greek capital Epsilon
      '\u039cid-Cap Climber',                      // Greek capital Mu
      'Dip \u0397unter',                           // Greek capital Eta
      'RUNN\u0415R',                               // Cyrillic capital Ie
      'G\u0435nesis',                              // Cyrillic small e
      'Gen\u0435s\u0456s',                         // Cyrillic e and i
      '\uff27\uff45\uff4e\uff45\uff53\uff49\uff53', // full-width "Genesis"
      '\ud835\udc06\ud835\udc1e\ud835\udc27\ud835\udc1e\ud835\udc2c\ud835\udc22\ud835\udc2c', // mathematical bold "Genesis"
      'G\u200benesis',                             // zero-width space
      'Run\u2060ner',                              // word joiner
      'Run\ufeffner',                              // BOM
      'Mid\u2011Cap Climber',                      // non-breaking hyphen
      'Mid\u2014Cap\u00a0Climber',                 // em dash, no-break space
      'G\u0301enesis',                             // combining accent
      'G\u00e9n\u00e9sis',                         // precomposed accents
      'Late Bl00mer',                              // zero reads as O
      'Late B1oomer',                              // one reads as l
      'LATE BIOOMER',                              // capital I reads as l
      'Mid-Cap C1imber',
      'Mid-Cap Clirnber',                          // m reads as rn
      // Extra folds (not in UTS #39): leetspeak digits and Latin small capitals
      'Genesi5', 'Gen3sis', 'Dip Hunt3r', 'L4te Bloomer', 'Dip Hun7er', '9enesis',
      '\u0280unner', '\u0262enesis', '\u1d05ip \u029cunter', 'Mid-\u1d04ap \u1d04li\u1d0dber', '\u029fate \u0299loomer',
      'Ru\u0274\u0274er', 'L\u1d00te Bloomer', 'Dip Hu\u0274\u1d1b\u1d07r', 'Mid-Ca\u1d18 Climber',
      // Chains: a Unicode prototype that is an extra-fold key folds on to its letter
      'Dip \u043dunter',                           // Cyrillic small en -> U+029C -> h
      'Dip Hun\u0442er', 'Dip Hun\u03c4er',          // Cyrillic small te, Greek small tau -> U+1D1B -> t
      'Late \u0432loomer',                         // Cyrillic small ve -> U+0299 -> b
      '\uab71unner',                               // Cherokee small letter E -> U+0280 -> r
      'Gen\u01b7sis',                              // Latin capital ezh -> 3 -> e
      'Genesi\uff15',                              // full-width 5 -> 5 -> s
      // Codex r21: prototypes with punctuation are cleaned like the name ("G'" -> G)
      '\u0193enesis',                              // G with hook, prototype G'
      '\u018aip Hunter',                           // D with hook, prototype D'
      'Dip Hun\u01acer',                           // T with hook, prototype T'
      'Late \u0181loomer',                         // B with hook, prototype B'
      'Mid-\u0187ap Climber',                      // C with hook, prototype C'
      'Runne\u0491',                               // Cyrillic ghe with upturn, prototype r'
      'Mid-Cap C\u0140imber',                      // l with middle dot, prototype l.
    ]) {
      expect(reserved(name)).toEqual({ name, reserved: true });
    }
  });

  test('every Unicode look-alike of every house-name letter keeps the name reserved', () => {
    // For each letter of each house name: every non-ASCII source in the table whose target is that
    // letter, put in its place. Sources that NFKC or NFD would change first are skipped (the key
    // normalises before it maps, so those are read through their normal form instead).
    const misses: string[] = [];
    let checked = 0;
    for (const house of FLOOR_ARENA_HOUSE_AGENTS) {
      const letters = [...house.name];
      letters.forEach((letter, index) => {
        if (!/[A-Za-z]/.test(letter)) return;
        for (const [source, target] of Object.entries(FLOOR_ARENA_CONFUSABLES)) {
          if (/^[\x00-\x7f]$/.test(source) || /\p{M}/u.test(source)) continue;
          if (source.normalize('NFKC') !== source || source.normalize('NFD') !== source) continue;
          if (floorArenaNameKey(target) !== floorArenaNameKey(letter)) continue;
          const name = [...letters.slice(0, index), source, ...letters.slice(index + 1)].join('');
          checked += 1;
          if (!isFloorArenaReservedName(name)) misses.push(`${house.name}: ${name}`);
        }
      });
    }
    expect(misses).toEqual([]);
    expect(checked).toBeGreaterThan(500);
  });

  test('names Unicode does not list as look-alikes stay free (no reservation by an unknown letter)', () => {
    for (const name of [
      'Ge\u732besis',                              // Codex r20: a CJK letter does not read as n
      'Ge\u10e6esis',                              // Georgian letter: not a confusable of n (no backstop)
      'Ge\u03bdesis',                              // small nu reads as v
      'Genesis2', 'Genesys', 'Agent 47', 'R2D2', 'Runner 9000', 'Late Bloomer 7', 'Dip Hunter 3',
      'Genesis Fan', 'Genesis 2', 'Genesis Bot', 'My Runner', 'Runners', 'Rumer', 'Dip', 'Hunter', 'Climber', 'Bloom',
      'Satoshi', 'Arena Agent', 'Nori', 'Ren\u00e9e', 'S\u00f8ren', 'Sigma \u03a3', 'Gemini', 'Jenesis',
      '\u0413\u0435\u043d\u0435\u0437\u0438\u0441',     // Cyrillic "Genezis": not every letter is a confusable
      '\u30b8\u30a7\u30cd\u30b7\u30b9\u3067\u3059',     // 7 Japanese letters
    ]) {
      expect(reserved(name)).toEqual({ name, reserved: false });
    }
    expect(isFloorArenaReservedName('')).toBe(false);
    expect(isFloorArenaReservedName(' -_. ')).toBe(false);
  });

  test('the key: exact shape first, then case; i and l are one letter because Unicode reads capital I as l', () => {
    expect(floorArenaNameKey('Mid-Cap Climber')).toBe(floorArenaNameKey('midcap.climber'));
    expect(floorArenaNameKey('Ge\u039desis')).toBe(floorArenaNameKey('Genesis'));
    expect(floorArenaNameKey('Ge\u03bdesis')).toBe('gevesls');
    expect(floorArenaNameKey('GENESIS')).toBe(floorArenaNameKey('genesis'));
    expect(floorArenaNameKey('MIDCAP')).toBe(floorArenaNameKey('midcap'));
    expect(floorArenaNameKey("O'Brien_2")).toBe('obrlen2');
  });
});
