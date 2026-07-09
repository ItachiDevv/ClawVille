'use client';

/**
 * land-office-modal.tsx — the HUMAN in-game surface for the Land Economy.
 *
 * Opened from the sidebar ECONOMY section ("Land Office"). Lets a player:
 *   • For Sale  — browse for-sale parcels grouped by tier (founder→starter).
 *                 Hold tiers (c/b/a/founder) are acquired via CLAIM (hold-to-
 *                 keep): prove a CLV hold, pay weekly CT upkeep — no CT price.
 *                 Starter is claimed via a refundable CT DEPOSIT held in escrow
 *                 (auto-assigned parcel). The tier-ladder visibly rises toward
 *                 town.
 *   • My Land   — owned parcels + each parcel's structure + level, with a
 *                 prominent "Claim your first home" CTA (refundable starter
 *                 deposit — NOT free) when the player owns nothing.
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
import { useQuery, useQueryClient, useMutation, type QueryClient } from '@tanstack/react-query';
import {
  LAND_TIERS,
  tierLabel,
  getTierStructureRules,
  MAX_PARCELS_PER_AVATAR,
  holdThresholdForTier,
  FOUNDER_UPKEEP_CT_WEEKLY,
  LAND_STARTER_DEPOSIT_CT,
  LAND_STARTER_RENT_CT_WEEKLY,
  type LandTier,
} from '@clawville/shared';
import { RpgModal, RpgButton } from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import { useAvatar, useSetSpawnPreference } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useWalletLink } from '@/hooks/use-wallet-link';
import { api, ApiError } from '@/lib/api';
import { useLandStore, type ParcelState } from '@/stores/land';
import { LAND_PARCELS_QUERY_KEY } from '@/lib/three/land-state-hydrator';
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

// ---------------------------------------------------------------------------
// Ref-based parcel focus helper — scrolls a highlighted card into view.
// Used when the modal is opened from a 3D parcel click (landOfficeFocusParcel).
// ---------------------------------------------------------------------------
const FOCUSED_CARD_ID = 'land-office-focused-parcel';

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

// ---------------------------------------------------------------------------
// Hold-to-keep helpers (Phase B2 — c/b/a/founder claim via CLV hold)
// ---------------------------------------------------------------------------

/** Hold-to-keep tiers = the ones with a CLV hold threshold (c/b/a/founder). */
function isHoldTier(tier: LandTier): boolean {
  return holdThresholdForTier(tier) != null;
}

