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
 *     priceCt: number | null;// int CT or null (LEGACY buy price — buy is disabled in Phase B)
 *     ownerAvatarId: string | null; // uuid or null (for-sale)
 *     rentCtWeekly: number | null;  // int CT/wk — deposit draw (starter) or hold
 *                                   // upkeep (c/b/a/founder); null = not stamped
 *     tenure: 'rented'|'owned'|'starter'|'deposit'|'hold'|null; // HOW the parcel is held; null = available/unsold
 *     // ── Phase B additive fields (2026-07-07; null on non-deposit/non-hold rows) ──
 *     depositCt: number | null;          // B1: original claim deposit (immutable)
 *     depositRemainingCt: number | null; // B1: live escrow remainder (top-up when low!)
 *     holdThresholdCt: number | null;    // B2: stamped CLV threshold (CLV uiAmount)
 *   };
 *
 *   type LandStructureDTO = {
 *     id: string;            // uuid
 *     parcelId: string;      // uuid (one structure per parcel)
 *     ownerAvatarId: string; // uuid (kept == parcel owner)
 *     structureType: 'home'|'shop';
 *     catalogKey: string;    // STRUCTURE_CATALOG key
 *     level: number;         // int 1..5
 *     shellKey: string;      // SHELL_CATALOG key
 *     paletteKey: string;    // PALETTE_PRESETS key
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
 *      PHASE B (2026-07-07): the claim now debits a REFUNDABLE
 *      LAND_STARTER_DEPOSIT_CT (2000) INTO ESCROW — no treasury credit at claim
 *      time (the deposit is not revenue; the weekly sweep draws rent from it).
 *      body: {} (empty / none — extra fields rejected, .strict())
 *      200 → { parcel: LandParcelClaimDTO, alreadyOwned: boolean,
 *              depositCt?: number, depositRemainingCt?: number }
 *            where LandParcelClaimDTO = Omit<LandParcelDTO, 'ownerAvatarId'>
 *            (a fresh claim carries tenure='deposit',
 *             rentCtWeekly=LAND_STARTER_RENT_CT_WEEKLY, depositCt=depositRemainingCt=2000)
 *            alreadyOwned=true  → the avatar already held a starter-tier parcel
 *              (legacy tenure='starter' OR Phase-B 'deposit') — NO charge, no event
 *            alreadyOwned=false → a starter parcel was granted + deposit escrowed this call
 *      400 → { error: 'invalid_body' | 'insufficient_clawtokens' }
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
 * 7. POST /api/land/parcels/:parcelId/buy         (DISABLED — Phase B, 2026-07-07)
 *      409 → { error: 'tenure_model_active' } for ALL tiers, unconditionally.
 *      Land is never sold permanently under the founder-locked tenure model:
 *      starter → POST /claim-starter (deposit-escrow); c/b/a/founder →
 *      POST /parcels/:parcelId/claim-hold (CLV hold-to-keep). The pre-Phase-B
 *      priced-sale implementation lives in git history (<= this diff's parent).
 *      POST /parcels/:parcelId/rent is disabled identically.
 *
 * 7b. POST /api/land/parcels/:parcelId/claim-hold  (AUTH, PARITY-BOUND, Phase B2)
 *      body: {} (.strict()) — NO client value reaches the write.
 *      Requires the subject's CLV balance ≥ Σ(stacked thresholds of its
 *      non-grandfathered holds) + holdThresholdForTier(tier). NO CT debit at
 *      claim; weekly upkeep (rent_ct_weekly; founder-stamped 2400) is drawn by
 *      the sweeper from the holder's avatar CT → treasury.
 *      200 → { parcel: LandParcelDTO, requiredClv: number, heldClv: number }
 *      400 → { error: 'invalid_body' | 'invalid_parcel_id' | 'use_claim_starter' }
 *      401 → no identity   ·   403 → bound user has no active avatar
 *      403 → { error: 'wallet_not_linked' }      (human with no linked wallet)
 *      403 → { error: 'agent_wallet_missing' }   (agent avatar with no custodial pubkey)
 *      403 → { error: 'insufficient_clv_hold', requiredClv, heldClv }
 *      404 → { error: 'parcel_not_found' }
 *      409 → { error: 'parcel_not_available' | 'parcel_cap_reached' }
 *      503 → { error: 'clv_balance_unavailable' } (FAIL-CLOSED: RPC/read down)
 *
 * 7c. POST /api/land/parcels/:parcelId/deposit-topup  (AUTH, PARITY-BOUND, B1)
 *      body: { amountCt: int 1..1_000_000 } (.strict()) — the ONLY client value,
 *      and it is a self-debit ceiling-capped by Zod, never a price.
 *      200 → { parcelCode, depositRemainingCt, amountCt, graceCleared: boolean }
 *      400 → { error: 'invalid_body' | 'invalid_parcel_id' | 'insufficient_clawtokens' }
 *      403 → { error: 'not_parcel_owner' }   ·   404 → { error: 'parcel_not_found' }
 *      409 → { error: 'not_deposit_tenure' }
 *
 * 7d. POST /api/land/parcels/:parcelId/release   (AUTH, PARITY-BOUND, B1+B2)
 *      body: {} (.strict()). Voluntary release: tenure='deposit' refunds the
 *      escrow remainder to the claimant; tenure='hold' refunds NOTHING. Both
 *      revert the parcel to the pool + archive its active structure.
 *      200 → { released: true, refundedCt: number, parcel: LandParcelDTO }
 *      400 → { error: 'invalid_body' | 'invalid_parcel_id' }
 *      403 → { error: 'not_parcel_owner' }   ·   404 → { error: 'parcel_not_found' }
 *      409 → { error: 'not_releasable_tenure' } (tenure not deposit|hold)
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
 *
 * 10. GET /api/land/structures/public             (PUBLIC, 60/min/IP)
 *      200 → PublicLandStructureDTO[]              (active-only, no owner identity)
 *      Server cache 60s; HTTP Cache-Control public, max-age=30.
 *
 * 11. PATCH /api/land/structures/:structureId/appearance  (AUTH, PARITY-BOUND)
 *      body: { shellKey?: string, paletteKey?: string } (.strict(), at least one)
 *      200 → { structure: LandStructureDTO }
 *      400 → { error: 'invalid_body' | 'invalid_structure_id' |
 *                       'shell_not_allowed' | 'palette_not_allowed' }
 *      403 → { error: 'not_structure_owner' }
 *      404 → { error: 'structure_not_found' }
 *      409 → { error: 'structure_archived' | 'ownership_desync' }
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
  avatars,
  landParcels,
  landStructures,
  landUpgrades,
  serviceListings,
  servicePurchases,
  agentBots,
  eq,
  and,
  desc,
  sql,
} from '@clawville/database';
import {
  LAND_EVENT_TYPES,
  LAND_TIERS,
  STRUCTURE_UPGRADE_COSTS,
  MAX_STRUCTURE_LEVEL,
  MAX_PARCELS_PER_AVATAR,
  RENT_PERIOD_DAYS,
  LAND_STARTER_DEPOSIT_CT,
  LAND_STARTER_RENT_CT_WEEKLY,
  FOUNDER_UPKEEP_CT_WEEKLY,
  holdThresholdForTier,
  getCatalogEntry,
  getTierStructureRules,
  getTierMaxLevel,
  isSkuAllowedForTier,
  isShellAllowed,
  isPaletteAllowed,
  DEFAULT_SHELL_KEY,
  DEFAULT_PALETTE_KEY,
  type LandTier,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
} from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { noStorePrivate } from '../middleware/no-store';
import { logEventFromContext } from '../services/event-logger';
import { broadcastLandEvent } from './world';
import {
  debitClawTokens,
  creditClawTokens,
  InsufficientTokensError,
} from '../services/claw-token-ledger';
import { type CovenantActorKind } from '../services/covenant-action-recorder';
import { getHouseTreasuryAvatarId } from '../services/house-treasury-seeder';
import {
  getLinkedWalletClvBalance,
  getWalletClvBalance,
  type ClvBalanceResult,
} from '../services/linked-wallet-clv-balance';
import type { AppContext } from '../types';

/** Map the auth identity kind onto the covenant actor vocabulary. */
const toActorKind = (kind: 'user' | 'agent'): CovenantActorKind =>
  kind === 'user' ? 'human' : 'agent';

// ─── shared shapes ──────────────────────────────────────────────────────────

/**
 * Parcel tenure — HOW a parcel is held; NULL on an available/unsold parcel.
 * Phase B (2026-07-07): 'deposit' = starter deposit-escrow; 'hold' = CLV
 * hold-to-keep (c/b/a/founder). 'owned'/'starter' are legacy (grandfathered).
 */
type LandTenure = 'rented' | 'owned' | 'starter' | 'deposit' | 'hold';

/**
 * Thrown inside the claim-hold tx when the subject's CLV balance is below the
 * stacked hold requirement — carries both numbers so the 403 body can tell the
 * caller exactly how much CLV the claim needs vs what the wallet holds.
 */
class InsufficientClvHoldError extends Error {
  constructor(
    public readonly requiredClv: number,
    public readonly heldClv: number,
  ) {
    super('insufficient_clv_hold');
    this.name = 'InsufficientClvHoldError';
  }
}

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
  /**
   * Weekly CT amount (server-stamped `land_parcels.rent_ct_weekly`): the escrow
   * draw for a 'deposit' starter, the upkeep for a 'hold' parcel, the legacy
   * rent for a 'rented' one. Null = not stamped.
   */
  rentCtWeekly: number | null;
  /** HOW the parcel is held; null = available/unsold (mirrors `land_tenure` enum). */
  tenure: LandTenure | null;
  /** B1: original claim deposit escrowed (immutable); null on non-deposit rows. */
  depositCt: number | null;
  /** B1: live escrow remainder (see the schema conservation invariant); null on non-deposit rows. */
  depositRemainingCt: number | null;
  /** B2: stamped CLV hold threshold (CLV uiAmount); null on non-hold rows. */
  holdThresholdCt: number | null;
}

/** The frozen structure DTO returned by placement / upgrade / structure reads. */
interface LandStructureDTO {
  id: string;
  parcelId: string;
  ownerAvatarId: string;
  structureType: 'home' | 'shop';
  catalogKey: string;
  level: number;
  shellKey: string;
  paletteKey: string;
}

/** Public world-render feed; intentionally omits owner identity and DB UUIDs. */
export interface PublicLandStructureDTO {
  parcelCode: string;
  gridX: number;
  gridY: number;
  tier: LandTier;
  structureType: 'home' | 'shop';
  level: number;
  shellKey: string;
  paletteKey: string;
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

// claim-hold + release take NO input — every value is server-resolved. Reject
// any stray field so a client cannot smuggle a price/tier/threshold/etc.
const emptyStrictBodySchema = z.object({}).strict();

// deposit-topup: the ONLY client value is the top-up amount — a SELF-debit into
// the caller's own escrow, hard-capped by Zod (1..1_000_000). It is never a
// price and never reaches any other avatar's balance.
const depositTopupBodySchema = z
  .object({
    amountCt: z.number().int().min(1).max(1_000_000),
  })
  .strict();

// placement: server validates the SKU against the parcel's tier; the body only
// declares WHICH catalog model + type. No level / price (placement is free Lv1).
const placeStructureBodySchema = z
  .object({
    structureType: z.enum(['home', 'shop']),
    catalogKey: z.string().min(1).max(64),
  })
  .strict();

/** Appearance is a free, partial mutation; empty and stray-key patches are invalid. */
export const appearanceBodySchema = z
  .object({
    shellKey: z.string().min(1).max(64).optional(),
    paletteKey: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => value.shellKey !== undefined || value.paletteKey !== undefined, {
    message: 'at least one appearance field is required',
  });

export interface AppearanceAuthority {
  ownerAvatarId: string;
  parcelOwnerAvatarId: string | null;
  status: 'active' | 'archived';
  structureType: 'home' | 'shop';
  level: number;
  tier: LandTier;
}

export type AppearanceValidationError =
  | 'not_structure_owner'
  | 'ownership_desync'
  | 'structure_archived'
  | 'shell_not_allowed'
  | 'palette_not_allowed';

/** Pure authorization/allowlist seam used by the route after its locked DB read. */
export function validateAppearanceMutation(
  authority: AppearanceAuthority,
  avatarId: string,
  patch: z.infer<typeof appearanceBodySchema>,
): AppearanceValidationError | null {
  if (authority.parcelOwnerAvatarId !== avatarId) return 'not_structure_owner';
  if (authority.ownerAvatarId !== authority.parcelOwnerAvatarId) return 'ownership_desync';
  if (authority.status !== 'active') return 'structure_archived';
  if (
    patch.shellKey !== undefined
    && !isShellAllowed(
      authority.structureType,
      authority.level,
      authority.tier,
      patch.shellKey,
    )
  ) {
    return 'shell_not_allowed';
  }
  if (
    patch.paletteKey !== undefined
    && !isPaletteAllowed(authority.level, patch.paletteKey)
  ) {
    return 'palette_not_allowed';
  }
  return null;
}

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

// ─── Service listings (run-a-store, Slice 4) ────────────────────────────────

const listingIdSchema = z.string().uuid();

// list: server derives structureId from the path + ownerAvatarId from
// identity — the body only declares the sellable content. `.strict()`
// rejects stray fields (no kind/status/platformFeeBps smuggling).
const listServiceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().max(500).optional(),
    priceCt: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();

// update/deactivate: every field optional, but at least one must be present
// (an empty patch is a no-op the client should not be sending).
const updateServiceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    priceCt: z.number().int().nonnegative().max(1_000_000).optional(),
    status: z.enum(['active', 'paused', 'delisted']).optional(),
  })
  .strict()
  .refine((val) => Object.keys(val).length > 0, {
    message: 'at least one field is required',
  });

