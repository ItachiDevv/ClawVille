/**
 * SimulationRuntime — a specialized ElizaRuntime that hosts the
 * autonomous pet simulation. Registers 4 pet actions + 1 provider
 * on a single shared runtime (per user decision: Option B).
 *
 * Per-tick movement and activity transitions are pure — handled in
 * the bridge via movement.ts helpers. The runtime is only invoked
 * when a planning decision is needed (pet idle + cooldown elapsed).
 *
 * Planning flow:
 *   1. Bridge calls runtime.planPetNextAction(userId)
 *   2. Runtime composes state via PET_WORLD_STATE provider
 *   3. Runtime asks LLM for a structured action choice
 *   4. Runtime parses + dispatches the chosen Action's handler
 *   5. Action mutates PetStateStore
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
import { PetStateStore } from './pet-state-store';
import type {
  ActivityEmojis,
  BuildingActivities,
  BuildingCenters,
  PathfindFn,
  PetDbHooks,
} from './types';

import { createPetMoveToBuildingAction } from './actions/pet-move-to-building';
import { createPetVisitBuildingAction } from './actions/pet-visit-building';
import { createPetReturnHomeAction } from './actions/pet-return-home';
import { createPetSleepAction } from './actions/pet-sleep';
import { createPetWorldStateProvider } from './providers/pet-world-state';

const SIM_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const SIM_AGENT_ID = uuidv5('clawville-simulation-agent', SIM_NAMESPACE) as UUID;
const SIM_ROOM_ID = uuidv5('clawville-simulation-room', SIM_NAMESPACE) as UUID;
const SIM_WORLD_ID = uuidv5('clawville-simulation-world', SIM_NAMESPACE) as UUID;

export interface SimulationRuntimeDeps {
  stateStore: PetStateStore;
  buildingCenters: BuildingCenters;
  buildingActivities: BuildingActivities;
  activityEmojis: ActivityEmojis;
  pathfind: PathfindFn;
  dbHooks: PetDbHooks;
  databaseUrl?: string;
  apiKeys?: { gemini?: string };
  /** Optional home spawn coordinates (defaults to center of 1280x800) */
  homeX?: number;
  homeY?: number;
  /** Phase 3: injected services for economic actions (BUY_ITEM, LEARN_SKILL) */
  services?: SimulationServices;
}

interface ActionChoice {
  action: 'PET_MOVE_TO_BUILDING' | 'PET_RETURN_HOME' | 'PET_SLEEP' | 'BUY_ITEM' | 'LEARN_SKILL';
  userId: string;
  buildingId?: string;
  itemId?: string;
}

/**
 * Phase 3: Services passed to Phase 1 economic actions.
 * Uses `any` for db and params because the exact Drizzle + ledger types live in
 * apps/api (separate package), and importing them here would create a circular
 * dependency. The types are enforced at the injection site (pet-simulation-bridge.ts)
 * where the real db + ledger functions are assigned.
 */
export interface SimulationServices {
  db: any;
  creditClawTokens: (params: any) => Promise<{ balanceAfter: number }>;
  debitClawTokens: (params: any) => Promise<{ balanceAfter: number }>;
}

/**
 * The simulation agent character — lightweight, just needs a name and
 * system prompt so the LLM understands its role as "the world puppeteer".
 *
 * Only includes plugins we actually need. plugin-openai / plugin-solana /
 * plugin-anthropic are deliberately omitted — Gemini text provider (priority
 * 95, prepended by ElizaRuntime) handles all text generation.
 */
