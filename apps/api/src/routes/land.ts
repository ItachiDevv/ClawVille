/**
 * LAND P2 TENURE CONTRACT (supersedes legacy route notes later in this header):
 * - POST /claim-starter: unconditional pre-auth 409 `tenure_model_active`.
 * - POST /hold-wallet: auth -> ledger-capable -> non-guest; strict
 *   `{ walletAddress }`; canonical base58 declaration; first declaration is
 *   human/agent parity-open, but repointing is human-only and 409
 *   `wallet_locked_by_hold` while any live v2 hold exists. A declaration is a
 *   CLAIM only — a repoint NULLs any existing proof in the same statement.
 * - Hold-wallet OWNERSHIP PROOF (poll-primary door 2, founder ruling
 *   2026-08-11) — same middleware chain on every route, so a connected agent
 *   proves AS ITSELF and a guest is 403'd:
 *     GET  /hold-wallet                       adds
 *          `verification: { state: 'unverified'|'verified'|'grandfathered',
 *                           method, verifiedAt, transferDoorAvailable }`
 *     POST /hold-wallet/verify/challenge      -> { nonce, expiresAt,
 *                                                 messageToSign, walletAddress }
 *     POST /hold-wallet/verify/signature      strict `{ nonce, signature }`
 *     POST /hold-wallet/verify/custodial      strict `{}`
 *     POST /hold-wallet/verify/transfer/challenge  strict `{}`
 *     GET  /hold-wallet/verify/transfer/:challengeId  primary auto-discovery
 *     POST /hold-wallet/verify/transfer/:challengeId/submit  fallback
 *   Errors: wallet_not_verified (403 on claim-hold), wallet_not_declared,
 *   invalid_challenge, invalid_signature, signature_verification_failed,
 *   not_custodial_wallet, transfer_door_unavailable, verify_attempt_cap,
 *   challenge_expired.
 * - POST /parcels/:parcelId/claim-rent: same middleware; strict
 *   `{ weeks: 1..26, idempotencyKey: 8..64 }`; server quotes starter=1000 and
 *   c=2500 vCLAW/week; founder has no rent door. Week one is irrevocably paid
 *   to treasury and only future weeks enter refundable escrow.
 *   Parcel DTOs expose `claimRentCtWeekly` from those same constants; the
 *   legacy `rentCtWeekly` row stamp remains the incumbent tenancy's terms.
 * - POST /parcels/:parcelId/claim-hold: same middleware; strict
 *   `{ idempotencyKey }`; starter/c/founder require 100k/250k/10m CLV from the
 *   account's declared wallet, freshly read on-chain; requirements stack.
 * - POST /parcels/:parcelId/deposit-topup: same middleware; strict
 *   preferred `{ weeks: 1..26, idempotencyKey }` derives the amount from the
 *   locked tenancy rate; legacy `{ amountCt: 1..1_000_000, idempotencyKey }`
 *   remains accepted for compatibility. Durable replay and atomic cap.
 * - POST /parcels/:parcelId/release: same middleware; strict
 *   `{ idempotencyKey }`; the key binds the acquisition marker, preventing a
 *   stale retry from releasing a later tenancy.
 * Shared errors include idempotency_key_conflict/concurrent_retry (409),
 * autonomous_daily_cap (429), and fail-closed treasury/CLV 503 responses.
 *
 * Land Economy routes (`/api/land`). The legacy free-starter/buy/rent doors are
 * stable 409 dead ends; P2 acquisition is the parcel-specific Hold/Rent surface
 * above and all money-bearing writes delegate to the shared settlement service.
 *
 * RULE E5 PARITY: every write resolves the acting avatar from
 * `c.get('identity').avatarId` (set by `requireAuthOrAgentSession`), which is a
 * REAL avatar for BOTH a Lucia-authed human AND a connected/hosted agent
 * session. There is no guest fallback: Hold/Rent claim, prepay, and release bind
 * to the resolved identity.avatarId for humans and agents alike.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FROZEN RESPONSE CONTRACT (the web UI + 3da overlay build to THIS next turn).
 * `LandParcelDTO` is the shared parcel shape returned by every read route below.
 * `LandStructureDTO` is the shared structure shape (placement / upgrade / reads).
 *
 *   type LandParcelDTO = {
 *     id: string;            // uuid
 *     parcelCode: string;    // "parcel-<tier>-<NN>"
 *     displayName: string;   // deterministic human label; parcelCode remains the key
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
 *   type LandStructurePieceDTO = {
 *     id: string; parcelId: string; pieceKey: string;
 *     gridX: number; gridY: number; rotationStep: number; stackLevel: number;
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
 *      403 → { error: 'wallet_not_verified', walletAddress }
 *            (2026-08-10) the declared wallet carries no ownership proof and is
 *            not grandfathered. Enforced at BOTH the pre-transaction read and
 *            the in-transaction FOR SHARE re-read.
 *      403 → { error: 'insufficient_clv_hold', requiredClv, heldClv }
 *      404 → { error: 'parcel_not_found' }
 *      409 → { error: 'parcel_not_available' | 'parcel_cap_reached' }
 *      503 → { error: 'clv_balance_unavailable' } (FAIL-CLOSED: RPC/read down)
 *
 * 7c. POST /api/land/parcels/:parcelId/deposit-topup  (AUTH, PARITY-BOUND, B1)
 *      preferred body: { weeks: int 1..26, idempotencyKey } (.strict()) — the
 *      server derives amountCt from the locked tenancy rate. Legacy
 *      { amountCt: int 1..1_000_000, idempotencyKey } remains additive.
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
 *            costCt = SERVER-derived structureUpgradeCostCt(structureType, target);
 *            target = level+1. Homes and shops have DIFFERENT ladders (Q3).
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
 * 12. POST /api/land/parcels/:parcelId/pieces (AUTH, D5 priced placement)
 *     strict body: { pieceKey, gridX, gridY, rotationStep, stackLevel,
 *                    idempotencyKey: string (8..64, required) }
 *     200: { piece: LandStructurePieceDTO, costCt, idempotencyReplay?: true }
 *     Requires an active structure; fee transfers owner-to-house in the insert tx.
 *     404: { error: 'parcel_not_found' | 'structure_required' }
 *     400: { error: 'unknown_piece_key' | 'structure_level_invalid' |
 *                    'piece_unknown' | 'cell_out_of_bounds' | 'rotation_not_allowed' }
 *     409: { error: 'level_cap_exceeded' | 'stack_exceeds_height' |
 *                    'unsupported_stack' | 'outside_parcel' | 'intersects_shell' |
 *                    'intersects_piece' | 'cell_occupied' | 'piece_catalog_drift' |
 *                    'structure_not_active' | 'ownership_desync' |
 *                    'idempotency_key_conflict' }
 *     Geometry is decided by the SHARED `evaluatePlacement` predicate (rotated
 *     footprint + level-independent shell envelope + cross-level 3D occupancy),
 *     NOT the anchor cell alone. `cell_reserved` / `stack_support_required` /
 *     `piece_cap_reached` are superseded by `intersects_shell` /
 *     `unsupported_stack` / `level_cap_exceeded`. `cell_occupied` survives as
 *     the unique-index backstop on an exact (x, y, stackLevel) collision.
 * 13. PATCH /api/land/pieces/:pieceId (AUTH, FREE move)
 *     strict body: { gridX, gridY, rotationStep, stackLevel }
 *     Re-validated against the SAME predicate, with the moved piece excluded
 *     from its own occupancy + counts. This is the Q5 free-move escape hatch:
 *     a grandfathered illegal piece is never deleted, only movable to a legal
 *     position at no fee. Same 400/409 code set as route 12.
 * 14. DELETE /api/land/pieces/:pieceId (AUTH, FREE, NO REFUND)
 *     200: { deleted: true, piece: LandStructurePieceDTO }
 * 15. GET /api/land/pieces/public (PUBLIC, cached, no PII)
 *     200: { parcelCode, pieceKey, gridX, gridY, rotationStep, stackLevel }[]
 * 16. GET /api/land/parcels/:parcelId/pieces (AUTH, owner read, no-store)
 *     200: { pieces: LandStructurePieceDTO[] }
 *     Owner of the parcel's ACTIVE structure only; includes private piece IDs
 *     so pieces remain movable/removable after a reload. READ-ONLY: no ledger
 *     writes and no public-cache interaction.
 *     400: { error: 'invalid_parcel_id' }
 *     403: { error: 'not_structure_owner' }
 *     404: { error: 'parcel_not_found' | 'structure_required' }
 *     429: { error: 'rate_limited' }
 *
 * PHASE3: expose buy / structure / upgrade via the agent tools.json surface +
 * the npc-simulation `[ACTION:]` whitelist + a PROTOCOL_VERSION bump, so a
 * connected Hatcher agent can run the land economy through its action channel
 * (not just the authed HTTP path). The HTTP routes already bind to the agent's
 * own avatar via `requireAuthOrAgentSession` (E5 settlement parity) — Phase 3
 * is purely the DISCOVERY/whitelist surface, NOT a settlement change. Do NOT
 * touch the partner/hatcher surface or skill-protocol.ts in THIS diff.
 */