// browse: GET /api/land/services?page=&limit= — page >= 1, limit clamped 1..50.
const servicesPageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

// buy: the ONLY client input is a REQUIRED idempotency key (same Codex
// BLOCK-HIGH rationale as /upgrade — a keyless retry would double-charge).
// The price is always server-read from the locked listing row.
const buyServiceBodySchema = z
  .object({
    idempotencyKey: z.string().min(8).max(64),
  })
  .strict();

// spawn-preference (town-fast-travel, 2026-06-19): the avatar's re-spawn target.
// `mode='town'` clears any home; `mode='home'` REQUIRES a `parcelId` the caller
// owns (server-verified against land_parcels.owner_avatar_id). The `.strict()`
// rejects stray fields; the `superRefine` enforces the home→parcelId dependency
// at parse time so the handler can trust a present parcelId on the home branch.
const spawnPreferenceBodySchema = z
  .object({
    mode: z.enum(['home', 'town']),
    parcelId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'home' && !val.parcelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'parcelId is required when mode is "home"',
        path: ['parcelId'],
      });
    }
  });

// ─── 60s read cache + per-IP rate limit (mirror leaderboard `/agents`) ──────

const READ_CACHE_TTL_MS = 60_000;
const publicReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

interface ReadCacheEntry {
  payload: LandParcelDTO[];
  expiresAt: number;
}

// Keyed on the normalized query (`parcels:<tier>:<status>` route).
const readCache = new Map<string, ReadCacheEntry>();

let publicStructuresCache: {
  payload: PublicLandStructureDTO[];
  expiresAt: number;
} | null = null;

function getPublicStructuresCache(): PublicLandStructureDTO[] | null {
  if (publicStructuresCache === null) return null;
  if (publicStructuresCache.expiresAt < Date.now()) {
    publicStructuresCache = null;
    return null;
  }
  return publicStructuresCache.payload;
}

function setPublicStructuresCache(payload: PublicLandStructureDTO[]): void {
  publicStructuresCache = { payload, expiresAt: Date.now() + READ_CACHE_TTL_MS };
}

/** Bust after any write that can change an active structure's public render. */
export function bustPublicStructuresCache(): void {
  publicStructuresCache = null;
}

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
export function bustParcelsAvailableCache(tier: LandTier): void {
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
export function bustOwnedCache(avatarId: string): void {
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
  rentCtWeekly: number | null;
  tenure: LandTenure | null;
  depositCt: number | null;
  depositRemainingCt: number | null;
  holdThresholdCt: number | null;
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
    rentCtWeekly: row.rentCtWeekly,
    tenure: row.tenure,
    depositCt: row.depositCt,
    depositRemainingCt: row.depositRemainingCt,
    holdThresholdCt: row.holdThresholdCt,
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
      rentCtWeekly: landParcels.rentCtWeekly,
      tenure: landParcels.tenure,
      depositCt: landParcels.depositCt,
      depositRemainingCt: landParcels.depositRemainingCt,
      holdThresholdCt: landParcels.holdThresholdCt,
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
  shellKey: string | null;
  paletteKey: string | null;
}): LandStructureDTO {
  return {
    id: row.id,
    parcelId: row.parcelId,
    ownerAvatarId: row.ownerAvatarId,
    structureType: row.structureType,
    catalogKey: row.catalogKey,
    level: row.level,
    // Rolling-deploy safety: never rely on a renderer-side implicit default.
    shellKey: row.shellKey ?? DEFAULT_SHELL_KEY,
    paletteKey: row.paletteKey ?? DEFAULT_PALETTE_KEY,
  };
}

/** Typed row mapper for the public world feed, including rolling-deploy fallbacks. */
export function toPublicLandStructureDTO(row: {
  parcelCode: string;
  gridX: number;
  gridY: number;
  tier: LandTier;
  structureType: 'home' | 'shop';
  level: number;
  shellKey: string | null;
  paletteKey: string | null;
}): PublicLandStructureDTO {
  return {
    parcelCode: row.parcelCode,
    gridX: row.gridX,
    gridY: row.gridY,
    tier: row.tier,
    structureType: row.structureType,
    level: row.level,
    shellKey: row.shellKey ?? DEFAULT_SHELL_KEY,
    paletteKey: row.paletteKey ?? DEFAULT_PALETTE_KEY,
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
      shellKey: landStructures.shellKey,
      paletteKey: landStructures.paletteKey,
    })
    .from(landStructures)
    // Exclude eviction-archived structures — they belong to a parcel the avatar
    // no longer holds, so they must not show in "my structures" or the renderer.
    .where(and(eq(landStructures.ownerAvatarId, avatarId), eq(landStructures.status, 'active')));
  return rows.map(toStructureDTO);
}

/**
 * Drizzle transaction handle — lets the acquire helper run inside the route's
 * existing tx (mirrors the `LedgerTx` alias in claw-token-ledger).
 */
type LandTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * On acquiring (buy/rent) a parcel that may be returning from an eviction,
 * reconcile any leftover ARCHIVED structure under the already-held parcel lock:
 *   - the SAME avatar re-acquiring  -> restore it (status -> 'active'), build intact;
 *   - a DIFFERENT avatar acquiring  -> purge it (DELETE) so they build fresh and
 *     the one-structure-per-parcel UNIQUE doesn't block their placement.
 * Active structures never sit on an `available` parcel by construction (eviction
 * archives them), so only the archived case is handled. Must be called with the
 * parcel row already locked FOR UPDATE in the same tx.
 */
async function reconcileArchivedStructureOnAcquire(
  tx: LandTx,
  parcelId: string,
  acquirerAvatarId: string,
): Promise<void> {
  const rows = await tx.execute<{ id: string; owner_avatar_id: string; status: string }>(
    sql`SELECT id, owner_avatar_id, status FROM land_structures
        WHERE parcel_id = ${parcelId}
        FOR UPDATE`,
  );
  const s = rows[0];
  if (!s || s.status !== 'archived') return;
  if (s.owner_avatar_id === acquirerAvatarId) {
    await tx.execute(
      sql`UPDATE land_structures SET status = 'active', updated_at = now() WHERE id = ${s.id}`,
    );
  } else {
    await tx.execute(sql`DELETE FROM land_structures WHERE id = ${s.id}`);
  }
}

/**
 * Deed-lock guard (marketplace C4 cross-domain seam, 2026-07-07). A parcel is
 * DEED-LOCKED when a live P2P marketplace listing holds its deed: a
 * `market_deed_locks` row exists (the authoritative HELD marker — created in the
 * listing tx, held THROUGH 'settled' until the Codex-gated transfer executor
 * releases it), OR a live ('active'|'pending_settlement') land_deed
 * `market_listings` row references it (defense-in-depth for any future lockless
 * listing path). While locked, the parcel MUST NOT revert to the pool (voluntary
 * /release OR a rent-sweeper lapse/eviction) — doing so lets the seller
 * double-sell a deed a buyer already settled. MUST be called with the parcel row
 * already locked FOR UPDATE and under the per-owner advisory lock in `tx`, so it
 * serializes against the marketplace lister/fulfiller (same advisory OUTER +
 * parcel FOR UPDATE INNER order — no new deadlock edge). Raw SQL by table name
 * so land.ts stays decoupled from the market schema (owned by token-economy).
 */
export async function parcelHasLiveDeedLock(tx: LandTx, parcelId: string): Promise<boolean> {
  try {
    const rows = await tx.execute<{ hit: number }>(
      sql`SELECT 1 AS hit
          WHERE EXISTS (SELECT 1 FROM market_deed_locks WHERE parcel_id = ${parcelId})
             OR EXISTS (
               SELECT 1 FROM market_listings
               WHERE item_kind = 'land_deed'
                 AND item_ref = ${parcelId}
                 AND status IN ('active', 'pending_settlement')
             )`,
    );
    return Array.from(rows as Iterable<unknown>).length > 0;
  } catch (err) {
    // Migration-order safety: on a DB where 0017 (market tables) is not applied,
    // the relation doesn't exist (Postgres 42P01) — no marketplace means nothing
    // can be deed-locked, so treat as UNLOCKED. Re-throw anything else so a real
    // fault is never silently swallowed on a money path.
    //
    // Error-surface note (verified): drizzle-orm 0.33.0 + postgres-js does NOT
    // wrap driver errors, so PostgresError's SQLSTATE lands directly on
    // `err.code`. The `cause.code` + exact-message checks are a NARROW fallback
    // (undefined_table's canonical message form only) in case a future drizzle
    // upgrade wraps the driver error — never a generic swallow.
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
    const undefinedTable =
      e?.code === '42P01' ||
      e?.cause?.code === '42P01' ||
      (typeof e?.message === 'string' && /relation "[^"]+" does not exist/.test(e.message)) ||
      (typeof e?.cause?.message === 'string' && /relation "[^"]+" does not exist/.test(e.cause.message));
    if (undefinedTable) return false;
    throw err;
  }
}

// ─── Service listings — run-a-store (Slice 4, P3) ───────────────────────────
//
// A peer CT service: an avatar with an ACTIVE 'shop' structure lists a
// service; another avatar buys it with CT, full transfer to the seller (no
// rake — DESIGN decision #9 on `service_listings` in the schema doc). Mirrors
// the parcel-buy money discipline EXACTLY: per-avatar advisory lock (outer) +
// row lock (inner) + ledger debit/credit IN-TX + audit row, all atomic.
//
// PARITY (Rule E5): every write resolves `identity.avatarId` from
// `requireAuthOrAgentSession` — a connected/hosted agent lists/updates/buys
// through its OWN avatar exactly as a human does; the browse reads are public.
//
// `land.service.sold` is EMISSION-ONLY this slice (curated onto the agent
// stream + LAND_EVENT_WEIGHTS already carries a weight=40/cap=50 entry in
// `@clawville/shared` land-economy.ts) — the leaderboard scoring CTE wiring
// is a deferred cross-domain decision owned by the land specialist / the
// leaderboard-progression domain, NOT touched here.

/** Per-structure cap on simultaneously-active listings (LIST route guard). */
const MAX_ACTIVE_LISTINGS_PER_STRUCTURE = 6;

/** A peer service listing (mirrors `service_listings`). */
interface ServiceListingDTO {
  id: string;
  structureId: string;
  ownerAvatarId: string;
  kind: 'peer' | 'partner';
  title: string;
  description: string | null;
  priceCt: number;
  status: 'active' | 'paused' | 'delisted';
  platformFeeBps: number;
  createdAt: string;
  updatedAt: string;
}

/** A settled service purchase (mirrors `service_purchases`). */
interface ServicePurchaseDTO {
  id: string;
  listingId: string;
  buyerAvatarId: string;
  sellerAvatarId: string;
  priceCt: number;
  landTransactionId: string | null;
  createdAt: string;
}

