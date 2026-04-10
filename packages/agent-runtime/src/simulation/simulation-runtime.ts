/**
 * SimulationRuntime — a specialized ElizaRuntime that hosts the
 * autonomous avatar simulation. Registers 4 avatar actions + 1 provider
 * on a single shared runtime (per user decision: Option B).
 *
 * Per-tick movement and activity transitions are pure — handled in
 * the bridge via movement.ts helpers. The runtime is only invoked
 * when a planning decision is needed (avatar idle + cooldown elapsed).
 *
 * Planning flow:
 *   1. Bridge calls runtime.planAvatarNextAction(userId)
 *   2. Runtime composes state via AVATAR_WORLD_STATE provider
 *   3. Runtime asks LLM for a structured action choice
 *   4. Runtime parses + dispatches the chosen Action's handler
 *   5. Action mutates AvatarStateStore
 *   6. Bridge resumes tick orchestration on next cycle
 */

import {
  ModelType,
  createCharacter,
  type Action,
  type ActionResult,
  type Character,
  type CharacterInput,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type UUID,
} from '@elizaos/core';
import { v5 as uuidv5 } from 'uuid';

import { ElizaRuntime, type ElizaRuntimeConfig } from '../eliza-runtime';
import { AvatarStateStore } from './avatar-state-store';
import type {
  ActivityEmojis,
  BuildingActivities,
  BuildingCenters,
  PathfindFn,
  PetDbHooks,
} from './types';

import { createPetMoveToBuildingAction } from './actions/avatar-move-to-building';
import { createPetVisitBuildingAction } from './actions/avatar-visit-building';
import { createPetReturnHomeAction } from './actions/avatar-return-home';
import { createPetSleepAction } from './actions/avatar-sleep';
import { createPetWorldStateProvider } from './providers/avatar-world-state';

const SIM_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const SIM_AGENT_ID = uuidv5('clawville-simulation-agent', SIM_NAMESPACE) as UUID;
const SIM_ROOM_ID = uuidv5('clawville-simulation-room', SIM_NAMESPACE) as UUID;
const SIM_WORLD_ID = uuidv5('clawville-simulation-world', SIM_NAMESPACE) as UUID;

export interface SimulationRuntimeDeps {
  stateStore: AvatarStateStore;
  buildingCenters: BuildingCenters;
  buildingActivities: BuildingActivities;
  activityEmojis: ActivityEmojis;
  pathfind: PathfindFn;
  dbHooks: PetDbHooks;
  databaseUrl?: string;
  apiKeys?: { anthropic?: string; gemini?: string };
  /** Optional home spawn coordinates (defaults to center of 1280x800) */
  homeX?: number;
  homeY?: number;
}

interface ActionChoice {
  action: 'AVATAR_MOVE_TO_BUILDING' | 'AVATAR_RETURN_HOME' | 'AVATAR_SLEEP';
  userId: string;
  buildingId?: string;
}

/**
 * The simulation agent character — lightweight, just needs a name and
 * system prompt so the LLM understands its role as "the world puppeteer".
 *
 * Only includes plugins we actually need. plugin-openai / plugin-solana
 * are deliberately omitted (not installed).
 */
function buildSimulationCharacter(): Character {
  const input: CharacterInput & { name: string } = {
    id: SIM_AGENT_ID,
    name: 'ClawVille Simulation',
    username: 'clawville-sim',
    system:
      'You are the autonomous avatar simulation controller for ClawVille. You decide what idle avatars should do next in the underwater reef world. Each tick, you are asked to choose one action for one avatar. Keep decisions varied: explore different buildings, eventually rest. Respond ONLY with a structured JSON action choice — no prose.',
    bio: ['The autonomous avatar simulation controller for ClawVille.'],
    plugins: [
      '@elizaos/plugin-anthropic',
      '@elizaos/plugin-sql',
    ],
    settings: {
      model: 'gemini-2.5-flash',
    } as any,
    style: {
      all: ['Respond only with structured JSON — no prose, no explanation'],
      chat: [],
      post: [],
    },
    topics: ['avatar autonomy', 'building exploration'],
    adjectives: ['decisive', 'varied', 'curious'],
    knowledge: [],
  };

  return createCharacter(input);
}

export class SimulationRuntime {
  private eliza: ElizaRuntime;
  private deps: SimulationRuntimeDeps;
  private actions: Action[] = [];
  private provider: Provider;
  private initialized = false;

