import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { CLAWVILLE_GAME_TOOLS } from '@clawville/shared';
import {
  MCP_CALLS_PER_MINUTE,
  MCP_MAX_CALL_BUDGETS,
  agentMcpRoutes,
  allowCall,
  callBudgetCountForTests,
  resetMcpStateForTests,
  setMcpDispatcher,
  setMcpSessionValidatorForTests,
  setMcpSubRequestTimeoutForTests,
} from '../agent-mcp';

const app = new Hono();
app.route('/api/agent', agentMcpRoutes);

const LIVE = new Set<string>();
/** sessionId -> agentId as the liveness gate reports it (default agent-of-<sid>). */
const AGENT_OF = new Map<string, string>();
const seen: Request[] = [];
let connectBody: Record<string, unknown> = {};

beforeEach(() => {
  resetMcpStateForTests();
  LIVE.clear();
  LIVE.add('ag-live');
  AGENT_OF.clear();
  seen.length = 0;
  connectBody = {
    agentId: 'agent-1',
    sessionId: 'ag-new',
    isReturning: false,
    cognition: { mode: 'self-managed' },
    walletAddress: 'Wallet111',
    walletPending: false,
    sessionTicket: { url: 'https://example.test/enter?t=1', expiresAt: '2026-10-14T00:00:00Z' },
    identity: { userId: 'u1', publicKey: 'pk', secretKey: 'ID-SECRET', isFirstTime: true },
    knowledge: ['big'],
  };
  setMcpSessionValidatorForTests(async (sid) => (LIVE.has(sid) ? { agentId: AGENT_OF.get(sid) ?? `agent-of-${sid}` } : null));
  setMcpDispatcher(async (req) => {
    seen.push(req);
    const url = new URL(req.url);
    if (url.pathname === '/api/agent/connect') {
      LIVE.add(String(connectBody.sessionId));
      return Response.json(connectBody);
    }
    return Response.json({ path: url.pathname, inventory: [] });
  });
});

afterEach(() => {
  setMcpDispatcher(null);
  setMcpSessionValidatorForTests(null);
  setMcpSubRequestTimeoutForTests(null);
});

let nextId = 1;
function rpc(method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}, id: number | null = nextId++) {
  return app.request('/api/agent/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.7', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
  });
}

async function initialize(): Promise<string> {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  return res.headers.get('mcp-session-id')!;
}

async function callTool(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await rpc('tools/call', { name, arguments: args }, headers);
  const json = (await res.json()) as any;
  return { res, json, answer: json.result ? JSON.parse(json.result.content[0].text) : null };
}

