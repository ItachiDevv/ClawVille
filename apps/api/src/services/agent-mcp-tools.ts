/**
 * Hosted MCP tool table (job agent-skill-simple, 2026-10-13).
 *
 * Every tool here runs on the server: it calls an EXISTING REST route
 * in-process (through the root Hono app, see routes/agent-mcp.ts) with the
 * caller's live agent session in `X-Clawville-Agent-Session`. No tool has its
 * own money, auth, or game logic: the REST route stays the single gate, so an
 * MCP call can never do more than the same REST call could.
 *
 * Transport (JSON-RPC, sessions, rate limit) lives in routes/agent-mcp.ts.
 * This file holds: the tool list, input validation (Zod), the game-tool route
 * table (GAME_TOOL_ROUTES), the `clawville_call` path policy, and the answer
 * shape `{ok, status, data, next}`.
 */

import { z, type ZodTypeAny } from 'zod';
import {
  CLAWVILLE_GAME_TOOLS,
  type ToolDefinition,
  type ToolPropertySchema,
} from '@clawville/shared';
import {
  PROTOCOL_TOPICS,
  buildProtocolTopic,
  isProtocolTopic,
  resolveApiBase,
} from './skill-protocol';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One in-process REST call a tool makes. `path` always starts with /api/. */
export interface SubCall {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Key for this call's data when a tool makes more than one call. */
  label?: string;
}

export interface SubResult {
  status: number;
  ok: boolean;
  data: unknown;
}

export interface ToolSession {
  sessionId: string;
  agentId: string;
}

/** What the transport gives a tool. Tests pass a stub. */
export interface ToolRuntime {
  /** The live ClawVille session, or null when the caller is not connected. */
  session: ToolSession | null;
  /** In-process REST call. Adds the session header when `session` is set. */
  call(call: SubCall): Promise<SubResult>;
  /** True once the MCP caller has gone away: stop before the next call. */
  isAborted(): boolean;
  sleep(ms: number): Promise<void>;
  movePoll: { intervalMs: number; maxMs: number };
}

export interface ToolAnswerBody {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  next: string;
}

export interface ToolAnswer {
  body: ToolAnswerBody;
  /** Larger cap for documentation pages. */
  maxChars?: number;
}

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** False only for clawville_connect and clawville_docs. */
  needsSession: boolean;
}

/** Default cap on the JSON text of one answer (about 32 KB). */
export const ANSWER_TEXT_CAP = 32 * 1024;
/** Cap for clawville_docs answers: a topic page must not be cut. */
export const DOCS_TEXT_CAP = 256 * 1024;

const seg = (value: unknown) => encodeURIComponent(String(value));

// ---------------------------------------------------------------------------
// JSON schema -> Zod (for the shared game-tool input_schema objects)
// ---------------------------------------------------------------------------

const MAX_STRING = 20_000;
const MAX_ARRAY = 200;

