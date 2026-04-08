import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, avatars, eq, and } from '@legacyapp/database';
import { json, error, requireAuth } from '@/lib/api-utils';
import { agentOrchestrator } from '@/services/agent-orchestrator';

const avatarChatSchema = z.object({
  content: z.string().min(1).max(4000),
});

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const body = await request.json();
    const result = avatarChatSchema.safeParse(body);

    if (!result.success) {
      return error('Message must be 1-4000 characters', 400);
    }

    // Get user's active avatar
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });

    if (!avatar) {
      return error('You do not have a avatar yet', 404);
    }

    if (!avatar.platformAgentId) {
      return error('Avatar does not have an agent configured', 400);
    }

    // Ensure agent runtime is running (lazy-start)
    const runtime = await agentOrchestrator.ensureAgentRuntime(
      avatar.platformAgentId,
      user.id
    );

    if (!runtime) {
      return error('Failed to start avatar agent runtime', 500);
    }

    // Process message
    const response = await runtime.processMessage(result.data.content, {
      userId: user.id,
      roomId: `avatar-${avatar.id}-${user.id}`,
      platform: 'clawville',
    });

    return json({
      message: {
        role: 'assistant' as const,
        content: response.content,
        timestamp: response.timestamp.toISOString(),
      },
    });
  } catch (err) {
    console.error('Avatar chat error:', err);
    return error('Internal server error', 500);
  }
}
