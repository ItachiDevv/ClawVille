/**
 * Hosted MCP server — POST /api/agent/mcp (job agent-skill-simple, 2026-10-13).
 *
 * A minimal Streamable HTTP MCP server: stateless JSON answers, no SSE, no SDK
 * (same shape as carbon-road's assistant/mcpServer.ts). An MCP host adds ONE
 * URL and gets real tools that run on this server.
 *
 *   - POST only. GET and DELETE answer 405 (allowed for a server without an
 *     SSE stream). Any request with an Origin header is refused (403): the
 *     callers are agent runtimes, never browsers, and refusing Origin removes
 *     the DNS-rebinding / cross-site classes the MCP spec warns about.
 *   - Body cap 256 KB. Batches of at most 20 messages.
 *   - Methods: initialize, notifications/* (202, no body), ping, tools/list,
 *     tools/call. JSON-RPC errors -32700 / -32600 / -32601 / -32602.
 *
 * Who a call acts for (never a client-supplied agentId): the live ClawVille
 * session the CALL itself carries, as `Authorization: Bearer <sessionId>`,
 * `X-Clawville-Agent-Session`, or the `sessionId` tool argument (for MCP
 * clients that cannot set headers). When more than one is sent they must
 * agree, else the call is refused. `Mcp-Session-Id` (issued by initialize,
 * random 192 bits) is transport state only and NEVER authorizes a call.
 * Liveness always goes through `validateLiveAgentSession` (the one fail-closed
 * gate every bearer path uses). initialize, ping, tools/list, clawville_connect
 * and clawville_docs need no session.
 *
 * Tools run in-process through the root app (`setMcpDispatcher`, set by
 * index.ts). Sub-requests carry the session header, JSON, and the caller's
 * client-IP headers so the REST rate limiters key on the real caller. The
 * caller's Authorization and Cookie headers are NEVER forwarded.
 *
 * State (issued MCP sessions, call budgets) is in-memory: this API
 * runs as one process (pendingConnections in agent-gateway.ts is also an
 * in-memory Map). A restart drops it; clients get 404 for the old
 * Mcp-Session-Id, initialize again, and call clawville_connect again.
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../types';
import { getClientIp } from '../middleware/rate-limit';
import { redactBearerTokens } from '../services/log-redact';
import { resolveApiBase } from '../services/skill-protocol';
import {
  MCP_TOOLS,
  answerText,
  canonicalCallPathname,
  credentialRefusedAnswer,
  findMcpTool,
  isMcpEndpointPath,
  notConnectedAnswer,
  SESSION_ID_ARG,
  SSE_ROUTE_PATTERNS,
  runMcpTool,
  type SubCall,
  type SubResult,
  type ToolRuntime,
  type ToolSession,
} from '../services/agent-mcp-tools';

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_MAX_BODY_BYTES = 256 * 1024;
export const MCP_CALLS_PER_MINUTE = 120;
/** Pre-DB ceiling per client IP for tools/call (many agents can share one NAT). */
const IP_CALLS_PER_MINUTE = 600;
/** initialize calls per client IP per minute (each one allocates a session). */
const INITIALIZE_PER_MINUTE = 30;
const MAX_BATCH = 20;
const SERVER_VERSION = '1.0.0';
/** Issued MCP sessions kept at most (oldest dropped first). */
const MAX_MCP_SESSIONS = 20_000;
/** An MCP session not used for this long is forgotten. */
const MCP_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** One in-process sub-request (dispatch AND body read) may take at most this long. */
let subRequestTimeoutMs = 30_000;
/**
 * Marker header on every in-process sub-request. The MCP route refuses any
 * request that carries it, so MCP can never dispatch into itself, however the
 * path is spelled.
 */
export const MCP_SUBREQUEST_HEADER = 'X-Clawville-Mcp-Subrequest';
/** Bytes read from one sub-response at most. */
const SUB_RESPONSE_MAX_BYTES = 1024 * 1024;

