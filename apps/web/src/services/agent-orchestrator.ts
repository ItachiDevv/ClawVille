import { db, agents, eq } from '@legacyapp/database';
import type { AgentStatus } from '@legacyapp/shared';

// Stub implementation for Vercel serverless
// ElizaOS requires a persistent server and won't work in serverless functions
// For production chat, deploy the API separately on Railway/Render/Fly.io

interface ElizaRuntimeStub {
  processMessage: (content: string, context: any) => Promise<{ content: string; timestamp: Date }>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

class AgentOrchestrator {
  async ensureAgentRuntime(agentId: string, userId: string): Promise<ElizaRuntimeStub | null> {
    // Verify agent exists
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) return null;

    // Return stub that provides basic response
    return {
      async processMessage(content: string) {
        return {
          content: `*${agent.name} looks at you curiously* Chat functionality requires a dedicated server. Deploy the API separately for full chat support.`,
          timestamp: new Date(),
        };
      },
      async start() {},
      async stop() {},
    };
  }

  getRunningAgentRuntime(agentId: string): ElizaRuntimeStub | null {
    return null;
  }

  async shutdown(): Promise<void> {}
}

export const agentOrchestrator = new AgentOrchestrator();
