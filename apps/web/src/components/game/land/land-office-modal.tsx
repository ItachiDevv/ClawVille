'use client';

/**
 * land-office-modal.tsx — the HUMAN in-game surface for the Land Economy.
 *
 * Opened from the sidebar ECONOMY section ("Land Office"). Lets a player:
 *   • For Sale  — choose a specific rendered parcel and its Hold or Rent door.
 *                 Hold is rent-free while the declared wallet meets the stacked
 *                 CLV threshold; Starter/C also offer 1..26 prepaid rent weeks.
 *   • My Land   — owned parcels + structure, tenure, prepay, and release state.
 *   • Build     — on a selected owned parcel: place + upgrade a building/shop,
 *                 with the TIER ADVANTAGE surfaced ("nicer options for higher
 *                 tiers" — higher tier ⇒ premium SKUs + higher max level).
 *
 * Visual language: the canonical `RpgModal` + `RpgButton` primitives from
 * @/components/rpg (matches Marketplace / Bazaar / Auction). Dark-navy panel,
 * so ONLY light text tokens (cyan-50/100/200, slate-100/200, white) are used.
 *
 * Settlement is human/agent at parity on the backend; this is the human path.
 * Agents already drive the same endpoints via the API.
 *
 * Mobile: RpgModal handles backdrop + escape + a responsive sheet; we gate the
 * 2-column Build layout on `useIsMobile()` (never a bare `md:` query) so iPad
 * (maxTouchPoints) collapses to a single column and never covers the joysticks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation, type QueryClient } from '@tanstack/react-query';
import {
  LAND_TIERS,
  parcelDisplayName,
  parseParcelCode,
  tierLabel,
  getTierStructureRules,
  type LandTier,
} from '@clawville/shared';
import { RpgModal, RpgButton } from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import { useAvatar, useSetSpawnPreference } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useIsGuest } from '@/hooks/use-is-guest';
import { api, ApiError } from '@/lib/api';
import { useLandStore, type ParcelState } from '@/stores/land';
import { LAND_PARCELS_QUERY_KEY } from '@/lib/three/land-state-hydrator';
import GuestLandSandbox from './guest-land-sandbox';
import { StructureAppearancePicker } from './structure-appearance-picker';
import {
  LandTenureForSalePanel,
  OwnedTenureControls,
  useLandHoldWalletStatus,
} from './tenure-office-panels';
import type {
  LandParcelDTO,
  LandStructureDTO,
  LandCatalogTierResponse,
  ServiceListingDTO,
  BrowseServicesResponse,
} from './types';

type Tab = 'for-sale' | 'my-land' | 'build' | 'services';

// ---------------------------------------------------------------------------
// Run-a-store — service listings (P3 Slice 4). Query-key namespace:
//   ['landServices', 'browse', page] — all-active paged PUBLIC browse (buyer-facing)
//   ['landServices', 'mine']         — the AUTHED owner's OWN listings across ALL
//                                      statuses (active + paused + delisted), all
//                                      shops, newest first (GET /api/land/services/mine)
// Both are extensions of the SAME namespace so a broad
// `predicate: (q) => q.queryKey[0] === 'landServices'` invalidation (used after a
// buy) catches every services view; list/patch specifically invalidate BOTH
// `['landServices','mine']` (the durable manage source) AND the browse keys.
// ---------------------------------------------------------------------------
const LAND_SERVICES_BROWSE_KEY = (page: number) => ['landServices', 'browse', page] as const;
const LAND_SERVICES_MINE_KEY = ['landServices', 'mine'] as const;
const LAND_SERVICES_MAX_ACTIVE_LISTINGS = 6; // mirrors land.ts MAX_ACTIVE_LISTINGS_PER_STRUCTURE (not exported)

/**
 * Durable refresh after any owner write (list / patch / deactivate / re-activate):
 * invalidate the owner's own-listings read (source of truth for the Manage view —
 * survives a reload, unlike the old session-only optimistic merge) AND the public
 * browse pages (a new/edited/paused listing may enter or leave the active feed).
 */
function invalidateLandServices(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: LAND_SERVICES_MINE_KEY });
  qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'landServices' && q.queryKey[1] === 'browse',
  });
}

/** Tier accent colors — matches the 3D parcel palette in land-parcels.tsx. */
const TIER_ACCENT: Record<LandTier, string> = {
  founder: '#f5c842',
  a: '#7ecef4',
  b: '#9fc975',
  c: '#c49a6c',
  starter: '#cbd5e1',
};

/** Map an API parcel status to the render-store's narrower ParcelState status. */
function toStoreStatus(status: LandParcelDTO['status']): ParcelState['status'] {
  if (status === 'owned') return 'owned';
  if (status === 'reserved') return 'reserved';
  return 'available';
}

/** Build a Record<parcelCode, ParcelState> for the 3D ownership overlay. */
function toParcelStateRecord(parcels: LandParcelDTO[]): Record<string, ParcelState> {
  const rec: Record<string, ParcelState> = {};
  for (const p of parcels) {
    rec[p.parcelCode] = {
      status: toStoreStatus(p.status),
      ownerAvatarId: p.ownerAvatarId,
    };
  }
  return rec;
}

/**
 * Resolve the machine error code from a thrown ApiError.
 *
 * The land routes (apps/api/src/routes/land.ts) return error bodies as
 * `{ error: '<snake_code>' }` with NO separate `code` field — so the snake_code
 * lands in `ApiError.message`, and `ApiError.code` is undefined. We therefore
 * read `err.code` first (the canonical field other routes set) and fall back to
 * `err.message` (where the land route puts it). Both are exact snake_case codes
 * for this surface, so a `switch` on the result is reliable and we still never
 * string-match human prose (the land route never returns prose error bodies).
 */
function errCode(err: unknown): { code: string | undefined; status: number | undefined } {
  if (err instanceof ApiError) return { code: err.code ?? err.message, status: err.status };
  return { code: undefined, status: undefined };
}

/**
 * Backstop copy for the server's `guest_not_allowed` 403 (land.ts
 * `requireNonGuestIdentity`). Guests render <GuestLandSandbox/> instead of the
 * real tabs, so this should not normally fire — but every land write error map
 * carries it as defense-in-depth so a guest NEVER sees a raw failure toast if a
 * real write path is somehow reached.
 */
const GUEST_NOT_ALLOWED_MSG =
  'Sign up to own real land — you’re browsing as a guest (this is the demo sandbox).';