  constructor(deps: SimulationRuntimeDeps) {
    this.deps = deps;

    // Build the 4 actions + provider with deps closed over
    this.actions = [
      createPetMoveToBuildingAction({
        stateStore: deps.stateStore,
        buildingCenters: deps.buildingCenters,
        pathfind: deps.pathfind,
      }),
      createPetVisitBuildingAction({
        stateStore: deps.stateStore,
        buildingActivities: deps.buildingActivities,
        activityEmojis: deps.activityEmojis,
        dbHooks: deps.dbHooks,
      }),
      createPetReturnHomeAction({
        stateStore: deps.stateStore,
        pathfind: deps.pathfind,
        homeX: deps.homeX,
        homeY: deps.homeY,
      }),
      createPetSleepAction({
        stateStore: deps.stateStore,
        activityEmojis: deps.activityEmojis,
      }),
    ];

    this.provider = createPetWorldStateProvider({
      stateStore: deps.stateStore,
      buildingCenters: deps.buildingCenters,
    });

    // Instantiate the underlying ElizaRuntime with a pre-built simulation
    // character (escape hatch — skips template loading entirely).
    const config: ElizaRuntimeConfig = {
      agentId: SIM_AGENT_ID,
      agentType: 'simulation-agent',
      character: buildSimulationCharacter(),
      agentConfig: {},
      databaseUrl: deps.databaseUrl,
      apiKeys: deps.apiKeys,
      thinkingConfig: {
        effort: 'low', // Planning is a small decision — low thinking budget
        enableThinkTool: false,
      },
    };

    this.eliza = new ElizaRuntime(config);
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    await this.eliza.start();

    // Register actions + provider on the underlying runtime
    const runtime = this.getRuntime();
    if (runtime) {
      for (const action of this.actions) {
        runtime.registerAction(action);
      }
      runtime.registerProvider(this.provider);
    }

    this.initialized = true;
    console.log('[SimulationRuntime] Initialized with 4 avatar actions + AVATAR_WORLD_STATE provider');
  }

  async stop(): Promise<void> {
    await this.eliza.stop();
    this.initialized = false;
  }

  /** Access the underlying IAgentRuntime (for composeState, useModel, etc.) */
  private getRuntime(): IAgentRuntime | null {
    // ElizaRuntime holds the underlying runtime in a private field — we
    // access it via the same unknown-cast pattern used during construction.
    return (this.eliza as unknown as { runtime: IAgentRuntime | null }).runtime;
  }

  /**
   * Plan the next action for a single avatar using the LLM.
   * Called by the bridge when a avatar is idle and cooldown has elapsed.
   */
  async planAvatarNextAction(userId: string): Promise<ActionResult | null> {
    if (!this.initialized) return null;
    const runtime = this.getRuntime();
    if (!runtime) return null;

    const avatar = this.deps.stateStore.get(userId);
    if (!avatar) return null;

    try {
      // Build a synthetic message that carries targetUserId for the provider
      const message: Memory = {
        id: uuidv5(`sim-tick-${userId}-${Date.now()}`, SIM_NAMESPACE) as UUID,
        agentId: SIM_AGENT_ID,
        entityId: SIM_AGENT_ID,
        roomId: SIM_ROOM_ID,
        content: { text: `Plan next action for avatar`, source: 'simulation' },
        createdAt: Date.now(),
        metadata: {
          type: 'message' as const,
          source: 'simulation',
          targetUserId: userId,
        } as any,
      };

      // Compose state with the AVATAR_WORLD_STATE provider
      let providerText = '';
      try {
        const state = await runtime.composeState(message, ['AVATAR_WORLD_STATE'], true);
        providerText = state.text ?? '';
      } catch (err) {
        // If composeState fails (e.g., provider registration race), fall back
        // to calling the provider directly
        const result = await this.provider.get(runtime, message, {} as any);
        providerText = result.text ?? '';
      }

      // Build the planning prompt
      const prompt = [
        providerText,
        '',
        'Decide what this avatar should do next. Choose ONE of:',
        '  1. AVATAR_MOVE_TO_BUILDING — walk to a nearby building to explore it',
        '  2. AVATAR_RETURN_HOME — head back to the spawn point',
        '  3. AVATAR_SLEEP — rest (terminal state until user returns)',
        '',
        'Favor variety — pick buildings the avatar has not visited yet. After several visits, return home and sleep.',
        '',
        `Respond ONLY with a single-line JSON object. Use userId="${userId}". Examples:`,
        `  {"action":"AVATAR_MOVE_TO_BUILDING","userId":"${userId}","buildingId":"cron-hub"}`,
        `  {"action":"AVATAR_RETURN_HOME","userId":"${userId}"}`,
        `  {"action":"AVATAR_SLEEP","userId":"${userId}"}`,
      ].join('\n');

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 200,
        stopSequences: [],
      } as any);

