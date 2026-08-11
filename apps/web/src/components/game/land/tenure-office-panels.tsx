'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LAND_TIERS,
  MAX_PARCELS_PER_AVATAR,
  holdThresholdForTier,
  parcelDisplayName,
  tierLabel,
  type LandTier,
} from '@clawville/shared';
import { RpgButton } from '@/components/rpg';
import { useAvatar } from '@/hooks/use-avatar';
import { useWalletLink } from '@/hooks/use-wallet-link';
import { api, ApiError } from '@/lib/api';
import {
  parcelDoorModel,
  tierDoorSentence,
} from '@/lib/land-tenure-doors';
import {
  beginLandOperation,
  settleLandOperation,
  useLandOperationState,
  type LandOperationState,
  type LandTenureDoor,
} from '@/lib/land-tenure-operations';
import { useGameStore } from '@/stores/game';
import type { LandHoldWalletStatus, LandParcelDTO } from './types';

const HOLD_WALLET_KEY = ['land-hold-wallet'] as const;

/**
 * Shared query key for the public "available parcels" browse read. Exported so
 * the focused single-parcel panel in land-office-modal.tsx subscribes to the
 * SAME cache entry as this browse panel (one fetch, one truth) instead of
 * re-typing the string and silently forking the cache.
 */
export const LAND_AVAILABLE_PARCELS_KEY = ['land-tenure-available'] as const;

const TIER_ACCENT: Record<LandTier, string> = {
  founder: '#f5c842',
  a: '#7ecef4',
  b: '#9fc975',
  c: '#c49a6c',
  starter: '#cbd5e1',
};

function codeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code ?? error.message : undefined;
}

function formatClv(amount: number): string {
  return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-6)}`;
}

/**
 * A positive duration in the coarsest unit a player thinks in. Deliberately
 * approximate: it is read as "how urgent is this", not as a countdown.
 */
function relativeSpan(ms: number): string {
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.ceil(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'}`;
}

/**
 * The single prose map for every land-tenure machine code. Split out of
 * `tenureError` so a LOCAL, non-thrown condition (the hold-locked wallet) can
 * render the same human sentence instead of leaking a snake_case code at the
 * player. Never print a raw code: route it through here.
 */
function tenureErrorForCode(code: string | undefined): string {
  switch (code) {
    case 'wallet_not_declared': return 'Declare the wallet that will back this CLV hold first.';
    case 'wallet_locked_by_hold': return 'This wallet cannot change while an active hold parcel depends on it.';
    case 'wallet_change_requires_human': return 'An agent may declare the first wallet, but only a human session may change it.';
    case 'wallet_already_declared': return 'That wallet is already declared by another account.';
    case 'insufficient_clv_hold': return 'The declared wallet does not hold enough CLV for the stacked requirement.';
    case 'clv_balance_unavailable': return 'The live CLV balance could not be verified. Try again shortly.';
    case 'insufficient_clawtokens': return 'You do not have enough vCLAW for this action.';
    case 'parcel_not_available': return 'Someone else just claimed this parcel.';
    case 'parcel_cap_reached': return `You already hold the maximum of ${MAX_PARCELS_PER_AVATAR} parcels.`;
    // The server throws this for the RENT door on a founder lot only. Its hold
    // door is live (land-tenure-settlement.ts accepts a founder hold claim), and
    // there is no auction code path in the repo, so the old "allocated through
    // the auction" wording contradicted both the server and the Claim button
    // this modal renders. See lib/land-tenure-doors.ts.
    case 'founder_no_rent_door': return 'Founders’ Row is hold-only. There is no rent door.';
    case 'tier_not_claimable': return 'That tenure door is not available for this tier.';
    case 'not_parcel_owner': return 'This parcel is no longer owned by your active avatar.';
    case 'not_deposit_tenure': return 'Only rent-door parcels can receive prepaid rent.';
    case 'deed_locked_by_listing': return 'Remove the live deed listing before releasing this parcel.';
    case 'idempotency_key_conflict': return 'This action key belongs to an earlier parcel state. Reopen the Land Office and try again.';
    case 'autonomous_daily_cap': return 'This agent reached its autonomous daily land-spend limit.';
    default: return 'The Land Office could not complete that action. Try again.';
  }
}

function tenureError(error: unknown): string {
  return tenureErrorForCode(codeOf(error));
}

/**
 * The stacked CLV hold requirement already committed by the viewer's owned
 * parcels. Exported so the focused single-parcel panel derives it with the
 * EXACT same reduction the browse panel uses — a divergent number here would
 * misinform a player about money.
 */
