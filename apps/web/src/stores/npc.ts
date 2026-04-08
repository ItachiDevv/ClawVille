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
}

// Demo NPCs shown when API server is not connected
function makeDemoNpc(id: string, name: string, x: number, y: number, species: string, color: number, isOpenClaw = false): NpcSpriteState {
  return { id, name, x, y, prevX: x, prevY: y, direction: 'idle', species, color, hp: 100, maxHp: 100, isDead: false, hasSword: false, inCombat: false, inConversation: false, inventory: [], isOpenClaw, combatAction: null, combatActionAt: 0 };
}

const DEMO_NPCS: NpcSpriteState[] = [
  makeDemoNpc('demo-1', 'Captain Claw', 400, 300, 'cat', 0xff6347),
  makeDemoNpc('demo-2', 'Pearl', 700, 200, 'bunny', 0xff80ab),
  makeDemoNpc('demo-3', 'Rusty', 200, 500, 'fox', 0xff8c00),
  makeDemoNpc('demo-4', 'Abyssal', 900, 400, 'dragon', 0x4488ff, true),
  makeDemoNpc('demo-5', 'Mantis', 300, 150, 'phoenix', 0x00e676),
];

// Demo NPC wandering — makes NPCs walk around when not connected to server
const DIRS: NpcSpriteState['direction'][] = ['up', 'down', 'left', 'right'];
interface WanderState { targetX: number; targetY: number; waitUntil: number; }
const wanderStates = new Map<string, WanderState>();

function pickNewTarget(npc: NpcSpriteState): WanderState {
  const tx = 80 + Math.random() * 1120; // stay within map
  const ty = 80 + Math.random() * 640;
  return { targetX: tx, targetY: ty, waitUntil: 0 };
}

function tickDemoNpcs(npcs: NpcSpriteState[]): NpcSpriteState[] {
  const now = Date.now();
  const speed = 4; // pixels per tick

  return npcs.map((npc) => {
    let ws = wanderStates.get(npc.id);
    if (!ws) {
      ws = pickNewTarget(npc);
      ws.waitUntil = now + Math.random() * 3000; // stagger initial movement
      wanderStates.set(npc.id, ws);
    }

    // Waiting (idle pause between walks)
    if (now < ws.waitUntil) {
      return { ...npc, direction: 'idle' as const };
    }

    const dx = ws.targetX - npc.x;
    const dy = ws.targetY - npc.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Reached target — pause then pick new one
    if (dist < 10) {
      const newWs = pickNewTarget(npc);
      newWs.waitUntil = now + 2000 + Math.random() * 4000;
      wanderStates.set(npc.id, newWs);
      return { ...npc, direction: 'idle' as const };
    }

    // Move toward target
    const mx = (dx / dist) * speed;
    const my = (dy / dist) * speed;
    const newX = npc.x + mx;
    const newY = npc.y + my;

    let dir: NpcSpriteState['direction'] = 'idle';
    if (Math.abs(dx) > Math.abs(dy)) {
      dir = dx > 0 ? 'right' : 'left';
    } else {
      dir = dy > 0 ? 'down' : 'up';
    }

    return { ...npc, prevX: npc.x, prevY: npc.y, x: newX, y: newY, direction: dir };
  });
}

let demoInterval: ReturnType<typeof setInterval> | null = null;

function startDemoWander() {
  if (demoInterval) return;
  demoInterval = setInterval(() => {
    const state = useNpcStore.getState();
    // Always wander — even server NPCs get client-side movement when idle
    const updated = tickDemoNpcs(state.npcs);
    useNpcStore.setState({ npcs: updated });
  }, 100);
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
    // Restore demo NPCs when server disconnects
    if (!v && get().npcs.length === 0) {
      set({ npcs: DEMO_NPCS });
    }
  },

  updateFromSnapshot: (snapshot) => {
    const state = get();
    const now = Date.now();

    // Update NPC positions (store previous for lerp)
    // If a server NPC is idle, keep the client-side position so wander can move it
    const prevMap = new Map(state.npcs.map((n) => [n.id, n]));
    const npcs: NpcSpriteState[] = snapshot.npcs.map((n) => {
      const prev = prevMap.get(n.id);
      const serverIsIdle = n.direction === 'idle' && !n.inCombat && !n.inConversation;
      const useClientPos = serverIsIdle && prev;
      return {
        id: n.id,
        name: n.name,
        x: useClientPos ? prev.x : n.x,
        y: useClientPos ? prev.y : n.y,
        prevX: prev?.x ?? n.x,
        prevY: prev?.y ?? n.y,
        direction: useClientPos ? prev.direction : (n.direction as NpcSpriteState['direction']),
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
      };
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

    set({
      npcs,
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
}));

// Auto-start demo wandering
if (typeof window !== 'undefined') {
  startDemoWander();
}
