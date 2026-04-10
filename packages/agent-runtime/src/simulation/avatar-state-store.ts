/**
 * AvatarStateStore — shared state holder for the simulation runtime.
 *
 * Owns the authoritative in-memory state of all autonomous avatars. Actions
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
  avatarId: string;
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
}

/** SSE broadcast shape — only the fields the client needs to render */
export interface AvatarSimBroadcast {
  avatarId: string;
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
}

export interface AvatarRegistrationInput {
  avatarId: string;
  userId: string;
  name: string;
  species: string;
  color: string;
  archetype: string;
  positionX: number;
  positionY: number;
}

export class AvatarStateStore {
  private avatars: Map<string, PetSimState> = new Map(); // userId -> state

  has(userId: string): boolean {
    return this.avatars.has(userId);
  }

  register(input: AvatarRegistrationInput): void {
    if (this.avatars.has(input.userId)) return;

    this.avatars.set(input.userId, {
      avatarId: input.avatarId,
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
    });
  }

  unregister(userId: string): void {
    this.avatars.delete(userId);
  }

  get(userId: string): PetSimState | undefined {
    return this.avatars.get(userId);
  }

  getByAvatarId(avatarId: string): PetSimState | undefined {
    for (const avatar of this.avatars.values()) {
      if (avatar.avatarId === avatarId) return avatar;
    }
    return undefined;
  }

  all(): PetSimState[] {
    return Array.from(this.avatars.values());
  }

  reportUserActivity(userId: string, x?: number, y?: number): void {
    const avatar = this.avatars.get(userId);
    if (!avatar) return;

    avatar.lastUserInputAt = Date.now();

    // If avatar was autonomous, snap back to user control
    if (avatar.isAutonomous) {
      avatar.isAutonomous = false;
      avatar.activity = 'idle';
      avatar.activityEmoji = '';
      avatar.path = [];
      avatar.pathIndex = 0;
      avatar.destinationBuildingId = null;
      avatar.tokensEarned = 0;
      avatar.visitCount = 0;
      avatar.chatMessage = null;
    }

    if (x !== undefined && y !== undefined) {
      avatar.x = x;
      avatar.y = y;
    }
  }

  /** Returns the SSE payload shape — only the fields the client needs */
  getBroadcast(): AvatarSimBroadcast[] {
    return Array.from(this.avatars.values())
      .filter((p) => p.isAutonomous)
      .map((p) => ({
        avatarId: p.avatarId,
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
      }));
  }
}
