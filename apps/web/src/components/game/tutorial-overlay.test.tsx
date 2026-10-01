import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import TutorialOverlay, { tutorialAudience, tutorialSteps, type TutorialAudience } from './tutorial-overlay';
import { useGameStore } from '@/stores/game';

// The first card told EVERY reader "You just created an AI-powered agent",
// including a guest who has no agent. The card now follows the reader.

const OLD_WELCOME = 'You just created an AI-powered agent';
const MENU_TITLE = 'Open the Menu';
const AUDIENCES: TutorialAudience[] = ['unknown', 'guest', 'player', 'trainer'];

const base = { authResolved: true, isAuthenticated: true, isGuest: false, agentPaired: false, agentSessionMode: undefined };

describe('tutorialAudience', () => {
  test('maps the auth and agent state to one reader', () => {
    expect(tutorialAudience({ ...base, authResolved: false })).toBe('unknown');
    expect(tutorialAudience({ ...base, isAuthenticated: false })).toBe('guest');
    expect(tutorialAudience({ ...base, isGuest: true })).toBe('guest');
    // The server answers 'none' for a guest; the guest check wins.
    expect(tutorialAudience({ ...base, isGuest: true, agentSessionMode: 'none' })).toBe('guest');
    expect(tutorialAudience({ ...base, agentSessionMode: 'none' })).toBe('player');
    expect(tutorialAudience({ ...base, agentSessionMode: 'provisioning-pending' })).toBe('player');
    for (const mode of ['hosted', 'external-active', 'external-idle', 'external-expired']) {
      expect(tutorialAudience({ ...base, agentSessionMode: mode })).toBe('trainer');
    }
    // Agent-session read still loading, or a dismissed banner: copy true for everyone.
    expect(tutorialAudience({ ...base, agentSessionMode: undefined })).toBe('unknown');
    expect(tutorialAudience({ ...base, agentSessionMode: 'dismissed' })).toBe('unknown');
    // An in-session pairing wins, like the /game banner.
    expect(tutorialAudience({ ...base, authResolved: false, agentPaired: true })).toBe('trainer');
  });
});

describe('tutorialSteps copy', () => {
  test('no reader sees the old "You just created" card', () => {
    for (const audience of AUDIENCES) {
      expect(tutorialSteps(audience)[0]!.content).not.toContain(OLD_WELCOME);
    }
  });

  test('each reader gets an honest first card', () => {
    const guest = tutorialSteps('guest')[0]!.content;
    expect(guest).toContain('as a guest');
    expect(guest).toContain("don't have an agent yet");
    expect(guest).toContain('Log in or sign up');
    expect(guest).toContain('connect one you already run');
    const player = tutorialSteps('player')[0]!.content;
    expect(player).toContain('signed in');
    expect(player).toContain('no agent yet');
    expect(player).toContain('agent button at the top of the screen');
    const trainer = tutorialSteps('trainer')[0]!.content;
    expect(trainer).toContain('Your agent is here with you');
    expect(trainer).toContain('Controlled');
    expect(trainer).toContain('Autonomous');
    const unknown = tutorialSteps('unknown')[0]!.content;
    expect(unknown).not.toMatch(/\byour agent\b/i);
    expect(new Set(AUDIENCES.map((audience) => tutorialSteps(audience)[0]!.content)).size).toBe(4);
  });

  test('only a reader with an agent is told "your agent" on the last card; the other middle cards never change', () => {
    const notMenu = (step: { title: string }) => step.title !== MENU_TITLE;
    for (const audience of AUDIENCES) {
      const steps = tutorialSteps(audience);
      const last = steps[steps.length - 1]!.content;
      if (audience === 'trainer') expect(last).toContain('Your agent');
      else expect(last).not.toMatch(/\byour agent\b/i);
      expect(steps.slice(1, -1).filter(notMenu)).toEqual(tutorialSteps('unknown').slice(1, -1).filter(notMenu));
      for (const step of steps) expect(step.content).not.toMatch(/—|\bCT\b|casino/i);
    }
  });

  // The menu card told every reader to "Open the gear menu (top right) to
  // manage your agent, configure location agents ...": a guest has no agent,
  // and the location-agent editor has no entry point.
  test('the menu card follows the reader and never sends a guest or a player to manage an agent', () => {
    const menuCard = (audience: TutorialAudience) => {
      const cards = tutorialSteps(audience).filter((step) => step.title === MENU_TITLE);
      expect(cards).toHaveLength(1);
      return cards[0]!.content;
    };
    for (const audience of AUDIENCES) {
      const text = menuCard(audience);
      expect(text).not.toContain('gear menu (top right)');
      expect(text).not.toContain('location agents');
      expect(text).toContain('right side of the screen');
      expect(text).toContain('Press Map at the top left');
      if (audience !== 'trainer') expect(text).not.toMatch(/manage your agent/i);
    }
    const guest = menuCard('guest');
    expect(guest).not.toMatch(/\byour agent\b/i);
    expect(guest).toContain('Log In and Sign Up');
    expect(guest).toContain('get an agent of your own');
    expect(menuCard('unknown')).not.toMatch(/\byour agent\b/i);
    expect(menuCard('player')).toContain('sets up your agent or connects one you already run');
    const trainer = menuCard('trainer');
    expect(trainer).toContain('manage your agent');
    expect(trainer).toContain('My Agent');
    expect(new Set(AUDIENCES.map(menuCard)).size).toBe(4);
  });
});

