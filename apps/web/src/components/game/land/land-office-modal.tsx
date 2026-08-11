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

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
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
// Dependency-light module (no `three` / R3F imports) — safe in this modal.
import { requestLandStructuresRefresh } from '@/lib/land-query-keys';
import { openLotStatusLine, parcelDoorModel } from '@/lib/land-tenure-doors';
import { yardPieceCostLine } from '@/lib/land-yard-editor';
import GuestLandSandbox from './guest-land-sandbox';
import { StructureAppearancePicker } from './structure-appearance-picker';
import {
  AvailableParcelCard,
  LAND_AVAILABLE_PARCELS_KEY,
  LandTenureForSalePanel,
  OwnedTenureControls,
  WalletDeclaration,
  landHoldSum,
  useLandHoldWalletStatus,
} from './tenure-office-panels';
import type {
  LandParcelDTO,
  LandStructureDTO,
  LandCatalogTierResponse,
  LandHoldWalletStatus,
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

/**
 * The owner's portfolio read (`GET /api/land/me`). A TanStack query so the
 * focused single-parcel panel and the My Land tab subscribe to ONE owned-state
 * source. See the queryFn in LandOfficeModal — it carries the load-bearing
 * `setStoreParcels` world-parity write.
 *
 * IDENTITY-SCOPED (2026-08-10). The key used to be the bare `['land-my-land']`
 * while the queryFn CLOSED OVER `avatarId`, which is a private read filed under
 * a shared name: avatar B could be served avatar A's cached portfolio before
 * its own read landed. The avatar id is part of the key now, so the two reads
 * are different cache entries and B starts from `undefined`, never from A's
 * rows. (The in-flight half of the same problem is handled inside the queryFn,
 * which re-checks the live identity before it touches the world store.)
 *
 * ONE CONTRACT PER KEY: this key is used by exactly one `useQuery`, in
 * `LandOfficeModal`. A second observer supplying a different queryFn would
 * decide which side effect runs by mount order — do not add one.
 */
const MY_LAND_QUERY_KEY_ROOT = 'land-my-land' as const;

function myLandQueryKey(avatarId: string | null) {
  return [MY_LAND_QUERY_KEY_ROOT, avatarId] as const;
}

/**
 * Stable empty fallbacks for the portfolio query. Module-level so an un-resolved
 * read does not hand a FRESH array to memo/effect deps on every render.
 */
const EMPTY_PARCELS: LandParcelDTO[] = [];
const EMPTY_STRUCTURES: LandStructureDTO[] = [];

// ── Guidance copy (shared by the My Land row and the focused panel) ─────────
// Plain language, no em dashes, vCLAW for the in-game currency.

/**
 * What Build/Manage and Decorate each do, once a building stands on the lot,
 * INCLUDING what a yard piece costs. The price differs between a home yard and
 * a shop yard, so it is derived per structure (see `yardPieceCostLine`) rather
 * than written as a constant. Without it nothing told a player the price until
 * they had already walked over and opened the editor.
 */
function ownedActionHintBuilt(structureType: 'home' | 'shop'): string {
  return `Manage changes or upgrades the building. Decorate opens the yard editor for fences, paths and props while you stand on the lot. ${yardPieceCostLine(structureType)}`;
}
/** Same, for an owned lot with nothing on it yet. */
const OWNED_ACTION_HINT_EMPTY =
  'Build places your first home or shop here. Decorate unlocks once a building stands on the lot.';
/** Fired when an owner presses Decorate from a menu while standing elsewhere. */
const DECORATE_WALK_HINT = 'Walk to your lot to decorate your yard.';
/**
 * Fired when an owner presses Decorate ON their lot but the PUBLIC structure
 * feed has not caught up yet. That feed (`StructureHydrator`, 60s poll) is what
 * the yard editor reads for the building's type and level, so opening the
 * editor without it would quote the wrong price, offer a rail the server
 * refuses, and show the wrong piece cap.
 */
const DECORATE_SYNC_HINT =
  'Your building is still syncing. Try Decorate again in a moment.';
/** Shown on the Build tab before an owned lot has been picked. */
const BUILD_TAB_HINT = 'Pick one of your lots in My Land first.';
/** Follow-on pointer after a successful first placement. */
const BUILT_NEXT_STEP_HINT =
  'Next: walk to your lot and use Decorate to lay out fences, paths and props.';

/**
 * Why a press inside this modal did nothing, shown INLINE next to the control
 * that was pressed. A toast alone is not enough ANYWHERE in here: the toast
 * host sits at `z-index: 50` and this modal is a full-screen `z-index: 100`,
 * so feedback fired from inside renders UNDERNEATH the thing that fired it,
 * and on touch there is no `title` hover to fall back on either.
 *
 * `anchor` names the control the note belongs to. Two namespaces share it and
 * cannot collide: a parcelCode (always `parcel-<tier>-<NN>`, see
 * packages/shared land-tiers.ts) for the per-lot Decorate buttons, and the
 * `tab:` constant below for the tab strip. One note at a time is deliberate —
 * it answers the LAST press, so a stale note never sits next to a control the
 * player has moved on from.
 *
 * Named `InlineNotice` rather than `DecorateNotice` since 2026-08-10: the
 * always-visible Build tab uses the same mechanism, and a second notice
 * mechanism for the same problem is how the two drift apart.
 */
interface InlineNotice {
  readonly anchor: string;
  readonly message: string;
}

/** Inline amber note under one control. Light text on a dark panel. */
function InlineNoticeLine({
  notice,
  anchor,
}: {
  notice: InlineNotice | null;
  anchor: string;
}) {
  if (!notice || notice.anchor !== anchor) return null;
  return (
    <p role="status" className="mt-2 w-full basis-full text-[11px] leading-relaxed text-amber-200">
      {notice.message}
    </p>
  );
}

/**
 * Anchor for the Build tab's "pick a lot first" note. `basis-full` inside the
 * tab strip's `flex flex-wrap` puts it on its own line directly under the tabs.
 */
const BUILD_TAB_NOTICE_ANCHOR = 'tab:build';

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
  'Sign up to own real land. You’re browsing as a guest, so this is the demo sandbox.';

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
  onDecorate,
  notice,
  isMobile,
  holdWallet,
  onTenureChanged,
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
  /**
   * Opens the in-world yard editor for an owned parcel that already carries a
   * structure. The proximity rule (and the "walk to your lot" toast) lives in
   * the parent so both this row and the focused panel behave identically.
   */
  onDecorate: (parcel: LandParcelDTO) => void;
  /** Inline "why that press did nothing" note, anchored to one control. */
  notice: InlineNotice | null;
  isMobile: boolean;
  holdWallet: import('./types').LandHoldWalletStatus | undefined;
  onTenureChanged: () => Promise<void> | void;
}) {
  // NOTE (2026-08-10): this tab used to take a `focusParcelCode` and scroll a
  // ringed card into view. That is now DEAD by construction — the tab strip
  // only renders when there is NO focus (a focused open renders
  // <FocusedParcelPanel/> instead), so the prop was permanently null. Removed
  // rather than left in place, so the next editor does not "fix" a focus
  // highlight that nothing can ever reach.
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
  const homeParcel = homeIsOwned ? parcels.find((p) => p.id === homeParcelId) : undefined;

  return (
    <div>
      {/* Every acquisition CTA leads to the specific-parcel two-door flow. */}
      <div className="mb-4 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
        <div className="flex flex-col gap-1">
          <span className="font-clawville text-sm text-emerald-100">
            🏡 Choose how to hold your next parcel
          </span>
          {/* No tier list and no numbers here on purpose: For Sale derives the
              real doors and the real amounts per tier from the shared tenure
              tables, and a second hand-typed summary is how the two drift. */}
          <span className="text-[12px] leading-relaxed text-slate-200">
            Open For Sale to choose a specific parcel. Each lot shows the doors it
            offers: a rent-free $CLAWVILLE hold, prepaid vCLAW rent, or both.
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
            return (
              <div
                key={p.id}
                className={`flex flex-wrap gap-2 rounded-xl border border-cyan-400/15 bg-cyan-500/[0.04] ${isMobile ? 'flex-col p-3' : 'flex-row items-start justify-between p-4'}`}
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
                      : 'Empty lot. Nothing built yet.'}
                  </div>
                  {/* What each button on this row actually does, plus what a
                      yard piece costs on THIS structure type. */}
                  <p className="mt-1 max-w-[46ch] text-[11px] leading-relaxed text-slate-200">
                    {struct
                      ? ownedActionHintBuilt(struct.structureType)
                      : OWNED_ACTION_HINT_EMPTY}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                  {/* "Manage building" here, not bare "Manage": the in-world
                      pill's Manage means "open the Land Office on this lot",
                      and this one means "open the Build tab". Same word, two
                      destinations, so both now say where they go. */}
                  <RpgButton size="sm" variant="secondary" className="min-h-[44px]" onClick={() => onBuild(p)}>
                    {struct ? 'Manage building' : 'Build here'}
                  </RpgButton>
                  {/* Second entry point to the yard editor. Until now the ONLY
                      way in was the in-world proximity pill, so an owner
                      reading their portfolio could never find it. */}
                  {struct && (
                    <RpgButton size="sm" variant="secondary" className="min-h-[44px]" onClick={() => onDecorate(p)}>
                      Decorate yard
                    </RpgButton>
                  )}
                  <InlineNoticeLine notice={notice} anchor={p.parcelCode} />
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
      return 'That building isn’t allowed on this tier. Buy a higher tier to unlock it.';
    case 'structure_exists':
      return 'This parcel already has a building.';
    case 'not_parcel_owner':
      return 'You don’t own this parcel.';
    case 'parcel_not_found':
      return 'That parcel no longer exists.';
    case 'invalid_catalog_key':
      return 'That building isn’t available. Pick another.';
    default:
      if (status === 401) return 'Log in to build.';
      return 'Could not place the building. Try again.';
  }
}

