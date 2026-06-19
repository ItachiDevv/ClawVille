import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
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
  bazaarListings,
  bazaarTransactions,
  bazaarReviews,
  avatarInventory,
} from '@clawville/database';
import { eq, and, desc, asc, sql, ne } from 'drizzle-orm';
import { gte, lte, isNotNull, count, avg } from 'drizzle-orm';

// Agent parity (Rule E5, Phase C). Every WRITE binds to `identity.avatarId` from
// `requireAuthOrAgentSession` — the SAME avatar for a Lucia human AND a
// connected/hosted agent (`X-Clawville-Agent-Session` → its bound avatar). The
// route group runs `sessionMiddleware` FIRST so the middleware can read
// `c.get('user')` for the human path; the agent path reads the session header.
// Seller-only / self-buy / single-active-listing / purchased-before-review guards
// are unchanged — they were already keyed on the acting avatar id, which is now
// the resolved `identity.avatarId`.
export const bazaarRoutes = new Hono<ActivityAuthContext>();
bazaarRoutes.use('*', sessionMiddleware);

// FEATURE_GATE: skill_marketplace — GRADUATED / UN-PAUSED 2026-06-19.
// The founder explicitly un-paused peer skill commerce (Bazaar / Marketplace /
// Auctions) — an OVERRIDE of the 2026-04-21 pause. The 503 write-gate that
// returned `Skill marketplace paused pending rework` is REMOVED; the bazaar buy
// path settles in real CT through `claw-token-ledger` (atomic debit-buyer /
// credit-seller, 15% platform fee) with full human↔agent parity. See PLAN.md
// §2 Phase C + the GameFeatures.md "peer skill commerce LIVE" section. The gate
// block is retained as an audit marker of the graduation, not an active stub.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calculateRarity(
  knowledgeEntryCount: number
): 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' {
  if (knowledgeEntryCount >= 20) return 'legendary';
  if (knowledgeEntryCount >= 15) return 'epic';
  if (knowledgeEntryCount >= 10) return 'rare';
  if (knowledgeEntryCount >= 5) return 'uncommon';
  return 'common';
}

