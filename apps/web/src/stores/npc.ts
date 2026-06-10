import { create } from 'zustand';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { clampMovement2D, ENTITY_HALF_HUMANOID } from '@/lib/three/collision/world-colliders';

const NPC_HALF_W = MAP_WIDTH / 2;
const NPC_HALF_H = MAP_HEIGHT / 2;
const RETIRED_WANDERING_NPC_IDS = new Set(['wanderer-marlin', 'wanderer-riptide']);

export interface NpcSpriteState {
  id: string;
  name: string;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /**
   * Time (Date.now ms) the LATEST snapshot for this NPC arrived from the
   * server. Used by the dead-reckoning extrapolator in arena-npcs.tsx —
   * between server ticks (5 Hz / 200 ms) the client projects the target
   * position forward at the velocity derived from (prevX,prevY)→(x,y)
   * over the elapsed snapshot interval, then lerps `currentPos` toward
   * that PROJECTED target instead of the stale snapshot. Eliminates the
   * 5 Hz pumping pattern that the pure-lerp approach inherited from the
   * server tick rate.
   */
  ts: number;
  /**
   * ms between the previous and current server snapshot for this NPC.
   * Approximately 200 (server tick) but can be larger if the SSE stream
   * skipped a snapshot. Used as the denominator when computing velocity
   * for dead reckoning — without it a missed frame would inflate velocity
   * and snap the NPC forward.
   */
  tsDelta: number;
  direction: 'idle' | 'left' | 'right' | 'up' | 'down';
  species: string;
  color: number;
  hp: number;
  maxHp: number;
  isDead: boolean;
  hasSword: boolean;
  inCombat: boolean;
  inConversation: boolean;
  inventory: string[];
  isOpenClaw: boolean;
  combatAction: 'attack' | 'heavy' | 'block' | 'dodge' | 'combo' | 'special' | null;
  combatActionAt: number;
  /** Smooth facing angle (radians) — set by NPC controller for possessed NPCs */
  facingAngle: number | null;
  /**
   * True while the possessed player NPC is sprinting (shift held / joystick past
   * the run threshold). Set by NpcController via moveNpc; read in arena-npcs.tsx
   * VRMNpcMesh to switch the animator to the 'run' clip. Undefined on wandering
   * NPCs (they never sprint) → treated as false.
   */
  isRunning?: boolean;
  /** Override the default idle clip for VRM NPCs. Undefined = use 'idle'. */
  defaultIdleClip?: string;
  /**
   * True for remote-player entries adapted from `RemotePlayerState`. The
   * entity-vs-local-player push-out in `arena-npcs.tsx` must be skipped for
   * these: each client computes a DIFFERENT push vector (based on its own
   * avatar position), so applying it produces per-client visual divergence and
   * breaks the authoritative-shared-world premise. The AABB building clamp
   * (`clampMovement2D`) is still applied -- static colliders are per-client
   * identical, so the clamp is benign.
   */
  isRemotePlayer?: boolean;
}

export interface NpcChatBubble {
  npcId: string;
  speaker: string;
  text: string;
  expiresAt: number;
}

export interface CombatEvent {
  id: string;
  attackerId: string;
  defenderId: string;
  damage: number;
  defenderHpAfter: number;
  expiresAt: number;
}

export interface LootEvent {
  id: string;
  winnerId: string;
  winnerName: string;
  loserId: string;
  loserName: string;
  itemCount: number;
  expiresAt: number;
}

interface ServerConversation {
  id: string;
  npc1Id: string;
  npc2Id: string;
  messages: Array<{ npcId: string; npcName: string; text: string }>;
  currentIndex: number;
  state: 'active' | 'done';
}

interface ServerCombat {
  id: string;
  attacker: string;
  defender: string;
  rounds: Array<{ attacker: string; damage: number; defenderHpAfter: number }>;
  state: 'active' | 'done';
  winner: string | null;
  lootTransferred: string[];
}

interface ServerSnapshot {
  npcs: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    direction: string;
    species: string;
    color: number;
    hp: number;
    maxHp: number;
    isDead: boolean;
    hasSword: boolean;
    inCombat: boolean;
    inConversation: boolean;
    inventory: string[];
    isOpenClaw?: boolean;
    activity?: string;
    activityEmoji?: string;
    intentDescription?: string;
    combatAction?: string | null;
    combatActionAt?: number;
  }>;
  conversations: ServerConversation[];
  combats: ServerCombat[];
  events?: Array<{
    id: string;
    type: string;
    npcId: string;
    npcName: string;
    data: any;
    timestamp: number;
  }>;
  timestamp: number;
}

