import {
  NPC_DEFINITIONS,
  NPC_BUILDING_CENTERS,
  BUILDING_OPENCLAW_THEMES,
  type NpcDefinition,
  type OpenClawRegistration,
  type OpenClawAvatarConfig,
  type NpcActivity,
  ACTIVITY_EMOJIS,
  BUILDING_ACTIVITIES,
  type ClawConfig,
  type BrowserClawSnapshot,
  type ArenaSettings,
  type ArenaRoundState,
  DEFAULT_ARENA_SETTINGS,
  clampPosition2D,
  WORLD_COLLIDER_MAP_HALF,
} from '@clawville/shared';
import { generateNpcConversation, generateOpenClawConversation } from './npc-conversation-engine';
import {
  findPath,
  hasClearance,
  isCollisionFreeWorld,
  findNearestWalkable,
  isPathCollisionFree,
  type PathNode,
} from './pathfinding';
import { AvatarSimulationBridge } from './avatar-simulation-bridge';
import { memoryService } from './memory-service';
import {
  getCollaborationBroker,
  type CollaborationLogEntry,
} from '@clawville/agent-runtime';
import type { OpenClawClient } from './openclaw-client';

// Map dimensions — Phase 6.2 (2026-05-18): 360×360 grid of 32px tiles = 11520×11520 world.
const MAP_WIDTH = 11520;
const MAP_HEIGHT = 11520;

// Town-center anchor and the annulus (ring) free-roaming wanderers stay inside.
// Buildings are on a ring at ~4160wu from center (R=130 tiles). Keep free
// roamers in the open commons well inside that ring so they do not path to
// building walls or look like they have nowhere meaningful to go. The inner
// radius keeps random wander targets off the dense Nori/bazaar/pavilion prop
// cluster; AABB snapping still handles approach targets that pass closer.
const TOWN_CENTER_X = MAP_WIDTH / 2;       // 5760
const TOWN_CENTER_Y = MAP_HEIGHT / 2;      // 5760
const FREE_ROAMER_MIN_RADIUS = 900;
const FREE_ROAMER_MAX_RADIUS = 2400;
const NPC_COLLISION_HALF = 30;

const FREE_ROAMER_IDS = new Set(
  NPC_DEFINITIONS.filter((def) => def.buildingId === '').map((def) => def.id),
);

// --- Types ---

export interface NpcRuntimeState {
  id: string;
  name: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  homeX: number;
  homeY: number;
  patrolRadius: number;
  direction: 'idle' | 'left' | 'right' | 'up' | 'down';
  species: string;
  color: number;
  inConversation: boolean;
  conversationCooldownUntil: number;
  // Activity system
  activity: NpcActivity;
  activityEmoji: string;
  destinationBuildingId: string | null;
  path: PathNode[];
  pathIndex: number;
  activityEndsAt: number;
  behaviorCooldown: number;
  intentDescription: string;
  /**
   * Ticks-in-a-row that AABB clamp blocked movement (2026-05-22).
   * Incremented every movement tick where clamped.hit is true; reset on a
   * net position delta ≥ 2 px. When stuckTicks ≥ 4 (≈800 ms at 5 Hz), the
   * NPC abandons its current path/target and re-plans — safety net for
   * cases where a path's final waypoint sits in the gap between A* grid
   * and pixel-accurate clamp, or a target NPC parked against a wall.
   */
  stuckTicks: number;
  // Arena-only fields
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  inCombat: boolean;
  inventory: string[];
  isDead: boolean;
  respawnAt: number;
  hasSword: boolean;
  isOpenClaw: boolean;
  level: number;
  kills: number;
  xp: number;
  baseAttack: number;
  baseDefense: number;
  baseSpeed: number;
  baseMaxHp: number;
  combatTargetId: string | null;
  lastAttackAt: number;
  lastHitAt: number;
  respawnedAt: number;
  invulnerableUntil: number;
  combatAction: 'attack' | 'heavy' | 'block' | 'dodge' | 'combo' | 'special' | null;
  combatActionAt: number;
  autonomyMode: 'server-managed' | 'self-managed' | 'native';
}

export interface NpcConversation {
  id: string;
  npc1Id: string;
  npc2Id: string;
  messages: Array<{ npcId: string; npcName: string; text: string }>;
  currentIndex: number;
  nextMessageAt: number;
  state: 'active' | 'done';
  typingNpcId: string | null;
  typingUntil: number;
}

export interface NpcCombat {
  id: string;
  attacker: string;
  defender: string;
  rounds: Array<{ attacker: string; damage: number; defenderHpAfter: number; isCrit?: boolean; isDodge?: boolean; isBlocked?: boolean }>;
  state: 'active' | 'done';
  winner: string | null;
  lootTransferred: string[];
  startedAt: number;
  nextRoundAt: number;
  phase: 'approach' | 'fighting' | 'done';
}

export interface SimulationEvent {
  id: string;
  type: string;
  npcId: string;
  npcName: string;
  data: Record<string, any>;
  timestamp: number;
}

export interface SimulationSnapshot {
  npcs: NpcRuntimeState[];
  conversations: NpcConversation[];
  combats: NpcCombat[];
  events: SimulationEvent[];
  autonomousAvatars: Array<{
    avatarId: string; userId: string; name: string; species: string; color: string;
    x: number; y: number; direction: string; activity: string; activityEmoji: string;
    isAutonomous: boolean; chatMessage: string | null;
  }>;
  browserClaws: BrowserClawSnapshot[];
  arenaRound: ArenaRoundState | null;
  arenaSettings: ArenaSettings;
  collaborationEvents: CollaborationLogEntry[];
  timestamp: number;
}

type SSEListener = (snapshot: SimulationSnapshot) => void;

// Arena round constants
const DEFAULT_MAX_ROUNDS = 5;
const ROUND_DURATION_MS = 60_000;   // 60s per round
const INTERMISSION_MS = 8_000;      // 8s between rounds

// --- Simulation Singleton ---

class NpcSimulation {
  private npcs: Map<string, NpcRuntimeState> = new Map();
  private conversations: Map<string, NpcConversation> = new Map();
  private combats: Map<string, NpcCombat> = new Map();
  private listeners: Set<SSEListener> = new Set();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private arenaMode = false;
  private tickCount = 0;
  private conversationCooldown = 0;
  private combatCooldown = 0;
  private idCounter = 0;
  private pendingEvents: SimulationEvent[] = [];
  public avatarAutonomyManager = new AvatarSimulationBridge();
  private arenaSettings: ArenaSettings = { ...DEFAULT_ARENA_SETTINGS };
  private arenaRound: ArenaRoundState | null = null;

  // OpenClaw bot registry
  private openClawBots: Map<string, { config: OpenClawRegistration; client: OpenClawClient }> = new Map();
  private npcOverrides: Map<string, string> = new Map(); // npcId → sessionId

  // Browser-connected claws (no gateway — controlled by browser client)
  private browserClaws: Map<string, {
    config: ClawConfig;
    sessionId: string;
    x: number;
    y: number;
    direction: string;
    activity: string;
    activityEmoji: string;
    lastHeartbeat: number;
  }> = new Map();

  start(arenaMode: boolean) {
    if (this.intervalId) return;
    this.arenaMode = arenaMode;
    this.initNpcs();
    if (arenaMode) this.initRounds();
    console.log(`[NPC Simulation] Starting in ${arenaMode ? 'arena' : 'world'} mode with ${this.npcs.size} NPCs`);
    // Tick rate 200ms (5Hz). 2026-04-25: bumped from 500ms because client lerp
    // produced visible burst-stop pattern between snapshots — at 2Hz the client
    // converged ~70% in 500ms then sat for 100ms+ waiting for the next update.
    // 5Hz with proportionally smaller per-tick deltas (baseStep 110 → 44)
    // keeps total speed constant but motion reads as continuous, not stepped.
    this.intervalId = setInterval(() => this.tick(), 200);
  }

  switchMode(arenaMode: boolean) {
    if (this.arenaMode === arenaMode) return;
    console.log(`[NPC Simulation] Switching to ${arenaMode ? 'arena' : 'world'} mode`);
    this.stop();
    this.tickCount = 0;
    this.conversationCooldown = 0;
    this.combatCooldown = 0;
    this.idCounter = 0;
    this.pendingEvents = [];
    this.arenaSettings = { ...DEFAULT_ARENA_SETTINGS };
    this.arenaRound = null;
    this.start(arenaMode);
  }

  getMode(): 'arena' | 'world' {
    return this.arenaMode ? 'arena' : 'world';
  }

  updateSettings(settings: Partial<ArenaSettings>) {
    if (!this.arenaMode) return;
    if (settings.combatSpeed !== undefined) this.arenaSettings.combatSpeed = Math.max(0.5, Math.min(3, settings.combatSpeed));
    if (settings.moveSpeed !== undefined) this.arenaSettings.moveSpeed = Math.max(0.5, Math.min(3, settings.moveSpeed));
    if (settings.maxFights !== undefined) this.arenaSettings.maxFights = Math.max(1, Math.min(10, Math.round(settings.maxFights)));
    if (settings.respawnTime !== undefined) this.arenaSettings.respawnTime = Math.max(1, Math.min(30, Math.round(settings.respawnTime)));
  }

