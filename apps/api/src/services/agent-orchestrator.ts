import { resolveProbeRuntimeScope } from './brainchain/probe-runtime-scope';
import { eq, and } from 'drizzle-orm';
import { db, agents, agentLogs, avatars, agentBots } from '@clawville/database';
import {
  ElizaRuntime,
  createElizaRuntime,
  resolveInferenceRoute,
  type OwnAiCallEstimate,
  type OwnAiPluginFallbackReason,
  type OwnAiProviderConfig,
  type OwnAiReservation,
} from '@clawville/agent-runtime';
import type { AgentStatus } from '@clawville/shared';
// P3 slice 6 (surface #3): the public, token-free connection protocol manual +
// its single-source version, injected into hosted PLAYER runtimes on start.
import { buildProtocolManual, resolveApiBase, PROTOCOL_VERSION } from './skill-protocol';
// Own AI (2026-11-09): the human's own key / UsePod token for a user-owned avatar's agent.
import {
  loadOwnAiRuntimeConfig,
  ownAiActiveNow,
  ownAiMayCall,
  recordOwnAiUsage,
  recordOwnAiFallback,
  releaseOwnAiReservation,
  onOwnAiSettingsChanged,
  type OwnAiRuntimeConfig,
} from './own-ai';

/** Budget-gate timeout. A slow gate fails CLOSED (ClawVille AI answers that call). */
export const OWN_AI_GATE_TIMEOUT_MS = 2_000;
/** Config-load timeout at runtime start. A slow load starts the agent on ClawVille AI. */
export const OWN_AI_LOAD_TIMEOUT_MS = 5_000;
/** OpenRouter app attribution headers (public values, no secret). */
const OPENROUTER_EXTRA_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://clawville.world',
  'X-Title': 'ClawVille',
};

/**
 * In-memory own-AI state of ONE running runtime. `fallbackReason` is the last
 * reason the plugin fell back (null = the last own-AI call worked). It is set by
 * onFallback and cleared by a successful onUsage, so the driver's speed check is
 * a Map read, not a DB read.
 */
export interface OwnAiLiveState {
  avatarId: string;
  speedSeconds: number;
  timeoutMs: number;
  fallbackReason: OwnAiPluginFallbackReason | null;
  /** The last gate miss was a timeout/error (not the daily limit). */
  gateFailure: boolean;
}

export interface OwnAiServiceDeps {
  /** Reserves the call's worst-case cost (priced with `model`); null = no room under the limit. */
  mayCall: (avatarId: string, model: string, estimate: OwnAiCallEstimate) => Promise<OwnAiReservation | null>;
  /** Settles a reservation with the real usage (one atomic upsert). */
  recordUsage: (
    avatarId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    reservation: OwnAiReservation,
  ) => Promise<void>;
  /** Gives back the reservation of a call that spent nothing. */
  release: (avatarId: string, reservation: OwnAiReservation) => Promise<void>;
  recordFallback: (avatarId: string, reason: OwnAiPluginFallbackReason) => Promise<void>;
}

const defaultOwnAiDeps: OwnAiServiceDeps = {
  mayCall: (avatarId, model, estimate) => ownAiMayCall(avatarId, model, estimate),
  recordUsage: (avatarId, model, i, o, reservation) => recordOwnAiUsage(avatarId, model, i, o, reservation),
  release: (avatarId, reservation) => releaseOwnAiReservation(avatarId, reservation),
  recordFallback: (avatarId, reason) => recordOwnAiFallback(avatarId, reason),
};

function errorCode(err: unknown): string {
  // Never log an error MESSAGE here: a provider or crypto error can echo a key.
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * Builds the `ownAi` runtime config: the decrypted key in memory plus the
 * callbacks bound to the own-ai service.
 *  - mayCall: reserves the call's worst-case cost (priced with the configured
 *    model), awaited with a 2 s timeout; timeout or error -> null (fail CLOSED).
 *    A reservation that lands after the timeout is released at once.
 *  - onUsage: fire-and-forget settlement of the reservation (errors logged by
 *    code); clears the fallback.
 *  - onRelease: fire-and-forget release of the reservation of a failed call.
 *  - onFallback: sets the in-memory reason. 'daily_limit' after a REAL limit is
 *    persisted by ownAiMayCall (only when the spent estimate has no room); after a gate timeout/error it is kept in
 *    memory as 'provider_error' and not persisted. Other reasons persist only
 *    when the reason changes (no DB write per call while a key stays rejected).
 */
