'use client';

/**
 * AuctionModal — Team 3a Gameify reskin. Visual rewrite of the auction house
 * using the shared RPG primitives from `@/components/rpg`, following the same
 * structural pattern established by Team 1's `bazaar-modal.tsx` anchor.
 *
 * Data flow is preserved byte-for-byte: every useQuery / useMutation / store
 * hook / query key / mutation function is identical to the previous
 * implementation — only the presentation layer changed.
 *
 * Auction-specific UI touches layered on top of the Team 1 primitives:
 *
 *   • Live countdown rendered into ItemCard's `badge` slot. Formats as
 *     `2h 34m`, `34m 17s`, `17s`, or a pulsing red `SNIPING` label in the
 *     final 30 seconds of an auction.
 *
 *   • Snipe-protection flash: every card tracks its own `bidCount` across
 *     query refetches and, when a new bid lands inside the 30s window, flashes
 *     a transient `+30s` token beside the countdown (~2s visible). The
 *     backend handles the actual timer extension; the modal just visualises
 *     it against the polled query data.
 *
 *   • Buy Now premium: the Buy Now CTA uses `<RpgButton rarity="legendary">`
 *     to inherit the gold palette from the rarity registry, giving it a
 *     visually distinct "premium" treatment vs. the regular Place Bid button.
 *
 *   • Bid input floor: the bid input is disabled until `amount >= minBid`
 *     (current highest + 1), with a "Minimum bid: X NT" hint below.
 *
 * Default tier for auction lots is `epic` per the brief — auctions should
 * feel more dramatic than bazaar browses. Items that carry their own
 * server-side rarity override this (e.g. an `agent-config` lot with
 * `rarity === 'legendary'`).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';
import {
  RpgModal,
  RpgButton,
  RuneSpinner,
  RuneFrame,
  ItemCard,
  RarityBadge,
  RpgTooltip,
  getRarity,
  type RarityId,
} from '@/components/rpg';

type AuctionTab = 'browse' | 'my-auctions' | 'my-bids';
type SortMode = 'ending-soon' | 'newest' | 'highest-bid';
type ItemTypeFilter = 'all' | 'skill' | 'agent-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a server-side rarity into a known RarityId, defaulting to `epic`
 * for auction lots (unlike bazaar's `common` default — auctions are more
 * dramatic). An explicit `null`/`undefined`/unknown server rarity falls back
 * to `epic`; a real server-side rarity always wins.
 */
function normaliseAuctionRarity(value: unknown): RarityId {
  if (typeof value !== 'string') return 'epic';
  const resolved = getRarity(value);
  // getRarity falls back to 'common' for unknown strings — we upgrade that
  // fallback to 'epic' for auctions, but honour any real match.
  if (resolved.id === 'common' && value.toLowerCase() !== 'common') return 'epic';
  return resolved.id;
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  skill: 'Skill',
  'agent-config': 'Agent Config',
};

function itemTypeLabel(itemType: string | undefined): string {
  if (!itemType) return 'Skill';
  return ITEM_TYPE_LABELS[itemType] ?? itemType;
}

// ---------------------------------------------------------------------------
// Countdown — auction-specific, reads the backend `endsAt` and ticks every 1s.
// Renders into ItemCard's `badge` slot or inline via a span wrapper.
// ---------------------------------------------------------------------------

type CountdownPhase = 'calm' | 'urgent' | 'sniping' | 'ended';

function formatCountdown(ms: number): { label: string; phase: CountdownPhase } {
  if (ms <= 0) return { label: 'Ended', phase: 'ended' };
  if (ms <= 30_000) {
    // Last 30 seconds — "SNIPING" pulse.
    const s = Math.ceil(ms / 1000);
    return { label: `${s}s`, phase: 'sniping' };
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (h > 0) return { label: `${h}h ${m}m`, phase: 'calm' };
  if (m > 0) return { label: `${m}m ${s}s`, phase: ms < 300_000 ? 'urgent' : 'calm' };
  return { label: `${s}s`, phase: 'urgent' };
}

function useCountdown(endsAt: string | undefined | null) {
  const [state, setState] = useState<{ label: string; phase: CountdownPhase }>(
    () =>
      endsAt
        ? formatCountdown(new Date(endsAt).getTime() - Date.now())
        : { label: '—', phase: 'ended' }
  );

  useEffect(() => {
    if (!endsAt) return;
    const tick = () => {
      const ms = new Date(endsAt).getTime() - Date.now();
      setState(formatCountdown(ms));
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [endsAt]);

  return state;
}

function CountdownBadge({
  endsAt,
  snipeFlash,
}: {
  endsAt: string | undefined | null;
  snipeFlash?: boolean;
}) {
  const { label, phase } = useCountdown(endsAt);

  const colorByPhase: Record<CountdownPhase, { base: string; border: string; bg: string }> = {
    calm: {
      base: '#7dd3fc',
      border: 'rgba(56, 189, 248, 0.45)',
      bg: 'rgba(56, 189, 248, 0.12)',
    },
    urgent: {
      base: '#fb923c',
      border: 'rgba(249, 115, 22, 0.5)',
      bg: 'rgba(249, 115, 22, 0.15)',
    },
    sniping: {
      base: '#f87171',
      border: 'rgba(220, 38, 38, 0.6)',
      bg: 'rgba(220, 38, 38, 0.18)',
    },
    ended: {
      base: '#94a3b8',
      border: 'rgba(148, 163, 184, 0.35)',
      bg: 'rgba(30, 41, 59, 0.6)',
    },
  };
  const palette = colorByPhase[phase];
  const display = phase === 'sniping' ? `SNIPING · ${label}` : label;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        fontFamily: 'var(--font-orbitron), sans-serif',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: palette.base,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        animation: phase === 'sniping' ? 'rpg-pulse-rarity 1.1s ease-in-out infinite' : undefined,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ fontSize: 10 }}>⧗</span>
      {display}
      {snipeFlash && (
        <span
          aria-hidden
          style={{
            marginLeft: 4,
            padding: '1px 6px',
            borderRadius: 999,
            background: 'rgba(34, 197, 94, 0.25)',
            border: '1px solid rgba(34, 197, 94, 0.55)',
            color: '#4ade80',
            fontSize: 9,
            letterSpacing: '0.1em',
          }}
        >
          +30s
        </span>
      )}
    </span>
  );
}

