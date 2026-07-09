'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useGameStore } from '@/stores/game';
import { useQuestStore, triggerQuestCheck } from '@/stores/quest';
import { useAvatar } from '@/hooks/use-avatar';

export default function ShopOverlay() {
  const { shopOpen, closeShop, currentLocation, addToast, setCosmeticDrawerOpen } = useGameStore();
  const { data: avatar } = useAvatar();
  const queryClient = useQueryClient();
  const [buyingId, setBuyingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['shop-items', currentLocation],
    queryFn: () => api.getShopItems(currentLocation!),
    enabled: shopOpen && !!currentLocation,
  });

  const buyMutation = useMutation({
    mutationFn: (itemId: string) => api.buyItem(itemId),
    onSuccess: (res) => {
      addToast('🛒', `Bought ${res.item.name}!`);
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      // Quest counters — Tier 4 Shop & Study, Inventory in Action,
      // Library Card all gate on bookBought / itemsBought. The
      // distinct-set tracker captures which buildings a player has
      // bought books from for Library Card.
      const qs = useQuestStore.getState();
      qs.incrementCounter('itemsBought', 1);
      if (res.item.isBook) {
        qs.incrementCounter('booksBought', 1);
        if (currentLocation) qs.recordDistinct('distinctBookBuildings', currentLocation);
      }
      triggerQuestCheck();
      setBuyingId(null);
    },
    onError: (err: Error) => {
      // Branch on the machine-readable `err.code`, never raw message text
      // (feedback_web_apierror_carries_status_code). Guests buy on a DEMO balance
      // now, so surface demo-appropriate context instead of dumping a raw error.
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'guest_not_allowed') {
        // Defensive backstop — `/buy` no longer guest-gates (guests settle demo
        // CT), so this should not fire here. If some other guest-blocked surface
        // ever routes through, nudge to sign up rather than show a raw gate error.
        addToast('🔒', 'Demo economy — create a free account to use real ClawTokens.');
      } else if (code === 'insufficient_ct') {
        // Guest demo balance too low for this book (the Buy button already
        // disables on `!canAfford`, so this is a rare race backstop).
        addToast('🪙', 'Not enough demo ClawTokens for that.');
      } else {
        addToast('❌', err.message);
      }
      setBuyingId(null);
    },
  });

  if (!shopOpen || !currentLocation) return null;

  const items = data?.items ?? [];
  const tokens = avatar?.clawTokens ?? 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="claw-panel w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-bold text-lg">Shop</h2>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold text-cyan-200 bg-cyan-500/20 border border-cyan-400/30 rounded-full px-2 py-0.5">
              <span className="text-sm">&#x1FA99;</span>
              {tokens}
            </span>
            <button
              onClick={closeShop}
              className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 hover:bg-black/40 text-white font-bold text-sm transition-colors"
            >
              X
            </button>
          </div>
        </div>

        {/* Items list */}
        <div className="flex-1 overflow-y-auto space-y-2">
          {isLoading ? (
            <p className="text-cyan-300/60 text-sm text-center py-8 font-mono uppercase tracking-[0.2em]">Loading shop…</p>
          ) : items.length === 0 ? (
            <p className="text-cyan-300/60 text-sm text-center py-8 font-mono uppercase tracking-[0.2em]">No items available.</p>
          ) : (
            items.map((item) => {
              const canAfford = tokens >= item.price;
              const isBuying = buyingId === item.id;
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:border-cyan-500/30 transition-colors"
                >
                  <span className="text-2xl">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-white text-sm">{item.name}</div>
                    <p className="text-white/60 text-xs mt-0.5 line-clamp-2">{item.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs font-bold text-cyan-200">
                      {item.price} &#x1FA99;
                    </span>
                    <button
                      onClick={() => {
                        setBuyingId(item.id);
                        buyMutation.mutate(item.id);
                      }}
                      disabled={!canAfford || isBuying}
                      className="text-xs font-bold px-3 py-1 rounded bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-40 text-white transition-colors shadow-[0_0_12px_rgba(0,229,255,0.2)]"
                    >
                      {isBuying ? '...' : canAfford ? 'Buy' : 'Need more'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Cosmetics entry — building shop sells knowledge books only.
            Cosmetics (skins, hats, surfboards, etc.) are global and live in
            their own drawer. Surface a clear entry point here so players
            don't have to find the sidebar menu to spend tokens on a board. */}
        <button
          type="button"
          onClick={() => {
            closeShop();
            setCosmeticDrawerOpen(true);
          }}
          className="mt-3 w-full flex items-center justify-between px-4 py-3 rounded-lg
                     bg-gradient-to-r from-pink-500/15 to-fuchsia-500/15
                     border border-pink-400/30 hover:border-pink-300/60
                     hover:from-pink-500/25 hover:to-fuchsia-500/25 transition-all
                     shadow-[0_0_20px_rgba(236,72,153,0.15)]"
        >
          <span className="flex items-center gap-2">
            <span className="text-lg">✨</span>
            <span className="font-bold text-sm text-pink-100">Browse Cosmetics</span>
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-pink-300/80">
            skins · hats · boards →
          </span>
        </button>
      </div>
    </div>
  );
}
