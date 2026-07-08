import { create } from 'zustand';
import {
  ACTIVITY_REGISTRY,
  DEFAULT_AGENT_MODEL_KEY,
  WORLD_PX_WIDTH,
  WORLD_PX_HEIGHT,
  SPAWN_PX as SHARED_SPAWN_PX,
} from '@clawville/shared';
import { buildingZones, MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Player spawn (game-px). Derived from the map center so a future world grow
// re-centers automatically. +540 keeps the avatar 540 wu SOUTH of origin
// (world Z = +540) — ~140 wu south of Nori (world Z = +400) and clear of the
// town-directory sign (world Z = −120).
// Land-builder-economics (2026-06-24): center px 9216 → 11264 (world grew 576→704 tiles).
//   x = MAP_WIDTH/2 = 11264,  y = MAP_HEIGHT/2 + 540 = 11804.
//
// Spawn scatter (town-ux-2026-06-19): a small random offset per client load
// prevents every player stacking on the exact same pixel in front of Nori.
// Offset is ±SPAWN_SCATTER_RADIUS px (uniform random, seeded once at module
// load so resetStore restores the SAME scattered position for this session).
// Clamped to a town-square safe zone: X within ±200 of center, Y within
// ±180 of base spawn — keeps players away from the sign (Z=-120), Nori
// (Z=+400), and building ring (first slot > 2000 wu away).
// ---------------------------------------------------------------------------
const SPAWN_SCATTER_RADIUS = 160; // game-px (≈ world units at 1px:1wu)
const _scatterX = (Math.random() - 0.5) * 2 * SPAWN_SCATTER_RADIUS;
const _scatterY = (Math.random() - 0.5) * 2 * SPAWN_SCATTER_RADIUS;
// Clamp: keep within town square clear zone (no buildings/sign/Nori)
const _safeScatterX = Math.max(-200, Math.min(200, _scatterX));
const _safeScatterY = Math.max(-180, Math.min(180, _scatterY));
const SPAWN_PX = {
  x: MAP_WIDTH  / 2 + _safeScatterX,
  y: MAP_HEIGHT / 2 + 540 + _safeScatterY,
};

// Drift guard (S3, 2026-06-16): the SERVER + DB derive spawn/center from
// @clawville/shared world-dimensions; the client computes them from the pixi
// tilemap. Both MUST agree or a logged-in player's broadcast body (server) and
// own body (client) diverge — exactly the Land Phase 0 re-center bug. This
// dev-only assertion fails loudly if MAP_WIDTH/MAP_HEIGHT or the computed spawn
// ever drift from the shared constants (e.g. a future world grow updates the
// tilemap but not world-dimensions.ts, or vice versa). Stripped from prod
// builds; non-breaking (no behavior change, just a fail-fast in dev).
// Drift guard: compare against the BASE spawn (before scatter) to keep
// the assertion meaningful. SPAWN_PX includes a per-session ±scatter offset
// (added 2026-06-19, town-ux) that is intentional client-only jitter — it
// should NOT trigger the drift guard, which is checking world-dimension sync
// between tilemap-data.ts and @clawville/shared world-dimensions.ts.
const _BASE_SPAWN_X = MAP_WIDTH  / 2;
const _BASE_SPAWN_Y = MAP_HEIGHT / 2 + 540;
if (process.env.NODE_ENV !== 'production') {
  if (
    MAP_WIDTH !== WORLD_PX_WIDTH ||
    MAP_HEIGHT !== WORLD_PX_HEIGHT ||
    _BASE_SPAWN_X !== SHARED_SPAWN_PX.x ||
    _BASE_SPAWN_Y !== SHARED_SPAWN_PX.y
  ) {
    console.error(
      '[game.ts] SPAWN/WORLD DRIFT: client tilemap disagrees with @clawville/shared world-dimensions. ' +
        `client {MAP_WIDTH:${MAP_WIDTH}, MAP_HEIGHT:${MAP_HEIGHT}, baseSpawn:(${_BASE_SPAWN_X},${_BASE_SPAWN_Y})} ` +
        `vs shared {WORLD_PX_WIDTH:${WORLD_PX_WIDTH}, WORLD_PX_HEIGHT:${WORLD_PX_HEIGHT}, ` +
        `SPAWN_PX:(${SHARED_SPAWN_PX.x},${SHARED_SPAWN_PX.y})}. ` +
        'Update both layers (tilemap-data.ts + world-dimensions.ts) in the same diff.',
    );
  }
}

// ---------------------------------------------------------------------------
// B6 — module-scope mutable position ref
// Callers that need per-frame position accuracy (movement physics, click-path
// following, proximity checks) read from this ref without triggering React
// re-renders. The reactive zustand field (avatarPosition) is throttled to 10 Hz
// via setAvatarPosition so that subscribers like Minimap rebuild at most 10×/sec
// instead of 60×/sec during movement.
// ---------------------------------------------------------------------------
// Land-builder-economics (2026-06-24): world is 22528×22528 px. Center = (11264, 11264).
// Spawn 540 wu south of center: sign at world Z = −120, Nori at world Z = +400,
// avatar spawn at world Z = SPAWN_PX.y − MAP_HEIGHT/2 = +540. See SPAWN_PX above.
export const avatarPositionRef: { x: number; y: number } = { x: SPAWN_PX.x, y: SPAWN_PX.y };
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
  /**
   * §B.1b — the server-confirmed `ocb-<base64url(agentId)>` in-world body id for
   * the CURRENT Autonomous enrollment, or null when not enrolled / not yet
   * confirmed. Set from the `bodyId` field of a successful `POST
   * /api/world/autonomy {active:true}` response (see `postAutonomy`/
   * `setControlMode` below) — NEVER derived client-side, so it can't drift from
   * the server's `avatarBodyId()` encoding. Consumed by `World3DCanvas.tsx` to
   * (a) hide the locally-driven `PlayerAvatar` while an agent body is streaming
   * in its place (the double-body render bug) and (b) retarget `FPSFollowCamera`
   * onto that streamed npc.ts entry instead of the frozen local avatar ref.
   * Cleared to null the instant control leaves Autonomous by ANY path
   * (`setControlMode`, `setAgentConnection`, `setAgentPaired`, `resetStore`) so
   * the local avatar reappears in the SAME tick controlMode flips, without
   * waiting on the async `postAutonomy(false)` response.
   */
  autonomousBodyId: string | null;
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

  // Agent connection (World mode) — supports any agent type, not just OpenClaw.
  //
  // Two DISTINCT states (split 2026-06-12, Codex finding #2). They are NOT
  // interchangeable and conflating them is the partner's reload-breakage bug:
  //
  //  • agentPaired — "this user has a connected agent" for UI purposes. Derived
  //    from the server's /me/agent-session liveness probe, so it SURVIVES A
  //    RELOAD. Drives every paired INDICATOR (Bot-Training pill, Controlled/
  //    Autonomous toggle labels, sidebar Trainer tier, cove autonomous
  //    availability). Carries NO bearer.
  //
  //  • agentSessionId — the LIVE agent-session bearer. The server returns it
  //    EXACTLY ONCE, at first connect (a hard security invariant — never
  //    re-emitted), so it can only be held in memory by the SAME browser session
  //    that performed the connect. It is null after any reload. /me/agent-session
  //    canNOT reconstruct it. The agent-bearer chat send path
  //    (avatar-chat-bar `routedThroughAgent`, use-location-chat) gates on a
  //    NON-NULL agentSessionId — so after a reload those paths correctly fall
  //    back to the normal authed avatar chat instead of replaying a fake bearer.
  //
  //  • agentConnected — kept as the convenience union "paired (UI) AND/OR holds a
  //    live bearer". Set true whenever agentPaired is true, with or without a
  //    bearer. UI consumers may read it as "is paired"; bearer paths must AND it
  //    with agentSessionId (they already do).
  //
  // THE BUG THIS SPLIT FIXES: the reload hydration used to pass the server's
  // `agentId` into setAgentConnection() as if it were the bearer, so the next
  // avatar chat sent agentId as sessionId → 404 → the connection cleared ~1s in.
  // Reload now calls setAgentPaired() (no bearer) — agentSessionId stays null,
  // the chat bar uses the authed avatar path, nothing 404s, the avatar stays.
  agentPaired: boolean;
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
  /**
   * Set or clear the connected-agent session.
   *
   * `opts.keepEmbodied` (clear path only): when an agent session is cleared
   * for a user who still OWNS their avatar (logged-in, non-guest, has an
   * avatar row), keep them driving their own body — controlMode stays
   * `'player'`, `isSpectator` stays false. Only the agent-specific state
   * (agentConnected / agentSessionId / Bot-Training pill / autonomous mode)
   * clears. The avatar belongs to the USER, not the agent session, so a dead
   * session must not unmount the live `<PlayerAvatar>` mid-game (regression
   * D2, 2026-06-12 — partner's avatar vanished ~1s after sending a chat that
   * 404'd on a server-dropped session). Ignored on the connect path
   * (sessionId truthy always embodies in 'player'). Guests / avatar-less
   * users still fall back to 'explore' as before.
   *
   * `keepEmbodied` is the gate, and the caller MUST derive it from the real
   * avatar object + auth state (the chat-bar does: `!!avatar && (!authFetched
   * || (user && !user.isGuest))`). The store can't re-derive embodiment
   * itself — it doesn't hold the avatar object, and its `avatarName` field is
   * left '' by every call site — so the caller owns this decision.
   */
  setAgentConnection: (sessionId: string | null, opts?: { keepEmbodied?: boolean }) => void;
  /**
   * Reload-survivable PAIRED state — set from the server's /me/agent-session
   * liveness probe on game-page mount. Marks the user as paired with an agent
   * for UI purposes (Bot-Training pill, Controlled/Autonomous toggle, cove
   * autonomous availability) WITHOUT ever holding a bearer.
   *
   * `setAgentPaired(true, agentId?)`:
   *   agentPaired = true, agentConnected = true, hasAgent = true,
   *   agentSessionId = null (CRITICAL — the bearer is never reconstructed; the
   *   server only emits it once at connect and can't re-emit it), embodies the
   *   owner in 'player' mode. The optional agentId is for diagnostics/display
   *   only and is NEVER used as a bearer.
   *
   * `setAgentPaired(false, _, opts?)`:
   *   clears agentPaired + agentConnected + agentSessionId. Honors
   *   `opts.keepEmbodied` exactly like setAgentConnection's clear path so a
   *   server "no longer connected" answer doesn't evict a still-authenticated
   *   owner from their own avatar (regression D2 consistency).
   *
   * The agent-bearer chat path (`agentConnected && agentSessionId`) stays OFF
   * after this because agentSessionId is null — by construction, never by
   * accident. To chat AS the agent again the user must re-run the in-session
   * connect flow (the only path that receives a real bearer), which is a
   * separate scoped feature, not this fix.
   */
  setAgentPaired: (paired: boolean, agentId?: string | null, opts?: { keepEmbodied?: boolean }) => void;

  // Toast notifications
  toasts: Toast[];
  addToast: (icon: string, message: string, durationMs?: number) => void;
  removeToast: (id: string) => void;

  // Skill Builder
  skillBuilderOpen: boolean;
  setSkillBuilderOpen: (open: boolean) => void;

  // Land Office (Phase 1 land economy — browse / claim / buy / build)
  landOfficeOpen: boolean;
  /**
   * Open the Land Office modal.
   * Pass `parcelCode` (e.g. `'parcel-a-01'`) when opening from a 3D parcel
   * click so the modal auto-focuses that parcel in the For-Sale tab ready to buy.
   * Omit (or pass undefined) for the normal sidebar open (no pre-selection).
   */
  openLandOffice: (parcelCode?: string) => void;
  closeLandOffice: () => void;
  /**
   * The parcel the Land Office should pre-focus on open. Set by openLandOffice
   * when the caller provides a parcelCode; cleared by the modal once it has
   * consumed the focus (or on close). null = no pre-selection.
   */
  landOfficeFocusParcel: string | null;
  clearLandOfficeFocus: () => void;

  // ── World Map + Fast Travel (town-fasttravel-2026-06-19) ──────────────
  // Interactive World Map modal — the WARP surface (the minimap stays the
  // WALK surface). Opened from the minimap "⤢ Map" button. Freezes movement
  // while open (mirrors every other modal so WASD/joystick can't drive the
  // avatar behind the map).
  worldMapOpen: boolean;
  openWorldMap: () => void;
  closeWorldMap: () => void;

  // Quick-travel warp. `warpTarget` is the in-flight teleport destination in
  // game-px (+ optional label, e.g. the building name). The WarpOverlay DOM
  // animation consumes it: a ~1.4s radial flash masks an INSTANT teleport at
  // its midpoint. `warpTo` is GATED on controlMode==='player' (the only mode
  // with a WASD-controllable avatar) — a no-op in explore/npc/autonomous so a
  // spectator/agent-driven body is never yanked. It also closes the World Map
  // so the modal dismisses the moment the warp fires. `clearWarp` is called by
  // the overlay at the end of the animation to unmount itself.
  warpTarget: { x: number; y: number; label?: string } | null;
  warpTo: (x: number, y: number, label?: string) => void;
  clearWarp: () => void;

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

  // Exchange — peer marketplace (Needs + Offers). Opened via the in-world
  // 3D marketplace stand (lib/three/marketplace-stall.tsx). See
  // packages/database/src/schema/exchange.ts for the escrow flow doc.
  exchangeOpen: boolean;
  exchangeTab: 'browse' | 'my-listings' | 'my-orders' | 'post';
  openExchange: () => void;
  closeExchange: () => void;
  setExchangeTab: (tab: 'browse' | 'my-listings' | 'my-orders' | 'post') => void;

  // Leaderboard — P4 single ClawVille-owned ranking board. 'skills-sold' /
  // 'skills-authored' sort modes were removed 2026-07-02 alongside peer skill
  // commerce (bazaar/auctions/marketplace) — the backend legacy board
  // (apps/api/src/routes/leaderboard.ts) never carried these fields on its
  // own SortMode/LeaderboardEntry, so selecting either tab crashed the modal
  // (`undefined.toLocaleString()` in formatMetric). Fixed by dropping both.
  leaderboardOpen: boolean;
  leaderboardSort: 'composite' | 'gold' | 'earned' | 'quests' | 'bounties';
  openLeaderboard: () => void;
  closeLeaderboard: () => void;
  setLeaderboardSort: (
    sort: 'composite' | 'gold' | 'earned' | 'quests' | 'bounties'
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

  // Hatcher launch banner active — true while HatcherLaunchHandler is showing
  // its bottom-center failure/relaunch banner. Drives mutual exclusion with the
  // soft email-verify nudge: the email banner suppresses itself while this is
  // set so the two bottom-center surfaces never stack/occlude (worst at mobile
  // width where the Hatcher panel wraps to ~1/3 of the screen). The Hatcher
  // banner is the higher-priority transient — the user just initiated that
  // launch — so it wins the bottom-center slot. Cleared when the banner is
  // dismissed or the handler unmounts.
  hatcherLaunchBannerActive: boolean;
  setHatcherLaunchBannerActive: (v: boolean) => void;

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

// ---------------------------------------------------------------------------
// §B.1 (2026-07-08) — Autonomous-mode SERVER enrollment.
//
// The client control-mode toggle only flips local loops; the SERVER must be told
// so the owner's hosted avatar-agent rides the FULL autonomy driver
// (perceive→decide→act([ACTION:])→settle REAL CT to the owner's avatar). One
// idempotent endpoint: POST /api/world/autonomy { active }. Authed by the Lucia
// cookie ONLY — the body carries just the boolean; the agent identity is derived
// server-side from the user's active avatar. The response NEVER carries a bearer,
// so this does not touch the no-bearer-refetch invariant (game/page.tsx).
//
// B3 (restart re-enrollment): the driver registry is server process-memory, so an
// API restart/deploy drops the enrollment. While Autonomous, re-POST on an
// interval so autonomy survives deploys (the endpoint is idempotent + cheap when
// already enrolled).
// ---------------------------------------------------------------------------
const AUTONOMY_API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
const AUTONOMY_KEEPALIVE_MS = 5 * 60 * 1000; // re-arm every 5 min (survives API restarts)
let autonomyKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

// §B.1b (Codex round 1 BLOCKING fix): monotonic token for the CURRENT
// Autonomous *session* (one increment per fresh 'player'->'autonomous'
// transition, captured into a closure-local `epoch` at the point the
// activation fetch fires). A rapid double-toggle (autonomous[A] -> player ->
// autonomous[B]) leaves request A's in-flight `.then()` racing against B's
// activation. The success case is provably harmless on its own — `bodyId` is
// `ocb-<base64url(agentId)>`, a pure function of the user's OWN agent, so a
// stale success writing it is idempotent-safe even under B. The FAILURE case
// is NOT harmless: without this token, request A's failure callback also only
// checks `controlMode === 'autonomous'`, which is true again once B starts —
// so a lagging failed A would wrongly revert the legitimate B session to
// 'player' and post a misleading toast, even though B's own activation may
// still succeed. Every `.then()` below is gated on `epoch === autonomyEpoch`
// (the CURRENT session) before writing success OR reverting on failure.
let autonomyEpoch = 0;

async function postAutonomy(
  active: boolean,
): Promise<{ ok: boolean; code?: string; status: number; bodyId?: string }> {
  try {
    const res = await fetch(`${AUTONOMY_API_BASE}/api/world/autonomy`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    // §B.1b: on activation the route returns the deterministic `bodyId`
    // (`ocb-<base64url(agentId)>`) it just enrolled — see world.ts POST
    // /autonomy doc comment. Not present on deactivate ({enrolled:false}) or
    // on any error response.
    const data = (await res.json().catch(() => ({}))) as { code?: string; bodyId?: string };
    return { ok: res.ok, code: data.code, status: res.status, bodyId: data.bodyId };
  } catch {
    // Network/offline — treat as a soft failure; the keepalive re-arm retries.
    return { ok: false, status: 0 };
  }
}

function stopAutonomyKeepalive(): void {
  if (autonomyKeepaliveTimer) {
    clearInterval(autonomyKeepaliveTimer);
    autonomyKeepaliveTimer = null;
  }
}

/**
 * Tear down the SERVER Autonomous enrollment + the client keepalive when the
 * store leaves Autonomous by a path OTHER than `setControlMode` — agent
 * disconnect/unpair (`setAgentConnection` / `setAgentPaired(false)`), losing the
 * agent (`setHasAgent`), or logout (`resetStore`). Without this, the 5-min
 * keepalive interval keeps re-arming enrollment and the server driver keeps
 * acting + settling REAL CT on the avatar after the user has disconnected /
 * logged out. Idempotent + safe to over-call: `postAutonomy(false)` is a
 * server-side no-op when nothing is enrolled, and `stopAutonomyKeepalive` is a
 * no-op when no timer is set. Guarded on the PRIOR mode so it fires ONLY on a
 * genuine departure from Autonomous.
 *
 * D6 tab-close persistence is unaffected: no store method runs on a raw tab
 * close, so the timer dies with the page and the server session persists to its
 * 24h TTL — exactly the "user leaves, agent keeps acting" contract. This cleanup
 * covers only the EXPLICIT exits (disconnect / unpair / logout).
 */
function leaveAutonomousServerCleanup(priorMode: ControlMode): void {
  if (priorMode !== 'autonomous') return;
  stopAutonomyKeepalive();
  // §B.1b: clear the confirmed streamed-body id synchronously so callers that
  // exit Autonomous via a path OTHER than setControlMode (agent
  // disconnect/unpair, logout) also remount PlayerAvatar immediately instead
  // of leaving a stale id pointed at a body the server is about to un-enroll.
  useGameStore.setState({ autonomousBodyId: null });
  void postAutonomy(false);
}

export const useGameStore = create<GameState>((set, get) => ({
  controlMode: 'explore',
  hasAgent: false,
  possessedNpcId: null,
  autonomousBodyId: null,
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

    // §B.1 — SERVER Autonomous enrollment (see the module header above). Enroll
    // the owner's hosted avatar-agent in the full autonomy driver, and start a
    // keepalive re-arm so autonomy survives an API restart (B3). On a rejection
    // (capacity / not-eligible / auth) toast the reason (branch on `code`, never
    // message text) and REVERT to Controlled — the agent is NOT autonomous
    // server-side, so the client must not pretend it is.
    if (mode === 'autonomous' && prev !== 'autonomous') {
      // §B.1b (Codex round 1): mint this session's token BEFORE firing the
      // fetch, and close over it — every callback below (activation +
      // keepalive re-arms) checks its OWN captured `epoch` against the
      // CURRENT `autonomyEpoch`, not just `controlMode === 'autonomous'`
      // (which a NEWER autonomous session would also satisfy).
      const epoch = ++autonomyEpoch;
      void postAutonomy(true).then((r) => {
        if (r.ok) {
          // §B.1b — only THIS session's confirmation may write the body id;
          // a stale response from a toggle the user already flipped away
          // from (and possibly re-entered) must not resurrect a hidden local
          // avatar's replacement after the fact.
          if (r.bodyId && epoch === autonomyEpoch && get().controlMode === 'autonomous') {
            set({ autonomousBodyId: r.bodyId });
          }
          return;
        }
        // A lagging failure from an EARLIER session must never revert a
        // legitimate NEWER autonomous session — checking controlMode alone
        // can't tell the two apart, since both read 'autonomous'.
        if (epoch !== autonomyEpoch) return;
        // Codex round 2 polish: also skip the toast (not just the revert) if
        // the user already left Autonomous by some OTHER path (e.g. logged
        // out, disconnected the agent) before this same-epoch failure landed
        // — a "could not start autonomous mode" toast would be confusing to
        // see after the user is no longer even trying to be in that mode.
        if (get().controlMode !== 'autonomous') return;
        const msg =
          r.code === 'autonomy_capacity'
            ? 'Autonomous agents are at capacity right now — try again soon.'
            : r.code === 'guest_forbidden'
              ? 'Create a free account to run your agent autonomously.'
              : r.code === 'no_agent' || r.code === 'not_eligible' || r.code === 'no_avatar'
                ? 'No eligible agent to run autonomously yet.'
                : r.status === 401
                  ? 'Log in to run your agent autonomously.'
                  : 'Could not start autonomous mode — please try again.';
        get().addToast(r.code === 'autonomy_capacity' ? '⏳' : '⚠️', msg, 4500);
        // The controlMode !== 'autonomous' early-return above already proved
        // we're still in this exact session's Autonomous mode, so the revert
        // is unconditional here (no redundant re-check needed).
        get().setControlMode('player');
      });
      if (typeof window !== 'undefined') {
        stopAutonomyKeepalive();
        autonomyKeepaliveTimer = setInterval(() => {
          if (useGameStore.getState().controlMode === 'autonomous') {
            void postAutonomy(true).then((r) => {
              // Backfill bodyId on a re-arm if the initial activation response
              // was lost/raced — deterministic id, safe to (re)apply
              // idempotently, but still epoch-gated for consistency (a
              // keepalive tick from a torn-down session must not write into a
              // newer one either, even though the id itself would be identical
              // for this same agent).
              if (r.ok && r.bodyId && epoch === autonomyEpoch && useGameStore.getState().controlMode === 'autonomous') {
                useGameStore.setState({ autonomousBodyId: r.bodyId });
              }
            });
          } else {
            stopAutonomyKeepalive();
          }
        }, AUTONOMY_KEEPALIVE_MS);
      }
    }
    // Hand autonomy back to the server on leaving Autonomous (idempotent; the
    // §B.2 session stays live per D6, only the driver stops + the body is
    // suppressed while the human drives).
    if (prev === 'autonomous' && mode !== 'autonomous') {
      stopAutonomyKeepalive();
      void postAutonomy(false);
    }
    set({
      controlMode: mode,
      isSpectator: mode === 'explore',
      possessedNpcId,
      // §B.1b: clear the confirmed body id THIS tick on any exit from
      // Autonomous so PlayerAvatar remounts immediately (no waiting on the
      // async postAutonomy(false) round trip). Entering Autonomous leaves it
      // as-is — the .then() above writes it once the server confirms.
      ...(mode !== 'autonomous' ? { autonomousBodyId: null } : {}),
      // Any explicit control-mode change ends Hatcher launch-spectate — the
      // owner has taken the wheel, so the explore→player auto-promotion guard
      // is no longer needed and must not strand them in spectate. The launch
      // handler sets hatcherSpectate AFTER its own setControlMode('explore')
      // call, so this never clears the flag during launch setup.
      hatcherSpectate: false,
      // Clear stale nearLocation when switching to explore (no character = no proximity)
      // or autonomous (§B.1b: PlayerAvatar unmounts, so the per-frame proximity
      // check that keeps nearLocation/nearCharacter current also stops — without
      // this, a nearLocation set the instant before the toggle would freeze
      // non-null and LocationHUD would keep showing a stale "press E to enter"
      // prompt the human could fire against a building the spectated agent has
      // long since walked away from).
      ...(mode === 'explore' || mode === 'autonomous' ? { nearLocation: null, nearCharacter: null } : {}),
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
    // §B.1: losing/setting the agent moves out of Autonomous — tear down the
    // server enrollment + keepalive first (this method sets a non-autonomous
    // mode below and bypasses setControlMode's own cleanup).
    leaveAutonomousServerCleanup(get().controlMode);
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
      // §B.1b: this method never lands in 'autonomous' — belt-and-suspenders
      // alongside leaveAutonomousServerCleanup's clear above.
      autonomousBodyId: null,
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

  // Spawn 540 world units south of center (world Z = +540) so the player stands
  // ~140wu south of Nori (Nori at world Z = +400 as of 2026-05-21).
  // Sign moved south by sign-size growth + Nori moved 240→400 to keep them in scale.
  avatarPosition: { x: SPAWN_PX.x, y: SPAWN_PX.y },
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

  agentPaired: false,
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
  setAgentConnection: (sessionId, opts) => {
    // A connected claw IS an agent driving the user's own avatar (Option A
    // architecture — the external claw takes over the user's avatar rather
    // than spawning a parallel NPC). Flipping hasAgent here swaps the
    // control-mode-toggle labels from Explore/NPC → Play/Autonomous and
    // kicks the user into Play mode by default. On disconnect, we drop
    // back to Explore (camera-only spectator).
    const connected = !!sessionId;
    const prev = get();

    // §B.1: any connect/disconnect that moves out of Autonomous must tear down
    // the SERVER driver enrollment + the keepalive (this method sets a
    // non-autonomous mode below, bypassing setControlMode's cleanup). Fires only
    // when prev was Autonomous; deactivate is a server no-op otherwise.
    leaveAutonomousServerCleanup(prev.controlMode);

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

    // Clear path for a still-embodied owner: the dead/cleared AGENT session is
    // not a reason to evict the user from their OWN avatar. Keep them driving
    // it in 'player' mode (camera-follow, body mounted) and only strip the
    // agent-specific state below. Connect path (connected===true) always
    // embodies in 'player' regardless of this flag.
    //
    // The gate is the caller's `opts.keepEmbodied`, which the chat-bar derives
    // from the REAL avatar object + auth state: `!!avatar && (!authFetched ||
    // (user && !user.isGuest))`. The store has NO better signal — it does not
    // hold the avatar object (React Query `['avatar']` is the source of truth),
    // and the only avatar-shaped store field, `avatarName`, is left '' by BOTH
    // setAvatarAppearance call sites (they pass name=undefined), so an AND-gate
    // on it would be a silent no-op that NEVER keeps anyone embodied (caught in
    // audit 2026-06-12 — the build was green but the fix did nothing). So we
    // trust the caller's avatar-derived hint rather than re-deriving from a
    // store field that isn't populated. Connect path (connected===true) always
    // embodies in 'player' regardless of this flag.
    const keepEmbodied = !connected && !!opts?.keepEmbodied;

    set((s) => ({
      // A live bearer implies paired; clearing the bearer also clears paired.
      agentPaired: connected,
      agentConnected: connected,
      agentSessionId: sessionId,
      agentConnectModalOpen: false,
      hasAgent: connected,
      controlMode: connected || keepEmbodied ? 'player' : 'explore',
      isSpectator: connected || keepEmbodied ? false : true,
      possessedNpcId: connected ? null : s.possessedNpcId,
      // §B.1b: this method never lands in 'autonomous' — belt-and-suspenders
      // alongside leaveAutonomousServerCleanup's clear above.
      autonomousBodyId: null,
    }));
  },

  setAgentPaired: (paired, _agentId, opts) => {
    // Reload-survivable paired hydration. CRITICAL: this never sets a bearer.
    // The server (/me/agent-session) only tells us WHETHER an agent is connected
    // (+ its agentId for display) — it cannot return the session bearer, which
    // is emitted exactly once at connect. So agentSessionId is forced null here:
    // the agent-bearer chat path (agentConnected && agentSessionId) stays off by
    // construction, and the avatar chat bar falls back to the normal authed
    // path — the partner's "connection clears ~1s after reload" bug (a fabricated
    // agentId-as-bearer 404ing on first chat) cannot recur.

    // Reset jump state on the paired transition for parity with the connect/
    // disconnect paths (avoids a stranded-airborne avatar across the flip).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();

    if (paired) {
      // Mirror the connect path's embodiment (player mode, body mounted) but
      // WITHOUT a bearer. No-op guard: if already paired with no bearer, don't
      // churn control mode (a useAvatar refetch re-runs the hydration effect).
      const prev = get();
      if (prev.agentPaired && prev.agentConnected && prev.agentSessionId === null) return;
      // §B.1: a re-pair that moves out of Autonomous tears down the server
      // enrollment + keepalive (after the no-op early-return above, so a stable
      // paired-no-bearer hydration does NOT deactivate a live autonomous agent).
      leaveAutonomousServerCleanup(prev.controlMode);
      // Hatcher-launch spectate preservation (Codex pass-8): a successful launch
      // lands the owner in 'explore' + hatcherSpectate to watch the agent. If
      // /api/auth/me/agent-session resolves AFTER the exchange, this paired
      // hydration must NOT yank them into 'player' and out of spectate. Keep the
      // explore/spectate view while still recording the paired/connected agent.
      const keepSpectate = prev.hatcherSpectate && prev.controlMode === 'explore';
      set({
        agentPaired: true,
        agentConnected: true,
        agentSessionId: null,
        hasAgent: true,
        controlMode: keepSpectate ? 'explore' : 'player',
        isSpectator: keepSpectate ? true : false,
        possessedNpcId: null,
        // §B.1b: this branch never lands in 'autonomous' — belt-and-suspenders
        // alongside leaveAutonomousServerCleanup's clear above.
        autonomousBodyId: null,
      });
      return;
    }

    // Clear path — server says no longer connected. Honor keepEmbodied so a
    // still-authenticated owner with their own avatar is not evicted from their
    // body (same D2 invariant as setAgentConnection's clear path). Stop autonomy
    // if it was running against the now-unpaired agent.
    const prev = get();
    if (prev.controlMode === 'autonomous') {
      // §B.1: server driver + keepalive teardown on unpair (agent gone).
      leaveAutonomousServerCleanup(prev.controlMode);
      const { useAutonomyStore } = require('@/stores/autonomy') as typeof import('@/stores/autonomy');
      useAutonomyStore.getState().stopAutonomy();
    }
    const keepEmbodied = !!opts?.keepEmbodied;
    set((s) => ({
      agentPaired: false,
      agentConnected: false,
      agentSessionId: null,
      hasAgent: false,
      controlMode: keepEmbodied ? 'player' : 'explore',
      isSpectator: keepEmbodied ? false : true,
      possessedNpcId: s.possessedNpcId,
      autonomousBodyId: null,
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

  landOfficeOpen: false,
  landOfficeFocusParcel: null,
  openLandOffice: (parcelCode) => set({
    landOfficeOpen: true,
    landOfficeFocusParcel: parcelCode ?? null,
  }),
  closeLandOffice: () => set({ landOfficeOpen: false, landOfficeFocusParcel: null }),
  clearLandOfficeFocus: () => set({ landOfficeFocusParcel: null }),

  // ── World Map + Fast Travel (town-fasttravel-2026-06-19) ──────────────
  worldMapOpen: false,
  openWorldMap: () => {
    // Freeze movement while the map is open so WASD/joystick can't drive the
    // avatar behind the modal (mirrors enterBuilding / openBuildingPortal).
    // Reset any in-flight jump so the avatar isn't stranded airborne under it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resetJump } = require('@/lib/three/jump-state') as typeof import('@/lib/three/jump-state');
    resetJump();
    set({ worldMapOpen: true, movementFrozen: true });
  },
  closeWorldMap: () => set({ worldMapOpen: false, movementFrozen: false }),

  warpTarget: null,
  warpTo: (x, y, label) => {
    // GATE: only a controllable player avatar may warp. In explore (camera
    // spectator), npc (possessed NPC drives via NpcController), or autonomous
    // (the agent navigates itself), there is no player body to teleport — a
    // warp would either do nothing useful or yank a body the user isn't
    // driving. Silent no-op outside 'player' (the World Map disables the
    // button + shows a hint, so this is just defense-in-depth).
    if (get().controlMode !== 'player') return;
    // Close the World Map so it dismisses the instant the warp fires, and KEEP
    // movement frozen for the whole ~1.4s warp animation. The teleport happens
    // at the overlay midpoint; if movement were released here, an ALREADY-HELD
    // W/joystick would keep driving player-avatar's movement (the overlay's
    // capture-phase swallow only blocks NEW key presses, not held state) and
    // drift the avatar off the freshly-set target after the teleport. Freezing
    // through the warp makes player-avatar skip its movement integration the
    // whole time; clearWarp() releases the freeze when the overlay unmounts.
    set({ warpTarget: { x, y, label }, worldMapOpen: false, movementFrozen: true });
  },
  // Called by WarpOverlay at the animation END — unmount the overlay AND release
  // the movement freeze warpTo() held through the warp (paired so the freeze can
  // never leak past the animation).
  clearWarp: () => set({ warpTarget: null, movementFrozen: false }),

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

  hatcherLaunchBannerActive: false,
  setHatcherLaunchBannerActive: (v) => {
    // Guard the no-op set so the HatcherLaunchHandler's unmount-cleanup (which
    // always calls setHatcherLaunchBannerActive(false)) doesn't fan out a
    // pointless store notification when the flag is already false.
    if (v === get().hatcherLaunchBannerActive) return;
    set({ hatcherLaunchBannerActive: v });
  },

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
      // §B.1: logout must also tear down the SERVER driver enrollment + the
      // keepalive, or the agent keeps acting + settling CT after logout (and the
      // 5-min keepalive keeps re-arming). Idempotent server no-op otherwise.
      leaveAutonomousServerCleanup('autonomous');
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
    autonomousBodyId: null,
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
    avatarPosition: { x: SPAWN_PX.x, y: SPAWN_PX.y }, // world Z=+540 — see SPAWN_PX (land-builder-economics: center 9216→11264)
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
    agentPaired: false,
    agentConnected: false,
    agentSessionId: null,
    agentConnectModalOpen: false,
    toasts: [],
    skillBuilderOpen: false,
    landOfficeOpen: false,
    landOfficeFocusParcel: null,
    worldMapOpen: false,
    warpTarget: null,
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
    hatcherLaunchBannerActive: false,
    hoveredBuilding: null,
    pendingFloatingTexts: [],
  });
  },
}));
