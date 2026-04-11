'use client';

/**
 * BazaarModal — the Gameify anchor. Visual re-skin of the skill bazaar using
 * the shared RPG primitives from `@/components/rpg`. Data flow is identical
 * to the previous implementation: every useQuery / useMutation / store hook
 * is preserved, only the presentation layer changed.
 *
 * Stage 2 agents: this file is the reference pattern. When re-skinning
 * auction / quest / bounty modals, follow the same structure — RpgModal at
 * the top, rarity-aware ItemCard grids in the body, RpgButton for all
 * actions, RuneSpinner for loading, etc.
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
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

type BazaarTab = 'browse' | 'my-listings' | 'my-purchases';
type SortMode = 'newest' | 'price-low' | 'price-high' | 'rating';
type RarityFilter = 'all' | RarityId;

// ---------------------------------------------------------------------------
// Filter data
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All Categories' },
  { value: 'automation', label: 'Automation' },
  { value: 'communication', label: 'Communication' },
  { value: 'security', label: 'Security' },
  { value: 'data', label: 'Data & Memory' },
  { value: 'integration', label: 'Integration' },
  { value: 'utility', label: 'Utility' },
];

const RARITY_FILTER_OPTIONS: { value: RarityFilter; label: string }[] = [
  { value: 'all', label: 'All Rarities' },
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'epic', label: 'Epic' },
  { value: 'legendary', label: 'Legendary' },
];

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-low', label: 'Price ↑' },
  { value: 'price-high', label: 'Price ↓' },
  { value: 'rating', label: 'Rating' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a server-side rarity into a known RarityId.
 *
 * NOTE: The bazaar API already auto-computes rarity server-side from the
 * skill's knowledge entry count (see `calculateRarity` in
 * `apps/api/src/routes/bazaar.ts`), so in practice every listing ships with
 * a value. The fallback here is defensive for legacy rows / future tiers.
 *
 * TODO: once every Gameify endpoint ships rarity in its response contract,
 * tighten this into a strict discriminated union and fail loud on unknowns.
 */