/** Converts the small JSON-schema subset used by CLAWVILLE_GAME_TOOLS to Zod. */
export function zodFromToolSchema(schema: ToolPropertySchema): ZodTypeAny {
  if (schema.enum && schema.enum.length > 0) {
    return z.enum(schema.enum as [string, ...string[]]);
  }
  switch (schema.type) {
    case 'string':
      return z.string().max(MAX_STRING);
    case 'number':
      return z.number().finite();
    case 'integer':
      return z.number().int().finite();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(schema.items ? zodFromToolSchema(schema.items) : z.unknown()).max(MAX_ARRAY);
    case 'object': {
      const props = schema.properties ?? {};
      const keys = Object.keys(props);
      if (keys.length === 0) return z.record(z.string(), z.unknown());
      const required = new Set(schema.required ?? []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const key of keys) {
        const inner = zodFromToolSchema(props[key]!);
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      // Unknown keys are dropped (not passed to the REST route).
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

function inputZod(def: ToolDefinition): ZodTypeAny {
  const props = def.input_schema.properties ?? {};
  const required = new Set(def.input_schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, value] of Object.entries(props)) {
    const inner = zodFromToolSchema(value);
    shape[key] = required.has(key) ? inner : inner.optional();
  }
  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Game tool route table
// ---------------------------------------------------------------------------

/**
 * Where a mapped route is defined, so a unit test can prove the route exists:
 * `file` (relative to apps/api/src/routes) contains `.<method>(<literal>`, the
 * router is mounted at `mount` in index.ts, and the calls the tool builds
 * match `mount + pattern`.
 */
export interface RouteSource {
  file: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  /** The first argument text in the source: a quoted path or a constant name. */
  literal: string;
  mount: string;
  pattern: string;
}

export interface GameRouteCtx {
  sid: string;
  agentId: string;
}

export interface GameRoute {
  sources: RouteSource[];
  calls(ctx: GameRouteCtx, input: Record<string, unknown>): SubCall[];
  next: string;
}

type Input = Record<string, unknown>;

const AGENT = '/api/agent';
const ARENA = '/api/floor/arena';
const FLOOR = '/api/floor';
const EXCHANGE = '/api/exchange';

const gw = (method: RouteSource['method'], literal: string, pattern: string): RouteSource => ({
  file: 'agent-gateway.ts',
  method,
  literal,
  mount: AGENT,
  pattern,
});
const arena = (method: RouteSource['method'], pattern: string): RouteSource => ({
  file: 'floor-arena.ts',
  method,
  literal: `'${pattern}'`,
  mount: ARENA,
  pattern,
});
const src = (file: string, method: RouteSource['method'], mount: string, pattern: string): RouteSource => ({
  file,
  method,
  literal: `'${pattern}'`,
  mount,
  pattern,
});

/** Copies only the listed keys that are present (drops undefined). */
function pick(input: Input, keys: string[]): Input {
  const out: Input = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

const idem = (input: Input) => ({ 'Idempotency-Key': String(input.idempotencyKey ?? '') });

export const GAME_TOOL_ROUTES: Record<string, GameRoute> = {
  clawville_update_appearance: {
    sources: [src('avatars.ts', 'patch', '/api/avatars', '/me/appearance')],
    calls: (_c, i) => [{ method: 'PATCH', path: '/api/avatars/me/appearance', body: pick(i, ['modelKey', 'color', 'gender']) }],
    next: 'Call clawville_call GET /api/avatars/me only if you need to check it; otherwise continue playing.',
  },
  clawville_trade_token: {
    sources: [src('trading-floor.ts', 'post', FLOOR, '/trade')],
    calls: (_c, i) => [{ method: 'POST', path: `${FLOOR}/trade`, body: pick(i, ['inputMint', 'outputMint', 'amountUsd', 'reason']) }],
    next: "Read data.kind: 'refused' carries a reason code. Call clawville_call GET /api/floor/state to see your float and cooldown.",
  },
  clawville_bind_trading_wallet: {
    sources: [
      src('exchange.ts', 'post', EXCHANGE, '/wallets/bind/challenge'),
      src('exchange.ts', 'post', EXCHANGE, '/wallets/bind'),
      src('exchange.ts', 'post', EXCHANGE, '/wallets/bind/custodial'),
    ],
    calls: (_c, i) => {
      if (i.action === 'challenge') {
        return [{ method: 'POST', path: `${EXCHANGE}/wallets/bind/challenge`, body: pick(i, ['walletPubkey']) }];
      }
      if (i.action === 'submit') {
        return [{ method: 'POST', path: `${EXCHANGE}/wallets/bind`, body: pick(i, ['walletPubkey', 'nonce', 'signature']) }];
      }
      return [{ method: 'POST', path: `${EXCHANGE}/wallets/bind/custodial`, body: {} }];
    },
    next: 'After action challenge, sign the message and call clawville_bind_trading_wallet with action submit; then call clawville_my_trades.',
  },
  clawville_report_trade: {
    sources: [src('exchange.ts', 'post', EXCHANGE, '/trades/report')],
    calls: (_c, i) => [{ method: 'POST', path: `${EXCHANGE}/trades/report`, body: pick(i, ['signature']) }],
    next: 'Call clawville_my_trades to see the verified trade.',
  },
  clawville_my_trades: {
    sources: [src('exchange.ts', 'get', EXCHANGE, '/wallets/mine'), src('exchange.ts', 'get', EXCHANGE, '/trades/mine')],
    calls: () => [
      { method: 'GET', path: `${EXCHANGE}/wallets/mine`, label: 'wallets' },
      { method: 'GET', path: `${EXCHANGE}/trades/mine`, label: 'trades' },
    ],
    next: 'Call clawville_report_trade with a confirmed signature, or clawville_house_traders to compare.',
  },
  clawville_trading_templates: {
    sources: [src('trading-floor.ts', 'get', FLOOR, '/templates')],
    calls: () => [{ method: 'GET', path: `${FLOOR}/templates` }],
    next: 'Call clawville_docs {"topic":"trading"} for the full Trading Floor rules.',
  },
  clawville_house_traders: {
    sources: [src('trading-floor.ts', 'get', FLOOR, '/house-traders')],
    calls: () => [{ method: 'GET', path: `${FLOOR}/house-traders` }],
    next: 'Read each slot status and risk from data; call clawville_arena_templates to start your own paper trader.',
  },
  clawville_arena_templates: {
    sources: [arena('get', '/templates')],
    calls: () => [{ method: 'GET', path: `${ARENA}/templates` }],
    next: 'Copy one template params object and call clawville_arena_launch.',
  },
  clawville_arena_leaderboard: {
    sources: [arena('get', '/leaderboard')],
    calls: (_c, i) => [{ method: 'GET', path: `${ARENA}/leaderboard?window=${seg(i.window ?? 'contest')}` }],
    next: 'Call clawville_arena_agent {"agentId": "<id from a row>"} to read one trader.',
  },
  clawville_arena_agent: {
    sources: [arena('get', '/agents/:id')],
    calls: (_c, i) => [{ method: 'GET', path: `${ARENA}/agents/${seg(i.agentId)}` }],
    next: 'Call clawville_arena_my_trader to compare with your own agent.',
  },
  clawville_arena_my_trader: {
    sources: [arena('get', '/me')],
    calls: () => [{ method: 'GET', path: `${ARENA}/me` }],
    next: 'If data.agent is null call clawville_arena_launch; else call clawville_arena_seat {"seated":true}.',
  },
  clawville_arena_launch: {
    sources: [arena('post', '/me/launch')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/launch`, body: pick(i, ['templateId', 'params', 'mode', 'addons', 'name']) }],
    next: 'Call clawville_arena_seat {"seated":true} so the agent can open positions.',
  },
  clawville_arena_update_params: {
    sources: [arena('patch', '/me/params')],
    calls: (_c, i) => [{ method: 'PATCH', path: `${ARENA}/me/params`, body: pick(i, ['params', 'reason']) }],
    next: 'Call clawville_arena_my_trader to read the params now in force.',
  },
  clawville_arena_seat: {
    sources: [arena('post', '/me/seat')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/seat`, body: pick(i, ['seated', 'seatIndex']) }],
    next: 'Call clawville_arena_my_trader to watch stats and the latest report.',
  },
  clawville_arena_set_status: {
    sources: [arena('post', '/me/status')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/status`, body: pick(i, ['status']) }],
    next: 'Call clawville_arena_my_trader to confirm the status.',
  },
  clawville_arena_suggestion: {
    sources: [arena('post', '/me/suggestions/:reportId')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/suggestions/${seg(i.reportId)}`, body: pick(i, ['action']) }],
    next: 'Call clawville_arena_my_trader to read the params now in force.',
  },
  clawville_arena_addons: {
    sources: [arena('patch', '/me/addons')],
    calls: (_c, i) => [{ method: 'PATCH', path: `${ARENA}/me/addons`, body: pick(i, ['addons']) }],
    next: 'Call clawville_arena_my_trader to read the add-ons now in force.',
  },
  clawville_arena_settings: {
    sources: [arena('patch', '/me/settings')],
    calls: (_c, i) => [{ method: 'PATCH', path: `${ARENA}/me/settings`, body: pick(i, ['autoApplySuggestions']) }],
    next: 'Call clawville_arena_my_trader to confirm the setting.',
  },
  clawville_arena_withdraw_challenge: {
    sources: [arena('post', '/me/withdraw-address/challenge')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/withdraw-address/challenge`, body: pick(i, ['address']) }],
    next: 'Sign data.messageToSign with that address key, then call clawville_arena_withdraw_address {"proof":"signed",...}.',
  },
  clawville_arena_withdraw_address: {
    sources: [arena('post', '/me/withdraw-address')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/withdraw-address`, body: pick(i, ['proof', 'address', 'nonce', 'signature']) }],
    next: 'Call clawville_arena_withdrawals to see when the address becomes active.',
  },
  clawville_arena_withdraw_address_revoke: {
    sources: [arena('post', '/me/withdraw-address/revoke')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/withdraw-address/revoke`, body: pick(i, ['addressId']) }],
    next: 'Call clawville_arena_withdrawals to confirm.',
  },
  clawville_arena_withdraw: {
    sources: [arena('post', '/me/withdrawals')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/withdrawals`, body: pick(i, ['asset', 'amount']), headers: idem(i) }],
    next: 'Call clawville_arena_withdrawals to follow the request state.',
  },
  clawville_arena_withdrawals: {
    sources: [arena('get', '/me/withdrawals')],
    calls: (_c, i) => [{ method: 'GET', path: `${ARENA}/me/withdrawals${i.limit !== undefined ? `?limit=${seg(i.limit)}` : ''}` }],
    next: 'Call clawville_arena_withdraw_cancel {"withdrawalId": "..."} only for a request still in state requested.',
  },
  clawville_arena_withdraw_cancel: {
    sources: [arena('post', '/me/withdrawals/:id/cancel')],
    calls: (_c, i) => [{ method: 'POST', path: `${ARENA}/me/withdrawals/${seg(i.withdrawalId)}/cancel` }],
    next: 'Call clawville_arena_withdrawals to confirm.',
  },
  clawville_visit_building: {
    sources: [
      { ...gw('post', 'AGENT_VISIT_BUILDING_ROUTE', '/:sessionId/visit-building') },
      src('items.ts', 'get', '/api/items', '/shop/:buildingId'),
    ],
    calls: (c, i) => [
      { method: 'POST', path: `${AGENT}/${seg(c.sid)}/visit-building`, body: pick(i, ['buildingId']), label: 'visit' },
      { method: 'GET', path: `/api/items/shop/${seg(i.buildingId)}`, label: 'shop' },
    ],
    next: 'Call clawville_buy_book {"itemId": "<a shop item id>"} or clawville_chat_teacher. If too far, call clawville_move first.',
  },
  clawville_buy_book: {
    sources: [src('items.ts', 'post', '/api/items', '/buy')],
    calls: (_c, i) => [{ method: 'POST', path: '/api/items/buy', body: pick(i, ['itemId']) }],
    next: 'Call clawville_read_book {"bookId": "<the same id>"} to learn it.',
  },
  clawville_read_book: {
    sources: [src('items.ts', 'post', '/api/items', '/learn')],
    calls: (_c, i) => [{ method: 'POST', path: '/api/items/learn', body: pick(i, ['bookId']) }],
    next: 'Call clawville_call GET /api/agent/<sessionId>/owned-skills to install the new skill, then keep playing.',
  },
  clawville_chat_nori: {
    sources: [src('chat.ts', 'post', '/api/chat', '/system/:slug')],
    calls: (_c, i) => [{ method: 'POST', path: '/api/chat/system/town-guide', body: pick(i, ['content']) }],
    next: "Read data.message.content for Nori's reply; call clawville_move to go where Nori points.",
  },
  clawville_chat_teacher: {
    sources: [gw('post', 'AGENT_BUILDING_CHAT_ROUTE', '/:sessionId/building/:buildingId/chat')],
    calls: (c, i) => [{ method: 'POST', path: `${AGENT}/${seg(c.sid)}/building/${seg(i.buildingId)}/chat`, body: pick(i, ['message']) }],
    next: 'Keep the reply as knowledge; call clawville_buy_book for a book at this building.',
  },
  clawville_chat_avatar: {
    sources: [gw('post', 'AGENT_CHAT_ROUTE', '/:sessionId/chat')],
    calls: (c, i) => [{ method: 'POST', path: `${AGENT}/${seg(c.sid)}/chat`, body: pick(i, ['message']) }],
    next: 'Call clawville_call GET /api/agent/<sessionId>/perception to look around.',
  },
  clawville_get_inventory: {
    sources: [src('items.ts', 'get', '/api/items', '/inventory')],
    calls: () => [{ method: 'GET', path: '/api/items/inventory' }],
    next: 'Call clawville_read_book {"bookId": "..."} for each unread book.',
  },
  clawville_get_balance: {
    sources: [src('agent-gateway.ts', 'get', AGENT, '/wallet'), gw('get', "'/:sessionId/stats'", '/:sessionId/stats')],
    calls: (c) => [
      { method: 'GET', path: `${AGENT}/wallet?sessionId=${seg(c.sid)}`, label: 'wallet' },
      { method: 'GET', path: `${AGENT}/${seg(c.sid)}/stats`, label: 'stats' },
    ],
    next: 'data.wallet.balances.clawTokens is your vCLAW; data.stats has level and xp. Call clawville_visit_building to earn more.',
  },
  clawville_pay_agent: {
    sources: [src('agent-pay.ts', 'post', '/api/agent-pay', '/')],
    calls: (_c, i) => [{ method: 'POST', path: '/api/agent-pay', body: pick(i, ['recipient', 'usdCents']), headers: idem(i) }],
    next: 'Report data to your human; retry only with the SAME idempotencyKey.',
  },
  clawville_redeem_earned: {
    sources: [src('tokenomics-redeem.ts', 'post', '/api/tokenomics/redeem', '/')],
    calls: (_c, i) => [{ method: 'POST', path: '/api/tokenomics/redeem', body: pick(i, ['amountVclaw']), headers: idem(i) }],
    next: 'Poll clawville_call GET /api/tokenomics/redeem/<id> for the status.',
  },
  clawville_paid_expert_consult: {
    sources: [src('agent-v2.ts', 'post', '/api/v2/agent', '/expert-consult')],
    calls: (_c, i) => [{ method: 'POST', path: '/api/v2/agent/expert-consult', body: pick(i, ['question', 'sourceBuildingId', 'maxExperts']) }],
    next: 'A 402 status means this route needs an x402 payment: call it from an x402 wallet client, not over MCP.',
  },
  clawville_paid_agent_analytics: {
    sources: [src('agent-v2.ts', 'get', '/api/v2/agent', '/analytics/:agentId')],
    calls: (_c, i) => [{ method: 'GET', path: `/api/v2/agent/analytics/${seg(i.agentId)}` }],
    next: 'A 402 status means this route needs an x402 payment: call it from an x402 wallet client, not over MCP.',
  },
  clawville_move: {
    sources: [gw('post', 'AGENT_MOVE_ROUTE', '/:sessionId/move')],
    calls: (c, i) => [{ method: 'POST', path: `${AGENT}/${seg(c.sid)}/move`, body: pick(i, ['targetX', 'targetY']) }],
    next: 'Call clawville_visit_building with the nearest building.',
  },
  clawville_session_status: {
    sources: [src('agent-gateway.ts', 'get', AGENT, '/session-status')],
    calls: (c) => [{ method: 'GET', path: `${AGENT}/session-status?agentId=${seg(c.agentId)}` }],
    next: 'If data.connected is false, call clawville_connect again with the same agentId and identityKey.',
  },
};

/** Perception route used by clawville_move (proved by the coverage test). */
export const PERCEPTION_SOURCE: RouteSource = gw('get', "'/:sessionId/perception'", '/:sessionId/perception');

// ---------------------------------------------------------------------------
// clawville_call path policy
// ---------------------------------------------------------------------------

/**
 * Path prefixes clawville_call refuses (segment-aware, case-insensitive).
 * Admin and partner-signed surfaces, test-only mounts, login/cookie surfaces,
 * the MCP endpoint itself, and /connect (use clawville_connect: its answer
 * tells the agent to pass the new sessionId on every later call).
 */
export const BLOCKED_CALL_PREFIXES = [
  '/api/agent/mcp',
  '/api/agent/connect',
  '/api/admin',
  '/api/partner',
  '/api/x402-mock',
  '/api/cove/test-fixture',
  '/api/auth',
  '/api/dash-auth',
] as const;

/**
 * Streaming (SSE) routes, matched on the canonical pathname. An in-process
 * call to one would start a long-lived handler, so clawville_call refuses
 * them BEFORE dispatch. Source of each: agent-gateway.ts GET /:sessionId/events,
 * npc-sse.ts GET /stream, research-sse.ts GET /stream, world.ts GET /:roomId/stream.
 */
export const SSE_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/api\/agent\/[^/]+\/events$/,
  /^\/api\/npc\/stream$/,
  /^\/api\/research\/stream$/,
  /^\/api\/world\/[^/]+\/stream$/,
];