describe('transport', () => {
  test('initialize returns serverInfo, tools capability and a random Mcp-Session-Id', async () => {
    const res = await rpc('initialize', { protocolVersion: '2025-03-26' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe('2025-03-26');
    expect(json.result.serverInfo.name).toBe('clawville');
    expect(json.result.capabilities.tools).toBeDefined();
    const sid = res.headers.get('mcp-session-id')!;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(await initialize()).not.toBe(sid);
  });

  test('an unknown protocol version falls back to the newest', async () => {
    const json = (await (await rpc('initialize', { protocolVersion: '1999-01-01' })).json()) as any;
    expect(json.result.protocolVersion).toBe('2025-06-18');
  });

  test('a notification answers 202 with no body', async () => {
    const res = await rpc('notifications/initialized', undefined, {}, null);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('ping and tools/list need no auth; the list has every game tool', async () => {
    expect(((await (await rpc('ping')).json()) as any).result).toEqual({});
    const json = (await (await rpc('tools/list')).json()) as any;
    const names = json.result.tools.map((t: { name: string }) => t.name);
    for (const tool of CLAWVILLE_GAME_TOOLS) expect(names).toContain(tool.name);
    for (const meta of ['clawville_connect', 'clawville_docs', 'clawville_call', 'clawville_building_tool', 'clawville_cove_tools', 'clawville_cove_blackjack', 'clawville_cove_poker']) {
      expect(names).toContain(meta);
    }
    expect(json.result.tools.every((t: any) => t.inputSchema?.type === 'object')).toBe(true);
  });

  test('unknown method -> -32601, unknown tool -> -32602', async () => {
    expect(((await (await rpc('resources/list')).json()) as any).error.code).toBe(-32601);
    expect(((await (await rpc('tools/call', { name: 'nope' })).json()) as any).error.code).toBe(-32602);
  });

  test('bad JSON -> 400 with -32700', async () => {
    const res = await app.request('/api/agent/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32700);
  });

  test('an invalid envelope -> -32600', async () => {
    const res = await app.request('/api/agent/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 1, method: 'ping' }) });
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });

  test('GET and DELETE -> 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request('/api/agent/mcp', { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  test('a browser Origin is refused', async () => {
    const res = await rpc('ping', undefined, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await app.request('/api/agent/mcp', { method: 'GET', headers: { Origin: 'https://x' } })).status).toBe(403);
  });

  test('a body over 256 KB -> 413', async () => {
    const res = await app.request('/api/agent/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } }),
    });
    expect(res.status).toBe(413);
  });

  test('an unknown Mcp-Session-Id -> 404 so the client initializes again', async () => {
    const res = await rpc('ping', undefined, { 'Mcp-Session-Id': 'never-issued' });
    expect(res.status).toBe(404);
  });

  test('an unsupported MCP-Protocol-Version header -> 400', async () => {
    const res = await rpc('ping', undefined, { 'MCP-Protocol-Version': '1999-01-01' });
    expect(res.status).toBe(400);
  });
});

describe('auth', () => {
  test('a game tool without a session answers not_connected (not a protocol error)', async () => {
    const { json, answer } = await callTool('clawville_get_inventory', {});
    expect(json.result.isError).toBe(false);
    expect(answer).toMatchObject({ ok: false, error: 'not_connected' });
    expect(seen).toHaveLength(0);
  });

  test('a dead bearer answers not_connected', async () => {
    const { answer } = await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-dead' });
    expect(answer.error).toBe('not_connected');
  });

  test('a live bearer works; sub-requests carry the session and client IP, never Authorization or Cookie', async () => {
    const { answer } = await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live', Cookie: 'auth_session=human', 'User-Agent': 'agent/1' });
    expect(answer.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const sub = seen[0]!;
    expect(new URL(sub.url).pathname).toBe('/api/items/inventory');
    expect(sub.headers.get('x-clawville-agent-session')).toBe('ag-live');
    expect(sub.headers.get('x-real-ip')).toBe('203.0.113.7');
    expect(sub.headers.get('user-agent')).toBe('agent/1');
    expect(sub.headers.get('authorization')).toBeNull();
    expect(sub.headers.get('cookie')).toBeNull();
  });

  test('X-Clawville-Agent-Session also works', async () => {
    const { answer } = await callTool('clawville_get_inventory', {}, { 'X-Clawville-Agent-Session': 'ag-live' });
    expect(answer.ok).toBe(true);
  });

  test('clawville_connect returns the sessionId and tells the agent to pass it on every call', async () => {
    const mcp = await initialize();
    const { answer } = await callTool('clawville_connect', { agentId: 'agent-1', identityType: 'claude-code', identityKey: 'k' }, { 'Mcp-Session-Id': mcp });
    expect(answer.ok).toBe(true);
    expect(answer.data.sessionId).toBe('ag-new');
    expect(answer.data.mcpSessionBound).toBeUndefined();
    expect(answer.data.identity.secretKey).toBe('ID-SECRET');
    expect(answer.data.wallet).toBeUndefined();
    expect(answer.data.knowledge).toBeUndefined();
    expect(answer.next).toContain('"sessionId": "ag-new"');
    expect(answer.next).toContain('EVERY later tool call');
    expect(answer.next).toContain('clawville_docs');
    const connectReq = seen[0]!;
    expect(connectReq.headers.get('x-clawville-agent-session')).toBeNull();
    expect(await connectReq.json()).toEqual({ agentId: 'agent-1', identityType: 'claude-code', identityKey: 'k' });
    // The returned sessionId works as the argument.
    const { answer: inv } = await callTool('clawville_get_inventory', { sessionId: 'ag-new' }, { 'Mcp-Session-Id': mcp });
    expect(inv.ok).toBe(true);
    expect(seen[1]!.headers.get('x-clawville-agent-session')).toBe('ag-new');
  });

  // Codex pass 2 (blocking): Mcp-Session-Id is transport state only.
  test('a tool call with only an Mcp-Session-Id (no credential) is refused with not_connected', async () => {
    const mcp = await initialize();
    await callTool('clawville_connect', { agentId: 'agent-1' }, { 'Mcp-Session-Id': mcp });
    const before = seen.length;
    for (const name of ['clawville_get_inventory', 'clawville_call', 'clawville_building_tool']) {
      const args = name === 'clawville_call' ? { method: 'GET', path: '/api/items/inventory' } : name === 'clawville_building_tool' ? { building: 'bank', tool: 'x' } : {};
      const { answer } = await callTool(name, args, { 'Mcp-Session-Id': mcp });
      expect({ name, error: answer.error }).toEqual({ name, error: 'not_connected' });
    }
    expect(seen.length).toBe(before);
  });

  test('a connected MCP session id does not authorize a second client', async () => {
    const mcp = await initialize();
    // Client A connects on this MCP session.
    await callTool('clawville_connect', { agentId: 'agent-1' }, { 'Mcp-Session-Id': mcp });
    const before = seen.length;
    // Client B reuses the same Mcp-Session-Id from another address, with no credential.
    const b = await callTool('clawville_get_inventory', {}, { 'Mcp-Session-Id': mcp, 'x-real-ip': '198.51.100.9' });
    expect(b.answer.error).toBe('not_connected');
    expect(seen.length).toBe(before);
    // With its own live session, B acts as itself, never as A.
    const own = await callTool('clawville_get_inventory', {}, { 'Mcp-Session-Id': mcp, 'x-real-ip': '198.51.100.9', Authorization: 'Bearer ag-live' });
    expect(own.answer.ok).toBe(true);
    expect(seen.at(-1)!.headers.get('x-clawville-agent-session')).toBe('ag-live');
  });

  test('the sessionId argument authorizes the call and never reaches the tool or a sub-request body', async () => {
    const { answer } = await callTool('clawville_call', { sessionId: 'ag-live', method: 'POST', path: '/api/items/use', body: { itemId: 'i1' } });
    expect(answer.ok).toBe(true);
    const sub = seen[0]!;
    expect(sub.headers.get('x-clawville-agent-session')).toBe('ag-live');
    expect(await sub.json()).toEqual({ itemId: 'i1' });
    const game = await callTool('clawville_get_inventory', { sessionId: 'ag-live' });
    expect(game.answer.ok).toBe(true);
    expect(new URL(seen[1]!.url).search).not.toContain('ag-live');
  });

  test('the sessionId argument and the headers must agree; a bad argument is refused', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, string>, string]> = [
      [{ sessionId: 'ag-live' }, { Authorization: 'Bearer ag-other' }, 'conflicting_credentials'],
      [{ sessionId: 'ag-live' }, { 'X-Clawville-Agent-Session': 'ag-other' }, 'conflicting_credentials'],
      [{ sessionId: 42 }, {}, 'invalid_credentials'],
      [{ sessionId: '' }, {}, 'invalid_credentials'],
      [{ sessionId: 'a b' }, {}, 'invalid_credentials'],
      [{ sessionId: 'ag-live' }, { Authorization: 'Basic x' }, 'invalid_credentials'],
      [{ sessionId: 'ag-dead' }, {}, 'not_connected'],
    ];
    for (const [args, headers, error] of cases) {
      const { answer } = await callTool('clawville_get_inventory', args, headers);
      expect({ args, headers, error: answer.error }).toEqual({ args, headers, error });
    }
    expect(seen).toHaveLength(0);
    const same = await callTool('clawville_get_inventory', { sessionId: 'ag-live' }, { Authorization: 'Bearer ag-live' });
    expect(same.answer.ok).toBe(true);
  });

  test('tools/list shows the sessionId argument on protected tools only', async () => {
    const json = (await (await rpc('tools/list')).json()) as any;
    const byName = new Map<string, any>(json.result.tools.map((t: any) => [t.name, t]));
    expect(byName.get('clawville_get_inventory').inputSchema.properties.sessionId.type).toBe('string');
    expect(byName.get('clawville_call').inputSchema.properties.sessionId.type).toBe('string');
    expect(byName.get('clawville_connect').inputSchema.properties.sessionId).toBeUndefined();
    expect(byName.get('clawville_docs').inputSchema.properties.sessionId).toBeUndefined();
  });

  test('a refused connect is a normal answer', async () => {
    setMcpDispatcher(async () => Response.json({ error: 'Too many connection attempts.' }, { status: 429 }));
    const { json, answer } = await callTool('clawville_connect', { agentId: 'agent-1' });
    expect(json.result.isError).toBe(false);
    expect(answer).toMatchObject({ ok: false, status: 429 });
  });

  test('a dispatcher crash is an isError tool result without details', async () => {
    setMcpDispatcher(async () => {
      throw new Error('boom ag-live');
    });
    const { json } = await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live' });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).not.toContain('ag-live');
  });

  test('an SSE route is refused, not hung', async () => {
    setMcpDispatcher(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    // An SSE route is refused before dispatch (finding 3a) ...
    const refused = await callTool('clawville_call', { method: 'GET', path: '/api/agent/ag-live/events' }, { Authorization: 'Bearer ag-live' });
    expect(refused.answer).toMatchObject({ ok: false, status: 400, error: 'path_refused' });
    // ... and any other route that answers with a stream is still cancelled (415).
    const { answer } = await callTool('clawville_call', { method: 'GET', path: '/api/agent/ag-live/perception' }, { Authorization: 'Bearer ag-live' });
    expect(answer).toMatchObject({ ok: false, status: 415 });
  });
});

describe('Codex review fixes', () => {
  // Finding 1: encoded and recursive MCP paths.
  test('encoded admin / mcp / connect paths never reach the dispatcher', async () => {
    for (const path of ['/api/%61dmin/trading', '/api/agent/%6dcp', '/api/agent/%63onnect', '/api/AGENT/MCP', '/api/agent/mcp/']) {
      const { answer } = await callTool('clawville_call', { method: 'POST', path, body: {} }, { Authorization: 'Bearer ag-live' });
      expect({ path, error: answer.error }).toEqual({ path, error: 'path_refused' });
    }
    expect(seen).toHaveLength(0);
  });

  test('a request carrying the sub-request marker is refused (no MCP recursion)', async () => {
    const res = await rpc('ping', undefined, { 'X-Clawville-Mcp-Subrequest': '1' });
    expect(res.status).toBe(400);
  });

  test('every sub-request carries the marker', async () => {
    await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live' });
    expect(seen[0]!.headers.get('x-clawville-mcp-subrequest')).toBe('1');
  });

  // Finding 2: session fixation.
  test('initialize with an Mcp-Session-Id header is refused and issues no id', async () => {
    const planted = await initialize();
    const res = await rpc('initialize', { protocolVersion: '2025-06-18' }, { 'Mcp-Session-Id': planted });
    expect(res.status).toBe(400);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(((await res.json()) as any).error.message).toContain('Do not send Mcp-Session-Id');
  });

  test('a dead bearer answers not_connected even after a connect on the MCP session (no fallback)', async () => {
    const mcp = await initialize();
    await callTool('clawville_connect', { agentId: 'agent-1' }, { 'Mcp-Session-Id': mcp });
    const before = seen.length;
    const { answer } = await callTool('clawville_get_inventory', {}, { 'Mcp-Session-Id': mcp, Authorization: 'Bearer ag-dead' });
    expect(answer.error).toBe('not_connected');
    expect(seen.length).toBe(before);
  });

  test('malformed or conflicting credential headers are refused', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ Authorization: 'Basic abc' }, 'invalid_credentials'],
      [{ Authorization: 'Bearer' }, 'invalid_credentials'],
      [{ 'X-Clawville-Agent-Session': '' }, 'invalid_credentials'],
      [{ Authorization: 'Bearer ag-live', 'X-Clawville-Agent-Session': 'ag-other' }, 'conflicting_credentials'],
    ];
    for (const [headers, error] of cases) {
      const { answer } = await callTool('clawville_get_inventory', {}, headers);
      expect({ headers, error: answer.error }).toEqual({ headers, error });
    }
    const same = await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live', 'X-Clawville-Agent-Session': 'ag-live' });
    expect(same.answer.ok).toBe(true);
  });

  // Finding 5: one deadline covers the body read too.
  test('a response body that stalls ends at the deadline and the reader is cancelled', async () => {
    setMcpSubRequestTimeoutForTests(50);
    let cancelled = false;
    let subSignal = null as AbortSignal | null;
    setMcpDispatcher(async (req) => {
      subSignal = req.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const started = Date.now();
    const { answer } = await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live' });
    expect(answer).toMatchObject({ ok: false, status: 504 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
    expect(subSignal!.aborted).toBe(true);
  });

  test('a dispatch that never answers ends at the deadline', async () => {
    setMcpSubRequestTimeoutForTests(50);
    setMcpDispatcher(() => new Promise<Response>(() => {}));
    const { answer } = await callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live' });
    expect(answer).toMatchObject({ ok: false, status: 504 });
  });

  test('the MCP caller hanging up aborts the sub-request', async () => {
    let subSignal = null as AbortSignal | null;
    setMcpDispatcher((req) => {
      subSignal = req.signal;
      return new Promise<Response>(() => {});
    });
    const caller = new AbortController();
    const pending = app.request('/api/agent/mcp', {
      method: 'POST',
      signal: caller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ag-live' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clawville_get_inventory', arguments: {} } }),
    });
    while (!subSignal) await new Promise((r) => setTimeout(r, 5));
    caller.abort();
    const json = (await (await pending).json()) as any;
    expect(JSON.parse(json.result.content[0].text).status).toBe(504);
    expect(subSignal!.aborted).toBe(true);
  });
});

