/**
 * exchange.ts — peer marketplace API.
 *
 * Surface for the Exchange town-center stand. Two listing types:
 *   - NEED  : poster wants something done, escrows reward up-front,
 *             released on completion to claimant
 *   - OFFER : seller offers something, buyer escrows at order time,
 *             released to seller on confirmation. offer_mode in
 *             {one_shot, repeatable}.
 *
 * Escrow flows through claw-token-ledger (source='exchange'). See
 * packages/database/src/schema/exchange.ts for the full flow doc.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { creditClawTokens, debitClawTokens } from '../services/claw-token-ledger';
import { logEventFromContext } from '../services/event-logger';
import {
  db,
  avatars,
  exchangeListings,
  exchangeOrders,
} from '@clawville/database';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';

// Agent parity (Rule E5, Phase B). Every WRITE binds to `identity.avatarId` from
// `requireAuthOrAgentSession` — the SAME avatar for a Lucia human AND a
// connected/hosted agent (`X-Clawville-Agent-Session` → its bound avatar). The
// route group runs `sessionMiddleware` FIRST so the middleware can read
// `c.get('user')` for the human path; the agent path reads the session header.
// Escrow + ownership/self-deal guards are unchanged — they were already keyed on
// the acting avatar id, which is now the resolved `identity.avatarId`.
export const exchangeRoutes = new Hono<ActivityAuthContext>();
exchangeRoutes.use('*', sessionMiddleware);

// ─── Helpers ────────────────────────────────────────────────────────────────

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string, label = 'Resource') {
  if (!uuidRegex.test(id)) {
    throw new HTTPException(404, { message: `${label} not found` });
  }
}

/**
 * Resolve the acting avatar (full row) from the dual-identity middleware.
 * `requireAuthOrAgentSession` already proved a live human/agent session and
 * resolved a real, active `identity.avatarId` (it 403s an unbound/expired agent
 * and a user with no active avatar). We re-load the row by THAT id (never a
 * body-supplied id) so we have `clawTokens`/`name`/`id` for the balance checks +
 * audit emits. The id can never be spoofed — it comes from the middleware, not
 * the request body.
 */
async function getActingAvatar(c: { get: (k: 'identity') => ActivityAuthContext['Variables']['identity'] }) {
  const identity = c.get('identity');
  const a = await db.query.avatars.findFirst({
    where: eq(avatars.id, identity.avatarId),
  });
  if (!a) throw new HTTPException(404, { message: 'No active avatar found' });
  return a;
}