/** Well-known ID for the dedicated player NPC spawned in NPC mode */
export const PLAYER_NPC_ID = '__player-npc__';

export interface NpcStoreState {
  npcs: NpcSpriteState[];
  chatBubbles: NpcChatBubble[];
  combatEvents: CombatEvent[];
  lootEvents: LootEvent[];
  combatLog: string[];
  connected: boolean;
  setConnected: (v: boolean) => void;
  updateFromSnapshot: (snapshot: ServerSnapshot) => void;
  cleanupExpired: () => void;
  /** Directly move a possessed NPC — skips wander logic, updates prevX/prevY for interpolation */
  moveNpc: (id: string, x: number, y: number, direction: NpcSpriteState['direction'], facingAngle?: number | null, isRunning?: boolean) => void;
  /** Spawn a dedicated player NPC at world center for NPC mode */
  spawnPlayerNpc: () => void;
  /** Remove the dedicated player NPC when leaving NPC mode */
  removePlayerNpc: () => void;
}

// Demo NPCs shown when API server is not connected
function makeDemoNpc(id: string, name: string, x: number, y: number, species: string, color: number, isOpenClaw = false, defaultIdleClip?: string): NpcSpriteState {
  // ts=0 (sentinel) tells the dead-reckoning extrapolator in arena-npcs.tsx
  // to skip projection entirely — demo NPCs are wandered client-side and
  // never have a server snapshot to extrapolate from. tsDelta=200 is the
  // safe default so any code that divides by it doesn't see Infinity.
  return { id, name, x, y, prevX: x, prevY: y, ts: 0, tsDelta: 200, direction: 'idle', species, color, hp: 100, maxHp: 100, isDead: false, hasSword: false, inCombat: false, inConversation: false, inventory: [], isOpenClaw, combatAction: null, combatActionAt: 0, facingAngle: null, defaultIdleClip };
}

// Demo NPC positions mirror the live free-roaming roster when SSE is down.
// Keep this list intentionally small: one version of each avatar family, no
// duplicate lobster crowd.
const DEMO_NPCS: NpcSpriteState[] = [
  // Milady VRM wandering NPCs — use milady_official_7 and milady_official_8 to avoid
  // sharing a VRM instance with the most-common player avatar picks (official_1 is the
  // default; official_5 is popular). The vrm-loader caches one VRM per path — two NPCs
  // sharing the same path would share vrm.scene and clobber each other's animation state.
  // IDs + spawn coords match NPC_DEFINITIONS in packages/shared. All spawns
  // are clear of building pathfinding-blocked zones. When connected, server
  // snapshots replace these in place by id; disconnected mode runs them
  // through the client wander loop.
  makeDemoNpc('milady-miu',     'Miu',       3825, 7200, 'milady_official_7', 0xffc0ff, false, 'looking_around'),
  makeDemoNpc('milady-kyoko',   'Kyoko',     7650, 4275, 'milady_official_8', 0xc0e8ff, false, 'squat'),
  makeDemoNpc('milady-vivi',    'Vivi',      3825, 4275, 'milady_official_2', 0xffd0a0),
  // 5 additional Miladys restored 2026-05-27 (full 8-Milady cast)
  makeDemoNpc('milady-aria',    'Aria',      4900, 3700, 'milady_official_1', 0xffb0c8),
  makeDemoNpc('milady-suki',    'Suki',      8200, 5100, 'milady_official_3', 0xc0ffd8),
  makeDemoNpc('milady-hana',    'Hana',      6400, 8100, 'milady_official_4', 0xfff0a0),
  makeDemoNpc('milady-yumi',    'Yumi',      3400, 6800, 'milady_official_5', 0xb0e0ff),
  makeDemoNpc('milady-ren',     'Ren',       3300, 4900, 'milady_official_6', 0xd0b0ff),
  // 2026-05-12 PM: Hermes wanderers restored with per-VRM auto-fit (Mira,
  // Cyrus, Tekk) — see npc-definitions.ts. Each species lands at
  // VRM_NPC_TARGET_HEIGHT_WU regardless of cm-vs-m authoring units.
  makeDemoNpc('hermes-mira',  'Mira',  5250, 5250, 'hermes_female', 0xb088ff),
  makeDemoNpc('hermes-cyrus', 'Cyrus', 4050, 2250, 'hermes_male',   0x4b6cb7),
  makeDemoNpc('hermes-tekk',  'Tekk',  2850, 5700, 'tekk',          0x30c060),
  makeDemoNpc('chibi-eliza',  'Eliza', 6700, 5500, 'eliza_chibi',   0xff7043),
  makeDemoNpc('chibi-milady', 'Mila',  4900, 6100, 'milady_chibi',  0xec407a),
  makeDemoNpc('wanderer-driftwood', 'Driftwood', 2250, 3600, 'lobster',     0x8d6e63),
];

