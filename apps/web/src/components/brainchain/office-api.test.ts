import { afterEach, expect, test } from 'bun:test';
import { officialEvidenceUrl, readOffice, workerRequestDescription } from './office-api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('public Office requests omit account credentials and forward cancellation', async () => {
  const controller = new AbortController();
  let request: RequestInit | undefined;
  let destination = '';
  globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
    destination = String(url); request = options;
    return Response.json({ version: 1 });
  }) as typeof fetch;
  const result = await readOffice<{ version: number }>('knowledge', controller.signal);
  expect(result.version).toBe(1);
  expect(destination.endsWith('/api/brainchain/knowledge')).toBe(true);
  expect(request?.credentials).toBe('omit');
  expect(request?.signal).toBe(controller.signal);
  expect(request?.cache).toBe('no-store');
});

test('a failed observation never becomes a fabricated empty success', async () => {
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
  await expect(readOffice('status', new AbortController().signal)).rejects.toThrow('cannot load this information');
});

test('evidence links reject executable URLs and look-alike hosts', () => {
  for (const value of ['javascript:alert(1)', 'https://docs.usebrainchain.com.evil.test/', 'https://user@docs.usebrainchain.com/', 'https://github.com/evil/brainchain']) {
    expect(officialEvidenceUrl(value)).toBeNull();
  }
  expect(officialEvidenceUrl('https://docs.usebrainchain.com/network')).toBe('https://docs.usebrainchain.com/network');
});
test('a running worker request remains a local request rather than task or income proof', () => {
  expect(workerRequestDescription('running')).toBe('Testnet work requested. This status does not confirm a task or payment.');
});