export function landHoldSum(ownedParcels: LandParcelDTO[]): number {
  return ownedParcels.reduce(
    (sum, parcel) => parcel.tenure === 'hold'
      ? sum + (parcel.holdThresholdCt ?? holdThresholdForTier(parcel.tier) ?? 0)
      : sum,
    0,
  );
}

/**
 * A door's button shows a spinner while its own request is on the wire AND
 * while its CONFIRMED settlement waits for the reads to catch up. It stops
 * spinning on `unrefreshed`, where the recovery notice takes over: an
 * indefinite spinner is the exact thing that state exists to remove.
 */
function doorIsWorking(state: LandOperationState, door: LandTenureDoor): boolean {
  if (state.door !== door) return false;
  return state.phase === 'settling' || state.phase === 'refreshing';
}

/**
 * The acting avatar id — the identity every settlement operation is filed
 * under. Read from the shared `['avatar']` query, so these controls cannot
 * disagree with the Land Office about who is acting and no extra round trip is
 * added. Null means the identity is not resolved, and nothing may be spent.
 */
function useActingAvatarId(): string | null {
  const { data: avatar } = useAvatar();
  return (avatar as { id?: string } | null | undefined)?.id ?? null;
}

/**
 * The explicit way out of a settlement that CONFIRMED but whose refresh never
 * landed (`land-tenure-operations.ts` phase `unrefreshed`).
 *
 * The spend controls stay locked on purpose: the settlement went through, so
 * pressing again would mint a FRESH idempotency key and charge a second time.
 * What the player gets instead is the truth plus a way to re-run the refresh.
 */
function SettlementRecoveryNotice({
  subject,
  parcelCode,
  state,
  onChanged,
}: {
  subject: string | null;
  parcelCode: string;
  state: LandOperationState;
  onChanged: () => Promise<void> | void;
}) {
  const [retrying, setRetrying] = useState(false);
  if (!subject || state.phase !== 'unrefreshed' || state.operation === null) {
    return null;
  }
  const operation = state.operation;
  const refresh = async () => {
    setRetrying(true);
    try {
      await onChanged();
      settleLandOperation(subject, parcelCode, operation, 'refreshed');
    } catch {
      // Stay in the same state; the notice and this button remain.
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div
      role="status"
      className="mt-3 rounded-lg border border-amber-300/30 bg-amber-400/[0.08] p-3"
    >
      <p className="text-[11px] leading-relaxed text-amber-100">
        That went through. The Land Office could not refresh afterwards, so what
        you see here may be out of date. Nothing else can be spent on this lot
        until it refreshes.
      </p>
      <RpgButton
        size="sm"
        variant="secondary"
        className="mt-2 min-h-[44px]"
        onClick={refresh}
        loading={retrying}
      >
        Refresh this lot
      </RpgButton>
    </div>
  );
}

/** The "we are still checking" line, shown while a spend is locked. */
function SettlementLockLine({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <p role="status" className="mt-3 text-[11px] leading-relaxed text-amber-200">
      {reason}
    </p>
  );
}

function TierBadge({ tier }: { tier: LandTier }) {
  const accent = TIER_ACCENT[tier];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
      style={{ color: accent, borderColor: `${accent}55`, background: `${accent}18` }}
    >
      {tierLabel(tier)}
    </span>
  );
}