interface ServiceListingsPayload {
  listings: ServiceListingDTO[];
  nextPage?: number;
}

interface ServiceReadCacheEntry {
  payload: ServiceListingsPayload;
  expiresAt: number;
}

// Keyed on `services:struct:<structureId>` (single-structure browse) or
// `services:all:<page>:<limit>` (paged all-active browse). A SEPARATE Map from
// the parcel `readCache` above (different payload shape) but reuses the SAME
// 60s TTL + the SAME `publicReadLimiter` rate limiter instance.
const serviceListingsCache = new Map<string, ServiceReadCacheEntry>();

function getServiceListingsCache(key: string): ServiceListingsPayload | null {
  const hit = serviceListingsCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    serviceListingsCache.delete(key);
    return null;
  }
  return hit.payload;
}

function setServiceListingsCache(key: string, payload: ServiceListingsPayload): void {
  serviceListingsCache.set(key, { payload, expiresAt: Date.now() + READ_CACHE_TTL_MS });
}

/**
 * Bust the browse caches for a structure's listings after a list/update
 * mutates one. Also clears every paged `services:all:*` entry — a new/edited/
 * delisted listing can move into or out of the all-active feed at any page,
 * and there is no single stable key to target (unlike the parcel tier cache).
 */
function bustServiceListingsCache(structureId: string): void {
  serviceListingsCache.delete(`services:struct:${structureId}`);
  for (const key of serviceListingsCache.keys()) {
    if (key.startsWith('services:all:')) serviceListingsCache.delete(key);
  }
}

/**
 * Tolerant timestamp → ISO string. Raw `tx.execute<>()` / `db.execute<>()` rows
 * return timestamp columns as STRINGS (postgres-js does NOT hydrate `Date` on a
 * raw execute — unlike drizzle's typed `.select()`/`.returning()`, which do), so
 * a site that assumes `Date` and calls `.toISOString()` crashes at runtime with
 * "toISOString is not a function". This accepts either and always returns ISO —
 * use it at EVERY raw-execute date-serialization site.
 */
function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Typed-select/insert row → DTO mapper (camelCase already, typed drizzle path). */
function toServiceListingDTO(row: typeof serviceListings.$inferSelect): ServiceListingDTO {
  return {
    id: row.id,
    structureId: row.structureId,
    ownerAvatarId: row.ownerAvatarId,
    kind: row.kind,
    title: row.title,
    description: row.description,
    priceCt: row.priceCt,
    status: row.status,
    platformFeeBps: row.platformFeeBps,
    // toIso (not a bare .toISOString()) so the mapper is robust even if a caller
    // ever feeds it a raw-execute row (string dates) rather than a typed one.
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
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
      rentCtWeekly: landParcels.rentCtWeekly,
      tenure: landParcels.tenure,
      depositCt: landParcels.depositCt,
      depositRemainingCt: landParcels.depositRemainingCt,
      holdThresholdCt: landParcels.holdThresholdCt,
    })
    .from(landParcels)
    .where(where);

  const payload = rows.map(toDTO);
  setReadCache(cacheKey, payload);
  return c.json(payload);
});

// ─── 2. GET /owned/:avatarId  (PUBLIC, rate-limited — multiplayer render seam) ─

// Public active-structure render feed (cached 60s, shared public-read limiter).
landRoutes.get('/structures/public', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  c.header('Cache-Control', 'public, max-age=30');

  const cached = getPublicStructuresCache();
  if (cached) return c.json(cached);

  const rows = await db
    .select({
      parcelCode: landParcels.parcelCode,
      gridX: landParcels.gridX,
      gridY: landParcels.gridY,
      tier: landParcels.tier,
      structureType: landStructures.structureType,
      level: landStructures.level,
      shellKey: landStructures.shellKey,
      paletteKey: landStructures.paletteKey,
    })
    .from(landStructures)
    .innerJoin(landParcels, eq(landParcels.id, landStructures.parcelId))
    .where(eq(landStructures.status, 'active'))
    .orderBy(landParcels.parcelCode);

  const payload = rows.map(toPublicLandStructureDTO);
  setPublicStructuresCache(payload);
  return c.json(payload);
});

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

landRoutes.get('/me', requireAuthOrAgentSession, noStorePrivate, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;
  // Bypass the cache for the owner's own view — a just-completed buy/place/upgrade
  // in the same session must be reflected immediately (the public /owned read can
  // tolerate up to 60s staleness; the owner's own /me cannot).
  const payload = await fetchOwnedLand(avatarId);
  return c.json({ avatarId, ...payload });
});

// ─── 4. POST /claim-starter  (AUTH, PARITY-BOUND, idempotent, atomic) ───────