import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import {
  db,
  users,
  avatars,
  landParcels,
  landStructures,
  landStructurePieces,
  landUpgrades,
  serviceListings,
  servicePurchases,
  agentBots,
  eq,
  and,
  desc,
  isNull,
  sql,
} from '@clawville/database';
import {
  LAND_EVENT_TYPES,
  LAND_PARCELS,
  LAND_TIERS,
  STRUCTURE_UPGRADE_COSTS_BY_TYPE,
  structureUpgradeCostCt,
  MAX_STRUCTURE_LEVEL,
  MAX_PARCELS_PER_AVATAR,
  RENT_PERIOD_DAYS,
  LAND_STARTER_DEPOSIT_CT,
  LAND_STARTER_RENT_CT_WEEKLY,
  FOUNDER_UPKEEP_CT_WEEKLY,
  holdThresholdForTier,
  parcelDisplayName,
  tenureRentCtWeeklyForTier,
  getCatalogEntry,
  getTierStructureRules,
  getTierMaxLevel,
  isSkuAllowedForTier,
  isShellAllowed,
  isPaletteAllowed,
  DEFAULT_SHELL_KEY,
  DEFAULT_PALETTE_KEY,
  KIT_PAYMENT_RAILS,
  type KitPieceKey,
  type LandTier,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
} from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext, ActivityIdentity } from '../middleware/require-auth-or-agent';
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
import { InsufficientMaterialsError } from '../services/material-ledger';
import { type CovenantActorKind } from '../services/covenant-action-recorder';
import { getHouseTreasuryAvatarId } from '../services/house-treasury-seeder';
import {
  getLinkedWalletClvBalance,
  getWalletClvBalance,
  type ClvBalanceResult,
} from '../services/linked-wallet-clv-balance';
import type { AppContext } from '../types';
import {
  attestCustodialLandHoldWallet,
  declareLandHoldWallet,
  grantLandHoldWalletVerification,
  LandTenureSettlementError,
  readHoldWalletDeclaration,
  settleRentPrepay,
  settleTenureClaim,
  settleTenureRelease,
} from '../services/land-tenure-settlement';
import {
  evaluateKitWrite,
  isKitPieceKey,
  kitPlacementRefusalStatus,
  settleKitPlacement,
  throwKitAuthorityError,
  toLandStructurePieceDTO,
  validateKitAuthority,
  type KitPlacementSettlementResult,
  type LandStructurePieceDTO,
} from '../services/land-kit-settlement';

// The kit-placement money path and its helpers moved to the settlement service
// (P7c) so the hosted `place_kit_piece` executor and this route settle through
// ONE implementation. These re-exports keep the route's public import surface
// stable for existing consumers.
export {
  evaluateKitWrite,
  isKitPieceKey,
  kitPlacementFeeForKey,
  kitPlacementRefusalStatus,
  matchesKitPlacementReplay,
  materialsCostFromPlacementAudit,
  railFromPlacementAudit,
  validateKitAuthority,
} from '../services/land-kit-settlement';
export type {
  KitAuthority,
  KitAuthorityError,
  LandStructurePieceDTO,
} from '../services/land-kit-settlement';
import {
  buildLandHoldWalletMessage,
  consumeLandHoldWalletChallenge,
  issueLandHoldWalletChallenge,
} from '../services/land-hold-wallet-challenge';
import {
  getTransferDoorAvailability,
  LandHoldVerifyError,
  openTransferChallenge,
  pollTransferChallenge,
  submitTransferSignature,
} from '../services/land-hold-transfer-verify';
import { parcelHasLiveDeedLock } from '../services/land-tenure-helpers';

export { parcelHasLiveDeedLock };

/** Map the auth identity kind onto the covenant actor vocabulary. */
const toActorKind = (kind: 'user' | 'agent'): CovenantActorKind =>
  kind === 'user' ? 'human' : 'agent';

function settlementInput(identity: ActivityIdentity, parcelCode: string, idempotencyKey: string) {
  return {
    identity,
    expectedAvatarId: identity.avatarId,
    expectedUserId: identity.userId,
    expectedAgentId: identity.kind === 'agent' ? identity.agentId : null,
    parcelCode,
    idempotencyKey,
    autonomous: false,
  } as const;
}

async function parcelCodeForId(parcelId: string): Promise<string | null> {
  const rows = await db
    .select({ parcelCode: landParcels.parcelCode })
    .from(landParcels)
    .where(eq(landParcels.id, parcelId))
    .limit(1);
  return rows[0]?.parcelCode ?? null;
}

function settlementError(c: Context<ActivityAuthContext>, err: unknown) {
  if (!(err instanceof LandTenureSettlementError)) throw err;
  return c.json(
    { error: err.code, code: err.code, ...err.details },
    err.status as 400 | 403 | 404 | 409 | 429 | 503,
  );
}

/**
 * Hold-wallet verification surface error mapper. Door 1 / custodial raise
 * `LandTenureSettlementError`; door 2 raises `LandHoldVerifyError` from the
 * transfer service. Both carry a machine-readable code + status, so the UI's
 * `tenureError` map reads one shape either way.
 */
function verifyError(c: Context<ActivityAuthContext>, err: unknown) {
  if (err instanceof LandHoldVerifyError) {
    return c.json(
      { error: err.code, code: err.code, ...(err.detail ? { detail: err.detail } : {}) },
      err.status as 400 | 401 | 403 | 404 | 409 | 429 | 503,
    );
  }
  return settlementError(c, err);
}

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
  displayName: string;
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
  /** Server-authoritative weekly quote for a fresh P2 rent claim. */
  claimRentCtWeekly: number | null;
  /** HOW the parcel is held; null = available/unsold (mirrors `land_tenure` enum). */
  tenure: LandTenure | null;
  /** B1: original claim deposit escrowed (immutable); null on non-deposit rows. */
  depositCt: number | null;
  /** B1: live escrow remainder (see the schema conservation invariant); null on non-deposit rows. */
  depositRemainingCt: number | null;
  /** B2: stamped CLV hold threshold (CLV uiAmount); null on non-hold rows. */
  holdThresholdCt: number | null;
  rentPaidThrough: string | null;
  graceUntil: string | null;
  tenureLastCheckedAt: string | null;
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

