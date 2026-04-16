export type { PetArchetypeId, PetTone } from '../constants/avatar-archetypes';
import type { AgentCategory, AgentHarness } from '../constants/agent-models';

export type AvatarSpecies = 'cat' | 'dragon' | 'fox' | 'owl' | 'wolf' | 'bunny' | 'phoenix' | 'turtle';
export type AvatarColor = 'green' | 'red' | 'blue' | 'yellow';
export type AvatarGender = 'male' | 'female';

export type PetHabitat = 'forest' | 'sea' | 'mountain' | 'sky' | 'desert' | 'cave';
export type PetHobby = 'reading-and-learning' | 'exploring' | 'battling' | 'collecting' | 'cooking' | 'art';
export type PetGreeting = 'run-away' | 'wave-hello' | 'tackle-hug' | 'shy-peek' | 'bow-politely' | 'roar';

export interface PetPersonality {
  habitat: PetHabitat;
  hobby: PetHobby;
  greeting: PetGreeting;
}

export interface PetStats {
  strength: number;
  defence: number;
  movement: number;
}

export interface Avatar {
  id: string;
  userId: string;
  name: string;
  species: AvatarSpecies;
  color: AvatarColor;
  gender: AvatarGender;
  archetype: string;
  personality: PetPersonality;
  stats: PetStats;
  positionX: number;
  positionY: number;
  /**
   * Phase 2: stable 3D model key — drives GLB selection in player-avatar.tsx.
   * NOT NULL in DB (DEFAULT 'lobster'); required on the client type so
   * consumers don't have to null-check every render.
   */
  modelKey: string;
  /** Phase 2: agent framework category — NOT NULL in DB (DEFAULT 'openclaw') */
  agentCategory: AgentCategory;
  /** Phase 2: preferred runtime harness — NOT NULL in DB (DEFAULT 'milady') */
  harness: AgentHarness;
  createdAt: string;
  updatedAt: string;
}
