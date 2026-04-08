'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { api } from '@/lib/api';

type AuctionTab = 'browse' | 'my-auctions' | 'my-bids';
type SortMode = 'ending-soon' | 'newest' | 'highest-bid';
type ItemTypeFilter = 'all' | 'skill' | 'agent-config';

const ITEM_TYPE_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  skill:          { bg: 'bg-cyan-500/20',   border: 'border-cyan-500/50',   text: 'text-cyan-300',   label: 'Skill' },
  'agent-config': { bg: 'bg-purple-500/20', border: 'border-purple-500/50', text: 'text-purple-300', label: 'Agent Config' },
};

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  active:    { bg: 'bg-green-500/20',  border: 'border-green-500/50',  text: 'text-green-400',  label: 'Active' },
  ended:     { bg: 'bg-gray-500/20',   border: 'border-gray-500/50',   text: 'text-gray-400',   label: 'Ended' },
  resolved:  { bg: 'bg-amber-500/20',  border: 'border-amber-500/50',  text: 'text-amber-400',  label: 'Resolved' },
  cancelled: { bg: 'bg-red-500/20',    border: 'border-red-500/50',    text: 'text-red-400',    label: 'Cancelled' },
};

function ItemTypeBadge({ itemType }: { itemType: string }) {
  const config = ITEM_TYPE_COLORS[itemType] || ITEM_TYPE_COLORS.skill;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.text} border`}>
      {config.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_COLORS[status] || STATUS_COLORS.ended;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${config.bg} ${config.border} ${config.text} border`}>
      {config.label}
    </span>
  );
}

