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
 * `LandParcelDTO` is the shared parcel shape returned by every read route below.
 * `LandStructureDTO` is the shared structure shape (placement / upgrade / reads).
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
 *   type LandStructureDTO = {
 *     id: string;            // uuid
 *     parcelId: string;      // uuid (one structure per parcel)
 *     ownerAvatarId: string; // uuid (kept == parcel owner)
 *     structureType: 'home'|'shop';
 *     catalogKey: string;    // STRUCTURE_CATALOG key
 *     level: number;         // int 1..5
 *   };
 *
 * 1. GET /api/land/parcels?tier=&status=   (PUBLIC, 60s cache, 60/min/IP)
 *      200 → LandParcelDTO[]                   (flat array; status defaults 'available')
 *      400 → { error: 'invalid_query' }        (bad tier/status enum)
 *      429 → { error: 'rate_limited' }
 *
 * 2. GET /api/land/owned/:avatarId          (PUBLIC, 60/min/IP)
 *      200 → { parcels: LandParcelDTO[], structures: LandStructureDTO[] }
 *            ⚠ SHAPE CHANGE (2026-06-17, Phase 1): was a flat LandParcelDTO[].
 *            Now an OBJECT so the render seam gets parcels + their structures in
 *            one call. Callers must read `.parcels` (the flat array moved under it).
 *      400 → { error: 'invalid_avatar_id' }    (not a uuid)
 *      429 → { error: 'rate_limited' }
 *
 * 3. GET /api/land/me                        (AUTH: human cookie OR agent session)
 *      200 → { avatarId: string, parcels: LandParcelDTO[], structures: LandStructureDTO[] }
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
 *
 * ── Phase 1 / Slice B — priced primary sale + structures (PARITY-BOUND) ───────
 *
 * 5. GET /api/land/parcels/:parcelId/structure   (PUBLIC, 60/min/IP)
 *      200 → { structure: LandStructureDTO | null }   (null = no structure placed)
 *      400 → { error: 'invalid_parcel_id' }    ·   429 → { error: 'rate_limited' }
 *
 * 6. GET /api/land/catalog?tier=                  (PUBLIC, 60/min/IP)
 *      with tier  → 200 → { tier, maxLevel, premium,
 *                           homeSkus: {key,label}[], shopSkus: {key,label}[],
 *                           upgradeCosts: number[] }
 *      no tier    → 200 → { tiers: Record<LandTier, {maxLevel,premium,homeSkus,shopSkus}>,
 *                           upgradeCosts: number[] }
 *      400 → { error: 'invalid_tier' }         ·   429 → { error: 'rate_limited' }
 *
 * 7. POST /api/land/parcels/:parcelId/buy         (AUTH, PARITY-BOUND, priced sale)
 *      body: {} (empty / none — .strict(); NO client price reaches the debit)
 *      200 → { parcel: LandParcelDTO, amountCt: number }
 *            amountCt = the SERVER-read `land_parcels.price_ct` that was debited.
 *      400 → { error: 'invalid_body' | 'invalid_parcel_id' | 'insufficient_clawtokens' }
 *      401 → no identity   ·   403 → bound user has no active avatar
 *      404 → { error: 'parcel_not_found' }
 *      409 → { error: 'parcel_not_available' | 'parcel_cap_reached' }
 *      501 → { error: 'founder_not_in_v1' }    (Founder = auction/USDC, priceCt NULL)
 *      Single-charge safety = the status flip 'available'→'owned' under the
 *      per-avatar advisory lock + `SELECT … FOR UPDATE` (a replay sees 'owned' → 409).
 *
 * 8. POST /api/land/parcels/:parcelId/structure   (AUTH, PARITY-BOUND, free Lv1)
 *      body: { structureType: 'home'|'shop', catalogKey: string }  (.strict())
 *      200 → { structure: LandStructureDTO }    (level 1, no CT charge)
 *      400 → { error: 'invalid_body' | 'invalid_parcel_id'
 *                     | 'invalid_catalog_key' | 'sku_not_allowed_for_tier' }
 *      401/403 as above   ·   403 → { error: 'not_parcel_owner' }
 *      404 → { error: 'parcel_not_found' }
 *      409 → { error: 'structure_exists' }      (one structure per parcel, UNIQUE)
 *
 * 9. POST /api/land/structures/:structureId/upgrade  (AUTH, PARITY-BOUND, priced)
 *      body: { idempotencyKey: string (1..64) }  (.strict(), REQUIRED)
 *            REQUIRED (Codex BLOCK HIGH): a keyless retry would be charged AGAIN
 *            as a fresh Lv+1 upgrade — a paid double-charge. The client MUST send
 *            the same key to make a retry a no-op replay. (Frontend already does.)
 *      200 → { structure: LandStructureDTO, costCt: number, idempotencyReplay?: true }
 *            costCt = SERVER-derived STRUCTURE_UPGRADE_COSTS[target]; target=level+1.
 *            idempotencyReplay=true → a prior upgrade with the same key was served
 *            (no new debit, structure already at to_level).
 *      400 → { error: 'invalid_body' | 'idempotency_key_required' |
 *                       'invalid_structure_id' | 'insufficient_clawtokens' }
 *            invalid_body = unparseable JSON OR a stray/wrong-typed field;
 *            idempotency_key_required = the body parsed but the key was absent/empty
 *              (rejected BEFORE any advisory lock / debit / mutation).
 *      401/403 as above   ·   403 → { error: 'not_structure_owner' }
 *      404 → { error: 'structure_not_found' }
 *      409 → { error: 'tier_max_level' | 'max_level_reached' |
 *                       'idempotency_key_conflict' | 'ownership_desync' }
 *            tier_max_level = the TIER GATE (target > getTierMaxLevel(parcel.tier));
 *            max_level_reached = target > MAX_STRUCTURE_LEVEL (global Lv5 ceiling);
 *            idempotency_key_conflict = the idempotencyKey was already spent on a
 *              DIFFERENT structure (the index is global on idempotency_key) — reuse
 *              a fresh key per upgrade. Ownership is asserted BEFORE any replay, so
 *              a key cannot be used to read/replay another avatar's structure;
 *            ownership_desync = the structure's denorm owner disagrees with the
 *              AUTHORITATIVE land_parcels.owner_avatar_id (data drift) — the money
 *              op is refused rather than charged against a stale denorm. Ownership
 *              is checked against the LOCKED parcel row (FOR UPDATE OF s, p), never
 *              the denorm alone.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PHASE3: expose buy / structure / upgrade via the agent tools.json surface +
 * the npc-simulation `[ACTION:]` whitelist + a PROTOCOL_VERSION bump, so a
 * connected Hatcher agent can run the land economy through its action channel
 * (not just the authed HTTP path). The HTTP routes already bind to the agent's
 * own avatar via `requireAuthOrAgentSession` (E5 settlement parity) — Phase 3
 * is purely the DISCOVERY/whitelist surface, NOT a settlement change. Do NOT
 * touch the partner/hatcher surface or skill-protocol.ts in THIS diff.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  db,
  landParcels,
  landStructures,
  landUpgrades,
  eq,
  and,
  sql,
} from '@clawville/database';
import {
  LAND_EVENT_TYPES,
  LAND_TIERS,
  STRUCTURE_UPGRADE_COSTS,
  MAX_STRUCTURE_LEVEL,
  MAX_PARCELS_PER_AVATAR,
  getCatalogEntry,
  getTierStructureRules,
  getTierMaxLevel,
  isSkuAllowedForTier,
  type LandTier,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { logEventFromContext } from '../services/event-logger';
import { debitClawTokens, InsufficientTokensError } from '../services/claw-token-ledger';
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

/** The frozen structure DTO returned by placement / upgrade / structure reads. */
interface LandStructureDTO {
  id: string;
  parcelId: string;
  ownerAvatarId: string;
  structureType: 'home' | 'shop';
  catalogKey: string;
  level: number;
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
const parcelIdSchema = z.string().uuid();
const structureIdSchema = z.string().uuid();

// buy takes NO input — the price is read from `land_parcels.price_ct`, never the
// body. Reject any stray field so a client cannot smuggle a price/tier/etc.
const buyBodySchema = z.object({}).strict();

// placement: server validates the SKU against the parcel's tier; the body only
// declares WHICH catalog model + type. No level / price (placement is free Lv1).
const placeStructureBodySchema = z
  .object({
    structureType: z.enum(['home', 'shop']),
    catalogKey: z.string().min(1).max(64),
  })
  .strict();

// upgrade: the only client input is a REQUIRED idempotency key (Codex BLOCK
// HIGH — keyless-replay double-charge). A retry MUST carry the same key or the
// server would treat the 2nd call as a fresh Lv+1 upgrade and debit AGAIN. The
// target level + cost are still server-derived (current level + 1 →
// STRUCTURE_UPGRADE_COSTS) — never client-trusted. The frontend already sends
// `upgradeStructure(structureId, idempotencyKey)`, so requiring it is
// contract-compatible.
const upgradeBodySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(64),
  })
  .strict();

