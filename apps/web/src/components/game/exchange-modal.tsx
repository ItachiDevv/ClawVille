'use client';

/**
 * ExchangeModal — peer marketplace surface.
 *
 * Aesthetic identity: "Tide Trade"
 * --------------------------------
 * The Exchange is a TWO-SIDED market (Needs vs Offers). To make that
 * binary readable at a glance the chrome uses opposing chromatic
 * temperatures — NEEDS sit on a cool cyan/teal tier ('rare'), OFFERS sit
 * on a warm amber/orange tier ('legendary'). The Browse tab opens with a
 * giant TIDE TOGGLE that physically separates the two sides so a
 * visitor never has to read a label to know what they're looking at.
 *
 * Everything else (cards, badges, post form, empty states) inherits
 * from that polarity:
 *   - NEED card: cyan rune frame, "REWARD" pill (cyan glow), "X SLOTS LEFT"
 *   - OFFER card: amber rune frame, "PRICE" pill (amber glow), ONE-SHOT
 *     or REPEATABLE badge.
 *
 * Reuses the @/components/rpg toolkit (RpgModal, RpgButton, ItemCard,
 * StatusChip, RarityBadge) — same primitives as bounty-board-modal so
 * the polish bar matches.
 *
 * Tabs: Browse · My Listings · My Orders · Post.
 *
 * State + data flow lives entirely in apps/web/src/hooks/use-exchange.ts.
 * This file is presentation + form state + tab orchestration only.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useGameStore, type GameState } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import {
  useExchangeListings,
  useMyExchangeListings,
  useMyExchangeOrders,
  useCreateExchangeListing,
  useOrderExchangeListing,
  useSubmitExchangeOrder,
  useConfirmExchangeOrder,
  useCancelExchangeOrder,
  useCancelExchangeListing,
  isExchangeGuestBlocked,
  EXCHANGE_CATEGORIES,
  CATEGORY_GLYPHS,
  type ExchangeListing,
  type ExchangeListingType,
  type ExchangeOfferMode,
  type ExchangeOrder,
  type ExchangeOrderState,
  type ExchangeCategory,
} from '@/hooks/use-exchange';
import {
  RpgModal,
  RpgButton,
  RpgTooltip,
  RuneSpinner,
  RuneFrame,
  ItemCard,
  StatusChip,
  type RarityId,
  type StatusChipTone,
} from '@/components/rpg';
import { useIsGuest } from '@/hooks/use-is-guest';
import { GuestUpsellModal } from '@/components/game/guest-upsell-modal';

// Guests run an all-demo economy (founder ruling 2026-07-06). The Exchange is
// P2P escrowed trade in REAL ClawTokens — it can't be safely simulated, so a
// guest hitting any write action gets the sign-up upsell, never a raw toast.
const EXCHANGE_UPSELL = {
  headline: 'Trading needs a real account',
  body: 'The Exchange moves real ClawTokens through escrow between players. Guests run a demo economy — create a free account to post, order, and settle real trades.',
  ctaLabel: 'Create free account',
} as const;

// ─── Constants ──────────────────────────────────────────────────────────────

type ExchangeTab = 'browse' | 'my-listings' | 'my-orders' | 'post';

type SortMode = 'newest' | 'reward-high' | 'reward-low';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'reward-high', label: 'Reward ↓' },
  { value: 'reward-low', label: 'Reward ↑' },
];

/**
 * NEED → cool tier (cyan/teal — same family as the HUD).
 * OFFER → warm tier (amber/orange — gold-rush "for-sale" energy).
 * one_shot offer drops a notch (epic purple — solo commission feel).
 */
function rarityForListing(l: ExchangeListing): RarityId {
  if (l.status === 'cancelled') return 'common';
  if (l.status === 'closed') return 'common';
  if (l.listingType === 'need') return 'rare';
  // offer
  return l.offerMode === 'repeatable' ? 'legendary' : 'epic';
}

/**
 * The order state machine has 5 stops. Map each to a status-chip tone.
 */
function orderStateTone(s: ExchangeOrderState): StatusChipTone {
  switch (s) {
    case 'open':       return 'info';
    case 'submitted':  return 'warning';
    case 'completed':  return 'positive';
    case 'cancelled':  return 'neutral';
    case 'disputed':   return 'danger';
  }
}

function listingStatusTone(s: ExchangeListing['status']): StatusChipTone {
  switch (s) {
    case 'open':      return 'info';
    case 'paused':    return 'warning';
    case 'closed':    return 'neutral';
    case 'cancelled': return 'neutral';
  }
}

// ─── Header token pill (CT balance) ────────────────────────────────────────

function CtPill({ tokens }: { tokens: number }) {
  return (
    <RpgTooltip content="Your ClawToken balance — escrowed on post (needs) or order (offers), released on confirm.">
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          borderRadius: 999,
          background:
            'linear-gradient(180deg, rgba(56, 189, 248, 0.10) 0%, rgba(56, 189, 248, 0.04) 100%)',
          border: '1px solid rgba(56, 189, 248, 0.4)',
          color: '#7dd3fc',
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textShadow: '0 0 8px rgba(56, 189, 248, 0.4)',
        }}
      >
        <span style={{ fontSize: 13 }}>◈</span>
        {tokens} NT
      </span>
    </RpgTooltip>
  );
}

// ─── Sigil + corner glyphs ──────────────────────────────────────────────────

/**
 * The header sigil for the modal — a tide-arrow inside an anchored
 * cartouche. Two opposing chevrons signal the bidirectional flow of the
 * Exchange (give / take, post / order).
 */
function ExchangeSigil() {
  return (
    <span
      aria-hidden
      style={{
        fontFamily: 'var(--font-orbitron), sans-serif',
        fontSize: 22,
        background:
          'linear-gradient(135deg, #7dd3fc 0%, #38bdf8 35%, #fb923c 65%, #fbbf24 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        filter: 'drop-shadow(0 0 6px rgba(125, 211, 252, 0.4))',
      }}
    >
      ⇋
    </span>
  );
}

// ─── Tide toggle — the centerpiece of the Browse tab ───────────────────────

