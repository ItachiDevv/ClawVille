import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, avatars, eq, and } from '@clawville/database';
import { json, error, requireAuth } from '@/lib/api-utils';

export async function GET() {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });

    return json({ avatar: avatar ?? null });
  } catch (err) {
    console.error('Get avatar error:', err);
    return error('Internal server error', 500);
  }
}

const updatePositionSchema = z.object({
  positionX: z.number().int().min(0),
  positionY: z.number().int().min(0),
});

export async function PATCH(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const body = await request.json();
    const result = updatePositionSchema.safeParse(body);

    if (!result.success) {
      return error('Invalid position', 400);
    }

    const [updated] = await db
      .update(avatars)
      .set({
        positionX: result.data.positionX,
        positionY: result.data.positionY,
        updatedAt: new Date(),
      })
      .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
      .returning();

    if (!updated) {
      return error('Avatar not found', 404);
    }

    return json({ avatar: updated });
  } catch (err) {
    console.error('Update avatar error:', err);
    return error('Internal server error', 500);
  }
}
