import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import {
  db,
  avatars,
  publishedSkills,
  bazaarListings,
  bazaarTransactions,
  bazaarReviews,
  avatarInventory,
} from '@legacyapp/database';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { gte, lte, isNotNull, count, avg } from 'drizzle-orm';

export const bazaarRoutes = new Hono<AppContext>();
bazaarRoutes.use('*', sessionMiddleware);

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

async function getUserPet(userId: string) {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
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
bazaarRoutes.get('/my-listings', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const avatar = await getUserPet(user.id);

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
bazaarRoutes.get('/my-purchases', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const avatar = await getUserPet(user.id);

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
      reviewerPetName: avatars.name,
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
    reviewerPetName: r.reviewerPetName,
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
      reviewerPetName: avatars.name,
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
      reviewerPetName: rv.reviewerPetName,
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

bazaarRoutes.post('/list', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const body = await c.req.json();
  const parsed = listSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const { skillId, price } = parsed.data;
  const avatar = await getUserPet(user.id);

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

bazaarRoutes.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  const body = await c.req.json();
  const parsed = updatePriceSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const avatar = await getUserPet(user.id);

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
bazaarRoutes.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  const avatar = await getUserPet(user.id);

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
bazaarRoutes.post('/:id/buy', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  validateUuid(id, 'Listing');

  // 1. Find listing (active status)
  const [listing] = await db
    .select()
    .from(bazaarListings)
    .where(and(eq(bazaarListings.id, id), eq(bazaarListings.status, 'active')))
    .limit(1);

  if (!listing) {
    throw new HTTPException(404, {
      message: 'Listing not found or no longer active',
    });
  }

  // 2. Find buyer's avatar (check clawTokens >= price)
  const buyerPet = await getUserPet(user.id);

  if (buyerPet.clawTokens < listing.price) {
    throw new HTTPException(400, {
      message: `Not enough ClawTokens. Need ${listing.price}, have ${buyerPet.clawTokens}.`,
    });
  }

  // 3. Find seller's avatar
  const sellerPet = await db.query.avatars.findFirst({
    where: eq(avatars.id, listing.sellerId),
  });

  if (!sellerPet) {
    throw new HTTPException(500, { message: 'Seller avatar not found' });
  }

  // 4. Prevent self-purchase
  if (buyerPet.id === sellerPet.id) {
    throw new HTTPException(400, {
      message: 'Cannot buy your own listing',
    });
  }

  // 5. Calculate fee split
  const price = listing.price;
  const platformFee = Math.floor(price * 0.15);
  const sellerPayout = price - platformFee;

  // 6. Update buyer: clawTokens -= price
  const [updatedBuyer] = await db
    .update(avatars)
    .set({
      clawTokens: buyerPet.clawTokens - price,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, buyerPet.id))
    .returning();

  // 7. Update seller: clawTokens += sellerPayout
  await db
    .update(avatars)
    .set({
      clawTokens: sellerPet.clawTokens + sellerPayout,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, sellerPet.id));

  // 8. Update listing: status = 'sold'
  await db
    .update(bazaarListings)
    .set({ status: 'sold', updatedAt: new Date() })
    .where(eq(bazaarListings.id, id));

  // 9. Insert bazaar_transaction
  const [transaction] = await db
    .insert(bazaarTransactions)
    .values({
      listingId: id,
      buyerId: buyerPet.id,
      sellerId: sellerPet.id,
      skillId: listing.skillId,
      price,
      platformFee,
      sellerPayout,
    })
    .returning();

  // 10. Add to buyer's avatar_inventory (increment quantity if exists, else insert)
  const itemId = `skill-${listing.skillId}`;
  const existingItem = await db.query.avatarInventory.findFirst({
    where: and(
      eq(avatarInventory.avatarId, buyerPet.id),
      eq(avatarInventory.itemId, itemId)
    ),
  });

  if (existingItem) {
    await db
      .update(avatarInventory)
      .set({ quantity: existingItem.quantity + 1 })
      .where(eq(avatarInventory.id, existingItem.id));
  } else {
    await db.insert(avatarInventory).values({
      avatarId: buyerPet.id,
      itemId,
      quantity: 1,
    });
  }

  return c.json({
    success: true,
    transaction: {
      id: transaction.id,
      listingId: transaction.listingId,
      skillId: transaction.skillId,
      price: transaction.price,
      platformFee: transaction.platformFee,
      sellerPayout: transaction.sellerPayout,
      createdAt: transaction.createdAt.toISOString(),
    },
    clawTokens: updatedBuyer.clawTokens,
  });
});

// ---------------------------------------------------------------------------
// 10. POST /:id/review — Leave review on a purchased skill (auth required)
// ---------------------------------------------------------------------------
const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

bazaarRoutes.post('/:id/review', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id'); // listing ID
  validateUuid(id, 'Listing');

  const body = await c.req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        'Invalid request: ' +
        parsed.error.issues.map((i) => i.message).join(', '),
    });
  }

  const avatar = await getUserPet(user.id);

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
