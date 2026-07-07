/**
 * types.ts — shared DTO + response types for the Land Office UI.
 *
 * Mirrors the FROZEN backend contract (apps/api/src/routes/land.ts), already
 * live on staging. The Land panel components + the api.ts client methods both
 * import from here so the wire shape is defined exactly once on the web side.
 */
import type { LandTier } from '@clawville/shared';

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
  /** How the parcel is held; null = available/unsold. */
  tenure: LandTenure | null;
}

/** A structure (home or shop) placed on an owned parcel. */
export interface LandStructureDTO {
  id: string;
  parcelId: string;
  ownerAvatarId: string;
  structureType: 'home' | 'shop';
  catalogKey: string;
  level: number;
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

/** POST /api/land/claim-starter response. */
export interface ClaimStarterResponse {
  parcel: LandParcelDTO;
  alreadyOwned: boolean;
}

/** POST /api/land/parcels/:id/buy response. */
export interface BuyParcelResponse {
  parcel: LandParcelDTO;
  amountCt: number;
}

/**
 * POST /api/land/parcels/:id/rent response. `amountCt` = the weekly rent debited
 * for the first week (server-read `rent_ct_weekly`). `rentPaidThrough` = ISO date
 * the rent is paid through; the hourly sweeper charges the next week + grace →
 * evict if unpaid.
 */
export interface RentParcelResponse {
  parcel: LandParcelDTO;
  amountCt: number;
  rentPaidThrough: string;
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