// Demo NPC wandering — makes NPCs walk around when not connected to server
interface WanderState { targetX: number; targetY: number; waitUntil: number; }
const wanderStates = new Map<string, WanderState>();

const WANDER_MARGIN = 80;
const WANDER_MAX_X = MAP_WIDTH - WANDER_MARGIN;
const WANDER_MAX_Y = MAP_HEIGHT - WANDER_MARGIN;
const WANDER_TARGET_MIN_DIST = 280;
const WANDER_TARGET_MAX_DIST = 760;

function isWalkableGamePoint(x: number, y: number): boolean {
  const worldX = x - NPC_HALF_W;
  const worldZ = y - NPC_HALF_H;
  const clamped = clampMovement2D(worldX, worldZ, worldX, worldZ, ENTITY_HALF_HUMANOID);
  return !clamped.hit;
}

function pickNewTarget(npc: NpcSpriteState): WanderState {
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = WANDER_TARGET_MIN_DIST + Math.random() * (WANDER_TARGET_MAX_DIST - WANDER_TARGET_MIN_DIST);
    const tx = Math.max(WANDER_MARGIN, Math.min(WANDER_MAX_X, npc.x + Math.cos(angle) * radius));
    const ty = Math.max(WANDER_MARGIN, Math.min(WANDER_MAX_Y, npc.y + Math.sin(angle) * radius));
    if (isWalkableGamePoint(tx, ty)) {
      return { targetX: tx, targetY: ty, waitUntil: 0 };
    }
  }
  return { targetX: npc.x, targetY: npc.y, waitUntil: Date.now() + 1000 };
}