landRoutes.post('/claim-starter', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  // Reject any body that isn't an empty object — no client value reaches the
  // write. An absent body (no Content-Type / empty) parses to `{}` and passes.
  const rawBody = await c.req.json().catch(() => ({}));
  if (!claimStarterBodySchema.safeParse(rawBody).success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  // Idempotent fast-path (outside the txn): if this avatar already owns ANY
  // starter-TIER parcel — a legacy free tenure='starter' row OR a Phase-B
  // tenure='deposit' one (both are tier='starter', which is what the check
  // keys on) — return it WITHOUT charging a deposit and without locking the
  // pool. The in-txn re-check below is the correctness guard against a
  // concurrent double-claim (and double-DEBIT, now that the claim costs CT).
  const existingFast = await db
    .select({
      id: landParcels.id,
      parcelCode: landParcels.parcelCode,
      tier: landParcels.tier,
      status: landParcels.status,
      gridX: landParcels.gridX,
      gridY: landParcels.gridY,
      priceCt: landParcels.priceCt,
      rentCtWeekly: landParcels.rentCtWeekly,
      tenure: landParcels.tenure,
      depositCt: landParcels.depositCt,
      depositRemainingCt: landParcels.depositRemainingCt,
      holdThresholdCt: landParcels.holdThresholdCt,
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
        rentCtWeekly: p.rentCtWeekly,
        tenure: p.tenure,
        depositCt: p.depositCt,
        depositRemainingCt: p.depositRemainingCt,
        holdThresholdCt: p.holdThresholdCt,
      },
      alreadyOwned: true,
    });
  }

  // ── atomic deposit-escrow grant (Phase B1, 2026-07-07) ────────────────────
  // The claim DEBITS `LAND_STARTER_DEPOSIT_CT` from the claimant INTO ESCROW —
  // the amount is recorded on the parcel row (`deposit_ct` / `deposit_
  // remaining_ct`) and credited to NOBODY (refundable, not revenue; the weekly
  // sweep draws rent from the remainder → treasury). Debit + ownership flip +
  // audit are ONE transaction: an InsufficientTokens throw rolls back the flip,
  // and any flip failure rolls back the debit.
  //
  // Note: the 5-cap `MAX_PARCELS_PER_AVATAR` is NOT the binding constraint here
  // — a starter is one-per-avatar via the ownership idempotency check (the
  // in-txn re-select below).
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
    rentCtWeekly: number | null;
    tenure: LandTenure | null;
    depositCt: number | null;
    depositRemainingCt: number | null;
    holdThresholdCt: number | null;
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
        rent_ct_weekly: number | string | null;
        tenure: LandTenure | null;
        deposit_ct: number | string | null;
        deposit_remaining_ct: number | string | null;
        hold_threshold_ct: number | string | null;
      }>(
        sql`SELECT id, parcel_code, tier, status, grid_x, grid_y, price_ct, rent_ct_weekly, tenure,
                   deposit_ct, deposit_remaining_ct, hold_threshold_ct
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
            rentCtWeekly: owned.rent_ct_weekly == null ? null : Number(owned.rent_ct_weekly),
            tenure: owned.tenure,
            depositCt: owned.deposit_ct == null ? null : Number(owned.deposit_ct),
            depositRemainingCt:
              owned.deposit_remaining_ct == null ? null : Number(owned.deposit_remaining_ct),
            holdThresholdCt:
              owned.hold_threshold_ct == null ? null : Number(owned.hold_threshold_ct),
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
        rent_ct_weekly: number | string | null;
      }>(
        sql`SELECT id, parcel_code, tier, status, grid_x, grid_y, price_ct, rent_ct_weekly
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

      // (c) ESCROW DEBIT (Phase B1) — the refundable deposit leaves the
      // claimant's balance IN THIS TX. There is deliberately NO treasury (or
      // any other) credit here: the deposit is not revenue — it is held as the
      // `deposit_remaining_ct` NUMBER on the row (see the schema conservation
      // invariant). Throws InsufficientTokensError (caught below → 400) on a
      // low balance, rolling back the SKIP LOCKED pick with it.
      const debit = await debitClawTokens(
        {
          avatarId,
          amount: LAND_STARTER_DEPOSIT_CT,
          reason: 'land_deposit_escrow',
          source: 'api',
          metadata: {
            parcelId: pick.id,
            parcelCode: pick.parcel_code,
            tier: pick.tier,
            refundable: true,
          },
          actorKind: toActorKind(identity.kind),
        },
        tx,
      );

      // (d) Flip ownership. tenure='deposit' — the escrow numbers + the weekly
      // draw schedule are stamped here; the sweeper draws from the remainder
      // when rent_paid_through elapses.
      await tx.execute(
        sql`UPDATE land_parcels
            SET status = 'owned',
                owner_avatar_id = ${avatarId},
                tenure = 'deposit',
                acquired_at = now(),
                deposit_ct = ${LAND_STARTER_DEPOSIT_CT},
                deposit_remaining_ct = ${LAND_STARTER_DEPOSIT_CT},
                rent_ct_weekly = ${LAND_STARTER_RENT_CT_WEEKLY},
                rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                grace_until = NULL,
                updated_at = now()
            WHERE id = ${pick.id}`,
      );

      // (e) Audit-spine row — the escrow movement (amount = the deposit,
      // cross-ref'd to the ledger debit). NOT a purchase: kind is the dedicated
      // 'land_deposit_escrow'.
      const meta = JSON.stringify({
        reason: 'starter_claim_deposit',
        refundable: true,
        rentCtWeekly: LAND_STARTER_RENT_CT_WEEKLY,
      });
      await tx.execute(
        sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
            VALUES ('land_deposit_escrow', ${pick.id}, ${avatarId}, ${LAND_STARTER_DEPOSIT_CT}, ${debit.ledgerId}, ${meta}::jsonb)`,
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
          // The UPDATE just stamped the deposit tenancy — reflect the stamped
          // values, not the pre-claim row.
          rentCtWeekly: LAND_STARTER_RENT_CT_WEEKLY,
          tenure: 'deposit' as const,
          depositCt: LAND_STARTER_DEPOSIT_CT,
          depositRemainingCt: LAND_STARTER_DEPOSIT_CT,
          holdThresholdCt: null,
        },
      };
    });
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      return c.json({ error: 'insufficient_clawtokens' }, 400);
    }
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
  bustPublicStructuresCache();

  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.PARCEL_PURCHASED,
    userId: identity.userId,
    avatarId: identity.avatarId,
    agentId: identity.kind === 'agent' ? identity.agentId : null,
    payload: {
      parcelCode: result.parcel.parcelCode,
      tier: result.parcel.tier,
      // amountCt stays 0: the deposit is a refundable ESCROW, not a spend —
      // reporting it as a purchase amount would overstate revenue. The escrow
      // size rides alongside for observability.
      amountCt: 0,
      depositCt: LAND_STARTER_DEPOSIT_CT,
      tenure: 'deposit',
    },
  });

  // Live land-sync (2.1): a fresh starter claim flips a parcel available→owned,
  // so its in-world for-sale sign must vanish for OTHER players too. Fire-and-
  // forget AFTER commit + the leaderboard event — a broadcast error can NEVER
  // affect the (already durable) grant.
  broadcastLandEvent({
    parcelCode: result.parcel.parcelCode,
    status: 'owned',
    ownerAvatarId: avatarId,
  });

  return c.json({
    parcel: result.parcel,
    alreadyOwned: false,
    depositCt: LAND_STARTER_DEPOSIT_CT,
    depositRemainingCt: LAND_STARTER_DEPOSIT_CT,
  });
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
      shellKey: landStructures.shellKey,
      paletteKey: landStructures.paletteKey,
    })
    .from(landStructures)
    // Only an ACTIVE structure renders; an archived one sits on a now-available
    // parcel awaiting restore/purge and must read as "no structure".
    .where(and(eq(landStructures.parcelId, parcelId), eq(landStructures.status, 'active')))
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

// ─── 7. POST /parcels/:parcelId/buy  (DISABLED — Phase B tenure model) ──────
//
// FOUNDER-DECIDED (2026-07-07): land is NEVER sold permanently. Acquisition is
// now tenure-only — starter via POST /claim-starter (deposit-escrow, B1),
// c/b/a/founder via POST /parcels/:parcelId/claim-hold (CLV hold-to-keep, B2).
// The route stays registered (stable 409 contract for old clients) but is a
// dead end for ALL tiers, deliberately WITHOUT auth middleware so every caller
// gets the same machine-readable refusal without a session lookup. The
// pre-Phase-B priced-sale implementation (advisory lock + FOR UPDATE + in-tx
// debit + T0 treasury credit) lives in git history at this diff's parent.
landRoutes.post('/parcels/:parcelId/buy', (c) => c.json({ error: 'tenure_model_active' }, 409));

// ─── 7b. POST /parcels/:parcelId/claim-hold  (AUTH, PARITY-BOUND, Phase B2) ──
//
// HOLD-TO-KEEP acquire for c/b/a/founder: the caller proves its CLV balance ≥
// the SUM of its existing non-grandfathered hold thresholds + this tier's
// threshold (thresholds STACK — see LAND_HOLD_THRESHOLDS_CLV). NO CT debit at
// claim: the hold IS the consideration; the weekly CT upkeep (rent_ct_weekly;
// founder-stamped FOUNDER_UPKEEP_CT_WEEKLY) is drawn by land-rent-sweeper from
// the holder's avatar balance → house treasury.
//
// CLV resolution (Rule E5 parity — both subject kinds, both FAIL-CLOSED here):
//   human (identity.kind='user')  → users.linked_wallet_pubkey (ownership
//     proven by routes/wallet-link.ts) → getLinkedWalletClvBalance;
//     not linked → 403 wallet_not_linked.
//   agent (identity.kind='agent') → avatars.wallet_address (the agent's own
//     custodial wallet) → getWalletClvBalance; missing → 403 agent_wallet_missing.
//   Read unavailable (RPC down / fail-soft {available:false}) → 503
//     clv_balance_unavailable — a hold is NEVER granted on an unconfirmed
//     balance. (The sweeper is the mirror image: it FAILS-OPEN and never
//     lapses on an unconfirmed balance.)
//
// The RPC read runs BEFORE the money tx — never hold advisory/row locks across
// a network call. The balance is external chain state (5-min cached, fail-soft)
// that no DB lock could pin anyway; what MUST be lock-consistent is the
// stacked-threshold SUM + the compare + the flip, and those all run inside the
// tx under advisory(avatar) + FOR UPDATE, so two concurrent claims by the same
// subject serialize and the second sees the first's committed hold in its SUM.
landRoutes.post('/parcels/:parcelId/claim-hold', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_parcel_id' }, 400);
  }
  const parcelId = idParsed.data;

  // No client value reaches the write — threshold/tier/upkeep are all
  // server-resolved. Reject any stray field.
  const rawBody = await c.req.json().catch(() => ({}));
  if (!emptyStrictBodySchema.safeParse(rawBody).success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  // (pre-1) Cheap UNLOCKED pre-checks so a 404 / starter-tier / already-owned
  // parcel never burns an RPC read. Advisory only — the authoritative
  // re-checks run under the lock inside the tx.
  const preRows = await db
    .select({ tier: landParcels.tier, status: landParcels.status })
    .from(landParcels)
    .where(eq(landParcels.id, parcelId))
    .limit(1);
  const pre = preRows[0];
  if (!pre) return c.json({ error: 'parcel_not_found' }, 404);
  if (pre.tier === 'starter') return c.json({ error: 'use_claim_starter' }, 400);
  if (pre.status !== 'available') return c.json({ error: 'parcel_not_available' }, 409);

  // (pre-2) Resolve the subject's CLV balance — FAIL-CLOSED on every branch.
  let clv: ClvBalanceResult;
  let clvWalletPubkey: string;
  if (identity.kind === 'user') {
    const linked = await getLinkedWalletClvBalance(identity.userId);
    if (!linked.linked || !linked.walletPubkey) {
      return c.json({ error: 'wallet_not_linked' }, 403);
    }
    clv = linked.clv;
    clvWalletPubkey = linked.walletPubkey;
  } else {
    const avatarRow = await db.query.avatars.findFirst({
      where: eq(avatars.id, avatarId),
      columns: { walletAddress: true },
    });
    const pubkey = avatarRow?.walletAddress ?? null;
    if (!pubkey) {
      return c.json({ error: 'agent_wallet_missing' }, 403);
    }
    clv = await getWalletClvBalance(pubkey);
    clvWalletPubkey = pubkey;
  }
  if (clv.available !== true || clv.uiAmount == null) {
    // FAIL-CLOSED: cannot confirm the hold → cannot grant the parcel.
    return c.json({ error: 'clv_balance_unavailable' }, 503);
  }
  const heldClv = clv.uiAmount;

  interface HeldParcel {
    id: string;
    parcelCode: string;
    tier: LandTier;
    status: 'available' | 'owned' | 'reserved' | 'retired';
    gridX: number;
    gridY: number;
    priceCt: number | null;
    ownerAvatarId: string | null;
    rentCtWeekly: number | null;
    tenure: LandTenure | null;
    depositCt: number | null;
    depositRemainingCt: number | null;
    holdThresholdCt: number | null;
  }

  let claimed: { parcel: HeldParcel; requiredClv: number };
  try {
    claimed = await db.transaction(async (tx) => {
      // (0) Per-avatar advisory lock FIRST (outer — deadlock order rule): the
      // stacked-threshold SUM and the parcel-cap COUNT below span MANY rows, so
      // no single row lock can bound them; the advisory lock serializes
      // same-subject claims. Different avatars never block each other.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      // (a) Lock the parcel row (inner). tier/status re-read UNDER the lock is
      // authoritative — the unlocked pre-checks above were a fast path only.
      const parcelRows = await tx.execute<{
        id: string;
        parcel_code: string;
        tier: LandTier;
        status: string;
        price_ct: number | string | null;
        rent_ct_weekly: number | string | null;
        grid_x: number | string;
        grid_y: number | string;
      }>(
        sql`SELECT id, parcel_code, tier, status, price_ct, rent_ct_weekly, grid_x, grid_y
            FROM land_parcels
            WHERE id = ${parcelId}
            FOR UPDATE`,
      );
      const parcel = parcelRows[0];
      if (!parcel) {
        throw new HTTPException(404, { message: 'parcel_not_found' });
      }
      if (parcel.tier === 'starter') {
        throw new HTTPException(400, { message: 'use_claim_starter' });
      }
      if (parcel.status !== 'available') {
        throw new HTTPException(409, { message: 'parcel_not_available' });
      }

      const threshold = holdThresholdForTier(parcel.tier);
      if (threshold == null) {
        // starter is the only null-threshold tier and was rejected above —
        // pure defense against a future tier addition.
        throw new HTTPException(400, { message: 'use_claim_starter' });
      }

      // (b) Stacked requirement — SUM of the caller's existing
      // non-grandfathered hold thresholds + this tier's, computed UNDER the
      // advisory lock. Grandfathered holds are excluded by definition (they
      // never proved CLV). NOTE: claim-time stacking includes holds currently
      // in grace (conservative — claiming MORE while failing a hold check must
      // not get cheaper); the sweeper's re-check applies the grace carve-out.
      const sumRows = await tx.execute<{ s: number | string }>(
        sql`SELECT COALESCE(SUM(hold_threshold_ct), 0)::int AS s
            FROM land_parcels
            WHERE owner_avatar_id = ${avatarId}
              AND tenure = 'hold'
              AND grandfathered = false`,
      );
      const requiredClv = Number(sumRows[0]?.s ?? 0) + threshold;

      // (c) THE HOLD GATE — compare the live uiAmount (human token count)
      // against the stacked requirement.
      if (heldClv < requiredClv) {
        throw new InsufficientClvHoldError(requiredClv, heldClv);
      }

      // (d) Ownership cap — COUNT under the advisory lock (PG-wire string →
      // Number before comparing).
      const countRows = await tx.execute<{ n: number | string }>(
        sql`SELECT COUNT(*)::int AS n FROM land_parcels WHERE owner_avatar_id = ${avatarId}`,
      );
      if (Number(countRows[0]?.n ?? 0) >= MAX_PARCELS_PER_AVATAR) {
        throw new HTTPException(409, { message: 'parcel_cap_reached' });
      }

      // (e) NO price debit — flip the parcel to a hold tenancy. rent_ct_weekly:
      // founder rows carry NULL (the rent ladder never priced them) → stamp
      // FOUNDER_UPKEEP_CT_WEEKLY; c/b/a keep their stamped weekly rent as the
      // upkeep (COALESCE keeps an existing value).
      const founderDefault = parcel.tier === 'founder' ? FOUNDER_UPKEEP_CT_WEEKLY : null;
      await tx.execute(
        sql`UPDATE land_parcels
            SET status = 'owned',
                owner_avatar_id = ${avatarId},
                tenure = 'hold',
                acquired_at = now(),
                hold_threshold_ct = ${threshold},
                hold_subject = ${identity.kind},
                grandfathered = false,
                rent_ct_weekly = COALESCE(rent_ct_weekly, ${founderDefault}),
                rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                grace_until = NULL,
                updated_at = now()
            WHERE id = ${parcel.id}`,
      );

      // (e.1) Restore/purge any eviction-archived structure on this parcel.
      await reconcileArchivedStructureOnAcquire(tx, parcel.id, avatarId);

      // (f) Audit — hold_claim, amount 0 (no CT moved at claim).
      const meta = JSON.stringify({
        tier: parcel.tier,
        parcelCode: parcel.parcel_code,
        holdThresholdClv: threshold,
        requiredClv,
        heldClv,
        holdSubject: identity.kind,
        clvWallet: clvWalletPubkey,
      });
      await tx.execute(
        sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
            VALUES ('hold_claim', ${parcel.id}, ${avatarId}, 0, ${meta}::jsonb)`,
      );

      // (g) Read back the stamped weekly upkeep (COALESCE result) for the DTO.
      const backRows = await tx.execute<{ rent_ct_weekly: number | string | null }>(
        sql`SELECT rent_ct_weekly FROM land_parcels WHERE id = ${parcel.id}`,
      );
      const stampedWeekly =
        backRows[0]?.rent_ct_weekly == null ? null : Number(backRows[0].rent_ct_weekly);

      return {
        parcel: {
          id: parcel.id,
          parcelCode: parcel.parcel_code,
          tier: parcel.tier,
          status: 'owned' as const,
          gridX: Number(parcel.grid_x),
          gridY: Number(parcel.grid_y),
          priceCt: parcel.price_ct == null ? null : Number(parcel.price_ct),
          ownerAvatarId: avatarId,
          rentCtWeekly: stampedWeekly,
          tenure: 'hold' as const,
          depositCt: null,
          depositRemainingCt: null,
          holdThresholdCt: threshold,
        },
        requiredClv,
      };
    });
  } catch (err) {
    if (err instanceof InsufficientClvHoldError) {
      return c.json(
        { error: 'insufficient_clv_hold', requiredClv: err.requiredClv, heldClv: err.heldClv },
        403,
      );
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409);
    }
    throw err;
  }

  // Committed — bust the owner's combined cache AND the for-sale pool cache for
  // this tier (the parcel left 'available'). Then emit the leaderboard credit.
  bustOwnedCache(avatarId);
  bustPublicStructuresCache();
  bustParcelsAvailableCache(claimed.parcel.tier);

  // Acquiring a parcel (hold, like buy/rent before it) is one PARCEL_PURCHASED
  // credit (weight 5, capped 5/day). Weekly upkeep sweeps emit NO event.
  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.PARCEL_PURCHASED,
    userId: identity.userId,
    avatarId: identity.avatarId,
    agentId: identity.kind === 'agent' ? identity.agentId : null,
    payload: {
      parcelCode: claimed.parcel.parcelCode,
      tier: claimed.parcel.tier,
      amountCt: 0,
      tenure: 'hold',
      holdThresholdClv: claimed.parcel.holdThresholdCt,
    },
  });

  // Live land-sync: the claim flipped this parcel available→owned, so its
  // in-world for-sale sign must vanish for OTHER players. Fire-and-forget
  // AFTER commit — a broadcast error can NEVER affect the (durable) claim.
  broadcastLandEvent({
    parcelCode: claimed.parcel.parcelCode,
    status: 'owned',
    ownerAvatarId: avatarId,
  });

  return c.json({ parcel: claimed.parcel, requiredClv: claimed.requiredClv, heldClv });
});

