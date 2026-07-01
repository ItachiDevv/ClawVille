/**
 * Identity-leak scrub for the PUBLIC world snapshot (P0, 2026-07-01, Codex/founder
 * audit — sibling of the B1 bearer-id fix).
 *
 * `SimulationSnapshot.autonomousAvatars` is served on the UNAUTH `/api/npc/state`
 * (+ the room `/api/world/:room/stream`). The raw `AvatarSimBroadcast` behind it
 * carries the owner `userId` + the raw `avatarId` (avatars.id UUID) + internal
 * budget/action fields. Neither id is a credential (no CT theft), but both are
 * internal identity that must NOT ship on the public wire (enumeration /
 * correlation). `publicAutonomousAvatars()` is an ALLOWLIST projection that emits
 * only render fields, drops `userId` + the budget/action fields, and replaces the
 * raw `avatarId` with the non-secret, non-reversible `derivePublicId` used by the
 * player + browser-claw snapshots.
 *
 * This stubs the broadcast INPUT (no runtime/store/network) and asserts the public
 * snapshot OUTPUT is scrubbed. Pure.
 */
import { describe, expect, it } from 'bun:test';
import { npcSimulation } from '../npc-simulation';

const RAW_AVATAR_UUID = '11111111-2222-3333-4444-555555555555';
const RAW_USER_UUID = '99999999-8888-7777-6666-555555555555';

type Mgr = { getAutonomousAvatars: () => unknown[] };

function withStubbedBroadcast(run: () => void) {
  const mgr = npcSimulation.avatarAutonomyManager as unknown as Mgr;
  const orig = mgr.getAutonomousAvatars.bind(mgr);
  mgr.getAutonomousAvatars = () => [
    {
      avatarId: RAW_AVATAR_UUID,
      userId: RAW_USER_UUID, // must be dropped
      name: 'AutoBot',
      species: 'milady_official_1',
      color: '#abcdef',
      x: 1234,
      y: 5678,
      direction: 'down',
      activity: 'walking',
      activityEmoji: '',
      isAutonomous: true,
      chatMessage: null,
      // internal fields the public shape must NOT carry:
      lastActionName: 'buy_cosmetic',
      lastActionResult: 'ok',
      budgetSpent: 4242,
      budgetPurchaseCount: 7,
    },
  ];
  try {
    run();
  } finally {
    mgr.getAutonomousAvatars = orig;
  }
}

describe('autonomousAvatars public snapshot scrubs internal identity', () => {
  it('drops userId + internal budget/action fields, derives avatarId, keeps render fields', () => {
    withStubbedBroadcast(() => {
      const snap = npcSimulation.getSnapshot();
      expect(snap.autonomousAvatars.length).toBe(1);
      const a = snap.autonomousAvatars[0] as Record<string, unknown>;

      // internal identity + internal fields are ABSENT.
      expect('userId' in a).toBe(false);
      expect('budgetSpent' in a).toBe(false);
      expect('budgetPurchaseCount' in a).toBe(false);
      expect('lastActionName' in a).toBe(false);
      expect('lastActionResult' in a).toBe(false);

      // avatarId is the DERIVED non-secret presence id (derivePublicId → 16 hex),
      // never the raw avatars.id UUID.
      expect(a.avatarId).not.toBe(RAW_AVATAR_UUID);
      expect(typeof a.avatarId).toBe('string');
      expect(a.avatarId as string).toMatch(/^[0-9a-f]{16}$/);

      // render fields preserved.
      expect(a.name).toBe('AutoBot');
      expect(a.species).toBe('milady_official_1');
      expect(a.x).toBe(1234);
      expect(a.y).toBe(5678);
      expect(a.isAutonomous).toBe(true);
    });
  });

  it('leaks NO raw UUID (avatarId OR userId) anywhere in the serialized public snapshot', () => {
    withStubbedBroadcast(() => {
      const json = JSON.stringify(npcSimulation.getSnapshot());
      expect(json.includes(RAW_AVATAR_UUID)).toBe(false);
      expect(json.includes(RAW_USER_UUID)).toBe(false);
      // no UUID-shaped token at all in the autonomousAvatars projection.
      const avatarsJson = JSON.stringify(npcSimulation.getSnapshot().autonomousAvatars);
      expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(avatarsJson)).toBe(false);
    });
  });
});