// --- The overlay reads the reader itself (the /game page passes no props) ---

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
let createRoot: typeof import('react-dom/client').createRoot;
let root: Root | null = null;
let container: HTMLElement | null = null;
let fetched: string[] = [];

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  define('localStorage', testWindow.localStorage);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async (input: RequestInfo | URL) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  });
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  fetched = [];
  testWindow.localStorage.clear();
  useGameStore.setState({ agentPaired: false, agentConnected: false });
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

async function firstCardText(seed: (client: QueryClient) => void): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnMount: false } },
  });
  seed(client);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(TutorialOverlay)));
  });
  return container.textContent ?? '';
}

describe('TutorialOverlay reads the reader from app state', () => {
  test('a logged-out visitor (auth-me null) sees the guest card', async () => {
    const text = await firstCardText((client) => client.setQueryData(['auth-me'], null));
    expect(text).toContain('Welcome to ClawVille!');
    expect(text).toContain('as a guest');
    expect(text).not.toContain(OLD_WELCOME);
  });

  test('a guest account sees the guest card', async () => {
    const text = await firstCardText((client) => client.setQueryData(['auth-me'], { user: { id: 'g', isGuest: true } }));
    expect(text).toContain('as a guest');
  });

  test('a signed-in player with no agent sees the player card', async () => {
    const text = await firstCardText((client) => {
      client.setQueryData(['auth-me'], { user: { id: 'u', isGuest: false } });
      client.setQueryData(['agent-session'], { connected: false, mode: 'none' });
    });
    expect(text).toContain('your account has no agent yet');
  });

  test('a trainer with a hosted agent sees the trainer card', async () => {
    const text = await firstCardText((client) => {
      client.setQueryData(['auth-me'], { user: { id: 'u', isGuest: false } });
      client.setQueryData(['agent-session'], { connected: true, mode: 'hosted', agentId: 'a' });
    });
    expect(text).toContain('Your agent is here with you');
  });

  test('a guest who presses Next up to the menu card sees the guest menu copy', async () => {
    let text = await firstCardText((client) => client.setQueryData(['auth-me'], { user: { id: 'g', isGuest: true } }));
    for (let clicks = 0; clicks < 12 && !text.includes(MENU_TITLE); clicks += 1) {
      const next = [...container!.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Next');
      expect(next).toBeDefined();
      await act(async () => { next!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      // nextStep() advances after a 150 ms fade.
      await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 200)); });
      text = container!.textContent ?? '';
    }
    expect(text).toContain(MENU_TITLE);
    expect(text).toContain('Log In and Sign Up');
    expect(text).not.toMatch(/manage your agent/i);
  });

  test('the overlay never fetches ["agent-session"] itself (the /game page owns that read)', async () => {
    await firstCardText((client) => client.setQueryData(['auth-me'], { user: { id: 'u', isGuest: false } }));
    expect(fetched.some((url) => url.includes('agent-session'))).toBe(false);
  });
});
