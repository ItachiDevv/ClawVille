/**
 * types.ts — shared DTO + response types for the Land Office UI.
 *
 * Mirrors the FROZEN backend contract (apps/api/src/routes/land.ts), already
 * live on staging. The Land panel components + the api.ts client methods both
 * import from here so the wire shape is defined exactly once on the web side.
 */
import type { KitPieceKey, LandTier } from '@clawville/shared';

/** Parcel lifecycle status as returned by the API. */
export type LandParcelStatus = 'available' | 'owned' | 'reserved' | 'retired';

/**
 * How a parcel is held; null on an available/unsold parcel. Phase B
 * (2026-07-07): 'deposit' = starter deposit-escrow, 'hold' = CLV hold-to-keep
 * (c/b/a/founder); 'owned'/'starter' are legacy grandfathered tenures.
 */
export type LandTenure = 'rented' | 'owned' | 'starter' | 'deposit' | 'hold';

/** A single land parcel row. `priceCt` is null for the founder tier (auction-only). */
export interface LandParcelDTO {
  id: string;
  parcelCode: string;
  /** Deterministic human label; parcelCode remains the wire/render key. */
  displayName: string;
  tier: LandTier;
  status: LandParcelStatus;
  gridX: number;
  gridY: number;
  priceCt: number | null;
  ownerAvatarId: string | null;
  /**
   * Weekly rent in CT, or null when the tier is not rentable. Rentable = c-tier
   * only; starter/founder carry null. The Land Office gates its Rent action on
   * `rentCtWeekly != null`.
   */
  rentCtWeekly: number | null;
  /** Server quote for a fresh rent-door claim; null when that door is unavailable. */
  claimRentCtWeekly: number | null;
  /** How the parcel is held; null = available/unsold. */
  tenure: LandTenure | null;
  /**
   * B1 (deposit tenure): live escrow remainder in CT — the refundable balance
   * the weekly sweeper draws from. Null on non-deposit rows.
   */
  depositRemainingCt: number | null;
  /**
   * B2 (hold tenure): the CLV hold threshold (CLV uiAmount) STAMPED at claim
   * time. Null on non-hold rows — including AVAILABLE hold-tier parcels (the
   * threshold is stamped only AT claim), so for-sale display/stacking math must
   * DERIVE the threshold from the tier via `holdThresholdForTier(tier)` and use
   * this field only for owned parcels.
   */
  holdThresholdCt: number | null;
  rentPaidThrough?: string | null;
  graceUntil?: string | null;
  /** Last authoritative tenure-row update/check exposed to the owner UI. */
  tenureLastCheckedAt?: string | null;
}

/** A structure (home or shop) placed on an owned parcel. */
export interface LandStructureDTO {
  id: string;
  parcelId: string;
  ownerAvatarId: string;
  structureType: 'home' | 'shop';
  catalogKey: string;
  level: number;
  shellKey: string;
  paletteKey: string;
}

/** Public world-render feed row; owner identity and DB ids are intentionally omitted. */
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

export interface UpdateStructureAppearanceRequest {
  shellKey?: string;
  paletteKey?: string;
}

export interface UpdateStructureAppearanceResponse {
  structure: LandStructureDTO;
}

/** Catalog SKU entry (key + display label) for a tier. */
export interface CatalogSku {
  key: string;
  label: string;
}

/** Single-tier catalog response (GET /api/land/catalog?tier=…). */
export interface LandCatalogTierResponse {
  tier: LandTier;
  maxLevel: number;
  premium: boolean;
  homeSkus: CatalogSku[];
  shopSkus: CatalogSku[];
  upgradeCosts: number[];
}

/** All-tiers catalog response (GET /api/land/catalog, no tier). */
export interface LandCatalogAllResponse {
  tiers: Record<LandTier, Omit<LandCatalogTierResponse, 'tier'>>;
  upgradeCosts: number[];
}

/** GET /api/land/owned/:avatarId and GET /api/land/me payloads. */
export interface OwnedLandResponse {
  parcels: LandParcelDTO[];
  structures: LandStructureDTO[];
}

/** GET /api/land/me adds the resolved avatarId. */
export interface MyLandResponse extends OwnedLandResponse {
  avatarId: string;
}

/** Private owner mutation shape for stage-A kit routes 12-14. */
export interface LandStructurePieceDTO {
  id: string;
  parcelId: string;
  pieceKey: KitPieceKey;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}

export interface OwnerLandPiecesResponse {
  pieces: LandStructurePieceDTO[];
}

