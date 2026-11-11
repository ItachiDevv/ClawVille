/**
 * Hosted MCP server — POST /api/agent/mcp (job agent-skill-simple, 2026-10-13).
 *
 * A minimal Streamable HTTP MCP server: stateless JSON answers, no SSE, no
 * SDK. An MCP host adds ONE URL and gets real tools that run on this server.
 *
 *   - POST only. GET and DELETE answer 405 (allowed for a server without an
 *     SSE stream). Any request with an Origin header is refused (403): the
 *     callers are agent runtimes, never browsers, and refusing Origin removes
 *     the DNS-rebinding / cross-site classes the MCP spec warns about.
 *   - Body cap 256 KB. Batches of at most 20 messages.
 *   - Methods: initialize, notifications/* (202, no body), ping, tools/list,
 *     tools/call, resources/list, resources/templates/list, resources/read.
 *     JSON-RPC errors -32700 / -32600 / -32601 / -32602 / -32002 (unknown resource).
 *   - MCP Apps (job mcp-apps-p1, 2026-11-11): one view resource,
 *     ui://clawville/dashboard (services/mcp-app/), linked by
 *     `_meta.ui.resourceUri` from clawville_dashboard and the app-only
 *     clawville_dashboard_refresh. Both take ONLY a view token minted by the
 *     session tool clawville_dashboard_open (see "MCP App view tokens"), so no
 *     sessionId is ever in a view tool's arguments.
 *
 * Who a call acts for (never a client-supplied agentId): the live ClawVille
 * session the CALL itself carries, as `Authorization: Bearer <sessionId>`,
 * `X-Clawville-Agent-Session`, or the `sessionId` tool argument (for MCP
 * clients that cannot set headers). When more than one is sent they must
 * agree, else the call is refused. `Mcp-Session-Id` (issued by initialize,
 * random 192 bits) is transport state only and NEVER authorizes a call.
 * Liveness always goes through `validateLiveAgentSession` (the one fail-closed
 * gate every bearer path uses). initialize, ping, tools/list, resources/*,
 * clawville_connect and clawville_docs need no session.
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
  type ToolAnswer,
  type ToolRuntime,
  type ToolSession,
} from '../services/agent-mcp-tools';
import {
  DASHBOARD_OPEN_TOOL,
  DASHBOARD_REFRESH_TOOL,
  DASHBOARD_RESOURCE_URI,
  DASHBOARD_TOOL,
  LEGACY_RESOURCE_URI_META_KEY,
  dashboardResourceContent,
  dashboardResourceListing,
  runDashboard,
} from '../services/mcp-app/dashboard';

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
  /**
   * True when this client's initialize declared MCP Apps support
   * (`capabilities.extensions["io.modelcontextprotocol/ui"]`). Only shapes
   * tools/list; it never authorizes anything.
   */
  uiCapable: boolean;
}

/** Client capability key for MCP Apps (ext-apps spec; the SDK's EXTENSION_ID). */
export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

function declaresUiExtension(params: Record<string, unknown>): boolean {
  const caps = params.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return false;
  const ext = (caps as { extensions?: unknown }).extensions;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return false;
  const ui = (ext as Record<string, unknown>)[MCP_UI_EXTENSION_ID];
  return !!ui && typeof ui === 'object';
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
  viewTokens.clear();
  tokensBySession.clear();
  lastBudgetSweep = 0;
}

// ---------------------------------------------------------------------------
// MCP App view tokens (job mcp-apps-p1)
// ---------------------------------------------------------------------------

/**
 * A view token lets the dashboard view (ui://clawville/dashboard) load and
 * refresh WITHOUT the ClawVille sessionId ever reaching the view. The host
 * forwards a tool's ARGUMENTS to its view, so the tool linked to the view
 * (clawville_dashboard) and its app-only refresh take ONLY this token; the
 * model-visible session tool clawville_dashboard_open (no `_meta.ui`) mints
 * it (192 random bits) bound to the caller's live session and agentId. It
 * lives VIEW_TOKEN_TTL_MS from mint (no sliding), every use re-checks
 * liveness, and a dead session drops it. At most MAX_VIEW_TOKENS_PER_SESSION
 * live tokens per agent session (that session's oldest goes first) and
 * MAX_VIEW_TOKENS overall. Read-only: a token can only re-run the read-only
 * dashboard for the session it is bound to.
 */
export const VIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MAX_VIEW_TOKENS = 10_000;
export const MAX_VIEW_TOKENS_PER_SESSION = 5;
/** Refreshes per view token per minute (each one makes 5-6 sub-requests). */
export const VIEW_REFRESH_PER_MINUTE = 10;
const VIEW_TOKEN_SHAPE = /^cvw_[A-Za-z0-9_-]{32}$/;

interface ViewTokenEntry {
  sessionId: string;
  agentId: string;
  expiresAt: number;
}

const viewTokens = new Map<string, ViewTokenEntry>();
/** sessionId -> its live tokens in mint order (at most MAX_VIEW_TOKENS_PER_SESSION). */
const tokensBySession = new Map<string, string[]>();