  getSettings(): ArenaSettings {
    return { ...this.arenaSettings };
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.npcs.clear();
    this.conversations.clear();
    this.combats.clear();
    console.log('[NPC Simulation] Stopped');
  }

  addListener(listener: SSEListener) { this.listeners.add(listener); }
  removeListener(listener: SSEListener) { this.listeners.delete(listener); }

  /**
   * Read-only snapshot — safe for non-broadcast callers (avatar chat context,
   * agent gateway perception, REST /api/npc/state, etc.). Does NOT drain
   * the collaboration broker queue; collaborationEvents is always empty.
   */
  getSnapshot(): SimulationSnapshot {
    return {
      npcs: Array.from(this.npcs.values()).map((n) => ({ ...n })),
      conversations: Array.from(this.conversations.values()).filter((c) => c.state === 'active').map((c) => ({ ...c, messages: [...c.messages] })),
      combats: Array.from(this.combats.values()).filter((c) => c.state === 'active').map((c) => ({ ...c, rounds: [...c.rounds] })),
      events: [...this.pendingEvents],
      autonomousAvatars: this.avatarAutonomyManager.getAutonomousAvatars(),
      browserClaws: this.getBrowserClawSnapshots(),
      arenaRound: this.arenaRound ? { ...this.arenaRound } : null,
      arenaSettings: { ...this.arenaSettings },
      collaborationEvents: [],
      timestamp: Date.now(),
    };
  }

  /**
   * Snapshot + drain the broker queue. Call ONLY from SSE broadcast —
   * drained entries are consumed and won't appear in any subsequent
   * snapshot. If no SSE listeners are connected, entries are preserved
   * so late-connecting clients can still see recent collaboration.
   */
  private buildBroadcastSnapshot(): SimulationSnapshot {
    const snapshot = this.getSnapshot();
    if (this.listeners.size > 0) {
      snapshot.collaborationEvents = getCollaborationBroker().drainLogEntries();
    }
    return snapshot;
  }

  private resolveSafeSpawn(rawX: number, rawY: number): { x: number; y: number } {
    const snapped = findNearestWalkable(rawX, rawY, NPC_COLLISION_HALF);
    if (snapped) return snapped;

    // Fallback for deep-in-collider legacy/restored positions where the
    // walkable search cannot escape within its planner radius.
    const clamped = clampPosition2D(
      rawX - WORLD_COLLIDER_MAP_HALF,
      rawY - WORLD_COLLIDER_MAP_HALF,
      NPC_COLLISION_HALF,
    );
    return {
      x: clamped.x + WORLD_COLLIDER_MAP_HALF,
      y: clamped.z + WORLD_COLLIDER_MAP_HALF,
    };
  }

  private initNpcs() {
    this.npcs.clear();
    for (const def of NPC_DEFINITIONS) {
      // Spawn resolve: choose a planner-valid walkable point before falling
      // back to raw clamp output. Clamp-only starts can sit on an AABB edge
      // without the clearance that path planning assumes.
      const spawn = this.resolveSafeSpawn(def.homeX, def.homeY);
      const spawnX = spawn.x;
      const spawnY = spawn.y;
      this.npcs.set(def.id, {
        id: def.id, name: def.name,
        x: spawnX, y: spawnY,
        targetX: spawnX, targetY: spawnY,
        homeX: spawnX, homeY: spawnY,
        patrolRadius: def.patrolRadius,
        direction: 'idle', species: def.species, color: def.color,
        inConversation: false, conversationCooldownUntil: 0,
        activity: 'idle', activityEmoji: '', destinationBuildingId: null,
        path: [], pathIndex: 0, activityEndsAt: 0,
        behaviorCooldown: 5 + Math.floor(Math.random() * 10),
        intentDescription: '',
        stuckTicks: 0,
        hp: def.stats.hp, maxHp: def.stats.hp,
        attack: def.stats.attack, defense: def.stats.defense, speed: def.stats.speed,
        inCombat: false, inventory: [], isDead: false, respawnAt: 0,
        hasSword: this.arenaMode, isOpenClaw: false,
        level: 1, kills: 0, xp: 0,
        baseAttack: def.stats.attack, baseDefense: def.stats.defense,
        baseSpeed: def.stats.speed, baseMaxHp: def.stats.hp,
        combatTargetId: null, lastAttackAt: 0, lastHitAt: 0,
        respawnedAt: 0, invulnerableUntil: 0,
        combatAction: null, combatActionAt: 0,
        autonomyMode: 'native',
      });
    }
  }

  // --- OpenClaw Methods ---

  registerOpenClaw(config: OpenClawRegistration, client: OpenClawClient, restoredState?: { lastX?: number; lastY?: number; knowledge?: string[] }) {
    if (config.mode === 'override') {
      if (!this.npcs.has(config.targetNpcId)) throw new Error(`NPC "${config.targetNpcId}" not found`);
      if (this.npcOverrides.has(config.targetNpcId)) throw new Error(`NPC "${config.targetNpcId}" is already overridden`);
      this.openClawBots.set(config.sessionId, { config, client });
      this.npcOverrides.set(config.targetNpcId, config.sessionId);
      const npc = this.npcs.get(config.targetNpcId)!;
      npc.isOpenClaw = true;
      npc.autonomyMode = config.autonomyMode ?? 'server-managed';
      console.log(`[OpenClaw] Override registered: ${config.targetNpcId} -> ${config.sessionId} (${npc.autonomyMode})`);
    } else {
      const avatarConfig = config as OpenClawAvatarConfig;
      const npcId = `oc-${config.sessionId}`;
      const rawSpawnX = restoredState?.lastX ?? avatarConfig.homeX;
      const rawSpawnY = restoredState?.lastY ?? avatarConfig.homeY;
      const spawn = this.resolveSafeSpawn(rawSpawnX, rawSpawnY);
      const spawnX = spawn.x;
      const spawnY = spawn.y;
      this.npcs.set(npcId, {
        id: npcId, name: avatarConfig.name,
        x: spawnX, y: spawnY,
        targetX: spawnX, targetY: spawnY,
        homeX: spawnX, homeY: spawnY,
        patrolRadius: avatarConfig.patrolRadius,
        direction: 'idle', species: avatarConfig.species, color: avatarConfig.color,
        inConversation: false, conversationCooldownUntil: 0,
        activity: 'idle', activityEmoji: '', destinationBuildingId: null,
        path: [], pathIndex: 0, activityEndsAt: 0, behaviorCooldown: 30, intentDescription: '',
        stuckTicks: 0,
        hp: avatarConfig.stats.hp, maxHp: avatarConfig.stats.hp,
        attack: avatarConfig.stats.attack, defense: avatarConfig.stats.defense, speed: avatarConfig.stats.speed,
        inCombat: false, inventory: [], isDead: false, respawnAt: 0,
        hasSword: this.arenaMode, isOpenClaw: true,
        level: 1, kills: 0, xp: 0,
        baseAttack: avatarConfig.stats.attack, baseDefense: avatarConfig.stats.defense,
        baseSpeed: avatarConfig.stats.speed, baseMaxHp: avatarConfig.stats.hp,
        combatTargetId: null, lastAttackAt: 0, lastHitAt: 0,
        respawnedAt: 0, invulnerableUntil: 0,
        combatAction: null, combatActionAt: 0,
        autonomyMode: config.autonomyMode ?? 'server-managed',
      });
      this.openClawBots.set(config.sessionId, { config, client });
      this.npcOverrides.set(npcId, config.sessionId);
      console.log(`[OpenClaw] Avatar injected: "${avatarConfig.name}" (${npcId}) [${config.autonomyMode ?? 'server-managed'}]${restoredState?.lastX != null ? ' [restored position]' : ''}`);
    }
  }

  unregisterOpenClaw(sessionId: string): boolean {
    const bot = this.openClawBots.get(sessionId);
    if (!bot) return false;
    if (bot.config.mode === 'override') {
      const npcId = bot.config.targetNpcId;
      this.cleanupNpcFromCombats(npcId);
      this.npcOverrides.delete(npcId);
      const npc = this.npcs.get(npcId);
      if (npc) { npc.isOpenClaw = false; npc.inCombat = false; npc.combatTargetId = null; }
    } else {
      const npcId = `oc-${sessionId}`;
      this.cleanupNpcFromCombats(npcId);
      this.npcOverrides.delete(npcId);
      this.npcs.delete(npcId);
    }
    this.openClawBots.delete(sessionId);
    console.log(`[OpenClaw] Unregistered: ${sessionId}`);
    return true;
  }

  getOpenClawClient(npcId: string): OpenClawClient | null {
    const sessionId = this.npcOverrides.get(npcId);
    if (!sessionId) return null;
    return this.openClawBots.get(sessionId)?.client ?? null;
  }