      const choice = this.parseActionChoice(response as string, userId);
      if (!choice) {
        console.warn(`[SimulationRuntime] Failed to parse planner response for ${userId}:`, response);
        return null;
      }

      // Dispatch the chosen action
      return await this.dispatchAction(choice, message);
    } catch (err) {
      console.error(`[SimulationRuntime] planAvatarNextAction(${userId}) failed:`, err);
      return null;
    }
  }

  /**
   * Direct action dispatch — used by the bridge to fire AVATAR_VISIT_BUILDING
   * when a avatar arrives at its destination (no LLM involvement).
   */
  async dispatchAction(
    choice: { action: string; userId: string; buildingId?: string },
    messageParam?: Memory,
  ): Promise<ActionResult | null> {
    const runtime = this.getRuntime();
    if (!runtime) return null;

    const action = this.actions.find((a) => a.name === choice.action);
    if (!action) {
      console.warn(`[SimulationRuntime] Unknown action: ${choice.action}`);
      return null;
    }

    const message: Memory = messageParam ?? {
      id: uuidv5(`sim-dispatch-${choice.userId}-${Date.now()}`, SIM_NAMESPACE) as UUID,
      agentId: SIM_AGENT_ID,
      entityId: SIM_AGENT_ID,
      roomId: SIM_ROOM_ID,
      content: { text: `Dispatch ${choice.action}`, source: 'simulation' },
      createdAt: new Date(Date.now()).toISOString() as unknown as number,
      metadata: {
        type: 'message' as const,
        source: 'simulation',
        targetUserId: choice.userId,
      } as any,
    };

    try {
      const valid = await action.validate(runtime, message);
      if (!valid) return null;

      const parameters: Record<string, string> = { userId: choice.userId };
      if (choice.buildingId) parameters.buildingId = choice.buildingId;

      const result = await action.handler(
        runtime,
        message,
        undefined,
        { parameters } as any,
      );
      return result ?? null;
    } catch (err) {
      console.error(`[SimulationRuntime] dispatchAction(${choice.action}) failed:`, err);
      return null;
    }
  }

  /**
   * Generate a short visit chat line via the runtime LLM.
   * Per user decision: visit chat is routed through runtime, not raw Anthropic SDK.
   */
  async generateAvatarChat(userId: string, buildingId: string): Promise<string | null> {
    if (!this.initialized) return null;
    const runtime = this.getRuntime();
    if (!runtime) return null;

    const avatar = this.deps.stateStore.get(userId);
    if (!avatar) return null;

    try {
      const prompt = `You are ${avatar.name}, a ${avatar.species} (${avatar.archetype} personality) visiting the ${buildingId} in the ClawVille reef. Say one short sentence about what you see or think. Be playful, under 50 characters. Respond with just the sentence, no quotes.`;

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
        stopSequences: [],
      } as any);

      const text = (response as string).trim().slice(0, 80).replace(/^["']|["']$/g, '');
      return text;
    } catch (err) {
      console.error('[SimulationRuntime] generateAvatarChat failed:', err);
      return null;
    }
  }

  private parseActionChoice(response: string, userId: string): ActionChoice | null {
    if (!response) return null;

    // Try to find a JSON object in the response
    const match = response.match(/\{[\s\S]*?\}/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]) as Partial<ActionChoice>;
      if (!parsed.action) return null;

      // Validate action name
      const validActions = ['AVATAR_MOVE_TO_BUILDING', 'AVATAR_RETURN_HOME', 'AVATAR_SLEEP'] as const;
      if (!validActions.includes(parsed.action as (typeof validActions)[number])) return null;

      // Always override userId with the one we know — don't trust LLM hallucinations
      return {
        action: parsed.action as ActionChoice['action'],
        userId,
        buildingId: parsed.buildingId,
      };
    } catch {
      return null;
    }
  }
}

export function createSimulationRuntime(deps: SimulationRuntimeDeps): SimulationRuntime {
  return new SimulationRuntime(deps);
}
