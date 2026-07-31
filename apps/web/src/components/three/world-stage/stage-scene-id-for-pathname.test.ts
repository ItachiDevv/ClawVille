import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  canonicalStageUrl,
  sceneIdForPathname,
  stageDestinationKey,
  stagePathnameFromHref,
} from './stage-scene-id';

let dom: JSDOM;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeAll(() => {
  dom = new JSDOM('', { url: 'https://clawville.test/game' });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
});

afterAll(() => {
  dom.window.close();
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('stage pathname identity', () => {
  test.each([
    ['/game', 'world'],
    ['/cove', 'cove'],
    ['/kelp', 'kelp'],
  ] as const)('%s maps to %s', (pathname, sceneId) => {
    expect(sceneIdForPathname(pathname)).toBe(sceneId);
  });

  test.each([
    '/activity/reef-race/abc',
    '/activity/bumper-shells/abc',
  ])('%s maps to activity', (pathname) => {
    expect(sceneIdForPathname(pathname)).toBe('activity');
  });

  test.each([
    '/activity',
    '/activity/reef-race',
    '/activity/a/b/c',
    '/activity//abc',
  ])('%s rejects malformed activity depth', (pathname) => {
    expect(sceneIdForPathname(pathname)).toBeNull();
  });

  test.each([
    '/cove/history',
    '/cove/verify',
    '/game/x',
  ])('%s remains outside the stage', (pathname) => {
    expect(sceneIdForPathname(pathname)).toBeNull();
  });

  test.each([
    ['/game?quickQueue=reef-race', '/game', 'world'],
    ['/game#x', '/game', 'world'],
    [
      '/activity/reef-race/abc?shortCode=Q7X3RT',
      '/activity/reef-race/abc',
      'activity',
    ],
    [
      '/activity/reef-race/abc?invite=X#y',
      '/activity/reef-race/abc',
      'activity',
    ],
  ] as const)('%s resolves through href parsing', (href, pathname, sceneId) => {
    expect(stagePathnameFromHref(href)).toBe(pathname);
    expect(sceneIdForPathname(stagePathnameFromHref(href))).toBe(sceneId);
  });

  test.each([
    '/game/',
    '/activity/reef-race/abc/',
  ])('%s rejects a trailing slash', (pathname) => {
    expect(sceneIdForPathname(pathname)).toBeNull();
  });

  test.each([
    ['/game', 'world'],
    ['/cove', 'cove'],
    ['/kelp', 'kelp'],
  ] as const)('%s has no destination sub-identity', (pathname, key) => {
    expect(stageDestinationKey(pathname)).toBe(key);
    expect(stageDestinationKey(pathname)).toBe(sceneIdForPathname(pathname));
  });

  test.each([
    ['/activity/reef-race/A', 'activity:reef-race:A'],
    ['/activity/reef-race/B', 'activity:reef-race:B'],
  ] as const)('%s preserves room identity', (pathname, key) => {
    expect(stageDestinationKey(pathname)).toBe(key);
    expect(sceneIdForPathname(pathname)).toBe('activity');
    expect(canonicalStageUrl(`${pathname}?__wsnav=e.1`)).toBe(pathname);
  });

  test('a non-stage pathname has no destination key', () => {
    expect(stageDestinationKey('/leaderboard')).toBeNull();
  });
});