// ─── 7c. POST /parcels/:parcelId/deposit-topup  (AUTH, PARITY-BOUND, B1) ─────
//
// Adds CT to the caller's OWN deposit escrow (deposit_remaining_ct += amount).
// The amount is the only client value and it is a SELF-debit (Zod-capped
// 1..1_000_000) — it can never move value to any other subject; the same
// conservation shape as the claim (claimant debited, NOBODY credited, the
// remainder number grows). A remainder that again covers a full week clears an
// open grace window.
landRoutes.post('/parcels/:parcelId/deposit-topup', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_parcel_id' }, 400);
  }
  const parcelId = idParsed.data;

  // Sentinel parse (mirrors /upgrade's money-safety pattern) — an unparseable
  // body is a hard 400, never coerced toward a debit.
  const PARSE_FAILED = Symbol('parse_failed');
  const rawBody: unknown = await c.req.json().catch(() => PARSE_FAILED);
  if (rawBody === PARSE_FAILED) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const bodyParsed = depositTopupBodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const amountCt = bodyParsed.data.amountCt;

  type TopupResult = {
    parcelCode: string;
    depositRemainingCt: number;
    graceCleared: boolean;
  };

  let topped: TopupResult;
  try {
    topped = await db.transaction(async (tx): Promise<TopupResult> => {
      // Per-avatar advisory lock (outer), then the parcel row (inner) — same
      // deadlock order as every land mutation.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      const rows = await tx.execute<{
        id: string;
        parcel_code: string;
        owner_avatar_id: string | null;
        tenure: LandTenure | null;
        deposit_remaining_ct: number | string | null;
        rent_ct_weekly: number | string | null;
        grace_until: string | Date | null;
      }>(
        sql`SELECT id, parcel_code, owner_avatar_id, tenure, deposit_remaining_ct, rent_ct_weekly, grace_until
            FROM land_parcels
            WHERE id = ${parcelId}
            FOR UPDATE`,
      );
      const p = rows[0];
      if (!p) {
        throw new HTTPException(404, { message: 'parcel_not_found' });
      }
      if (p.owner_avatar_id !== avatarId) {
        throw new HTTPException(403, { message: 'not_parcel_owner' });
      }
      if (p.tenure !== 'deposit') {
        throw new HTTPException(409, { message: 'not_deposit_tenure' });
      }

      // ESCROW DEBIT — into the remainder, IN THIS TX. Throws
      // InsufficientTokensError (→ 400) on a low balance.
      const debit = await debitClawTokens(
        {
          avatarId,
          amount: amountCt,
          reason: 'land_deposit_topup',
          source: 'api',
          metadata: { parcelId: p.id, parcelCode: p.parcel_code, refundable: true },
          actorKind: toActorKind(identity.kind),
        },
        tx,
      );

      const newRemaining = Number(p.deposit_remaining_ct ?? 0) + amountCt;
      const rentWeekly = p.rent_ct_weekly == null ? null : Number(p.rent_ct_weekly);
      // Covers a full week again → un-pause the tenancy (clear grace). The
      // response flag reports whether a grace was ACTUALLY lifted.
      const coversWeek = rentWeekly != null && rentWeekly > 0 && newRemaining >= rentWeekly;
      const graceCleared = coversWeek && p.grace_until != null;
      await tx.execute(
        sql`UPDATE land_parcels
            SET deposit_remaining_ct = deposit_remaining_ct + ${amountCt},
                grace_until = CASE WHEN ${coversWeek} THEN NULL ELSE grace_until END,
                updated_at = now()
            WHERE id = ${p.id}`,
      );

      const meta = JSON.stringify({ newRemaining, graceCleared, refundable: true });
      await tx.execute(
        sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
            VALUES ('land_deposit_topup', ${p.id}, ${avatarId}, ${amountCt}, ${debit.ledgerId}, ${meta}::jsonb)`,
      );

      return { parcelCode: p.parcel_code, depositRemainingCt: newRemaining, graceCleared };
    });
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      return c.json({ error: 'insufficient_clawtokens' }, 400);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as 403 | 404 | 409);
    }
    throw err;
  }

  // The owner's /me must reflect the new remainder immediately.
  bustOwnedCache(avatarId);

  return c.json({
    parcelCode: topped.parcelCode,
    depositRemainingCt: topped.depositRemainingCt,
    amountCt,
    graceCleared: topped.graceCleared,
  });
});

// ─── 7d. POST /parcels/:parcelId/release  (AUTH, PARITY-BOUND, B1 + B2) ──────
//
// Voluntary release back to the pool. tenure='deposit' → the escrow REMAINDER
// is refunded to the claimant (credited SOFT — the ledger's receiver rule, so
// escrow can never launder into a cashable tag); everything already drawn as
// rent stays with the treasury. tenure='hold' → nothing was escrowed, nothing
// refunds. Both revert the parcel (status='available', every tenure field
// cleared) and archive the active structure (restored on a same-avatar
// re-acquire, purged on a re-lease — the eviction convention).
landRoutes.post('/parcels/:parcelId/release', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_parcel_id' }, 400);
  }
  const parcelId = idParsed.data;

  const rawBody = await c.req.json().catch(() => ({}));
  if (!emptyStrictBodySchema.safeParse(rawBody).success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  interface ReleasedParcel {
    id: string;
    parcelCode: string;
    tier: LandTier;
    status: 'available' | 'owned' | 'reserved' | 'retired';
    gridX: number;
    gridY: number;
    priceCt: number | null;
    ownerAvatarId: string | null;
    rentCtWeekly: number | null;
    tenure: LandTenure | null;
    depositCt: number | null;
    depositRemainingCt: number | null;
    holdThresholdCt: number | null;
  }

  let released: { parcel: ReleasedParcel; refundedCt: number };
  try {
    released = await db.transaction(async (tx) => {
      // Per-avatar advisory lock (outer), then the parcel row (inner).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`,
      );

      const rows = await tx.execute<{
        id: string;
        parcel_code: string;
        tier: LandTier;
        owner_avatar_id: string | null;
        tenure: LandTenure | null;
        deposit_remaining_ct: number | string | null;
        rent_ct_weekly: number | string | null;
        price_ct: number | string | null;
        grid_x: number | string;
        grid_y: number | string;
      }>(
        sql`SELECT id, parcel_code, tier, owner_avatar_id, tenure, deposit_remaining_ct,
                   rent_ct_weekly, price_ct, grid_x, grid_y
            FROM land_parcels
            WHERE id = ${parcelId}
            FOR UPDATE`,
      );
      const p = rows[0];
      if (!p) {
        throw new HTTPException(404, { message: 'parcel_not_found' });
      }
      if (p.owner_avatar_id !== avatarId) {
        throw new HTTPException(403, { message: 'not_parcel_owner' });
      }
      // DEED-LOCK GUARD (marketplace C4 seam): a live P2P listing holds this
      // parcel's deed in escrow — releasing it to the pool would let the seller
      // double-sell a deed a buyer may have already settled. Refuse; the seller
      // must cancel the listing first (which releases the lock). Checked under
      // the advisory + parcel FOR UPDATE already held, so it serializes against
      // the lister/fulfiller.
      if (await parcelHasLiveDeedLock(tx, p.id)) {
        throw new HTTPException(409, { message: 'deed_locked_by_listing' });
      }
      if (p.tenure !== 'deposit' && p.tenure !== 'hold') {
        // Legacy tenures (starter/owned/rented) keep their existing lifecycle —
        // release is a Phase-B surface only.
        throw new HTTPException(409, { message: 'not_releasable_tenure' });
      }

      let refundedCt = 0;
      if (p.tenure === 'deposit') {
        const remaining = Number(p.deposit_remaining_ct ?? 0);
        let creditLedgerId: string | null = null;
        if (remaining > 0) {
          // ESCROW REFUND — the remainder returns to the claimant IN THIS TX.
          // This is the `refund` leg of the conservation invariant:
          // draws + refund + forfeit == claim + topups.
          const credit = await creditClawTokens(
            {
              avatarId,
              amount: remaining,
              reason: 'land_deposit_refund',
              source: 'api',
              metadata: { parcelId: p.id, parcelCode: p.parcel_code },
              actorKind: toActorKind(identity.kind),
            },
            tx,
          );
          creditLedgerId = credit.ledgerId;
          refundedCt = remaining;
        }
        const meta = JSON.stringify({
          reason: 'voluntary_release',
          tenure: 'deposit',
          refundedCt,
        });
        await tx.execute(
          sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, credit_ledger_tx_id, metadata)
              VALUES ('land_deposit_refund', ${p.id}, ${avatarId}, ${refundedCt}, ${creditLedgerId}, ${meta}::jsonb)`,
        );
      } else {
        // tenure='hold': nothing escrowed → nothing to refund. Audit the
        // pool-return as an 'eviction' row disambiguated by metadata (the kind
        // enum has no dedicated voluntary-release value; 'eviction' == "parcel
        // returned to the pool", which is exactly what happened — JUDGMENT CALL,
        // see the Phase-B report).
        const meta = JSON.stringify({ reason: 'voluntary_release', tenure: 'hold' });
        await tx.execute(
          sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
              VALUES ('eviction', ${p.id}, ${avatarId}, 0, ${meta}::jsonb)`,
        );
      }

      // Revert to the pool — clears EVERY tenure field (rent + deposit + hold +
      // grandfathered). Mirrors the sweeper's revertParcelToPool; rent_ct_weekly
      // stays stamped (it is the listing value, not a per-tenancy one).
      await tx.execute(
        sql`UPDATE land_parcels
            SET status = 'available',
                owner_avatar_id = NULL,
                tenure = NULL,
                acquired_at = NULL,
                rent_paid_through = NULL,
                grace_until = NULL,
                deposit_ct = NULL,
                deposit_remaining_ct = NULL,
                hold_threshold_ct = NULL,
                hold_subject = NULL,
                grandfathered = false,
                updated_at = now()
            WHERE id = ${p.id}`,
      );
      // Archive (soft-delete) the active structure — the eviction convention.
      await tx.execute(
        sql`UPDATE land_structures
            SET status = 'archived', updated_at = now()
            WHERE parcel_id = ${p.id} AND status = 'active'`,
      );

      return {
        refundedCt,
        parcel: {
          id: p.id,
          parcelCode: p.parcel_code,
          tier: p.tier,
          status: 'available' as const,
          gridX: Number(p.grid_x),
          gridY: Number(p.grid_y),
          priceCt: p.price_ct == null ? null : Number(p.price_ct),
          ownerAvatarId: null,
          rentCtWeekly: p.rent_ct_weekly == null ? null : Number(p.rent_ct_weekly),
          tenure: null,
          depositCt: null,
          depositRemainingCt: null,
          holdThresholdCt: null,
        },
      };
    });
  } catch (err) {
    if (err instanceof HTTPException) {
      // `code` mirrors `error` (every message on this route is already a
      // snake_case code) so the web ApiError rule — UI branches on `err.code`,
      // never the message — holds for the new `deed_locked_by_listing` refusal.
      return c.json({ error: err.message, code: err.message }, err.status as 403 | 404 | 409);
    }
    throw err;
  }

  // Committed — the parcel is back in the pool: bust the owner cache + the
  // for-sale pool cache, and tell every connected player live.
  bustOwnedCache(avatarId);
  bustPublicStructuresCache();
  bustParcelsAvailableCache(released.parcel.tier);
  broadcastLandEvent({
    parcelCode: released.parcel.parcelCode,
    status: 'available',
    ownerAvatarId: null,
  });

  return c.json({ released: true, refundedCt: released.refundedCt, parcel: released.parcel });
});

// ─── 8. POST /parcels/:parcelId/structure  (AUTH, PARITY-BOUND, free Lv1) ────