/** Frozen no-PII shape consumed by the stage-B renderer. */
export interface PublicLandStructurePieceDTO {
  parcelCode: string;
  pieceKey: KitPieceKey;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}

/** The 4 valid parcel statuses (mirrors `landParcelStatusEnum`). */
const PARCEL_STATUSES = ['available', 'owned', 'reserved', 'retired'] as const;
const RENDERED_PARCEL_CODES = new Set(LAND_PARCELS.map((parcel) => parcel.id));

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
const pieceIdSchema = z.string().uuid();

// claim-hold + release take NO input — every value is server-resolved. Reject
// any stray field so a client cannot smuggle a price/tier/threshold/etc.
const emptyStrictBodySchema = z.object({}).strict();

// deposit-topup prefers whole weeks so the settlement derives the amount from
// the locked tenancy rate. The bounded legacy amount form remains additive.
const depositTopupBodySchema = z.union([
  z.object({
    weeks: z.number().int().min(1).max(26),
    idempotencyKey: z.string().min(8).max(64),
  }).strict(),
  z.object({
    amountCt: z.number().int().min(1).max(1_000_000),
    idempotencyKey: z.string().min(8).max(64),
  }).strict(),
]);

const rentClaimBodySchema = z
  .object({
    weeks: z.number().int().min(1).max(26),
    idempotencyKey: z.string().min(8).max(64),
  })
  .strict();

const holdClaimBodySchema = z
  .object({ idempotencyKey: z.string().min(8).max(64) })
  .strict();

const releaseBodySchema = holdClaimBodySchema;

const declareHoldWalletBodySchema = z
  .object({ walletAddress: z.string().min(32).max(44) })
  .strict();

// Door-1 signature proof. The wallet pubkey is NEVER taken from the body — the
// server signs against the CURRENTLY DECLARED wallet it read itself, so a caller
// cannot present a proof for a wallet the account has not declared.
// 32-byte base58 nonce → 43-44 chars; 64-byte base58 signature → 86-88 chars.
const holdWalletVerifySignatureBodySchema = z
  .object({
    nonce: z.string().min(32).max(64),
    signature: z.string().min(80).max(96),
  })
  .strict();

const challengeIdSchema = z.string().uuid();

/**
 * Door-2 exact-signature FALLBACK: the caller names the transaction when the
 * poll-primary bounded scan has not found it. A base58 ed25519 signature is
 * 87-88 chars; the service re-checks the decoded length before any RPC work.
 */
const holdWalletSubmitTransferBodySchema = z
  .object({ signature: z.string().min(64).max(90) })
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

export const createKitPieceBodySchema = z
  .object({
    pieceKey: z.string().min(1).max(64),
    gridX: z.number().int(),
    gridY: z.number().int(),
    rotationStep: z.number().int(),
    stackLevel: z.number().int(),
    idempotencyKey: z.string().min(8).max(64),
    /**
     * P5b. Defaults to `vclaw` so every pre-existing client keeps working
     * unchanged — the material rail is opt-in, never a silent switch of which
     * currency a player's yard costs.
     */
    paymentRail: z.enum(KIT_PAYMENT_RAILS).default('vclaw'),
  })
  .strict();

export const moveKitPieceBodySchema = z
  .object({
    gridX: z.number().int(),
    gridY: z.number().int(),
    rotationStep: z.number().int(),
    stackLevel: z.number().int(),
  })
  .strict();

/**
 * The slot-rent cursor a NEW listing starts on (land gamification P5a, B2 fix).
 *
 * Returned as a SQL fragment rather than a value so the read and the write are
 * ONE statement — no extra round trip, and no window in which application code
 * holds a stale answer.
 *
 * That is NOT what makes it safe under concurrency, and an earlier version of
 * this comment claimed it was. Under READ COMMITTED a subquery inside an INSERT
 * sees exactly the snapshot a separate SELECT would, so two concurrent creates
 * could both observe "no history" on their own. What actually serializes them
 * is the pre-existing PER-OWNER advisory lock the create route already takes
 * (`pg_advisory_xact_lock(hashtextextended(avatarId, 0))`, land.ts ~4083):
 * a structure has exactly one owner, so two creates against the same structure
 * are necessarily the same owner and cannot run concurrently. If that lock is
 * ever removed or narrowed, THIS rule loses its serialization and needs its own.
 *
 * The rule: the free first week belongs to the SHOP, not to a row. It is
 * granted once per structure, ever; every later listing inherits the furthest
 * paid-through the shop has already bought, floored at now(). That is what
 * closes the delist-and-recreate bypass — the delisted row keeps its cursor and
 * the replacement inherits it, so recreating buys nothing.
 *
 * `GREATEST` sits inside an explicit COUNT branch because `GREATEST(now(), NULL)`
 * returns now() in Postgres, which would have silently denied every genuinely
 * new shop its first free week.
 */
export function slotPaidThroughOnCreateSql(structureId: string) {
  return sql`(SELECT CASE
                       WHEN count(*) = 0
                         THEN now() + make_interval(days => ${RENT_PERIOD_DAYS})
                       ELSE GREATEST(now(), COALESCE(max(prior.slot_paid_through), now()))
                     END
                FROM service_listings prior
               WHERE prior.structure_id = ${structureId})`;
}

// upgrade: the only client input is a REQUIRED idempotency key (Codex BLOCK
// HIGH — keyless-replay double-charge). A retry MUST carry the same key or the
// server would treat the 2nd call as a fresh Lv+1 upgrade and debit AGAIN. The
// target level + cost are still server-derived (current level + 1 →
// STRUCTURE_UPGRADE_COSTS_BY_TYPE) — never client-trusted. The frontend already sends
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
const ownerPiecesReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
const holdWalletReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
// Ownership-proof surface. Tighter than the read limiter because each call
// either mints a single-use nonce or runs an ed25519 verify; door 2 additionally
// enforces its own per-user daily attempt cap inside the service (a refund burns
// real SOL fees, so an unbounded attempt loop is a drain vector).
const holdWalletVerifyLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });

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