const INSTRUCTIONS =
  'Tools for ClawVille, a shared world where AI agents and humans learn, play and trade. ' +
  'Call clawville_connect first (a stable agentId plus your saved identityType and identityKey), then clawville_docs {"topic":"core"}. ' +
  'Pass "sessionId": "<sessionId from clawville_connect>" in the arguments of every other tool call (or send Authorization: Bearer <sessionId>); Mcp-Session-Id never authorizes a call. ' +
  'Every answer is JSON {ok, status, data, next}; next names the next call. A refused action is a normal answer with ok false. ' +
  'Some tools move real money (vCLAW, USDC, SOL): tell your human before you use them.';

// ---------------------------------------------------------------------------
// Injectable seams (index.ts sets the dispatcher; tests stub both)
// ---------------------------------------------------------------------------

export type McpDispatcher = (req: Request) => Promise<Response>;
export type McpSessionValidator = (sessionId: string) => Promise<{ agentId: string } | null>;

let dispatcher: McpDispatcher | null = null;

/** index.ts calls this with `(req) => app.fetch(req)` after every route is mounted. */
export function setMcpDispatcher(fn: McpDispatcher | null): void {
  dispatcher = fn;
}

const defaultValidator: McpSessionValidator = async (sessionId) => {
  // Dynamic import keeps the DB-backed gate out of unit tests' module graph.
  const { validateLiveAgentSession } = await import('../middleware/require-auth-or-agent');
  const live = await validateLiveAgentSession(sessionId);
  return live ? { agentId: live.config.agentId } : null;
};
let validator: McpSessionValidator = defaultValidator;

/** Test seam: replace the liveness gate. `null` restores the real one. */
export function setMcpSessionValidatorForTests(fn: McpSessionValidator | null): void {
  validator = fn ?? defaultValidator;
}

let movePoll = { intervalMs: 1000, maxMs: 30_000 };
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Test seam: shorten the sub-request deadline. `null` restores 30 s. */
export function setMcpSubRequestTimeoutForTests(ms: number | null): void {
  subRequestTimeoutMs = ms ?? 30_000;
}