// ─── 60s read cache + per-IP rate limit (mirror leaderboard `/agents`) ──────

const READ_CACHE_TTL_MS = 60_000;
const publicReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

interface ReadCacheEntry {
  payload: LandParcelDTO[];
  expiresAt: number;
}

// Keyed on the normalized query (`parcels:<tier>:<status>` route).
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

/**
 * Bust the for-sale ('available') parcel-list cache after a buy removes a parcel
 * from the pool. The public `/parcels` route caches under `parcels:<tier>:available`
 * AND `parcels:*:available` (the all-tiers browse), so a sold parcel must drop
 * BOTH or the for-sale list serves a stale entry for up to 60s.
 */
function bustParcelsAvailableCache(tier: LandTier): void {
  readCache.delete(`parcels:${tier}:available`);
  readCache.delete(`parcels:*:available`);
}

/** The combined owned-parcels+structures shape (routes 2 + 3). */
interface OwnedLandPayload {
  parcels: LandParcelDTO[];
  structures: LandStructureDTO[];
}

interface OwnedCacheEntry {
  payload: OwnedLandPayload;
  expiresAt: number;
}

// Keyed on `owned:<avatarId>` — the public render seam (route 2) + /me (route 3).
const ownedCache = new Map<string, OwnedCacheEntry>();

