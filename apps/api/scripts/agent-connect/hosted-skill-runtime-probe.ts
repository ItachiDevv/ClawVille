#!/usr/bin/env bun
/**
 * Release gate for hosted skill/manual prompt composition.
 *
 * The probe owns short-lived database fixtures and must run on the same host as
 * the API process so both loopback gateway mocks are reachable from that process.
 * It never prints response bodies, prompts, cookies, database URLs, or secrets.
 */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';

const PROD_API_HOSTS = new Set(['api.clawville.world', 'api-new.clawville.world', 'clawville.world']);
const PROD_DATABASE_REF = 'wheuidgiyyccqyoppxoa';
const STAGING_DATABASE_REF = 'mtpixvtclsjqjguouxes';
const HERMES_PROXY_PORT = 8642;
const MAX_CAPTURED_REQUESTS = 12;
const MAX_GATEWAY_BODY_BYTES = 2_000_000;
const MOCK_HERMES_MARKER = 'HERMES_MOCK_REPLY_V1';
const DECLARED_GATEWAY_MARKER = 'CV_PROBE_DECLARED_GATEWAY_REPLY';

const cliSchema = z.object({
  api: z.string().url(),
  keep: z.boolean(),
  withEcho: z.boolean(),
}).strict();

const claimResponseSchema = z.object({
  ok: z.literal(true),
  buildingId: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  installed: z.enum(['runtime', 'marker', 'already']),
});

const chatResponseSchema = z.object({
  message: z.object({
    role: z.literal('assistant'),
    content: z.string(),
    timestamp: z.string().min(1),
  }),
});

const gatewayRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.string().min(1),
    content: z.string().max(MAX_GATEWAY_BODY_BYTES),
  }).passthrough()).min(1).max(200),
}).passthrough();

const skillMetadataSchema = z.object({
  buildingId: z.string().min(1),
}).passthrough();

class ProbeFailure extends Error {}

interface CliOptions {
  api: string;
  keep: boolean;
  withEcho: boolean;
}

interface Fixture {
  userId: string;
  avatarId: string;
  platformAgentId: string;
  sessionId: string;
  cookie: string;
  name: string;
}

interface CapturedGatewayRequest {
  prompts: string[];
}

interface ProtocolEvidence {
  title: string;
  versionLine: string;
  walletLine: string;
  version: number;
}

let assertionNumber = 0;
const probeAbortController = new AbortController();
function ok(condition: unknown, message: string): asserts condition {
  assertionNumber += 1;
  if (!condition) throw new ProbeFailure(`${assertionNumber}. FAIL ${message}`);
  console.log(`${assertionNumber}. OK ${message}`);
}

function throwIfInterrupted(): void {
  if (probeAbortController.signal.aborted) throw new ProbeFailure('probe interrupted');
}

function parseCli(args: string[]): CliOptions {
  const parsed: Record<string, unknown> = { keep: false, withEcho: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === '--keep') {
      if (seen.has(item)) throw new ProbeFailure('usage: duplicate argument');
      seen.add(item);
      parsed.keep = true;
    } else if (item === '--with-echo') {
      if (seen.has(item)) throw new ProbeFailure('usage: duplicate argument');
      seen.add(item);
      parsed.withEcho = true;
    } else if (item === '--api') {
      if (seen.has(item)) throw new ProbeFailure('usage: duplicate argument');
      seen.add(item);
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new ProbeFailure('usage: --api requires an absolute API base URL');
      }
      parsed.api = value;
      i += 1;
    } else {
      throw new ProbeFailure('usage: unknown argument');
    }
  }
  const result = cliSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProbeFailure(
      'usage: bun run apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api <base> [--keep] [--with-echo]',
    );
  }
  return result.data;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function normalizeAndValidateApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeFailure('--api must be an absolute http(s) URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProbeFailure('--api must use http or https');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ProbeFailure('--api must be an origin without credentials, path, query, or fragment');
  }
  if (PROD_API_HOSTS.has(hostname) || hostname.endsWith('.api.clawville.world')) {
    throw new ProbeFailure('production API targets are forbidden');
  }
  if (!isLoopbackHost(hostname) && hostname !== 'api-staging.clawville.world') {
    throw new ProbeFailure('--api must target loopback or the staging API');
  }
  return url.toString().replace(/\/$/, '');
}

