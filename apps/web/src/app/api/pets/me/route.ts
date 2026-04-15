import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, pets, eq, and } from '@clawville/database';
import { json, error, requireAuth } from '@/lib/api-utils';

export async function GET() {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const pet = await db.query.pets.findFirst({
      where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
    });

    return json({ pet: pet ?? null });
  } catch (err) {
    console.error('Get pet error:', err);
    return error('Internal server error', 500);
  }
}

const updatePositionSchema = z.object({
  positionX: z.number().int().min(0).max(5120),
  positionY: z.number().int().min(0).max(5120),
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
      .update(pets)
      .set({
        positionX: result.data.positionX,
        positionY: result.data.positionY,
        updatedAt: new Date(),
      })
      .where(and(eq(pets.userId, user.id), eq(pets.isActive, true)))
      .returning();

    if (!updated) {
      return error('Pet not found', 404);
    }

    return json({ pet: updated });
  } catch (err) {
    console.error('Update pet error:', err);
    return error('Internal server error', 500);
  }
}