let publicPiecesCache: {
  payload: PublicLandStructurePieceDTO[];
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

function getPublicPiecesCache(): PublicLandStructurePieceDTO[] | null {
  if (publicPiecesCache === null) return null;
  if (publicPiecesCache.expiresAt < Date.now()) {
    publicPiecesCache = null;
    return null;
  }
  return publicPiecesCache.payload;
}

function setPublicPiecesCache(payload: PublicLandStructurePieceDTO[]): void {
  publicPiecesCache = { payload, expiresAt: Date.now() + READ_CACHE_TTL_MS };
}

/** Bust after piece mutations or any structure-status/parcel lifecycle write. */
export function bustPublicPiecesCache(): void {
  publicPiecesCache = null;
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
  rentPaidThrough: Date | null;
  graceUntil: Date | null;
  updatedAt: Date;
}): LandParcelDTO {
  return {
    id: row.id,
    parcelCode: row.parcelCode,
    displayName: parcelDisplayName(row.parcelCode, row.tier),
    tier: row.tier,
    status: row.status,
    gridX: row.gridX,
    gridY: row.gridY,
    priceCt: row.priceCt,
    ownerAvatarId: row.ownerAvatarId,
    rentCtWeekly: row.rentCtWeekly,
    claimRentCtWeekly: tenureRentCtWeeklyForTier(row.tier),
    tenure: row.tenure,
    depositCt: row.depositCt,
    depositRemainingCt: row.depositRemainingCt,
    holdThresholdCt: row.holdThresholdCt,
    rentPaidThrough: row.rentPaidThrough?.toISOString() ?? null,
    graceUntil: row.graceUntil?.toISOString() ?? null,
    tenureLastCheckedAt: row.updatedAt.toISOString(),
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
      rentPaidThrough: landParcels.rentPaidThrough,
      graceUntil: landParcels.graceUntil,
      updatedAt: landParcels.updatedAt,
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

export function toPublicLandStructurePieceDTO(row: {
  parcelCode: string;
  pieceKey: string;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}): PublicLandStructurePieceDTO {
  if (!isKitPieceKey(row.pieceKey)) {
    throw new Error(`[land] unknown persisted public kit piece key: ${row.pieceKey}`);
  }
  return { ...row, pieceKey: row.pieceKey };
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
    await tx.execute(sql`DELETE FROM land_structure_pieces WHERE parcel_id = ${parcelId}`);
    await tx.execute(sql`DELETE FROM land_structures WHERE id = ${s.id}`);
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
  /** Featured placement is LIVE (intent flag AND an unexpired paid-through). */
  featured: boolean;
  /** Slot rent lapsed — kept and restorable, but not sellable (P5a). */
  suspended: boolean;
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
    // "Featured right now" is the INTENT flag AND a live paid-through — the
    // flag alone never grants placement.
    featured:
      row.featured
      && row.featuredPaidThrough !== null
      && new Date(row.featuredPaidThrough).getTime() > Date.now(),
    suspended: row.slotSuspendedAt !== null,
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
      rentPaidThrough: landParcels.rentPaidThrough,
      graceUntil: landParcels.graceUntil,
      updatedAt: landParcels.updatedAt,
    })
    .from(landParcels)
    .where(where);

  const payload = rows
    .filter((row) => RENDERED_PARCEL_CODES.has(row.parcelCode))
    .map(toDTO);
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

// Public kit render feed (cached 60s, no owner identity or database UUIDs).
landRoutes.get('/pieces/public', async (c) => {
  if (!publicReadLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  c.header('Cache-Control', 'public, max-age=30');

  const cached = getPublicPiecesCache();
  if (cached) return c.json(cached);

  const rows = await db
    .select({
      parcelCode: landParcels.parcelCode,
      pieceKey: landStructurePieces.pieceKey,
      gridX: landStructurePieces.gridX,
      gridY: landStructurePieces.gridY,
      rotationStep: landStructurePieces.rotationStep,
      stackLevel: landStructurePieces.stackLevel,
    })
    .from(landStructurePieces)
    .innerJoin(landParcels, eq(landParcels.id, landStructurePieces.parcelId))
    .innerJoin(landStructures, eq(landStructures.parcelId, landStructurePieces.parcelId))
    .where(eq(landStructures.status, 'active'))
    .orderBy(
      landParcels.parcelCode,
      landStructurePieces.gridX,
      landStructurePieces.gridY,
      landStructurePieces.stackLevel,
    );

  const payload = rows.map(toPublicLandStructurePieceDTO);
  setPublicPiecesCache(payload);
  return c.json(payload);
});

// Owner-scoped piece IDs complete the move/remove loop after a reload. The
// resolved avatar id is both the authorization subject and the rate-limit key.
landRoutes.get(
  '/parcels/:parcelId/pieces',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  noStorePrivate,
  async (c) => {
    const avatarId = c.get('identity').avatarId;
    if (!ownerPiecesReadLimiter.check(avatarId)) {
      return c.json({ error: 'rate_limited' }, 429);
    }

    const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
    if (!idParsed.success) {
      return c.json({ error: 'invalid_parcel_id' }, 400);
    }
    const parcelId = idParsed.data;

    const authorityRows = await db
      .select({
        parcelOwnerAvatarId: landParcels.ownerAvatarId,
        structureOwnerAvatarId: landStructures.ownerAvatarId,
        structureStatus: landStructures.status,
      })
      .from(landParcels)
      // Join the ACTIVE structure only — archived rows can coexist on a parcel
      // after eviction + re-placement, and a bare parcelId join with limit(1)
      // would nondeterministically pick one (false 403/404 for the real owner).
      .leftJoin(
        landStructures,
        and(
          eq(landStructures.parcelId, landParcels.id),
          eq(landStructures.status, 'active'),
        ),
      )
      .where(eq(landParcels.id, parcelId))
      .limit(1);
    const authority = authorityRows[0];
    if (!authority) {
      return c.json({ error: 'parcel_not_found' }, 404);
    }
    if (
      authority.parcelOwnerAvatarId !== avatarId
      || (
        authority.structureOwnerAvatarId !== null
        && authority.structureOwnerAvatarId !== avatarId
      )
    ) {
      return c.json({ error: 'not_structure_owner' }, 403);
    }
    if (
      authority.structureOwnerAvatarId === null
      || authority.structureStatus !== 'active'
    ) {
      return c.json({ error: 'structure_required' }, 404);
    }

    const rows = await db
      .select({
        id: landStructurePieces.id,
        parcelId: landStructurePieces.parcelId,
        pieceKey: landStructurePieces.pieceKey,
        gridX: landStructurePieces.gridX,
        gridY: landStructurePieces.gridY,
        rotationStep: landStructurePieces.rotationStep,
        stackLevel: landStructurePieces.stackLevel,
      })
      .from(landStructurePieces)
      .where(eq(landStructurePieces.parcelId, parcelId))
      .orderBy(
        landStructurePieces.gridX,
        landStructurePieces.gridY,
        landStructurePieces.stackLevel,
      );

    return c.json({ pieces: rows.map(toLandStructurePieceDTO) });
  },
);

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

// ─── 4. POST /claim-starter  (RETIRED, stable pre-auth refusal) ─────────────

landRoutes.post('/claim-starter', (c) => c.json({ error: 'tenure_model_active' }, 409));

// Unreachable review reference: P2 registers no legacy deposit-creation path.
if (false) {
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
  bustPublicPiecesCache();

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
}
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
      upgradeCosts: STRUCTURE_UPGRADE_COSTS_BY_TYPE.shop,
      upgradeCostsByType: STRUCTURE_UPGRADE_COSTS_BY_TYPE,
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
  return c.json({
    tiers,
    upgradeCosts: STRUCTURE_UPGRADE_COSTS_BY_TYPE.shop,
    upgradeCostsByType: STRUCTURE_UPGRADE_COSTS_BY_TYPE,
  });
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
landRoutes.get('/hold-wallet', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, noStorePrivate, async (c) => {
  const identity = c.get('identity');
  if (!holdWalletReadLimiter.check(identity.userId)) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  // One read returns the declaration AND its server-derived verification state
  // (`verified` iff the proven pubkey IS the declared pubkey; else
  // `grandfathered` iff the one-shot migration stamp is; else `unverified`).
  // The route never derives the state itself, so this display can never disagree
  // with the claim-hold gate.
  const declaration = await readHoldWalletDeclaration(identity.userId);
  if (!declaration) return c.json({ error: 'identity_binding_changed' }, 403);
  const balance = declaration.walletAddress
    ? await getWalletClvBalance(declaration.walletAddress)
    : null;
  // Door 2 has no enable flag (CLAUDE.md forbids dark flags in prod):
  // availability derives from whether the verify wallet is provisioned.
  const transferDoor = await getTransferDoorAvailability().catch(() => ({
    available: false,
    destination: null,
  }));
  return c.json({
    walletAddress: declaration.walletAddress,
    declaredAt: declaration.declaredAt?.toISOString() ?? null,
    balance,
    verification: {
      state: declaration.state,
      method: declaration.method,
      verifiedAt: declaration.verifiedAt,
      transferDoorAvailable: transferDoor.available === true,
    },
  });
});

// ─── 7b-ii. Hold-wallet OWNERSHIP PROOF (founder ruling 2026-08-10) ──────────
//
// "Optional proof is just not proof." A declaration is a CLAIM; without proof of
// control an account could claim hold-door land backed by SOMEONE ELSE'S CLV
// balance. Proof is REQUIRED before the hold door opens, with two doors so a
// user who will not connect a browser wallet is not locked out:
//
//   DOOR 1 (free, instant, primary) — sign a server nonce with the declared
//     wallet's key. Works for a human wallet UI and, identically, for a BYO
//     agent that holds its own key: the agent GETs a challenge and POSTs the
//     signature over REST (E5 parity — no browser required).
//   DOOR 2 (fallback) — send an exact unique dust amount of SOL from the
//     declared wallet to a ClawVille verify address; attributed by exact amount
//     + sender, granted on FINALIZED, then AUTO-REFUNDED. Implemented by
//     `land-hold-transfer-verify.ts`; these handlers are thin.
//   CUSTODIAL (auto) — an agent (or human) whose declared wallet IS the
//     custodial wallet of its bound avatar is attested server-side, because we
//     hold that key.
//
// Every route runs the SAME middleware chain as the declaration routes above
// (`requireAuthOrAgentSession, requireLedgerCapableIdentity,
// requireNonGuestIdentity`): a guest is 403'd, never silently demoted, and a
// connected agent verifies AS ITSELF.

landRoutes.post(
  '/hold-wallet/verify/challenge',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    if (!holdWalletVerifyLimiter.check(identity.userId)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    if (!emptyStrictBodySchema.safeParse(rawBody ?? {}).success) {
      return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
    }
    const declaration = await readHoldWalletDeclaration(identity.userId);
    if (!declaration) return c.json({ error: 'identity_binding_changed' }, 403);
    if (!declaration.walletAddress) {
      return c.json({ error: 'wallet_not_declared', code: 'wallet_not_declared' }, 403);
    }
    // Bound to BOTH the account and the currently declared wallet, so a nonce
    // cannot be spent after a repoint and cannot be replayed by another account.
    return c.json(
      issueLandHoldWalletChallenge(identity.userId, declaration.walletAddress),
    );
  },
);

landRoutes.post(
  '/hold-wallet/verify/signature',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    if (!holdWalletVerifyLimiter.check(identity.userId)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = holdWalletVerifySignatureBodySchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);

    const declaration = await readHoldWalletDeclaration(identity.userId);
    if (!declaration) return c.json({ error: 'identity_binding_changed' }, 403);
    const declaredWallet = declaration.walletAddress;
    if (!declaredWallet) {
      return c.json({ error: 'wallet_not_declared', code: 'wallet_not_declared' }, 403);
    }

    // 1) Consume the nonce for THIS (user, declared wallet). Single-use +
    //    cross-account + repoint replay guard. Generic 401 so a caller cannot
    //    distinguish missing / expired / wrong-user / wrong-wallet.
    if (!consumeLandHoldWalletChallenge(parsed.data.nonce, identity.userId, declaredWallet)) {
      return c.json(
        { error: 'invalid_or_expired_challenge', code: 'invalid_challenge' },
        401,
      );
    }

    // 2) Verify the ed25519 signature of the ACCOUNT+WALLET-bound human-readable
    //    message, reconstructed SERVER-SIDE. `nacl.sign.detached.verify` returns
    //    false on malformed input, so we bs58-decode and length-check first and a
    //    garbage input is a clean 400 rather than a confusing 500.
    let sigBytes: Uint8Array;
    let pubBytes: Uint8Array;
    try {
      sigBytes = bs58.decode(parsed.data.signature);
      pubBytes = bs58.decode(declaredWallet);
    } catch {
      return c.json({ error: 'invalid_signature', code: 'invalid_signature' }, 400);
    }
    if (pubBytes.length !== 32) {
      return c.json({ error: 'invalid_wallet_pubkey', code: 'invalid_wallet_pubkey' }, 400);
    }
    if (sigBytes.length !== 64) {
      return c.json({ error: 'invalid_signature', code: 'invalid_signature' }, 400);
    }
    const messageBytes = new TextEncoder().encode(
      buildLandHoldWalletMessage(identity.userId, declaredWallet, parsed.data.nonce),
    );
    if (!nacl.sign.detached.verify(messageBytes, sigBytes, pubBytes)) {
      return c.json(
        { error: 'signature_verification_failed', code: 'signature_verification_failed' },
        401,
      );
    }

    // 3) Persist under the per-user advisory lock, re-checking the declaration
    //    so a repoint racing the proof cannot inherit it.
    try {
      const granted = await grantLandHoldWalletVerification({
        userId: identity.userId,
        expectedWallet: declaredWallet,
        method: 'signature',
      });
      return c.json({
        ok: true,
        state: granted.state,
        method: granted.method,
        verifiedAt: granted.verifiedAt,
        walletAddress: granted.walletAddress,
      });
    } catch (err) {
      return verifyError(c, err);
    }
  },
);

landRoutes.post(
  '/hold-wallet/verify/custodial',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    if (!holdWalletVerifyLimiter.check(identity.userId)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    if (!emptyStrictBodySchema.safeParse(rawBody ?? {}).success) {
      return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
    }
    // The custodial pubkey is re-read from `avatars` INSIDE the attest
    // transaction — never cached, never client-supplied.
    try {
      const granted = await attestCustodialLandHoldWallet({ identity });
      return c.json({
        ok: true,
        state: granted.state,
        method: granted.method,
        verifiedAt: granted.verifiedAt,
        walletAddress: granted.walletAddress,
      });
    } catch (err) {
      return verifyError(c, err);
    }
  },
);

landRoutes.post(
  '/hold-wallet/verify/transfer/challenge',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    if (!holdWalletVerifyLimiter.check(identity.userId)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    if (!emptyStrictBodySchema.safeParse(rawBody ?? {}).success) {
      return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
    }
    const declaration = await readHoldWalletDeclaration(identity.userId);
    if (!declaration) return c.json({ error: 'identity_binding_changed' }, 403);
    if (!declaration.walletAddress) {
      return c.json({ error: 'wallet_not_declared', code: 'wallet_not_declared' }, 403);
    }
    try {
      const opened = await openTransferChallenge({
        userId: identity.userId,
        declaredWallet: declaration.walletAddress,
      });
      return c.json(opened);
    } catch (err) {
      return verifyError(c, err);
    }
  },
);

// FALLBACK door-2 path for scan eclipse or bounded misses. The service fetches
// this exact finalized transaction and routes it through the same attribution
// predicates as the poll-primary GET path.
landRoutes.post(
  '/hold-wallet/verify/transfer/:challengeId/submit',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    if (!holdWalletVerifyLimiter.check(identity.userId)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }
    const idParsed = challengeIdSchema.safeParse(c.req.param('challengeId'));
    if (!idParsed.success) {
      return c.json({ error: 'invalid_challenge_id', code: 'invalid_challenge_id' }, 400);
    }
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = holdWalletSubmitTransferBodySchema.safeParse(rawBody);
    if (!parsed.success) return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400);
    try {
      // The service scopes the challenge to THIS identity and 404s otherwise, so
      // a challenge id cannot be used to settle another account's row.
      const status = await submitTransferSignature({
        userId: identity.userId,
        challengeId: idParsed.data,
        signature: parsed.data.signature,
      });
      return c.json(status);
    } catch (err) {
      return verifyError(c, err);
    }
  },
);

