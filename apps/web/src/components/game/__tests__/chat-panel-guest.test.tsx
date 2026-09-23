import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import ChatPanel from '../chat-panel';
import NoriButton from '../nori-button';
import { useGuideChat } from '@/hooks/use-guide-chat';
import { api, ApiError, type GuestSignupResponse } from '@/lib/api';
import { useGameStore } from '@/stores/game';
import { useQuestStore } from '@/stores/quest';

const testWindow = new Window({ url: 'http://localhost/game', width: 390, height: 844 });
const names = ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let createRoot: typeof import('react-dom/client').createRoot;
let root: Root | null;
let container: HTMLElement;
let client: QueryClient;
let hook: ReturnType<typeof useGuideChat>;
let chatSpy: ReturnType<typeof spyOn<typeof api, 'sendSystemChat'>>;
let guestSpy: ReturnType<typeof spyOn<typeof api, 'guestSignup'>>;
let countSpy: ReturnType<typeof spyOn<ReturnType<typeof useQuestStore.getState>, 'incrementCounter'>>;
let questSpy: ReturnType<typeof spyOn<ReturnType<typeof useQuestStore.getState>, 'checkAndCompleteQuests'>>;
const guest: GuestSignupResponse = {
  user: { id: 'guest-test', name: 'Visitor', email: null, isGuest: true },
  avatar: { id: 'guest-avatar-test', name: 'Visitor' }, reused: false,
};
const reply = { message: { role: 'assistant', content: 'The Bounty Board is at the pavilion.', timestamp: '2026-09-22T00:00:00Z' } };

function HookProbe() { hook = useGuideChat(); return null; }

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root?.render(createElement(QueryClientProvider, { client }, node)));
  await flush();
}

beforeAll(async () => {
  for (const name of names) {
    const value = name === 'window' ? testWindow
      : name === 'IS_REACT_ACT_ENVIRONMENT' ? true
      : testWindow[name as keyof typeof testWindow];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useGameStore.setState({ controlMode: 'explore', chatOpen: false, guideChatOpen: false, movementFrozen: false, currentLocation: null });
  chatSpy = spyOn(api, 'sendSystemChat').mockResolvedValue(reply);
  guestSpy = spyOn(api, 'guestSignup').mockResolvedValue(guest);
  countSpy = spyOn(useQuestStore.getState(), 'incrementCounter').mockImplementation(() => {});
  questSpy = spyOn(useQuestStore.getState(), 'checkAndCompleteQuests').mockReturnValue([]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  client.clear();
  chatSpy.mockRestore(); guestSpy.mockRestore(); countSpy.mockRestore(); questSpy.mockRestore();
  useGameStore.setState({ guideChatOpen: false, movementFrozen: false });
});

afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

describe('Nori without an avatar', () => {
  test('the real game page mounts ChatPanel outside every conditional avatar gate', () => {
    const source = readFileSync(new URL('../../../app/(world)/game/page.tsx', import.meta.url), 'utf8');
    const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let panels = 0;
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ChatPanel') {
        panels++;
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
          expect(ts.isConditionalExpression(ancestor)).toBe(false);
          if (ts.isBinaryExpression(ancestor)) expect(ancestor.operatorToken.kind).not.toBe(ts.SyntaxKind.AmpersandAmpersandToken);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(panels).toBe(1);
  });

  test('Explore shortcut opens a panel and touch Close restores movement without an avatar', async () => {
    await mount(createElement('div', null, createElement(NoriButton), createElement(ChatPanel)));
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(container.textContent).toContain('your town guide');
    expect(useGameStore.getState().movementFrozen).toBe(true);
    const close = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close.className).toContain('w-11 h-11');
    await act(async () => close.click());
    expect(useGameStore.getState().movementFrozen).toBe(false);
    expect(container.querySelector('input')).toBeNull();
    expect(chatSpy).not.toHaveBeenCalled();
    expect(guestSpy).not.toHaveBeenCalled();
  });

  test('a definitive 401 creates one guest session and retries the exact message once', async () => {
    chatSpy.mockRejectedValueOnce(new ApiError('Authentication required', 401));
    await mount(createElement(HookProbe));
    const text = 'Where is the Bounty Board?';
    await act(async () => hook.sendMessage(text));
    await flush();
    expect(guestSpy).toHaveBeenCalledTimes(1);
    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(chatSpy.mock.calls).toEqual([['town-guide', text], ['town-guide', text]]);
    expect(hook.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().controlMode).toBe('explore');
  });

  for (const error of [new ApiError('Unavailable', 503), new TypeError('Network interrupted')]) {
    test(`${error.message}: no identity change, replay, or quest credit`, async () => {
      chatSpy.mockRejectedValue(error);
      await mount(createElement(HookProbe));
      await act(async () => hook.sendMessage('Hello Nori'));
      await flush();
      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(guestSpy).not.toHaveBeenCalled();
      expect(countSpy).not.toHaveBeenCalled();
      expect(hook.error).toBe(error);
    });
  }

  test('a second 401 stops after one retry', async () => {
    chatSpy.mockRejectedValue(new ApiError('Authentication required', 401));
    await mount(createElement(HookProbe));
    await act(async () => hook.sendMessage('Hello'));
    await flush();
    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(guestSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).not.toHaveBeenCalled();
    expect(hook.error).toBeInstanceOf(ApiError);
  });

  test('guest bootstrap failure stays visible and does not replay or award a quest turn', async () => {
    chatSpy.mockRejectedValue(new ApiError('Authentication required', 401));
    guestSpy.mockRejectedValue(new ApiError('Guest limit', 429));
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mount(createElement(HookProbe));
      await act(async () => hook.sendMessage('Hello'));
      await flush();
      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(guestSpy).toHaveBeenCalledTimes(1);
      expect(countSpy).not.toHaveBeenCalled();
      expect(hook.error?.message).toContain('Could not start guest chat');
    } finally {
      warning.mockRestore();
    }
  });

  test('a failed message displays an error and leaves touch Close available', async () => {
    chatSpy.mockRejectedValue(new ApiError('Unavailable', 503));
    useGameStore.setState({ guideChatOpen: true, movementFrozen: true });
    await mount(createElement(ChatPanel));
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Hello');
      input.dispatchEvent(new testWindow.Event('input', { bubbles: true }) as unknown as Event);
    });
    const send = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Send')!;
    await act(async () => send.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Nori could not reply');
    expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });
});