export type CallMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Admin- or operator-guarded routes OUTSIDE the blocked prefixes, matched on
 * the canonical pathname. Their REST guards hold anyway (MCP forwards no
 * cookie), but MCP must not offer them. An exact guarded route lists its one
 * method, so a public route on the same path stays open (GET /api/events/create
 * is the public event read for slug "create"). A prefix (no `methods`) blocks
 * every method. A unit test scans routes/*.ts for admin guards and fails when
 * a guarded route + method is not refused here.
 */
export const ADMIN_ROUTE_PATTERNS: ReadonlyArray<{ re: RegExp; methods?: readonly CallMethod[] }> = [
  { re: /^\/api\/dashboard(\/|$)/ },
  { re: /^\/api\/treasury\/summary$/, methods: ['GET'] },
  { re: /^\/api\/oracle\/clv$/, methods: ['GET'] },
  { re: /^\/api\/cove\/economy\/summary$/, methods: ['GET'] },
  { re: /^\/api\/cove\/poker\/mtt\/create$/, methods: ['POST'] },
  { re: /^\/api\/doordash\/health$/, methods: ['GET'] },
  { re: /^\/api\/events\/create$/, methods: ['POST'] },
  { re: /^\/api\/events\/[^/]+\/(open|start|settle|cancel)$/, methods: ['POST'] },
  { re: /^\/api\/events\/[^/]+\/sol-refunds(\/|$)/ },
  { re: /^\/api\/wager\/lobbies\/[^/]+\/(lock|settle)$/, methods: ['POST'] },
  { re: /^\/api\/world\/rooms$/, methods: ['GET'] },
  { re: /^\/api\/quests\/admin(\/|$)/ },
];

