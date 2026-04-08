'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';

type BazaarTab = 'browse' | 'my-listings' | 'my-purchases';
type SortMode = 'newest' | 'price-low' | 'price-high' | 'rating';
type Rarity = 'all' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

const RARITY_COLORS: Record<string, { bg: string; border: string; text: string; label: string; glow?: string }> = {
  common:    { bg: 'bg-gray-500/20',   border: 'border-gray-500/50',   text: 'text-gray-300',  label: 'Common' },
  uncommon:  { bg: 'bg-green-500/20',  border: 'border-green-500/50',  text: 'text-green-400', label: 'Uncommon' },
  rare:      { bg: 'bg-blue-500/20',   border: 'border-blue-500/50',   text: 'text-blue-400',  label: 'Rare' },
  epic:      { bg: 'bg-purple-500/20', border: 'border-purple-500/50', text: 'text-purple-400', label: 'Epic' },
  legendary: { bg: 'bg-amber-500/20',  border: 'border-amber-500/50',  text: 'text-amber-400', label: 'Legendary', glow: 'shadow-[0_0_12px_rgba(245,158,11,0.4)]' },
};

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All Categories' },
  { value: 'automation', label: 'Automation' },
  { value: 'communication', label: 'Communication' },
  { value: 'security', label: 'Security' },
  { value: 'data', label: 'Data & Memory' },
  { value: 'integration', label: 'Integration' },
  { value: 'utility', label: 'Utility' },
];

