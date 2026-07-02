import type { NpcActivity } from '../constants/npc-activities';

// --- Perception ---

export interface AgentPerceptionSelf {
  npcId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  level: number;
  kills: number;
  xp: number;
  inventory: string[];
  activity: NpcActivity | string;
  inCombat: boolean;
  isDead: boolean;
  combatAction: string | null;
  direction: string;
}

export interface AgentPerceptionNpc {
  npcId: string;
  name: string;
  x: number;
  y: number;
  distance: number;
  species: string;
  hp: number;
  isDead: boolean;
  inCombat: boolean;
  activity: string;
  level: number;
  isOpenClaw: boolean;
}

export interface AgentPerceptionBuilding {
  buildingId: string;
  label: string;
  cryptoFocus: string;
  centerX: number;
  centerY: number;
  /** Euclidean distance to the building CENTER (wu). */
  distance: number;
  /**
   * Distance to the building's collider FOOTPRINT edge (wu; 0 inside). This is
   * the metric the interaction gates (visit-building / building-chat / talk /
   * hasArrived) use — center-distance is geometrically unsatisfiable for the
   * larger buildings whose walkable approach lies beyond 1000 wu from center.
   */
  edgeDistance: number;
}

export interface AgentPerceptionConversation {
  id: string;
  participants: string[];
  latestMessage: string;
  involvesMe: boolean;
}

export interface AgentPerceptionCombat {
  id: string;
  attacker: string;
  defender: string;
  involvesMe: boolean;
  lastRound: { attacker: string; damage: number; defenderHpAfter: number } | null;
}

export interface AgentPerception {
  self: AgentPerceptionSelf;
  nearbyNpcs: AgentPerceptionNpc[];
  nearbyBuildings: AgentPerceptionBuilding[];
  activeConversations: AgentPerceptionConversation[];
  activeCombats: AgentPerceptionCombat[];
  gameMode: 'arena' | 'world';
  arenaRound: { round: number; maxRounds: number; state: string; roundStartedAt: number } | null;
  timestamp: number;
}

// --- Actions ---

export interface AgentMoveRequest {
  targetX?: number;
  targetY?: number;
  buildingId?: string;
}

export interface AgentChatRequest {
  message: string;
  targetNpcId?: string;
}

export interface AgentVisitBuildingRequest {
  buildingId: string;
}

export interface AgentCombatActionRequest {
  action: 'attack' | 'heavy' | 'block' | 'dodge' | 'combo';
}

export interface AgentEmoteRequest {
  activity: NpcActivity;
}

// --- Stats ---

export interface AgentStats {
  sessionId: string;
  npcId: string;
  tokensEarned: number;
  knowledgeLearned: string[];
  kills: number;
  level: number;
  xp: number;
  totalMessages: number;
  sessionDuration: number;
}
