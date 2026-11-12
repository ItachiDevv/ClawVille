import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAWVILLE_GAME_TOOLS, type ToolPropertySchema } from '@clawville/shared';
import {
  COVE_BLACKJACK_TOOL_NAMES,
  COVE_POKER_TOOL_NAMES,
  GAME_TOOL_ROUTES,
  MCP_TOOLS,
  PERCEPTION_SOURCE,
  answerText,
  runMcpTool,
  summarizeConnect,
  validateCallPath,
  type RouteSource,
  type SubCall,
  type SubResult,
  type ToolRuntime,
  type HttpMethod,
} from '../agent-mcp-tools';

const SRC = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const INDEX = read('index.ts');
const GUARD = read('services/agent-human-control-guard.ts');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternRegex(mount: string, pattern: string): RegExp {
  const full = pattern === '/' ? mount : `${mount}${pattern}`;
  return new RegExp(`^${full.split('/').map((part) => (part.startsWith(':') ? '[^/]+' : escape(part))).join('/')}$`);
}

/** A sample value that satisfies a property schema. */
function sample(schema: ToolPropertySchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'string': return 'x1';
    case 'number': return 10_000;
    case 'integer': return 1;
    case 'boolean': return true;
    case 'array': return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sample(v);
      return out;
    }
    default: return null;
  }
}

function stubRuntime(
  respond: (call: SubCall) => SubResult = () => ({ status: 200, ok: true, data: { ok: true } }),
  session: ToolRuntime['session'] = { sessionId: 'ag-live', agentId: 'agent-1' },
) {
  const calls: SubCall[] = [];
  const rt: ToolRuntime = {
    session,
    call: async (call) => {
      calls.push(call);
      return respond(call);
    },
    isAborted: () => false,
    sleep: async () => {},
    movePoll: { intervalMs: 0, maxMs: 1_000 },
  };
  return { rt, calls };
}

const parse = (text: string) => JSON.parse(text) as { ok: boolean; status?: number; data?: any; error?: string; next: string };

describe('GAME_TOOL_ROUTES coverage', () => {
  test('every CLAWVILLE_GAME_TOOLS name has a route mapping, and no mapping is stale', () => {
    const names = CLAWVILLE_GAME_TOOLS.map((t) => t.name).sort();
    expect(Object.keys(GAME_TOOL_ROUTES).sort()).toEqual(names);
  });

  test('every mapped route exists in its route file and its mount exists in index.ts', () => {
    const sources: RouteSource[] = [...Object.values(GAME_TOOL_ROUTES).flatMap((r) => r.sources), PERCEPTION_SOURCE];
    for (const s of sources) {
      const file = read(`routes/${s.file}`);
      const call = new RegExp(`\\.${s.method}\\(\\s*${escape(s.literal)}\\s*,`);
      expect({ src: s, found: call.test(file) }).toEqual({ src: s, found: true });
      if (s.literal.startsWith("'")) {
        expect(s.literal).toBe(`'${s.pattern}'`);
      } else {
        // Constant-named gateway routes come from HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS.
        expect(GUARD.includes(`'${s.pattern}'`)).toBe(true);
      }
      expect(INDEX.includes(`app.route('${s.mount}',`)).toBe(true);
    }
  });

  test('the calls each tool builds match one of its declared routes', () => {
    for (const tool of CLAWVILLE_GAME_TOOLS) {
      const route = GAME_TOOL_ROUTES[tool.name]!;
      const input = sample(tool.input_schema as ToolPropertySchema) as Record<string, unknown>;
      for (const call of route.calls({ sid: 'ag-live', agentId: 'agent-1' }, input)) {
        const pathname = call.path.split('?')[0]!;
        const match = route.sources.some(
          (s) => s.method.toUpperCase() === call.method && patternRegex(s.mount, s.pattern).test(pathname),
        );
        expect({ tool: tool.name, path: call.path, match }).toEqual({ tool: tool.name, path: call.path, match: true });
      }
    }
  });

  test('cove tool names exist in the gateway forwarder tables', () => {
    const gateway = read('routes/agent-gateway.ts');
    for (const name of [...COVE_BLACKJACK_TOOL_NAMES, ...COVE_POKER_TOOL_NAMES]) {
      expect(gateway.includes(`  ${name}: {`)).toBe(true);
    }
  });

  test('game tools keep their shared name, description and input schema (plus the sessionId argument)', () => {
    for (const tool of CLAWVILLE_GAME_TOOLS) {
      const listed = MCP_TOOLS.find((t) => t.name === tool.name)!;
      const shared = tool.input_schema as unknown as { properties?: Record<string, unknown>; required?: string[] };
      const { sessionId, ...rest } = (listed.inputSchema as { properties: Record<string, unknown> }).properties;
      expect({ ...listed.inputSchema, properties: rest }).toEqual({ ...shared, properties: shared.properties ?? {} });
      expect((sessionId as { type: string }).type).toBe('string');
      // Optional in the schema: a client may send the header instead.
      expect((listed.inputSchema as { required?: string[] }).required ?? []).not.toContain('sessionId');
      expect(listed.description.includes('{apiBase}')).toBe(false);
    }
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });

  test('every protected tool takes the sessionId argument; connect and docs do not', () => {
    for (const tool of MCP_TOOLS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect({ tool: tool.name, has: 'sessionId' in props }).toEqual({ tool: tool.name, has: tool.needsSession });
    }
  });
});

