import type { AvatarColor } from '../types/avatar';

export interface ColorInfo {
  id: AvatarColor;
  name: string;
  hex: string;
}

export const AVATAR_COLORS: ColorInfo[] = [
  { id: 'green', name: 'Green', hex: '#4CAF50' },
  { id: 'red', name: 'Red', hex: '#F44336' },
  { id: 'blue', name: 'Blue', hex: '#2196F3' },
  { id: 'yellow', name: 'Yellow', hex: '#FFEB3B' },
];

export const COLOR_IDS = AVATAR_COLORS.map((c) => c.id);
