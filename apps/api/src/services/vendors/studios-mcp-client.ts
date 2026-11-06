/**
 * Minimal Streamable HTTP MCP client for the Studios MCP server
 * (`https://mcp.mystudios.fun/mcp`), MCP hub phase 3c.
 *
 * Only `initialize` (+ `notifications/initialized`) and `tools/call` with a
 * FIXED allowlist of tool names. A name outside the allowlist throws before
 * any token lookup or network call. The bearer token comes from
 * `studios-oauth.ts getAccessToken` (the human's own Studios sign-in); on a
 * 401 the token is refreshed once and the call is tried once more, then it
 * fails typed. Replies may be `application/json` or `text/event-stream`.
 *
 * The raw tool `result` object goes back to the caller, which maps each tool's
 * fields to our own (`studios-signin.ts`; the pipeline in `studios-images.ts`).
 * A failure on or after the `tools/call` send carries `toolCallSent`, so the
 * caller never says "nothing was paid" for a call Studios may have run. Tool output is untrusted: it is never
 * logged and never relayed as-is to a model. `tools/list` is not used to build
 * any menu; `listToolNamesForVerification` exists only for an ops check / test.
 *
 * Hand-written (no SDK dependency), like our own MCP server in routes/agent-mcp.ts.
 */

import { z } from 'zod';
import { getAccessToken } from './studios-oauth';

export const STUDIOS_MCP_URL = 'https://mcp.mystudios.fun/mcp';
export const STUDIOS_MCP_PROTOCOL_VERSION = '2025-06-18';
/** Versions with the Streamable HTTP transport that this client can speak. */
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set(['2025-06-18', '2025-03-26']);

export const STUDIOS_MCP_TOOLS = [
  'create_image',
  'create_video',
  'create_character_shots',
  'recast',
  'get_job',
  'get_account',
  'list_media',
  'list_options',
  'start_upload',
  'upload_media',
] as const;
export type StudiosMcpToolName = (typeof STUDIOS_MCP_TOOLS)[number];
const TOOL_ALLOWLIST: ReadonlySet<string> = new Set(STUDIOS_MCP_TOOLS);

export function isStudiosMcpTool(name: string): name is StudiosMcpToolName {
  return TOOL_ALLOWLIST.has(name);
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Image results may carry base64 bytes; anything larger is refused. */
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

export type StudiosMcpErrorCode =
  | 'studios_mcp_tool_not_allowed'
  | 'studios_mcp_unauthorized'
  | 'studios_mcp_unavailable'
  | 'studios_mcp_session_expired'
  | 'studios_mcp_protocol_mismatch'
  | 'studios_mcp_bad_response'
  | 'studios_mcp_rpc_error';

const ERROR_MESSAGES: Record<StudiosMcpErrorCode, string> = {
  studios_mcp_tool_not_allowed: 'That Studios tool is not on the ClawVille list.',
  studios_mcp_unauthorized: 'Studios refused the sign-in token.',
  studios_mcp_unavailable: 'Studios did not answer. Try again later.',
  studios_mcp_session_expired: 'The Studios session ended. Try again.',
  studios_mcp_protocol_mismatch: 'Studios answered with an MCP version ClawVille does not speak.',
  studios_mcp_bad_response: 'Studios sent a reply that ClawVille could not read.',
  studios_mcp_rpc_error: 'Studios returned an error for this call.',
};

/** A typed failure. The message is our own text; vendor text is never included. */
export class StudiosMcpError extends Error {
  readonly code: StudiosMcpErrorCode;
  /** HTTP status of the failed reply, when there was one. */
  readonly httpStatus: number | null;
  /** JSON-RPC error code from Studios (a number only, never its message). */
  readonly rpcCode: number | null;
  /**
   * True when the failure came on or after the `tools/call` send: Studios may
   * have run (and billed) the tool. False: the session setup failed, or
   * Studios answered 401, so the tool did not run.
   */
  readonly toolCallSent: boolean;
  constructor(code: StudiosMcpErrorCode, detail: { httpStatus?: number | null; rpcCode?: number | null; toolCallSent?: boolean } = {}) {
    super(ERROR_MESSAGES[code]);
    this.name = 'StudiosMcpError';
    this.code = code;
    this.httpStatus = detail.httpStatus ?? null;
    this.rpcCode = detail.rpcCode ?? null;
    this.toolCallSent = detail.toolCallSent ?? false;
  }
}

export type GetStudiosToken = (avatarId: string, options?: { rejectedToken?: string }) => Promise<string>;

export interface StudiosMcpClientOptions {
  avatarId: string;
  /** Default: studios-oauth getAccessToken. */
  getToken?: GetStudiosToken;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /**
   * Test only: a loopback mock server. Refused outside NODE_ENV=test and for
   * any non-loopback host, so a token can never go anywhere but Studios.
   */
  endpoint?: string;
}

export interface StudiosToolResult {
  /** The tool's own `isError` flag (a tool-level failure, not a transport one). */
  isError: boolean;
  /** The raw MCP `result` object. Untrusted: map fields, never relay or log it. */
  result: Record<string, unknown>;
}

const rpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.record(z.unknown()),
});
const rpcFailureSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({ code: z.number() }),
});
type RpcResponse =
  | { ok: true; id: string | number; result: Record<string, unknown> }
  | { ok: false; id: string | number | null; errorCode: number };

