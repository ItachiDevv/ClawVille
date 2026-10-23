import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Founder 2026-10-22 ("make it so it survives a restart"): the autonomy
// driver's prior teacher questions live in platform_agents.config
// .priorTalkQuestions = { ownerUserId, byBuilding: { <buildingId>: string[] } }.
// Pins the pure parser (owner scope, id/key/list bounds, normalization) and the
// write shape (ONE update, values bound as parameters). No real DB: the
// database module's `db` is replaced; `agents` and `sql` stay real.

type Captured = { op: 'update' | 'select'; set?: Record<string, unknown>; whereCalls: number };
let captured: Captured[] = [];
let selectRows: Array<{ config: unknown }> = [];

const fakeDb = {
  update: () => {
    const record: Captured = { op: 'update', whereCalls: 0 };
    captured.push(record);
    return {
      set: (value: Record<string, unknown>) => {
        record.set = value;
        return {
          where: async () => {
            record.whereCalls++;
          },
        };
      },
    };
  },
  select: () => {
    const record: Captured = { op: 'select', whereCalls: 0 };
    captured.push(record);
    return {
      from: () => ({
        where: () => {
          record.whereCalls++;
          return { limit: async () => selectRows };
        },
      }),
    };
  },
};

const realDatabase = await import('@clawville/database');
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

const state = await import('../agent-autonomy-state');
const {
  parseStoredPriorTalkQuestions,
  normalizePriorTalkQuestions,
  getPriorTalkQuestions,
  setPriorTalkQuestionsForBuilding,
  decidePriorTalkQuestionsWrite,
  parseStoredPriorTalkQuestionsOwnerStamp,
  PRIOR_TALK_QUESTIONS_MAX,
  PRIOR_TALK_QUESTION_MAX_CHARS,
  PRIOR_TALK_QUESTION_BUILDINGS_MAX,
} = state;

afterAll(() => {
  mock.module('@clawville/database', () => realDatabase);
});

beforeEach(() => {
  captured = [];
  selectRows = [];
});

const OWNER = 'owner-user-1';

describe('parseStoredPriorTalkQuestions', () => {
  it('reads a valid object for the matching owner', () => {
    const map = parseStoredPriorTalkQuestions(
      { ownerUserId: OWNER, byBuilding: { 'memory-rag': ['what is a vector index'] } },
      OWNER,
    );
    expect([...map]).toEqual([['memory-rag', ['what is a vector index']]]);
  });

  it('discards the whole object on an owner mismatch', () => {
    const raw = { ownerUserId: 'someone-else', byBuilding: { 'memory-rag': ['q one'] } };
    expect(parseStoredPriorTalkQuestions(raw, OWNER).size).toBe(0);
    expect(parseStoredPriorTalkQuestions(raw, null).size).toBe(0);
    expect(
      parseStoredPriorTalkQuestions({ ownerUserId: null, byBuilding: { 'memory-rag': ['q one'] } }, OWNER).size,
    ).toBe(0);
  });

  it('null owner matches null owner; a missing ownerUserId reads as null', () => {
    const viaNull = parseStoredPriorTalkQuestions({ ownerUserId: null, byBuilding: { 'memory-rag': ['q one'] } }, null);
    expect(viaNull.get('memory-rag')).toEqual(['q one']);
    const viaMissing = parseStoredPriorTalkQuestions({ byBuilding: { 'memory-rag': ['q two'] } }, null);
    expect(viaMissing.get('memory-rag')).toEqual(['q two']);
  });

  it('drops bad building ids and malformed lists, keeps the valid entries', () => {
    const map = parseStoredPriorTalkQuestions(
      {
        ownerUserId: OWNER,
        byBuilding: {
          'Memory-RAG': ['upper case id'],
          'has space': ['space id'],
          ['x'.repeat(65)]: ['too long id'],
          'not-a-list': 'just a string',
          'mixed-list': ['ok', 42],
          'all-blank': ['   ', '\n'],
          'memory-rag': ['kept question'],
        },
      },
      OWNER,
    );
    expect([...map]).toEqual([['memory-rag', ['kept question']]]);
  });

  it('caps the building keys at 16', () => {
    const byBuilding: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++) byBuilding[`b-${i}`] = [`question ${i}`];
    const map = parseStoredPriorTalkQuestions({ ownerUserId: OWNER, byBuilding }, OWNER);
    expect(PRIOR_TALK_QUESTION_BUILDINGS_MAX).toBe(16);
    expect(map.size).toBe(16);
    expect(map.has('b-15')).toBe(true);
    expect(map.has('b-16')).toBe(false);
  });

  it('re-normalizes each list: whitespace, trim, 160 cap, dedupe to newest, last 4', () => {
    const map = parseStoredPriorTalkQuestions(
      {
        ownerUserId: OWNER,
        byBuilding: {
          'memory-rag': ['  alpha\n\n one ', 'bravo', 'alpha one', 'charlie', 'delta', 'echo', 'y'.repeat(300)],
        },
      },
      OWNER,
    );
    expect(map.get('memory-rag')).toEqual(['charlie', 'delta', 'echo', 'y'.repeat(PRIOR_TALK_QUESTION_MAX_CHARS)]);
    expect(PRIOR_TALK_QUESTIONS_MAX).toBe(4);
    expect(normalizePriorTalkQuestions(['a', 'b', 'a'])).toEqual(['b', 'a']);
  });

  it('non-object or garbage input reads as empty', () => {
    for (const raw of [undefined, null, 'text', 42, [], ['a'], { ownerUserId: OWNER }, { ownerUserId: 7, byBuilding: {} }, { ownerUserId: OWNER, byBuilding: [] }]) {
      expect(parseStoredPriorTalkQuestions(raw, OWNER).size).toBe(0);
    }
  });
});

