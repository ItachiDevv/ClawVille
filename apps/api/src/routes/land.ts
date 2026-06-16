/**
 * Land Economy — Phase 1 / Slice A routes (`/api/land`).
 *
 * The first user-facing surface on top of the Phase 0 `land_parcels` /
 * `land_transactions` schema. Slice A is the FREE starter-parcel claim + the
 * read seams the world renderer / 3da overlay consume. The PRICED primary-sale
 * buy (CT debit via the ledger) is a LATER slice — this file deliberately has
 * NO ledger touch and never writes `avatars.clawTokens`.
 *
 * RULE E5 PARITY: every write resolves the acting avatar from
 * `c.get('identity').avatarId` (set by `requireAuthOrAgentSession`), which is a
 * REAL avatar for BOTH a Lucia-authed human AND a connected/hosted agent
 * session. There is no guest fallback in that middleware, so the starter grant
 * binds to the agent's own avatar exactly as it does for a human — no
 * human-XOR-guest, no agent-locked-out path. (PARITY note —
 *   human path: POST /api/land/claim-starter via Lucia cookie;
 *   agent path: same endpoint via X-Clawville-Agent-Session → bound avatar;
 *   settlement binds to identity.avatarId.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FROZEN RESPONSE CONTRACT (the web UI + 3da overlay build to THIS next turn).
 * `LandParcelDTO` is the shared parcel shape returned by every route below.
 *
 *   type LandParcelDTO = {
 *     id: string;            // uuid
 *     parcelCode: string;    // "parcel-<tier>-<NN>"
 *     tier: 'starter'|'c'|'b'|'a'|'founder';
 *     status: 'available'|'owned'|'reserved'|'retired';
 *     gridX: number;         // int
 *     gridY: number;         // int
 *     priceCt: number | null;// int CT or null (Founder = null)
 *     ownerAvatarId: string | null; // uuid or null (for-sale)
 *   };
 *
 * 1. GET /api/land/parcels?tier=&status=   (PUBLIC, 60s cache, 60/min/IP)
 *      200 → LandParcelDTO[]                   (flat array; status defaults 'available')
 *      400 → { error: 'invalid_query' }        (bad tier/status enum)
 *      429 → { error: 'rate_limited' }
 *
 * 2. GET /api/land/owned/:avatarId          (PUBLIC, 60/min/IP)
 *      200 → LandParcelDTO[]                   (that avatar's parcels, flat array)
 *      400 → { error: 'invalid_avatar_id' }    (not a uuid)
 *      429 → { error: 'rate_limited' }
 *
 * 3. GET /api/land/me                        (AUTH: human cookie OR agent session)
 *      200 → { avatarId: string, parcels: LandParcelDTO[] }
 *      401 → no identity   ·  403 → bound user has no active avatar
 *
 * 4. POST /api/land/claim-starter            (AUTH: human cookie OR agent session)
 *      body: {} (empty / none — extra fields rejected, .strict())
 *      200 → { parcel: LandParcelClaimDTO, alreadyOwned: boolean }
 *            where LandParcelClaimDTO = Omit<LandParcelDTO, 'ownerAvatarId'>
 *              = { id, parcelCode, tier, status, gridX, gridY, priceCt }
 *            alreadyOwned=true  → the avatar already held a starter (no new grant, no event)
 *            alreadyOwned=false → a starter parcel was granted this call
 *      400 → { error: 'invalid_body' }         (stray fields)
 *      401 → no identity   ·  403 → bound user has no active avatar
 *      409 → { error: 'no_starter_available' } (starter pool exhausted)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  db,
  landParcels,
  eq,
  and,
  sql,
} from '@clawville/database';
import {
  LAND_EVENT_TYPES,
  LAND_TIERS,
  type LandTier,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { logEventFromContext } from '../services/event-logger';
import type { AppContext } from '../types';

// ─── shared shapes ──────────────────────────────────────────────────────────

/** The frozen parcel DTO returned by every read route (see contract above). */
interface LandParcelDTO {
  id: string;
  parcelCode: string;
  tier: LandTier;
  status: 'available' | 'owned' | 'reserved' | 'retired';
  gridX: number;
  gridY: number;
  priceCt: number | null;
  ownerAvatarId: string | null;
}