// ---------------------------------------------------------------------------
// Tier badge + price pill
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: LandTier }) {
  const accent = TIER_ACCENT[tier];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
      style={{
        color: accent,
        borderColor: `${accent}55`,
        background: `${accent}18`,
      }}
    >
      {tierLabel(tier)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hold-to-keep helpers (Phase B2 — c/b/a/founder claim via CLV hold)
// ---------------------------------------------------------------------------

function FilterChip({
  label,
  active,
  accent,
  onClick,
}: {
  label: string;
  active: boolean;
  accent?: string;
  onClick: () => void;
}) {
  const color = accent ?? '#38bdf8';
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[36px] items-center rounded-full border px-3.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all"
      style={{
        color: active ? '#0a1628' : color,
        background: active ? color : `${color}14`,
        borderColor: active ? color : `${color}44`,
        fontWeight: 700,
      }}
    >
      {label}
    </button>
  );
}

function MyLandTab({
  parcels,
  structures,
  loading,
  hasAvatar,
  spawnPreference,
  homeParcelId,
  settingSpawn,
  onSetSpawn,
  onBrowse,
  onBuild,
  isMobile,
  holdWallet,
  onTenureChanged,
  focusParcelCode,
}: {
  parcels: LandParcelDTO[];
  structures: LandStructureDTO[];
  loading: boolean;
  hasAvatar: boolean;
  spawnPreference: 'home' | 'town';
  homeParcelId: string | null;
  settingSpawn: boolean;
  onSetSpawn: (mode: 'home' | 'town', parcelId?: string) => void;
  /** Opens the rendered two-door parcel chooser. */
  onBrowse: () => void;
  onBuild: (parcel: LandParcelDTO) => void;
  isMobile: boolean;
  holdWallet: import('./types').LandHoldWalletStatus | undefined;
  onTenureChanged: () => Promise<void> | void;
  focusParcelCode?: string | null;
}) {
  const focusedCardRef = useRef<HTMLDivElement>(null);
  const structByParcel = useMemo(() => {
    const m = new Map<string, LandStructureDTO>();
    for (const s of structures) m.set(s.parcelId, s);
    return m;
  }, [structures]);

  useEffect(() => {
    if (!focusParcelCode || loading) return;
    if (!parcels.some((parcel) => parcel.parcelCode === focusParcelCode)) return;
    const frame = requestAnimationFrame(() => {
      focusedCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusedCardRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusParcelCode, loading, parcels]);

  if (!hasAvatar) {
    return (
      <p className="py-12 text-center font-mono text-xs text-slate-300">
        Create an agent to claim and own land.
      </p>
    );
  }

  // Whether the home spawn is currently a parcel the player still owns. If the
  // stored homeParcelId isn't in the owned set (sold / transferred), treat the
  // spawn as effectively town so the "Spawn at Town Center" revert reads right.
  const homeIsOwned = spawnPreference === 'home' && parcels.some((p) => p.id === homeParcelId);
  const homeParcel = homeIsOwned ? parcels.find((p) => p.id === homeParcelId) : undefined;

  return (
    <div>
      {/* Every acquisition CTA leads to the specific-parcel two-door flow. */}
      <div className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
        <div className="flex flex-col gap-1">
          <span className="font-clawville text-sm text-emerald-100">
            🏡 Choose how to hold your next parcel
          </span>
          <span className="text-[12px] leading-relaxed text-slate-200">
            Open For Sale to choose a specific parcel. Starter and C parcels offer
            a rent-free CLV hold or prepaid vCLAW rent; Founder parcels are hold-only.
          </span>
        </div>
        <RpgButton
          size="sm"
          variant="primary"
          rarity="uncommon"
          onClick={onBrowse}
          className="mt-3 min-h-[44px]"
        >
          Open the two-door chooser
        </RpgButton>
      </div>

      {/* Spawn-point summary + town-center revert. Renders when the player owns
          at least one parcel (otherwise there's nothing to home-spawn at). */}
      {parcels.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
              🧭 Spawn point
            </span>
            <div className="mt-0.5 text-[12px] text-slate-200">
              {homeIsOwned ? (
                <>
                  You spawn at{' '}
                  <span className="font-semibold text-cyan-100">
                    {homeParcel
                      ? parcelDisplayName(homeParcel.parcelCode, homeParcel.tier)
                      : 'your home'}
                  </span>
                  .
                </>
              ) : (
                <>You spawn at <span className="font-semibold text-cyan-100">Town Center</span>.</>
              )}
            </div>
          </div>
          {homeIsOwned && (
            <RpgButton
              size="sm"
              variant="ghost"
              onClick={() => onSetSpawn('town')}
              loading={settingSpawn}
              className="min-h-[44px]"
            >
              Spawn at Town Center
            </RpgButton>
          )}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center font-mono text-xs text-slate-300">Loading your land…</p>
      ) : parcels.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-slate-400">
          You don&apos;t hold any parcels yet. Choose a parcel and tenure door in For Sale.
        </p>
      ) : (
        <div className="max-h-[44vh] space-y-3 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
          {parcels.map((p) => {
            const struct = structByParcel.get(p.id);
            const isSpawnHere = homeIsOwned && homeParcelId === p.id;
            const isFocused = focusParcelCode === p.parcelCode;
            return (
              <div
                key={p.id}
                ref={isFocused ? focusedCardRef : undefined}
                tabIndex={isFocused ? -1 : undefined}
                aria-current={isFocused ? 'true' : undefined}
                className={`flex flex-wrap gap-2 rounded-xl border bg-cyan-500/[0.04] ${isMobile ? 'flex-col p-3' : 'flex-row items-start justify-between p-4'} ${isFocused ? 'border-cyan-200 ring-2 ring-cyan-300 ring-offset-2 ring-offset-[#071321]' : 'border-cyan-400/15'}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-cyan-50">
                      {parcelDisplayName(p.parcelCode, p.tier)}
                    </span>
                    <TierBadge tier={p.tier} />
                    {isSpawnHere && (
                      <span className="inline-flex items-center rounded-full border border-cyan-300/40 bg-cyan-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-100">
                        🧭 Spawn here
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">{p.parcelCode}</div>
                  <div className="mt-1 font-mono text-[11px] text-slate-300">
                    {struct
                      ? `${struct.structureType === 'home' ? '🏠' : '🏪'} ${struct.catalogKey} · Lv${struct.level}`
                      : 'Empty lot — nothing built yet'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RpgButton
                    size="sm"
                    variant={isSpawnHere ? 'ghost' : 'secondary'}
                    onClick={() => onSetSpawn('home', p.id)}
                    loading={settingSpawn}
                    disabled={isSpawnHere}
                    className="min-h-[44px]"
                  >
                    {isSpawnHere ? 'Spawn point ✓' : 'Set as spawn point'}
                  </RpgButton>
                  <RpgButton size="sm" variant="secondary" className="min-h-[44px]" onClick={() => onBuild(p)}>
                    {struct ? 'Manage' : 'Build'}
                  </RpgButton>
                </div>
                <OwnedTenureControls
                  parcel={p}
                  wallet={holdWallet}
                  onChanged={onTenureChanged}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build / Upgrade tab
// ---------------------------------------------------------------------------

function placeErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'sku_not_allowed_for_tier':
      return 'That building isn’t allowed on this tier — buy a higher tier to unlock it.';
    case 'structure_exists':
      return 'This parcel already has a building.';
    case 'not_parcel_owner':
      return 'You don’t own this parcel.';
    case 'parcel_not_found':
      return 'That parcel no longer exists.';
    case 'invalid_catalog_key':
      return 'That building isn’t available — pick another.';
    default:
      if (status === 401) return 'Log in to build.';
      return 'Could not place the building — try again.';
  }
}

function upgradeErrorMessage(code: string | undefined, status: number | undefined, maxLevel: number): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'tier_max_level':
    case 'max_level_reached':
      return `This tier caps at Lv${maxLevel} — buy a higher tier to build bigger.`;
    case 'insufficient_clawtokens':
      return 'Not enough vCLAW for this upgrade.';
    // The upgrade route checks ownership of the STRUCTURE, not the parcel.
    case 'not_structure_owner':
    case 'not_parcel_owner':
      return 'You don’t own this structure.';
    case 'structure_not_found':
      return 'That structure no longer exists — reopen the panel.';
    case 'ownership_desync':
      return 'Ownership changed — reopen the panel and try again.';
    case 'idempotency_key_conflict':
      return 'That upgrade is already processing — give it a moment.';
    case 'idempotency_key_required':
      return 'Upgrade request was malformed — try again.';
    default:
      if (status === 401) return 'Log in to upgrade.';
      return 'Upgrade failed — try again.';
  }
}

function BuildTab({
  parcel,
  isMobile,
  onChanged,
}: {
  parcel: LandParcelDTO;
  isMobile: boolean;
  onChanged: () => void;
}) {
  const addToast = useGameStore((s) => s.addToast);
  const [catalog, setCatalog] = useState<LandCatalogTierResponse | null>(null);
  const [structure, setStructure] = useState<LandStructureDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Placement form state
  const [placeType, setPlaceType] = useState<'home' | 'shop'>('home');
  const [placeSku, setPlaceSku] = useState<string>('');
  const [placing, setPlacing] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cat, st] = await Promise.all([
        api.getLandCatalog(parcel.tier),
        api.getParcelStructure(parcel.id),
      ]);
      setCatalog(cat);
      setStructure(st.structure);
      // Default SKU = first allowed home SKU.
      if (cat.homeSkus.length > 0) setPlaceSku(cat.homeSkus[0].key);
    } catch {
      setError('Could not load the build catalog — try again.');
    } finally {
      setLoading(false);
    }
  }, [parcel.id, parcel.tier]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the selected SKU valid when the player flips home/shop.
  useEffect(() => {
    if (!catalog) return;
    const list = placeType === 'home' ? catalog.homeSkus : catalog.shopSkus;
    if (list.length > 0 && !list.some((s) => s.key === placeSku)) {
      setPlaceSku(list[0].key);
    }
  }, [placeType, catalog, placeSku]);

  const handlePlace = async () => {
    if (!placeSku) return;
    setPlacing(true);
    setError(null);
    try {
      const res = await api.placeStructure(parcel.id, {
        structureType: placeType,
        catalogKey: placeSku,
      });
      setStructure(res.structure);
      addToast(
        '🏗️',
        `Built ${res.structure.catalogKey} on ${parcelDisplayName(parcel.parcelCode, parcel.tier)}!`,
      );
      onChanged();
    } catch (err) {
      const { code, status } = errCode(err);
      setError(placeErrorMessage(code, status));
    } finally {
      setPlacing(false);
    }
  };

  const handleUpgrade = async () => {
    if (!structure || !catalog) return;
    setUpgrading(true);
    setError(null);
    try {
      // Backend REQUIRES a fresh idempotency key per click (keyless replay
      // double-charges). Generate a new UUID every time.
      const res = await api.upgradeStructure(structure.id, crypto.randomUUID());
      setStructure(res.structure);
      if (res.idempotencyReplay) {
        addToast('🔁', `Already at Lv${res.structure.level} (no double-charge).`);
      } else {
        addToast('⬆️', `Upgraded to Lv${res.structure.level} for ${res.costCt.toLocaleString()} vCLAW!`);
      }
      onChanged();
    } catch (err) {
      const { code, status } = errCode(err);
      setError(upgradeErrorMessage(code, status, catalog.maxLevel));
    } finally {
      setUpgrading(false);
    }
  };

  if (loading) {
    return <p className="py-12 text-center font-mono text-xs text-slate-300">Loading catalog…</p>;
  }
  if (error && !catalog) {
    return (
      <div className="py-12 text-center">
        <p className="font-mono text-xs text-rose-300">{error}</p>
        <RpgButton size="sm" variant="secondary" onClick={load} className="mt-3">
          Retry
        </RpgButton>
      </div>
    );
  }
  if (!catalog) return null;

  const advantageCopy = catalog.premium
    ? `Founders’ Row — premium buildings + upgrade all the way to Lv${catalog.maxLevel}.`
    : `${tierLabel(parcel.tier)} — buildings up to Lv${catalog.maxLevel}. Higher tiers unlock nicer buildings and higher levels.`;

  return (
    <div>
      {/* Parcel header + the unmissable tier-advantage banner */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <span>
          <span className="block font-semibold text-cyan-50">
            {parcelDisplayName(parcel.parcelCode, parcel.tier)}
          </span>
          <span className="block font-mono text-[10px] text-slate-400">
            {parcel.parcelCode}
          </span>
        </span>
        <TierBadge tier={parcel.tier} />
      </div>

      <div
        className="mb-4 rounded-xl border p-3"
        style={{
          borderColor: `${TIER_ACCENT[parcel.tier]}44`,
          background: `${TIER_ACCENT[parcel.tier]}12`,
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">{catalog.premium ? '👑' : '🏆'}</span>
          <span className="text-[12px] font-semibold leading-snug text-cyan-50">{advantageCopy}</span>
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {error}
        </p>
      )}

      <div className={isMobile ? 'flex flex-col gap-4' : 'grid grid-cols-2 gap-4'}>
        {/* Catalog (what this tier unlocks) */}
        <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/[0.03] p-3">
          <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
            Available on this tier
          </h4>
          <SkuList label="Homes" skus={catalog.homeSkus} />
          <SkuList label="Shops" skus={catalog.shopSkus} />
        </div>

        {/* Place OR Upgrade */}
        <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/[0.03] p-3">
          {structure ? (
            <>
              <UpgradePanel
                structure={structure}
                catalog={catalog}
                upgrading={upgrading}
                onUpgrade={handleUpgrade}
              />
              <StructureAppearancePicker
                structure={structure}
                parcelCode={parcel.parcelCode}
                parcelTier={parcel.tier}
                isMobile={isMobile}
                onStructureChange={setStructure}
                onChanged={onChanged}
              />
            </>
          ) : (
            <PlacePanel
              catalog={catalog}
              placeType={placeType}
              setPlaceType={setPlaceType}
              placeSku={placeSku}
              setPlaceSku={setPlaceSku}
              placing={placing}
              onPlace={handlePlace}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SkuList({ label, skus }: { label: string; skus: { key: string; label: string }[] }) {
  return (
    <div className="mb-2">
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-400">{label}</span>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {skus.map((s) => (
          <li
            key={s.key}
            className="rounded-md border border-cyan-400/20 bg-cyan-500/[0.06] px-2 py-0.5 font-mono text-[10px] text-cyan-100"
          >
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlacePanel({
  catalog,
  placeType,
  setPlaceType,
  placeSku,
  setPlaceSku,
  placing,
  onPlace,
}: {
  catalog: LandCatalogTierResponse;
  placeType: 'home' | 'shop';
  setPlaceType: (t: 'home' | 'shop') => void;
  placeSku: string;
  setPlaceSku: (k: string) => void;
  placing: boolean;
  onPlace: () => void;
}) {
  const list = placeType === 'home' ? catalog.homeSkus : catalog.shopSkus;
  return (
    <div>
      <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
        Build (free · lands at Lv1)
      </h4>
      <div className="mb-3 flex gap-2">
        <TypeToggle label="🏠 Home" active={placeType === 'home'} onClick={() => setPlaceType('home')} />
        <TypeToggle label="🏪 Shop" active={placeType === 'shop'} onClick={() => setPlaceType('shop')} />
      </div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
        Choose a building
      </label>
      <select
        value={placeSku}
        onChange={(e) => setPlaceSku(e.target.value)}
        className="mb-3 w-full rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
      >
        {list.map((s) => (
          <option key={s.key} value={s.key} className="text-cyan-50">
            {s.label}
          </option>
        ))}
      </select>
      <RpgButton size="sm" variant="primary" onClick={onPlace} loading={placing} disabled={!placeSku}>
        Build it
      </RpgButton>
    </div>
  );
}

function TypeToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[40px] flex-1 rounded-lg border px-2 py-1.5 font-mono text-[11px] transition-all"
      style={{
        color: active ? '#0a1628' : '#cbd5e1',
        background: active ? '#38bdf8' : 'rgba(56,189,248,0.08)',
        borderColor: active ? '#38bdf8' : 'rgba(56,189,248,0.3)',
        fontWeight: active ? 700 : 500,
      }}
    >
      {label}
    </button>
  );
}

function UpgradePanel({
  structure,
  catalog,
  upgrading,
  onUpgrade,
}: {
  structure: LandStructureDTO;
  catalog: LandCatalogTierResponse;
  upgrading: boolean;
  onUpgrade: () => void;
}) {
  const { maxLevel, upgradeCosts } = catalog;
  const atCap = structure.level >= maxLevel;
  const nextLevel = structure.level + 1;
  const nextCost = upgradeCosts[nextLevel];

  return (
    <div>
      <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
        {structure.structureType === 'home' ? '🏠' : '🏪'} {structure.catalogKey}
      </h4>
      {/* Level ladder — current highlighted, levels past maxLevel greyed out. */}
      <div className="mb-3 space-y-1">
        {Array.from({ length: 5 }, (_, i) => i + 1).map((lvl) => {
          const reached = lvl <= structure.level;
          const locked = lvl > maxLevel;
          const cost = upgradeCosts[lvl];
          return (
            <div
              key={lvl}
              className="flex items-center justify-between rounded-md border px-2 py-1 font-mono text-[11px]"
              style={{
                opacity: locked ? 0.4 : 1,
                color: locked ? '#64748b' : reached ? '#a7f3d0' : '#cbd5e1',
                borderColor: reached
                  ? 'rgba(16,185,129,0.4)'
                  : locked
                    ? 'rgba(100,116,139,0.25)'
                    : 'rgba(56,189,248,0.25)',
                background: reached ? 'rgba(16,185,129,0.08)' : 'transparent',
              }}
            >
              <span>
                Lv{lvl}
                {reached ? ' ✓' : ''}
                {locked ? ' 🔒' : ''}
              </span>
              <span>{lvl === 1 ? 'free' : locked ? 'tier locked' : `${cost?.toLocaleString()} vCLAW`}</span>
            </div>
          );
        })}
      </div>

      {atCap ? (
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Maxed at Lv{maxLevel} for {tierLabel(structure_tier(catalog))}. Buy a higher
          tier to build bigger.
        </p>
      ) : (
        <RpgButton size="sm" variant="primary" onClick={onUpgrade} loading={upgrading}>
          Upgrade to Lv{nextLevel} · {nextCost?.toLocaleString()} vCLAW
        </RpgButton>
      )}
    </div>
  );
}

/** The catalog response carries the tier; expose it for the cap copy. */
function structure_tier(catalog: LandCatalogTierResponse): LandTier {
  return catalog.tier;
}

// ---------------------------------------------------------------------------
// Services tab — run-a-store (P3 Slice 4)
//
// BROWSE: all-active paged listings (public buyer-facing feed, `browseServices`).
// MANAGE: only rendered when the player owns at least one active 'shop' structure —
// lets them list a new service and edit / pause / re-activate / delist existing ones.
//
// The Manage view reads the owner-scoped `GET /api/land/services/mine`
// (`api.getMyServices`, keyed `['landServices','mine']`) — the caller's OWN
// listings across ALL statuses (active + paused + delisted), for every shop they
// own, newest first. This is the durable source of truth, so a paused/delisted
// listing STAYS visible (with a Re-activate action) across a reload — closing the
// earlier read-surface gap where the only read was active-only. Per-shop panels
// filter this one shared read by `structureId`. List/patch writes invalidate
// `['landServices','mine']` (+ the browse pages) so the manage view reflects the
// change immediately and survives a reload — no session-only optimistic merge.
// ---------------------------------------------------------------------------

function serviceBuyErrorMessage(code: string | undefined, status: number | undefined, priceCt: number, have: number): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'self_purchase':
      return 'You can’t buy your own listing.';
    case 'listing_not_active':
      return 'This listing was paused or removed.';
    case 'insufficient_clawtokens':
      return `Not enough vCLAW — need ${priceCt.toLocaleString()}, you have ${have.toLocaleString()}.`;
    case 'idempotency_key_conflict':
      return 'That purchase is already processing — give it a moment.';
    case 'listing_not_found':
      return 'That listing no longer exists.';
    default:
      if (status === 401) return 'Log in to buy a service.';
      return 'Purchase failed — try again.';
  }
}

function serviceListErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'not_a_shop':
      return 'Only a shop can list services — build a shop first.';
    case 'structure_archived':
      return 'That structure is no longer active.';
    case 'not_structure_owner':
      return 'You don’t own that shop.';
    case 'ownership_desync':
      return 'Ownership changed — reopen the panel and try again.';
    case 'listing_cap_reached':
      return `This shop already has the maximum of ${LAND_SERVICES_MAX_ACTIVE_LISTINGS} active listings.`;
    case 'structure_not_found':
      return 'That shop no longer exists.';
    default:
      if (status === 401) return 'Log in to list a service.';
      return 'Could not list the service — try again.';
  }
}

function serviceUpdateErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'not_listing_owner':
      return 'You don’t own that listing.';
    case 'listing_not_found':
      return 'That listing no longer exists — refresh and try again.';
    // Re-activating a paused listing can exceed the active cap if the server
    // enforces it on the PATCH path — surface it clearly (harmless otherwise).
    case 'listing_cap_reached':
      return `This shop already has the maximum of ${LAND_SERVICES_MAX_ACTIVE_LISTINGS} active listings — pause another first.`;
    default:
      if (status === 401) return 'Log in to manage listings.';
      return 'Could not update the listing — try again.';
  }
}

/** Buy-confirm modal for a service listing — mirrors BuyModal. */
function BuyServiceModal({
  listing,
  clawTokens,
  onClose,
  onBought,
}: {
  listing: ServiceListingDTO;
  clawTokens: number;
  onClose: () => void;
  onBought: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const addToast = useGameStore((s) => s.addToast);
  // ONE fresh key per modal instance (a genuine retry of THIS click reuses it
  // via component state; a new buy click mounts a new modal with a new key).
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: () => api.buyService(listing.id, idempotencyKey),
    onSuccess: (res) => {
      addToast('🛍️', `Bought "${listing.title}" for ${res.priceCt.toLocaleString()} vCLAW!`);
      onBought();
    },
    onError: (err) => {
      const { code, status } = errCode(err);
      setError(serviceBuyErrorMessage(code, status, listing.priceCt, clawTokens));
    },
  });

  return (
    <RpgModal open onClose={onClose} title="Confirm Purchase" subtitle="Buy Service" tier="epic" maxWidth={420}>
      <div className="space-y-4 p-1">
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-4">
          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-cyan-100">
            {listing.title}
          </span>
          {listing.description && (
            <p className="mt-1 text-[12px] leading-relaxed text-slate-200">{listing.description}</p>
          )}
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-200">Price</span>
            <span className="font-mono font-bold text-amber-300">{listing.priceCt.toLocaleString()} vCLAW</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-slate-200">Your balance</span>
            <span className="font-mono font-bold text-cyan-200">{clawTokens.toLocaleString()} vCLAW</span>
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <RpgButton size="sm" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </RpgButton>
          <RpgButton
            size="sm"
            variant="primary"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={clawTokens < listing.priceCt}
          >
            {clawTokens < listing.priceCt ? 'Need more vCLAW' : `Buy for ${listing.priceCt.toLocaleString()} vCLAW`}
          </RpgButton>
        </div>
      </div>
    </RpgModal>
  );
}

function ServiceListingCard({
  listing,
  isOwn,
  onBuy,
}: {
  listing: ServiceListingDTO;
  isOwn: boolean;
  onBuy: (l: ServiceListingDTO) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-cyan-400/15 bg-cyan-500/[0.04] p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-cyan-100">
          {listing.title}
        </span>
        <span className="shrink-0 font-mono text-sm font-bold text-amber-300">
          {listing.priceCt.toLocaleString()} vCLAW
        </span>
      </div>
      {listing.description && (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-slate-300">{listing.description}</p>
      )}
      <div className="flex items-center justify-end">
        <RpgButton size="sm" variant={isOwn ? 'ghost' : 'primary'} disabled={isOwn} onClick={() => onBuy(listing)}>
          {isOwn ? 'Your listing' : 'Buy'}
        </RpgButton>
      </div>
    </div>
  );
}

/** Browse — all-active paged services (public read). */
function BrowseServicesPanel({
  ownAvatarId,
  onBuy,
}: {
  ownAvatarId: string | null;
  onBuy: (l: ServiceListingDTO) => void;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery<BrowseServicesResponse>({
    queryKey: LAND_SERVICES_BROWSE_KEY(page),
    queryFn: () => api.browseServices(page, 20),
  });

  if (query.isLoading) {
    return <p className="py-12 text-center font-mono text-xs text-slate-300">Loading services…</p>;
  }
  if (query.isError) {
    return (
      <div className="py-12 text-center">
        <p className="font-mono text-xs text-rose-300">Could not load services — try again.</p>
        <RpgButton size="sm" variant="secondary" onClick={() => query.refetch()} className="mt-3">
          Retry
        </RpgButton>
      </div>
    );
  }

  const listings = query.data?.listings ?? [];

  return (
    <div>
      <p className="mb-3 text-[12px] leading-relaxed text-slate-200">
        Services other players (and agents) are running out of their shops — coaching, crafted
        goods, one-off favors. Buying settles vCLAW{' '}
        <span className="font-semibold text-cyan-200">directly to the seller</span>, no house rake.
      </p>
      {listings.length === 0 ? (
        <p className="rounded-lg border border-cyan-400/10 bg-cyan-500/[0.03] px-3 py-6 text-center font-mono text-[11px] text-slate-400">
          No services listed yet — be the first to run a store in Build → Shop.
        </p>
      ) : (
        <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
          {listings.map((l) => (
            <ServiceListingCard key={l.id} listing={l} isOwn={!!ownAvatarId && l.ownerAvatarId === ownAvatarId} onBuy={onBuy} />
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between">
        <RpgButton size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          ← Prev
        </RpgButton>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">Page {page}</span>
        <RpgButton size="sm" variant="ghost" disabled={!query.data?.nextPage} onClick={() => setPage((p) => p + 1)}>
          Next →
        </RpgButton>
      </div>
    </div>
  );
}

/** A single owned listing's manage row — pause/activate, delist, edit price/title. */
function ManageListingRow({
  listing,
  queryClient,
}: {
  listing: ServiceListingDTO;
  queryClient: QueryClient;
}) {
  const addToast = useGameStore((s) => s.addToast);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(listing.title);
  const [description, setDescription] = useState(listing.description ?? '');
  const [priceCt, setPriceCt] = useState(String(listing.priceCt));
  const [error, setError] = useState<string | null>(null);

  const patchMutation = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateService>[1]) => api.updateService(listing.id, patch),
    onSuccess: () => {
      // Durable source of truth: refetch the owner's own listings (all statuses)
      // so a pause/delist/edit is reflected immediately AND survives a reload.
      invalidateLandServices(queryClient);
      setError(null);
    },
    onError: (err) => {
      const { code, status } = errCode(err);
      setError(serviceUpdateErrorMessage(code, status));
    },
  });

  const handleToggleActive = () => {
    patchMutation.mutate({ status: listing.status === 'active' ? 'paused' : 'active' });
  };
  const handleDelist = () => {
    patchMutation.mutate({ status: 'delisted' });
  };
  const handleSaveEdit = () => {
    const trimmedTitle = title.trim();
    const parsedPrice = Number(priceCt);
    if (trimmedTitle.length < 1 || trimmedTitle.length > 80) {
      setError('Title must be 1–80 characters.');
      return;
    }
    if (description.length > 500) {
      setError('Description must be 500 characters or fewer.');
      return;
    }
    if (!Number.isInteger(parsedPrice) || parsedPrice < 0 || parsedPrice > 1_000_000) {
      setError('Price must be a whole number between 0 and 1,000,000 vCLAW.');
      return;
    }
    patchMutation.mutate(
      { title: trimmedTitle, description: description.trim() || undefined, priceCt: parsedPrice },
      { onSuccess: () => { setEditing(false); addToast('✏️', 'Listing updated.'); } },
    );
  };

  const statusColor =
    listing.status === 'active' ? '#a7f3d0' : listing.status === 'paused' ? '#fcd34d' : '#94a3b8';

  return (
    <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/[0.04] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-[12px] font-semibold text-cyan-100">{listing.title}</span>
            <span
              className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]"
              style={{ color: statusColor, borderColor: `${statusColor}55`, background: `${statusColor}18` }}
            >
              {listing.status}
            </span>
          </div>
          {listing.description && !editing && (
            <p className="mt-1 text-[12px] leading-relaxed text-slate-300">{listing.description}</p>
          )}
        </div>
        <span className="shrink-0 font-mono text-sm font-bold text-amber-300">
          {listing.priceCt.toLocaleString()} vCLAW
        </span>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Title"
            className="w-full rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Description (optional)"
            rows={2}
            className="w-full resize-none rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
          />
          <input
            value={priceCt}
            onChange={(e) => setPriceCt(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            placeholder="Price (vCLAW)"
            className="w-full rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
          />
          <div className="flex justify-end gap-2">
            <RpgButton size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); }} disabled={patchMutation.isPending}>
              Cancel
            </RpgButton>
            <RpgButton size="sm" variant="primary" onClick={handleSaveEdit} loading={patchMutation.isPending}>
              Save
            </RpgButton>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <RpgButton size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </RpgButton>
          <RpgButton size="sm" variant="secondary" onClick={handleToggleActive} loading={patchMutation.isPending}>
            {listing.status === 'active' ? 'Pause' : 'Activate'}
          </RpgButton>
          {listing.status !== 'delisted' && (
            <RpgButton size="sm" variant="danger" onClick={handleDelist} loading={patchMutation.isPending}>
              Delist
            </RpgButton>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
          {error}
        </p>
      )}
    </div>
  );
}

/** Manage panel for one owned shop — list new + manage existing services. */
function ManageShopPanel({ shop }: { shop: LandStructureDTO }) {
  const addToast = useGameStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priceCt, setPriceCt] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Source of truth for the Manage view: the owner's OWN listings across ALL
  // statuses (all shops), filtered to THIS shop. Shared `['landServices','mine']`
  // read — react-query dedupes it across per-shop panel mounts.
  const query = useQuery({
    queryKey: LAND_SERVICES_MINE_KEY,
    queryFn: api.getMyServices,
  });
  const listings = (query.data?.listings ?? []).filter((l) => l.structureId === shop.id);
  const activeCount = listings.filter((l) => l.status === 'active').length;

  const listMutation = useMutation({
    mutationFn: () =>
      api.listService(shop.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        priceCt: Number(priceCt),
      }),
    onSuccess: (res) => {
      // Durable refresh (mine + browse) — no session-only optimistic merge.
      invalidateLandServices(queryClient);
      setTitle('');
      setDescription('');
      setPriceCt('');
      setFormError(null);
      addToast('🛍️', `Listed "${res.listing.title}"!`);
    },
    onError: (err) => {
      const { code, status } = errCode(err);
      setFormError(serviceListErrorMessage(code, status));
    },
  });

  const handleSubmit = () => {
    const trimmedTitle = title.trim();
    const parsedPrice = Number(priceCt);
    if (trimmedTitle.length < 1 || trimmedTitle.length > 80) {
      setFormError('Title must be 1–80 characters.');
      return;
    }
    if (description.length > 500) {
      setFormError('Description must be 500 characters or fewer.');
      return;
    }
    if (priceCt.trim().length === 0 || !Number.isInteger(parsedPrice) || parsedPrice < 0 || parsedPrice > 1_000_000) {
      setFormError('Price must be a whole number between 0 and 1,000,000 vCLAW.');
      return;
    }
    if (activeCount >= LAND_SERVICES_MAX_ACTIVE_LISTINGS) {
      setFormError(`This shop already has the maximum of ${LAND_SERVICES_MAX_ACTIVE_LISTINGS} active listings.`);
      return;
    }
    listMutation.mutate();
  };

  return (
    <div>
      <div className="mb-4 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">List a new service</h4>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">
            {activeCount} / {LAND_SERVICES_MAX_ACTIVE_LISTINGS} active
          </span>
        </div>
        <div className="space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Title (e.g. 1:1 Coaching)"
            className="w-full rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Description (optional)"
            rows={2}
            className="w-full resize-none rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
          />
          <input
            value={priceCt}
            onChange={(e) => setPriceCt(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            placeholder="Price (vCLAW)"
            className="w-full rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
          />
          {formError && (
            <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
              {formError}
            </p>
          )}
          <RpgButton
            size="sm"
            variant="primary"
            onClick={handleSubmit}
            loading={listMutation.isPending}
            disabled={activeCount >= LAND_SERVICES_MAX_ACTIVE_LISTINGS}
          >
            {activeCount >= LAND_SERVICES_MAX_ACTIVE_LISTINGS ? 'Cap reached' : 'List it'}
          </RpgButton>
        </div>
      </div>

      {query.isLoading ? (
        <p className="py-6 text-center font-mono text-xs text-slate-300">Loading your listings…</p>
      ) : query.isError ? (
        <div className="py-6 text-center">
          <p className="font-mono text-[11px] text-rose-300">Could not load your listings — try again.</p>
          <RpgButton size="sm" variant="secondary" onClick={() => query.refetch()} className="mt-3">
            Retry
          </RpgButton>
        </div>
      ) : listings.length === 0 ? (
        <p className="rounded-lg border border-cyan-400/10 bg-cyan-500/[0.03] px-3 py-4 text-center font-mono text-[11px] text-slate-400">
          No listings yet — use the form above.
        </p>
      ) : (
        <div className="max-h-[36vh] space-y-2 overflow-y-auto pr-1">
          {listings.map((l) => (
            <ManageListingRow key={l.id} listing={l} queryClient={queryClient} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServicesTab({
  hasAvatar,
  avatarId,
  clawTokens,
  shops,
}: {
  hasAvatar: boolean;
  avatarId: string | null;
  clawTokens: number;
  shops: LandStructureDTO[];
}) {
  const [subView, setSubView] = useState<'browse' | 'manage'>('browse');
  const [selectedShopId, setSelectedShopId] = useState<string | null>(shops[0]?.id ?? null);
  const [buyTarget, setBuyTarget] = useState<ServiceListingDTO | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (shops.length > 0 && !shops.some((s) => s.id === selectedShopId)) {
      setSelectedShopId(shops[0].id);
    }
    if (shops.length === 0) setSelectedShopId(null);
  }, [shops, selectedShopId]);

  const canManage = hasAvatar && shops.length > 0;
  const selectedShop = shops.find((s) => s.id === selectedShopId) ?? null;

  const handleBought = () => {
    setBuyTarget(null);
    queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'landServices' });
    queryClient.invalidateQueries({ queryKey: ['avatar'] }); // refresh CT balance
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="🛒 Browse" active={subView === 'browse'} onClick={() => setSubView('browse')} />
        {canManage && (
          <FilterChip label="🏪 My Listings" active={subView === 'manage'} onClick={() => setSubView('manage')} />
        )}
      </div>

      {subView === 'browse' && <BrowseServicesPanel ownAvatarId={avatarId} onBuy={setBuyTarget} />}

      {subView === 'manage' && canManage && (
        <div>
          {shops.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {shops.map((s) => (
                <FilterChip
                  key={s.id}
                  label={s.catalogKey}
                  active={s.id === selectedShopId}
                  onClick={() => setSelectedShopId(s.id)}
                />
              ))}
            </div>
          )}
          {selectedShop ? (
            <ManageShopPanel key={selectedShop.id} shop={selectedShop} />
          ) : (
            <p className="py-8 text-center font-mono text-xs text-slate-300">Select a shop above.</p>
          )}
        </div>
      )}

      {subView === 'manage' && !canManage && (
        <p className="py-12 text-center font-mono text-xs text-slate-300">
          Build a shop in 🏗️ Build to start running services.
        </p>
      )}

      {buyTarget && (
        <BuyServiceModal
          listing={buyTarget}
          clawTokens={clawTokens}
          onClose={() => setBuyTarget(null)}
          onBought={handleBought}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function LandOfficeModal() {
  const open = useGameStore((s) => s.landOfficeOpen);
  const close = useGameStore((s) => s.closeLandOffice);
  const addToast = useGameStore((s) => s.addToast);
  const focusParcelCode = useGameStore((s) => s.landOfficeFocusParcel);
  const setStoreParcels = useLandStore((s) => s.setParcels);
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();
  // Guest signal via the canonical hook (shares the ['auth-me'] cache with the
  // avatar-status-bar DEMO badge — no extra round trip). A guest gets the
  // client-side sandbox (below) instead of the real, server-gated tabs.
  const isGuest = useIsGuest();
  const setSpawnPreference = useSetSpawnPreference();
  const hasAvatar = !!avatar;
  const avatarId: string | null = (avatar as { id?: string } | null | undefined)?.id ?? null;
  const clawTokens: number = (avatar as { clawTokens?: number } | null | undefined)?.clawTokens ?? 0;
  const spawnPreference: 'home' | 'town' =
    (avatar as { spawnPreference?: 'home' | 'town' } | null | undefined)?.spawnPreference ?? 'town';
  const homeParcelId: string | null =
    (avatar as { homeParcelId?: string | null } | null | undefined)?.homeParcelId ?? null;

  const [tab, setTab] = useState<Tab>('for-sale');
  const [myParcels, setMyParcels] = useState<LandParcelDTO[]>([]);
  const [myStructures, setMyStructures] = useState<LandStructureDTO[]>([]);
  const [myLoading, setMyLoading] = useState(false);
  // Acquisition is parcel-specific through the two-door For Sale panel.
  const [buildParcel, setBuildParcel] = useState<LandParcelDTO | null>(null);

  // One fresh account-declared hold-wallet read is shared by the acquisition
  // cards and every owned hold card in this modal.
  const holdWallet = useLandHoldWalletStatus(open && !isGuest && hasAvatar);

  // Owned active 'shop' structures — the Services tab's Manage surface.
  const myShops = useMemo(() => myStructures.filter((s) => s.structureType === 'shop'), [myStructures]);

  // Hydrate the 3D ownership overlay from a public ownership lookup.
  const hydrateOverlay = useCallback(
    async (id: string | null) => {
      if (!id) return;
      try {
        const res = await api.getOwnedLand(id);
        setStoreParcels(toParcelStateRecord(res.parcels));
      } catch {
        /* overlay hydration is best-effort; never blocks the UI */
      }
    },
    [setStoreParcels],
  );

  const refreshMyLand = useCallback(async () => {
    if (!hasAvatar) return;
    setMyLoading(true);
    try {
      const res = await api.getMyLand();
      setMyParcels(res.parcels);
      setMyStructures(res.structures);
      setStoreParcels(toParcelStateRecord(res.parcels));
      return res;
    } catch {
      /* leave prior state on transient error */
      return undefined;
    } finally {
      setMyLoading(false);
    }
  }, [hasAvatar, setStoreParcels]);

  // On open, resolve the focused parcel against the viewer's owned rows before
  // choosing the tab. Keep the focus until close so its ring stays visible.
  useEffect(() => {
    if (!open) return;
    // Guests use the client-side sandbox — never touch the real land reads.
    if (isGuest) return;
    let cancelled = false;
    if (focusParcelCode) setTab('for-sale');
    void Promise.all([refreshMyLand(), hydrateOverlay(avatarId)]).then(([owned]) => {
      if (cancelled || !focusParcelCode || !owned) return;
      setTab(owned.parcels.some((parcel) => parcel.parcelCode === focusParcelCode)
        ? 'my-land'
        : 'for-sale');
    });
    return () => { cancelled = true; };
  }, [open, isGuest, refreshMyLand, hydrateOverlay, avatarId, focusParcelCode]);

  // Helper — invalidate the world parcel query so LandStateHydrator refetches
  // and the 3D scene reflects the new ownership without a page reload.
  const invalidateLandState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY });
  }, [queryClient]);

  // Shared post-settlement refresh for claim, prepay, and release.
  const handleTenureChanged = async () => {
    await refreshMyLand();
    await hydrateOverlay(avatarId);
    await holdWallet.refetch();
    invalidateLandState();
  };

  // Claim (hold-to-keep) success — WORLD↔DB↔UI parity path (modal list + 3D
  // FOR-SALE sign + My Land all flip together). refreshMyLand also updates
  // existingHoldSum for the next claim.
  // WALLET SEAM: open the wallet-visibility-ui team's link modal (mounted
  // top-level in /game; we mount nothing). Close our claim modal first so the
  // wallet modal is the sole foreground — the user links, reopens, and the
  // ['wallet-link'] cache refresh flips `linked`/`heldClv` here automatically.
  // Set / clear the spawn point. 'home' binds an owned parcel; 'town' reverts.
  // The mutation invalidates ['avatar'] so spawnPreference/homeParcelId refresh
  // here (the badge updates) and SpawnOnLoad reads the new value next load.
  const handleSetSpawn = async (mode: 'home' | 'town', parcelId?: string) => {
    try {
      await setSpawnPreference.mutateAsync(mode === 'home' ? { mode, parcelId } : { mode });
      addToast(
        '🧭',
        mode === 'home' ? 'Spawn point set to your home!' : 'Spawn point set to Town Center.',
      );
    } catch (err) {
      const { code, status } = errCode(err);
      const msg =
        code === 'not_owned'
          ? 'You don’t own that parcel — pick one you own.'
          : status === 401
            ? 'Log in to set a spawn point.'
            : 'Could not update your spawn point — try again.';
      addToast('⚠️', msg, 4500);
    }
  };

  const openBuild = (parcel: LandParcelDTO) => {
    setBuildParcel(parcel);
    setTab('build');
  };

  const focusedTier = focusParcelCode
    ? myParcels.find((parcel) => parcel.parcelCode === focusParcelCode)?.tier
      ?? parseParcelCode(focusParcelCode)?.tier
      ?? null
    : null;
  const focusedDisplayName = focusParcelCode && focusedTier
    ? parcelDisplayName(focusParcelCode, focusedTier)
    : null;

  return (
    <>
      <RpgModal
        open={open}
        onClose={close}
        title="Land Office"
        subtitle={focusedDisplayName
          ? `Focused: ${focusedDisplayName} · ${focusParcelCode}`
          : 'Browse · Hold or rent · Build'}
        tier="legendary"
        maxWidth={1000}
        bodyClassName={isMobile
          ? 'px-3 py-4 [scrollbar-gutter:stable]'
          : 'px-5 py-5 pr-4 [scrollbar-gutter:stable]'}
      >
        {isGuest ? (
          // A guest cannot own real land (every land write 403s server-side);
          // render the client-side SANDBOX instead of the real, gated tabs.
          <GuestLandSandbox />
        ) : (
        <>
        {/* Tabs */}
        <div className="mb-4 flex flex-wrap gap-2 border-b border-cyan-400/20 pb-3">
          <TabButton label="🏝️ For Sale" active={tab === 'for-sale'} onClick={() => setTab('for-sale')} />
          <TabButton label="🏠 My Land" active={tab === 'my-land'} onClick={() => setTab('my-land')} />
          {buildParcel && (
            <TabButton label="🏗️ Build" active={tab === 'build'} onClick={() => setTab('build')} />
          )}
          <TabButton label="🛍️ Services" active={tab === 'services'} onClick={() => setTab('services')} />
        </div>

        {tab === 'for-sale' && (
          <LandTenureForSalePanel
            ownedParcels={myParcels}
            isMobile={isMobile}
            focusParcelCode={focusParcelCode}
            onChanged={async () => {
              await handleTenureChanged();
              setTab('my-land');
            }}
          />
        )}
        {tab === 'my-land' && (
          <MyLandTab
            parcels={myParcels}
            structures={myStructures}
            loading={myLoading}
            hasAvatar={hasAvatar}
            spawnPreference={spawnPreference}
            homeParcelId={homeParcelId}
            settingSpawn={setSpawnPreference.isPending}
            onSetSpawn={handleSetSpawn}
            onBrowse={() => setTab('for-sale')}
            onBuild={openBuild}
            isMobile={isMobile}
            holdWallet={holdWallet.data}
            onTenureChanged={handleTenureChanged}
            focusParcelCode={focusParcelCode}
          />
        )}
        {tab === 'build' && buildParcel && (
          <BuildTab
            parcel={buildParcel}
            isMobile={isMobile}
            onChanged={() => {
              refreshMyLand();
              hydrateOverlay(avatarId);
            }}
          />
        )}
        {tab === 'services' && (
          <ServicesTab hasAvatar={hasAvatar} avatarId={avatarId} clawTokens={clawTokens} shops={myShops} />
        )}
        </>
        )}
      </RpgModal>

      {/* Claim confirm modals drive the real (server) write paths, so they are
          never mounted for a guest — the guest sandbox handles its own flow. */}
    </>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[44px] rounded-lg px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-all"
      style={{
        color: active ? '#0a1628' : '#cbd5e1',
        background: active ? '#38bdf8' : 'rgba(56,189,248,0.08)',
        fontWeight: active ? 700 : 600,
      }}
    >
      {label}
    </button>
  );
}
