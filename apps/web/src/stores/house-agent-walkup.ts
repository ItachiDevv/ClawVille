import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { FLOOR_ARENA_TEMPLATES, floorArenaTemplateById } from '@clawville/shared';

import { useFloorArenaUi } from './floor-arena-ui';
import { useGameStore } from './game';

/**
 * P15 walk-up pop-up state (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §3).
 *
 * The player walks up to one of the five house agents in the Trading Floor; a
 * DOM panel beside it shows the agent and a button "Choose this trading style".
 *
 * The first five exports are the FROZEN contract. Three writers use them:
 *   - T4 walk-up detection calls `setHouseAgentWalkup` on a TRANSITION only and
 *     writes `houseAgentWalkupAnchor` every frame (no React, no allocation);
 *   - the room's ONE E / USE ladder calls `activateHouseAgentWalkup` as its
 *     lowest rung (stand > monitor > door > sit > house agent);
 *   - the panel (`components/trading-floor/house-agent-walkup.tsx`) reads both.
 *
 * Walk-up index i is house agent i is template i: FLOOR_ARENA_HOUSE_AGENTS and
 * FLOOR_ARENA_TEMPLATES share one order (pinned by house-agent-walkup.test.ts).
 *
 * This module imports no component and no hook, so the 3D room can import it
 * without an import cycle.
 */

export interface HouseAgentWalkupState {
  /** The house agent in walk-up reach, 0..4, or -1. */
  index: number;
  /** True when E (or USE) would reach the walk-up rung, so the panel may say "or press E". */
  eAvailable: boolean;
}

export const useHouseAgentWalkup: UseBoundStore<StoreApi<{ index: number; eAvailable: boolean }>> =
  create<HouseAgentWalkupState>()(() => ({ index: -1, eAvailable: false }));

/**
 * CSS px of the walk-up agent's chest point, written per frame by T4 and read
 * per frame by the panel's placement loop. One shared record: mutate it, never
 * replace it. When `onScreen` is false (off screen or behind the camera), the
 * panel docks on the side `x` points to (x below half the viewport width:
 * left edge, else the right edge).
 */
export const houseAgentWalkupAnchor: { x: number; y: number; onScreen: boolean } = {
  x: 0,
  y: 0,
  onScreen: false,
};

// ---------------------------------------------------------------------------
// Panel-local state (NOT part of the frozen contract)
// ---------------------------------------------------------------------------

/** Whether this viewer can own an arena trader, as the panel last resolved it. */
export type HouseAgentWalkupViewer = 'unknown' | 'can-own' | 'cannot-own';

export interface HouseAgentWalkupPanelState {
  /** The index the player closed with the close button, or -1. Cleared on every index change. */
  dismissedIndex: number;
  /**
   * `can-own`: auth resolved, not a guest, GET /me answered. `cannot-own`:
   * guest, logged out, or GET /me 401 / 403. Written by the panel on a change.
   */
  viewer: HouseAgentWalkupViewer;
  /** Mirror of the sessionStorage choice kept for after sign-up, or null. */
  pendingTemplateId: string | null;
}

export const useHouseAgentWalkupPanel = create<HouseAgentWalkupPanelState>()(() => ({
  dismissedIndex: -1,
  viewer: 'unknown',
  pendingTemplateId: null,
}));

function normaliseIndex(index: number): number {
  return Number.isInteger(index) && index >= 0 && index < FLOOR_ARENA_TEMPLATES.length ? index : -1;
}

/** T4 calls this on a TRANSITION only. A repeat call with the same values writes nothing. */
export function setHouseAgentWalkup(index: number, eAvailable: boolean): void {
  const nextIndex = normaliseIndex(index);
  const nextE = nextIndex >= 0 && eAvailable === true;
  const current = useHouseAgentWalkup.getState();
  if (current.index === nextIndex && current.eAvailable === nextE) return;
  // Leaving the radius (or walking straight to the next agent) ends a dismissal.
  if (current.index !== nextIndex && useHouseAgentWalkupPanel.getState().dismissedIndex !== -1) {
    useHouseAgentWalkupPanel.setState({ dismissedIndex: -1 });
  }
  useHouseAgentWalkup.setState({ index: nextIndex, eAvailable: nextE });
}

/** The close button: hidden until the player leaves the radius and comes back. */
export function dismissHouseAgentWalkup(): void {
  const { index } = useHouseAgentWalkup.getState();
  if (index < 0 || useHouseAgentWalkupPanel.getState().dismissedIndex === index) return;
  useHouseAgentWalkupPanel.setState({ dismissedIndex: index });
}

