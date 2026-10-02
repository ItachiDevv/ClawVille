import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  AGENT_SESSION_NOT_LEDGER_AUTHORIZED_BODY,
  botKnowledgeAccessible,
  botKnowledgeAppend,
  botKnowledgeWriteOwnerCondition,
} from '../agent-bot-knowledge';

const dialect = new PgDialect();
type TestSession = { ledgerCapable?: boolean; boundUserId?: string | null };
const render = (session: TestSession) =>
  dialect.sqlToQuery(botKnowledgeWriteOwnerCondition(session));

describe('security C4 — bot-knowledge write owner condition', () => {
  // The rule is connect-sec's use-time owner proof (boundUserId === row
  // user_id); the ledger flag plays no part, so an owner-proven non-ledger
  // session (restored after a deploy, the /enter keeper) writes its own row.
  test.each([
    ['a ledger-capable owner session', { ledgerCapable: true, boundUserId: 'owner-a' }],
    ['an owner-proven non-ledger session (restored / keeper)', { ledgerCapable: false, boundUserId: 'owner-a' }],
    ['an owner proof with no ledger flag at all', { boundUserId: 'owner-a' }],
  ] as const)('%s may write an unbound row or its own owner row', (_label, session) => {
    expect(render(session)).toMatchObject({
      sql: '("openclaw_bots"."user_id" IS NULL OR "openclaw_bots"."user_id" = $1)',
      params: ['owner-a'],
    });
  });

  test.each([
    ['ledger flag without a proven owner', { ledgerCapable: true, boundUserId: null }],
    ['non-ledger without a proven owner', { ledgerCapable: false, boundUserId: null }],
    ['anonymous', {}],
  ] as const)('%s may write only an unbound row', (_label, session) => {
    expect(render(session)).toMatchObject({ sql: '"openclaw_bots"."user_id" is null', params: [] });
  });

  test('the append is one jsonb || expression that carries only the new entries', () => {
    // No previously-read array is written back, so two allowed concurrent
    // appends cannot drop each other's entry.
    expect(dialect.sqlToQuery(botKnowledgeAppend(['lesson a', 'lesson "b"']))).toMatchObject({
      sql: `coalesce("openclaw_bots"."knowledge", '[]'::jsonb) || $1::jsonb`,
      params: ['["lesson a","lesson \\"b\\""]'],
    });
  });
});

describe('security C5 — bot-knowledge access predicate', () => {
  const sessions: TestSession[] = [
    { ledgerCapable: true, boundUserId: 'owner-a' },
    { ledgerCapable: true, boundUserId: 'owner-b' },
    { ledgerCapable: false, boundUserId: 'owner-a' },
    { ledgerCapable: false, boundUserId: 'owner-b' },
    { ledgerCapable: true, boundUserId: null },
    { ledgerCapable: false, boundUserId: null },
    {},
  ];

  test('an unbound row is open to every session', () => {
    for (const session of sessions) {
      expect(botKnowledgeAccessible(session, null)).toBe(true);
    }
  });

  test('an owned row is open exactly when boundUserId equals the row owner (ledger flag ignored)', () => {
    for (const session of sessions) {
      expect(botKnowledgeAccessible(session, 'owner-a')).toBe(session.boundUserId === 'owner-a');
    }
    expect(botKnowledgeAccessible({ boundUserId: 'owner-a' }, 'owner-a')).toBe(true);
    // An owner-proven non-ledger session (restored after a deploy, /enter keeper).
    const restored: TestSession = { ledgerCapable: false, boundUserId: 'owner-a' };
    expect(botKnowledgeAccessible(restored, 'owner-a')).toBe(true);
    // A different owner, a null owner proof and an anonymous session are refused.
    expect(botKnowledgeAccessible({ boundUserId: 'owner-b' }, 'owner-a')).toBe(false);
    expect(botKnowledgeAccessible({ boundUserId: null }, 'owner-a')).toBe(false);
    expect(botKnowledgeAccessible({}, 'owner-a')).toBe(false);
  });

  test('the write condition admits exactly the rows the predicate admits', () => {
    // Evaluate the rendered SQL against each live owner and compare.
    for (const session of sessions) {
      const { sql, params } = render(session);
      for (const owner of [null, 'owner-a', 'owner-b']) {
        const holds = sql.includes('IS NULL OR')
          ? owner === null || owner === params[0]
          : owner === null;
        expect(holds).toBe(botKnowledgeAccessible(session, owner));
      }
    }
  });

  test('the refusal body carries the shared not-ledger code', () => {
    expect(AGENT_SESSION_NOT_LEDGER_AUTHORIZED_BODY).toEqual({
      error: 'agent_session_not_ledger_authorized',
      code: 'agent_session_not_ledger_authorized',
    });
  });
});
