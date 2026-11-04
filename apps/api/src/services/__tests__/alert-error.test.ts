import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

const originalToken = process.env.ITACHI_DEBUG_BOT_TOKEN;
const originalChatId = process.env.ITACHI_DEBUG_CHAT_ID;
const originalClawvilleEnv = process.env.CLAWVILLE_ENV;
const originalFetch = globalThis.fetch;

process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
process.env.ITACHI_DEBUG_CHAT_ID = 'test-chat';
// The deployed-box gate reads CLAWVILLE_ENV per call; these delivery tests run
// as a deployed box. The gate's own tests below override per test.
process.env.CLAWVILLE_ENV = 'staging';

const { alertError, sendTelegramText } = await import('../alert-error');

describe('alert-error Telegram delivery', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.ITACHI_DEBUG_BOT_TOKEN;
    else process.env.ITACHI_DEBUG_BOT_TOKEN = originalToken;
    if (originalChatId === undefined) delete process.env.ITACHI_DEBUG_CHAT_ID;
    else process.env.ITACHI_DEBUG_CHAT_ID = originalChatId;
    if (originalClawvilleEnv === undefined) delete process.env.CLAWVILLE_ENV;
    else process.env.CLAWVILLE_ENV = originalClawvilleEnv;
  });

  it('non-deployed run (CLAWVILLE_ENV unset) logs instead of paging', async () => {
    delete process.env.CLAWVILLE_ENV;
    let fetched = false;
    globalThis.fetch = (async (_input, _init) => {
      fetched = true;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await alertError({
        severity: 'critical',
        source: 'gate-test-local',
        message: 'local process must not page',
      });
      expect(fetched).toBe(false);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('NOT paged')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      process.env.CLAWVILLE_ENV = 'staging';
    }
  });

  it('ALERT_TELEGRAM_FORCE=true pages even without CLAWVILLE_ENV', async () => {
    delete process.env.CLAWVILLE_ENV;
    process.env.ALERT_TELEGRAM_FORCE = 'true';
    let fetched = false;
    globalThis.fetch = (async (_input, _init) => {
      fetched = true;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      await alertError({
        severity: 'warning',
        source: 'gate-test-force',
        message: 'deliberate local pipe test',
      });
      expect(fetched).toBe(true);
    } finally {
      delete process.env.ALERT_TELEGRAM_FORCE;
      process.env.CLAWVILLE_ENV = 'staging';
    }
  });

  it('production CLAWVILLE_ENV pages normally', async () => {
    process.env.CLAWVILLE_ENV = 'production';
    let fetched = false;
    globalThis.fetch = (async (_input, _init) => {
      fetched = true;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      await alertError({
        severity: 'critical',
        source: 'gate-test-prod',
        message: 'deployed box pages',
      });
      expect(fetched).toBe(true);
    } finally {
      process.env.CLAWVILLE_ENV = 'staging';
    }
  });

  it('sends arbitrary alert content as plain text', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const hostileMessage = '`vault_held` (approved) [retry_pending]';
    const largeContext = { payload: 'x'.repeat(2_048), state: '[vault_held](approved)' };
    await alertError({
      severity: 'critical',
      source: 'bounty_ops[test]',
      message: hostileMessage,
      context: largeContext,
    });

    expect(requestBody).toBeDefined();
    expect(requestBody).not.toHaveProperty('parse_mode');
    expect(requestBody?.text).toContain(hostileMessage);
    expect(requestBody?.text).toContain(largeContext.payload);
  });

  it('logs the full message to stdout when Telegram rejects the send', async () => {
    const message = `full fallback ${'z'.repeat(2_048)}`;
    globalThis.fetch = (async (_input, _init) =>
      new Response('bad entities', { status: 400 })) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    await sendTelegramText(message);

    expect(warn).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[alert-error] Telegram rejected message fallback:',
      message,
    );
    warn.mockRestore();
    log.mockRestore();
  });

  it('never logs the bot token when the send throws', async () => {
    const realShape = '1234567890:AAH-abcdefghijklmnopqrstuvwxyz012345';
    process.env.ITACHI_DEBUG_BOT_TOKEN = realShape;
    globalThis.fetch = (async (input, _init): Promise<Response> => {
      // Bun's fetch error carries the request URL (path), which holds the token.
      throw Object.assign(new Error(`socket closed for ${String(input)}`), {
        code: 'ECONNRESET',
        path: String(input),
      });
    }) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await sendTelegramText('hello');
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.flat().map((part) =>
        typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
      expect(logged).toContain('ECONNRESET');
      expect(logged).not.toContain(realShape);
      expect(logged).not.toContain('AAH-abcdefghijklmnopqrstuvwxyz012345');
    } finally {
      warn.mockRestore();
      process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
    }
  });

  it('redacts the bot token from a rejected send body and the fallback text', async () => {
    const realShape = '1234567890:AAH-abcdefghijklmnopqrstuvwxyz012345';
    process.env.ITACHI_DEBUG_BOT_TOKEN = realShape;
    globalThis.fetch = (async (input, _init): Promise<Response> =>
      new Response(`bad request for ${String(input)}`, { status: 400 })) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await sendTelegramText(`echo ${realShape}`)).toBe(false);
      const logged = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join(' ');
      expect(logged).toContain('<redacted>');
      expect(logged).not.toContain('AAH-abcdefghijklmnopqrstuvwxyz012345');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
    }
  });

  it('redacts the bot token on every fallback log path', async () => {
    const realShape = '1234567890:AAH-abcdefghijklmnopqrstuvwxyz012345';
    const secretTail = 'AAH-abcdefghijklmnopqrstuvwxyz012345';
    process.env.ITACHI_DEBUG_BOT_TOKEN = realShape;
    // The token straddles the 200-character cut of the reject body.
    globalThis.fetch = (async (_input, _init): Promise<Response> =>
      new Response(`${'x'.repeat(190)}${realShape}`, { status: 400 })) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await sendTelegramText('body probe');
      delete process.env.ITACHI_DEBUG_CHAT_ID;
      await sendTelegramText(`no chat ${realShape}`);
      await alertError({ severity: 'warning', source: 'redact-no-chat', message: `m ${realShape}` });
      process.env.ITACHI_DEBUG_CHAT_ID = 'test-chat';
      delete process.env.CLAWVILLE_ENV;
      await alertError({
        severity: 'warning',
        source: 'redact-local',
        message: `m ${realShape}`,
        context: { url: `https://api.telegram.org/bot${realShape}/sendMessage` },
      });
      const logged = [...warn.mock.calls, ...log.mock.calls].flat().map((part) =>
        typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
      expect(logged).toContain('<redacted>');
      // Neither the bot id nor any part of the secret survives.
      expect(logged).not.toContain('1234567890');
      expect(logged).not.toContain(secretTail.slice(0, 8));
    } finally {
      warn.mockRestore();
      log.mockRestore();
      process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
      process.env.ITACHI_DEBUG_CHAT_ID = 'test-chat';
      process.env.CLAWVILLE_ENV = 'staging';
    }
  });

  it('resolves true only when Telegram accepts the send', async () => {
    globalThis.fetch = (async (_input, _init): Promise<Response> =>
      new Response('ok', { status: 200 })) as typeof fetch;
    expect(await sendTelegramText('delivered')).toBe(true);
  });
});

