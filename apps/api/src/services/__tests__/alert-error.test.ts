import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';

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
});
