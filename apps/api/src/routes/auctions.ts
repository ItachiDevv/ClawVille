import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import {
  db,
  avatars,
  publishedSkills,
  auctions,
  auctionBids,
  auctionAgentConfigs,
  avatarInventory,
} from '@clawville/database';
import { eq, and, desc, asc, lt, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the acting avatar (full row) from the dual-identity middleware
 * (Rule E5, Phase C — agent parity). `requireAuthOrAgentSession` already proved a
 * live human/agent session and resolved a real, active `identity.avatarId` (it
 * 403s an unbound/expired agent and a user with no active avatar). We re-load the
 * row by THAT id (never a body-supplied id) so we have `clawTokens`/`name`/`id`
 * for the escrow checks + settlement. Unspoofable — it comes from the middleware,
 * not the request body.
 */
async function getActingAvatar(c: { get: (k: 'identity') => ActivityAuthContext['Variables']['identity'] }) {
  const identity = c.get('identity');
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, identity.avatarId),
  });
  if (!avatar) throw new HTTPException(404, { message: 'No active agent found' });
  return avatar;
}

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string, label = 'Resource') {
  if (!uuidRegex.test(id)) {
    throw new HTTPException(404, { message: `${label} not found` });
  }
}

// ---------------------------------------------------------------------------
// SSE Event Bus for live auction updates
// ---------------------------------------------------------------------------

export interface AuctionEvent {
  type: 'bid_placed' | 'auction_ended' | 'buy_now';
  auctionId: string;
  currentBid: number | null;
  currentBidderId: string | null;
  endsAt: string;
  bidCount: number;
}

type AuctionListener = (event: AuctionEvent) => void;

class AuctionEventBus {
  private listeners = new Set<AuctionListener>();

  addListener(listener: AuctionListener) {
    this.listeners.add(listener);
  }

  removeListener(listener: AuctionListener) {
    this.listeners.delete(listener);
  }