/** Test seam: shorten the clawville_move arrival wait. */
export function setMcpMovePollingForTests(opts: { intervalMs: number; maxMs: number } | null): void {
  movePoll = opts ?? { intervalMs: 1000, maxMs: 30_000 };
  sleep = opts ? () => Promise.resolve() : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MCP sessions + budgets (in-memory)
// ---------------------------------------------------------------------------

/**
 * Mcp-Session-Id is transport state ONLY (Codex review pass 2, 2026-10-13): it
 * holds no ClawVille session and never authorizes a tool call, so knowing or
 * planting one gives nothing. `initialize` that carries an Mcp-Session-Id is
 * still refused, and only ids this server issued exist (unknown ids get 404).
 */
interface McpSessionEntry {
  lastUsed: number;
}

const mcpSessions = new Map<string, McpSessionEntry>();
const callBudgets = new Map<string, { tokens: number; at: number }>();

/** Hard cap on rate-budget entries; the least recently used go first. */
export const MCP_MAX_CALL_BUDGETS = 20_000;
/** Stale budgets (idle > 2 min, i.e. full again) are swept at most this often. */
const BUDGET_SWEEP_INTERVAL_MS = 10_000;
const BUDGET_STALE_MS = 120_000;
let lastBudgetSweep = 0;

export function resetMcpStateForTests(): void {
  mcpSessions.clear();
  callBudgets.clear();
  lastBudgetSweep = 0;
}

export function callBudgetCountForTests(): number {
  return callBudgets.size;
}

function issueMcpSession(now: number): string {
  const id = randomBytes(24).toString('base64url');
  if (mcpSessions.size >= MAX_MCP_SESSIONS) {
    for (const [key, entry] of mcpSessions) {
      if (now - entry.lastUsed > MCP_SESSION_IDLE_MS) mcpSessions.delete(key);
    }
    // Map keeps insertion order: drop the oldest. An evicted client gets 404
    // and initializes again; it loses no ClawVille state (none is kept here).
    while (mcpSessions.size >= MAX_MCP_SESSIONS) {
      const oldest = mcpSessions.keys().next().value;
      if (oldest === undefined) break;
      mcpSessions.delete(oldest);
    }
  }
  mcpSessions.set(id, { lastUsed: now });
  return id;
}

function lookupMcpSession(id: string, now: number): McpSessionEntry | null {
  const entry = mcpSessions.get(id);
  if (!entry) return null;
  if (now - entry.lastUsed > MCP_SESSION_IDLE_MS) {
    mcpSessions.delete(id);
    return null;
  }
  entry.lastUsed = now;
  return entry;
}

/**
 * Token bucket: `perMinute` calls per minute per key. The map is kept in
 * least-recently-used order (delete + set on every use), so the size cap
 * evicts the oldest entries in O(1) each; the stale sweep runs at most once
 * per BUDGET_SWEEP_INTERVAL_MS, never on every call.
 */
export function allowCall(key: string, now: number, perMinute = MCP_CALLS_PER_MINUTE): boolean {
  const existing = callBudgets.get(key);
  const budget = existing ?? { tokens: perMinute, at: now };
  budget.tokens = Math.min(perMinute, budget.tokens + ((now - budget.at) / 60_000) * perMinute);
  budget.at = now;
  const allowed = budget.tokens >= 1;
  if (allowed) budget.tokens -= 1;
  if (existing) callBudgets.delete(key);
  if (now - lastBudgetSweep >= BUDGET_SWEEP_INTERVAL_MS) {
    lastBudgetSweep = now;
    // LRU order: stop at the first entry that is still fresh.
    for (const [k, v] of callBudgets) {
      if (now - v.at <= BUDGET_STALE_MS) break;
      callBudgets.delete(k);
    }
  }
  while (callBudgets.size >= MCP_MAX_CALL_BUDGETS) {
    const oldest = callBudgets.keys().next().value;
    if (oldest === undefined) break;
    callBudgets.delete(oldest);
  }
  callBudgets.set(key, budget);
  return allowed;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Visible ASCII, bounded: the shape of every id we accept from a header. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,256}$/;

type ExplicitCredential =
  | { kind: 'none' }
  | { kind: 'sid'; sessionId: string }
  | { kind: 'refused'; error: string; detail: string };

/**
 * The ClawVille credential in the MCP request HEADERS. A malformed header, or
 * Authorization and X-Clawville-Agent-Session naming different sessions, is
 * refused outright (never ignored, never a fallback).
 */
function explicitCredential(c: Context<AppContext>): ExplicitCredential {
  const auth = c.req.header('authorization');
  const header = c.req.header('x-clawville-agent-session');
  let fromAuth: string | null = null;
  let fromHeader: string | null = null;
  if (auth !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (!match || !TOKEN_SHAPE.test(match[1]!)) {
      return { kind: 'refused', error: 'invalid_credentials', detail: 'Authorization must be "Bearer <sessionId>".' };
    }
    fromAuth = match[1]!;
  }
  if (header !== undefined) {
    const value = header.trim();
    if (!TOKEN_SHAPE.test(value)) {
      return { kind: 'refused', error: 'invalid_credentials', detail: 'X-Clawville-Agent-Session is malformed.' };
    }
    fromHeader = value;
  }
  if (fromAuth && fromHeader && fromAuth !== fromHeader) {
    return { kind: 'refused', error: 'conflicting_credentials', detail: 'Authorization and X-Clawville-Agent-Session name different sessions.' };
  }
  const sessionId = fromAuth ?? fromHeader;
  return sessionId ? { kind: 'sid', sessionId } : { kind: 'none' };
}

/**
 * Adds the `sessionId` tool argument (protected tools only) to the header
 * credential. A non-string or malformed argument is refused; an argument that
 * names another session than the headers is refused.
 */
function callCredential(fromHeaders: ExplicitCredential, args: Record<string, unknown>, needsSession: boolean): ExplicitCredential {
  if (!needsSession || !Object.prototype.hasOwnProperty.call(args, SESSION_ID_ARG)) return fromHeaders;
  const value = args[SESSION_ID_ARG];
  if (typeof value !== 'string' || !TOKEN_SHAPE.test(value)) {
    return {
      kind: 'refused',
      error: 'invalid_credentials',
      detail: 'The sessionId argument must be the sessionId string from clawville_connect.',
    };
  }
  if (fromHeaders.kind === 'refused') return fromHeaders;
  if (fromHeaders.kind === 'sid' && fromHeaders.sessionId !== value) {
    return {
      kind: 'refused',
      error: 'conflicting_credentials',
      detail: 'The sessionId argument and the session header name different sessions.',
    };
  }
  return { kind: 'sid', sessionId: value };
}

/** Client-IP and provenance headers the rate limiters and fingerprint read. */
const FORWARDED_HEADERS = ['x-real-ip', 'x-forwarded-for', 'cf-connecting-ip', 'user-agent', 'x-cv-fingerprint'] as const;

function forwardedHeaders(c: Context<AppContext>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = c.req.header(name);
    if (value) out[name] = value;
  }
  return out;
}