function getOwnedCache(avatarId: string): OwnedLandPayload | null {
  const hit = ownedCache.get(`owned:${avatarId}`);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    ownedCache.delete(`owned:${avatarId}`);
    return null;
  }
  return hit.payload;
}

function setOwnedCache(avatarId: string, payload: OwnedLandPayload): void {
  ownedCache.set(`owned:${avatarId}`, { payload, expiresAt: Date.now() + READ_CACHE_TTL_MS });
}

/** Bust the combined owned cache after any write that changes an avatar's holdings. */
function bustOwnedCache(avatarId: string): void {
  ownedCache.delete(`owned:${avatarId}`);
}

/** Fetch the combined owned parcels + structures for an avatar (cached). */
async function fetchOwnedLand(avatarId: string): Promise<OwnedLandPayload> {
  const [parcels, structures] = await Promise.all([
    fetchOwnedParcels(avatarId),
    fetchOwnedStructures(avatarId),
  ]);
  return { parcels, structures };
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

/** Drizzle row → structure DTO (typed select, no coercion needed). */
function toStructureDTO(row: {
  id: string;
  parcelId: string;
  ownerAvatarId: string;
  structureType: 'home' | 'shop';
  catalogKey: string;
  level: number;
}): LandStructureDTO {
  return {
    id: row.id,
    parcelId: row.parcelId,
    ownerAvatarId: row.ownerAvatarId,
    structureType: row.structureType,
    catalogKey: row.catalogKey,
    level: row.level,
  };
}

/** Shared owned-structures query (routes 2 + 3) — one indexed scan on owner_avatar_id. */
async function fetchOwnedStructures(avatarId: string): Promise<LandStructureDTO[]> {
  const rows = await db
    .select({
      id: landStructures.id,
      parcelId: landStructures.parcelId,
      ownerAvatarId: landStructures.ownerAvatarId,
      structureType: landStructures.structureType,
      catalogKey: landStructures.catalogKey,
      level: landStructures.level,
    })
    .from(landStructures)
    .where(eq(landStructures.ownerAvatarId, avatarId));
  return rows.map(toStructureDTO);
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

  const cached = getOwnedCache(avatarId);
  if (cached) return c.json(cached);

  const payload = await fetchOwnedLand(avatarId);
  setOwnedCache(avatarId, payload);
  return c.json(payload);
});

// ─── 3. GET /me  (AUTH) ─────────────────────────────────────────────────────

landRoutes.get('/me', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;
  // Bypass the cache for the owner's own view — a just-completed buy/place/upgrade
  // in the same session must be reflected immediately (the public /owned read can
  // tolerate up to 60s staleness; the owner's own /me cannot).
  const payload = await fetchOwnedLand(avatarId);
  return c.json({ avatarId, ...payload });
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
  bustOwnedCache(avatarId);

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 / Slice B — priced primary sale + structures (PARITY-BOUND)
//
// PHASE3: expose buy / structure / upgrade via the agent tools.json surface +
// the npc-simulation `[ACTION:]` whitelist + a PROTOCOL_VERSION bump so a
// connected Hatcher agent can run these through its action channel. The HTTP
// routes already settle to the agent's OWN avatar via requireAuthOrAgentSession
// (E5 parity) — Phase 3 is the discovery surface only. Do NOT touch the
// partner/hatcher surface or skill-protocol.ts in THIS diff.
// ─────────────────────────────────────────────────────────────────────────────

// ─── 5. GET /parcels/:parcelId/structure  (PUBLIC, rate-limited) ────────────

landRoutes.get('/parcels/:parcelId/structure', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const parsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!parsed.success) {
    return c.json({ error: 'invalid_parcel_id' }, 400);
  }
  const parcelId = parsed.data;

  const rows = await db
    .select({
      id: landStructures.id,
      parcelId: landStructures.parcelId,
      ownerAvatarId: landStructures.ownerAvatarId,
      structureType: landStructures.structureType,
      catalogKey: landStructures.catalogKey,
      level: landStructures.level,
    })
    .from(landStructures)
    .where(eq(landStructures.parcelId, parcelId))
    .limit(1);

  const structure = rows[0] ? toStructureDTO(rows[0]) : null;
  return c.json({ structure });
});

