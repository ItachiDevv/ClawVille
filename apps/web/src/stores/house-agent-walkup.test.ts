import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_HOUSE_AGENTS, FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

import {
  HOUSE_AGENT_PENDING_TEMPLATE_KEY,
  HOUSE_AGENT_PENDING_TEMPLATE_TTL_MS,
  activateHouseAgentWalkup,
  chooseHouseAgentTemplate,
  clearPendingHouseAgentTemplate,
  dismissHouseAgentWalkup,
  houseAgentWalkupAnchor,
  readPendingHouseAgentTemplate,
  setHouseAgentWalkup,
  setHouseAgentWalkupViewer,
  useHouseAgentWalkup,
  useHouseAgentWalkupPanel,
} from './house-agent-walkup';
import { useFloorArenaUi } from './floor-arena-ui';
import { useGameStore } from './game';

// P15 T5: the walk-up store. The first five imports are the FROZEN contract in
// ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §3; T4 (detection) and
// the room's E / USE ladder (W3) are written against these exact names.

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error('SecurityError: storage is blocked');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError: storage is blocked');
  }
}

const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
const previousWindow = (globalThis as { window?: unknown }).window;
let storage = new MemoryStorage();

function installStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { sessionStorage: value } });
}

beforeEach(() => {
  storage = new MemoryStorage();
  installStorage(storage);
  useHouseAgentWalkup.setState({ index: -1, eAvailable: false });
  useHouseAgentWalkupPanel.setState({ dismissedIndex: -1, viewer: 'unknown', pendingTemplateId: null });
  useFloorArenaUi.setState({ panel: 'overview', profileAgentId: null, launchTemplateId: null, myAgent: 'unknown', launched: null });
  useGameStore.setState({ exchangeOpen: false, exchangeTab: 'browse' });
});

afterAll(() => {
  if (hadWindow) Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow });
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('frozen contract', () => {
  test('starts closed with no E hint', () => {
    expect(useHouseAgentWalkup.getState()).toMatchObject({ index: -1, eAvailable: false });
  });

  test('the anchor is one shared mutable record (T4 writes it every frame)', () => {
    expect(houseAgentWalkupAnchor).toEqual({ x: expect.any(Number), y: expect.any(Number), onScreen: false });
    houseAgentWalkupAnchor.x = 321;
    houseAgentWalkupAnchor.y = 222;
    houseAgentWalkupAnchor.onScreen = true;
    expect(houseAgentWalkupAnchor).toEqual({ x: 321, y: 222, onScreen: true });
    houseAgentWalkupAnchor.onScreen = false;
  });

  test('walk-up index i is house agent i is template i (the spots, the board and the panel share one order)', () => {
    expect(FLOOR_ARENA_HOUSE_AGENTS.map((agent) => agent.templateId)).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id));
  });
});

describe('setHouseAgentWalkup: transition-only', () => {
  test('writes the store only when the value changes', () => {
    let writes = 0;
    const unsubscribe = useHouseAgentWalkup.subscribe(() => {
      writes += 1;
    });
    setHouseAgentWalkup(2, true);
    setHouseAgentWalkup(2, true);
    setHouseAgentWalkup(2, true);
    expect(writes).toBe(1);
    setHouseAgentWalkup(2, false);
    expect(writes).toBe(2);
    setHouseAgentWalkup(-1, false);
    setHouseAgentWalkup(-1, false);
    expect(writes).toBe(3);
    unsubscribe();
    expect(useHouseAgentWalkup.getState()).toMatchObject({ index: -1, eAvailable: false });
  });

  test('an index outside 0..4 or not an integer reads as -1, and -1 never carries the E hint', () => {
    for (const bad of [5, 99, -2, 1.5, Number.NaN]) {
      setHouseAgentWalkup(bad, true);
      expect(useHouseAgentWalkup.getState()).toMatchObject({ index: -1, eAvailable: false });
    }
    setHouseAgentWalkup(4, true);
    expect(useHouseAgentWalkup.getState()).toMatchObject({ index: 4, eAvailable: true });
  });
});

describe('close button: stays closed until the player leaves and comes back', () => {
  test('dismiss holds for the same agent, clears when the index goes -1', () => {
    setHouseAgentWalkup(1, true);
    dismissHouseAgentWalkup();
    expect(useHouseAgentWalkupPanel.getState().dismissedIndex).toBe(1);
    setHouseAgentWalkup(1, false);
    expect(useHouseAgentWalkupPanel.getState().dismissedIndex).toBe(1);
    setHouseAgentWalkup(-1, false);
    expect(useHouseAgentWalkupPanel.getState().dismissedIndex).toBe(-1);
    setHouseAgentWalkup(1, true);
    expect(useHouseAgentWalkupPanel.getState().dismissedIndex).toBe(-1);
  });

  test('walking straight to the next agent does not carry the dismissal', () => {
    setHouseAgentWalkup(1, true);
    dismissHouseAgentWalkup();
    setHouseAgentWalkup(2, true);
    expect(useHouseAgentWalkupPanel.getState().dismissedIndex).toBe(-1);
  });

  test('dismiss at -1 does nothing', () => {
    dismissHouseAgentWalkup();
    expect(useHouseAgentWalkupPanel.getState().dismissedIndex).toBe(-1);
  });
});