describe('prior questions DB wrappers', () => {
  it('getPriorTalkQuestions parses config.priorTalkQuestions under the given owner', async () => {
    selectRows = [{ config: { other: 1, priorTalkQuestions: { ownerUserId: OWNER, ownerSetAt: 4_000, byBuilding: { 'memory-rag': ['q'] } } } }];
    const mine = await getPriorTalkQuestions('pa-1', OWNER);
    expect([...mine.questions]).toEqual([['memory-rag', ['q']]]);
    expect(mine).toMatchObject({ present: true, storedOwnerUserId: OWNER, storedOwnerSetAt: 4_000 });
    // Owner mismatch: no questions, but the stored owner + stamp still come back.
    const other = await getPriorTalkQuestions('pa-1', 'other-owner');
    expect(other.questions.size).toBe(0);
    expect(other).toMatchObject({ present: true, storedOwnerUserId: OWNER, storedOwnerSetAt: 4_000 });
    selectRows = [];
    expect(await getPriorTalkQuestions('pa-1', OWNER)).toEqual({
      questions: new Map(),
      present: false,
      storedOwnerUserId: null,
      storedOwnerSetAt: null,
    });
  });

  it('parseStoredPriorTalkQuestionsOwnerStamp reads owner + stamp for any owner, null stamp when not a finite number', () => {
    expect(parseStoredPriorTalkQuestionsOwnerStamp({ ownerUserId: 'x', ownerSetAt: 9, byBuilding: {} }))
      .toEqual({ present: true, storedOwnerUserId: 'x', storedOwnerSetAt: 9 });
    expect(parseStoredPriorTalkQuestionsOwnerStamp({ byBuilding: {} }))
      .toEqual({ present: true, storedOwnerUserId: null, storedOwnerSetAt: null });
    expect(parseStoredPriorTalkQuestionsOwnerStamp({ ownerUserId: 'x', ownerSetAt: '9' }))
      .toEqual({ present: true, storedOwnerUserId: 'x', storedOwnerSetAt: null });
    for (const raw of [undefined, null, 'text', 7, []]) {
      expect(parseStoredPriorTalkQuestionsOwnerStamp(raw))
        .toEqual({ present: false, storedOwnerUserId: null, storedOwnerSetAt: null });
    }
    // Old (pre-stamp) objects still parse questions for the same owner.
    expect(parseStoredPriorTalkQuestions({ ownerUserId: OWNER, byBuilding: { 'memory-rag': ['q'] } }, OWNER).size).toBe(1);
  });

  it('setPriorTalkQuestionsForBuilding is ONE update with every value bound as a parameter', async () => {
    const questions = ["what's a 'vector' index", 'how does chunking work'];
    await setPriorTalkQuestionsForBuilding('pa-1', OWNER, 'memory-rag', questions, 1_700_000_000_123);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.op).toBe('update');
    expect(captured[0]!.whereCalls).toBe(1);
    expect(captured[0]!.set!.updatedAt).toBeInstanceOf(Date);

    const query = new PgDialect().sqlToQuery(captured[0]!.set!.config as SQL);
    expect(query.sql).toContain(`|| jsonb_build_object('priorTalkQuestions', CASE`);
    expect(query.sql).toContain('IS NOT DISTINCT FROM');
    expect(query.sql).toContain(`jsonb_typeof(`);
    expect(query.sql).not.toContain('jsonb_set');
    // Values travel as parameters, never inside the SQL text.
    expect(query.sql).not.toContain('vector');
    expect(query.sql).not.toContain(OWNER);
    expect(query.sql).not.toContain('memory-rag');
    expect(query.params).toContain(OWNER);
    expect(query.params).toContain('memory-rag');
    expect(query.params).toContain(JSON.stringify(questions));
    expect(query.params).toContain(1_700_000_000_123);
    expect(query.sql).toContain(`'ownerSetAt'`);
    expect(query.sql).toContain('GREATEST(');
    expect(query.sql).not.toContain('1700000000123');
  });

  it('one write never stores more than 4 normalized questions; a bad building id writes nothing', async () => {
    await setPriorTalkQuestionsForBuilding('pa-1', null, 'memory-rag', ['a', 'b', 'c', 'd', 'e', ' e '], 5);
    const query = new PgDialect().sqlToQuery(captured[0]!.set!.config as SQL);
    expect(query.params).toContain(JSON.stringify(['b', 'c', 'd', 'e']));
    expect(query.params).toContain(null);

    captured = [];
    await setPriorTalkQuestionsForBuilding('pa-1', OWNER, "x'); DROP TABLE agents; --", ['q'], 5);
    expect(captured).toHaveLength(0);
    for (const badStamp of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      await setPriorTalkQuestionsForBuilding('pa-1', OWNER, 'memory-rag', ['q'], badStamp);
    }
    expect(captured).toHaveLength(0);
  });
});