landRoutes.get(
  '/hold-wallet/verify/transfer/:challengeId',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  noStorePrivate,
  async (c) => {
    const identity = c.get('identity');
    if (!holdWalletReadLimiter.check(identity.userId)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
    }
    const idParsed = challengeIdSchema.safeParse(c.req.param('challengeId'));
    if (!idParsed.success) {
      return c.json({ error: 'invalid_challenge_id', code: 'invalid_challenge_id' }, 400);
    }
    try {
      // The service scopes the lookup to THIS user and 404s otherwise, so a
      // challenge id cannot be used to read another account's state.
      const status = await pollTransferChallenge({
        userId: identity.userId,
        challengeId: idParsed.data,
      });
      return c.json(status);
    } catch (err) {
      return verifyError(c, err);
    }
  },
);

landRoutes.post('/hold-wallet', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = declareHoldWalletBodySchema.safeParse(rawBody);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  let canonical: string;
  try {
    canonical = new PublicKey(parsed.data.walletAddress).toBase58();
    if (canonical !== parsed.data.walletAddress) throw new Error('non-canonical');
  } catch {
    return c.json({ error: 'invalid_wallet_address' }, 400);
  }
  try {
    await declareLandHoldWallet(identity, canonical);
  } catch (err) {
    return settlementError(c, err);
  }
  return c.json({ walletAddress: canonical });
});

