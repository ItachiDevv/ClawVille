'use client';

/**
 * Q3 plan §4.4 — Cosmetic drawer.
 *
 * Lists the player's OWNED cosmetics with category filter chips and
 * equip/unequip toggles. Reads from useOwnedCosmetics() (React Query) so
 * other surfaces (3D loader, shop) share the same cache.
 *
 * NO purchase flow here — that's Phase 4 storefront. This drawer assumes
 * items are already owned (acquired via gift/reward or future shop). For
 * Phase 3 launch the catalog is empty; first content drop will be the 4
 * surfboards from the Reef Race v2 session.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────┐
 *   │  Cosmetics                              [×]    │
 *   │  ─────────────────────────────────────         │
 *   │  [All] [Hats] [Glasses] [Auras] [Boards]       │
 *   │  ─────────────────────────────────────         │
 *   │  ┌──────┐  ┌──────┐  ┌──────┐                  │
 *   │  │ icon │  │ icon │  │ icon │   ...            │
 *   │  │ name │  │ name │  │ name │                  │
 *   │  │ [eqp]│  │ [   ]│  │ [eqp]│                  │
 *   │  └──────┘  └──────┘  └──────┘                  │
 *   └────────────────────────────────────────────────┘
 */

import { useMemo, useState } from 'react';
import { useOwnedCosmetics, useEquipCosmetic, type OwnedCosmetic } from '@/hooks/use-cosmetics';

const CATEGORY_FILTERS: { id: string; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '✨' },
  { id: 'hat', label: 'Hats', icon: '🎩' },
  { id: 'glasses', label: 'Glasses', icon: '🕶️' },
  { id: 'aura', label: 'Auras', icon: '🌟' },
  { id: 'board', label: 'Boards', icon: '🏄' },
  { id: 'particle', label: 'Particles', icon: '✦' },
  { id: 'palette', label: 'Palettes', icon: '🎨' },
  { id: 'outfit', label: 'Outfits', icon: '👕' },
];

// Category → icon glyph for the SKU card when no preview image is available.
// Phase 3 ships without preview render; Phase 4 storefront will add real
// thumbnails generated from the variants.
const CATEGORY_ICONS: Record<string, string> = Object.fromEntries(
  CATEGORY_FILTERS.map((c) => [c.id, c.icon]),
);

interface CosmeticDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function CosmeticDrawer({ open, onClose }: CosmeticDrawerProps) {
  const { data, isLoading, isError, error } = useOwnedCosmetics();
  const equip = useEquipCosmetic();
  const [filter, setFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.owned;
    return data.owned.filter((o) => o.sku.category === filter);
  }, [data, filter]);

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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cosmetics drawer"
            className="rounded-full px-2 py-1 font-mono text-sm text-white/60 hover:text-white"
          >
            ×
          </button>
        </header>

        <div className="mt-4 flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map((f) => {
            const active = f.id === filter;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[10px] font-mono uppercase tracking-[0.18em] transition-all ${
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

        <div className="mt-5 max-h-[55vh] overflow-y-auto">
          {isLoading ? (
            <p className="py-12 text-center font-mono text-xs text-white/40">Loading cosmetics…</p>
          ) : isError ? (
            <p className="py-12 text-center font-mono text-xs text-red-300/70">
              Failed to load cosmetics: {(error as Error)?.message}
            </p>
          ) : filtered.length === 0 ? (
            <EmptyState filter={filter} hasAny={(data?.owned ?? []).length > 0} />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {filtered.map((o) => (
                <CosmeticCard
                  key={o.id}
                  cosmetic={o}
                  onToggle={() =>
                    equip.mutate({ skuId: o.sku.id, equipped: !o.equipped })
                  }
                  pending={equip.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CosmeticCard({
  cosmetic,
  onToggle,
  pending,
}: {
  cosmetic: OwnedCosmetic;
  onToggle: () => void;
  pending: boolean;
}) {
  const icon = CATEGORY_ICONS[cosmetic.sku.category] ?? '✨';
  return (
    <div
      className={`relative rounded-xl border bg-cyan-500/[0.04] p-3 transition-all ${
        cosmetic.equipped
          ? 'border-cyan-300/60 shadow-[0_0_18px_rgba(0,229,255,0.18)]'
          : 'border-cyan-400/15'
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

function EmptyState({ filter, hasAny }: { filter: string; hasAny: boolean }) {
  if (!hasAny) {
    return (
      <div className="py-12 text-center font-mono text-xs text-white/40">
        <p>No cosmetics yet.</p>
        <p className="mt-2">First drops land soon — keep playing to earn ClawTokens.</p>
      </div>
    );
  }
  return (
    <p className="py-12 text-center font-mono text-xs text-white/40">
      No {filter} owned. Try another category.
    </p>
  );
}
