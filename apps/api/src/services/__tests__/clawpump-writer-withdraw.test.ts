/**
 * P5 T2: the ClawPump withdraw writer (contract ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §3, §10 T2).
 * REAL MONEY path: every refusal must happen before the POST, the POST runs once (no retry), and only a reply
 * that proves "nothing sent" is 'rejected'. Fixtures are the raw ClawPump replies of Run 2 (2026-10-01,
 * withdraw-probe-2-out.txt and withdraw-probe-3-out.txt). No real request is made: fetch is a fake.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { TRADE_MINTS } from '@clawville/shared';
import * as W from '../clawpump-writer';

const KEY = 'cpk_test_not_a_real_key';
const env = { CLAWPUMP_API_KEY: KEY, CLAWVILLE_ENV: 'production' };
const ROW_ID = 'abcd1234-0000-4000-8000-000000000000';
const ARENA_ID = '11111111-2222-4333-8444-555555555555';
const HOUSE_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
const NAME = 'CV Arena · Bob #abcd12340000';
const OWNED = { arenaAgentId: ROW_ID, isOwnedBy: async () => true };
// Run 2 public addresses (no keys): LandTest1 agent wallet = source, team rescue wallet = destination.
const SOURCE = '7HJkSiAAnptjPh9kxmc8qbQbDQyWkpgmxuonzC3gEM6E';
const DEST = 'CQMkzDuaftQ1mW6ZkdEd3uGWdMaqio39VsY2TmyugRmz';
const OTHER_WALLET = 'HNR8ywe8PrV5ZUvAWSjfLxMELjqXaPqWq36N6M1WoRCM';
/** The USDC token account of DEST from the Run 2 reply: a PDA, so it is off the ed25519 curve. */
const OFF_CURVE = 'CdoCkEofQMZgWUPvfoiVagAsw2woNpZy67pYazLE6Y4c';
const USDC_SIG = '2PXo2yyYa2Bqw8M7SsdJusGcfgj7xLQmVZZ1x3EDx2eHFvFMN5HizScJkkCJu3LjMXWY1MBsxRfscFn9pntwRFUz';
const SOL_SIG = '45fqnTLZCCaK1rqqm5t4p5Va9KwLzEpW34h3DKUMCwdRGpgzteFK8g8WwooG4vEjiCnQW1swV3qA5CXy8kDJZJX3';
const CODE_RE = /^[a-z0-9_.:-]{1,64}$/;

/** withdraw-probe-2-out.txt, P3: POST /wallets/{LandTest1}/transfer 0.01 USDC -> 200. */
const USDC_SENT_REPLY = {
  ok: true, status: 'sent', from: SOURCE, to: DEST, amount: 0.01, token: 'USDC', mint: TRADE_MINTS.USDC,
  txHash: USDC_SIG, explorerUrl: `https://solscan.io/tx/${USDC_SIG}`,
  recipientTokenAccount: OFF_CURVE, destinationType: 'wallet', createdRecipientTokenAccount: false,
  tokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', usedTransferHook: false, memoIncluded: false,
};
/** withdraw-probe-3-out.txt, P4a: 0.002 SOL -> 200. No mint, no createdRecipientTokenAccount. */
const SOL_SENT_REPLY = {
  ok: true, status: 'sent', from: SOURCE, to: DEST, amount: 0.002, token: 'SOL',
  txHash: SOL_SIG, explorerUrl: `https://solscan.io/tx/${SOL_SIG}`,
};
/** WITHDRAW_PROBES Run 1, P3: the 0.005 SOL pre-check (nothing sent). */
const FEE_REFUSAL = {
  ok: false, code: 'insufficient_fee_balance',
  error: 'Live wallet balance checked before transfer: available 0 SOL for network fees, need at least 0.005 SOL. ...',
};
/** WITHDRAW_PROBES Run 1, P1: the live-balance pre-check (nothing sent). */
const LIVE_REFUSAL = {
  ok: false, code: 'insufficient_live_balance',
  error: 'Live wallet balance checked before transfer: available 0 USDC, requested 0.01 USDC. ...',
};
/** withdraw-probe-2-out.txt: GET /wallets/{LandTest1}/history?limit=3 after the P3 send. */
const HISTORY_REPLY = {
  address: SOURCE, solBalance: 0.005995, usdcBalance: 0.01, solPrice: 117.7750614339597, totalValueUsd: 0.72,
  transactions: [
    { signature: USDC_SIG, timestamp: 1790897585, date: '2026-10-01T23:33:05.000Z', status: 'success', memo: null },
    { signature: '2rTKgwVRMcibjjAiTY9tD1kmrHdrq6voVmAPTsS29wUngP6wZrZ6zFrdixTvXY8R2UsaLUEPrqZr7fFCiTyFoEvb', timestamp: 1790897553, date: '2026-10-01T23:32:33.000Z', status: 'success', memo: '[37] clawville P5 step0 withdraw probe gas' },
    { signature: '2NgxnXVWFk5nGUn3BRtx85PoC9HMkgxzjYYdGxy6CqJWjzaK6nLe3GUgRFhXYe6ys9seKamrEqocqBzE15HrPtiS', timestamp: 1790862485, date: '2026-10-01T13:48:05.000Z', status: 'success', memo: '[32] 53c3a5081bb33b00daf130df5c2d9419' },
  ],
};
/** withdraw-probe-3-out.txt shape, balances after the P4a SOL send (0.003985 SOL left, 0 USDC). */
const HISTORY_AFTER_SOL = {
  address: SOURCE, solBalance: 0.003985, usdcBalance: 0, solPrice: 118.31, totalValueUsd: 0.47,
  transactions: [{ signature: SOL_SIG, timestamp: 1790897640, date: '2026-10-01T23:34:00.000Z', status: 'success', memo: null }],
};