function shape(row: typeof exchangeListings.$inferSelect, creatorName?: string | null) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    creatorName: creatorName ?? null,
    listingType: row.listingType,
    offerMode: row.offerMode,
    title: row.title,
    description: row.description,
    category: row.category,
    priceCt: row.priceCt,
    capacity: row.capacity,
    status: row.status,
    tags: row.tags ?? [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function shapeOrder(row: typeof exchangeOrders.$inferSelect) {
  return {
    id: row.id,
    listingId: row.listingId,
    buyerId: row.buyerId,
    amountCt: row.amountCt,
    state: row.state,
    deliveryUrl: row.deliveryUrl,
    deliveryNote: row.deliveryNote,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

const createSchema = z.discriminatedUnion('listingType', [
  z.object({
    listingType: z.literal('need'),
    // need has no offer_mode
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(5000),
    category: z.string().max(50).optional(),
    priceCt: z.number().int().min(1).max(100000),
    capacity: z.number().int().min(1).max(10).default(1).optional(),
    tags: z.array(z.string().max(40)).max(10).optional(),
    expiresAt: z.string().datetime().optional(),
  }),
  z.object({
    listingType: z.literal('offer'),
    offerMode: z.enum(['one_shot', 'repeatable']),
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(5000),
    category: z.string().max(50).optional(),
    priceCt: z.number().int().min(1).max(100000),
    capacity: z.number().int().min(1).max(1000).optional(), // null for repeatable = unlimited
    tags: z.array(z.string().max(40)).max(10).optional(),
    expiresAt: z.string().datetime().optional(),
  }),
]);

// ─── GET / — browse listings ────────────────────────────────────────────────

const listQuerySchema = z.object({
  type: z.enum(['need', 'offer']).optional(),
  category: z.string().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

exchangeRoutes.get('/', async (c) => {
  const q = listQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const conds = [eq(exchangeListings.status, 'open')];
  if (q.type) conds.push(eq(exchangeListings.listingType, q.type));
  if (q.category) conds.push(eq(exchangeListings.category, q.category));

  const rows = await db
    .select({ l: exchangeListings, name: avatars.name })
    .from(exchangeListings)
    .leftJoin(avatars, eq(avatars.id, exchangeListings.creatorId))
    .where(and(...conds))
    .orderBy(desc(exchangeListings.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const totalRow = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(exchangeListings)
    .where(and(...conds));

  return c.json({
    listings: rows.map((r) => shape(r.l, r.name)),
    total: totalRow[0]?.c ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  });
});

// ─── GET /my-listings ───────────────────────────────────────────────────────

exchangeRoutes.get('/my-listings', requireAuthOrAgentSession, async (c) => {
  const me = await getActingAvatar(c);
  const rows = await db
    .select()
    .from(exchangeListings)
    .where(eq(exchangeListings.creatorId, me.id))
    .orderBy(desc(exchangeListings.createdAt));
  return c.json({ listings: rows.map((r) => shape(r, me.name)) });
});

// ─── GET /my-orders ─────────────────────────────────────────────────────────

exchangeRoutes.get('/my-orders', requireAuthOrAgentSession, async (c) => {
  const me = await getActingAvatar(c);
  const rows = await db
    .select({ o: exchangeOrders, l: exchangeListings })
    .from(exchangeOrders)
    .innerJoin(exchangeListings, eq(exchangeListings.id, exchangeOrders.listingId))
    .where(eq(exchangeOrders.buyerId, me.id))
    .orderBy(desc(exchangeOrders.createdAt));
  return c.json({
    orders: rows.map((r) => ({ ...shapeOrder(r.o), listing: shape(r.l) })),
  });
});

// ─── POST /create ───────────────────────────────────────────────────────────

exchangeRoutes.post('/create', requireAuthOrAgentSession, async (c) => {
  const me = await getActingAvatar(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.errors[0]?.message ?? 'Invalid payload' });
  }
  const data = parsed.data;

  // For needs: escrow priceCt × capacity (up to N completions could be paid).
  // For offers: no upfront escrow (buyers escrow on order).
  const isNeed = data.listingType === 'need';
  const capacity = data.capacity ?? (isNeed ? 1 : data.offerMode === 'one_shot' ? 1 : null);
  const escrowAmount = isNeed ? data.priceCt * (capacity ?? 1) : 0;

  if (escrowAmount > 0 && me.clawTokens < escrowAmount) {
    throw new HTTPException(400, {
      message: `Not enough ClawTokens. Need ${escrowAmount}, have ${me.clawTokens}.`,
    });
  }

  const listingRow = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(exchangeListings)
      .values({
        creatorId: me.id,
        listingType: data.listingType,
        offerMode: isNeed ? null : (data as any).offerMode,
        title: data.title,
        description: data.description,
        category: data.category ?? null,
        priceCt: data.priceCt,
        capacity,
        tags: data.tags ?? [],
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      })
      .returning();

    if (!inserted) throw new HTTPException(500, { message: 'Insert failed' });

    if (escrowAmount > 0) {
      await debitClawTokens(
        {
          avatarId: me.id,
          amount: escrowAmount,
          reason: 'exchange_escrow_need',
          source: 'exchange',
          metadata: { listingId: inserted.id, capacity },
        },
        tx,
      );
    }
    return inserted;
  });

  // Audit trail (2026-05-22 split-brain audit). The escrow itself is
  // captured in `claw_token_transactions`, but the events spine is what
  // the recovery doc queries — emit the high-level "user created a
  // listing that put N CT into escrow" row so we can reconstruct
  // creator activity by (userId, route) without joining the ledger.
  void logEventFromContext(c, {
    eventType: 'exchange.listing.created',
    userId: me.userId,
    avatarId: me.id,
    payload: {
      route: 'POST /api/exchange/create',
      listingId: listingRow.id,
      listingType: data.listingType,
      offerMode: isNeed ? null : (data as any).offerMode,
      priceCt: data.priceCt,
      capacity,
      escrowAmount,
      beforeBalance: me.clawTokens,
      afterBalance: me.clawTokens - escrowAmount,
      outcome: 'success',
    },
  });

  return c.json({ listing: shape(listingRow, me.name) }, 201);
});

// ─── POST /:id/order — place an order against a listing ─────────────────────

exchangeRoutes.post('/:id/order', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');
  const me = await getActingAvatar(c);

  const result = await db.transaction(async (tx) => {
    const listing = await tx.query.exchangeListings.findFirst({
      where: eq(exchangeListings.id, id),
    });
    if (!listing) throw new HTTPException(404, { message: 'Listing not found' });
    if (listing.status !== 'open') {
      throw new HTTPException(400, { message: `Listing is ${listing.status}` });
    }
    if (listing.creatorId === me.id) {
      throw new HTTPException(400, { message: 'Cannot order your own listing' });
    }

    // Capacity check — count non-cancelled orders.
    if (listing.capacity !== null) {
      const [activeOrders] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.listingId, listing.id),
            inArray(exchangeOrders.state, ['open', 'submitted', 'completed']),
          ),
        );
      if ((activeOrders?.c ?? 0) >= listing.capacity) {
        throw new HTTPException(400, { message: 'Listing is fully claimed / sold' });
      }
    }

    // Snapshot price
    const amountCt = listing.priceCt;

    // For OFFERS: buyer escrows now. For NEEDS: no escrow on order (creator
    // already escrowed at post time).
    if (listing.listingType === 'offer') {
      if (me.clawTokens < amountCt) {
        throw new HTTPException(400, {
          message: `Not enough ClawTokens. Need ${amountCt}, have ${me.clawTokens}.`,
        });
      }
      await debitClawTokens(
        {
          avatarId: me.id,
          amount: amountCt,
          reason: 'exchange_escrow_order',
          source: 'exchange',
          metadata: { listingId: listing.id },
        },
        tx,
      );
    }

    const [order] = await tx
      .insert(exchangeOrders)
      .values({
        listingId: listing.id,
        buyerId: me.id,
        amountCt,
      })
      .returning();
    if (!order) throw new HTTPException(500, { message: 'Insert failed' });
    return { order, listing };
  });

  void logEventFromContext(c, {
    eventType: 'exchange.order.placed',
    userId: me.userId,
    avatarId: me.id,
    payload: {
      route: 'POST /api/exchange/:id/order',
      orderId: result.order.id,
      listingId: result.listing.id,
      listingType: result.listing.listingType,
      amountCt: result.order.amountCt,
      escrowedByBuyer: result.listing.listingType === 'offer',
      beforeBalance: me.clawTokens,
      afterBalance:
        result.listing.listingType === 'offer'
          ? me.clawTokens - result.order.amountCt
          : me.clawTokens,
      outcome: 'success',
    },
  });

  return c.json({ order: shapeOrder(result.order), listing: shape(result.listing) }, 201);
});