// ─── 6. GET /catalog?tier=  (PUBLIC, rate-limited — tier-gated SKU listing) ──

landRoutes.get('/catalog', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Build the {key,label} list for a tier's allowed SKUs (label from the catalog).
  const skuList = (keys: readonly string[]): { key: string; label: string }[] =>
    keys.map((key) => ({ key, label: getCatalogEntry(key)?.label ?? key }));

  const tierParam = c.req.query('tier');
  if (tierParam !== undefined) {
    const tierParsed = tierSchema.safeParse(tierParam);
    if (!tierParsed.success) {
      return c.json({ error: 'invalid_tier' }, 400);
    }
    const tier = tierParsed.data;
    const rules = getTierStructureRules(tier);
    return c.json({
      tier,
      maxLevel: rules.maxLevel,
      premium: rules.premium,
      homeSkus: skuList(rules.homeSkus),
      shopSkus: skuList(rules.shopSkus),
      upgradeCosts: STRUCTURE_UPGRADE_COSTS,
    });
  }

  // No tier → return every tier's rules in one shot (the parcel-map overlay reads all).
  const tiers = Object.fromEntries(
    LAND_TIERS.map((tier) => {
      const rules = getTierStructureRules(tier);
      return [
        tier,
        {
          maxLevel: rules.maxLevel,
          premium: rules.premium,
          homeSkus: skuList(rules.homeSkus),
          shopSkus: skuList(rules.shopSkus),
        },
      ];
    }),
  );
  return c.json({ tiers, upgradeCosts: STRUCTURE_UPGRADE_COSTS });
});

// ─── 7. POST /parcels/:parcelId/buy  (AUTH, PARITY-BOUND, priced primary sale) ─

