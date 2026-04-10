import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { creditClawTokens, debitClawTokens } from '../services/neo-token-ledger';
import {
  db,
  pets,
  publishedSkills,
  auctions,
  auctionBids,
  auctionAgentConfigs,
  petInventory,
} from '@clawville/database';
import { eq, and, desc, asc, lt, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getUserPet(userId: string) {
  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, userId), eq(pets.isActive, true)),
  });
  if (!pet) throw new HTTPException(404, { message: 'No active agent found' });
  return pet;
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
          if (auction.currentBidderId && auction.currentBid) {
            // Has a winner — resolve with payout
            const winnerPet = await db.query.pets.findFirst({
              where: eq(pets.id, auction.currentBidderId),
            });
            const sellerPet = await db.query.pets.findFirst({
              where: eq(pets.id, auction.sellerId),
            });

            if (winnerPet && sellerPet) {
              const price = auction.currentBid;
              const platformFee = Math.floor(price * 0.15);
              const sellerPayout = price - platformFee;

              // Pay seller (bid was already escrowed from winner on place-bid)
              await creditClawTokens({
                petId: sellerPet.id,
                amount: sellerPayout,
                reason: 'auction_settled',
                source: 'api',
                metadata: {
                  auctionId: auction.id,
                  winnerId: winnerPet.id,
                  price,
                  platformFee,
                },
              });

              // Transfer skill to winner's inventory if skill type
              if (auction.itemType === 'skill' && auction.skillId) {
                const itemId = `skill-${auction.skillId}`;
                const existingItem = await db.query.petInventory.findFirst({
                  where: and(
                    eq(petInventory.petId, winnerPet.id),
                    eq(petInventory.itemId, itemId)
                  ),
                });

                if (existingItem) {
                  await db
                    .update(petInventory)
                    .set({ quantity: existingItem.quantity + 1 })
                    .where(eq(petInventory.id, existingItem.id));
                } else {
                  await db.insert(petInventory).values({
                    petId: winnerPet.id,
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
                await db.insert(auctionAgentConfigs).values({
                  auctionId: auction.id,
                  petId: winnerPet.id,
                  configSnapshot: auction.agentConfigSnapshot,
                });
              }

              // Mark as resolved
              await db
                .update(auctions)
                .set({
                  status: 'resolved',
                  resolvedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(auctions.id, auction.id));

              console.log(
                `[AuctionResolver] Resolved auction ${auction.id} — winner: ${winnerPet.id}, payout: ${sellerPayout}`
              );
            }
          } else {
            // No bids — mark as ended
            await db
              .update(auctions)
              .set({
                status: 'ended',
                resolvedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(auctions.id, auction.id));

            console.log(
              `[AuctionResolver] Ended auction ${auction.id} — no bids`
            );
          }

          // Emit event
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

export const auctionRoutes = new Hono<AppContext>();
auctionRoutes.use('*', sessionMiddleware);

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
auctionRoutes.get('/my-auctions', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

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
    .where(eq(auctions.sellerId, pet.id))
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
auctionRoutes.get('/my-bids', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const pet = await getUserPet(user.id);

  // Find distinct auctions this pet has bid on
  const bidRows = await db
    .select({
      auctionId: auctionBids.auctionId,
      latestBidAmount: auctionBids.amount,
      latestBidAt: auctionBids.createdAt,
    })
    .from(auctionBids)
    .where(eq(auctionBids.bidderId, pet.id))
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
      sellerPetName: pets.name,
      sellerSpecies: pets.species,
    })
    .from(auctions)
    .innerJoin(pets, eq(auctions.sellerId, pets.id))
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
        sellerPetName: a.sellerPetName,
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
        isWinning: a.currentBidderId === pet.id,
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

auctionRoutes.post('/create', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const body = await c.req.json();
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

  const pet = await getUserPet(user.id);

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

    if (skill.authorPetId !== pet.id) {
      throw new HTTPException(403, {
        message: 'You can only auction skills you authored',
      });
    }

    resolvedSkillId = skillId;
  } else {
    // agent_config — snapshot the pet's characterConfig
    agentConfigSnapshot = pet.characterConfig ?? {};
  }

  const now = new Date();
  const endsAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

  const [auction] = await db
    .insert(auctions)
    .values({
      sellerId: pet.id,
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
      sellerPetName: pets.name,
      sellerSpecies: pets.species,
    })
    .from(auctions)
    .innerJoin(pets, eq(auctions.sellerId, pets.id))
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
      bidderPetName: pets.name,
      bidderSpecies: pets.species,
    })
    .from(auctionBids)
    .innerJoin(pets, eq(auctionBids.bidderId, pets.id))
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
    sellerPetName: r.sellerPetName,
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
      bidderPetName: b.bidderPetName,
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
auctionRoutes.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const pet = await getUserPet(user.id);

  const [auction] = await db
    .select()
    .from(auctions)
    .where(eq(auctions.id, id))
    .limit(1);

  if (!auction) {
    throw new HTTPException(404, { message: 'Auction not found' });
  }

  if (auction.sellerId !== pet.id) {
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

auctionRoutes.post('/:id/bid', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const body = await c.req.json();
  const parsed = bidSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { amount } = parsed.data;
  const bidderPet = await getUserPet(user.id);

  // 1. Fetch auction
  const [auction] = await db
    .select()
    .from(auctions)
    .where(eq(auctions.id, id))
    .limit(1);

  if (!auction) {
    throw new HTTPException(404, { message: 'Auction not found' });
  }

  if (auction.status !== 'active') {
    throw new HTTPException(400, { message: 'Auction is not active' });
  }

  // Check if auction has expired
  const now = new Date();
  if (auction.endsAt < now) {
    throw new HTTPException(400, { message: 'Auction has ended' });
  }

  // 2. Prevent self-bidding
  if (auction.sellerId === bidderPet.id) {
    throw new HTTPException(400, {
      message: 'Seller cannot bid on their own auction',
    });
  }

  // 3. Verify bid amount
  const minimumBid = auction.currentBid
    ? auction.currentBid + 1
    : auction.startingBid;

  if (amount < minimumBid) {
    throw new HTTPException(400, {
      message: `Bid must be at least ${minimumBid} ClawTokens`,
    });
  }

  // 4. ESCROW: Verify bidder has enough tokens
  if (bidderPet.clawTokens < amount) {
    throw new HTTPException(400, {
      message: `Not enough ClawTokens. Need ${amount}, have ${bidderPet.clawTokens}.`,
    });
  }

  // 5. Deduct bid amount from bidder (escrow)
  await debitClawTokens({
    petId: bidderPet.id,
    amount,
    reason: 'auction_bid_escrow',
    source: 'api',
    metadata: { auctionId: id },
  });

  // 6. Refund previous bidder if there was one
  if (auction.currentBidderId && auction.currentBid) {
    await creditClawTokens({
      petId: auction.currentBidderId,
      amount: auction.currentBid,
      reason: 'auction_bid_refund',
      source: 'api',
      metadata: { auctionId: id, outbidBy: bidderPet.id },
    });
  }

  // 7. SNIPE PROTECTION: If bid within 30s of endsAt, extend by 30s
  //    Max extension: +30 min from originalEndsAt
  let newEndsAt = auction.endsAt;
  const timeRemaining = auction.endsAt.getTime() - now.getTime();
  const SNIPE_THRESHOLD_MS = 30 * 1000; // 30 seconds
  const MAX_EXTENSION_MS = 30 * 60 * 1000; // 30 minutes

  if (timeRemaining <= SNIPE_THRESHOLD_MS) {
    const maxEndsAt = new Date(
      auction.originalEndsAt.getTime() + MAX_EXTENSION_MS
    );
    const proposedEndsAt = new Date(now.getTime() + SNIPE_THRESHOLD_MS);
    newEndsAt = proposedEndsAt < maxEndsAt ? proposedEndsAt : maxEndsAt;
  }

  // 8. Update auction state
  await db
    .update(auctions)
    .set({
      currentBid: amount,
      currentBidderId: bidderPet.id,
      bidCount: auction.bidCount + 1,
      endsAt: newEndsAt,
      updatedAt: new Date(),
    })
    .where(eq(auctions.id, id));

  // 9. Insert bid record
  const [bid] = await db
    .insert(auctionBids)
    .values({
      auctionId: id,
      bidderId: bidderPet.id,
      amount,
    })
    .returning();

  // 10. Emit SSE event
  auctionEventBus.emit({
    type: 'bid_placed',
    auctionId: id,
    currentBid: amount,
    currentBidderId: bidderPet.id,
    endsAt: newEndsAt.toISOString(),
    bidCount: auction.bidCount + 1,
  });

  // Re-fetch bidder's updated balance
  const updatedBidder = await db.query.pets.findFirst({
    where: eq(pets.id, bidderPet.id),
  });

  return c.json({
    success: true,
    bid: {
      id: bid.id,
      auctionId: bid.auctionId,
      amount: bid.amount,
      createdAt: bid.createdAt.toISOString(),
    },
    endsAt: newEndsAt.toISOString(),
    bidCount: auction.bidCount + 1,
    clawTokens: updatedBidder?.clawTokens ?? 0,
  });
});

// ---------------------------------------------------------------------------
// POST /:id/buy-now — Instant purchase at buyNowPrice (auth required)
// ---------------------------------------------------------------------------
auctionRoutes.post('/:id/buy-now', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Auction');

  const buyerPet = await getUserPet(user.id);

  // 1. Fetch auction
  const [auction] = await db
    .select()
    .from(auctions)
    .where(eq(auctions.id, id))
    .limit(1);

  if (!auction) {
    throw new HTTPException(404, { message: 'Auction not found' });
  }

  if (auction.status !== 'active') {
    throw new HTTPException(400, { message: 'Auction is not active' });
  }

  const now = new Date();
  if (auction.endsAt < now) {
    throw new HTTPException(400, { message: 'Auction has ended' });
  }

  // 2. Verify auction has buy-now price
  if (!auction.buyNowPrice) {
    throw new HTTPException(400, {
      message: 'This auction does not have a buy-now option',
    });
  }

  // 3. Verify buy-now is still valid (must be > currentBid)
  if (auction.currentBid && auction.buyNowPrice <= auction.currentBid) {
    throw new HTTPException(400, {
      message: 'Current bid has reached or exceeded buy-now price',
    });
  }

  // 4. Prevent self-purchase
  if (auction.sellerId === buyerPet.id) {
    throw new HTTPException(400, {
      message: 'Cannot buy your own auction',
    });
  }

  // 5. Verify buyer has enough tokens
  const price = auction.buyNowPrice;
  if (buyerPet.clawTokens < price) {
    throw new HTTPException(400, {
      message: `Not enough ClawTokens. Need ${price}, have ${buyerPet.clawTokens}.`,
    });
  }

  // 6. Deduct buy-now price from buyer
  const { balanceAfter: buyerBalance } = await debitClawTokens({
    petId: buyerPet.id,
    amount: price,
    reason: 'auction_buy_now',
    source: 'api',
    metadata: { auctionId: id, sellerId: auction.sellerId },
  });

  // 7. Refund previous bidder's escrowed bid if any
  if (auction.currentBidderId && auction.currentBid) {
    await creditClawTokens({
      petId: auction.currentBidderId,
      amount: auction.currentBid,
      reason: 'auction_bid_refund',
      source: 'api',
      metadata: { auctionId: id, outbidBy: buyerPet.id, reason: 'buy_now' },
    });
  }

  // 8. Pay seller (85% of buyNowPrice)
  const platformFee = Math.floor(price * 0.15);
  const sellerPayout = price - platformFee;

  await creditClawTokens({
    petId: auction.sellerId,
    amount: sellerPayout,
    reason: 'auction_buy_now_settled',
    source: 'api',
    metadata: { auctionId: id, buyerId: buyerPet.id, price, platformFee },
  });

  // 9. Mark auction as resolved
  await db
    .update(auctions)
    .set({
      currentBid: price,
      currentBidderId: buyerPet.id,
      status: 'resolved',
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(auctions.id, id));

  // 10. Transfer skill to buyer's inventory if skill type
  if (auction.itemType === 'skill' && auction.skillId) {
    const itemId = `skill-${auction.skillId}`;
    const existingItem = await db.query.petInventory.findFirst({
      where: and(
        eq(petInventory.petId, buyerPet.id),
        eq(petInventory.itemId, itemId)
      ),
    });

    if (existingItem) {
      await db
        .update(petInventory)
        .set({ quantity: existingItem.quantity + 1 })
        .where(eq(petInventory.id, existingItem.id));
    } else {
      await db.insert(petInventory).values({
        petId: buyerPet.id,
        itemId,
        quantity: 1,
      });
    }
  }

  // 11. Store agent config snapshot for buyer if agent_config type
  if (auction.itemType === 'agent_config' && auction.agentConfigSnapshot) {
    await db.insert(auctionAgentConfigs).values({
      auctionId: auction.id,
      petId: buyerPet.id,
      configSnapshot: auction.agentConfigSnapshot,
    });
  }

  // 12. Emit SSE event
  auctionEventBus.emit({
    type: 'buy_now',
    auctionId: id,
    currentBid: price,
    currentBidderId: buyerPet.id,
    endsAt: auction.endsAt.toISOString(),
    bidCount: auction.bidCount,
  });

  return c.json({
    success: true,
    price,
    platformFee,
    sellerPayout,
    clawTokens: buyerBalance,
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
      sellerPetName: pets.name,
      sellerSpecies: pets.species,
    })
    .from(auctions)
    .innerJoin(pets, eq(auctions.sellerId, pets.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const result = rows.map((r) => ({
    id: r.id,
    sellerId: r.sellerId,
    sellerPetName: r.sellerPetName,
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