function WeeksSelect({ value, onChange, label }: { value: number; onChange: (weeks: number) => void; label: string }) {
  return (
    <label className="flex min-h-[44px] items-center gap-2 text-[11px] text-slate-200">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-h-[44px] rounded-lg border border-cyan-300/30 bg-slate-950 px-3 font-mono text-cyan-100"
      >
        {Array.from({ length: 26 }, (_, index) => index + 1).map((weeks) => (
          <option key={weeks} value={weeks}>{weeks}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Hold-wallet declaration. Exported so the focused single-parcel panel can show
 * it above an available parcel's hold door — without it a player who has not
 * declared a wallet reads "Declare a hold wallet first." with nowhere to do it.
 */
export function WalletDeclaration({
  status,
  hasLiveHold,
  requirementTier = 'starter',
  existingHoldSum = 0,
}: {
  status: LandHoldWalletStatus | undefined;
  hasLiveHold: boolean;
  /**
   * Which tier's hold threshold the balance line is measured against. The
   * browse panel lists every tier at once and has no single answer, so it keeps
   * the entry-tier default; the FOCUSED single-parcel panel knows exactly which
   * lot the player is looking at and passes that lot's tier, so the sentence
   * names the right tier and the right number instead of quoting Starter at
   * someone standing on a Founder lot.
   */
  requirementTier?: LandTier;
  /**
   * The stacked CLV already committed by the parcels this avatar holds.
   *
   * LOAD-BEARING (2026-08-10). This section used to colour its balance line
   * pass/fail against the FOCUSED TIER'S THRESHOLD ALONE while the claim card
   * a few pixels below required `existingHoldSum + threshold`. On a second
   * hold that reads as a green "you are fine" directly above a disabled
   * "N CLV short." button — the screen contradicting itself about money. Same
   * reduction (`landHoldSum`) both places, so they cannot diverge.
   */
  existingHoldSum?: number;
}) {
  const queryClient = useQueryClient();
  const addToast = useGameStore((state) => state.addToast);
  const { walletPubkey } = useWalletLink();
  const [wallet, setWallet] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setWallet(status?.walletAddress ?? walletPubkey ?? '');
  }, [status?.walletAddress, walletPubkey]);

  const changing = status?.walletAddress != null && wallet !== status.walletAddress;
  // Route the local lock through the SAME prose map the thrown errors use, so a
  // player never reads a snake_case machine code.
  const lockedReason = changing && hasLiveHold
    ? tenureErrorForCode('wallet_locked_by_hold')
    : null;

  // Threshold reference for the tier in scope, derived from the shared ladder
  // so the number on screen is always the real one, never hand-typed. The
  // requirement STACKS, so it is the sum of what this avatar already holds plus
  // this tier's own threshold — the exact number the claim card gates on.
  const tierHold = holdThresholdForTier(requirementTier);
  const tierName = tierLabel(requirementTier);
  const stackedRequirement = tierHold == null ? null : existingHoldSum + tierHold;
  const liveBalance = status?.balance?.available ? status.balance.uiAmount : null;
  const meetsRequirement =
    stackedRequirement != null && liveBalance != null && liveBalance >= stackedRequirement;
  const requirementSentence = tierHold == null
    ? ''
    : existingHoldSum > 0
      ? `A ${tierName} hold needs ${formatClv(stackedRequirement!)} CLV in this wallet, counting the lots you already hold.`
      : `A ${tierName} hold needs ${formatClv(tierHold)} CLV.`;
  const balanceLine = status?.walletAddress == null
    ? requirementSentence || null
    : `${liveBalance == null ? 'Live balance unavailable' : `${formatClv(liveBalance)} CLV live balance`}.${
      requirementSentence === '' ? '' : ` ${requirementSentence}`}`;

  const save = async () => {
    setSaving(true);
    try {
      await api.declareLandHoldWallet(wallet.trim());
      await queryClient.invalidateQueries({ queryKey: HOLD_WALLET_KEY });
      addToast('🔗', status?.walletAddress ? 'Land hold wallet changed.' : 'Land hold wallet declared.');
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-cyan-300/20 bg-cyan-400/[0.05] p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200">Hold wallet</div>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-200">
        This is the Solana address we read on-chain to open the rent-free hold door. It has to
        hold $CLAWVILLE, shown here as CLV.
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-200">
        We check the balance when you claim, then again every week. The requirement stacks, so
        every lot you hold this way adds its amount to the total this wallet must keep. Declaring
        is free and moves no funds.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          aria-label="Land hold wallet address"
          value={wallet}
          onChange={(event) => setWallet(event.target.value.trim())}
          className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-cyan-300/25 bg-slate-950 px-3 font-mono text-[11px] text-cyan-50"
          placeholder="Canonical Solana wallet address"
        />
        <RpgButton
          size="sm"
          variant="secondary"
          className="min-h-[44px]"
          onClick={save}
          loading={saving}
          disabled={wallet.length < 32 || !!lockedReason || wallet === status?.walletAddress}
        >
          {status?.walletAddress ? 'Change wallet' : 'Declare wallet'}
        </RpgButton>
      </div>
      {lockedReason && <p className="mt-2 text-[11px] text-amber-200">{lockedReason}</p>}
      {status?.walletAddress && (
        <p className="mt-2 font-mono text-[11px] text-slate-300">
          Declared {shortWallet(status.walletAddress)}
        </p>
      )}
      {balanceLine && (
        <p className={`mt-1 text-[11px] leading-relaxed ${meetsRequirement ? 'text-emerald-100' : 'text-amber-200'}`}>
          {balanceLine}
        </p>
      )}
    </section>
  );
}

/**
 * One available parcel's two-door claim card.
 *
 * Exported (2026-08-10) so the focused single-parcel panel REUSES it instead of
 * duplicating a money surface.
 *
 * IDEMPOTENCY LIVES OUTSIDE THIS COMPONENT (`@/lib/land-tenure-operations`).
 * It used to be a `useRef` map plus a `busy` useState, which survives a
 * re-render but not an unmount — and the focused panel and the browse list
 * mount this card at DIFFERENT places in the tree, so navigating between them
 * mid-claim handed the player a fresh key and an idle-looking button while the
 * first request was still unresolved. The registry is keyed by
 * `(acting avatar, parcelCode, semantic operation)` at module scope, so the key
 * survives the unmount and a pending claim still reads as busy on the other
 * surface, and avatar B never inherits avatar A's locks.
 *
 * DOORS COME FROM ONE MODEL (`@/lib/land-tenure-doors`). A door the tier does
 * not offer renders NO section and NO button — the hold panel used to render
 * unconditionally with a disabled Claim under it, which reads as "this exists
 * but you cannot afford it" on a tier where it does not exist at all.
 *
 * `showHeader=false` drops the internal name/tier line for callers that already
 * render one directly above the card.
 */
export function AvailableParcelCard({
  parcel,
  wallet,
  existingHoldSum,
  isMobile,
  showHeader = true,
  settlementLock = null,
  onChanged,
}: {
  parcel: LandParcelDTO;
  wallet: LandHoldWalletStatus | undefined;
  existingHoldSum: number;
  isMobile: boolean;
  showHeader?: boolean;
  /**
   * Non-null = every control that SPENDS is disabled, and this string says WHY
   * in plain words. The card still renders (so the player is not staring at a
   * spinner); a spend against evidence we have not confirmed, or without a
   * resolved identity, is exactly what the focused panel exists to prevent.
   */
  settlementLock?: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const [weeks, setWeeks] = useState(1);
  const subject = useActingAvatarId();
  // Shared across every surface that renders this parcel's controls.
  const operationState = useLandOperationState(subject, parcel.parcelCode);
  const doors = parcelDoorModel(parcel.tier, parcel.claimRentCtWeekly);
  const required = existingHoldSum + (doors.holdClv ?? 0);
  const held = wallet?.balance?.available ? wallet.balance.uiAmount : null;
  const holdReason = !wallet?.walletAddress
    ? 'Declare a hold wallet first.'
    : held == null
      ? 'Live CLV balance is unavailable.'
      : held < required
        ? `${formatClv(required - held)} CLV short.`
        : null;
  const weekly = doors.rentWeeklyCt;
  // Without an identity nothing can be filed against an avatar, so nothing may
  // be spent. Said plainly rather than through a dead disabled button.
  const lockReason = subject === null
    ? 'Create your agent to claim land.'
    : settlementLock;
  const locked = lockReason !== null || operationState.blocked;

  const claim = async (door: 'hold' | 'rent') => {
    if (!subject) return;
    // The semantic action IS the registry slot: a hold, or a rent of exactly
    // this many weeks. Same string the old ref map used, same key semantics,
    // same request body — only the storage moved out of component scope.
    const operation = door === 'hold' ? 'hold' : `rent:${weeks}`;
    const key = beginLandOperation(subject, parcel.parcelCode, operation);
    // EXIT PATHS. Success -> 'confirmed', then the refresh decides between
    // 'refreshed' and 'refresh_failed'. Every other exit (typed API error,
    // network rejection, abort) lands on 'retryable' in the `finally`, which
    // KEEPS the key and RE-ENABLES the control so a retry collapses server-side
    // instead of minting a second key.
    let confirmed = false;
    try {
      if (door === 'hold') {
        await api.claimHoldParcel(parcel.id, key);
      } else {
        await api.claimRentParcel(parcel.id, weeks, key);
      }
      confirmed = true;
      settleLandOperation(subject, parcel.parcelCode, operation, 'confirmed');
      addToast('🏝️', door === 'hold'
        ? `Claimed ${parcelDisplayName(parcel.parcelCode, parcel.tier)} through the rent-free hold door.`
        : `Rented ${parcelDisplayName(parcel.parcelCode, parcel.tier)} for ${weeks} week${weeks === 1 ? '' : 's'}.`);
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      if (!confirmed) {
        settleLandOperation(subject, parcel.parcelCode, operation, 'retryable');
      }
    }
    if (!confirmed) return;
    // The settlement is DONE. The refresh is a separate concern with its own
    // outcome, so a hung or failed refetch can never leave a settled claim
    // looking like a stuck button.
    try {
      await onChanged();
      settleLandOperation(subject, parcel.parcelCode, operation, 'refreshed');
    } catch {
      settleLandOperation(subject, parcel.parcelCode, operation, 'refresh_failed');
    }
  };

  return (
    <article className={`rounded-xl border border-cyan-300/15 bg-cyan-400/[0.04] ${isMobile ? 'p-3' : 'p-4'}`}>
      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          <span>
            <span className="block font-semibold text-cyan-50">
              {parcelDisplayName(parcel.parcelCode, parcel.tier)}
            </span>
            <span className="block font-mono text-[10px] text-slate-400">{parcel.parcelCode}</span>
          </span>
          <TierBadge tier={parcel.tier} />
        </div>
      )}
      {/* Headline banner — only ever states a door this lot actually offers.
          "CLV" is the unit beside the figure; the section above NAMES the
          token as $CLAWVILLE. */}
      <div className={`${showHeader ? 'mt-3' : ''} rounded-lg border border-emerald-300/25 bg-emerald-400/[0.08] px-3 py-2`}>
        {doors.holdClv != null && (
          <p className="font-semibold text-emerald-100">
            Hold {formatClv(doors.holdClv)} CLV, rent-free
          </p>
        )}
        {weekly != null && (
          <p className={`text-[12px] font-semibold text-amber-100 ${doors.holdClv != null ? 'mt-0.5' : ''}`}>
            {doors.holdClv != null ? 'or rent' : 'Rent'} {weekly.toLocaleString()} vCLAW/week
          </p>
        )}
        {!doors.hasOpenDoor && (
          <p className="text-[12px] font-semibold text-amber-100">
            {doors.rentQuoteMissing
              ? 'The weekly rent price for this lot is unavailable right now.'
              : 'This lot is not open to claim right now.'}
          </p>
        )}
      </div>
      {doors.hasOpenDoor && (
        <div className={`mt-3 grid gap-3 ${isMobile || doors.holdClv == null || weekly == null ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {doors.holdClv != null && (
            <section className="rounded-lg border border-emerald-300/20 bg-emerald-400/[0.05] p-3">
              <div className="font-semibold text-emerald-100">Hold door · rent-free</div>
              <p className="mt-1 text-[11px] text-slate-200">
                {formatClv(required)} CLV minimum (stacked).
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-slate-300">
                {wallet?.walletAddress ?? 'No wallet declared'} · {held == null ? 'balance unverified' : `${formatClv(held)} CLV`}
              </p>
              <RpgButton
                size="sm"
                variant="primary"
                className="mt-3 min-h-[44px] w-full"
                onClick={() => claim('hold')}
                loading={doorIsWorking(operationState, 'hold')}
                disabled={!!holdReason || locked}
              >
                Claim with hold
              </RpgButton>
              {holdReason && <p className="mt-2 text-[10px] text-amber-200">{holdReason}</p>}
            </section>
          )}
          {weekly != null && (
            <section className="rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-3">
              <div className="font-semibold text-amber-100">Rent door</div>
              <p className="mt-1 text-[11px] text-slate-200">{weekly.toLocaleString()} vCLAW/week</p>
              <WeeksSelect value={weeks} onChange={setWeeks} label="Weeks" />
              <p className="font-mono text-[11px] text-cyan-100">Total {(weekly * weeks).toLocaleString()} vCLAW</p>
              <p className="mt-1 text-[10px] text-amber-200">The first week is non-refundable. Later weeks stay refundable in escrow.</p>
              <RpgButton
                size="sm"
                variant="primary"
                className="mt-3 min-h-[44px] w-full"
                onClick={() => claim('rent')}
                loading={doorIsWorking(operationState, 'rent')}
                disabled={locked}
              >
                Rent parcel
              </RpgButton>
            </section>
          )}
          {doors.hasHoldDoor && !doors.hasRentDoor && (
            <p className="rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-100">
              {tierLabel(parcel.tier)} is hold-only. There is no rent door.
            </p>
          )}
        </div>
      )}
      <SettlementLockLine reason={operationState.blocked ? null : lockReason} />
      <SettlementRecoveryNotice
        subject={subject}
        parcelCode={parcel.parcelCode}
        state={operationState}
        onChanged={onChanged}
      />
    </article>
  );
}

/**
 * The full browse panel.
 *
 * NOTE (2026-08-10): this used to take a `focusParcelCode` and scroll a ringed
 * card into view. That is DEAD by construction now — the Land Office renders
 * this panel only when there is NO focused parcel (a focused open renders the
 * single-parcel panel instead), so the prop was permanently null. Removed
 * rather than left in place, so the next editor does not spend an afternoon
 * debugging a focus highlight nothing can reach.
 */
export function LandTenureForSalePanel({
  ownedParcels,
  isMobile,
  onChanged,
}: {
  ownedParcels: LandParcelDTO[];
  isMobile: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const parcels = useQuery({
    queryKey: LAND_AVAILABLE_PARCELS_KEY,
    queryFn: () => api.getLandParcels({ status: 'available' }),
    // Availability is what these cards SPEND against, so it is revalidated on
    // every open rather than served from the app-wide 60s cache. Same rule (and
    // the same reason) as the owned-portfolio read in land-office-modal.tsx.
    // Both observers of this key set it, so the two cannot drift.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const wallet = useQuery({ queryKey: HOLD_WALLET_KEY, queryFn: api.getLandHoldWallet, retry: false });
  const existingHoldSum = useMemo(() => landHoldSum(ownedParcels), [ownedParcels]);
  const available = parcels.data ?? [];

  if (parcels.isLoading) return <p className="py-10 text-center text-sm text-slate-300">Loading available parcels…</p>;
  if (parcels.isError) return <p className="py-10 text-center text-sm text-rose-200">Available parcels could not be loaded.</p>;

  return (
    <div>
      <WalletDeclaration
        status={wallet.data}
        hasLiveHold={ownedParcels.some((parcel) => parcel.tenure === 'hold')}
        existingHoldSum={existingHoldSum}
      />
      <p className="mb-2 text-[12px] leading-relaxed text-slate-200">
        Hold $CLAWVILLE and pay no rent, or rent by the week with vCLAW. Not every tier offers
        both doors:
      </p>
      {/* Every number here is DERIVED from the ONE door model: the hold amount
          from the shared threshold ladder and the weekly rent from a listed
          parcel's own `claimRentCtWeekly` server quote. The sentence used to
          hand-type "Starter is 100,000 $CLAWVILLE or 1,000 vCLAW/week; C is
          250,000 ...", which is a price list that can silently disagree with
          what the server charges. */}
      <ul className="mb-4 space-y-1">
        {LAND_TIERS.map((tier) => {
          const tierParcels = available.filter((parcel) => parcel.tier === tier);
          if (tierParcels.length === 0) return null;
          const quoted = tierParcels
            .map((parcel) => parcelDoorModel(parcel.tier, parcel.claimRentCtWeekly))
            .find((model) => model.rentWeeklyCt != null);
          return (
            <li key={tier} className="text-[12px] leading-relaxed text-slate-200">
              {tierDoorSentence(quoted ?? parcelDoorModel(tier, tierParcels[0].claimRentCtWeekly))}
            </li>
          );
        })}
      </ul>
      <div className="max-h-[52vh] space-y-5 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        {LAND_TIERS.map((tier) => {
          const tierParcels = available.filter((parcel) => parcel.tier === tier);
          if (tierParcels.length === 0) return null;
          return (
            <section key={tier}>
              <div className="mb-2 flex items-center gap-2"><TierBadge tier={tier} /><span className="text-[10px] text-slate-300">{tierParcels.length} available</span></div>
              <div className={`grid gap-2 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {tierParcels.map((parcel) => (
                  <div key={parcel.id}>
                    <AvailableParcelCard
                      parcel={parcel}
                      wallet={wallet.data}
                      existingHoldSum={existingHoldSum}
                      isMobile={isMobile}
                      onChanged={async () => {
                        await Promise.all([parcels.refetch(), wallet.refetch()]);
                        await onChanged();
                      }}
                    />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The owned lot's rent + release controls.
 *
 * Same idempotency discipline as `AvailableParcelCard`: the keys and the
 * in-flight flag live in `@/lib/land-tenure-operations`, not in component
 * state, because this component is mounted from BOTH the My Land list and the
 * focused single-parcel panel and navigating between them unmounts it.
 */
export function OwnedTenureControls({
  parcel,
  wallet,
  settlementLock = null,
  onChanged,
}: {
  parcel: LandParcelDTO;
  wallet: LandHoldWalletStatus | undefined;
  /** See `AvailableParcelCard` — non-null disables every spend, and says why. */
  settlementLock?: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const [weeks, setWeeks] = useState(1);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const subject = useActingAvatarId();
  const operationState = useLandOperationState(subject, parcel.parcelCode);
  const lockReason = subject === null
    ? 'Sign in as the owner of this lot to change its rent.'
    : settlementLock;
  const locked = lockReason !== null || operationState.blocked;
  const weekly = parcel.rentCtWeekly;
  const graceMs = parcel.graceUntil ? new Date(parcel.graceUntil).getTime() - Date.now() : null;
  const graceHours = graceMs == null ? null : Math.max(0, Math.ceil(graceMs / 3_600_000));
  // Rent is the one thing on this panel that can COST the player their lot, and
  // it rendered as a bare timestamp with no urgency and no consequence. Same
  // shape as `graceHours` above, from the same DTO field the sweeper acts on.
  const rentRemainingMs = parcel.rentPaidThrough
    ? new Date(parcel.rentPaidThrough).getTime() - Date.now()
    : null;
  const rentRemainingLine = rentRemainingMs == null
    ? null
    : rentRemainingMs <= 0
      ? 'Rent has run out. Prepay now or this lot returns to the Land Office.'
      : `About ${relativeSpan(rentRemainingMs)} left. If rent runs out the lot returns to the Land Office after its grace period.`;
  const rentIsUrgent = rentRemainingMs != null && rentRemainingMs <= 48 * 3_600_000;

  // EXIT PATHS shared by both settlements below, all of them:
  //   • the request resolves          -> 'confirmed', then the refresh decides
  //   •   ... and the refresh lands   -> 'refreshed'  (entry dropped, unlocked)
  //   •   ... and the refresh throws  -> 'refresh_failed' (explicit notice)
  //   •   ... and the refresh hangs   -> the registry's bounded timer flips it
  //                                      to that same explicit notice
  //   • typed API error               -> 'retryable' (key kept, control usable)
  //   • network rejection / timeout   -> 'retryable'
  //   • abort                         -> 'retryable'
  // The `finally` is what guarantees the last three: nothing can be left
  // `settling` forever, so a lost response can never strand a control.
  const prepay = async () => {
    if (weekly == null || !subject) return;
    // Prepaying N weeks is a distinct semantic action per N, exactly as the old
    // `prepayKeys` map keyed by `weeks` was.
    const operation = `prepay:${weeks}`;
    const idempotencyKey = beginLandOperation(subject, parcel.parcelCode, operation);
    let confirmed = false;
    try {
      await api.prepayLandRent(parcel.id, weeks, idempotencyKey);
      confirmed = true;
      settleLandOperation(subject, parcel.parcelCode, operation, 'confirmed');
      addToast('🪙', `Prepaid ${weeks} week${weeks === 1 ? '' : 's'} on ${parcelDisplayName(parcel.parcelCode, parcel.tier)}.`);
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      if (!confirmed) {
        settleLandOperation(subject, parcel.parcelCode, operation, 'retryable');
      }
    }
    if (!confirmed) return;
    try {
      await onChanged();
      settleLandOperation(subject, parcel.parcelCode, operation, 'refreshed');
    } catch {
      settleLandOperation(subject, parcel.parcelCode, operation, 'refresh_failed');
    }
  };

  const release = async () => {
    if (!subject) return;
    const operation = 'release';
    const idempotencyKey = beginLandOperation(subject, parcel.parcelCode, operation);
    let confirmed = false;
    try {
      const result = await api.releaseLandParcel(parcel.id, idempotencyKey);
      confirmed = true;
      settleLandOperation(subject, parcel.parcelCode, operation, 'confirmed');
      addToast('↩️', result.refundedCt > 0
        ? `Released ${parcelDisplayName(parcel.parcelCode, parcel.tier)}; ${result.refundedCt.toLocaleString()} vCLAW escrow returned.`
        : `Released ${parcelDisplayName(parcel.parcelCode, parcel.tier)}.`);
      setConfirmRelease(false);
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      if (!confirmed) {
        settleLandOperation(subject, parcel.parcelCode, operation, 'retryable');
      }
    }
    if (!confirmed) return;
    try {
      await onChanged();
      settleLandOperation(subject, parcel.parcelCode, operation, 'refreshed');
    } catch {
      settleLandOperation(subject, parcel.parcelCode, operation, 'refresh_failed');
    }
  };

  return (
    <div className="mt-3 w-full basis-full border-t border-cyan-300/15 pt-3 text-[11px] text-slate-200">
      {/* Heading, because "Manage building" sits a few pixels above this block
          and a first-time reader reasonably expects it to cover rent too. It
          does not: that button opens Build/upgrade, and keeping the lot is
          THIS block. Naming the concern is what makes the two read as
          different areas rather than one. */}
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200">
        Rent and tenure for this lot
      </div>
      {parcel.tenure === 'hold' ? (
        <div>
          <span className="font-semibold text-emerald-100">Rent-free hold</span> ·{' '}
          <span className="font-mono">{wallet?.walletAddress ? shortWallet(wallet.walletAddress) : 'wallet unavailable'}</span>
          <div className="mt-1 text-slate-300">Last check: {parcel.tenureLastCheckedAt ? new Date(parcel.tenureLastCheckedAt).toLocaleString() : 'pending'}</div>
        </div>
      ) : parcel.tenure === 'deposit' ? (
        <div>
          <div>
            Rent paid through: <span className="font-mono text-cyan-100">{parcel.rentPaidThrough ? new Date(parcel.rentPaidThrough).toLocaleString() : 'pending'}</span>
          </div>
          {rentRemainingLine && (
            <div className={`mt-1 leading-relaxed ${rentIsUrgent ? 'font-semibold text-amber-200' : 'text-slate-300'}`}>
              {rentRemainingLine}
            </div>
          )}
          {graceHours != null && <div className="mt-1 font-semibold text-amber-200">Grace ends in about {graceHours} hour{graceHours === 1 ? '' : 's'}.</div>}
          {weekly != null && (
            // The control read as a bare "Prepay" next to a bare `1`, so the
            // number named no unit and the button was styled as a secondary
            // option sitting under an amber warning about losing the lot.
            // Naming the unit and promoting the button INSIDE the warning
            // window makes the remedy read as the remedy. The request, the
            // price and `prepayKeys` are untouched.
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <WeeksSelect value={weeks} onChange={setWeeks} label="Weeks of rent" />
              <span className="font-mono text-cyan-100">Total {(weekly * weeks).toLocaleString()} vCLAW</span>
              <RpgButton
                size="sm"
                variant={rentIsUrgent ? 'primary' : 'secondary'}
                className="min-h-[44px]"
                onClick={prepay}
                loading={doorIsWorking(operationState, 'prepay')}
                disabled={locked}
              >
                {rentIsUrgent ? 'Prepay rent now' : 'Prepay rent'}
              </RpgButton>
            </div>
          )}
        </div>
      ) : (
        <div className="text-slate-300">Legacy tenure · no P2 rent controls.</div>
      )}

      {!confirmRelease ? (
        <RpgButton size="sm" variant="ghost" className="mt-3 min-h-[44px]" onClick={() => setConfirmRelease(true)} disabled={locked}>Release parcel</RpgButton>
      ) : (
        <div role="alertdialog" aria-label={`Release ${parcelDisplayName(parcel.parcelCode, parcel.tier)}`} className="mt-3 rounded-lg border border-rose-300/30 bg-rose-400/[0.08] p-3">
          <p className="text-rose-100">
            Release {parcelDisplayName(parcel.parcelCode, parcel.tier)}? {parcel.tenure === 'deposit'
              ? 'Remaining escrow is returned, but the first week and rent already drawn are not refundable. Your build is archived.'
              : 'The $CLAWVILLE hold is removed with no deposit refund. Your build is archived.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RpgButton size="sm" variant="ghost" className="min-h-[44px]" onClick={() => setConfirmRelease(false)} disabled={operationState.blocked}>Keep parcel</RpgButton>
            <RpgButton size="sm" variant="primary" className="min-h-[44px]" onClick={release} loading={doorIsWorking(operationState, 'release')} disabled={locked}>Confirm release</RpgButton>
          </div>
        </div>
      )}
      <SettlementLockLine reason={operationState.blocked ? null : lockReason} />
      <SettlementRecoveryNotice
        subject={subject}
        parcelCode={parcel.parcelCode}
        state={operationState}
        onChanged={onChanged}
      />
    </div>
  );
}

export function useLandHoldWalletStatus(enabled: boolean) {
  return useQuery({ queryKey: HOLD_WALLET_KEY, queryFn: api.getLandHoldWallet, enabled, retry: false });
}
