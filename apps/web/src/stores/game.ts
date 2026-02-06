import { create } from 'zustand';

export type MovementDirection = 'idle' | 'left' | 'right' | 'up' | 'down';

export interface GameState {
  // Avatar appearance (species + color for sprite rendering)
  avatarSpecies: string;
  avatarColor: string;
  setPetAppearance: (species: string, color: string) => void;

  // Avatar position (written by game loop)
  avatarPosition: { x: number; y: number };
  setPetPosition: (x: number, y: number) => void;

  // Movement direction for sprite animation
  movementDirection: MovementDirection;
  setMovementDirection: (dir: MovementDirection) => void;

  // Near location (written by game loop when overlapping a building zone)
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

  // Game menu
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;

  // Avatar settings modal
  settingsModalOpen: boolean;
  setSettingsModalOpen: (open: boolean) => void;

  // Location config modal
  locationConfigModalOpen: boolean;
  locationConfigTarget: string | null;
  openLocationConfig: (locationId: string) => void;
  closeLocationConfig: () => void;

  // Joystick velocity from mobile controls (0-1 range)
  joystickVelocity: { x: number; y: number };
  setJoystickVelocity: (x: number, y: number) => void;
}

export const useGameStore = create<GameState>((set) => ({
  avatarSpecies: 'cat',
  avatarColor: 'yellow',
  setPetAppearance: (species, color) => set({ avatarSpecies: species, avatarColor: color }),

  avatarPosition: { x: 400, y: 250 },
  setPetPosition: (x, y) => set({ avatarPosition: { x, y } }),

  movementDirection: 'idle',
  setMovementDirection: (dir) => set({ movementDirection: dir }),

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

  menuOpen: false,
  setMenuOpen: (open) => set({ menuOpen: open }),

  settingsModalOpen: false,
  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),

  locationConfigModalOpen: false,
  locationConfigTarget: null,
  openLocationConfig: (locationId) =>
    set({
      locationConfigModalOpen: true,
      locationConfigTarget: locationId,
    }),
  closeLocationConfig: () =>
    set({
      locationConfigModalOpen: false,
      locationConfigTarget: null,
    }),

  joystickVelocity: { x: 0, y: 0 },
  setJoystickVelocity: (x, y) => set({ joystickVelocity: { x, y } }),
}));