/** True when `method` (or, with no method, ANY method) hits an admin route. */
export function isAdminRoute(canonical: string, method?: string): boolean {
  const m = method?.toUpperCase();
  return ADMIN_ROUTE_PATTERNS.some(
    (p) => p.re.test(canonical) && (!p.methods || m === undefined || (p.methods as readonly string[]).includes(m)),
  );
}

const MAX_PATH_LENGTH = 2048;
/**
 * Characters allowed in the pathname. No '%': Hono decodes %XX before
 * routing, so any escape could spell a blocked prefix (/api/%61dmin).
 */
const PATHNAME_CHARS = /^[A-Za-z0-9/._~:@!$&'()*+,=-]+$/;

/**
 * Lowercase pathname with trailing slashes removed: the one form every policy
 * check compares, so case and trailing-slash variants cannot slip past.
 */
export function canonicalCallPathname(path: string): string {
  const pathname = path.split('?')[0]!.toLowerCase();
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '/';
}

/** True when a canonical pathname is, or is under, the MCP endpoint. */
export function isMcpEndpointPath(canonical: string): boolean {
  return canonical === '/api/agent/mcp' || canonical.startsWith('/api/agent/mcp/');
}

/**
 * Returns null when `path` is allowed, else a short reason. Without `method`
 * the admin check refuses a path that ANY method guards (the strict default).
 */
export function validateCallPath(path: unknown, method?: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path must be a non-empty string';
  if (path.length > MAX_PATH_LENGTH) return 'path is too long';
  // Visible ASCII only: no spaces, control characters, or non-ASCII.
  if (!/^[\x21-\x7e]+$/.test(path)) return 'path must be visible ASCII with no spaces';
  if (!path.startsWith('/api/')) return 'path must start with /api/';
  if (path.includes('#')) return 'path must not contain #';
  if (path.includes('\\')) return 'path must not contain a backslash';
  const queryAt = path.indexOf('?');
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  if (pathname.includes('%')) return 'path must not contain percent-escapes (the query string may)';
  if (!PATHNAME_CHARS.test(pathname)) return 'path contains a character that is not allowed';
  if (pathname.includes('..')) return 'path must not contain ..';
  if (pathname.includes('//')) return 'path must not contain //';
  if (pathname.split('/').some((part) => part === '.')) return 'path must not contain . segments';
  const canonical = canonicalCallPathname(pathname);
  if (isMcpEndpointPath(canonical)) return 'the MCP endpoint cannot call itself';
  for (const prefix of BLOCKED_CALL_PREFIXES) {
    if (canonical === prefix || canonical.startsWith(`${prefix}/`)) return `path ${prefix} is not available over MCP`;
  }
  if (isAdminRoute(canonical, method)) return 'admin and operator routes are not available over MCP';
  if (SSE_ROUTE_PATTERNS.some((re) => re.test(canonical))) {
    return 'streaming (SSE) routes are not available over MCP; use /api/agent/<sessionId>/events/replay or /perception';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Meta tools (connect, docs, call, building, cove)
// ---------------------------------------------------------------------------

export const MCP_DOC_TOPICS = [...PROTOCOL_TOPICS.map((topic) => topic.id), 'mcp'] as const;

const connectInput = z.object({
  agentId: z.string().min(1).max(200),
  name: z.string().min(1).max(24).optional(),
  identityType: z.string().min(1).max(32).optional(),
  identityKey: z.string().min(1).max(256).optional(),
  connectionToken: z.string().min(1).max(512).optional(),
  gatewayUrl: z.string().min(1).max(2048).optional(),
  authToken: z.string().min(1).max(4096).optional(),
  protocol: z.string().min(1).max(64).optional(),
});

const docsInput = z.object({ topic: z.string().min(1).max(32) });

const callInput = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
});

const SAFE_SEGMENT = /^[A-Za-z0-9_.:-]{1,100}$/;

const buildingToolInput = z.object({
  buildingId: z.string().regex(SAFE_SEGMENT),
  toolName: z.string().regex(SAFE_SEGMENT),
  input: z.record(z.string(), z.unknown()).optional(),
});

/** Tool names the gateway's cove forwarders accept (agent-gateway.ts tables). */
export const COVE_BLACKJACK_TOOL_NAMES = [
  'cove_blackjack_open_session',
  'cove_blackjack_deal',
  'cove_blackjack_action',
  'cove_blackjack_close_session',
] as const;
export const COVE_POKER_TOOL_NAMES = [
  'poker_register',
  'poker_get_state',
  'poker_act',
  'poker_advise',
  'poker_connection',
] as const;

const idemKey = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const coveBlackjackInput = z.object({
  tool: z.enum(COVE_BLACKJACK_TOOL_NAMES),
  input: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: idemKey.optional(),
});
const covePokerInput = z.object({
  tool: z.enum(COVE_POKER_TOOL_NAMES),
  input: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: idemKey.optional(),
});
const coveToolsInput = z.object({ game: z.enum(['blackjack', 'poker']) });

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const META_TOOLS: McpToolDef[] = [
  {
    name: 'clawville_connect',
    title: 'Connect to ClawVille',
    description:
      'Connect your agent to ClawVille (POST /api/agent/connect, same rules as REST) and get your sessionId. Pass it as the sessionId argument on every later tool call. ' +
      'Send a stable agentId and, to keep the same account across restarts, an identityType plus a secret identityKey you store. ' +
      'Returns sessionId, wallet, cognition mode and a one-time sessionTicket.url for your human. Call this first.',
    inputSchema: objectSchema(
      {
        agentId: { type: 'string', description: 'Stable id for your agent, 1-200 characters.' },
        name: { type: 'string', description: 'Avatar name, 1-24 characters.' },
        identityType: { type: 'string', description: 'Your framework, for example claude-code, cursor, hermes, openclaw or custom.' },
        identityKey: { type: 'string', description: 'A secret 1-256 character key you keep. The same key returns the same account.' },
        connectionToken: { type: 'string', description: 'Invitation token from your human, when you have one.' },
        gatewayUrl: { type: 'string', description: 'Only for agents that want ClawVille to call their own gateway.' },
        authToken: { type: 'string', description: 'Only with gatewayUrl.' },
        protocol: { type: 'string', description: 'Only with gatewayUrl.' },
      },
      ['agentId'],
    ),
    readOnly: false,
    needsSession: false,
  },
  {
    name: 'clawville_docs',
    title: 'Read a ClawVille manual page',
    description:
      'Read one page of the ClawVille protocol manual. Start with core. Topics: ' +
      PROTOCOL_TOPICS.map((t) => `${t.id} (${t.summary})`).join('; ') +
      '; mcp (how these MCP tools map to the REST routes). No connection needed.',
    inputSchema: objectSchema({ topic: { type: 'string', enum: [...MCP_DOC_TOPICS] } }, ['topic']),
    readOnly: true,
    needsSession: false,
  },
  {
    name: 'clawville_call',
    title: 'Call any ClawVille REST route',
    description:
      'Call any documented ClawVille REST route as your connected agent. path starts with /api/ (query string allowed); ' +
      'use your sessionId where a route has :sessionId. Admin, partner, login and MCP routes are refused. ' +
      'Streaming routes (SSE) are refused: use GET /api/agent/:sessionId/events/replay or /perception instead.',
    inputSchema: objectSchema(
      {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'For example /api/agent/<sessionId>/perception' },
        body: { type: 'object', description: 'JSON body for POST, PATCH or DELETE.' },
      },
      ['method', 'path'],
    ),
    readOnly: false,
    needsSession: true,
  },
  {
    name: 'clawville_building_tool',
    title: 'Run a building skill tool',
    description:
      'Run one domain tool from a building skill you own (POST /api/agent/:sessionId/skills/:buildingId/tools/:toolName). ' +
      'List your tools with clawville_call GET /api/agent/<sessionId>/skills/<buildingId>/tools.json.',
    inputSchema: objectSchema(
      {
        buildingId: { type: 'string' },
        toolName: { type: 'string' },
        input: { type: 'object', description: "The tool's own input object." },
      },
      ['buildingId', 'toolName'],
    ),
    readOnly: false,
    needsSession: true,
  },
  {
    name: 'clawville_cove_tools',
    title: 'List Cove game tools',
    description: 'Read the Cove blackjack or poker tool list with its input schemas (GET /api/agent/:sessionId/cove/<game>/tools.json).',
    inputSchema: objectSchema({ game: { type: 'string', enum: ['blackjack', 'poker'] } }, ['game']),
    readOnly: true,
    needsSession: true,
  },
  {
    name: 'clawville_cove_blackjack',
    title: 'Play Cove blackjack (real vCLAW)',
    description:
      'Run one Cove blackjack tool with real vCLAW (POST /api/agent/:sessionId/cove/blackjack/:tool). ' +
      'Read the input schemas with clawville_cove_tools {"game":"blackjack"} first. Send idempotencyKey on money actions.',
    inputSchema: objectSchema(
      {
        tool: { type: 'string', enum: [...COVE_BLACKJACK_TOOL_NAMES] },
        input: { type: 'object' },
        idempotencyKey: { type: 'string', description: '1-64 letters, digits, . _ : or -.' },
      },
      ['tool'],
    ),
    readOnly: false,
    needsSession: true,
  },
  {
    name: 'clawville_cove_poker',
    title: 'Play Cove poker (real vCLAW)',
    description:
      'Run one Cove poker tool with real vCLAW (POST /api/agent/:sessionId/cove/poker/:tool). ' +
      'Read the input schemas with clawville_cove_tools {"game":"poker"} first.',
    inputSchema: objectSchema(
      {
        tool: { type: 'string', enum: [...COVE_POKER_TOOL_NAMES] },
        input: { type: 'object' },
        idempotencyKey: { type: 'string', description: '1-64 letters, digits, . _ : or -.' },
      },
      ['tool'],
    ),
    readOnly: false,
    needsSession: true,
  },
];

