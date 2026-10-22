import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement, type ComponentProps } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { CashPublicSeat, PublicTableStateResponse } from '@/lib/cove/cash-poker';

// Staging 2026-10-21 (hand 8299): every cash-table seat badge floated one
// chair off. The 3D projector (`SEAT_BADGE_WORLD_ANCHORS` in
// holdem-table-room.tsx) reads registry slot 0 as the viewer's own seat and
// slots 1..5 as BOT_SEATS[0..4]. Physical chair N (0..4) holds server seat
// `(pov + N + 1) % 6`, so its badge must register as slot N + 1. The cash HUD
// registered chair N as slot N, so each badge followed the previous chair.

const testWindow = new Window({ url: 'http://localhost/cove', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'HTMLDivElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

type HudModule = typeof import('../SeatedHoldemHud');
type HudProps = ComponentProps<HudModule['CashTableRoomHud']>;

let createRoot: typeof import('react-dom/client').createRoot;
let CashTableRoomHud: HudModule['CashTableRoomHud'];
let getHoldemSeatBadgeElement: typeof import('@/lib/cove/holdem-table-view').getHoldemSeatBadgeElement;
let root: Root | null = null;
let container: HTMLElement | null = null;

/** Copy of SeatedHoldemHud.tsx `TABLE_ROOM_SEAT_ANCHORS` (index = registry slot). */
const TABLE_ROOM_SEAT_ANCHORS = [
  { left: 50, top: 76 },
  { left: 95, top: 70 },
  { left: 95, top: 54 },
  { left: 94, top: 37 },
  { left: 5, top: 54 },
  { left: 6, top: 37 },
] as const;

const POV_SEAT = 3;
const NAMES: Record<number, string> = {
  0: 'Felt-Bot-000',
  1: 'Felt-Bot-001',
  2: 'Felt-Bot-002',
  3: 'Viewer-Seat-3',
  // Chair 0 holds seat 4, so the old slot-N bug put this badge in slot 0.
  4: 'Felt-Bot-004',
};

function liveSeat(seatIndex: number): CashPublicSeat {
  return {
    seatIndex,
    avatarId: `avatar-${seatIndex}`,
    name: NAMES[seatIndex]!,
    subjectType: seatIndex === POV_SEAT ? 'human' : 'agent',
    chipStack: 1_000 + seatIndex,
    streetBet: 0,
    totalCommitted: 0,
    status: 'active',
    isButton: false,
    isSB: false,
    isBB: false,
    isActing: false,
  };
}

function fixtureState(): PublicTableStateResponse {
  const occupied = [0, 1, 2, POV_SEAT, 4];
  return {
    ok: true,
    table: {
      id: 'table-badge-slots',
      source: 'house',
      visibility: 'public',
      tierKey: 'low',
      buyInCt: '200',
      smallBlindCt: '10',
      bigBlindCt: '20',
      maxSeats: 6,
      status: 'open',
    },
    seats: occupied.map((seatIndex) => ({
      seatIndex,
      avatarId: `avatar-${seatIndex}`,
      subjectType: seatIndex === POV_SEAT ? 'human' : 'agent',
      isSeeded: seatIndex !== POV_SEAT,
      stackCt: String(1_000 + seatIndex),
      status: 'sitting_in',
    })),
    live: {
      tableId: 'table-badge-slots',
      handNumber: 8299,
      blinds: { sb: 10, bb: 20, ante: 0, level: 0 },
      buttonSeatIndex: 0,
      board: [],
      pot: 30,
      sidePots: [],
      toActSeatIndex: null,
      toActDeadlineMs: null,
      toCall: 0,
      minRaiseTo: 40,
      seats: occupied.map(liveSeat),
      street: 'preflop',
      serverSeedCommitHash: 'commit',
      actions: [],
    },
  };
}

async function mountHud(state: PublicTableStateResponse = fixtureState()): Promise<HTMLElement> {
  const props: HudProps = {
    instanceId: 'cash-badge-slots',
    state,
    selfView: null,
    settled: null,
    povSeatIndex: POV_SEAT,
    amSeated: true,
    sitting: false,
    leaving: false,
    leaveQueued: false,
    actionBusy: false,
    onSit: () => {},
    onLeave: () => {},
    onAction: () => {},
    selfAvatarId: `avatar-${POV_SEAT}`,
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CashTableRoomHud, props));
  });
  return container;
}

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);

  ({ createRoot } = await import('react-dom/client'));
  ({ getHoldemSeatBadgeElement } = await import('@/lib/cove/holdem-table-view'));
  ({ CashTableRoomHud } = await import('../SeatedHoldemHud'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

describe('CashTableRoomHud seat-badge registry slots', () => {
  test('physical chair N registers as slot N + 1 and shows server seat (pov + N + 1) % 6', async () => {
    const hud = await mountHud();

    // Slot 0 is the viewer's own seat: the cash HUD never registers a badge there.
    // (Text, not the element, so a failure prints a readable badge.)
    expect(getHoldemSeatBadgeElement(0)?.textContent ?? null).toBeNull();

    for (let chair = 0; chair < 5; chair += 1) {
      const slot = chair + 1;
      const serverSeat = (POV_SEAT + chair + 1) % 6;
      const badge = getHoldemSeatBadgeElement(slot);
      const name = NAMES[serverSeat];
      if (!name) {
        // Chair 1 holds the empty server seat 5.
        expect(badge?.textContent ?? null).toBeNull();
        continue;
      }
      expect(badge).not.toBeNull();
      expect(hud.contains(badge)).toBe(true);
      // The first span of the name row is the seat name; the stack is unique per seat.
      expect(badge!.querySelector('span')?.textContent).toBe(name);
      expect(badge!.textContent).toContain(`${(1_000 + serverSeat).toLocaleString()} vCLAW`);
      // The static fallback position agrees with the registry slot.
      expect(badge!.style.left).toBe(`${TABLE_ROOM_SEAT_ANCHORS[slot].left}%`);
      expect(badge!.style.top).toBe(`${TABLE_ROOM_SEAT_ANCHORS[slot].top}%`);
    }

    // Exactly the four opponents carry badges, and every one is registered.
    const registered = [0, 1, 2, 3, 4, 5]
      .map((slot) => getHoldemSeatBadgeElement(slot))
      .filter((element) => element !== null);
    expect(registered).toHaveLength(4);
  });

  test('unmount clears every registered badge slot', async () => {
    await mountHud();
    await act(async () => root?.unmount());
    root = null;
    for (let slot = 0; slot < 6; slot += 1) {
      expect(getHoldemSeatBadgeElement(slot)).toBeNull();
    }
  });

  // Staging 2026-10-21: a bot that sat out was not in the live hand, so its
  // chair had no badge during a hand and read "SEAT N" between hands. The
  // roster row now carries the avatar name (protocol 96) and the badge shows
  // for every seated player, in the hand or not.
  test('a sitting-out roster seat keeps its badge and its name during a live hand', async () => {
    const state = fixtureState();
    state.seats.push({
      seatIndex: 5,
      avatarId: 'avatar-5',
      subjectType: 'agent',
      isSeeded: true,
      stackCt: '200',
      status: 'sitting_out',
      name: 'Felt-Bot-005',
    });
    await mountHud(state);
    // Chair 1 holds server seat (3 + 1 + 1) % 6 = 5, registry slot 2.
    const badge = getHoldemSeatBadgeElement(2);
    expect(badge).not.toBeNull();
    expect(badge!.querySelector('span')?.textContent).toBe('Felt-Bot-005');
    expect(badge!.textContent).toContain('200 vCLAW');
    expect(badge!.textContent).toContain('Sitting out');
    expect(badge!.textContent).not.toContain('Seat 6');
  });
});
