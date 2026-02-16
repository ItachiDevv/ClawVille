import type { AvatarSpecies } from '../types/avatar';

export interface SpeciesInfo {
  id: AvatarSpecies;
  name: string;
  description: string;
  emoji: string;
}

export const AVATAR_SPECIES: SpeciesInfo[] = [
  { id: 'cat', name: 'Reef Lobster', description: 'A nimble lobster with delicate coral-tipped claws', emoji: '🦞' },
  { id: 'dragon', name: 'Abyssal Lobster', description: 'A deep-sea lobster with bioluminescent armor', emoji: '🦞' },
  { id: 'fox', name: 'Spiny Lobster', description: 'A fast, antenna-whipping spiny lobster', emoji: '🦞' },
  { id: 'owl', name: 'Hermit Lobster', description: 'A wise lobster who carries a shell of knowledge', emoji: '🦞' },
  { id: 'wolf', name: 'Crusher Lobster', description: 'A powerful lobster with massive crushing claws', emoji: '🦞' },
  { id: 'bunny', name: 'Bubble Lobster', description: 'A playful lobster that blows tiny bubbles', emoji: '🦞' },
  { id: 'phoenix', name: 'Mantis Lobster', description: 'A dazzling lobster with rainbow-striking appendages', emoji: '🦞' },
  { id: 'turtle', name: 'Iron Lobster', description: 'A heavily armored lobster with an impenetrable carapace', emoji: '🦞' },
];

export const SPECIES_IDS = AVATAR_SPECIES.map((s) => s.id);
