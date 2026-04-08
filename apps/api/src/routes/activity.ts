import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, desc } from 'drizzle-orm';
import { db, pets, activityLog } from '@elizapets/database';
import { requireAuth } from '../middleware/auth';
import { sessionMiddleware } from '../middleware/auth';
import type { AppContext } from '../types';
import { z } from 'zod';

export const activityRoutes = new Hono<AppContext>();

activityRoutes.use('*', sessionMiddleware);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/pets/me/activity?limit=20&offset=0
 * Returns recent activity log entries for the user's pet.
 */
activityRoutes.get('/me/activity', requireAuth, async (c) => {
  const user = c.get('user');

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
  });

  if (!pet) {
    throw new HTTPException(404, { message: 'Pet not found' });
  }

  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid query parameters' });
  }
  const query = parsed.data;

  const entries = await db.query.activityLog.findMany({
    where: eq(activityLog.petId, pet.id),
    orderBy: [desc(activityLog.createdAt)],
    limit: query.limit,
    offset: query.offset,
  });

  return c.json({ activities: entries });
});