function upgradeErrorMessage(code: string | undefined, status: number | undefined, maxLevel: number): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'tier_max_level':
    case 'max_level_reached':
      return `This tier caps at Lv${maxLevel}. Buy a higher tier to build bigger.`;
    case 'insufficient_clawtokens':
      return 'Not enough vCLAW for this upgrade.';
    // The upgrade route checks ownership of the STRUCTURE, not the parcel.
    case 'not_structure_owner':
    case 'not_parcel_owner':
      return 'You don’t own this structure.';
    case 'structure_not_found':
      return 'That structure no longer exists. Reopen the panel.';
    case 'ownership_desync':
      return 'Ownership changed. Reopen the panel and try again.';
    case 'idempotency_key_conflict':
      return 'That upgrade is already processing. Give it a moment.';
    case 'idempotency_key_required':
      return 'Upgrade request was malformed. Try again.';
    default:
      if (status === 401) return 'Log in to upgrade.';
      return 'Upgrade failed. Try again.';
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
      setError('Could not load the build catalog. Try again.');
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
      // Point at the next step. The yard editor is the least discoverable part
      // of the land loop, so say it out loud the moment it becomes reachable.
      addToast('🌿', BUILT_NEXT_STEP_HINT, 6000);
      // Kick the PUBLIC structure feed (`StructureHydrator`, 60s poll). The
      // yard editor and the in-world Decorate pill both read that feed, so
      // without this the toast above points at a button that stays hidden, or
      // opens an editor with no structure to price against, for up to a minute.
      requestLandStructuresRefresh();
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
      // Same reason as placement: the public feed carries the LEVEL the yard
      // editor derives its piece caps, stacking rules and reserved shell from.
      // A stale level shows the old cap and the old "stacking unlocks at" line.
      requestLandStructuresRefresh();
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
    ? `Founders’ Row: premium buildings, and upgrades all the way to Lv${catalog.maxLevel}.`
    : `${tierLabel(parcel.tier)}: buildings up to Lv${catalog.maxLevel}. Higher tiers unlock nicer buildings and higher levels.`;

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
      return `Not enough vCLAW. You need ${priceCt.toLocaleString()} and have ${have.toLocaleString()}.`;
    case 'idempotency_key_conflict':
      return 'That purchase is already processing. Give it a moment.';
    case 'listing_not_found':
      return 'That listing no longer exists.';
    default:
      if (status === 401) return 'Log in to buy a service.';
      return 'Purchase failed. Try again.';
  }
}

function serviceListErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'not_a_shop':
      return 'Only a shop can list services. Build a shop first.';
    case 'structure_archived':
      return 'That structure is no longer active.';
    case 'not_structure_owner':
      return 'You don’t own that shop.';
    case 'ownership_desync':
      return 'Ownership changed. Reopen the panel and try again.';
    case 'listing_cap_reached':
      return `This shop already has the maximum of ${LAND_SERVICES_MAX_ACTIVE_LISTINGS} active listings.`;
    case 'structure_not_found':
      return 'That shop no longer exists.';
    default:
      if (status === 401) return 'Log in to list a service.';
      return 'Could not list the service. Try again.';
  }
}

function serviceUpdateErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case 'guest_not_allowed':
      return GUEST_NOT_ALLOWED_MSG;
    case 'not_listing_owner':
      return 'You don’t own that listing.';
    case 'listing_not_found':
      return 'That listing no longer exists. Refresh and try again.';
    // Re-activating a paused listing can exceed the active cap if the server
    // enforces it on the PATCH path — surface it clearly (harmless otherwise).
    case 'listing_cap_reached':
      return `This shop already has the maximum of ${LAND_SERVICES_MAX_ACTIVE_LISTINGS} active listings. Pause another first.`;
    default:
      if (status === 401) return 'Log in to manage listings.';
      return 'Could not update the listing. Try again.';
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
        <p className="font-mono text-xs text-rose-300">Could not load services. Try again.</p>
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
        Services other players (and agents) are running out of their shops: coaching, crafted
        goods, one-off favors. Buying settles vCLAW{' '}
        <span className="font-semibold text-cyan-200">directly to the seller</span>, no house rake.
      </p>
      {listings.length === 0 ? (
        <p className="rounded-lg border border-cyan-400/10 bg-cyan-500/[0.03] px-3 py-6 text-center font-mono text-[11px] text-slate-400">
          No services listed yet. Be the first to run a store in Build → Shop.
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
          <p className="font-mono text-[11px] text-rose-300">Could not load your listings. Try again.</p>
          <RpgButton size="sm" variant="secondary" onClick={() => query.refetch()} className="mt-3">
            Retry
          </RpgButton>
        </div>
      ) : listings.length === 0 ? (
        <p className="rounded-lg border border-cyan-400/10 bg-cyan-500/[0.03] px-3 py-4 text-center font-mono text-[11px] text-slate-400">
          No listings yet. Use the form above.
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
// Focused single-parcel panel (land UX legibility pass, 2026-08-10)
//
// When the player arrives from a specific lot (the proximity pill / minimap
// calls `openLandOffice(parcelCode)`), showing four tabs and a long list is the
// wrong answer to "what can I do with THIS lot". This panel replaces the tab
// strip with the one parcel they asked about, in the state it is actually in.
//
// Before this existed a focus code that was neither owned-by-me nor currently
// available rendered NOTHING at all — the worst case of the three.
//
// JOIN RULE (T1): every lookup here joins on `parcelCode`. `LandParcelDTO.id`
// is the DB uuid and is NEVER the join key; `useLandStore.parcels` is keyed by
// parcelCode. Owner structures are the one exception and join
// `structure.parcelId === parcel.id` INSIDE the owner payload, exactly as the
// My Land row does.
// ---------------------------------------------------------------------------

/**
 * How the focused parcel resolves against the three reads we have.
 * `unresolved` = a read failed, hung, contradicted another read, or the acting
 * identity is unknown — so we say so and offer a retry instead of sitting on a
 * loading line forever or claiming the lot is closed.
 * `no-doors` = the lot is open, but its tier offers no way in.
 */
type FocusState =
  | 'mine'
  | 'available'
  | 'no-doors'
  | 'taken'
  | 'reserved'
  | 'loading'
  | 'unresolved'
  | 'unknown';

/**
 * How long the panel may sit on "checking" before it stops waiting and offers
 * the retry UI instead. A read that never settles used to leave an owned panel
 * on "Confirming" forever with no control to press.
 */
const EVIDENCE_TIMEOUT_MS = 15_000;

/**
 * True once `active` has been continuously true for `EVIDENCE_TIMEOUT_MS`.
 * Resets whenever `active` clears or the panel moves to another parcel.
 */
function useWaitTimedOut(active: boolean, resetKey: string): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!active) {
      setTimedOut(false);
      return;
    }
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), EVIDENCE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [active, resetKey]);
  return timedOut;
}