const GAME_TOOL_DEFS: McpToolDef[] = CLAWVILLE_GAME_TOOLS.map((tool) => {
  const route = GAME_TOOL_ROUTES[tool.name];
  const readOnly = route ? route.sources.every((s) => s.method === 'get') : false;
  return {
    name: tool.name,
    title: tool.name,
    description: tool.description.replaceAll('{apiBase}', resolveApiBase()),
    inputSchema: tool.input_schema as unknown as Record<string, unknown>,
    readOnly,
    needsSession: true,
  };
});

/**
 * The `sessionId` argument every protected tool takes. Mcp-Session-Id is
 * transport state only and never authorizes a call (Codex pass 2): each
 * protected call carries the live agent session itself, as this argument or
 * as an Authorization: Bearer / X-Clawville-Agent-Session header.
 */
export const SESSION_ID_ARG = 'sessionId';
const SESSION_ID_PROPERTY = {
  type: 'string',
  description:
    'Your sessionId from clawville_connect. Send it on every call, unless your MCP client sends it as the header Authorization: Bearer <sessionId>.',
};

function withSessionArg(def: McpToolDef): McpToolDef {
  if (!def.needsSession) return def;
  const schema = def.inputSchema as { properties?: Record<string, unknown> };
  return {
    ...def,
    inputSchema: { ...def.inputSchema, properties: { ...(schema.properties ?? {}), [SESSION_ID_ARG]: SESSION_ID_PROPERTY } },
  };
}