function tickDemoNpcs(npcs: NpcSpriteState[]): NpcSpriteState[] {
  const now = Date.now();
  // 2026-05-29: was 4 px/tick (=40 px/s) — 5.5× slower than the real 5 Hz server
  // sim (npc-simulation baseStep 44/tick = 220 px/s). The slow fallback made every
  // local `bun run start` playtest read as slow-motion + foot-slide, because leg
  // cadence is tuned for the real sim speed. Match it: 22 px/tick @ 10 Hz = 220 px/s.
  const speed = 22; // px/tick → 220 px/s, matches server sim (44/tick @ 5 Hz)

  // Lazy import to avoid circular dep — both stores are plain Zustand, no circular JS modules
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
  const possessedNpcId = useGameStore.getState().possessedNpcId;

  // 2026-05-11 — Mutate npc objects in place (same pattern as updateFromSnapshot).
  // Previously this returned `{ ...npc, ... }` every 100ms which broke useShallow
  // and re-rendered the ArenaNpcs subtree 10×/sec in disconnected mode.
  for (let i = 0; i < npcs.length; i++) {
    const npc = npcs[i];
    if (possessedNpcId && npc.id === possessedNpcId) continue;
    let ws = wanderStates.get(npc.id);
    if (!ws) {
      ws = pickNewTarget(npc);
      ws.waitUntil = now + Math.random() * 800; // stagger starts, not multi-second freezes
      wanderStates.set(npc.id, ws);
    }

    if (now < ws.waitUntil) {
      npc.direction = 'idle';
      continue;
    }

    const dx = ws.targetX - npc.x;
    const dy = ws.targetY - npc.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 10) {
      const newWs = pickNewTarget(npc);
      // Real free-roamers rarely freeze for seconds — brief pause then move on.
      newWs.waitUntil = now + Math.random() * 600;
      wanderStates.set(npc.id, newWs);
      npc.direction = 'idle';
      continue;
    }

    // Clamp the step to the remaining distance so a fast NPC can NEVER overshoot
    // its target. Without this, a 22 px/tick step that lands ~11 px past a target
    // leaves dist≈11 (>the 10 px arrival threshold), so the NPC never re-targets
    // and bounces ±11 px around the point forever — a stable overshoot limit cycle
    // that reads as "spinning in place" (facing flips 180° each bounce). At the old
    // 4 px/tick speed the overshoot was always <10 px so the arrival check caught it.
    const moveLen = Math.min(speed, dist);
    const mx = (dx / dist) * moveLen;
    const my = (dy / dist) * moveLen;
    npc.prevX = npc.x;
    npc.prevY = npc.y;
    // SIM-LEVEL collision clamp against world AABB colliders. Without this
    // the wander loop walks NPCs straight through buildings/props; only the
    // render-time clamp in arena-npcs.tsx kept the visible mesh pinned to
    // walls while the sim happily marched on inside. Convert game-px ↔ world
    // (worldX = gameX - HALF; gameX = worldX + HALF) around the clamp.
    const newGameX = npc.x + mx;
    const newGameY = npc.y + my;
    const clamped = clampMovement2D(
      npc.x - NPC_HALF_W, npc.y - NPC_HALF_H,
      newGameX - NPC_HALF_W, newGameY - NPC_HALF_H,
      ENTITY_HALF_HUMANOID,
    );
    npc.x = clamped.x + NPC_HALF_W;
    npc.y = clamped.z + NPC_HALF_H;
    const moved = Math.abs(npc.x - npc.prevX) + Math.abs(npc.y - npc.prevY);
    if (clamped.hit || moved < 0.5) {
      const newWs = pickNewTarget(npc);
      newWs.waitUntil = now + 200 + Math.random() * 300;
      wanderStates.set(npc.id, newWs);
      npc.direction = 'idle';
      continue;
    }
    // Give the moving NPC a real ts/tsDelta so the renderer's entity-interpolation
    // lerp path (arena-npcs.tsx alpha = elapsed/tsDelta) drives it, instead of the
    // ts===0 snap-to-current branch that produced visible 10 Hz stepping. prevX/prevY
    // were captured above before the move, so prev→x lerps continuously each 100 ms.
    npc.ts = now;
    npc.tsDelta = 100;
    if (Math.abs(dx) > Math.abs(dy)) {
      npc.direction = dx > 0 ? 'right' : 'left';
    } else {
      npc.direction = dy > 0 ? 'down' : 'up';
    }
  }
  return npcs;
}

let demoIntervalId: ReturnType<typeof setInterval> | null = null;

function startDemoWander() {
  if (demoIntervalId) return; // already running
  demoIntervalId = setInterval(() => {
    const state = useNpcStore.getState();
    // Only wander when not connected to server
    const updated = tickDemoNpcs(state.npcs);
    useNpcStore.setState({ npcs: updated });
  }, 100);
}

function stopDemoWander() {
  if (demoIntervalId) {
    clearInterval(demoIntervalId);
    demoIntervalId = null;
  }
}

