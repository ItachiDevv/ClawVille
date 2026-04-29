'use client';

/**
 * Cosmetic drawer — Owned + Shop tabs.
 *
 * Phase 1 (book shop) was per-building. Cosmetics are global, so they ship
 * inside this drawer instead of the per-building shop overlay.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────┐
 *   │  Cosmetics                              [×]    │
 *   │  ─────────────────────────────────────         │
 *   │  [ Owned ] [ Shop ]              CT: 240       │
 *   │  ─────────────────────────────────────         │
 *   │  [All] [Hats] [Glasses] [Auras] [Boards]       │
 *   │  ─────────────────────────────────────         │
 *   │  ┌──────┐  ┌──────┐  ┌──────┐                  │
 *   │  │ icon │  │ icon │  │ icon │   ...            │
 *   │  │ name │  │ name │  │ name │                  │
 *   │  │[buy] │  │[eqp] │  │[own] │                  │
 *   │  └──────┘  └──────┘  └──────┘                  │
 *   └────────────────────────────────────────────────┘
 */

import { useMemo, useState } from 'react';
import {
  useOwnedCosmetics,
  useEquipCosmetic,
  useCosmeticCatalog,
  useBuyCosmetic,
  type OwnedCosmetic,
  type CosmeticCatalogItem,
} from '@/hooks/use-cosmetics';
import { usePet } from '@/hooks/use-pet';

const CATEGORY_FILTERS: { id: string; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '✨' },
  { id: 'hat', label: 'Hats', icon: '🎩' },
  { id: 'glasses', label: 'Glasses', icon: '🕶️' },
  { id: 'emote', label: 'Emotes', icon: '💃' },
  { id: 'aura', label: 'Auras', icon: '🌟' },
  { id: 'board', label: 'Boards', icon: '🏄' },
  { id: 'particle', label: 'Particles', icon: '✦' },
  { id: 'palette', label: 'Palettes', icon: '🎨' },
  { id: 'outfit', label: 'Outfits', icon: '👕' },
];

const CATEGORY_ICONS: Record<string, string> = Object.fromEntries(
  CATEGORY_FILTERS.map((c) => [c.id, c.icon]),
);

const RARITY_BORDER: Record<string, string> = {
  common: 'border-white/15',
  rare: 'border-cyan-300/50',
  epic: 'border-fuchsia-300/60',
  limited: 'border-amber-300/70',
};

interface CosmeticDrawerProps {
  open: boolean;
  onClose: () => void;
}

type Tab = 'owned' | 'shop';

export default function CosmeticDrawer({ open, onClose }: CosmeticDrawerProps) {
  const [tab, setTab] = useState<Tab>('owned');
  const [filter, setFilter] = useState<string>('all');
  const { data: pet } = usePet();
  const tokens = pet?.clawTokens ?? 0;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="claw-panel relative w-full max-w-3xl rounded-t-2xl border border-cyan-400/25 bg-[#061520]/95 p-6 shadow-[0_-12px_40px_rgba(0,229,255,0.18)] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between">
          <h2 className="font-clawville text-xl text-white">Cosmetics</h2>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/20 px-2 py-0.5 font-mono text-xs font-bold text-cyan-200">
              <span className="text-sm">&#x1FA99;</span>
              {tokens}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close cosmetics drawer"
              className="rounded-full px-2 py-1 font-mono text-sm text-white/60 hover:text-white"
            >
              ×
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="mt-4 flex gap-2 border-b border-cyan-400/20 pb-3">
          <TabButton active={tab === 'owned'} onClick={() => setTab('owned')} label="Owned" icon="🎒" />
          <TabButton active={tab === 'shop'} onClick={() => setTab('shop')} label="Shop" icon="🛒" />
        </div>

        {/* Category chips */}
        <div className="mt-4 flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map((f) => {
            const active = f.id === filter;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.18em] transition-all ${
                  active
                    ? 'border-cyan-300/60 bg-cyan-500/20 text-cyan-100'
                    : 'border-cyan-400/15 bg-black/30 text-cyan-200/50 hover:text-cyan-100'
                }`}
              >
                <span aria-hidden>{f.icon}</span>
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="mt-5 max-h-[55vh] overflow-y-auto">
          {tab === 'owned' ? (
            <OwnedTab filter={filter} />
          ) : (
            <ShopTab filter={filter} tokens={tokens} />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] transition-all ${
        active
          ? 'bg-cyan-500/25 text-cyan-100'
          : 'text-cyan-200/50 hover:text-cyan-100'
      }`}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Owned tab
// ---------------------------------------------------------------------------

function OwnedTab({ filter }: { filter: string }) {
  const { data, isLoading, isError, error } = useOwnedCosmetics();
  const equip = useEquipCosmetic();

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.owned;
    return data.owned.filter((o) => o.sku.category === filter);
  }, [data, filter]);

  if (isLoading) {
    return <p className="py-12 text-center font-mono text-xs text-white/40">Loading cosmetics…</p>;
  }
  if (isError) {
    return (
      <p className="py-12 text-center font-mono text-xs text-red-300/70">
        Failed to load cosmetics: {(error as Error)?.message}
      </p>
    );
  }
  if (filtered.length === 0) {
    return <EmptyOwnedState filter={filter} hasAny={(data?.owned ?? []).length > 0} />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {filtered.map((o) => (
        <OwnedCard
          key={o.id}
          cosmetic={o}
          onToggle={() => equip.mutate({ skuId: o.sku.id, equipped: !o.equipped })}
          pending={equip.isPending}
        />
      ))}
    </div>
  );
}