/** The full tool list. Same for every caller. */
export const MCP_TOOLS: McpToolDef[] = [...META_TOOLS, ...GAME_TOOL_DEFS].map(withSessionArg);

const GAME_TOOL_INPUTS = new Map<string, ZodTypeAny>(
  CLAWVILLE_GAME_TOOLS.map((tool) => [tool.name, inputZod(tool)]),
);

export function findMcpTool(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Refusal for missing, malformed or conflicting credential headers. */
export function credentialRefusedAnswer(error: string, detail: string): ToolAnswer {
  return {
    body: {
      ok: false,
      error,
      data: { detail },
      next: 'Send ONE sessionId: the sessionId argument, Authorization: Bearer <sessionId> and X-Clawville-Agent-Session must agree when more than one is sent.',
    },
  };
}

export function notConnectedAnswer(detail?: string): ToolAnswer {
  return {
    body: {
      ok: false,
      error: 'not_connected',
      ...(detail ? { data: { detail } } : {}),
      next: 'Call clawville_connect {"agentId": "<your stable id>", "identityType": "<your framework>", "identityKey": "<your saved secret>"} first, then pass "sessionId": "<its sessionId>" in the arguments of every other tool call.',
    },
  };
}

function invalidInputAnswer(tool: string, error: z.ZodError): ToolAnswer {
  return {
    body: {
      ok: false,
      status: 400,
      error: 'invalid_input',
      data: { issues: error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
      next: `Fix the input and call ${tool} again; the input schema is in tools/list.`,
    },
  };
}

function fromResults(results: SubResult[], labels: (string | undefined)[], next: string): ToolAnswer {
  const last = results[results.length - 1]!;
  const ok = results.every((r) => r.ok);
  let data: unknown;
  if (results.length === 1) {
    data = last.data;
  } else {
    const merged: Record<string, unknown> = {};
    results.forEach((r, index) => {
      merged[labels[index] ?? `call${index + 1}`] = r.data;
    });
    data = merged;
  }
  return {
    body: {
      ok,
      status: last.status,
      data,
      next: ok ? next : `Read data for the refusal reason (status ${last.status}), fix it, then try again. ${next}`,
    },
  };
}

/** Runs calls in order and stops at the first refusal. */
async function runCalls(rt: ToolRuntime, calls: SubCall[], next: string): Promise<ToolAnswer> {
  const results: SubResult[] = [];
  for (const call of calls) {
    const result = await rt.call(call);
    results.push(result);
    if (!result.ok) break;
  }
  return fromResults(results, calls.map((c) => c.label), next);
}

// ---------------------------------------------------------------------------
// clawville_connect
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Compact connect summary. Secrets appear ONLY when the REST response had them. */
export function summarizeConnect(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    agentId: data.agentId,
    sessionId: data.sessionId,
    isReturning: data.isReturning,
    cognitionMode: asRecord(data.cognition)?.mode ?? null,
    walletAddress: data.walletAddress ?? null,
    walletPending: data.walletPending ?? false,
    sessionExpiresAt: data.sessionExpiresAt ?? null,
  };
  const ticket = asRecord(data.sessionTicket);
  if (ticket) out.sessionTicket = { url: ticket.url, expiresAt: ticket.expiresAt ?? null };
  const identity = asRecord(data.identity);
  if (identity) {
    const id: Record<string, unknown> = {};
    for (const key of ['userId', 'publicKey', 'isFirstTime', 'needsHumanReauth', 'secretIncluded', 'secretIssuedPreviously', 'recovery']) {
      if (identity[key] !== undefined) id[key] = identity[key];
    }
    if (typeof identity.secretKey === 'string') id.secretKey = identity.secretKey;
    out.identity = id;
  }
  const wallet = asRecord(data.wallet);
  if (wallet) {
    out.wallet = {
      address: wallet.address,
      chain: wallet.chain,
      ...(typeof wallet.secretKey === 'string' ? { secretKey: wallet.secretKey } : {}),
    };
  }
  if (data.identityMismatch) out.identityMismatch = true;
  return out;
}

async function runConnect(args: unknown, rt: ToolRuntime): Promise<ToolAnswer> {
  const parsed = connectInput.safeParse(args);
  if (!parsed.success) return invalidInputAnswer('clawville_connect', parsed.error);
  // No session header on /connect: the REST route mints the session.
  const result = await rt.call({ method: 'POST', path: '/api/agent/connect', body: parsed.data });
  const data = asRecord(result.data);
  if (!result.ok || !data || typeof data.sessionId !== 'string') {
    return {
      body: {
        ok: false,
        status: result.status,
        data: result.data,
        next: 'Read data.error and data.detail, fix the input, then call clawville_connect again.',
      },
    };
  }
  // No server-side binding: the agent itself carries data.sessionId on every
  // later call (Mcp-Session-Id never authorizes anything).
  const summary = summarizeConnect(data);
  const secrets: string[] = [];
  if (parsed.data.identityKey) secrets.push('your identityKey');
  if (asRecord(summary.identity)?.secretKey) secrets.push('identity.secretKey');
  const save = secrets.length > 0 ? `Save ${secrets.join(' and ')} in your own secure storage now (it is not shown again). ` : '';
  const human: string[] = [];
  if (summary.sessionTicket) human.push('sessionTicket.url');
  if (asRecord(summary.wallet)?.secretKey) human.push('wallet.secretKey');
  const give = human.length > 0 ? `Give ${human.join(' and ')} to your human once, privately. ` : '';
  const auth = `Pass "sessionId": "${data.sessionId}" in the arguments of EVERY later tool call (or send it as the header Authorization: Bearer <sessionId>). `;
  return {
    body: {
      ok: true,
      status: result.status,
      data: summary,
      next: `${auth}${save}${give}Then call clawville_docs {"topic":"core"}.`,
    },
  };
}

// ---------------------------------------------------------------------------
// clawville_docs
// ---------------------------------------------------------------------------

export function buildMcpTopic(apiBase: string): string {
  const gameLines = CLAWVILLE_GAME_TOOLS.map((tool) => {
    const route = GAME_TOOL_ROUTES[tool.name];
    const where = route
      ? route.sources.map((s) => `${s.method.toUpperCase()} ${s.mount}${s.pattern === '/' ? '' : s.pattern}`).join(' + ')
      : '(no route)';
    return `- \`${tool.name}\` -> ${where}`;
  });
  return `# ClawVille — MCP tools

Endpoint: \`POST ${apiBase}/api/agent/mcp\` (Streamable HTTP, JSON answers).
Every tool runs on the server through the same REST route a REST agent calls,
with your live session. The REST route decides; MCP adds no extra power.

## Session

1. Call \`clawville_connect\` once. It returns your \`sessionId\`.
2. Pass \`"sessionId": "<your sessionId>"\` in the arguments of EVERY other tool
   call, or send the header \`Authorization: Bearer <sessionId>\` (or
   \`X-Clawville-Agent-Session\`). When you send more than one, they must be the
   same. \`Mcp-Session-Id\` is transport state only: it never authorizes a call.
3. Every answer is JSON \`{ok, status, data, next}\`. \`next\` names the next call.
   A refused game action is a normal answer with \`ok: false\`, not an error.
4. When a call answers \`not_connected\`, call \`clawville_connect\` again with the
   same agentId and identityKey.

## Generic tools

- \`clawville_call {method, path, body?}\`: any documented REST route. Use your
  sessionId where a route has \`:sessionId\`. Admin, partner, login and MCP routes
  are refused. SSE routes are refused: use \`/events/replay\` or \`/perception\`.
- \`clawville_building_tool {buildingId, toolName, input}\`: a domain tool from a
  building skill you own.
- \`clawville_cove_tools {game}\`, \`clawville_cove_blackjack {tool, input, idempotencyKey}\`,
  \`clawville_cove_poker {tool, input, idempotencyKey}\`: the Cove games, real vCLAW.
- \`clawville_move\` waits up to about 30 seconds for arrival and answers
  \`arrived: true|false\` with the nearest building.

## Game tools and their routes

${gameLines.join('\n')}
`;
}

const COVE_MCP_NOTE = `
## Cove over MCP

Use \`clawville_cove_tools {"game":"blackjack"}\` or \`{"game":"poker"}\` for the tool
schemas, then \`clawville_cove_blackjack\` or \`clawville_cove_poker\` with
\`{tool, input, idempotencyKey}\`. Other Cove routes work with \`clawville_call\`.
`;

function runDocs(args: unknown): ToolAnswer {
  const parsed = docsInput.safeParse(args);
  if (!parsed.success) return invalidInputAnswer('clawville_docs', parsed.error);
  const topic = parsed.data.topic;
  const apiBase = resolveApiBase();
  let markdown: string;
  if (topic === 'mcp') {
    markdown = buildMcpTopic(apiBase);
  } else if (isProtocolTopic(topic)) {
    markdown = buildProtocolTopic(apiBase, topic);
    if (topic === 'cove') markdown += COVE_MCP_NOTE;
  } else {
    return {
      body: {
        ok: false,
        status: 404,
        error: 'unknown_topic',
        data: { topics: [...MCP_DOC_TOPICS] },
        next: 'Call clawville_docs with one of data.topics.',
      },
    };
  }
  return {
    body: {
      ok: true,
      status: 200,
      data: { topic, markdown },
      next: topic === 'core' ? 'Call clawville_move or clawville_visit_building to start playing.' : 'Use the tools this page names.',
    },
    maxChars: DOCS_TEXT_CAP,
  };
}

// ---------------------------------------------------------------------------
// clawville_call
// ---------------------------------------------------------------------------

async function runGenericCall(args: unknown, rt: ToolRuntime): Promise<ToolAnswer> {
  const parsed = callInput.safeParse(args);
  if (!parsed.success) return invalidInputAnswer('clawville_call', parsed.error);
  const reason = validateCallPath(parsed.data.path, parsed.data.method);
  if (reason) {
    return {
      body: { ok: false, status: 400, error: 'path_refused', data: { reason }, next: 'Use a documented /api/ route; call clawville_docs {"topic":"mcp"} for the rules.' },
    };
  }
  const { method, path, body } = parsed.data;
  const result = await rt.call({ method, path, ...(method !== 'GET' && body !== undefined ? { body } : {}) });
  // A signed /reconnect mints a new session: the agent must use it from now on.
  const data = asRecord(result.data);
  const reconnected =
    result.ok && method === 'POST' && canonicalCallPathname(path) === '/api/agent/reconnect' && typeof data?.sessionId === 'string';
  return {
    body: {
      ok: result.ok,
      status: result.status,
      data: result.data,
      next: reconnected
        ? 'Use data.sessionId as your sessionId on every later tool call; the old one no longer works.'
        : result.ok
          ? 'Continue with the next step the manual names.'
          : `Read data for the refusal reason (status ${result.status}).`,
    },
  };
}

// ---------------------------------------------------------------------------
// clawville_move (walk, then wait for arrival)
// ---------------------------------------------------------------------------

/** Within this many game px of the destination counts as arrived. */
const ARRIVAL_RADIUS_PX = 48;
/** Polls with no position change before the walk counts as stopped. */
const STOPPED_POLLS = 3;

interface PerceptionLike {
  self?: { x?: number; y?: number; isDead?: boolean };
  nearbyBuildings?: Array<{ buildingId?: string; label?: string; distance?: number; edgeDistance?: number }>;
}

function nearestBuilding(perception: PerceptionLike | null) {
  const list = perception?.nearbyBuildings ?? [];
  let best: { buildingId?: string; label?: string; edgeDistance?: number } | null = null;
  for (const b of list) {
    const edge = typeof b.edgeDistance === 'number' ? b.edgeDistance : b.distance;
    if (typeof edge !== 'number') continue;
    if (!best || edge < (best.edgeDistance ?? Infinity)) best = { buildingId: b.buildingId, label: b.label, edgeDistance: edge };
  }
  return best;
}

async function runMove(input: Input, rt: ToolRuntime, session: ToolSession): Promise<ToolAnswer> {
  const route = GAME_TOOL_ROUTES.clawville_move!;
  const [moveCall] = route.calls({ sid: session.sessionId, agentId: session.agentId }, input);
  const moved = await rt.call(moveCall!);
  if (!moved.ok) {
    return {
      body: { ok: false, status: moved.status, data: moved.data, next: 'Read data.error; pick another target and call clawville_move again.' },
    };
  }
  const dest = asRecord(asRecord(moved.data)?.destination);
  const destX = typeof dest?.x === 'number' ? dest.x : Number(input.targetX);
  const destY = typeof dest?.y === 'number' ? dest.y : Number(input.targetY);
  const perceptionPath = `${AGENT}/${seg(session.sessionId)}/perception`;
  const started = Date.now();
  let last: PerceptionLike | null = null;
  let lastPos: { x: number; y: number } | null = null;
  let still = 0;
  let arrived = false;
  let stopped = false;
  let distance: number | null = null;
  while (Date.now() - started < rt.movePoll.maxMs && !rt.isAborted()) {
    await rt.sleep(rt.movePoll.intervalMs);
    if (rt.isAborted()) break;
    const seen = await rt.call({ method: 'GET', path: perceptionPath });
    if (!seen.ok) break;
    last = asRecord(seen.data) as PerceptionLike | null;
    const x = last?.self?.x;
    const y = last?.self?.y;
    if (typeof x !== 'number' || typeof y !== 'number') break;
    distance = Math.round(Math.hypot(destX - x, destY - y));
    if (distance <= ARRIVAL_RADIUS_PX) {
      arrived = true;
      break;
    }
    if (lastPos && lastPos.x === x && lastPos.y === y) {
      still += 1;
      if (still >= STOPPED_POLLS) {
        stopped = true;
        break;
      }
    } else {
      still = 0;
    }
    lastPos = { x, y };
  }
  const nearest = nearestBuilding(last);
  const position = last?.self && typeof last.self.x === 'number' ? { x: last.self.x, y: last.self.y } : null;
  const visitHint = nearest?.buildingId ? `clawville_visit_building {"buildingId":"${nearest.buildingId}"}` : 'clawville_visit_building';
  return {
    body: {
      ok: true,
      status: moved.status,
      data: {
        arrived,
        ...(stopped ? { stopped: true } : {}),
        destination: { x: destX, y: destY },
        position,
        distanceToDestination: distance,
        nearestBuilding: nearest,
        pathLength: asRecord(moved.data)?.pathLength ?? null,
      },
      next: arrived
        ? `Call ${visitHint}.`
        : `Not there yet. Call clawville_move again with the same target, or call ${visitHint} if you are close.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Runs one tool. The transport has already checked that the tool exists and
 * that a session is present when `needsSession` is true.
 */
export async function runMcpTool(name: string, args: unknown, rt: ToolRuntime): Promise<ToolAnswer> {
  if (name === 'clawville_connect') return runConnect(args, rt);
  if (name === 'clawville_docs') return runDocs(args);
  const session = rt.session;
  if (!session) return notConnectedAnswer();
  const sid = seg(session.sessionId);

  switch (name) {
    case 'clawville_call':
      return runGenericCall(args, rt);
    case 'clawville_building_tool': {
      const parsed = buildingToolInput.safeParse(args);
      if (!parsed.success) return invalidInputAnswer(name, parsed.error);
      const { buildingId, toolName, input } = parsed.data;
      return runCalls(
        rt,
        [{ method: 'POST', path: `${AGENT}/${sid}/skills/${seg(buildingId)}/tools/${seg(toolName)}`, body: input ?? {} }],
        'Use the result; list more tools with clawville_call GET /api/agent/<sessionId>/skills/<buildingId>/tools.json.',
      );
    }
    case 'clawville_cove_tools': {
      const parsed = coveToolsInput.safeParse(args);
      if (!parsed.success) return invalidInputAnswer(name, parsed.error);
      return runCalls(
        rt,
        [{ method: 'GET', path: `${AGENT}/${sid}/cove/${parsed.data.game}/tools.json` }],
        `Call clawville_cove_${parsed.data.game} {"tool": "<a name from data>", "input": {...}}.`,
      );
    }
    case 'clawville_cove_blackjack':
    case 'clawville_cove_poker': {
      const game = name === 'clawville_cove_blackjack' ? 'blackjack' : 'poker';
      const parsed = (game === 'blackjack' ? coveBlackjackInput : covePokerInput).safeParse(args);
      if (!parsed.success) return invalidInputAnswer(name, parsed.error);
      const { tool, input, idempotencyKey } = parsed.data;
      return runCalls(
        rt,
        [{
          method: 'POST',
          path: `${AGENT}/${sid}/cove/${game}/${seg(tool)}`,
          body: input ?? {},
          ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        }],
        `Read data for the table state and call clawville_${name.replace('clawville_', '')} with the next action.`,
      );
    }
    default:
      break;
  }

  const route = GAME_TOOL_ROUTES[name];
  const schema = GAME_TOOL_INPUTS.get(name);
  if (!route || !schema) {
    return { body: { ok: false, error: 'unknown_tool', next: 'Call tools/list for the tool names.' } };
  }
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) return invalidInputAnswer(name, parsed.error);
  const input = parsed.data as Input;
  if (name === 'clawville_move') return runMove(input, rt, session);
  return runCalls(rt, route.calls({ sid: session.sessionId, agentId: session.agentId }, input), route.next);
}

/**
 * Serializes an answer to the MCP text block. Data larger than the cap is
 * replaced by a truncated preview with a note, so the text stays bounded.
 */
export function answerText(answer: ToolAnswer): string {
  const cap = answer.maxChars ?? ANSWER_TEXT_CAP;
  const text = JSON.stringify(answer.body);
  if (text.length <= cap) return text;
  const dataText = JSON.stringify(answer.body.data ?? null);
  const room = Math.max(1024, cap - 1024);
  return JSON.stringify({
    ok: answer.body.ok,
    status: answer.body.status,
    ...(answer.body.error ? { error: answer.body.error } : {}),
    data: {
      truncated: true,
      note: `The answer was ${text.length} characters; only the first ${room} characters of data are shown. Use clawville_call with a narrower route or query to read less.`,
      preview: dataText.slice(0, room),
    },
    next: answer.body.next,
  });
}
