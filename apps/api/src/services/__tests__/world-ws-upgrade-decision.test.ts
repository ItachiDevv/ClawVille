import { describe, expect, it } from 'bun:test';

// No npc-simulation mock: decideWorldWsUpgrade is a pure function, and a partial
// mock.module('../npc-simulation') poisons every later suite in the shared-process
// CI gate (see world-position-apply.test.ts). Loading the real module is safe —
// the other gate suites already do.
const { decideWorldWsUpgrade } = await import('../world-presence-ws-hub');

const allowed = {
  enabled: true,
  ipUpgradeAllowed: true,
  roomIdValid: true,
  originAllowed: true,
  presenceResolved: true,
  ipSlotReserved: true,
};

describe('world WS upgrade decision', () => {
  it.each([
    [
      { ...allowed, enabled: false },
      { ok: false, status: 503, code: 'world_ws_disabled' },
    ],
    [
      { ...allowed, ipUpgradeAllowed: false },
      { ok: false, status: 429, code: 'ws_upgrade_rate_limited' },
    ],
    [
      { ...allowed, roomIdValid: false },
      { ok: false, status: 400, code: 'invalid_room_id' },
    ],
    [
      { ...allowed, originAllowed: false },
      { ok: false, status: 403, code: 'origin_not_allowed' },
    ],
    [
      { ...allowed, presenceResolved: false },
      { ok: false, status: 401, code: 'no_presence' },
    ],
    [
      { ...allowed, ipSlotReserved: false },
      { ok: false, status: 429, code: 'ws_concurrency_cap' },
    ],
    [allowed, { ok: true }],
  ] as const)('returns the ordered table result %#', (input, expected) => {
    expect(decideWorldWsUpgrade(input)).toEqual(expected);
  });

  it('pins first-match ordering', () => {
    expect(
      decideWorldWsUpgrade({
        ...allowed,
        enabled: false,
        roomIdValid: false,
      }),
    ).toMatchObject({ code: 'world_ws_disabled' });
    expect(
      decideWorldWsUpgrade({
        ...allowed,
        ipUpgradeAllowed: false,
        originAllowed: false,
      }),
    ).toMatchObject({ code: 'ws_upgrade_rate_limited' });
    expect(
      decideWorldWsUpgrade({
        ...allowed,
        presenceResolved: false,
        ipSlotReserved: false,
      }),
    ).toMatchObject({ code: 'no_presence' });
  });

  it('cannot return a membership-class rejection', () => {
    const possibleResults = [
      allowed,
      { ...allowed, enabled: false },
      { ...allowed, presenceResolved: false },
    ].map((input) => JSON.stringify(decideWorldWsUpgrade(input)));
    expect(possibleResults.join(' ')).not.toContain('membership');
    expect(possibleResults.join(' ')).not.toContain('room_mismatch');
  });
});