/** Reads at most `limit` bytes of a response body; stops when `abort` fires. */
async function readCapped(
  res: Response,
  limit: number,
  abort: Promise<never>,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abort]);
      if (done) break;
      if (size + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - size));
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // Ends the producer on overflow, deadline or caller abort; no-op when done.
    // Never awaited: a producer whose cancel() hangs must not hold the answer.
    reader.cancel().catch(() => {});
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

async function inProcessCall(
  call: SubCall,
  sessionId: string | null,
  fwd: Record<string, string>,
  parentSignal: AbortSignal | undefined,
): Promise<SubResult> {
  if (!dispatcher) return { status: 503, ok: false, data: { error: 'mcp_dispatcher_not_ready' } };
  // Second line of defence after validateCallPath: never dispatch into the MCP
  // endpoint or an SSE route, whatever built the path.
  const canonical = canonicalCallPathname(call.path);
  if (
    isMcpEndpointPath(canonical) ||
    call.path.split('?')[0]!.includes('%') ||
    SSE_ROUTE_PATTERNS.some((re) => re.test(canonical))
  ) {
    return { status: 400, ok: false, data: { error: 'path_refused' } };
  }
  // In-process only: the URL host is our own public API base and the path was
  // built by the tool table or passed validateCallPath (always /api/...).
  const url = new URL(call.path, resolveApiBase());
  const headers: Record<string, string> = { ...fwd, Accept: 'application/json', ...(call.headers ?? {}) };
  headers[MCP_SUBREQUEST_HEADER] = '1';
  if (sessionId) headers['X-Clawville-Agent-Session'] = sessionId;
  const hasBody = call.body !== undefined && call.method !== 'GET';
  if (hasBody) headers['Content-Type'] = 'application/json';

  // ONE deadline for dispatch AND body consumption; the MCP caller hanging up
  // aborts it too. The signal reaches the sub-request, so handlers that watch
  // c.req.raw.signal stop as well.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), subRequestTimeoutMs);
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const abort = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(new Error('aborted'));
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  abort.catch(() => {}); // never an unhandled rejection
  try {
    // The caller already left (or the deadline passed): do not start the call.
    if (controller.signal.aborted) return { status: 504, ok: false, data: { error: 'aborted' } };
    const req = new Request(url.toString(), {
      method: call.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
      signal: controller.signal,
    });
    const res = await Promise.race([dispatcher(req), abort]);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      // Not awaited: a cancel() that never settles must not block the answer.
      res.body?.cancel().catch(() => {});
      return {
        status: 415,
        ok: false,
        data: { error: 'streaming_not_supported', hint: 'Use GET /api/agent/<sessionId>/events/replay or /perception over MCP.' },
      };
    }
    const { text, truncated } = await readCapped(res, SUB_RESPONSE_MAX_BYTES, abort);
    let data: unknown;
    if (truncated) {
      data = { truncated: true, preview: text.slice(0, 16 * 1024) };
    } else if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      data = null;
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
  } catch (error) {
    if (controller.signal.aborted) return { status: 504, ok: false, data: { error: 'timeout' } };
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
    controller.abort(); // release the sub-request in every case
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

const validId = (id: unknown): id is JsonRpcId =>
  id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

interface RequestState {
  c: Context<AppContext>;
  now: number;
  /** Set by initialize: the new Mcp-Session-Id response header. */
  issuedSessionId: string | null;
  /** Credential from the request headers (the sessionId argument is per call). */
  explicit: ExplicitCredential;
  fwd: Record<string, string>;
  clientIp: string;
}

type SessionResolution =
  | { session: ToolSession | null; detail?: string }
  | { refused: { error: string; detail: string } };

/**
 * Resolves the live ClawVille session for ONE tool call from the credential it
 * carries. No fallback: a dead session answers not_connected, and no
 * credential means no session (Mcp-Session-Id never counts).
 */
async function resolveToolSession(credential: ExplicitCredential): Promise<SessionResolution> {
  if (credential.kind === 'refused') {
    return { refused: { error: credential.error, detail: credential.detail } };
  }
  if (credential.kind === 'none') return { session: null };
  const live = await validator(credential.sessionId);
  if (!live) return { session: null, detail: 'That sessionId is not live. Call clawville_connect for a new one.' };
  return { session: { sessionId: credential.sessionId, agentId: live.agentId } };
}

async function dispatchMessage(entry: unknown, state: RequestState): Promise<JsonRpcResponse | undefined> {
  const invalid: JsonRpcResponse = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid;
  const message = entry as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return invalid;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (hasId && !validId(message.id)) return invalid;
  if (message.params !== undefined && (typeof message.params !== 'object' || message.params === null || Array.isArray(message.params))) {
    return hasId ? { jsonrpc: '2.0', id: (message.id as JsonRpcId) ?? null, error: { code: -32602, message: 'params must be an object' } } : undefined;
  }
  if (!hasId) return undefined; // notifications/initialized, cancelled, ...
  const id = (message.id as JsonRpcId) ?? null;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  const result = (value: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result: value });

  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
      if (!state.issuedSessionId) {
        if (!allowCall(`init:${state.clientIp}`, state.now, INITIALIZE_PER_MINUTE)) {
          return fail(-32000, 'Too many initialize calls from this address. Wait a minute.');
        }
        state.issuedSessionId = issueMcpSession(state.now);
      }
      return result({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'clawville', title: 'ClawVille', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { title: tool.title, readOnlyHint: tool.readOnly, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments;
      const tool = typeof name === 'string' ? findMcpTool(name) : undefined;
      if (!tool) return fail(-32602, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 64) : String(name)}`);
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return fail(-32602, 'arguments must be an object');
      }
      const toolResult = (text: string, isError = false) => result({ content: [{ type: 'text', text }], isError });
      // A rate refusal is an answer, not a tool error (some hosts trip a
      // breaker on repeated tool errors).
      const limited = () =>
        toolResult(JSON.stringify({ ok: false, error: 'rate_limited', next: `Wait a minute: at most ${MCP_CALLS_PER_MINUTE} tool calls per minute.` }));
      // Pre-DB ceiling per IP, so random bearers cannot drive session lookups.
      if (!allowCall(`ip:${state.clientIp}`, state.now, IP_CALLS_PER_MINUTE)) return limited();
      try {
        const toolArgs = (args ?? {}) as Record<string, unknown>;
        const resolution = await resolveToolSession(callCredential(state.explicit, toolArgs, tool.needsSession));
        if ('refused' in resolution) {
          return toolResult(answerText(credentialRefusedAnswer(resolution.refused.error, resolution.refused.detail)));
        }
        const { session, detail } = resolution;
        const budgetKey = session ? `sid:${session.sessionId}` : `anon:${state.clientIp}`;
        if (!allowCall(budgetKey, state.now)) return limited();
        if (tool.needsSession && !session) return toolResult(answerText(notConnectedAnswer(detail)));
        // The sessionId argument is a credential, not a tool input: it never
        // reaches the tool or a sub-request body.
        const { [SESSION_ID_ARG]: _credential, ...toolInput } = toolArgs;
        const runtime: ToolRuntime = {
          session,
          call: (call) =>
            inProcessCall(
              call,
              call.path === '/api/agent/connect' ? null : session?.sessionId ?? null,
              state.fwd,
              state.c.req.raw.signal,
            ),
          isAborted: () => state.c.req.raw.signal.aborted,
          sleep,
          movePoll,
        };
        const answer = await runMcpTool(tool.name, tool.needsSession ? toolInput : toolArgs, runtime);
        return toolResult(answerText(answer));
      } catch (error) {
        console.error(`[agent-mcp] tool ${tool.name} failed: ${redactBearerTokens(error instanceof Error ? error.message : String(error))}`);
        return toolResult(
          JSON.stringify({ ok: false, error: 'tool_failed', next: `The ${tool.name} tool failed on the server. Try again shortly.` }),
          true,
        );
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method.slice(0, 64)}`);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const agentMcpRoutes = new Hono<AppContext>();

const noStore = { 'Cache-Control': 'no-store' };

function refuseBrowser(c: Context<AppContext>): Response | null {
  if (c.req.header('origin')) return c.json({ error: 'browser_origin_refused' }, 403, noStore);
  return null;
}

agentMcpRoutes.on(['GET', 'DELETE', 'PUT', 'PATCH'], '/mcp', (c) => {
  return refuseBrowser(c) ?? c.json({ error: 'method_not_allowed' }, 405, { ...noStore, Allow: 'POST' });
});

agentMcpRoutes.post(
  '/mcp',
  async (c, next) => {
    // Origin first, so a browser never gets past the door (not even a 413).
    const refused = refuseBrowser(c);
    if (refused) return refused;
    if (c.req.header(MCP_SUBREQUEST_HEADER) !== undefined) {
      return c.json({ error: 'mcp_recursion_refused' }, 400, noStore);
    }
    await next();
  },
  bodyLimit({
    maxSize: MCP_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'body_too_large' }, 413, { ...noStore, Connection: 'close' }),
  }),
  async (c) => {
    try {
      const version = c.req.header('mcp-protocol-version');
      if (version && !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        return c.json(
          { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version.slice(0, 32)}` } },
          400,
          noStore,
        );
      }
      const raw = await c.req.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400, noStore);
      }
      const batch = Array.isArray(parsed);
      const messages = (batch ? parsed : [parsed]) as unknown[];
      if (messages.length === 0 || messages.length > MAX_BATCH) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400, noStore);
      }

      const now = Date.now();
      const isInitialize = messages.some(
        (m) => !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize',
      );
      const headerSessionId = c.req.header('mcp-session-id')?.trim() || null;
      if (headerSessionId && isInitialize) {
        // Fixation guard (a): never accept or reuse a client-chosen id.
        return c.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message:
                'Do not send Mcp-Session-Id with initialize: remove it from your MCP client config. The server issues it in the initialize answer.',
            },
          },
          400,
          noStore,
        );
      }
      if (headerSessionId) {
        const mcpEntry = TOKEN_SHAPE.test(headerSessionId) ? lookupMcpSession(headerSessionId, now) : null;
        if (!mcpEntry) {
          // Spec: an unknown or ended session gets 404; the client initializes again.
          return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found. Send initialize again.' } }, 404, noStore);
        }
      }

      const state: RequestState = {
        c,
        now,
        issuedSessionId: null,
        explicit: explicitCredential(c),
        fwd: forwardedHeaders(c),
        clientIp: getClientIp({ get: (h) => c.req.header(h) ?? null }),
      };
      const replies: JsonRpcResponse[] = [];
      for (const message of messages) {
        // The caller hung up: stop the batch, never start the next message.
        if (c.req.raw.signal.aborted) break;
        const reply = await dispatchMessage(message, state);
        if (reply) replies.push(reply);
      }
      const headers: Record<string, string> = { ...noStore };
      if (state.issuedSessionId) headers['Mcp-Session-Id'] = state.issuedSessionId;
      if (replies.length === 0) return c.body(null, 202, headers);
      return c.json(batch ? replies : replies[0], 200, headers);
    } catch (error) {
      // A body with no Content-Length overflows while c.req.text() streams it;
      // bodyLimit raises BodyLimitError there. Answer it here so it never
      // reaches app.onError (which alerts on unexpected errors).
      if (error instanceof Error && error.name === 'BodyLimitError') {
        return c.json({ error: 'body_too_large' }, 413, { ...noStore, Connection: 'close' });
      }
      console.error(`[agent-mcp] request failed: ${redactBearerTokens(error instanceof Error ? error.message : String(error))}`);
      return c.json({ error: 'internal_error' }, 500, noStore);
    }
  },
);

export { agentMcpRoutes };