landRoutes.post('/parcels/:parcelId/structure', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
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
        shell_key: string | null;
        palette_key: string | null;
      }>(
        sql`INSERT INTO land_structures
              (parcel_id, owner_avatar_id, structure_type, catalog_key, level, shell_key, palette_key)
            VALUES (${parcel.id}, ${avatarId}, ${structureType}, ${catalogKey}, 1,
                    ${DEFAULT_SHELL_KEY}, ${DEFAULT_PALETTE_KEY})
            RETURNING id, parcel_id, owner_avatar_id, structure_type, catalog_key, level,
                      shell_key, palette_key`,
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
          shellKey: row.shell_key ?? DEFAULT_SHELL_KEY,
          paletteKey: row.palette_key ?? DEFAULT_PALETTE_KEY,
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
  bustPublicStructuresCache();

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

landRoutes.patch(
  '/structures/:structureId/appearance',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const avatarId = c.get('identity').avatarId;

    const idParsed = structureIdSchema.safeParse(c.req.param('structureId'));
    if (!idParsed.success) {
      return c.json({ error: 'invalid_structure_id' }, 400);
    }
    const structureId = idParsed.data;

    const rawBody = await c.req.json().catch(() => ({}));
    const bodyParsed = appearanceBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const patch = bodyParsed.data;

    let structure: LandStructureDTO;
    try {
      structure = await db.transaction(async (tx) => {
        const rows = await tx.execute<{
          id: string;
          parcel_id: string;
          owner_avatar_id: string;
          parcel_owner_avatar_id: string | null;
          status: 'active' | 'archived';
          structure_type: 'home' | 'shop';
          catalog_key: string;
          level: number | string;
          shell_key: string | null;
          palette_key: string | null;
          tier: LandTier;
        }>(
          sql`SELECT s.id, s.parcel_id, s.owner_avatar_id,
                     p.owner_avatar_id AS parcel_owner_avatar_id, s.status,
                     s.structure_type, s.catalog_key, s.level,
                     s.shell_key, s.palette_key, p.tier
              FROM land_structures s
              JOIN land_parcels p ON p.id = s.parcel_id
              WHERE s.id = ${structureId}
              FOR UPDATE OF s, p`,
        );
        const row = rows[0];
        if (!row) {
          throw new HTTPException(404, { message: 'structure_not_found' });
        }

        const validationError = validateAppearanceMutation(
          {
            ownerAvatarId: row.owner_avatar_id,
            parcelOwnerAvatarId: row.parcel_owner_avatar_id,
            status: row.status,
            structureType: row.structure_type,
            level: Number(row.level),
            tier: row.tier,
          },
          avatarId,
          patch,
        );
        if (validationError !== null) {
          const status = validationError === 'not_structure_owner'
            ? 403
            : validationError === 'structure_archived' || validationError === 'ownership_desync'
              ? 409
              : 400;
          throw new HTTPException(status, { message: validationError });
        }

        const updates: { shellKey?: string; paletteKey?: string; updatedAt: Date } = {
          updatedAt: new Date(),
        };
        if (patch.shellKey !== undefined) updates.shellKey = patch.shellKey;
        if (patch.paletteKey !== undefined) updates.paletteKey = patch.paletteKey;

        const updatedRows = await tx
          .update(landStructures)
          .set(updates)
          .where(eq(landStructures.id, structureId))
          .returning({
            id: landStructures.id,
            parcelId: landStructures.parcelId,
            ownerAvatarId: landStructures.ownerAvatarId,
            structureType: landStructures.structureType,
            catalogKey: landStructures.catalogKey,
            level: landStructures.level,
            shellKey: landStructures.shellKey,
            paletteKey: landStructures.paletteKey,
          });
        return toStructureDTO(updatedRows[0]!);
      });
    } catch (err) {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409);
      }
      throw err;
    }

    bustOwnedCache(avatarId);
    bustPublicStructuresCache();
    return c.json({ structure });
  },
);