interface ValidatedDatabaseTarget {
  logicalIdentity: string;
}

function validateDatabaseUrl(
  name: 'DATABASE_URL' | 'ELIZA_DATABASE_URL',
  raw: string | undefined,
): ValidatedDatabaseTarget | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeFailure(`${name} is not a valid database URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ProbeFailure(`${name} must use postgres or postgresql`);
  }
  const hostname = url.hostname.toLowerCase();
  let username = url.username.toLowerCase();
  try {
    username = decodeURIComponent(username);
  } catch {
    throw new ProbeFailure(`${name} has an invalid encoded username`);
  }
  const isKnownProd =
    hostname === `db.${PROD_DATABASE_REF}.supabase.co`
    || username === `postgres.${PROD_DATABASE_REF}`;
  if (isKnownProd) {
    throw new ProbeFailure(`${name} points at the forbidden production database`);
  }
  const isLocalDatabase = isLoopbackHost(hostname) || hostname === 'postgres' || hostname.endsWith('.local');
  const isDirectStagingDatabase =
    hostname === `db.${STAGING_DATABASE_REF}.supabase.co`
    && username === 'postgres';
  const isStagingPooler =
    hostname.endsWith('.pooler.supabase.com')
    && username === `postgres.${STAGING_DATABASE_REF}`;
  const isStagingDatabase = isDirectStagingDatabase || isStagingPooler;
  if (!isLocalDatabase && !isStagingDatabase) {
    throw new ProbeFailure(`${name} must target a local database or the isolated staging database`);
  }
  const logicalIdentity = isStagingDatabase
    ? `staging:${STAGING_DATABASE_REF}:${url.pathname}`
    : `local:${isLoopbackHost(hostname) ? 'loopback' : hostname}:${username}:${url.pathname}`;
  return { logicalIdentity };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 120_000,
  respectProbeAbort = true,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = respectProbeAbort
      ? AbortSignal.any([controller.signal, probeAbortController.signal])
      : controller.signal;
    return await fetch(url, { ...init, signal });
  } catch {
    throw new ProbeFailure('API request failed or timed out');
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new ProbeFailure(`API returned HTTP ${response.status}`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ProbeFailure('API response was not JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProbeFailure('API response contract mismatch');
  return parsed.data;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildCanarySkill(buildingId: string, canary: string): string {
  return `---
name: ${buildingId}
description: Temporary hosted runtime prompt-composition probe.
version: 1.0.0
---
# Hosted Runtime Probe

This temporary claimed building skill exists only for an isolated release-gate run.

## Unique Canary

When asked for the hosted runtime probe's unique canary token, answer exactly: ${canary}
The unique canary is learned only from this claimed building skill.
`;
}

function deriveProtocolEvidence(
  apiBase: string,
  source: { buildProtocolManual: (base: string) => string; PROTOCOL_VERSION: number },
): ProtocolEvidence {
  const manual = source.buildProtocolManual(apiBase);
  const title = manual.split('\n').find((line) => line.startsWith('# '));
  const versionLine = manual
    .split('\n')
    .find((line) => line.trim().endsWith(String(source.PROTOCOL_VERSION)) && line.includes('protocol_version'));
  const walletLine = manual
    .split('\n')
    .find((line) => line.includes('top-level `walletAddress` always equals `wallet.address`'));
  if (!title || !versionLine || !walletLine) {
    throw new ProbeFailure('could not derive protocol evidence from the source-generated manual');
  }
  return { title, versionLine, walletLine, version: source.PROTOCOL_VERSION };
}

function currentStateContext(prompt: string): string {
  const start = prompt.indexOf('[Current state context]');
  if (start < 0) return '';
  const userBoundary = prompt.lastIndexOf('\n\nUser:');
  return prompt.slice(start, userBoundary > start ? userBoundary : prompt.length);
}

function promptHasEvidence(
  prompt: string,
  canary: string,
  protocol: ProtocolEvidence,
): boolean {
  const context = currentStateContext(prompt);
  return context.includes(canary)
    && context.includes(protocol.title)
    && context.includes(protocol.versionLine)
    && context.includes(protocol.walletLine)
    && context.includes(String(protocol.version));
}

async function insertFixture(
  client: postgres.Sql,
  input: {
    runId: string;
    gatewayUrl?: string;
    kind: 'declared-gateway' | 'echo';
  },
): Promise<Fixture> {
  // Resolve the cookie serializer before any mutation so an import failure
  // cannot strand a committed fixture whose IDs were never returned to cleanup.
  const { lucia } = await import('../../src/lib/auth');
  const userId = randomUUID();
  const avatarId = randomUUID();
  const platformAgentId = randomUUID();
  const sessionId = randomUUID();
  const cookie = lucia.createSessionCookie(sessionId).serialize();
  const short = input.runId.slice(0, 8);
  const name = `Probe${input.kind === 'echo' ? 'E' : 'G'}${short}`.slice(0, 20);
  const fingerprint = sha256Hex(`hosted-skill-runtime-probe:${input.runId}:${input.kind}`);
  const customization: Record<string, unknown> = {
    bio: ['Temporary hosted runtime prompt-composition probe.'],
    knowledge: [],
    ...(input.gatewayUrl
      ? {
          gateway: {
            gatewayUrl: input.gatewayUrl,
            authToken: '',
            agentId: `probe-${input.runId}`,
            protocol: 'openai-compat',
            modelName: 'probe-model',
            timeoutMs: 30_000,
          },
        }
      : {}),
  };
  // DEFAULT config on purpose (no houseAgentId flag): since 2026-07-17 the
  // orchestrator injects the manual into EVERY player runtime class, and this
  // probe must exercise the ordinary declared-gateway `openclaw-bot` path — a
  // fixture that rides a special-case branch would let per-class regressions
  // through the gate (the founder's uniformity directive: one result counts,
  // every agent class getting the same skill injection).
  const config = {};
  const agentType = input.kind === 'declared-gateway' ? 'openclaw-bot' : 'avatar-agent';

  await client.begin(async (tx) => {
    await tx`
      INSERT INTO users (id, name, identity_fingerprint, is_guest)
      VALUES (${userId}, ${name}, ${fingerprint}, false)
    `;
    await tx`
      INSERT INTO platform_agents (id, user_id, name, type, status, customization, config)
      VALUES (
        ${platformAgentId}, ${userId}, ${name}, ${agentType}, 'pending',
        ${JSON.stringify(customization)}::jsonb, ${JSON.stringify(config)}::jsonb
      )
    `;
    await tx`
      INSERT INTO avatars (
        id, user_id, name, species, color, gender, archetype,
        personality, stats, character_config, platform_agent_id,
        claw_tokens, soft_balance, bought_balance, earned_balance,
        agent_category, model_key, harness, is_active, is_guest
      ) VALUES (
        ${avatarId}, ${userId}, ${name}, 'cat', 'blue', 'female', 'brave-adventurer',
        ${tx.json({ habitat: 'sea', hobby: 'reading-and-learning', greeting: 'Hello' })},
        ${tx.json({ strength: 5, defence: 5, movement: 5 })},
        ${tx.json({
          bio: ['Temporary probe.'], greeting: 'Hello', tone: 'concise', topics: ['verification'],
          adjectives: ['precise'], rules: [], style: { all: [], chat: [], post: [] },
          messageExamples: [], lore: [], knowledge: [],
        })},
        ${platformAgentId}, 1000, 1000, 0, 0, 'openclaw', 'lobster', 'milady', true, false
      )
    `;
    await tx`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (${sessionId}, ${userId}, ${new Date(Date.now() + 60 * 60 * 1000)})
    `;
  });

  return {
    userId,
    avatarId,
    platformAgentId,
    sessionId,
    cookie,
    name,
  };
}

async function insertCanarySkill(
  client: postgres.Sql,
  buildingId: string,
  content: string,
): Promise<void> {
  const contentHash = sha256Hex(content);
  await client`
    INSERT INTO building_skills (
      building_id, name, description, content, source_article_ids,
      generator_version, content_hash
    ) VALUES (
      ${buildingId}, ${buildingId}, 'Temporary hosted runtime prompt-composition probe.',
      ${content}, ${client.json([])}, 1, ${contentHash}
    )
  `;
}

async function claimSkill(
  apiBase: string,
  fixture: Fixture,
  buildingId: string,
): Promise<z.infer<typeof claimResponseSchema>> {
  return parseJson(
    await fetchWithTimeout(`${apiBase}/api/skills/${encodeURIComponent(buildingId)}/claim`, {
      method: 'POST',
      headers: { Cookie: fixture.cookie },
    }),
    claimResponseSchema,
  );
}

async function founderChat(
  apiBase: string,
  fixture: Fixture,
  content: string,
): Promise<z.infer<typeof chatResponseSchema>> {
  return parseJson(
    await fetchWithTimeout(`${apiBase}/api/avatars/me/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fixture.cookie },
      body: JSON.stringify({ content }),
    }),
    chatResponseSchema,
  );
}