export function buildOwnAiPluginConfig(
  cfg: OwnAiRuntimeConfig,
  state: OwnAiLiveState,
  deps: OwnAiServiceDeps = defaultOwnAiDeps,
  gateTimeoutMs: number = OWN_AI_GATE_TIMEOUT_MS,
): OwnAiProviderConfig {
  const avatarId = cfg.avatarId;
  return {
    protocol: cfg.protocol,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokensFloor: cfg.maxTokensFloor,
    timeoutMs: cfg.timeoutMs,
    reasoning: cfg.reasoning,
    extraHeaders: cfg.provider === 'openrouter' ? { ...OPENROUTER_EXTRA_HEADERS } : undefined,
    mayCall: async (estimate) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A synchronous throw becomes a rejection (caught below, fail closed).
      const gate = Promise.resolve().then(() => deps.mayCall(avatarId, cfg.model, estimate));
      try {
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), gateTimeoutMs);
        });
        const verdict = await Promise.race([gate, timeout]);
        if (verdict === 'timeout') {
          state.gateFailure = true;
          console.warn(`[Orchestrator] own_ai_gate_timeout avatar=${avatarId}`);
          // The call goes to ClawVille AI: a reservation that lands late is given back.
          void gate.then(
            (late) => (late ? deps.release(avatarId, late) : undefined),
            () => undefined,
          ).catch((err) => {
            console.warn(`[Orchestrator] own_ai_release_failed avatar=${avatarId} code=${errorCode(err)}`);
          });
          return null;
        }
        state.gateFailure = false;
        return verdict ?? null;
      } catch (err) {
        state.gateFailure = true;
        console.warn(`[Orchestrator] own_ai_gate_failed avatar=${avatarId} code=${errorCode(err)}`);
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    onUsage: (u, reservation) => {
      state.fallbackReason = null;
      void deps.recordUsage(avatarId, u.model, u.inputTokens, u.outputTokens, reservation).catch((err) => {
        console.warn(`[Orchestrator] own_ai_usage_record_failed avatar=${avatarId} code=${errorCode(err)}`);
      });
    },
    onRelease: (reservation) => {
      void deps.release(avatarId, reservation).catch((err) => {
        console.warn(`[Orchestrator] own_ai_release_failed avatar=${avatarId} code=${errorCode(err)}`);
      });
    },
    onFallback: (reason) => {
      if (reason === 'daily_limit') {
        state.fallbackReason = state.gateFailure ? 'provider_error' : 'daily_limit';
        return;
      }
      const changed = state.fallbackReason !== reason;
      state.fallbackReason = reason;
      if (!changed) return;
      void deps.recordFallback(avatarId, reason).catch((err) => {
        console.warn(`[Orchestrator] own_ai_fallback_record_failed avatar=${avatarId} code=${errorCode(err)}`);
      });
    },
  };
}

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
  /** Own AI: the user-owned avatar this runtime plays (set for hosted-user runtimes). */
  avatarId?: string;
  /** Own AI: present when the runtime runs on the human's own AI. */
  ownAi?: OwnAiLiveState;
}

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class AgentOrchestrator {
  private runningAgents: Map<string, RunningAgent> = new Map();
  private inactivityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private recoveryInProgress: Set<string> = new Set();
  /**
   * Own AI: settings generation per avatar. Bumped on every settings change. A
   * start that read generation N and finishes after a change stops itself, so a
   * runtime never keeps settings older than the last save.
   */
  private ownAiSettingsGen: Map<string, number> = new Map();

  constructor() {
    // Check for inactive agents every 5 minutes
    this.inactivityCheckInterval = setInterval(() => {
      this.stopInactiveAgents().catch(console.error);
    }, 5 * 60 * 1000);
    // Own AI: a settings change stops that avatar's running runtime; the next
    // use (chat or the autonomy driver) re-warms it with the new settings.
    try {
      onOwnAiSettingsChanged((avatarId) => {
        void this.handleOwnAiSettingsChanged(avatarId);
      });
    } catch (err) {
      console.warn(`[Orchestrator] own_ai_subscribe_failed code=${errorCode(err)}`);
    }
  }

  /** Own AI: stop every running runtime of this avatar (fail-soft). */
  async handleOwnAiSettingsChanged(avatarId: string): Promise<void> {
    this.ownAiSettingsGen.set(avatarId, (this.ownAiSettingsGen.get(avatarId) ?? 0) + 1);
    for (const [agentId, ra] of this.runningAgents) {
      if (ra.avatarId !== avatarId) continue;
      try {
        console.log(`[Orchestrator] own AI settings changed for avatar ${avatarId}; stopping agent ${agentId} to re-warm`);
        await this.stopAgent(agentId);
      } catch (err) {
        console.warn(`[Orchestrator] own_ai_restart_failed agent=${agentId} code=${errorCode(err)}`);
      }
    }
  }

  /**
   * Own AI: the avatar a USER-OWNED hosted runtime plays, or null. Only called
   * for route 'hosted-user' (never a teacher, system or house runtime). The
   * avatar must point at this platform agent AND belong to the agent's owner,
   * and the owner must have no house bot (belt and braces next to the route).
   */
  private async resolveUserOwnedAvatarId(agentId: string, userId: string): Promise<string | null> {
    const rows = await db
      .select({ id: avatars.id })
      .from(avatars)
      .where(and(eq(avatars.platformAgentId, agentId), eq(avatars.userId, userId)))
      .limit(1);
    const avatarId = rows[0]?.id;
    if (!avatarId) return null;
    const house = await db
      .select({ id: agentBots.id })
      .from(agentBots)
      .where(and(eq(agentBots.userId, userId), eq(agentBots.isHouse, true)))
      .limit(1);
    return house.length > 0 ? null : avatarId;
  }

  /**
   * Own AI: load the runtime config for a user-owned avatar. Any failure or a
   * slow load (> 5 s) returns null: the agent starts on ClawVille AI.
   */
  private async loadOwnAiForStart(agentId: string, avatarId: string): Promise<OwnAiRuntimeConfig | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), OWN_AI_LOAD_TIMEOUT_MS);
      });
      const result = await Promise.race([loadOwnAiRuntimeConfig(avatarId), timeout]);
      if (result === 'timeout') {
        console.warn(`[Orchestrator] own_ai_load_timeout agent=${agentId}; running on ClawVille AI`);
        return null;
      }
      return result;
    } catch (err) {
      console.warn(`[Orchestrator] own_ai_load_failed agent=${agentId} code=${errorCode(err)}; running on ClawVille AI`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Own AI: seconds between decisions for the autonomy driver. null = the agent
   * runs on ClawVille AI now (no own AI, or the last own-AI call fell back).
   * A Map read; does not bump lastActivity.
   */
  getOwnAiSpeedSeconds(agentId: string): number | null {
    const own = this.runningAgents.get(agentId)?.ownAi;
    return own && own.fallbackReason === null ? own.speedSeconds : null;
  }

  /** Own AI: the own-AI call timeout (ms) for the driver's decide budget; null as above. */
  getOwnAiTimeoutMs(agentId: string): number | null {
    const own = this.runningAgents.get(agentId)?.ownAi;
    return own && own.fallbackReason === null ? own.timeoutMs : null;
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
      const probeScope = await resolveProbeRuntimeScope(agentId, userId, true);
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

      // Inference route — decides which endpoints the InferenceRouter walks for
      // this runtime's text gen (teachers → OpenAI, our house fleet → local boxes
      // + failover). Derived from the RAW DB type + house-ness. House-ness is
      // resolved from BOTH the caller's `opts.isHouse` AND the platform_agents
      // row's `config.houseAgentId`, so a house fixture routes to the fleet
      // regardless of WHICH path warms its runtime first (the driver passes
      // isHouse; a human-chat warm would not — the config marker covers that).
      const isHouseAgent =
        opts?.isHouse === true ||
        Boolean((agent.config as Record<string, unknown> | null)?.houseAgentId);
      const inferenceRoute = resolveInferenceRoute(agent.type, isHouseAgent);

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

      // Own AI — ONLY for a user-owned avatar's hosted runtime (route
      // 'hosted-user' excludes teachers, Nori/system agents and the house
      // fleet) and never next to an OpenClaw gateway (the gateway wins). A
      // load failure never stops the agent: it runs on ClawVille AI.
      let avatarId: string | undefined;
      let ownAiState: OwnAiLiveState | undefined;
      let ownAi: OwnAiProviderConfig | undefined;
      let ownAiGenAtStart = 0;
      if (!probeScope && inferenceRoute === 'hosted-user' && !openclawGateway) {
        try {
          avatarId = (await this.resolveUserOwnedAvatarId(agentId, userId)) ?? undefined;
        } catch (err) {
          console.warn(`[Orchestrator] own_ai_avatar_lookup_failed agent=${agentId} code=${errorCode(err)}`);
        }
        if (avatarId) {
          ownAiGenAtStart = this.ownAiSettingsGen.get(avatarId) ?? 0;
          const cfg = await this.loadOwnAiForStart(agentId, avatarId);
          if (cfg) {
            // A sticky fallback already makes cfg null. Today's daily limit
            // does not, so seed the in-memory state from the DB: the driver
            // must not run the fast lane on ClawVille AI. A failed (> 5 s) read seeds 'daily_limit' too (house spacing);
            // the first working own-AI call clears it (onUsage).
            let activeTimer: ReturnType<typeof setTimeout> | undefined;
            const activeNow = await Promise.race([
              ownAiActiveNow(avatarId),
              new Promise<'clawville'>((resolve) => {
                activeTimer = setTimeout(() => resolve('clawville'), OWN_AI_LOAD_TIMEOUT_MS);
              }),
            ]).catch((err: unknown) => {
              console.warn(`[Orchestrator] own_ai_active_read_failed agent=${agentId} code=${errorCode(err)}`);
              return 'clawville' as const;
            }).finally(() => {
              if (activeTimer) clearTimeout(activeTimer);
            });
            ownAiState = {
              avatarId,
              speedSeconds: cfg.speedSeconds,
              timeoutMs: cfg.timeoutMs,
              fallbackReason: activeNow === 'own' ? null : 'daily_limit',
              gateFailure: false,
            };
            ownAi = buildOwnAiPluginConfig(cfg, ownAiState);
          }
        }
      }

      const runtime: ElizaRuntime = createElizaRuntime({
        agentId,
        agentType,
        probeScope,
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
        inferenceRoute,
        ownAi,
        databaseUrl: process.env.DATABASE_URL,
        apiKeys: probeScope ? undefined : {
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
        avatarId,
        ownAi: ownAiState,
      });

      // P3 slice 6 (surface #3): inject the connection protocol manual into a
      // ClawVille-HOSTED PLAYER runtime's OWN ElizaOS memory so it plays the same
      // contract a connected agent fetches from `/api/skills/protocol/skill.md`.
      // Scoped to ALL PLAYER runtimes — hosted avatar-agents (the default hosted
      // ElizaOS/Milady agent) AND every `openclaw-bot` shell (declared-gateway
      // BYO, hermes-local/openclaw-local hosted, house agents). Widened from
      // `avatar-agent || isHouseAgent` 2026-07-17 (founder uniformity directive:
      // every hosted player class gets the manual — the old scope left a
      // declared-gateway shell's external brain blind to the world contract
      // unless the agent self-installed). Teacher `location-agent`s + Nori
      // `system-agent` stay excluded — they are world NPCs, not players, and the
      // manual would be noise in their teaching RAG. Injection is agent-scoped +
      // version-deduped (idempotent), fire-and-forget + fail-soft; NEVER blocks
      // boot. Regression gate: hosted-skill-runtime-probe (default openclaw-bot
      // fixture, no house flag).
      if (agentType === 'avatar-agent' || agentType === 'openclaw-bot' || isHouseAgent) {
        void this.injectProtocolKnowledgeIntoRuntime(runtime);
      }

      await this.updateAgentStatus(agentId, 'running');
      console.log(`[Orchestrator] Agent ${agentId} started`);

      // Own AI: the settings changed while this runtime was starting -> stop it
      // so the next use re-warms with the new settings.
      if (avatarId && (this.ownAiSettingsGen.get(avatarId) ?? 0) !== ownAiGenAtStart) {
        console.log(`[Orchestrator] own AI settings changed during start of ${agentId}; stopping to re-warm`);
        await this.stopAgent(agentId);
      }
    } catch (error) {
      await this.updateAgentStatus(agentId, 'error');
      throw error;
    }
  }

  /**
   * P3 slice 6 (surface #3) — fire-and-forget injection of the CURRENT connection
   * protocol manual into a freshly-started hosted PLAYER runtime. Builds the
   * public, token-free manual (`buildProtocolManual`) + the single-source live
   * `PROTOCOL_VERSION` and hands both to the runtime's own fail-soft
   * `injectProtocolKnowledge`. Wrapped so a throw here can never escape into the
   * start path. A `PROTOCOL_VERSION` bump is picked up on the runtime's NEXT start
   * (the natural lifecycle boundary); the injector dedupes by version, so a re-run
   * on the same version is idempotent. The v41 deployment restart therefore
   * re-injects the one-wallet manual into every restarted hosted player runtime.
   */
  private async injectProtocolKnowledgeIntoRuntime(runtime: ElizaRuntime): Promise<void> {
    try {
      const manual = buildProtocolManual(resolveApiBase());
      await runtime.injectProtocolKnowledge(manual, PROTOCOL_VERSION);
    } catch (err) {
      console.warn(
        '[Orchestrator] protocol-knowledge injection failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
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