function Countdown({ endsAt }: { endsAt: string }) {
  const [timeLeft, setTimeLeft] = useState('');
  const [isUrgent, setIsUrgent] = useState(false);

  useEffect(() => {
    const tick = () => {
      const ms = new Date(endsAt).getTime() - Date.now();
      if (ms <= 0) { setTimeLeft('Ended'); setIsUrgent(false); return; }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setTimeLeft(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
      setIsUrgent(ms < 300000); // < 5 min
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [endsAt]);

  return <span className={isUrgent ? 'text-red-400 animate-pulse font-bold' : 'text-amber-300'}>{timeLeft}</span>;
}

function AuctionCard({
  auction,
  onBid,
  onBuyNow,
  bidding,
  buyingNow,
}: {
  auction: any;
  onBid: (amount: number) => void;
  onBuyNow?: () => void;
  bidding: boolean;
  buyingNow: boolean;
}) {
  const [showBidInput, setShowBidInput] = useState(false);
  const [bidAmount, setBidAmount] = useState('');
  const currentBid = auction.currentBid || auction.startingBid || 0;
  const minBid = currentBid + 1;
  const isEnded = new Date(auction.endsAt).getTime() <= Date.now();
  const isEndingSoon = !isEnded && new Date(auction.endsAt).getTime() - Date.now() < 300000;

  const handleSubmitBid = () => {
    const amount = Number(bidAmount);
    if (amount >= minBid) {
      onBid(amount);
      setShowBidInput(false);
      setBidAmount('');
    }
  };

  return (
    <div className="relative rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 transition-all hover:bg-amber-500/10">
      {isEndingSoon && !isEnded && (
        <div className="absolute top-2 right-2">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-500/30 border border-red-500/50 text-red-400 animate-pulse">
            ENDING SOON
          </span>
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{auction.title || 'Untitled Auction'}</span>
            <ItemTypeBadge itemType={auction.itemType || 'skill'} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            by {auction.sellerName || 'Unknown'}
          </p>
          {auction.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{auction.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {auction.bidCount > 0 ? (
            <span className="flex items-center gap-1 text-sm font-bold text-amber-300">
              {currentBid} <span className="text-xs">&#x1FA99;</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-sm text-gray-400">
              {auction.startingBid} <span className="text-xs">&#x1FA99;</span>
              <span className="text-[10px] text-gray-500">start</span>
            </span>
          )}
          {auction.bidCount != null && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-400">
              {auction.bidCount} bid{auction.bidCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span className="flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <Countdown endsAt={auction.endsAt} />
          </span>
          {auction.buyNowPrice && !isEnded && (
            <span className="text-amber-400/70">
              Buy Now: {auction.buyNowPrice} &#x1FA99;
            </span>
          )}
        </div>

        {!isEnded && (
          <div className="flex items-center gap-2">
            {auction.buyNowPrice && onBuyNow && (
              <button
                onClick={onBuyNow}
                disabled={buyingNow}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {buyingNow ? 'Buying...' : 'Buy Now'}
              </button>
            )}
            <button
              onClick={() => { setShowBidInput(!showBidInput); setBidAmount(String(minBid)); }}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white transition-all"
            >
              Place Bid
            </button>
          </div>
        )}
      </div>

      {/* Inline bid input */}
      {showBidInput && !isEnded && (
        <div className="mt-2 flex items-center gap-2 p-2 rounded-lg bg-black/30 border border-amber-500/20">
          <span className="text-[10px] text-gray-500">Min: {minBid} &#x1FA99;</span>
          <input
            type="number"
            value={bidAmount}
            onChange={(e) => setBidAmount(e.target.value)}
            min={minBid}
            placeholder={String(minBid)}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            onClick={handleSubmitBid}
            disabled={bidding || Number(bidAmount) < minBid}
            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {bidding ? 'Bidding...' : 'Confirm'}
          </button>
          <button
            onClick={() => setShowBidInput(false)}
            className="text-xs text-gray-400 hover:text-gray-300 px-1"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function MyAuctionCard({
  auction,
  onCancel,
  cancelling,
}: {
  auction: any;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const canCancel = auction.status === 'active' && (!auction.bidCount || auction.bidCount === 0);

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{auction.title || 'Untitled Auction'}</span>
            <ItemTypeBadge itemType={auction.itemType || 'skill'} />
            <StatusBadge status={auction.status || 'active'} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Starting bid: <span className="text-amber-300 font-bold">{auction.startingBid} &#x1FA99;</span>
            {auction.currentBid > 0 && (
              <> &middot; Current: <span className="text-amber-300 font-bold">{auction.currentBid} &#x1FA99;</span></>
            )}
          </p>
          {auction.status === 'active' && auction.endsAt && (
            <p className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <Countdown endsAt={auction.endsAt} />
            </p>
          )}
          {auction.status === 'resolved' && auction.finalPrice != null && (
            <p className="text-xs text-green-400 mt-0.5">
              Sold for: {auction.finalPrice} &#x1FA99;
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {auction.bidCount != null && (
            <span className="text-[10px] text-gray-500">{auction.bidCount} bid{auction.bidCount !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
      {canCancel && (
        <div className="flex items-center justify-end mt-2">
          <button
            onClick={onCancel}
            disabled={cancelling}
            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/40 transition-all disabled:opacity-40"
          >
            {cancelling ? 'Cancelling...' : 'Cancel Auction'}
          </button>
        </div>
      )}
    </div>
  );
}

function MyBidCard({
  auction,
  onIncreaseBid,
}: {
  auction: any;
  onIncreaseBid: (amount: number) => void;
}) {
  const [showBidInput, setShowBidInput] = useState(false);
  const [bidAmount, setBidAmount] = useState('');
  const isWinning = auction.isWinning || auction.bidStatus === 'winning';
  const isEnded = new Date(auction.endsAt).getTime() <= Date.now();
  const currentBid = auction.currentBid || auction.startingBid || 0;
  const minBid = currentBid + 1;

  const handleSubmitBid = () => {
    const amount = Number(bidAmount);
    if (amount >= minBid) {
      onIncreaseBid(amount);
      setShowBidInput(false);
      setBidAmount('');
    }
  };

  return (
    <div className={`rounded-lg border p-3 ${isWinning ? 'border-green-500/30 bg-green-500/5' : 'border-orange-500/30 bg-orange-500/5'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">{auction.title || 'Untitled Auction'}</span>
            <ItemTypeBadge itemType={auction.itemType || 'skill'} />
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            by {auction.sellerName || 'Unknown'}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            Your bid: <span className="text-amber-300 font-bold">{auction.myBid || 0} &#x1FA99;</span>
            {' '}&middot; Current: <span className="text-amber-300 font-bold">{currentBid} &#x1FA99;</span>
          </p>
          {!isEnded && auction.endsAt && (
            <p className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <Countdown endsAt={auction.endsAt} />
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
            isEnded
              ? 'bg-gray-500/20 text-gray-400 border-gray-500/50'
              : isWinning
                ? 'bg-green-500/20 text-green-400 border-green-500/50'
                : 'bg-orange-500/20 text-orange-400 border-orange-500/50'
          }`}>
            {isEnded ? (isWinning ? 'Won' : 'Lost') : isWinning ? 'Winning' : 'Outbid'}
          </span>
        </div>
      </div>

      {!isWinning && !isEnded && (
        <div className="flex items-center justify-end mt-2">
          {showBidInput ? (
            <div className="flex items-center gap-2 w-full">
              <span className="text-[10px] text-gray-500">Min: {minBid} &#x1FA99;</span>
              <input
                type="number"
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                min={minBid}
                placeholder={String(minBid)}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                onClick={handleSubmitBid}
                disabled={Number(bidAmount) < minBid}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowBidInput(false)}
                className="text-xs text-gray-400 hover:text-gray-300 px-1"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setShowBidInput(true); setBidAmount(String(minBid)); }}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/40 transition-all"
            >
              Increase Bid
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
      addToast('&#x2696;', 'Bid placed successfully!');
      queryClient.invalidateQueries({ queryKey: ['auction-detail', auctionId] });
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['pet'] });
      setBidAmount('');
    },
    onError: (err: Error) => {
      addToast('&#x274C;', err.message || 'Bid failed');
    },
  });

  const buyNowMutation = useMutation({
    mutationFn: () => api.buyNow(auctionId),
    onSuccess: () => {
      addToast('&#x2696;', 'Auction won! Item purchased.');
      queryClient.invalidateQueries({ queryKey: ['auction-detail', auctionId] });
      queryClient.invalidateQueries({ queryKey: ['auctions'] });
      queryClient.invalidateQueries({ queryKey: ['pet'] });
    },
    onError: (err: Error) => {
      addToast('&#x274C;', err.message || 'Buy failed');
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
      </div>
    );
  }

  const auction = data?.auction;
  const bids = data?.bids ?? [];
  if (!auction) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-sm">Auction not found.</p>
        <button onClick={onBack} className="text-xs text-amber-400 hover:text-amber-300 mt-2">Back to Browse</button>
      </div>
    );
  }

  const currentBid = auction.currentBid || auction.startingBid || 0;
  const minBid = currentBid + 1;
  const isEnded = new Date(auction.endsAt).getTime() <= Date.now();

  return (
    <div className="px-5 py-3 space-y-4">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        Back to Browse
      </button>

      {/* Auction header */}
      <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-bold text-white">{auction.title}</h3>
              <ItemTypeBadge itemType={auction.itemType || 'skill'} />
            </div>
            {auction.description && (
              <p className="text-sm text-gray-400 mt-1">{auction.description}</p>
            )}
            <p className="text-xs text-gray-500 mt-1">by {auction.sellerName || 'Unknown'}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="text-right">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">Current Bid</p>
              <p className="text-xl font-bold text-amber-300">{currentBid} <span className="text-sm">&#x1FA99;</span></p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Time Left</p>
              <Countdown endsAt={auction.endsAt} />
            </div>
          </div>
        </div>

        {/* Bid / Buy Now actions */}
        {!isEnded && (
          <div className="flex items-center gap-3 mt-4 pt-3 border-t border-amber-500/20">
            <div className="flex-1 flex items-center gap-2">
              <input
                type="number"
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                min={minBid}
                placeholder={`Min bid: ${minBid}`}
                className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                onClick={() => bidMutation.mutate(Number(bidAmount))}
                disabled={bidMutation.isPending || Number(bidAmount) < minBid}
                className="text-sm font-bold px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {bidMutation.isPending ? 'Bidding...' : 'Place Bid'}
              </button>
            </div>
            {auction.buyNowPrice && (
              <button
                onClick={() => buyNowMutation.mutate()}
                disabled={buyNowMutation.isPending}
                className="text-sm font-bold px-4 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {buyNowMutation.isPending ? 'Buying...' : `Buy Now ${auction.buyNowPrice} \u{1FA99}`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bid history */}
      <div>
        <h4 className="text-sm font-bold text-amber-300/80 mb-2">Bid History ({bids.length})</h4>
        {bids.length === 0 ? (
          <p className="text-xs text-gray-500">No bids yet. Be the first!</p>
        ) : (
          <div className="space-y-1 max-h-[30vh] overflow-y-auto">
            {bids.map((bid: any, i: number) => (
              <div
                key={bid.id || i}
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs ${
                  i === 0 ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  {i === 0 && <span className="text-amber-400 text-[10px] font-bold">HIGHEST</span>}
                  <span className="text-gray-300">{bid.bidderName || 'Anonymous'}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-amber-300">{bid.amount} &#x1FA99;</span>
                  <span className="text-gray-600">{new Date(bid.createdAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuctionModal() {
  const { auctionOpen, closeAuction, auctionTab, setAuctionTab, addToast } = useGameStore();
  const { data: pet } = usePet();
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

  // Build query params
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
      queryClient.invalidateQueries({ queryKey: ['pet'] });
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
      queryClient.invalidateQueries({ queryKey: ['pet'] });
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

  const handleBid = useCallback((auctionId: string, amount: number) => {
    setBiddingId(auctionId);
    bidMutation.mutate({ auctionId, amount });
  }, [bidMutation]);

  const handleBuyNow = useCallback((auctionId: string) => {
    setBuyingNowId(auctionId);
    buyNowMutation.mutate(auctionId);
  }, [buyNowMutation]);

  const handleCancel = useCallback((auctionId: string) => {
    setCancellingId(auctionId);
    cancelMutation.mutate(auctionId);
  }, [cancelMutation]);

  // Close on Escape
  useEffect(() => {
    if (!auctionOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (detailAuctionId) setDetailAuctionId(null);
        else closeAuction();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [auctionOpen, closeAuction, detailAuctionId]);

  if (!auctionOpen) return null;

  const auctions = browseData?.auctions ?? [];
  const total = browseData?.total ?? 0;
  const pageSize = browseData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const myAuctions = myAuctionsData?.auctions ?? [];
  const myBids = myBidsData?.auctions ?? [];
  const tokens = pet?.clawTokens ?? pet?.neoTokens ?? 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-[#1a1008]/90 via-[#12150f]/90 to-[#0f1a2e]/90 backdrop-blur-sm"
        onClick={() => {
          if (detailAuctionId) setDetailAuctionId(null);
          else closeAuction();
        }}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="claw-panel flex flex-col overflow-hidden bg-gradient-to-b from-[#1f1508] to-[#0f1a2e] border-2 border-amber-500/30">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">&#x2696;&#xFE0F;</span>
              <div>
                <h2 className="font-bold text-lg text-white tracking-wide">Auction House</h2>
                <p className="text-[10px] text-amber-400/60 uppercase tracking-widest">Bid &middot; Win &middot; Collect</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-sm font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 py-1">
                <span className="text-base">&#x1FA99;</span>
                {tokens}
              </span>
              <button
                onClick={closeAuction}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white font-bold text-sm transition-colors border border-white/10"
              >
                &#x2715;
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-amber-500/20 px-5">
            {(['browse', 'my-auctions', 'my-bids'] as AuctionTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setAuctionTab(t)}
                className={`px-4 py-2.5 text-sm font-bold transition-colors border-b-2 ${
                  auctionTab === t
                    ? 'text-amber-300 border-amber-400'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {t === 'browse' ? 'Browse Auctions' : t === 'my-auctions' ? 'My Auctions' : 'My Bids'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {/* ===== BROWSE TAB ===== */}
            {auctionTab === 'browse' && (
              <div className="flex flex-col">
                {detailAuctionId ? (
                  <AuctionDetail
                    auctionId={detailAuctionId}
                    onBack={() => setDetailAuctionId(null)}
                  />
                ) : (
                  <>
                    {/* Filters bar */}
                    <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-white/5">
                      {/* Item type filter */}
                      <select
                        value={itemType}
                        onChange={(e) => setItemType(e.target.value as ItemTypeFilter)}
                        className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500/50"
                      >
                        <option value="all">All Types</option>
                        <option value="skill">Skills</option>
                        <option value="agent-config">Agent Configs</option>
                      </select>

                      {/* Sort */}
                      <div className="flex items-center gap-1 ml-auto">
                        <span className="text-[10px] text-gray-500 font-bold">Sort:</span>
                        {([
                          { value: 'ending-soon', label: 'Ending Soon' },
                          { value: 'newest', label: 'Newest' },
                          { value: 'highest-bid', label: 'Highest Bid' },
                        ] as { value: SortMode; label: string }[]).map((s) => (
                          <button
                            key={s.value}
                            onClick={() => setSort(s.value)}
                            className={`text-[10px] px-2 py-1 rounded-md font-bold transition-colors ${
                              sort === s.value
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : 'text-gray-500 hover:bg-white/5 border border-transparent'
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Auction cards */}
                    <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                      {browseLoading ? (
                        <div className="flex items-center justify-center py-12">
                          <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                        </div>
                      ) : auctions.length === 0 ? (
                        <div className="text-center py-12">
                          <span className="text-3xl block mb-2">&#x2696;&#xFE0F;</span>
                          <p className="text-gray-500 text-sm">No active auctions. Check back later!</p>
                        </div>
                      ) : (
                        <>
                          {auctions.map((auction: any) => (
                            <div
                              key={auction.id}
                              className="cursor-pointer"
                              onClick={(e) => {
                                // Don't navigate to detail if clicking a button or input
                                if ((e.target as HTMLElement).closest('button, input')) return;
                                setDetailAuctionId(auction.id);
                              }}
                            >
                              <AuctionCard
                                auction={auction}
                                onBid={(amount) => handleBid(auction.id, amount)}
                                onBuyNow={auction.buyNowPrice ? () => handleBuyNow(auction.id) : undefined}
                                bidding={biddingId === auction.id}
                                buyingNow={buyingNowId === auction.id}
                              />
                            </div>
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
                  </>
                )}
              </div>
            )}

            {/* ===== MY AUCTIONS TAB ===== */}
            {auctionTab === 'my-auctions' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {myAuctionsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                  </div>
                ) : myAuctions.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">&#x1F4E6;</span>
                    <p className="text-gray-500 text-sm">You have no auctions yet.</p>
                    <p className="text-gray-600 text-xs mt-1">Create a skill in the Skill Builder, then auction it here!</p>
                  </div>
                ) : (
                  <>
                    {/* Earnings summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Active Auctions</p>
                        <p className="text-lg font-bold text-amber-400">{myAuctions.filter((a: any) => a.status === 'active').length}</p>
                      </div>
                      <div className="h-8 w-px bg-amber-500/20" />
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Total Earned</p>
                        <p className="text-lg font-bold text-amber-300">
                          {myAuctions.reduce((sum: number, a: any) => sum + (a.finalPrice || 0), 0)} &#x1FA99;
                        </p>
                      </div>
                      <div className="h-8 w-px bg-amber-500/20" />
                      <div>
                        <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-bold">Total Bids Received</p>
                        <p className="text-lg font-bold text-white">
                          {myAuctions.reduce((sum: number, a: any) => sum + (a.bidCount || 0), 0)}
                        </p>
                      </div>
                    </div>

                    {myAuctions.map((auction: any) => (
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

            {/* ===== MY BIDS TAB ===== */}
            {auctionTab === 'my-bids' && (
              <div className="px-5 py-3 space-y-2 min-h-[200px] max-h-[55vh]">
                {myBidsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full" />
                  </div>
                ) : myBids.length === 0 ? (
                  <div className="text-center py-12">
                    <span className="text-3xl block mb-2">&#x1F3AF;</span>
                    <p className="text-gray-500 text-sm">No bids yet. Browse auctions to start bidding!</p>
                  </div>
                ) : (
                  <>
                    {/* Bid summary */}
                    <div className="flex items-center gap-4 mb-3 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">Winning</p>
                        <p className="text-lg font-bold text-green-400">
                          {myBids.filter((a: any) => (a.isWinning || a.bidStatus === 'winning') && new Date(a.endsAt).getTime() > Date.now()).length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">Outbid</p>
                        <p className="text-lg font-bold text-orange-400">
                          {myBids.filter((a: any) => !(a.isWinning || a.bidStatus === 'winning') && new Date(a.endsAt).getTime() > Date.now()).length}
                        </p>
                      </div>
                      <div className="h-8 w-px bg-cyan-500/20" />
                      <div>
                        <p className="text-[10px] text-cyan-400/70 uppercase tracking-wider font-bold">Total Bid</p>
                        <p className="text-lg font-bold text-amber-300">
                          {myBids.reduce((sum: number, a: any) => sum + (a.myBid || 0), 0)} &#x1FA99;
                        </p>
                      </div>
                    </div>

                    {myBids.map((auction: any) => (
                      <MyBidCard
                        key={auction.id}
                        auction={auction}
                        onIncreaseBid={(amount) => handleBid(auction.id, amount)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