/** Compact CLV formatter: 100000→"100K", 500000→"500K", 2500000→"2.5M", 10000000→"10M". */
function formatClv(amount: number): string {
  if (amount >= 1_000_000) {
    const m = amount / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    const k = amount / 1_000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return amount.toLocaleString();
}

/**
 * Weekly CT upkeep for a hold-tier parcel. Available c/b/a rows carry a
 * seed-stamped `rentCtWeekly`; available FOUNDER rows carry null (the server
 * stamps FOUNDER_UPKEEP_CT_WEEKLY only AT claim), so display the constant.
 */
function weeklyUpkeepCt(parcel: LandParcelDTO): number | null {
  return parcel.rentCtWeekly ?? (parcel.tier === 'founder' ? FOUNDER_UPKEEP_CT_WEEKLY : null);
}

/**
 * The CLV a claim on `tier` requires ON TOP of what the caller already holds
 * against other parcels (thresholds STACK server-side). `existingHoldSum` is
 * computed client-side from the caller's owned `tenure==='hold'` parcels
 * because honoRequest drops the server's requiredClv/heldClv extras from the
 * 403 error body. KNOWN LIMITATION: the DTO does not expose `grandfathered`,
 * so a grandfathered legacy owner's holds (excluded from the SERVER sum) are
 * counted here — the display can over-state the requirement for those few
 * legacy accounts. The server is authoritative and will still accept, which is
 * why the Claim button is never disabled on a client-side "short" verdict.
 */
function stackedRequiredClv(tier: LandTier, existingHoldSum: number): number {
  return existingHoldSum + (holdThresholdForTier(tier) ?? 0);
}

// ---------------------------------------------------------------------------
// For-Sale tab
// ---------------------------------------------------------------------------

function ForSaleTab({
  onClaim,
  onClaimStarter,
  heldClv,
  existingHoldSum,
  focusParcelCode,
  onFocusConsumed,
}: {
  /** Open the hold-to-keep ClaimHoldModal for a c/b/a/founder parcel. */
  onClaim: (parcel: LandParcelDTO) => void;
  /**
   * Open the StarterClaimModal (deposit-escrow). Parcel-AGNOSTIC — the
   * claim-starter route takes no parcelId and AUTO-PICKS an available lot.
   */
  onClaimStarter: () => void;
  /** Linked-wallet CLV uiAmount, or null (logged out / not linked / read down). */
  heldClv: number | null;
  /** Σ of the caller's existing hold thresholds (stacking) — see stackedRequiredClv. */
  existingHoldSum: number;
  /** When set, scroll the matching parcel card into view and clear after. */
  focusParcelCode?: string | null;
  onFocusConsumed?: () => void;
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

  // Scroll the focused parcel into view once the parcel list has loaded and
  // the DOM element exists. Uses the DOM id set on the ParcelCard wrapper.
  useEffect(() => {
    if (!focusParcelCode || loading || parcels.length === 0) return;
    // Reset tier filter to 'all' so the target parcel is visible in any tier.
    setFilterTier('all');
    // Defer one tick so the list has re-rendered with filterTier='all'.
    const tid = setTimeout(() => {
      const el = document.getElementById(FOCUSED_CARD_ID);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        onFocusConsumed?.();
      }
    }, 60);
    return () => clearTimeout(tid);
    // Only re-run when focusParcelCode changes; loading/parcels are not deps here
    // because we already guard on them above. eslint disable below is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParcelCode]);

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
        Parcels closer to the town center belong to higher tiers — they unlock{' '}
        <span className="font-semibold text-cyan-200">premium buildings</span>{' '}
        and <span className="font-semibold text-cyan-200">higher upgrade levels</span>.
        Higher tiers are <span className="font-semibold text-cyan-200">claimed by holding $CLAWVILLE</span>{' '}
        in your linked wallet (no CT price — hold to keep, plus a small weekly CT
        upkeep). The hold ladder rises from Starter Cove out at the rim up to
        Founders&apos; Row.
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
                    ? 'No Founders’ Row lots open right now.'
                    : 'Sold out in this tier right now.'}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {list.map((p) => (
                    <ParcelCard
                      key={p.id}
                      parcel={p}
                      onClaim={onClaim}
                      onClaimStarter={onClaimStarter}
                      heldClv={heldClv}
                      existingHoldSum={existingHoldSum}
                      isFocused={!!focusParcelCode && p.parcelCode === focusParcelCode}
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
  onClaim,
  onClaimStarter,
  heldClv,
  existingHoldSum,
  isFocused,
}: {
  parcel: LandParcelDTO;
  onClaim: (p: LandParcelDTO) => void;
  /** Open the parcel-agnostic StarterClaimModal (server auto-picks the lot). */
  onClaimStarter: () => void;
  /** Linked-wallet CLV uiAmount, or null (logged out / not linked / read down). */
  heldClv: number | null;
  existingHoldSum: number;
  isFocused?: boolean;
}) {
  const accent = TIER_ACCENT[parcel.tier];
  // Hold tiers (c/b/a/founder) acquire via CLAIM (hold-to-keep) — the old Buy
  // route is retired (409 tenure_model_active). Starter acquires via the
  // deposit-escrow claim (§18b.j B1) — its old Buy button was equally dead.
  const holdTier = isHoldTier(parcel.tier);
  const tierThreshold = holdThresholdForTier(parcel.tier);
  const upkeep = weeklyUpkeepCt(parcel);
  // Qualified/short badge — display-only (server is authoritative; see
  // stackedRequiredClv for the grandfathered caveat). null = unknown.
  const qualified =
    holdTier && heldClv != null
      ? heldClv >= stackedRequiredClv(parcel.tier, existingHoldSum)
      : null;
  return (
    <div
      id={isFocused ? FOCUSED_CARD_ID : undefined}
      className="flex flex-col gap-2 rounded-xl border bg-cyan-500/[0.04] p-3"
      style={{
        borderColor: isFocused ? '#38bdf8' : `${accent}33`,
        boxShadow: isFocused ? '0 0 0 2px #38bdf880' : undefined,
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-100">
          {parcel.parcelCode}
        </span>
        <TierBadge tier={parcel.tier} />
      </div>
      {holdTier ? (
        <>
          {/* Hold-to-keep: show the CLV hold + Claim (replaces the retired Buy). */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm font-bold text-amber-300">
              Hold {formatClv(tierThreshold ?? 0)} $CLAWVILLE
            </span>
            <RpgButton
              size="sm"
              variant="primary"
              className="min-h-[44px]"
              onClick={() => onClaim(parcel)}
            >
              Claim
            </RpgButton>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-cyan-200">
              {upkeep != null ? (
                <>
                  {upkeep.toLocaleString()} CT
                  <span className="text-slate-400"> / week upkeep</span>
                </>
              ) : (
                <span className="text-slate-400">weekly upkeep set at claim</span>
              )}
            </span>
            {qualified != null && (
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${
                  qualified
                    ? 'border-emerald-300/40 bg-emerald-400/15 text-emerald-200'
                    : 'border-amber-300/40 bg-amber-400/15 text-amber-200'
                }`}
              >
                {qualified ? '✓ $CLAWVILLE qualified' : '$CLAWVILLE short'}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Starter = deposit-escrow (§18b.j B1). The retired Buy button
              (always 409 tenure_model_active) is replaced by Claim → the
              parcel-AGNOSTIC StarterClaimModal: claim-starter takes no
              parcelId and AUTO-PICKS an available lot, so the button opens
              the confirm without binding to THIS card's parcel. Affordability
              is gated inside the modal (mirrors BuyModal's tooPoor pattern). */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm font-bold text-amber-300">
              Refundable {LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT deposit
            </span>
            <RpgButton
              size="sm"
              variant="primary"
              className="min-h-[44px]"
              onClick={onClaimStarter}
            >
              Claim
            </RpgButton>
          </div>
          <span className="font-mono text-[11px] text-cyan-200">
            {LAND_STARTER_RENT_CT_WEEKLY.toLocaleString()} CT
            <span className="text-slate-400"> / week upkeep, drawn from the deposit</span>
          </span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claim (hold-to-keep) confirm modal — c/b/a/founder (Phase B2)
// ---------------------------------------------------------------------------

/**
 * One distinct message per claim-hold error code (contract: land.ts route 7b).
 * `requiredClv`/`heldClv` are CLIENT-computed — honoRequest drops the server's
 * extra fields from the 403 `insufficient_clv_hold` body (only error/code
 * survive into ApiError). Switch on errCode() output; never string-match prose.
 */
function claimHoldErrorMessage(
  code: string | undefined,
  status: number | undefined,
  parcel: LandParcelDTO,
  requiredClv: number,
  heldClv: number | null,
): string {
  switch (code) {
    case 'wallet_not_linked':
      return 'Link a self-custody wallet first — your $CLAWVILLE hold is verified against it.';
    // Agent-only (humans shouldn't hit this) — handled defensively.
    case 'agent_wallet_missing':
      return 'This agent has no custodial wallet — reconnect the agent and try again.';
    case 'insufficient_clv_hold':
      return `Not enough $CLAWVILLE held — this claim needs ${formatClv(requiredClv)} $CLAWVILLE in your wallet${
        heldClv != null ? `, you hold ${heldClv.toLocaleString()}` : ''
      }.`;
    // FAIL-CLOSED: the chain read is down — the server never grants unverified.
    case 'clv_balance_unavailable':
      return 'We can’t verify your $CLAWVILLE balance right now — try again in a minute.';
    case 'parcel_not_available':
      return 'Someone just claimed this parcel. Pick another.';
    case 'parcel_cap_reached':
      return `You already hold the maximum of ${MAX_PARCELS_PER_AVATAR} parcels.`;
    // Starter tier shouldn't reach this modal — defensive.
    case 'use_claim_starter':
      return 'Starter parcels are claimed with a refundable CT deposit (For Sale or My Land), not a $CLAWVILLE hold.';
    // Defensive — marketplace deed escrow-lock (claim-hold doesn't emit it today).
    case 'deed_locked_by_listing':
      return 'This deed is locked by a live marketplace listing — try again once it clears.';
    case 'parcel_not_found':
      return 'That parcel no longer exists.';
    case 'invalid_parcel_id':
    case 'invalid_body':
      return 'Claim request was malformed — reopen the panel and try again.';
    default:
      if (status === 401) return 'Log in to claim land.';
      return `Could not claim ${parcel.parcelCode} — try again.`;
  }
}

/**
 * Hold-to-keep claim confirm (mirrors BuyModal). NO CT is spent to
 * claim — the player must HOLD the tier's CLV threshold (stacking with their
 * existing holds) in their linked wallet, and the weekly CT upkeep auto-charges
 * like rent. Not-linked users get a "Link a wallet" CTA instead of Claim.
 */
function ClaimHoldModal({
  parcel,
  linked,
  heldClv,
  existingHoldSum,
  onClose,
  onClaimed,
  onRequestWalletLink,
}: {
  parcel: LandParcelDTO;
  /** Whether the caller has a linked self-custody wallet (wallet team's hook). */
  linked: boolean;
  /** Linked-wallet CLV uiAmount, or null (not linked / read down). */
  heldClv: number | null;
  existingHoldSum: number;
  onClose: () => void;
  onClaimed: () => void;
  onRequestWalletLink: () => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useGameStore((s) => s.addToast);

  const tierThreshold = holdThresholdForTier(parcel.tier) ?? 0;
  const requiredClv = stackedRequiredClv(parcel.tier, existingHoldSum);
  const upkeep = weeklyUpkeepCt(parcel);
  // Display-only verdict — the server re-checks under lock and is authoritative
  // (the client sum can over-count for grandfathered legacy owners), so Claim
  // stays ENABLED on a "short" verdict; only not-linked disables it.
  const qualified = heldClv != null ? heldClv >= requiredClv : null;

  const handleClaim = async () => {
    setClaiming(true);
    setError(null);
    try {
      // EMPTY body — the threshold + live balance are server-derived, always.
      const res = await api.claimHoldParcel(parcel.id);
      addToast(
        '🏝️',
        `Claimed ${res.parcel.parcelCode} — held with ${formatClv(res.parcel.holdThresholdCt ?? tierThreshold)} $CLAWVILLE!`,
      );
      onClaimed();
    } catch (err) {
      const { code, status } = errCode(err);
      setError(claimHoldErrorMessage(code, status, parcel, requiredClv, heldClv));
      setClaiming(false);
    }
  };

  return (
    <RpgModal open onClose={onClose} title="Confirm Claim" subtitle="Hold to Keep" tier="epic" maxWidth={460}>
      <div className="space-y-4 p-1">
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-cyan-100">
              {parcel.parcelCode}
            </span>
            <TierBadge tier={parcel.tier} />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-200">$CLAWVILLE hold required</span>
            <span className="font-mono font-bold text-amber-300">{formatClv(requiredClv)} $CLAWVILLE</span>
          </div>
          {existingHoldSum > 0 && (
            <p className="mt-1 text-right font-mono text-[10px] text-slate-300">
              this parcel {formatClv(tierThreshold)} + {formatClv(existingHoldSum)} already held ={' '}
              {formatClv(requiredClv)}
            </p>
          )}
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-slate-200">You hold</span>
            <span
              className={`font-mono font-bold ${
                heldClv != null ? 'text-cyan-200' : 'text-amber-200'
              }`}
            >
              {!linked
                ? 'Wallet not linked'
                : heldClv == null
                  ? 'Can’t verify right now'
                  : `${heldClv.toLocaleString()} $CLAWVILLE`}
            </span>
          </div>
          {qualified != null && (
            <p
              className={`mt-2 rounded-lg border px-2 py-1 text-right font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${
                qualified
                  ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-200'
                  : 'border-amber-300/40 bg-amber-400/10 text-amber-200'
              }`}
            >
              {qualified
                ? '✓ You qualify'
                : `${formatClv(requiredClv - (heldClv ?? 0))} $CLAWVILLE short — server has the final say`}
            </p>
          )}
        </div>

        {/* How hold-to-keep works — no CT spent to claim; hold CLV + weekly upkeep. */}
        <p className="rounded-lg border border-cyan-400/15 bg-cyan-500/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-slate-200">
          <span className="font-semibold text-cyan-100">No CT is spent to claim.</span>{' '}
          You keep this parcel by <span className="font-semibold text-cyan-100">holding{' '}
          {formatClv(requiredClv)} $CLAWVILLE</span> in your linked wallet, plus a weekly upkeep of{' '}
          <span className="font-semibold text-cyan-100">
            {upkeep != null ? `${upkeep.toLocaleString()} CT` : 'CT (stamped at claim)'}
          </span>{' '}
          auto-charged from your balance — like rent. If the upkeep can’t be paid or your
          $CLAWVILLE drops below the hold, you get a short grace window — then the parcel is{' '}
          <span className="font-semibold text-amber-200">evicted</span> and returns to the
          pool (your build is preserved).
        </p>

        {error && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <RpgButton size="sm" variant="ghost" className="min-h-[44px]" onClick={onClose} disabled={claiming}>
            Cancel
          </RpgButton>
          {linked ? (
            <RpgButton
              size="sm"
              variant="primary"
              className="min-h-[44px]"
              onClick={handleClaim}
              loading={claiming}
            >
              Claim · hold {formatClv(requiredClv)} $CLAWVILLE
            </RpgButton>
          ) : (
            <RpgButton size="sm" variant="primary" className="min-h-[44px]" onClick={onRequestWalletLink}>
              Link a wallet
            </RpgButton>
          )}
        </div>
      </div>
    </RpgModal>
  );
}

// ---------------------------------------------------------------------------
// Starter claim confirm modal — deposit-escrow (Phase B1)
// ---------------------------------------------------------------------------

/**
 * One distinct message per claim-starter error code (contract: land.ts
 * claim-starter route). NOTE `already_owned` is NOT an error — the route
 * replies 200 `{ parcel, alreadyOwned: true }` and NEVER re-charges, so the
 * success path handles it. Switch on errCode() output; never prose-match.
 */
function starterClaimErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case 'insufficient_clawtokens':
      return `You need ${LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT for the refundable deposit — top up and try again.`;
    case 'no_starter_available':
      return 'All Starter Coves are taken right now — check back soon.';
    default:
      if (status === 401) return 'Log in to claim a home.';
      return 'Couldn’t claim a Starter Cove — try again.';
  }
}

/**
 * Starter deposit-claim confirm (mirrors ClaimHoldModal/BuyModal). PARCEL-
 * AGNOSTIC: `POST /api/land/claim-starter` takes NO body/parcelId — the
 * server AUTO-PICKS an available starter (SKIP LOCKED), so the modal
 * discloses the auto-assignment instead of implying the user picked a lot.
 * The LAND_STARTER_DEPOSIT_CT (2000) CT deposit is REFUNDABLE escrow, NOT a
 * purchase: LAND_STARTER_RENT_CT_WEEKLY (100) CT/week upkeep auto-draws from
 * it, `release` refunds the remainder, and exhaustion → grace → the cove is
 * released with the remaining deposit forfeited. No client amount is ever
 * sent — the server derives everything.
 */
function StarterClaimModal({
  clawTokens,
  onClose,
  onClaimed,
}: {
  clawTokens: number;
  onClose: () => void;
  onClaimed: () => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useGameStore((s) => s.addToast);
  const tooPoor = clawTokens < LAND_STARTER_DEPOSIT_CT;

  const handleClaim = async () => {
    setClaiming(true);
    setError(null);
    try {
      // NO body — the server auto-assigns an available starter parcel.
      const res = await api.claimStarterPlot();
      // HONEST success copy: a refundable deposit was escrowed — never "free".
      addToast(
        '🏡',
        res.alreadyOwned
          ? `You already have your Starter Cove (${res.parcel.parcelCode}).`
          : `Claimed ${res.parcel.parcelCode} — your Starter Cove! ${LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT is held as a refundable deposit.`,
      );
      onClaimed();
    } catch (err) {
      const { code, status } = errCode(err);
      setError(starterClaimErrorMessage(code, status));
      setClaiming(false);
    }
  };

  return (
    <RpgModal open onClose={onClose} title="Claim a Starter Cove" subtitle="Your first home" tier="rare" maxWidth={440}>
      <div className="space-y-4 p-1">
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-cyan-100">
              Starter Cove
            </span>
            <TierBadge tier="starter" />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-200">Refundable deposit</span>
            <span className="font-mono font-bold text-amber-300">
              {LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-slate-200">Weekly upkeep</span>
            <span className="font-mono font-bold text-cyan-200">
              {LAND_STARTER_RENT_CT_WEEKLY.toLocaleString()} CT
              <span className="font-normal text-slate-300"> / week, from the deposit</span>
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-slate-200">Your balance</span>
            <span className={`font-mono font-bold ${tooPoor ? 'text-amber-200' : 'text-cyan-200'}`}>
              {clawTokens.toLocaleString()} CT
            </span>
          </div>
        </div>

        {/* The deposit terms, honestly — escrow, not a purchase, never "free". */}
        <p className="rounded-lg border border-cyan-400/15 bg-cyan-500/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-slate-200">
          <span className="font-semibold text-cyan-100">
            An available Starter Cove is assigned to you
          </span>{' '}
          (you don’t pick a specific lot). The{' '}
          <span className="font-semibold text-cyan-100">
            {LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT deposit is refundable
          </span>{' '}
          — held in escrow, not a purchase: release the cove and you get back whatever
          upkeep hasn’t already drawn. A weekly upkeep of{' '}
          <span className="font-semibold text-cyan-100">
            {LAND_STARTER_RENT_CT_WEEKLY.toLocaleString()} CT
          </span>{' '}
          auto-draws from the deposit. Running low? Top it up from My Land. If it can’t
          cover a week you get a short grace window — then the cove is{' '}
          <span className="font-semibold text-amber-200">
            released and the remaining deposit is forfeited
          </span>
          .
        </p>

        {error && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <RpgButton size="sm" variant="ghost" className="min-h-[44px]" onClick={onClose} disabled={claiming}>
            Cancel
          </RpgButton>
          <RpgButton
            size="sm"
            variant="primary"
            className="min-h-[44px]"
            onClick={handleClaim}
            loading={claiming}
            disabled={tooPoor}
          >
            {tooPoor
              ? 'Need more CT'
              : `Claim · ${LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT deposit`}
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
  spawnPreference,
  homeParcelId,
  settingSpawn,
  onSetSpawn,
  onClaim,
  onBuild,
}: {
  parcels: LandParcelDTO[];
  structures: LandStructureDTO[];
  loading: boolean;
  hasAvatar: boolean;
  spawnPreference: 'home' | 'town';
  homeParcelId: string | null;
  settingSpawn: boolean;
  onSetSpawn: (mode: 'home' | 'town', parcelId?: string) => void;
  /** Opens the StarterClaimModal confirm — the claim itself happens there. */
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

  // Whether the home spawn is currently a parcel the player still owns. If the
  // stored homeParcelId isn't in the owned set (sold / transferred), treat the
  // spawn as effectively town so the "Spawn at Town Center" revert reads right.
  const homeIsOwned = spawnPreference === 'home' && parcels.some((p) => p.id === homeParcelId);

  return (
    <div>
      {/* Claim-your-first-home CTA — prominent when the player owns nothing.
          HONEST deposit terms (§18b.j B1): NOT free — a refundable 2000 CT
          deposit held in escrow, 100 CT/week upkeep auto-drawn from it. The
          button only OPENS the StarterClaimModal confirm (no silent charge). */}
      <div className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
        <div className="flex flex-col gap-1">
          <span className="font-clawville text-sm text-emerald-100">
            🏡 Claim your first home
          </span>
          <span className="text-[12px] leading-relaxed text-slate-200">
            Claim a Starter Cove with a refundable{' '}
            <span className="font-semibold text-emerald-200">
              {LAND_STARTER_DEPOSIT_CT.toLocaleString()} CT deposit
            </span>{' '}
            ({LAND_STARTER_RENT_CT_WEEKLY.toLocaleString()} CT/week upkeep draws from
            it; release refunds the rest). Build a basic home or shop (up to Lv2);
            claim a higher tier later for premium buildings.
          </span>
        </div>
        <RpgButton
          size="sm"
          variant="primary"
          rarity="uncommon"
          onClick={onClaim}
          className="mt-3 min-h-[44px]"
        >
          {parcels.length > 0 ? 'Claim a Starter Cove (if available)' : 'Claim your first home'}
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
                  <span className="font-mono font-semibold text-cyan-100">
                    {parcels.find((p) => p.id === homeParcelId)?.parcelCode ?? 'your home'}
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
          You don&apos;t own any parcels yet. Claim your first home above (refundable
          deposit), or claim a higher tier in For&nbsp;Sale.
        </p>
      ) : (
        <div className="max-h-[44vh] space-y-2 overflow-y-auto pr-1">
          {parcels.map((p) => {
            const struct = structByParcel.get(p.id);
            const isSpawnHere = homeIsOwned && homeParcelId === p.id;
            return (
              <div
                key={p.id}
                className="flex flex-col gap-2 rounded-xl border border-cyan-400/15 bg-cyan-500/[0.04] p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-100">
                      {p.parcelCode}
                    </span>
                    <TierBadge tier={p.tier} />
                    {isSpawnHere && (
                      <span className="inline-flex items-center rounded-full border border-cyan-300/40 bg-cyan-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-100">
                        🧭 Spawn here
                      </span>
                    )}
                  </div>
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
                  >
                    {isSpawnHere ? 'Spawn point ✓' : 'Set as spawn point'}
                  </RpgButton>
                  <RpgButton size="sm" variant="secondary" onClick={() => onBuild(p)}>
                    {struct ? 'Manage' : 'Build'}
                  </RpgButton>
                </div>
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
    case 'self_purchase':
      return 'You can’t buy your own listing.';
    case 'listing_not_active':
      return 'This listing was paused or removed.';
    case 'insufficient_clawtokens':
      return `Not enough ClawTokens — need ${priceCt.toLocaleString()}, you have ${have.toLocaleString()}.`;
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
      addToast('🛍️', `Bought "${listing.title}" for ${res.priceCt.toLocaleString()} CT!`);
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
            <span className="font-mono font-bold text-amber-300">{listing.priceCt.toLocaleString()} CT</span>
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
            {clawTokens < listing.priceCt ? 'Need more CT' : `Buy for ${listing.priceCt.toLocaleString()} CT`}
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
          {listing.priceCt.toLocaleString()} CT
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
        goods, one-off favors. Buying settles CT{' '}
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
      setError('Price must be a whole number between 0 and 1,000,000 CT.');
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
          {listing.priceCt.toLocaleString()} CT
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
            placeholder="Price (CT)"
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
      setFormError('Price must be a whole number between 0 and 1,000,000 CT.');
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
            placeholder="Price (CT)"
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
  const clearLandOfficeFocus = useGameStore((s) => s.clearLandOfficeFocus);
  const setStoreParcels = useLandStore((s) => s.setParcels);
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();
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
  // Starter deposit-claim confirm (parcel-agnostic — claim-starter auto-picks).
  // Buy-outright was REMOVED with the rest of the dead /buy path: every tier
  // now acquires via Claim (starter → deposit-escrow, c/b/a/founder → CLV
  // hold), so no ParcelCard renders a Buy button and there is no buyTarget.
  const [starterClaimOpen, setStarterClaimOpen] = useState(false);
  const [claimTarget, setClaimTarget] = useState<LandParcelDTO | null>(null);
  const [buildParcel, setBuildParcel] = useState<LandParcelDTO | null>(null);

  // Hold-to-keep qualification (Phase B2): the linked wallet + its CLV balance,
  // read via the wallet-visibility-ui team's shared hook (['wallet-link'] cache,
  // deduped across the HUD wallet chip + here). `heldClv` collapses to the
  // spendable-for-qualification number: the CLV uiAmount only when a wallet is
  // linked AND the on-chain read succeeded — else null (→ "Link a wallet" /
  // "can't verify" paths). No per-card fetch; the hook is cached.
  const { linked: walletLinked, clvUiAmount, clvAvailable } = useWalletLink();
  const heldClv = walletLinked && clvAvailable ? clvUiAmount : null;

  // Σ of the caller's EXISTING hold thresholds — thresholds STACK server-side,
  // so a new claim requires (this sum + the new tier's threshold) CLV. Prefer
  // the server-stamped holdThresholdCt (mirrors the server's SUM exactly);
  // derive from tier as a fallback. See stackedRequiredClv for the
  // grandfathered caveat (DTO has no `grandfathered` flag).
  const existingHoldSum = useMemo(
    () =>
      myParcels.reduce(
        (sum, p) =>
          p.tenure === 'hold'
            ? sum + (p.holdThresholdCt ?? holdThresholdForTier(p.tier) ?? 0)
            : sum,
        0,
      ),
    [myParcels],
  );

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
    } catch {
      /* leave prior state on transient error */
    } finally {
      setMyLoading(false);
    }
  }, [hasAvatar, setStoreParcels]);

  // On open: load my land + hydrate the overlay. If opened with a focus parcel,
  // auto-switch to the For-Sale tab so the highlighted card is visible.
  useEffect(() => {
    if (!open) return;
    refreshMyLand();
    hydrateOverlay(avatarId);
    if (focusParcelCode) {
      setTab('for-sale');
    }
    // focusParcelCode intentionally excluded from deps — we only want this to
    // react to the open event, not to every focus change. Tab auto-switch on
    // each new open is the correct semantic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refreshMyLand, hydrateOverlay, avatarId]);

  // Helper — invalidate the world parcel query so LandStateHydrator refetches
  // and the 3D scene reflects the new ownership without a page reload.
  const invalidateLandState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY });
  }, [queryClient]);

  // Starter claim success — MIRRORS handleClaimedHold exactly: the WORLD↔DB↔UI
  // parity path (the auto-assigned starter flips available→owned; its in-world
  // FOR-SALE sign vanishes; My Land shows it). The claim itself (POST
  // /api/land/claim-starter, the 2000 CT deposit debit) happens inside
  // StarterClaimModal behind an explicit confirm — the old top-level silent
  // charge with "free" copy is gone.
  const handleStarterClaimed = async () => {
    setStarterClaimOpen(false);
    await refreshMyLand();
    await hydrateOverlay(avatarId);
    invalidateLandState();
    setTab('my-land');
  };

  // Claim (hold-to-keep) success — WORLD↔DB↔UI parity path (modal list + 3D
  // FOR-SALE sign + My Land all flip together). refreshMyLand also updates
  // existingHoldSum for the next claim.
  const handleClaimedHold = async () => {
    setClaimTarget(null);
    await refreshMyLand();
    await hydrateOverlay(avatarId);
    invalidateLandState();
    setTab('my-land');
  };

  // WALLET SEAM: open the wallet-visibility-ui team's link modal (mounted
  // top-level in /game; we mount nothing). Close our claim modal first so the
  // wallet modal is the sole foreground — the user links, reopens, and the
  // ['wallet-link'] cache refresh flips `linked`/`heldClv` here automatically.
  const openWalletLink = useGameStore((s) => s.openWalletLink);
  const handleRequestWalletLink = useCallback(() => {
    setClaimTarget(null);
    openWalletLink();
  }, [openWalletLink]);

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
          <TabButton label="🛍️ Services" active={tab === 'services'} onClick={() => setTab('services')} />
        </div>

        {tab === 'for-sale' && (
          <ForSaleTab
            onClaim={setClaimTarget}
            onClaimStarter={() => setStarterClaimOpen(true)}
            heldClv={heldClv}
            existingHoldSum={existingHoldSum}
            focusParcelCode={focusParcelCode}
            onFocusConsumed={clearLandOfficeFocus}
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
            onClaim={() => setStarterClaimOpen(true)}
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
        {tab === 'services' && (
          <ServicesTab hasAvatar={hasAvatar} avatarId={avatarId} clawTokens={clawTokens} shops={myShops} />
        )}
      </RpgModal>

      {claimTarget && (
        <ClaimHoldModal
          parcel={claimTarget}
          linked={walletLinked}
          heldClv={heldClv}
          existingHoldSum={existingHoldSum}
          onClose={() => setClaimTarget(null)}
          onClaimed={handleClaimedHold}
          onRequestWalletLink={handleRequestWalletLink}
        />
      )}

      {starterClaimOpen && (
        <StarterClaimModal
          clawTokens={clawTokens}
          onClose={() => setStarterClaimOpen(false)}
          onClaimed={handleStarterClaimed}
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
