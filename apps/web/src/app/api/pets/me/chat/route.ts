import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, pets, eq } from '@legacyapp/database';
import { json, error, requireAuth } from '@/lib/api-utils';
import { agentOrchestrator } from '@/services/agent-orchestrator';

const petChatSchema = z.object({
  content: z.string().min(1).max(4000),
});

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const body = await request.json();
    const result = petChatSchema.safeParse(body);

    if (!result.success) {
      return error('Message must be 1-4000 characters', 400);
    }

    // Get user's pet
    const pet = await db.query.pets.findFirst({
      where: eq(pets.userId, user.id),
    });

    if (!pet) {
      return error('You do not have a pet yet', 404);
    }

    if (!pet.platformAgentId) {
      return error('Pet does not have an agent configured', 400);
    }

    // Ensure agent runtime is running (lazy-start)
    const runtime = await agentOrchestrator.ensureAgentRuntime(
      pet.platformAgentId,
      user.id
    );

    if (!runtime) {
      return error('Failed to start pet agent runtime', 500);
    }

    // Process message
    const response = await runtime.processMessage(result.data.content, {
      userId: user.id,
      roomId: `pet-${pet.id}-${user.id}`,
      platform: 'legacyapp',
    });

    return json({
      message: {
        role: 'assistant' as const,
        content: response.content,
        timestamp: response.timestamp.toISOString(),
      },
    });
  } catch (err) {
    console.error('Pet chat error:', err);
    return error('Internal server error', 500);
  }
}