function RarityBadge({ rarity }: { rarity: string }) {
  const config = RARITY_COLORS[rarity] || RARITY_COLORS.common;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.text} border`}>
      {config.label}
    </span>
  );
}

function StarRating({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' }) {
  const stars = [];
  const textSize = size === 'md' ? 'text-base' : 'text-xs';
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      stars.push(<span key={i} className={`${textSize} text-amber-400`}>&#9733;</span>);
    } else if (i - 0.5 <= rating) {
      stars.push(<span key={i} className={`${textSize} text-amber-400`}>&#9733;</span>);
    } else {
      stars.push(<span key={i} className={`${textSize} text-gray-600`}>&#9733;</span>);
    }
  }
  return <span className="inline-flex items-center gap-px">{stars}</span>;
}

function ListingCard({
  listing,
  onBuy,
  buying,
}: {
  listing: any;
  onBuy?: () => void;
  buying?: boolean;
}) {
  const rarity = listing.rarity || 'common';
  const config = RARITY_COLORS[rarity] || RARITY_COLORS.common;
  const isLegendary = rarity === 'legendary';

  return (
    <div
      className={`relative rounded-lg border p-3 transition-all hover:scale-[1.01] ${config.border} ${config.bg} ${isLegendary ? config.glow : ''} ${isLegendary ? 'animate-pulse-subtle' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{listing.skillName || listing.name || 'Unnamed Skill'}</span>
            <RarityBadge rarity={rarity} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            by {listing.sellerName || listing.authorName || 'Unknown'}
          </p>
          {listing.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{listing.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
            {listing.price} <span className="text-xs">&#x1FA99;</span>
          </span>
          {listing.avgRating != null && listing.avgRating > 0 && (
            <StarRating rating={listing.avgRating} />
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          {listing.reviewCount > 0 && (
            <span>{listing.reviewCount} review{listing.reviewCount !== 1 ? 's' : ''}</span>
          )}
          {listing.category && (
            <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">{listing.category}</span>
          )}
          {listing.createdAt && (
            <span>{new Date(listing.createdAt).toLocaleDateString()}</span>
          )}
        </div>
        {onBuy && (
          <button
            onClick={onBuy}
            disabled={buying}
            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {buying ? 'Buying...' : 'Buy'}
          </button>
        )}
      </div>
    </div>
  );
}

function MyListingCard({
  listing,
  onCancel,
  cancelling,
}: {
  listing: any;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const rarity = listing.rarity || 'common';
  const config = RARITY_COLORS[rarity] || RARITY_COLORS.common;

  return (
    <div className={`rounded-lg border p-3 ${config.border} ${config.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{listing.skillName || listing.name || 'Unnamed Skill'}</span>
            <RarityBadge rarity={rarity} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Listed for <span className="text-amber-300 font-bold">{listing.price} &#x1FA99;</span>
          </p>
          {listing.totalEarnings != null && (
            <p className="text-xs text-green-400 mt-0.5">
              Earned: {listing.totalEarnings} &#x1FA99;
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${listing.status === 'active' ? 'bg-green-500/20 text-green-400 border border-green-500/50' : 'bg-gray-500/20 text-gray-400 border border-gray-500/50'}`}>
            {listing.status === 'active' ? 'Active' : listing.status || 'Active'}
          </span>
          {listing.soldCount != null && listing.soldCount > 0 && (
            <span className="text-[10px] text-gray-500">{listing.soldCount} sold</span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end mt-2">
        <button
          onClick={onCancel}
          disabled={cancelling}
          className="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/40 transition-all disabled:opacity-40"
        >
          {cancelling ? 'Cancelling...' : 'Cancel Listing'}
        </button>
      </div>
    </div>
  );
}

function PurchaseCard({
  purchase,
  onReview,
}: {
  purchase: any;
  onReview: () => void;
}) {
  const rarity = purchase.rarity || 'common';
  const config = RARITY_COLORS[rarity] || RARITY_COLORS.common;

  return (
    <div className={`rounded-lg border p-3 ${config.border} ${config.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{purchase.skillName || purchase.name || 'Unnamed Skill'}</span>
            <RarityBadge rarity={rarity} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            from {purchase.sellerName || 'Unknown'} &middot; {purchase.price} &#x1FA99;
          </p>
          {purchase.purchasedAt && (
            <p className="text-[10px] text-gray-500 mt-0.5">
              Purchased {new Date(purchase.purchasedAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {purchase.hasReviewed ? (
            <span className="text-[10px] text-gray-500 italic">Reviewed</span>
          ) : (
            <button
              onClick={onReview}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/40 transition-all"
            >
              Review
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
  const [hoverRating, setHoverRating] = useState(0);

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
      <h4 className="text-sm font-bold text-amber-300">Write a Review</h4>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            onMouseEnter={() => setHoverRating(star)}
            onMouseLeave={() => setHoverRating(0)}
            onClick={() => setRating(star)}
            className="text-xl transition-transform hover:scale-110"
          >
            <span className={star <= (hoverRating || rating) ? 'text-amber-400' : 'text-gray-600'}>
              &#9733;
            </span>
          </button>
        ))}
        <span className="text-xs text-gray-400 ml-2">{rating}/5</span>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Share your thoughts on this skill... (optional)"
        rows={2}
        className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-amber-500/50"
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="text-xs text-gray-400 hover:text-gray-300 px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(rating, comment)}
          disabled={submitting}
          className="text-xs font-bold px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-all disabled:opacity-40"
        >
          {submitting ? 'Submitting...' : 'Submit Review'}
        </button>
      </div>
    </div>
  );
}

export default function BazaarModal() {
  const { bazaarOpen, closeBazaar, bazaarTab, setBazaarTab, addToast } = useGameStore();
  const { data: avatar } = useAvatar();
  const queryClient = useQueryClient();

  // Filters
  const [sort, setSort] = useState<SortMode>('newest');
  const [rarity, setRarity] = useState<Rarity>('all');
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

  // Build query params
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
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
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
    mutationFn: ({ listingId, rating, comment }: { listingId: string; rating: number; comment?: string }) =>
      api.reviewBazaarSkill(listingId, { rating, comment }),
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

  const handleBuy = useCallback((listingId: string) => {
    setBuyingId(listingId);
    buyMutation.mutate(listingId);
  }, [buyMutation]);

  const handleCancel = useCallback((listingId: string) => {
    setCancellingId(listingId);
    cancelMutation.mutate(listingId);
  }, [cancelMutation]);

  const handleReviewSubmit = useCallback((listingId: string, rating: number, comment: string) => {
    setSubmittingReview(true);
    reviewMutation.mutate({ listingId, rating, comment: comment || undefined });
  }, [reviewMutation]);

  // Close on Escape
  useEffect(() => {
    if (!bazaarOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (reviewingId) setReviewingId(null);
        else closeBazaar();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bazaarOpen, closeBazaar, reviewingId]);

  if (!bazaarOpen) return null;

  const listings = browseData?.listings ?? [];
  const total = browseData?.total ?? 0;
  const pageSize = browseData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myListings = myListingsData?.listings ?? [];
  const myPurchases = myPurchasesData?.purchases ?? [];
  const tokens = avatar?.clawTokens ?? avatar?.clawTokens ?? 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-[#0a1628]/90 via-[#0d1f3c]/90 to-[#0a1628]/90 backdrop-blur-sm"
        onClick={closeBazaar}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="claw-panel flex flex-col overflow-hidden bg-gradient-to-b from-[#0f2847] to-[#0a1e3a] border-2 border-cyan-500/30">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚖️</span>
              <div>
                <h2 className="font-bold text-lg text-white tracking-wide">Skill Bazaar</h2>
                <p className="text-[10px] text-cyan-400/60 uppercase tracking-widest">Trade &middot; Buy &middot; Sell</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-sm font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 py-1">
                <span className="text-base">&#x1FA99;</span>
                {tokens}
              </span>
              <button
                onClick={closeBazaar}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white font-bold text-sm transition-colors border border-white/10"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-cyan-500/20 px-5">
            {(['browse', 'my-listings', 'my-purchases'] as BazaarTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setBazaarTab(t)}
                className={`px-4 py-2.5 text-sm font-bold transition-colors border-b-2 ${
                  bazaarTab === t
                    ? 'text-cyan-300 border-cyan-400'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {t === 'browse' ? 'Browse' : t === 'my-listings' ? 'My Listings' : 'My Purchases'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {/* ===== BROWSE TAB ===== */}
            {bazaarTab === 'browse' && (
              <div className="flex flex-col">
                {/* Filters bar */}
                <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-white/5">
                  {/* Rarity filter */}
                  <select
                    value={rarity}
                    onChange={(e) => setRarity(e.target.value as Rarity)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-cyan-500/50"
                  >
                    <option value="all">All Rarities</option>
                    <option value="common">Common</option>
                    <option value="uncommon">Uncommon</option>
                    <option value="rare">Rare</option>
                    <option value="epic">Epic</option>
                    <option value="legendary">Legendary</option>
                  </select>

                  {/* Category filter */}
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-cyan-500/50"
                  >
                    {CATEGORY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>

                  {/* Price range */}
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      placeholder="Min"
                      value={minPrice}
                      onChange={(e) => setMinPrice(e.target.value)}
                      className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50"
                    />
                    <span className="text-gray-600 text-xs">-</span>
                    <input
                      type="number"
                      placeholder="Max"
                      value={maxPrice}
                      onChange={(e) => setMaxPrice(e.target.value)}
                      className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50"
                    />
                    <span className="text-[10px] text-gray-500">&#x1FA99;</span>
                  </div>

                  {/* Sort */}
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[10px] text-gray-500 font-bold">Sort:</span>
                    {([
                      { value: 'newest', label: 'Newest' },
                      { value: 'price-low', label: 'Price ↑' },
                      { value: 'price-high', label: 'Price ↓' },
                      { value: 'rating', label: 'Rating' },
                    ] as { value: SortMode; label: string }[]).map((s) => (
                      <button
                        key={s.value}
                        onClick={() => setSort(s.value)}
                        className={`text-[10px] px-2 py-1 rounded-md font-bold transition-colors ${
                          sort === s.value
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                            : 'text-gray-500 hover:bg-white/5 border border-transparent'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Listings grid */}
                <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                  {browseLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin w-6 h-6 border-2 border-cyan-300 border-t-transparent rounded-full" />
                    </div>
                  ) : listings.length === 0 ? (
                    <div className="text-center py-12">
                      <span className="text-3xl block mb-2">🏪</span>
                      <p className="text-gray-500 text-sm">No listings found. Be the first to sell a skill!</p>
                    </div>
                  ) : (
                    <>
                      {listings.map((listing: any) => (
                        <ListingCard
                          key={listing.id}
                          listing={listing}
                          onBuy={() => handleBuy(listing.id)}
                          buying={buyingId === listing.id}
                        />
                      ))}

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 pt-3">
                          <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page <= 1}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 disabled:opacity-30 transition-colors"
                          >
                            Prev
                          </button>
                          <span className="text-xs text-gray-500">
                            Page {page} of {totalPages}
                          </span>
                          <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:bg-white/10 disabled:opacity-30 transition-colors"
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ===== MY LISTINGS TAB ===== */}
            {bazaarTab === 'my-listings' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {myListingsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-cyan-300 border-t-transparent rounded-full" />
                  </div>
                ) : myListings.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">📦</span>
                    <p className="text-gray-500 text-sm">You have no active listings.</p>
                    <p className="text-gray-600 text-xs mt-1">Use the Skill Builder to create a skill, then list it here!</p>
                  </div>
                ) : (
                  <>
                    {/* Earnings summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                      <div>
                        <p className="text-[10px] text-green-400/70 uppercase tracking-wider font-bold">Active Listings</p>
                        <p className="text-lg font-bold text-green-400">{myListings.filter((l: any) => l.status === 'active').length}</p>
                      </div>
                      <div className="h-8 w-px bg-green-500/20" />
                      <div>
                        <p className="text-[10px] text-green-400/70 uppercase tracking-wider font-bold">Total Earned</p>
                        <p className="text-lg font-bold text-amber-300">
                          {myListings.reduce((sum: number, l: any) => sum + (l.totalEarnings || 0), 0)} &#x1FA99;
                        </p>
                      </div>
                    </div>

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

            {/* ===== MY PURCHASES TAB ===== */}
            {bazaarTab === 'my-purchases' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {purchasesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-cyan-300 border-t-transparent rounded-full" />
                  </div>
                ) : myPurchases.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">🛍️</span>
                    <p className="text-gray-500 text-sm">No purchases yet. Browse the bazaar to find skills!</p>
                  </div>
                ) : (
                  myPurchases.map((purchase: any) => (
                    <div key={purchase.id}>
                      <PurchaseCard
                        purchase={purchase}
                        onReview={() => setReviewingId(reviewingId === purchase.id ? null : purchase.id)}
                      />
                      {reviewingId === purchase.id && (
                        <div className="mt-2">
                          <ReviewForm
                            onSubmit={(rating, comment) => handleReviewSubmit(purchase.listingId || purchase.id, rating, comment)}
                            onCancel={() => setReviewingId(null)}
                            submitting={submittingReview}
                          />
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
