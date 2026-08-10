import { describe, expect, test } from 'bun:test';
import { buildFixtureIssueScript } from '../fixture-recovery';

interface MockReply {
  status: number;
  body?: unknown;
}

interface FetchCall {
  url: string;
  method: string;
  headerAtCall: string | undefined;
  body: unknown;
}

async function execute(
  replies: MockReply[],
  cashTableId: string | null = null,
  preflightOnly = false,
): Promise<{
  result: unknown;
  calls: FetchCall[];
  releases: string[];
  window: Record<string, unknown>;
}> {
  const calls: FetchCall[] = [];
  const releases: string[] = [];
  const fakeWindow: Record<string, unknown> = {
    __CV_SET_FIXTURE_HEADER(header?: string) {
      fakeWindow.__CV_TEST_FIXTURE_HEADER = header;
    },
    __CV_RELEASE_FIXTURE_GATE(header?: string) {
      fakeWindow.__CV_TEST_FIXTURE_HEADER = header;
      if (header) releases.push(header);
    },
    localStorage: {
      setItem() {
        throw new Error('fixture credentials must not touch localStorage');
      },
    },
    sessionStorage: {
      setItem() {
        throw new Error('fixture credentials must not touch sessionStorage');
      },
    },
  };
  const fetchMock = async (url: string, init: RequestInit = {}) => {
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    let body: unknown = null;
    if (typeof init.body === 'string') {
      body = JSON.parse(init.body);
    }
    calls.push({
      url,
      method: init.method ?? 'GET',
      headerAtCall:
        typeof fakeWindow.__CV_TEST_FIXTURE_HEADER === 'string'
          ? fakeWindow.__CV_TEST_FIXTURE_HEADER
          : undefined,
      body,
    });
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      async json() {
        return reply.body ?? null;
      },
    };
  };
  const script = buildFixtureIssueScript(
    'bj-split',
    {
      apiBase: 'https://api-staging.example',
      maxLossPerRun: 50,
      maxDurationMs: 120_000,
    },
    cashTableId,
    preflightOnly,
  );
  const result = await new Function(
    'window',
    'fetch',
    'setTimeout',
    `return ${script}`,
  )(fakeWindow, fetchMock, (callback: () => void) => {
    callback();
    return 0;
  });
  expect(replies).toHaveLength(0);
  return { result, calls, releases, window: fakeWindow };
}

const recovery = (
  reason:
    | 'blackjack_hand_requires_settlement'
    | 'practice_ledger_recovery_required'
    | 'cash_recovery_required',
) => ({
  status: 409,
  body: {
    error: 'fixture_recovery_required',
    recovery: {
      runId: 'stale-run',
      token: 'stale-raw-token',
      reason,
    },
  },
});

const retrySuccess: MockReply = {
  status: 201,
  body: { runId: 'replacement-run', token: 'replacement-raw-token' },
};