export const useNpcStore = create<NpcStoreState>((set, get) => ({
  npcs: DEMO_NPCS,
  chatBubbles: [],
  combatEvents: [],
  lootEvents: [],
  combatLog: [],
  connected: false,

  setConnected: (v) => {
    if (get().connected === v) return;
    set({ connected: v });
    if (v) {
      // Server connected — stop client wander. The server NPC sim now drives
      // ALL seeded NPCs (including the 2 Milady VRM brand wanderers, since
      // they were added to NPC_DEFINITIONS 2026-04-21). Snapshots carry their
      // positions, conversations, and chat bubbles.
      stopDemoWander();
    } else {
      // Disconnected — restore DEMO_NPCS and run the client-side wander loop
      // so the world still feels alive without a server connection.
      if (get().npcs.length === 0) {
        set({ npcs: DEMO_NPCS });
      }
      startDemoWander();
    }
  },

  updateFromSnapshot: (snapshot) => {
    const state = get();
    const now = Date.now();

    // Update NPC positions (store previous for lerp)
    // If a server NPC is idle, keep the client-side position so wander can move it.
    // Skip the possessed NPC entirely so player input isn't overwritten by the server.
    const { possessedNpcId } = (require('@/stores/game') as typeof import('@/stores/game')).useGameStore.getState();
    const activeSnapshotNpcs = snapshot.npcs.filter((n) => !RETIRED_WANDERING_NPC_IDS.has(n.id));
    const prevMap = new Map(state.npcs.map((n) => [n.id, n]));
    const npcs: NpcSpriteState[] = activeSnapshotNpcs.map((n) => {
      const prev = prevMap.get(n.id);
      // Never overwrite the possessed NPC — player controls it via NpcController
      if (n.id === possessedNpcId && prev) {
        return prev;
      }
      // Connected SSE snapshots are authoritative for position, including idle
      // frames. Keeping prior client coordinates when the server goes idle
      // leaves the rendered NPC short of its final waypoint; the next movement
      // then reads as a sideways slide/snap from stale coordinates.
      // Build the candidate object first, then check identity against prev.
      // If every field is equal we return the PREVIOUS reference — this preserves
      // React.memo's shallow-prop bailout in GLBNpcMesh / VRMNpcMesh and prevents
      // 13-18 needless re-renders per SSE tick when nothing actually changed.
      // Dead-reckoning bookkeeping. tsDelta is the wall-clock gap between
      // this snapshot and the previous one for this NPC. Default ~200 ms
      // (server tick) but we measure rather than assume so a skipped SSE
      // frame doesn't double the inferred velocity. Clamp the floor to
      // avoid divide-by-near-zero if two snapshots somehow land in the
      // same ms (test fixtures, replay tools).
      const tsDelta = prev ? Math.max(16, now - prev.ts) : 200;
      const candidate: NpcSpriteState = {
        id: n.id,
        name: n.name,
        x: n.x,
        y: n.y,
        prevX: prev?.x ?? n.x,
        prevY: prev?.y ?? n.y,
        ts: now,
        tsDelta,
        // direction always from server — never sticky (see comment above).
        direction: n.direction as NpcSpriteState['direction'],
        species: n.species,
        color: n.color,
        hp: n.hp,
        maxHp: n.maxHp,
        isDead: n.isDead,
        hasSword: n.hasSword,
        inCombat: n.inCombat,
        inConversation: n.inConversation,
        inventory: n.inventory,
        isOpenClaw: n.isOpenClaw ?? false,
        combatAction: (n.combatAction as NpcSpriteState['combatAction']) ?? null,
        combatActionAt: n.combatActionAt ?? 0,
        facingAngle: prev?.facingAngle ?? null,
        // Preserve client-side seed value — server snapshots never carry defaultIdleClip.
        defaultIdleClip: prev?.defaultIdleClip,
      };
      // 2026-05-11 — Position mutation pattern.
      // React-rendered NPC components subscribe via useShallow(s => s.npcs),
      // so when EVERY element preserves its reference between snapshots the
      // top-level subscriber doesn't re-render at all. Previously, the SSE
      // tick rebuilt every walking NPC's object (new x/y → new ref) which
      // forced ArenaNpcs to re-render 5×/s and re-evaluate the full 18-NPC
      // subtree. Chrome trace showed function T (React scheduler flushWork)
      // at 530 ms/call as a result.
      //
      // Fix: if every NON-position field is equal, mutate position on the
      // PREVIOUS object and return its reference. React never sees the
      // change. The NPC's useFrame still reads fresh x/y because npcRef.current
      // points at the same (now-mutated) object.
      //
      // Cost: speech bubbles + activity indicators read npc.x/y from React
      // state, so they lag by however long the npc identity stays stable.
      // These appear on stationary NPCs (in combat / in conversation) so the
      // visual lag is negligible (200-500 ms before the indicator updates
      // when a fight finally ends and the NPC moves).
      if (prev && npcFieldsEqual(prev, candidate)) {
        // Mutate every non-identity field on prev. Only conversation flip,
        // rename, species swap, or color change ever invalidate identity in
        // this game (no combat / no hp / no death systems exist yet, but
        // their fields ride along via mutation so they stay correct if
        // they're ever brought back).
        prev.x = candidate.x;
        prev.y = candidate.y;
        prev.prevX = candidate.prevX;
        prev.prevY = candidate.prevY;
        // ts / tsDelta drive dead-reckoning in useFrame. They must reflect
        // the LATEST snapshot timing even when we're returning the prev
        // reference — otherwise the extrapolator keeps using a stale base
        // time and the projected target falls further behind every tick.
        prev.ts = candidate.ts;
        prev.tsDelta = candidate.tsDelta;
        prev.direction = candidate.direction;
        prev.hp = candidate.hp;
        prev.maxHp = candidate.maxHp;
        prev.isDead = candidate.isDead;
        prev.hasSword = candidate.hasSword;
        prev.inCombat = candidate.inCombat;
        prev.combatAction = candidate.combatAction;
        prev.combatActionAt = candidate.combatActionAt;
        prev.inventory = candidate.inventory;
        // facingAngle stays on prev — never overwritten by SSE.
        return prev;
      }
      return candidate;
    });

    // Process conversations into chat bubbles
    const newBubbles: NpcChatBubble[] = [...state.chatBubbles.filter((b) => b.expiresAt > now)];
    for (const convo of snapshot.conversations) {
      if (convo.state !== 'active' || convo.currentIndex >= convo.messages.length) continue;
      const msg = convo.messages[convo.currentIndex];
      if (RETIRED_WANDERING_NPC_IDS.has(msg.npcId)) continue;
      // Only add if we don't already have this exact bubble
      const exists = newBubbles.some(
        (b) => b.npcId === msg.npcId && b.text === msg.text
      );
      if (!exists) {
        newBubbles.push({
          npcId: msg.npcId,
          speaker: msg.npcName,
          text: msg.text,
          expiresAt: now + 6000,
        });
      }
    }

    // Process events (agent chat bubbles, etc.)
    if (snapshot.events) {
      for (const event of snapshot.events) {
        if (RETIRED_WANDERING_NPC_IDS.has(event.npcId)) continue;
        // Agent chat bubbles
        if (event.type === 'agent_chat' && event.data?.message) {
          const exists = newBubbles.some(
            (b) => b.npcId === event.npcId && b.text === event.data.message
          );
          if (!exists) {
            newBubbles.push({
              npcId: event.npcId,
              speaker: event.npcName,
              text: event.data.message,
              expiresAt: now + 8000,
            });
          }
        }
      }
    }

    // Process combats into combat events
    const newCombatEvents: CombatEvent[] = [...state.combatEvents.filter((e) => e.expiresAt > now)];
    const newLootEvents: LootEvent[] = [...state.lootEvents.filter((e) => e.expiresAt > now)];
    const newLog = [...state.combatLog];

    for (const combat of snapshot.combats) {
      // Add latest round as combat event
      if (combat.rounds.length > 0) {
        const lastRound = combat.rounds[combat.rounds.length - 1];
        const eventId = `${combat.id}-r${combat.rounds.length}`;
        const exists = newCombatEvents.some((e) => e.id === eventId);
        if (!exists) {
          newCombatEvents.push({
            id: eventId,
            attackerId: lastRound.attacker,
            defenderId:
              lastRound.attacker === combat.attacker ? combat.defender : combat.attacker,
            damage: lastRound.damage,
            defenderHpAfter: lastRound.defenderHpAfter,
            expiresAt: now + 3000,
          });
        }
      }

      // Check for combat conclusion
      if (combat.state === 'done' && combat.winner) {
        const winnerId = combat.winner;
        const loserId = winnerId === combat.attacker ? combat.defender : combat.attacker;
        const winnerNpc = activeSnapshotNpcs.find((n) => n.id === winnerId);
        const loserNpc = activeSnapshotNpcs.find((n) => n.id === loserId);
        if (winnerNpc && loserNpc) {
          const lootId = `loot-${combat.id}`;
          const lootExists = newLootEvents.some((e) => e.id === lootId);
          if (!lootExists) {
            newLootEvents.push({
              id: lootId,
              winnerId,
              winnerName: winnerNpc.name,
              loserId,
              loserName: loserNpc.name,
              itemCount: combat.lootTransferred.length,
              expiresAt: now + 5000,
            });
            const logEntry = `${winnerNpc.name} defeated ${loserNpc.name}${combat.lootTransferred.length > 0 ? ` and looted ${combat.lootTransferred.length} items` : ''}!`;
            if (!newLog.includes(logEntry)) {
              newLog.push(logEntry);
              if (newLog.length > 20) newLog.shift();
            }
          }
        }
      }
    }

    // Preserve the dedicated player NPC only when in NPC mode — server doesn't know about it.
    // Do NOT re-inject when controlMode is 'player' or 'autonomous': doing so caused the
    // player NPC (a full-size lobster at world center 2560,2560) to persist in agent mode
    // and obscure the bazaar / town-center buildings.
    const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
    const isNpcMode = useGameStore.getState().controlMode === 'npc';
    const playerNpc = isNpcMode ? state.npcs.find((n) => n.id === PLAYER_NPC_ID) : undefined;
    const finalNpcs = playerNpc ? [playerNpc, ...npcs] : npcs;

    set({
      npcs: finalNpcs,
      chatBubbles: newBubbles,
      combatEvents: newCombatEvents,
      lootEvents: newLootEvents,
      combatLog: newLog,
    });
  },

  cleanupExpired: () => {
    const ts = Date.now();
    set((s) => ({
      chatBubbles: s.chatBubbles.filter((b) => b.expiresAt > ts),
      combatEvents: s.combatEvents.filter((e) => e.expiresAt > ts),
      lootEvents: s.lootEvents.filter((e) => e.expiresAt > ts),
    }));
  },

  moveNpc: (id, x, y, direction, facingAngle = null, isRunning = false) => {
    // 2026-05-11 — Mutate in place + skip setState entirely if no identity-check
    // field changed. moveNpc fires at 60Hz during NPC-mode play; the old
    // `s.npcs.map(...)` returned a new array + new element every call, kicking
    // off a React reconciliation pass even though only position changed.
    const s = get();
    const npc = s.npcs.find((n) => n.id === id);
    if (!npc) return;
    npc.prevX = npc.x;
    npc.prevY = npc.y;
    npc.x = x;
    npc.y = y;
    npc.direction = direction;
    npc.facingAngle = facingAngle;
    npc.isRunning = isRunning;
    // No setState call — the mutated object is the same reference subscribers
    // already hold, and useFrame reads via npcRef.current.
  },

  spawnPlayerNpc: () => {
    const exists = get().npcs.some((n) => n.id === PLAYER_NPC_ID);
    if (exists) return;
    const playerNpc: NpcSpriteState = {
      id: PLAYER_NPC_ID,
      name: 'You',
      // 2026-06-10: was (3840, 3840) — the OLD world center from the 7680px
      // map era, stranding NPC-mode players in an empty southwest field. The
      // world is 11520×11520 now; spawn at the canonical avatar spawn
      // (5760, 6300) — town center, 140wu south of Nori (game.ts
      // avatarPositionRef uses the same point).
      x: 5760, y: 6300,
      prevX: 5760, prevY: 6300,
      ts: 0, tsDelta: 200,
      direction: 'idle',
      // 2026-04-25: NPC-mode default flipped from 'lobster' to 'milady_official_1'
      // so the player avatar matches the world's signature cast. ArenaNpcs routes
      // VRM species through VRMNpcMesh, which now ports the jumpState/airborne/bob
      // logic from GLBNpcMesh (see arena-npcs.tsx) so jump still works.
      species: 'milady_official_1',
      color: 0x42a5f5, // blue tint
      hp: 100, maxHp: 100,
      isDead: false, hasSword: false,
      inCombat: false, inConversation: false,
      inventory: [],
      isOpenClaw: false,
      combatAction: null, combatActionAt: 0,
      facingAngle: null,
    };
    set((s) => ({ npcs: [playerNpc, ...s.npcs] }));
  },

  removePlayerNpc: () => {
    set((s) => ({ npcs: s.npcs.filter((n) => n.id !== PLAYER_NPC_ID) }));
  },
}));

// ---------------------------------------------------------------------------
// NPC identity helper — drives the in-place mutation pattern in
// updateFromSnapshot. Only fields that are READ from React state (rather
// than via npcRef.current inside useFrame) belong here.
//
// ClawVille has no combat, no hp, no death systems yet — those fields ride
// along via mutation but never invalidate identity. The only React-visible
// state change is `inConversation` (drives speech bubbles + activity
// indicators), plus the static label fields (name / species / color /
// isOpenClaw which never change in practice but are cheap to check).
// ---------------------------------------------------------------------------
function npcFieldsEqual(a: NpcSpriteState, b: NpcSpriteState): boolean {
  return (
    Object.is(a.id, b.id) &&
    Object.is(a.name, b.name) &&
    Object.is(a.species, b.species) &&
    Object.is(a.color, b.color) &&
    Object.is(a.inConversation, b.inConversation) &&
    Object.is(a.isOpenClaw, b.isOpenClaw)
  );
}

// Auto-start demo wandering
if (typeof window !== 'undefined') {
  startDemoWander();
}