/** The 4 valid parcel statuses (mirrors `landParcelStatusEnum`). */
const PARCEL_STATUSES = ['available', 'owned', 'reserved', 'retired'] as const;

// Zod enums built from the SHARED tier list + the status literal set, so a
// schema drift surfaces as a compile error rather than a silent mismatch.
const tierSchema = z.enum(LAND_TIERS as unknown as [LandTier, ...LandTier[]]);
const statusSchema = z.enum(PARCEL_STATUSES);

const parcelsQuerySchema = z
  .object({
    tier: tierSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict();

// claim-starter takes NO input — accept an empty body / no body, reject any
// stray field (no client value may reach the write; the avatar + parcel are
// server-resolved).
const claimStarterBodySchema = z.object({}).strict();

const avatarIdSchema = z.string().uuid();

// ─── 60s read cache + per-IP rate limit (mirror leaderboard `/agents`) ──────

const READ_CACHE_TTL_MS = 60_000;
const publicReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

interface ReadCacheEntry {
  payload: LandParcelDTO[];
  expiresAt: number;
}

// Keyed on the normalized query (`parcels` route) or `owned:<avatarId>`.
const readCache = new Map<string, ReadCacheEntry>();

function getReadCache(key: string): LandParcelDTO[] | null {
  const hit = readCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    readCache.delete(key);
    return null;
  }
  return hit.payload;
}

function setReadCache(key: string, payload: LandParcelDTO[]): void {
  readCache.set(key, { payload, expiresAt: Date.now() + READ_CACHE_TTL_MS });
}

/** Drizzle column → DTO mapper (typed select, no coercion needed). */
function toDTO(row: {
  id: string;
  parcelCode: string;
  tier: LandTier;
  status: (typeof PARCEL_STATUSES)[number];
  gridX: number;
  gridY: number;
  priceCt: number | null;
  ownerAvatarId: string | null;
}): LandParcelDTO {
  return {
    id: row.id,
    parcelCode: row.parcelCode,
    tier: row.tier,
    status: row.status,
    gridX: row.gridX,
    gridY: row.gridY,
    priceCt: row.priceCt,
    ownerAvatarId: row.ownerAvatarId,
  };
}

/** Shared owned-parcels query (routes 2 + 3) — one indexed scan on owner_avatar_id. */
async function fetchOwnedParcels(avatarId: string): Promise<LandParcelDTO[]> {
  const rows = await db
    .select({
      id: landParcels.id,
      parcelCode: landParcels.parcelCode,
      tier: landParcels.tier,
      status: landParcels.status,
      gridX: landParcels.gridX,
      gridY: landParcels.gridY,
      priceCt: landParcels.priceCt,
      ownerAvatarId: landParcels.ownerAvatarId,
    })
    .from(landParcels)
    .where(eq(landParcels.ownerAvatarId, avatarId));
  return rows.map(toDTO);
}

// ─── router ─────────────────────────────────────────────────────────────────

// `DualContext` = base app context + the `identity` variable that
// `requireAuthOrAgentSession` sets on the authed routes. Mirrors activities.ts
// so `c.get('identity')` is typed without a cast; the public routes that never
// set it still typecheck (the variable is simply not read there).
type DualContext = AppContext & ActivityAuthContext;

export const landRoutes = new Hono<DualContext>();

// `requireAuthOrAgentSession` (on /me + /claim-starter) reads `c.get('user')`
// for the human path, which `sessionMiddleware` populates. Apply it to every
// route on this router — it's a no-op (no throw) for the unauthenticated public
// reads, and the required upstream for the authed writes. Mirrors activities.ts.
landRoutes.use('*', sessionMiddleware);

// ─── 1. GET /parcels?tier=&status=  (PUBLIC, cached, rate-limited) ──────────

landRoutes.get('/parcels', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const parsed = parcelsQuerySchema.safeParse({
    tier: c.req.query('tier'),
    status: c.req.query('status'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query' }, 400);
  }

  // Default to the for-sale pool. tier is optional (all tiers when absent).
  const status = parsed.data.status ?? 'available';
  const tier = parsed.data.tier ?? null;

  const cacheKey = `parcels:${tier ?? '*'}:${status}`;
  const cached = getReadCache(cacheKey);
  if (cached) return c.json(cached);

  // Single indexed query — `land_parcels_tier_status_idx` covers (tier, status).
  const where = tier
    ? and(eq(landParcels.tier, tier), eq(landParcels.status, status))
    : eq(landParcels.status, status);

  const rows = await db
    .select({
      id: landParcels.id,
      parcelCode: landParcels.parcelCode,
      tier: landParcels.tier,
      status: landParcels.status,
      gridX: landParcels.gridX,
      gridY: landParcels.gridY,
      priceCt: landParcels.priceCt,
      ownerAvatarId: landParcels.ownerAvatarId,
    })
    .from(landParcels)
    .where(where);

  const payload = rows.map(toDTO);
  setReadCache(cacheKey, payload);
  return c.json(payload);
});

// ─── 2. GET /owned/:avatarId  (PUBLIC, rate-limited — multiplayer render seam) ─

landRoutes.get('/owned/:avatarId', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const parsed = avatarIdSchema.safeParse(c.req.param('avatarId'));
  if (!parsed.success) {
    return c.json({ error: 'invalid_avatar_id' }, 400);
  }
  const avatarId = parsed.data;

  const cacheKey = `owned:${avatarId}`;
  const cached = getReadCache(cacheKey);
  if (cached) return c.json(cached);

  const payload = await fetchOwnedParcels(avatarId);
  setReadCache(cacheKey, payload);
  return c.json(payload);
});

// ─── 3. GET /me  (AUTH) ─────────────────────────────────────────────────────

landRoutes.get('/me', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;
  const parcels = await fetchOwnedParcels(avatarId);
  return c.json({ avatarId, parcels });
});