describe('hard-death fixture recovery', () => {
  test('blackjack stands every active slot, closes shoe, deletes, and retries', async () => {
    const run = await execute([
      recovery('blackjack_hand_requires_settlement'),
      { status: 200, body: { shoe: { id: 'shoe-1' } } },
      {
        status: 200,
        body: {
          handId: 'hand-1',
          playerHands: [
            { isResolved: true },
            { isResolved: false },
          ],
        },
      },
      { status: 200, body: { status: 'in_progress' } },
      { status: 200, body: { hand: null } },
      { status: 200, body: { hand: null } },
      { status: 200, body: { closed: true } },
      { status: 404, body: { message: 'no_open_shoe' } },
      { status: 200, body: { closed: true } },
      retrySuccess,
    ]);
    expect(run.result).toEqual({ runId: 'replacement-run' });
    expect(run.calls.find((call) =>
      call.url.endsWith('/blackjack/action')
    )?.body).toEqual({
      handId: 'hand-1',
      action: 'stand',
      handSlot: 1,
    });
    expect(run.calls.some((call) =>
      call.url.endsWith('/blackjack/session/close')
      && (call.body as { shoeId?: string }).shoeId === 'shoe-1'
    )).toBe(true);
    expect(run.calls.at(-2)?.url).toEndWith(
      '/api/cove/test-fixture/run/stale-run',
    );
    expect(run.releases).toEqual([
      'replacement-run.replacement-raw-token',
    ]);
  });

  test('practice uses a zero-exposure fold then normal close before retry', async () => {
    const run = await execute([
      recovery('practice_ledger_recovery_required'),
      {
        status: 200,
        body: { table: { id: 'practice-1' }, hand: { id: 'hand-2' } },
      },
      { status: 200, body: { status: 'settled' } },
      { status: 200, body: { closed: true } },
      { status: 404, body: { message: 'no_open_table' } },
      { status: 200, body: { closed: true } },
      retrySuccess,
    ]);
    expect(run.calls.find((call) =>
      call.url.endsWith('/holdem/action')
    )?.body).toEqual({ handId: 'hand-2', action: 'fold' });
    expect(run.calls.some((call) =>
      call.url.endsWith('/holdem/session/close')
      && (call.body as { tableId?: string }).tableId === 'practice-1'
    )).toBe(true);
    expect(run.result).toEqual({ runId: 'replacement-run' });
  });

  test('cash uses Walk Away and proves the owner seat absent before retry', async () => {
    const run = await execute([
      recovery('cash_recovery_required'),
      {
        status: 200,
        body: { avatar: { id: 'avatar-1', clawTokens: 100 } },
      },
      {
        status: 200,
        body: {
          seats: [
            { avatarId: 'avatar-1', status: 'active' },
            { avatarId: 'bot-1', status: 'active' },
          ],
        },
      },
      {
        status: 200,
        body: {
          view: {
            isYourTurn: true,
            legalActions: ['call', 'fold'],
            handNumber: 7,
          },
        },
      },
      { status: 200, body: { ok: true } },
      {
        status: 200,
        body: {
          seats: [
            { avatarId: 'avatar-1', status: 'active' },
            { avatarId: 'bot-1', status: 'active' },
          ],
        },
      },
      { status: 409, body: { message: 'not_seated_or_no_live_hand' } },
      {
        status: 200,
        body: {
          queued: false,
          cashedOutCt: 50,
          cashOutLedgerTxnId: 'ledger-1',
        },
      },
      {
        status: 200,
        body: { seats: [{ avatarId: 'bot-1', status: 'active' }] },
      },
      {
        status: 200,
        body: { avatar: { id: 'avatar-1', clawTokens: 150 } },
      },
      { status: 200, body: { closed: true } },
      retrySuccess,
    ], 'cash-table-1');
    expect(run.calls.some((call) =>
      call.url.endsWith('/cash/tables/cash-table-1/leave')
      && call.method === 'POST'
    )).toBe(true);
    expect(run.calls.find((call) =>
      call.url.endsWith('/cash/tables/cash-table-1/action')
    )?.body).toEqual({
      handNumber: 7,
      actionSeq: 0,
      action: { kind: 'fold' },
    });
    expect(run.result).toEqual({ runId: 'replacement-run' });
  });

  test('fails closed, clears the stale credential, and does not retry', async () => {
    const replies: MockReply[] = [
      recovery('practice_ledger_recovery_required'),
      { status: 500, body: { message: 'unavailable' } },
    ];
    const calls: FetchCall[] = [];
    const fakeWindow: Record<string, unknown> = {
      __CV_SET_FIXTURE_HEADER(header?: string) {
        fakeWindow.__CV_TEST_FIXTURE_HEADER = header;
      },
      __CV_RELEASE_FIXTURE_GATE() {
        throw new Error('the pending seed arm must remain gated');
      },
    };
    const script = buildFixtureIssueScript(
      'holdem-fold-win',
      {
        apiBase: 'https://api-staging.example',
        maxLossPerRun: 50,
        maxDurationMs: 120_000,
      },
      null,
    );
    const fetchMock = async (url: string, init: RequestInit = {}) => {
      const reply = replies.shift()!;
      calls.push({
        url,
        method: init.method ?? 'GET',
        headerAtCall:
          typeof fakeWindow.__CV_TEST_FIXTURE_HEADER === 'string'
            ? fakeWindow.__CV_TEST_FIXTURE_HEADER
            : undefined,
        body: null,
      });
      return {
        status: reply.status,
        ok: reply.status >= 200 && reply.status < 300,
        json: async () => reply.body,
      };
    };
    await expect(new Function(
      'window',
      'fetch',
      `return ${script}`,
    )(fakeWindow, fetchMock)).rejects.toThrow(
      'practice recovery current session failed with status 500',
    );
    expect(calls).toHaveLength(2);
    expect(fakeWindow.__CV_TEST_FIXTURE_HEADER).toBeUndefined();
  });

  test('raw tokens are absent from the runner result and persistence surfaces', async () => {
    const run = await execute([retrySuccess]);
    expect(JSON.stringify(run.result)).not.toContain('raw-token');
    expect(run.window.localStorage).toBeDefined();
    expect(run.window.sessionStorage).toBeDefined();
    expect(run.calls[0]?.headerAtCall).toBeUndefined();
  });

  test('owner preflight also recovers fixtureName-less rows then deletes its probe run', async () => {
    const run = await execute([
      recovery('practice_ledger_recovery_required'),
      {
        status: 200,
        body: { table: { id: 'practice-1' }, hand: null },
      },
      { status: 200, body: { closed: true } },
      { status: 404, body: { message: 'no_open_table' } },
      { status: 200, body: { closed: true } },
      retrySuccess,
      { status: 204 },
    ], null, true);
    expect(run.result).toEqual({ clean: true });
    expect(run.releases).toEqual([]);
    expect(run.window.__CV_TEST_FIXTURE_HEADER).toBeUndefined();
    expect(run.calls.filter((call) =>
      call.method === 'DELETE'
    ).map((call) => call.url)).toEqual([
      'https://api-staging.example/api/cove/test-fixture/run/stale-run',
      'https://api-staging.example/api/cove/test-fixture/run/replacement-run',
    ]);
  });
});
