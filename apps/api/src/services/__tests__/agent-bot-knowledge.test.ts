import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  AGENT_SESSION_NOT_LEDGER_AUTHORIZED_BODY,
  botKnowledgeAccessible,
  botKnowledgeAppend,
  botKnowledgeWriteOwnerCondition,
} from '../agent-bot-knowledge';
import { sessionLedgerCapable } from '../agent-owner-binding';

const dialect = new PgDialect();
const render = (session: { ledgerCapable?: boolean; boundUserId?: string | null }) =>
  dialect.sqlToQuery(botKnowledgeWriteOwnerCondition(session));

describe('security C4 — bot-knowledge write owner condition', () => {
  test('a proven session may write an unbound row or its own owner row', () => {
    expect(render({ ledgerCapable: true, boundUserId: 'owner-a' })).toMatchObject({
      sql: '("openclaw_bots"."user_id" IS NULL OR "openclaw_bots"."user_id" = $1)',
      params: ['owner-a'],
    });
  });

  test.each([
    ['non-ledger with a stamped owner (restored session)', { ledgerCapable: false, boundUserId: 'owner-a' }],
    ['ledger flag without a proven owner', { ledgerCapable: true, boundUserId: null }],
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
  const sessions = [
    { ledgerCapable: true, boundUserId: 'owner-a' },
    { ledgerCapable: true, boundUserId: 'owner-b' },
    { ledgerCapable: false, boundUserId: 'owner-a' },
    { ledgerCapable: true, boundUserId: null },
    {},
  ];

  test('an unbound row is open to every session', () => {
    for (const session of sessions) {
      expect(botKnowledgeAccessible(session, null)).toBe(true);
    }
  });

  test('an owned row is open exactly when sessionLedgerCapable holds', () => {
    for (const session of sessions) {
      expect(botKnowledgeAccessible(session, 'owner-a')).toBe(sessionLedgerCapable(session, 'owner-a'));
    }
    expect(botKnowledgeAccessible({ ledgerCapable: true, boundUserId: 'owner-a' }, 'owner-a')).toBe(true);
    expect(botKnowledgeAccessible({ ledgerCapable: true, boundUserId: 'owner-b' }, 'owner-a')).toBe(false);
    expect(botKnowledgeAccessible({ ledgerCapable: false, boundUserId: 'owner-a' }, 'owner-a')).toBe(false);
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