function buildSimulationCharacter(): Character {
  const input: CharacterInput & { name: string } = {
    id: SIM_AGENT_ID,
    name: 'ClawVille Simulation',
    username: 'clawville-sim',
    system:
      'You are the autonomous pet simulation controller for ClawVille. You decide what idle pets should do next in the underwater reef world. Each tick, you are asked to choose one action for one pet. Keep decisions varied: explore different buildings, eventually rest. Respond ONLY with a structured JSON action choice — no prose.',
    bio: ['The autonomous pet simulation controller for ClawVille.'],
    plugins: [
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
    topics: ['pet autonomy', 'building exploration'],
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
    console.log('[SimulationRuntime] Initialized with 4 pet actions + PET_WORLD_STATE provider');
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
   * Plan the next action for a single pet using the LLM.
   * Called by the bridge when a pet is idle and cooldown has elapsed.
   */
  async planPetNextAction(userId: string): Promise<ActionResult | null> {
    if (!this.initialized) return null;
    const runtime = this.getRuntime();
    if (!runtime) return null;

    const pet = this.deps.stateStore.get(userId);
    if (!pet) return null;

    try {
      // Build a synthetic message that carries targetUserId for the provider
      const message: Memory = {
        id: uuidv5(`sim-tick-${userId}-${Date.now()}`, SIM_NAMESPACE) as UUID,
        agentId: SIM_AGENT_ID,
        entityId: SIM_AGENT_ID,
        roomId: SIM_ROOM_ID,
        content: { text: `Plan next action for pet`, source: 'simulation' },
        createdAt: Date.now(),
        metadata: {
          type: 'message' as const,
          source: 'simulation',
          targetUserId: userId,
        } as any,
      };

      // Compose state with the PET_WORLD_STATE provider
      let providerText = '';
      try {
        const state = await runtime.composeState(message, ['PET_WORLD_STATE'], true);
        providerText = state.text ?? '';
      } catch (err) {
        // If composeState fails (e.g., provider registration race), fall back
        // to calling the provider directly
        const result = await this.provider.get(runtime, message, {} as any);
        providerText = result.text ?? '';
      }

      // Phase 3: Check budget — if exceeded, force return home
      const budgetExceeded = pet.budgetSpent >= pet.budgetMaxNt || pet.budgetPurchaseCount >= pet.budgetMaxPurchases;
      if (budgetExceeded) {
        console.log(`[SimulationRuntime] Budget exceeded for ${userId} (spent=${pet.budgetSpent}/${pet.budgetMaxNt}, purchases=${pet.budgetPurchaseCount}/${pet.budgetMaxPurchases}) — forcing return home`);
        return await this.dispatchAction({ action: 'PET_RETURN_HOME', userId }, message);
      }

      // Phase 3: Determine if economic actions are available (pet is visiting a building + has services)
      const isAtBuilding = pet.activity !== 'idle' && pet.activity !== 'sleeping' && pet.destinationBuildingId;
      const hasEconomy = !!this.deps.services && !budgetExceeded;

      // Build the planning prompt
      const actionChoices = [
        '  1. PET_MOVE_TO_BUILDING — walk to a nearby building to explore it',
        '  2. PET_RETURN_HOME — head back to the spawn point',
        '  3. PET_SLEEP — rest (terminal state until user returns)',
      ];

      const examples = [
        `  {"action":"PET_MOVE_TO_BUILDING","userId":"${userId}","buildingId":"cron-hub"}`,
        `  {"action":"PET_RETURN_HOME","userId":"${userId}"}`,
        `  {"action":"PET_SLEEP","userId":"${userId}"}`,
      ];

      // Phase 3: When at a building with budget remaining, offer BUY_ITEM / LEARN_SKILL
      if (isAtBuilding && hasEconomy) {
        actionChoices.push(
          '  4. BUY_ITEM — buy a knowledge book from the current building shop (costs ClawTokens)',
          '  5. LEARN_SKILL — read a book from inventory to learn its knowledge',
        );
        examples.push(
          `  {"action":"BUY_ITEM","userId":"${userId}","itemId":"book-${pet.destinationBuildingId}-0"}`,
          `  {"action":"LEARN_SKILL","userId":"${userId}","itemId":"book-${pet.destinationBuildingId}-0"}`,
        );
      }

      const budgetLine = hasEconomy
        ? `Budget remaining: ${pet.budgetMaxNt - pet.budgetSpent} NT, ${pet.budgetMaxPurchases - pet.budgetPurchaseCount} purchases.`
        : '';

      const prompt = [
        providerText,
        budgetLine,
        '',
        'Decide what this pet should do next. Choose ONE of:',
        ...actionChoices,
        '',
        'Favor variety — pick buildings the pet has not visited yet. When visiting a building, try buying a book and learning from it before moving on. After several visits, return home and sleep.',
        '',
        `Respond ONLY with a single-line JSON object. Use userId="${userId}". Examples:`,
        ...examples,
      ].join('\n');

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 200,
        stopSequences: [],
      } as any);

      const choice = this.parseActionChoice(response as string, userId);
      if (!choice) {
        console.warn(`[SimulationRuntime] Failed to parse planner response for ${userId}:`, response);
        // Fallback: sleep on persistent parse failure so the pet doesn't loop
        return await this.dispatchAction({ action: 'PET_SLEEP', userId }, message);
      }

      // Dispatch the chosen action
      const result = await this.dispatchAction(choice, message);

      // Phase 3: Track action on the pet state for SSE broadcast + reset cooldown
      if (result) {
        pet.lastActionName = choice.action;
        pet.lastActionResult = result.text ?? (result.success ? 'OK' : 'Failed');
        pet.behaviorCooldown = 100; // prevent rapid re-planning after action
      }

      return result;
    } catch (err) {
      console.error(`[SimulationRuntime] planPetNextAction(${userId}) failed:`, err);
      return null;
    }
  }

  /**
   * Direct action dispatch — used by the bridge to fire PET_VISIT_BUILDING
   * when a pet arrives at its destination (no LLM involvement).
   */
  async dispatchAction(
    choice: { action: string; userId: string; buildingId?: string; itemId?: string },
    messageParam?: Memory,
  ): Promise<ActionResult | null> {
    const runtime = this.getRuntime();
    if (!runtime) return null;

    // Phase 3: Route economic actions (BUY_ITEM, LEARN_SKILL) through Phase 1 action handlers
    const isEconomicAction = choice.action === 'BUY_ITEM' || choice.action === 'LEARN_SKILL' || choice.action === 'CHECK_BALANCE';
    if (isEconomicAction) {
      return this.dispatchEconomicAction(choice);
    }

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
  async generatePetChat(userId: string, buildingId: string): Promise<string | null> {
    if (!this.initialized) return null;
    const runtime = this.getRuntime();
    if (!runtime) return null;

    const pet = this.deps.stateStore.get(userId);
    if (!pet) return null;

    try {
      const prompt = `You are ${pet.name}, a ${pet.species} (${pet.archetype} personality) visiting the ${buildingId} in the ClawVille reef. Say one short sentence about what you see or think. Be playful, under 50 characters. Respond with just the sentence, no quotes.`;

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        maxTokens: 100,
        stopSequences: [],
      } as any);

      const text = (response as string).trim().slice(0, 80).replace(/^["']|["']$/g, '');
      return text;
    } catch (err) {
      console.error('[SimulationRuntime] generatePetChat failed:', err);
      return null;
    }
  }

  /**
   * Phase 3: Dispatch BUY_ITEM / LEARN_SKILL / CHECK_BALANCE via Phase 1 action handlers.
   * These live in ../actions/ and need ClawvilleServices injected via state.
   */
  private async dispatchEconomicAction(
    choice: { action: string; userId: string; itemId?: string },
  ): Promise<ActionResult | null> {
    if (!this.deps.services) {
      console.warn('[SimulationRuntime] Cannot dispatch economic action — no services injected');
      return null;
    }

    const pet = this.deps.stateStore.get(choice.userId);
    if (!pet) {
      console.warn(`[SimulationRuntime] Pet not found for user ${choice.userId}`);
      return { success: false, text: 'Pet not found' } as ActionResult;
    }

    try {
      // Dynamic import the Phase 1 action
      const { allActions } = await import('../actions/index');
      const action = allActions.find((a: any) => a.name === choice.action);
      if (!action) {
        console.warn(`[SimulationRuntime] Phase 1 action not found: ${choice.action}`);
        return { success: false, text: `Unknown action: ${choice.action}` } as ActionResult;
      }

      // Build state with services injected (same shape as processMessage state)
      const state = {
        petId: pet.petId,
        userId: pet.userId,
        services: this.deps.services,
      };

      // Build message with parameters (structured for getParam() lookup)
      const params: Record<string, string> = {};
      if (choice.itemId) params.itemId = choice.itemId;

      const message = {
        content: {
          text: `Execute ${choice.action}`,
          parameters: params,
        },
        parameters: params,
      };

      const result = await action.handler(null, message, state, { parameters: params });

      // Track budget — increment on any purchase attempt, adjust if failed (compensating)
      if (choice.action === 'BUY_ITEM' || choice.action === 'BUY_BAZAAR_LISTING') {
        const spent = result?.data?.price ?? 0;
        if (result?.success) {
          pet.budgetSpent = Math.min(pet.budgetMaxNt, pet.budgetSpent + spent);
          pet.budgetPurchaseCount = Math.min(pet.budgetMaxPurchases, pet.budgetPurchaseCount + 1);
          console.log(`[SimulationRuntime] ${choice.action} for ${pet.name}: spent ${spent} NT (total: ${pet.budgetSpent}/${pet.budgetMaxNt})`);
        }
        // If !result.success, the action handler's compensating credit has already refunded
      }

      return result ?? null;
    } catch (err) {
      console.error(`[SimulationRuntime] dispatchEconomicAction(${choice.action}) failed:`, err);
      return { success: false, text: (err as Error).message };
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

      // Validate action name — Phase 3: includes economic actions
      const validActions = [
        'PET_MOVE_TO_BUILDING', 'PET_RETURN_HOME', 'PET_SLEEP',
        'BUY_ITEM', 'LEARN_SKILL',
      ] as const;
      if (!validActions.includes(parsed.action as (typeof validActions)[number])) return null;

      // Always override userId with the one we know — don't trust LLM hallucinations
      return {
        action: parsed.action as ActionChoice['action'],
        userId,
        buildingId: parsed.buildingId,
        itemId: parsed.itemId,
      };
    } catch {
      return null;
    }
  }
}

export function createSimulationRuntime(deps: SimulationRuntimeDeps): SimulationRuntime {
  return new SimulationRuntime(deps);
}
