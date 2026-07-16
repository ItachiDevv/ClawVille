#!/usr/bin/env bun
/**
 * Public terminal-agent onboarding regression gate.
 *
 * Uses a fresh identity on every run and intentionally never logs credentials,
 * session bearers, one-time identity material, or response payloads.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../src/services/skill-protocol';

const protocolPointerSchema = z.object({
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  url: z.literal('/api/skills/protocol/skill.md'),
  manifestUrl: z.literal('/api/skills/manifest.json'),
  auth: z.literal('X-Clawville-Agent-Session: <sessionId>'),
});

const connectResponseSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().regex(/^ag-/),
  knowledge: z.array(z.string()),
  protocol: protocolPointerSchema,
  identity: z.object({
    userId: z.string().min(1),
    isFirstTime: z.literal(true),
    secretIncluded: z.literal(true),
    secretIssuedPreviously: z.literal(false),
    publicKey: z.string().min(1),
    secretKey: z.string().min(1),
  }),
});

const returningConnectResponseSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().regex(/^ag-/),
  knowledge: z.array(z.string()),
  protocol: protocolPointerSchema,
  identity: z.object({
    userId: z.string().min(1),
    publicKey: z.string().min(1),
    isFirstTime: z.literal(false),
    secretIncluded: z.literal(false),
    secretIssuedPreviously: z.literal(true),
    recovery: z.string().min(1),
    secretKey: z.never().optional(),
  }),
});

const ownedSkillsResponseSchema = z.object({
  ownedSkills: z.array(z.object({ buildingId: z.string().min(1) }).passthrough()),
}).passthrough();

const claimSkillResponseSchema = z.object({
  ok: z.literal(true),
  buildingId: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  installed: z.enum(['runtime', 'marker', 'already']),
});

const joinResponseSchema = z.object({
  userId: z.string().min(1),
  avatarId: z.string().uuid(),
}).passthrough();

const sessionStatusResponseSchema = z.object({
  connected: z.literal(true),
});

const knowledgeResponseSchema = z.object({
  knowledge: z.array(z.string()),
});

class SmokeFailure extends Error {}
let failureReported = false;

function apiBaseFromArgs(args: string[]): string {
  const apiFlag = args.indexOf('--api');
  const raw = apiFlag >= 0 ? args[apiFlag + 1] : undefined;
  if (!raw) throw new SmokeFailure('usage: bun run scripts/agent-onboarding-smoke.ts --api <base>');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SmokeFailure('--api must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SmokeFailure('--api must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SmokeFailure('--api must not include credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new SmokeFailure(`request timed out after ${timeoutMs}ms`);
    }
    throw new SmokeFailure('request failed');
  } finally {
    clearTimeout(timeout);
  }
}

async function expectJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new SmokeFailure(`HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SmokeFailure('response was not JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SmokeFailure('response contract mismatch');
  return parsed.data;
}

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetchWithTimeout(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function check(name: string, assertion: () => Promise<void>): Promise<void> {
  try {
    await assertion();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof SmokeFailure ? error.message : 'unexpected failure';
    console.error(`FAIL ${name}: ${message}`);
    failureReported = true;
    throw error;
  }
}

async function waitForVisit(base: string, sessionId: string, buildingId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await postJson(
      base,
      `/api/agent/${encodeURIComponent(sessionId)}/visit-building`,
      { buildingId },
    );
    if (response.ok) return;
    if (response.status !== 400) throw new SmokeFailure(`HTTP ${response.status}`);

    // A 400 while the body is walking is the expected proximity gate. Avoid
    // printing its body because smoke output must never become a payload dump.
    await response.arrayBuffer();
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new SmokeFailure('agent did not reach the building within 60s');
}

async function main(): Promise<void> {
  const base = apiBaseFromArgs(process.argv.slice(2));
  const nonce = randomUUID();
  const agentId = `onboarding-smoke-${nonce}`;
  const identityKey = `onboarding-smoke-key:${randomUUID()}`;
  const buildingId = 'agent-security';
  const connectBody = {
    agentId,
    identityType: 'nanoclaw' as const,
    identityKey,
    protocol: 'nanoclaw' as const,
    name: `Smoke-${nonce.slice(0, 8)}`,
    homeX: 5088,
    homeY: 5088,
    stats: { hp: 150, attack: 25, defense: 25, speed: 25 },
  };

  await check('public clawville-play manual', async () => {
    const response = await fetchWithTimeout(`${base}/api/skills/clawville-play/skill.md`);
    if (!response.ok) throw new SmokeFailure(`HTTP ${response.status}`);
    const manual = await response.text();
    const banned = [
      { label: 'ClawToken', pattern: /\bClawTokens?\b/i },
      { label: 'CT', pattern: /(^|[^A-Za-z0-9_])CT([^A-Za-z0-9_]|$)/ },
      { label: 'casino', pattern: /\bcasino\b/i },
      { label: 'pet', pattern: /\bpets?\b/i },
    ].find(({ pattern }) => pattern.test(manual));
    if (banned) throw new SmokeFailure(`manual contains banned term ${banned.label}`);
  });

  let firstConnect!: z.infer<typeof connectResponseSchema>;
  await check('first identity-key connect', async () => {
    firstConnect = await expectJson(
      await postJson(base, '/api/agent/connect', connectBody),
      connectResponseSchema,
    );
    if (firstConnect.agentId !== agentId) throw new SmokeFailure('agentId was not stable');
    if (firstConnect.protocol.version !== PROTOCOL_VERSION) {
      throw new SmokeFailure('connect protocol version does not match source');
    }
  });

  await check('identity join provisions an active avatar', async () => {
    await expectJson(
      await postJson(base, '/api/agent/join', {
        identityType: connectBody.identityType,
        identityKey,
        name: connectBody.name,
      }),
      joinResponseSchema,
    );
  });

  let ownershipConnect!: z.infer<typeof returningConnectResponseSchema>;
  await check('post-join reconnect proves avatar ownership', async () => {
    ownershipConnect = await expectJson(
      await postJson(base, '/api/agent/connect', connectBody),
      returningConnectResponseSchema,
    );
    if (ownershipConnect.sessionId === firstConnect.sessionId) {
      throw new SmokeFailure('post-join session bearer did not rotate');
    }
  });

  await check('bound owned-skills read', async () => {
    await expectJson(
      await fetchWithTimeout(
        `${base}/api/agent/${encodeURIComponent(ownershipConnect.sessionId)}/owned-skills`,
      ),
      ownedSkillsResponseSchema,
    );
  });

  await check('agent-session building skill claim', async () => {
    const claimed = await expectJson(
      await fetchWithTimeout(
        `${base}/api/skills/${encodeURIComponent(buildingId)}/claim`,
        {
          method: 'POST',
          headers: { 'X-Clawville-Agent-Session': ownershipConnect.sessionId },
        },
      ),
      claimSkillResponseSchema,
    );
    if (claimed.buildingId !== buildingId) {
      throw new SmokeFailure('claim response buildingId mismatch');
    }
  });

  await check('session status', async () => {
    await expectJson(
      await fetchWithTimeout(
        `${base}/api/agent/session-status?agentId=${encodeURIComponent(agentId)}`,
      ),
      sessionStatusResponseSchema,
    );
  });

  await check('move', async () => {
    const response = await postJson(
      base,
      `/api/agent/${encodeURIComponent(ownershipConnect.sessionId)}/move`,
      { buildingId },
    );
    if (!response.ok) throw new SmokeFailure(`HTTP ${response.status}`);
    await response.arrayBuffer();
  });

  await check('visit building', async () => {
    await waitForVisit(base, ownershipConnect.sessionId, buildingId);
  });

  await check('chat', async () => {
    const response = await postJson(
      base,
      `/api/agent/${encodeURIComponent(ownershipConnect.sessionId)}/chat`,
      { message: 'Onboarding smoke check.' },
    );
    if (!response.ok) throw new SmokeFailure(`HTTP ${response.status}`);
    await response.arrayBuffer();
  });

  await check('bearer-authenticated protocol manual', async () => {
    const response = await fetchWithTimeout(`${base}${ownershipConnect.protocol.url}`, {
      headers: { 'X-Clawville-Agent-Session': ownershipConnect.sessionId },
    });
    if (!response.ok) throw new SmokeFailure(`HTTP ${response.status}`);
    const servedVersion = Number(response.headers.get('X-Skill-Version'));
    if (servedVersion !== PROTOCOL_VERSION) {
      throw new SmokeFailure('served protocol version does not match source');
    }
    await response.arrayBuffer();
  });

  await check('returning connect rotates session and preserves knowledge', async () => {
    let knowledgeBeforeReconnect: string[] = [];
    const knowledgeDeadline = Date.now() + 10_000;
    while (Date.now() < knowledgeDeadline) {
      const snapshot = await expectJson(
        await fetchWithTimeout(
          `${base}/api/agent/${encodeURIComponent(ownershipConnect.sessionId)}/knowledge`,
        ),
        knowledgeResponseSchema,
      );
      knowledgeBeforeReconnect = snapshot.knowledge;
      if (knowledgeBeforeReconnect.length > 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (knowledgeBeforeReconnect.length === 0) {
      throw new SmokeFailure('visit knowledge was not persisted before reconnect');
    }

    const response = await postJson(base, '/api/agent/connect', connectBody);
    if (!response.ok) throw new SmokeFailure(`HTTP ${response.status}`);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new SmokeFailure('response was not JSON');
    }
    const parsed = returningConnectResponseSchema.safeParse(raw);
    if (!parsed.success) throw new SmokeFailure('response contract mismatch');
    if (parsed.data.sessionId === ownershipConnect.sessionId) {
      throw new SmokeFailure('session bearer did not rotate');
    }
    if (parsed.data.protocol.version !== PROTOCOL_VERSION) {
      throw new SmokeFailure('returning protocol version does not match source');
    }
    const returningKnowledge = new Set(parsed.data.knowledge);
    if (!knowledgeBeforeReconnect.every((entry) => returningKnowledge.has(entry))) {
      throw new SmokeFailure('persisted knowledge was missing after reconnect');
    }
  });
}

main().catch((error: unknown) => {
  if (!failureReported) {
    const message = error instanceof SmokeFailure ? error.message : 'unexpected failure';
    console.error(`FAIL setup: ${message}`);
  }
  process.exitCode = 1;
});
