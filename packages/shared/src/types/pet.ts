export type { PetArchetypeId, PetTone } from '../constants/pet-archetypes';

export type PetSpecies = 'cat' | 'dragon' | 'fox' | 'owl' | 'wolf' | 'bunny' | 'phoenix' | 'turtle';
export type PetColor = 'green' | 'red' | 'blue' | 'yellow';
export type PetGender = 'male' | 'female';

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

export interface Pet {
  id: string;
  userId: string;
  name: string;
  species: PetSpecies;
  color: PetColor;
  gender: PetGender;
  archetype: string;
  personality: PetPersonality;
  stats: PetStats;
  positionX: number;
  positionY: number;
  createdAt: string;
  updatedAt: string;
}
