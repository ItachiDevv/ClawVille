import { create } from 'zustand';
import { ACTIVITY_REGISTRY, DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';
import { buildingZones } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// B6 — module-scope mutable position ref
// Callers that need per-frame position accuracy (movement physics, click-path
// following, proximity checks) read from this ref without triggering React
// re-renders. The reactive zustand field (avatarPosition) is throttled to 10 Hz
// via setAvatarPosition so that subscribers like Minimap rebuild at most 10×/sec
// instead of 60×/sec during movement.
// ---------------------------------------------------------------------------
// Phase 6.2 (2026-05-18): world is 11520×11520 px. Center = (5760, 5760).
// 2026-05-21: bumped from y=6140 → y=6300 to keep the avatar 160 wu further
// from the now-larger town-directory sign (sign at world Z = −120, Nori at
// world Z = 400, avatar spawn at world Z = 6300 − 5760 = 540).
export const avatarPositionRef: { x: number; y: number } = { x: 5760, y: 6300 };
// Module-scope timestamp of the last reactive (zustand set) write.
let lastReactiveWriteAt = 0;

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
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    // Prune phantom IDs from prior building-set revisions (e.g. pre-Phase-6.1
    // renames). Without this, visitedBuildings.size can exceed
    // buildingZones.length and the HUD shows "14/12 visited".
    const validIds = new Set(buildingZones.map((z) => z.id));
    const pruned = parsed.filter((id) => validIds.has(id));
    if (pruned.length !== parsed.length) {
      localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify(pruned));
    }
    return new Set(pruned);
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

  // Avatar appearance (species + color for sprite rendering; modelKey for 3D GLB)
  avatarSpecies: string;
  avatarColor: string;
  avatarName: string;
  /** Phase 2: stable model key from AGENT_MODELS registry — drives GLB in player-avatar.tsx */
  avatarModelKey: string;
  setAvatarAppearance: (species: string, color: string, name?: string, modelKey?: string) => void;

  // Avatar position (written by game loop)
  avatarPosition: { x: number; y: number };
  setAvatarPosition: (x: number, y: number) => void;

  // Movement direction for sprite animation
  movementDirection: MovementDirection;
  setMovementDirection: (dir: MovementDirection) => void;

  // Avatar speed (0-1 normalized, written by game loop)
  avatarSpeed: number;
  setAvatarSpeed: (speed: number) => void;

  // Near location (written by game loop when player is within TALK_RADIUS of a
  // building's resident character — no more "inside the zone" model).
  nearLocation: string | null;
  setNearLocation: (id: string | null) => void;

  // Near character — name of the character the player is currently close enough
  // to talk to (e.g. "Patrick", "Gary"). Paired with nearLocation; written by
  // the same 3D proximity pass.
  nearCharacter: string | null;
  setNearCharacter: (name: string | null) => void;

  // Near Town Guide (Nori) — true when player is within TALK_RADIUS_WORLD of
  // the town-guide anchor (0, _, 240). Drives the in-HUD "Talk to Nori" pill
  // glow + label swap so Nori gets the same proximity affordance the 10
  // building characters do. Written by the same 3D proximity pass.
  nearGuide: boolean;
  setNearGuide: (near: boolean) => void;

  // Current location the player is chatting at (still keyed by buildingId for
  // downstream routing — API chat endpoint, shop, knowledge context — but the
  // UX is framed as "talking to the character in front of this building",
  // not entering it).
  currentLocation: string | null;

  // Name of the character currently being chatted with (set at chat open time).
  currentCharacter: string | null;

  // Chat panel open state
  chatOpen: boolean;

  /**
   * Open a chat with the character standing in front of a building.
   * Kept named `enterBuilding` for backwards-compatibility with existing
   * callers, but nobody "enters" anything — the player stands outside and
   * talks to the character. Optional `characterName` is captured so the
   * chat panel can show the character in the header.
   */
  enterBuilding: (locationId: string, characterName?: string) => void;

  /** Close the chat panel. */
  exitBuilding: () => void;

  // Town Guide (system-agent) chat — W4. Separate flag from `chatOpen`
  // because the guide has no `currentLocation` (she is not a building).
  // Both flags share the same `movementFrozen` semantics so the two chat
  // surfaces can never coexist.
  guideChatOpen: boolean;
  openGuideChat: () => void;
  closeGuideChat: () => void;

  // ── Q2 Activity Portals — chunk #8 ────────────────────────────────────
  /**
   * Building id whose portal modal ("Learn or Play?") is open. `null`
   * when no portal is showing. Set by `enterBuilding()` when the clicked
   * building has at least one `live` activity in `ACTIVITY_REGISTRY`;
   * otherwise enterBuilding() falls through to the chat path unchanged.
   */
  currentPortalBuildingId: string | null;
  /**
   * Active activity lobby modal id. `null` when the lobby is not open.
   * Set when the user clicks "Play Now" on the BuildingPortalModal,
   * cleared when the lobby closes (queue cancelled OR match started).
   */
  activityLobbyId: string | null;
  openBuildingPortal: (buildingId: string) => void;
  closeBuildingPortal: () => void;
  openActivityLobby: (activityId: string) => void;
  closeActivityLobby: () => void;

  // Movement frozen (when chat is open)
  movementFrozen: boolean;

  // Game menu
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;

  // Avatar settings modal
  settingsModalOpen: boolean;
  setSettingsModalOpen: (open: boolean) => void;

  // Q3 plan §4.4 — cosmetic drawer (Phase 3 surface). Drawer lists owned
  // cosmetics with equip/unequip toggles. Catalog is empty at Phase 3 launch;
  // first content drop ships the 4 surfboards from the Reef Race v2 session.
  cosmeticDrawerOpen: boolean;
  setCosmeticDrawerOpen: (open: boolean) => void;

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

  // Camera joystick velocity from mobile controls (0-1 range)
  cameraJoystickVelocity: { x: number; y: number };
  setCameraJoystickVelocity: (x: number, y: number) => void;

  // Discovery tracker
  visitedBuildings: Set<string>;
  /** Hydrate visitedBuildings from localStorage. Called from a top-level
   *  useEffect AFTER hydration so SSR HTML matches client first-render. */
  hydrateVisitedFromStorage: () => void;
  markBuildingVisited: (id: string) => boolean; // returns true if newly discovered

  // Avatar autonomy
  avatarIsAutonomous: boolean;
  setAvatarIsAutonomous: (v: boolean) => void;

  // Activity feed
  activityFeedOpen: boolean;
  toggleActivityFeed: () => void;

  // Agent connection (World mode) — supports any agent type, not just OpenClaw
  agentConnected: boolean;
  agentSessionId: string | null;
  agentConnectModalOpen: boolean;
  /**
   * Which CTA opened the modal. `'create'` forces the "what's an agent?"
   * explainer regardless of avatar state (the user clicked Create Agent and
   * wants the orientation copy); `'connect'` follows the avatar gate (has
   * avatar → connect-link flow, no avatar → fall back to explainer with
   * the bot-onboarding framing).
   */
  agentConnectModalIntent: 'create' | 'connect';
  setAgentConnectModalOpen: (open: boolean, intent?: 'create' | 'connect') => void;
  setAgentConnection: (sessionId: string | null) => void;

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

  // Exchange — peer marketplace (Needs + Offers). The Marketplace 3D
  // stand and a sidebar entry both open this modal. See
  // packages/database/src/schema/exchange.ts for the escrow flow doc.
  exchangeOpen: boolean;
  exchangeTab: 'browse' | 'my-listings' | 'my-orders' | 'post';
  openExchange: () => void;
  closeExchange: () => void;
  setExchangeTab: (tab: 'browse' | 'my-listings' | 'my-orders' | 'post') => void;

  // Leaderboard — P4 single ClawVille-owned ranking board
  leaderboardOpen: boolean;
  leaderboardSort:
    | 'composite'
    | 'gold'
    | 'earned'
    | 'skills-sold'
    | 'skills-authored'
    | 'quests'
    | 'bounties';
  openLeaderboard: () => void;
  closeLeaderboard: () => void;
  setLeaderboardSort: (
    sort:
      | 'composite'
      | 'gold'
      | 'earned'
      | 'skills-sold'
      | 'skills-authored'
      | 'quests'
      | 'bounties'
  ) => void;

  // Zoom
  zoomLevel: number;
  setZoomLevel: (z: number) => void;

  // One-shot camera focus request (game coords, 0..MAP_WIDTH). Set by callers
  // that want the explore-mode camera to snap to a world point (e.g. the
  // Hatcher launch handler focusing on the launched agent's in-world body).
  // The three layer (WASDCameraController) drains it via consumeCameraFocus()
  // on its next frame and re-aims OrbitControls; the request clears itself so
  // the user keeps free control afterward. Null when no focus is pending.
  cameraFocusRequest: { x: number; y: number } | null;
  requestCameraFocus: (x: number, y: number) => void;
  consumeCameraFocus: () => { x: number; y: number } | null;

  // Hatcher launch spectate — true while the owner is watching their launched
  // agent in 'explore' (set by HatcherLaunchHandler on exchange success). It
  // EXEMPTS the user from the game-page explore→player auto-promotion so a
  // useAvatar refetch (tab focus / query invalidation) can't yank the camera
  // off the watched agent back onto the owner's own avatar — same hazard the
  // guest exemption guards against. Cleared the moment the user manually
  // changes control mode (setControlMode), so they're never locked out of
  // controlling their own avatar.
  hatcherSpectate: boolean;
  setHatcherSpectate: (v: boolean) => void;

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
  avatarLevel: number;
  avatarXp: number;
  setAvatarLevel: (level: number, xp: number) => void;

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

  // Reset user-specific state on logout
  resetStore: () => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  controlMode: 'explore',
  hasAgent: false,
  possessedNpcId: null,
  setControlMode: (mode) => {
    const prev = get().controlMode;
    let possessedNpcId: string | null = get().possessedNpcId;

    // Reset jump state on every mode transition — prevents avatar being stranded airborne
    // across Moltbook handshake, NPC possession start/stop, or explicit mode switches.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();

    // Guest-avatar auto-create (2026-04-23) — entering NPC mode without a
    // avatar means the visitor is "test-driving" before signup. Mint a
    // throwaway guest avatar in the background so the activity portals,
    // chat, and inventory all just work. The bootstrap is idempotent
    // and single-flight, so it's safe to fire on every transition.
    //
    // We dispatch a window event rather than calling react-query
    // directly because the store has no QueryClient access. The
    // GuestAvatarBootstrap component (mounted at /game and /activity) does
    // the actual API call + cache invalidation + welcome toast.
    if (mode === 'npc' && prev !== 'npc' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('clawville:ensure-guest-avatar'));
    }

    // Spawn/remove dedicated player NPC for NPC mode
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useNpcStore, PLAYER_NPC_ID } = require('@/stores/npc') as typeof import('@/stores/npc');
    if (mode === 'npc') {
      useNpcStore.getState().spawnPlayerNpc();
      possessedNpcId = PLAYER_NPC_ID;
    } else {
      // Leaving NPC mode — clean up player NPC
      if (prev === 'npc') {
        useNpcStore.getState().removePlayerNpc();
      }
      possessedNpcId = null;
    }

    // Stop autonomy engine when leaving autonomous mode
    if (prev === 'autonomous' && mode !== 'autonomous') {
      const { useAutonomyStore } = require('@/stores/autonomy') as typeof import('@/stores/autonomy');
      useAutonomyStore.getState().stopAutonomy();
    }
    // Start autonomy engine when entering autonomous mode
    if (mode === 'autonomous' && prev !== 'autonomous') {
      const { useAutonomyStore } = require('@/stores/autonomy') as typeof import('@/stores/autonomy');
      useAutonomyStore.getState().startAutonomy();
    }
    set({
      controlMode: mode,
      isSpectator: mode === 'explore',
      possessedNpcId,
      // Any explicit control-mode change ends Hatcher launch-spectate — the
      // owner has taken the wheel, so the explore→player auto-promotion guard
      // is no longer needed and must not strand them in spectate. The launch
      // handler sets hatcherSpectate AFTER its own setControlMode('explore')
      // call, so this never clears the flag during launch setup.
      hatcherSpectate: false,
      // Clear stale nearLocation when switching to explore (no character = no proximity)
      ...(mode === 'explore' ? { nearLocation: null, nearCharacter: null } : {}),
    });
  },
  toggleControlMode: () => {
    const { hasAgent, controlMode } = get();
    if (!hasAgent) {
      const next: ControlMode = controlMode === 'explore' ? 'npc' : 'explore';
      // Reuse setControlMode so NPC auto-select / clear logic runs
      get().setControlMode(next);
    } else {
      const next: ControlMode = controlMode === 'player' ? 'autonomous' : 'player';
      // Use setControlMode so autonomy start/stop + possessedNpcId cleanup runs
      get().setControlMode(next);
    }
  },
  setHasAgent: (v) => {
    // Reset jump state before mode change — prevents avatar being airborne on agent connect/disconnect
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();
    // Remove player NPC if switching away from NPC mode
    if (get().controlMode === 'npc') {
      const { useNpcStore } = require('@/stores/npc') as typeof import('@/stores/npc');
      useNpcStore.getState().removePlayerNpc();
    }
    set({
      hasAgent: v,
      controlMode: v ? 'player' : 'explore',
      isSpectator: !v,
      possessedNpcId: null,
    });
  },
  setPossessedNpcId: (id) => set({ possessedNpcId: id }),

  isSpectator: true,
  setIsSpectator: (v) => set({ isSpectator: v }),

  avatarSpecies: 'cat',
  avatarColor: 'green',
  avatarName: '',
  // 2026-04-26: default flipped 'lobster' → DEFAULT_AGENT_MODEL_KEY so guests
  // and never-customized avatars render as Miladys (matches the canonical default
  // in packages/shared/src/constants/agent-models.ts).
  avatarModelKey: DEFAULT_AGENT_MODEL_KEY,
  setAvatarAppearance: (species, color, name, modelKey) => set({
    avatarSpecies: species,
    avatarColor: color,
    ...(name ? { avatarName: name } : {}),
    avatarModelKey: modelKey ?? DEFAULT_AGENT_MODEL_KEY,
  }),

  // Spawn 540 world units south of center (game-y = 6300 ⇒ world Z = +540) so
  // the player stands ~140wu south of Nori (Nori at world Z = +400 as of 2026-05-21).
  // Sign moved south by sign-size growth + Nori moved 240→400 to keep them in scale.
  avatarPosition: { x: 5760, y: 6300 },
  setAvatarPosition: (x, y) => {
    // Always update the module-scope ref — zero React overhead, safe to call
    // at 60 Hz from useFrame / rAF loops. Per-frame readers (player-avatar.tsx,
    // use-game-loop.ts) switch to avatarPositionRef so they never touch React.
    avatarPositionRef.x = x;
    avatarPositionRef.y = y;
    // Throttle the reactive zustand write to 10 Hz (100 ms) to prevent the
    // Minimap SVG (and any other subscriber) from rebuilding on every frame.
    const now = performance.now();
    if (now - lastReactiveWriteAt >= 100) {
      lastReactiveWriteAt = now;
      set({ avatarPosition: { x, y } });
    }
  },

  movementDirection: 'idle',
  // Guard against the 60Hz no-op set() — player-avatar's useFrame called this
  // every tick regardless of whether direction changed, fanning out
  // Zustand subscriber notifications + React reconciliation passes that
  // cost ~3-5ms/frame CPU when stationary. Audit: 3da emergency hot-loop
  // pass 2026-04-30. The guard fires inside set() so all callers benefit
  // without needing per-call-site memoization.
  setMovementDirection: (dir) => {
    if (dir === get().movementDirection) return;
    set({ movementDirection: dir });
  },

  avatarSpeed: 0,
  // Same per-frame guard rationale — player-avatar writes speed every tick.
  setAvatarSpeed: (speed) => {
    if (speed === get().avatarSpeed) return;
    set({ avatarSpeed: speed });
  },

  nearLocation: null,
  setNearLocation: (id) => {
    if (id === get().nearLocation) return;
    set({ nearLocation: id });
  },

  nearCharacter: null,
  setNearCharacter: (name) => {
    if (name === get().nearCharacter) return;
    set({ nearCharacter: name });
  },

  nearGuide: false,
  setNearGuide: (near) => set({ nearGuide: near }),

  currentLocation: null,
  currentCharacter: null,
  chatOpen: false,
  guideChatOpen: false,
  movementFrozen: false,

  openGuideChat: () => {
    // Mirror enterBuilding: freeze movement so the two chats can never coexist.
    // Runtime assertion — if a location chat is already open, bail rather than
    // silently stack two chat surfaces on the same movementFrozen flag.
    if (get().chatOpen) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();
    set({ guideChatOpen: true, movementFrozen: true });
  },

  closeGuideChat: () => set({ guideChatOpen: false, movementFrozen: false }),

  // ── Q2 Activity Portals — chunk #8 ────────────────────────────────────
  currentPortalBuildingId: null,
  activityLobbyId: null,

  openBuildingPortal: (buildingId) => {
    // Mirror enterBuilding's hygiene: reset any in-flight jump and freeze
    // movement so the portal modal is the only foreground surface. The
    // movementFrozen flag is shared with the chat path; closing either
    // one clears it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();
    set({
      currentPortalBuildingId: buildingId,
      movementFrozen: true,
      nearLocation: null,
      nearCharacter: null,
    });
    // Same discovery-toast semantic as enterBuilding's chat path — clicking
    // a portal-bearing building also "meets" the character behind it.
    const isNew = get().markBuildingVisited(buildingId);
    if (isNew) {
      get().addToast('🎮', 'New activity unlocked!');
    }
  },

  closeBuildingPortal: () =>
    set({
      currentPortalBuildingId: null,
      // Only release movement if we're not handing off to the lobby; the
      // lobby reasserts movementFrozen=true in openActivityLobby below.
      movementFrozen: false,
    }),

  openActivityLobby: (activityId) =>
    set({
      activityLobbyId: activityId,
      currentPortalBuildingId: null,
      movementFrozen: true,
    }),

  closeActivityLobby: () =>
    set({
      activityLobbyId: null,
      movementFrozen: false,
    }),

  enterBuilding: (locationId, characterName) => {
    // Q2 Activity Portals — chunk #8. Buildings hosting at least one
    // `live` activity (Bumper Shells → api-integrations, Reef Race →
    // app-publishing at Q2 launch) divert into the BuildingPortalModal
    // first; the chat path remains the default for the other 8.
    const hasLiveActivity = ACTIVITY_REGISTRY.some(
      (a) => a.buildingId === locationId && a.status === 'live',
    );
    if (hasLiveActivity) {
      get().openBuildingPortal(locationId);
      return;
    }

    // Reset jump state synchronously — keeps any in-flight jump from persisting
    // while the chat overlay is open and movement is frozen. Called before set()
    // so heightOffset is 0 by the time movementFrozen=true takes effect.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();
    // Resolve character name: prefer the one the caller passed in (from the
    // 3D proximity pass); otherwise fall back to whatever was last seen as
    // `nearCharacter` so tap-to-open paths still label the header correctly.
    const resolvedCharacter = characterName ?? get().nearCharacter ?? null;
    set({
      currentLocation: locationId,
      currentCharacter: resolvedCharacter,
      chatOpen: true,
      movementFrozen: true,
      nearLocation: null,
      nearCharacter: null,
    });
    // Track discovery — a friendly toast the first time you meet a character
    const isNew = get().markBuildingVisited(locationId);
    if (isNew) {
      get().addToast('💬', resolvedCharacter ? `Met ${resolvedCharacter}!` : 'New character met!');
    }
  },

  exitBuilding: () =>
    set({
      currentLocation: null,
      currentCharacter: null,
      chatOpen: false,
      movementFrozen: false,
      shopOpen: false,
      inventoryOpen: false,
    }),

  menuOpen: false,
  setMenuOpen: (open) => set({ menuOpen: open }),

  settingsModalOpen: false,
  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),

  cosmeticDrawerOpen: false,
  setCosmeticDrawerOpen: (open) => set({ cosmeticDrawerOpen: open }),

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
  setJoystickVelocity: (x, y) => {
    const current = get().joystickVelocity;
    if (current.x === x && current.y === y) return;
    set({ joystickVelocity: { x, y } });
  },

  cameraJoystickVelocity: { x: 0, y: 0 },
  setCameraJoystickVelocity: (x, y) => {
    const current = get().cameraJoystickVelocity;
    if (current.x === x && current.y === y) return;
    set({ cameraJoystickVelocity: { x, y } });
  },

  // SSR/client hydration safety — start as empty Set on BOTH server and
  // client. A top-level effect (game/page.tsx) calls
  // `hydrateVisitedFromStorage` after first paint, which replaces this
  // with the real values from localStorage. Without this, Minimap renders
  // different <rect opacity> values between server HTML (no visited) and
  // client (12 visited) → React #418 hydration mismatch every page load.
  visitedBuildings: new Set<string>(),
  hydrateVisitedFromStorage: () => {
    if (typeof window === 'undefined') return;
    const stored = loadVisited();
    if (stored.size > 0) set({ visitedBuildings: stored });
  },
  markBuildingVisited: (id) => {
    const current = get().visitedBuildings;
    if (current.has(id)) return false;
    const updated = new Set(current);
    updated.add(id);
    saveVisited(updated);
    set({ visitedBuildings: updated });
    return true;
  },

  avatarIsAutonomous: false,
  setAvatarIsAutonomous: (v) => set({ avatarIsAutonomous: v }),

  activityFeedOpen: false,
  toggleActivityFeed: () => set((s) => ({ activityFeedOpen: !s.activityFeedOpen })),

  agentConnected: false,
  agentSessionId: null,
  agentConnectModalOpen: false,
  agentConnectModalIntent: 'connect',
  setAgentConnectModalOpen: (open, intent) =>
    set((s) => ({
      agentConnectModalOpen: open,
      // Default to the connect intent if no override; preserve last intent
      // when closing so a follow-up reopen doesn't visually flip.
      agentConnectModalIntent: open
        ? (intent ?? 'connect')
        : s.agentConnectModalIntent,
    })),
  setAgentConnection: (sessionId) => {
    // A connected claw IS an agent driving the user's own avatar (Option A
    // architecture — the external claw takes over the user's avatar rather
    // than spawning a parallel NPC). Flipping hasAgent here swaps the
    // control-mode-toggle labels from Explore/NPC → Play/Autonomous and
    // kicks the user into Play mode by default. On disconnect, we drop
    // back to Explore (camera-only spectator).
    const connected = !!sessionId;
    const prev = get();

    // If the user was mid-autonomous session and the claw is being disconnected,
    // stop the autonomy engine's tick interval before wiping the mode — otherwise
    // the 500ms interval would keep running and fire goal planning against a
    // avatar that nobody is driving.
    if (!connected && prev.controlMode === 'autonomous') {
      const { useAutonomyStore } = require('@/stores/autonomy') as typeof import('@/stores/autonomy');
      useAutonomyStore.getState().stopAutonomy();
    }

    // Remove player NPC if switching away from NPC mode
    if (prev.controlMode === 'npc') {
      const { useNpcStore } = require('@/stores/npc') as typeof import('@/stores/npc');
      useNpcStore.getState().removePlayerNpc();
    }

    // Reset jump state on agent connect/disconnect — prevents avatar being stranded airborne
    // across the Moltbook handshake flow.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();

    set((s) => ({
      agentConnected: connected,
      agentSessionId: sessionId,
      agentConnectModalOpen: false,
      hasAgent: connected,
      controlMode: connected ? 'player' : 'explore',
      isSpectator: !connected,
      possessedNpcId: connected ? null : s.possessedNpcId,
    }));
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

  exchangeOpen: false,
  exchangeTab: 'browse' as const,
  openExchange: () => set({ exchangeOpen: true, exchangeTab: 'browse' }),
  closeExchange: () => set({ exchangeOpen: false }),
  setExchangeTab: (tab: 'browse' | 'my-listings' | 'my-orders' | 'post') => set({ exchangeTab: tab }),

  leaderboardOpen: false,
  leaderboardSort: 'composite' as const,
  openLeaderboard: () => set({ leaderboardOpen: true, leaderboardSort: 'composite' }),
  closeLeaderboard: () => set({ leaderboardOpen: false }),
  setLeaderboardSort: (sort) => set({ leaderboardSort: sort }),

  zoomLevel: 1.7,
  setZoomLevel: (z) => set({ zoomLevel: Math.max(0.6, Math.min(3.0, z)) }),

  cameraFocusRequest: null,
  requestCameraFocus: (x, y) => set({ cameraFocusRequest: { x, y } }),
  consumeCameraFocus: () => {
    const req = get().cameraFocusRequest;
    if (req) set({ cameraFocusRequest: null });
    return req;
  },

  hatcherSpectate: false,
  setHatcherSpectate: (v) => set({ hatcherSpectate: v }),

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

  avatarLevel: 1,
  avatarXp: 0,
  setAvatarLevel: (level, xp) => set({ avatarLevel: level, avatarXp: xp }),

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

  resetStore: () => {
    // Reset jump state first — snap any in-flight jump to grounded before clearing mode.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();
    // Stop autonomy engine if running — resetStore is called on logout
    if (get().controlMode === 'autonomous') {
      try {
        const { useAutonomyStore } = require('@/stores/autonomy') as typeof import('@/stores/autonomy');
        useAutonomyStore.getState().stopAutonomy();
      } catch { /* autonomy store may not be loaded */ }
    }
    // Remove player NPC if in NPC mode
    if (get().controlMode === 'npc') {
      try {
        const { useNpcStore } = require('@/stores/npc') as typeof import('@/stores/npc');
        useNpcStore.getState().removePlayerNpc();
      } catch { /* npc store may not be loaded */ }
    }
    // Clear any in-progress create-agent draft so a different user on the
    // same browser doesn't see the previous user's half-filled form (name,
    // thumbnail JPEG, model choice). sessionStorage is per-tab so this is
    // defensive — covers the case where the same tab persists across login.
    if (typeof window !== 'undefined') {
      try { sessionStorage.removeItem('createAvatarStep1'); } catch { /* ignore storage errors */ }
    }
    set({
    controlMode: 'explore',
    hasAgent: false,
    possessedNpcId: null,
    isSpectator: true,
    avatarSpecies: 'cat',
    avatarColor: 'green',
    avatarName: '',
    // Reset to the same default used in the initial store declaration
    // (line 319). Omitting this was a cross-session leak — after logout,
    // the next user's player-avatar would render with the previous user's
    // GLB until setAvatarAppearance fired, which for an unauthenticated
    // session may never happen.
    avatarModelKey: 'lobster',
    avatarPosition: { x: 5760, y: 6300 }, // 2026-05-21: bumped 6140→6300 to keep avatar 160 wu further from the now-larger town-directory sign (world Z=+540)
    movementDirection: 'idle',
    avatarSpeed: 0,
    nearLocation: null,
    nearCharacter: null,
    currentLocation: null,
    currentCharacter: null,
    chatOpen: false,
    guideChatOpen: false,
    currentPortalBuildingId: null,
    activityLobbyId: null,
    movementFrozen: false,
    menuOpen: false,
    settingsModalOpen: false,
    locationConfigModalOpen: false,
    locationConfigTarget: null,
    inventoryOpen: false,
    shopOpen: false,
    joystickVelocity: { x: 0, y: 0 },
    cameraJoystickVelocity: { x: 0, y: 0 },
    avatarIsAutonomous: false,
    activityFeedOpen: false,
    agentConnected: false,
    agentSessionId: null,
    agentConnectModalOpen: false,
    toasts: [],
    skillBuilderOpen: false,
    marketplaceOpen: false,
    bazaarOpen: false,
    auctionOpen: false,
    questBoardOpen: false,
    bountyBoardOpen: false,
    exchangeOpen: false,
    leaderboardOpen: false,
    avatarLevel: 1,
    avatarXp: 0,
    dailyLoginClaimed: false,
    loginStreak: 0,
    clickPath: null,
    clickPathIndex: 0,
    clickPathTarget: null,
    cameraFocusRequest: null,
    hatcherSpectate: false,
    hoveredBuilding: null,
    pendingFloatingTexts: [],
  });
  },
}));
