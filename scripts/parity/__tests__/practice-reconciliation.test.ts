import { describe, expect, test } from 'bun:test';
import { buildPracticeHoldemReconciliationScript } from '../teardown';

interface MockReply {
  status: number;
  body?: unknown;
}

interface FetchCall {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

async function execute(replies: MockReply[]): Promise<{
  result: unknown;
  calls: FetchCall[];
}> {
  const calls: FetchCall[] = [];
  const fetchMock = async (url: string, init: RequestInit = {}) => {
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    calls.push({
      url,
      method: init.method ?? 'GET',
      credentials: init.credentials,
      body:
        typeof init.body === 'string'
          ? JSON.parse(init.body)
          : null,
    });
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      async json() {
        return reply.body ?? null;
      },
    };
  };
  const script = buildPracticeHoldemReconciliationScript(
    'https://api-staging.example/',
  );
  const result = await new Function(
    'fetch',
    `return ${script}`,
  )(fetchMock);
  expect(replies).toHaveLength(0);
  return { result, calls };
}

describe('practice Hold’em reconciliation', () => {
  test('folds an active hand, closes its table, and proves absence', async () => {
    const run = await execute([
      {
        status: 200,
        body: {
          table: { id: 'practice-table' },
          hand: { handId: 'practice-hand' },
        },
      },
      { status: 200 },
      { status: 200 },
      { status: 404 },
    ]);
    expect(run.result).toEqual({
      clean: true,
      reconciled: true,
      absentStatus: 404,
    });
    expect(run.calls.map((call) => [
      call.method,
      call.url,
      call.body,
    ])).toEqual([
      [
        'GET',
        'https://api-staging.example/api/cove/holdem/session/current',
        null,
      ],
      [
        'POST',
        'https://api-staging.example/api/cove/holdem/action',
        { handId: 'practice-hand', action: 'fold' },
      ],
      [
        'POST',
        'https://api-staging.example/api/cove/holdem/session/close',
        { tableId: 'practice-table' },
      ],
      [
        'GET',
        'https://api-staging.example/api/cove/holdem/session/current',
        null,
      ],
    ]);
    expect(run.calls.every((call) =>
      call.credentials === 'include'
    )).toBe(true);
  });

  test('closes an idle table without manufacturing an action', async () => {
    const run = await execute([
      {
        status: 200,
        body: { table: { id: 'practice-table' }, hand: null },
      },
      { status: 200 },
      { status: 404 },
    ]);
    expect(run.result).toEqual({
      clean: true,
      reconciled: true,
      absentStatus: 404,
    });
    expect(run.calls.some((call) =>
      call.url.endsWith('/holdem/action')
    )).toBe(false);
  });

  test('accepts an already-absent session without mutating', async () => {
    const run = await execute([{ status: 404 }]);
    expect(run.result).toEqual({
      clean: true,
      reconciled: false,
      absentStatus: 404,
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
  });

  test('does not treat authentication failures as an absent session', async () => {
    for (const status of [401, 403]) {
      await expect(execute([{ status }])).rejects.toThrow(
        `practice holdem reconciliation current returned HTTP ${status}`,
      );
    }
  });

  test('requires a real 404 after closing the session', async () => {
    for (const status of [401, 403]) {
      await expect(execute([
        {
          status: 200,
          body: { table: { id: 'practice-table' }, hand: null },
        },
        { status: 200 },
        { status },
      ])).rejects.toThrow(
        `practice holdem reconciliation absence proof returned HTTP ${status}`,
      );
    }
  });

  test('fails closed with a sanitized HTTP-class error', async () => {
    await expect(execute([
      {
        status: 200,
        body: {
          table: { id: 'practice-table' },
          hand: { handId: 'practice-hand' },
        },
      },
      {
        status: 500,
        body: { secret: 'must-not-be-reflected' },
      },
    ])).rejects.toThrow(
      'practice holdem reconciliation fold returned HTTP 500',
    );
  });
});
