/**
 * NPC town-liveliness scripted layer.
 *
 * NOT the user-agent Autonomous engine; decoupled from the toggle 2026-07-15
 * (RC3); server driver = apps/api/src/services/agent-autonomy-driver.ts.
 */
import { create } from 'zustand';
import { NPC_BUILDING_CENTERS } from '@clawville/shared';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import { findPath } from '@/lib/pixi/client-pathfinding';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoalType = 'visit_building' | 'explore_unvisited' | 'earn_tokens' | 'rest';

interface AgentGoal {
  id: string;
  type: GoalType;
  targetBuildingId: string;
  priority: number;
  status: 'pending' | 'traveling' | 'active' | 'complete' | 'failed';
  startedAt: number;
  description: string;
}

export interface AgentThought {
  id: string;
  timestamp: number;
  text: string;
  type: 'decision' | 'observation' | 'arrival' | 'reward' | 'idle';
}

type TickState = 'idle' | 'planning' | 'traveling' | 'entering' | 'inside' | 'exiting' | 'pausing';

// ---------------------------------------------------------------------------
// Building metadata for goal scoring
// ---------------------------------------------------------------------------

const ALL_BUILDING_IDS = Object.keys(NPC_BUILDING_CENTERS);
const MAP_DIAGONAL = Math.sqrt(MAP_WIDTH * MAP_WIDTH + MAP_HEIGHT * MAP_HEIGHT);