function normaliseRarity(value: unknown): RarityId {
  return getRarity(typeof value === 'string' ? value : null).id;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Star rating (small — only used in the review form + aggregate display)
// ---------------------------------------------------------------------------

function StarRating({
  rating,
  interactive,
  onChange,
  size = 'sm',
}: {
  rating: number;
  interactive?: boolean;
  onChange?: (r: number) => void;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [hover, setHover] = useState(0);
  const px = size === 'lg' ? 22 : size === 'md' ? 16 : 13;

  return (
    <span style={{ display: 'inline-flex', gap: 2, lineHeight: 1 }}>
      {[1, 2, 3, 4, 5].map((star) => {
        const active = star <= (hover || rating);
        const content = (
          <span
            key={star}
            style={{
              fontSize: px,
              color: active ? '#facc15' : '#475569',
              cursor: interactive ? 'pointer' : 'default',
              transition: 'transform 120ms ease, color 120ms ease',
              transform: interactive && hover === star ? 'scale(1.15)' : 'scale(1)',
              filter: active ? 'drop-shadow(0 0 4px rgba(250, 204, 21, 0.45))' : 'none',
            }}
            onMouseEnter={interactive ? () => setHover(star) : undefined}
            onMouseLeave={interactive ? () => setHover(0) : undefined}
            onClick={interactive && onChange ? () => onChange(star) : undefined}
            role={interactive ? 'button' : undefined}
            aria-label={interactive ? `Rate ${star} stars` : undefined}
          >
            ★
          </span>
        );
        return content;
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Listing card (Browse tab)
// ---------------------------------------------------------------------------

function BrowseListingCard({
  listing,
  onBuy,
  buying,
}: {
  listing: any;
  onBuy?: () => void;
  buying?: boolean;
}) {
  const rarity = normaliseRarity(listing.rarity);
  const skillName = listing.skillName || listing.name || 'Unnamed Skill';
  const sellerName = listing.sellerPetName || listing.sellerName || listing.authorName || 'Unknown';

  const stats: { label: string; value: React.ReactNode }[] = [];
  if (listing.category) stats.push({ label: 'Category', value: listing.category });
  if (listing.upvoteCount != null) stats.push({ label: 'Upvotes', value: listing.upvoteCount });
  if (listing.reviewCount != null && listing.reviewCount > 0)
    stats.push({ label: 'Reviews', value: listing.reviewCount });
  if (listing.createdAt)
    stats.push({ label: 'Listed', value: formatDate(listing.createdAt) });

  return (
    <ItemCard
      rarity={rarity}
      name={skillName}
      subtitle={`by ${sellerName}`}
      icon={<span>⚔</span>}
      description={listing.skillDescription || listing.description}
      stats={stats}
      price={listing.price}
      priceUnit="NT"
      badge={
        listing.avgRating != null && listing.avgRating > 0 ? (
          <StarRating rating={listing.avgRating} size="sm" />
        ) : undefined
      }
      footer={
        onBuy ? (
          <>
            <span
              style={{
                fontSize: 10,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              {listing.featuredAt ? 'Featured' : 'Active'}
            </span>
            <RpgButton
              variant="primary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onBuy();
              }}
              loading={buying}
            >
              Buy
            </RpgButton>
          </>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// My listings card
// ---------------------------------------------------------------------------

function MyListingCard({
  listing,
  onCancel,
  cancelling,
}: {
  listing: any;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const rarity = normaliseRarity(listing.rarity);
  const skillName = listing.skillName || listing.name || 'Unnamed Skill';

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Price', value: `${listing.price} NT` },
    { label: 'Status', value: listing.status ?? 'active' },
  ];
  if (listing.category) stats.push({ label: 'Category', value: listing.category });
  if (listing.totalEarnings != null)
    stats.push({ label: 'Earned', value: `${listing.totalEarnings} NT` });
  if (listing.soldCount != null && listing.soldCount > 0)
    stats.push({ label: 'Sold', value: listing.soldCount });

  return (
    <ItemCard
      rarity={rarity}
      name={skillName}
      subtitle={listing.skillDescription || 'Your published skill'}
      icon={<span>📜</span>}
      stats={stats}
      badge={
        <span
          style={{
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            padding: '2px 8px',
            borderRadius: 999,
            border: `1px solid ${listing.status === 'active' ? 'rgba(34, 197, 94, 0.5)' : 'rgba(148, 163, 184, 0.4)'}`,
            color: listing.status === 'active' ? '#4ade80' : '#94a3b8',
            background: listing.status === 'active' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(30, 41, 59, 0.6)',
          }}
        >
          {listing.status === 'active' ? 'Active' : listing.status || 'Active'}
        </span>
      }
      footer={
        listing.status === 'active' ? (
          <>
            <span style={{ fontSize: 10, color: '#64748b' }}>
              Listed {formatDate(listing.createdAt)}
            </span>
            <RpgButton
              variant="danger"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              loading={cancelling}
            >
              Cancel
            </RpgButton>
          </>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Purchase card
// ---------------------------------------------------------------------------

function PurchaseCard({
  purchase,
  onReview,
  reviewOpen,
}: {
  purchase: any;
  onReview: () => void;
  reviewOpen: boolean;
}) {
  const rarity = normaliseRarity(purchase.rarity);
  const skillName = purchase.skillName || purchase.name || 'Unnamed Skill';
  const sellerName = purchase.sellerPetName || purchase.sellerName || 'Unknown';

  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Price', value: `${purchase.price} NT` },
  ];
  if (purchase.sellerPayout != null)
    stats.push({ label: 'Seller Got', value: `${purchase.sellerPayout} NT` });
  if (purchase.platformFee != null)
    stats.push({ label: 'Platform Fee', value: `${purchase.platformFee} NT` });
  if (purchase.purchasedAt || purchase.createdAt)
    stats.push({
      label: 'Purchased',
      value: formatDate(purchase.purchasedAt || purchase.createdAt),
    });

  return (
    <ItemCard
      rarity={rarity}
      name={skillName}
      subtitle={`from ${sellerName}`}
      icon={<span>🏺</span>}
      description={purchase.skillDescription}
      stats={stats}
      footer={
        purchase.hasReviewed ? (
          <span
            style={{
              fontSize: 10,
              fontStyle: 'italic',
              color: '#64748b',
              marginLeft: 'auto',
            }}
          >
            Reviewed
          </span>
        ) : (
          <>
            <span style={{ fontSize: 10, color: '#64748b' }}>Rate this skill</span>
            <RpgButton
              variant={reviewOpen ? 'ghost' : 'secondary'}
              size="sm"
              rarity="legendary"
              onClick={(e) => {
                e.stopPropagation();
                onReview();
              }}
            >
              {reviewOpen ? 'Close' : 'Review'}
            </RpgButton>
          </>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Review form
// ---------------------------------------------------------------------------

function ReviewForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (rating: number, comment: string) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');

  return (
    <RuneFrame tier="legendary" glow="subtle" style={{ marginTop: 10 }}>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h4
            style={{
              fontFamily: 'var(--font-orbitron), sans-serif',
              fontSize: 13,
              fontWeight: 700,
              color: '#fb923c',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              margin: 0,
            }}
          >
            Write a Review
          </h4>
          <RarityBadge tier="legendary" label="Rare Quill" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StarRating rating={rating} onChange={setRating} interactive size="lg" />
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{rating}/5</span>
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Share your thoughts on this skill... (optional)"
          rows={3}
          style={{
            width: '100%',
            background: 'rgba(10, 22, 40, 0.85)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 12,
            color: '#e2e8f0',
            resize: 'none',
            outline: 'none',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <RpgButton variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </RpgButton>
          <RpgButton
            variant="primary"
            size="sm"
            onClick={() => onSubmit(rating, comment)}
            loading={submitting}
          >
            Submit Review
          </RpgButton>
        </div>
      </div>
    </RuneFrame>
  );
}

// ---------------------------------------------------------------------------
// Filter styles shared by selects/inputs
// ---------------------------------------------------------------------------

const FILTER_INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(10, 22, 40, 0.85)',
  border: '1px solid rgba(56, 189, 248, 0.25)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 11,
  color: '#e2e8f0',
  outline: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function BazaarModal() {
  const { bazaarOpen, closeBazaar, bazaarTab, setBazaarTab, addToast } = useGameStore();
  const { data: pet } = usePet();
  const queryClient = useQueryClient();

  // Filters
  const [sort, setSort] = useState<SortMode>('newest');
  const [rarity, setRarity] = useState<RarityFilter>('all');
  const [category, setCategory] = useState('all');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [page, setPage] = useState(1);

  // Local state
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [submittingReview, setSubmittingReview] = useState(false);

  // Reset filters on tab change
  useEffect(() => {
    setPage(1);
  }, [bazaarTab, sort, rarity, category, minPrice, maxPrice]);

  // Build query params (kept byte-for-byte identical to the previous
  // implementation so `useQuery` cache keys line up across the two versions).
  const queryParams = {
    page,
    rarity: rarity !== 'all' ? rarity : undefined,
    category: category !== 'all' ? category : undefined,
    sort,
    minPrice: minPrice ? Number(minPrice) : undefined,
    maxPrice: maxPrice ? Number(maxPrice) : undefined,
  };

  // Browse listings query
  const { data: browseData, isLoading: browseLoading } = useQuery({
    queryKey: ['bazaar-listings', queryParams],
    queryFn: () => api.getBazaarListings(queryParams),
    enabled: bazaarOpen && bazaarTab === 'browse',
  });

  // My listings query
  const { data: myListingsData, isLoading: myListingsLoading } = useQuery({
    queryKey: ['bazaar-my-listings'],
    queryFn: () => api.getMyBazaarListings(),
    enabled: bazaarOpen && bazaarTab === 'my-listings',
  });

  // My purchases query
  const { data: myPurchasesData, isLoading: purchasesLoading } = useQuery({
    queryKey: ['bazaar-my-purchases'],
    queryFn: () => api.getMyBazaarPurchases(),
    enabled: bazaarOpen && bazaarTab === 'my-purchases',
  });

  // Buy mutation
  const buyMutation = useMutation({
    mutationFn: (listingId: string) => api.buyBazaarListing(listingId),
    onSuccess: () => {
      addToast('🛒', 'Skill purchased successfully!');
      queryClient.invalidateQueries({ queryKey: ['pet'] });
      queryClient.invalidateQueries({ queryKey: ['bazaar-listings'] });
      queryClient.invalidateQueries({ queryKey: ['bazaar-my-purchases'] });
      setBuyingId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message || 'Purchase failed');
      setBuyingId(null);
    },
  });

  // Cancel listing mutation
  const cancelMutation = useMutation({
    mutationFn: (listingId: string) => api.cancelBazaarListing(listingId),
    onSuccess: () => {
      addToast('🗑️', 'Listing cancelled');
      queryClient.invalidateQueries({ queryKey: ['bazaar-my-listings'] });
      queryClient.invalidateQueries({ queryKey: ['bazaar-listings'] });
      setCancellingId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message || 'Failed to cancel');
      setCancellingId(null);
    },
  });

  // Review mutation
  const reviewMutation = useMutation({
    mutationFn: ({
      listingId,
      rating,
      comment,
    }: {
      listingId: string;
      rating: number;
      comment?: string;
    }) => api.reviewBazaarSkill(listingId, { rating, comment }),
    onSuccess: () => {
      addToast('⭐', 'Review submitted!');
      queryClient.invalidateQueries({ queryKey: ['bazaar-my-purchases'] });
      queryClient.invalidateQueries({ queryKey: ['bazaar-listings'] });
      setReviewingId(null);
      setSubmittingReview(false);
    },
    onError: (err: Error) => {
      addToast('❌', err.message || 'Review failed');
      setSubmittingReview(false);
    },
  });

  const handleBuy = useCallback(
    (listingId: string) => {
      setBuyingId(listingId);
      buyMutation.mutate(listingId);
    },
    [buyMutation]
  );

  const handleCancel = useCallback(
    (listingId: string) => {
      setCancellingId(listingId);
      cancelMutation.mutate(listingId);
    },
    [cancelMutation]
  );

  const handleReviewSubmit = useCallback(
    (listingId: string, rating: number, comment: string) => {
      setSubmittingReview(true);
      reviewMutation.mutate({ listingId, rating, comment: comment || undefined });
    },
    [reviewMutation]
  );

  // Nested escape: if a review form is open, escape closes it first, then the
  // modal. We handle this BEFORE RpgModal attaches its own escape listener by
  // letting the bazaar-local effect run and stopPropagation if needed.
  useEffect(() => {
    if (!bazaarOpen || !reviewingId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setReviewingId(null);
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [bazaarOpen, reviewingId]);

  if (!bazaarOpen) return null;

  const listings = browseData?.listings ?? [];
  const total = browseData?.total ?? 0;
  const pageSize = browseData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myListings = myListingsData?.listings ?? [];
  const myPurchases = myPurchasesData?.purchases ?? [];
  const tokens = pet?.clawTokens ?? pet?.clawTokens ?? 0;

  const totalEarned = myListings.reduce(
    (sum: number, l: any) => sum + (l.totalEarnings || 0),
    0
  );
  const activeCount = myListings.filter((l: any) => l.status === 'active').length;

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  return (
    <RpgModal
      open={bazaarOpen}
      onClose={closeBazaar}
      title="Skill Bazaar"
      subtitle="Trade · Buy · Sell"
      tier="rare"
      glow="subtle"
      headerIcon={<span>⚖</span>}
      maxWidth={980}
      tokenBadge={
        <RpgTooltip content="Your ClawToken balance — spent on purchases, earned from sales.">
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
          borderBottom: '1px solid rgba(56, 189, 248, 0.15)',
        }}
      >
        {(['browse', 'my-listings', 'my-purchases'] as BazaarTab[]).map((t) => {
          const isActive = bazaarTab === t;
          const label =
            t === 'browse' ? 'Browse' : t === 'my-listings' ? 'My Listings' : 'My Purchases';
          return (
            <button
              key={t}
              type="button"
              onClick={() => setBazaarTab(t)}
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

      {/* ============================== BROWSE TAB ============================== */}
      {bazaarTab === 'browse' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
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
              value={rarity}
              onChange={(e) => setRarity(e.target.value as RarityFilter)}
              style={FILTER_INPUT_STYLE}
            >
              {RARITY_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={FILTER_INPUT_STYLE}
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                placeholder="Min"
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                style={{ ...FILTER_INPUT_STYLE, width: 64 }}
              />
              <span style={{ color: '#475569', fontSize: 11 }}>—</span>
              <input
                type="number"
                placeholder="Max"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                style={{ ...FILTER_INPUT_STYLE, width: 64 }}
              />
              <span style={{ fontSize: 9, color: '#64748b', letterSpacing: '0.1em' }}>NT</span>
            </div>

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
                  variant={sort === s.value ? 'ghost' : 'ghost'}
                  size="sm"
                  onClick={() => setSort(s.value)}
                  style={{
                    fontSize: 9,
                    padding: '4px 10px',
                    background:
                      sort === s.value
                        ? 'rgba(56, 189, 248, 0.15)'
                        : 'rgba(10, 22, 40, 0.4)',
                    color: sort === s.value ? '#7dd3fc' : '#94a3b8',
                    border: `1px solid ${sort === s.value ? 'rgba(56, 189, 248, 0.5)' : 'rgba(148, 163, 184, 0.2)'}`,
                  }}
                >
                  {s.label}
                </RpgButton>
              ))}
            </div>
          </div>

          {/* Listings grid */}
          <div
            style={{
              padding: '14px 22px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minHeight: 240,
              maxHeight: '58vh',
              overflowY: 'auto',
            }}
          >
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
                <RuneSpinner size={44} tier="rare" />
                <span
                  style={{
                    fontSize: 10,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '0.2em',
                  }}
                >
                  Scrying the market
                </span>
              </div>
            ) : listings.length === 0 ? (
              <EmptyState
                icon="🏪"
                title="The bazaar is empty"
                hint="No listings match your filters. Try widening the rarity range or sort."
              />
            ) : (
              <>
                {listings.map((listing: any) => (
                  <BrowseListingCard
                    key={listing.id}
                    listing={listing}
                    onBuy={() => handleBuy(listing.id)}
                    buying={buyingId === listing.id}
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
        </div>
      )}

      {/* ============================== MY LISTINGS TAB ============================== */}
      {bazaarTab === 'my-listings' && (
        <div
          style={{
            padding: '14px 22px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minHeight: 240,
            maxHeight: '58vh',
            overflowY: 'auto',
          }}
        >
          {myListingsLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '60px 0',
              }}
            >
              <RuneSpinner size={44} tier="rare" />
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
          ) : myListings.length === 0 ? (
            <EmptyState
              icon="📦"
              title="No active listings"
              hint="Craft a skill in the Forge, then list it here to earn ClawTokens."
            />
          ) : (
            <>
              {/* Earnings summary */}
              <RuneFrame tier="uncommon" glow={false}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 22,
                    padding: '12px 18px',
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: 9,
                        color: 'rgba(34, 197, 94, 0.7)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.14em',
                        margin: 0,
                        fontWeight: 700,
                      }}
                    >
                      Active Listings
                    </p>
                    <p
                      style={{
                        fontFamily: 'var(--font-orbitron), sans-serif',
                        fontSize: 20,
                        fontWeight: 700,
                        color: '#4ade80',
                        margin: '2px 0 0',
                      }}
                    >
                      {activeCount}
                    </p>
                  </div>
                  <div
                    style={{
                      height: 36,
                      width: 1,
                      background: 'rgba(34, 197, 94, 0.25)',
                    }}
                  />
                  <div>
                    <p
                      style={{
                        fontSize: 9,
                        color: 'rgba(250, 204, 21, 0.7)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.14em',
                        margin: 0,
                        fontWeight: 700,
                      }}
                    >
                      Total Earned
                    </p>
                    <p
                      style={{
                        fontFamily: 'var(--font-orbitron), sans-serif',
                        fontSize: 20,
                        fontWeight: 700,
                        color: '#facc15',
                        margin: '2px 0 0',
                        textShadow: '0 0 10px rgba(250, 204, 21, 0.4)',
                      }}
                    >
                      {totalEarned} NT
                    </p>
                  </div>
                </div>
              </RuneFrame>

              {myListings.map((listing: any) => (
                <MyListingCard
                  key={listing.id}
                  listing={listing}
                  onCancel={() => handleCancel(listing.id)}
                  cancelling={cancellingId === listing.id}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* ============================== MY PURCHASES TAB ============================== */}
      {bazaarTab === 'my-purchases' && (
        <div
          style={{
            padding: '14px 22px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minHeight: 240,
            maxHeight: '58vh',
            overflowY: 'auto',
          }}
        >
          {purchasesLoading ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '60px 0',
              }}
            >
              <RuneSpinner size={44} tier="rare" />
              <span
                style={{
                  fontSize: 10,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.2em',
                }}
              >
                Gathering your trophies
              </span>
            </div>
          ) : myPurchases.length === 0 ? (
            <EmptyState
              icon="🛍"
              title="No purchases yet"
              hint="Browse the bazaar and pick up a skill to strengthen your agent."
            />
          ) : (
            myPurchases.map((purchase: any) => (
              <div key={purchase.id}>
                <PurchaseCard
                  purchase={purchase}
                  onReview={() =>
                    setReviewingId(reviewingId === purchase.id ? null : purchase.id)
                  }
                  reviewOpen={reviewingId === purchase.id}
                />
                {reviewingId === purchase.id && (
                  <ReviewForm
                    onSubmit={(rating, comment) =>
                      handleReviewSubmit(
                        purchase.listingId || purchase.id,
                        rating,
                        comment
                      )
                    }
                    onCancel={() => setReviewingId(null)}
                    submitting={submittingReview}
                  />
                )}
              </div>
            ))
          )}
        </div>
      )}
    </RpgModal>
  );
}

// ---------------------------------------------------------------------------
// Shared empty state
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
      <span style={{ fontSize: 36, filter: 'drop-shadow(0 0 16px rgba(56, 189, 248, 0.3))' }}>
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