describe('Codex pass 2: cancellation', () => {
  test('a caller abort during the first batch message: the second never reaches the dispatcher', async () => {
    const paths: string[] = [];
    setMcpDispatcher((req) => {
      paths.push(new URL(req.url).pathname);
      return new Promise<Response>(() => {});
    });
    const caller = new AbortController();
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'clawville_get_inventory', arguments: {} } });
    const pending = app.request('/api/agent/mcp', {
      method: 'POST',
      signal: caller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ag-live' },
      body: JSON.stringify([call(1), call(2)]),
    });
    while (paths.length === 0) await new Promise((r) => setTimeout(r, 5));
    caller.abort();
    const replies = (await (await pending).json()) as any[];
    // Give a wrongly started second call time to show up.
    await new Promise((r) => setTimeout(r, 30));
    expect(paths).toEqual(['/api/items/inventory']);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0].result.content[0].text).status).toBe(504);
  });

  test('a body whose cancel() never settles still answers at the deadline', async () => {
    setMcpSubRequestTimeoutForTests(50);
    const neverSettles = () => new Promise<void>(() => {});
    // Fail fast (instead of hanging the run) if the answer waits on cancel().
    const within = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('answer waited on cancel()')), 2_000))]);
    setMcpDispatcher(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
          cancel: neverSettles,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const started = Date.now();
    const { answer } = await within(callTool('clawville_get_inventory', {}, { Authorization: 'Bearer ag-live' }));
    expect(answer).toMatchObject({ ok: false, status: 504 });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The streaming-refusal path does not wait on cancel() either.
    setMcpDispatcher(async () =>
      new Response(new ReadableStream({ cancel: neverSettles }), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const sse = await within(callTool('clawville_call', { method: 'GET', path: '/api/agent/ag-live/perception' }, { Authorization: 'Bearer ag-live' }));
    expect(sse.answer).toMatchObject({ ok: false, status: 415 });
  });

  test('a caller abort during the first sub-request: the tool starts no second sub-request', async () => {
    const caller = new AbortController();
    const paths: string[] = [];
    setMcpDispatcher(async (req) => {
      paths.push(new URL(req.url).pathname);
      caller.abort(); // the caller hangs up while the visit is answered
      return Response.json({ ok: true });
    });
    await Promise.resolve(
      app.request('/api/agent/mcp', {
        method: 'POST',
        signal: caller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ag-live' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clawville_visit_building', arguments: { buildingId: 'cron-automation' } } }),
      }),
    ).catch(() => null);
    expect(paths).toHaveLength(1);
  });

  test('a caller that already left starts no sub-request', async () => {
    const caller = new AbortController();
    caller.abort();
    const res = await Promise.resolve(
      app.request('/api/agent/mcp', {
        method: 'POST',
        signal: caller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ag-live' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clawville_get_inventory', arguments: {} } }),
      }),
    ).catch(() => null);
    // Either no reply at all (batch stopped) or a 504 answer; never a dispatch.
    if (res && res.status === 200) {
      const json = (await res.json()) as any;
      if (json?.result) expect(JSON.parse(json.result.content[0].text).status).toBe(504);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('rate limit', () => {
  test('the rate-budget map never grows past its cap; the oldest entries go first', () => {
    const now = Date.now();
    for (let i = 0; i < MCP_MAX_CALL_BUDGETS + 500; i += 1) allowCall(`flood:${i}`, now);
    expect(callBudgetCountForTests()).toBeLessThanOrEqual(MCP_MAX_CALL_BUDGETS);
    // A drained key that is still in the map stays drained.
    for (let i = 0; i < 3; i += 1) allowCall('tight', now, 2);
    expect(allowCall('tight', now, 2)).toBe(false);
    expect(callBudgetCountForTests()).toBeLessThanOrEqual(MCP_MAX_CALL_BUDGETS);
  });

  test(`at most ${MCP_CALLS_PER_MINUTE} tools/call per minute per session`, async () => {
    for (let i = 0; i < MCP_CALLS_PER_MINUTE; i += 1) {
      const { answer } = await callTool('clawville_docs', { topic: 'mcp' }, { Authorization: 'Bearer ag-live' });
      expect(answer.ok).toBe(true);
    }
    const { json, answer } = await callTool('clawville_docs', { topic: 'mcp' }, { Authorization: 'Bearer ag-live' });
    expect(json.result.isError).toBe(false);
    expect(answer.error).toBe('rate_limited');
  });
});
