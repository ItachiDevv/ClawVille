export type { PetArchetypeId, PetTone } from '../constants/avatar-archetypes';

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
  createdAt: string;
  updatedAt: string;
}