describe('activateHouseAgentWalkup (the lowest E / USE rung)', () => {
  test('false at index -1, and nothing opens', () => {
    expect(activateHouseAgentWalkup()).toBe(false);
    expect(useGameStore.getState().exchangeOpen).toBe(false);
  });

  test('false while the Exchange panel is open, and the panel is left alone', () => {
    setHouseAgentWalkup(0, true);
    useGameStore.setState({ exchangeOpen: true, exchangeTab: 'browse' });
    expect(activateHouseAgentWalkup()).toBe(false);
    expect(useGameStore.getState().exchangeTab).toBe('browse');
    expect(useFloorArenaUi.getState().panel).toBe('overview');
  });

  test('false after the player closed the pop-up (nothing on screen to act on)', () => {
    setHouseAgentWalkup(0, true);
    dismissHouseAgentWalkup();
    expect(activateHouseAgentWalkup()).toBe(false);
    expect(useGameStore.getState().exchangeOpen).toBe(false);
  });

  test('otherwise runs the primary action: the launch with this template, and returns true', () => {
    setHouseAgentWalkup(1, true);
    expect(activateHouseAgentWalkup()).toBe(true);
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, exchangeTab: 'floor' });
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'runner' });
  });

  test('a viewer with a trader gets "Open my trader" (the desk), not a second launch', () => {
    useFloorArenaUi.setState({ myAgent: 'present' });
    setHouseAgentWalkup(3, true);
    expect(activateHouseAgentWalkup()).toBe(true);
    expect(useFloorArenaUi.getState().panel).toBe('desk');
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, exchangeTab: 'floor' });
    expect(storage.map.size).toBe(0);
  });
});

describe('chooseHouseAgentTemplate', () => {
  test('opens the existing launch flow with the template preselected', () => {
    setHouseAgentWalkupViewer('can-own');
    chooseHouseAgentTemplate('dip-hunter');
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'dip-hunter' });
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, exchangeTab: 'floor' });
  });

  test('a viewer who can own a trader leaves no pending key', () => {
    setHouseAgentWalkupViewer('can-own');
    chooseHouseAgentTemplate('genesis');
    expect(storage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
    expect(useHouseAgentWalkupPanel.getState().pendingTemplateId).toBeNull();
  });

  test('a guest (or a viewer not known yet) also stores {templateId, at} for after sign-up', () => {
    for (const viewer of ['cannot-own', 'unknown'] as const) {
      storage.map.clear();
      setHouseAgentWalkupViewer(viewer);
      const before = Date.now();
      chooseHouseAgentTemplate('late-bloomer');
      const raw = storage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as { templateId: string; at: number };
      expect(parsed.templateId).toBe('late-bloomer');
      expect(parsed.at).toBeGreaterThanOrEqual(before);
      expect(parsed.at).toBeLessThanOrEqual(Date.now());
      expect(useHouseAgentWalkupPanel.getState().pendingTemplateId).toBe('late-bloomer');
      // The guest still lands on the same launch call (it shows the sign-up card).
      expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'late-bloomer' });
    }
  });

  test('an unknown template id opens nothing and stores nothing', () => {
    setHouseAgentWalkupViewer('cannot-own');
    chooseHouseAgentTemplate('not-a-template');
    expect(useGameStore.getState().exchangeOpen).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  test('blocked or full storage never throws and the launch still opens', () => {
    installStorage(new ThrowingStorage());
    setHouseAgentWalkupViewer('cannot-own');
    expect(() => chooseHouseAgentTemplate('genesis')).not.toThrow();
    expect(useFloorArenaUi.getState().launchTemplateId).toBe('genesis');
    expect(() => readPendingHouseAgentTemplate()).not.toThrow();
    expect(readPendingHouseAgentTemplate()).toBeNull();
    expect(() => clearPendingHouseAgentTemplate()).not.toThrow();
  });

  test('no window at all (server render) never throws', () => {
    Reflect.deleteProperty(globalThis, 'window');
    setHouseAgentWalkupViewer('cannot-own');
    expect(() => chooseHouseAgentTemplate('runner')).not.toThrow();
    expect(readPendingHouseAgentTemplate()).toBeNull();
  });
});

describe('the pending key: 30 minutes, validated on every read', () => {
  test('TTL is 30 minutes and the key name is fixed', () => {
    expect(HOUSE_AGENT_PENDING_TEMPLATE_TTL_MS).toBe(30 * 60_000);
    expect(HOUSE_AGENT_PENDING_TEMPLATE_KEY).toBe('cv.floorArena.pendingTemplate');
  });

  test('a fresh key reads back; an expired one reads null and is removed', () => {
    const now = 1_800_000_000_000;
    storage.setItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY, JSON.stringify({ templateId: 'runner', at: now - 29 * 60_000 }));
    expect(readPendingHouseAgentTemplate(now)).toBe('runner');
    expect(useHouseAgentWalkupPanel.getState().pendingTemplateId).toBe('runner');

    storage.setItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY, JSON.stringify({ templateId: 'runner', at: now - 31 * 60_000 }));
    expect(readPendingHouseAgentTemplate(now)).toBeNull();
    expect(storage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
    expect(useHouseAgentWalkupPanel.getState().pendingTemplateId).toBeNull();
  });

  test('garbage, an unknown template or a future time reads null and is removed', () => {
    const now = 1_800_000_000_000;
    for (const raw of [
      'not json',
      JSON.stringify({ templateId: 'nope', at: now }),
      JSON.stringify({ templateId: 'runner' }),
      JSON.stringify({ templateId: 'runner', at: now + 10 * 60_000 }),
      JSON.stringify(['runner', now]),
    ]) {
      storage.setItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY, raw);
      expect(readPendingHouseAgentTemplate(now)).toBeNull();
      expect(storage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
    }
  });

  test('clear removes the key and the mirror', () => {
    setHouseAgentWalkupViewer('cannot-own');
    chooseHouseAgentTemplate('genesis');
    clearPendingHouseAgentTemplate();
    expect(storage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
    expect(useHouseAgentWalkupPanel.getState().pendingTemplateId).toBeNull();
  });
});