export interface PlaceLandPieceRequest {
  pieceKey: KitPieceKey;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
  idempotencyKey: string;
  /**
   * OMITTED for the vCLAW rail — byte-identical to the request this route
   * has always accepted. Included ONLY when the player picked the materials
   * rail (HOME yards, P5b — gamification-pass-2026-08-09.md §2.9
   * KitMutationInput.op.paymentRail). CONFIRMED SERVED 2026-08-09: the
   * backend lane's `9824db4f` (`apps/api/src/routes/land.ts:647`) declares
   * `paymentRail: z.enum(KIT_PAYMENT_RAILS).default('vclaw')` on the
   * `/api/land/parcels/:parcelId/pieces` schema, so both omitting it and
   * sending 'materials' are accepted. `yard-editor-three.tsx` still catches
   * an unexpected 400 defensively and reverts the rail with a toast.
   */
  paymentRail?: 'materials';
}

export interface MoveLandPieceRequest {
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}

export interface PlaceLandPieceResponse {
  piece: LandStructurePieceDTO;
  costCt: number;
  idempotencyReplay?: boolean;
}

export interface MoveLandPieceResponse {
  piece: LandStructurePieceDTO;
}

export interface DeleteLandPieceResponse {
  deleted: true;
  piece: LandStructurePieceDTO;
}

/**
 * POST /api/land/parcels/:id/claim-hold response (Phase B2 hold-to-keep).
 * `requiredClv` = the server-computed STACKED requirement (Σ existing
 * non-grandfathered hold thresholds + this tier's threshold); `heldClv` = the
 * live CLV uiAmount the server verified. NOTE: on the 403 `insufficient_clv_hold`
 * error path these numbers are DROPPED by honoRequest (only `error`/`code`
 * survive into ApiError), so error UI must compute them client-side.
 */
export interface ClaimHoldResponse {
  parcel: LandParcelDTO;
  requiredClv: number;
  heldClv: number;
}

export interface ClaimRentResponse {
  parcel: LandParcelDTO;
  weeks: number;
  weeklyCt: number;
  idempotencyReplay?: boolean;
}

// ── Hold-wallet ownership proof (FROZEN contract §3) ───────────────────────
// Declaring a wallet you do not control used to let you claim hold-door land
// backed by SOMEONE ELSE'S CLV balance, so proof is now REQUIRED before the
// hold door opens. Two doors keep a user who will not connect a browser wallet
// from being locked out.

/**
 * Proof state of the DECLARED wallet. Derived server-side and PUBKEY-BOUND:
 * `verified` only while the stored verified pubkey still equals the declared
 * pubkey, so declare-A → verify-A → change-to-B can never inherit A's proof.
 * `grandfathered` = declared before the proof cutoff; those holds keep working
 * untouched and the UI only invites the user to verify.
 */
export type LandHoldWalletVerificationState = 'unverified' | 'verified' | 'grandfathered';

/** How the proof was obtained. `custodial` = ClawVille holds the key already. */
export type LandHoldWalletVerificationMethod = 'signature' | 'transfer' | 'custodial';

export interface LandHoldWalletVerification {
  state: LandHoldWalletVerificationState;
  method: LandHoldWalletVerificationMethod | null;
  verifiedAt: string | null;
  /** false when the verify wallet is unprovisioned, i.e. the transfer door is offline. */
  transferDoorAvailable: boolean;
}

export interface LandHoldWalletStatus {
  walletAddress: string | null;
  declaredAt: string | null;
  balance: {
    available: boolean;
    amountAtomic: string | null;
    decimals: number | null;
    uiAmount: number | null;
    cached: boolean;
    fetchedAt: string | null;
  } | null;
  /**
   * OPTIONAL on the CLIENT type on purpose. web and api deploy as separate
   * Coolify apps, so a web bundle can briefly talk to an api that predates the
   * verification block. A missing block renders exactly like the pre-proof UI
   * instead of crashing on `verification.state`.
   */
  verification?: LandHoldWalletVerification;
}

/** POST /api/land/hold-wallet/verify/challenge — door 1 (sign a nonce). */
export interface LandHoldWalletVerifyChallenge {
  nonce: string;
  expiresAt: string;
  /**
   * Sign this EXACT string. Account-bound AND wallet-bound, so a signature can
   * never be replayed against a different account or a different declaration.
   */
  messageToSign: string;
  walletAddress: string;
}

/** Success body of POST /verify/signature and POST /verify/custodial. */
export interface LandHoldWalletVerifyResult {
  ok: true;
  state: 'verified';
  method: LandHoldWalletVerificationMethod;
  verifiedAt: string;
  /** Echo of the wallet the server proved, re-read inside the grant tx. */
  walletAddress?: string;
}