export function viewTokenCountForTests(): number {
  return viewTokens.size;
}

/** Index size, so a test can prove deleted tokens leave no index entries behind. */
export function viewTokenSessionIndexSizeForTests(): number {
  let n = 0;
  for (const list of tokensBySession.values()) n += list.length;
  return n;
}

/** Test seam: mint without a tool call (the map-cap test needs thousands). */
export function mintViewTokenForTests(session: ToolSession, now: number): string {
  return mintViewToken(session, now).token;
}

function mintViewToken(session: ToolSession, now: number): { token: string; expiresAt: number } {
  // Per-session cap: this session's tokens in mint order; drop the expired
  // ones, then the oldest, until one slot is free.
  const own = (tokensBySession.get(session.sessionId) ?? []).filter((key) => {
    const entry = viewTokens.get(key);
    if (entry && entry.expiresAt > now) return true;
    viewTokens.delete(key);
    return false;
  });
  while (own.length >= MAX_VIEW_TOKENS_PER_SESSION) viewTokens.delete(own.shift()!);
  if (own.length > 0) tokensBySession.set(session.sessionId, own);
  else tokensBySession.delete(session.sessionId);
  if (viewTokens.size >= MAX_VIEW_TOKENS) {
    for (const [key, entry] of viewTokens) {
      if (entry.expiresAt <= now) deleteViewToken(key);
    }
    // Insertion order = mint order: drop the oldest.
    while (viewTokens.size >= MAX_VIEW_TOKENS) {
      const oldest = viewTokens.keys().next().value;
      if (oldest === undefined) break;
      deleteViewToken(oldest);
    }
  }
  const token = `cvw_${randomBytes(24).toString('base64url')}`;
  const expiresAt = now + VIEW_TOKEN_TTL_MS;
  viewTokens.set(token, { sessionId: session.sessionId, agentId: session.agentId, expiresAt });
  const list = tokensBySession.get(session.sessionId) ?? [];
  list.push(token);
  tokensBySession.set(session.sessionId, list);
  return { token, expiresAt };
}

/** Removes a token from the map and from its session's index. */
function deleteViewToken(token: string): void {
  const entry = viewTokens.get(token);
  if (!entry) return;
  viewTokens.delete(token);
  const list = tokensBySession.get(entry.sessionId);
  if (!list) return;
  const rest = list.filter((key) => key !== token);
  if (rest.length > 0) tokensBySession.set(entry.sessionId, rest);
  else tokensBySession.delete(entry.sessionId);
}

function lookupViewToken(token: unknown, now: number): ViewTokenEntry | null {
  if (typeof token !== 'string' || !VIEW_TOKEN_SHAPE.test(token)) return null;
  const entry = viewTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    deleteViewToken(token);
    return null;
  }
  return entry;
}

function viewTokenRefusedAnswer(): ToolAnswer {
  return {
    body: {
      ok: false,
      error: 'view_token_invalid',
      next: 'This viewToken is unknown or expired (a sessionId is never a viewToken). Call clawville_dashboard_open with your session for a new viewToken, then clawville_dashboard with it.',
    },
  };
}

export function callBudgetCountForTests(): number {
  return callBudgets.size;
}

