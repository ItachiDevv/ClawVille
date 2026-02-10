import { create } from 'zustand';

export type MovementDirection = 'idle' | 'left' | 'right' | 'up' | 'down';

export interface Toast {
  id: string;
  icon: string;
  message: string;
  expiresAt: number;
}

const VISITED_STORAGE_KEY = 'legacyapp-visited-buildings';

function loadVisited(): Set<string> {
  try {
    const raw = localStorage.getItem(VISITED_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveVisited(visited: Set<string>) {
  localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify([...visited]));
}

export interface GameState {
  // Spectator mode (no pet, camera-only)
  isSpectator: boolean;
  setIsSpectator: (v: boolean) => void;

  // Pet appearance (species + color for sprite rendering)
  petSpecies: string;
  petColor: string;
  setPetAppearance: (species: string, color: string) => void;

  // Pet position (written by game loop)
  petPosition: { x: number; y: number };
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

  // Pet settings modal
  settingsModalOpen: boolean;
  setSettingsModalOpen: (open: boolean) => void;

  // Location config modal
  locationConfigModalOpen: boolean;
  locationConfigTarget: string | null;
  openLocationConfig: (locationId: string) => void;
  closeLocationConfig: () => void;

  // Inventory modal
  inventoryOpen: boolean;
  openInventory: () => void;
  closeInventory: () => void;

  // Shop overlay
  shopOpen: boolean;
  openShop: () => void;
  closeShop: () => void;

  // Joystick velocity from mobile controls (0-1 range)
  joystickVelocity: { x: number; y: number };
  setJoystickVelocity: (x: number, y: number) => void;

  // Discovery tracker
  visitedBuildings: Set<string>;
  markBuildingVisited: (id: string) => boolean; // returns true if newly discovered

  // Toast notifications
  toasts: Toast[];
  addToast: (icon: string, message: string, durationMs?: number) => void;
  removeToast: (id: string) => void;
}

export const useGameStore = create<GameState>((set) => ({
  isSpectator: false,
  setIsSpectator: (v) => set({ isSpectator: v }),

  petSpecies: 'cat',
  petColor: 'yellow',
  setPetAppearance: (species, color) => set({ petSpecies: species, petColor: color }),

  petPosition: { x: 400, y: 250 },
  setPetPosition: (x, y) => set({ petPosition: { x, y } }),

  movementDirection: 'idle',
  setMovementDirection: (dir) => set({ movementDirection: dir }),

  nearLocation: null,
  setNearLocation: (id) => set({ nearLocation: id }),

  currentLocation: null,
  chatOpen: false,
  movementFrozen: false,

  enterBuilding: (locationId) => {
    set({
      currentLocation: locationId,
      chatOpen: true,
      movementFrozen: true,
    });
    // Track discovery
    const isNew = useGameStore.getState().markBuildingVisited(locationId);
    if (isNew) {
      useGameStore.getState().addToast('🏠', 'New location discovered!');
    }
  },

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

  inventoryOpen: false,
  openInventory: () => set({ inventoryOpen: true }),
  closeInventory: () => set({ inventoryOpen: false }),

  shopOpen: false,
  openShop: () => set({ shopOpen: true }),
  closeShop: () => set({ shopOpen: false }),

  joystickVelocity: { x: 0, y: 0 },
  setJoystickVelocity: (x, y) => set({ joystickVelocity: { x, y } }),

  visitedBuildings: typeof window !== 'undefined' ? loadVisited() : new Set(),
  markBuildingVisited: (id) => {
    const current = useGameStore.getState().visitedBuildings;
    if (current.has(id)) return false;
    const updated = new Set(current);
    updated.add(id);
    saveVisited(updated);
    set({ visitedBuildings: updated });
    return true;
  },

  toasts: [],
  addToast: (icon, message, durationMs = 3000) => {
    const toast: Toast = {
      id: crypto.randomUUID(),
      icon,
      message,
      expiresAt: Date.now() + durationMs,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== toast.id) }));
    }, durationMs);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
