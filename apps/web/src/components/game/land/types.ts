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