function TideToggle({
  value,
  onChange,
}: {
  value: ExchangeListingType;
  onChange: (v: ExchangeListingType) => void;
}) {
  const isNeed = value === 'need';
  return (
    <div
      role="tablist"
      aria-label="Listing type"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 0,
        position: 'relative',
        borderRadius: 14,
        padding: 4,
        background:
          'linear-gradient(180deg, rgba(8, 18, 36, 0.85) 0%, rgba(8, 18, 36, 0.65) 100%)',
        border: '1px solid rgba(148, 163, 184, 0.2)',
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
      }}
    >
      {/* Sliding indicator */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 4,
          bottom: 4,
          left: isNeed ? 4 : '50%',
          width: 'calc(50% - 4px)',
          borderRadius: 11,
          transition: 'left 240ms cubic-bezier(0.5, 0, 0.2, 1.2), background 240ms ease',
          background: isNeed
            ? 'linear-gradient(180deg, rgba(56, 189, 248, 0.22) 0%, rgba(14, 116, 144, 0.18) 100%)'
            : 'linear-gradient(180deg, rgba(251, 146, 60, 0.22) 0%, rgba(180, 83, 9, 0.18) 100%)',
          boxShadow: isNeed
            ? '0 0 0 1px rgba(56, 189, 248, 0.55), 0 6px 22px rgba(56, 189, 248, 0.28)'
            : '0 0 0 1px rgba(251, 146, 60, 0.6), 0 6px 22px rgba(251, 146, 60, 0.30)',
        }}
      />
      {(['need', 'offer'] as const).map((t) => {
        const active = value === t;
        const isOfferSide = t === 'offer';
        return (
          <button
            key={t}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(t)}
            style={{
              position: 'relative',
              zIndex: 1,
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              color: active ? (isOfferSide ? '#fdba74' : '#7dd3fc') : '#64748b',
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              transition: 'color 220ms ease',
            }}
          >
            <span style={{ fontSize: 18 }}>{isOfferSide ? '⊕' : '⊖'}</span>
            <span style={{ fontSize: 13 }}>{isOfferSide ? 'Offers' : 'Needs'}</span>
            <span
              style={{
                fontSize: 9,
                color: active ? (isOfferSide ? '#fdba74' : '#7dd3fc') : '#475569',
                opacity: active ? 0.85 : 0.55,
                letterSpacing: '0.16em',
                transition: 'all 220ms ease',
              }}
            >
              {isOfferSide ? 'tide bringing in' : 'tide pulling out'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Filter chip strip (categories) ─────────────────────────────────────────

function CategoryChips({
  value,
  onChange,
}: {
  value: ExchangeCategory;
  onChange: (v: ExchangeCategory) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
      }}
    >
      {EXCHANGE_CATEGORIES.map((c) => {
        const active = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              background: active
                ? 'rgba(56, 189, 248, 0.15)'
                : 'rgba(10, 22, 40, 0.55)',
              border: `1px solid ${active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(148, 163, 184, 0.2)'}`,
              color: active ? '#7dd3fc' : '#94a3b8',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 180ms ease',
            }}
          >
            <span style={{ fontSize: 11, opacity: active ? 1 : 0.6 }}>
              {CATEGORY_GLYPHS[c.id]}
            </span>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Sort chips ─────────────────────────────────────────────────────────────

function SortChips({
  value,
  onChange,
}: {
  value: SortMode;
  onChange: (v: SortMode) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 700,
          marginRight: 4,
        }}
      >
        Sort
      </span>
      {SORT_OPTIONS.map((s) => {
        const active = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => onChange(s.value)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              background: active
                ? 'rgba(56, 189, 248, 0.15)'
                : 'rgba(10, 22, 40, 0.45)',
              border: `1px solid ${active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(148, 163, 184, 0.18)'}`,
              color: active ? '#7dd3fc' : '#94a3b8',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              cursor: 'pointer',
              transition: 'all 160ms ease',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Listing card ───────────────────────────────────────────────────────────

function ListingCard({
  listing,
  occupiedCount,
  onPrimaryAction,
  onAuthorCancel,
  primaryLabel,
  primaryDisabled,
  primaryPending,
  primaryTooltip,
  isMine,
  cancelPending,
  showStatus,
}: {
  listing: ExchangeListing;
  occupiedCount: number;
  onPrimaryAction?: () => void;
  onAuthorCancel?: () => void;
  primaryLabel: ReactNode;
  primaryDisabled?: boolean;
  primaryPending?: boolean;
  primaryTooltip?: string;
  isMine?: boolean;
  cancelPending?: boolean;
  showStatus?: boolean;
}) {
  const isNeed = listing.listingType === 'need';
  const accent = isNeed ? '#7dd3fc' : '#fdba74';
  const accentSoft = isNeed ? 'rgba(56, 189, 248, 0.14)' : 'rgba(251, 146, 60, 0.14)';
  const accentBorder = isNeed ? 'rgba(56, 189, 248, 0.45)' : 'rgba(251, 146, 60, 0.45)';

  const capacityLabel = useMemo(() => {
    if (listing.capacity === null) return 'UNLIMITED';
    const remaining = Math.max(0, listing.capacity - occupiedCount);
    if (listing.capacity === 1) {
      return remaining > 0 ? 'OPEN · 1 SLOT' : 'CLAIMED';
    }
    return `${remaining} / ${listing.capacity} SLOTS`;
  }, [listing.capacity, occupiedCount]);

  const subtypeBadge = useMemo(() => {
    if (isNeed) return null;
    if (listing.offerMode === 'repeatable') {
      return (
        <StatusChip label="Repeatable" tone="warning" size="sm" />
      );
    }
    return (
      <StatusChip label="One-Shot" tone="info" size="sm" />
    );
  }, [isNeed, listing.offerMode]);

  return (
    <ItemCard
      rarity={rarityForListing(listing)}
      name={
        <span
          style={{
            fontFamily: 'var(--font-orbitron), sans-serif',
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          {listing.title}
        </span>
      }
      subtitle={
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          posted by{' '}
          <span style={{ color: accent, fontWeight: 600 }}>
            {listing.creatorName ?? 'unknown'}
          </span>
        </span>
      }
      icon={
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: accentSoft,
            border: `1px solid ${accentBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            color: accent,
            fontFamily: 'var(--font-orbitron), sans-serif',
            textShadow: `0 0 6px ${accentBorder}`,
          }}
          aria-hidden
        >
          {isNeed ? '↶' : '↷'}
        </div>
      }
      badge={
        <span
          style={{
            display: 'inline-flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          {subtypeBadge}
          {listing.category && (
            <StatusChip
              label={listing.category}
              tone="neutral"
              size="sm"
            />
          )}
          {showStatus && listing.status !== 'open' && (
            <StatusChip
              label={listing.status}
              tone={listingStatusTone(listing.status)}
              size="sm"
            />
          )}
        </span>
      }
      description={
        <span
          style={{
            fontSize: 12,
            color: '#cbd5e1',
            lineHeight: 1.55,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {listing.description}
        </span>
      }
      price={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 12px',
            borderRadius: 999,
            background: accentSoft,
            border: `1px solid ${accentBorder}`,
            color: accent,
            fontFamily: 'var(--font-orbitron), sans-serif',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textShadow: `0 0 6px ${accentBorder}`,
          }}
        >
          <span style={{ fontSize: 12, opacity: 0.85 }}>◈</span>
          {listing.priceCt}
        </span>
      }
      priceUnit={
        <span
          style={{
            fontSize: 9,
            color: accent,
            opacity: 0.7,
            letterSpacing: '0.16em',
            marginTop: 4,
          }}
        >
          {isNeed ? 'reward' : 'price'} · NT
        </span>
      }
      stats={[
        { label: 'Capacity', value: capacityLabel },
        ...(listing.tags && listing.tags.length > 0
          ? [
              {
                label: 'Tags',
                value: listing.tags.slice(0, 3).join(' · '),
              },
            ]
          : []),
      ]}
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {isMine && onAuthorCancel && (
            <RpgButton
              variant="danger"
              size="sm"
              onClick={onAuthorCancel}
              loading={!!cancelPending}
            >
              Cancel Listing
            </RpgButton>
          )}
          {onPrimaryAction && (
            <RpgTooltip
              content={primaryTooltip ?? (isNeed ? 'Claim this need to fulfil it.' : 'Buy a seat on this offer.')}
            >
              <RpgButton
                variant="primary"
                size="sm"
                rarity={isNeed ? 'rare' : 'legendary'}
                onClick={onPrimaryAction}
                disabled={primaryDisabled}
                loading={!!primaryPending}
              >
                {primaryLabel}
              </RpgButton>
            </RpgTooltip>
          )}
        </div>
      }
      interactive={false}
    />
  );
}

// ─── Order row (My Orders tab) ──────────────────────────────────────────────

function OrderRow({
  order,
  listing,
  onSubmit,
  onConfirm,
  onCancel,
  submitPending,
  confirmPending,
  cancelPending,
  callerIsCreator,
}: {
  order: ExchangeOrder;
  listing: ExchangeListing;
  onSubmit?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  submitPending?: boolean;
  confirmPending?: boolean;
  cancelPending?: boolean;
  callerIsCreator: boolean;
}) {
  const isNeed = listing.listingType === 'need';
  const accent = isNeed ? '#7dd3fc' : '#fdba74';
  const accentBorder = isNeed ? 'rgba(56, 189, 248, 0.4)' : 'rgba(251, 146, 60, 0.4)';

  // Caller is the FULFILLER when: (need + their order = they're the claimant)
  // OR (offer + they are listing creator = they're the seller).
  // Caller is the CONFIRMER when: (need + listing creator = poster) OR
  // (offer + their order = buyer).
  const callerIsFulfiller =
    (isNeed && !callerIsCreator) || (!isNeed && callerIsCreator);

  return (
    <RuneFrame
      tier={rarityForListing(listing)}
      glow="subtle"
      interactive={false}
      style={{ padding: 0 }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: 14,
          padding: '14px 18px',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 8,
            background: isNeed
              ? 'rgba(56, 189, 248, 0.12)'
              : 'rgba(251, 146, 60, 0.12)',
            border: `1px solid ${accentBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: accent,
            fontFamily: 'var(--font-orbitron), sans-serif',
            fontSize: 20,
          }}
          aria-hidden
        >
          {isNeed ? '↶' : '↷'}
        </div>

        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-orbitron), sans-serif',
                fontSize: 13,
                fontWeight: 700,
                color: '#e2e8f0',
              }}
            >
              {listing.title}
            </span>
            <StatusChip
              label={order.state}
              tone={orderStateTone(order.state)}
              size="sm"
            />
          </div>
          <div
            style={{
              fontSize: 10,
              color: '#64748b',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              letterSpacing: '0.08em',
              marginTop: 4,
            }}
          >
            {isNeed ? 'CLAIM · ' : 'ORDER · '}
            <span style={{ color: accent, fontWeight: 700 }}>
              {order.amountCt} NT
            </span>
            {' · '}
            {new Date(order.createdAt).toLocaleDateString()}
          </div>
          {order.deliveryUrl && (
            <a
              href={order.deliveryUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{
                marginTop: 6,
                fontSize: 11,
                color: '#7dd3fc',
                display: 'inline-block',
                wordBreak: 'break-all',
              }}
            >
              ↗ {order.deliveryUrl}
            </a>
          )}
          {order.deliveryNote && (
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 11,
                color: '#cbd5e1',
                lineHeight: 1.5,
              }}
            >
              {order.deliveryNote}
            </p>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            alignItems: 'flex-end',
          }}
        >
          {order.state === 'open' && callerIsFulfiller && onSubmit && (
            <RpgButton
              variant="primary"
              size="sm"
              onClick={onSubmit}
              loading={!!submitPending}
            >
              Submit Delivery
            </RpgButton>
          )}
          {order.state === 'submitted' && !callerIsFulfiller && onConfirm && (
            <RpgButton
              variant="primary"
              size="sm"
              rarity="legendary"
              onClick={onConfirm}
              loading={!!confirmPending}
            >
              Confirm + Release
            </RpgButton>
          )}
          {(order.state === 'open' || order.state === 'submitted') && onCancel && (
            <RpgButton
              variant="danger"
              size="sm"
              onClick={onCancel}
              loading={!!cancelPending}
            >
              Cancel
            </RpgButton>
          )}
        </div>
      </div>
    </RuneFrame>
  );
}

// ─── Empty states ───────────────────────────────────────────────────────────

function EmptyState({
  glyph,
  title,
  body,
  cta,
}: {
  glyph: string;
  title: string;
  body: string;
  cta?: ReactNode;
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '50px 24px 60px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div
        aria-hidden
        style={{
          fontSize: 38,
          opacity: 0.75,
          filter: 'drop-shadow(0 0 10px rgba(125, 211, 252, 0.4))',
          marginBottom: 4,
        }}
      >
        {glyph}
      </div>
      <h3
        style={{
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 14,
          color: '#e2e8f0',
          margin: 0,
          letterSpacing: '0.08em',
        }}
      >
        {title}
      </h3>
      <p
        style={{
          maxWidth: 380,
          margin: 0,
          fontSize: 12,
          color: '#94a3b8',
          lineHeight: 1.6,
        }}
      >
        {body}
      </p>
      {cta && <div style={{ marginTop: 12 }}>{cta}</div>}
    </div>
  );
}

// ─── Submit modal — captures deliveryUrl + note ────────────────────────────

function SubmitDeliveryDialog({
  open,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { deliveryUrl?: string; deliveryNote?: string }) => void;
  pending: boolean;
}) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open) {
      setUrl('');
      setNote('');
    }
  }, [open]);

  return (
    <RpgModal
      open={open}
      onClose={onClose}
      title="Submit Delivery"
      subtitle="Drop a link · leave a note · release will follow"
      tier="rare"
      maxWidth={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 22px' }}>
        <Field label="Delivery URL (optional)">
          <input
            type="url"
            placeholder="https://github.com/.../pull/42"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={INPUT_STYLE}
          />
        </Field>
        <Field label="Delivery Note">
          <textarea
            rows={5}
            placeholder="What did you do, where to find it, any caveats."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ ...INPUT_STYLE, resize: 'vertical', minHeight: 96 }}
          />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <RpgButton variant="secondary" size="md" onClick={onClose}>
            Cancel
          </RpgButton>
          <RpgButton
            variant="primary"
            size="md"
            disabled={!url && !note.trim()}
            loading={pending}
            onClick={() =>
              onSubmit({
                deliveryUrl: url.trim() || undefined,
                deliveryNote: note.trim() || undefined,
              })
            }
          >
            Submit
          </RpgButton>
        </div>
      </div>
    </RpgModal>
  );
}