describe('alertError rate limit', () => {
  const saved = {
    token: process.env.ITACHI_DEBUG_BOT_TOKEN,
    chat: process.env.ITACHI_DEBUG_CHAT_ID,
    env: process.env.CLAWVILLE_ENV,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  beforeEach(() => {
    process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
    process.env.ITACHI_DEBUG_CHAT_ID = 'test-chat';
    process.env.CLAWVILLE_ENV = 'staging';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restore('ITACHI_DEBUG_BOT_TOKEN', saved.token);
    restore('ITACHI_DEBUG_CHAT_ID', saved.chat);
    restore('CLAWVILLE_ENV', saved.env);
  });

  it('keeps the window after an undelivered page and reports every lost page on the next one', async () => {
    const texts: string[] = [];
    let accept = false;
    globalThis.fetch = (async (_input, init): Promise<Response> => {
      texts.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
      return new Response('nope', { status: accept ? 200 : 429 });
    }) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const now = spyOn(Date, 'now');
    try {
      const params = { severity: 'warning' as const, source: 'rate-test', message: 'same text' };
      now.mockReturnValue(1_000_000);
      await alertError(params);
      // Same window: no new request, so a failing channel is not hammered.
      await alertError(params);
      await alertError(params);
      await alertError(params);
      expect(texts).toHaveLength(1);
      accept = true;
      now.mockReturnValue(1_000_000 + 61_000);
      await alertError(params);
      expect(texts).toHaveLength(2);
      // 1 undelivered page + 3 suppressed calls.
      expect(texts[1]).toContain('(+4 more since the last page)');
    } finally {
      now.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe('sendTelegramText undelivered text', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps user text out of the logs when logUndeliveredText is false', async () => {
    process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
    process.env.ITACHI_DEBUG_CHAT_ID = 'test-chat';
    globalThis.fetch = (async (_input, _init): Promise<Response> =>
      new Response('bad request', { status: 400 })) as typeof fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await sendTelegramText('private ticket text', { logUndeliveredText: false })).toBe(false);
      const logged = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join(' ');
      expect(logged).not.toContain('private ticket text');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
