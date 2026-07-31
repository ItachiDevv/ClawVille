import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string): string =>
  readFileSync(resolve(import.meta.dir, path), 'utf8');

const pageSource = read('page.tsx');
const lobbySource = read('../../../../../components/game/lobby-landing.tsx');
const mobileSource = read(
  '../../../../../components/game/activity-mobile-controls.tsx',
);
const inputSource = read('../../../../../hooks/useActivityInput.ts');
const playerSource = read(
  '../../../../../lib/three/activities/reef-race/ReefRacePlayer.tsx',
);
const bumperSource = read(
  '../../../../../lib/three/activities/bumper-shells/BumperShellsScene.tsx',
);

describe('room-keyed activity runtime', () => {
  test('changing activity or room remounts the runtime subtree', () => {
    expect(pageSource).toContain('key={`${activityId}:${roomId}`}');
  });

  test('shortCode is initialized inside the keyed runtime from current search params', () => {
    expect(pageSource.indexOf('function ActivityRoomRuntime')).toBeLessThan(
      pageSource.indexOf('const [shortCode, setShortCode]'),
    );
    expect(pageSource).toContain(
      "searchParams?.get('shortCode') ?? null",
    );
    expect(pageSource).toContain('shortCode: shortCode ??');
  });

  test('lobby gate initializer lives inside the keyed runtime', () => {
    expect(pageSource).toMatch(
      /function ActivityRoomRuntime[\s\S]*?const \[lobbyGate, setLobbyGate\] = useState/,
    );
  });

  test('spectator camera state lives inside the keyed runtime', () => {
    expect(pageSource).toContain(
      "useState<SpectatorCamMode>('action')",
    );
    expect(pageSource).toContain(
      'const [spectatorTargetAvatarId, setSpectatorTargetAvatarId]',
    );
  });

  test('activity store resets to the new room and clears on teardown', () => {
    expect(pageSource).toMatch(
      /useActivityStore\.getState\(\)\.reset\(roomId\);[\s\S]*?reset\(null\);[\s\S]*?\[roomId\]/,
    );
  });

  test('both reef self buses reset with their keyed owners', () => {
    expect(inputSource).toContain('resetSelfInputBus()');
    expect(playerSource).toContain('resetSelfPoseBus()');
  });

  test('bumper hit and elimination scratch reset on roomId change', () => {
    expect(bumperSource).toMatch(
      /_hitCheckScratch\.lastHitCount = 0;\s*_elimCheckScratch\.lastElimCount = 0;[\s\S]*?\[roomId\]/,
    );
  });

  test('LobbyLanding local fields get fresh initializers on a room-key change', () => {
    for (const initializer of [
      "useState<Phase>('loading')",
      'useState<LobbySnapshot | null>(null)',
      'useState<LobbyPlayerSnapshot[]>([])',
      'useState<string | null>(null)',
      'useState<number>(0)',
      'useState<number>(4)',
      "useState<LobbyVisibility>('public')",
      "useState<LobbyMode>('multiplayer')",
      'useState(false)',
    ]) {
      expect(lobbySource).toContain(initializer);
    }
    expect(pageSource).toContain('key={`${activityId}:${roomId}`}');
  });

  test('LobbyLanding clears every three-second poll on room change and unmount', () => {
    expect(lobbySource).toContain('setTimeout(tick, 3000)');
    expect(lobbySource.match(/clearTimeout\(pollTimer\.current\)/g)).toHaveLength(
      2,
    );
    expect(lobbySource).toContain('[activityId, roomId, inviteCode]');
  });

  test('mobile flashes and nipple manager are recreated by the keyed subtree', () => {
    expect(mobileSource).toContain('const [boostFlash, setBoostFlash]');
    expect(mobileSource).toContain(
      'const [powerupFlash, setPowerupFlash]',
    );
    expect(mobileSource).toContain('nipplejs.create');
    expect(mobileSource).toContain('leftJoystickRef.current.destroy()');
    expect(pageSource).toContain('key={`${activityId}:${roomId}`}');
  });

  test('audio unlock listeners are registered once above room-specific rendering', () => {
    expect(pageSource.match(/primeActivitySounds\(\)/g)).toHaveLength(1);
    expect(pageSource.match(/window\.addEventListener\('pointerdown'/g)).toHaveLength(
      1,
    );
    expect(pageSource).not.toMatch(
      /<ActivityRoomRuntime[\s\S]*?primeActivitySounds\(\)/,
    );
  });
});