/**
 * Track increments of `bidCount` across React Query refetches and flash a
 * "snipe saved" indicator for ~1.8s whenever a new bid arrives inside the
 * final 30s window. The backend handles the actual timer extension; this
 * hook only surfaces the visual cue.
 */
function useSnipeFlash(
  bidCount: number | undefined,
  endsAt: string | undefined | null
): boolean {
  const [flash, setFlash] = useState(false);
  const prevCount = useRef<number>(bidCount ?? 0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const nextCount = bidCount ?? 0;
    if (nextCount > prevCount.current && endsAt) {
      const remaining = new Date(endsAt).getTime() - Date.now();
      if (remaining > 0 && remaining <= 60_000) {
        // Bid landed inside the danger window — flash the +30s indicator.
        setFlash(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setFlash(false), 1800);
      }
    }
    prevCount.current = nextCount;
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [bidCount, endsAt]);

  return flash;
}

// ---------------------------------------------------------------------------
// Inline bid input — used inside both browse cards and the My Bids tab.
// ---------------------------------------------------------------------------

const INLINE_INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(10, 22, 40, 0.85)',
  border: '1px solid rgba(56, 189, 248, 0.25)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 11,
  color: '#e2e8f0',
  outline: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  width: '100%',
};

function BidInputRow({
  minBid,
  submitting,
  onSubmit,
  onCancel,
  confirmLabel = 'Confirm',
}: {
  minBid: number;
  submitting: boolean;
  onSubmit: (amount: number) => void;
  onCancel: () => void;
  confirmLabel?: string;
}) {
  const [amount, setAmount] = useState<string>(String(minBid));
  const numeric = Number(amount);
  const valid = Number.isFinite(numeric) && numeric >= minBid;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 8,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(10, 22, 40, 0.7)',
        border: '1px solid rgba(168, 85, 247, 0.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={minBid}
          placeholder={String(minBid)}
          style={INLINE_INPUT_STYLE}
          onClick={(e) => e.stopPropagation()}
        />
        <RpgButton
          variant="primary"
          size="sm"
          disabled={!valid}
          loading={submitting}
          onClick={(e) => {
            e.stopPropagation();
            if (valid) onSubmit(numeric);
          }}
        >
          {confirmLabel}
        </RpgButton>
        <RpgButton
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </RpgButton>
      </div>
      <span
        style={{
          fontSize: 9,
          color: valid ? '#64748b' : '#fb923c',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 700,
        }}
      >
        Minimum bid: {minBid} NT
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse tab — auction lot card
// ---------------------------------------------------------------------------

function BrowseAuctionCard({
  auction,
  onOpenDetail,
  onBid,
  onBuyNow,
  bidding,
  buyingNow,
}: {
  auction: any;
  onOpenDetail: () => void;
  onBid: (amount: number) => void;
  onBuyNow?: () => void;
  bidding: boolean;
  buyingNow: boolean;
}) {
  const [showBidInput, setShowBidInput] = useState(false);
  const rarity = normaliseAuctionRarity(auction.rarity);
  const currentBid: number = auction.currentBid || auction.startingBid || 0;
  const minBid = currentBid + 1;
  const isEnded = new Date(auction.endsAt).getTime() <= Date.now();
  const snipeFlash = useSnipeFlash(auction.bidCount, auction.endsAt);
  const bidCount: number = auction.bidCount ?? 0;

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Type', value: itemTypeLabel(auction.itemType) },
    { label: bidCount > 0 ? 'Current' : 'Start', value: `${currentBid} NT` },
    { label: 'Bids', value: bidCount },
  ];
  if (auction.buyNowPrice && !isEnded) {
    stats.push({ label: 'Buy Now', value: `${auction.buyNowPrice} NT` });
  }
  if (auction.sellerName) {
    stats.push({ label: 'Seller', value: auction.sellerName });
  }

  return (
    <ItemCard
      rarity={rarity}
      name={auction.title || 'Untitled Auction'}
      subtitle={`by ${auction.sellerName || 'Unknown'}`}
      icon={<span>⚔</span>}
      description={auction.description}
      stats={stats}
      price={currentBid}
      priceUnit="NT"
      badge={<CountdownBadge endsAt={auction.endsAt} snipeFlash={snipeFlash} />}
      onClick={onOpenDetail}
      footer={
        isEnded ? (
          <span
            style={{
              fontSize: 10,
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontWeight: 700,
              marginLeft: 'auto',
            }}
          >
            Auction Ended
          </span>
        ) : showBidInput ? (
          <div style={{ flex: 1 }}>
            <BidInputRow
              minBid={minBid}
              submitting={bidding}
              onSubmit={(amount) => {
                onBid(amount);
                setShowBidInput(false);
              }}
              onCancel={() => setShowBidInput(false)}
            />
          </div>
        ) : (
          <>
            <span style={{ fontSize: 10, color: '#64748b' }}>
              Min bid {minBid} NT
            </span>
            <div
              style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              {auction.buyNowPrice && onBuyNow && (
                <RpgTooltip
                  content={`Skip the countdown and claim instantly for ${auction.buyNowPrice} NT.`}
                >
                  <RpgButton
                    variant="primary"
                    rarity="legendary"
                    size="sm"
                    loading={buyingNow}
                    onClick={(e) => {
                      e.stopPropagation();
                      onBuyNow();
                    }}
                  >
                    Buy Now {auction.buyNowPrice} NT
                  </RpgButton>
                </RpgTooltip>
              )}
              <RpgButton
                variant="primary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowBidInput(true);
                }}
              >
                Place Bid
              </RpgButton>
            </div>
          </>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// My auctions card
// ---------------------------------------------------------------------------

function MyAuctionCard({
  auction,
  onCancel,
  cancelling,
}: {
  auction: any;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const rarity = normaliseAuctionRarity(auction.rarity);
  const canCancel =
    auction.status === 'active' && (!auction.bidCount || auction.bidCount === 0);
  const snipeFlash = useSnipeFlash(auction.bidCount, auction.endsAt);

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Type', value: itemTypeLabel(auction.itemType) },
    { label: 'Start Bid', value: `${auction.startingBid} NT` },
  ];
  if (auction.currentBid > 0) {
    stats.push({ label: 'Current', value: `${auction.currentBid} NT` });
  }
  if (auction.buyNowPrice) {
    stats.push({ label: 'Buy Now', value: `${auction.buyNowPrice} NT` });
  }
  stats.push({ label: 'Bids', value: auction.bidCount ?? 0 });
  if (auction.status === 'resolved' && auction.finalPrice != null) {
    stats.push({ label: 'Sold For', value: `${auction.finalPrice} NT` });
  }

  const statusLabel = auction.status || 'active';
  const statusPalette: Record<string, { color: string; bg: string; border: string }> = {
    active: {
      color: '#4ade80',
      bg: 'rgba(34, 197, 94, 0.12)',
      border: 'rgba(34, 197, 94, 0.5)',
    },
    ended: {
      color: '#94a3b8',
      bg: 'rgba(148, 163, 184, 0.12)',
      border: 'rgba(148, 163, 184, 0.5)',
    },
    resolved: {
      color: '#facc15',
      bg: 'rgba(250, 204, 21, 0.12)',
      border: 'rgba(250, 204, 21, 0.5)',
    },
    cancelled: {
      color: '#f87171',
      bg: 'rgba(220, 38, 38, 0.12)',
      border: 'rgba(220, 38, 38, 0.5)',
    },
  };
  const statusStyle = statusPalette[statusLabel] ?? statusPalette.ended;

  return (
    <ItemCard
      rarity={rarity}
      name={auction.title || 'Untitled Auction'}
      subtitle={`${itemTypeLabel(auction.itemType)} · Your auction`}
      icon={<span>📜</span>}
      stats={stats}
      badge={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: statusStyle.color,
            background: statusStyle.bg,
            border: `1px solid ${statusStyle.border}`,
          }}
        >
          {statusLabel}
        </span>
      }
      footer={
        <>
          {auction.status === 'active' && auction.endsAt ? (
            <CountdownBadge endsAt={auction.endsAt} snipeFlash={snipeFlash} />
          ) : (
            <span
              style={{
                fontSize: 10,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              {auction.status === 'resolved'
                ? `Sold ${auction.finalPrice ?? 0} NT`
                : 'Not active'}
            </span>
          )}
          {canCancel && (
            <RpgButton
              variant="danger"
              size="sm"
              loading={cancelling}
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              Cancel Auction
            </RpgButton>
          )}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// My bids card
// ---------------------------------------------------------------------------

function MyBidCard({
  auction,
  onIncreaseBid,
  submitting,
}: {
  auction: any;
  onIncreaseBid: (amount: number) => void;
  submitting: boolean;
}) {
  const [showBidInput, setShowBidInput] = useState(false);
  const rarity = normaliseAuctionRarity(auction.rarity);
  const isWinning = auction.isWinning || auction.bidStatus === 'winning';
  const isEnded = new Date(auction.endsAt).getTime() <= Date.now();
  const currentBid: number = auction.currentBid || auction.startingBid || 0;
  const minBid = currentBid + 1;
  const snipeFlash = useSnipeFlash(auction.bidCount, auction.endsAt);

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Your Bid', value: `${auction.myBid || 0} NT` },
    { label: 'Current', value: `${currentBid} NT` },
    { label: 'Bids', value: auction.bidCount ?? 0 },
    { label: 'Type', value: itemTypeLabel(auction.itemType) },
  ];

  const statusLabel = isEnded
    ? isWinning
      ? 'Won'
      : 'Lost'
    : isWinning
      ? 'Winning'
      : 'Outbid';
  const statusPalette = {
    Won: { color: '#4ade80', bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.5)' },
    Lost: { color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.5)' },
    Winning: {
      color: '#4ade80',
      bg: 'rgba(34, 197, 94, 0.15)',
      border: 'rgba(34, 197, 94, 0.5)',
    },
    Outbid: {
      color: '#fb923c',
      bg: 'rgba(249, 115, 22, 0.15)',
      border: 'rgba(249, 115, 22, 0.5)',
    },
  } as const;
  const statusStyle = statusPalette[statusLabel];

  return (
    <ItemCard
      rarity={rarity}
      name={auction.title || 'Untitled Auction'}
      subtitle={`by ${auction.sellerName || 'Unknown'}`}
      icon={<span>🎯</span>}
      stats={stats}
      badge={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: statusStyle.color,
            background: statusStyle.bg,
            border: `1px solid ${statusStyle.border}`,
          }}
        >
          {statusLabel}
        </span>
      }
      footer={
        <>
          {!isEnded && auction.endsAt ? (
            <CountdownBadge endsAt={auction.endsAt} snipeFlash={snipeFlash} />
          ) : (
            <span
              style={{
                fontSize: 10,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              Ended
            </span>
          )}
          {!isWinning && !isEnded && (
            <div onClick={(e) => e.stopPropagation()} style={{ marginLeft: 'auto' }}>
              {showBidInput ? (
                <BidInputRow
                  minBid={minBid}
                  submitting={submitting}
                  confirmLabel="Raise"
                  onSubmit={(amount) => {
                    onIncreaseBid(amount);
                    setShowBidInput(false);
                  }}
                  onCancel={() => setShowBidInput(false)}
                />
              ) : (
                <RpgButton
                  variant="primary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowBidInput(true);
                  }}
                >
                  Increase Bid
                </RpgButton>
              )}
            </div>
          )}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Auction detail panel — drilldown view inside the Browse tab.
// ---------------------------------------------------------------------------

function AuctionDetail({
  auctionId,
  onBack,
}: {
  auctionId: string;
  onBack: () => void;
}) {
  const { addToast } = useGameStore();
  const queryClient = useQueryClient();
  const [bidAmount, setBidAmount] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['auction-detail', auctionId],
    queryFn: () => api.getAuction(auctionId),
    refetchInterval: 10000,
  });

  const bidMutation = useMutation({
    mutationFn: (amount: number) => api.placeBid(auctionId, amount),
    onSuccess: () => {
      addToast('\u2696\uFE0F', 'Bid placed successfully!');
      queryClient.invalidateQueries({ queryKey: ['auction-detail', auctionId] });
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      setBidAmount('');
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Bid failed');
    },
  });

  const buyNowMutation = useMutation({
    mutationFn: () => api.buyNow(auctionId),
    onSuccess: () => {
      addToast('\u2696\uFE0F', 'Auction won! Item purchased.');
      queryClient.invalidateQueries({ queryKey: ['auction-detail', auctionId] });
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Buy failed');
    },
  });

  const auction = data?.auction;
  const bids: any[] = data?.bids ?? [];
  const snipeFlash = useSnipeFlash(auction?.bidCount, auction?.endsAt);

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          padding: '60px 0',
        }}
      >
        <RuneSpinner size={44} tier="epic" />
        <span
          style={{
            fontSize: 10,
            color: '#64748b',
            textTransform: 'uppercase',
            letterSpacing: '0.2em',
          }}
        >
          Summoning lot manifest
        </span>
      </div>
    );
  }

  if (!auction) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <p style={{ color: '#64748b', fontSize: 12 }}>Auction not found.</p>
        <RpgButton variant="ghost" size="sm" onClick={onBack} style={{ marginTop: 10 }}>
          ← Back to Browse
        </RpgButton>
      </div>
    );
  }

  const rarity = normaliseAuctionRarity(auction.rarity);
  const currentBid: number = auction.currentBid || auction.startingBid || 0;
  const minBid = currentBid + 1;
  const isEnded = new Date(auction.endsAt).getTime() <= Date.now();
  const numericBid = Number(bidAmount);
  const bidValid = Number.isFinite(numericBid) && numericBid >= minBid;

  return (
    <div
      style={{
        padding: '14px 22px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <RpgButton variant="ghost" size="sm" onClick={onBack} style={{ alignSelf: 'flex-start' }}>
        ← Back to Browse
      </RpgButton>

      {/* Header lot card (feature block — uses RuneFrame directly for a taller hero) */}
      <RuneFrame tier={rarity} glow={rarity === 'legendary' ? 'subtle' : false}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            padding: '18px 20px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <h3
                  style={{
                    fontFamily: 'var(--font-orbitron), sans-serif',
                    fontSize: 18,
                    fontWeight: 700,
                    color: '#f1f5f9',
                    letterSpacing: '0.04em',
                    margin: 0,
                    textShadow: `0 0 14px ${getRarity(rarity).glow}`,
                  }}
                >
                  {auction.title}
                </h3>
                <RarityBadge tier={rarity} size="md" />
                <span
                  style={{
                    fontSize: 10,
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                  }}
                >
                  {itemTypeLabel(auction.itemType)}
                </span>
              </div>
              {auction.description && (
                <p
                  style={{
                    fontSize: 12,
                    color: '#cbd5e1',
                    margin: '8px 0 0',
                    lineHeight: 1.5,
                  }}
                >
                  {auction.description}
                </p>
              )}
              <p
                style={{
                  fontSize: 11,
                  color: '#64748b',
                  margin: '6px 0 0',
                }}
              >
                Offered by {auction.sellerName || 'Unknown'}
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 8,
              }}
            >
              <div style={{ textAlign: 'right' }}>
                <p
                  style={{
                    fontSize: 9,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '0.14em',
                    margin: 0,
                    fontWeight: 700,
                  }}
                >
                  Current Bid
                </p>
                <p
                  style={{
                    fontFamily: 'var(--font-orbitron), sans-serif',
                    fontSize: 22,
                    fontWeight: 700,
                    color: '#facc15',
                    margin: '2px 0 0',
                    textShadow: '0 0 12px rgba(250, 204, 21, 0.45)',
                  }}
                >
                  {currentBid} <span style={{ fontSize: 11, color: '#ca8a04' }}>NT</span>
                </p>
              </div>
              <CountdownBadge endsAt={auction.endsAt} snipeFlash={snipeFlash} />
            </div>
          </div>

          {/* Bid / Buy Now actions */}
          {!isEnded && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                paddingTop: 14,
                borderTop: '1px dashed rgba(148, 163, 184, 0.25)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  flex: 1,
                  minWidth: 220,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="number"
                    value={bidAmount}
                    onChange={(e) => setBidAmount(e.target.value)}
                    min={minBid}
                    placeholder={`Min bid: ${minBid}`}
                    style={{ ...INLINE_INPUT_STYLE, flex: 1, fontSize: 13, padding: '8px 12px' }}
                  />
                  <RpgButton
                    variant="primary"
                    size="md"
                    disabled={!bidValid}
                    loading={bidMutation.isPending}
                    onClick={() => bidMutation.mutate(numericBid)}
                  >
                    Place Bid
                  </RpgButton>
                </div>
                <span
                  style={{
                    fontSize: 9,
                    color: bidValid || !bidAmount ? '#64748b' : '#fb923c',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    fontWeight: 700,
                  }}
                >
                  Minimum bid: {minBid} NT
                </span>
              </div>
              {auction.buyNowPrice && (
                <RpgTooltip
                  content={`Claim the lot instantly for ${auction.buyNowPrice} NT — skips the countdown.`}
                >
                  <RpgButton
                    variant="primary"
                    rarity="legendary"
                    size="md"
                    loading={buyNowMutation.isPending}
                    onClick={() => buyNowMutation.mutate()}
                  >
                    Buy Now {auction.buyNowPrice} NT
                  </RpgButton>
                </RpgTooltip>
              )}
            </div>
          )}
        </div>
      </RuneFrame>

      {/* Bid history — each entry rendered as a slim RuneFrame mini-card */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 10,
          }}
        >
          <h4
            style={{
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 13,
              fontWeight: 700,
              color: '#7dd3fc',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              margin: 0,
            }}
          >
            Bid History
          </h4>
          <span
            style={{
              fontSize: 10,
              color: '#64748b',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {bids.length} {bids.length === 1 ? 'bid' : 'bids'}
          </span>
        </div>
        {bids.length === 0 ? (
          <div
            style={{
              padding: '24px 0',
              textAlign: 'center',
              fontSize: 12,
              color: '#64748b',
            }}
          >
            No bids yet. Be the first to strike.
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: '32vh',
              overflowY: 'auto',
              paddingRight: 4,
            }}
          >
            {bids.map((bid, i) => (
              <RuneFrame
                key={bid.id || i}
                tier={i === 0 ? 'legendary' : 'common'}
                glow={false}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px 14px',
                  }}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}
                  >
                    {i === 0 && (
                      <span
                        style={{
                          fontSize: 9,
                          color: '#fb923c',
                          fontWeight: 700,
                          letterSpacing: '0.14em',
                          textTransform: 'uppercase',
                          textShadow: '0 0 6px rgba(249, 115, 22, 0.5)',
                        }}
                      >
                        ★ Highest
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 12,
                        color: '#e2e8f0',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {bid.bidderName || 'Anonymous'}
                    </span>
                  </div>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-orbitron), sans-serif',
                        fontSize: 13,
                        fontWeight: 700,
                        color: '#facc15',
                        textShadow: '0 0 8px rgba(250, 204, 21, 0.35)',
                      }}
                    >
                      {bid.amount} NT
                    </span>
                    <span style={{ fontSize: 10, color: '#64748b' }}>
                      {bid.createdAt ? new Date(bid.createdAt).toLocaleString() : ''}
                    </span>
                  </div>
                </div>
              </RuneFrame>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared empty state (copied from the bazaar anchor pattern).
// ---------------------------------------------------------------------------

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: string;
  title: string;
  hint: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '60px 20px',
        textAlign: 'center',
      }}
    >
      <span
        style={{ fontSize: 36, filter: 'drop-shadow(0 0 16px rgba(168, 85, 247, 0.35))' }}
      >
        {icon}
      </span>
      <h3
        style={{
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 14,
          fontWeight: 700,
          color: '#cbd5e1',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        {title}
      </h3>
      <p style={{ fontSize: 11, color: '#64748b', maxWidth: 360, margin: 0 }}>{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary stat block — small RuneFrame with three metric columns.
// ---------------------------------------------------------------------------

function SummaryStats({
  tier,
  items,
}: {
  tier: RarityId;
  items: { label: string; value: React.ReactNode; color?: string }[];
}) {
  return (
    <RuneFrame tier={tier} glow={false}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          padding: '12px 18px',
          flexWrap: 'wrap',
        }}
      >
        {items.map((it, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            {i > 0 && (
              <div
                style={{
                  height: 36,
                  width: 1,
                  background: 'rgba(148, 163, 184, 0.25)',
                }}
              />
            )}
            <div>
              <p
                style={{
                  fontSize: 9,
                  color: '#94a3b8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  margin: 0,
                  fontWeight: 700,
                }}
              >
                {it.label}
              </p>
              <p
                style={{
                  fontFamily: 'var(--font-orbitron), sans-serif',
                  fontSize: 20,
                  fontWeight: 700,
                  color: it.color || '#facc15',
                  margin: '2px 0 0',
                  textShadow: it.color
                    ? undefined
                    : '0 0 10px rgba(250, 204, 21, 0.4)',
                }}
              >
                {it.value}
              </p>
            </div>
          </div>
        ))}
      </div>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Shared list-pane styles
// ---------------------------------------------------------------------------

const LIST_PANE_STYLE: React.CSSProperties = {
  padding: '14px 22px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minHeight: 240,
  maxHeight: '58vh',
  overflowY: 'auto',
};

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function AuctionModal() {
  const { auctionOpen, closeAuction, auctionTab, setAuctionTab, addToast } = useGameStore();
  const { data: avatar } = useAvatar();
  const queryClient = useQueryClient();

  // Filters
  const [sort, setSort] = useState<SortMode>('ending-soon');
  const [itemType, setItemType] = useState<ItemTypeFilter>('all');
  const [page, setPage] = useState(1);

  // Local state
  const [biddingId, setBiddingId] = useState<string | null>(null);
  const [buyingNowId, setBuyingNowId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [detailAuctionId, setDetailAuctionId] = useState<string | null>(null);

  // Reset page on filter change
  useEffect(() => {
    setPage(1);
  }, [auctionTab, sort, itemType]);

  // Reset detail view on tab change
  useEffect(() => {
    setDetailAuctionId(null);
  }, [auctionTab]);

  // Build query params — kept byte-for-byte identical to the previous
  // implementation so every `useQuery` cache key lines up across versions.
  const queryParams = {
    page,
    itemType: itemType !== 'all' ? itemType : undefined,
    status: 'active',
    sort,
  };

  // Browse auctions query
  const { data: browseData, isLoading: browseLoading } = useQuery({
    queryKey: ['auctions', queryParams],
    queryFn: () => api.getAuctions(queryParams),
    enabled: auctionOpen && auctionTab === 'browse' && !detailAuctionId,
    refetchInterval: 15000,
  });

  // My auctions query
  const { data: myAuctionsData, isLoading: myAuctionsLoading } = useQuery({
    queryKey: ['auctions-mine'],
    queryFn: () => api.getMyAuctions(),
    enabled: auctionOpen && auctionTab === 'my-auctions',
  });

  // My bids query
  const { data: myBidsData, isLoading: myBidsLoading } = useQuery({
    queryKey: ['auctions-my-bids'],
    queryFn: () => api.getMyBids(),
    enabled: auctionOpen && auctionTab === 'my-bids',
  });

  // Bid mutation
  const bidMutation = useMutation({
    mutationFn: ({ auctionId, amount }: { auctionId: string; amount: number }) =>
      api.placeBid(auctionId, amount),
    onSuccess: () => {
      addToast('\u2696\uFE0F', 'Bid placed successfully!');
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['auctions-my-bids'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      setBiddingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Bid failed');
      setBiddingId(null);
    },
  });

  // Buy now mutation
  const buyNowMutation = useMutation({
    mutationFn: (auctionId: string) => api.buyNow(auctionId),
    onSuccess: () => {
      addToast('\u2696\uFE0F', 'Auction won! Item purchased.');
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['auctions-mine'] });
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      setBuyingNowId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Purchase failed');
      setBuyingNowId(null);
    },
  });

  // Cancel auction mutation
  const cancelMutation = useMutation({
    mutationFn: (auctionId: string) => api.cancelAuction(auctionId),
    onSuccess: () => {
      addToast('\uD83D\uDDD1\uFE0F', 'Auction cancelled');
      queryClient.invalidateQueries({ queryKey: ['auctions-mine'] });
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      setCancellingId(null);
    },
    onError: (err: Error) => {
      addToast('\u274C', err.message || 'Failed to cancel');
      setCancellingId(null);
    },
  });

  const handleBid = useCallback(
    (auctionId: string, amount: number) => {
      setBiddingId(auctionId);
      bidMutation.mutate({ auctionId, amount });
    },
    [bidMutation]
  );

  const handleBuyNow = useCallback(
    (auctionId: string) => {
      setBuyingNowId(auctionId);
      buyNowMutation.mutate(auctionId);
    },
    [buyNowMutation]
  );

  const handleCancel = useCallback(
    (auctionId: string) => {
      setCancellingId(auctionId);
      cancelMutation.mutate(auctionId);
    },
    [cancelMutation]
  );

  // Nested escape: if a detail panel is open, escape closes it first, then
  // the modal. We run capture-phase BEFORE RpgModal's own escape listener so
  // the "go back" transition always wins when a drilldown is active.
  useEffect(() => {
    if (!auctionOpen || !detailAuctionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDetailAuctionId(null);
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [auctionOpen, detailAuctionId]);

  if (!auctionOpen) return null;

  const auctions: any[] = browseData?.auctions ?? [];
  const total: number = browseData?.total ?? 0;
  const pageSize: number = browseData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myAuctions: any[] = myAuctionsData?.auctions ?? [];
  const myBids: any[] = myBidsData?.auctions ?? [];
  const tokens: number = (avatar as any)?.clawTokens ?? 0;

  const winningCount = myBids.filter(
    (a) =>
      (a.isWinning || a.bidStatus === 'winning') &&
      new Date(a.endsAt).getTime() > Date.now()
  ).length;
  const outbidCount = myBids.filter(
    (a) =>
      !(a.isWinning || a.bidStatus === 'winning') &&
      new Date(a.endsAt).getTime() > Date.now()
  ).length;
  const totalBidAmount = myBids.reduce((sum, a) => sum + (a.myBid || 0), 0);
  const activeAuctionCount = myAuctions.filter((a) => a.status === 'active').length;
  const totalEarned = myAuctions.reduce((sum, a) => sum + (a.finalPrice || 0), 0);
  const totalBidsReceived = myAuctions.reduce(
    (sum, a) => sum + (a.bidCount || 0),
    0
  );

  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: 'ending-soon', label: 'Ending Soon' },
    { value: 'newest', label: 'Newest' },
    { value: 'highest-bid', label: 'Highest Bid' },
  ];

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  return (
    <RpgModal
      open={auctionOpen}
      onClose={closeAuction}
      title="Auction House"
      subtitle="Bid · Win · Collect"
      tier="epic"
      glow="subtle"
      headerIcon={<span>⚖</span>}
      maxWidth={1040}
      tokenBadge={
        <RpgTooltip content="Your ClawToken balance — spent on bids and Buy Now claims.">
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              borderRadius: 999,
              background: 'rgba(250, 204, 21, 0.08)',
              border: '1px solid rgba(250, 204, 21, 0.35)',
              color: '#facc15',
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textShadow: '0 0 8px rgba(250, 204, 21, 0.35)',
            }}
          >
            <span style={{ fontSize: 13 }}>◈</span>
            {tokens} NT
          </span>
        </RpgTooltip>
      }
    >
      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '10px 22px 0',
          borderBottom: '1px solid rgba(168, 85, 247, 0.18)',
        }}
      >
        {(['browse', 'my-auctions', 'my-bids'] as AuctionTab[]).map((t) => {
          const isActive = auctionTab === t;
          const label =
            t === 'browse'
              ? 'Browse Auctions'
              : t === 'my-auctions'
                ? 'My Auctions'
                : 'My Bids';
          return (
            <button
              key={t}
              type="button"
              onClick={() => setAuctionTab(t)}
              style={{
                position: 'relative',
                padding: '10px 18px',
                background: 'transparent',
                border: 'none',
                fontFamily: 'var(--font-orbitron), sans-serif',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: isActive ? '#c084fc' : '#64748b',
                cursor: 'pointer',
                transition: 'color 180ms ease',
              }}
            >
              {label}
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 12,
                  right: 12,
                  bottom: -1,
                  height: 2,
                  background: isActive
                    ? 'linear-gradient(90deg, transparent 0%, #a855f7 50%, transparent 100%)'
                    : 'transparent',
                  boxShadow: isActive ? '0 0 10px rgba(168, 85, 247, 0.55)' : 'none',
                  transition: 'background 200ms ease',
                }}
              />
            </button>
          );
        })}
      </div>

      {/* ============================== BROWSE TAB ============================== */}
      {auctionTab === 'browse' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {detailAuctionId ? (
            <AuctionDetail
              auctionId={detailAuctionId}
              onBack={() => setDetailAuctionId(null)}
            />
          ) : (
            <>
              {/* Filters */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 22px',
                  borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
                }}
              >
                <select
                  value={itemType}
                  onChange={(e) => setItemType(e.target.value as ItemTypeFilter)}
                  style={{
                    ...INLINE_INPUT_STYLE,
                    width: 'auto',
                  }}
                >
                  <option value="all">All Types</option>
                  <option value="skill">Skills</option>
                  <option value="agent-config">Agent Configs</option>
                </select>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    marginLeft: 'auto',
                  }}
                >
                  <span
                    style={{
                      fontSize: 9,
                      color: '#64748b',
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      fontWeight: 700,
                    }}
                  >
                    Sort
                  </span>
                  {SORT_OPTIONS.map((s) => (
                    <RpgButton
                      key={s.value}
                      variant="ghost"
                      size="sm"
                      onClick={() => setSort(s.value)}
                      style={{
                        fontSize: 9,
                        padding: '4px 10px',
                        background:
                          sort === s.value
                            ? 'rgba(168, 85, 247, 0.15)'
                            : 'rgba(10, 22, 40, 0.4)',
                        color: sort === s.value ? '#c084fc' : '#94a3b8',
                        border: `1px solid ${sort === s.value ? 'rgba(168, 85, 247, 0.5)' : 'rgba(148, 163, 184, 0.2)'}`,
                      }}
                    >
                      {s.label}
                    </RpgButton>
                  ))}
                </div>
              </div>

              {/* Auction grid */}
              <div style={LIST_PANE_STYLE}>
                {browseLoading ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      padding: '60px 0',
                    }}
                  >
                    <RuneSpinner size={44} tier="epic" />
                    <span
                      style={{
                        fontSize: 10,
                        color: '#64748b',
                        textTransform: 'uppercase',
                        letterSpacing: '0.2em',
                      }}
                    >
                      Calling the auctioneer
                    </span>
                  </div>
                ) : auctions.length === 0 ? (
                  <EmptyState
                    icon="⚖"
                    title="The gavel is silent"
                    hint="No active auctions match your filters. Check back soon or widen the type filter."
                  />
                ) : (
                  <>
                    {auctions.map((auction) => (
                      <BrowseAuctionCard
                        key={auction.id}
                        auction={auction}
                        onOpenDetail={() => setDetailAuctionId(auction.id)}
                        onBid={(amount) => handleBid(auction.id, amount)}
                        onBuyNow={
                          auction.buyNowPrice
                            ? () => handleBuyNow(auction.id)
                            : undefined
                        }
                        bidding={biddingId === auction.id}
                        buyingNow={buyingNowId === auction.id}
                      />
                    ))}

                    {totalPages > 1 && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 10,
                          paddingTop: 10,
                        }}
                      >
                        <RpgButton
                          variant="ghost"
                          size="sm"
                          disabled={page <= 1}
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                        >
                          ← Prev
                        </RpgButton>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          Page {page} of {totalPages}
                        </span>
                        <RpgButton
                          variant="ghost"
                          size="sm"
                          disabled={page >= totalPages}
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        >
                          Next →
                        </RpgButton>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ============================== MY AUCTIONS TAB ============================== */}
      {auctionTab === 'my-auctions' && (
        <div style={LIST_PANE_STYLE}>
          {myAuctionsLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '60px 0',
              }}
            >
              <RuneSpinner size={44} tier="epic" />
              <span
                style={{
                  fontSize: 10,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.2em',
                }}
              >
                Consulting your ledger
              </span>
            </div>
          ) : myAuctions.length === 0 ? (
            <EmptyState
              icon="📦"
              title="No auctions yet"
              hint="Forge a skill, then list it here with a starting bid, duration, and optional Buy Now."
            />
          ) : (
            <>
              <SummaryStats
                tier="legendary"
                items={[
                  {
                    label: 'Active',
                    value: activeAuctionCount,
                    color: '#fb923c',
                  },
                  {
                    label: 'Total Earned',
                    value: `${totalEarned} NT`,
                  },
                  {
                    label: 'Bids Received',
                    value: totalBidsReceived,
                    color: '#c084fc',
                  },
                ]}
              />
              {myAuctions.map((auction) => (
                <MyAuctionCard
                  key={auction.id}
                  auction={auction}
                  onCancel={() => handleCancel(auction.id)}
                  cancelling={cancellingId === auction.id}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* ============================== MY BIDS TAB ============================== */}
      {auctionTab === 'my-bids' && (
        <div style={LIST_PANE_STYLE}>
          {myBidsLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '60px 0',
              }}
            >
              <RuneSpinner size={44} tier="epic" />
              <span
                style={{
                  fontSize: 10,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.2em',
                }}
              >
                Checking the scoreboard
              </span>
            </div>
          ) : myBids.length === 0 ? (
            <EmptyState
              icon="🎯"
              title="No bids placed"
              hint="Browse auctions and lay down a bid to appear on the leaderboard."
            />
          ) : (
            <>
              <SummaryStats
                tier="epic"
                items={[
                  {
                    label: 'Winning',
                    value: winningCount,
                    color: '#4ade80',
                  },
                  {
                    label: 'Outbid',
                    value: outbidCount,
                    color: '#fb923c',
                  },
                  {
                    label: 'Total Bid',
                    value: `${totalBidAmount} NT`,
                  },
                ]}
              />
              {myBids.map((auction) => (
                <MyBidCard
                  key={auction.id}
                  auction={auction}
                  onIncreaseBid={(amount) => handleBid(auction.id, amount)}
                  submitting={biddingId === auction.id}
                />
              ))}
            </>
          )}
        </div>
      )}
    </RpgModal>
  );
}
