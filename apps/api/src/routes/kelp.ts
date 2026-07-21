import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
  KELP_REALM_SPEED_GRACE_MULTIPLIER,
  KELP_REALM_SPORE_BEACON_IDS,
  KELP_REALM_SPORE_COUNT,
  KELP_REALM_SPORE_FULL_MASK,
  KELP_REALM_TOKEN_TTL_MS,
  KELP_MAZE_COLLECTIBLE_SLUG,
  REWARD_ONLY_COSMETIC_CURRENCY,
} from '@clawville/shared';
import { avatarSkins, cosmeticSkus, db } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  type ActivityAuthContext,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { logEventFromContext } from '../services/event-logger';

const beaconIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/);
const visitBodySchema = z.object({ prevToken: z.string().min(20).max(512).optional() }).strict();
const claimBodySchema = z.object({ centerToken: z.string().min(20).max(512) }).strict();
const sporeMaskSchema = z.number().int().min(0).max(KELP_REALM_SPORE_FULL_MASK);
const sporeMaskTokenSchema = z.string().regex(/^[0-7]$/).transform(Number);
const TOKEN_DOMAIN = ':kelp-realm-v1';
const CLOCK_SKEW_MS = 0;

const nodeById = new Map(KELP_REALM_BEACON_GRAPH.nodes.map((node) => [node.id, node]));
const sporeIndexByBeaconId = new Map(
  KELP_REALM_SPORE_BEACON_IDS.map((beaconId, index) => [beaconId, index]),
);
const edgesByNode = new Map<string, typeof KELP_REALM_BEACON_GRAPH.edges>();
for (const node of KELP_REALM_BEACON_GRAPH.nodes) {
  edgesByNode.set(
    node.id,
    KELP_REALM_BEACON_GRAPH.edges.filter((edge) => edge.from === node.id || edge.to === node.id),
  );
}

type TokenVerdict =
  | { ok: true; beaconId: string; issuedAtMs: number; sporeMask: number }
  | { ok: false; code: 'invalid_token' | 'expired_token' };

function hmacKey(secret: string): Buffer {
  return createHash('sha256').update(`${secret}${TOKEN_DOMAIN}`).digest();
}

export function issueKelpBeaconToken(
  subject: string,
  beaconId: string,
  issuedAtMs: number,
  secret: string,
  sporeMask = 0,
): string {
  const parsedSporeMask = sporeMaskSchema.parse(sporeMask);
  const signature = createHmac('sha256', hmacKey(secret))
    .update(`${subject}|${beaconId}|${issuedAtMs}|${parsedSporeMask}`)
    .digest('base64url');
  return `${beaconId}.${issuedAtMs}.${parsedSporeMask}.${signature}`;
}

export function verifyKelpBeaconToken(
  token: string,
  subject: string,
  nowMs: number,
  secret: string,
): TokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, code: 'invalid_token' };
  const [beaconId, issuedRaw, sporeMaskRaw, signatureRaw] = parts;
  if (!beaconIdSchema.safeParse(beaconId).success || !nodeById.has(beaconId)) {
    return { ok: false, code: 'invalid_token' };
  }
  const sporeMaskResult = sporeMaskTokenSchema.safeParse(sporeMaskRaw);
  if (!sporeMaskResult.success) return { ok: false, code: 'invalid_token' };
  const sporeMask = sporeMaskResult.data;
  const issuedAtMs = Number(issuedRaw);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs > nowMs + CLOCK_SKEW_MS) {
    return { ok: false, code: 'invalid_token' };
  }
  if (nowMs - issuedAtMs >= KELP_REALM_TOKEN_TTL_MS) {
    return { ok: false, code: 'expired_token' };
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(signatureRaw, 'base64url');
  } catch {
    return { ok: false, code: 'invalid_token' };
  }
  const expected = createHmac('sha256', hmacKey(secret))
    .update(`${subject}|${beaconId}|${issuedAtMs}|${sporeMask}`)
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, code: 'invalid_token' };
  }
  return { ok: true, beaconId, issuedAtMs, sporeMask };
}

function secretOrNull(): string | null {
  const secret = process.env.FINGERPRINT_SECRET;
  return secret?.trim() ? secret : null;
}

async function readJsonBody(c: { req: { text(): Promise<string> } }): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function countFoundSpores(sporeMask: number): number {
  let found = 0;
  for (let index = 0; index < KELP_REALM_SPORE_COUNT; index++) {
    if ((sporeMask & (1 << index)) !== 0) found++;
  }
  return found;
}

function collectSporeAtBeacon(sporeMask: number, beaconId: string): number {
  const sporeIndex = sporeIndexByBeaconId.get(beaconId);
  return sporeIndex === undefined ? sporeMask : sporeMask | (1 << sporeIndex);
}