function parseRpcResponse(item: unknown): RpcResponse | null {
  const success = rpcSuccessSchema.safeParse(item);
  if (success.success) return { ok: true, id: success.data.id, result: success.data.result };
  const failure = rpcFailureSchema.safeParse(item);
  if (failure.success) return { ok: false, id: failure.data.id, errorCode: failure.data.error.code };
  return null;
}

const initializeResultSchema = z.object({ protocolVersion: z.string().max(32) }).passthrough();
const toolsListResultSchema = z.object({
  tools: z.array(z.object({ name: z.string().max(128) }).passthrough()).max(500),
  nextCursor: z.string().max(1024).optional(),
}).passthrough();

function resolveEndpoint(endpoint: string | undefined): string {
  if (endpoint === undefined || endpoint === STUDIOS_MCP_URL) return STUDIOS_MCP_URL;
  if (process.env.NODE_ENV !== 'test') throw new Error('studios-mcp-client: endpoint override is test-only');
  const host = new URL(endpoint).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error('studios-mcp-client: test endpoint must be loopback');
  }
  return endpoint;
}

class Unauthorized extends Error {}

/** Read a body up to MAX_RESPONSE_BYTES (exported for tests). */
export async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    // Release the connection before failing.
    await res.body?.cancel().catch(() => {});
    throw new StudiosMcpError('studios_mcp_bad_response', { httpStatus: res.status });
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new StudiosMcpError('studios_mcp_bad_response', { httpStatus: res.status });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Pick the JSON-RPC response with this id from one parsed message or a batch. */
function matchResponse(payload: unknown, id: number): RpcResponse | null {
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    const parsed = parseRpcResponse(item);
    if (parsed && parsed.id === id) return parsed;
  }
  return null;
}

/**
 * Read an SSE stream until the response with this id arrives. Notifications
 * and server requests on the stream are ignored. Stops reading at the match.
 */
