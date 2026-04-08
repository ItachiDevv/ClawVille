import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, desc } from 'drizzle-orm';
import { db, avatars, activityLog } from '@legacyapp/database';
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
 * GET /api/avatars/me/activity?limit=20&offset=0
 * Returns recent activity log entries for the user's avatar.
 */
activityRoutes.get('/me/activity', requireAuth, async (c) => {
  const user = c.get('user');

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
  });

  if (!avatar) {
    throw new HTTPException(404, { message: 'Avatar not found' });
  }

  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid query parameters' });
  }
  const query = parsed.data;

  const entries = await db.query.activityLog.findMany({
    where: eq(activityLog.avatarId, avatar.id),
    orderBy: [desc(activityLog.createdAt)],
    limit: query.limit,
    offset: query.offset,
  });

  return c.json({ activities: entries });
});