/** POST /api/land/hold-wallet/verify/transfer/challenge — door 2 (exact dust). */
export interface LandHoldTransferChallenge {
  challengeId: string;
  destination: string;
  /** EXACT lamports to send. Attribution is by exact amount, so this is literal. */
  lamports: number;
  amountSol: number;
  /**
   * The note the transfer MUST carry. The amount only matches the payment to
   * the check; the note is what says the sender meant it for THIS account, so a
   * transfer without it is refunded and never accepted. OPTIONAL on the client
   * type because web and api deploy separately.
   */
  memo?: string;
  expiresAt: string;
}

export type LandHoldTransferChallengeState =
  | 'pending'
  | 'observed'
  | 'verified'
  | 'expired'
  | 'failed'
  | 'rejected'
  /** Money arrived but was never submitted, so it is refunded and not verified. */
  | 'unclaimed';

/**
 * Why an exact-amount transfer arrived but could not prove ownership. Both the
 * payment and the note must be part of the transaction the wallet SIGNED: a
 * program acting on the user's behalf is not the user's own statement.
 */
export type LandHoldTransferRejectedReason =
  | 'memo_missing'
  | 'source_not_signer'
  | 'transfer_not_top_level';

export type LandHoldTransferRefundState = 'none' | 'sending' | 'sent' | 'reconcile' | 'skipped';

/**
 * GET /api/land/hold-wallet/verify/transfer/:challengeId.
 * `challengeId`/`destination`/`lamports` are OPTIONAL here: the frozen route
 * contract lists the five required fields, while the service-level status shape
 * also carries the echo fields. Optional keeps either shape type-safe, and the
 * UI already holds the destination/amount from the open call.
 */
export interface LandHoldTransferChallengeStatus {
  state: LandHoldTransferChallengeState;
  /** Set only when `state` is 'rejected'. */
  rejectedReason?: LandHoldTransferRejectedReason | null;
  refundState: LandHoldTransferRefundState | null;
  inboundSignature: string | null;
  refundSignature: string | null;
  expiresAt: string;
  challengeId?: string;
  destination?: string;
  lamports?: number;
  memo?: string;
}

/** Every machine-readable refusal the verification surface can return. */
export type LandHoldVerifyErrorCode =
  | 'wallet_not_verified'
  | 'wallet_not_declared'
  | 'invalid_challenge'
  | 'invalid_signature'
  | 'signature_verification_failed'
  | 'not_custodial_wallet'
  | 'transfer_door_unavailable'
  | 'verify_attempt_cap'
  | 'challenge_expired'
  | 'challenge_not_found';

export interface RentPrepayResponse {
  parcelCode: string;
  depositRemainingCt: number;
  amountCt: number;
  graceCleared: boolean;
  idempotencyReplay?: boolean;
}

export interface ReleaseParcelResponse {
  released: true;
  refundedCt: number;
  parcel: LandParcelDTO;
  idempotencyReplay?: boolean;
}

/** POST /api/land/parcels/:id/structure response. */
export interface PlaceStructureResponse {
  structure: LandStructureDTO;
}

/** POST /api/land/structures/:id/upgrade response. */
export interface UpgradeStructureResponse {
  structure: LandStructureDTO;
  costCt: number;
  idempotencyReplay?: boolean;
}

/** GET /api/land/parcels/:id/structure response. */
export interface ParcelStructureResponse {
  structure: LandStructureDTO | null;
}

/** Where a logged-in player's avatar spawns when entering the world. */
export type SpawnPreferenceMode = 'home' | 'town';

/**
 * POST /api/land/spawn-preference response (FROZEN contract).
 * `mode: 'home'` requires an owned `parcelId` (server 403 `code:'not_owned'`
 * otherwise); `mode: 'town'` clears the home spawn. The server echoes the
 * resolved preference + home parcel id so the client can update local state
 * without a refetch. `homeParcelId` is null when mode is 'town'.
 */
export interface SpawnPreferenceResponse {
  spawnPreference: SpawnPreferenceMode;
  homeParcelId: string | null;
}

// ── Service listings — run-a-store (P3 Slice 4) ────────────────────────────
// Mirrors the FROZEN backend contract (apps/api/src/routes/land.ts routes
// 12-16). A peer CT service listed on an owned/rented ACTIVE 'shop' structure;
// buying it settles full-price CT to the seller (no rake — v1 design).