  getActiveOpenClawBots(): Array<{ sessionId: string; mode: string; npcId?: string; name?: string }> {
    const result: Array<{ sessionId: string; mode: string; npcId?: string; name?: string }> = [];
    for (const [sid, { config }] of this.openClawBots) {
      if (config.mode === 'override') {
        result.push({ sessionId: sid, mode: 'override', npcId: config.targetNpcId });
      } else {
        result.push({ sessionId: sid, mode: 'avatar', npcId: `oc-${sid}`, name: config.name });
      }
    }
    return result;
  }

  getOpenClawClientBySession(sessionId: string): OpenClawClient | null {
    return this.openClawBots.get(sessionId)?.client ?? null;
  }

  getOpenClawBotConfig(sessionId: string): OpenClawRegistration | null {
    return this.openClawBots.get(sessionId)?.config ?? null;
  }

  /**
   * Find all currently-connected agent session IDs whose agent IDs are in
   * the given set. Used by the skill-event-bus auto-install push so a
   * book read by a human triggers a `knowledge_added` SSE event on every
   * one of the user's active agent sessions.
   */
  findActiveSessionsByAgentIds(agentIds: Iterable<string>): string[] {
    const ids = new Set(agentIds);
    if (ids.size === 0) return [];
    const found: string[] = [];
    for (const [sid, { config }] of this.openClawBots) {
      if (ids.has(config.agentId)) found.push(sid);
    }
    return found;
  }

  /** Get avatar's current position for persistence on disconnect */
  getOpenClawAvatarPosition(sessionId: string): { x: number; y: number } | null {
    const npcId = `oc-${sessionId}`;
    const npc = this.npcs.get(npcId);
    return npc ? { x: npc.x, y: npc.y } : null;
  }

  // --- Agent Gateway Accessors ---

  /** Get NPC state by ID (for agent perception) */
  getNpcById(npcId: string): NpcRuntimeState | null {
    return this.npcs.get(npcId) ?? null;
  }

  /** Map a session ID to the NPC body it controls */
  getNpcIdForSession(sessionId: string): string | null {
    const bot = this.openClawBots.get(sessionId);
    if (!bot) return null;
    return bot.config.mode === 'override' ? bot.config.targetNpcId : `oc-${sessionId}`;
  }

  /** Check if a session ID corresponds to a valid agent */
  isValidAgentSession(sessionId: string): boolean {
    return this.openClawBots.has(sessionId);
  }

  /** Get all NPC states (for perception radius calculation) */
  getAllNpcs(): NpcRuntimeState[] {
    return Array.from(this.npcs.values());
  }

  /** Get all active conversations */
  getActiveConversations(): NpcConversation[] {
    return Array.from(this.conversations.values()).filter(c => c.state === 'active');
  }

  /** Get all active combats */
  getActiveCombats(): NpcCombat[] {
    return Array.from(this.combats.values()).filter(c => c.state === 'active');
  }

  /** Set an NPC's path (for agent-controlled movement) */
  setNpcPath(npcId: string, path: PathNode[], destinationBuildingId?: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    npc.path = path;
    npc.pathIndex = 0;
    npc.activity = 'walking';
    npc.activityEmoji = '';
    npc.destinationBuildingId = destinationBuildingId ?? null;
    npc.behaviorCooldown = 200; // Prevent server from overriding agent's path
  }

  /** Inject a chat bubble from an agent-controlled NPC */
  injectAgentChat(npcId: string, message: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    this.pendingEvents.push({
      id: this.nextId(),
      type: 'agent_chat',
      npcId: npc.id,
      npcName: npc.name,
      data: { message },
      timestamp: Date.now(),
    });
  }