async function waitForKnowledge(
  client: postgres.Sql,
  fixture: Fixture,
  buildingId: string,
  canary: string,
  protocolVersion: number,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const rows = await client<Array<{ skill_ready: boolean; protocol_ready: boolean }>>`
      SELECT
        EXISTS (
          SELECT 1 FROM memories
          WHERE agent_id = ${fixture.platformAgentId}::uuid
            AND metadata->>'subtype' = 'building-skill'
            AND metadata->>'buildingId' = ${buildingId}
            AND content->>'text' LIKE ${`%${canary}%`}
        ) AS skill_ready,
        EXISTS (
          SELECT 1 FROM memories
          WHERE agent_id = ${fixture.platformAgentId}::uuid
            AND metadata->>'subtype' = 'protocol-knowledge'
            AND (metadata->>'version')::int = ${protocolVersion}
        ) AS protocol_ready
    `;
    if (rows[0]?.skill_ready && rows[0]?.protocol_ready) return;
    await Bun.sleep(250);
  }
  throw new ProbeFailure('timed out waiting for current skill and protocol memories');
}

async function startDeclaredGatewayMock(): Promise<{
  server: ReturnType<typeof Bun.serve>;
  captured: CapturedGatewayRequest[];
}> {
  const captured: CapturedGatewayRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true });
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      const declaredLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_GATEWAY_BODY_BYTES) {
        return Response.json({ error: 'body_too_large' }, { status: 413 });
      }
      let raw: unknown;
      try {
        const text = await request.text();
        if (text.length > MAX_GATEWAY_BODY_BYTES) {
          return Response.json({ error: 'body_too_large' }, { status: 413 });
        }
        raw = JSON.parse(text) as unknown;
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      const parsed = gatewayRequestSchema.safeParse(raw);
      if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
      if (captured.length < MAX_CAPTURED_REQUESTS) {
        captured.push({ prompts: parsed.data.messages.map((message) => message.content) });
      }
      return Response.json({
        id: `probe-${captured.length}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: DECLARED_GATEWAY_MARKER },
          finish_reason: 'stop',
        }],
      });
    },
  });
  return { server, captured };
}

async function assertPortAvailable(port: number): Promise<void> {
  let probe: ReturnType<typeof Bun.serve> | null = null;
  try {
    probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') });
  } catch {
    throw new ProbeFailure(`required loopback port ${port} is already occupied`);
  } finally {
    probe?.stop(true);
  }
}

async function reserveAlternatePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new ProbeFailure('could not reserve an alternate loopback port');
  return port;
}

async function waitForMockHermes(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The child has not bound yet.
    }
    await Bun.sleep(100);
  }
  throw new ProbeFailure('mock Hermes child did not become healthy');
}

async function runHermesLane(composedPrompt: string): Promise<CapturedGatewayRequest[]> {
  await assertPortAvailable(HERMES_PROXY_PORT);
  const alternatePort = await reserveAlternatePort();
  const mockPath = resolve('apps/api/scripts/agent-connect/mock-hermes-server.ts');
  const child = Bun.spawn(
    [process.execPath, 'run', mockPath, '--port', String(alternatePort)],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
  );
  let stdoutDrain: Promise<ArrayBuffer> = Promise.resolve(new ArrayBuffer(0));
  let stderrDrain: Promise<ArrayBuffer> = Promise.resolve(new ArrayBuffer(0));
  let proxy: ReturnType<typeof Bun.serve> | null = null;
  const captured: CapturedGatewayRequest[] = [];
  try {
    stdoutDrain = new Response(child.stdout).arrayBuffer().catch(() => new ArrayBuffer(0));
    stderrDrain = new Response(child.stderr).arrayBuffer().catch(() => new ArrayBuffer(0));
    await waitForMockHermes(alternatePort);
    proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: HERMES_PROXY_PORT,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        let bodyText: string;
        try {
          bodyText = await request.text();
          if (bodyText.length > MAX_GATEWAY_BODY_BYTES) {
            return Response.json({ error: 'body_too_large' }, { status: 413 });
          }
          const parsed = gatewayRequestSchema.safeParse(JSON.parse(bodyText) as unknown);
          if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
          if (captured.length < MAX_CAPTURED_REQUESTS) {
            captured.push({ prompts: parsed.data.messages.map((message) => message.content) });
          }
        } catch {
          return Response.json({ error: 'invalid_json' }, { status: 400 });
        }
        return fetch(`http://127.0.0.1:${alternatePort}${url.pathname}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyText,
          redirect: 'manual',
        });
      },
    });

    process.env.FINGERPRINT_SECRET ??= 'a'.repeat(64);
    process.env.VANITY_ENCRYPTION_KEY ??= 'b'.repeat(64);
    process.env.CLAWVILLE_SERVICE_ISSUER_SK ??= 'c'.repeat(64);
    process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY ??= 'd'.repeat(64);
    process.env.CLOUDFLARE_WORKER_URL ??= 'https://example.invalid';
    process.env.CLOUDFLARE_WORKER_BEARER ??= 'x';
    process.env.PARTNER_PUBKEYS ??= '{}';
    const { AgentSubstrateClient } = await import('../../src/services/agent-substrate-client');
    const client = new AgentSubstrateClient({
      agentId: 'hosted-skill-runtime-probe-hermes',
      sessionId: 'hosted-skill-runtime-probe-session',
      gatewayUrl: 'http://localhost:0',
      authToken: '',
      protocol: 'hermes-local',
      species: 'milady_official_1',
      color: 0x888888,
    } as never);
    const reply = await client.chat([{ role: 'user', content: composedPrompt }]);
    ok(reply.includes(MOCK_HERMES_MARKER), 'Lane B traversed chatHermesLocal and the repository mock');
    return captured;
  } finally {
    proxy?.stop(true);
    child.kill();
    await child.exited.catch(() => -1);
    await Promise.all([stdoutDrain, stderrDrain]);
  }
}