// Mirror of the write CASE (Codex r1 P1): a delayed write from an older owner
// generation must never replace a newer owner's stored object.
describe('decidePriorTalkQuestionsWrite', () => {
  const A = 'owner-a';
  const B = 'owner-b';

  it('same owner merges, whatever the stamps (old objects without a stamp too)', () => {
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: A, ownerSetAt: 200, byBuilding: {} }, A, 100)).toBe('merge');
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: A, byBuilding: {} }, A, 100)).toBe('merge');
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: null, byBuilding: {} }, null, 1)).toBe('merge');
    expect(decidePriorTalkQuestionsWrite({ byBuilding: {} }, null, 1)).toBe('merge');
  });

  it('missing or non-object stored value is replaced', () => {
    for (const stored of [undefined, null, 'text', 7, [], ['x']]) {
      expect(decidePriorTalkQuestionsWrite(stored, A, 100)).toBe('replace');
    }
  });

  it('another owner without a numeric stamp is replaced', () => {
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: B, byBuilding: {} }, A, 100)).toBe('replace');
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: B, ownerSetAt: '999', byBuilding: {} }, A, 100)).toBe('replace');
  });

  it('another owner with an older stamp is replaced; newer or equal is skipped', () => {
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: B, ownerSetAt: 99, byBuilding: {} }, A, 100)).toBe('replace');
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: B, ownerSetAt: 100, byBuilding: {} }, A, 100)).toBe('skip');
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: B, ownerSetAt: 101, byBuilding: {} }, A, 100)).toBe('skip');
  });

  it('a delayed owner-A write that lands after owner B registered and wrote leaves B object', () => {
    const stampA = 1_000;
    const stampB = 2_000; // B registered later: strictly larger generation stamp
    // B's first write replaced A's object.
    const afterB = { ownerUserId: B, ownerSetAt: stampB, byBuilding: { 'memory-rag': ['b question'] } };
    expect(decidePriorTalkQuestionsWrite({ ownerUserId: A, ownerSetAt: stampA, byBuilding: {} }, B, stampB)).toBe('replace');
    // A's delayed write (submitted before the move) must not touch it.
    expect(decidePriorTalkQuestionsWrite(afterB, A, stampA)).toBe('skip');
    // B keeps merging.
    expect(decidePriorTalkQuestionsWrite(afterB, B, stampB)).toBe('merge');
  });
});