// Thoughts the agent thinks while inside buildings
const BUILDING_THOUGHTS: Record<string, string[]> = {};
for (const [id, theme] of Object.entries(BUILDING_OPENCLAW_THEMES)) {
  BUILDING_THOUGHTS[id] = [
    `Studying ${theme.category.toLowerCase()}...`,
    `Learning about ${theme.focus.split(',')[0]}...`,
    `This ${theme.label} has interesting knowledge about ${theme.focus.split(',')[1]?.trim() || theme.category.toLowerCase()}...`,
    `Taking notes on ${theme.focus.split(',')[2]?.trim() || theme.category.toLowerCase()}...`,
  ];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AutonomyState {
  // Core
  isActive: boolean;
  tickState: TickState;
  currentGoal: AgentGoal | null;
  thoughts: AgentThought[];

  // Session stats
  buildingsVisitedThisSession: string[];
  sessionStartedAt: number | null;

  // Timing
  activityEndsAt: number;
  pauseEndsAt: number;
  lastThoughtAt: number;

  // Actions
  startAutonomy: () => void;
  stopAutonomy: () => void;
  tick: () => void;

  // For external agents (OpenClaw/Hermes) to inject goals
  injectGoal: (buildingId: string, description?: string) => void;
}

let _tickInterval: ReturnType<typeof setInterval> | null = null;

export const useAutonomyStore = create<AutonomyState>((set, get) => ({
  isActive: false,
  tickState: 'idle',
  currentGoal: null,
  thoughts: [],
  buildingsVisitedThisSession: [],
  sessionStartedAt: null,
  activityEndsAt: 0,
  pauseEndsAt: 0,
  lastThoughtAt: 0,

  startAutonomy: () => {
    if (get().isActive) return;

    const thought: AgentThought = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      text: 'Autonomous mode activated. Scanning for objectives...',
      type: 'decision',
    };

    set({
      isActive: true,
      tickState: 'idle',
      currentGoal: null,
      thoughts: [thought],
      buildingsVisitedThisSession: [],
      sessionStartedAt: Date.now(),
      activityEndsAt: 0,
      pauseEndsAt: 0,
      lastThoughtAt: Date.now(),
    });

    // Start tick loop at 500ms
    if (_tickInterval) clearInterval(_tickInterval);
    _tickInterval = setInterval(() => {
      get().tick();
    }, 500);
  },

  stopAutonomy: () => {
    if (_tickInterval) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }

    const thoughts = get().thoughts;
    const stopThought: AgentThought = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      text: 'Autonomous mode deactivated.',
      type: 'idle',
    };

    // Exit building if inside one
    const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
    const gameState = useGameStore.getState();
    if (gameState.currentLocation) {
      gameState.exitBuilding();
    }
    gameState.clearClickPath();

    set({
      isActive: false,
      tickState: 'idle',
      currentGoal: null,
      thoughts: [...thoughts.slice(-49), stopThought],
    });
  },

  tick: () => {
    const state = get();
    if (!state.isActive) return;

    const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
    const game = useGameStore.getState();
    const now = Date.now();

    switch (state.tickState) {
      // ---------------------------------------------------------------
      // IDLE — pick the next goal
      // ---------------------------------------------------------------
      case 'idle':
      case 'planning': {
        const goal = planNextGoal(state, game);
        if (!goal) {
          // Nothing to do — rest
          if (now - state.lastThoughtAt > 5000) {
            addThought(set, get, 'All buildings explored! Resting...', 'idle');
          }
          return;
        }

        addThought(set, get, goal.description, 'decision');

        // Find path to building center
        const center = NPC_BUILDING_CENTERS[goal.targetBuildingId];
        if (!center) {
          set({ tickState: 'idle' });
          return;
        }

        const path = findPath(game.avatarPosition.x, game.avatarPosition.y, center.x, center.y);
        if (path.length === 0) {
          addThought(set, get, `Can't find a path to ${BUILDING_OPENCLAW_THEMES[goal.targetBuildingId]?.label ?? goal.targetBuildingId}. Picking another target...`, 'observation');
          set({ tickState: 'idle' });
          return;
        }

        // Set the click path — player-avatar.tsx will follow it
        game.setClickPath(path, goal.targetBuildingId);

        goal.status = 'traveling';
        set({ currentGoal: goal, tickState: 'traveling' });
        break;
      }

      // ---------------------------------------------------------------
      // TRAVELING — wait for avatar to reach building proximity
      // ---------------------------------------------------------------
      case 'traveling': {
        const goal = state.currentGoal;
        if (!goal) { set({ tickState: 'idle' }); return; }

        // Check if we've arrived (nearLocation matches target)
        if (game.nearLocation === goal.targetBuildingId) {
          set({ tickState: 'entering' });
          return;
        }

        // Check if clickPath was cleared (path completed without proximity match — try entering anyway or re-path)
        if (!game.clickPath) {
          // Maybe we're close enough — check distance
          const center = NPC_BUILDING_CENTERS[goal.targetBuildingId];
          if (center) {
            const dx = game.avatarPosition.x - center.x;
            const dy = game.avatarPosition.y - center.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 100) {
              // Close enough, try entering
              set({ tickState: 'entering' });
              return;
            }
          }
          // Path ended but we're not close — re-path
          const center2 = NPC_BUILDING_CENTERS[goal.targetBuildingId];
          if (center2) {
            const path = findPath(game.avatarPosition.x, game.avatarPosition.y, center2.x, center2.y);
            if (path.length > 0) {
              game.setClickPath(path, goal.targetBuildingId);
            } else {
              addThought(set, get, 'Lost my way... picking a new destination.', 'observation');
              set({ tickState: 'idle', currentGoal: null });
            }
          }
        }

        // Periodic travel thoughts
        if (now - state.lastThoughtAt > 6000) {
          const theme = BUILDING_OPENCLAW_THEMES[goal.targetBuildingId];
          if (theme) {
            addThought(set, get, `Heading to ${theme.label}...`, 'observation');
          }
        }
        break;
      }

      // ---------------------------------------------------------------
      // ENTERING — trigger enterBuilding
      // ---------------------------------------------------------------
      case 'entering': {
        const goal = state.currentGoal;
        if (!goal) { set({ tickState: 'idle' }); return; }

        // Only enter if not already inside
        if (!game.currentLocation) {
          // Set nearLocation if not set (edge case)
          if (game.nearLocation !== goal.targetBuildingId) {
            game.setNearLocation(goal.targetBuildingId);
          }
          game.enterBuilding(goal.targetBuildingId);
        }

        const theme = BUILDING_OPENCLAW_THEMES[goal.targetBuildingId];
        addThought(set, get, `Arrived at ${theme?.label ?? goal.targetBuildingId}!`, 'arrival');

        // Stay inside for 8-15 seconds
        const stayDuration = 8000 + Math.random() * 7000;
        set({
          tickState: 'inside',
          activityEndsAt: now + stayDuration,
        });
        break;
      }

      // ---------------------------------------------------------------
      // INSIDE — learning, generate thoughts, wait for timer
      // ---------------------------------------------------------------
      case 'inside': {
        const goal = state.currentGoal;
        if (!goal) { set({ tickState: 'idle' }); return; }

        // Generate study thoughts periodically
        if (now - state.lastThoughtAt > 3000) {
          const thoughts = BUILDING_THOUGHTS[goal.targetBuildingId];
          if (thoughts) {
            const text = thoughts[Math.floor(Math.random() * thoughts.length)];
            addThought(set, get, text, 'observation');
          }
        }

        // Time to leave?
        if (now >= state.activityEndsAt) {
          set({ tickState: 'exiting' });
        }
        break;
      }

      // ---------------------------------------------------------------
      // EXITING — leave building, mark complete
      // ---------------------------------------------------------------
      case 'exiting': {
        const goal = state.currentGoal;
        if (!goal) { set({ tickState: 'idle' }); return; }

        // Exit the building
        if (game.currentLocation) {
          game.exitBuilding();
        }

        const theme = BUILDING_OPENCLAW_THEMES[goal.targetBuildingId];
        addThought(set, get, `Finished studying at ${theme?.label ?? goal.targetBuildingId}. Moving on...`, 'reward');

        goal.status = 'complete';

        // Track session visit
        const visited = [...state.buildingsVisitedThisSession];
        if (!visited.includes(goal.targetBuildingId)) {
          visited.push(goal.targetBuildingId);
        }

        // Pause before next goal (2-4 seconds)
        set({
          tickState: 'pausing',
          currentGoal: null,
          buildingsVisitedThisSession: visited,
          pauseEndsAt: now + 2000 + Math.random() * 2000,
        });
        break;
      }

      // ---------------------------------------------------------------
      // PAUSING — brief rest between goals
      // ---------------------------------------------------------------
      case 'pausing': {
        if (now >= state.pauseEndsAt) {
          set({ tickState: 'idle' });
        }
        break;
      }
    }
  },

  injectGoal: (buildingId, description) => {
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];
    const goal: AgentGoal = {
      id: crypto.randomUUID(),
      type: 'visit_building',
      targetBuildingId: buildingId,
      priority: 100, // External goals are highest priority
      status: 'pending',
      startedAt: Date.now(),
      description: description ?? `Directed to visit ${theme?.label ?? buildingId}`,
    };

    addThought(set, get, `Received external command: visit ${theme?.label ?? buildingId}`, 'decision');

    // Force back to idle to pick up this goal immediately
    const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
    const game = useGameStore.getState();
    if (game.currentLocation) game.exitBuilding();
    game.clearClickPath();

    set({ currentGoal: goal, tickState: 'idle' });
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addThought(
  set: (fn: (s: AutonomyState) => Partial<AutonomyState>) => void,
  get: () => AutonomyState,
  text: string,
  type: AgentThought['type'],
) {
  const thought: AgentThought = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    text,
    type,
  };
  set((s) => ({
    thoughts: [...s.thoughts.slice(-49), thought],
    lastThoughtAt: Date.now(),
  }));
}