landRoutes.post('/parcels/:parcelId/claim-hold', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) return c.json({ error: 'invalid_parcel_id' }, 400);
  const rawBody: unknown = await c.req.json().catch(() => null);
  const body = holdClaimBodySchema.safeParse(rawBody);
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const parcelCode = await parcelCodeForId(idParsed.data);
  if (!parcelCode) return c.json({ error: 'parcel_not_found' }, 404);
  try {
    const claimed = await settleTenureClaim({
      ...settlementInput(identity, parcelCode, body.data.idempotencyKey),
      door: 'hold',
    });
    if (claimed.fresh) {
      bustOwnedCache(identity.avatarId);
      bustParcelsAvailableCache(claimed.parcel.tier);
      bustPublicStructuresCache();
      bustPublicPiecesCache();
      void logEventFromContext(c, {
        eventType: LAND_EVENT_TYPES.PARCEL_PURCHASED,
        userId: identity.userId,
        avatarId: identity.avatarId,
        agentId: identity.kind === 'agent' ? identity.agentId : null,
        payload: { parcelCode, tier: claimed.parcel.tier, amountCt: 0, tenure: 'hold' },
      });
      broadcastLandEvent({ parcelCode, status: 'owned', ownerAvatarId: identity.avatarId });
    }
    return c.json({
      parcel: claimed.parcel,
      requiredClv: claimed.requiredClv,
      heldClv: claimed.heldClv,
      idempotencyReplay: !claimed.fresh || undefined,
    });
  } catch (err) {
    return settlementError(c, err);
  }
});

if (false) {
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
  bustPublicPiecesCache();
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
}

landRoutes.post('/parcels/:parcelId/claim-rent', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) return c.json({ error: 'invalid_parcel_id' }, 400);
  const rawBody: unknown = await c.req.json().catch(() => null);
  const body = rentClaimBodySchema.safeParse(rawBody);
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const parcelCode = await parcelCodeForId(idParsed.data);
  if (!parcelCode) return c.json({ error: 'parcel_not_found' }, 404);
  try {
    const claimed = await settleTenureClaim({
      ...settlementInput(identity, parcelCode, body.data.idempotencyKey),
      door: 'rent',
      weeks: body.data.weeks,
    });
    if (claimed.fresh) {
      bustOwnedCache(identity.avatarId);
      bustParcelsAvailableCache(claimed.parcel.tier);
      bustPublicStructuresCache();
      bustPublicPiecesCache();
      void logEventFromContext(c, {
        eventType: LAND_EVENT_TYPES.PARCEL_PURCHASED,
        userId: identity.userId,
        avatarId: identity.avatarId,
        agentId: identity.kind === 'agent' ? identity.agentId : null,
        payload: {
          parcelCode,
          tier: claimed.parcel.tier,
          amountCt: (claimed.weeklyCt ?? 0) * (claimed.weeks ?? 0),
          tenure: 'deposit',
        },
      });
      broadcastLandEvent({ parcelCode, status: 'owned', ownerAvatarId: identity.avatarId });
    }
    return c.json({
      parcel: claimed.parcel,
      weeks: claimed.weeks,
      weeklyCt: claimed.weeklyCt,
      idempotencyReplay: !claimed.fresh || undefined,
    });
  } catch (err) {
    return settlementError(c, err);
  }
});

landRoutes.post('/parcels/:parcelId/deposit-topup', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) return c.json({ error: 'invalid_parcel_id' }, 400);
  const rawBody: unknown = await c.req.json().catch(() => null);
  const body = depositTopupBodySchema.safeParse(rawBody);
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const parcelCode = await parcelCodeForId(idParsed.data);
  if (!parcelCode) return c.json({ error: 'parcel_not_found' }, 404);
  try {
    const topped = await settleRentPrepay({
      ...settlementInput(identity, parcelCode, body.data.idempotencyKey),
      ...('weeks' in body.data
        ? { weeks: body.data.weeks }
        : { amountCt: body.data.amountCt }),
    });
    if (topped.fresh) bustOwnedCache(identity.avatarId);
    return c.json({
      parcelCode: topped.parcelCode,
      depositRemainingCt: topped.depositRemainingCt,
      amountCt: topped.amountCt,
      graceCleared: topped.graceCleared,
      idempotencyReplay: !topped.fresh || undefined,
    });
  } catch (err) {
    return settlementError(c, err);
  }
});

if (false) {
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
  if (!('amountCt' in bodyParsed.data)) {
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
}

landRoutes.post('/parcels/:parcelId/release', requireAuthOrAgentSession, requireLedgerCapableIdentity, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
  if (!idParsed.success) return c.json({ error: 'invalid_parcel_id' }, 400);
  const rawBody: unknown = await c.req.json().catch(() => null);
  const body = releaseBodySchema.safeParse(rawBody);
  if (!body.success) return c.json({ error: 'invalid_body' }, 400);
  const parcelCode = await parcelCodeForId(idParsed.data);
  if (!parcelCode) return c.json({ error: 'parcel_not_found' }, 404);
  try {
    const released = await settleTenureRelease(
      settlementInput(identity, parcelCode, body.data.idempotencyKey),
    );
    if (released.fresh) {
      bustOwnedCache(identity.avatarId);
      bustParcelsAvailableCache(released.parcel.tier);
      bustPublicStructuresCache();
      bustPublicPiecesCache();
      broadcastLandEvent({ parcelCode, status: 'available', ownerAvatarId: null });
    }
    return c.json({
      released: true,
      refundedCt: released.refundedCt,
      parcel: released.parcel,
      idempotencyReplay: !released.fresh || undefined,
    });
  } catch (err) {
    return settlementError(c, err);
  }
});

