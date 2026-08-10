'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useWalletLink } from '@/hooks/use-wallet-link';
import { api, ApiError } from '@/lib/api';
import { useGameStore } from '@/stores/game';
import type { LandHoldWalletStatus, LandParcelDTO } from './types';

const HOLD_WALLET_KEY = ['land-hold-wallet'] as const;

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

function tenureError(error: unknown): string {
  switch (codeOf(error)) {
    case 'wallet_not_declared': return 'Declare the wallet that will back this CLV hold first.';
    case 'wallet_locked_by_hold': return 'This wallet cannot change while an active hold parcel depends on it.';
    case 'wallet_change_requires_human': return 'An agent may declare the first wallet, but only a human session may change it.';
    case 'wallet_already_declared': return 'That wallet is already declared by another account.';
    case 'insufficient_clv_hold': return 'The declared wallet does not hold enough CLV for the stacked requirement.';
    case 'clv_balance_unavailable': return 'The live CLV balance could not be verified. Try again shortly.';
    case 'insufficient_clawtokens': return 'You do not have enough vCLAW for this action.';
    case 'parcel_not_available': return 'Someone else just claimed this parcel.';
    case 'parcel_cap_reached': return `You already hold the maximum of ${MAX_PARCELS_PER_AVATAR} parcels.`;
    case 'founder_no_rent_door': return 'Founder parcels are hold-only and allocated through the auction.';
    case 'tier_not_claimable': return 'That tenure door is not available for this tier.';
    case 'not_parcel_owner': return 'This parcel is no longer owned by your active avatar.';
    case 'not_deposit_tenure': return 'Only rent-door parcels can receive prepaid rent.';
    case 'deed_locked_by_listing': return 'Remove the live deed listing before releasing this parcel.';
    case 'idempotency_key_conflict': return 'This action key belongs to an earlier parcel state. Reopen the Land Office and try again.';
    case 'autonomous_daily_cap': return 'This agent reached its autonomous daily land-spend limit.';
    default: return 'The Land Office could not complete that action. Try again.';
  }
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

function WalletDeclaration({
  status,
  hasLiveHold,
}: {
  status: LandHoldWalletStatus | undefined;
  hasLiveHold: boolean;
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
  const lockedReason = changing && hasLiveHold
    ? 'wallet_locked_by_hold: release active hold parcels before changing this wallet.'
    : null;

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
      <p className="mt-1 text-[12px] text-slate-200">
        Declare the Solana wallet whose live CLV balance backs hold-door parcels. The first declaration works from any ledger-capable session.
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
          Declared {shortWallet(status.walletAddress)} ·{' '}
          {status.balance?.available && status.balance.uiAmount != null
            ? `${formatClv(status.balance.uiAmount)} CLV live balance`
            : 'live balance unavailable'}
        </p>
      )}
    </section>
  );
}