function issueMcpSession(now: number, uiCapable: boolean): string {
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
  mcpSessions.set(id, { lastUsed: now, uiCapable });
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
  /** The MCP session named by Mcp-Session-Id, when the request sent one. */
  mcpSession: McpSessionEntry | null;
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

function buildRuntime(state: RequestState, session: ToolSession | null): ToolRuntime {
  return {
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
        state.issuedSessionId = issueMcpSession(state.now, declaresUiExtension(params));
      }
      return result({
        protocolVersion,
        // resources: the MCP App view ui://clawville/dashboard (resources/list,
        // resources/read). The MCP Apps extension needs no server-side
        // capability: the host declares it, and a host without it ignores
        // the tool `_meta.ui` link and reads the text answer.
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'clawville', title: 'ClawVille', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({
        // A client whose initialize did NOT declare MCP Apps support gets no
        // view-linked tool (it could not render the view; clawville_dashboard_open
        // gives it the text). An unknown client (no Mcp-Session-Id) gets them all.
        tools: MCP_TOOLS.filter((tool) => !tool.ui || state.mcpSession?.uiCapable !== false).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { title: tool.title, readOnlyHint: tool.readOnly, openWorldHint: false },
          // MCP Apps link, in the nested form and the legacy flat key the
          // ext-apps registerAppTool helper also writes.
          ...(tool.ui
            ? { _meta: { ui: { ...tool.ui }, [LEGACY_RESOURCE_URI_META_KEY]: tool.ui.resourceUri } }
            : {}),
        })),
      });
    case 'resources/list':
    case 'resources/templates/list':
    case 'resources/read': {
      // Static content, no session; the per-IP ceiling still applies.
      if (!allowCall(`ip:${state.clientIp}`, state.now, IP_CALLS_PER_MINUTE)) {
        return fail(-32000, 'Too many requests from this address. Wait a minute.');
      }
      if (message.method === 'resources/list') return result({ resources: [dashboardResourceListing()] });
      if (message.method === 'resources/templates/list') return result({ resourceTemplates: [] });
      if (typeof params.uri !== 'string' || params.uri.length === 0) return fail(-32602, 'params.uri must be a non-empty string');
      if (params.uri !== DASHBOARD_RESOURCE_URI) {
        // MCP spec: an unknown resource is -32002.
        return fail(-32002, `Resource not found: ${params.uri.slice(0, 64)}`);
      }
      return result({ contents: [dashboardResourceContent(resolveApiBase())] });
    }
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments;
      const tool = typeof name === 'string' ? findMcpTool(name) : undefined;
      if (!tool) return fail(-32602, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 64) : String(name)}`);
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return fail(-32602, 'arguments must be an object');
      }
      const toolResult = (text: string, isError = false, structuredContent?: Record<string, unknown>) =>
        result({ content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}), isError });
      const answerResult = (answer: ToolAnswer) => toolResult(answerText(answer), false, answer.structuredContent);
      // A rate refusal is an answer, not a tool error (some hosts trip a
      // breaker on repeated tool errors).
      const limited = () =>
        toolResult(JSON.stringify({ ok: false, error: 'rate_limited', next: `Wait a minute: at most ${MCP_CALLS_PER_MINUTE} tool calls per minute.` }));
      // Pre-DB ceiling per IP, so random bearers cannot drive session lookups.
      if (!allowCall(`ip:${state.clientIp}`, state.now, IP_CALLS_PER_MINUTE)) return limited();
      try {
        const toolArgs = (args ?? {}) as Record<string, unknown>;
        if (tool.name === DASHBOARD_TOOL || tool.name === DASHBOARD_REFRESH_TOOL) {
          // View-linked tools: the host forwards their arguments to the view,
          // so they take ONLY the view token; the session comes from it.
          // Unknown, malformed or expired tokens (a sessionId is never one)
          // and any other argument are refused before any DB read.
          const extra = Object.keys(toolArgs).filter((key) => key !== 'viewToken');
          if (extra.length > 0) {
            return answerResult({
              body: {
                ok: false,
                status: 400,
                error: 'invalid_input',
                data: { detail: `${tool.name} takes only viewToken; remove: ${extra.slice(0, 5).join(', ')}.` },
                next: `Call ${tool.name} {"viewToken": "<data.viewToken from clawville_dashboard_open>"}. Never send your sessionId to a view tool.`,
              },
            });
          }
          const entry = lookupViewToken(toolArgs.viewToken, state.now);
          if (!entry) return answerResult(viewTokenRefusedAnswer());
          if (state.explicit.kind === 'refused') {
            return answerResult(credentialRefusedAnswer(state.explicit.error, state.explicit.detail));
          }
          if (state.explicit.kind === 'sid' && state.explicit.sessionId !== entry.sessionId) {
            return answerResult(credentialRefusedAnswer('conflicting_credentials', 'The session header and the view token name different sessions.'));
          }
          if (!allowCall(`view:${String(toolArgs.viewToken)}`, state.now, VIEW_REFRESH_PER_MINUTE)) return limited();
          if (!allowCall(`sid:${entry.sessionId}`, state.now)) return limited();
          const live = await validator(entry.sessionId);
          if (!live || live.agentId !== entry.agentId) {
            deleteViewToken(String(toolArgs.viewToken));
            return answerResult(viewTokenRefusedAnswer());
          }
          const session: ToolSession = { sessionId: entry.sessionId, agentId: entry.agentId };
          const view = { token: String(toolArgs.viewToken), expiresAt: entry.expiresAt };
          return answerResult(await runDashboard(buildRuntime(state, session), session, resolveApiBase(), view, 'view'));
        }
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
        if (tool.name === DASHBOARD_OPEN_TOOL && session) {
          // Text for every host plus a view token for clawville_dashboard; this
          // tool has no `_meta.ui`, so no view ever sees its sessionId argument.
          const minted = mintViewToken(session, state.now);
          return answerResult(await runDashboard(buildRuntime(state, session), session, resolveApiBase(), minted, 'open'));
        }
        const answer = await runMcpTool(tool.name, tool.needsSession ? toolInput : toolArgs, buildRuntime(state, session));
        return answerResult(answer);
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
      // The header carries the version that `initialize` agreed. On `initialize`
      // itself the client may send a newer one (Hermes 0.22 sends 2025-11-25):
      // the body negotiation answers with a version we support, and the client
      // uses that one from then on. Every other request must carry a supported one.
      const version = c.req.header('mcp-protocol-version');
      if (!(isInitialize && !batch) && version && !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        return c.json(
          { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version.slice(0, 32)}` } },
          400,
          noStore,
        );
      }
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
      let mcpEntry: McpSessionEntry | null = null;
      if (headerSessionId) {
        mcpEntry = TOKEN_SHAPE.test(headerSessionId) ? lookupMcpSession(headerSessionId, now) : null;
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
        mcpSession: mcpEntry,
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
