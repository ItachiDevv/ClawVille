import { NPC_DEFINITIONS, type NpcDefinition, type OpenClawRegistration, type OpenClawAvatarConfig } from '@legacyapp/shared';
import { generateNpcConversation, generateOpenClawConversation } from './npc-conversation-engine';
import type { OpenClawClient } from './openclaw-client';

// Map dimensions from tilemap-data
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;

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
}

export interface NpcConversation {
  id: string;
  npc1Id: string;
  npc2Id: string;
  messages: Array<{ npcId: string; npcName: string; text: string }>;
  currentIndex: number;
  nextMessageAt: number;
  state: 'active' | 'done';
}

export interface NpcCombat {
  id: string;
  attacker: string;
  defender: string;
  rounds: Array<{ attacker: string; damage: number; defenderHpAfter: number }>;
  state: 'active' | 'done';
  winner: string | null;
  lootTransferred: string[];
  startedAt: number;
  nextRoundAt: number;
}

export interface SimulationSnapshot {
  npcs: NpcRuntimeState[];
  conversations: NpcConversation[];
  combats: NpcCombat[];
  timestamp: number;
}

type SSEListener = (snapshot: SimulationSnapshot) => void;

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

  // OpenClaw bot registry
  private openClawBots: Map<string, { config: OpenClawRegistration; client: OpenClawClient }> = new Map();
  private npcOverrides: Map<string, string> = new Map(); // npcId → sessionId

  start(arenaMode: boolean) {
    if (this.intervalId) return;
    this.arenaMode = arenaMode;
    this.initNpcs();
    console.log(`[NPC Simulation] Starting in ${arenaMode ? 'arena' : 'world'} mode with ${this.npcs.size} NPCs`);
    this.intervalId = setInterval(() => this.tick(), 2000);
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

  addListener(listener: SSEListener) {
    this.listeners.add(listener);
  }

  removeListener(listener: SSEListener) {
    this.listeners.delete(listener);
  }

  getSnapshot(): SimulationSnapshot {
    return {
      npcs: Array.from(this.npcs.values()),
      conversations: Array.from(this.conversations.values()).filter((c) => c.state === 'active'),
      combats: Array.from(this.combats.values()).filter((c) => c.state === 'active'),
      timestamp: Date.now(),
    };
  }

  private initNpcs() {
    this.npcs.clear();
    for (const def of NPC_DEFINITIONS) {
      this.npcs.set(def.id, {
        id: def.id,
        name: def.name,
        x: def.homeX,
        y: def.homeY,
        targetX: def.homeX,
        targetY: def.homeY,
        homeX: def.homeX,
        homeY: def.homeY,
        patrolRadius: def.patrolRadius,
        direction: 'idle',
        species: def.species,
        color: def.color,
        inConversation: false,
        hp: def.stats.hp,
        maxHp: def.stats.hp,
        attack: def.stats.attack,
        defense: def.stats.defense,
        speed: def.stats.speed,
        inCombat: false,
        inventory: [],
        isDead: false,
        respawnAt: 0,
        hasSword: this.arenaMode,
        isOpenClaw: false,
      });
    }
  }

  // --- OpenClaw Methods ---

  registerOpenClaw(config: OpenClawRegistration, client: OpenClawClient, restoredState?: { lastX?: number; lastY?: number; knowledge?: string[] }) {
    if (config.mode === 'override') {
      // Check if NPC exists
      if (!this.npcs.has(config.targetNpcId)) {
        throw new Error(`NPC "${config.targetNpcId}" not found`);
      }
      // Check if already overridden
      if (this.npcOverrides.has(config.targetNpcId)) {
        throw new Error(`NPC "${config.targetNpcId}" is already overridden`);
      }
      this.openClawBots.set(config.sessionId, { config, client });
      this.npcOverrides.set(config.targetNpcId, config.sessionId);
      const npc = this.npcs.get(config.targetNpcId)!;
      npc.isOpenClaw = true;
      console.log(`[OpenClaw] Override registered: ${config.targetNpcId} → ${config.sessionId}`);
    } else {
      // Avatar mode — inject a new NPC
      const avatarConfig = config as OpenClawAvatarConfig;
      const npcId = `oc-${config.sessionId}`;
      const startX = restoredState?.lastX ?? avatarConfig.homeX;
      const startY = restoredState?.lastY ?? avatarConfig.homeY;
      this.npcs.set(npcId, {
        id: npcId,
        name: avatarConfig.name,
        x: startX,
        y: startY,
        targetX: startX,
        targetY: startY,
        homeX: avatarConfig.homeX,
        homeY: avatarConfig.homeY,
        patrolRadius: avatarConfig.patrolRadius,
        direction: 'idle',
        species: avatarConfig.species,
        color: avatarConfig.color,
        inConversation: false,
        hp: avatarConfig.stats.hp,
        maxHp: avatarConfig.stats.hp,
        attack: avatarConfig.stats.attack,
        defense: avatarConfig.stats.defense,
        speed: avatarConfig.stats.speed,
        inCombat: false,
        inventory: [],
        isDead: false,
        respawnAt: 0,
        hasSword: this.arenaMode,
        isOpenClaw: true,
      });
      this.openClawBots.set(config.sessionId, { config, client });
      // Map the NPC ID to this session so conversation routing works
      this.npcOverrides.set(npcId, config.sessionId);
      console.log(`[OpenClaw] Avatar injected: "${avatarConfig.name}" (${npcId})${restoredState?.lastX != null ? ' [restored position]' : ''}`);
    }
  }

  unregisterOpenClaw(sessionId: string): boolean {
    const bot = this.openClawBots.get(sessionId);
    if (!bot) return false;

    if (bot.config.mode === 'override') {
      const npcId = bot.config.targetNpcId;
      this.npcOverrides.delete(npcId);
      const npc = this.npcs.get(npcId);
      if (npc) npc.isOpenClaw = false;
    } else {
      // Remove avatar NPC
      const npcId = `oc-${sessionId}`;
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

  /** Get avatar's current position for persistence on disconnect */
  getOpenClawAvatarPosition(sessionId: string): { x: number; y: number } | null {
    const npcId = `oc-${sessionId}`;
    const npc = this.npcs.get(npcId);
    return npc ? { x: npc.x, y: npc.y } : null;
  }

  private nextId(): string {
    return `ev-${++this.idCounter}`;
  }

  private tick() {
    this.tickCount++;
    this.conversationCooldown = Math.max(0, this.conversationCooldown - 1);
    this.combatCooldown = Math.max(0, this.combatCooldown - 1);

    // 1. Respawn dead NPCs
    this.handleRespawns();

    // 2. Progress active combats
    this.progressCombats();

    // 3. Progress active conversations
    this.progressConversations();

    // 4. Move NPCs
    this.moveNpcs();

    // 5. Maybe start a conversation (every ~20s = 10 ticks)
    if (this.conversationCooldown === 0 && this.tickCount % 10 === 0) {
      this.tryStartConversation();
    }

    // 6. Maybe start combat (arena only, every ~30-45s = 15-22 ticks)
    if (this.arenaMode && this.combatCooldown === 0 && this.tickCount % 15 === 0) {
      this.tryStartCombat();
    }

    // 7. Clean up done conversations/combats older than 10s
    this.cleanup();

    // 8. Broadcast snapshot
    this.broadcast();
  }

  private handleRespawns() {
    const now = Date.now();
    for (const npc of this.npcs.values()) {
      if (npc.isDead && npc.respawnAt > 0 && now >= npc.respawnAt) {
        npc.isDead = false;
        npc.hp = npc.maxHp;
        npc.x = npc.homeX;
        npc.y = npc.homeY;
        npc.targetX = npc.homeX;
        npc.targetY = npc.homeY;
        npc.inCombat = false;
        npc.inConversation = false;
        npc.respawnAt = 0;
        npc.direction = 'idle';
        console.log(`[NPC Simulation] ${npc.name} respawned`);
      }
    }
  }

  private moveNpcs() {
    for (const npc of this.npcs.values()) {
      if (npc.isDead || npc.inConversation || npc.inCombat) continue;

      const dx = npc.targetX - npc.x;
      const dy = npc.targetY - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 5) {
        // Arrived at target — pick new random target within patrol radius
        npc.direction = 'idle';
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * npc.patrolRadius;
        npc.targetX = Math.max(32, Math.min(MAP_WIDTH - 32, npc.homeX + Math.cos(angle) * radius));
        npc.targetY = Math.max(32, Math.min(MAP_HEIGHT - 32, npc.homeY + Math.sin(angle) * radius));
      } else {
        // Move ~40px toward target
        const step = Math.min(40, dist);
        const nx = dx / dist;
        const ny = dy / dist;
        npc.x += nx * step;
        npc.y += ny * step;

        // Clamp
        npc.x = Math.max(16, Math.min(MAP_WIDTH - 16, npc.x));
        npc.y = Math.max(16, Math.min(MAP_HEIGHT - 16, npc.y));

        // Direction for sprite
        if (Math.abs(dx) > Math.abs(dy)) {
          npc.direction = dx > 0 ? 'right' : 'left';
        } else {
          npc.direction = dy > 0 ? 'down' : 'up';
        }
      }
    }
  }

  private getIdleAliveNpcs(): NpcRuntimeState[] {
    return Array.from(this.npcs.values()).filter(
      (n) => !n.isDead && !n.inConversation && !n.inCombat
    );
  }

  private findNearestIdleNpc(npc: NpcRuntimeState, maxDist: number): NpcRuntimeState | null {
    let nearest: NpcRuntimeState | null = null;
    let nearestDist = maxDist;

    for (const other of this.npcs.values()) {
      if (other.id === npc.id || other.isDead || other.inConversation || other.inCombat) continue;
      const dx = other.x - npc.x;
      const dy = other.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = other;
      }
    }
    return nearest;
  }

  private async tryStartConversation() {
    const idle = this.getIdleAliveNpcs();
    if (idle.length < 2) return;

    // Pick a random idle NPC
    const initiator = idle[Math.floor(Math.random() * idle.length)];
    const partner = this.findNearestIdleNpc(initiator, 250);
    if (!partner) return;

    // Mark both as in conversation
    initiator.inConversation = true;
    partner.inConversation = true;
    this.conversationCooldown = 10; // ~20s before next conversation

    // Build NpcDefinition-like objects for both participants
    const def1 = NPC_DEFINITIONS.find((d) => d.id === initiator.id) ?? this.buildAvatarDef(initiator);
    const def2 = NPC_DEFINITIONS.find((d) => d.id === partner.id) ?? this.buildAvatarDef(partner);

    // Check if either participant has an OpenClaw client
    const client1 = this.getOpenClawClient(initiator.id);
    const client2 = this.getOpenClawClient(partner.id);

    let messages;
    if (client1 || client2) {
      messages = await generateOpenClawConversation(def1, def2, client1, client2, this.arenaMode);
    } else {
      messages = await generateNpcConversation(def1, def2, this.arenaMode);
    }

    const conversation: NpcConversation = {
      id: this.nextId(),
      npc1Id: initiator.id,
      npc2Id: partner.id,
      messages,
      currentIndex: 0,
      nextMessageAt: Date.now(),
      state: 'active',
    };

    this.conversations.set(conversation.id, conversation);
    console.log(`[NPC Simulation] Conversation started: ${initiator.name} <-> ${partner.name}`);
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

      convo.currentIndex++;
      if (convo.currentIndex >= convo.messages.length) {
        // Conversation done
        convo.state = 'done';
        const npc1 = this.npcs.get(convo.npc1Id);
        const npc2 = this.npcs.get(convo.npc2Id);
        if (npc1) npc1.inConversation = false;
        if (npc2) npc2.inConversation = false;
      } else {
        convo.nextMessageAt = now + 5000; // 5s between messages
      }
    }
  }

  private tryStartCombat() {
    const idle = this.getIdleAliveNpcs();
    if (idle.length < 2) return;

    const initiator = idle[Math.floor(Math.random() * idle.length)];
    const target = this.findNearestIdleNpc(initiator, 200);
    if (!target) return;

    initiator.inCombat = true;
    target.inCombat = true;
    this.combatCooldown = 15; // ~30s before next combat

    // Face each other
    if (target.x > initiator.x) {
      initiator.direction = 'right';
      target.direction = 'left';
    } else {
      initiator.direction = 'left';
      target.direction = 'right';
    }

    const combat: NpcCombat = {
      id: this.nextId(),
      attacker: initiator.id,
      defender: target.id,
      rounds: [],
      state: 'active',
      winner: null,
      lootTransferred: [],
      startedAt: Date.now(),
      nextRoundAt: Date.now() + 1000, // First round after 1s
    };

    this.combats.set(combat.id, combat);
    console.log(`[NPC Simulation] Combat started: ${initiator.name} vs ${target.name}`);
  }

  private progressCombats() {
    const now = Date.now();
    for (const combat of this.combats.values()) {
      if (combat.state !== 'active') continue;
      if (now < combat.nextRoundAt) continue;

      const attacker = this.npcs.get(combat.attacker);
      const defender = this.npcs.get(combat.defender);
      if (!attacker || !defender) {
        combat.state = 'done';
        continue;
      }

      // Determine who attacks first based on speed
      const [first, second] = attacker.speed >= defender.speed
        ? [attacker, defender]
        : [defender, attacker];

      // First attacker hits
      const damage1 = Math.max(1, Math.round(
        first.attack * (0.8 + Math.random() * 0.4) - second.defense * 0.5
      ));
      second.hp = Math.max(0, second.hp - damage1);
      combat.rounds.push({
        attacker: first.id,
        damage: damage1,
        defenderHpAfter: second.hp,
      });

      if (second.hp <= 0) {
        this.resolveCombatDeath(combat, first, second);
        continue;
      }

      // Second attacker hits back
      const damage2 = Math.max(1, Math.round(
        second.attack * (0.8 + Math.random() * 0.4) - first.defense * 0.5
      ));
      first.hp = Math.max(0, first.hp - damage2);
      combat.rounds.push({
        attacker: second.id,
        damage: damage2,
        defenderHpAfter: first.hp,
      });

      if (first.hp <= 0) {
        this.resolveCombatDeath(combat, second, first);
        continue;
      }

      // Schedule next round
      combat.nextRoundAt = now + 2000;
    }
  }

  private resolveCombatDeath(combat: NpcCombat, winner: NpcRuntimeState, loser: NpcRuntimeState) {
    combat.state = 'done';
    combat.winner = winner.id;

    // Transfer inventory
    if (loser.inventory.length > 0) {
      combat.lootTransferred = [...loser.inventory];
      winner.inventory.push(...loser.inventory);
      loser.inventory = [];
    }

    // Award a loot token to winner
    winner.inventory.push(`loot-${this.nextId()}`);

    // Winner exits combat
    winner.inCombat = false;

    // Loser dies
    loser.isDead = true;
    loser.inCombat = false;
    loser.respawnAt = Date.now() + 15000; // 15s respawn

    console.log(`[NPC Simulation] ${winner.name} defeated ${loser.name}! Looted ${combat.lootTransferred.length} items`);
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
    const snapshot = this.getSnapshot();
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
