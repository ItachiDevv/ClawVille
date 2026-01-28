import type { AvatarSpecies } from '../types/avatar';

export interface SpeciesInfo {
  id: AvatarSpecies;
  name: string;
  description: string;
  emoji: string;
}

export const AVATAR_SPECIES: SpeciesInfo[] = [
  { id: 'cat', name: 'Cat', description: 'A curious and agile feline', emoji: '🐱' },
  { id: 'dragon', name: 'Dragon', description: 'A fierce and majestic dragon', emoji: '🐉' },
  { id: 'fox', name: 'Fox', description: 'A clever and quick-witted fox', emoji: '🦊' },
  { id: 'owl', name: 'Owl', description: 'A wise and watchful owl', emoji: '🦉' },
  { id: 'wolf', name: 'Wolf', description: 'A loyal and strong wolf', emoji: '🐺' },
  { id: 'bunny', name: 'Bunny', description: 'A sweet and bouncy bunny', emoji: '🐰' },
  { id: 'phoenix', name: 'Phoenix', description: 'A radiant and mystical phoenix', emoji: '🔥' },
  { id: 'turtle', name: 'Turtle', description: 'A steady and resilient turtle', emoji: '🐢' },
];

export const SPECIES_IDS = AVATAR_SPECIES.map((s) => s.id);