function AvailableParcelCard({
  parcel,
  wallet,
  existingHoldSum,
  isMobile,
  onChanged,
}: {
  parcel: LandParcelDTO;
  wallet: LandHoldWalletStatus | undefined;
  existingHoldSum: number;
  isMobile: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const [weeks, setWeeks] = useState(1);
  const [busy, setBusy] = useState<'hold' | 'rent' | null>(null);
  const claimKeys = useRef(new Map<string, string>());
  const threshold = holdThresholdForTier(parcel.tier);
  const required = existingHoldSum + (threshold ?? 0);
  const held = wallet?.balance?.available ? wallet.balance.uiAmount : null;
  const holdReason = threshold == null
    ? 'Hold door unavailable for this tier.'
    : !wallet?.walletAddress
      ? 'Declare a hold wallet first.'
      : held == null
        ? 'Live CLV balance is unavailable.'
        : held < required
          ? `${formatClv(required - held)} CLV short.`
          : null;
  const weekly = parcel.claimRentCtWeekly;
  const rentAllowed = (parcel.tier === 'starter' || parcel.tier === 'c') && weekly != null;

  const claim = async (door: 'hold' | 'rent') => {
    setBusy(door);
    try {
      const semanticAction = door === 'hold' ? 'hold' : `rent:${weeks}`;
      const key = claimKeys.current.get(semanticAction) ?? crypto.randomUUID();
      claimKeys.current.set(semanticAction, key);
      if (door === 'hold') {
        await api.claimHoldParcel(parcel.id, key);
        addToast('🏝️', `Claimed ${parcelDisplayName(parcel.parcelCode, parcel.tier)} through the rent-free hold door.`);
      } else {
        await api.claimRentParcel(parcel.id, weeks, key);
        addToast('🏝️', `Rented ${parcelDisplayName(parcel.parcelCode, parcel.tier)} for ${weeks} week${weeks === 1 ? '' : 's'}.`);
      }
      claimKeys.current.delete(semanticAction);
      await onChanged();
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`rounded-xl border border-cyan-300/15 bg-cyan-400/[0.04] ${isMobile ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="block font-semibold text-cyan-50">
            {parcelDisplayName(parcel.parcelCode, parcel.tier)}
          </span>
          <span className="block font-mono text-[10px] text-slate-400">{parcel.parcelCode}</span>
        </span>
        <TierBadge tier={parcel.tier} />
      </div>
      <div className="mt-3 rounded-lg border border-emerald-300/25 bg-emerald-400/[0.08] px-3 py-2">
        <p className="font-semibold text-emerald-100">
          Hold {threshold == null ? '$CLAWVILLE' : `${formatClv(threshold)} $CLAWVILLE`} — rent-free
        </p>
        {rentAllowed && (
          <p className="mt-0.5 text-[12px] font-semibold text-amber-100">
            or rent {weekly.toLocaleString()} vCLAW/week
          </p>
        )}
      </div>
      <div className={`mt-3 grid gap-3 ${isMobile || !rentAllowed ? 'grid-cols-1' : 'grid-cols-2'}`}>
        <section className="rounded-lg border border-emerald-300/20 bg-emerald-400/[0.05] p-3">
          <div className="font-semibold text-emerald-100">Hold door · rent-free</div>
          <p className="mt-1 text-[11px] text-slate-200">
            {threshold == null ? 'Not offered for this tier.' : `${formatClv(required)} CLV minimum (stacked).`}
          </p>
          <p className="mt-1 break-all font-mono text-[10px] text-slate-300">
            {wallet?.walletAddress ?? 'No wallet declared'} · {held == null ? 'balance unverified' : `${formatClv(held)} CLV`}
          </p>
          <RpgButton
            size="sm"
            variant="primary"
            className="mt-3 min-h-[44px] w-full"
            onClick={() => claim('hold')}
            loading={busy === 'hold'}
            disabled={!!holdReason || busy != null}
          >
            Claim with hold
          </RpgButton>
          {holdReason && <p className="mt-2 text-[10px] text-amber-200">{holdReason}</p>}
        </section>
        {rentAllowed ? (
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
              loading={busy === 'rent'}
              disabled={busy != null}
            >
              Rent parcel
            </RpgButton>
          </section>
        ) : parcel.tier === 'founder' ? (
          <p className="rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-100">
            Founder parcels are hold-only.
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function LandTenureForSalePanel({
  ownedParcels,
  isMobile,
  focusParcelCode,
  onChanged,
}: {
  ownedParcels: LandParcelDTO[];
  isMobile: boolean;
  focusParcelCode?: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const focusedCardRef = useRef<HTMLDivElement>(null);
  const parcels = useQuery({
    queryKey: ['land-tenure-available'],
    queryFn: () => api.getLandParcels({ status: 'available' }),
  });
  const wallet = useQuery({ queryKey: HOLD_WALLET_KEY, queryFn: api.getLandHoldWallet, retry: false });
  const existingHoldSum = useMemo(
    () => ownedParcels.reduce(
      (sum, parcel) => parcel.tenure === 'hold'
        ? sum + (parcel.holdThresholdCt ?? holdThresholdForTier(parcel.tier) ?? 0)
        : sum,
      0,
    ),
    [ownedParcels],
  );
  const available = parcels.data ?? [];
  useEffect(() => {
    if (!focusParcelCode || available.length === 0) return;
    if (!available.some((parcel) => parcel.parcelCode === focusParcelCode)) return;
    const frame = requestAnimationFrame(() => {
      focusedCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusedCardRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [available, focusParcelCode]);

  if (parcels.isLoading) return <p className="py-10 text-center text-sm text-slate-300">Loading available parcels…</p>;
  if (parcels.isError) return <p className="py-10 text-center text-sm text-rose-200">Available parcels could not be loaded.</p>;

  return (
    <div>
      <WalletDeclaration status={wallet.data} hasLiveHold={ownedParcels.some((parcel) => parcel.tenure === 'hold')} />
      <p className="mb-4 text-[12px] leading-relaxed text-slate-200">
        Hold $CLAWVILLE — rent-free — or rent vCLAW by the week. Starter is 100,000 $CLAWVILLE or 1,000 vCLAW/week; C is 250,000 $CLAWVILLE or 2,500 vCLAW/week. Founder is hold-only.
      </p>
      <div className="max-h-[52vh] space-y-5 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        {LAND_TIERS.map((tier) => {
          const tierParcels = available.filter((parcel) => parcel.tier === tier);
          if (tierParcels.length === 0) return null;
          return (
            <section key={tier}>
              <div className="mb-2 flex items-center gap-2"><TierBadge tier={tier} /><span className="text-[10px] text-slate-300">{tierParcels.length} available</span></div>
              <div className={`grid gap-2 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {tierParcels.map((parcel) => (
                  <div
                    key={parcel.id}
                    id={`land-tenure-${parcel.parcelCode}`}
                    ref={focusParcelCode === parcel.parcelCode ? focusedCardRef : undefined}
                    tabIndex={focusParcelCode === parcel.parcelCode ? -1 : undefined}
                    aria-current={focusParcelCode === parcel.parcelCode ? 'true' : undefined}
                    className={focusParcelCode === parcel.parcelCode
                      ? 'col-span-full rounded-xl ring-2 ring-cyan-300 ring-offset-2 ring-offset-[#071321]'
                      : undefined}
                  >
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

export function OwnedTenureControls({
  parcel,
  wallet,
  onChanged,
}: {
  parcel: LandParcelDTO;
  wallet: LandHoldWalletStatus | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const [weeks, setWeeks] = useState(1);
  const [busy, setBusy] = useState<'prepay' | 'release' | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const prepayKeys = useRef(new Map<number, string>());
  const releaseKey = useRef<string | null>(null);
  const weekly = parcel.rentCtWeekly;
  const graceMs = parcel.graceUntil ? new Date(parcel.graceUntil).getTime() - Date.now() : null;
  const graceHours = graceMs == null ? null : Math.max(0, Math.ceil(graceMs / 3_600_000));

  const prepay = async () => {
    if (weekly == null) return;
    setBusy('prepay');
    try {
      const key = prepayKeys.current.get(weeks) ?? crypto.randomUUID();
      prepayKeys.current.set(weeks, key);
      await api.prepayLandRent(parcel.id, weeks, key);
      prepayKeys.current.delete(weeks);
      addToast('🪙', `Prepaid ${weeks} week${weeks === 1 ? '' : 's'} on ${parcelDisplayName(parcel.parcelCode, parcel.tier)}.`);
      await onChanged();
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setBusy(null);
    }
  };

  const release = async () => {
    setBusy('release');
    try {
      const key = releaseKey.current ?? crypto.randomUUID();
      releaseKey.current = key;
      const result = await api.releaseLandParcel(parcel.id, key);
      releaseKey.current = null;
      addToast('↩️', result.refundedCt > 0
        ? `Released ${parcelDisplayName(parcel.parcelCode, parcel.tier)}; ${result.refundedCt.toLocaleString()} vCLAW escrow returned.`
        : `Released ${parcelDisplayName(parcel.parcelCode, parcel.tier)}.`);
      setConfirmRelease(false);
      await onChanged();
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 w-full basis-full border-t border-cyan-300/15 pt-3 text-[11px] text-slate-200">
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
          {graceHours != null && <div className="mt-1 font-semibold text-amber-200">Grace ends in about {graceHours} hour{graceHours === 1 ? '' : 's'}.</div>}
          {weekly != null && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <WeeksSelect value={weeks} onChange={setWeeks} label="Prepay" />
              <span className="font-mono text-cyan-100">{(weekly * weeks).toLocaleString()} vCLAW</span>
              <RpgButton size="sm" variant="secondary" className="min-h-[44px]" onClick={prepay} loading={busy === 'prepay'} disabled={busy != null}>Prepay rent</RpgButton>
            </div>
          )}
        </div>
      ) : (
        <div className="text-slate-300">Legacy tenure · no P2 rent controls.</div>
      )}

      {!confirmRelease ? (
        <RpgButton size="sm" variant="ghost" className="mt-3 min-h-[44px]" onClick={() => setConfirmRelease(true)}>Release parcel</RpgButton>
      ) : (
        <div role="alertdialog" aria-label={`Release ${parcelDisplayName(parcel.parcelCode, parcel.tier)}`} className="mt-3 rounded-lg border border-rose-300/30 bg-rose-400/[0.08] p-3">
          <p className="text-rose-100">
            Release {parcelDisplayName(parcel.parcelCode, parcel.tier)}? {parcel.tenure === 'deposit'
              ? 'Remaining escrow is returned, but the first week and rent already drawn are not refundable. Your build is archived.'
              : 'The CLV hold is removed with no deposit refund. Your build is archived.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RpgButton size="sm" variant="ghost" className="min-h-[44px]" onClick={() => setConfirmRelease(false)} disabled={busy != null}>Keep parcel</RpgButton>
            <RpgButton size="sm" variant="primary" className="min-h-[44px]" onClick={release} loading={busy === 'release'} disabled={busy != null}>Confirm release</RpgButton>
          </div>
        </div>
      )}
    </div>
  );
}

export function useLandHoldWalletStatus(enabled: boolean) {
  return useQuery({ queryKey: HOLD_WALLET_KEY, queryFn: api.getLandHoldWallet, enabled, retry: false });
}