function adjacentFor(beaconId: string, subject: string) {
  const node = nodeById.get(beaconId)!;
  const seed = createHash('sha256').update(`${subject}:${beaconId}`).digest();
  return (edgesByNode.get(beaconId) ?? []).map((edge) => {
    const adjacentId = edge.from === beaconId ? edge.to : edge.from;
    const adjacent = nodeById.get(adjacentId)!;
    const bearingDeg = (Math.atan2(adjacent.x - node.x, -(adjacent.z - node.z)) * 180 / Math.PI + 360) % 360;
    return {
      descriptor: {
        id: adjacent.id,
        kind: adjacent.kind,
        bearingDeg: Math.round(bearingDeg * 10) / 10,
        distanceWu: edge.distanceWu,
      },
      shuffleKey: createHash('sha256').update(seed).update(adjacent.id).digest('hex'),
    };
  })
    .sort((a, b) => a.shuffleKey.localeCompare(b.shuffleKey) || a.descriptor.id.localeCompare(b.descriptor.id))
    .map(({ descriptor }) => descriptor);
}

export type RewardGrantResult =
  | { ok: true; alreadyOwned: boolean; skuId: string }
  | { ok: false; reason: 'missing' | 'misconfigured' };
type KelpTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface KelpRouteDependencies {
  nowMs: () => number;
  secret: () => string | null;
  session: MiddlewareHandler<ActivityAuthContext>;
  resolveIdentity: MiddlewareHandler<ActivityAuthContext>;
  requireLedger: MiddlewareHandler<ActivityAuthContext>;
  requireNonGuest: MiddlewareHandler<ActivityAuthContext>;
  noStore: MiddlewareHandler<ActivityAuthContext>;
  grantReward: (avatarId: string, nowMs: number) => Promise<RewardGrantResult>;
  recordCompletion: (
    c: Context<ActivityAuthContext>,
    identity: ActivityIdentity,
  ) => void;
  logRewardConfigurationError: (details: {
    slug: string;
    reason: 'missing' | 'misconfigured';
  }) => void;
}

export async function grantKelpCollectibleInTransaction(
  tx: KelpTransaction,
  avatarId: string,
  nowMs: number,
): Promise<RewardGrantResult> {
    const [sku] = await tx
      .select({
        id: cosmeticSkus.id,
        exclusiveCurrency: cosmeticSkus.exclusiveCurrency,
        supplyCap: cosmeticSkus.supplyCap,
      })
      .from(cosmeticSkus)
      .where(eq(cosmeticSkus.slug, KELP_MAZE_COLLECTIBLE_SLUG))
      .limit(1);
    if (!sku) return { ok: false, reason: 'missing' };
    if (
      sku.exclusiveCurrency !== REWARD_ONLY_COSMETIC_CURRENCY ||
      sku.supplyCap !== null
    ) return { ok: false, reason: 'misconfigured' };
    const inserted = await tx
      .insert(avatarSkins)
      .values({
        avatarId,
        skuId: sku.id,
        acquiredVia: 'reward',
        ledgerId: null,
        equipped: true,
        equippedAt: new Date(nowMs),
      })
      .onConflictDoNothing({ target: [avatarSkins.avatarId, avatarSkins.skuId] })
      .returning({ id: avatarSkins.id });
    return { ok: true, alreadyOwned: inserted.length === 0, skuId: sku.id };
}

async function grantKelpCollectible(avatarId: string, nowMs: number): Promise<RewardGrantResult> {
  return db.transaction((tx) => grantKelpCollectibleInTransaction(tx, avatarId, nowMs));
}

const DEFAULT_DEPENDENCIES: KelpRouteDependencies = {
  nowMs: () => Date.now(),
  secret: secretOrNull,
  session: sessionMiddleware as unknown as MiddlewareHandler<ActivityAuthContext>,
  resolveIdentity: requireAuthOrAgentSession,
  requireLedger: requireLedgerCapableIdentity,
  requireNonGuest: requireNonGuestIdentity,
  noStore: noStorePrivate as unknown as MiddlewareHandler<ActivityAuthContext>,
  grantReward: grantKelpCollectible,
  recordCompletion: (c, identity) => {
    void logEventFromContext(c, {
      eventType: 'kelp_maze.completed',
      userId: identity.userId,
      avatarId: identity.avatarId,
      agentId: identity.kind === 'agent' ? identity.agentId : null,
      payload: { rewardSlug: KELP_MAZE_COLLECTIBLE_SLUG },
    });
  },
  logRewardConfigurationError: ({ slug, reason }) => {
    console.error('[Kelp claim] stable collectible SKU is unavailable', { slug, reason });
  },
};

