import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';

const originalToken = process.env.ITACHI_DEBUG_BOT_TOKEN;
const originalChatId = process.env.ITACHI_DEBUG_CHAT_ID;
const originalFetch = globalThis.fetch;

process.env.ITACHI_DEBUG_BOT_TOKEN = 'test-token';
process.env.ITACHI_DEBUG_CHAT_ID = 'test-chat';

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