landRoutes.post('/parcels/:parcelId/buy', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_parcel_id' }, 400);
  }
  const parcelId = idParsed.data;

  // No client value reaches the write — the price comes from the parcel row.
  const rawBody = await c.req.json().catch(() => ({}));
  if (!buyBodySchema.safeParse(rawBody).success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  interface BoughtParcel {
    id: string;
    parcelCode: string;
    tier: LandTier;
    status: 'available' | 'owned' | 'reserved' | 'retired';
    gridX: number;
    gridY: number;
    priceCt: number | null;
    ownerAvatarId: string | null;
  }

  let bought: { parcel: BoughtParcel; amountCt: number };
  try {
    bought = await db.transaction(async (tx) => {
      // (0) Per-avatar serialization FIRST (outer lock — deadlock order rule):
      // the cap COUNT below spans MANY parcel rows, so no single row lock can
      // bound it. The advisory lock keyed on the avatar serializes same-avatar
      // buys so two concurrent buys can't both pass the < cap check. Different
      // avatars hash to different keys and never block each other.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      // (a) Lock the parcel row (inner lock). price_ct + tier + status read here
      // are the SOLE source of truth — the body never carries a price.
      const parcelRows = await tx.execute<{
        id: string;
        parcel_code: string;
        tier: LandTier;
        status: string;
        price_ct: number | string | null;
        owner_avatar_id: string | null;
        grid_x: number | string;
        grid_y: number | string;
      }>(
        sql`SELECT id, parcel_code, tier, status, price_ct, owner_avatar_id, grid_x, grid_y
            FROM land_parcels
            WHERE id = ${parcelId}
            FOR UPDATE`,
      );
      const parcel = parcelRows[0];
      if (!parcel) {
        throw new HTTPException(404, { message: 'parcel_not_found' });
      }

      // (b) Single-charge safety: only an 'available' parcel can be bought. A
      // replayed/concurrent buy sees 'owned' (or reserved/retired) → 409, never
      // a second debit. The status flip below IS the idempotency key.
      if (parcel.status !== 'available') {
        throw new HTTPException(409, { message: 'parcel_not_available' });
      }

      // (c) Founder = auction/USDC-only in v1 (price_ct NULL). Also guard a
      // 0/NULL price from ever reaching debitClawTokens (which throws on amount<=0):
      // a 0-price row is the FREE starter path (claim-starter), not a priced buy.
      const priceCt = parcel.price_ct == null ? null : Number(parcel.price_ct);
      if (parcel.tier === 'founder' || priceCt == null || priceCt <= 0) {
        throw new HTTPException(501, { message: 'founder_not_in_v1' });
      }

      // (d) Ownership cap — COUNT under the advisory lock. Coerce the string
      // COUNT (PG wire) to a number BEFORE comparing, or it compares lexically.
      const countRows = await tx.execute<{ n: number | string }>(
        sql`SELECT COUNT(*)::int AS n FROM land_parcels WHERE owner_avatar_id = ${avatarId}`,
      );
      const ownedCount = Number(countRows[0]?.n ?? 0);
      if (ownedCount >= MAX_PARCELS_PER_AVATAR) {
        throw new HTTPException(409, { message: 'parcel_cap_reached' });
      }

      // (e) Debit IN THIS TX — a throw rolls back the status flip too. Throws
      // InsufficientTokensError (caught below) on a low balance.
      const debit = await debitClawTokens(
        {
          avatarId,
          amount: priceCt,
          reason: 'land_parcel_purchase',
          source: 'api',
          metadata: { parcelId: parcel.id, parcelCode: parcel.parcel_code, tier: parcel.tier },
        },
        tx,
      );

      // (f) Flip ownership available → owned.
      await tx.execute(
        sql`UPDATE land_parcels
            SET status = 'owned',
                owner_avatar_id = ${avatarId},
                acquired_at = now(),
                updated_at = now()
            WHERE id = ${parcel.id}`,
      );

      // (g) Land-domain audit row (burn-sink: buyer debited, no treasury credit).
      const meta = JSON.stringify({ tier: parcel.tier, parcelCode: parcel.parcel_code });
      await tx.execute(
        sql`INSERT INTO land_transactions
              (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
            VALUES ('parcel_purchase', ${parcel.id}, ${avatarId}, ${priceCt}, ${debit.ledgerId}, ${meta}::jsonb)`,
      );

      return {
        parcel: {
          id: parcel.id,
          parcelCode: parcel.parcel_code,
          tier: parcel.tier,
          status: 'owned' as const,
          gridX: Number(parcel.grid_x),
          gridY: Number(parcel.grid_y),
          priceCt,
          ownerAvatarId: avatarId,
        },
        amountCt: priceCt,
      };
    });
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      return c.json({ error: 'insufficient_clawtokens' }, 400);
    }
    if (err instanceof HTTPException) {
      // Map the in-tx HTTPExceptions to the documented JSON error bodies.
      const code = err.message;
      const status = err.status;
      return c.json({ error: code }, status as 404 | 409 | 501);
    }
    throw err;
  }

  // Committed — bust the owner's combined cache AND the for-sale pool cache for
  // this tier (the parcel left 'available'). Then emit the leaderboard credit.
  bustOwnedCache(avatarId);
  bustParcelsAvailableCache(bought.parcel.tier);

  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.PARCEL_PURCHASED,
    userId: identity.userId,
    avatarId: identity.avatarId,
    agentId: identity.kind === 'agent' ? identity.agentId : null,
    payload: {
      parcelCode: bought.parcel.parcelCode,
      tier: bought.parcel.tier,
      amountCt: bought.amountCt,
    },
  });

  return c.json({ parcel: bought.parcel, amountCt: bought.amountCt });
});

// ─── 8. POST /parcels/:parcelId/structure  (AUTH, PARITY-BOUND, free Lv1) ────

