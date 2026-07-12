'use client';

/**
 * guest-land-sandbox.tsx — the GUEST view of the Land Office.
 *
 * A guest (throwaway demo identity) cannot own real land: every land WRITE
 * 403s server-side (`land.ts` `requireNonGuestIdentity` → `guest_not_allowed`).
 * Rather than dead-end a guest on error toasts, the Land Office renders THIS
 * panel for guests — a fully client-side, clearly-labelled SANDBOX that lets
 * them claim a demo cove, build a home/shop, and upgrade it against a demo CT
 * wallet, with a persistent sign-up conversion path.
 *
 * All state lives in `useGuestLandSandbox` (stores/land-guest-sandbox.ts) — a
 * store isolated from the real `useLandStore` and from every query cache, so
 * nothing here can leak into a server request and no sandbox structure ever
 * renders in the shared 3D world (stated honestly in the copy below).
 *
 * Visual language matches the real modal: dark-navy panel → ONLY light text
 * tokens (cyan-50/100/200, slate-100/200, amber-200/300, white). Single-column
 * + min-h-44 tap targets so it fits mobile / iPad without covering joysticks.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LAND_STARTER_DEPOSIT_CT,
  STRUCTURE_UPGRADE_COSTS,
  getTierStructureRules,
  getCatalogEntry,
} from '@clawville/shared';
import { RpgButton } from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import {
  useGuestLandSandbox,
  GUEST_SANDBOX_MAX_LEVEL,
  GUEST_SANDBOX_TIER,
} from '@/stores/land-guest-sandbox';

/** Sign-up conversion path — mirrors sidebar-menu.tsx's account CTA. */
const SIGNUP_HREF = '/login?mode=signup';

function skuLabel(key: string): string {
  return getCatalogEntry(key)?.label ?? key;
}

/** The persistent SANDBOX banner + demo wallet chip (top of the panel). */
function SandboxBanner({ demoCt }: { demoCt: number }) {
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-400/30 bg-amber-500/[0.08] p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/40 bg-amber-400/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-amber-200">
          🏝️ Sandbox
        </span>
        <p className="mt-1.5 text-[12px] leading-relaxed text-amber-100/90">
          This is a private demo — nothing here is real land. Your pretend cove
          lives only in this panel and never appears in the shared world.{' '}
          <span className="font-semibold text-amber-200">Sign up to claim real land.</span>
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1 self-start rounded-full border border-amber-500/25 bg-amber-500/15 px-2.5 py-1 font-mono text-[11px] font-bold text-amber-200">
        🪙 {demoCt.toLocaleString()} <span className="font-normal text-amber-200/70">DEMO vCLAW</span>
      </span>
    </div>
  );
}

/** The always-visible "own real land" conversion CTA (bottom of the panel). */
function ConversionCta() {
  const router = useRouter();
  return (
    <div className="mt-4 flex flex-col gap-2 rounded-xl border border-cyan-400/25 bg-cyan-500/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <span className="font-clawville text-sm text-cyan-100">🚀 Ready for the real thing?</span>
        <p className="mt-0.5 text-[12px] leading-relaxed text-slate-200">
          Sign up to claim actual parcels, build in the shared world, and earn
          real vCLAW.
        </p>
      </div>
      <RpgButton
        size="sm"
        variant="primary"
        rarity="uncommon"
        className="min-h-[44px] shrink-0"
        onClick={() => router.push(SIGNUP_HREF)}
      >
        Sign up to own real land
      </RpgButton>
    </div>
  );
}

/** Claim card — shown when the guest has no demo cove yet. */
function ClaimCard({ onClaim, canAfford }: { onClaim: () => void; canAfford: boolean }) {
  return (
    <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
      <span className="font-clawville text-sm text-emerald-100">🏡 Try claiming a demo cove</span>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-200">
        Claim a Starter Cove with a refundable{' '}
        <span className="font-semibold text-emerald-200">
          {LAND_STARTER_DEPOSIT_CT.toLocaleString()} DEMO vCLAW deposit
        </span>{' '}
        (held in escrow, refunded when you release the cove — just like the real
        thing). Then build a home or shop and upgrade it. It&apos;s all pretend.
      </p>
      <RpgButton
        size="sm"
        variant="primary"
        rarity="uncommon"
        onClick={onClaim}
        disabled={!canAfford}
        className="mt-3 min-h-[44px]"
      >
        {canAfford
          ? `Claim demo cove · ${LAND_STARTER_DEPOSIT_CT.toLocaleString()} DEMO vCLAW deposit`
          : 'Not enough DEMO vCLAW'}
      </RpgButton>
    </div>
  );
}