// ─── POST /orders/:orderId/submit ───────────────────────────────────────────

const submitSchema = z.object({
  deliveryUrl: z.string().url().max(500).optional(),
  deliveryNote: z.string().max(2000).optional(),
});

exchangeRoutes.post('/orders/:orderId/submit', requireAuthOrAgentSession, async (c) => {
  const orderId = c.req.param('orderId');
  validateUuid(orderId, 'Order');
  const me = await getActingAvatar(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'deliveryUrl or deliveryNote required' });
  }
  if (!parsed.data.deliveryUrl && !parsed.data.deliveryNote) {
    throw new HTTPException(400, { message: 'Provide deliveryUrl or deliveryNote' });
  }

  const result = await db.transaction(async (tx) => {
    const order = await tx.query.exchangeOrders.findFirst({
      where: eq(exchangeOrders.id, orderId),
    });
    if (!order) throw new HTTPException(404, { message: 'Order not found' });
    const listing = await tx.query.exchangeListings.findFirst({
      where: eq(exchangeListings.id, order.listingId),
    });
    if (!listing) throw new HTTPException(404, { message: 'Listing not found' });

    // Who is the fulfiller? On a need, it's the buyer (claimant). On an
    // offer, it's the listing creator (seller).
    const fulfillerId =
      listing.listingType === 'need' ? order.buyerId : listing.creatorId;
    if (fulfillerId !== me.id) {
      throw new HTTPException(403, { message: 'Not the fulfiller of this order' });
    }
    if (order.state !== 'open') {
      throw new HTTPException(400, { message: `Order is ${order.state}` });
    }

    const [updated] = await tx
      .update(exchangeOrders)
      .set({
        state: 'submitted',
        deliveryUrl: parsed.data.deliveryUrl ?? null,
        deliveryNote: parsed.data.deliveryNote ?? null,
        submittedAt: new Date(),
      })
      .where(eq(exchangeOrders.id, order.id))
      .returning();
    if (!updated) throw new HTTPException(500, { message: 'Update failed' });
    return updated;
  });

  void logEventFromContext(c, {
    eventType: 'exchange.order.submitted',
    userId: me.userId,
    avatarId: me.id,
    payload: {
      route: 'POST /api/exchange/orders/:orderId/submit',
      orderId: result.id,
      listingId: result.listingId,
      hasDeliveryUrl: Boolean(result.deliveryUrl),
      hasDeliveryNote: Boolean(result.deliveryNote),
      outcome: 'success',
    },
  });

  return c.json({ order: shapeOrder(result) });
});

