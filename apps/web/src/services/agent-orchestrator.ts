import { db, agents, eq, and } from '@clawville/database';
import {
  ElizaRuntime,
  createElizaRuntime,
} from '@clawville/agent-runtime';
import type { AgentStatus } from '@clawville/shared';

interface RunningAgent {
  runtime: ElizaRuntime;
  startedAt: Date;
  lastHeartbeat: Date;
  lastActivity: Date;
  heartbeatIntervalId?: ReturnType<typeof setInterval>;
}

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class AgentOrchestrator {
  private runningAgents: Map<string, RunningAgent> = new Map();
  private inactivityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private recoveryInProgress: Set<string> = new Set();

  constructor() {
    // Check for inactive agents every 5 minutes
    if (typeof setInterval !== 'undefined') {
      this.inactivityCheckInterval = setInterval(() => {
        this.stopInactiveAgents().catch(console.error);
      }, 5 * 60 * 1000);
    }
  }

  /**
   * Ensure an agent runtime is available (lazy-start).
   * Starts the runtime on first chat message, not on config save.
   */
  async ensureAgentRuntime(agentId: string, userId: string): Promise<ElizaRuntime | null> {
    // Check if already running
    const existing = this.runningAgents.get(agentId);
    if (existing) {
      existing.lastActivity = new Date();
      return existing.runtime;
    }

    // Prevent concurrent startup
    if (this.recoveryInProgress.has(agentId)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const recovered = this.runningAgents.get(agentId);
      return recovered?.runtime ?? null;
    }

    // Verify agent exists
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.userId, userId)),
    });

    if (!agent) return null;

    // Lazy-start the agent
    console.log(`[Orchestrator] Lazy-starting agent ${agentId}`);
    this.recoveryInProgress.add(agentId);

    try {
      if (agent.status !== 'stopped' && agent.status !== 'pending') {
        await this.updateAgentStatus(agentId, 'stopped');
      }
      await this.startAgent(agentId, userId);
      const running = this.runningAgents.get(agentId);
      return running?.runtime ?? null;
    } catch (error) {
      console.error(`[Orchestrator] Failed to start agent ${agentId}:`, error);
      await this.updateAgentStatus(agentId, 'error');
      return null;
    } finally {
      this.recoveryInProgress.delete(agentId);
    }
  }

  async startAgent(agentId: string, userId: string): Promise<void> {
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.userId, userId)),
    });

    if (!agent) throw new Error('Agent not found');
    if (agent.status === 'running') throw new Error('Agent is already running');

    await this.updateAgentStatus(agentId, 'starting');

    try {
      const customization = (agent.customization as Record<string, unknown>) ?? {};
      const isAvatarAgent = agent.type === 'avatar-agent';

      const runtime: ElizaRuntime = createElizaRuntime({
        agentId,
        agentType: isAvatarAgent ? 'avatar-agent' : 'location-agent',
        customization: {
          name: agent.name,
          personality: customization.personality as string | undefined,
          bio: customization.bio as string | undefined,
          greeting: customization.greeting as string | undefined,
          rules: customization.rules as string[] | undefined,
          tone: customization.tone as 'formal' | 'casual' | 'friendly' | 'professional' | undefined,
          topics: customization.topics as string[] | undefined,
          style: customization.style as string[] | undefined,
        },
        agentConfig: (agent.config as Record<string, unknown>) ?? {},
        databaseUrl: process.env.DATABASE_URL,
        apiKeys: {
          // OpenAI backs BOTH text generation (openai-text-provider) and
          // embeddings (openai-embedding-provider, text-embedding-3-small, 1536-dim).
          openai: process.env.OPENAI_API_KEY,
        },
      });

      await runtime.start();

      const heartbeatIntervalId = setInterval(() => {
        const ra = this.runningAgents.get(agentId);
        if (ra) ra.lastHeartbeat = new Date();
      }, 30000);

      this.runningAgents.set(agentId, {
        runtime,
        startedAt: new Date(),
        lastHeartbeat: new Date(),
        lastActivity: new Date(),
        heartbeatIntervalId,
      });

      await this.updateAgentStatus(agentId, 'running');
      console.log(`[Orchestrator] Agent ${agentId} started`);
    } catch (error) {
      await this.updateAgentStatus(agentId, 'error');
      throw error;
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    const running = this.runningAgents.get(agentId);
    if (running) {
      if (running.heartbeatIntervalId) clearInterval(running.heartbeatIntervalId);
      await running.runtime.stop();
      this.runningAgents.delete(agentId);
    }
    await this.updateAgentStatus(agentId, 'stopped');
    console.log(`[Orchestrator] Agent ${agentId} stopped`);
  }

  getRunningAgentRuntime(agentId: string): ElizaRuntime | null {
    const running = this.runningAgents.get(agentId);
    if (running) running.lastActivity = new Date();
    return running?.runtime ?? null;
  }

  private async stopInactiveAgents(): Promise<void> {
    const now = Date.now();
    for (const [agentId, agent] of this.runningAgents) {
      if (now - agent.lastActivity.getTime() > INACTIVITY_TIMEOUT_MS) {
        console.log(`[Orchestrator] Stopping inactive agent ${agentId}`);
        await this.stopAgent(agentId);
      }
    }
  }

  private async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    await db
      .update(agents)
      .set({ status, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
  }

  async shutdown(): Promise<void> {
    if (this.inactivityCheckInterval) clearInterval(this.inactivityCheckInterval);
    for (const [agentId, agent] of this.runningAgents) {
      try {
        if (agent.heartbeatIntervalId) clearInterval(agent.heartbeatIntervalId);
        await agent.runtime.stop();
        await this.updateAgentStatus(agentId, 'stopped');
      } catch (error) {
        console.error(`Error stopping agent ${agentId}:`, error);
      }
    }
    this.runningAgents.clear();
  }
}

export const agentOrchestrator = new AgentOrchestrator();