interface Call {
  method: string; path: string; body: unknown; auth: string | null; contentType: string | null;
  redirect: string | undefined; hasSignal: boolean;
}
type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: headers.get('authorization'),
      contentType: headers.get('content-type'),
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${url.pathname}`];
    if (!handler) return new Response('{"error":"Not Found"}', { status: 404 });
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls, posts: () => calls.filter((call) => call.method === 'POST') };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const agentBody = (extra: Record<string, unknown> = {}) => ({
  id: ARENA_ID, name: NAME, status: 'stopped', wallet_address: SOURCE, enabled_skills: [], ...extra,
});
const transferRoutes = (reply: Handler, agent: Record<string, unknown> = {}) => fakeFetch({
  [`GET /agents/${ARENA_ID}`]: () => json(agentBody(agent)),
  [`POST /wallets/${ARENA_ID}/transfer`]: reply,
});
const historyRoutes = (reply: Handler) => fakeFetch({ [`GET /wallets/${ARENA_ID}/history`]: reply });

const usdcInput: W.ArenaTransferInput = { to: DEST, asset: 'USDC', amountAtomic: 10_000n, expectedSource: SOURCE };
const solInput: W.ArenaTransferInput = { to: DEST, asset: 'SOL', amountAtomic: 2_000_000n, expectedSource: SOURCE };

const send = (
  input: W.ArenaTransferInput,
  fake: { fetchImpl: typeof fetch },
  ownership: W.ClawPumpWriterOwnership = OWNED,
  extra: W.ClawPumpWriterOptions = {},
) => W.transferFromArenaWallet(ARENA_ID, input, ownership, { env, fetchImpl: fake.fetchImpl, ...extra });

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
let consoleSpies: Array<{ mock: { calls: unknown[][] }; mockRestore: () => void }> = [];

beforeEach(() => {
  W._resetClawPumpWriterRateForTest();
  consoleSpies = CONSOLE_METHODS.map((method) => spyOn(console, method));
});

afterEach(() => {
  const used = consoleSpies.reduce((count, spy) => count + spy.mock.calls.length, 0);
  for (const spy of consoleSpies) spy.mockRestore();
  // I9: the withdraw writer never logs (no key, no vendor text, no body can reach a log).
  expect(used).toBe(0);
});

describe('transferFromArenaWallet: every refusal is thrown before the POST', () => {
  test('a house id is refused before the DB check and before any request', async () => {
    const asked: string[] = [];
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    const ownership = { arenaAgentId: ROW_ID, isOwnedBy: async (id: string) => { asked.push(id); return true; } };
    expect(W.CLAWPUMP_HOUSE_AGENT_IDS.has(HOUSE_ID)).toBe(true);
    await expect(W.transferFromArenaWallet(HOUSE_ID, usdcInput, ownership, { env, fetchImpl: fake.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(asked).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  test('DB ownership false: not_arena_agent with no request at all', async () => {
    const asked: Array<[string, string]> = [];
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    const notOwned = {
      arenaAgentId: ROW_ID,
      isOwnedBy: async (clawpumpAgentId: string, arenaAgentId: string) => { asked.push([clawpumpAgentId, arenaAgentId]); return false; },
    };
    await expect(send(usdcInput, fake, notOwned)).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(asked).toEqual([[ARENA_ID, ROW_ID]]);
    expect(fake.calls).toHaveLength(0);
  });

  test('a wrong environment prefix or a wrong row suffix: not_arena_agent after the guard GET, no POST', async () => {
    for (const name of ['CV Arena (staging) · Bob #abcd12340000', 'CV Arena · Bob #ffff00000000', 'Genesis']) {
      W._resetClawPumpWriterRateForTest();
      const fake = transferRoutes(() => json(USDC_SENT_REPLY), { name });
      await expect(send(usdcInput, fake)).rejects.toMatchObject({ code: 'not_arena_agent' });
      expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /agents/${ARENA_ID}`]);
    }
  });

  test('status running -> agent_running; null, missing or another status -> agent_not_stopped; no POST', async () => {
    const cases: Array<[string | null | undefined, string]> = [
      ['running', 'agent_running'], ['Running', 'agent_running'], [null, 'agent_not_stopped'],
      [undefined, 'agent_not_stopped'], ['starting', 'agent_not_stopped'],
    ];
    for (const [status, code] of cases) {
      W._resetClawPumpWriterRateForTest();
      const fake = transferRoutes(() => json(USDC_SENT_REPLY), { status });
      await expect(send(usdcInput, fake)).rejects.toMatchObject({ code });
      expect(fake.posts()).toHaveLength(0);
    }
  });

  test('the agent wallet is not the expected source: wallet_mismatch, no POST', async () => {
    for (const walletAddress of [OTHER_WALLET, null, undefined]) {
      W._resetClawPumpWriterRateForTest();
      const fake = transferRoutes(() => json(USDC_SENT_REPLY), { wallet_address: walletAddress });
      const error = await send(usdcInput, fake).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(W.ClawPumpWriterError);
      expect(error).toMatchObject({ code: 'wallet_mismatch' });
      expect((error as Error).message).toBe('clawpump_wallet_mismatch');
      expect(fake.posts()).toHaveLength(0);
    }
  });

  test('bad input: invalid_input before any request (off-curve to, to === source, amount bounds, asset)', async () => {
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    const bad: Array<Partial<Record<keyof W.ArenaTransferInput, unknown>>> = [
      { to: OFF_CURVE },
      { to: SOURCE },
      { to: '0OIlDuaftQ1mW6ZkdEd3uGWdMaqio39VsY2TmyugRmz' },
      { to: '1111' },
      { to: ` ${DEST}` },
      { amountAtomic: 0n },
      { amountAtomic: -1n },
      { amountAtomic: 2n ** 63n },
      { amountAtomic: 10_000 },
      { asset: 'BONK' },
      { asset: 'usdc' },
      { expectedSource: 'not-a-wallet' },
      { expectedSource: undefined },
    ];
    for (const patch of bad) {
      await expect(send({ ...usdcInput, ...patch } as W.ArenaTransferInput, fake)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(W.transferFromArenaWallet('not-a-uuid', usdcInput, OWNED, { env, fetchImpl: fake.fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_agent_id' });
    expect(fake.calls).toHaveLength(0);
    // The largest amount the contract allows passes the input check (2^63 - 1).
    const largest = transferRoutes(() => json({ ...USDC_SENT_REPLY, amount: '9223372036854.775807' }));
    const outcome = await send({ ...usdcInput, amountAtomic: 2n ** 63n - 1n }, largest);
    expect(outcome).toEqual({ kind: 'sent', txSignature: USDC_SIG, recipientAccountCreated: false });
    expect(largest.posts()[0]!.body).toEqual({ to: DEST, amount: '9223372036854.775807', token: TRADE_MINTS.USDC });
  });

  test('budget: with 1 token above the reserve the guard GET runs and the POST throws budget_exhausted', async () => {
    W._resetClawPumpWriterRateForTest(W.CLAWPUMP_WRITER_REMOVAL_RESERVE + 1);
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    const error = await send(usdcInput, fake).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(W.ClawPumpWriterError);
    expect(error).toMatchObject({ code: 'budget_exhausted', status: null });
    expect(fake.calls.map((call) => call.method)).toEqual(['GET']);
    expect(fake.posts()).toHaveLength(0);
  });

  test('the caller cannot spend the removal reserve: priority "removal" still uses a normal token', async () => {
    W._resetClawPumpWriterRateForTest(W.CLAWPUMP_WRITER_REMOVAL_RESERVE + 1);
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    await expect(send(usdcInput, fake, OWNED, { priority: 'removal' })).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(fake.posts()).toHaveLength(0);
  });

  test('no key: not_configured before any request', async () => {
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    await expect(W.transferFromArenaWallet(ARENA_ID, usdcInput, OWNED, { env: { CLAWVILLE_ENV: 'production' }, fetchImpl: fake.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_configured' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('transferFromArenaWallet: one POST with the exact body', () => {
  test('USDC: {to, amount: "0.01", token: <USDC mint>} on /wallets/{id}/transfer, once, then sent', async () => {
    const timeouts = spyOn(AbortSignal, 'timeout');
    try {
      const fake = transferRoutes(() => json(USDC_SENT_REPLY));
      const outcome = await send(usdcInput, fake);
      expect(outcome).toEqual({ kind: 'sent', txSignature: USDC_SIG, recipientAccountCreated: false });
      expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        `GET /agents/${ARENA_ID}`, `POST /wallets/${ARENA_ID}/transfer`,
      ]);
      const post = fake.posts()[0]!;
      expect(post.body).toEqual({ to: DEST, amount: '0.01', token: TRADE_MINTS.USDC });
      expect(post.auth).toBe(`Bearer ${KEY}`);
      expect(post.contentType).toBe('application/json');
      expect(post.redirect).toBe('error');
      expect(post.hasSignal).toBe(true);
      // Guard GET at the default read timeout, the POST at CLAWPUMP_TRANSFER_TIMEOUT_MS.
      expect(timeouts.mock.calls.map((args) => args[0])).toEqual([15_000, W.CLAWPUMP_TRANSFER_TIMEOUT_MS]);
      expect(W.CLAWPUMP_TRANSFER_TIMEOUT_MS).toBe(45_000);
    } finally {
      timeouts.mockRestore();
    }
  });

  test('USDC 100000 atomic is sent as "0.1" (contract example)', async () => {
    const fake = transferRoutes(() => json({ ...USDC_SENT_REPLY, amount: 0.1 }));
    const outcome = await send({ ...usdcInput, amountAtomic: 100_000n }, fake);
    expect(fake.posts()[0]!.body).toEqual({ to: DEST, amount: '0.1', token: TRADE_MINTS.USDC });
    expect(outcome.kind).toBe('sent');
  });

  test('SOL: {to, amount: "0.002", token: "SOL"}, once; the recorded SOL reply is sent with recipientAccountCreated null', async () => {
    const fake = transferRoutes(() => json(SOL_SENT_REPLY));
    const outcome = await send(solInput, fake);
    expect(fake.posts()).toHaveLength(1);
    expect(fake.posts()[0]!.body).toEqual({ to: DEST, amount: '0.002', token: 'SOL' });
    expect(outcome).toEqual({ kind: 'sent', txSignature: SOL_SIG, recipientAccountCreated: null });
  });

  test('createdRecipientTokenAccount true is passed through', async () => {
    const fake = transferRoutes(() => json({ ...USDC_SENT_REPLY, createdRecipientTokenAccount: true }));
    expect(await send(usdcInput, fake)).toEqual({ kind: 'sent', txSignature: USDC_SIG, recipientAccountCreated: true });
  });
});

describe('transferFromArenaWallet: a POST that may have sent returns unknown, once (no retry)', () => {
  const cases: Array<[string, Handler, W.ArenaTransferOutcome]> = [
    ['timeout', () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }, { kind: 'unknown', code: 'timeout', txSignature: null }],
    ['abort', () => { throw new DOMException('aborted', 'AbortError'); }, { kind: 'unknown', code: 'timeout', txSignature: null }],
    ['network error', () => { throw new TypeError('fetch failed'); }, { kind: 'unknown', code: 'network_error', txSignature: null }],
    ['a thrown non-Error', () => { throw 'boom'; }, { kind: 'unknown', code: 'network_error', txSignature: null }],
    ['HTTP 500', () => json({ error: 'Internal Server Error' }, 500), { kind: 'unknown', code: 'http_500', txSignature: null }],
    ['HTTP 502 html', () => new Response('<html>Bad Gateway</html>', { status: 502 }), { kind: 'unknown', code: 'http_502', txSignature: null }],
    ['HTTP 500 with a txHash', () => json({ ok: false, txHash: USDC_SIG }, 500), { kind: 'unknown', code: 'http_500', txSignature: USDC_SIG }],
    ['a body that fails while it is read', () => new Response(new ReadableStream({
      pull(controller) { controller.error(new TypeError('connection reset')); },
    }), { status: 200 }), { kind: 'unknown', code: 'network_error', txSignature: null }],
  ];
  for (const [label, handler, expected] of cases) {
    test(`${label} -> ${expected.kind} ${'code' in expected ? expected.code : ''}; fetch called once for the POST`, async () => {
      const fake = transferRoutes(handler);
      const outcome = await send(usdcInput, fake);
      expect(outcome).toEqual(expected);
      expect(fake.posts()).toHaveLength(1);
      expect(fake.calls).toHaveLength(2);
    });
  }
});

describe('transferFromArenaWallet: reply classification (contract §3)', () => {
  const classify = async (reply: Handler, input: W.ArenaTransferInput = usdcInput) => {
    W._resetClawPumpWriterRateForTest();
    const fake = transferRoutes(reply);
    const outcome = await send(input, fake);
    expect(fake.posts()).toHaveLength(1);
    const text = JSON.stringify(outcome);
    // I9: codes only. Never the key, never vendor `error` text.
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Live wallet balance');
    if ('code' in outcome) expect(outcome.code).toMatch(CODE_RE);
    return outcome;
  };

  test('HTTP 200 ok:false with a proved no-send code -> rejected vendor_<code>', async () => {
    expect(await classify(() => json(FEE_REFUSAL))).toEqual({ kind: 'rejected', code: 'vendor_insufficient_fee_balance' });
    expect(await classify(() => json(LIVE_REFUSAL))).toEqual({ kind: 'rejected', code: 'vendor_insufficient_live_balance' });
    expect([...W.CLAWPUMP_TRANSFER_NO_SEND_VENDOR_CODES].sort()).toEqual(['insufficient_fee_balance', 'insufficient_live_balance']);
  });

  test('HTTP 200 ok:false with another code -> unknown vendor_<code>; a code outside [a-z0-9_.:-] -> vendor_error', async () => {
    expect(await classify(() => json({ ok: false, code: 'other_code', error: 'x' })))
      .toEqual({ kind: 'unknown', code: 'vendor_other_code', txSignature: null });
    for (const code of ['Insufficient_Fee_Balance', 'has space', 'x'.repeat(58), 42, null, undefined, '']) {
      expect(await classify(() => json({ ok: false, code, error: 'x' })))
        .toEqual({ kind: 'unknown', code: 'vendor_error', txSignature: null });
    }
  });

  test('ok:false with a txHash -> unknown with the signature (even with a no-send code)', async () => {
    expect(await classify(() => json({ ...FEE_REFUSAL, txHash: USDC_SIG })))
      .toEqual({ kind: 'unknown', code: 'vendor_insufficient_fee_balance', txSignature: USDC_SIG });
    expect(await classify(() => json({ ok: false, code: 'send_failed', txHash: USDC_SIG })))
      .toEqual({ kind: 'unknown', code: 'vendor_send_failed', txSignature: USDC_SIG });
    // A txHash field that is not a valid signature still blocks 'rejected' (nothing is proved).
    expect(await classify(() => json({ ...FEE_REFUSAL, txHash: 'pending' })))
      .toEqual({ kind: 'unknown', code: 'vendor_insufficient_fee_balance', txSignature: null });
  });

  test('a no-send code on a status other than 200 is not proof: unknown', async () => {
    expect(await classify(() => json(FEE_REFUSAL, 400))).toEqual({ kind: 'unknown', code: 'http_400', txSignature: null });
    expect(await classify(() => json(FEE_REFUSAL, 202))).toEqual({ kind: 'unknown', code: 'vendor_insufficient_fee_balance', txSignature: null });
  });

  test('4xx bodies are read for a txHash: HTTP 400 with a txHash -> unknown with the signature', async () => {
    expect(await classify(() => json({ ok: false, code: 'bad_request', txHash: USDC_SIG }, 400)))
      .toEqual({ kind: 'unknown', code: 'http_400', txSignature: USDC_SIG });
    expect(await classify(() => json({ ok: false }, 404))).toEqual({ kind: 'unknown', code: 'http_404', txSignature: null });
  });

  test('HTTP 401, 403, 429 without a txHash -> rejected http_<status>; with a txHash or an unread body -> unknown', async () => {
    for (const status of [401, 403, 429]) {
      expect(await classify(() => json({ error: 'no' }, status))).toEqual({ kind: 'rejected', code: `http_${status}` });
      expect(await classify(() => new Response('Unauthorized', { status }))).toEqual({ kind: 'rejected', code: `http_${status}` });
      expect(await classify(() => json({ error: 'no', txHash: USDC_SIG }, status)))
        .toEqual({ kind: 'unknown', code: `http_${status}`, txSignature: USDC_SIG });
    }
    // A body over 1 MB is not inspected, so it cannot prove "no txHash".
    expect(await classify(() => new Response(`{"error":"${'x'.repeat(1_000_001)}"}`, { status: 429 })))
      .toEqual({ kind: 'unknown', code: 'http_429', txSignature: null });
  });

  test('ok:true without a txHash -> unknown no_tx_hash', async () => {
    const { txHash: _drop, ...noHash } = USDC_SENT_REPLY;
    expect(await classify(() => json(noHash))).toEqual({ kind: 'unknown', code: 'no_tx_hash', txSignature: null });
    for (const txHash of ['short', '0OIl'.repeat(20), 123, null]) {
      expect(await classify(() => json({ ...USDC_SENT_REPLY, txHash }))).toEqual({ kind: 'unknown', code: 'no_tx_hash', txSignature: null });
    }
  });

  test('ok:true but from / to / amount / mint / token / status differ -> mismatch reply_mismatch with the signature', async () => {
    const mismatch: W.ArenaTransferOutcome = { kind: 'mismatch', code: 'reply_mismatch', txSignature: USDC_SIG };
    expect(await classify(() => json({ ...USDC_SENT_REPLY, to: OTHER_WALLET }))).toEqual(mismatch);
    expect(await classify(() => json({ ...USDC_SENT_REPLY, from: OTHER_WALLET }))).toEqual(mismatch);
    expect(await classify(() => json({ ...USDC_SENT_REPLY, amount: 0.02 }))).toEqual(mismatch);
    expect(await classify(() => json({ ...USDC_SENT_REPLY, amount: '0.009999' }))).toEqual(mismatch);
    expect(await classify(() => json({ ...USDC_SENT_REPLY, mint: TRADE_MINTS.ANSEM }))).toEqual(mismatch);
    // A real field mismatch stays 'mismatch' whatever the status says.
    expect(await classify(() => json({ ...USDC_SENT_REPLY, to: OTHER_WALLET, status: 'pending' }))).toEqual(mismatch);
    const solMismatch: W.ArenaTransferOutcome = { kind: 'mismatch', code: 'reply_mismatch', txSignature: SOL_SIG };
    expect(await classify(() => json({ ...SOL_SENT_REPLY, token: 'USDC' }), solInput)).toEqual(solMismatch);
    expect(await classify(() => json({ ...SOL_SENT_REPLY, amount: 0.0021 }), solInput)).toEqual(solMismatch);
  });

  test('lead decision: matching fields but status !== "sent" -> unknown vendor_status_<status> with the signature', async () => {
    expect(await classify(() => json({ ...USDC_SENT_REPLY, status: 'pending' })))
      .toEqual({ kind: 'unknown', code: 'vendor_status_pending', txSignature: USDC_SIG });
    expect(await classify(() => json({ ...SOL_SENT_REPLY, status: 'Submitted' }), solInput))
      .toEqual({ kind: 'unknown', code: 'vendor_status_submitted', txSignature: SOL_SIG });
    const { status: _status, ...noStatus } = USDC_SENT_REPLY;
    for (const body of [{ ...USDC_SENT_REPLY, status: 'in progress' }, { ...USDC_SENT_REPLY, status: 'x'.repeat(51) },
      { ...USDC_SENT_REPLY, status: 7 }, { ...USDC_SENT_REPLY, status: '' }, noStatus]) {
      expect(await classify(() => json(body))).toEqual({ kind: 'unknown', code: 'vendor_status_other', txSignature: USDC_SIG });
    }
  });

  test('sent: the amount may be a number or a string; SOL token in any case; SOL ignores mint', async () => {
    expect((await classify(() => json({ ...USDC_SENT_REPLY, amount: '0.01' }))).kind).toBe('sent');
    expect((await classify(() => json({ ...SOL_SENT_REPLY, token: 'sol' }), solInput)).kind).toBe('sent');
    expect((await classify(() => json({ ...SOL_SENT_REPLY, mint: 'anything' }), solInput)).kind).toBe('sent');
    expect((await classify(() => json({ ...USDC_SENT_REPLY, createdRecipientTokenAccount: 'yes' })))).toEqual({
      kind: 'sent', txSignature: USDC_SIG, recipientAccountCreated: null,
    });
  });

  test('ok:true with a txHash but missing fields -> unknown with the signature (never sent, never rejected)', async () => {
    expect(await classify(() => json({ ok: true, txHash: USDC_SIG })))
      .toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: USDC_SIG });
    const { mint: _mint, ...noMint } = USDC_SENT_REPLY;
    expect(await classify(() => json(noMint))).toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: USDC_SIG });
  });

  test('an unparsable 2xx body, or no boolean ok -> unknown reply_unparsed (with the signature when present)', async () => {
    expect(await classify(() => new Response('not json', { status: 200 }))).toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: null });
    expect(await classify(() => json([USDC_SENT_REPLY]))).toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: null });
    expect(await classify(() => json('sent'))).toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: null });
    const { ok: _ok, ...noOk } = USDC_SENT_REPLY;
    expect(await classify(() => json(noOk))).toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: USDC_SIG });
    expect(await classify(() => new Response(`{"ok":true,"pad":"${'x'.repeat(1_000_001)}"}`, { status: 200 })))
      .toEqual({ kind: 'unknown', code: 'reply_unparsed', txSignature: null });
  });

  test('the withdraw path never calls the whitelist or the wallet summary', async () => {
    const fake = transferRoutes(() => json(USDC_SENT_REPLY));
    await send(usdcInput, fake);
    expect(fake.calls.some((call) => call.path.startsWith('/whitelist') || call.path.startsWith('/wallets/summary'))).toBe(false);
  });
});