describe('clawville_call path policy', () => {
  const cases: Array<[unknown, boolean]> = [
    ['/api/agent/ag-1/perception', true],
    ['/api/floor/arena/leaderboard?window=24h', true],
    ['/api/items/shop/cron-automation', true],
    ['/api/agent/connect-skill', true],
    ['/api/agent/mcp', false],
    ['/api/agent/MCP', false],
    ['/api/agent/mcp/x', false],
    ['/api/agent/connect', false],
    ['/api/agent/connect?x=1', false],
    ['/api/admin/trading', false],
    ['/api/Admin', false],
    ['/api/partner/hatcher/agents', false],
    ['/api/x402-mock/settle', false],
    ['/api/cove/test-fixture/seed', false],
    ['/api/auth/login', false],
    ['/api/dash-auth/x', false],
    ['/api/../admin', false],
    ['/api/agent/%2e%2e/admin', false],
    ['/api/agent/%2F', false],
    // Codex finding 1: Hono decodes %XX before routing.
    ['/api/%61dmin/trading', false],
    ['/api/%41DMIN/trading', false],
    ['/api/agent/%6dcp', false],
    ['/api/agent/%4DCP', false],
    ['/api/agent/%63onnect', false],
    ['/api/agent/%43ONNECT', false],
    ['/API/admin', false],
    ['/api/ADMIN/trading', false],
    ['/api/AGENT/MCP', false],
    ['/api/agent/Connect', false],
    ['/api/admin/', false],
    ['/api/agent/mcp/', false],
    ['/api/agent/connect/', false],
    ['/api/agent/mcp;x', false],
    ['/api/items/shop/x?q=%41', true],
    // Codex pass 2 note: admin-guarded routes outside /api/admin.
    ['/api/treasury/summary', false],
    ['/api/oracle/clv', false],
    ['/api/events/create', false],
    ['/api/events/x/settle', false],
    ['/api/events/x/sol-refunds/y/paid', false],
    ['/api/wager/lobbies/x/settle', false],
    ['/api/dashboard/overview', false],
    ['/api/quests/admin/create', false],
    ['/api/world/rooms', false],
    ['/api/events/x/signup', true],
    ['/api/wager/lobbies', true],
    // Codex finding 3: SSE routes are refused before dispatch.
    ['/api/agent/ag-1/events', false],
    ['/api/agent/ag-1/events/', false],
    ['/api/agent/ag-1/EVENTS', false],
    ['/api/agent/ag-1/events?after=5', false],
    ['/api/agent/ag-1/events/replay', true],
    ['/api/npc/stream', false],
    ['/api/research/stream', false],
    ['/api/world/room-1/stream', false],
    ['/api/npc/state', true],
    ['/api//admin', false],
    ['/api/./admin', false],
    ['/api\\admin', false],
    ['http://evil.example/api/x', false],
    ['//evil.example/api/x', false],
    ['/api/x#frag', false],
    ['/api/x y', false],
    ['/api/é', false],
    ['/health', false],
    ['api/agent', false],
    ['', false],
    [42, false],
    ['/api/' + 'a'.repeat(3000), false],
  ];
  for (const [path, allowed] of cases) {
    test(`${String(path).slice(0, 60)} -> ${allowed ? 'allowed' : 'refused'}`, () => {
      expect(validateCallPath(path) === null).toBe(allowed);
    });
  }

  test('SSE_ROUTE_PATTERNS covers every streaming route file', () => {
    const streaming = readdirSync(join(SRC, 'routes'))
      .filter((f) => f.endsWith('.ts') && f !== 'agent-mcp.ts')
      .filter((f) => /streamSSE\(|text\/event-stream/.test(read(`routes/${f}`)))
      .sort();
    // A new SSE route must add a pattern to SSE_ROUTE_PATTERNS and to this list.
    expect(streaming).toEqual(['agent-gateway.ts', 'npc-sse.ts', 'research-sse.ts', 'world.ts']);
  });

  test('admin exclusions are method-aware: GET /api/events/create is the public slug read, POST is refused', async () => {
    expect(validateCallPath('/api/events/create', 'GET')).toBeNull();
    expect(validateCallPath('/api/events/create', 'POST')).not.toBeNull();
    expect(validateCallPath('/api/events/create')).not.toBeNull(); // no method: strict
    expect(validateCallPath('/api/events/x/settle', 'GET')).toBeNull();
    expect(validateCallPath('/api/events/x/settle', 'POST')).not.toBeNull();
    expect(validateCallPath('/api/treasury/summary', 'GET')).not.toBeNull();
    expect(validateCallPath('/api/events/x/sol-refunds', 'POST')).not.toBeNull(); // prefix: every method
    expect(validateCallPath('/api/dashboard/overview', 'POST')).not.toBeNull();
    const { rt, calls } = stubRuntime();
    const get = await runMcpTool('clawville_call', { method: 'GET', path: '/api/events/create' }, rt);
    expect(get.body.ok).toBe(true);
    const post = await runMcpTool('clawville_call', { method: 'POST', path: '/api/events/create', body: {} }, rt);
    expect(post.body.error).toBe('path_refused');
    expect(calls).toEqual([{ method: 'GET', path: '/api/events/create' }]);
  });

  test('a refused path never reaches the dispatcher', async () => {
    const { rt, calls } = stubRuntime();
    const answer = await runMcpTool('clawville_call', { method: 'GET', path: '/api/admin/trading' }, rt);
    expect(answer.body.error).toBe('path_refused');
    expect(calls).toHaveLength(0);
  });

  test('a GET never carries a body; a reconnect tells the agent to use the new sessionId', async () => {
    const { rt, calls } = stubRuntime((call) =>
      call.path === '/api/agent/reconnect'
        ? { status: 200, ok: true, data: { sessionId: 'ag-rotated' } }
        : { status: 200, ok: true, data: {} },
    );
    await runMcpTool('clawville_call', { method: 'GET', path: '/api/agent/ag-live/stats', body: { a: 1 } }, rt);
    expect(calls[0]!.body).toBeUndefined();
    const answer = await runMcpTool('clawville_call', { method: 'POST', path: '/api/agent/reconnect', body: { a: 1 } }, rt);
    expect(answer.body.next).toContain('data.sessionId as your sessionId');
  });

  test('no admin-guarded route in apps/api/src/routes is reachable through clawville_call', () => {
    const GUARDS = /\b(adminOnly|requireNamedAdmin|moneyOperatorOnly|doordashOperatorOnly|requireAdmin|requireAdminUser)\b/;
    // Router variables imported from each route file, and where index.ts mounts them.
    const mountsByFile = new Map<string, string[]>();
    const importRe = /import\s*\{([^}]*)\}\s*from\s*'\.\/routes\/([\w.-]+)'/g;
    for (const m of INDEX.matchAll(importRe)) {
      const names = m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
      const mounts: string[] = [];
      for (const name of names) {
        for (const r of INDEX.matchAll(new RegExp(`app\\.route\\(\\s*'([^']+)'\\s*,\\s*${escape(name)}\\s*\\)`, 'g'))) {
          mounts.push(r[1]!);
        }
      }
      const file = m[2]!.endsWith('.ts') ? m[2]! : `${m[2]}.ts`;
      mountsByFile.set(file, [...(mountsByFile.get(file) ?? []), ...mounts]);
    }
    const routeRe = /(\w+)\.(get|post|patch|put|delete|all)\(\s*'(\/[^']*)'([^\n]*)/g;
    const guarded: string[] = [];
    const unmounted: string[] = [];
    for (const file of readdirSync(join(SRC, 'routes')).filter((f) => f.endsWith('.ts'))) {
      const text = read(`routes/${file}`);
      const routerWide = new Set(
        [...text.matchAll(/(\w+)\.use\(\s*'\*'\s*,\s*(\w+)/g)].filter((u) => GUARDS.test(u[2]!)).map((u) => u[1]!),
      );
      const defs = [...text.matchAll(routeRe)];
      defs.forEach((d, i) => {
        const end = i + 1 < defs.length ? defs[i + 1]!.index! : text.length;
        // The handler body up to the next route: catches in-handler guards (quests requireAdminUser).
        const segment = text.slice(d.index!, end);
        if (!routerWide.has(d[1]!) && !GUARDS.test(d[4]!) && !/requireAdminUser\(|requireNamedAdmin\(/.test(segment)) return;
        const mounts = mountsByFile.get(file) ?? [];
        if (mounts.length === 0) {
          unmounted.push(`${file} ${d[3]}`);
          return;
        }
        const concrete = d[3]!.replace(/:\w+(\{[^}]*\})?\??/g, 'x1').replace(/\*/g, 'x1');
        // The guarded route's own method; .all() is guarded for every method.
        const methods = d[2] === 'all' ? ['GET', 'POST', 'PATCH', 'DELETE'] : [d[2]!.toUpperCase()];
        for (const mount of mounts) {
          const path = concrete === '/' || concrete === '' ? mount : `${mount}${concrete}`;
          guarded.push(path);
          for (const method of methods) {
            expect({ file, method, path, refused: validateCallPath(path, method) !== null }).toEqual({ file, method, path, refused: true });
          }
        }
      });
    }
    // Route files with guards that index.ts does not mount (none today).
    expect(unmounted).toEqual([]);
    // Sanity: the scanner really finds the guarded routes (dashboard, events, treasury, ...).
    expect(guarded.length).toBeGreaterThanOrEqual(40);
    for (const known of ['/api/treasury/summary', '/api/oracle/clv', '/api/events/create', '/api/world/rooms', '/api/quests/admin/create']) {
      expect(guarded).toContain(known);
    }
  });
});

describe('clawville_docs', () => {
  test('core returns the served topic page', async () => {
    const { rt } = stubRuntime(undefined, null);
    const answer = await runMcpTool('clawville_docs', { topic: 'core' }, rt);
    const body = parse(answerText(answer));
    expect(body.ok).toBe(true);
    expect(body.data.markdown.startsWith('# ClawVille — Core rules')).toBe(true);
    expect(body.data.truncated).toBeUndefined();
  });

  test('every topic fits its cap uncut', async () => {
    const { rt } = stubRuntime(undefined, null);
    for (const topic of ['core', 'actions', 'world', 'cove', 'land', 'jobs', 'payments', 'trading', 'ecosystem', 'mcp']) {
      const body = parse(answerText(await runMcpTool('clawville_docs', { topic }, rt)));
      expect({ topic, ok: body.ok, cut: Boolean(body.data?.truncated) }).toEqual({ topic, ok: true, cut: false });
    }
  });

  test('the topic enum offers ecosystem and the page is the served ecosystem page', async () => {
    const docs = MCP_TOOLS.find((tool) => tool.name === 'clawville_docs')!;
    const topicSchema = (docs.inputSchema as { properties: { topic: { enum: string[] } } }).properties.topic;
    expect(topicSchema.enum).toContain('ecosystem');
    const { rt } = stubRuntime(undefined, null);
    const body = parse(answerText(await runMcpTool('clawville_docs', { topic: 'ecosystem' }, rt)));
    expect(body.ok).toBe(true);
    expect(body.data.markdown.startsWith('# ClawVille — Ecosystem MCPs\n\n## Ecosystem MCPs')).toBe(true);
  });

  test('the mcp page lists every game tool', async () => {
    const { rt } = stubRuntime(undefined, null);
    const body = parse(answerText(await runMcpTool('clawville_docs', { topic: 'mcp' }, rt)));
    for (const tool of CLAWVILLE_GAME_TOOLS) expect(body.data.markdown.includes(`\`${tool.name}\``)).toBe(true);
  });

  test('an unknown topic is a normal answer', async () => {
    const { rt } = stubRuntime(undefined, null);
    const body = parse(answerText(await runMcpTool('clawville_docs', { topic: 'nope' }, rt)));
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unknown_topic');
  });
});

describe('game tool execution', () => {
  test('BrainChain operations call the declared subject-bound REST routes and drop authority fields', async () => {
    const cases: Array<[Record<string, unknown>, HttpMethod, string, Record<string, unknown> | undefined]> = [
      [{op:'purchase_list'},'GET','/api/brainchain/purchases',undefined],
      [{op:'purchase_quote',orderId:'purchase-id'},'POST','/api/brainchain/purchases/purchase-id/quote',{}],
      [{op:'purchase_reconcile',orderId:'purchase-id'},'POST','/api/brainchain/purchases/purchase-id/reconcile',{}],
      [{ op: 'knowledge' }, 'GET', '/api/brainchain/knowledge', undefined],
      [{ op: 'status' }, 'GET', '/api/brainchain/status', undefined],
      [{ op: 'install' }, 'POST', '/api/brainchain/install', {}],
      [{ op: 'workers' }, 'GET', '/api/brainchain/workers', undefined],
      [{ op: 'earnings', workerId: 'worker-id', board: '0xabc', fromBlock: '965' }, 'GET', '/api/brainchain/workers/worker-id/earnings?board=0xabc&fromBlock=965', undefined],
      [{ op: 'identity_credit', workerId: 'worker-id', agentId: '462' }, 'GET', '/api/brainchain/workers/worker-id/identity-credit?agentId=462', undefined],
      [{ op: 'binding_challenge', environment: 'testnet', address: '0x123' }, 'POST', '/api/brainchain/workers/challenge', { environment: 'testnet', address: '0x123' }],
      [{ op: 'bind', nonce: 'fresh', signature: '0xproof' }, 'POST', '/api/brainchain/workers/bind', { nonce: 'fresh', signature: '0xproof' }],
      [{ op: 'control', workerId: 'worker-id', requestedState: 'draining' }, 'POST', '/api/brainchain/workers/worker-id/control', { requestedState: 'draining' }],
    ];
    for (const [input, method, path, body] of cases) {
      const { rt, calls } = stubRuntime();
      const answer = await runMcpTool('clawville_brainchain', { ...input, avatarId: 'other-avatar', privateKey: 'never-forward-this' }, rt);
      expect(answer.body.ok).toBe(true);
      expect(calls).toEqual([{ method, path, ...(body ? { body } : {}) }]);
      expect(answer.body.next).toContain('Binding is permanent');
      expect(JSON.stringify(calls)).not.toContain('other-avatar');
      expect(JSON.stringify(calls)).not.toContain('never-forward-this');
    }
  });

  test('BrainChain rejects an absent session and an unsupported money operation', async () => {
    const disconnected = stubRuntime(undefined, null);
    expect((await runMcpTool('clawville_brainchain', { op: 'install' }, disconnected.rt)).body.ok).toBe(false);
    expect(disconnected.calls).toHaveLength(0);
    const connected = stubRuntime();
    expect((await runMcpTool('clawville_brainchain', { op: 'cash_out' }, connected.rt)).body.ok).toBe(false);
    expect(connected.calls).toHaveLength(0);
  });
  test('without a session a game tool answers not_connected', async () => {
    const { rt, calls } = stubRuntime(undefined, null);
    const body = parse(answerText(await runMcpTool('clawville_get_inventory', {}, rt)));
    expect(body.error).toBe('not_connected');
    expect(body.next).toContain('clawville_connect');
    expect(calls).toHaveLength(0);
  });

  test('invalid input is refused before any call', async () => {
    const { rt, calls } = stubRuntime();
    const body = parse(answerText(await runMcpTool('clawville_buy_book', {}, rt)));
    expect(body.error).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  test('unknown keys are dropped and idempotency keys go to the header', async () => {
    const { rt, calls } = stubRuntime();
    await runMcpTool('clawville_pay_agent', {
      recipient: { kind: 'agent', agentId: 'bob' },
      usdCents: 5,
      idempotencyKey: 'k-1',
      evil: 'x',
    }, rt);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/agent-pay',
      body: { recipient: { kind: 'agent', agentId: 'bob' }, usdCents: 5 },
      headers: { 'Idempotency-Key': 'k-1' },
    });
  });

  test('clawville_studios_image forwards the prompt and the Idempotency-Key header to the Studios route', async () => {
    const { rt, calls } = stubRuntime(() => ({
      status: 200,
      ok: true,
      data: { ok: true, mode: 'wallet', mediaId: 'm1', mediaPath: '/api/media/m1' },
    }));
    const body = parse(answerText(await runMcpTool('clawville_studios_image', {
      prompt: 'a red crab on a dock',
      idempotencyKey: 'img-0001',
      model: 'other',
    }, rt)));
    expect(calls).toEqual([{
      method: 'POST',
      path: '/api/vendors/studios/images',
      body: { prompt: 'a red crab on a dock' },
      headers: { 'Idempotency-Key': 'img-0001' },
    }]);
    expect(body).toMatchObject({ ok: true, status: 200, data: { mediaPath: '/api/media/m1' } });
    expect(body.next).toContain('SAME idempotencyKey');
    expect(body.next).toContain('payment_ambiguous');
  });

  test('the phase 3b Studios tools forward only their own fields and the Idempotency-Key to their routes', async () => {
    const { rt, calls } = stubRuntime(() => ({ status: 202, ok: true, data: { status: 'running', requestId: 'r1' } }));
    const video = parse(answerText(await runMcpTool('clawville_studios_video', {
      prompt: 'a boat', durationSeconds: 5, audio: false, idempotencyKey: 'vid-0001', avatarId: 'someone-else',
    }, rt)));
    await runMcpTool('clawville_studios_character', { random: true, shots: ['headshot'], picks: { species: 'animal' }, idempotencyKey: 'chr-0001', mode: 'wallet' }, rt);
    await runMcpTool('clawville_studios_recast', { preset: 'recast-x-wan', imageUrls: ['https://cdn.example.org/a.png'], idempotencyKey: 'rec-0001' }, rt);
    await runMcpTool('clawville_studios_options', { menu: 'recast-presets' }, rt);
    expect(calls).toEqual([
      { method: 'POST', path: '/api/vendors/studios/videos', body: { prompt: 'a boat', durationSeconds: 5, audio: false }, headers: { 'Idempotency-Key': 'vid-0001' } },
      { method: 'POST', path: '/api/vendors/studios/characters', body: { shots: ['headshot'], picks: { species: 'animal' }, random: true }, headers: { 'Idempotency-Key': 'chr-0001' } },
      { method: 'POST', path: '/api/vendors/studios/recasts', body: { preset: 'recast-x-wan', imageUrls: ['https://cdn.example.org/a.png'] }, headers: { 'Idempotency-Key': 'rec-0001' } },
      { method: 'GET', path: '/api/vendors/studios/options/recast-presets' },
    ]);
    expect(video.next).toContain('GET /api/vendors/studios/requests/');
    expect(video.next).toContain('payment_ambiguous');
  });

  test('clawville_studios_account reads the sign-in balance and My Media (both by default), labeled, with only its own query fields', async () => {
    const { rt, calls } = stubRuntime(() => ({ status: 200, ok: true, data: { balanceUsd: 1 } }));
    const both = parse(answerText(await runMcpTool('clawville_studios_account', {}, rt)));
    expect(calls).toEqual([
      { method: 'GET', path: '/api/vendors/studios/signin/account', label: 'balance' },
      { method: 'GET', path: '/api/vendors/studios/signin/media', label: 'media' },
    ]);
    expect(both.next).toContain('studios_signin_missing');
    expect(both.next).not.toContain('description');
    calls.length = 0;
    await runMcpTool('clawville_studios_account', { include: ['media'], kind: 'video', limit: 5, cursor: 'c-1', avatarId: 'someone-else' }, rt);
    await runMcpTool('clawville_studios_account', { include: ['balance'] }, rt);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/vendors/studios/signin/media?kind=video&limit=5&cursor=c-1', label: 'media' },
      { method: 'GET', path: '/api/vendors/studios/signin/account', label: 'balance' },
    ]);
    calls.length = 0;
    expect(parse(answerText(await runMcpTool('clawville_studios_account', { include: ['tokens'] }, rt))).error).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  test('the phase 3b Studios tools refuse a missing key or an unknown menu before any call', async () => {
    const { rt, calls } = stubRuntime();
    expect(parse(answerText(await runMcpTool('clawville_studios_video', { prompt: 'a boat' }, rt))).error).toBe('invalid_input');
    expect(parse(answerText(await runMcpTool('clawville_studios_recast', { preset: 'p', imageUrls: [] }, rt))).error).toBe('invalid_input');
    expect(parse(answerText(await runMcpTool('clawville_studios_options', { menu: 'chat-models' }, rt))).error).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  test('clawville_studios_image without an idempotencyKey is refused before any call', async () => {
    const { rt, calls } = stubRuntime();
    const body = parse(answerText(await runMcpTool('clawville_studios_image', { prompt: 'a crab' }, rt)));
    expect(body.error).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  test('a refused game action is a normal answer with the REST status', async () => {
    const { rt } = stubRuntime(() => ({ status: 403, ok: false, data: { error: 'agent_session_not_ledger_authorized' } }));
    const body = parse(answerText(await runMcpTool('clawville_buy_book', { itemId: 'b' }, rt)));
    expect(body).toMatchObject({ ok: false, status: 403, data: { error: 'agent_session_not_ledger_authorized' } });
  });

  test('visit stops at a refused visit and skips the shop read', async () => {
    const { rt, calls } = stubRuntime(() => ({ status: 400, ok: false, data: { error: 'Too far' } }));
    await runMcpTool('clawville_visit_building', { buildingId: 'cron-automation' }, rt);
    expect(calls).toHaveLength(1);
  });

  test('path segments are URL-encoded', async () => {
    const { rt, calls } = stubRuntime();
    await runMcpTool('clawville_arena_agent', { agentId: 'house:genesis/../x' }, rt);
    expect(calls[0]!.path).toBe('/api/floor/arena/agents/house%3Agenesis%2F..%2Fx');
  });

  test('clawville_move waits for arrival', async () => {
    let poll = 0;
    const { rt } = stubRuntime((call) => {
      if (call.path.endsWith('/move')) return { status: 200, ok: true, data: { success: true, pathLength: 4, destination: { x: 100, y: 100 } } };
      poll += 1;
      const x = poll >= 3 ? 90 : 10 * poll;
      return {
        status: 200,
        ok: true,
        data: { self: { x, y: 100 }, nearbyBuildings: [{ buildingId: 'cron-automation', distance: 50, edgeDistance: 5 }] },
      };
    });
    const body = parse(answerText(await runMcpTool('clawville_move', { targetX: 100, targetY: 100 }, rt)));
    expect(body.ok).toBe(true);
    expect(body.data.arrived).toBe(true);
    expect(body.data.nearestBuilding.buildingId).toBe('cron-automation');
    expect(body.next).toContain('clawville_visit_building');
  });

  test('clawville_move reports a stopped walk as not arrived', async () => {
    const { rt } = stubRuntime((call) =>
      call.path.endsWith('/move')
        ? { status: 200, ok: true, data: { destination: { x: 500, y: 500 } } }
        : { status: 200, ok: true, data: { self: { x: 10, y: 10 }, nearbyBuildings: [] } },
    );
    const body = parse(answerText(await runMcpTool('clawville_move', { targetX: 500, targetY: 500 }, rt)));
    expect(body.data.arrived).toBe(false);
    expect(body.data.stopped).toBe(true);
  });

  test('clawville_move stops polling once the MCP caller is gone', async () => {
    let gone = false;
    const { rt, calls } = stubRuntime((call) => {
      if (call.path.endsWith('/move')) return { status: 200, ok: true, data: { destination: { x: 500, y: 500 } } };
      gone = true; // the caller hangs up during the first perception poll
      return { status: 200, ok: true, data: { self: { x: 10, y: 10 }, nearbyBuildings: [] } };
    });
    rt.isAborted = () => gone;
    await runMcpTool('clawville_move', { targetX: 500, targetY: 500 }, rt);
    expect(calls.filter((c) => c.path.endsWith('/perception')).length).toBeLessThanOrEqual(1);
  });
});

describe('connect summary', () => {
  test('secrets appear only when the REST response included them', () => {
    const without = summarizeConnect({ agentId: 'a', sessionId: 's', identity: { userId: 'u', publicKey: 'p', isFirstTime: false }, wallet: { address: 'w', chain: 'solana' } });
    expect(JSON.stringify(without)).not.toContain('secretKey');
    const withSecrets = summarizeConnect({ agentId: 'a', sessionId: 's', identity: { userId: 'u', publicKey: 'p', secretKey: 'ID-SECRET' }, wallet: { address: 'w', chain: 'solana', secretKey: 'W-SECRET' } });
    expect((withSecrets.identity as any).secretKey).toBe('ID-SECRET');
    expect((withSecrets.wallet as any).secretKey).toBe('W-SECRET');
  });
});

describe('answer size cap', () => {
  test('a huge answer is cut with a note', () => {
    const text = answerText({ body: { ok: true, status: 200, data: 'x'.repeat(100_000), next: 'n' } });
    expect(text.length).toBeLessThan(33 * 1024);
    const body = parse(text);
    expect(body.data.truncated).toBe(true);
    expect(body.next).toBe('n');
  });
});

test('MCP refuses payment bearer capture and owner approval routes',()=>{
 for(const operation of ['capture','approve','approval-challenge'])expect(validateCallPath(`/api/brainchain/purchases/00000000-0000-4000-8000-000000000001/${operation}`,'POST')).not.toBeNull();
});


describe('arena terminal read tools', () => {
  const reads = [
    ['trades', '/agents/house%3Agenesis/trades'], ['equity', '/agents/house%3Agenesis/equity'],
    ['my_trades', '/me/trades'], ['my_equity', '/me/equity'],
    ['events', '/agents/house%3Agenesis/events'], ['my_events', '/me/events'],
    ['contest', '/contest'], ['discovery', '/discovery'], ['tape', '/tape'],
  ] as const;
  for (const [suffix, path] of reads) {
    test(`${suffix} uses its read route without app metadata`, async () => {
      const name = `clawville_arena_${suffix}`;
      const def = MCP_TOOLS.find((tool) => tool.name === name)!;
      expect(def).toBeDefined();
      expect(def.readOnly).toBe(true);
      expect(def.ui).toBeUndefined();
      const { rt, calls } = stubRuntime();
      const result = await runMcpTool(name, { agentId: 'house:genesis' }, rt);
      expect(result.body.ok).toBe(true);
      expect(calls).toEqual([{ method: 'GET', path: `/api/floor/arena${path}` }]);
    });
  }
  test('trade query forwards each cursor and filter without session credentials', () => {
    const call = GAME_TOOL_ROUTES.clawville_arena_trades!.calls(
      { sid: 'ag-live', agentId: 'agent-1' },
      { agentId: 'house:genesis', before: '2026-11-11T10:00:00.000Z', beforeId: 'abc', limit: 7, outcome: 'loss', reason: 'stop', sessionId: 'secret' },
    )[0]!;
    const url = new URL(call.path, 'https://example.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({ before: '2026-11-11T10:00:00.000Z', beforeId: 'abc', limit: '7', outcome: 'loss', reason: 'stop' });
    // Protocol 135: the trades window forwards on both trade tools; absent, the route default (period) applies.
    const context = { sid: 'ag-live', agentId: 'agent-1' };
    expect(GAME_TOOL_ROUTES.clawville_arena_my_trades!.calls(context, { window: 'all', reason: 'reset' })[0]!.path).toBe('/api/floor/arena/me/trades?reason=reset&window=all');
    expect(GAME_TOOL_ROUTES.clawville_arena_trades!.calls(context, { agentId: 'house:genesis', window: 'period' })[0]!.path).toBe('/api/floor/arena/agents/house%3Agenesis/trades?window=period');
    expect(GAME_TOOL_ROUTES.clawville_arena_my_trades!.calls(context, {})[0]!.path).toBe('/api/floor/arena/me/trades');
  });
  test('equity window and event cursor remain query parameters', () => {
    const context = { sid: 'ag-live', agentId: 'agent-1' };
    // Protocol 135: the leaderboard defaults to the P&L period window; an explicit window still forwards.
    expect(GAME_TOOL_ROUTES.clawville_arena_leaderboard!.calls(context, {})[0]!.path).toBe('/api/floor/arena/leaderboard?window=period');
    expect(GAME_TOOL_ROUTES.clawville_arena_leaderboard!.calls(context, { window: 'contest' })[0]!.path).toBe('/api/floor/arena/leaderboard?window=contest');
    expect(GAME_TOOL_ROUTES.clawville_arena_my_equity!.calls(context, { window: 'period' })[0]!.path).toBe('/api/floor/arena/me/equity?window=period');
    expect(GAME_TOOL_ROUTES.clawville_arena_my_equity!.calls(context, { window: '7d' })[0]!.path).toBe('/api/floor/arena/me/equity?window=7d');
    expect(GAME_TOOL_ROUTES.clawville_arena_my_events!.calls(context, { after: 'event&next', limit: 10 })[0]!.path).toBe('/api/floor/arena/me/events?after=event%26next&limit=10');
  });
});