landRoutes.post('/parcels/:parcelId/structure', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_parcel_id' }, 400);
  }
  const parcelId = idParsed.data;

  const rawBody = await c.req.json().catch(() => ({}));
  const bodyParsed = placeStructureBodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const { structureType, catalogKey } = bodyParsed.data;

  // Clean 400 for an unknown key BEFORE the tier gate (isSkuAllowedForTier also
  // rejects it, but a distinct error code is friendlier to the client).
  if (getCatalogEntry(catalogKey) === null) {
    return c.json({ error: 'invalid_catalog_key' }, 400);
  }

  let placed: { structure: LandStructureDTO; tier: LandTier; parcelCode: string };
  try {
    placed = await db.transaction(async (tx) => {
      // Per-avatar advisory lock (outer), then the parcel row (inner) — same
      // deadlock order as buy.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      const parcelRows = await tx.execute<{
        id: string;
        parcel_code: string;
        tier: LandTier;
        owner_avatar_id: string | null;
      }>(
        sql`SELECT id, parcel_code, tier, owner_avatar_id
            FROM land_parcels
            WHERE id = ${parcelId}
            FOR UPDATE`,
      );
      const parcel = parcelRows[0];
      if (!parcel) {
        throw new HTTPException(404, { message: 'parcel_not_found' });
      }
      if (parcel.owner_avatar_id !== avatarId) {
        throw new HTTPException(403, { message: 'not_parcel_owner' });
      }

      // SERVER-authoritative tier gate — the SKU must be allowed for THIS
      // parcel's tier (read from the row, never the body). Rejects founder SKUs
      // on lower tiers AND home-key-as-shop type confusion.
      if (!isSkuAllowedForTier(catalogKey, structureType, parcel.tier)) {
        throw new HTTPException(400, { message: 'sku_not_allowed_for_tier' });
      }

      // Insert the free Lv1 structure. The `parcel_id` UNIQUE constraint is the
      // race-safe one-structure-per-parcel backstop (catch 23505 → 409).
      const insertRows = await tx.execute<{
        id: string;
        parcel_id: string;
        owner_avatar_id: string;
        structure_type: 'home' | 'shop';
        catalog_key: string;
        level: number | string;
      }>(
        sql`INSERT INTO land_structures
              (parcel_id, owner_avatar_id, structure_type, catalog_key, level)
            VALUES (${parcel.id}, ${avatarId}, ${structureType}, ${catalogKey}, 1)
            RETURNING id, parcel_id, owner_avatar_id, structure_type, catalog_key, level`,
      );
      const row = insertRows[0];

      // Land-domain audit row — free placement (amount_ct = 0, no ledger debit).
      const meta = JSON.stringify({
        structureType,
        catalogKey,
        tier: parcel.tier,
        parcelCode: parcel.parcel_code,
      });
      await tx.execute(
        sql`INSERT INTO land_transactions
              (kind, parcel_id, structure_id, avatar_id, amount_ct, metadata)
            VALUES ('structure_placement', ${parcel.id}, ${row.id}, ${avatarId}, 0, ${meta}::jsonb)`,
      );

      return {
        structure: {
          id: row.id,
          parcelId: row.parcel_id,
          ownerAvatarId: row.owner_avatar_id,
          structureType: row.structure_type,
          catalogKey: row.catalog_key,
          level: Number(row.level),
        },
        tier: parcel.tier,
        parcelCode: parcel.parcel_code,
      };
    });
  } catch (err) {
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      // One structure per parcel — a concurrent/replayed placement raced us.
      return c.json({ error: 'structure_exists' }, 409);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as 400 | 403 | 404);
    }
    throw err;
  }

  bustOwnedCache(avatarId);

  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.STRUCTURE_PLACED,
    userId: identity.userId,
    avatarId: identity.avatarId,
    agentId: identity.kind === 'agent' ? identity.agentId : null,
    payload: {
      // parcelId is the stable join key (ARCHITECTURE.md §5a); parcelCode + tier
      // are richer human-readable extras (none read by leaderboard scoring).
      parcelId: placed.structure.parcelId,
      parcelCode: placed.parcelCode,
      structureType: placed.structure.structureType,
      catalogKey: placed.structure.catalogKey,
      tier: placed.tier,
    },
  });

  return c.json({ structure: placed.structure });
});

// ─── 9. POST /structures/:structureId/upgrade  (AUTH, PARITY-BOUND, priced) ──