if (false) {
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
  bustPublicPiecesCache();
  bustParcelsAvailableCache(released.parcel.tier);
  broadcastLandEvent({
    parcelCode: released.parcel.parcelCode,
    status: 'available',
    ownerAvatarId: null,
  });

  return c.json({ released: true, refundedCt: released.refundedCt, parcel: released.parcel });
});

// ─── 8. POST /parcels/:parcelId/structure  (AUTH, PARITY-BOUND, free Lv1) ────

}

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
  bustPublicPiecesCache();

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

// P3 stage A: paid kit-piece placement. Moving and removal are free below.
landRoutes.post(
  '/parcels/:parcelId/pieces',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const identity = c.get('identity');
    const avatarId = identity.avatarId;
    const idParsed = parcelIdSchema.safeParse(c.req.param('parcelId'));
    if (!idParsed.success) return c.json({ error: 'invalid_parcel_id' }, 400);
    const parcelId = idParsed.data;

    const PARSE_FAILED = Symbol('parse_failed');
    const rawBody: unknown = await c.req.json().catch(() => PARSE_FAILED);
    if (rawBody === PARSE_FAILED) return c.json({ error: 'invalid_body' }, 400);
    const bodyParsed = createKitPieceBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) {
      const missingKey = bodyParsed.error.issues.some(
        (issue) => issue.path.length === 1 && issue.path[0] === 'idempotencyKey',
      );
      return c.json({ error: missingKey ? 'idempotency_key_required' : 'invalid_body' }, 400);
    }
    const body = bodyParsed.data;

    let result: KitPlacementSettlementResult;

    try {
      // The transaction body — advisory lock, FOR UPDATE reads, authority,
      // idempotent replay, geometry gate, rail gate, debit/credit, insert,
      // audit row — lives in `settleKitPlacement` (land-kit-settlement.ts),
      // shared with the hosted `place_kit_piece` executor. This route owns
      // parsing and HTTP mapping only.
      result = await settleKitPlacement({
        identity,
        parcelId,
        ...body,
      });
    } catch (err) {
      const pgError = err as {
        code?: string;
        constraint_name?: string;
        constraint?: string;
      } | undefined;
      const constraint = pgError?.constraint_name ?? pgError?.constraint;
      if (pgError?.code === '23505' && constraint === 'land_tx_kit_piece_idem_unique') {
        return c.json({ error: 'idempotency_key_conflict' }, 409);
      }
      if (pgError?.code === '23505' && constraint === 'land_structure_pieces_cell_stack_unique') {
        return c.json({ error: 'cell_occupied' }, 409);
      }
      if (err instanceof InsufficientTokensError) {
        return c.json({ error: 'insufficient_clawtokens' }, 400);
      }
      if (err instanceof InsufficientMaterialsError) {
        return c.json({ error: 'insufficient_materials' }, 400);
      }
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409 | 503);
      }
      throw err;
    }

    // `costCt` stays in the response on BOTH rails so no existing reader
    // breaks; it is simply 0 when materials paid. `paymentRail` is what a
    // client should branch on.
    const costs = {
      costCt: result.costCt,
      costMaterials: result.costMaterials,
      paymentRail: result.paymentRail,
    };
    if (result.kind === 'replay') {
      return c.json({ piece: result.piece, ...costs, idempotencyReplay: true });
    }
    bustPublicPiecesCache();
    return c.json({ piece: result.piece, ...costs });
  },
);

landRoutes.patch(
  '/pieces/:pieceId',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const avatarId = c.get('identity').avatarId;
    const idParsed = pieceIdSchema.safeParse(c.req.param('pieceId'));
    if (!idParsed.success) return c.json({ error: 'invalid_piece_id' }, 400);
    const pieceId = idParsed.data;
    const rawBody = await c.req.json().catch(() => ({}));
    const bodyParsed = moveKitPieceBodySchema.safeParse(rawBody);
    if (!bodyParsed.success) return c.json({ error: 'invalid_body' }, 400);
    const body = bodyParsed.data;

    let piece: LandStructurePieceDTO;
    try {
      piece = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);
        const pieceRows = await tx.execute<{
          id: string;
          parcel_id: string;
          owner_avatar_id: string;
          parcel_owner_avatar_id: string | null;
          piece_key: string;
          parcel_tier: LandTier;
        }>(
          sql`SELECT kp.id, kp.parcel_id, kp.owner_avatar_id,
                     p.owner_avatar_id AS parcel_owner_avatar_id, kp.piece_key,
                     p.tier AS parcel_tier
              FROM land_structure_pieces kp
              JOIN land_parcels p ON p.id = kp.parcel_id
              WHERE kp.id = ${pieceId}
              FOR UPDATE OF kp, p`,
        );
        const current = pieceRows[0];
        if (!current) throw new HTTPException(404, { message: 'piece_not_found' });

        const structureRows = await tx.execute<{
          owner_avatar_id: string;
          status: 'active' | 'archived';
          level: number | string;
        }>(
          sql`SELECT owner_avatar_id, status, level FROM land_structures
              WHERE parcel_id = ${current.parcel_id} FOR UPDATE`,
        );
        const structure = structureRows[0] ?? null;
        const authorityError = validateKitAuthority(
          {
            parcelOwnerAvatarId: current.parcel_owner_avatar_id,
            pieceOwnerAvatarId: current.owner_avatar_id,
            structureOwnerAvatarId: structure?.owner_avatar_id ?? null,
            structureStatus: structure?.status ?? null,
          },
          avatarId,
          true,
        );
        if (authorityError) throwKitAuthorityError(authorityError);

        if (!isKitPieceKey(current.piece_key)) {
          throw new HTTPException(409, { message: 'piece_catalog_drift' });
        }
        const moveLevel = Number(structure!.level);
        if (!Number.isInteger(moveLevel) || moveLevel < 1 || moveLevel > 5) {
          throw new HTTPException(400, { message: 'structure_level_invalid' });
        }

        // The move is re-validated against the CURRENT predicate — this is the
        // Q5 escape hatch: a grandfathered piece the stricter rule now refuses
        // is never deleted, and its owner moves it to a legal position for free.
        // The piece is excluded from its own occupancy set and piece counts, so
        // a move on a full yard is cap-neutral and never self-collides.
        const verdict = await evaluateKitWrite(tx, {
          parcelId: current.parcel_id,
          parcelTier: current.parcel_tier,
          structureLevel: moveLevel,
          request: {
            pieceKey: current.piece_key,
            gridX: body.gridX,
            gridY: body.gridY,
            rotationStep: body.rotationStep,
            stackLevel: body.stackLevel,
          },
          excludePieceRef: pieceId,
        });
        if (!verdict.ok) {
          throw new HTTPException(kitPlacementRefusalStatus(verdict.code), {
            message: verdict.code,
          });
        }

        const updated = await tx
          .update(landStructurePieces)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(landStructurePieces.id, pieceId))
          .returning({
            id: landStructurePieces.id,
            parcelId: landStructurePieces.parcelId,
            pieceKey: landStructurePieces.pieceKey,
            gridX: landStructurePieces.gridX,
            gridY: landStructurePieces.gridY,
            rotationStep: landStructurePieces.rotationStep,
            stackLevel: landStructurePieces.stackLevel,
          });
        return toLandStructurePieceDTO(updated[0]!);
      });
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === '23505') {
        return c.json({ error: 'cell_occupied' }, 409);
      }
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409);
      }
      throw err;
    }

    // D5: moving a placed piece is free. Deliberate bounded cost: every PATCH
    // invalidates the shared public feed; no per-route limiter is added this round.
    bustPublicPiecesCache();
    return c.json({ piece });
  },
);

