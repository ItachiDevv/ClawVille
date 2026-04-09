import { create } from 'zustand';

export type MovementDirection = 'idle' | 'left' | 'right' | 'up' | 'down';

export type ControlMode = 'explore' | 'npc' | 'player' | 'autonomous';

export interface Toast {
  id: string;
  icon: string;
  message: string;
  expiresAt: number;
}

const VISITED_STORAGE_KEY = 'clawville-visited-buildings';

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
  // Control mode — determines how input is routed and how the camera behaves
  controlMode: ControlMode;
  hasAgent: boolean;
  possessedNpcId: string | null;
  setControlMode: (mode: ControlMode) => void;
  toggleControlMode: () => void;
  setHasAgent: (v: boolean) => void;
  setPossessedNpcId: (id: string | null) => void;

  // Spectator mode (no avatar, camera-only) — derived from controlMode; kept for backward compat
  isSpectator: boolean;
  setIsSpectator: (v: boolean) => void;

  // Avatar appearance (species + color for sprite rendering)
  avatarSpecies: string;
  avatarColor: string;
  avatarName: string;
  setPetAppearance: (species: string, color: string, name?: string) => void;

  // Avatar position (written by game loop)
  avatarPosition: { x: number; y: number };
  setPetPosition: (x: number, y: number) => void;

  // Movement direction for sprite animation
  movementDirection: MovementDirection;
  setMovementDirection: (dir: MovementDirection) => void;

  // Avatar speed (0-1 normalized, written by game loop)
  petSpeed: number;
  setPetSpeed: (speed: number) => void;

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

  // Avatar autonomy
  petIsAutonomous: boolean;
  setPetIsAutonomous: (v: boolean) => void;

  // Activity feed
  activityFeedOpen: boolean;
  toggleActivityFeed: () => void;

  // OpenClaw connection (World mode)
  openclawConnected: boolean;
  openclawSessionId: string | null;
  openclawModalOpen: boolean;
  setOpenclawModalOpen: (open: boolean) => void;
  setOpenclawConnection: (sessionId: string | null) => void;

  // Toast notifications
  toasts: Toast[];
  addToast: (icon: string, message: string, durationMs?: number) => void;
  removeToast: (id: string) => void;

  // Skill Builder
  skillBuilderOpen: boolean;
  setSkillBuilderOpen: (open: boolean) => void;

  // Marketplace
  marketplaceOpen: boolean;
  openMarketplace: () => void;
  closeMarketplace: () => void;

  // Bazaar
  bazaarOpen: boolean;
  bazaarTab: 'browse' | 'my-listings' | 'my-purchases';
  openBazaar: () => void;
  closeBazaar: () => void;
  setBazaarTab: (tab: 'browse' | 'my-listings' | 'my-purchases') => void;

  // Auction House
  auctionOpen: boolean;
  auctionTab: 'browse' | 'my-auctions' | 'my-bids';
  openAuction: () => void;
  closeAuction: () => void;
  setAuctionTab: (tab: 'browse' | 'my-auctions' | 'my-bids') => void;

  // Quest Board
  questBoardOpen: boolean;
  questBoardTab: 'available' | 'active' | 'completed';
  openQuestBoard: () => void;
  closeQuestBoard: () => void;
  setQuestBoardTab: (tab: 'available' | 'active' | 'completed') => void;

  // Bounty Board
  bountyBoardOpen: boolean;
  bountyBoardTab: 'browse' | 'my-bounties' | 'my-attempts' | 'create';
  openBountyBoard: () => void;
  closeBountyBoard: () => void;
  setBountyBoardTab: (tab: 'browse' | 'my-bounties' | 'my-attempts' | 'create') => void;

  // Zoom
  zoomLevel: number;
  setZoomLevel: (z: number) => void;

  // Click-to-move pathfinding
  clickPath: { x: number; y: number }[] | null;
  clickPathIndex: number;
  clickPathTarget: string | null;
  setClickPath: (path: { x: number; y: number }[], target?: string | null) => void;
  advanceClickPath: () => void;
  clearClickPath: () => void;

  // Building hover tooltip
  hoveredBuilding: string | null;
  setHoveredBuilding: (id: string | null) => void;
  mousePosition: { x: number; y: number };
  setMousePosition: (x: number, y: number) => void;

  // Floating text queue (consumed by PixiCanvas)
  pendingFloatingTexts: Array<{ text: string; color: number }>;
  addFloatingText: (text: string, color: number) => void;
  consumeFloatingTexts: () => Array<{ text: string; color: number }>;

  // Avatar level & XP
  petLevel: number;
  petXp: number;
  setPetLevel: (level: number, xp: number) => void;

  // Daily login streak
  dailyLoginClaimed: boolean;
  loginStreak: number;
  setDailyLoginClaimed: (claimed: boolean, streak?: number) => void;

  // Arena settings
  arenaSettings: {
    combatSpeed: number;   // 0.5 - 3, default 1
    moveSpeed: number;     // 0.5 - 3, default 1
    maxFights: number;     // 1 - 10, default 3
    respawnTime: number;   // 1 - 30, default 5 (seconds)
  };
  arenaSettingsOpen: boolean;
  setArenaSettingsOpen: (open: boolean) => void;
  updateArenaSetting: <K extends keyof GameState['arenaSettings']>(key: K, value: GameState['arenaSettings'][K]) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  controlMode: 'explore',
  hasAgent: false,
  possessedNpcId: null,
  setControlMode: (mode) =>
    set({
      controlMode: mode,
      isSpectator: mode === 'explore' || mode === 'npc',
    }),
  toggleControlMode: () => {
    const { hasAgent, controlMode } = get();
    if (!hasAgent) {
      const next: ControlMode = controlMode === 'explore' ? 'npc' : 'explore';
      set({ controlMode: next, isSpectator: next === 'explore' || next === 'npc' });
    } else {
      const next: ControlMode = controlMode === 'player' ? 'autonomous' : 'player';
      set({ controlMode: next, isSpectator: false });
    }
  },
  setHasAgent: (v) =>
    set((s) => ({
      hasAgent: v,
      controlMode: v ? 'player' : 'explore',
      isSpectator: !v,
      // clear possessed NPC when agent connects so modes don't conflict
      possessedNpcId: v ? null : s.possessedNpcId,
    })),
  setPossessedNpcId: (id) => set({ possessedNpcId: id }),

  isSpectator: true,
  setIsSpectator: (v) => set({ isSpectator: v }),

  avatarSpecies: 'cat',
  avatarColor: 'yellow',
  avatarName: '',
  setPetAppearance: (species, color, name) => set({ avatarSpecies: species, avatarColor: color, ...(name ? { avatarName: name } : {}) }),

  avatarPosition: { x: 400, y: 250 },
  setPetPosition: (x, y) => set({ avatarPosition: { x, y } }),

  movementDirection: 'idle',
  setMovementDirection: (dir) => set({ movementDirection: dir }),

  petSpeed: 0,
  setPetSpeed: (speed) => set({ petSpeed: speed }),

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
    // Floating "Welcome!" text
    get().addFloatingText('Welcome!', 0xffffff);
    // Track discovery
    const isNew = get().markBuildingVisited(locationId);
    if (isNew) {
      get().addToast('🏠', 'New location discovered!');
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
    const current = get().visitedBuildings;
    if (current.has(id)) return false;
    const updated = new Set(current);
    updated.add(id);
    saveVisited(updated);
    set({ visitedBuildings: updated });
    return true;
  },

  petIsAutonomous: false,
  setPetIsAutonomous: (v) => set({ petIsAutonomous: v }),

  activityFeedOpen: false,
  toggleActivityFeed: () => set((s) => ({ activityFeedOpen: !s.activityFeedOpen })),

  openclawConnected: false,
  openclawSessionId: null,
  openclawModalOpen: false,
  setOpenclawModalOpen: (open) => set({ openclawModalOpen: open }),
  setOpenclawConnection: (sessionId) =>
    set({
      openclawConnected: !!sessionId,
      openclawSessionId: sessionId,
      openclawModalOpen: false,
    }),

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

  skillBuilderOpen: false,
  setSkillBuilderOpen: (open) => set({ skillBuilderOpen: open }),

  marketplaceOpen: false,
  openMarketplace: () => set({ marketplaceOpen: true }),
  closeMarketplace: () => set({ marketplaceOpen: false }),

  bazaarOpen: false,
  bazaarTab: 'browse' as const,
  openBazaar: () => set({ bazaarOpen: true, bazaarTab: 'browse' }),
  closeBazaar: () => set({ bazaarOpen: false }),
  setBazaarTab: (tab: 'browse' | 'my-listings' | 'my-purchases') => set({ bazaarTab: tab }),

  auctionOpen: false,
  auctionTab: 'browse' as const,
  openAuction: () => set({ auctionOpen: true, auctionTab: 'browse' }),
  closeAuction: () => set({ auctionOpen: false }),
  setAuctionTab: (tab: 'browse' | 'my-auctions' | 'my-bids') => set({ auctionTab: tab }),

  questBoardOpen: false,
  questBoardTab: 'available' as const,
  openQuestBoard: () => set({ questBoardOpen: true, questBoardTab: 'available' }),
  closeQuestBoard: () => set({ questBoardOpen: false }),
  setQuestBoardTab: (tab: 'available' | 'active' | 'completed') => set({ questBoardTab: tab }),

  bountyBoardOpen: false,
  bountyBoardTab: 'browse' as const,
  openBountyBoard: () => set({ bountyBoardOpen: true, bountyBoardTab: 'browse' }),
  closeBountyBoard: () => set({ bountyBoardOpen: false }),
  setBountyBoardTab: (tab: 'browse' | 'my-bounties' | 'my-attempts' | 'create') => set({ bountyBoardTab: tab }),

  zoomLevel: 1.7,
  setZoomLevel: (z) => set({ zoomLevel: Math.max(0.6, Math.min(3.0, z)) }),

  clickPath: null,
  clickPathIndex: 0,
  clickPathTarget: null,
  setClickPath: (path, target = null) => set({ clickPath: path, clickPathIndex: 0, clickPathTarget: target }),
  advanceClickPath: () => set((s) => {
    const nextIndex = s.clickPathIndex + 1;
    if (!s.clickPath || nextIndex >= s.clickPath.length) {
      return { clickPath: null, clickPathIndex: 0, clickPathTarget: null };
    }
    return { clickPathIndex: nextIndex };
  }),
  clearClickPath: () => set({ clickPath: null, clickPathIndex: 0, clickPathTarget: null }),

  hoveredBuilding: null,
  setHoveredBuilding: (id) => set({ hoveredBuilding: id }),
  mousePosition: { x: 0, y: 0 },
  setMousePosition: (x, y) => set({ mousePosition: { x, y } }),

  pendingFloatingTexts: [],
  addFloatingText: (text, color) => set((s) => ({
    pendingFloatingTexts: [...s.pendingFloatingTexts, { text, color }],
  })),
  consumeFloatingTexts: () => {
    const texts = get().pendingFloatingTexts;
    if (texts.length === 0) return [];
    set({ pendingFloatingTexts: [] });
    return texts;
  },

  petLevel: 1,
  petXp: 0,
  setPetLevel: (level, xp) => set({ petLevel: level, petXp: xp }),

  dailyLoginClaimed: false,
  loginStreak: 0,
  setDailyLoginClaimed: (claimed, streak) => set({ dailyLoginClaimed: claimed, ...(streak !== undefined ? { loginStreak: streak } : {}) }),

  arenaSettings: {
    combatSpeed: 1,
    moveSpeed: 1,
    maxFights: 3,
    respawnTime: 5,
  },
  arenaSettingsOpen: false,
  setArenaSettingsOpen: (open) => set({ arenaSettingsOpen: open }),
  updateArenaSetting: (key, value) => set((s) => ({
    arenaSettings: { ...s.arenaSettings, [key]: value },
  })),
}));