  /** Set an NPC's combat action (for agent-controlled combat) */
  setNpcCombatAction(npcId: string, action: NpcRuntimeState['combatAction']) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    npc.combatAction = action;
    npc.combatActionAt = Date.now();
  }

  /** Set an NPC's activity and emoji (for agent emotes) */
  setNpcActivity(npcId: string, activity: NpcActivity, emoji: string) {
    const npc = this.npcs.get(npcId);
    if (!npc) return;
    npc.activity = activity;
    npc.activityEmoji = emoji;
    npc.activityEndsAt = Date.now() + 8000 + Math.random() * 12000;
  }

  // --- Browser Claw Methods ---

  registerBrowserClaw(sessionId: string, config: ClawConfig): void {
    const spawnX = 540 + Math.random() * 200;
    const spawnY = 300 + Math.random() * 200;
    this.browserClaws.set(sessionId, {
      config,
      sessionId,
      x: spawnX,
      y: spawnY,
      direction: 'idle',
      activity: 'idle',
      activityEmoji: '',
      lastHeartbeat: Date.now(),
    });
    console.log(`[BrowserClaw] Connected: "${config.name}" (${sessionId})`);
  }

  unregisterBrowserClaw(sessionId: string): boolean {
    const existed = this.browserClaws.delete(sessionId);
    if (existed) console.log(`[BrowserClaw] Disconnected: ${sessionId}`);
    return existed;
  }

  updateBrowserClawPosition(sessionId: string, x: number, y: number, direction?: string, activity?: string): boolean {
    const claw = this.browserClaws.get(sessionId);
    if (!claw) return false;
    claw.x = Math.max(16, Math.min(MAP_WIDTH - 16, x));
    claw.y = Math.max(16, Math.min(MAP_HEIGHT - 16, y));
    if (direction) claw.direction = direction;
    if (activity) claw.activity = activity;
    claw.lastHeartbeat = Date.now();
    return true;
  }

  getBrowserClaw(sessionId: string): { config: ClawConfig; sessionId: string; x: number; y: number } | null {
    return this.browserClaws.get(sessionId) ?? null;
  }

  getBrowserClawSnapshots(): BrowserClawSnapshot[] {
    return Array.from(this.browserClaws.values()).map((c) => ({
      sessionId: c.sessionId,
      name: c.config.name,
      species: c.config.species,
      color: c.config.color,
      x: c.x,
      y: c.y,
      direction: c.direction,
      activity: c.activity,
      activityEmoji: c.activityEmoji,
    }));
  }

  private cleanupStaleClaws() {
    const cutoff = Date.now() - 30000; // 30s no heartbeat
    for (const [sid, claw] of this.browserClaws) {
      if (claw.lastHeartbeat < cutoff) {
        this.browserClaws.delete(sid);
        console.log(`[BrowserClaw] Stale timeout: "${claw.config.name}" (${sid})`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — NPC-vs-NPC entity push-out
  // ---------------------------------------------------------------------------

  private resolveNpcNpcOverlaps() {
    const alive: NpcRuntimeState[] = [];
    for (const npc of this.npcs.values()) {
      if (!npc.isDead && !npc.inConversation) alive.push(npc);
    }

    // Half-width: chibi VRMs (milady-* and chibi-*) 25wu, everything else 50wu.
    const halfOf = (npc: NpcRuntimeState): number =>
      npc.id.startsWith('milady-') || npc.id.startsWith('chibi-') ? 25 : 50;

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i]!;
        const b = alive[j]!;
        const combinedHalf = halfOf(a) + halfOf(b);
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= combinedHalf * combinedHalf || distSq === 0) continue;

        const dist = Math.sqrt(distSq);
        const overlap = combinedHalf - dist;
        const pushX = (dx / dist) * (overlap * 0.5);
        const pushY = (dy / dist) * (overlap * 0.5);

        const rawAX = Math.max(16, Math.min(MAP_WIDTH - 16, a.x + pushX));
        const rawAY = Math.max(16, Math.min(MAP_HEIGHT - 16, a.y + pushY));
        const rawBX = Math.max(16, Math.min(MAP_WIDTH - 16, b.x - pushX));
        const rawBY = Math.max(16, Math.min(MAP_HEIGHT - 16, b.y - pushY));

        // Re-clamp pushed positions against building AABBs so two NPCs meeting
        // near a building wall can't push each other through it.
        const clA = clampPosition2D(rawAX - WORLD_COLLIDER_MAP_HALF, rawAY - WORLD_COLLIDER_MAP_HALF, halfOf(a));
        a.x = Math.max(16, Math.min(MAP_WIDTH - 16, clA.x + WORLD_COLLIDER_MAP_HALF));
        a.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clA.z + WORLD_COLLIDER_MAP_HALF));

        const clB = clampPosition2D(rawBX - WORLD_COLLIDER_MAP_HALF, rawBY - WORLD_COLLIDER_MAP_HALF, halfOf(b));
        b.x = Math.max(16, Math.min(MAP_WIDTH - 16, clB.x + WORLD_COLLIDER_MAP_HALF));
        b.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clB.z + WORLD_COLLIDER_MAP_HALF));
      }
    }
  }

  private nextId(): string { return `ev-${++this.idCounter}`; }

  private tick() {
    this.tickCount++;
    this.conversationCooldown = Math.max(0, this.conversationCooldown - 1);
    this.combatCooldown = Math.max(0, this.combatCooldown - 1);
    this.pendingEvents = [];

    this.handleRespawns();
    this.progressCombats();
    this.progressConversations();

    if (!this.arenaMode) {
      this.handleActivityDurations();
      this.planNpcBehaviors();
    }

    this.moveNpcs();

    // NPC-vs-NPC push-out (world mode only, Phase 4).
    // Runs after all positions are updated so we resolve overlaps once per tick
    // rather than re-checking every individual step. The push amount is small
    // enough (~30wu max) that one pass per 200ms tick is sufficient.
    if (!this.arenaMode) {
      this.resolveNpcNpcOverlaps();
    }

    if (this.conversationCooldown === 0 && this.tickCount % 40 === 0) {
      this.tryStartConversation().catch((err) => {
        console.error('[NPC Simulation] tryStartConversation failed:', err);
      });
    }
    if (this.arenaMode && this.combatCooldown === 0 && this.tickCount % 3 === 0) {
      this.tryStartCombat();
    }

    // Arena round progression
    if (this.arenaMode) this.tickRounds();

    // Sweep for orphaned combat flags every 10 ticks (~5s) in arena mode
    if (this.arenaMode && this.tickCount % 10 === 0) {
      this.sweepOrphanedCombatFlags();
    }

    // Autonomous avatar behavior (world mode only) — Phase 2: via SimulationRuntime
    if (!this.arenaMode) {
      this.avatarAutonomyManager.tick();
    }

    this.cleanup();
    this.broadcast();

    // Clean up stale browser claws every ~15s (30 ticks * 500ms)
    if (this.tickCount % 30 === 0) {
      this.cleanupStaleClaws();
    }

    // Periodic memory cleanup (~every 30 min: 3600 ticks * 500ms = 1800s)
    if (this.tickCount % 3600 === 0) {
      memoryService.cleanup().catch(console.error);
    }
  }

  private handleRespawns() {
    const now = Date.now();
    for (const npc of this.npcs.values()) {
      if (npc.isDead && npc.respawnAt > 0 && now >= npc.respawnAt) {
        npc.isDead = false; npc.hp = npc.maxHp;
        npc.x = npc.homeX; npc.y = npc.homeY;
        npc.targetX = npc.homeX; npc.targetY = npc.homeY;
        npc.inCombat = false; npc.inConversation = false; npc.respawnAt = 0;
        npc.direction = 'idle'; npc.activity = 'idle'; npc.activityEmoji = '';
        npc.path = []; npc.pathIndex = 0; npc.destinationBuildingId = null;
        npc.behaviorCooldown = 10;
        npc.stuckTicks = 0;
        npc.combatTargetId = null;
        npc.respawnedAt = now;
        npc.invulnerableUntil = now + 3000;
        console.log(`[NPC Simulation] ${npc.name} respawned (Lv${npc.level})`);
      }
    }
  }

  // --- Behavior Planning (World Mode) ---

  /**
   * Validate a candidate (gamePx) target against the pixel-accurate AABB
   * clamp. If the target sits inside a collider, snap it outward to the
   * nearest collision-free game-pixel via `findNearestWalkable`. Returns
   * null when no safe spot exists within the search radius — callers must
   * then re-pick or fall back to behaviorCooldown.
   *
   * Added 2026-05-22 to plug RCA gap #3: planners used to validate only
   * against `hasClearance` (coarse A* grid) and skipped the per-axis pad-
   * vs-real-extent test. A "valid" wander/visit/approach target could land
   * inside a prop AABB or in the gap between A*'s 11-tile pad and the
   * real building half-extents (e.g. messaging-channels halfX=850 wu vs
   * pad-only=576 wu).
   */
  private snapPlannerTarget(
    tx: number,
    ty: number,
    entityHalf: number = NPC_COLLISION_HALF,
  ): { x: number; y: number } | null {
    if (
      hasClearance(tx, ty, 3) &&
      isCollisionFreeWorld(tx, ty, entityHalf)
    ) {
      return { x: tx, y: ty };
    }
    return findNearestWalkable(tx, ty, entityHalf);
  }

  private findSafePath(
    npc: NpcRuntimeState,
    tx: number,
    ty: number,
    entityHalf: number = NPC_COLLISION_HALF,
  ): PathNode[] {
    const path = findPath(npc.x, npc.y, tx, ty);
    if (path.length === 0) return [];
    return isPathCollisionFree(npc.x, npc.y, path, entityHalf) ? path : [];
  }

  private planNpcBehaviors() {
    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation || npc.inCombat) continue;
      if (npc.activity !== 'idle') continue;
      if (npc.isOpenClaw && npc.autonomyMode === 'self-managed') continue;

      npc.behaviorCooldown--;
      if (npc.behaviorCooldown > 0) continue;

      // Free-roaming wanderers (`buildingId === ''` in NPC_DEFINITIONS) skip
      // the building-visit and idle-near-home branches entirely. Hermes and
      // chibi wanderers do not use the old milady-/wanderer- ID prefixes, so
      // prefix checks quietly sent them back into building-wall paths.
      // Building-anchored NPCs (Bubbles, Inky, Hazel, etc.) keep the original
      // distribution — for them the idle-near-home wiggle is a meaningful
      // behavior because they have a real anchor (their building).
      const isFreeRoamer = FREE_ROAMER_IDS.has(npc.id);
      const roll = Math.random();
      if (isFreeRoamer) {
        // Free roamers (Milady/Hermes/chibi/crustacean wanderers) stay in the
        // town commons. They skip building visits entirely (buildings live on
        // the outer ring — walking there reads as leaving town) and
        // only approach nearby NPCs that are also inside the ring. The
        // dedicated `planCenterWander` picks targets within
        // FREE_ROAMER_MAX_RADIUS of the town center.
        if (roll < 0.50) this.planApproachNearbyNpc(npc);
        else this.planCenterWander(npc);
        npc.behaviorCooldown = Math.floor(npc.behaviorCooldown / 2);
      } else {
        if (roll < 0.40) this.planVisitBuilding(npc);
        else if (roll < 0.60) this.planApproachNpc(npc);
        else if (roll < 0.90) this.planIdleNearHome(npc);
        else this.planWander(npc);
      }
    }
  }

  private planVisitBuilding(npc: NpcRuntimeState) {
    const buildingIds = Object.keys(NPC_BUILDING_CENTERS).filter((id) => id !== npc.id);
    if (buildingIds.length === 0) return;

    const withDist = buildingIds.map((id) => {
      const c = NPC_BUILDING_CENTERS[id];
      const dx = c.x - npc.x; const dy = c.y - npc.y;
      return { id, dist: Math.sqrt(dx * dx + dy * dy) };
    }).sort((a, b) => a.dist - b.dist);

    const candidates = withDist.slice(0, 5);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const center = NPC_BUILDING_CENTERS[target.id];

    // Up to 5 attempts to find a building approach point that's both
    // pathable AND outside the building AABB (2026-05-22). The naive
    // center+offset frequently lands inside the new larger building
    // colliders (e.g. messaging-channels halfX=850 wu). When the raw
    // candidate fails the collision test, snapPlannerTarget snaps outward.
    for (let attempt = 0; attempt < 5; attempt++) {
      const offsetX = (Math.random() - 0.5) * 40;
      const offsetY = 20 + Math.random() * 20;
      const snapped = this.snapPlannerTarget(center.x + offsetX, center.y + offsetY);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.destinationBuildingId = target.id;
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = `Walking to ${target.id}`;
        npc.behaviorCooldown = 120;
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  private planApproachNpc(npc: NpcRuntimeState) {
    const others = Array.from(this.npcs.values()).filter(
      (o) => o.id !== npc.id && !o.isDead && !o.inCombat && !o.inConversation && o.activity !== 'sleeping'
    );
    if (others.length === 0) { npc.behaviorCooldown = 20; return; }

    const target = others[Math.floor(Math.random() * others.length)];

    // Pick a stand-off point 80 wu from the target toward us. Walking to
    // target.x/y directly can land us on top of (or inside) the target's
    // own AABB or wedge us against whatever wall the target is parked at
    // (2026-05-22). 5 attempts: first the chaser-direction stand-off,
    // then random angles if that's blocked.
    const STAND_OFF = 80;
    const tdx = target.x - npc.x;
    const tdy = target.y - npc.y;
    const tdist = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    for (let attempt = 0; attempt < 5; attempt++) {
      let standX: number;
      let standY: number;
      if (attempt === 0) {
        // Stand-off along the line from chaser → target.
        standX = target.x - (tdx / tdist) * STAND_OFF;
        standY = target.y - (tdy / tdist) * STAND_OFF;
      } else {
        const angle = Math.random() * Math.PI * 2;
        standX = target.x + Math.cos(angle) * STAND_OFF;
        standY = target.y + Math.sin(angle) * STAND_OFF;
      }
      const snapped = this.snapPlannerTarget(standX, standY);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = `Approaching ${target.name}`;
        npc.behaviorCooldown = 80;
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  private planIdleNearHome(npc: NpcRuntimeState) {
    // Up to 5 attempts — the home position may sit just outside a building
    // AABB and a small wiggle radius can land the candidate inside
    // (2026-05-22).
    for (let attempt = 0; attempt < 5; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 20 + Math.random() * 40;
      const tx = Math.max(32, Math.min(MAP_WIDTH - 32, npc.homeX + Math.cos(angle) * radius));
      const ty = Math.max(32, Math.min(MAP_HEIGHT - 32, npc.homeY + Math.sin(angle) * radius));
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = 'Strolling nearby';
        npc.behaviorCooldown = 40 + Math.floor(Math.random() * 40);
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  private planWander(npc: NpcRuntimeState) {
    // Up to 5 attempts so a single bad random sample doesn't burn the tick
    // (2026-05-22). Random map points can easily land in a building or
    // prop AABB now that we rasterize 18 colliders with real extents.
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = 64 + Math.random() * (MAP_WIDTH - 128);
      const ty = 64 + Math.random() * (MAP_HEIGHT - 128);
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = 'Wandering';
        npc.behaviorCooldown = 80 + Math.floor(Math.random() * 60);
        return;
      }
    }
    npc.behaviorCooldown = 20;
  }

  // Free-roamer wander that picks a point inside the town RING (annulus
  // between FREE_ROAMER_MIN_RADIUS and FREE_ROAMER_MAX_RADIUS). Prevents
  // Miladys and crustacean wanderers both from crowding on top of the
  // town-center furniture AND from drifting to the map edge / outer
  // building ring.
  private planCenterWander(npc: NpcRuntimeState) {
    // Uniform area sampling in an annulus:
    //   r = sqrt(u * (R² - r²) + r²)
    // preserves equal area density at every radius — without the sqrt
    // more points would cluster near the inner edge.
    //
    // Retry up to 12 times per plan call so a single blocked sample near a
    // town-center prop doesn't freeze movement for a full planning cycle.
    const rMinSq = FREE_ROAMER_MIN_RADIUS * FREE_ROAMER_MIN_RADIUS;
    const rMaxSq = FREE_ROAMER_MAX_RADIUS * FREE_ROAMER_MAX_RADIUS;
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random() * (rMaxSq - rMinSq) + rMinSq);
      const tx = TOWN_CENTER_X + Math.cos(angle) * radius;
      const ty = TOWN_CENTER_Y + Math.sin(angle) * radius;
      // Reject targets with < 3 tiles of clearance from any blocked tile —
      // prevents NPCs pathfinding to the edge of a building exclusion zone
      // where they then stop pressed against the visible wall.
      // 2026-05-22: also reject targets inside any pixel-accurate AABB
      // (covers town-center props like shisha-oasis halfX=420 wu that
      // wouldn't show up in the coarse A* grid for the FREE_ROAMER ring).
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = 'Strolling the town ring';
        npc.behaviorCooldown = 80 + Math.floor(Math.random() * 60);
        return;
      }
    }
    // All 12 samples blocked — give up this tick but replan soon.
    npc.behaviorCooldown = 10;
  }

  // Free-roamer approach: only considers NPCs that are ALSO inside the
  // outer ring bound (MAX_RADIUS), so a Milady never chases a building
  // resident past the building ring. Approach targets may be closer to
  // center than MIN_RADIUS (e.g. another wanderer passing through the
  // inner circle) — the approacher's next planCenterWander will snap
  // them back out to the ring. Falls back to a center-wander if no
  // suitable target.
  //
  // IMPORTANT: pathfinds to a STAND-OFF position 80wu from the target,
  // not the target's exact position. Without the offset, multiple
  // approachers all converge to a single world coordinate — observed
  // 2026-04-24 with Driftwood/Marlin/Riptide all frozen at exactly
  // x=4195.9919, y=2823.1967, so Marlin and Riptide rendered INSIDE
  // Driftwood's mesh and looked missing. Each approacher picks a random
  // angle around the target so multiple approachers spread around the
  // target instead of stacking.
  private planApproachNearbyNpc(npc: NpcRuntimeState) {
    const rMaxSq = FREE_ROAMER_MAX_RADIUS * FREE_ROAMER_MAX_RADIUS;
    const others = Array.from(this.npcs.values()).filter((o) => {
      if (o.id === npc.id) return false;
      if (o.isDead || o.inCombat || o.inConversation) return false;
      if (o.activity === 'sleeping') return false;
      const dx = o.x - TOWN_CENTER_X;
      const dy = o.y - TOWN_CENTER_Y;
      return dx * dx + dy * dy <= rMaxSq;
    });
    if (others.length === 0) { this.planCenterWander(npc); return; }
    const target = others[Math.floor(Math.random() * others.length)];
    // If approacher is already within the stand-off radius of this target,
    // approaching them again just keeps us clustered. Wander instead.
    const dx0 = target.x - npc.x; const dy0 = target.y - npc.y;
    const distToTargetSq = dx0 * dx0 + dy0 * dy0;
    const standOff = 250;
    if (distToTargetSq <= standOff * standOff) {
      this.planCenterWander(npc);
      return;
    }
    // Stand-off: aim `standOff` wu from the target at a random angle, not AT
    // the target. 2026-04-24: bumped 80 → 250 because the 80wu gap wasn't
    // enough separation — all 3 crustaceans + 5 Miladys chain-approached each
    // other into an ~100wu cluster. 250wu is roughly 2.5× a Milady's visible
    // height (112 * 1.6m ≈ 180 wu), enough daylight between NPCs that they
    // read as distinct.
    // Try up to 8 stand-off angles before giving up. Reject targets without
    // >=3 tiles of clearance so approachers don't end up pressed against
    // town props or each other near the target NPC.
    for (let attempt = 0; attempt < 8; attempt++) {
      const approachAngle = Math.random() * Math.PI * 2;
      const tx = target.x + Math.cos(approachAngle) * standOff;
      const ty = target.y + Math.sin(approachAngle) * standOff;
      // Combined clearance + pixel-accurate AABB test (2026-05-22).
      // Without the AABB test the stand-off can sit inside a prop the
      // target was parked next to (shisha-oasis is 420 wu half-extent,
      // bigger than the 250 wu stand-off itself).
      const snapped = this.snapPlannerTarget(tx, ty);
      if (!snapped) continue;
      const path = this.findSafePath(npc, snapped.x, snapped.y);
      if (path.length > 0) {
        npc.activity = 'walking'; npc.activityEmoji = '';
        npc.path = path; npc.pathIndex = 0;
        npc.intentDescription = `Approaching ${target.name}`;
        npc.behaviorCooldown = 80;
        return;
      }
    }
    {
      // Pathfinding failed (stand-off point may be inside a blocked tile or
      // off-map). Fall back to a center-wander instead of sitting idle —
      // otherwise the NPC just loops back into the same failing approach.
      this.planCenterWander(npc);
    }
  }

  // --- Activity Duration ---

  private handleActivityDurations() {
    const now = Date.now();
    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation || npc.inCombat) continue;

      // Arrived at destination — start building activity
      if (npc.activity === 'walking' && npc.path.length > 0 && npc.pathIndex >= npc.path.length) {
        if (npc.destinationBuildingId) {
          const activities = BUILDING_ACTIVITIES[npc.destinationBuildingId] ?? ['thinking'];
          const picked = activities[Math.floor(Math.random() * activities.length)];
          npc.activity = picked;
          npc.activityEmoji = ACTIVITY_EMOJIS[picked];
          npc.activityEndsAt = now + 8000 + Math.random() * 12000;
          npc.intentDescription = `${picked} at ${npc.destinationBuildingId}`;
          npc.path = []; npc.pathIndex = 0;
        } else {
          npc.activity = 'idle'; npc.activityEmoji = '';
          npc.path = []; npc.pathIndex = 0;
          npc.behaviorCooldown = 20 + Math.floor(Math.random() * 20);
        }
      }

      // Activity expired
      if (npc.activityEndsAt > 0 && now >= npc.activityEndsAt) {
        npc.activity = 'idle'; npc.activityEmoji = '';
        npc.activityEndsAt = 0; npc.destinationBuildingId = null;
        npc.behaviorCooldown = 10 + Math.floor(Math.random() * 20);
        npc.intentDescription = '';
      }
    }
  }

  private moveNpcs() {
    // World-mode baseStep × tickRate = wu/s.
    // 2026-04-25: tick rate moved 2Hz → 5Hz, baseStep scaled 110 → 44 to keep
    // speed at 220 wu/s (44 / 0.2s = 220). Smaller per-tick deltas = smoother
    // client lerp = motion reads closer to Nori (who has zero net translation).
    const baseStep = this.arenaMode ? (14 + Math.random() * 4) * this.arenaSettings.moveSpeed : 44;

    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation) continue;

      // In-combat NPCs in approach phase move toward their target at 1.5x speed
      if (npc.inCombat && npc.combatTargetId) {
        const target = this.npcs.get(npc.combatTargetId);
        if (target && !target.isDead) {
          const dx = target.x - npc.x;
          const dy = target.y - npc.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 40) {
            const approachStep = Math.min(baseStep * 1.5, dist);
            const desiredX = npc.x + (dx / dist) * approachStep;
            const desiredY = npc.y + (dy / dist) * approachStep;
            if (!this.arenaMode) {
              const clamped = clampPosition2D(
                desiredX - WORLD_COLLIDER_MAP_HALF,
                desiredY - WORLD_COLLIDER_MAP_HALF,
                30,
              );
              npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, clamped.x + WORLD_COLLIDER_MAP_HALF));
              npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clamped.z + WORLD_COLLIDER_MAP_HALF));
            } else {
              npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, desiredX));
              npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, desiredY));
            }
            npc.direction = dx > 0 ? 'right' : 'left';
          }
        }
        continue;
      }

      if (npc.inCombat) continue;
      if (npc.activity !== 'idle' && npc.activity !== 'walking') continue;

      if (this.arenaMode) {
        const nearest = this.findNearestAliveNpc(npc);
        if (nearest) {
          const jitterX = (Math.random() - 0.5) * 40;
          const jitterY = (Math.random() - 0.5) * 40;
          npc.targetX = nearest.x + jitterX;
          npc.targetY = nearest.y + jitterY;
        }
        this.moveTowardTarget(npc, baseStep);
        continue;
      }

      // World mode: follow A* path
      if (npc.path.length > 0 && npc.pathIndex < npc.path.length) {
        const wp = npc.path[npc.pathIndex];
        const dx = wp.x - npc.x; const dy = wp.y - npc.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 4) {
          npc.pathIndex++;
          if (npc.pathIndex >= npc.path.length) npc.direction = 'idle';
          npc.stuckTicks = 0;
        } else {
          const step = Math.min(baseStep, dist);
          const desiredX = npc.x + (dx / dist) * step;
          const desiredY = npc.y + (dy / dist) * step;

          // AABB world-collider clamp — convert game-px to world-space, clamp,
          // then convert back. entityHalf=30 (NPC capsule half-width in wu).
          const prevX = npc.x;
          const prevY = npc.y;
          if (!isCollisionFreeWorld(desiredX, desiredY, 30)) {
            npc.path = [];
            npc.pathIndex = 0;
            npc.activity = 'idle';
            npc.activityEmoji = '';
            npc.destinationBuildingId = null;
            npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
            npc.stuckTicks = 0;
            npc.direction = 'idle';
            continue;
          }
          const wx = desiredX - WORLD_COLLIDER_MAP_HALF;
          const wz = desiredY - WORLD_COLLIDER_MAP_HALF;
          const clamped = clampPosition2D(wx, wz, 30);
          npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, clamped.x + WORLD_COLLIDER_MAP_HALF));
          npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clamped.z + WORLD_COLLIDER_MAP_HALF));

          // Track stuck state (2026-05-22). The existing single-frame "abandon
          // on first clamp hit" is good, but path-following can produce
          // wedge-walks where the clamp shaves a little distance off and the
          // NPC creeps along the wall. stuckTicks catches that residual case.
          const moved = Math.abs(npc.x - prevX) + Math.abs(npc.y - prevY);
          if (moved < 2) {
            npc.stuckTicks++;
          } else {
            npc.stuckTicks = 0;
          }

          // If collider blocked this step, abandon current path and pick a new
          // patrol target — prevents NPCs humping a wall for the whole path.
          if (clamped.hit || npc.stuckTicks >= 4) {
            npc.path = [];
            npc.pathIndex = 0;
            npc.activity = 'idle';
            npc.activityEmoji = '';
            npc.destinationBuildingId = null;
            npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
            npc.stuckTicks = 0;
          } else {
            npc.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
          }
        }
      } else if (npc.activity === 'idle' && npc.path.length === 0) {
        npc.direction = 'idle';
        npc.stuckTicks = 0;
      }
    }
  }

  private moveTowardTarget(npc: NpcRuntimeState, baseStep: number) {
    const dx = npc.targetX - npc.x; const dy = npc.targetY - npc.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < (this.arenaMode ? 35 : 10)) {
      npc.direction = 'idle';
      npc.stuckTicks = 0;
    } else {
      const step = Math.min(baseStep, dist);
      const desiredX = npc.x + (dx / dist) * step;
      const desiredY = npc.y + (dy / dist) * step;
      if (!this.arenaMode) {
        const prevX = npc.x;
        const prevY = npc.y;
        if (!isCollisionFreeWorld(desiredX, desiredY, 30)) {
          npc.path = [];
          npc.pathIndex = 0;
          npc.activity = 'idle';
          npc.activityEmoji = '';
          npc.destinationBuildingId = null;
          npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
          npc.stuckTicks = 0;
          npc.direction = 'idle';
          return;
        }
        const clamped = clampPosition2D(
          desiredX - WORLD_COLLIDER_MAP_HALF,
          desiredY - WORLD_COLLIDER_MAP_HALF,
          30,
        );
        npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, clamped.x + WORLD_COLLIDER_MAP_HALF));
        npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, clamped.z + WORLD_COLLIDER_MAP_HALF));

        // Mirror of path-step abandon at L~1062 — direct-target walkers also
        // need stuck-recovery (2026-05-22). Without this, an NPC whose target
        // sits inside an AABB wedges against the wall forever — activity stays
        // 'walking', behaviorCooldown never re-arms, planNpcBehaviors skips
        // them on every tick (gated on activity === 'idle').
        const moved = Math.abs(npc.x - prevX) + Math.abs(npc.y - prevY);
        if (clamped.hit || moved < 2) {
          npc.stuckTicks++;
        } else {
          npc.stuckTicks = 0;
        }
        if (clamped.hit || npc.stuckTicks >= 4) {
          npc.path = [];
          npc.pathIndex = 0;
          npc.activity = 'idle';
          npc.activityEmoji = '';
          npc.destinationBuildingId = null;
          npc.behaviorCooldown = 5 + Math.floor(Math.random() * 10);
          npc.stuckTicks = 0;
          npc.direction = 'idle';
          return;
        }
      } else {
        npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, desiredX));
        npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, desiredY));
      }
      npc.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
  }

  private findNearestAliveNpc(npc: NpcRuntimeState): NpcRuntimeState | null {
    let nearest: NpcRuntimeState | null = null;
    let nearestDist = Infinity;
    const now = Date.now();
    for (const other of this.npcs.values()) {
      if (other.id === npc.id || other.isDead || now < other.invulnerableUntil) continue;
      const dx = other.x - npc.x; const dy = other.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) { nearestDist = dist; nearest = other; }
    }
    return nearest;
  }

  private getIdleAliveNpcs(): NpcRuntimeState[] {
    const now = Date.now();
    return Array.from(this.npcs.values()).filter(
      (n) => !n.isDead && !n.inConversation && !n.inCombat && now >= n.conversationCooldownUntil
    );
  }

  private findNearestIdleNpc(npc: NpcRuntimeState, maxDist: number): NpcRuntimeState | null {
    let nearest: NpcRuntimeState | null = null;
    let nearestDist = maxDist;
    const now = Date.now();
    for (const other of this.npcs.values()) {
      if (other.id === npc.id || other.isDead || other.inConversation || other.inCombat || now < other.invulnerableUntil || now < other.conversationCooldownUntil) continue;
      const dx = other.x - npc.x;
      const dy = other.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) { nearestDist = dist; nearest = other; }
    }
    return nearest;
  }

  private async tryStartConversation() {
    const idle = this.getIdleAliveNpcs();
    if (idle.length < 2) return;

    const initiator = idle[Math.floor(Math.random() * idle.length)];
    // 2500 game-px partner-search radius — tuned for the Phase 6.2 world
    // (11520×11520). Earlier 400px value was sized for the ~5120 world and
    // was too tight after the expansion: NPCs scattered across 12 ring slots
    // (each ~2680px apart on the ring) almost never landed within 400px, so
    // tryStartConversation kept exiting without a partner and no bubbles
    // appeared. 2500px lets adjacent ring residents + town-center wanderers
    // find each other while still requiring meaningful proximity.
    const partner = this.findNearestIdleNpc(initiator, 2500);
    if (!partner) return;

    initiator.inConversation = true; partner.inConversation = true;
    initiator.activity = 'socializing'; initiator.activityEmoji = ACTIVITY_EMOJIS.socializing;
    initiator.path = []; initiator.pathIndex = 0;
    partner.activity = 'socializing'; partner.activityEmoji = ACTIVITY_EMOJIS.socializing;
    partner.path = []; partner.pathIndex = 0;
    this.conversationCooldown = 40;

    const resetNpcsOnFailure = () => {
      initiator.inConversation = false; initiator.activity = 'idle'; initiator.activityEmoji = '';
      partner.inConversation = false; partner.activity = 'idle'; partner.activityEmoji = '';
    };

    try {
      const def1 = NPC_DEFINITIONS.find((d: NpcDefinition) => d.id === initiator.id) ?? this.buildAvatarDef(initiator);
      const def2 = NPC_DEFINITIONS.find((d: NpcDefinition) => d.id === partner.id) ?? this.buildAvatarDef(partner);
      const client1 = this.getOpenClawClient(initiator.id);
      const client2 = this.getOpenClawClient(partner.id);

      // Build conversation context with crypto speciality
      const npc1Theme = BUILDING_OPENCLAW_THEMES[def1.buildingId ?? ''];
      const npc2Theme = BUILDING_OPENCLAW_THEMES[def2.buildingId ?? ''];
      const cryptoContext = [
        npc1Theme ? `${def1.name} specializes in ${npc1Theme.focus.split(',')[0]}` : '',
        npc2Theme ? `${def2.name} specializes in ${npc2Theme.focus.split(',')[0]}` : '',
      ].filter(Boolean).join('. ') || undefined;

      let messages;
      if (client1 || client2) {
        messages = await generateOpenClawConversation(def1, def2, client1, client2, this.arenaMode, cryptoContext);
      } else {
        messages = await generateNpcConversation(def1, def2, this.arenaMode, cryptoContext);
      }

      const firstSpeaker = messages.length > 0 ? messages[0].npcId : null;
      const conversation: NpcConversation = {
        id: this.nextId(), npc1Id: initiator.id, npc2Id: partner.id,
        messages, currentIndex: 0, nextMessageAt: Date.now() + 2500,
        state: 'active', typingNpcId: firstSpeaker, typingUntil: Date.now() + 2500,
      };
      this.conversations.set(conversation.id, conversation);
      console.log(`[NPC Simulation] Conversation started: ${initiator.name} <-> ${partner.name}`);
    } catch (err) {
      console.error(`[NPC Simulation] Conversation generation failed, resetting NPCs:`, err);
      resetNpcsOnFailure();
    }
  }

  /** Build a minimal NpcDefinition for OpenClaw avatar NPCs */
  private buildAvatarDef(npc: NpcRuntimeState): NpcDefinition {
    return {
      id: npc.id,
      name: npc.name,
      species: npc.species as any,
      color: npc.color,
      buildingId: '',
      patrolRadius: npc.patrolRadius,
      homeX: npc.homeX,
      homeY: npc.homeY,
      stats: { hp: npc.maxHp, attack: npc.attack, defense: npc.defense, speed: npc.speed },
      personality: 'An OpenClaw-powered bot with a unique personality.',
    };
  }

  private progressConversations() {
    const now = Date.now();
    for (const convo of this.conversations.values()) {
      if (convo.state !== 'active') continue;
      if (now < convo.nextMessageAt) continue;

      if (convo.typingNpcId && now >= convo.typingUntil) convo.typingNpcId = null;

      convo.currentIndex++;
      if (convo.currentIndex >= convo.messages.length) {
        convo.state = 'done'; convo.typingNpcId = null;
        const npc1 = this.npcs.get(convo.npc1Id);
        const npc2 = this.npcs.get(convo.npc2Id);
        const convoCooldownMs = 15000 + Math.random() * 20000;
        if (npc1) { npc1.inConversation = false; npc1.activity = 'idle'; npc1.activityEmoji = ''; npc1.path = []; npc1.pathIndex = 0; npc1.behaviorCooldown = 3; npc1.conversationCooldownUntil = Date.now() + convoCooldownMs; }
        if (npc2) { npc2.inConversation = false; npc2.activity = 'idle'; npc2.activityEmoji = ''; npc2.path = []; npc2.pathIndex = 0; npc2.behaviorCooldown = 3; npc2.conversationCooldownUntil = Date.now() + convoCooldownMs; }
      } else {
        const nextMsg = convo.messages[convo.currentIndex];
        const typingDuration = 2000 + Math.random() * 1500;
        convo.typingNpcId = nextMsg.npcId;
        convo.typingUntil = now + typingDuration;
        convo.nextMessageAt = now + typingDuration + 2000;
      }
    }
  }

  private tryStartCombat() {
    // Don't start combat during intermission or after arena completion
    if (this.arenaRound && this.arenaRound.state !== 'fighting') return;

    const activeCombats = Array.from(this.combats.values()).filter((c) => c.state === 'active');
    if (activeCombats.length >= this.arenaSettings.maxFights) return;

    const now = Date.now();
    const idle = this.getIdleAliveNpcs().filter((n) => now >= n.invulnerableUntil);
    if (idle.length < 2) return;
    const initiator = idle[Math.floor(Math.random() * idle.length)];
    const target = this.findNearestIdleNpc(initiator, 400);
    if (!target) return;

    initiator.inCombat = true; target.inCombat = true;
    initiator.combatTargetId = target.id;
    target.combatTargetId = initiator.id;
    this.combatCooldown = 4;
    if (target.x > initiator.x) { initiator.direction = 'right'; target.direction = 'left'; }
    else { initiator.direction = 'left'; target.direction = 'right'; }

    const combat: NpcCombat = {
      id: this.nextId(), attacker: initiator.id, defender: target.id,
      rounds: [], state: 'active', winner: null, lootTransferred: [],
      startedAt: now, nextRoundAt: now + 1500, phase: 'approach',
    };
    this.combats.set(combat.id, combat);
  }

  private selectCombatAction(): NpcRuntimeState['combatAction'] {
    const roll = Math.random();
    if (roll < 0.50) return 'attack';
    if (roll < 0.65) return 'heavy';
    if (roll < 0.80) return 'block';
    if (roll < 0.90) return 'dodge';
    return 'combo';
  }

  private progressCombats() {
    const now = Date.now();
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active' || now < combat.nextRoundAt) continue;
      const attacker = this.npcs.get(combat.attacker);
      const defender = this.npcs.get(combat.defender);

      if (!attacker || !defender) {
        combat.state = 'done'; combat.phase = 'done';
        const survivor = attacker || defender;
        if (survivor) { survivor.inCombat = false; survivor.combatTargetId = null; survivor.combatAction = null; }
        continue;
      }

      if (attacker.isDead || defender.isDead || now < attacker.invulnerableUntil || now < defender.invulnerableUntil) {
        combat.state = 'done'; combat.phase = 'done';
        attacker.inCombat = false; attacker.combatTargetId = null; attacker.combatAction = null;
        defender.inCombat = false; defender.combatTargetId = null; defender.combatAction = null;
        continue;
      }

      if (combat.phase === 'approach') {
        combat.phase = 'fighting';
        combat.nextRoundAt = now + Math.round(800 / this.arenaSettings.combatSpeed);
        continue;
      }

      const faster = attacker.speed >= defender.speed ? attacker : defender;
      const slower = attacker.speed >= defender.speed ? defender : attacker;

      const fasterAction = faster.combatAction ?? this.selectCombatAction();
      const slowerAction = slower.combatAction ?? this.selectCombatAction();
      faster.combatAction = fasterAction;
      faster.combatActionAt = now;
      slower.combatAction = slowerAction;
      slower.combatActionAt = now;

      // Faster attacks first
      if (fasterAction === 'combo') {
        for (let i = 0; i < 3; i++) {
          const hit = this.calculateAttack(faster, slower, now, 0.6, slowerAction);
          combat.rounds.push(hit);
          if (slower.hp <= 0) { this.resolveCombatDeath(combat, faster, slower); break; }
        }
        if ((combat as any).state === 'done') continue;
      } else if (fasterAction === 'block' || fasterAction === 'dodge') {
        // Defensive action — no attack from faster this round
      } else {
        const damageMultiplier = fasterAction === 'heavy' ? 1.5 : 1.0;
        const hit = this.calculateAttack(faster, slower, now, damageMultiplier, slowerAction);
        combat.rounds.push(hit);
        if (slower.hp <= 0) { this.resolveCombatDeath(combat, faster, slower); continue; }
      }

      // Slower retaliates
      if (slowerAction === 'combo') {
        for (let i = 0; i < 3; i++) {
          const hit = this.calculateAttack(slower, faster, now, 0.6, fasterAction);
          combat.rounds.push(hit);
          if (faster.hp <= 0) { this.resolveCombatDeath(combat, slower, faster); break; }
        }
        if ((combat as any).state === 'done') continue;
      } else if (slowerAction === 'block' || slowerAction === 'dodge') {
        // Defensive — no attack
      } else {
        const damageMultiplier = slowerAction === 'heavy' ? 1.5 : 1.0;
        const hit = this.calculateAttack(slower, faster, now, damageMultiplier, fasterAction);
        combat.rounds.push(hit);
        if (faster.hp <= 0) { this.resolveCombatDeath(combat, slower, faster); continue; }
      }

      combat.nextRoundAt = now + Math.round(2000 / this.arenaSettings.combatSpeed);
    }
  }

  private calculateAttack(
    attacker: NpcRuntimeState, defender: NpcRuntimeState, now: number,
    damageMultiplier: number = 1.0,
    defenderAction?: NpcRuntimeState['combatAction']
  ): { attacker: string; damage: number; defenderHpAfter: number; isCrit?: boolean; isDodge?: boolean; isBlocked?: boolean } {
    if (defenderAction === 'dodge') {
      return { attacker: attacker.id, damage: 0, defenderHpAfter: defender.hp, isDodge: true };
    }

    const critChance = Math.min(0.35, 0.05 + Math.max(0, attacker.speed - defender.speed) * 0.02);
    const isCrit = Math.random() < critChance;
    const critMultiplier = isCrit ? 1.5 : 1.0;
    const rawDamage = attacker.attack * (0.8 + Math.random() * 0.4);
    const mitigated = defender.defense * 0.8;
    let damage = Math.max(1, Math.round((rawDamage - mitigated) * critMultiplier * damageMultiplier));

    const isBlocked = defenderAction === 'block';
    if (isBlocked) {
      damage = Math.max(1, Math.round(damage * 0.5));
    }

    defender.hp = Math.max(0, defender.hp - damage);
    attacker.lastAttackAt = now;
    defender.lastHitAt = now;
    return { attacker: attacker.id, damage, defenderHpAfter: defender.hp, isCrit: isCrit || undefined, isDodge: undefined, isBlocked: isBlocked || undefined };
  }

  private resolveCombatDeath(combat: NpcCombat, winner: NpcRuntimeState, loser: NpcRuntimeState) {
    combat.state = 'done'; combat.phase = 'done'; combat.winner = winner.id;
    if (loser.inventory.length > 0) {
      combat.lootTransferred = [...loser.inventory];
      winner.inventory.push(...loser.inventory);
      loser.inventory = [];
    }
    winner.inventory.push(`loot-${this.nextId()}`);

    // XP and leveling
    winner.kills++;
    const xpGained = 30 + loser.level * 15;
    winner.xp += xpGained;
    const xpToNext = () => 50 * winner.level;
    while (winner.xp >= xpToNext()) {
      winner.xp -= xpToNext();
      winner.level++;
      winner.attack = winner.baseAttack + (winner.level - 1);
      winner.defense = winner.baseDefense + (winner.level - 1);
      winner.speed = winner.baseSpeed + (winner.level - 1);
      winner.maxHp = winner.baseMaxHp + (winner.level - 1) * 5;
      winner.hp = Math.min(winner.maxHp, winner.hp + 10);
      this.pendingEvents.push({
        id: this.nextId(), type: 'level_up',
        npcId: winner.id, npcName: winner.name,
        data: { newLevel: winner.level }, timestamp: Date.now(),
      });
      console.log(`[NPC Simulation] ${winner.name} leveled up to Lv${winner.level}!`);
    }

    winner.inCombat = false; winner.combatTargetId = null; winner.combatAction = null;
    loser.isDead = true; loser.inCombat = false; loser.combatTargetId = null; loser.combatAction = null;
    loser.respawnAt = Date.now() + this.arenaSettings.respawnTime * 1000;
    console.log(`[NPC Simulation] ${winner.name} (Lv${winner.level}) defeated ${loser.name} (Lv${loser.level})! +${xpGained}XP`);
  }

  private cleanupNpcFromCombats(npcId: string) {
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      if (combat.attacker !== npcId && combat.defender !== npcId) continue;
      combat.state = 'done'; combat.phase = 'done';
      const opponentId = combat.attacker === npcId ? combat.defender : combat.attacker;
      const opponent = this.npcs.get(opponentId);
      if (opponent) { opponent.inCombat = false; opponent.combatTargetId = null; opponent.combatAction = null; }
    }
  }

  private sweepOrphanedCombatFlags() {
    const activeCombatNpcs = new Set<string>();
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      activeCombatNpcs.add(combat.attacker);
      activeCombatNpcs.add(combat.defender);
    }
    for (const npc of this.npcs.values()) {
      if (npc.inCombat && !activeCombatNpcs.has(npc.id)) {
        npc.inCombat = false;
        npc.combatTargetId = null;
      }
    }
  }

  // --- Round System ---

  private initRounds() {
    this.arenaRound = {
      round: 1,
      maxRounds: DEFAULT_MAX_ROUNDS,
      state: 'fighting',
      roundStartedAt: Date.now(),
      intermissionEndsAt: 0,
    };
    this.pendingEvents.push({
      id: this.nextId(), type: 'round_start',
      npcId: '', npcName: '',
      data: { round: 1, maxRounds: DEFAULT_MAX_ROUNDS },
      timestamp: Date.now(),
    });
    console.log(`[Arena] Round 1/${DEFAULT_MAX_ROUNDS} started`);
  }

  private tickRounds() {
    if (!this.arenaRound) return;
    const now = Date.now();
    if (this.arenaRound.state === 'fighting') {
      if (now - this.arenaRound.roundStartedAt >= ROUND_DURATION_MS) this.endRound();
    } else if (this.arenaRound.state === 'intermission') {
      if (now >= this.arenaRound.intermissionEndsAt) this.startNextRound();
    }
  }

  private endRound() {
    if (!this.arenaRound) return;
    const now = Date.now();
    const currentRound = this.arenaRound.round;

    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      combat.state = 'done'; combat.phase = 'done';
      const a = this.npcs.get(combat.attacker);
      const d = this.npcs.get(combat.defender);
      if (a) { a.inCombat = false; a.combatTargetId = null; }
      if (d) { d.inCombat = false; d.combatTargetId = null; }
    }

    for (const npc of this.npcs.values()) {
      npc.hp = npc.maxHp;
      npc.isDead = false; npc.respawnAt = 0;
      npc.inCombat = false; npc.combatTargetId = null;
      npc.x = npc.homeX; npc.y = npc.homeY;
      npc.targetX = npc.homeX; npc.targetY = npc.homeY;
      npc.direction = 'idle';
    }

    this.pendingEvents.push({
      id: this.nextId(), type: 'round_end',
      npcId: '', npcName: '', data: { round: currentRound }, timestamp: now,
    });

    if (currentRound >= this.arenaRound.maxRounds) {
      const winner = this.getArenaWinner();
      this.arenaRound.state = 'complete';
      this.pendingEvents.push({
        id: this.nextId(), type: 'arena_complete',
        npcId: winner?.id ?? '', npcName: winner?.name ?? 'Nobody',
        data: { winnerId: winner?.id, winnerName: winner?.name, winnerKills: winner?.kills ?? 0, winnerLevel: winner?.level ?? 1 },
        timestamp: now,
      });
      console.log(`[Arena] Complete! Winner: ${winner?.name ?? 'Nobody'} (Lv${winner?.level}, ${winner?.kills} kills)`);
    } else {
      this.arenaRound.state = 'intermission';
      this.arenaRound.intermissionEndsAt = now + INTERMISSION_MS;
      for (const npc of this.npcs.values()) {
        npc.invulnerableUntil = this.arenaRound.intermissionEndsAt;
      }
      console.log(`[Arena] Round ${currentRound} ended. Intermission...`);
    }
  }

  private startNextRound() {
    if (!this.arenaRound) return;
    const now = Date.now();
    this.arenaRound.round++;
    this.arenaRound.state = 'fighting';
    this.arenaRound.roundStartedAt = now;
    this.arenaRound.intermissionEndsAt = 0;

    this.pendingEvents.push({
      id: this.nextId(), type: 'round_start',
      npcId: '', npcName: '',
      data: { round: this.arenaRound.round, maxRounds: this.arenaRound.maxRounds },
      timestamp: now,
    });
    console.log(`[Arena] Round ${this.arenaRound.round}/${this.arenaRound.maxRounds} started`);
  }

  private getArenaWinner(): NpcRuntimeState | null {
    let best: NpcRuntimeState | null = null;
    for (const npc of this.npcs.values()) {
      if (!best || npc.kills > best.kills || (npc.kills === best.kills && npc.level > best.level)) {
        best = npc;
      }
    }
    return best;
  }

  private cleanup() {
    // Remove done conversations/combats older than 15s
    const cutoff = Date.now() - 15000;
    for (const [id, convo] of this.conversations) {
      if (convo.state === 'done' && convo.nextMessageAt < cutoff) {
        this.conversations.delete(id);
      }
    }
    for (const [id, combat] of this.combats) {
      if (combat.state === 'done' && combat.startedAt < cutoff) {
        this.combats.delete(id);
      }
    }
  }

  private broadcast() {
    // Use the broadcast-specific snapshot that drains the collaboration
    // broker queue. Non-broadcast callers (avatar chat, agent gateway, REST)
    // must NOT call this method to avoid losing collab events.
    const snapshot = this.buildBroadcastSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener may have disconnected
        this.listeners.delete(listener);
      }
    }
  }
}

export const npcSimulation = new NpcSimulation();

export function startSimulation(arenaMode: boolean) {
  npcSimulation.start(arenaMode);
}

export function stopSimulation() {
  npcSimulation.stop();
}