/** Score and pick the best building to visit next */
function planNextGoal(
  state: AutonomyState,
  game: { avatarPosition: { x: number; y: number }; visitedBuildings: Set<string> },
): AgentGoal | null {
  const candidates: Array<{ id: string; score: number }> = [];

  for (const id of ALL_BUILDING_IDS) {
    const center = NPC_BUILDING_CENTERS[id];
    if (!center) continue;

    let score = 0;

    // Unvisited buildings are top priority (global discovery)
    if (!game.visitedBuildings.has(id)) {
      score += 50;
    }

    // Not visited this session — prefer variety
    if (!state.buildingsVisitedThisSession.includes(id)) {
      score += 25;
    } else {
      score -= 20; // Already visited this session — deprioritize
    }

    // Proximity bonus — closer buildings are more attractive
    const dx = game.avatarPosition.x - center.x;
    const dy = game.avatarPosition.y - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    score += 20 * (1 - dist / MAP_DIAGONAL);

    // Small random factor for variety
    score += Math.random() * 10;

    candidates.push({ id, score });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= -10) return null;

  const theme = BUILDING_OPENCLAW_THEMES[best.id];
  const isNew = !game.visitedBuildings.has(best.id);

  return {
    id: crypto.randomUUID(),
    type: isNew ? 'explore_unvisited' : 'visit_building',
    targetBuildingId: best.id,
    priority: best.score,
    status: 'pending',
    startedAt: Date.now(),
    description: isNew
      ? `Discovered ${theme?.label ?? best.id}! Heading there to learn about ${theme?.category ?? 'new skills'}...`
      : `Returning to ${theme?.label ?? best.id} for more ${theme?.category ?? 'training'}...`,
  };
}