  emit(event: AuctionEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

export const auctionEventBus = new AuctionEventBus();

// ---------------------------------------------------------------------------
// Auction Resolver — resolves expired auctions on a 10s interval
// ---------------------------------------------------------------------------

class AuctionResolver {
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.resolve(), 10_000);
    console.log('[AuctionResolver] Started (10s interval)');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async resolve() {
    try {
      const now = new Date();

      // Find expired active auctions
      const expiredAuctions = await db
        .select()
        .from(auctions)
        .where(and(eq(auctions.status, 'active'), lt(auctions.endsAt, now)));

      for (const auction of expiredAuctions) {
        try {
          // Wrap the entire settlement in a transaction with an atomic claim
          // to prevent double-processing by concurrent resolver ticks.
          await db.transaction(async (tx) => {
            // Atomic claim: UPDATE ... WHERE status='active' RETURNING.
            // If 0 rows, another tick already claimed this auction.
            const [claimed] = await tx
              .update(auctions)
              .set({
                status: auction.currentBidderId && auction.currentBid ? 'resolved' : 'ended',
                resolvedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(and(eq(auctions.id, auction.id), eq(auctions.status, 'active')))
              .returning();

            if (!claimed) return; // Already processed by another tick

            if (auction.currentBidderId && auction.currentBid) {
              // Has a winner — resolve with payout
              const winnerAvatar = await tx.query.avatars.findFirst({
                where: eq(avatars.id, auction.currentBidderId),
              });
              const sellerAvatar = await tx.query.avatars.findFirst({
                where: eq(avatars.id, auction.sellerId),
              });

              if (winnerAvatar && sellerAvatar) {
                const price = auction.currentBid;
                const platformFee = Math.floor(price * 0.15);
                const sellerPayout = price - platformFee;

                // Pay seller (bid was already escrowed from winner on place-bid)
                await creditClawTokens({
                  avatarId: sellerAvatar.id,
                  amount: sellerPayout,
                  reason: 'auction_settled',
                  source: 'api',
                  metadata: {
                    auctionId: auction.id,
                    winnerId: winnerAvatar.id,
                    price,
                    platformFee,
                  },
                }, tx);

                // Transfer skill to winner's inventory if skill type
                if (auction.itemType === 'skill' && auction.skillId) {
                  const itemId = `skill-${auction.skillId}`;
                  const existingItem = await tx.query.avatarInventory.findFirst({
                    where: and(
                      eq(avatarInventory.avatarId, winnerAvatar.id),
                      eq(avatarInventory.itemId, itemId)
                    ),
                  });

                  if (existingItem) {
                    await tx
                      .update(avatarInventory)
                      .set({ quantity: existingItem.quantity + 1 })
                      .where(eq(avatarInventory.id, existingItem.id));
                  } else {
                    await tx.insert(avatarInventory).values({
                      avatarId: winnerAvatar.id,
                      itemId,
                      quantity: 1,
                    });
                  }
                }

                // If agent_config type, store the snapshot for the winner
                if (
                  auction.itemType === 'agent_config' &&
                  auction.agentConfigSnapshot
                ) {
                  await tx.insert(auctionAgentConfigs).values({
                    auctionId: auction.id,
                    avatarId: winnerAvatar.id,
                    configSnapshot: auction.agentConfigSnapshot,
                  });
                }

                console.log(
                  `[AuctionResolver] Resolved auction ${auction.id} — winner: ${winnerAvatar.id}, payout: ${sellerPayout}`
                );
              }
            } else {
              console.log(
                `[AuctionResolver] Ended auction ${auction.id} — no bids`
              );
            }
          });

          // Emit event (outside transaction — non-critical SSE notification)
          auctionEventBus.emit({
            type: 'auction_ended',
            auctionId: auction.id,
            currentBid: auction.currentBid,
            currentBidderId: auction.currentBidderId,
            endsAt: auction.endsAt.toISOString(),
            bidCount: auction.bidCount,
          });
        } catch (err) {
          console.error(
            `[AuctionResolver] Error resolving auction ${auction.id}:`,
            err
          );
        }
      }
    } catch (err) {
      console.error('[AuctionResolver] Error in resolve loop:', err);
    }
  }
}

export const auctionResolver = new AuctionResolver();
auctionResolver.start();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Agent parity (Rule E5, Phase C). Every WRITE binds to `identity.avatarId` from
// `requireAuthOrAgentSession` (sessionMiddleware runs first for the human cookie
// path; the agent path reads `X-Clawville-Agent-Session`). Self-bid / self-buy /
// only-seller-cancels / snipe-extension / outbid-refund-exactly-once guards are
// unchanged — they were already keyed on the acting avatar id, now the resolved
// `identity.avatarId`. The resolver cron settles expired auctions on the seller +
// winner avatar ids regardless of whether a participant is human or agent.
export const auctionRoutes = new Hono<ActivityAuthContext>();
auctionRoutes.use('*', sessionMiddleware);

// FEATURE_GATE: skill_marketplace — GRADUATED / UN-PAUSED 2026-06-19.
// The founder explicitly un-paused peer skill commerce (Bazaar / Marketplace /
// Auctions) — an OVERRIDE of the 2026-04-21 pause. The 503 write-gate is REMOVED;
// auction bid escrow + outbid-refund + buy-now + the expiry resolver cron all
// settle in real CT through `claw-token-ledger` (escrow on bid, refund previous
// bidder, 15% platform fee on settlement) with full human↔agent parity. See
// PLAN.md §2 Phase C + GameFeatures.md. Retained as an audit marker, not a stub.

// ---------------------------------------------------------------------------
// SSE: GET /stream — Live auction updates (no auth, spectator-friendly)
// (Static route — must be before /:id)
// ---------------------------------------------------------------------------
auctionRoutes.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    const listener: AuctionListener = async (event) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
        });
      } catch {
        auctionEventBus.removeListener(listener);
      }
    };

    auctionEventBus.addListener(listener);

    stream.onAbort(() => {
      auctionEventBus.removeListener(listener);
    });

    // Keep stream alive until client disconnects
    while (true) {
      await stream.sleep(30000);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /my-auctions — Seller's own auctions (auth required)
// (Static route — must be before /:id)
// ---------------------------------------------------------------------------
auctionRoutes.get('/my-auctions', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);

  const rows = await db
    .select({
      id: auctions.id,
      itemType: auctions.itemType,
      skillId: auctions.skillId,
      title: auctions.title,
      description: auctions.description,
      startingBid: auctions.startingBid,
      currentBid: auctions.currentBid,
      buyNowPrice: auctions.buyNowPrice,
      currentBidderId: auctions.currentBidderId,
      bidCount: auctions.bidCount,
      status: auctions.status,
      endsAt: auctions.endsAt,
      originalEndsAt: auctions.originalEndsAt,
      resolvedAt: auctions.resolvedAt,
      createdAt: auctions.createdAt,
      updatedAt: auctions.updatedAt,
    })
    .from(auctions)
    .where(eq(auctions.sellerId, avatar.id))
    .orderBy(desc(auctions.createdAt));

  const result = rows.map((r) => ({
    ...r,
    endsAt: r.endsAt.toISOString(),
    originalEndsAt: r.originalEndsAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return c.json({ auctions: result });
});

// ---------------------------------------------------------------------------
// GET /my-bids — Auctions the user has bid on (auth required)
// (Static route — must be before /:id)
// ---------------------------------------------------------------------------
auctionRoutes.get('/my-bids', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);

  // Find distinct auctions this avatar has bid on
  const bidRows = await db
    .select({
      auctionId: auctionBids.auctionId,
      latestBidAmount: auctionBids.amount,
      latestBidAt: auctionBids.createdAt,
    })
    .from(auctionBids)
    .where(eq(auctionBids.bidderId, avatar.id))
    .orderBy(desc(auctionBids.createdAt));

  // Deduplicate to get the latest bid per auction
  const seenAuctions = new Set<string>();
  const latestBids: Array<{
    auctionId: string;
    latestBidAmount: number;
    latestBidAt: Date;
  }> = [];

  for (const row of bidRows) {
    if (!seenAuctions.has(row.auctionId)) {
      seenAuctions.add(row.auctionId);
      latestBids.push(row);
    }
  }

  if (latestBids.length === 0) {
    return c.json({ bids: [] });
  }

  // Fetch auction details for each
  const auctionIds = latestBids.map((b) => b.auctionId);
  const auctionRows = await db
    .select({
      id: auctions.id,
      sellerId: auctions.sellerId,
      itemType: auctions.itemType,
      skillId: auctions.skillId,
      title: auctions.title,
      startingBid: auctions.startingBid,
      currentBid: auctions.currentBid,
      buyNowPrice: auctions.buyNowPrice,
      currentBidderId: auctions.currentBidderId,
      bidCount: auctions.bidCount,
      status: auctions.status,
      endsAt: auctions.endsAt,
      createdAt: auctions.createdAt,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(auctions)
    .innerJoin(avatars, eq(auctions.sellerId, avatars.id))
    .where(
      sql`${auctions.id} IN ${auctionIds}`
    );

  const auctionMap = new Map(auctionRows.map((a) => [a.id, a]));

  const bids = latestBids
    .map((b) => {
      const a = auctionMap.get(b.auctionId);
      if (!a) return null;
      return {
        auctionId: a.id,
        title: a.title,
        itemType: a.itemType,
        skillId: a.skillId,
        sellerAvatarName: a.sellerAvatarName,
        sellerSpecies: a.sellerSpecies,
        startingBid: a.startingBid,
        currentBid: a.currentBid,
        buyNowPrice: a.buyNowPrice,
        currentBidderId: a.currentBidderId,
        bidCount: a.bidCount,
        status: a.status,
        endsAt: a.endsAt.toISOString(),
        createdAt: a.createdAt.toISOString(),
        myLatestBid: b.latestBidAmount,
        myLatestBidAt: b.latestBidAt.toISOString(),
        isWinning: a.currentBidderId === avatar.id,
      };
    })
    .filter(Boolean);

  return c.json({ bids });
});

// ---------------------------------------------------------------------------
// POST /create — Create a new auction (auth required)
// (Static route — must be before /:id)
// ---------------------------------------------------------------------------
const createAuctionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  itemType: z.enum(['skill', 'agent_config']),
  skillId: z.string().uuid().optional(),
  startingBid: z.number().int().min(1),
  buyNowPrice: z.number().int().min(1).optional(),
  durationHours: z.number().int().min(1).max(168).default(24),
});

