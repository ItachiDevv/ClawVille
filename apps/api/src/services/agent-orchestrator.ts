import { eq, and } from 'drizzle-orm';
import { db, agents, agentLogs, avatars, agentBots } from '@clawville/database';
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
  /**
   * Mirrors `platform_agents.type` at startup time. Used by
   * `stopInactiveAgents()` to skip system agents (Town Guide et al.) from
   * the 30-min sweep — they are boot-seeded singletons the world depends
   * on; stopping one on inactivity would 503 the next visitor until boot.
   */
  type?: string;
  /**
   * Agent-metaverse P1 — set true for a ClawVille-HOSTED "house" agent whose
   * runtime is warmed at boot and driven autonomously by agent-autonomy-driver.
   * Like a system agent, it must SURVIVE the 30-min inactivity sweep: the driver
   * only calls `useModel` (never routes through the chat path that bumps
   * `lastActivity`), so an active house agent would otherwise look idle and get
   * stopped out from under the driver. Kept as a separate signal from `type`
   * (house agents are `type:'openclaw-bot'`, not `'system-agent'`) so the two
   * lifecycles stay distinct.
   */
  isHouse?: boolean;
}

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class AgentOrchestrator {
  private runningAgents: Map<string, RunningAgent> = new Map();
  private inactivityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private recoveryInProgress: Set<string> = new Set();

  constructor() {
    // Check for inactive agents every 5 minutes
    this.inactivityCheckInterval = setInterval(() => {
      this.stopInactiveAgents().catch(console.error);
    }, 5 * 60 * 1000);
  }

  /**
   * Ensure an agent runtime is available (lazy-start).
   * Starts the runtime on first chat message, not on config save.
   */
  async ensureAgentRuntime(
    agentId: string,
    userId?: string,
    opts?: { isHouse?: boolean },
  ): Promise<ElizaRuntime | null> {
    // Check if already running
    const existing = this.runningAgents.get(agentId);
    if (existing) {
      existing.lastActivity = new Date();
      return existing.runtime;
    }

    // Prevent concurrent startup. ATOMIC check-then-set (2026-07-02, Codex): the
    // `.add()` MUST run with NO `await` between it and the `has()` guard, so two
    // concurrent callers can never both pass — the loser sees the flag set and
    // waits. Previously the flag was set only AFTER the awaited `db.query` lookup
    // below, so two concurrent callers (e.g. multiple agents chatting the same
    // building → two ensureAgentRuntime for the same system platformAgentId) could
    // both pass the guard, both call startAgent, and duplicate-init/overwrite the
    // runningAgents entry. Setting the flag first + moving the lookup inside the
    // try/finally closes that window (the finally still clears on every path).
    if (this.recoveryInProgress.has(agentId)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const recovered = this.runningAgents.get(agentId);
      return recovered?.runtime ?? null;
    }
    this.recoveryInProgress.add(agentId);

    try {
      // Verify agent exists — openclaw-bot agents match by id only
      const agent = userId
        ? await db.query.agents.findFirst({
            where: and(eq(agents.id, agentId), eq(agents.userId, userId)),
          })
        : await db.query.agents.findFirst({
            where: eq(agents.id, agentId),
          });

      if (!agent) return null;

      // Lazy-start the agent
      console.log(`[Orchestrator] Lazy-starting agent ${agentId}`);
      if (agent.status !== 'stopped' && agent.status !== 'pending') {
        await this.updateAgentStatus(agentId, 'stopped');
      }
      // Forward opts (e.g. isHouse) so a LAZY-warmed house agent keeps its
      // inactivity-sweep exemption — the autonomy driver warms via this path
      // (off the boot crush), NOT via the seeder's boot-time startAgent.
      await this.startAgent(agentId, agent.userId, opts);
      const running = this.runningAgents.get(agentId);
      return running?.runtime ?? null;
    } catch (error) {
      console.error(`[Orchestrator] Failed to start agent ${agentId}:`, error);
      await this.updateAgentStatus(agentId, 'error');
      return null;
    } finally {
      // R1 release valve: `startAgent` now REJECTS on a hung ElizaOS init (the
      // in-process rejecting timeout in eliza-runtime.ts), and that rejection
      // propagates into the catch above — so this finally ALWAYS clears the recovery
      // guard. Previously a hung init could hang here forever, leaving the agentId
      // stuck in `recoveryInProgress` so every future ensureAgentRuntime fell into
      // the wait-2s-return-null branch permanently. R1's rejecting timeout is what
      // now guarantees this line runs.
      this.recoveryInProgress.delete(agentId);
    }
  }

  async startAgent(
    agentId: string,
    userId: string,
    opts?: { isHouse?: boolean },
  ): Promise<void> {
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.userId, userId)),
    });

    if (!agent) throw new Error('Agent not found');
    if (agent.status === 'running') throw new Error('Agent is already running');

    await this.updateAgentStatus(agentId, 'starting');

    try {
      const customization = (agent.customization as Record<string, unknown>) ?? {};
      // `system-agent` (e.g. Town Guide) runs the same ElizaOS runtime shape
      // as a location-agent — one character, knowledge[] in customization,
      // same providers. It only differs in where its chat traffic comes
      // from (`/api/chat/system/:slug` instead of `/locations/:id/chat`)
      // and the orchestrator's inactivity-sweep behavior below.
      const agentType = agent.type === 'avatar-agent'
        ? 'avatar-agent'
        : agent.type === 'openclaw-bot'
          ? 'openclaw-bot'
          : agent.type === 'system-agent'
            ? 'location-agent'
            : 'location-agent';

      // Extract gateway config for openclaw-bot agents
      const gatewayData = customization.gateway as Record<string, unknown> | undefined;
      const openclawGateway = agentType === 'openclaw-bot' && gatewayData
        ? {
            gatewayUrl: gatewayData.gatewayUrl as string,
            authToken: gatewayData.authToken as string,
            agentId: gatewayData.agentId as string,
            protocol: (gatewayData.protocol as 'openai-compat' | 'anthropic' | 'custom-webhook') ?? 'openai-compat',
            modelName: gatewayData.modelName as string | undefined,
            timeoutMs: gatewayData.timeoutMs as number | undefined,
            maxTokens: gatewayData.maxTokens as number | undefined,
          }
        : undefined;

      const runtime: ElizaRuntime = createElizaRuntime({
        agentId,
        agentType,
        customization: {
          name: agent.name,
          personality: customization.personality as string | undefined,
          bio: customization.bio as string | string[] | undefined,
          greeting: customization.greeting as string | undefined,
          rules: customization.rules as string[] | undefined,
          tone: customization.tone as string | undefined,
          topics: customization.topics as string[] | undefined,
          style: customization.style as string[] | { all: string[]; chat: string[]; post: string[] } | undefined,
          lore: customization.lore as string[] | undefined,
          knowledge: customization.knowledge as string[] | undefined,
          messageExamples: customization.messageExamples as Array<{ user: string; content: string }[]> | undefined,
          adjectives: customization.adjectives as string[] | undefined,
          system: customization.system as string | undefined,
        },
        agentConfig: (agent.config as Record<string, unknown>) ?? {},
        openclawGateway,
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
        type: agent.type ?? undefined,
        isHouse: opts?.isHouse ?? false,
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
      // SAFETY-CRITICAL: skip system agents from the inactivity sweep
      // BEFORE any stopAgent / updateAgentStatus call. System agents
      // (Town Guide et al.) are boot-seeded singletons; stopping one
      // 503s the next visitor to `/api/chat/system/:slug` until next
      // boot. Skip must happen before `stopAgent()` — not inside it —
      // because `stopAgent()` unconditionally writes
      // `updateAgentStatus('stopped')` to the DB on every sweep tick
      // even when no in-memory runtime is present.
      //
      // Agent-metaverse P1 — ALSO skip house agents (ClawVille-hosted
      // autonomous fixtures). The autonomy driver keeps them acting via
      // `useModel` (which does NOT bump `lastActivity`), so they'd look idle
      // and get stopped out from under the driver — same "boot-seeded
      // singleton the world depends on" rationale as system agents.
      if (agent.type === 'system-agent' || agent.isHouse) continue;

      if (now - agent.lastActivity.getTime() > INACTIVITY_TIMEOUT_MS) {
        // D6 (P3 slice 3) — do NOT reap a hosted runtime that BACKS a LIVE
        // connected agent session. The connected agent drives play through the
        // gateway (`/:sid/*`), which slides the SESSION TTL but never touches
        // THIS runtime's `lastActivity` (gateway actions warm the TEACHER's
        // runtime, not the connected agent's own), so a live-session agent looks
        // idle here and its wrapper/memory runtime would die mid-session. The
        // check is the SAME live-session predicate validateLiveAgentSession uses.
        // FAIL-OPEN to today's behavior (stop) on any error — prefer no-leak. A
        // transient read error may stop a runtime that IS backing a live session,
        // but that degradation is SOFT: the next connected action lazy re-warms the
        // runtime (ensureAgentRuntime), and until then the converged-memory paths
        // fall back to the keyword store — no data loss, no hard failure.
        let backsLiveSession = false;
        try {
          backsLiveSession = await this.agentBacksLiveConnectedSession(agentId);
        } catch {
          backsLiveSession = false;
        }
        if (backsLiveSession) continue;

        console.log(`[Orchestrator] Stopping inactive agent ${agentId}`);
        await this.stopAgent(agentId);
      }
    }
  }

  /**
   * D6 (P3 slice 3) — does this hosted runtime (platform_agents.id) back a LIVE
   * connected agent session? Resolves the runtime's avatar (`avatars.platformAgentId`)
   * → its owner → any `openclaw_bots` session for that owner that is still live
   * (strictly-future `session_expires_at`, not swept). Same fail-closed TTL rule
   * as `validateLiveAgentSession` / `restoreAgentSessionFromRow`. Returns false
   * (→ eligible for the idle sweep) when no live session backs the runtime.
   */
  private async agentBacksLiveConnectedSession(platformAgentId: string): Promise<boolean> {
    const rows = await db
      .select({
        expiresAt: agentBots.sessionExpiresAt,
        sweptAt: agentBots.sessionSweptAt,
      })
      .from(avatars)
      .innerJoin(agentBots, eq(agentBots.userId, avatars.userId))
      .where(eq(avatars.platformAgentId, platformAgentId));
    const now = Date.now();
    for (const r of rows) {
      const exp = r.expiresAt?.getTime();
      if (exp === undefined || exp <= now) continue; // NULL / past = expired
      const swept = r.sweptAt?.getTime();
      if (swept !== undefined && swept >= exp) continue; // swept = reaped
      return true; // a live connected session backs this runtime
    }
    return false;
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