// ─── Confirm modal — review note ────────────────────────────────────────────

function ConfirmReleaseDialog({
  open,
  onClose,
  onConfirm,
  pending,
  amountCt,
  recipientName,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reviewNote?: string) => void;
  pending: boolean;
  amountCt: number;
  recipientName: string;
}) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open) setNote('');
  }, [open]);

  return (
    <RpgModal
      open={open}
      onClose={onClose}
      title="Confirm + Release Escrow"
      subtitle={`${amountCt} NT will move to ${recipientName}`}
      tier="legendary"
      maxWidth={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 22px' }}>
        <div
          style={{
            padding: 14,
            borderRadius: 10,
            background: 'rgba(249, 115, 22, 0.08)',
            border: '1px solid rgba(249, 115, 22, 0.4)',
            color: '#fdba74',
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span aria-hidden style={{ fontSize: 14 }}>⚠</span>
            <strong style={{ letterSpacing: '0.1em', textTransform: 'uppercase', fontSize: 10 }}>
              Irreversible
            </strong>
          </div>
          This releases escrow to the counterparty and closes the order. Only
          confirm once you’ve verified the delivery — there’s no clawback.
        </div>
        <Field label="Review Note (optional)">
          <textarea
            rows={3}
            placeholder="Praise · feedback · receipt note."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ ...INPUT_STYLE, resize: 'vertical', minHeight: 70 }}
          />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <RpgButton variant="secondary" size="md" onClick={onClose}>
            Cancel
          </RpgButton>
          <RpgButton
            variant="primary"
            size="md"
            rarity="legendary"
            loading={pending}
            onClick={() => onConfirm(note.trim() || undefined)}
          >
            Release {amountCt} NT
          </RpgButton>
        </div>
      </div>
    </RpgModal>
  );
}

