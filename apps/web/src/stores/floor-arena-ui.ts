import { create } from 'zustand';

import { useGameStore } from './game';

/**
 * Which Trading Floor Arena panel the Exchange modal's floor tab shows, and
 * what the client knows about the viewer's own arena agent.
 *
 * A store and not component state because two places outside the panel open
 * it: the 3D room (sitting at a desk opens "My trader") and the leaderboard
 * rows (a row opens that agent's profile). Spec: docs/trading-floor-arena.md.
 */
export type FloorArenaPanel = 'overview' | 'launch' | 'desk' | 'profile' | 'rules';

/**
 * `unknown` until GET /me answers. `none` also covers a viewer who cannot own
 * an arena agent (anonymous or guest), so the room skips the seat write for
 * them instead of sending a request that can only be refused.
 */
export type FloorArenaMyAgentState = 'unknown' | 'none' | 'present';

/** What the launch success screen shows until the player moves on. */
export interface FloorArenaLaunched {
  agentName: string | null;
  paymentAddress: string | null;
}

interface FloorArenaUiStore {
  panel: FloorArenaPanel;
  /** The agent the profile panel shows. */
  profileAgentId: string | null;
  /** The template the launch flow starts from. `null` starts at step 1. */
  launchTemplateId: string | null;
  /**
   * The desk the LOCAL player sits at in the 3D room, or -1. Written only on a
   * transition (sit, stand, leave the room), never per frame.
   */
  localSeatIndex: number;
  myAgent: FloorArenaMyAgentState;
  /** Counts settled seat writes, so the desk panel re-reads GET /me. */
  seatWriteVersion: number;
  /**
   * Set by a successful launch. Held here, not in the launch component, because
   * the launch makes GET /me return an agent, which swaps the panel the section
   * renders; the success screen must survive that swap.
   */
  launched: FloorArenaLaunched | null;
  showPanel: (
    panel: FloorArenaPanel,
    options?: { agentId?: string | null; templateId?: string | null },
  ) => void;
  /** Opens the Exchange modal on its floor tab AND selects the panel. */
  openArena: (
    panel: FloorArenaPanel,
    options?: { agentId?: string | null; templateId?: string | null },
  ) => void;
  setLocalSeatIndex: (seatIndex: number) => void;
  setMyAgent: (state: FloorArenaMyAgentState) => void;
  noteSeatWriteSettled: () => void;
  setLaunched: (launched: FloorArenaLaunched | null) => void;
  /**
   * Called by `clearIdentityState` on every auth transition, so one account's
   * agent state (and its launch screen with a wallet address) never shows to
   * the next account on the same browser. The local seat is room state, not
   * identity, and stays.
   */
  resetIdentity: () => void;
}

export const useFloorArenaUi = create<FloorArenaUiStore>((set, get) => ({
  panel: 'overview',
  profileAgentId: null,
  launchTemplateId: null,
  localSeatIndex: -1,
  myAgent: 'unknown',
  seatWriteVersion: 0,
  launched: null,
  showPanel: (panel, options) => {
    set({
      panel,
      profileAgentId: panel === 'profile' ? (options?.agentId ?? null) : get().profileAgentId,
      launchTemplateId: panel === 'launch' ? (options?.templateId ?? null) : get().launchTemplateId,
    });
  },
  openArena: (panel, options) => {
    get().showPanel(panel, options);
    const game = useGameStore.getState();
    if (!(game.exchangeOpen && game.exchangeTab === 'floor')) game.openTradingFloor();
  },
  setLocalSeatIndex: (seatIndex) => {
    if (get().localSeatIndex !== seatIndex) set({ localSeatIndex: seatIndex });
  },
  setMyAgent: (state) => {
    if (get().myAgent !== state) set({ myAgent: state });
  },
  noteSeatWriteSettled: () => set({ seatWriteVersion: get().seatWriteVersion + 1 }),
  setLaunched: (launched) => set({ launched }),
  resetIdentity: () =>
    set({ panel: 'overview', profileAgentId: null, launchTemplateId: null, myAgent: 'unknown', launched: null }),
}));