/** A peer service listing (mirrors `service_listings`). */
export interface ServiceListingDTO {
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
export interface ServicePurchaseDTO {
  id: string;
  listingId: string;
  buyerAvatarId: string;
  sellerAvatarId: string;
  priceCt: number;
  landTransactionId: string | null;
  createdAt: string;
}

/** POST /api/land/structures/:structureId/services request body. */
export interface ListServiceRequest {
  title: string;
  description?: string;
  priceCt: number;
}

/** POST /api/land/structures/:structureId/services response. */
export interface ListServiceResponse {
  listing: ServiceListingDTO;
}

/** PATCH /api/land/services/:listingId request body — at least one field required. */
export interface UpdateServiceRequest {
  title?: string;
  description?: string;
  priceCt?: number;
  status?: 'active' | 'paused' | 'delisted';
}

/** PATCH /api/land/services/:listingId response. */
export interface UpdateServiceResponse {
  listing: ServiceListingDTO;
}

/** GET /api/land/structures/:structureId/services response (active listings only). */
export interface StructureServicesResponse {
  listings: ServiceListingDTO[];
}

/** GET /api/land/services?page=&limit= response (paged, active only, newest first). */
export interface BrowseServicesResponse {
  listings: ServiceListingDTO[];
  nextPage?: number;
}

/** POST /api/land/services/:listingId/buy response. `cached` = an idempotent replay (no new charge). */
export interface BuyServiceResponse {
  purchase: ServicePurchaseDTO;
  priceCt: number;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Seabed salvage (P7a/P7b — FROZEN, verified against the backend lane's
// shipped commits `7eec61cd`/`9824db4f` on `feat/land-salvage`, merged into
// this branch 2026-08-09: apps/api/src/routes/land-salvage.ts +
// apps/api/src/services/{salvage-settlement,salvage-approach}.ts. These
// shapes are copied from the real route handlers, not guessed.
// ---------------------------------------------------------------------------

/** One node's per-avatar claim state, as read from `GET /api/land/salvage/state`. */
export interface LandSalvageNodeStatus {
  nodeId: string;
  band: string;
  x: number;
  z: number;
  /** null = never claimed by this avatar, i.e. ready now. */
  nextClaimAt: string | null;
  ready: boolean;
}

export type SalvageFlavour = 'common' | 'uncommon' | 'rare';

/** The exact payload both a claim response and `state.lastClaim` carry. */
export interface LandSalvageClaimPayload {
  nodeId: string;
  layoutVersion: number;
  materialsGranted: number;
  flavour: SalvageFlavour;
  /** Pooled material balance AFTER the credit. */
  balanceAfter: number;
  /** ISO8601 — when this node becomes claimable again for this avatar. */
  nextClaimAt: string;
  claimsRemainingToday: number;
  ownerClaimsRemainingToday: number;
}

/** Rules the client RENDERS rather than re-derives — never hardcode these. */
export interface LandSalvageRules {
  approachRangeWu: number;
  cooldownMs: number;
  avatarDailyClaimCap: number;
  ownerDailyClaimCap: number;
  layoutVersion: number;
}

export interface LandSalvageStateResponse {
  layoutVersion: number;
  nodes: LandSalvageNodeStatus[];
  materialBalance: number;
  claimsUsedToday: number;
  claimsRemainingToday: number;
  ownerClaimsUsedToday: number;
  ownerClaimsRemainingToday: number;
  lastClaim: LandSalvageClaimPayload | null;
  rules: LandSalvageRules;
}

// ---- POST /:nodeId/approach ----

export interface LandSalvageApproachRequest {
  /** Centered world coords — the SAME frame LandProximityTracker resolves. */
  x: number;
  z: number;
}

export type LandSalvageApproachErrorCode =
  | 'node_unknown'
  | 'anchor_pending'
  | 'movement_poisoned'
  | 'impossible_movement'
  | 'out_of_range'
  | 'dwell_pending'
  | 'rate_limited';

/** Success body. Failure bodies are `{ok:false,error,retryAfterMs}` — thrown as ApiError, see api.ts. */
export interface LandSalvageApproachResponse {
  ok: true;
  approachToken: string;
  /** ISO8601 — SALVAGE_APPROACH_TOKEN_TTL_MS (20s) from issuance. */
  expiresAt: string;
}

// ---- POST /:nodeId/claim ----

export interface LandSalvageClaimRequest {
  approachToken: string;
  /** REQUIRED, 8-64 chars. ONE per gather gesture — reuse on retry or it double-pays. */
  idempotencyKey: string;
}

/** Success body — `ok:true` plus the claim payload spread flat, plus `replay`. */
export interface LandSalvageClaimResponse extends LandSalvageClaimPayload {
  ok: true;
  replay: boolean;
}

export type LandSalvageClaimErrorCode =
  | 'node_unknown'
  | 'house_excluded'
  | 'owner_unresolved'
  | 'binding_drift'
  | 'owner_daily_cap'
  | 'avatar_daily_cap'
  | 'node_on_cooldown'
  | 'idempotency_key_conflict'
  | 'concurrent_retry'
  | 'idempotency_key_required'
  | 'invalid_body'
  | 'rate_limited'
  /** From the approach-token verify step, surfaced as the claim route's own 403. */
  | 'invalid_token'
  | 'expired_token';