// ─── Post tab ───────────────────────────────────────────────────────────────

interface PostFormState {
  type: ExchangeListingType | null;
  offerMode: ExchangeOfferMode;
  title: string;
  description: string;
  category: ExchangeCategory;
  priceCt: number;
  capacity: number;
  tagsRaw: string;
}

const initialPostForm: PostFormState = {
  type: null,
  offerMode: 'one_shot',
  title: '',
  description: '',
  category: 'other',
  priceCt: 100,
  capacity: 1,
  tagsRaw: '',
};

function PostTab({
  tokens,
  onDone,
  isGuest,
  onGuestBlocked,
}: {
  tokens: number;
  onDone: () => void;
  isGuest: boolean;
  onGuestBlocked: () => void;
}) {
  const [f, setF] = useState<PostFormState>(initialPostForm);
  const create = useCreateExchangeListing();

  const isNeed = f.type === 'need';
  const isOffer = f.type === 'offer';
  const showsCapacity = isNeed || (isOffer && f.offerMode === 'one_shot');
  const escrowCost = isNeed ? f.priceCt * f.capacity : 0;
  const cannotAfford = isNeed && escrowCost > tokens;

  const canSubmit =
    !!f.type &&
    f.title.trim().length >= 3 &&
    f.description.trim().length >= 10 &&
    f.priceCt >= 1 &&
    !cannotAfford &&
    !create.isPending;

  function submit() {
    if (!canSubmit || !f.type) return;
    // Preemptive guest gate — never round-trip to the escrow write path.
    if (isGuest) {
      onGuestBlocked();
      return;
    }
    const tags = f.tagsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);
    create.mutate(
      {
        listingType: f.type,
        offerMode: isOffer ? f.offerMode : undefined,
        title: f.title.trim(),
        description: f.description.trim(),
        category: f.category === 'all' ? undefined : f.category,
        priceCt: f.priceCt,
        capacity: showsCapacity ? f.capacity : undefined,
        tags: tags.length > 0 ? tags : undefined,
      },
      {
        onSuccess: () => {
          setF(initialPostForm);
          onDone();
        },
        // Backstop: a guest slipped past the preemptive gate (auth-me race).
        onError: (err) => {
          if (isExchangeGuestBlocked(err)) onGuestBlocked();
        },
      },
    );
  }

  return (
    <div style={{ padding: '18px 22px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Step 1 — direction discriminator */}
      <div>
        <SectionLabel>1 · Choose Direction</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {(
            [
              {
                id: 'need' as const,
                title: 'I Need Help',
                blurb:
                  'Post a task. Escrow your reward up-front. The first qualified hand fulfils it.',
                accent: '#7dd3fc',
                accentSoft: 'rgba(56, 189, 248, 0.10)',
                accentBorder: 'rgba(56, 189, 248, 0.45)',
                glyph: '↶',
                tag: 'tide pulling out',
              },
              {
                id: 'offer' as const,
                title: 'I’m Offering',
                blurb:
                  'List a service or item. Buyers escrow on order. You deliver, you confirm, you collect.',
                accent: '#fdba74',
                accentSoft: 'rgba(251, 146, 60, 0.10)',
                accentBorder: 'rgba(251, 146, 60, 0.45)',
                glyph: '↷',
                tag: 'tide bringing in',
              },
            ]
          ).map((card) => {
            const active = f.type === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => setF({ ...f, type: card.id })}
                style={{
                  textAlign: 'left',
                  padding: 16,
                  borderRadius: 14,
                  background: active ? card.accentSoft : 'rgba(10, 22, 40, 0.55)',
                  border: `1px solid ${active ? card.accentBorder : 'rgba(148, 163, 184, 0.2)'}`,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  transition: 'all 200ms ease',
                  boxShadow: active
                    ? `0 0 0 1px ${card.accentBorder}, 0 12px 32px ${card.accentSoft}`
                    : 'none',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-orbitron), sans-serif',
                      fontSize: 22,
                      color: card.accent,
                      lineHeight: 1,
                    }}
                  >
                    {card.glyph}
                  </span>
                  <span
                    style={{
                      fontSize: 8,
                      color: card.accent,
                      opacity: 0.75,
                      textTransform: 'uppercase',
                      letterSpacing: '0.18em',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                  >
                    {card.tag}
                  </span>
                </div>
                <h3
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-orbitron), sans-serif',
                    fontSize: 16,
                    color: active ? card.accent : '#e2e8f0',
                    letterSpacing: '0.04em',
                  }}
                >
                  {card.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: 11.5,
                    color: '#94a3b8',
                    lineHeight: 1.55,
                  }}
                >
                  {card.blurb}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {!f.type ? (
        <p style={{ fontSize: 11, color: '#64748b', textAlign: 'center' }}>
          Pick a direction above to reveal the rest of the form.
        </p>
      ) : (
        <>
          {/* Step 2 — offer-mode (offer only) */}
          {isOffer && (
            <div>
              <SectionLabel>2 · Offer Cadence</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {(['one_shot', 'repeatable'] as const).map((m) => {
                  const active = f.offerMode === m;
                  const isRepeat = m === 'repeatable';
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setF({ ...f, offerMode: m })}
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        borderRadius: 10,
                        background: active
                          ? 'rgba(251, 146, 60, 0.10)'
                          : 'rgba(10, 22, 40, 0.5)',
                        border: `1px solid ${active ? 'rgba(251, 146, 60, 0.5)' : 'rgba(148, 163, 184, 0.18)'}`,
                        cursor: 'pointer',
                        transition: 'all 180ms ease',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 4,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 14,
                            color: active ? '#fdba74' : '#94a3b8',
                          }}
                        >
                          {isRepeat ? '↻' : '●'}
                        </span>
                        <span
                          style={{
                            fontFamily: 'var(--font-orbitron), sans-serif',
                            fontSize: 12,
                            color: active ? '#fdba74' : '#cbd5e1',
                            textTransform: 'uppercase',
                            letterSpacing: '0.12em',
                            fontWeight: 700,
                          }}
                        >
                          {isRepeat ? 'Repeatable' : 'One-Shot'}
                        </span>
                      </div>
                      <span style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.45 }}>
                        {isRepeat
                          ? 'Stays open. Many buyers, each escrows on order. Productize a service.'
                          : 'Single seat. First buyer takes it. Custom commissions, 1-of-1 items.'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3 — fields */}
          <div>
            <SectionLabel>{isOffer ? '3' : '2'} · Listing</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
              <Field label="Title">
                <input
                  type="text"
                  maxLength={200}
                  placeholder={
                    isNeed
                      ? 'Need someone to wire up a Helius webhook handler'
                      : 'Custom skill bake — 24h turnaround'
                  }
                  value={f.title}
                  onChange={(e) => setF({ ...f, title: e.target.value })}
                  style={INPUT_STYLE}
                />
              </Field>
              <Field label="Description">
                <textarea
                  rows={5}
                  maxLength={5000}
                  placeholder={
                    isNeed
                      ? 'What you need done, in detail. Acceptance criteria help — the more specific, the faster you get a good claim.'
                      : 'What you’re offering. Deliverables, scope, what buyers can expect.'
                  }
                  value={f.description}
                  onChange={(e) => setF({ ...f, description: e.target.value })}
                  style={{ ...INPUT_STYLE, resize: 'vertical', minHeight: 110 }}
                />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: showsCapacity ? '1fr 1fr 1fr' : '1fr 1fr', gap: 12 }}>
                <Field label="Category">
                  <select
                    value={f.category}
                    onChange={(e) => setF({ ...f, category: e.target.value as ExchangeCategory })}
                    style={INPUT_STYLE}
                  >
                    {EXCHANGE_CATEGORIES.filter((c) => c.id !== 'all').map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={isNeed ? 'Reward (NT)' : 'Price / order (NT)'}>
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    value={f.priceCt}
                    onChange={(e) => setF({ ...f, priceCt: Math.max(1, parseInt(e.target.value) || 1) })}
                    style={INPUT_STYLE}
                  />
                </Field>
                {showsCapacity && (
                  <Field label={isNeed ? 'Slots' : 'Seats'}>
                    <input
                      type="number"
                      min={1}
                      max={isNeed ? 10 : 1000}
                      value={f.capacity}
                      onChange={(e) => setF({ ...f, capacity: Math.max(1, parseInt(e.target.value) || 1) })}
                      style={INPUT_STYLE}
                    />
                  </Field>
                )}
              </div>
              <Field label="Tags (comma-separated, max 10)">
                <input
                  type="text"
                  placeholder="solana, helius, webhook"
                  value={f.tagsRaw}
                  onChange={(e) => setF({ ...f, tagsRaw: e.target.value })}
                  style={INPUT_STYLE}
                />
              </Field>
            </div>
          </div>

          {/* Escrow callout (needs only) */}
          {isNeed && (
            <div
              style={{
                padding: 14,
                borderRadius: 12,
                background:
                  'linear-gradient(120deg, rgba(56, 189, 248, 0.10) 0%, rgba(56, 189, 248, 0.04) 100%)',
                border: '1px solid rgba(56, 189, 248, 0.4)',
                display: 'flex',
                gap: 14,
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: 'rgba(56, 189, 248, 0.16)',
                  border: '1px solid rgba(56, 189, 248, 0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 22,
                  color: '#7dd3fc',
                }}
                aria-hidden
              >
                ⚓
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-orbitron), sans-serif',
                    fontSize: 11,
                    color: '#7dd3fc',
                    textTransform: 'uppercase',
                    letterSpacing: '0.18em',
                    fontWeight: 700,
                  }}
                >
                  Escrow
                </div>
                <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 4, lineHeight: 1.55 }}>
                  Posting this need will lock{' '}
                  <strong style={{ color: '#7dd3fc' }}>
                    {escrowCost} NT
                  </strong>{' '}
                  ({f.priceCt} NT × {f.capacity} slot{f.capacity === 1 ? '' : 's'}) until each claim is approved.
                  Refunded on cancel.
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-orbitron), sans-serif',
                  fontSize: 18,
                  color: cannotAfford ? '#f87171' : '#7dd3fc',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}
              >
                {escrowCost} / {tokens}
              </div>
            </div>
          )}

          {/* Submit */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 4,
              borderTop: '1px solid rgba(148, 163, 184, 0.12)',
              paddingTop: 14,
            }}
          >
            <RpgButton variant="secondary" size="md" onClick={() => setF(initialPostForm)}>
              Reset
            </RpgButton>
            <RpgButton
              variant="primary"
              size="md"
              rarity={isNeed ? 'rare' : 'legendary'}
              onClick={submit}
              disabled={!canSubmit}
              loading={create.isPending}
            >
              {cannotAfford
                ? 'Not enough NT'
                : isNeed
                ? `Post Need · escrow ${escrowCost} NT`
                : 'Post Offer'}
            </RpgButton>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Tab strip ──────────────────────────────────────────────────────────────