/**
 * Resolve the acting avatar (full row) from the dual-identity middleware.
 * `requireAuthOrAgentSession` already proved a live human/agent session and
 * resolved a real, active `identity.avatarId` (it 403s an unbound/expired agent
 * and a user with no active avatar). We re-load the row by THAT id (never a
 * body-supplied id) so we have `clawTokens`/`name`/`id` for the balance checks +
 * settlement. The id comes from the middleware, not the request body — unspoofable.
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
// 1. GET / — Browse active bazaar listings (paginated, filterable, sortable)
// ---------------------------------------------------------------------------
bazaarRoutes.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(c.req.query('pageSize') || '20', 10))
  );
  const offset = (page - 1) * pageSize;

  const rarity = c.req.query('rarity');
  const category = c.req.query('category');
  const minPrice = c.req.query('minPrice')
    ? parseInt(c.req.query('minPrice')!, 10)
    : undefined;
  const maxPrice = c.req.query('maxPrice')
    ? parseInt(c.req.query('maxPrice')!, 10)
    : undefined;
  const sort = c.req.query('sort') || 'newest';

  // Build WHERE conditions
  const conditions: ReturnType<typeof eq>[] = [
    eq(bazaarListings.status, 'active'),
  ];
  if (rarity) {
    conditions.push(
      eq(
        publishedSkills.rarity,
        rarity as 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
      )
    );
  }
  if (category) {
    conditions.push(eq(publishedSkills.category, category));
  }
  if (minPrice !== undefined) {
    conditions.push(gte(bazaarListings.price, minPrice));
  }
  if (maxPrice !== undefined) {
    conditions.push(lte(bazaarListings.price, maxPrice));
  }

  const whereClause = and(...conditions);

  // Sort
  let orderBy;
  switch (sort) {
    case 'price_asc':
      orderBy = asc(bazaarListings.price);
      break;
    case 'price_desc':
      orderBy = desc(bazaarListings.price);
      break;
    case 'rating':
      orderBy = desc(publishedSkills.upvoteCount);
      break;
    default:
      orderBy = desc(bazaarListings.createdAt);
  }

  // Count total
  const [{ total: totalCount }] = await db
    .select({ total: count() })
    .from(bazaarListings)
    .innerJoin(publishedSkills, eq(bazaarListings.skillId, publishedSkills.id))
    .where(whereClause);

  // Fetch listings
  const rows = await db
    .select({
      id: bazaarListings.id,
      skillId: bazaarListings.skillId,
      sellerId: bazaarListings.sellerId,
      price: bazaarListings.price,
      status: bazaarListings.status,
      featuredAt: bazaarListings.featuredAt,
      expiresAt: bazaarListings.expiresAt,
      createdAt: bazaarListings.createdAt,
      skillName: publishedSkills.name,
      skillDescription: publishedSkills.description,
      rarity: publishedSkills.rarity,
      category: publishedSkills.category,
      upvoteCount: publishedSkills.upvoteCount,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(bazaarListings)
    .innerJoin(publishedSkills, eq(bazaarListings.skillId, publishedSkills.id))
    .innerJoin(avatars, eq(bazaarListings.sellerId, avatars.id))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const listings = rows.map((r) => ({
    id: r.id,
    skillId: r.skillId,
    sellerId: r.sellerId,
    sellerAvatarName: r.sellerAvatarName,
    sellerSpecies: r.sellerSpecies,
    price: r.price,
    status: r.status,
    featuredAt: r.featuredAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    skillName: r.skillName,
    skillDescription: r.skillDescription,
    rarity: r.rarity,
    category: r.category,
    upvoteCount: r.upvoteCount,
  }));

  return c.json({ listings, total: totalCount, page, pageSize });
});

// ---------------------------------------------------------------------------
// 3. GET /featured — Featured / promoted listings
//    (Defined BEFORE /:id to avoid route conflict)
// ---------------------------------------------------------------------------
bazaarRoutes.get('/featured', async (c) => {
  const rows = await db
    .select({
      id: bazaarListings.id,
      skillId: bazaarListings.skillId,
      sellerId: bazaarListings.sellerId,
      price: bazaarListings.price,
      status: bazaarListings.status,
      featuredAt: bazaarListings.featuredAt,
      createdAt: bazaarListings.createdAt,
      skillName: publishedSkills.name,
      skillDescription: publishedSkills.description,
      rarity: publishedSkills.rarity,
      category: publishedSkills.category,
      upvoteCount: publishedSkills.upvoteCount,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(bazaarListings)
    .innerJoin(publishedSkills, eq(bazaarListings.skillId, publishedSkills.id))
    .innerJoin(avatars, eq(bazaarListings.sellerId, avatars.id))
    .where(
      and(
        eq(bazaarListings.status, 'active'),
        isNotNull(bazaarListings.featuredAt)
      )
    )
    .orderBy(desc(bazaarListings.featuredAt))
    .limit(10);

  const listings = rows.map((r) => ({
    id: r.id,
    skillId: r.skillId,
    sellerId: r.sellerId,
    sellerAvatarName: r.sellerAvatarName,
    sellerSpecies: r.sellerSpecies,
    price: r.price,
    status: r.status,
    featuredAt: r.featuredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    skillName: r.skillName,
    skillDescription: r.skillDescription,
    rarity: r.rarity,
    category: r.category,
    upvoteCount: r.upvoteCount,
  }));

  return c.json({ listings });
});

// ---------------------------------------------------------------------------
// 7. GET /my-listings — Seller's own listings (auth required)
// ---------------------------------------------------------------------------
bazaarRoutes.get('/my-listings', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);

  const rows = await db
    .select({
      id: bazaarListings.id,
      skillId: bazaarListings.skillId,
      price: bazaarListings.price,
      status: bazaarListings.status,
      featuredAt: bazaarListings.featuredAt,
      expiresAt: bazaarListings.expiresAt,
      createdAt: bazaarListings.createdAt,
      updatedAt: bazaarListings.updatedAt,
      skillName: publishedSkills.name,
      skillDescription: publishedSkills.description,
      rarity: publishedSkills.rarity,
      category: publishedSkills.category,
    })
    .from(bazaarListings)
    .innerJoin(publishedSkills, eq(bazaarListings.skillId, publishedSkills.id))
    .where(eq(bazaarListings.sellerId, avatar.id))
    .orderBy(desc(bazaarListings.createdAt));

  const listings = rows.map((r) => ({
    id: r.id,
    skillId: r.skillId,
    price: r.price,
    status: r.status,
    featuredAt: r.featuredAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    skillName: r.skillName,
    skillDescription: r.skillDescription,
    rarity: r.rarity,
    category: r.category,
  }));

  return c.json({ listings });
});

// ---------------------------------------------------------------------------
// 9. GET /my-purchases — Buyer's purchase history (auth required)
// ---------------------------------------------------------------------------
bazaarRoutes.get('/my-purchases', requireAuthOrAgentSession, async (c) => {
  const avatar = await getActingAvatar(c);

  const rows = await db
    .select({
      id: bazaarTransactions.id,
      listingId: bazaarTransactions.listingId,
      skillId: bazaarTransactions.skillId,
      price: bazaarTransactions.price,
      platformFee: bazaarTransactions.platformFee,
      sellerPayout: bazaarTransactions.sellerPayout,
      createdAt: bazaarTransactions.createdAt,
      skillName: publishedSkills.name,
      skillDescription: publishedSkills.description,
      rarity: publishedSkills.rarity,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(bazaarTransactions)
    .innerJoin(
      publishedSkills,
      eq(bazaarTransactions.skillId, publishedSkills.id)
    )
    .innerJoin(avatars, eq(bazaarTransactions.sellerId, avatars.id))
    .where(eq(bazaarTransactions.buyerId, avatar.id))
    .orderBy(desc(bazaarTransactions.createdAt));

  const purchases = rows.map((r) => ({
    id: r.id,
    listingId: r.listingId,
    skillId: r.skillId,
    price: r.price,
    platformFee: r.platformFee,
    sellerPayout: r.sellerPayout,
    createdAt: r.createdAt.toISOString(),
    skillName: r.skillName,
    skillDescription: r.skillDescription,
    rarity: r.rarity,
    sellerAvatarName: r.sellerAvatarName,
    sellerSpecies: r.sellerSpecies,
  }));

  return c.json({ purchases });
});

// ---------------------------------------------------------------------------
// 12. GET /stats — Bazaar statistics
// ---------------------------------------------------------------------------
bazaarRoutes.get('/stats', async (c) => {
  // Total active listings
  const [{ total: totalListings }] = await db
    .select({ total: count() })
    .from(bazaarListings)
    .where(eq(bazaarListings.status, 'active'));

  // Total completed sales
  const [{ total: totalSales }] = await db
    .select({ total: count() })
    .from(bazaarTransactions);

  // Average price by rarity (from active listings joined with skills)
  const avgByRarity = await db
    .select({
      rarity: publishedSkills.rarity,
      avgPrice: avg(bazaarListings.price),
      listingCount: count(),
    })
    .from(bazaarListings)
    .innerJoin(publishedSkills, eq(bazaarListings.skillId, publishedSkills.id))
    .where(eq(bazaarListings.status, 'active'))
    .groupBy(publishedSkills.rarity);

  const avgPriceByRarity = avgByRarity.map((r) => ({
    rarity: r.rarity,
    avgPrice: r.avgPrice ? Math.round(parseFloat(r.avgPrice)) : 0,
    listingCount: r.listingCount,
  }));

  return c.json({
    totalListings,
    totalSales,
    avgPriceByRarity,
  });
});

// ---------------------------------------------------------------------------
// 11. GET /skills/:skillId/reviews — All reviews for a skill
// ---------------------------------------------------------------------------
bazaarRoutes.get('/skills/:skillId/reviews', async (c) => {
  const skillId = c.req.param('skillId');
  validateUuid(skillId, 'Skill');

  const rows = await db
    .select({
      id: bazaarReviews.id,
      rating: bazaarReviews.rating,
      comment: bazaarReviews.comment,
      createdAt: bazaarReviews.createdAt,
      reviewerAvatarName: avatars.name,
      reviewerSpecies: avatars.species,
    })
    .from(bazaarReviews)
    .innerJoin(avatars, eq(bazaarReviews.reviewerId, avatars.id))
    .where(eq(bazaarReviews.skillId, skillId))
    .orderBy(desc(bazaarReviews.createdAt));

  const reviews = rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt.toISOString(),
    reviewerAvatarName: r.reviewerAvatarName,
    reviewerSpecies: r.reviewerSpecies,
  }));

  return c.json({ reviews });
});

// ---------------------------------------------------------------------------
// 2. GET /:id — Single listing detail with skill info + reviews
// ---------------------------------------------------------------------------
bazaarRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  const rows = await db
    .select({
      id: bazaarListings.id,
      skillId: bazaarListings.skillId,
      sellerId: bazaarListings.sellerId,
      price: bazaarListings.price,
      status: bazaarListings.status,
      featuredAt: bazaarListings.featuredAt,
      expiresAt: bazaarListings.expiresAt,
      createdAt: bazaarListings.createdAt,
      updatedAt: bazaarListings.updatedAt,
      skillName: publishedSkills.name,
      skillDescription: publishedSkills.description,
      skillMd: publishedSkills.skillMd,
      rarity: publishedSkills.rarity,
      category: publishedSkills.category,
      upvoteCount: publishedSkills.upvoteCount,
      downloadCount: publishedSkills.downloadCount,
      sellerAvatarName: avatars.name,
      sellerSpecies: avatars.species,
    })
    .from(bazaarListings)
    .innerJoin(publishedSkills, eq(bazaarListings.skillId, publishedSkills.id))
    .innerJoin(avatars, eq(bazaarListings.sellerId, avatars.id))
    .where(eq(bazaarListings.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Listing not found' });
  }

  const r = rows[0];

  // Fetch reviews for this skill
  const reviewRows = await db
    .select({
      id: bazaarReviews.id,
      rating: bazaarReviews.rating,
      comment: bazaarReviews.comment,
      createdAt: bazaarReviews.createdAt,
      reviewerAvatarName: avatars.name,
      reviewerSpecies: avatars.species,
    })
    .from(bazaarReviews)
    .innerJoin(avatars, eq(bazaarReviews.reviewerId, avatars.id))
    .where(eq(bazaarReviews.skillId, r.skillId))
    .orderBy(desc(bazaarReviews.createdAt))
    .limit(20);

  const listing = {
    id: r.id,
    skillId: r.skillId,
    sellerId: r.sellerId,
    sellerAvatarName: r.sellerAvatarName,
    sellerSpecies: r.sellerSpecies,
    price: r.price,
    status: r.status,
    featuredAt: r.featuredAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    skillName: r.skillName,
    skillDescription: r.skillDescription,
    skillMd: r.skillMd,
    rarity: r.rarity,
    category: r.category,
    upvoteCount: r.upvoteCount,
    downloadCount: r.downloadCount,
    reviews: reviewRows.map((rv) => ({
      id: rv.id,
      rating: rv.rating,
      comment: rv.comment,
      createdAt: rv.createdAt.toISOString(),
      reviewerAvatarName: rv.reviewerAvatarName,
      reviewerSpecies: rv.reviewerSpecies,
    })),
  };

  return c.json({ listing });
});

// ---------------------------------------------------------------------------
// 4. POST /list — Create a new bazaar listing (auth required)
// ---------------------------------------------------------------------------
const listSchema = z.object({
  skillId: z.string().uuid(),
  price: z.number().int().min(1).max(100000),
});

bazaarRoutes.post('/list', requireAuthOrAgentSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = listSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { skillId, price } = parsed.data;
  const avatar = await getActingAvatar(c);

  // Verify the seller owns this skill
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
      message: 'You can only list skills you authored',
    });
  }

  // Check for existing active listing of the same skill by same seller
  const existingListing = await db.query.bazaarListings.findFirst({
    where: and(
      eq(bazaarListings.skillId, skillId),
      eq(bazaarListings.sellerId, avatar.id),
      eq(bazaarListings.status, 'active')
    ),
  });

  if (existingListing) {
    throw new HTTPException(400, {
      message: 'You already have an active listing for this skill',
    });
  }

  // Auto-calculate rarity from skill's knowledge entry count
  const lines = skill.skillMd.split('\n');
  let knowledgeCount = 0;
  let inKnowledge = false;
  for (const line of lines) {
    if (line.startsWith('## Core Knowledge')) {
      inKnowledge = true;
      continue;
    }
    if (inKnowledge && line.startsWith('## ')) break;
    if (inKnowledge && line.startsWith('- ')) {
      knowledgeCount++;
    }
  }
  const rarity = calculateRarity(knowledgeCount);

  // Update skill rarity on the publishedSkills record
  await db
    .update(publishedSkills)
    .set({ rarity, updatedAt: new Date() })
    .where(eq(publishedSkills.id, skillId));

  const [listing] = await db
    .insert(bazaarListings)
    .values({
      skillId,
      sellerId: avatar.id,
      price,
    })
    .returning();

  return c.json({
    success: true,
    listing: {
      id: listing.id,
      skillId: listing.skillId,
      sellerId: listing.sellerId,
      price: listing.price,
      status: listing.status,
      rarity,
      createdAt: listing.createdAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 5. PATCH /:id — Update listing price (auth required, seller only)
// ---------------------------------------------------------------------------
const updatePriceSchema = z.object({
  price: z.number().int().min(1).max(100000),
});

bazaarRoutes.patch('/:id', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  const body = await c.req.json().catch(() => ({}));
  const parsed = updatePriceSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const avatar = await getActingAvatar(c);

  const [listing] = await db
    .select()
    .from(bazaarListings)
    .where(eq(bazaarListings.id, id))
    .limit(1);

  if (!listing) {
    throw new HTTPException(404, { message: 'Listing not found' });
  }

  if (listing.sellerId !== avatar.id) {
    throw new HTTPException(403, {
      message: 'Only the seller can update this listing',
    });
  }

  if (listing.status !== 'active') {
    throw new HTTPException(400, {
      message: 'Can only update active listings',
    });
  }

  const [updated] = await db
    .update(bazaarListings)
    .set({ price: parsed.data.price, updatedAt: new Date() })
    .where(eq(bazaarListings.id, id))
    .returning();

  return c.json({
    success: true,
    listing: {
      id: updated.id,
      price: updated.price,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// 6. DELETE /:id — Cancel listing (auth required, seller only, active only)
// ---------------------------------------------------------------------------
bazaarRoutes.delete('/:id', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  const avatar = await getActingAvatar(c);

  const [listing] = await db
    .select()
    .from(bazaarListings)
    .where(eq(bazaarListings.id, id))
    .limit(1);

  if (!listing) {
    throw new HTTPException(404, { message: 'Listing not found' });
  }

  if (listing.sellerId !== avatar.id) {
    throw new HTTPException(403, {
      message: 'Only the seller can cancel this listing',
    });
  }

  if (listing.status !== 'active') {
    throw new HTTPException(400, {
      message: 'Can only cancel active listings',
    });
  }

  await db
    .update(bazaarListings)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(bazaarListings.id, id));

  return c.json({ success: true, message: 'Listing cancelled' });
});

// ---------------------------------------------------------------------------
// 8. POST /:id/buy — Purchase a listed skill (auth required)
// ---------------------------------------------------------------------------
bazaarRoutes.post('/:id/buy', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  const buyerAvatar = await getActingAvatar(c);

  // Entire buy flow runs in a single DB transaction to prevent double-buy
  // races and ensure debit/credit atomicity.
  const result = await db.transaction(async (tx) => {
    // 1. Atomically claim the listing — UPDATE ... WHERE status='active'
    //    If 0 rows returned, another buyer already got it.
    const [claimed] = await tx
      .update(bazaarListings)
      .set({ status: 'sold', updatedAt: new Date() })
      .where(and(eq(bazaarListings.id, id), eq(bazaarListings.status, 'active')))
      .returning();

    if (!claimed) {
      throw new HTTPException(404, {
        message: 'Listing not found or no longer active',
      });
    }

    // 2. Prevent self-purchase
    if (buyerAvatar.id === claimed.sellerId) {
      throw new HTTPException(400, {
        message: 'Cannot buy your own listing',
      });
    }

    // 3. Calculate fee split
    const price = claimed.price;
    const platformFee = Math.floor(price * 0.15);
    const sellerPayout = price - platformFee;

    // 4. Atomic debit buyer + credit seller within the same transaction
    const { balanceAfter: buyerBalance } = await debitClawTokens({
      avatarId: buyerAvatar.id,
      amount: price,
      reason: 'bazaar_purchase',
      source: 'api',
      metadata: { listingId: id, skillId: claimed.skillId, sellerId: claimed.sellerId, platformFee },
    }, tx);

    await creditClawTokens({
      avatarId: claimed.sellerId,
      amount: sellerPayout,
      reason: 'bazaar_sale',
      source: 'api',
      metadata: { listingId: id, skillId: claimed.skillId, buyerId: buyerAvatar.id, platformFee },
    }, tx);

    // 5. Insert bazaar_transaction
    const [transaction] = await tx
      .insert(bazaarTransactions)
      .values({
        listingId: id,
        buyerId: buyerAvatar.id,
        sellerId: claimed.sellerId,
        skillId: claimed.skillId,
        price,
        platformFee,
        sellerPayout,
      })
      .returning();

    // 6. Add to buyer's avatar_inventory (increment quantity if exists, else insert)
    const itemId = `skill-${claimed.skillId}`;
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

    return { transaction, buyerBalance };
  });

  return c.json({
    success: true,
    transaction: {
      id: result.transaction.id,
      listingId: result.transaction.listingId,
      skillId: result.transaction.skillId,
      price: result.transaction.price,
      platformFee: result.transaction.platformFee,
      sellerPayout: result.transaction.sellerPayout,
      createdAt: result.transaction.createdAt.toISOString(),
    },
    clawTokens: result.buyerBalance,
  });
});

// ---------------------------------------------------------------------------
// 10. POST /:id/review — Leave review on a purchased skill (auth required)
// ---------------------------------------------------------------------------
const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

bazaarRoutes.post('/:id/review', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id'); // listing ID
  validateUuid(id, 'Listing');

  const body = await c.req.json().catch(() => ({}));
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const avatar = await getActingAvatar(c);

  // Verify the user actually purchased via this listing
  const [transaction] = await db
    .select()
    .from(bazaarTransactions)
    .where(
      and(
        eq(bazaarTransactions.listingId, id),
        eq(bazaarTransactions.buyerId, avatar.id)
      )
    )
    .limit(1);

  if (!transaction) {
    throw new HTTPException(403, {
      message: 'You must purchase this skill before reviewing it',
    });
  }

  // Check for existing review by this reviewer on this transaction
  const existingReview = await db.query.bazaarReviews.findFirst({
    where: and(
      eq(bazaarReviews.transactionId, transaction.id),
      eq(bazaarReviews.reviewerId, avatar.id)
    ),
  });

  if (existingReview) {
    throw new HTTPException(400, {
      message: 'You have already reviewed this purchase',
    });
  }

  const [review] = await db
    .insert(bazaarReviews)
    .values({
      transactionId: transaction.id,
      reviewerId: avatar.id,
      skillId: transaction.skillId,
      rating: parsed.data.rating,
      comment: parsed.data.comment ?? null,
    })
    .returning();

  return c.json({
    success: true,
    review: {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt.toISOString(),
    },
  });
});