/** Build picker — shown when the cove is claimed but empty. */
function BuildPanel({ onBuild }: { onBuild: (type: 'home' | 'shop', key: string) => void }) {
  const rules = getTierStructureRules(GUEST_SANDBOX_TIER);
  const [placeType, setPlaceType] = useState<'home' | 'shop'>('home');
  const skus = placeType === 'home' ? rules.homeSkus : rules.shopSkus;
  const [sku, setSku] = useState<string>(rules.homeSkus[0] ?? '');

  // Keep the selected SKU valid when flipping home/shop.
  const list = useMemo(() => skus.slice(), [skus]);
  const effectiveSku = list.includes(sku) ? sku : list[0] ?? '';

  return (
    <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/[0.03] p-3">
      <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
        Build (free · lands at Lv1)
      </h4>
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => setPlaceType('home')}
          className="min-h-[40px] flex-1 rounded-lg border px-2 py-1.5 font-mono text-[11px] transition-all"
          style={{
            color: placeType === 'home' ? '#0a1628' : '#cbd5e1',
            background: placeType === 'home' ? '#38bdf8' : 'rgba(56,189,248,0.08)',
            borderColor: placeType === 'home' ? '#38bdf8' : 'rgba(56,189,248,0.3)',
            fontWeight: placeType === 'home' ? 700 : 500,
          }}
        >
          🏠 Home
        </button>
        <button
          type="button"
          onClick={() => setPlaceType('shop')}
          className="min-h-[40px] flex-1 rounded-lg border px-2 py-1.5 font-mono text-[11px] transition-all"
          style={{
            color: placeType === 'shop' ? '#0a1628' : '#cbd5e1',
            background: placeType === 'shop' ? '#38bdf8' : 'rgba(56,189,248,0.08)',
            borderColor: placeType === 'shop' ? '#38bdf8' : 'rgba(56,189,248,0.3)',
            fontWeight: placeType === 'shop' ? 700 : 500,
          }}
        >
          🏪 Shop
        </button>
      </div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
        Choose a building
      </label>
      <select
        value={effectiveSku}
        onChange={(e) => setSku(e.target.value)}
        className="mb-3 w-full rounded-lg border border-cyan-400/30 bg-[#0a1628] px-3 py-2 font-mono text-[12px] text-cyan-50 outline-none focus:border-cyan-300"
      >
        {list.map((k) => (
          <option key={k} value={k} className="text-cyan-50">
            {skuLabel(k)}
          </option>
        ))}
      </select>
      <RpgButton
        size="sm"
        variant="primary"
        onClick={() => onBuild(placeType, effectiveSku)}
        disabled={!effectiveSku}
        className="min-h-[44px]"
      >
        Build it (demo)
      </RpgButton>
    </div>
  );
}

/** Upgrade panel — shown when the cove has a structure. */
function UpgradePanel({
  level,
  structureType,
  catalogKey,
  onUpgrade,
}: {
  level: number;
  structureType: 'home' | 'shop';
  catalogKey: string;
  onUpgrade: () => void;
}) {
  const atCap = level >= GUEST_SANDBOX_MAX_LEVEL;
  const nextLevel = level + 1;
  const nextCost = STRUCTURE_UPGRADE_COSTS[nextLevel];

  return (
    <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/[0.03] p-3">
      <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
        {structureType === 'home' ? '🏠' : '🏪'} {skuLabel(catalogKey)} · Lv{level}
      </h4>
      <div className="mb-3 space-y-1">
        {Array.from({ length: GUEST_SANDBOX_MAX_LEVEL }, (_, i) => i + 1).map((lvl) => {
          const reached = lvl <= level;
          const cost = STRUCTURE_UPGRADE_COSTS[lvl];
          return (
            <div
              key={lvl}
              className="flex items-center justify-between rounded-md border px-2 py-1 font-mono text-[11px]"
              style={{
                color: reached ? '#a7f3d0' : '#cbd5e1',
                borderColor: reached ? 'rgba(16,185,129,0.4)' : 'rgba(56,189,248,0.25)',
                background: reached ? 'rgba(16,185,129,0.08)' : 'transparent',
              }}
            >
              <span>
                Lv{lvl}
                {reached ? ' ✓' : ''}
              </span>
              <span>{lvl === 1 ? 'free' : `${cost?.toLocaleString()} DEMO vCLAW`}</span>
            </div>
          );
        })}
      </div>
      {atCap ? (
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Maxed at Lv{GUEST_SANDBOX_MAX_LEVEL} for a Starter Cove. Sign up + claim
          a higher tier to build bigger.
        </p>
      ) : (
        <RpgButton size="sm" variant="primary" onClick={onUpgrade} className="min-h-[44px]">
          Upgrade to Lv{nextLevel} · {nextCost?.toLocaleString()} DEMO vCLAW
        </RpgButton>
      )}
    </div>
  );
}