async function requestRuntimeStop(
  client: postgres.Sql,
  apiBase: string,
  fixture: Fixture,
  runId: string,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${apiBase}/api/avatars/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fixture.cookie },
      body: JSON.stringify({ learningFocus: `probe-stop-${runId.slice(0, 8)}-${fixture.avatarId.slice(0, 8)}` }),
    }, 20_000, false);
    if (!response.ok) return false;
    await response.arrayBuffer();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const rows = await client<Array<{ status: string }>>`
        SELECT status::text AS status
        FROM platform_agents
        WHERE id = ${fixture.platformAgentId}::uuid
      `;
      if (rows[0]?.status === 'stopped') return true;
      await Bun.sleep(100);
    }
    return false;
  } catch {
    return false;
  }
}

async function cleanupDatabase(
  client: postgres.Sql,
  fixtures: Fixture[],
  buildingId: string,
): Promise<void> {
  const failures: string[] = [];
  const attempt = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch {
      failures.push(label);
    }
  };

  // Claim/chat/stop-patch event writes are intentionally fire-and-forget. The
  // event logger's guest-resolution fallback is bounded at 750ms, so wait past
  // that bound before deleting its subject rows.
  await Bun.sleep(1_000);
  for (const fixture of fixtures) {
    await attempt('events', () => client`
      DELETE FROM events
      WHERE user_id = ${fixture.userId}::uuid
         OR avatar_id = ${fixture.avatarId}::uuid
         OR agent_id = ${fixture.platformAgentId}
         OR building_id = ${buildingId}
    `);
    await attempt('event_write_failures', () => client`
      DELETE FROM event_write_failures
      WHERE attempted_row->>'userId' = ${fixture.userId}
         OR attempted_row->>'avatarId' = ${fixture.avatarId}
         OR attempted_row->>'agentId' = ${fixture.platformAgentId}
         OR attempted_row->>'buildingId' = ${buildingId}
    `);
    await attempt('memories', () => client`
      DELETE FROM memories
      WHERE agent_id = ${fixture.platformAgentId}::uuid
         OR room_id = ${fixture.platformAgentId}::uuid
         OR entity_id = ${fixture.platformAgentId}::uuid
    `);
    await attempt('plugin_agent', async () => {
      const pluginAgents = await client<Array<{ relation: string | null }>>`
        SELECT to_regclass('public.agents')::text AS relation
      `;
      if (pluginAgents[0]?.relation) {
        await client.unsafe('DELETE FROM agents WHERE id = $1::uuid', [fixture.platformAgentId]);
      }
    });
    await attempt('sessions', () => client`DELETE FROM sessions WHERE user_id = ${fixture.userId}::uuid`);
    await attempt('user', () => client`DELETE FROM users WHERE id = ${fixture.userId}::uuid`);
  }
  const platformIds = fixtures.map((fixture) => fixture.platformAgentId);
  const userIds = fixtures.map((fixture) => fixture.userId);
  const avatarIds = fixtures.map((fixture) => fixture.avatarId);
  await attempt('building_skill', () => client`DELETE FROM building_skills WHERE building_id = ${buildingId}`);

  // Require a bounded quiet window after subject deletion. Each pass re-deletes
  // by every unique fixture key, then checks for survivors. Two consecutive
  // zero windows prove no delayed event/fallback writer appeared between them.
  let quietWindows = 0;
  const quietDeadline = Date.now() + 5_000;
  while (quietWindows < 2 && Date.now() < quietDeadline && failures.length === 0) {
    await Bun.sleep(300);
    await attempt('late_events', () => client`
      DELETE FROM events
      WHERE building_id = ${buildingId}
         OR user_id = ANY(${userIds}::uuid[])
         OR avatar_id = ANY(${avatarIds}::uuid[])
         OR agent_id = ANY(${platformIds}::text[])
    `);
    await attempt('late_event_write_failures', () => client`
      DELETE FROM event_write_failures
      WHERE attempted_row->>'buildingId' = ${buildingId}
         OR attempted_row->>'userId' = ANY(${userIds}::text[])
         OR attempted_row->>'avatarId' = ANY(${avatarIds}::text[])
         OR attempted_row->>'agentId' = ANY(${platformIds}::text[])
    `);
    if (failures.length > 0) break;
    const lateCounts = await client<Array<{ events_count: number; failures_count: number }>>`
      SELECT
        (SELECT count(*)::int FROM events
          WHERE building_id = ${buildingId}
             OR user_id = ANY(${userIds}::uuid[])
             OR avatar_id = ANY(${avatarIds}::uuid[])
             OR agent_id = ANY(${platformIds}::text[])
        ) AS events_count,
        (SELECT count(*)::int FROM event_write_failures
          WHERE attempted_row->>'buildingId' = ${buildingId}
             OR attempted_row->>'userId' = ANY(${userIds}::text[])
             OR attempted_row->>'avatarId' = ANY(${avatarIds}::text[])
             OR attempted_row->>'agentId' = ANY(${platformIds}::text[])
        ) AS failures_count
    `;
    quietWindows = Number(lateCounts[0]?.events_count ?? -1) === 0
      && Number(lateCounts[0]?.failures_count ?? -1) === 0
      ? quietWindows + 1
      : 0;
  }
  if (quietWindows < 2) failures.push('event_quiet_window');

  if (failures.length > 0) {
    throw new ProbeFailure('cleanup failed for one or more probe fixture tables');
  }

  const postcondition = await client<Array<{
    users_count: number;
    avatars_count: number;
    sessions_count: number;
    platform_agents_count: number;
    skills_count: number;
    memories_count: number;
    events_count: number;
    failures_count: number;
  }>>`
    SELECT
      (SELECT count(*)::int FROM users WHERE id = ANY(${userIds}::uuid[])) AS users_count,
      (SELECT count(*)::int FROM avatars WHERE id = ANY(${avatarIds}::uuid[])) AS avatars_count,
      (SELECT count(*)::int FROM sessions WHERE user_id = ANY(${userIds}::uuid[])) AS sessions_count,
      (SELECT count(*)::int FROM platform_agents WHERE id = ANY(${platformIds}::uuid[])) AS platform_agents_count,
      (SELECT count(*)::int FROM building_skills WHERE building_id = ${buildingId}) AS skills_count,
      (SELECT count(*)::int FROM memories WHERE agent_id = ANY(${platformIds}::uuid[])) AS memories_count,
      (SELECT count(*)::int FROM events
        WHERE building_id = ${buildingId}
           OR user_id = ANY(${userIds}::uuid[])
           OR avatar_id = ANY(${avatarIds}::uuid[])
           OR agent_id = ANY(${platformIds}::text[])
      ) AS events_count,
      (SELECT count(*)::int FROM event_write_failures
        WHERE attempted_row->>'buildingId' = ${buildingId}
           OR attempted_row->>'userId' = ANY(${userIds}::text[])
           OR attempted_row->>'avatarId' = ANY(${avatarIds}::text[])
           OR attempted_row->>'agentId' = ANY(${platformIds}::text[])
      ) AS failures_count
  `;
  const counts = postcondition[0];
  const pluginRelation = await client<Array<{ relation: string | null }>>`
    SELECT to_regclass('public.agents')::text AS relation
  `;
  let pluginAgentCount = 0;
  if (pluginRelation[0]?.relation) {
    const pluginRows = await client.unsafe<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM agents WHERE id = ANY($1::uuid[])',
      [platformIds],
    );
    pluginAgentCount = Number(pluginRows[0]?.count ?? 0);
  }
  if (!counts || Object.values(counts).some((count) => Number(count) !== 0) || pluginAgentCount !== 0) {
    throw new ProbeFailure('cleanup postcondition found surviving probe rows');
  }
}