function TabStrip({
  tab,
  onChange,
}: {
  tab: ExchangeTab;
  onChange: (t: ExchangeTab) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '10px 22px 0',
        borderBottom: '1px solid rgba(56, 189, 248, 0.15)',
      }}
    >
      {(
        [
          { key: 'browse', label: 'Browse' },
          { key: 'my-listings', label: 'My Listings' },
          { key: 'my-orders', label: 'My Orders' },
          { key: 'post', label: 'Post' },
        ] as { key: ExchangeTab; label: string }[]
      ).map((t) => {
        const isActive = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
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
              color: isActive ? '#7dd3fc' : '#64748b',
              cursor: 'pointer',
              transition: 'color 180ms ease',
            }}
          >
            {t.label}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 12,
                right: 12,
                bottom: -1,
                height: 2,
                background: isActive
                  ? 'linear-gradient(90deg, transparent 0%, #38bdf8 50%, transparent 100%)'
                  : 'transparent',
                boxShadow: isActive ? '0 0 10px rgba(56, 189, 248, 0.55)' : 'none',
                transition: 'background 200ms ease',
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

// ─── Main modal ─────────────────────────────────────────────────────────────

export default function ExchangeModal() {
  const open = useGameStore((s: GameState) => s.exchangeOpen);
  const close = useGameStore((s: GameState) => s.closeExchange);
  const tab = useGameStore((s: GameState) => s.exchangeTab);
  const setTab = useGameStore((s: GameState) => s.setExchangeTab);
  const { data: avatar } = useAvatar();
  const tokens = avatar?.clawTokens ?? 0;
  const myAvatarId = avatar?.id ?? null;
  const isGuest = useIsGuest();

  // Guest sign-up upsell — shown instead of any real-CT trade action / any
  // guest_not_allowed 403. One instance for the whole modal.
  const [guestUpsellOpen, setGuestUpsellOpen] = useState(false);

  // Browse filter state
  const [browseType, setBrowseType] = useState<ExchangeListingType>('need');
  const [category, setCategory] = useState<ExchangeCategory>('all');
  const [sort, setSort] = useState<SortMode>('newest');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [browseType, category, sort, tab]);

  // Queries — only fire while the modal is open and we're on that tab.
  const browseQ = useExchangeListings(
    { type: browseType, category, page, pageSize: 20 },
    open && tab === 'browse',
  );
  const myListingsQ = useMyExchangeListings(open && tab === 'my-listings');
  const myOrdersQ = useMyExchangeOrders(open && tab === 'my-orders');

  // Mutations
  const orderM = useOrderExchangeListing();
  const submitM = useSubmitExchangeOrder();
  const confirmM = useConfirmExchangeOrder();
  const cancelOrderM = useCancelExchangeOrder();
  const cancelListingM = useCancelExchangeListing();

  // Per-row pending guard so the matching button shows the spinner.
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);

  // Submit / Confirm dialogs
  const [submitTarget, setSubmitTarget] = useState<ExchangeOrder | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    order: ExchangeOrder;
    listing: ExchangeListing;
  } | null>(null);

  // Client-side sort — keeps the server payload simple and lets the chips
  // toggle without an extra refetch.
  const sortedListings = useMemo(() => {
    const rows = browseQ.data?.listings ?? [];
    if (sort === 'newest') return rows;
    const dir = sort === 'reward-high' ? -1 : 1;
    return [...rows].sort((a, b) => (a.priceCt - b.priceCt) * dir);
  }, [browseQ.data, sort]);

  // Preemptive guest gate — a guest never reaches the escrow write path; the
  // action opens the sign-up upsell instead of a server round-trip. The
  // onError arm is the backstop for the auth-me-not-yet-resolved race.
  const onOrder = (l: ExchangeListing) => {
    if (orderM.isPending) return;
    if (isGuest) {
      setGuestUpsellOpen(true);
      return;
    }
    setPendingTarget(l.id);
    orderM.mutate(l.id, {
      onError: (err) => {
        if (isExchangeGuestBlocked(err)) setGuestUpsellOpen(true);
      },
      onSettled: () => setPendingTarget(null),
    });
  };

  const onAuthorCancel = (l: ExchangeListing) => {
    if (cancelListingM.isPending) return;
    if (isGuest) {
      setGuestUpsellOpen(true);
      return;
    }
    if (!window.confirm('Cancel this listing? Open orders will be refunded.')) {
      return;
    }
    setPendingTarget(l.id);
    cancelListingM.mutate(l.id, {
      onError: (err) => {
        if (isExchangeGuestBlocked(err)) setGuestUpsellOpen(true);
      },
      onSettled: () => setPendingTarget(null),
    });
  };

  const onSubmitDelivery = (input: { deliveryUrl?: string; deliveryNote?: string }) => {
    if (!submitTarget) return;
    if (isGuest) {
      setGuestUpsellOpen(true);
      return;
    }
    submitM.mutate(
      { orderId: submitTarget.id, input },
      {
        onSuccess: () => setSubmitTarget(null),
        onError: (err) => {
          if (isExchangeGuestBlocked(err)) setGuestUpsellOpen(true);
        },
      },
    );
  };

  const onConfirmRelease = (reviewNote?: string) => {
    if (!confirmTarget) return;
    if (isGuest) {
      setGuestUpsellOpen(true);
      return;
    }
    confirmM.mutate(
      { orderId: confirmTarget.order.id, reviewNote },
      {
        onSuccess: () => setConfirmTarget(null),
        onError: (err) => {
          if (isExchangeGuestBlocked(err)) setGuestUpsellOpen(true);
        },
      },
    );
  };

  const onCancelOrder = (orderId: string) => {
    if (cancelOrderM.isPending) return;
    if (isGuest) {
      setGuestUpsellOpen(true);
      return;
    }
    if (!window.confirm('Cancel this order? Escrow will be refunded.')) return;
    setPendingTarget(orderId);
    cancelOrderM.mutate(orderId, {
      onError: (err) => {
        if (isExchangeGuestBlocked(err)) setGuestUpsellOpen(true);
      },
      onSettled: () => setPendingTarget(null),
    });
  };

  return (
    <>
      <RpgModal
        open={open}
        onClose={close}
        title="Exchange"
        subtitle="Peer marketplace · Needs · Offers · Escrowed Trade"
        tier="rare"
        glow="subtle"
        headerIcon={<ExchangeSigil />}
        maxWidth={1080}
        tokenBadge={<CtPill tokens={tokens} />}
      >
        <TabStrip tab={tab} onChange={setTab} />

        {/* ═══════════════════════════ BROWSE ═══════════════════════════ */}
        {tab === 'browse' && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                padding: '18px 22px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                borderBottom: '1px solid rgba(148, 163, 184, 0.10)',
              }}
            >
              <TideToggle value={browseType} onChange={setBrowseType} />
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 14,
                  justifyContent: 'space-between',
                }}
              >
                <CategoryChips value={category} onChange={setCategory} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <SortChips value={sort} onChange={setSort} />
                  <RpgButton
                    variant="primary"
                    size="sm"
                    rarity={browseType === 'need' ? 'rare' : 'legendary'}
                    onClick={() => setTab('post')}
                  >
                    + Post {browseType === 'need' ? 'a Need' : 'an Offer'}
                  </RpgButton>
                </div>
              </div>
            </div>

            <div
              style={{
                padding: '16px 22px 22px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
                gap: 14,
                minHeight: 280,
                maxHeight: '60vh',
                overflowY: 'auto',
              }}
            >
              {browseQ.isLoading ? (
                <BrowseSkeleton tone={browseType} />
              ) : sortedListings.length === 0 ? (
                <div style={{ gridColumn: '1 / -1' }}>
                  <EmptyState
                    glyph={browseType === 'need' ? '〜' : '⛵'}
                    title={
                      browseType === 'need'
                        ? 'The tide is still.'
                        : 'No stalls open today.'
                    }
                    body={
                      browseType === 'need'
                        ? 'No needs posted in this category yet. Be the first to ask the village for help.'
                        : 'No offers in this category right now. Try a different category or post your own catch.'
                    }
                    cta={
                      <RpgButton
                        variant="primary"
                        size="md"
                        rarity={browseType === 'need' ? 'rare' : 'legendary'}
                        onClick={() => setTab('post')}
                      >
                        + Post {browseType === 'need' ? 'a Need' : 'an Offer'}
                      </RpgButton>
                    }
                  />
                </div>
              ) : (
                sortedListings.map((l) => {
                  const isMine = l.creatorId === myAvatarId;
                  const isFull =
                    l.capacity !== null && l.capacity === 1;
                  // We don't have order-count on this endpoint, so display
                  // 0 occupied. Detail endpoint has the real number when
                  // the user clicks through (future).
                  return (
                    <ListingCard
                      key={l.id}
                      listing={l}
                      occupiedCount={0}
                      onPrimaryAction={
                        isMine ? undefined : () => onOrder(l)
                      }
                      primaryLabel={
                        isMine
                          ? 'Yours'
                          : l.listingType === 'need'
                          ? 'Claim This'
                          : 'Place Order'
                      }
                      primaryDisabled={isMine || (isFull && false)}
                      primaryPending={pendingTarget === l.id && orderM.isPending}
                      primaryTooltip={
                        isMine
                          ? 'Self-orders disabled — manage from My Listings.'
                          : undefined
                      }
                      isMine={false}
                    />
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ═══════════════════════ MY LISTINGS ═══════════════════════ */}
        {tab === 'my-listings' && (
          <div
            style={{
              padding: '18px 22px 22px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
              gap: 14,
              minHeight: 280,
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            {myListingsQ.isLoading ? (
              <BrowseSkeleton tone="need" />
            ) : (myListingsQ.data?.listings ?? []).length === 0 ? (
              <div style={{ gridColumn: '1 / -1' }}>
                <EmptyState
                  glyph="◇"
                  title="Your sigil board is empty."
                  body="You haven't posted anything yet. Drop a need or an offer to get the tide moving."
                  cta={
                    <RpgButton
                      variant="primary"
                      size="md"
                      rarity="rare"
                      onClick={() => setTab('post')}
                    >
                      + Post Something
                    </RpgButton>
                  }
                />
              </div>
            ) : (
              myListingsQ.data!.listings.map((l) => (
                <ListingCard
                  key={l.id}
                  listing={l}
                  occupiedCount={0}
                  primaryLabel={null}
                  isMine
                  showStatus
                  onAuthorCancel={
                    l.status === 'open' || l.status === 'paused'
                      ? () => onAuthorCancel(l)
                      : undefined
                  }
                  cancelPending={pendingTarget === l.id && cancelListingM.isPending}
                />
              ))
            )}
          </div>
        )}

        {/* ═══════════════════════ MY ORDERS ═══════════════════════ */}
        {tab === 'my-orders' && (
          <div
            style={{
              padding: '18px 22px 22px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 280,
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            {myOrdersQ.isLoading ? (
              <BrowseSkeleton tone="offer" />
            ) : (myOrdersQ.data?.orders ?? []).length === 0 ? (
              <EmptyState
                glyph="⛵"
                title="No orders adrift."
                body="When you claim a need or buy an offer, it'll show up here with its release status."
                cta={
                  <RpgButton variant="primary" size="md" onClick={() => setTab('browse')}>
                    Browse Listings
                  </RpgButton>
                }
              />
            ) : (
              myOrdersQ.data!.orders.map((o) => {
                const callerIsCreator = o.listing.creatorId === myAvatarId;
                return (
                  <OrderRow
                    key={o.id}
                    order={o}
                    listing={o.listing}
                    callerIsCreator={callerIsCreator}
                    onSubmit={() => setSubmitTarget(o)}
                    onConfirm={() => setConfirmTarget({ order: o, listing: o.listing })}
                    onCancel={() => onCancelOrder(o.id)}
                    submitPending={submitTarget?.id === o.id && submitM.isPending}
                    confirmPending={confirmTarget?.order.id === o.id && confirmM.isPending}
                    cancelPending={pendingTarget === o.id && cancelOrderM.isPending}
                  />
                );
              })
            )}
          </div>
        )}

        {/* ═══════════════════════ POST ═══════════════════════ */}
        {tab === 'post' && (
          <PostTab
            tokens={tokens}
            onDone={() => setTab('my-listings')}
            isGuest={isGuest}
            onGuestBlocked={() => setGuestUpsellOpen(true)}
          />
        )}
      </RpgModal>

      {/* Nested action dialogs (Submit + Confirm) */}
      <SubmitDeliveryDialog
        open={!!submitTarget}
        onClose={() => setSubmitTarget(null)}
        onSubmit={onSubmitDelivery}
        pending={submitM.isPending}
      />
      <ConfirmReleaseDialog
        open={!!confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onConfirm={onConfirmRelease}
        pending={confirmM.isPending}
        amountCt={confirmTarget?.order.amountCt ?? 0}
        recipientName={confirmTarget?.listing.creatorId === myAvatarId
          ? 'the claimant'
          : confirmTarget?.listing.creatorName ?? 'the seller'}
      />

      <GuestUpsellModal
        open={guestUpsellOpen}
        onClose={() => setGuestUpsellOpen(false)}
        headline={EXCHANGE_UPSELL.headline}
        body={EXCHANGE_UPSELL.body}
        ctaLabel={EXCHANGE_UPSELL.ctaLabel}
      />
    </>
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function BrowseSkeleton({ tone }: { tone: ExchangeListingType }) {
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '70px 0',
      }}
    >
      <RuneSpinner size={48} tier={tone === 'need' ? 'rare' : 'legendary'} />
      <span
        style={{
          fontSize: 10,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.24em',
        }}
      >
        Reading the tide-board
      </span>
    </div>
  );
}

// ─── Shared form atoms (mirror bounty-board styles) ─────────────────────────

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: 'rgba(10, 22, 40, 0.85)',
  border: '1px solid rgba(56, 189, 248, 0.25)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 12,
  color: '#e2e8f0',
  outline: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 10,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 10,
      }}
    >
      <span
        aria-hidden
        style={{
          flex: 1,
          height: 1,
          background:
            'linear-gradient(90deg, transparent 0%, rgba(56, 189, 248, 0.5) 50%, transparent 100%)',
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-orbitron), sans-serif',
          fontSize: 10,
          color: '#7dd3fc',
          textTransform: 'uppercase',
          letterSpacing: '0.24em',
          fontWeight: 700,
        }}
      >
        {children}
      </span>
      <span
        aria-hidden
        style={{
          flex: 1,
          height: 1,
          background:
            'linear-gradient(90deg, transparent 0%, rgba(56, 189, 248, 0.5) 50%, transparent 100%)',
        }}
      />
    </div>
  );
}