landRoutes.post('/structures/:structureId/upgrade', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
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
        shell_key: string | null;
        palette_key: string | null;
        tier: LandTier;
      }>(
        sql`SELECT s.id, s.parcel_id, s.owner_avatar_id,
                   p.owner_avatar_id AS parcel_owner_avatar_id,
                   s.structure_type, s.catalog_key, s.level, s.shell_key, s.palette_key, p.tier
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
              shellKey: s.shell_key ?? DEFAULT_SHELL_KEY,
              paletteKey: s.palette_key ?? DEFAULT_PALETTE_KEY,
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
            actorKind: toActorKind(identity.kind),
          },
          tx,
        );
        ledgerId = debit.ledgerId;

        // T0 fee routing (2026-07-07): the upgrade cost → house treasury, IN
        // THIS SAME tx (net-neutral supply; the CT moves owner→treasury instead
        // of burning). Owner-side amount UNCHANGED; the idempotency-key replay
        // above returns before any money moves, so a retry never re-credits.
        // A null treasury degrades to the pre-T0 burn.
        if (Number.isInteger(cost)) {
          const treasuryId = await getHouseTreasuryAvatarId();
          if (treasuryId) {
            await creditClawTokens(
              {
                avatarId: treasuryId,
                amount: cost,
                reason: 'house_fee_structure_upgrade',
                source: 'system',
                metadata: { structureId, toLevel: target, tier: s.tier, ownerAvatarId: avatarId },
                actorKind: 'system',
              },
              tx,
            );
          } else {
            console.error(
              `[land] house treasury unavailable — ${cost} CT upgrade burned (pre-T0 behavior) for structure ${structureId}`,
            );
          }
        }
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
          shellKey: s.shell_key ?? DEFAULT_SHELL_KEY,
          paletteKey: s.palette_key ?? DEFAULT_PALETTE_KEY,
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
            shellKey: landStructures.shellKey,
            paletteKey: landStructures.paletteKey,
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
  bustPublicStructuresCache();

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

// ─── 10. POST /spawn-preference  (AUTH, PARITY-BOUND) ───────────────────────
//
// Town fast-travel — set where the caller's avatar re-spawns on world entry.
// PARITY (Rule E5): binds to `identity.avatarId` from `requireAuthOrAgentSession`
// so a connected/hosted agent sets ITS OWN avatar's preference, not just a human.
//
//   body: { mode: 'town' }                 → spawn_preference='town', home_parcel_id=null
//   body: { mode: 'home', parcelId: uuid } → asserts the caller OWNS parcelId,
//                                             then spawn_preference='home', home_parcel_id=parcelId
//
//   200 → { spawnPreference: 'home'|'town', homeParcelId: string|null }
//   400 → { error, code: 'invalid_body' }      (bad/missing fields, stray keys, home w/o parcelId)
//   403 → { error, code: 'not_owned' }         (mode='home' but caller doesn't own parcelId)
//   404 → { error, code: 'parcel_not_found' }  (mode='home' but parcelId doesn't exist)
//
// No CT moves here — this only writes the two spawn columns on the caller's own
// avatar row. No raw clawTokens write; the ledger is untouched. The ownership
// check + the write are done in ONE transaction with the parcel row locked
// (`FOR UPDATE`) so a concurrent sale/transfer of the parcel can't slip a
// no-longer-owned home past the check (TOCTOU). Same advisory-lock keying as the
// land mutations is unnecessary (no cross-row supply invariant — a single
// avatar row is updated), but the parcel row-lock + in-tx re-read of
// owner_avatar_id is the authoritative ownership guard.
landRoutes.post('/spawn-preference', requireAuthOrAgentSession, requireLedgerCapableIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  // Sentinel parse — a missing/invalid body is a 400, NEVER coerced into a
  // valid path. (No `.catch(() => ({}))` that would silently accept garbage.)
  const rawBody = await c.req.json().catch(() => undefined);
  const parsed = spawnPreferenceBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'invalid spawn-preference body', code: 'invalid_body' }, 400);
  }
  const { mode } = parsed.data;

  // ── mode='town' — clear any home, fast path (no parcel touch) ──────────────
  if (mode === 'town') {
    await db
      .update(avatars)
      .set({ spawnPreference: 'town', homeParcelId: null, updatedAt: new Date() })
      .where(eq(avatars.id, avatarId));
    return c.json({ spawnPreference: 'town' as const, homeParcelId: null });
  }

  // ── mode='home' — parcelId guaranteed present by the schema superRefine ────
  const parcelId = parsed.data.parcelId!;

  // Ownership-verify + write atomically. The parcel row is locked (`FOR UPDATE`)
  // and its owner re-read INSIDE the txn, so a parcel sold/transferred between a
  // bare read and the write can't leave a home pointing at a parcel the caller
  // no longer owns. Returns a discriminated result the handler maps to the
  // documented JSON error bodies (the txn callback never builds a Response).
  type SetHomeResult =
    | { kind: 'ok' }
    | { kind: 'parcel_not_found' }
    | { kind: 'not_owned' };

  const result = await db.transaction(async (tx): Promise<SetHomeResult> => {
    const parcelRows = await tx.execute<{ owner_avatar_id: string | null }>(
      sql`SELECT owner_avatar_id FROM land_parcels WHERE id = ${parcelId} FOR UPDATE`,
    );
    const parcel = parcelRows[0];
    if (!parcel) return { kind: 'parcel_not_found' };
    if (parcel.owner_avatar_id !== avatarId) return { kind: 'not_owned' };

    await tx
      .update(avatars)
      .set({ spawnPreference: 'home', homeParcelId: parcelId, updatedAt: new Date() })
      .where(eq(avatars.id, avatarId));

    return { kind: 'ok' };
  });

  if (result.kind === 'parcel_not_found') {
    return c.json({ error: 'parcel not found', code: 'parcel_not_found' }, 404);
  }
  if (result.kind === 'not_owned') {
    return c.json({ error: 'you do not own that parcel', code: 'not_owned' }, 403);
  }

  return c.json({ spawnPreference: 'home' as const, homeParcelId: parcelId });
});

// ─── 11. POST /parcels/:parcelId/rent  (DISABLED — Phase B tenure model) ─────
//
// FOUNDER-DECIDED (2026-07-07): rent-to-acquire is superseded by the two
// Phase-B tenure mechanisms (starter deposit-escrow via /claim-starter;
// c/b/a/founder CLV hold-to-keep via /parcels/:parcelId/claim-hold). EXISTING
// tenure='rented' parcels are untouched — the sweeper still charges/graces/
// evicts them — but no NEW rental can start. Registered without auth middleware
// (same rationale as the disabled /buy): every caller gets the same 409. The
// pre-Phase-B implementation lives in git history at this diff's parent.
landRoutes.post('/parcels/:parcelId/rent', (c) => c.json({ error: 'tenure_model_active' }, 409));

// ─────────────────────────────────────────────────────────────────────────────
// Service listings — run-a-store (Slice 4, P3)
// ─────────────────────────────────────────────────────────────────────────────

// ─── 12. POST /structures/:structureId/services  (AUTH, PARITY-BOUND, free list) ─
//
//   body: { title: string (1..80), description?: string (0..500), priceCt: int (0..1_000_000) }
//   200 → { listing: ServiceListingDTO }
//   400 → { error: 'invalid_body' | 'invalid_structure_id' | 'not_a_shop' }
//   401/403 as elsewhere   ·   403 → { error: 'not_structure_owner' }
//   404 → { error: 'structure_not_found' }
//   409 → { error: 'structure_archived' | 'ownership_desync' | 'listing_cap_reached' }

landRoutes.post(
  '/structures/:structureId/services',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    const avatarId = identity.avatarId;

    const idParsed = structureIdSchema.safeParse(c.req.param('structureId'));
    if (!idParsed.success) {
      return c.json({ error: 'invalid_structure_id' }, 400);
    }
    const structureId = idParsed.data;

    const rawBody = await c.req.json().catch(() => ({}));
    const bodyParsed = listServiceBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const { title, description, priceCt } = bodyParsed.data;

    type ListResult =
      | { kind: 'ok'; listing: ServiceListingDTO }
      | { kind: 'structure_not_found' }
      | { kind: 'not_a_shop' }
      | { kind: 'structure_archived' }
      | { kind: 'not_structure_owner' }
      | { kind: 'ownership_desync' }
      | { kind: 'listing_cap_reached' };

    const result = await db.transaction(async (tx): Promise<ListResult> => {
      // Per-avatar advisory lock (outer), then the structure+parcel rows
      // (inner) — same deadlock order as buy/upgrade/place-structure.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);

      const rows = await tx.execute<{
        id: string;
        parcel_id: string;
        structure_type: 'home' | 'shop';
        structure_status: string;
        struct_owner: string;
        parcel_owner: string | null;
      }>(
        sql`SELECT s.id, s.parcel_id, s.structure_type, s.status AS structure_status,
                   s.owner_avatar_id AS struct_owner, p.owner_avatar_id AS parcel_owner
            FROM land_structures s
            JOIN land_parcels p ON p.id = s.parcel_id
            WHERE s.id = ${structureId}
            FOR UPDATE OF s, p`,
      );
      const s = rows[0];
      if (!s) return { kind: 'structure_not_found' };
      if (s.structure_type !== 'shop') return { kind: 'not_a_shop' };
      if (s.structure_status !== 'active') return { kind: 'structure_archived' };
      // Ownership is checked against the AUTHORITATIVE parcel row (covers BOTH
      // an owned AND a rented parcel — rent sets land_parcels.owner_avatar_id
      // to the renter, same as buy/upgrade's ownership discipline).
      if (s.parcel_owner !== avatarId) return { kind: 'not_structure_owner' };
      // Defense-in-depth: the structure's denorm owner must agree with the
      // authoritative parcel owner (mirrors /upgrade's ownership_desync guard).
      if (s.struct_owner !== avatarId) return { kind: 'ownership_desync' };

      const countRows = await tx.execute<{ n: number | string }>(
        sql`SELECT COUNT(*)::int AS n FROM service_listings
            WHERE structure_id = ${structureId} AND status = 'active'`,
      );
      if (Number(countRows[0]?.n ?? 0) >= MAX_ACTIVE_LISTINGS_PER_STRUCTURE) {
        return { kind: 'listing_cap_reached' };
      }

      const insertRows = await tx.execute<{
        id: string;
        structure_id: string;
        owner_avatar_id: string;
        kind: 'peer' | 'partner';
        title: string;
        description: string | null;
        price_ct: number | string;
        status: 'active' | 'paused' | 'delisted';
        platform_fee_bps: number | string;
        // Raw execute → timestamps arrive as STRINGS, not Date (see toIso).
        created_at: string;
        updated_at: string;
      }>(
        sql`INSERT INTO service_listings
              (structure_id, owner_avatar_id, kind, title, description, price_ct, status)
            VALUES (${structureId}, ${avatarId}, 'peer', ${title}, ${description ?? null}, ${priceCt}, 'active')
            RETURNING id, structure_id, owner_avatar_id, kind, title, description, price_ct, status, platform_fee_bps, created_at, updated_at`,
      );
      const row = insertRows[0]!;
      return {
        kind: 'ok',
        listing: {
          id: row.id,
          structureId: row.structure_id,
          ownerAvatarId: row.owner_avatar_id,
          kind: row.kind,
          title: row.title,
          description: row.description,
          priceCt: Number(row.price_ct),
          status: row.status,
          platformFeeBps: Number(row.platform_fee_bps),
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        },
      };
    });

    if (result.kind !== 'ok') {
      const statusByKind = {
        structure_not_found: 404,
        not_a_shop: 400,
        structure_archived: 409,
        not_structure_owner: 403,
        ownership_desync: 409,
        listing_cap_reached: 409,
      } as const;
      return c.json({ error: result.kind }, statusByKind[result.kind]);
    }

    bustServiceListingsCache(structureId);

    return c.json({ listing: result.listing });
  },
);

// ─── 13. PATCH /services/:listingId  (AUTH, PARITY-BOUND, own-listing only) ──
//
//   body: { title?, description?, priceCt?, status? } — at least one field (.strict())
//   200 → { listing: ServiceListingDTO }
//   400 → { error: 'invalid_body' | 'invalid_listing_id' }
//   401/403 as elsewhere   ·   403 → { error: 'not_listing_owner' }
//   404 → { error: 'listing_not_found' }

landRoutes.patch('/services/:listingId', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = listingIdSchema.safeParse(c.req.param('listingId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_listing_id' }, 400);
  }
  const listingId = idParsed.data;

  // Sentinel parse — an unparseable body is a hard 400, never coerced to {}.
  const PARSE_FAILED = Symbol('parse_failed');
  const rawBody: unknown = await c.req.json().catch(() => PARSE_FAILED);
  if (rawBody === PARSE_FAILED) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const bodyParsed = updateServiceBodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const patch = bodyParsed.data;

  type PatchResult =
    | { kind: 'ok'; listing: ServiceListingDTO }
    | { kind: 'not_found' }
    | { kind: 'not_owner' };

  const result = await db.transaction(async (tx): Promise<PatchResult> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);

    const rows = await tx.execute<{ id: string; owner_avatar_id: string }>(
      sql`SELECT id, owner_avatar_id FROM service_listings WHERE id = ${listingId} FOR UPDATE`,
    );
    const existing = rows[0];
    if (!existing) return { kind: 'not_found' };
    if (existing.owner_avatar_id !== avatarId) return { kind: 'not_owner' };

    const updates: Partial<typeof serviceListings.$inferInsert> = { updatedAt: new Date() };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.priceCt !== undefined) updates.priceCt = patch.priceCt;
    if (patch.status !== undefined) updates.status = patch.status;

    const [updated] = await tx
      .update(serviceListings)
      .set(updates)
      .where(eq(serviceListings.id, listingId))
      .returning();

    return { kind: 'ok', listing: toServiceListingDTO(updated!) };
  });

  if (result.kind === 'not_found') {
    return c.json({ error: 'listing_not_found' }, 404);
  }
  if (result.kind === 'not_owner') {
    return c.json({ error: 'not_listing_owner' }, 403);
  }

  bustServiceListingsCache(result.listing.structureId);

  return c.json({ listing: result.listing });
});

// ─── 14. GET /structures/:structureId/services  (PUBLIC, cached, rate-limited) ─
//
//   200 → { listings: ServiceListingDTO[] }   (active listings only)
//   400 → { error: 'invalid_structure_id' }   ·   429 → { error: 'rate_limited' }

landRoutes.get('/structures/:structureId/services', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const idParsed = structureIdSchema.safeParse(c.req.param('structureId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_structure_id' }, 400);
  }
  const structureId = idParsed.data;

  const cacheKey = `services:struct:${structureId}`;
  const cached = getServiceListingsCache(cacheKey);
  if (cached) return c.json(cached);

  const rows = await db
    .select()
    .from(serviceListings)
    .where(and(eq(serviceListings.structureId, structureId), eq(serviceListings.status, 'active')));

  const payload: ServiceListingsPayload = { listings: rows.map(toServiceListingDTO) };
  setServiceListingsCache(cacheKey, payload);
  return c.json(payload);
});

// ─── 15. GET /services/mine  (AUTH, PARITY-BOUND, owner-scoped, ALL statuses) ─
//
// The store owner's OWN listings across reloads — INCLUDING paused/delisted (the
// public browse routes 14/16 are active-only), so an owner can see + re-activate
// a listing they paused. This completes the manage loop the public reads can't.
// Owner-scoped by `identity.avatarId` → no leak. NOT cached — an owner's own view
// must reflect a just-completed list/patch immediately (same reasoning as /me).
// PARITY (Rule E5): a connected/hosted agent lists a store just like a human, so
// it reads ITS OWN listings through the same authed path.
//
//   200 → { listings: ServiceListingDTO[] }   (all statuses, newest first)
//   401 → no identity   ·   403 → bound user has no active avatar
//
// Route-order note: registered BEFORE the paged `GET /services` below, but the
// two are DISTINCT literal paths (`/services/mine` vs `/services`) with no param
// route between them (there is no `GET /services/:id`), so there is no shadow.

landRoutes.get('/services/mine', requireAuthOrAgentSession, noStorePrivate, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const rows = await db
    .select()
    .from(serviceListings)
    .where(eq(serviceListings.ownerAvatarId, avatarId))
    .orderBy(desc(serviceListings.createdAt));

  return c.json({ listings: rows.map(toServiceListingDTO) });
});

// ─── 16. GET /services?page=&limit=  (PUBLIC, cached, rate-limited, paged) ───
//
//   200 → { listings: ServiceListingDTO[], nextPage?: number }  (active only, newest first)
//   400 → { error: 'invalid_query' }   ·   429 → { error: 'rate_limited' }

landRoutes.get('/services', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const parsed = servicesPageQuerySchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query' }, 400);
  }
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 20;

  const cacheKey = `services:all:${page}:${limit}`;
  const cached = getServiceListingsCache(cacheKey);
  if (cached) return c.json(cached);

  const offset = (page - 1) * limit;
  // Fetch one extra row to know whether a next page exists without a COUNT(*).
  const rows = await db
    .select()
    .from(serviceListings)
    .where(eq(serviceListings.status, 'active'))
    .orderBy(desc(serviceListings.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasNext = rows.length > limit;
  const pageRows = hasNext ? rows.slice(0, limit) : rows;

  const payload: ServiceListingsPayload = {
    listings: pageRows.map(toServiceListingDTO),
    ...(hasNext ? { nextPage: page + 1 } : {}),
  };
  setServiceListingsCache(cacheKey, payload);
  return c.json(payload);
});

// ─── 17. POST /services/:listingId/buy  (AUTH, PARITY-BOUND, atomic, priced) ─
//
//   body: { idempotencyKey: string (8..64) }  REQUIRED (.strict())
//   200 → { purchase: ServicePurchaseDTO, priceCt: number, cached: boolean }
//   400 → { error: 'invalid_body' | 'invalid_listing_id' | 'insufficient_clawtokens' }
//   401/403 as elsewhere
//   404 → { error: 'listing_not_found' }
//   409 → { error: 'listing_not_active' | 'not_a_peer_listing' | 'structure_unavailable'
//                  | 'self_purchase' | 'idempotency_key_conflict' | 'concurrent_retry' }
//     not_a_peer_listing   = a non-CT (USDC 'partner') listing can't settle here;
//     structure_unavailable = the seller's shop was archived/evicted or the parcel
//                             changed hands after the listing was created;
//     concurrent_retry     = a mutual-buy deadlock (40P01) rolled this tx fully
//                             back — retry with the SAME idempotencyKey.
//
// AFTER COMMIT (fresh purchase only): emits `land.service.sold` keyed to the
// SELLER (weight 40, credited to the seller — this is a run-a-store sale, not
// the buyer's action). A cached replay (same-key retry OR a concurrent 23505
// loser re-served) emits NOTHING — the original request already emitted once.

landRoutes.post('/services/:listingId/buy', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const avatarId = identity.avatarId;

  const idParsed = listingIdSchema.safeParse(c.req.param('listingId'));
  if (!idParsed.success) {
    return c.json({ error: 'invalid_listing_id' }, 400);
  }
  const listingId = idParsed.data;

  // Sentinel parse (Codex money-safety pattern, mirrors /upgrade) — an
  // unparseable body is a hard 400, never coerced toward a keyless charge.
  const PARSE_FAILED = Symbol('parse_failed');
  const rawBody: unknown = await c.req.json().catch(() => PARSE_FAILED);
  if (rawBody === PARSE_FAILED) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const bodyParsed = buyServiceBodySchema.safeParse(rawBody);
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const idempotencyKey = bodyParsed.data.idempotencyKey;

  type BuyResult =
    | {
        kind: 'fresh';
        purchase: ServicePurchaseDTO;
        priceCt: number;
        sellerAvatarId: string;
        structureId: string;
      }
    | { kind: 'cached'; purchase: ServicePurchaseDTO; priceCt: number };

  let result: BuyResult;
  try {
    result = await db.transaction(async (tx): Promise<BuyResult> => {
      // (0) Per-avatar advisory lock on the BUYER (outer — same order as buy/upgrade).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);

      // (1) IDEMPOTENCY FIRST. The `service_purchases_idem_unique` index is
      // GLOBAL on idempotency_key alone (mirrors land_upgrades) — look it up
      // by itself and branch: same listing+buyer → replay the cached
      // purchase (no new charge, no event); otherwise → clean 409 (the key
      // was already spent on a different listing/buyer) rather than falling
      // through to a 23505 that would roll back this call's debit and lie
      // "replayed" while silently dropping this buyer's purchase.
      const priorRows = await tx.execute<{
        id: string;
        listing_id: string;
        buyer_avatar_id: string;
        seller_avatar_id: string;
        price_ct: number | string;
        land_transaction_id: string | null;
        // Raw execute → timestamp arrives as a STRING, not Date (see toIso).
        created_at: string;
      }>(
        sql`SELECT id, listing_id, buyer_avatar_id, seller_avatar_id, price_ct, land_transaction_id, created_at
            FROM service_purchases
            WHERE idempotency_key = ${idempotencyKey}
            LIMIT 1`,
      );
      const prior = priorRows[0];
      if (prior) {
        if (prior.listing_id === listingId && prior.buyer_avatar_id === avatarId) {
          const cachedPriceCt = Number(prior.price_ct);
          return {
            kind: 'cached',
            purchase: {
              id: prior.id,
              listingId: prior.listing_id,
              buyerAvatarId: prior.buyer_avatar_id,
              sellerAvatarId: prior.seller_avatar_id,
              priceCt: cachedPriceCt,
              landTransactionId: prior.land_transaction_id,
              createdAt: toIso(prior.created_at),
            },
            priceCt: cachedPriceCt,
          };
        }
        throw new HTTPException(409, { message: 'idempotency_key_conflict' });
      }

      // (2) Lock the listing row.
      const listingRows = await tx.execute<{
        id: string;
        structure_id: string;
        owner_avatar_id: string;
        kind: 'peer' | 'partner';
        title: string;
        price_ct: number | string;
        status: string;
      }>(
        sql`SELECT id, structure_id, owner_avatar_id, kind, title, price_ct, status
            FROM service_listings
            WHERE id = ${listingId}
            FOR UPDATE`,
      );
      const listing = listingRows[0];
      if (!listing) {
        throw new HTTPException(404, { message: 'listing_not_found' });
      }
      if (listing.status !== 'active') {
        throw new HTTPException(409, { message: 'listing_not_active' });
      }
      // (2a) CT-TIER GUARD (audit ADVISORY→FIX #2) — only a 'peer' listing
      // settles in CT. A future USDC 'partner' listing must NEVER be paid with
      // CT through this route, even if one is somehow created active. Cheap
      // defense-in-depth before any ledger touch.
      if (listing.kind !== 'peer') {
        throw new HTTPException(409, { message: 'not_a_peer_listing' });
      }

      // (2b) STALE-LISTING / POST-EVICTION GUARD (audit BLOCKING #1) — the buy
      // is the one money route that trusted the listing's denorm owner without
      // re-verifying the shop still exists AND is still held by the seller. The
      // rent sweeper archives the structure + returns the parcel to the pool on
      // a rent-lapse eviction but does NOT cascade-delist its service_listings
      // (confirmed), so a listing can outlive the seller's ownership of the
      // shop — a buy would then pay a seller who no longer runs it. Re-read the
      // structure + parcel under a lock (mirrors the LIST/upgrade ownership-
      // desync discipline) and reject a defunct/transferred shop BEFORE any
      // ledger touch. Lock order is buyer-advisory → listing → land_structures
      // → land_parcels (s-before-p, same as the LIST route), so no new deadlock
      // edge is introduced.
      const shopRows = await tx.execute<{
        struct_status: string;
        parcel_owner: string | null;
      }>(
        sql`SELECT s.status AS struct_status, p.owner_avatar_id AS parcel_owner
            FROM land_structures s
            JOIN land_parcels p ON p.id = s.parcel_id
            WHERE s.id = ${listing.structure_id}
            FOR UPDATE OF s, p`,
      );
      const shop = shopRows[0];
      if (
        !shop ||
        shop.struct_status !== 'active' ||
        shop.parcel_owner !== listing.owner_avatar_id
      ) {
        throw new HTTPException(409, { message: 'structure_unavailable' });
      }

      // (3) SERVER-authoritative price — the body never carries a price.
      const priceCt = Number(listing.price_ct);
      const sellerAvatarId = listing.owner_avatar_id;

      // (4) Self-purchase — asserted BEFORE any ledger touch.
      if (sellerAvatarId === avatarId) {
        throw new HTTPException(409, { message: 'self_purchase' });
      }

      // (5) Settlement — conservation (price in == price out, NO rake, NO
      // mint). priceCt===0 (free service) skips the ledger entirely
      // (debitClawTokens throws on amount<=0) but still writes the audit +
      // purchase rows below.
      let debitLedgerId: string | null = null;
      if (priceCt > 0) {
        const debit = await debitClawTokens(
          {
            avatarId,
            amount: priceCt,
            reason: 'land_service_purchase',
            source: 'api',
            metadata: { listingId, sellerAvatarId },
            actorKind: toActorKind(identity.kind),
          },
          tx,
        );
        debitLedgerId = debit.ledgerId;

        // Seller is credited SOFT — peer CT can NEVER mint cashable EARNED
        // (conservation; the laundering defense). Composed IN THIS tx (never
        // transferClawTokens, which opens its OWN transaction and would break
        // atomicity with the service_purchases insert below).
        await creditClawTokens(
          {
            avatarId: sellerAvatarId,
            amount: priceCt,
            reason: 'land_service_sale',
            source: 'api',
            provenance: 'soft',
            metadata: { listingId, buyerAvatarId: avatarId },
            actorKind: toActorKind(identity.kind),
          },
          tx,
        );
      }

      // (6) Land-domain audit row — parcel_id resolved via the structure join
      // (a service listing has no parcel_id of its own).
      const meta = JSON.stringify({ listingId, sellerAvatarId, title: listing.title });
      const auditRows = await tx.execute<{ id: string }>(
        sql`INSERT INTO land_transactions
              (kind, parcel_id, structure_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
            VALUES (
              'service_sale',
              (SELECT parcel_id FROM land_structures WHERE id = ${listing.structure_id}),
              ${listing.structure_id},
              ${avatarId},
              ${priceCt},
              ${debitLedgerId},
              ${meta}::jsonb
            )
            RETURNING id`,
      );
      const landTransactionId = auditRows[0]!.id;

      // (7) Insert the purchase row. A concurrent same-key winner trips the
      // GLOBAL idempotency_key unique index (23505) — let it propagate OUT of
      // this transaction (rolling back the debit/credit we just made here,
      // which is correct: the winner already committed its own charge) so the
      // OUTER catch can re-fetch the winning row over a fresh, non-aborted
      // connection (mirrors the /upgrade 23505 handler exactly).
      const purchaseRows = await tx.execute<{
        id: string;
        listing_id: string;
        buyer_avatar_id: string;
        seller_avatar_id: string;
        price_ct: number | string;
        land_transaction_id: string | null;
        // Raw execute → timestamp arrives as a STRING, not Date (see toIso).
        created_at: string;
      }>(
        sql`INSERT INTO service_purchases
              (listing_id, buyer_avatar_id, seller_avatar_id, price_ct, land_transaction_id, idempotency_key)
            VALUES (${listingId}, ${avatarId}, ${sellerAvatarId}, ${priceCt}, ${landTransactionId}, ${idempotencyKey})
            RETURNING id, listing_id, buyer_avatar_id, seller_avatar_id, price_ct, land_transaction_id, created_at`,
      );
      const row = purchaseRows[0]!;

      return {
        kind: 'fresh',
        purchase: {
          id: row.id,
          listingId: row.listing_id,
          buyerAvatarId: row.buyer_avatar_id,
          sellerAvatarId: row.seller_avatar_id,
          priceCt: Number(row.price_ct),
          landTransactionId: row.land_transaction_id,
          createdAt: toIso(row.created_at),
        },
        priceCt,
        sellerAvatarId,
        structureId: listing.structure_id,
      };
    });
  } catch (err) {
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      // Concurrent same-key winner — our INSERT tripped the GLOBAL
      // idempotency_key unique index AFTER our own pre-check read (step 1), so
      // the whole tx (including our debit/credit) rolled back. Re-fetch the
      // winner OUTSIDE the now-aborted tx and serve it ONLY if it really is
      // THIS listing+buyer (ownership-safe — never disclose another buyer's
      // purchase row), mirroring the /upgrade 23505 handler's defensive check.
      const winnerRows = await db
        .select({
          id: servicePurchases.id,
          listingId: servicePurchases.listingId,
          buyerAvatarId: servicePurchases.buyerAvatarId,
          sellerAvatarId: servicePurchases.sellerAvatarId,
          priceCt: servicePurchases.priceCt,
          landTransactionId: servicePurchases.landTransactionId,
          createdAt: servicePurchases.createdAt,
        })
        .from(servicePurchases)
        .where(eq(servicePurchases.idempotencyKey, idempotencyKey))
        .limit(1);
      const winner = winnerRows[0];
      if (winner && winner.listingId === listingId && winner.buyerAvatarId === avatarId) {
        return c.json(
          {
            purchase: {
              id: winner.id,
              listingId: winner.listingId,
              buyerAvatarId: winner.buyerAvatarId,
              sellerAvatarId: winner.sellerAvatarId,
              priceCt: winner.priceCt,
              // winner.* is a drizzle .select() (real Date), but toIso keeps the
              // whole route's date-serialization uniform + string-tolerant.
              landTransactionId: winner.landTransactionId,
              createdAt: toIso(winner.createdAt),
            },
            priceCt: winner.priceCt,
            cached: true,
          },
          200,
        );
      }
      return c.json({ error: 'idempotency_key_conflict' }, 409);
    }
    if (pgCode === '40P01') {
      // Mutual-buy DEADLOCK (audit ADVISORY→FIX #3): A-buys-B's-service while
      // B-buys-A's inverts the debit-own/credit-other ledger-row lock order.
      // Postgres picks a victim and rolls its whole tx back (debit + credit +
      // audit + purchase — nothing committed), so it is money-safe to ask the
      // client to retry with the SAME idempotencyKey (which then proceeds fresh,
      // or replays if the peer's tx already committed this key). Not re-ordering
      // the ledger locks — the retryable-409 is the minimal correct fix.
      return c.json({ error: 'concurrent_retry' }, 409);
    }
    if (err instanceof InsufficientTokensError) {
      return c.json({ error: 'insufficient_clawtokens' }, 400);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as 404 | 409);
    }
    throw err;
  }

  if (result.kind === 'cached') {
    return c.json({ purchase: result.purchase, priceCt: result.priceCt, cached: true });
  }

  // FRESH purchase committed — bust the structure's + all-listings browse cache.
  bustServiceListingsCache(result.structureId);

  // Resolve the SELLER's own agentId/userId (durably — the seller may be
  // offline right now) so the emitted event carries the SELLER as the
  // credited subject, never the buyer. LEFT JOIN FROM avatars (not an INNER
  // JOIN from openclaw_bots) — a human-only seller with no connected agent
  // still needs its userId resolved for the event; an INNER JOIN would
  // silently drop it and mis-attribute the row to no one. ORDER BY
  // lastSeenAt DESC + LIMIT 1 is a deterministic tie-break for the rare case
  // of more than one bot row per user — liveness is irrelevant here (this is
  // a leaderboard-credit lookup, not a real-CT settlement gate).
  const sellerRows = await db
    .select({ userId: avatars.userId, agentId: agentBots.agentId })
    .from(avatars)
    .leftJoin(agentBots, eq(agentBots.userId, avatars.userId))
    .where(eq(avatars.id, result.sellerAvatarId))
    .orderBy(desc(agentBots.lastSeenAt))
    .limit(1);
  const seller = sellerRows[0];
  const sellerUserId = seller?.userId ?? null;
  const sellerAgentId = seller?.agentId ?? null;

  // CONTRACT (leaderboard-progression, P3 slice 4): `priceCt` and
  // `buyerAvatarId` are LOAD-BEARING for the scoring CTE — the paid-only
  // filter (throw-proof text compare on priceCt) and the DISTINCT-BUYER
  // anti-wash cap key. Never drop or rename them without coordinating with
  // the leaderboard owner.
  void logEventFromContext(c, {
    eventType: LAND_EVENT_TYPES.SERVICE_SOLD,
    userId: sellerUserId,
    avatarId: result.sellerAvatarId,
    agentId: sellerAgentId,
    payload: {
      listingId,
      structureId: result.structureId,
      priceCt: result.priceCt,
      buyerAvatarId: avatarId,
    },
  });

  return c.json({ purchase: result.purchase, priceCt: result.priceCt, cached: false });
});