async function readSseResponse(res: Response, id: number): Promise<RpcResponse> {
  if (!res.body) throw new StudiosMcpError('studios_mcp_bad_response', { httpStatus: res.status });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let dataLines: string[] = [];
  const finishEvent = (): RpcResponse | null => {
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    dataLines = [];
    try {
      return matchResponse(JSON.parse(data), id);
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new StudiosMcpError('studios_mcp_bad_response', { httpStatus: res.status });
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += '\n\n';
      let newline = buffer.search(/\r\n|\r|\n/);
      while (newline !== -1) {
        // A `\r` at the end of the bytes so far may be the first half of `\r\n`.
        if (!done && newline === buffer.length - 1 && buffer[newline] === '\r') break;
        const line = buffer.slice(0, newline);
        const sepLength = buffer.startsWith('\r\n', newline) ? 2 : 1;
        buffer = buffer.slice(newline + sepLength);
        if (line === '') {
          const match = finishEvent();
          if (match) return match;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // `event:`, `id:`, `retry:` and `:` comment lines are ignored.
        newline = buffer.search(/\r\n|\r|\n/);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new StudiosMcpError('studios_mcp_bad_response', { httpStatus: res.status });
}

class StudiosMcpSession {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  private async send(body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new StudiosMcpError('studios_mcp_unavailable');
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      throw new Unauthorized();
    }
    if (res.status === 404 && this.sessionId) {
      await res.body?.cancel().catch(() => {});
      throw new StudiosMcpError('studios_mcp_session_expired', { httpStatus: 404 });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const code = res.status >= 500 || res.status === 429 ? 'studios_mcp_unavailable' : 'studios_mcp_bad_response';
      throw new StudiosMcpError(code, { httpStatus: res.status });
    }
    return res;
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await this.send({ jsonrpc: '2.0', id, method, params });
    if (method === 'initialize') {
      const sid = res.headers.get('mcp-session-id');
      // Visible ASCII only (MCP transport rule); anything else is not kept.
      if (sid && /^[\x21-\x7e]{1,256}$/.test(sid)) this.sessionId = sid;
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    let response: RpcResponse | null;
    try {
      if (type.includes('text/event-stream')) {
        response = await readSseResponse(res, id);
      } else if (type.includes('application/json')) {
        const bytes = await readCapped(res);
        response = matchResponse(JSON.parse(new TextDecoder().decode(bytes)), id);
      } else {
        await res.body?.cancel().catch(() => {});
        response = null;
      }
    } catch (err) {
      if (err instanceof StudiosMcpError) throw err;
      throw new StudiosMcpError(
        err instanceof DOMException || (err as Error)?.name === 'TimeoutError' ? 'studios_mcp_unavailable' : 'studios_mcp_bad_response',
        { httpStatus: res.status },
      );
    }
    if (!response) throw new StudiosMcpError('studios_mcp_bad_response', { httpStatus: res.status });
    if (!response.ok) throw new StudiosMcpError('studios_mcp_rpc_error', { rpcCode: response.errorCode });
    return response.result;
  }

  async notify(method: string): Promise<void> {
    const res = await this.send({ jsonrpc: '2.0', method });
    await res.body?.cancel().catch(() => {});
  }

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: STUDIOS_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ClawVille', version: '1.0.0' },
    });
    const parsed = initializeResultSchema.safeParse(result);
    if (!parsed.success) throw new StudiosMcpError('studios_mcp_bad_response');
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(parsed.data.protocolVersion)) {
      throw new StudiosMcpError('studios_mcp_protocol_mismatch');
    }
    this.protocolVersion = parsed.data.protocolVersion;
    await this.notify('notifications/initialized');
  }

  /** Best effort: tell the server the session is over (MCP DELETE). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const res = await fetch(this.endpoint, {
        method: 'DELETE',
        headers: this.headers(),
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      // The server ends idle sessions on its own.
    }
  }
}

/**
 * Open a session, run `work`, close the session. On a 401 at any step the
 * token is refreshed once (`rejectedToken`) and the whole sequence runs once
 * more on a new session; a second 401 fails as `studios_mcp_unauthorized`.
 */
async function withSession<T>(options: StudiosMcpClientOptions, work: (session: StudiosMcpSession) => Promise<T>): Promise<T> {
  const endpoint = resolveEndpoint(options.endpoint);
  const getToken = options.getToken ?? getAccessToken;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let token = await getToken(options.avatarId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = new StudiosMcpSession(endpoint, timeoutMs, token);
    try {
      await session.initialize();
      return await work(session);
    } catch (err) {
      if (!(err instanceof Unauthorized)) throw err;
      if (attempt === 1) throw new StudiosMcpError('studios_mcp_unauthorized', { httpStatus: 401 });
      token = await getToken(options.avatarId, { rejectedToken: token });
    } finally {
      // Not awaited: a server that hangs on DELETE must not slow the call.
      void session.close();
    }
  }
  throw new StudiosMcpError('studios_mcp_unauthorized', { httpStatus: 401 });
}

/**
 * Call one allowlisted Studios tool. Throws `studios_mcp_tool_not_allowed`
 * before any token lookup or network call for a name outside the list.
 * NOTE: a tool that spends credits is billed by Studios; callers must hold the
 * request row + spend rules before calling (the ambiguous outcome is never retried here
 * except after a 401, when Studios did not run the call).
 */
export async function callStudiosTool(
  options: StudiosMcpClientOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<StudiosToolResult> {
  if (!isStudiosMcpTool(name)) throw new StudiosMcpError('studios_mcp_tool_not_allowed');
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('callStudiosTool: arguments must be an object');
  }
  return withSession(options, async (session) => {
    try {
      const result = await session.request('tools/call', { name, arguments: args });
      return { isError: result.isError === true, result };
    } catch (err) {
      // A 401 (Unauthorized) passes on for the one refresh: the tool did not run.
      if (!(err instanceof StudiosMcpError)) throw err;
      throw new StudiosMcpError(err.code, { httpStatus: err.httpStatus, rpcCode: err.rpcCode, toolCallSent: true });
    }
  });
}

/**
 * OPS / TEST ONLY: the tool names the server lists, to check our allowlist
 * against the live server. Never used to build a menu; descriptions are dropped.
 */
export async function listToolNamesForVerification(options: StudiosMcpClientOptions): Promise<string[]> {
  return withSession(options, async (session) => {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await session.request('tools/list', cursor ? { cursor } : {});
      const parsed = toolsListResultSchema.safeParse(result);
      if (!parsed.success) throw new StudiosMcpError('studios_mcp_bad_response');
      for (const tool of parsed.data.tools) names.push(tool.name);
      cursor = parsed.data.nextCursor;
      if (!cursor) break;
    }
    return names;
  });
}