function OwnedCard({
  cosmetic,
  onToggle,
  pending,
}: {
  cosmetic: OwnedCosmetic;
  onToggle: () => void;
  pending: boolean;
}) {
  const icon = CATEGORY_ICONS[cosmetic.sku.category] ?? '✨';
  const rarityBorder = RARITY_BORDER[cosmetic.sku.rarity] ?? 'border-cyan-400/15';
  return (
    <div
      className={`relative rounded-xl border bg-cyan-500/[0.04] p-3 transition-all ${
        cosmetic.equipped
          ? 'border-cyan-300/60 shadow-[0_0_18px_rgba(0,229,255,0.18)]'
          : rarityBorder
      }`}
    >
      <div className="flex aspect-square items-center justify-center rounded-lg bg-black/30 text-3xl">
        <span aria-hidden>{icon}</span>
      </div>
      <h3 className="mt-2 truncate font-mono text-[11px] uppercase tracking-[0.16em] text-cyan-100">
        {cosmetic.sku.displayName}
      </h3>
      <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-cyan-300/40">
        {cosmetic.sku.rarity}
      </p>
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        className={`mt-2 w-full rounded-md py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all disabled:opacity-50 ${
          cosmetic.equipped
            ? 'bg-cyan-500/30 text-cyan-100 hover:bg-cyan-500/40'
            : 'bg-white/5 text-white/70 hover:bg-white/10'
        }`}
      >
        {cosmetic.equipped ? 'Equipped' : 'Equip'}
      </button>
      {cosmetic.sku.attribution ? (
        <p className="mt-1 truncate font-mono text-[8px] text-white/30" title={cosmetic.sku.attribution}>
          {cosmetic.sku.attribution}
        </p>
      ) : null}
    </div>
  );
}

function EmptyOwnedState({ filter, hasAny }: { filter: string; hasAny: boolean }) {
  if (!hasAny) {
    return (
      <div className="py-12 text-center font-mono text-xs text-white/40">
        <p>No cosmetics yet.</p>
        <p className="mt-2">Open the Shop tab to browse what's available.</p>
      </div>
    );
  }
  return (
    <p className="py-12 text-center font-mono text-xs text-white/40">
      No {filter} owned. Try another category or open the Shop tab.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Shop tab
// ---------------------------------------------------------------------------

function ShopTab({ filter, tokens }: { filter: string; tokens: number }) {
  const { data: catalog, isLoading, isError, error } = useCosmeticCatalog();
  const { data: ownedData } = useOwnedCosmetics();
  const buy = useBuyCosmetic();

  // Map of owned SKU IDs (so we can mark them).
  const ownedIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of ownedData?.owned ?? []) set.add(o.sku.id);
    return set;
  }, [ownedData]);

  const filtered = useMemo(() => {
    const items = catalog?.catalog ?? [];
    if (filter === 'all') return items;
    return items.filter((i) => i.category === filter);
  }, [catalog, filter]);

  if (isLoading) {
    return <p className="py-12 text-center font-mono text-xs text-white/40">Loading shop…</p>;
  }
  if (isError) {
    return (
      <p className="py-12 text-center font-mono text-xs text-red-300/70">
        Shop failed to load: {(error as Error)?.message}
      </p>
    );
  }
  if (filtered.length === 0) {
    return (
      <p className="py-12 text-center font-mono text-xs text-white/40">
        Nothing in this category yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {filtered.map((item) => (
        <ShopCard
          key={item.id}
          item={item}
          owned={ownedIds.has(item.id)}
          tokens={tokens}
          pending={buy.isPending && buy.variables === item.id}
          onBuy={() => buy.mutate(item.id)}
        />
      ))}
    </div>
  );
}

function ShopCard({
  item,
  owned,
  tokens,
  pending,
  onBuy,
}: {
  item: CosmeticCatalogItem;
  owned: boolean;
  tokens: number;
  pending: boolean;
  onBuy: () => void;
}) {
  const icon = CATEGORY_ICONS[item.category] ?? '✨';
  const rarityBorder = RARITY_BORDER[item.rarity] ?? 'border-cyan-400/15';
  const canAfford = tokens >= item.priceCt;
  return (
    <div className={`relative rounded-xl border bg-cyan-500/[0.04] p-3 ${rarityBorder}`}>
      <div className="flex aspect-square items-center justify-center rounded-lg bg-black/30 text-3xl">
        <span aria-hidden>{icon}</span>
      </div>
      <h3 className="mt-2 truncate font-mono text-[11px] uppercase tracking-[0.16em] text-cyan-100">
        {item.displayName}
      </h3>
      <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-cyan-300/40">
        {item.rarity} · {item.category}
      </p>
      {owned ? (
        <button
          type="button"
          disabled
          className="mt-2 w-full rounded-md bg-cyan-500/20 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-100/80"
        >
          Owned
        </button>
      ) : (
        <button
          type="button"
          onClick={onBuy}
          disabled={!canAfford || pending}
          className={`mt-2 w-full rounded-md py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all disabled:opacity-50 ${
            canAfford
              ? 'bg-cyan-500/30 text-cyan-100 hover:bg-cyan-500/40'
              : 'bg-white/5 text-white/40'
          }`}
          title={canAfford ? `Buy for ${item.priceCt} CT` : `Need ${item.priceCt} CT (you have ${tokens})`}
        >
          {pending ? 'Buying…' : `Buy · ${item.priceCt} 🪙`}
        </button>
      )}
      {item.description ? (
        <p
          className="mt-1 line-clamp-2 font-mono text-[9px] leading-snug text-white/40"
          title={item.description}
        >
          {item.description}
        </p>
      ) : null}
    </div>
  );
}
