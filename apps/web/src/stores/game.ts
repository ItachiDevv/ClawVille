import { create } from 'zustand';

export interface GameState {
  // Avatar position (written by Phaser)
  avatarPosition: { x: number; y: number };
  setPetPosition: (x: number, y: number) => void;

  // Near location (written by Phaser when overlapping a building zone)
  nearLocation: string | null;
  setNearLocation: (id: string | null) => void;

  // Current location (when inside a building)
  currentLocation: string | null;

  // Chat panel open state
  chatOpen: boolean;

  // Enter a building
  enterBuilding: (locationId: string) => void;

  // Exit a building
  exitBuilding: () => void;

  // Movement frozen (when chat is open)
  movementFrozen: boolean;
}

export const useGameStore = create<GameState>((set) => ({
  avatarPosition: { x: 400, y: 250 },
  setPetPosition: (x, y) => set({ avatarPosition: { x, y } }),

  nearLocation: null,
  setNearLocation: (id) => set({ nearLocation: id }),

  currentLocation: null,
  chatOpen: false,
  movementFrozen: false,

  enterBuilding: (locationId) =>
    set({
      currentLocation: locationId,
      chatOpen: true,
      movementFrozen: true,
    }),

  exitBuilding: () =>
    set({
      currentLocation: null,
      chatOpen: false,
      movementFrozen: false,
    }),
}));