auctionRoutes.post('/create', requireAuthOrAgentSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createAuctionSchema.safeParse(body);

  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { title, description, itemType, skillId, startingBid, buyNowPrice, durationHours } =
    parsed.data;

  // buyNowPrice must be > startingBid if provided
  if (buyNowPrice !== undefined && buyNowPrice <= startingBid) {
    throw new HTTPException(400, {
      message: 'Buy-now price must be greater than starting bid',
    });
  }

  const avatar = await getActingAvatar(c);

  let resolvedSkillId: string | null = null;
  let agentConfigSnapshot: unknown = null;

  if (itemType === 'skill') {
    // skillId is required for skill auctions
    if (!skillId) {
      throw new HTTPException(400, {
        message: 'skillId is required for skill auctions',
      });
    }

    // Verify seller owns the skill
    const [skill] = await db
      .select()
      .from(publishedSkills)
      .where(eq(publishedSkills.id, skillId))
      .limit(1);

    if (!skill) {
      throw new HTTPException(404, { message: 'Skill not found' });
    }

    if (skill.authorAvatarId !== avatar.id) {
      throw new HTTPException(403, {
        message: 'You can only auction skills you authored',
      });
    }

    resolvedSkillId = skillId;
  } else {
    // agent_config — snapshot the avatar's characterConfig
    agentConfigSnapshot = avatar.characterConfig ?? {};
  }

  const now = new Date();
  const endsAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

  const [auction] = await db
    .insert(auctions)
    .values({
      sellerId: avatar.id,
      itemType,
      skillId: resolvedSkillId,
      agentConfigSnapshot,
      title,
      description: description ?? null,
      startingBid,
      buyNowPrice: buyNowPrice ?? null,
      endsAt,
      originalEndsAt: endsAt,
    })
    .returning();

  return c.json({
    success: true,
    auction: {
      id: auction.id,
      sellerId: auction.sellerId,
      itemType: auction.itemType,
      skillId: auction.skillId,
      title: auction.title,
      description: auction.description,
      startingBid: auction.startingBid,
      buyNowPrice: auction.buyNowPrice,
      bidCount: auction.bidCount,
      status: auction.status,
      endsAt: auction.endsAt.toISOString(),
      originalEndsAt: auction.originalEndsAt.toISOString(),
      createdAt: auction.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /:id — Single auction detail with bid history
// ---------------------------------------------------------------------------
auctionRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const rows = await db
    .select({
      id: auctions.id,
      sellerId: auctions.sellerId,
      itemType: auctions.itemType,
      skillId: auctions.skillId,
      agentConfigSnapshot: auctions.agentConfigSnapshot,
      title: auctions.title,
      description: auctions.description,
      startingBid: auctions.startingBid,
      currentBid: auctions.currentBid,
      buyNowPrice: auctions.buyNowPrice,
      currentBidderId: auctions.currentBidderId,
      bidCount: auctions.bidCount,
      status: auctions.status,
      endsAt: auctions.endsAt,
      originalEndsAt: auctions.originalEndsAt,
      resolvedAt: auctions.resolvedAt,
      createdAt: auctions.createdAt,
      updatedAt: auctions.updatedAt,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(auctions)
    .innerJoin(avatars, eq(auctions.sellerId, avatars.id))
    .where(eq(auctions.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Auction not found' });
  }

  const r = rows[0];

  // Fetch bid history
  const bidHistory = await db
    .select({
      id: auctionBids.id,
      bidderId: auctionBids.bidderId,
      amount: auctionBids.amount,
      createdAt: auctionBids.createdAt,
      bidderAvatarName: avatars.name,
      bidderSpecies: avatars.species,
    })
    .from(auctionBids)
    .innerJoin(avatars, eq(auctionBids.bidderId, avatars.id))
    .where(eq(auctionBids.auctionId, id))
    .orderBy(desc(auctionBids.createdAt))
    .limit(50);

  // Optionally fetch skill info if skill-type auction
  let skillInfo: {
    name: string;
    description: string | null;
    rarity: string | null;
    category: string | null;
  } | null = null;

  if (r.skillId) {
    const [skill] = await db
      .select({
        name: publishedSkills.name,
        description: publishedSkills.description,
        rarity: publishedSkills.rarity,
        category: publishedSkills.category,
      })
      .from(publishedSkills)
      .where(eq(publishedSkills.id, r.skillId))
      .limit(1);

    if (skill) {
      skillInfo = skill;
    }
  }

  const auction = {
    id: r.id,
    sellerId: r.sellerId,
    sellerAvatarName: r.sellerAvatarName,
    sellerSpecies: r.sellerSpecies,
    itemType: r.itemType,
    skillId: r.skillId,
    skillInfo,
    agentConfigSnapshot: r.itemType === 'agent_config' ? r.agentConfigSnapshot : undefined,
    title: r.title,
    description: r.description,
    startingBid: r.startingBid,
    currentBid: r.currentBid,
    buyNowPrice: r.buyNowPrice,
    currentBidderId: r.currentBidderId,
    bidCount: r.bidCount,
    status: r.status,
    endsAt: r.endsAt.toISOString(),
    originalEndsAt: r.originalEndsAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    bids: bidHistory.map((b) => ({
      id: b.id,
      bidderId: b.bidderId,
      bidderAvatarName: b.bidderAvatarName,
      bidderSpecies: b.bidderSpecies,
      amount: b.amount,
      createdAt: b.createdAt.toISOString(),
    })),
  };

  return c.json({ auction });
});

// ---------------------------------------------------------------------------
// DELETE /:id — Cancel auction (only if no bids, only by seller)
// ---------------------------------------------------------------------------
auctionRoutes.delete('/:id', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const avatar = await getActingAvatar(c);

  const [auction] = await db
    .select()
    .from(auctions)
    .where(eq(auctions.id, id))
    .limit(1);

  if (!auction) {
    throw new HTTPException(404, { message: 'Auction not found' });
  }

  if (auction.sellerId !== avatar.id) {
    throw new HTTPException(403, {
      message: 'Only the seller can cancel this auction',
    });
  }

  if (auction.status !== 'active') {
    throw new HTTPException(400, {
      message: 'Can only cancel active auctions',
    });
  }

  if (auction.bidCount > 0) {
    throw new HTTPException(400, {
      message: 'Cannot cancel an auction that has bids',
    });
  }

  await db
    .update(auctions)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(auctions.id, id));

  return c.json({ success: true, message: 'Auction cancelled' });
});

// ---------------------------------------------------------------------------
// POST /:id/bid — Place a bid (auth required, escrow + snipe protection)
// ---------------------------------------------------------------------------
const bidSchema = z.object({
  amount: z.number().int().min(1),
});

auctionRoutes.post('/:id/bid', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const body = await c.req.json().catch(() => ({}));
  const parsed = bidSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { amount } = parsed.data;
  const bidderAvatar = await getActingAvatar(c);

  // Entire bid flow in a single transaction with row-level locking to
  // prevent two concurrent bids from racing on the same auction row.
  const result = await db.transaction(async (tx) => {
    // 1. SELECT ... FOR UPDATE — row-lock the auction to serialize bids
    const [auction] = await tx.execute<{
      id: string;
      seller_id: string;
      status: string;
      current_bid: number | null;
      current_bidder_id: string | null;
      bid_count: number;
      starting_bid: number;
      ends_at: Date;
      original_ends_at: Date;
    }>(
      sql`SELECT * FROM auctions WHERE id = ${id} FOR UPDATE`
    );

    if (!auction) {
      throw new HTTPException(404, { message: 'Auction not found' });
    }

    if (auction.status !== 'active') {
      throw new HTTPException(400, { message: 'Auction is not active' });
    }

    const now = new Date();
    const endsAt = new Date(auction.ends_at);
    if (endsAt < now) {
      throw new HTTPException(400, { message: 'Auction has ended' });
    }

    // 2. Prevent self-bidding
    if (auction.seller_id === bidderAvatar.id) {
      throw new HTTPException(400, {
        message: 'Seller cannot bid on their own auction',
      });
    }

    // 3. Verify bid amount
    const minimumBid = auction.current_bid
      ? auction.current_bid + 1
      : auction.starting_bid;

    if (amount < minimumBid) {
      throw new HTTPException(400, {
        message: `Bid must be at least ${minimumBid} ClawTokens`,
      });
    }

    // 4. Deduct bid amount from bidder (escrow) — within transaction
    await debitClawTokens({
      avatarId: bidderAvatar.id,
      amount,
      reason: 'auction_bid_escrow',
      source: 'api',
      metadata: { auctionId: id },
    }, tx);

    // 5. Refund previous bidder if there was one — within same transaction
    if (auction.current_bidder_id && auction.current_bid) {
      await creditClawTokens({
        avatarId: auction.current_bidder_id,
        amount: auction.current_bid,
        reason: 'auction_bid_refund',
        source: 'api',
        metadata: { auctionId: id, outbidBy: bidderAvatar.id },
      }, tx);
    }

    // 6. SNIPE PROTECTION: If bid within 30s of endsAt, extend by 30s
    //    Max extension: +30 min from originalEndsAt
    let newEndsAt = endsAt;
    const originalEndsAt = new Date(auction.original_ends_at);
    const timeRemaining = endsAt.getTime() - now.getTime();
    const SNIPE_THRESHOLD_MS = 30 * 1000;
    const MAX_EXTENSION_MS = 30 * 60 * 1000;

    if (timeRemaining <= SNIPE_THRESHOLD_MS) {
      const maxEndsAt = new Date(
        originalEndsAt.getTime() + MAX_EXTENSION_MS
      );
      const proposedEndsAt = new Date(now.getTime() + SNIPE_THRESHOLD_MS);
      newEndsAt = proposedEndsAt < maxEndsAt ? proposedEndsAt : maxEndsAt;
    }

    const newBidCount = auction.bid_count + 1;

    // 7. Update auction state
    await tx
      .update(auctions)
      .set({
        currentBid: amount,
        currentBidderId: bidderAvatar.id,
        bidCount: newBidCount,
        endsAt: newEndsAt,
        updatedAt: new Date(),
      })
      .where(eq(auctions.id, id));

    // 8. Insert bid record
    const [bid] = await tx
      .insert(auctionBids)
      .values({
        auctionId: id,
        bidderId: bidderAvatar.id,
        amount,
      })
      .returning();

    return { bid, newEndsAt, newBidCount };
  });

  // 9. Emit SSE event (outside transaction — non-critical)
  auctionEventBus.emit({
    type: 'bid_placed',
    auctionId: id,
    currentBid: amount,
    currentBidderId: bidderAvatar.id,
    endsAt: result.newEndsAt.toISOString(),
    bidCount: result.newBidCount,
  });

  // Re-fetch bidder's updated balance
  const updatedBidder = await db.query.avatars.findFirst({
    where: eq(avatars.id, bidderAvatar.id),
  });

  return c.json({
    success: true,
    bid: {
      id: result.bid.id,
      auctionId: result.bid.auctionId,
      amount: result.bid.amount,
      createdAt: result.bid.createdAt.toISOString(),
    },
    endsAt: result.newEndsAt.toISOString(),
    bidCount: result.newBidCount,
    clawTokens: updatedBidder?.clawTokens ?? 0,
  });
});

// ---------------------------------------------------------------------------
// POST /:id/buy-now — Instant purchase at buyNowPrice (auth required)
// ---------------------------------------------------------------------------
auctionRoutes.post('/:id/buy-now', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const buyerAvatar = await getActingAvatar(c);

  // Entire buy-now flow in a single transaction with row-level locking to
  // prevent two concurrent buy-now requests from racing on the same auction.
  const result = await db.transaction(async (tx) => {
    // 1. SELECT ... FOR UPDATE — row-lock the auction to serialize buy-now
    const [auction] = await tx.execute<{
      id: string;
      seller_id: string;
      status: string;
      current_bid: number | null;
      current_bidder_id: string | null;
      bid_count: number;
      buy_now_price: number | null;
      ends_at: Date;
      item_type: string;
      skill_id: string | null;
      agent_config_snapshot: any;
    }>(
      sql`SELECT * FROM auctions WHERE id = ${id} FOR UPDATE`
    );

    if (!auction) {
      throw new HTTPException(404, { message: 'Auction not found' });
    }

    if (auction.status !== 'active') {
      throw new HTTPException(400, { message: 'Auction is not active' });
    }

    const now = new Date();
    const endsAt = new Date(auction.ends_at);
    if (endsAt < now) {
      throw new HTTPException(400, { message: 'Auction has ended' });
    }

    // 2. Verify auction has buy-now price
    if (!auction.buy_now_price) {
      throw new HTTPException(400, {
        message: 'This auction does not have a buy-now option',
      });
    }

    // 3. Verify buy-now is still valid (must be > currentBid)
    if (auction.current_bid && auction.buy_now_price <= auction.current_bid) {
      throw new HTTPException(400, {
        message: 'Current bid has reached or exceeded buy-now price',
      });
    }

    // 4. Prevent self-purchase
    if (auction.seller_id === buyerAvatar.id) {
      throw new HTTPException(400, {
        message: 'Cannot buy your own auction',
      });
    }

    // 5. Verify buyer has enough tokens
    const price = auction.buy_now_price;
    if (buyerAvatar.clawTokens < price) {
      throw new HTTPException(400, {
        message: `Not enough ClawTokens. Need ${price}, have ${buyerAvatar.clawTokens}.`,
      });
    }

    // 6. Deduct buy-now price from buyer — within transaction
    const { balanceAfter: buyerBalance } = await debitClawTokens({
      avatarId: buyerAvatar.id,
      amount: price,
      reason: 'auction_buy_now',
      source: 'api',
      metadata: { auctionId: id, sellerId: auction.seller_id },
    }, tx);

    // 7. Refund previous bidder's escrowed bid if any — within transaction
    if (auction.current_bidder_id && auction.current_bid) {
      await creditClawTokens({
        avatarId: auction.current_bidder_id,
        amount: auction.current_bid,
        reason: 'auction_bid_refund',
        source: 'api',
        metadata: { auctionId: id, outbidBy: buyerAvatar.id, reason: 'buy_now' },
      }, tx);
    }

    // 8. Pay seller (85% of buyNowPrice) — within transaction
    const platformFee = Math.floor(price * 0.15);
    const sellerPayout = price - platformFee;

    await creditClawTokens({
      avatarId: auction.seller_id,
      amount: sellerPayout,
      reason: 'auction_buy_now_settled',
      source: 'api',
      metadata: { auctionId: id, buyerId: buyerAvatar.id, price, platformFee },
    }, tx);

    // 9. Mark auction as resolved — within transaction
    await tx
      .update(auctions)
      .set({
        currentBid: price,
        currentBidderId: buyerAvatar.id,
        status: 'resolved',
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(auctions.id, id));

    // 10. Transfer skill to buyer's inventory if skill type — within transaction
    if (auction.item_type === 'skill' && auction.skill_id) {
      const itemId = `skill-${auction.skill_id}`;
      const existingItem = await tx.query.avatarInventory.findFirst({
        where: and(
          eq(avatarInventory.avatarId, buyerAvatar.id),
          eq(avatarInventory.itemId, itemId)
        ),
      });

      if (existingItem) {
        await tx
          .update(avatarInventory)
          .set({ quantity: existingItem.quantity + 1 })
          .where(eq(avatarInventory.id, existingItem.id));
      } else {
        await tx.insert(avatarInventory).values({
          avatarId: buyerAvatar.id,
          itemId,
          quantity: 1,
        });
      }
    }

    // 11. Store agent config snapshot for buyer if agent_config type — within transaction
    if (auction.item_type === 'agent_config' && auction.agent_config_snapshot) {
      await tx.insert(auctionAgentConfigs).values({
        auctionId: auction.id,
        avatarId: buyerAvatar.id,
        configSnapshot: auction.agent_config_snapshot,
      });
    }

    return { price, platformFee, sellerPayout, buyerBalance, endsAt, bidCount: auction.bid_count };
  });

  // 12. Emit SSE event (outside transaction — non-critical)
  auctionEventBus.emit({
    type: 'buy_now',
    auctionId: id,
    currentBid: result.price,
    currentBidderId: buyerAvatar.id,
    endsAt: result.endsAt.toISOString(),
    bidCount: result.bidCount,
  });

  return c.json({
    success: true,
    price: result.price,
    platformFee: result.platformFee,
    sellerPayout: result.sellerPayout,
    clawTokens: result.buyerBalance,
  });
});

// ---------------------------------------------------------------------------
// GET / — List active auctions (paginated, filterable, sortable)
// (Must be LAST so it doesn't catch static routes)
// ---------------------------------------------------------------------------
auctionRoutes.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('pageSize') || '20', 10))
  );
  const offset = (page - 1) * pageSize;

  const itemType = c.req.query('itemType');
  const status = c.req.query('status') || 'active';
  const sort = c.req.query('sort') || 'ending-soon';

  // Build WHERE conditions
  const conditions: ReturnType<typeof eq>[] = [];

  if (status) {
    conditions.push(
      eq(
        auctions.status,
        status as 'active' | 'ended' | 'cancelled' | 'resolved'
      )
    );
  }

  if (itemType) {
    conditions.push(
      eq(auctions.itemType, itemType as 'skill' | 'agent_config')
    );
  }

  const whereClause =
    conditions.length > 0 ? and(...conditions) : undefined;

  // Count total
  const [{ total: totalCount }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auctions)
    .where(whereClause);

  // Sort
  let orderBy;
  switch (sort) {
    case 'ending-soon':
      orderBy = asc(auctions.endsAt);
      break;
    case 'newest':
      orderBy = desc(auctions.createdAt);
      break;
    case 'price-asc':
      orderBy = asc(auctions.currentBid);
      break;
    case 'price-desc':
      orderBy = desc(auctions.currentBid);
      break;
    case 'most-bids':
      orderBy = desc(auctions.bidCount);
      break;
    default:
      orderBy = asc(auctions.endsAt);
  }

  // Fetch auctions
  const rows = await db
    .select({
      id: auctions.id,
      sellerId: auctions.sellerId,
      itemType: auctions.itemType,
      skillId: auctions.skillId,
      title: auctions.title,
      description: auctions.description,
      startingBid: auctions.startingBid,
      currentBid: auctions.currentBid,
      buyNowPrice: auctions.buyNowPrice,
      currentBidderId: auctions.currentBidderId,
      bidCount: auctions.bidCount,
      status: auctions.status,
      endsAt: auctions.endsAt,
      originalEndsAt: auctions.originalEndsAt,
      createdAt: auctions.createdAt,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(auctions)
    .innerJoin(avatars, eq(auctions.sellerId, avatars.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const result = rows.map((r) => ({
    id: r.id,
    sellerId: r.sellerId,
    sellerAvatarName: r.sellerAvatarName,
    sellerSpecies: r.sellerSpecies,
    itemType: r.itemType,
    skillId: r.skillId,
    title: r.title,
    description: r.description,
    startingBid: r.startingBid,
    currentBid: r.currentBid,
    buyNowPrice: r.buyNowPrice,
    currentBidderId: r.currentBidderId,
    bidCount: r.bidCount,
    status: r.status,
    endsAt: r.endsAt.toISOString(),
    originalEndsAt: r.originalEndsAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json({ auctions: result, total: totalCount, page, pageSize });
});