export function setHouseAgentWalkupViewer(viewer: HouseAgentWalkupViewer): void {
  if (useHouseAgentWalkupPanel.getState().viewer !== viewer) useHouseAgentWalkupPanel.setState({ viewer });
}

// ---------------------------------------------------------------------------
// The choice kept across sign-up (sessionStorage, every access in try/catch)
// ---------------------------------------------------------------------------

export const HOUSE_AGENT_PENDING_TEMPLATE_KEY = 'cv.floorArena.pendingTemplate';
export const HOUSE_AGENT_PENDING_TEMPLATE_TTL_MS = 30 * 60_000;
/** A stamp this far in the future is still accepted (clock adjustments). */
const PENDING_FUTURE_SLACK_MS = 60_000;

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : (window.sessionStorage ?? null);
  } catch {
    return null;
  }
}

function setPendingMirror(templateId: string | null): void {
  if (useHouseAgentWalkupPanel.getState().pendingTemplateId !== templateId) {
    useHouseAgentWalkupPanel.setState({ pendingTemplateId: templateId });
  }
}

function writePendingTemplate(templateId: string): void {
  setPendingMirror(templateId);
  try {
    sessionStore()?.setItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY, JSON.stringify({ templateId, at: Date.now() }));
  } catch {
    // Storage blocked or full: the choice lives only in memory for this page.
  }
}

export function clearPendingHouseAgentTemplate(): void {
  setPendingMirror(null);
  try {
    sessionStore()?.removeItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

/**
 * The template a guest chose before sign-up, if it is still fresh (30 min) and
 * names a real template. Anything else is removed and reads null. Syncs the
 * in-memory mirror either way.
 */
export function readPendingHouseAgentTemplate(nowMs: number = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStore()?.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) {
    setPendingMirror(null);
    return null;
  }
  let templateId: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as { templateId?: unknown; at?: unknown };
      const fresh =
        typeof row.at === 'number' &&
        Number.isFinite(row.at) &&
        row.at <= nowMs + PENDING_FUTURE_SLACK_MS &&
        nowMs - row.at <= HOUSE_AGENT_PENDING_TEMPLATE_TTL_MS;
      if (fresh && typeof row.templateId === 'string' && floorArenaTemplateById(row.templateId)) {
        templateId = row.templateId;
      }
    }
  } catch {
    templateId = null;
  }
  if (templateId === null) {
    clearPendingHouseAgentTemplate();
    return null;
  }
  setPendingMirror(templateId);
  return templateId;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * "Choose this trading style". Opens the EXISTING launch flow (Exchange modal,
 * floor tab, LaunchTrader at step 2 "Set the rules" with a clone of the
 * template params); P15 adds no second launch path. A guest, a logged-out
 * visitor or a GET /me 401 / 403 lands on the existing "Create a free account"
 * card from the same call; for them (and while the viewer is not known yet)
 * the choice is also kept for 30 minutes, because `resetIdentity` clears
 * `launchTemplateId` on sign-up. The panel reopens the launch once when the
 * viewer can own a trader.
 */
export function chooseHouseAgentTemplate(templateId: string): void {
  if (!floorArenaTemplateById(templateId)) return;
  if (useHouseAgentWalkupPanel.getState().viewer !== 'can-own') writePendingTemplate(templateId);
  useFloorArenaUi.getState().openArena('launch', { templateId });
}

/**
 * The E / USE rung (lowest priority, after sit). False at index -1, while the
 * Exchange panel is open, or after the player closed the pop-up for this agent
 * (nothing on screen to act on). Otherwise it runs the panel's primary action
 * and returns true: "Open my trader" for a viewer who has one (one trader per
 * account), else "Choose this trading style".
 */
export function activateHouseAgentWalkup(): boolean {
  const { index } = useHouseAgentWalkup.getState();
  if (index < 0) return false;
  if (useGameStore.getState().exchangeOpen) return false;
  if (useHouseAgentWalkupPanel.getState().dismissedIndex === index) return false;
  const template = FLOOR_ARENA_TEMPLATES[index];
  if (!template) return false;
  const ui = useFloorArenaUi.getState();
  if (ui.myAgent === 'present') ui.openArena('desk');
  else chooseHouseAgentTemplate(template.id);
  return true;
}