// ─── 4. POST /claim-starter  (AUTH, PARITY-BOUND, idempotent, atomic) ───────

landRoutes.post('/claim-starter', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  // Reject any body that isn't an empty object — no client value reaches the
  // write. An absent body (no Content-Type / empty) parses to `{}` and passes.
  const rawBody = await c.req.json().catch(() => ({}));
  if (!claimStarterBodySchema.safeParse(rawBody).success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  // Idempotent fast-path (outside the txn): if this avatar already owns ANY
  // starter, return it without locking the pool. The in-txn re-check below is
  // the correctness guard against a concurrent double-claim.
  const existingFast = await db
    .select({
      id: landParcels.id,
      parcelCode: landParcels.parcelCode,
      tier: landParcels.tier,
      status: landParcels.status,
      gridX: landParcels.gridX,
      gridY: landParcels.gridY,
      priceCt: landParcels.priceCt,
    })
    .from(landParcels)
    .where(and(eq(landParcels.ownerAvatarId, avatarId), eq(landParcels.tier, 'starter')))
    .limit(1);

  if (existingFast[0]) {
    const p = existingFast[0];
    return c.json({
      parcel: {
        id: p.id,
        parcelCode: p.parcelCode,
        tier: p.tier,
        status: p.status,
        gridX: p.gridX,
        gridY: p.gridY,
        priceCt: p.priceCt,
      },
      alreadyOwned: true,
    });
  }

  // ── atomic grant ──────────────────────────────────────────────────────────
  // Note: the 5-cap `MAX_PARCELS_PER_AVATAR` is NOT the binding constraint here
  // — a starter is one-per-avatar via the ownership idempotency check (the
  // in-txn re-select below). The cap is enforced on the PRICED buy in a later
  // slice; we deliberately do not apply it to the free starter grant.
  //
  // `tx.execute` returns INT/text columns as strings (PG wire format) — coerce
  // grid coords with Number() before they land in the response.
  type ClaimResult =
    | { kind: 'already_owned'; parcel: ClaimedParcel }
    | { kind: 'granted'; parcel: ClaimedParcel };
  interface ClaimedParcel {
    id: string;
    parcelCode: string;
    tier: LandTier;
    status: 'available' | 'owned' | 'reserved' | 'retired';
    gridX: number;
    gridY: number;
    priceCt: number | null;
  }

  let result: ClaimResult;
  try {
    result = await db.transaction(async (tx): Promise<ClaimResult> => {
      // (0) Per-avatar serialization. Under READ COMMITTED the ownership
      // re-check in (a) and the `FOR UPDATE SKIP LOCKED` pick in (b) read
      // DISJOINT row-sets, so two concurrent claims by the SAME avatar could
      // both miss the re-check and SKIP-LOCK two DIFFERENT available rows —
      // granting one avatar two starters. A transaction-scoped advisory lock
      // keyed on the avatar id serializes same-avatar claims (the lock releases
      // at COMMIT/ROLLBACK), so the second waits and then sees the first's
      // committed ownership in (a). Generalizes to the priced multi-tier buy
      // where no single row can carry the constraint. Matches the project's
      // per-subject mutex+advisory pattern. Concurrent claims by DIFFERENT
      // avatars hash to different keys and never block each other.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      // (a) Correctness guard — re-check ownership INSIDE the txn. A concurrent
      // claim that committed between the fast-path read and here is caught: the
      // avatar already has a starter, grant nothing, return that parcel. With
      // the advisory lock above held, this re-check is now authoritative for
      // same-avatar concurrency.
      const ownedRows = await tx.execute<{
        id: string;
        parcel_code: string;
        tier: LandTier;
        status: string;
        grid_x: number | string;
        grid_y: number | string;
        price_ct: number | string | null;
      }>(
        sql`SELECT id, parcel_code, tier, status, grid_x, grid_y, price_ct
            FROM land_parcels
            WHERE owner_avatar_id = ${avatarId} AND tier = 'starter'
            LIMIT 1`,
      );
      const owned = ownedRows[0];
      if (owned) {
        return {
          kind: 'already_owned',
          parcel: {
            id: owned.id,
            parcelCode: owned.parcel_code,
            tier: owned.tier,
            status: owned.status as ClaimedParcel['status'],
            gridX: Number(owned.grid_x),
            gridY: Number(owned.grid_y),
            priceCt: owned.price_ct == null ? null : Number(owned.price_ct),
          },
        };
      }

      // (b) Claim one available starter. FOR UPDATE SKIP LOCKED so two
      // concurrent first-time claimers never lock onto the SAME row — the
      // second skips the locked row and takes the next, deterministic by
      // parcel_code so the pool drains in order.
      const pickRows = await tx.execute<{
        id: string;
        parcel_code: string;
        tier: LandTier;
        status: string;
        grid_x: number | string;
        grid_y: number | string;
        price_ct: number | string | null;
      }>(
        sql`SELECT id, parcel_code, tier, status, grid_x, grid_y, price_ct
            FROM land_parcels
            WHERE tier = 'starter' AND status = 'available'
            ORDER BY parcel_code
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
      );
      const pick = pickRows[0];
      if (!pick) {
        throw new HTTPException(409, { message: 'no_starter_available' });
      }

      // (c) Flip ownership.
      await tx.execute(
        sql`UPDATE land_parcels
            SET status = 'owned',
                owner_avatar_id = ${avatarId},
                acquired_at = now(),
                updated_at = now()
            WHERE id = ${pick.id}`,
      );

      // (d) Audit-spine row — free grant (amount_ct = 0, no ledger debit).
      const meta = JSON.stringify({ free: true, reason: 'starter_claim' });
      await tx.execute(
        sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
            VALUES ('parcel_purchase', ${pick.id}, ${avatarId}, 0, ${meta}::jsonb)`,
      );

      return {
        kind: 'granted',
        parcel: {
          id: pick.id,
          parcelCode: pick.parcel_code,
          // post-UPDATE state is 'owned' — reflect it in the response.
          tier: pick.tier,
          status: 'owned',
          gridX: Number(pick.grid_x),
          gridY: Number(pick.grid_y),
          priceCt: pick.price_ct == null ? null : Number(pick.price_ct),
        },
      };
    });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw err;
  }

  // Already-owned race (committed concurrently) — no new grant, no event.
  if (result.kind === 'already_owned') {
    return c.json({ parcel: result.parcel, alreadyOwned: true });
  }

  // Fresh grant committed — bust the owner read-cache so the render seam sees
  // the new parcel within the same request, then emit the leaderboard credit.
  readCache.delete(`owned:${avatarId}`);

  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.PARCEL_PURCHASED,
    userId: identity.userId,
    avatarId: identity.avatarId,
    agentId: identity.kind === 'agent' ? identity.agentId : null,
    payload: {
      parcelCode: result.parcel.parcelCode,
      tier: result.parcel.tier,
      amountCt: 0,
    },
  });

  return c.json({ parcel: result.parcel, alreadyOwned: false });
});