async function runEchoLane(
  client: postgres.Sql,
  apiBase: string,
  buildingId: string,
  canary: string,
  protocolVersion: number,
  runId: string,
  fixtures: Fixture[],
): Promise<void> {
  try {
    const echoFixture = await insertFixture(client, { runId: `${runId}-echo`, kind: 'echo' });
    fixtures.push(echoFixture);
    const claim = await claimSkill(apiBase, echoFixture, buildingId);
    if (claim.installed !== 'runtime' && claim.installed !== 'already') {
      console.log('ADVISORY MISS Lane C did not install into a hosted runtime');
      return;
    }
    await waitForKnowledge(client, echoFixture, buildingId, canary, protocolVersion);
    const response = await founderChat(
      apiBase,
      echoFixture,
      "What is the hosted runtime probe's unique canary token? Answer with only the token.",
    );
    console.log(
      response.message.content.includes(canary)
        ? 'ADVISORY PASS Lane C reply contained the canary'
        : 'ADVISORY MISS Lane C reply did not contain the canary',
    );
  } catch {
    console.log('ADVISORY MISS Lane C could not complete');
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const apiBase = normalizeAndValidateApiBase(options.api);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new ProbeFailure('DATABASE_URL is required');
  const applicationDatabase = validateDatabaseUrl('DATABASE_URL', databaseUrl)!;
  const elizaDatabase = validateDatabaseUrl('ELIZA_DATABASE_URL', process.env.ELIZA_DATABASE_URL);
  if (elizaDatabase && elizaDatabase.logicalIdentity !== applicationDatabase.logicalIdentity) {
    throw new ProbeFailure('ELIZA_DATABASE_URL must target the same logical database as DATABASE_URL');
  }
  // Import protected application source only after every target guard passes.
  const protocolSource = await import('../../src/services/skill-protocol');
  ok(true, 'configuration is non-production and required database settings are present');

  const runId = randomUUID();
  const buildingId = `probe-canary-${runId}`.slice(0, 64);
  const canary = `CV-PROBE-CANARY-${runId}`;
  const skillContent = buildCanarySkill(buildingId, canary);
  const protocolEvidence = deriveProtocolEvidence(apiBase, protocolSource);
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 10,
  });
  const fixtures: Fixture[] = [];
  let declaredMock: Awaited<ReturnType<typeof startDeclaredGatewayMock>> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let databaseCreated = false;
  let cleanupVerified = false;

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      declaredMock?.server.stop(true);
      let stopFailed = false;
      let cleanupFailed = false;
      if (!options.keep) {
        for (const fixture of fixtures) {
          const stopped = await requestRuntimeStop(client, apiBase, fixture, runId);
          if (!stopped) stopFailed = true;
        }
      }
      try {
        if (databaseCreated && !options.keep) {
          await cleanupDatabase(client, fixtures, buildingId);
        }
      } catch {
        cleanupFailed = true;
      }
      try {
        await client.end({ timeout: 5 });
      } catch {
        cleanupFailed = true;
      }
      cleanupVerified = !cleanupFailed && (options.keep || (!stopFailed && databaseCreated));
      if (stopFailed || cleanupFailed) {
        throw new ProbeFailure('cleanup could not verify complete disposal of probe resources');
      }
    })();
    return cleanupPromise;
  };

  const onSignal = () => probeAbortController.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const health = await fetchWithTimeout(`${apiBase}/health`, {}, 15_000);
    ok(health.ok, 'target API health check passed');

    declaredMock = await startDeclaredGatewayMock();
    await insertCanarySkill(client, buildingId, skillContent);
    databaseCreated = true;
    const fixture = await insertFixture(client, {
      runId,
      gatewayUrl: `http://127.0.0.1:${declaredMock.server.port}`,
      kind: 'declared-gateway',
    });
    fixtures.push(fixture);
    ok(true, 'temporary canary skill and disposable declared-gateway agent were created');

    const metadataResponse = await fetchWithTimeout(
      `${apiBase}/api/skills/${encodeURIComponent(buildingId)}`,
      {},
      15_000,
    );
    const metadataRaw = metadataResponse.ok ? await metadataResponse.json().catch(() => null) : null;
    const metadata = skillMetadataSchema.safeParse(metadataRaw);
    ok(
      metadataResponse.ok && metadata.success && metadata.data.buildingId === buildingId,
      'API and probe share the exact canary fixture database row',
    );

    const claim = await claimSkill(apiBase, fixture, buildingId);
    ok(claim.buildingId === buildingId && claim.installed === 'runtime', 'claim route installed the canary into the hosted runtime');

    await waitForKnowledge(client, fixture, buildingId, canary, protocolEvidence.version);
    ok(true, 'current skill and protocol memories are ready for retrieval');

    const query = "What is the hosted runtime probe's unique canary token, and what is the current connection protocol version?";
    const chat = await founderChat(apiBase, fixture, query);
    ok(chat.message.content.includes(DECLARED_GATEWAY_MARKER), 'Lane A founder-chat turn used the declared gateway');

    const declaredPrompts = declaredMock.captured.flatMap((entry) => entry.prompts);
    const composedPrompt = declaredPrompts.find((prompt) =>
      promptHasEvidence(prompt, canary, protocolEvidence),
    );
    ok(declaredPrompts.length >= 1, 'Lane A mock received at least one outbound prompt');
    ok(Boolean(composedPrompt), 'Lane A current-state context contains canary and source-derived protocol evidence');
    ok(currentStateContext(composedPrompt!).includes('[Current state context]'), 'Lane A proves provider composition rather than history echo');

    const hermesCaptured = await runHermesLane(composedPrompt!);
    const hermesPrompts = hermesCaptured.flatMap((entry) => entry.prompts);
    ok(hermesPrompts.length >= 1, 'Lane B transparent proxy captured the Hermes-local request');
    ok(hermesPrompts.some((prompt) => prompt === composedPrompt), 'Lane B transported the exact Lane A composed prompt');
    ok(hermesPrompts.some((prompt) => promptHasEvidence(prompt, canary, protocolEvidence)), 'Lane B wire contains canary and source-derived protocol evidence');
    ok(hermesPrompts.some((prompt) => currentStateContext(prompt).includes('[Current state context]')), 'Lane B wire retains current-state provider context');

    if (options.withEcho) {
      await runEchoLane(client, apiBase, buildingId, canary, protocolEvidence.version, runId, fixtures);
    }
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (probeAbortController.signal.aborted) throw new ProbeFailure('probe interrupted');
  ok(cleanupVerified, options.keep ? '--keep retained database fixtures; mock servers stopped' : 'database fixtures and mock servers were cleaned up');
  console.log(`ALL PASS (${assertionNumber} checks)`);
}

main().catch((error: unknown) => {
  if (error instanceof ProbeFailure) console.error(error.message);
  else console.error('FAIL unexpected probe error (details suppressed)');
  process.exitCode = 1;
});