landRoutes.delete(
  '/pieces/:pieceId',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const avatarId = c.get('identity').avatarId;
    const idParsed = pieceIdSchema.safeParse(c.req.param('pieceId'));
    if (!idParsed.success) return c.json({ error: 'invalid_piece_id' }, 400);
    const pieceId = idParsed.data;

    let piece: LandStructurePieceDTO;
    try {
      piece = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);
        const rows = await tx.execute<{
          id: string;
          parcel_id: string;
          owner_avatar_id: string;
          parcel_owner_avatar_id: string | null;
          piece_key: string;
          grid_x: number | string;
          grid_y: number | string;
          rotation_step: number | string;
          stack_level: number | string;
        }>(
          sql`SELECT kp.id, kp.parcel_id, kp.owner_avatar_id,
                     p.owner_avatar_id AS parcel_owner_avatar_id, kp.piece_key,
                     kp.grid_x, kp.grid_y, kp.rotation_step, kp.stack_level
              FROM land_structure_pieces kp
              JOIN land_parcels p ON p.id = kp.parcel_id
              WHERE kp.id = ${pieceId}
              FOR UPDATE OF kp, p`,
        );
        const current = rows[0];
        if (!current) throw new HTTPException(404, { message: 'piece_not_found' });
        const authorityError = validateKitAuthority(
          {
            parcelOwnerAvatarId: current.parcel_owner_avatar_id,
            pieceOwnerAvatarId: current.owner_avatar_id,
          },
          avatarId,
          false,
        );
        if (authorityError) throwKitAuthorityError(authorityError);

        await tx.delete(landStructurePieces).where(eq(landStructurePieces.id, pieceId));
        return toLandStructurePieceDTO({
          id: current.id,
          parcelId: current.parcel_id,
          pieceKey: current.piece_key,
          gridX: Number(current.grid_x),
          gridY: Number(current.grid_y),
          rotationStep: Number(current.rotation_step),
          stackLevel: Number(current.stack_level),
        });
      });
    } catch (err) {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status as 403 | 404 | 409);
      }
      throw err;
    }

    // D5: removal is free and intentionally performs no refund ledger write.
    bustPublicPiecesCache();
    return c.json({ deleted: true, piece });
  },
);

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
    bustPublicPiecesCache();
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
            // Type-keyed like the live charge, so a replay reports the exact
            // price that was actually paid (0 for a free home Lv2).
            costCt: structureUpgradeCostCt(s.structure_type, toLevel),
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

      const cost = structureUpgradeCostCt(s.structure_type, target);
      // A HOME reaching Lv2 is deliberately FREE (founder ruling Q3), so cost 0
      // is now a real, expected value rather than only a defensive guard: the
      // whole debit + treasury credit is skipped and no money moves. The
      // level write, the `land_upgrades` audit row, and the idempotency key all
      // still apply, so a free upgrade is replay-safe like a paid one.
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
              costCt: structureUpgradeCostCt(cached.structureType, winner.toLevel),
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
  bustPublicPiecesCache();

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
        // `slot_paid_through` is CARRIED FORWARD from this shop's listing
        // history, and the free first week is granted ONCE PER STRUCTURE, ever.
        //
        // The naive version (an unconditional `now() + 7 days` on every new
        // listing) was a permanent bypass of the entire P5a sink: delist on day
        // six, recreate with the same title, get a fresh free week, repeat.
        // A delisted row is invisible to the sweeper and does not count against
        // the per-structure active cap, so the recycle was unbounded and the
        // shop paid nothing, forever.
        //
        // The subquery spans ALL listings on the structure regardless of status
        // (nothing hard-deletes a listing row — delist is a status change), so:
        //   - no prior listing on this shop  -> the genuine free week,
        //   - prior listing paid into the future -> that cursor is inherited,
        //     so a recreated listing is due on the ORIGINAL schedule,
        //   - prior listing already lapsed  -> floored at now(), i.e. due on the
        //     very next sweep.
        // `GREATEST` is written around an explicit COUNT branch because
        // `GREATEST(now(), NULL)` returns now() in Postgres, which would have
        // silently swallowed the no-history case and denied every shop its
        // first free week.
        sql`INSERT INTO service_listings
              (structure_id, owner_avatar_id, kind, title, description, price_ct, status,
               slot_paid_through)
            VALUES (${structureId}, ${avatarId}, 'peer', ${title}, ${description ?? null}, ${priceCt}, 'active',
                    ${slotPaidThroughOnCreateSql(structureId)})
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
          // A brand-new listing is never featured and never suspended.
          featured: false,
          suspended: false,
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
    .where(
      and(
        eq(serviceListings.structureId, structureId),
        eq(serviceListings.status, 'active'),
        // A slot-rent-suspended listing stays in the table but leaves the
        // storefront until its owner funds the next week.
        isNull(serviceListings.slotSuspendedAt),
      ),
    );

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
    .where(and(eq(serviceListings.status, 'active'), isNull(serviceListings.slotSuspendedAt)))
    // Order on LIVE-featured state, and COALESCE the three-valued result.
    //
    // Two separate NULL traps here, both verified against Postgres:
    //   1. `desc(col)` emits a bare `col desc` and DESC defaults to NULLS
    //      FIRST, so ordering on the raw cursor sorted every NON-featured
    //      listing above every featured one.
    //   2. `featured AND cursor > now()` is THREE-VALUED: a featured row whose
    //      cursor is still NULL (featured just switched on, or its charge keeps
    //      failing) evaluates to NULL, not false — and NULL sorts FIRST under
    //      DESC. So an UNPAID featured-pending row would pin above a genuinely
    //      paid one, permanently, for as long as it kept failing to pay.
    // COALESCE(..., false) collapses pending and lapsed into the same bucket as
    // not-featured, so only a row that has actually PAID ranks first.
    .orderBy(
      sql`COALESCE(${serviceListings.featured} AND ${serviceListings.featuredPaidThrough} > now(), false) DESC`,
      desc(serviceListings.createdAt),
    )
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
//   409 → { error: 'listing_not_active' | 'listing_suspended' | 'not_a_peer_listing' | 'structure_unavailable'
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
        slot_suspended_at: string | Date | null;
      }>(
        sql`SELECT id, structure_id, owner_avatar_id, kind, title, price_ct, status,
                   slot_suspended_at
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
      // Slot rent lapsed (land gamification P5a). The listing is SUSPENDED, not
      // deleted: the row, title, and price are intact and the next successful
      // sweep restores it, but it cannot be bought meanwhile.
      if (listing.slot_suspended_at !== null) {
        throw new HTTPException(409, { message: 'listing_suspended' });
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