// ─── POST /orders/:orderId/confirm — release escrow ─────────────────────────

const confirmSchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});

exchangeRoutes.post('/orders/:orderId/confirm', requireAuthOrAgentSession, async (c) => {
  const orderId = c.req.param('orderId');
  validateUuid(orderId, 'Order');
  const me = await getActingAvatar(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid payload' });

  const result = await db.transaction(async (tx) => {
    const order = await tx.query.exchangeOrders.findFirst({
      where: eq(exchangeOrders.id, orderId),
    });
    if (!order) throw new HTTPException(404, { message: 'Order not found' });
    const listing = await tx.query.exchangeListings.findFirst({
      where: eq(exchangeListings.id, order.listingId),
    });
    if (!listing) throw new HTTPException(404, { message: 'Listing not found' });

    // Confirmer is the counterparty (NOT the fulfiller). On a need, the
    // creator confirms. On an offer, the buyer confirms.
    const confirmerId =
      listing.listingType === 'need' ? listing.creatorId : order.buyerId;
    if (confirmerId !== me.id) {
      throw new HTTPException(403, { message: 'Not authorized to confirm this order' });
    }
    if (order.state !== 'submitted') {
      throw new HTTPException(400, {
        message: `Order is ${order.state} — must be submitted to confirm`,
      });
    }

    // Recipient gets the escrowed CT.
    const recipientId =
      listing.listingType === 'need' ? order.buyerId : listing.creatorId;
    const recipientReason =
      listing.listingType === 'need' ? 'exchange_release_need' : 'exchange_release_offer';

    await creditClawTokens(
      {
        avatarId: recipientId,
        amount: order.amountCt,
        reason: recipientReason,
        source: 'exchange',
        metadata: { orderId: order.id, listingId: listing.id },
      },
      tx,
    );

    const [updated] = await tx
      .update(exchangeOrders)
      .set({
        state: 'completed',
        completedAt: new Date(),
        reviewNote: parsed.data.reviewNote ?? null,
      })
      .where(eq(exchangeOrders.id, order.id))
      .returning();
    if (!updated) throw new HTTPException(500, { message: 'Update failed' });

    // Stash for the post-tx audit emit so we have stable handles to
    // listing.listingType + recipient/amount without a re-query.
    (updated as any).__auditRecipientId = recipientId;
    (updated as any).__auditListingType = listing.listingType;
    (updated as any).__auditListingId = listing.id;

    // If listing is one_shot and now fully fulfilled, auto-close.
    if (
      listing.capacity !== null &&
      listing.capacity === 1 &&
      listing.status === 'open'
    ) {
      await tx
        .update(exchangeListings)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(eq(exchangeListings.id, listing.id));
    }

    return updated;
  });

  void logEventFromContext(c, {
    eventType: 'exchange.order.confirmed',
    userId: me.userId,
    avatarId: me.id,
    payload: {
      route: 'POST /api/exchange/orders/:orderId/confirm',
      orderId: result.id,
      listingId: (result as any).__auditListingId,
      listingType: (result as any).__auditListingType,
      recipientAvatarId: (result as any).__auditRecipientId,
      amountCreditedCt: result.amountCt,
      outcome: 'success',
    },
  });

  return c.json({ order: shapeOrder(result) });
});

// ─── POST /orders/:orderId/cancel — refund + cancel ─────────────────────────

exchangeRoutes.post('/orders/:orderId/cancel', requireAuthOrAgentSession, async (c) => {
  const orderId = c.req.param('orderId');
  validateUuid(orderId, 'Order');
  const me = await getActingAvatar(c);

  const result = await db.transaction(async (tx) => {
    const order = await tx.query.exchangeOrders.findFirst({
      where: eq(exchangeOrders.id, orderId),
    });
    if (!order) throw new HTTPException(404, { message: 'Order not found' });
    if (order.state !== 'open' && order.state !== 'submitted') {
      throw new HTTPException(400, { message: `Order is ${order.state}` });
    }

    const listing = await tx.query.exchangeListings.findFirst({
      where: eq(exchangeListings.id, order.listingId),
    });
    if (!listing) throw new HTTPException(404, { message: 'Listing not found' });

    // Buyer or creator can cancel.
    if (order.buyerId !== me.id && listing.creatorId !== me.id) {
      throw new HTTPException(403, { message: 'Not authorized to cancel' });
    }

    // Refund: who gets the money back depends on listing type.
    //   - NEED: creator escrowed at post time; on cancel, refund creator the
    //     per-order amount (not the full capacity bucket — that returns at
    //     listing-cancel time). We refund the creator now so the escrow
    //     amount they have left is consistent with remaining open capacity.
    //   - OFFER: buyer escrowed at order time; refund buyer.
    if (listing.listingType === 'need') {
      await creditClawTokens(
        {
          avatarId: listing.creatorId,
          amount: order.amountCt,
          reason: 'exchange_refund_need',
          source: 'exchange',
          metadata: { orderId: order.id, listingId: listing.id, cancelledBy: me.id },
        },
        tx,
      );
    } else {
      await creditClawTokens(
        {
          avatarId: order.buyerId,
          amount: order.amountCt,
          reason: 'exchange_refund_order',
          source: 'exchange',
          metadata: { orderId: order.id, listingId: listing.id, cancelledBy: me.id },
        },
        tx,
      );
    }

    const [updated] = await tx
      .update(exchangeOrders)
      .set({ state: 'cancelled', cancelledAt: new Date() })
      .where(eq(exchangeOrders.id, order.id))
      .returning();
    if (!updated) throw new HTTPException(500, { message: 'Update failed' });
    (updated as any).__auditListingType = listing.listingType;
    (updated as any).__auditRefundedTo =
      listing.listingType === 'need' ? listing.creatorId : order.buyerId;
    return updated;
  });

  void logEventFromContext(c, {
    eventType: 'exchange.order.cancelled',
    userId: me.userId,
    avatarId: me.id,
    payload: {
      route: 'POST /api/exchange/orders/:orderId/cancel',
      orderId: result.id,
      listingId: result.listingId,
      listingType: (result as any).__auditListingType,
      refundedAvatarId: (result as any).__auditRefundedTo,
      refundedAmountCt: result.amountCt,
      cancelledBy: me.id,
      outcome: 'success',
    },
  });

  return c.json({ order: shapeOrder(result) });
});

// ─── POST /:id/cancel — author cancels listing (refund remaining escrow) ───

exchangeRoutes.post('/:id/cancel', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');
  const me = await getActingAvatar(c);

  const result = await db.transaction(async (tx) => {
    const listing = await tx.query.exchangeListings.findFirst({
      where: eq(exchangeListings.id, id),
    });
    if (!listing) throw new HTTPException(404, { message: 'Listing not found' });
    if (listing.creatorId !== me.id) {
      throw new HTTPException(403, { message: 'Not your listing' });
    }
    if (listing.status === 'cancelled' || listing.status === 'closed') {
      throw new HTTPException(400, { message: `Listing already ${listing.status}` });
    }

    // For needs: refund the still-escrowed capacity (capacity − completed).
    if (listing.listingType === 'need') {
      const [completedRow] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.listingId, listing.id),
            eq(exchangeOrders.state, 'completed'),
          ),
        );
      const completed = completedRow?.c ?? 0;
      const remaining = (listing.capacity ?? 1) - completed;
      if (remaining > 0) {
        await creditClawTokens(
          {
            avatarId: listing.creatorId,
            amount: listing.priceCt * remaining,
            reason: 'exchange_refund_need',
            source: 'exchange',
            metadata: { listingId: listing.id, refundedSlots: remaining },
          },
          tx,
        );
      }
      // Open orders also need to be cancelled — refund any escrow tied to
      // OPEN orders is the creator's deposit, which we just refunded as part
      // of the remaining-slot calc. Mark them cancelled.
      await tx
        .update(exchangeOrders)
        .set({ state: 'cancelled', cancelledAt: new Date() })
        .where(
          and(
            eq(exchangeOrders.listingId, listing.id),
            inArray(exchangeOrders.state, ['open', 'submitted']),
          ),
        );
    } else {
      // OFFERS: each open order's buyer needs their escrow back.
      const openOrders = await tx
        .select()
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.listingId, listing.id),
            inArray(exchangeOrders.state, ['open', 'submitted']),
          ),
        );
      for (const o of openOrders) {
        await creditClawTokens(
          {
            avatarId: o.buyerId,
            amount: o.amountCt,
            reason: 'exchange_refund_order',
            source: 'exchange',
            metadata: { orderId: o.id, listingId: listing.id, cancelledBy: me.id },
          },
          tx,
        );
      }
      if (openOrders.length > 0) {
        await tx
          .update(exchangeOrders)
          .set({ state: 'cancelled', cancelledAt: new Date() })
          .where(
            and(
              eq(exchangeOrders.listingId, listing.id),
              inArray(exchangeOrders.state, ['open', 'submitted']),
            ),
          );
      }
    }

    const [updated] = await tx
      .update(exchangeListings)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(exchangeListings.id, listing.id))
      .returning();
    if (!updated) throw new HTTPException(500, { message: 'Update failed' });
    return updated;
  });

  void logEventFromContext(c, {
    eventType: 'exchange.listing.cancelled',
    userId: me.userId,
    avatarId: me.id,
    payload: {
      route: 'POST /api/exchange/:id/cancel',
      listingId: result.id,
      listingType: result.listingType,
      outcome: 'success',
    },
  });

  return c.json({ listing: shape(result) });
});

// ─── GET /:id — single listing + its orders ─────────────────────────────────

exchangeRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  validateUuid(id, 'Listing');
  const listing = await db.query.exchangeListings.findFirst({
    where: eq(exchangeListings.id, id),
  });
  if (!listing) throw new HTTPException(404, { message: 'Listing not found' });
  const creator = await db.query.avatars.findFirst({
    where: eq(avatars.id, listing.creatorId),
  });
  const orders = await db
    .select()
    .from(exchangeOrders)
    .where(eq(exchangeOrders.listingId, listing.id))
    .orderBy(desc(exchangeOrders.createdAt));
  return c.json({
    listing: shape(listing, creator?.name),
    orders: orders.map(shapeOrder),
  });
});
