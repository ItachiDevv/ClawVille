'use client';

/**
 * land-office-modal.tsx — the HUMAN in-game surface for the Land Economy.
 *
 * Opened from the sidebar ECONOMY section ("Land Office"). Lets a player:
 *   • For Sale  — browse for-sale parcels grouped by tier (founder→starter),
 *                 with price + a tier-ladder that visibly rises toward town.
 *   • My Land   — owned parcels + each parcel's structure + level, with a
 *                 prominent "Claim free home" CTA when the player owns nothing.
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LAND_TIERS,
  tierLabel,
  getTierStructureRules,
  MAX_PARCELS_PER_AVATAR,
  type LandTier,
} from '@clawville/shared';
import { RpgModal, RpgButton } from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { api, ApiError } from '@/lib/api';
import { useLandStore, type ParcelState } from '@/stores/land';
import type {
  LandParcelDTO,
  LandStructureDTO,
  LandCatalogTierResponse,
} from './types';

type Tab = 'for-sale' | 'my-land' | 'build';

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

function PriceText({ priceCt }: { priceCt: number | null }) {
  if (priceCt === null) {
    return (
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-300">
        Auction · Coming soon
      </span>
    );
  }
  return (
    <span className="font-mono text-sm font-bold text-amber-300">
      {priceCt.toLocaleString()} CT
    </span>
  );
}

// ---------------------------------------------------------------------------
// For-Sale tab
// ---------------------------------------------------------------------------

function ForSaleTab({
  onBuy,
  clawTokens,
}: {
  onBuy: (parcel: LandParcelDTO) => void;
  clawTokens: number;
}) {
  const [parcels, setParcels] = useState<LandParcelDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterTier, setFilterTier] = useState<LandTier | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getLandParcels({ status: 'available' });
      setParcels(res);
    } catch {
      setError('Could not load parcels — try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Group available parcels by tier in the value-gradient order (founder→starter).
  const byTier = useMemo(() => {
    const map = new Map<LandTier, LandParcelDTO[]>();
    for (const t of LAND_TIERS) map.set(t, []);
    for (const p of parcels) {
      if (p.status !== 'available') continue;
      if (filterTier !== 'all' && p.tier !== filterTier) continue;
      // Sort within tier by price asc later; collect first.
      map.get(p.tier)?.push(p);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.priceCt ?? 0) - (b.priceCt ?? 0));
    }
    return map;
  }, [parcels, filterTier]);

  if (loading) {
    return <p className="py-12 text-center font-mono text-xs text-slate-300">Loading parcels…</p>;
  }
  if (error) {
    return (
      <div className="py-12 text-center">
        <p className="font-mono text-xs text-rose-300">{error}</p>
        <RpgButton size="sm" variant="secondary" onClick={load} className="mt-3">
          Retry
        </RpgButton>
      </div>
    );
  }

  return (
    <div>
      {/* Tier ladder note + filter chips */}
      <p className="mb-3 text-[12px] leading-relaxed text-slate-200">
        Parcels closer to the town center belong to higher tiers — pricier, but
        they unlock <span className="font-semibold text-cyan-200">premium buildings</span>{' '}
        and <span className="font-semibold text-cyan-200">higher upgrade levels</span>.
        The price ladder rises from Starter Cove out at the rim up to Founders&apos; Row.
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip label="All" active={filterTier === 'all'} onClick={() => setFilterTier('all')} />
        {LAND_TIERS.map((t) => (
          <FilterChip
            key={t}
            label={tierLabel(t)}
            accent={TIER_ACCENT[t]}
            active={filterTier === t}
            onClick={() => setFilterTier(t)}
          />
        ))}
      </div>

      <div className="max-h-[52vh] space-y-5 overflow-y-auto pr-1">
        {LAND_TIERS.filter((t) => filterTier === 'all' || t === filterTier).map((tier) => {
          const list = byTier.get(tier) ?? [];
          const rule = getTierStructureRules(tier);
          return (
            <section key={tier}>
              <div className="mb-2 flex items-center gap-2">
                <TierBadge tier={tier} />
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
                  {list.length} available · max Lv{rule.maxLevel}
                  {rule.premium ? ' · premium SKUs' : ''}
                </span>
              </div>
              {list.length === 0 ? (
                <p className="rounded-lg border border-cyan-400/10 bg-cyan-500/[0.03] px-3 py-3 font-mono text-[11px] text-slate-400">
                  {tier === 'founder'
                    ? 'Founders’ Row is auction-only — coming soon.'
                    : 'Sold out in this tier right now.'}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {list.map((p) => (
                    <ParcelCard
                      key={p.id}
                      parcel={p}
                      clawTokens={clawTokens}
                      onBuy={onBuy}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

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

function ParcelCard({
  parcel,
  clawTokens,
  onBuy,
}: {
  parcel: LandParcelDTO;
  clawTokens: number;
  onBuy: (p: LandParcelDTO) => void;
}) {
  const accent = TIER_ACCENT[parcel.tier];
  const isFounder = parcel.priceCt === null;
  const tooPoor = parcel.priceCt !== null && clawTokens < parcel.priceCt;
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border bg-cyan-500/[0.04] p-3"
      style={{ borderColor: `${accent}33` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-100">
          {parcel.parcelCode}
        </span>
        <TierBadge tier={parcel.tier} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <PriceText priceCt={parcel.priceCt} />
        <RpgButton
          size="sm"
          variant={isFounder ? 'ghost' : 'primary'}
          disabled={isFounder || tooPoor}
          onClick={() => onBuy(parcel)}
        >
          {isFounder ? 'Auction' : tooPoor ? 'Need more CT' : 'Buy'}
        </RpgButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buy confirm modal (nested RpgModal)
// ---------------------------------------------------------------------------

function buyErrorMessage(code: string | undefined, status: number | undefined, parcel: LandParcelDTO, have: number): string {
  switch (code) {
    case 'insufficient_clawtokens':
      return `Not enough ClawTokens — need ${parcel.priceCt?.toLocaleString() ?? '?'}, you have ${have.toLocaleString()}.`;
    case 'parcel_not_available':
      return 'This parcel was just sold. Pick another.';
    case 'parcel_cap_reached':
      return `You already own the maximum of ${MAX_PARCELS_PER_AVATAR} parcels.`;
    case 'founder_not_in_v1':
      return 'Founders’ Row is auction-only — coming soon.';
    default:
      if (status === 401) return 'Log in to buy land.';
      return 'Purchase failed — try again.';
  }
}

function BuyModal({
  parcel,
  clawTokens,
  onClose,
  onBought,
}: {
  parcel: LandParcelDTO;
  clawTokens: number;
  onClose: () => void;
  onBought: () => void;
}) {
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useGameStore((s) => s.addToast);

  const handleBuy = async () => {
    setBuying(true);
    setError(null);
    try {
      const res = await api.buyParcel(parcel.id);
      addToast('🏝️', `Bought ${res.parcel.parcelCode} for ${res.amountCt.toLocaleString()} CT!`);
      onBought();
    } catch (err) {
      const { code, status } = errCode(err);
      setError(buyErrorMessage(code, status, parcel, clawTokens));
      setBuying(false);
    }
  };

  return (
    <RpgModal open onClose={onClose} title="Confirm Purchase" subtitle="Buy Land" tier="epic" maxWidth={420}>
      <div className="space-y-4 p-1">
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-cyan-100">
              {parcel.parcelCode}
            </span>
            <TierBadge tier={parcel.tier} />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-200">Price</span>
            <span className="font-mono font-bold text-amber-300">
              {parcel.priceCt?.toLocaleString() ?? '—'} CT
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-slate-200">Your balance</span>
            <span className="font-mono font-bold text-cyan-200">{clawTokens.toLocaleString()} CT</span>
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <RpgButton size="sm" variant="ghost" onClick={onClose} disabled={buying}>
            Cancel
          </RpgButton>
          <RpgButton size="sm" variant="primary" onClick={handleBuy} loading={buying}>
            Buy for {parcel.priceCt?.toLocaleString()} CT
          </RpgButton>
        </div>
      </div>
    </RpgModal>
  );
}

// ---------------------------------------------------------------------------
// My-Land tab
// ---------------------------------------------------------------------------

function MyLandTab({
  parcels,
  structures,
  loading,
  hasAvatar,
  claiming,
  onClaim,
  onBuild,
}: {
  parcels: LandParcelDTO[];
  structures: LandStructureDTO[];
  loading: boolean;
  hasAvatar: boolean;
  claiming: boolean;
  onClaim: () => void;
  onBuild: (parcel: LandParcelDTO) => void;
}) {
  const structByParcel = useMemo(() => {
    const m = new Map<string, LandStructureDTO>();
    for (const s of structures) m.set(s.parcelId, s);
    return m;
  }, [structures]);

  if (!hasAvatar) {
    return (
      <p className="py-12 text-center font-mono text-xs text-slate-300">
        Create an agent to claim and own land.
      </p>
    );
  }

  return (
    <div>
      {/* Claim free home CTA — prominent when the player owns nothing. */}
      <div className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
        <div className="flex flex-col gap-1">
          <span className="font-clawville text-sm text-emerald-100">
            🏡 Claim your free starter home
          </span>
          <span className="text-[12px] leading-relaxed text-slate-200">
            Every player gets one free Starter Cove parcel — build a basic home or
            shop (up to Lv2). Buy a higher tier later for premium buildings.
          </span>
        </div>
        <RpgButton
          size="sm"
          variant="primary"
          rarity="uncommon"
          onClick={onClaim}
          loading={claiming}
          className="mt-3"
        >
          {parcels.length > 0 ? 'Claim another (if available)' : 'Claim free home'}
        </RpgButton>
      </div>

      {loading ? (
        <p className="py-8 text-center font-mono text-xs text-slate-300">Loading your land…</p>
      ) : parcels.length === 0 ? (
        <p className="py-6 text-center font-mono text-xs text-slate-400">
          You don&apos;t own any parcels yet. Claim a free home above, or buy one in
          For&nbsp;Sale.
        </p>
      ) : (
        <div className="max-h-[44vh] space-y-2 overflow-y-auto pr-1">
          {parcels.map((p) => {
            const struct = structByParcel.get(p.id);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-cyan-400/15 bg-cyan-500/[0.04] p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-100">
                      {p.parcelCode}
                    </span>
                    <TierBadge tier={p.tier} />
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-slate-300">
                    {struct
                      ? `${struct.structureType === 'home' ? '🏠' : '🏪'} ${struct.catalogKey} · Lv${struct.level}`
                      : 'Empty lot — nothing built yet'}
                  </div>
                </div>
                <RpgButton size="sm" variant="secondary" onClick={() => onBuild(p)}>
                  {struct ? 'Manage' : 'Build'}
                </RpgButton>
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
    case 'tier_max_level':
    case 'max_level_reached':
      return `This tier caps at Lv${maxLevel} — buy a higher tier to build bigger.`;
    case 'insufficient_clawtokens':
      return 'Not enough ClawTokens for this upgrade.';
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
      addToast('🏗️', `Built ${res.structure.catalogKey} on ${parcel.parcelCode}!`);
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
        addToast('⬆️', `Upgraded to Lv${res.structure.level} for ${res.costCt.toLocaleString()} CT!`);
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
        <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-cyan-100">
          {parcel.parcelCode}
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
            <UpgradePanel
              structure={structure}
              catalog={catalog}
              upgrading={upgrading}
              onUpgrade={handleUpgrade}
            />
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
              <span>{lvl === 1 ? 'free' : locked ? 'tier locked' : `${cost?.toLocaleString()} CT`}</span>
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
          Upgrade to Lv{nextLevel} · {nextCost?.toLocaleString()} CT
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
// Main modal
// ---------------------------------------------------------------------------

export default function LandOfficeModal() {
  const open = useGameStore((s) => s.landOfficeOpen);
  const close = useGameStore((s) => s.closeLandOffice);
  const addToast = useGameStore((s) => s.addToast);
  const setStoreParcels = useLandStore((s) => s.setParcels);
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();
  const hasAvatar = !!avatar;
  const avatarId: string | null = (avatar as { id?: string } | null | undefined)?.id ?? null;
  const clawTokens: number = (avatar as { clawTokens?: number } | null | undefined)?.clawTokens ?? 0;

  const [tab, setTab] = useState<Tab>('for-sale');
  const [myParcels, setMyParcels] = useState<LandParcelDTO[]>([]);
  const [myStructures, setMyStructures] = useState<LandStructureDTO[]>([]);
  const [myLoading, setMyLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [buyTarget, setBuyTarget] = useState<LandParcelDTO | null>(null);
  const [buildParcel, setBuildParcel] = useState<LandParcelDTO | null>(null);

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
    } catch {
      /* leave prior state on transient error */
    } finally {
      setMyLoading(false);
    }
  }, [hasAvatar, setStoreParcels]);

  // On open: load my land + hydrate the overlay.
  useEffect(() => {
    if (!open) return;
    refreshMyLand();
    hydrateOverlay(avatarId);
  }, [open, refreshMyLand, hydrateOverlay, avatarId]);

  const handleClaim = async () => {
    setClaiming(true);
    try {
      const res = await api.claimStarterPlot();
      addToast(
        '🏡',
        res.alreadyOwned
          ? `You already own ${res.parcel.parcelCode}.`
          : `Claimed ${res.parcel.parcelCode} — your free starter home!`,
      );
      await refreshMyLand();
      await hydrateOverlay(avatarId);
      setTab('my-land');
    } catch (err) {
      const { code, status } = errCode(err);
      const msg =
        code === 'no_starter_available'
          ? 'No free starter parcels are available right now.'
          : status === 401
            ? 'Log in to claim a home.'
            : 'Could not claim a home — try again.';
      addToast('⚠️', msg, 4500);
    } finally {
      setClaiming(false);
    }
  };

  const handleBought = async () => {
    setBuyTarget(null);
    await refreshMyLand();
    await hydrateOverlay(avatarId);
    setTab('my-land');
  };

  const openBuild = (parcel: LandParcelDTO) => {
    setBuildParcel(parcel);
    setTab('build');
  };

  return (
    <>
      <RpgModal
        open={open}
        onClose={close}
        title="Land Office"
        subtitle="Browse · Claim · Build"
        tier="legendary"
        maxWidth={1000}
      >
        {/* Tabs */}
        <div className="mb-4 flex flex-wrap gap-2 border-b border-cyan-400/20 pb-3">
          <TabButton label="🏝️ For Sale" active={tab === 'for-sale'} onClick={() => setTab('for-sale')} />
          <TabButton label="🏠 My Land" active={tab === 'my-land'} onClick={() => setTab('my-land')} />
          {buildParcel && (
            <TabButton label="🏗️ Build" active={tab === 'build'} onClick={() => setTab('build')} />
          )}
        </div>

        {tab === 'for-sale' && <ForSaleTab onBuy={setBuyTarget} clawTokens={clawTokens} />}
        {tab === 'my-land' && (
          <MyLandTab
            parcels={myParcels}
            structures={myStructures}
            loading={myLoading}
            hasAvatar={hasAvatar}
            claiming={claiming}
            onClaim={handleClaim}
            onBuild={openBuild}
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
      </RpgModal>

      {buyTarget && (
        <BuyModal
          parcel={buyTarget}
          clawTokens={clawTokens}
          onClose={() => setBuyTarget(null)}
          onBought={handleBought}
        />
      )}
    </>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[40px] rounded-lg px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-all"
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
