import { create } from 'zustand';

export interface NpcSpriteState {
  id: string;
  name: string;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
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
  /** Override the default idle clip for VRM NPCs. Undefined = use 'idle'. */
  defaultIdleClip?: string;
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
  moveNpc: (id: string, x: number, y: number, direction: NpcSpriteState['direction'], facingAngle?: number | null) => void;
  /** Spawn a dedicated player NPC at world center for NPC mode */
  spawnPlayerNpc: () => void;
  /** Remove the dedicated player NPC when leaving NPC mode */
  removePlayerNpc: () => void;
}

// Demo NPCs shown when API server is not connected
function makeDemoNpc(id: string, name: string, x: number, y: number, species: string, color: number, isOpenClaw = false, defaultIdleClip?: string): NpcSpriteState {
  return { id, name, x, y, prevX: x, prevY: y, direction: 'idle', species, color, hp: 100, maxHp: 100, isDead: false, hasSword: false, inCombat: false, inConversation: false, inventory: [], isOpenClaw, combatAction: null, combatActionAt: 0, facingAngle: null, defaultIdleClip };
}

// Demo NPC positions spread around the village center (2560,2560) to match
// the 5120x5120 map (160x160 tiles).
const DEMO_NPCS: NpcSpriteState[] = [
  makeDemoNpc('demo-1',  'Captain Claw', 2600, 2200, 'lobster',          0xff2020),       // bright red
  makeDemoNpc('demo-2',  'Pearl',        3000, 1800, 'lobster',          0xff80ab),       // pink
  makeDemoNpc('demo-3',  'Rusty',        1800, 2800, 'lobster',          0xff8c00),       // orange
  makeDemoNpc('demo-4',  'Abyssal',      3400, 2400, 'lobster',          0x2244ff, true), // deep blue
  makeDemoNpc('demo-5',  'Mantis',       2200, 1600, 'lobster',          0x00e676),       // green
  makeDemoNpc('demo-6',  'Goldie',       2800, 3000, 'lobster',          0xffd700),       // gold
  makeDemoNpc('demo-7',  'Shadow',       1600, 2200, 'lobster',          0x8844cc),       // purple
  makeDemoNpc('demo-8',  'Coral',        3600, 2000, 'lobster',          0xff4488),       // hot pink
  makeDemoNpc('demo-9',  'Frost',        2400, 1400, 'lobster',          0x00ccdd),       // cyan/teal
  makeDemoNpc('demo-10', 'Ember',        3200, 3200, 'lobster',          0xff5500),       // burnt orange
  // Milady VRM wandering NPCs — use milady_official_7 and milady_official_8 to avoid
  // sharing a VRM instance with the most-common player avatar picks (official_1 is the
  // default; official_5 is popular). The vrm-loader caches one VRM per path — two NPCs
  // sharing the same path would share vrm.scene and clobber each other's animation state.
  // IDs + spawn coords match NPC_DEFINITIONS in packages/shared. All spawns
  // are clear of building pathfinding-blocked zones. When connected, server
  // snapshots replace these in place by id; disconnected mode runs them
  // through the client wander loop.
  makeDemoNpc('milady-miu',     'Miu',       1400, 3000, 'milady_official_7', 0xffc0ff, false, 'looking_around'),
  makeDemoNpc('milady-kyoko',   'Kyoko',     3700, 2000, 'milady_official_8', 0xc0e8ff, false, 'squat'),
  makeDemoNpc('milady-vivi',    'Vivi',      1600, 1500, 'milady_official_2', 0xffd0a0),
  // 2026-05-12 PM: Hermes wanderers restored with per-VRM auto-fit (Mira,
  // Cyrus, Tekk) — see npc-definitions.ts. Each species lands at
  // VRM_NPC_TARGET_HEIGHT_WU regardless of cm-vs-m authoring units.
  makeDemoNpc('hermes-mira',  'Mira',  3500, 3500, 'hermes_female', 0xb088ff),
  makeDemoNpc('hermes-cyrus', 'Cyrus', 2700, 1500, 'hermes_male',   0x4b6cb7),
  makeDemoNpc('hermes-tekk',  'Tekk',  1900, 3800, 'tekk',          0x30c060),
  makeDemoNpc('wanderer-driftwood', 'Driftwood', 1500, 2400, 'lobster',     0x8d6e63),
  makeDemoNpc('wanderer-marlin',    'Marlin',    3700, 2700, 'sweet_crab',  0x00acc1),
  makeDemoNpc('wanderer-riptide',   'Riptide',   2600, 3500, 'hermitcrab',  0xa1887f),
];