describe('readArenaWalletLive: GET /wallets/{id}/history (live), never /wallets/summary', () => {
  const read = (fake: { fetchImpl: typeof fetch }, ownership: W.ClawPumpWriterOwnership = OWNED, extra: W.ClawPumpWriterOptions & { limit?: number } = {}) =>
    W.readArenaWalletLive(ARENA_ID, ownership, { env, fetchImpl: fake.fetchImpl, ...extra });

  test('maps the Run 2 history reply: 0.01 USDC -> 10000n, 0.005995 SOL -> 5995000n, signatures and status', async () => {
    let seenAt = 0;
    const fake = historyRoutes(() => { seenAt = Date.now(); return json(HISTORY_REPLY); });
    const live = await read(fake);
    expect(live.address).toBe(SOURCE);
    expect(live.usdcAtomic).toBe(10_000n);
    expect(live.solLamports).toBe(5_995_000n);
    expect(live.transactions).toEqual(HISTORY_REPLY.transactions.map((tx) => ({ signature: tx.signature, status: 'success' })));
    expect(live.readAt).toBeInstanceOf(Date);
    // readAt is taken before the request (the add-on rule subtracts calls since readAt).
    expect(live.readAt.getTime()).toBeLessThanOrEqual(seenAt);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /wallets/${ARENA_ID}/history?limit=50`]);
    expect(fake.calls[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  test('0.003985 SOL -> 3985000n and 0 USDC -> 0n; a missing status maps to null', async () => {
    const fake = historyRoutes(() => json({ ...HISTORY_AFTER_SOL, transactions: [{ signature: SOL_SIG }] }));
    const live = await read(fake);
    expect(live.solLamports).toBe(3_985_000n);
    expect(live.usdcAtomic).toBe(0n);
    expect(live.transactions).toEqual([{ signature: SOL_SIG, status: null }]);
  });

  test('string balances are accepted', async () => {
    const fake = historyRoutes(() => json({ ...HISTORY_REPLY, solBalance: '0.003985', usdcBalance: '61.161385' }));
    const live = await read(fake);
    expect(live.solLamports).toBe(3_985_000n);
    expect(live.usdcAtomic).toBe(61_161_385n);
  });

  test('a null, missing, negative or unreadable balance, a bad address or too many rows -> schema_invalid (fail closed)', async () => {
    const { usdcBalance: _u, ...noUsdc } = HISTORY_REPLY;
    const { transactions: _t, ...noTransactions } = HISTORY_REPLY;
    const bad: unknown[] = [
      { ...HISTORY_REPLY, usdcBalance: null },
      { ...HISTORY_REPLY, solBalance: null },
      noUsdc,
      noTransactions,
      { ...HISTORY_REPLY, solBalance: -0.1 },
      { ...HISTORY_REPLY, usdcBalance: 'abc' },
      { ...HISTORY_REPLY, usdcBalance: '1e400' },
      { ...HISTORY_REPLY, address: null },
      { ...HISTORY_REPLY, address: 'not-base58-0OIl' },
      { ...HISTORY_REPLY, address: '1111' },
      { ...HISTORY_REPLY, transactions: Array.from({ length: 201 }, () => ({ signature: SOL_SIG, status: 'success' })) },
      { ...HISTORY_REPLY, transactions: [{ status: 'success' }] },
      [HISTORY_REPLY],
    ];
    for (const body of bad) {
      W._resetClawPumpWriterRateForTest();
      await expect(read(historyRoutes(() => json(body)))).rejects.toMatchObject({ code: 'schema_invalid' });
    }
  });

  test('a house id or a DB ownership miss is refused before any request', async () => {
    const asked: Array<[string, string]> = [];
    const fake = historyRoutes(() => json(HISTORY_REPLY));
    const ownership = (owned: boolean) => ({
      arenaAgentId: ROW_ID,
      isOwnedBy: async (clawpumpAgentId: string, arenaAgentId: string) => { asked.push([clawpumpAgentId, arenaAgentId]); return owned; },
    });
    await expect(W.readArenaWalletLive(HOUSE_ID, ownership(true), { env, fetchImpl: fake.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(asked).toEqual([]);
    await expect(read(fake, ownership(false))).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(asked).toEqual([[ARENA_ID, ROW_ID]]);
    await expect(W.readArenaWalletLive('nope', OWNED, { env, fetchImpl: fake.fetchImpl })).rejects.toMatchObject({ code: 'invalid_agent_id' });
    expect(fake.calls).toHaveLength(0);
  });

  test('limit: passed through; 0, 201 or a fraction -> invalid_input before any request', async () => {
    const fake = historyRoutes(() => json(HISTORY_REPLY));
    await read(fake, OWNED, { limit: 3 });
    expect(fake.calls.map((call) => call.path)).toEqual([`/wallets/${ARENA_ID}/history?limit=3`]);
    for (const limit of [0, 201, 1.5, Number.NaN]) {
      await expect(read(fake, OWNED, { limit })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fake.calls).toHaveLength(1);
  });

  test('one normal token: refused at the removal reserve, even with priority "removal"', async () => {
    W._resetClawPumpWriterRateForTest(W.CLAWPUMP_WRITER_REMOVAL_RESERVE);
    const fake = historyRoutes(() => json(HISTORY_REPLY));
    await expect(read(fake)).rejects.toMatchObject({ code: 'budget_exhausted' });
    await expect(read(fake, OWNED, { priority: 'removal' })).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(fake.calls).toHaveLength(0);
  });

  test('an HTTP error is a thrown read error (a read moves no money)', async () => {
    await expect(read(historyRoutes(() => json({ error: 'x' }, 500)))).rejects.toMatchObject({ code: 'http_error', status: 500 });
  });

  test('never calls /wallets/summary', async () => {
    const fake = fakeFetch({
      [`GET /wallets/${ARENA_ID}/history`]: () => json(HISTORY_REPLY),
      'GET /wallets/summary': () => json({ wallets: [] }),
    });
    await read(fake);
    expect(fake.calls.some((call) => call.path.startsWith('/wallets/summary'))).toBe(false);
  });
});

describe('arenaDestinationProblem', () => {
  test('null for an on-curve 32-byte key; a code for every other case', () => {
    expect(W.arenaDestinationProblem(DEST)).toBeNull();
    expect(W.arenaDestinationProblem(SOURCE)).toBeNull();
    expect(W.arenaDestinationProblem(OFF_CURVE)).toBe('off_curve');
    expect(W.arenaDestinationProblem('0OIlDuaftQ1mW6ZkdEd3uGWdMaqio39VsY2TmyugRmz')).toBe('not_base58');
    expect(W.arenaDestinationProblem(` ${DEST}`)).toBe('not_base58');
    expect(W.arenaDestinationProblem('')).toBe('not_base58');
    expect(W.arenaDestinationProblem(42 as never)).toBe('not_base58');
    expect(W.arenaDestinationProblem('1111')).toBe('not_32_bytes');
    expect(W.arenaDestinationProblem(USDC_SIG)).toBe('not_32_bytes');
  });
});

describe('formatAtomicAmount and parseUiAmountToAtomic', () => {
  test('formatAtomicAmount: exact decimal text, no exponent, no trailing zeros', () => {
    const cases: Array<[bigint, number, string]> = [
      [100_000n, 6, '0.1'], [10_000n, 6, '0.01'], [2_000_000n, 9, '0.002'], [1n, 9, '0.000000001'],
      [1_000_000n, 6, '1'], [0n, 6, '0'], [123_456_789n, 6, '123.456789'], [5n, 0, '5'],
      [2n ** 63n - 1n, 9, '9223372036.854775807'], [10n ** 30n, 6, '1000000000000000000000000'],
    ];
    for (const [atomic, decimals, text] of cases) {
      expect(W.formatAtomicAmount(atomic, decimals)).toBe(text);
      expect(W.formatAtomicAmount(atomic, decimals)).not.toContain('e');
    }
  });

  test('parseUiAmountToAtomic: FLOOR of the decimal text, no float error, exponent input handled', () => {
    const cases: Array<[number | string, number, bigint]> = [
      [0.01, 6, 10_000n], [0.003985, 9, 3_985_000n], [0.005995, 9, 5_995_000n], ['0.01', 6, 10_000n],
      [0.29, 6, 290_000n], [0.1 + 0.2, 6, 300_000n], [1.1, 9, 1_100_000_000n], [61.161385, 6, 61_161_385n],
      [1e-7, 9, 100n], ['1e-7', 9, 100n], [1e-7, 6, 0n], [0.1234567, 6, 123_456n], ['0.0000009', 6, 0n],
      [5, 6, 5_000_000n], [0, 6, 0n], [-0, 6, 0n], ['0', 9, 0n], [' 0.5 ', 6, 500_000n], ['.5', 6, 500_000n],
      ['5.', 6, 5_000_000n], [1e21, 6, 10n ** 27n], [0.002, 9, 2_000_000n], [0.0009, 9, 900_000n],
    ];
    for (const [value, decimals, atomic] of cases) expect(W.parseUiAmountToAtomic(value, decimals)).toBe(atomic);
  });

  test('parseUiAmountToAtomic: null when not finite, negative or not a decimal', () => {
    for (const value of [-0.01, '-0.01', '-0', Number.NaN, Number.POSITIVE_INFINITY, 'Infinity', 'NaN', '1e400', 'abc', '', ' ', '.', '0x10', '1.2.3', '+5', '1,5', null, undefined]) {
      expect(W.parseUiAmountToAtomic(value as never, 6)).toBeNull();
    }
  });
});

describe('writer surface', () => {
  test('clawPumpArenaWithdrawWriter has exactly readWalletLive and transfer; ClawPumpArenaWriter is not extended', () => {
    expect(Object.keys(W.clawPumpArenaWithdrawWriter).sort()).toEqual(['readWalletLive', 'transfer']);
    expect(Object.keys(W.clawPumpArenaWriter).sort()).toEqual(['createAgent', 'getWalletBalances', 'readAgent', 'updateAgent', 'x402Pay']);
  });

  test('no console call across a full send, a refusal, an unknown outcome, a throw and a read', async () => {
    // Each step gets a full budget (5 normal tokens): this test counts console calls, not tokens.
    expect((await send(usdcInput, transferRoutes(() => json(USDC_SENT_REPLY)))).kind).toBe('sent');
    W._resetClawPumpWriterRateForTest();
    expect((await send(usdcInput, transferRoutes(() => json(FEE_REFUSAL)))).kind).toBe('rejected');
    W._resetClawPumpWriterRateForTest();
    expect((await send(usdcInput, transferRoutes(() => { throw new TypeError('fetch failed'); }))).kind).toBe('unknown');
    await expect(send({ ...usdcInput, to: OFF_CURVE }, transferRoutes(() => json(USDC_SENT_REPLY)))).rejects.toMatchObject({ code: 'invalid_input' });
    W._resetClawPumpWriterRateForTest();
    await W.readArenaWalletLive(ARENA_ID, OWNED, { env, fetchImpl: historyRoutes(() => json(HISTORY_REPLY)).fetchImpl });
    // The beforeEach spies count every console method during this test.
    expect(consoleSpies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(0);
  });
});
