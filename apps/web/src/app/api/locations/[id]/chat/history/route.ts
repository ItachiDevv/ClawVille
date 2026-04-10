import { NextRequest } from 'next/server';
import { db, locationAgents, eq, and } from '@clawville/database';
import { json, error, requireAuth } from '@/lib/api-utils';
import { agentOrchestrator } from '@/services/agent-orchestrator';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult;

    const { id: locationId } = await params;

    const locationAgent = await db.query.locationAgents.findFirst({
      where: and(
        eq(locationAgents.userId, user.id),
        eq(locationAgents.locationId, locationId)
      ),
    });

    if (!locationAgent || !locationAgent.platformAgentId) {
      return json({ messages: [] });
    }

    // Get history from agent runtime if available
    const runtime = agentOrchestrator.getRunningAgentRuntime(locationAgent.platformAgentId);

    if (!runtime) {
      return json({ messages: [] });
    }

    // For now, return empty - history is loaded from ElizaOS memories
    // which the runtime handles internally
    return json({ messages: [] });
  } catch (err) {
    console.error('Get chat history error:', err);
    return error('Internal server error', 500);
  }
}
