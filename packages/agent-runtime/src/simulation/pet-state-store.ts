/**
 * PetStateStore — shared state holder for the simulation runtime.
 *
 * Owns the authoritative in-memory state of all autonomous pets. Actions
 * registered on the SimulationRuntime mutate this store; the bridge in
 * apps/api reads from it to produce the SSE snapshot.
 *
 * Why a dedicated store and not runtime.setSetting / memory:
 * - Movement is per-tick (500ms); runtime memory writes are too heavy
 * - Path data is high-frequency ephemeral state, not knowledge to persist
 * - The bridge needs a hot read path for every SSE broadcast
 */

import type { PathNode, NpcActivity, PetDirection } from './types';

export interface PetSimState {
  petId: string;
  userId: string;
  name: string;
  species: string;
  color: string;
  archetype: string;
  x: number;
  y: number;
  direction: PetDirection;
  activity: NpcActivity;
  activityEmoji: string;
  destinationBuildingId: string | null;
  path: PathNode[];
  pathIndex: number;
  isAutonomous: boolean;
  lastUserInputAt: number;
  tokensEarned: number;
  visitCount: number;
  activityEndsAt: number;
  behaviorCooldown: number;
  lastChatAt: number;
  chatMessage: string | null;

  // Phase 3: Autonomy budget controls
  /** Max ClawTokens the pet may spend per autonomous session */
  budgetMaxNt: number;
  /** Max item purchases per autonomous session */
  budgetMaxPurchases: number;
  /** ClawTokens spent so far this session */
  budgetSpent: number;
  /** Purchases made this session */
  budgetPurchaseCount: number;
  /** Last action dispatched (for SSE broadcast) */
  lastActionName: string | null;
  /** Last action result text (for SSE broadcast) */
  lastActionResult: string | null;
}

/** SSE broadcast shape — only the fields the client needs to render */
export interface PetSimBroadcast {
  petId: string;
  userId: string;
  name: string;
  species: string;
  color: string;
  x: number;
  y: number;
  direction: PetDirection;
  activity: NpcActivity;
  activityEmoji: string;
  isAutonomous: boolean;
  chatMessage: string | null;
  // Phase 3 enrichment
  lastActionName: string | null;
  lastActionResult: string | null;
  budgetSpent: number;
  budgetPurchaseCount: number;
}

export interface PetRegistrationInput {
  petId: string;
  userId: string;
  name: string;
  species: string;
  color: string;
  archetype: string;
  positionX: number;
  positionY: number;
}

export class PetStateStore {
  private pets: Map<string, PetSimState> = new Map(); // userId -> state

  has(userId: string): boolean {
    return this.pets.has(userId);
  }

  register(input: PetRegistrationInput): void {
    if (this.pets.has(input.userId)) return;

    this.pets.set(input.userId, {
      petId: input.petId,
      userId: input.userId,
      name: input.name,
      species: input.species,
      color: input.color,
      archetype: input.archetype,
      x: input.positionX,
      y: input.positionY,
      direction: 'idle',
      activity: 'idle',
      activityEmoji: '',
      destinationBuildingId: null,
      path: [],
      pathIndex: 0,
      isAutonomous: false,
      lastUserInputAt: Date.now(),
      tokensEarned: 0,
      visitCount: 0,
      activityEndsAt: 0,
      behaviorCooldown: 0,
      lastChatAt: 0,
      chatMessage: null,
      budgetMaxNt: 100,
      budgetMaxPurchases: 5,
      budgetSpent: 0,
      budgetPurchaseCount: 0,
      lastActionName: null,
      lastActionResult: null,
    });
  }

  unregister(userId: string): void {
    this.pets.delete(userId);
  }

  get(userId: string): PetSimState | undefined {
    return this.pets.get(userId);
  }

  getByPetId(petId: string): PetSimState | undefined {
    for (const pet of this.pets.values()) {
      if (pet.petId === petId) return pet;
    }
    return undefined;
  }

  all(): PetSimState[] {
    return Array.from(this.pets.values());
  }

  reportUserActivity(userId: string, x?: number, y?: number): void {
    const pet = this.pets.get(userId);
    if (!pet) return;

    pet.lastUserInputAt = Date.now();

    // If pet was autonomous, snap back to user control
    if (pet.isAutonomous) {
      pet.isAutonomous = false;
      pet.activity = 'idle';
      pet.activityEmoji = '';
      pet.path = [];
      pet.pathIndex = 0;
      pet.destinationBuildingId = null;
      pet.tokensEarned = 0;
      pet.visitCount = 0;
      pet.chatMessage = null;
      pet.budgetSpent = 0;
      pet.budgetPurchaseCount = 0;
      pet.lastActionName = null;
      pet.lastActionResult = null;
    }

    if (x !== undefined && y !== undefined) {
      pet.x = x;
      pet.y = y;
    }
  }

  /** Returns the SSE payload shape — only the fields the client needs */
  getBroadcast(): PetSimBroadcast[] {
    return Array.from(this.pets.values())
      .filter((p) => p.isAutonomous)
      .map((p) => ({
        petId: p.petId,
        userId: p.userId,
        name: p.name,
        species: p.species,
        color: p.color,
        x: p.x,
        y: p.y,
        direction: p.direction,
        activity: p.activity,
        activityEmoji: p.activityEmoji,
        isAutonomous: p.isAutonomous,
        chatMessage: p.chatMessage,
        lastActionName: p.lastActionName,
        lastActionResult: p.lastActionResult,
        budgetSpent: p.budgetSpent,
        budgetPurchaseCount: p.budgetPurchaseCount,
      }));
  }
}
