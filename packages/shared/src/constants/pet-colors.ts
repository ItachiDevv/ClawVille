import type { PetColor } from '../types/pet';

export interface ColorInfo {
  id: PetColor;
  name: string;
  hex: string;
}

export const PET_COLORS: ColorInfo[] = [
  { id: 'green', name: 'Green', hex: '#4CAF50' },
  { id: 'red', name: 'Red', hex: '#F44336' },
  { id: 'blue', name: 'Blue', hex: '#2196F3' },
  { id: 'yellow', name: 'Yellow', hex: '#FFEB3B' },
];

export const COLOR_IDS = PET_COLORS.map((c) => c.id);