landRoutes.post('/structures/:structureId/upgrade', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = structureIdSchema.safeParse(c.req.param('structureId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_structure_id' }, 400);
  }
  const structureId = idParsed.data;

  // Parse the body EXPLICITLY (Codex BLOCK HIGH — keyless-replay double-charge).
  // A malformed / missing JSON body must return `invalid_body` and can NEVER
  // silently become a keyless upgrade: we use a sentinel rather than
  // `.catch(() => ({}))` so an unparseable body is a hard 400, not an empty
  // object that slips toward a debit. The schema then REQUIRES idempotencyKey,
  // so an absent/empty key is `idempotency_key_required` — both rejected BEFORE
  // the advisory lock / FOR UPDATE / debit / mutation below.
  const PARSE_FAILED = Symbol('parse_failed');
  const rawBody: unknown = await c.req.json().catch(() => PARSE_FAILED);
  if (rawBody === PARSE_FAILED) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const bodyParsed = upgradeBodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    // Distinguish the missing/empty key (the money-safety invariant) from a
    // stray-field / wrong-type body so a retrying client gets an actionable code.
    const missingKey = bodyParsed.error.issues.some(
      (i) => i.path.length === 1 && i.path[0] === 'idempotencyKey',
    );
    return c.json(
      { error: missingKey ? 'idempotency_key_required' : 'invalid_body' },
      400,
    );
  }
  // REQUIRED + non-empty (schema-enforced) — never null on the debit path.
  const idempotencyKey = bodyParsed.data.idempotencyKey;

  type UpgradeResult =
    | { kind: 'upgraded'; structure: LandStructureDTO; costCt: number; tier: LandTier; fromLevel: number }
    | { kind: 'replay'; structure: LandStructureDTO; costCt: number };

  let result: UpgradeResult;
  try {
    result = await db.transaction(async (tx): Promise<UpgradeResult> => {
      // Per-avatar advisory lock (outer), then the structure row (inner).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      // (1) OWNERSHIP FIRST (audit-1 BLOCKING #1 + Codex BLOCK MED): lock the
      // structure AND its parent parcel (`FOR UPDATE OF s, p`), and assert the
      // caller owns it BEFORE any idempotency replay can return. Doing the replay
      // before this would let avatar B replay avatar A's upgrade by guessing A's
      // client-supplied key — an ownership bypass on a money route. Proving
      // ownership up front gates EVERY return.
      //
      // Ownership is checked against the AUTHORITATIVE `land_parcels.owner_avatar_id`
      // (Codex BLOCK MED — never trust the denormalized `land_structures.owner_avatar_id`
      // alone on a money path). We require BOTH: the parcel is owned by the caller,
      // AND the structure's denorm owner agrees with the parcel owner. If the two
      // ever drift (transfer bug / migration gap / direct SQL), a stale structure
      // owner can NOT pay to upgrade a parcel they no longer hold — the parcel row,
      // not the denorm, is the source of truth. Locking the parcel too closes the
      // TOCTOU (a concurrent transfer can't slip between our read and the debit).
      // The TIER is read from the locked parcel row (it always was).
      const rows = await tx.execute<{
        id: string;
        parcel_id: string;
        owner_avatar_id: string;
        parcel_owner_avatar_id: string | null;
        structure_type: 'home' | 'shop';
        catalog_key: string;
        level: number | string;
        tier: LandTier;
      }>(
        sql`SELECT s.id, s.parcel_id, s.owner_avatar_id,
                   p.owner_avatar_id AS parcel_owner_avatar_id,
                   s.structure_type, s.catalog_key, s.level, p.tier
            FROM land_structures s
            JOIN land_parcels p ON p.id = s.parcel_id
            WHERE s.id = ${structureId}
            FOR UPDATE OF s, p`,
      );
      const s = rows[0];
      if (!s) {
        throw new HTTPException(404, { message: 'structure_not_found' });
      }
      // Authoritative parcel ownership — the caller must own the PARCEL the
      // structure sits on. (A null parcel owner = unowned/for-sale → not yours.)
      if (s.parcel_owner_avatar_id !== avatarId) {
        throw new HTTPException(403, { message: 'not_structure_owner' });
      }
      // Defense-in-depth: the denorm must agree with the authoritative owner. A
      // mismatch signals data drift — refuse the money op rather than charge
      // against a stale denorm.
      if (s.owner_avatar_id !== s.parcel_owner_avatar_id) {
        throw new HTTPException(409, { message: 'ownership_desync' });
      }

      // (2) IDEMPOTENCY — owner-verified replay, index-aligned (audit-1 BLOCKING
      // #2). The `land_upgrades_idem_unique` index is on `idempotency_key` ALONE
      // (GLOBAL, not composite with structure_id). So we look the key up by
      // itself and branch on WHERE it was used:
      //   - prior row IS this structure  → legit retry → serve the cached replay
      //     (owner already verified above; no new debit).
      //   - prior row is a DIFFERENT structure → the key was already spent
      //     elsewhere → reject pre-debit with a clean 409 rather than letting it
      //     fall through to a 23505 on the INSERT that would roll back the debit
      //     AND lie "replayed" while silently dropping THIS structure's upgrade.
      if (idempotencyKey) {
        const priorRows = await tx.execute<{
          structure_id: string;
          to_level: number | string;
        }>(
          sql`SELECT structure_id, to_level FROM land_upgrades
              WHERE idempotency_key = ${idempotencyKey}
              LIMIT 1`,
        );
        const prior = priorRows[0];
        if (prior) {
          if (prior.structure_id !== structureId) {
            throw new HTTPException(409, { message: 'idempotency_key_conflict' });
          }
          const toLevel = Number(prior.to_level);
          // Serve the (already owner-verified) structure at its current level.
          return {
            kind: 'replay',
            structure: {
              id: s.id,
              parcelId: s.parcel_id,
              ownerAvatarId: s.owner_avatar_id,
              structureType: s.structure_type,
              catalogKey: s.catalog_key,
              level: Number(s.level),
            },
            costCt: STRUCTURE_UPGRADE_COSTS[toLevel] ?? 0,
          };
        }
      }

      // target/cost are SERVER-derived off the FRESH locked level — a concurrent
      // upgrade that committed first is reflected here (re-read under the lock).
      const level = Number(s.level);
      const target = level + 1;

      // THE tier gate: a structure cannot climb past its parcel-tier ceiling.
      if (target > getTierMaxLevel(s.tier)) {
        throw new HTTPException(409, { message: 'tier_max_level' });
      }
      // Global Lv5 ceiling (defense in depth; tier ceilings are all <= 5).
      if (target > MAX_STRUCTURE_LEVEL) {
        throw new HTTPException(409, { message: 'max_level_reached' });
      }

      const cost = STRUCTURE_UPGRADE_COSTS[target] ?? 0;
      // target >= 2 here always has cost > 0; guard anyway so debit never gets 0.
      let ledgerId: string | null = null;
      if (cost > 0) {
        const debit = await debitClawTokens(
          {
            avatarId,
            amount: cost,
            reason: 'land_structure_upgrade',
            source: 'api',
            metadata: { structureId, fromLevel: level, toLevel: target, tier: s.tier },
          },
          tx,
        );
        ledgerId = debit.ledgerId;
      }

      await tx.execute(
        sql`UPDATE land_structures SET level = ${target}, updated_at = now() WHERE id = ${structureId}`,
      );

      // Append-only upgrade audit. The partial-unique idempotency_key index trips
      // 23505 on a concurrent same-key retry (caught below → serve cached).
      await tx.execute(
        sql`INSERT INTO land_upgrades
              (structure_id, from_level, to_level, cost_ct, by_avatar_id, ledger_tx_id, idempotency_key)
            VALUES (${structureId}, ${level}, ${target}, ${cost}, ${avatarId}, ${ledgerId}, ${idempotencyKey})`,
      );

      const meta = JSON.stringify({ fromLevel: level, toLevel: target, tier: s.tier });
      await tx.execute(
        sql`INSERT INTO land_transactions
              (kind, parcel_id, structure_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
            VALUES ('structure_upgrade', ${s.parcel_id}, ${structureId}, ${avatarId}, ${cost}, ${ledgerId}, ${meta}::jsonb)`,
      );

      return {
        kind: 'upgraded',
        structure: {
          id: s.id,
          parcelId: s.parcel_id,
          ownerAvatarId: s.owner_avatar_id,
          structureType: s.structure_type,
          catalogKey: s.catalog_key,
          level: target,
        },
        costCt: cost,
        tier: s.tier,
        fromLevel: level,
      };
    });
  } catch (err) {
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505' && idempotencyKey) {
      // Concurrent same-key upgrade won the race: its INSERT landed AFTER our
      // in-tx pre-check read (step 2 above), so OURS tripped the GLOBAL
      // idempotency_key unique index and rolled back our debit. Because the
      // pre-check already rejects CROSS-structure key reuse with a clean 409
      // (BLOCKING #2 fix), a 23505 reaching here can only be a same-structure,
      // same-key winner. We look the winner up and DEFENSIVELY assert it really
      // is THIS structure before serving — if (impossibly) it's a different
      // structure, we return the conflict 409 rather than disclose/serve another
      // structure's row to a caller who only owns THIS one (ownership safety).
      const winnerRows = await db
        .select({
          structureId: landUpgrades.structureId,
          toLevel: landUpgrades.toLevel,
        })
        .from(landUpgrades)
        .where(eq(landUpgrades.idempotencyKey, idempotencyKey))
        .limit(1);
      const winner = winnerRows[0];
      if (winner) {
        if (winner.structureId !== structureId) {
          return c.json({ error: 'idempotency_key_conflict' }, 409);
        }
        // Ownership of `structureId` was proven inside the tx before the INSERT
        // that 23505'd, so re-reading the REQUESTED structure here is owner-safe.
        const cachedRows = await db
          .select({
            id: landStructures.id,
            parcelId: landStructures.parcelId,
            ownerAvatarId: landStructures.ownerAvatarId,
            structureType: landStructures.structureType,
            catalogKey: landStructures.catalogKey,
            level: landStructures.level,
          })
          .from(landStructures)
          .where(eq(landStructures.id, structureId))
          .limit(1);
        const cached = cachedRows[0];
        if (cached) {
          return c.json(
            {
              structure: toStructureDTO(cached),
              costCt: STRUCTURE_UPGRADE_COSTS[winner.toLevel] ?? 0,
              idempotencyReplay: true,
            },
            200,
          );
        }
      }
    }
    if (err instanceof InsufficientTokensError) {
      return c.json({ error: 'insufficient_clawtokens' }, 400);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as 403 | 404 | 409);
    }
    throw err;
  }

  bustOwnedCache(avatarId);

  if (result.kind === 'replay') {
    return c.json({
      structure: result.structure,
      costCt: result.costCt,
      idempotencyReplay: true,
    });
  }

  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.STRUCTURE_UPGRADED,
    userId: identity.userId,
    avatarId: identity.avatarId,
    agentId: identity.kind === 'agent' ? identity.agentId : null,
    payload: {
      structureId: result.structure.id,
      fromLevel: result.fromLevel,
      toLevel: result.structure.level,
      costCt: result.costCt,
      tier: result.tier,
    },
  });

  return c.json({ structure: result.structure, costCt: result.costCt });
});