export default function GuestLandSandbox() {
  const addToast = useGameStore((s) => s.addToast);
  const demoCt = useGuestLandSandbox((s) => s.demoCt);
  const cove = useGuestLandSandbox((s) => s.cove);
  const claimCove = useGuestLandSandbox((s) => s.claimCove);
  const buildStructure = useGuestLandSandbox((s) => s.buildStructure);
  const upgradeStructure = useGuestLandSandbox((s) => s.upgradeStructure);
  const releaseCove = useGuestLandSandbox((s) => s.releaseCove);

  const handleClaim = () => {
    const res = claimCove();
    if (res.ok) {
      addToast('🏡', `Claimed a demo cove — ${res.amountCt?.toLocaleString()} DEMO vCLAW held as a refundable deposit.`);
    } else if (res.code === 'insufficient_ct') {
      addToast('⚠️', 'Not enough DEMO vCLAW for the deposit.', 4000);
    }
  };

  const handleBuild = (type: 'home' | 'shop', key: string) => {
    const res = buildStructure(type, key);
    if (res.ok) addToast('🏗️', `Built ${skuLabel(key)} on your demo cove!`);
  };

  const handleUpgrade = () => {
    const res = upgradeStructure();
    if (res.ok) {
      addToast('⬆️', `Upgraded to Lv${(cove?.structure?.level ?? 0) + 1} for ${res.amountCt?.toLocaleString()} DEMO vCLAW!`);
    } else if (res.code === 'insufficient_ct') {
      addToast('⚠️', 'Not enough DEMO vCLAW for this upgrade.', 4000);
    } else if (res.code === 'max_level') {
      addToast('🔒', `A Starter Cove caps at Lv${GUEST_SANDBOX_MAX_LEVEL}.`, 4000);
    }
  };

  const handleRelease = () => {
    const res = releaseCove();
    if (res.ok) {
      addToast('🔄', `Released your demo cove — ${res.amountCt?.toLocaleString()} DEMO vCLAW refunded.`);
    }
  };

  return (
    <div>
      <SandboxBanner demoCt={demoCt} />

      {!cove ? (
        <ClaimCard onClaim={handleClaim} canAfford={demoCt >= LAND_STARTER_DEPOSIT_CT} />
      ) : (
        <div className="space-y-3">
          {/* Cove summary */}
          <div className="flex flex-col gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.05] p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cyan-100">
                  {cove.parcelCode}
                </span>
                <span className="inline-flex items-center rounded-full border border-amber-300/40 bg-amber-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200">
                  Demo
                </span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-slate-300">
                {cove.structure
                  ? `${cove.structure.structureType === 'home' ? '🏠' : '🏪'} ${skuLabel(cove.structure.catalogKey)} · Lv${cove.structure.level}`
                  : 'Empty lot — nothing built yet'}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                {cove.depositRemainingCt.toLocaleString()} DEMO vCLAW deposit held (refundable)
              </div>
            </div>
            <RpgButton
              size="sm"
              variant="ghost"
              onClick={handleRelease}
              className="min-h-[44px] shrink-0"
            >
              Release (refund deposit)
            </RpgButton>
          </div>

          {cove.structure ? (
            <UpgradePanel
              level={cove.structure.level}
              structureType={cove.structure.structureType}
              catalogKey={cove.structure.catalogKey}
              onUpgrade={handleUpgrade}
            />
          ) : (
            <BuildPanel onBuild={handleBuild} />
          )}
        </div>
      )}

      <ConversionCta />
    </div>
  );
}