// Demo NPC wandering — makes NPCs walk around when not connected to server
interface WanderState { targetX: number; targetY: number; waitUntil: number; }
const wanderStates = new Map<string, WanderState>();

const WANDER_MARGIN = 80;
const WANDER_MAX_X = 5120 - WANDER_MARGIN; // MAP_WIDTH - margin
const WANDER_MAX_Y = 5120 - WANDER_MARGIN; // MAP_HEIGHT - margin

function pickNewTarget(npc: NpcSpriteState): WanderState {
  const tx = WANDER_MARGIN + Math.random() * (WANDER_MAX_X - WANDER_MARGIN);
  const ty = WANDER_MARGIN + Math.random() * (WANDER_MAX_Y - WANDER_MARGIN);
  return { targetX: tx, targetY: ty, waitUntil: 0 };
}

function tickDemoNpcs(npcs: NpcSpriteState[]): NpcSpriteState[] {
  const now = Date.now();
  const speed = 4; // pixels per tick

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
      ws.waitUntil = now + Math.random() * 3000;
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
      newWs.waitUntil = now + 2000 + Math.random() * 4000;
      wanderStates.set(npc.id, newWs);
      npc.direction = 'idle';
      continue;
    }

    const mx = (dx / dist) * speed;
    const my = (dy / dist) * speed;
    npc.prevX = npc.x;
    npc.prevY = npc.y;
    npc.x = npc.x + mx;
    npc.y = npc.y + my;
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
    const prevMap = new Map(state.npcs.map((n) => [n.id, n]));
    const npcs: NpcSpriteState[] = snapshot.npcs.map((n) => {
      const prev = prevMap.get(n.id);
      // Never overwrite the possessed NPC — player controls it via NpcController
      if (n.id === possessedNpcId && prev) {
        return prev;
      }
      const serverIsIdle = n.direction === 'idle' && !n.inCombat && !n.inConversation;
      // useClientPos: when server is idle, keep the client's previous position
      // (so demo-mode wander animations don't snap NPCs back). BUT direction
      // is ALWAYS authoritative from the server — keeping prev.direction caused
      // NPCs to play walk-cycle animation forever after server transitioned to
      // idle (user-reported "walking in place" 2026-04-25).
      const useClientPos = serverIsIdle && prev;
      // Build the candidate object first, then check identity against prev.
      // If every field is equal we return the PREVIOUS reference — this preserves
      // React.memo's shallow-prop bailout in GLBNpcMesh / VRMNpcMesh and prevents
      // 13-18 needless re-renders per SSE tick when nothing actually changed.
      const candidate: NpcSpriteState = {
        id: n.id,
        name: n.name,
        x: useClientPos ? prev.x : n.x,
        y: useClientPos ? prev.y : n.y,
        prevX: prev?.x ?? n.x,
        prevY: prev?.y ?? n.y,
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
        const winnerNpc = snapshot.npcs.find((n) => n.id === winnerId);
        const loserNpc = snapshot.npcs.find((n) => n.id === loserId);
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

  moveNpc: (id, x, y, direction, facingAngle = null) => {
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
    // No setState call — the mutated object is the same reference subscribers
    // already hold, and useFrame reads via npcRef.current.
  },

  spawnPlayerNpc: () => {
    const exists = get().npcs.some((n) => n.id === PLAYER_NPC_ID);
    if (exists) return;
    const playerNpc: NpcSpriteState = {
      id: PLAYER_NPC_ID,
      name: 'You',
      x: 2560, y: 2560, // World center (tile 80,80)
      prevX: 2560, prevY: 2560,
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
