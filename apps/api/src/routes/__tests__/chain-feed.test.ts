import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createChainFeedHandler, defaultChainFeedDeps, loadChainFeedVerdicts, type ChainFeedDeps, type ChainFeedRow } from '../chain-feed';
import { chainFeedDemandMints, resetChainFeedDemand } from '../../services/floor-arena/chain-checks';

/**
 * Driven through the handler's dependency seam, so it runs with NO database and NO env change in the shared routes
 * lane process (no `mock.module`: that lane runs every file in one bun process).
 */

const SECRET = 'x'.repeat(40);
const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CHECKED_AT = '2026-10-31T08:00:00.000Z';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** `count` distinct valid 42-character base58 mints. */
function distinctMints(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${'1'.repeat(40)}${BASE58[Math.floor(i / 58)]}${BASE58[i % 58]}`);
}

function harness(over: Partial<ChainFeedDeps> = {}) {
  const asked: Array<readonly string[]> = [];
  const demanded: Array<readonly string[]> = [];
  const deps: ChainFeedDeps = {
    recordDemand: (mints) => { demanded.push(mints); },
    readSecret: () => SECRET,
    loadVerdicts: async (mints) => {
      asked.push(mints);
      return mints.map((mint): ChainFeedRow => ({ mint, verdict: { pass: true, fails: [], codes: [], checkedAt: CHECKED_AT }, checkedAt: CHECKED_AT }));
    },
    ...over,
  };
  const app = new Hono();
  app.get('/verdicts', createChainFeedHandler(deps));
  const call = (query: string, headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }) =>
    app.request(`/verdicts${query}`, { headers });
  return { asked, demanded, call };
}

describe('GET /api/internal/chain-feed/verdicts', () => {
  it('404 with an empty body while the secret is unset or shorter than 32 characters; no read', async () => {
    for (const secret of [null, 'short-secret']) {
      const h = harness({ readSecret: () => secret });
      const res = await h.call(`?mints=${MINT_A}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(h.asked).toEqual([]);
      expect(h.demanded).toEqual([]);
    }
  });

  it('401 for a missing, wrong or non-Bearer token; no read and the secret is never echoed', async () => {
    const h = harness();
    for (const headers of [{} as Record<string, string>, { Authorization: 'Bearer wrong' }, { Authorization: `Basic ${SECRET}` }, { Authorization: `Bearer ${SECRET}x` }]) {
      const res = await h.call(`?mints=${MINT_A}`, headers);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(SECRET);
    }
    expect(h.asked).toEqual([]);
    expect(h.demanded).toEqual([]);
  });

  it('400 for missing, empty, non-base58, too short or more than 200 mints', async () => {
    const h = harness();
    const many = distinctMints(201);
    for (const query of ['', '?mints=', '?mints=,,', `?mints=${MINT_A},0OIl${'1'.repeat(36)}`, '?mints=abc', `?mints=${many.join(',')}`]) {
      const res = await h.call(query);
      expect(res.status).toBe(400);
    }
    expect(h.asked).toEqual([]);
    expect(h.demanded).toEqual([]);
  });

  it('200: dedupes and trims the mints, answers { verdicts: [{ mint, verdict, checkedAt }] } with no-store', async () => {
    const h = harness();
    const res = await h.call(`?mints=${MINT_A},%20${MINT_B},${MINT_A}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.asked).toEqual([[MINT_A, MINT_B]]);
    expect(h.demanded).toEqual([[MINT_A, MINT_B]]);
    const body = await res.json() as { verdicts: Array<Record<string, unknown>> };
    expect(body.verdicts).toHaveLength(2);
    expect(body.verdicts[0]).toEqual({ mint: MINT_A, verdict: { pass: true, fails: [], codes: [], checkedAt: CHECKED_AT }, checkedAt: CHECKED_AT });
  });

  it('accepts exactly 200 distinct mints', async () => {
    const h = harness();
    const mints = distinctMints(200);
    expect(new Set(mints).size).toBe(200);
    const res = await h.call(`?mints=${mints.join(',')}`);
    expect(res.status).toBe(200);
    expect(h.asked[0]).toHaveLength(200);
  });

  describe('demand: a valid request makes its mints chain-check demand in this process', () => {
    beforeEach(() => { resetChainFeedDemand(); });

    it('the default recorder stores the asked mints; 401 and 400 store nothing', async () => {
      const h = harness({ recordDemand: undefined });
      expect((await h.call(`?mints=${MINT_A}`, { Authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await h.call('?mints=abc')).status).toBe(400);
      expect(chainFeedDemandMints()).toEqual([]);
      expect((await h.call(`?mints=${MINT_A},${MINT_B}`)).status).toBe(200);
      expect(chainFeedDemandMints().sort()).toEqual([MINT_A, MINT_B].sort());
      resetChainFeedDemand();
    });

    it('the production deps record demand', () => {
      expect(defaultChainFeedDeps.recordDemand).toBeDefined();
      defaultChainFeedDeps.recordDemand!([MINT_A]);
      expect(chainFeedDemandMints()).toEqual([MINT_A]);
      resetChainFeedDemand();
    });
  });
});

describe('loadChainFeedVerdicts: one read of the shared discovery table only', () => {
  const dialect = new PgDialect();

  it('reads floor_discovery_mints with a verdict, never floor_arena_private_mints; no write', async () => {
    const log: Array<{ sql: string; params: unknown[] }> = [];
    const database = {
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        log.push({ sql: query.sql.replace(/\s+/g, ' ').trim(), params: query.params });
        return [
          { mint: MINT_A, chain_verdict: { pass: false, fails: ['mint-authority'], codes: ['mint_authority'], checkedAt: CHECKED_AT }, chain_checked_at: new Date(CHECKED_AT) },
          { mint: MINT_B, chain_verdict: { pass: true }, chain_checked_at: 'not a date' },
        ];
      },
    };
    const rows = await loadChainFeedVerdicts([MINT_A, MINT_B], database as never);
    expect(log).toHaveLength(1);
    expect(log[0]!.sql).toMatch(/^SELECT mint, chain_verdict, chain_checked_at FROM floor_discovery_mints WHERE/);
    expect(log[0]!.sql).toContain('chain_verdict IS NOT NULL');
    expect(log[0]!.sql).not.toContain('floor_arena_private_mints');
    expect(log[0]!.sql).not.toMatch(/UPDATE|INSERT|DELETE/i);
    expect(log[0]!.params).toEqual([JSON.stringify([MINT_A, MINT_B])]);
    // A row whose check time does not parse is dropped; the other keeps the ISO time of chain_checked_at.
    expect(rows).toEqual([{ mint: MINT_A, verdict: { pass: false, fails: ['mint-authority'], codes: ['mint_authority'], checkedAt: CHECKED_AT }, checkedAt: CHECKED_AT }]);
  });
});
