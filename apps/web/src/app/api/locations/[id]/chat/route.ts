import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db, locationAgents, eq, and } from '@clawville/database';
import { json, error, requireAuth } from '@/lib/api-utils';
import { agentOrchestrator } from '@/services/agent-orchestrator';

const chatSchema = z.object({
  content: z.string().min(1).max(4000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const { id: locationId } = await params;
    const body = await request.json();
    const result = chatSchema.safeParse(body);

    if (!result.success) {
      return error('Message must be 1-4000 characters', 400);
    }

    // Find agent for this location
    const locationAgent = await db.query.locationAgents.findFirst({
      where: and(
        eq(locationAgents.userId, user.id),
        eq(locationAgents.locationId, locationId)
      ),
    });

    if (!locationAgent || !locationAgent.platformAgentId) {
      return error('No agent configured for this location', 404);
    }

    // Ensure agent runtime is running
    const runtime = await agentOrchestrator.ensureAgentRuntime(
      locationAgent.platformAgentId,
      user.id
    );

    if (!runtime) {
      return error('Failed to start agent runtime', 500);
    }

    // Process message
    const response = await runtime.processMessage(result.data.content, {
      userId: user.id,
      roomId: `${locationId}-${user.id}`,
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
    console.error('Location chat error:', err);
    return error('Internal server error', 500);
  }
}
