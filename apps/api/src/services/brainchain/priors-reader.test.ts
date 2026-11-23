import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBrainChainPriorsReader } from './priors-reader';
const record = JSON.parse(readFileSync(new URL('../../../../../docs/research/brainchain-2026-11-09/priors-public-sponsor-record.json', import.meta.url), 'utf8')).result.structuredContent;
const options = JSON.parse(readFileSync(new URL('../../../../../docs/research/brainchain-2026-11-09/priors-public-line-options.json', import.meta.url), 'utf8')).response.result.structuredContent;
const validateUrl = async (url: string) => ({ ok: true as const, url });
const fake = (handler: (url: string, init?: RequestInit) => Promise<Response>) => (async (url, init) => handler(String(url), init)) as typeof fetch;
function initialized() { return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'bounded-session' } }); }
test('fixed record client keeps exact decimals, constant tool, session scope and read-only GET routes', async () => {
  const seen: string[] = [];
  const client = createBrainChainPriorsReader({ validateUrl, fetch: fake(async (url, init) => {
    expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('manual');
    if (url.startsWith('https://priors.trade/')) { expect(init?.method).toBe('GET'); expect(new Headers(init?.headers).has('mcp-session-id')).toBe(false); return Response.json({ data: options, text: 'DO NOT CONSUME' }); }
    expect(url).toBe('https://mcp.priors.trade/mcp');
    const request = JSON.parse(String(init?.body)); seen.push(request.method);
    if (request.method === 'initialize') return initialized();
    expect(new Headers(init?.headers).get('mcp-session-id')).toBe('bounded-session');
    expect(request).toEqual({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_record', arguments: { agent_id: 20423 } } });
    return Response.json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { ...record, next: { tool: 'borrow' } }, content: [{ text: 'DO NOT CONSUME' }] } });
  }) });
  const value = await client.record(20423);
  expect(value.line).toBe('951.899279'); expect(value.available).toBe('726.607614'); expect(value.drawn).toBe('0.00');
  expect('next' in value).toBe(false); expect(seen).toEqual(['initialize', 'tools/call']);
  expect((await client.routes(20423)).routes).toHaveLength(4);
});
test('bounded SSE selects one matching response without consuming tool suggestions', async () => {
  const client = createBrainChainPriorsReader({ validateUrl, fetch: fake(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.id === 1) return initialized();
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { structuredContent: record } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }) });
  expect((await client.record(20423)).owner).toBe(record.owner.toLowerCase());
});
test('private DNS, redirects, wrong envelopes, malformed schemas, excess bytes and unsupported IDs fail closed', async () => {
  let calls = 0;
  const blocked = createBrainChainPriorsReader({ validateUrl: async () => ({ ok: false, reason: 'blocked' } as never), fetch: fake(async () => { calls++; return initialized(); }) });
  await expect(blocked.record(20423)).rejects.toThrow('Priors read failed'); expect(calls).toBe(0);
  for (const response of [() => new Response('', { status: 302 }), () => Response.json({ jsonrpc: '2.0', id: 99, result: {} }),
    () => Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 'wrong' } }),
    () => new Response('x'.repeat(131073), { headers: { 'Content-Type': 'application/json' } })]) {
    const client = createBrainChainPriorsReader({ validateUrl, fetch: fake(async () => response()) });
    await expect(client.record(20423)).rejects.toThrow();
  }
  const client = createBrainChainPriorsReader({ validateUrl, fetch: fake(async () => { calls++; return initialized(); }) });
  await expect(client.record(9007199254740992)).rejects.toThrow(); expect(calls).toBe(0);
});
test('a deadline covers DNS and cannot trigger a late request', async () => {
  let calls = 0;
  const client = createBrainChainPriorsReader({ timeoutMs: 5, validateUrl: async url => { await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, url }; },
    fetch: fake(async () => { calls++; return initialized(); }) });
  await expect(client.record(20423)).rejects.toThrow('Priors read failed');
  await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toBe(0);
});