function FocusedParcelPanel({
  parcelCode,
  myParcels,
  myStructures,
  myLoading,
  myFetching,
  myErrored,
  myValidated,
  viewerAvatarId,
  spawnPreference,
  homeParcelId,
  holdWallet,
  isMobile,
  onBuild,
  onDecorate,
  notice,
  onTenureChanged,
  onRetryOwned,
  onBrowseAll,
}: {
  parcelCode: string;
  myParcels: LandParcelDTO[];
  myStructures: LandStructureDTO[];
  myLoading: boolean;
  /** A portfolio read is IN FLIGHT right now (first fetch or a refetch). */
  myFetching: boolean;
  /** The owned-portfolio read settled in error (it does not retry). */
  myErrored: boolean;
  /**
   * The portfolio on screen was VALIDATED for the CURRENT identity: the last
   * read under this avatar's own query key SUCCEEDED.
   *
   * NOT "and nothing is in flight". That is the fix for the flap a live drive
   * measured: the portfolio uses `staleTime: 0`, so every window refocus starts
   * a routine background refetch, and folding `isFetching` in here disabled
   * every money button for a full round trip (149ms on a fast box, 3045ms with
   * latency injected) with no visible cause. A press landing in that window did
   * nothing at all. A background refresh over evidence we have ALREADY
   * validated is not a reason to disable a control under the player's finger;
   * a read that has never succeeded for this identity is.
   *
   * Staleness is handled where it belongs: both reads revalidate on every open,
   * a FAILED refresh flips the query to `isError` (caught by `myErrored`), a
   * contradicting world overlay forces `unresolved`, and the server re-checks
   * ownership under a row lock on every write.
   */
  myValidated: boolean;
  viewerAvatarId: string | null;
  spawnPreference: 'home' | 'town';
  homeParcelId: string | null;
  holdWallet: LandHoldWalletStatus | undefined;
  isMobile: boolean;
  onBuild: (parcel: LandParcelDTO) => void;
  onDecorate: (parcel: LandParcelDTO) => void;
  /** Inline "why that press did nothing" note, anchored to one control. */
  notice: InlineNotice | null;
  onTenureChanged: () => Promise<void> | void;
  onRetryOwned: () => void;
  onBrowseAll: () => void;
}) {
  const mine = useMemo(
    () => myParcels.find((parcel) => parcel.parcelCode === parcelCode) ?? null,
    [myParcels, parcelCode],
  );
  // Same cache entry as the For Sale browse panel (shared key) — one fetch.
  // Gated on `mine`: a lot the viewer already owns can never be in the public
  // available list, so firing this read for it is pure cost against the
  // project's #1 web-performance constraint.
  const available = useQuery({
    queryKey: LAND_AVAILABLE_PARCELS_KEY,
    queryFn: () => api.getLandParcels({ status: 'available' }),
    enabled: !mine,
    // Availability is what the claim doors SPEND against. The app-wide default
    // is a 60s staleTime, which meant this panel could enable a claim from a
    // cached row with no read of its own ever firing. Same rule as the owned
    // portfolio: revalidate on every open. The browse panel sets the same two
    // options on this key so the two observers cannot drift.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  // The world hydrator fills this for EVERY parcel, so it is how we detect a
  // lot that is in neither of our two lists (held by another resident).
  const worldState = useLandStore((s) => s.parcels.get(parcelCode) ?? null);

  const forSale = useMemo(
    () => available.data?.find((parcel) => parcel.parcelCode === parcelCode) ?? null,
    [available.data, parcelCode],
  );
  // T3: the SAME reduction the browse panel uses. A divergent stacked
  // requirement here would misinform a player about money.
  const existingHoldSum = useMemo(() => landHoldSum(myParcels), [myParcels]);
  const struct = useMemo(
    () => (mine ? myStructures.find((s) => s.parcelId === mine.id) ?? null : null),
    [mine, myStructures],
  );
  const hasLiveHold = useMemo(
    () => myParcels.some((parcel) => parcel.tenure === 'hold'),
    [myParcels],
  );

  const tier = mine?.tier ?? forSale?.tier ?? parseParcelCode(parcelCode)?.tier ?? null;
  const displayName = tier ? parcelDisplayName(parcelCode, tier) : parcelCode;
  const isSpawnHere = !!mine && spawnPreference === 'home' && homeParcelId === mine.id;

  // The acting identity. NOTHING may be concluded about who holds a lot while
  // this is unknown (see the ladder below), and nothing may be spent either.
  const identityKnown = viewerAvatarId !== null;

  // The world overlay can know the lot is OURS before the portfolio read lands.
  // Treat that gap as loading rather than flashing "held by another resident".
  const ownedByViewerInWorld =
    worldState?.status === 'owned'
    && identityKnown
    && worldState.ownerAvatarId === viewerAvatarId;

  // The public available list is EVIDENCE once its own read has SUCCEEDED. Not
  // "and is not refetching" — see the `myValidated` prop doc for why folding a
  // background refetch in here disabled money buttons on every window refocus.
  // The staleness this used to guard against is handled by the query's own
  // `staleTime: 0` + `refetchOnMount: 'always'` above.
  const availableValidated = available.isSuccess;
  // A cross-source contradiction: the world overlay states this lot is held or
  // held back while the available list still lists it as open. One of the two
  // is stale and we cannot tell which, so we must not pick a side.
  // (`ownedByViewerInWorld` is settled ABOVE this, so an `owned` here always
  // means somebody other than the viewer.)
  const worldContradictsForSale =
    worldState?.status === 'owned' || worldState?.status === 'reserved';
  // The SAME check on the owned branch, which used to skip it entirely and
  // present a portfolio row confidently however loudly the world disagreed.
  //
  // Only a POSITIVE disagreement counts: the overlay naming a DIFFERENT holder,
  // or the Land Office holding the lot back. A world `available` against a
  // portfolio `mine` is the ordinary lag right after a successful claim (the
  // public feed is invalidated asynchronously), and treating that as a
  // contradiction would flash "we could not confirm" after every claim.
  const worldContradictsMine =
    !!mine
    && (worldState?.status === 'reserved'
      || worldState?.status === 'retired'
      || (worldState?.status === 'owned'
        && worldState.ownerAvatarId !== null
        && worldState.ownerAvatarId !== viewerAvatarId));

  // The doors THIS lot offers, from the one shared model. A lot whose tier has
  // no door must never be presented as "pick a door below".
  const doors = useMemo(
    () => (forSale ? parcelDoorModel(forSale.tier, forSale.claimRentCtWeekly) : null),
    [forSale],
  );

  // "We are waiting on a read" — the input to the bounded timeout. A read that
  // never settles used to leave the panel on a spinner (or on "Confirming")
  // with nothing to press.
  //
  // The two `!validated` legs are defence in depth: today a row can only exist
  // once its own query succeeded, so they cannot fire. They are written out
  // anyway so that if either query's options change (a retry policy, a
  // placeholder, a shared cache seed) the wait and the timeout still follow the
  // validation rule instead of silently trusting whatever is in the cache.
  const waitingOnEvidence =
    myLoading
    || available.isLoading
    || (!!mine && !myValidated)
    || (!!forSale && !availableValidated)
    || (ownedByViewerInWorld && !mine);
  const waitTimedOut = useWaitTimedOut(waitingOnEvidence, parcelCode);

  // ORDER IS LOAD-BEARING. Every "we do not know yet" and "we could not find
  // out" case is settled BEFORE any statement about who holds the lot, because
  // a wrong ownership claim is the one thing this panel must never make.
  //
  // The bugs this ordering fixes:
  //   • the `taken` branch used to sit ABOVE the loading check, so while the
  //     ['avatar'] or portfolio read was still resolving the panel told the
  //     lot's actual OWNER it was "held by another resident";
  //   • the world-says-ours branch used to fall to `loading` whenever the
  //     portfolio had settled without the row, which is a spinner nothing can
  //     clear (nothing is in flight and the branch offers no retry). It now
  //     requires a read to actually be IN FLIGHT, and otherwise lands on
  //     `unresolved`, which renders Try again + Browse all;
  //   • `mine` used to outrank `myErrored`, so a RETAINED portfolio row plus a
  //     FAILED refresh read as a confident "Yours" indefinitely — the milder
  //     form of the same wrong-ownership-claim defect. An error now resolves
  //     to `unresolved` (Try again + Browse all);
  //   • `forSale` used to outrank both `available.isError` and a contradicting
  //     world overlay, so a stale browse row could offer a claim door on a lot
  //     the world already knew was taken;
  //   • a HUNG read left the panel checking forever — `waitTimedOut` now turns
  //     that into the same retryable `unresolved` UI;
  //   • an UNKNOWN acting identity could fall through to `taken`, which is how
  //     a lot's real owner got told another resident held it. `identityKnown`
  //     now gates every one of those conclusions, so that is impossible by
  //     construction rather than by branch ordering;
  //   • a `mine` row that the world overlay positively contradicted was still
  //     presented as a confident "Yours".
  //
  // The remaining "we have data but have not validated it for this identity"
  // case is NOT a spinner: the panel renders, and `settlementLock` below
  // disables every control that could SPEND against the unvalidated read.
  const state: FocusState = mine
    ? (myErrored || worldContradictsMine ? 'unresolved' : 'mine')
    : ownedByViewerInWorld
      ? (myErrored || waitTimedOut || !myFetching ? 'unresolved' : 'loading')
      : forSale
        ? (available.isError || worldContradictsForSale
            ? 'unresolved'
            : doors?.hasOpenDoor
              ? 'available'
              : 'no-doors')
        : waitTimedOut
          ? 'unresolved'
          : myLoading || available.isLoading
            ? 'loading'
            // Never tell a player a lot is closed when we simply could not read
            // it, and never state who holds it while we do not know who is
            // asking.
            : myErrored || available.isError || !identityKnown
              ? 'unresolved'
              : worldState?.status === 'owned'
                ? 'taken'
                : worldState?.status === 'reserved'
                  ? 'reserved'
                  : 'unknown';

  /**
   * Why a spend is locked, in plain words, or null when nothing is locked.
   *
   * LOCKED when: the acting identity is unknown, or the read this statement
   * rests on has NEVER succeeded for this identity and parcel.
   * NOT LOCKED when: a validated read is merely being refreshed in the
   * background. That was the measured flap, and a control under the player's
   * finger must not go dead for a routine refetch.
   */
  const settlementLock =
    !identityKnown
      ? 'Create your agent to claim and own land.'
      : state === 'mine' && !myValidated
        ? 'Confirming this lot is still yours before anything can be spent.'
        : state === 'available' && !availableValidated
          ? 'Confirming this lot is still open before anything can be spent.'
          : null;

  const retry = () => {
    void available.refetch();
    onRetryOwned();
  };

  const statusLine =
    state === 'mine'
      ? mine?.tenure === 'hold'
        ? 'Yours, held rent-free with $CLAWVILLE.'
        : mine?.tenure === 'deposit'
          ? 'Yours, on prepaid vCLAW rent.'
          : 'Yours.'
      : state === 'available' && doors
        ? openLotStatusLine(doors)
        : state === 'no-doors' && doors
          ? openLotStatusLine(doors)
          : state === 'taken'
            ? 'Held by another resident.'
            : state === 'reserved'
              ? 'Held back by the Land Office.'
              : state === 'loading'
                ? 'Checking this lot…'
                : state === 'unresolved'
                  // Covers a failed read, a hung read, an unknown identity and
                  // a world overlay we could not reconcile with the portfolio,
                  // so it must not claim any of them.
                  ? 'We could not confirm who holds this lot.'
                  : 'Not open to claim right now.';

  const closedMessage =
    state === 'taken'
      ? 'This lot is held by another resident. You cannot claim it, but plenty of other lots are open.'
      : state === 'reserved'
        ? 'This lot is held back by the Land Office and is not open to claim.'
        : state === 'no-doors'
          ? 'This lot is open, but its tier offers no way to claim it right now. Other lots do.'
          : 'This lot is not open to claim right now.';

  return (
    <section aria-label={`Parcel ${displayName}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-cyan-400/25 bg-cyan-500/[0.06] p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-clawville text-base text-cyan-50">{displayName}</span>
            {tier && <TierBadge tier={tier} />}
            {isSpawnHere && (
              <span className="inline-flex items-center rounded-full border border-cyan-300/40 bg-cyan-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-100">
                🧭 Spawn here
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-400">{parcelCode}</div>
          <div className="mt-1 text-[12px] leading-relaxed text-slate-200">{statusLine}</div>
        </div>
        <RpgButton size="sm" variant="ghost" className="min-h-[44px]" onClick={onBrowseAll}>
          Browse all parcels
        </RpgButton>
      </div>

      {state === 'mine' && mine && (
        <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/[0.04] p-4">
          <div className="font-mono text-[11px] text-slate-300">
            {struct
              ? `${struct.structureType === 'home' ? '🏠' : '🏪'} ${struct.catalogKey} · Lv${struct.level}`
              : 'Empty lot. Nothing built yet.'}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-200">
            {struct
              ? ownedActionHintBuilt(struct.structureType)
              : OWNED_ACTION_HINT_EMPTY}
          </p>
          <div className={`mt-3 flex gap-2 ${isMobile ? 'flex-col' : 'flex-row flex-wrap'}`}>
            <RpgButton
              size="sm"
              variant="primary"
              className="min-h-[44px]"
              onClick={() => onBuild(mine)}
            >
              {struct ? 'Manage building' : 'Build here'}
            </RpgButton>
            {struct && (
              <RpgButton
                size="sm"
                variant="secondary"
                className="min-h-[44px]"
                onClick={() => onDecorate(mine)}
              >
                Decorate yard
              </RpgButton>
            )}
          </div>
          {/* Why a Decorate press did nothing, said where it was pressed. The
              toast that also fires renders under this modal. */}
          <InlineNoticeLine notice={notice} anchor={parcelCode} />
          <OwnedTenureControls
            parcel={mine}
            wallet={holdWallet}
            settlementLock={settlementLock}
            onChanged={onTenureChanged}
          />
        </div>
      )}

      {state === 'available' && forSale && (
        <div>
          {/* Without this a player whose wallet is not declared reads "Declare a
              hold wallet first." with nowhere in this view to declare it.
              `requirementTier` names THIS lot's tier and its real threshold and
              `existingHoldSum` stacks it, so the balance line measures against
              exactly what the Claim button gates on — it used to compare the
              wallet against this tier alone and could show green directly above
              a disabled "N CLV short." button.
              Only rendered when this lot actually HAS a hold door. */}
          {doors?.hasHoldDoor && (
            <WalletDeclaration
              status={holdWallet}
              hasLiveHold={hasLiveHold}
              requirementTier={forSale.tier}
              existingHoldSum={existingHoldSum}
            />
          )}
          {/* Mounted at a STABLE position so its idempotency-key refs survive
              every refetch (T2). Never give it a changing `key`. */}
          <AvailableParcelCard
            parcel={forSale}
            wallet={holdWallet}
            existingHoldSum={existingHoldSum}
            isMobile={isMobile}
            showHeader={false}
            settlementLock={settlementLock}
            // ORDER MATTERS: refresh the owned portfolio FIRST. `mine` wins the
            // state ladder, so the panel flips straight to "Yours". Dropping the
            // row from the available list first would leave a window where the
            // lot resolves to neither list and the player reads "not open to
            // claim" one tick after a successful claim.
            onChanged={async () => {
              await onTenureChanged();
              await available.refetch();
            }}
          />
        </div>
      )}

      {(state === 'taken' || state === 'reserved' || state === 'unknown' || state === 'no-doors') && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-400/[0.06] p-4">
          <p className="text-[12px] leading-relaxed text-amber-100">{closedMessage}</p>
          <RpgButton
            size="sm"
            variant="secondary"
            className="mt-3 min-h-[44px]"
            onClick={onBrowseAll}
          >
            Browse all parcels
          </RpgButton>
        </div>
      )}

      {state === 'unresolved' && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-400/[0.06] p-4">
          <p className="text-[12px] leading-relaxed text-amber-100">
            We could not confirm this lot&apos;s current state. Try again, or browse everything
            that is open.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RpgButton size="sm" variant="primary" className="min-h-[44px]" onClick={retry}>
              Try again
            </RpgButton>
            <RpgButton size="sm" variant="secondary" className="min-h-[44px]" onClick={onBrowseAll}>
              Browse all parcels
            </RpgButton>
          </div>
        </div>
      )}

      {state === 'loading' && (
        <p className="py-10 text-center font-mono text-xs text-slate-300">Checking this lot…</p>
      )}
    </section>
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
  const clearFocus = useGameStore((s) => s.clearLandOfficeFocus);
  const nearParcelCode = useGameStore((s) => s.nearParcelCode);
  const setStoreParcels = useLandStore((s) => s.setParcels);
  // Removal counterpart to `setParcels` — see the PARITY SWEEP note in the
  // portfolio queryFn for why a dropped entry is the only honest write there.
  const forgetStoreParcels = useLandStore((s) => s.forgetParcels);
  const enterBuildMode = useLandStore((s) => s.enterBuildMode);
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  // Kept as the whole query, not just `data`: the focused panel has to tell
  // "no avatar yet" apart from "no avatar at all", or it states who holds a lot
  // before it knows who the viewer is. `useAvatar` swallows its own errors and
  // resolves to null, so `isPending` is the only not-yet-known signal.
  const avatarQuery = useAvatar();
  const avatar = avatarQuery.data;
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
  // Acquisition is parcel-specific through the two-door For Sale panel.
  const [buildParcel, setBuildParcel] = useState<LandParcelDTO | null>(null);
  // Why a press inside this modal did nothing, rendered INLINE beside the
  // control that was pressed (a Decorate button, or the Build tab). One slot,
  // so it always answers the LAST press. See `InlineNotice`.
  const [notice, setNotice] = useState<InlineNotice | null>(null);

  // One fresh account-declared hold-wallet read is shared by the acquisition
  // cards and every owned hold card in this modal.
  const holdWallet = useLandHoldWalletStatus(open && !isGuest && hasAvatar);

  // ── Owned portfolio ──────────────────────────────────────────────────────
  // A TanStack query (was local useState) so the focused single-parcel panel
  // subscribes to owned state instead of re-fetching it.
  //
  // LOAD-BEARING SIDE EFFECT: `setStoreParcels(...)` lives INSIDE the queryFn.
  // It hydrates the 3D world's ownership overlay, so it must run on EVERY
  // network read (first fetch, refetch after a claim, window refocus). Dropping
  // it silently breaks WORLD <-> DB <-> UI parity, this domain's #1 invariant.
  //
  // `staleTime: 0` is what GUARANTEES that. A queryFn side effect does NOT run
  // when the query is served from cache, and the app-wide default is a 60s
  // staleTime (`app/providers.tsx`), so reopening the modal inside that window
  // resolved instantly from cache: no fetch, no overlay write, and a portfolio
  // up to a minute out of date. The code this replaced ran an unconditional
  // fetch from an effect on `open`, and that behaviour has to be preserved.
  //
  // Guests are excluded at the `enabled` gate: a guest gets <GuestLandSandbox/>
  // and must never touch a real land read.
  const myLandEnabled = open && !isGuest && hasAvatar;
  const myLand = useQuery({
    queryKey: myLandQueryKey(avatarId),
    queryFn: async () => {
      // The identity that ISSUED this read. The key is scoped to it, and the
      // world-store write below is re-checked against the LIVE identity, so a
      // request begun as avatar A can never repaint the world after a switch
      // to avatar B (`clearIdentityState` cancels queries, but a fetch already
      // on the wire still resolves its own promise).
      const requestAvatarId = avatarId;
      const res = await api.getMyLand();
      const record = toParcelStateRecord(res.parcels);
      // PARITY SWEEP. `setParcels` is PATCH semantics (stores/land.ts), so a
      // parcel this avatar has RELEASED keeps its stale `{owned, you}` entry in
      // the world overlay until something else overwrites it. `GET /api/land/me`
      // is `WHERE owner_avatar_id = me` with no filter or paging, so it is
      // authoritative for exactly ONE claim: a lot the overlay still credits to
      // the VIEWER that the portfolio does not list is no longer the viewer's.
      //
      // That is ALL it proves. It does NOT prove the lot is for sale: it may
      // have moved to another resident (a deed transfer, an eviction and
      // re-claim), or gone reserved or retired. Writing `available` here — as
      // this used to — paints a for-sale state onto somebody else's lot in the
      // 3D world from a client-side inference, which breaks the land domain's
      // #1 invariant (the world must agree with the database).
      //
      // So we DROP the stale viewer attribution (an absent key is the
      // hydrator's documented "unknown", which renders as its default) and let
      // the AUTHORITATIVE public feed say what the lot actually is — the
      // invalidation below forces `LandStateHydrator` to re-read it.
      const staleViewerCodes: string[] = [];
      if (requestAvatarId) {
        for (const [code, parcelState] of useLandStore.getState().parcels) {
          if (
            parcelState.status === 'owned'
            && parcelState.ownerAvatarId === requestAvatarId
            && !record[code]
          ) {
            staleViewerCodes.push(code);
          }
        }
      }
      const liveAvatarId =
        queryClient.getQueryData<{ avatar: { id?: string } | null }>(['avatar'])?.avatar?.id
        ?? null;
      if (liveAvatarId !== requestAvatarId) {
        // Identity changed while this was in flight. Return the data (the cache
        // entry is keyed to the OLD avatar, so nothing reads it) but never
        // write the shared world store on a stale identity's behalf.
        return res;
      }
      setStoreParcels(record);
      if (staleViewerCodes.length > 0) {
        forgetStoreParcels(staleViewerCodes);
        queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY });
      }
      return res;
    },
    enabled: myLandEnabled,
    // See the block above: never serve this one from cache.
    staleTime: 0,
    refetchOnMount: 'always',
    // The previous imperative fetch made exactly one attempt and kept the prior
    // state on a transient error. Keep that shape.
    retry: false,
  });
  const myParcels = myLand.data?.parcels ?? EMPTY_PARCELS;
  const myStructures = myLand.data?.structures ?? EMPTY_STRUCTURES;
  // Show the loading line only while there is nothing to show, so a background
  // refetch never blanks a list the player is already reading.
  //
  // The ['avatar'] leg is load-bearing for the focused panel: until it settles,
  // `hasAvatar` is false, so the portfolio query is not even ENABLED and every
  // owned-state signal reads empty. Treating that window as "not loading" is
  // what let the panel tell a lot's actual owner it was held by someone else.
  const myLoading =
    !isGuest
    && (avatarQuery.isPending
      || (myLandEnabled && !myLand.data && myLand.isPending));

  /**
   * The portfolio on screen was VALIDATED for the CURRENT identity.
   *
   * Two legs. The query key carries the avatar id, so `data` can only belong to
   * this avatar, and `isSuccess` means the last read under that key actually
   * landed (a retained row behind a failed refetch flips the query to
   * `isError`, which `myLand.isError` catches).
   *
   * The `!isFetching` legs this used to carry are GONE, and that is the point.
   * The portfolio uses `staleTime: 0`, so a window refocus starts a routine
   * refetch, and requiring "nothing in flight" disabled every money button for
   * that whole round trip — measured live at 149ms on a fast box and 3045ms
   * with latency injected, with no visible cause and no feedback on a press
   * that landed inside it. Validated-then-refreshing is not the same thing as
   * never-validated, and only the second is a reason to lock a spend.
   */
  const myValidated = myLandEnabled && myLand.isSuccess && !!avatarId;

  /** Refetch the portfolio (re-runs the world-overlay hydration in the queryFn). */
  const refetchMyLand = myLand.refetch;
  const refreshMyLand = useCallback(async () => {
    if (!hasAvatar) return undefined;
    const res = await refetchMyLand();
    return res.data;
  }, [hasAvatar, refetchMyLand]);

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

  // On open, hydrate the 3D ownership overlay from the public read. The owned
  // portfolio's own overlay write rides inside the query above; this adds the
  // public lookup the old Promise.all ran beside it.
  // Guests use the client-side sandbox — never touch the real land reads.
  useEffect(() => {
    if (!open || isGuest) return;
    void hydrateOverlay(avatarId);
  }, [open, isGuest, hydrateOverlay, avatarId]);

  // The inline notice answers ONE press. Drop it when the modal closes so a
  // stale "walk to your lot" is not waiting on the next open.
  useEffect(() => {
    if (!open) setNotice(null);
  }, [open]);

  // Resolve the focused parcel against the viewer's owned rows and pick the tab
  // the player falls back into the moment they clear the focus. (While a focus
  // is set the tab strip is replaced by the focused panel, so this is purely
  // the fallback destination.)
  useEffect(() => {
    if (!open || isGuest || !focusParcelCode) return;
    if (!myLand.data) {
      setTab('for-sale');
      return;
    }
    setTab(myLand.data.parcels.some((parcel) => parcel.parcelCode === focusParcelCode)
      ? 'my-land'
      : 'for-sale');
  }, [open, isGuest, focusParcelCode, myLand.data]);

  // Helper — invalidate the world parcel query so LandStateHydrator refetches
  // and the 3D scene reflects the new ownership without a page reload.
  const invalidateLandState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY });
  }, [queryClient]);

  // Shared post-settlement refresh for claim, prepay, and release.
  //
  // ORDER MATTERS: the owned portfolio is refreshed FIRST, so a just-claimed
  // lot resolves as "yours" before the public available list stops listing it.
  // The available-list invalidation is LAST for the same reason, and it is
  // what lets a RELEASED lot resolve back to "open to claim" instead of
  // "not open to claim right now" against a stale browse cache.
  const handleTenureChanged = async () => {
    await refreshMyLand();
    await hydrateOverlay(avatarId);
    await holdWallet.refetch();
    invalidateLandState();
    queryClient.invalidateQueries({ queryKey: LAND_AVAILABLE_PARCELS_KEY });
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
          ? 'You don’t own that parcel. Pick one you own.'
          : status === 401
            ? 'Log in to set a spawn point.'
            : 'Could not update your spawn point. Try again.';
      addToast('⚠️', msg, 4500);
    }
  };

  const openBuild = (parcel: LandParcelDTO) => {
    // A lot is picked, so the Build tab's "pick a lot first" note is answered.
    setNotice(null);
    setBuildParcel(parcel);
    setTab('build');
  };

  /**
   * Build/Manage from the FOCUSED panel. The focused panel replaces the tab
   * strip, so the focus has to clear or the Build tab it just selected would
   * stay invisible.
   */
  const openBuildFromFocus = (parcel: LandParcelDTO) => {
    clearFocus();
    openBuild(parcel);
  };

  /**
   * Yard-editor entry from a MENU (My Land row or the focused panel).
   *
   * TWO gates, and the second is money-facing:
   *
   *   1. PROXIMITY. The editor is in-world, so it only opens on the lot the
   *      player is standing on.
   *   2. PUBLIC STRUCTURE FEED. `enterBuildMode` validates nothing, and the
   *      editor derives its price, its payment rails, its piece caps and its
   *      stacking rules from `useLandStore.structures` — the PUBLIC feed, on a
   *      60s poll. Opening without it falls back to `home`/Lv1 and then quotes
   *      home prices on a shop yard (5/20 vCLAW against the 15/60 the server
   *      charges), offers the materials rail the server refuses on a shop, and
   *      shows a 6-piece cap to an upgraded building. So this checks the SAME
   *      map the in-world pill gates on (`land-options-pill.tsx`), kicks a
   *      refresh, and says to try again.
   *
   * Every refusal writes an INLINE notice as well as a toast: the toast host is
   * `z-index: 50` and this modal is `z-index: 100`, so a toast fired from in
   * here lands underneath the thing that fired it.
   */
  const handleDecorate = (parcel: LandParcelDTO) => {
    if (nearParcelCode !== parcel.parcelCode) {
      setNotice({ anchor: parcel.parcelCode, message: DECORATE_WALK_HINT });
      addToast('🌿', DECORATE_WALK_HINT, 4500);
      return;
    }
    if (!useLandStore.getState().structures.has(parcel.parcelCode)) {
      requestLandStructuresRefresh();
      setNotice({ anchor: parcel.parcelCode, message: DECORATE_SYNC_HINT });
      addToast('🌿', DECORATE_SYNC_HINT, 4500);
      return;
    }
    setNotice(null);
    close();
    enterBuildMode(parcel.parcelCode);
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
        ) : focusParcelCode ? (
          // Arrived from a specific lot: answer "what can I do with THIS lot"
          // instead of dropping the player into four tabs and a long list.
          <FocusedParcelPanel
            parcelCode={focusParcelCode}
            myParcels={myParcels}
            myStructures={myStructures}
            myLoading={myLoading}
            myFetching={myLand.isFetching || avatarQuery.isFetching}
            myErrored={myLand.isError}
            myValidated={myValidated}
            viewerAvatarId={avatarId}
            spawnPreference={spawnPreference}
            homeParcelId={homeParcelId}
            holdWallet={holdWallet.data}
            isMobile={isMobile}
            onBuild={openBuildFromFocus}
            onDecorate={handleDecorate}
            notice={notice}
            onTenureChanged={handleTenureChanged}
            onRetryOwned={() => {
              // Retry BOTH legs — the panel's own uncertainty can come from
              // either the portfolio read or the identity behind it.
              void avatarQuery.refetch();
              void refreshMyLand();
            }}
            onBrowseAll={clearFocus}
          />
        ) : (
        <>
        {/* Tabs */}
        <div className="mb-4 flex flex-wrap gap-2 border-b border-cyan-400/20 pb-3">
          <TabButton label="🏝️ For Sale" active={tab === 'for-sale'} onClick={() => setTab('for-sale')} />
          <TabButton label="🏠 My Land" active={tab === 'my-land'} onClick={() => setTab('my-land')} />
          {/* Always present, so a new owner learns building is part of the loop.
              Before a lot is picked it reads as unavailable and says what to do
              (a hard `disabled` would be silent on touch, which is the exact
              "how do I do this" failure this pass is fixing). The BODY guard
              below is unchanged, so nothing can render without a parcel.

              The hint reaches all three audiences: INLINE for touch (the toast
              renders under this modal and `title` is a hover-only affordance),
              `title` for a mouse, and `aria-describedby` for a screen reader.
              Same treatment the Decorate buttons carry. */}
          <TabButton
            label="🏗️ Build"
            active={tab === 'build' && !!buildParcel}
            muted={!buildParcel}
            hint={buildParcel ? undefined : BUILD_TAB_HINT}
            onClick={() => {
              if (!buildParcel) {
                setNotice({ anchor: BUILD_TAB_NOTICE_ANCHOR, message: BUILD_TAB_HINT });
                addToast('🏗️', BUILD_TAB_HINT, 4500);
                setTab('my-land');
                return;
              }
              setNotice(null);
              setTab('build');
            }}
          />
          <TabButton label="🛍️ Services" active={tab === 'services'} onClick={() => setTab('services')} />
          {/* `basis-full` inside this `flex flex-wrap` strip puts the note on
              its own line directly under the tabs. */}
          <InlineNoticeLine notice={notice} anchor={BUILD_TAB_NOTICE_ANCHOR} />
        </div>

        {tab === 'for-sale' && (
          <LandTenureForSalePanel
            ownedParcels={myParcels}
            isMobile={isMobile}
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
            onDecorate={handleDecorate}
            notice={notice}
            isMobile={isMobile}
            holdWallet={holdWallet.data}
            onTenureChanged={handleTenureChanged}
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

function TabButton({
  label,
  active,
  onClick,
  muted = false,
  hint,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  /**
   * PURELY VISUAL. The tab reads as not-yet-usable (muted fill) but is a
   * fully operative button: pressing it explains the next step and moves the
   * player there. It is deliberately NOT `disabled` and deliberately NOT
   * `aria-disabled` — a hard `disabled` fires no event at all, which on touch
   * means a silent dead press (the exact "how do I do this" failure this pass
   * exists to remove), and `aria-disabled` told a screen reader the control
   * was inoperable while it plainly was not.
   */
  muted?: boolean;
  /**
   * Why the tab reads as muted. Exposed to assistive tech through
   * `aria-describedby` (announced after the label, without becoming part of
   * the name) as well as to a mouse through `title`.
   */
  hint?: string;
}) {
  const hintId = useId();
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        title={hint}
        aria-describedby={hint ? hintId : undefined}
        className="min-h-[44px] rounded-lg px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-all"
        style={{
          color: muted ? '#94a3b8' : active ? '#0a1628' : '#cbd5e1',
          background: muted
            ? 'rgba(148,163,184,0.10)'
            : active
              ? '#38bdf8'
              : 'rgba(56,189,248,0.08)',
          fontWeight: active ? 700 : 600,
          // Always `pointer`: this button fires a REAL action even when it reads
          // as unavailable (it explains the next step and switches tabs), so a
          // `help` cursor would mis-signal a tooltip-only control.
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
      {/* Absolutely positioned by `sr-only`, so it is not a flex item in the
          tab strip and changes nothing visually. */}
      {hint ? (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      ) : null}
    </>
  );
}