export function createKelpRoutes(
  overrides: Partial<KelpRouteDependencies> = {},
): Hono<ActivityAuthContext> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const routes = new Hono<ActivityAuthContext>();
  routes.use('*', dependencies.session);

  routes.post('/beacon/:beaconId/visit', dependencies.resolveIdentity, dependencies.noStore, async (c) => {
  const idResult = beaconIdSchema.safeParse(c.req.param('beaconId'));
  const node = idResult.success ? nodeById.get(idResult.data) : undefined;
  if (!node) return c.json({ error: 'unknown_beacon', code: 'unknown_beacon' }, 404);

  const bodyResult = visitBodySchema.safeParse(await readJsonBody(c));
  if (!bodyResult.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
  const identity = c.get('identity');
  const secret = dependencies.secret();
  if (!secret) return c.json({ error: 'token_service_unavailable', code: 'token_service_unavailable' }, 503);
  const nowMs = dependencies.nowMs();
  let sporeMask = 0;

  if (node.kind !== 'entry') {
    if (!bodyResult.data.prevToken) {
      return c.json({ error: 'previous_beacon_token_required', code: 'prev_token_required' }, 400);
    }
    const previous = verifyKelpBeaconToken(bodyResult.data.prevToken, identity.avatarId, nowMs, secret);
    if (!previous.ok) return c.json({ error: previous.code, code: previous.code }, 400);
    sporeMask = previous.sporeMask;
    const edge = (edgesByNode.get(node.id) ?? []).find(
      (candidate) => candidate.from === previous.beaconId || candidate.to === previous.beaconId,
    );
    if (!edge) return c.json({ error: 'non_adjacent_beacon', code: 'non_adjacent_beacon' }, 400);
    const minimumElapsedMs = Math.ceil(
      edge.distanceWu / (KELP_REALM_PLAYER_SPEED_WU_PER_SEC * KELP_REALM_SPEED_GRACE_MULTIPLIER) * 1000,
    );
    const elapsedMs = nowMs - previous.issuedAtMs;
    if (elapsedMs < minimumElapsedMs) {
      return c.json({
        error: 'too_fast',
        code: 'too_fast',
        retryAfterMs: minimumElapsedMs - elapsedMs,
      }, 429);
    }
  }

  sporeMask = collectSporeAtBeacon(sporeMask, node.id);
  const sporeIndex = sporeIndexByBeaconId.get(node.id);

  return c.json({
    token: issueKelpBeaconToken(identity.avatarId, node.id, nowMs, secret, sporeMask),
    adjacent: adjacentFor(node.id, identity.avatarId),
    spores: { found: countFoundSpores(sporeMask), total: KELP_REALM_SPORE_COUNT },
    ...(sporeIndex === undefined ? {} : { spore: true as const }),
  });
  });

  routes.post(
  '/claim',
  dependencies.resolveIdentity,
  dependencies.requireLedger,
  dependencies.requireNonGuest,
  dependencies.noStore,
  async (c) => {
    const bodyResult = claimBodySchema.safeParse(await readJsonBody(c));
    if (!bodyResult.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
    const identity = c.get('identity');
    const secret = dependencies.secret();
    if (!secret) return c.json({ error: 'token_service_unavailable', code: 'token_service_unavailable' }, 503);
    const nowMs = dependencies.nowMs();
    const token = verifyKelpBeaconToken(bodyResult.data.centerToken, identity.avatarId, nowMs, secret);
    if (!token.ok) return c.json({ error: token.code, code: token.code }, 400);
    if (nodeById.get(token.beaconId)?.kind !== 'center') {
      return c.json({ error: 'center_token_required', code: 'center_token_required' }, 400);
    }
    if (token.sporeMask !== KELP_REALM_SPORE_FULL_MASK) {
      return c.json({
        code: 'spores_missing',
        found: countFoundSpores(token.sporeMask),
        total: KELP_REALM_SPORE_COUNT,
      }, 409);
    }

    const result = await dependencies.grantReward(identity.avatarId, nowMs);
    if (!result.ok) {
      dependencies.logRewardConfigurationError({
        slug: KELP_MAZE_COLLECTIBLE_SLUG,
        reason: result.reason,
      });
      return c.json({
        error: 'collectible_sku_unavailable',
        code: 'collectible_sku_unavailable',
      }, 500);
    }

    if (!result.alreadyOwned) {
      dependencies.recordCompletion(c, identity);
    }
    return c.json({ ok: true, alreadyOwned: result.alreadyOwned });
  },
  );

  return routes;
}

export const kelpRoutes = createKelpRoutes();
