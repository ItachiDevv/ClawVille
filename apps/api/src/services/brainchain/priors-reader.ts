import { z } from 'zod';
import { validateOutboundUrlResolved } from '../hatcher-config';

export class BrainChainPriorsReadError extends Error { readonly code = 'priors_read_unavailable'; }
const MCP = 'https://mcp.priors.trade/mcp';
const LINES = 'https://priors.trade/api/line-options';
const protocol = '2025-03-26';
const safeId = z.number().int().nonnegative().safe();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const decimal = z.string().regex(/^(0|[1-9]\d{0,77})(?:\.\d{1,18})?$/);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ offset: true });
export const priorsRecordSchema = z.object({
  agentId: safeId, owner: address, isRoot: z.boolean(), backer: z.object({ agentId: safeId }).nullable(), premiumBps: z.number().int().min(0).max(10_000),
  line: decimal, available: decimal, drawn: decimal, loansRepaid: count, qualifiedRepaid: count, volumeRepaid: decimal, feesPaid: decimal,
  score: z.number().int().min(0).max(1000), defaulted: z.boolean(), frozen: z.boolean(), asOf: timestamp,
  // Public fixtures establish an empty list only. Do not invent a hosted loan-terms schema.
  openLoans: z.array(z.unknown()).max(64),
});
const route = z.object({ route: z.enum(['treasury_invite', 'ethos_lane', 'stock_line', 'own_priors']), open: z.boolean().nullable(),
  line: decimal.nullable().optional(), bond: decimal.nullable().optional(), room: decimal.nullable().optional(),
  upTo: decimal.nullable().optional(), maxLine: decimal.nullable().optional(), weekLeft: decimal.nullable().optional() });
export const priorsRoutesSchema = z.object({ agentId: safeId, owner: address, recordRead: z.boolean(), record: z.object({}).nullable(),
  ownerDefaulted: z.boolean().nullable(), routes: z.array(route).max(4),
  asOf: z.object({ snapshot: timestamp.nullable(), stocks: timestamp.nullable(), directoryBlock: safeId.nullable() }),
}).refine(value => new Set(value.routes.map(entry => entry.route)).size === value.routes.length);

/** Fixed initialize + agent_record only. No caller-selected method, tool, URL, or headers. */
export function createBrainChainPriorsReader(overrides: {
  fetch?: typeof fetch; validateUrl?: typeof validateOutboundUrlResolved; timeoutMs?: number;
} = {}) {
  const deadline = Date.now() + 20_000;
  let session: string | undefined;
  async function request(url: string, body?: Record<string, unknown>): Promise<unknown> {
    // Both URL forms originate here; the caller supplies only a validated integer ID.
    if (url !== MCP && !/^https:\/\/priors\.trade\/api\/line-options\?id=\d{1,16}$/.test(url)) throw new BrainChainPriorsReadError('Unsupported read');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BrainChainPriorsReadError('Read deadline');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrainChainPriorsReadError('Read deadline')); }, Math.min(remaining, overrides.timeoutMs ?? 5000)); });
    const read = async () => {
      const approved = await (overrides.validateUrl ?? validateOutboundUrlResolved)(url);
      if (!approved.ok || controller.signal.aborted) throw new BrainChainPriorsReadError('Read host unavailable');
      const response = await (overrides.fetch ?? fetch)(url, { method: body ? 'POST' : 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Accept: body ? 'application/json, text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json', 'MCP-Protocol-Version': protocol,
          ...(session ? { 'Mcp-Session-Id': session } : {}) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (response.status !== 200 || !response.body || (type !== 'application/json' && !(body && type === 'text/event-stream'))) {
        await response.body?.cancel(); throw new BrainChainPriorsReadError('Read response unavailable');
      }
      const returnedSession = response.headers.get('mcp-session-id');
      if (body && returnedSession !== null) {
        if (!/^[\x21-\x7e]{1,128}$/.test(returnedSession) || (session && returnedSession !== session)) throw new BrainChainPriorsReadError('Invalid read session');
        session = returnedSession;
      }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 131_072) { await reader.cancel(); throw new BrainChainPriorsReadError('Read response too large'); }
          chunks.push(chunk.value);
        }
      } finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
      if (controller.signal.aborted) throw new BrainChainPriorsReadError('Read aborted');
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (type === 'application/json') return JSON.parse(text) as unknown;
      // One bounded SSE response envelope; never interpret text, tool requests, links, or notifications.
      const events = text.replace(/\r\n/g, '\n').split('\n\n').filter(part => part.split('\n').some(line => line.startsWith('data:')));
      const envelopes = events.map(event => JSON.parse(event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) as unknown);
      const selected = envelopes.filter(value => value && typeof value === 'object' && 'id' in value && value.id === body?.id);
      if (selected.length !== 1) throw new BrainChainPriorsReadError('Invalid read envelope');
      return selected[0];
    };
    try { return await Promise.race([read(), timeout]); }
    catch { throw new BrainChainPriorsReadError('Priors read failed'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  function envelope(value: unknown, id: number) {
    return z.object({ jsonrpc: z.literal('2.0'), id: z.literal(id), result: z.object({}).passthrough(), error: z.never().optional() }).parse(value).result;
  }
  async function record(agentId: number) {
    safeId.parse(agentId);
    const initialized = envelope(await request(MCP, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'ClawVille-readonly', version: '1' } } }), 1);
    z.object({ protocolVersion: z.literal(protocol) }).parse(initialized);
    const result = envelope(await request(MCP, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_record', arguments: { agent_id: agentId } } }), 2);
    const payload = z.object({ isError: z.literal(false).optional(), structuredContent: priorsRecordSchema }).parse(result);
    return payload.structuredContent;
  }
  async function routes(agentId: number) {
    safeId.parse(agentId);
    const result = z.object({ data: priorsRoutesSchema }).parse(await request(`${LINES}?id=${agentId}`));
    return result.data;
  }
  return { record, routes };
}
