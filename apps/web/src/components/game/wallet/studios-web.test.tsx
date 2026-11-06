import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// MCP hub phase 3 web: the human path for every Studios feature in the wallet
// panel. Pay mode save (linked-wallet signature), Studios sign-in and its
// return message, the video / character-shot / recast forms (request key and
// polling), pay-mode gating, media delete with a proof, and video markup.

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = [
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'MutationObserver',
] as const;
const installed = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

let createRoot: typeof import('react-dom/client').createRoot;
let card: typeof import('./studios-card');
let payMode: typeof import('./studios-pay-mode');
let forms: typeof import('./studios-forms');
let media: typeof import('./studios-media');
let store: typeof import('./studios-request-store');
let useGameStore: typeof import('@/stores/game').useGameStore;
let api: typeof import('@/lib/api').api;
let ApiError: typeof import('@/lib/api').ApiError;
let originalApi: Record<string, unknown> = {};

const LINKED = 'LinkedWallet1111111111111111111111111111111';
const MEDIA_IMG = '11111111-2222-4333-8444-555555555555';
const MEDIA_VID = '22222222-2222-4333-8444-555555555555';
const REQ = '33333333-2222-4333-8444-555555555555';
const signed: string[] = [];
const fakeWallet = {
  connect: async () => ({ publicKey: { toString: () => LINKED } }),
  signMessage: async (bytes: Uint8Array) => {
    signed.push(new TextDecoder().decode(bytes));
    return { signature: new Uint8Array(64).fill(7) };
  },
};

let payModeSaved: 'wallet' | 'key' | 'signin' | null = null;
let keyLinked = false;
let oauth: { linked: boolean; status: 'active' | 'broken' | null } = { linked: false, status: null };
let requestView: Record<string, unknown> | null = null;
let postAnswer: () => Promise<unknown> = async () => ({ status: 'running', requestId: REQ, message: 'x' });
const log: Array<{ fn: string; arg: unknown }> = [];
const navigated: string[] = [];
let authorizeUrl = 'https://mystudios.fun/connect/authorize?state=s';

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

function policyView() {
  return {
    dailyCapUsdCents: 100,
    perCallCapUsdCents: 25,
    allowedVendors: ['studios'],
    studiosKeyImagesPerDay: 10,
    studiosVideosPerDay: 2,
    studiosCharacterShotsPerDay: 5,
    studiosRecastsPerDay: 1,
    requireApproval: false,
    studiosPayMode: payModeSaved,
    configured: true,
    updatedAt: null,
  };
}

const MENUS: Record<string, unknown> = {
  'media-models': {
    menu: 'media-models',
    models: [
      { id: 'flux-image', kind: 'image', operations: {} },
      {
        id: 'minimax-h3-max-turbo',
        kind: 'video',
        operations: { text_to_video: { usdPerUnit: 0.04, audio: true } },
        resolutions: ['768p', '4k'],
        aspectRatios: ['16:9', 'bad'],
        durationSeconds: { min: 5, max: 10, step: 5, default: 5 },
      },
    ],
  },
  'image-styles': { menu: 'image-styles', styles: [{ id: '3d-mascot', type: 'style' }] },
  'recast-presets': {
    menu: 'recast-presets',
    presets: [{ id: 'duo-dance', performers: 2, seconds: 15, priceUsd: 2.4, defaultResolution: '720p', resolutions: [{ id: '480p', priceUsd: 1.17 }, { id: '720p', priceUsd: 2.4 }], shape: 'tall' }],
    ownClip: null,
  },
};

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async () => new Response('{}', { status: 404 }));
  ({ createRoot } = await import('react-dom/client'));
  ({ api, ApiError } = await import('@/lib/api'));
  ({ useGameStore } = await import('@/stores/game'));
  card = await import('./studios-card');
  payMode = await import('./studios-pay-mode');
  forms = await import('./studios-forms');
  media = await import('./studios-media');
  store = await import('./studios-request-store');
  payMode.studiosNavigation.go = (url: string) => {
    navigated.push(url);
  };
  const m = api as unknown as Record<string, unknown>;
  const names = [
    'me', 'getSpendPolicy', 'putSpendPolicy', 'spendPolicyChallenge', 'studiosKeyStatus', 'studiosOAuthStatus',
    'studiosOAuthChallenge', 'studiosOAuthStart', 'studiosOAuthUnlink', 'studiosSigninAccount', 'studiosSigninMedia',
    'studiosImages', 'studiosOptions', 'studiosImage', 'studiosVideo', 'studiosCharacter', 'studiosRecast', 'studiosRequest',
    'mediaDeleteChallenge', 'deleteMedia', 'studiosApprovals', 'getMyAvatar',
  ];
  originalApi = Object.fromEntries(names.map((n) => [n, m[n]]));
  const challenge = (label: string) => ({ nonce: 'N'.repeat(44), expiresAt: new Date().toISOString(), messageToSign: label, walletPubkey: LINKED });
  m.me = async () => ({ user: { id: 'user-1', isGuest: false } });
  m.getSpendPolicy = async () => policyView();
  m.spendPolicyChallenge = async (body: unknown) => {
    log.push({ fn: 'policy-challenge', arg: body });
    return challenge('ClawVille spend rules');
  };
  m.putSpendPolicy = async (body: Record<string, unknown>) => {
    log.push({ fn: 'policy-put', arg: body });
    payModeSaved = body.studiosPayMode as typeof payModeSaved;
    return policyView();
  };
  m.studiosKeyStatus = async () => ({ linked: keyLinked, last4: keyLinked ? 'ab12' : null, updatedAt: null });
  m.studiosOAuthStatus = async () => ({ ...oauth, scope: null, linkedAt: null });
  m.studiosOAuthChallenge = async (action: string) => {
    log.push({ fn: 'oauth-challenge', arg: action });
    return challenge(`ClawVille Studios ${action}`);
  };
  m.studiosOAuthStart = async (proof: unknown) => {
    log.push({ fn: 'oauth-start', arg: proof });
    return { authorizeUrl };
  };
  m.studiosOAuthUnlink = async (proof: unknown) => {
    log.push({ fn: 'oauth-unlink', arg: proof });
    oauth = { linked: false, status: null };
    return { linked: false, status: null, scope: null, linkedAt: null };
  };
  m.studiosSigninAccount = async () => {
    log.push({ fn: 'account', arg: null });
    return { balanceUsd: 4.5, freeUsageLeft: null, connectionSpendLeftUsd: 1, readable: true };
  };
  m.studiosSigninMedia = async () => ({ items: [{ id: 'sm_1', kind: 'video', state: 'ready', createdAt: '2026-11-06T10:00:00Z' }], nextCursor: null });
  m.studiosImages = async () => ({
    images: [
      { id: MEDIA_IMG, mediaPath: `/api/media/${MEDIA_IMG}`, mimeType: 'image/png', prompt: '<b>crab</b>', mode: 'wallet', actor: 'agent', createdAt: '2026-11-06T09:00:00Z' },
      { id: MEDIA_VID, mediaPath: `/api/media/${MEDIA_VID}`, mimeType: 'video/mp4', prompt: 'dance', mode: 'account', actor: 'human', createdAt: '2026-11-06T09:30:00Z' },
    ],
  });
  m.studiosOptions = async (menu: string) => MENUS[menu];
  const post = (fn: string) => async (body: unknown, key: string) => {
    log.push({ fn, arg: { body, key } });
    return postAnswer();
  };
  m.studiosImage = post('image');
  m.studiosVideo = post('video');
  m.studiosCharacter = post('character');
  m.studiosRecast = post('recast');
  m.studiosRequest = async (id: string) => {
    log.push({ fn: 'poll', arg: id });
    return requestView ?? { requestId: id, operation: 'video', status: 'running', mode: 'wallet', mediaPath: null, media: [], code: null };
  };
  m.mediaDeleteChallenge = async (id: string) => {
    log.push({ fn: 'delete-challenge', arg: id });
    return challenge(`ClawVille delete ${id}`);
  };
  m.deleteMedia = async (id: string, proof: unknown) => {
    log.push({ fn: 'delete', arg: { id, proof } });
    return { deleted: true, mediaId: id };
  };
  m.studiosApprovals = async () => ({ approvals: [] });
  m.getMyAvatar = async () => ({ avatar: { id: 'avatar-1', name: 'Crab' } });
});

beforeEach(() => {
  payModeSaved = null;
  keyLinked = false;
  oauth = { linked: false, status: null };
  requestView = null;
  postAnswer = async () => ({ status: 'running', requestId: REQ, message: 'x' });
  authorizeUrl = 'https://mystudios.fun/connect/authorize?state=s';
  log.length = 0;
  signed.length = 0;
  navigated.length = 0;
  (testWindow as unknown as { solana?: unknown }).solana = fakeWallet;
  useGameStore.setState({ walletLinkModalOpen: false });
  payMode.useStudiosReturnStore.getState().clear();
  testWindow.sessionStorage.clear();
  store.resetStudiosRequestStoreForTests();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

afterAll(() => {
  Object.assign(api as unknown as Record<string, unknown>, originalApi);
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: ReactElement): Promise<void> {
  container = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: client! }, element));
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return [...(container?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
}

function button(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
  return found;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new testWindow.MouseEvent('click', { bubbles: true }) as unknown as Event);
  });
  await settle();
}

async function openSection(title: string): Promise<void> {
  const header = buttons().find((b) => b.getAttribute('aria-expanded') !== null && b.textContent?.startsWith(title));
  if (!header) throw new Error(`no section "${title}"`);
  if (header.getAttribute('aria-expanded') !== 'true') await click(header);
}

/** Type into a React-controlled field (the native setter, then the event React listens to). */
async function type(el: Element, value: string): Promise<void> {
  const proto = el.tagName === 'TEXTAREA' ? testWindow.HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? testWindow.HTMLSelectElement.prototype
      : testWindow.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new testWindow.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }) as unknown as Event);
  });
  await settle();
}

function field(labelText: string): Element {
  const label = [...(container?.querySelectorAll('label') ?? [])].find((l) => l.textContent?.startsWith(labelText));
  const el = label?.querySelector('textarea, select, input');
  if (!el) throw new Error(`no field "${labelText}"`);
  return el;
}

function calls(fn: string) {
  return log.filter((l) => l.fn === fn);
}

describe('pay mode', () => {
  test('shows the three choices and what each can do', async () => {
    await mount(createElement(card.StudiosCard));
    await openSection('How Studios is paid');
    const text = container?.querySelector('[data-testid="pay-mode"]')?.textContent ?? '';
    expect(text).toContain('My agent wallet (USDC)');
    expect(text).toContain('Images and videos.');
    expect(text).toContain('My Studios API key');
    expect(text).toContain('Everything: images, videos, character shots and recast.');
    expect(text).toContain('My Studios sign-in');
    expect(text).toContain('your Studios media and balance');
  });

  test('saving asks the linked wallet to sign the exact values, then PUTs them with the proof', async () => {
    oauth = { linked: true, status: 'active' };
    await mount(createElement(card.StudiosCard));
    await openSection('How Studios is paid');
    const radio = [...(container?.querySelectorAll('input[type="radio"]') ?? [])][2]!;
    await click(radio);
    await click(button('Save who pays'));
    expect(log.filter((l) => l.fn.startsWith('policy')).map((l) => l.fn)).toEqual(['policy-challenge', 'policy-put']);
    const sent = calls('policy-challenge')[0]!.arg as Record<string, unknown>;
    const put = calls('policy-put')[0]!.arg as Record<string, unknown>;
    expect(sent).toEqual({ dailyCapUsdCents: 100, perCallCapUsdCents: 25, allowedVendors: ['studios'], studiosKeyImagesPerDay: 10, requireApproval: false, studiosPayMode: 'signin' });
    const { proof, ...values } = put;
    expect(values).toEqual(sent);
    expect(proof).toMatchObject({ nonce: 'N'.repeat(44) });
    expect(signed).toEqual(['ClawVille spend rules']);
    expect(container?.textContent).toContain('Saved.');
  });

  test('a refusal shows plain words, never the code', async () => {
    (api as unknown as Record<string, unknown>).spendPolicyChallenge = async () => {
      throw new ApiError('spend_policy_needs_wallet_link', 403, 'spend_policy_needs_wallet_link');
    };
    try {
      await mount(createElement(card.StudiosCard));
      await openSection('How Studios is paid');
      await click([...(container?.querySelectorAll('input[type="radio"]') ?? [])][1]!);
      await click(button('Save who pays'));
      expect(container?.textContent).toContain('Link your own wallet first');
      expect(container?.textContent).not.toContain('spend_policy_needs_wallet_link');
      expect(calls('policy-put')).toEqual([]);
    } finally {
      (api as unknown as Record<string, unknown>).spendPolicyChallenge = async (body: unknown) => {
        log.push({ fn: 'policy-challenge', arg: body });
        return { nonce: 'N'.repeat(44), expiresAt: '', messageToSign: 'ClawVille spend rules', walletPubkey: LINKED };
      };
    }
  });

  test('warns when the chosen payer is not ready', () => {
    expect(payMode.payModeWarning('key', { linked: false }, undefined)).toContain('No Studios key is saved');
    expect(payMode.payModeWarning('signin', undefined, { linked: false, status: null })).toContain('not signed in with Studios');
    expect(payMode.payModeWarning('signin', undefined, { linked: true, status: 'broken' })).toContain('Sign in again');
    expect(payMode.payModeWarning('wallet', undefined, undefined)).toBeNull();
  });
});

describe('Studios sign-in', () => {
  test('signs the link challenge, starts, then sends this tab to the Studios page', async () => {
    await mount(createElement(card.StudiosCard));
    await openSection('How Studios is paid');
    await click(button('Sign in with Studios'));
    expect(log.map((l) => l.fn)).toEqual(['oauth-challenge', 'oauth-start']);
    expect(calls('oauth-challenge')[0]!.arg).toBe('link');
    expect(calls('oauth-start')[0]!.arg).toMatchObject({ nonce: 'N'.repeat(44) });
    expect(signed).toEqual(['ClawVille Studios link']);
    expect(navigated).toEqual(['https://mystudios.fun/connect/authorize?state=s']);
  });

  test('never moves the tab to a page that is not on Studios', async () => {
    authorizeUrl = 'https://evil.example/connect/authorize';
    await mount(createElement(card.StudiosCard));
    await openSection('How Studios is paid');
    await click(button('Sign in with Studios'));
    expect(navigated).toEqual([]);
    expect(container?.textContent).toContain('The Studios sign-in is not available now.');
  });

  test('signed in: shows the balance and the spend left today, and sign-out signs an unlink', async () => {
    oauth = { linked: true, status: 'active' };
    await mount(createElement(card.StudiosCard));
    await openSection('How Studios is paid');
    const account = container?.querySelector('[data-testid="studios-account"]')?.textContent ?? '';
    expect(account).toContain('$4.50');
    expect(account).toContain('Studios did not say');
    expect(account).toContain('$1.00');
    await click(button('Sign out of Studios'));
    expect(calls('oauth-challenge').map((l) => l.arg)).toEqual(['unlink']);
    expect(calls('oauth-unlink')[0]!.arg).toMatchObject({ nonce: 'N'.repeat(44) });
    expect(button('Sign in with Studios')).toBeTruthy();
  });

  test('a broken link shows "Sign in again" and reads no balance', async () => {
    oauth = { linked: true, status: 'broken' };
    await mount(createElement(card.StudiosCard));
    await openSection('How Studios is paid');
    expect(button('Sign in again')).toBeTruthy();
    expect(calls('account')).toEqual([]);
  });

  test('the tab moves only to the https Studios sign-in page with no user info', () => {
    expect(payMode.checkedAuthorizeUrl('https://mystudios.fun/connect/authorize?state=s')).toBe('https://mystudios.fun/connect/authorize?state=s');
    for (const bad of [
      'https://mystudios.fun/other?state=s',
      'https://mystudios.fun/connect/authorize/x',
      'https://user:pass@mystudios.fun/connect/authorize',
      'https://user@mystudios.fun/connect/authorize',
      'http://mystudios.fun/connect/authorize',
      'https://mystudios.fun.evil.example/connect/authorize',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(() => payMode.checkedAuthorizeUrl(bad)).toThrow();
    }
  });

  test('every return reason has its own plain message; an unknown one has a safe default', () => {
    const reasons = [
      'invalid_request', 'invalid_state', 'state_used', 'state_expired', 'wrong_user', 'wrong_issuer', 'denied',
      'avatar_changed', 'cancelled', 'exchange_failed', 'unavailable', 'needs_login', 'human_only', 'guest', 'rate_limited',
    ];
    const texts = reasons.map((reason) => {
      const message = payMode.studiosReturnMessage('error', reason)!;
      expect(message.ok).toBe(false);
      expect(message.text).not.toMatch(/[a-z]+_[a-z_]+/);
      return message.text;
    });
    expect(new Set(texts).size).toBe(reasons.length);
    expect(payMode.studiosReturnMessage('error', '<script>')!.text).toBe('The Studios sign-in did not finish. Nothing changed. Try again.');
    expect(payMode.studiosReturnMessage('error', 'constructor')!.text).toBe('The Studios sign-in did not finish. Nothing changed. Try again.');
    expect(payMode.studiosReturnMessage('linked', null)).toMatchObject({ ok: true });
    expect(payMode.studiosReturnMessage(null, null)).toBeNull();
  });

  test('on return to /game: opens the wallet panel, shows the message, removes only the Studios parameters', async () => {
    testWindow.history.replaceState({}, '', '/game?keep=1&studios=error&reason=denied');
    await mount(createElement(payMode.StudiosReturnHandler));
    expect(testWindow.location.search).toBe('?keep=1');
    expect(useGameStore.getState().walletLinkModalOpen).toBe(true);
    expect(payMode.useStudiosReturnStore.getState().message).toEqual({ ok: false, text: 'You did not allow ClawVille on Studios. Nothing changed.' });
    testWindow.history.replaceState({}, '', '/game');
  });
});

describe('forms', () => {
  test('wallet mode: character shots and recast say why they are off, and offer no button', async () => {
    payModeSaved = 'wallet';
    await mount(createElement(card.StudiosCard));
    await openSection('Character shots');
    await openSection('Recast');
    expect(container?.textContent).toContain('Studios takes no wallet payment for character shots or recast');
    expect(buttons().some((b) => b.textContent === 'Make character shots' || b.textContent === 'Make recast clip')).toBe(false);
    // Video stays open to the wallet, with the per-call cap.
    await openSection('Video');
    expect(container?.textContent).toContain('Your per-call cap is $0.25');
  });

  test('video: filtered menu values, the price line, then 202 running keeps the button off and reads the request', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    await mount(createElement(card.StudiosCard));
    await openSection('Video');
    const resolutions = [...field('Resolution').querySelectorAll('option')].map((o) => o.textContent);
    expect(resolutions).toEqual(['Studios default', '768p']);
    expect([...field('Aspect ratio').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Studios default', '16:9']);
    expect(container?.textContent).toContain('text to video: $0.040 per unit (sound possible)');
    await type(field('Describe the video'), 'a crab dancing');
    await type(field('Start image'), `/api/media/${MEDIA_IMG}`);
    await click(button('Make video'));
    const first = calls('video')[0]!.arg as { body: Record<string, unknown>; key: string };
    expect(first.body).toMatchObject({ prompt: 'a crab dancing', model: 'minimax-h3-max-turbo', durationSeconds: 5, audio: false });
    expect(String(first.body.imageUrl)).toMatch(new RegExp(`/api/media/${MEDIA_IMG}$`));
    expect(button('Running...').disabled).toBe(true);
    // The request is read at once; the 4 s interval itself is checked in "pure helpers"
    // (happy-dom loads query-core with no window, so TanStack timers never start here).
    expect(calls('poll').map((l) => l.arg)).toEqual([REQ]);
    // A second click while it runs sends nothing.
    await click(button('Running...'));
    expect(calls('video').length).toBe(1);
    // It ends: the video shows with controls and no autoplay; the next send gets a new key.
    requestView = { requestId: REQ, operation: 'video', status: 'done', mode: 'account', mediaPath: `/api/media/${MEDIA_VID}`, media: [{ slot: 'video', mediaId: MEDIA_VID, mediaPath: `/api/media/${MEDIA_VID}` }], code: null };
    await act(async () => {
      await client!.refetchQueries({ queryKey: ['studios-request', REQ] });
    });
    await settle();
    expect(container?.textContent).toContain('Made with your Studios account.');
    const shown = [...(container?.querySelectorAll('video') ?? [])].find((v) => v.getAttribute('src')?.endsWith(MEDIA_VID));
    expect(shown?.getAttribute('preload')).toBe('none');
    expect(shown?.hasAttribute('autoplay')).toBe(false);
    postAnswer = async () => {
      throw new Error('network');
    };
    await click(button('Make video'));
    const second = calls('video')[1]!.arg as { key: string };
    expect(second.key).not.toBe(first.key);
  });

  test('each form: a lost reply keeps the key for the same input; a changed input gets a new key', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    postAnswer = async () => {
      throw new Error('network');
    };
    await mount(createElement(card.StudiosCard));

    await openSection('Image');
    await type(field('Describe the image'), 'a crab');
    await click(button('Make image'));
    await click(button('Make image'));
    await type(field('Describe the image'), 'a fish');
    await click(button('Make image'));
    const image = calls('image').map((l) => (l.arg as { key: string }).key);
    expect(image[0]).toBe(image[1]);
    expect(image[2]).not.toBe(image[0]);

    await openSection('Character shots');
    await type(field('Describe the character'), 'a knight');
    await click(button('Make character shots'));
    await click(button('Make character shots'));
    await type(field('Style'), '3d-mascot');
    await click(button('Make character shots'));
    const chars = calls('character').map((l) => l.arg as { key: string; body: Record<string, unknown> });
    expect(chars[0]!.body).toEqual({ shots: ['sheet'], prompt: 'a knight' });
    expect(chars[0]!.key).toBe(chars[1]!.key);
    expect(chars[2]!.body).toEqual({ shots: ['sheet'], prompt: 'a knight', style: '3d-mascot' });
    expect(chars[2]!.key).not.toBe(chars[0]!.key);

    await openSection('Recast');
    await type(field('Preset'), 'duo-dance');
    expect(container?.querySelector('[data-testid="recast-price"]')?.textContent).toBe('Price: $2.40 of your Studios credits.');
    await type(field('Resolution'), '480p');
    expect(container?.querySelector('[data-testid="recast-price"]')?.textContent).toBe('Price: $1.17 of your Studios credits.');
    expect(button('Make recast clip').disabled).toBe(true);
    await type(field('Photo of performer 1'), `/api/media/${MEDIA_IMG}`);
    expect(button('Make recast clip').disabled).toBe(true);
    await type(field('Photo of performer 2'), `/api/media/${MEDIA_IMG}`);
    await click(button('Make recast clip'));
    await click(button('Make recast clip'));
    await type(field('Direction'), 'wave');
    await click(button('Make recast clip'));
    const recasts = calls('recast').map((l) => l.arg as { key: string; body: Record<string, unknown> });
    expect(recasts[0]!.body).toMatchObject({ preset: 'duo-dance', resolution: '480p' });
    expect((recasts[0]!.body.imageUrls as string[]).length).toBe(2);
    expect(recasts[0]!.key).toBe(recasts[1]!.key);
    expect(recasts[2]!.key).not.toBe(recasts[0]!.key);
    // The video in the recast list is never offered as a photo.
    expect([...field('Photo of performer 1').querySelectorAll('option')].length).toBe(2);
  });

  test('an outcome that may have charged blocks the same input', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    await mount(createElement(card.StudiosCard));
    await openSection('Video');
    await type(field('Describe the video'), 'a crab');
    requestView = { requestId: REQ, operation: 'video', status: 'failed', mode: 'account', mediaPath: null, media: [], code: 'outcome_unknown' };
    await click(button('Make video'));
    await settle();
    expect(container?.textContent).toContain('may have charged');
    expect(button('Change the input to make a new request').disabled).toBe(true);
  });
});

describe('open requests outlive the wallet modal', () => {
  async function remount(): Promise<void> {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    await mount(createElement(card.StudiosCard));
  }

  test('after a 202, closing and reopening keeps the key and the request id; the request is read again and nothing is sent twice', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    await mount(createElement(card.StudiosCard));
    await openSection('Video');
    await type(field('Describe the video'), 'a crab');
    await click(button('Make video'));
    const first = calls('video')[0]!.arg as { key: string };
    const saved = store.readStudiosSlot(store.useStudiosRequestStore.getState().slots, 'avatar-1:video').pending;
    expect(saved).toMatchObject({ key: first.key, requestId: REQ });

    log.length = 0;
    await remount();
    // The section is open again on its own, says it runs, and reads the request.
    expect(button('Running...').disabled).toBe(true);
    expect(container?.textContent).toContain('Studios is working on it.');
    expect(calls('poll').map((l) => l.arg)).toEqual([REQ]);
    await click(button('Running...'));
    expect(calls('video')).toEqual([]);

    // A reload of the tab (memory gone): sessionStorage brings it back.
    store.resetStudiosRequestStoreForTests();
    log.length = 0;
    await remount();
    expect(button('Running...').disabled).toBe(true);
    expect(calls('poll').map((l) => l.arg)).toEqual([REQ]);

    // It ends: the slot is cleared, and a new send gets a new key.
    requestView = { requestId: REQ, operation: 'video', status: 'done', mode: 'account', mediaPath: `/api/media/${MEDIA_VID}`, media: [], code: null };
    await act(async () => {
      await client!.refetchQueries({ queryKey: ['studios-request', REQ] });
    });
    await settle();
    expect(store.readStudiosSlot(store.useStudiosRequestStore.getState().slots, 'avatar-1:video').pending).toBeNull();
    expect(testWindow.sessionStorage.getItem(store.STUDIOS_REQUESTS_STORAGE_KEY)).toBeNull();
  });

  test('a lost reply, then close and reopen: the same input reuses the same key', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    postAnswer = async () => {
      throw new Error('network');
    };
    await mount(createElement(card.StudiosCard));
    await openSection('Image');
    await type(field('Describe the image'), 'a crab');
    await click(button('Make image'));
    await remount();
    await openSection('Image');
    await type(field('Describe the image'), 'a crab');
    await click(button('Make image'));
    const keys = calls('image').map((l) => (l.arg as { key: string }).key);
    expect(keys.length).toBe(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test('an outcome that may have charged stays blocked after reopening', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    requestView = { requestId: REQ, operation: 'video', status: 'failed', mode: 'account', mediaPath: null, media: [], code: 'outcome_unknown' };
    await mount(createElement(card.StudiosCard));
    await openSection('Video');
    await type(field('Describe the video'), 'a crab');
    await click(button('Make video'));
    await settle();
    await remount();
    await openSection('Video');
    await type(field('Describe the video'), 'a crab');
    expect(button('Change the input to make a new request').disabled).toBe(true);
  });

  const OTHER = '44444444-2222-4333-8444-555555555555';
  const slotOf = (op: string) => store.readStudiosSlot(store.useStudiosRequestStore.getState().slots, `avatar-1:${op}`).pending;
  const dup = (requestId: string, status: string) => new ApiError('duplicate_request_in_flight', 409, 'duplicate_request_in_flight', { requestId, requestStatus: status });

  test('every form: a 409 duplicate_request_in_flight attaches to the first request and reads it, as a status, not an error', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    postAnswer = async () => {
      throw dup(OTHER, 'running');
    };
    await mount(createElement(card.StudiosCard));
    const cases: Array<{ section: string; op: string; fill: () => Promise<void>; label: string }> = [
      { section: 'Image', op: 'image', label: 'Make image', fill: () => type(field('Describe the image'), 'a crab') },
      { section: 'Video', op: 'video', label: 'Make video', fill: () => type(field('Describe the video'), 'a crab') },
      { section: 'Character shots', op: 'character_shots', label: 'Make character shots', fill: () => type(field('Describe the character'), 'a knight') },
      {
        section: 'Recast', op: 'recast', label: 'Make recast clip', fill: async () => {
          await type(field('Preset'), 'duo-dance');
          await type(field('Photo of performer 1'), `/api/media/${MEDIA_IMG}`);
          await type(field('Photo of performer 2'), `/api/media/${MEDIA_IMG}`);
        },
      },
    ];
    for (const c of cases) {
      await openSection(c.section);
      await c.fill();
      log.length = 0;
      await click(button(c.label));
      expect(slotOf(c.op)?.requestId).toBe(OTHER);
      expect(calls('poll').map((l) => l.arg)).toContain(OTHER);
    }
    const lines = [...(container?.querySelectorAll('p') ?? [])].filter((p) => p.textContent === 'This request is already running. The result shows here when it is ready.');
    expect(lines.length).toBe(4);
    for (const line of lines) expect(line.className).not.toContain('text-red');
    expect(buttons().filter((b) => b.textContent === 'Running...').length).toBe(4);
  });

  test('a 409 for a request that waits for approval says so', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    postAnswer = async () => {
      throw dup(OTHER, 'awaiting_approval');
    };
    requestView = { requestId: OTHER, operation: 'image', status: 'awaiting_approval', mode: 'account', mediaPath: null, media: [], code: null };
    await mount(createElement(card.StudiosCard));
    await openSection('Image');
    await type(field('Describe the image'), 'a crab');
    await click(button('Make image'));
    expect(container?.textContent).toContain('this request waits in Approvals above');
    expect(button('Waiting for your approval...').disabled).toBe(true);
  });

  test('a replay that answers approval_expired or approval_declined clears the key', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    for (const code of ['approval_expired', 'approval_declined']) {
      store.resetStudiosRequestStoreForTests();
      testWindow.sessionStorage.clear();
      log.length = 0;
      postAnswer = async () => {
        throw new Error('network');
      };
      await mount(createElement(card.StudiosCard));
      await openSection('Image');
      await type(field('Describe the image'), 'a crab');
      await click(button('Make image'));
      const kept = slotOf('image')?.key;
      expect(kept).toBeTruthy();
      postAnswer = async () => {
        throw new ApiError(code, 409, code);
      };
      await click(button('Make image'));
      expect((calls('image')[1]!.arg as { key: string }).key).toBe(kept!);
      expect(slotOf('image')).toBeNull();
      postAnswer = async () => {
        throw new Error('network');
      };
      await click(button('Make image'));
      expect((calls('image')[2]!.arg as { key: string }).key).not.toBe(kept!);
      await act(async () => root?.unmount());
      container?.remove();
      root = null;
    }
  });

  test('a second tab (its own store) with the same input attaches through the 409', async () => {
    payModeSaved = 'key';
    keyLinked = true;
    await mount(createElement(card.StudiosCard));
    await openSection('Video');
    await type(field('Describe the video'), 'a crab');
    await click(button('Make video'));
    const firstKey = (calls('video')[0]!.arg as { key: string }).key;
    expect(slotOf('video')?.requestId).toBe(REQ);
    await act(async () => root?.unmount());
    container?.remove();
    root = null;

    // The other tab: empty memory, empty sessionStorage; the server knows the input.
    store.resetStudiosRequestStoreForTests();
    testWindow.sessionStorage.clear();
    log.length = 0;
    postAnswer = async () => {
      throw dup(REQ, 'running');
    };
    await mount(createElement(card.StudiosCard));
    await openSection('Video');
    await type(field('Describe the video'), 'a crab');
    await click(button('Make video'));
    const secondKey = (calls('video')[0]!.arg as { key: string }).key;
    expect(secondKey).not.toBe(firstKey);
    expect(slotOf('video')?.requestId).toBe(REQ);
    expect(calls('poll').map((l) => l.arg)).toEqual([REQ]);
    expect(button('Running...').disabled).toBe(true);
    expect(container?.textContent).toContain('This request is already running.');
  });

  test('a sessionStorage that throws: the flow still works in memory', async () => {
    const throwing = { get: () => { throw new Error('denied'); }, configurable: true };
    Object.defineProperty(testWindow, 'sessionStorage', throwing);
    try {
      payModeSaved = 'key';
      keyLinked = true;
      await mount(createElement(card.StudiosCard));
      await openSection('Video');
      await type(field('Describe the video'), 'a crab');
      await click(button('Make video'));
      expect(button('Running...').disabled).toBe(true);
      await remount();
      expect(button('Running...').disabled).toBe(true);
      expect(calls('video').length).toBe(1);
    } finally {
      Reflect.deleteProperty(testWindow, 'sessionStorage');
    }
    expect(() => testWindow.sessionStorage.getItem('x')).not.toThrow();
  });
});

describe('media gallery', () => {
  test('a video has controls, loads nothing first and never plays by itself; prompts are plain text', async () => {
    await mount(createElement(media.StudiosMediaGallery));
    const video = container?.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(video?.getAttribute('preload')).toBe('none');
    expect(video?.hasAttribute('autoplay')).toBe(false);
    expect(video?.getAttribute('src')).toContain(`/api/media/${MEDIA_VID}`);
    expect(container?.querySelector('b')).toBeNull();
    expect(container?.textContent).toContain('<b>crab</b>');
  });

  test('delete asks for the challenge, the linked wallet signs, then DELETE carries the proof', async () => {
    await mount(createElement(media.StudiosMediaGallery));
    await click(buttons().filter((b) => b.textContent === 'Delete')[0]!);
    expect(log.map((l) => l.fn)).toEqual(['delete-challenge', 'delete']);
    expect(signed).toEqual([`ClawVille delete ${MEDIA_IMG}`]);
    expect(calls('delete')[0]!.arg).toMatchObject({ id: MEDIA_IMG, proof: { nonce: 'N'.repeat(44) } });
    expect(((calls('delete')[0]!.arg as { proof: { signature: string } }).proof.signature.length)).toBeGreaterThan(80);
  });

  test('with no browser wallet, delete sends nothing and says why', async () => {
    (testWindow as unknown as { solana?: unknown }).solana = undefined;
    await mount(createElement(media.StudiosMediaGallery));
    await click(buttons().filter((b) => b.textContent === 'Delete')[0]!);
    expect(calls('delete')).toEqual([]);
    expect(container?.textContent).toContain('No Solana wallet detected');
  });

  test('My Studios media loads on press and shows id, kind and state only', async () => {
    oauth = { linked: true, status: 'active' };
    await mount(createElement(card.StudiosCard));
    await openSection('My Studios media');
    await click(button('Show my Studios media'));
    const text = container?.querySelector('[data-testid="studios-signin-media"]')?.textContent ?? '';
    expect(text).toContain('sm_1');
    expect(text).toContain('Video, ready, 2026-11-06');
  });

  test('every button in the card is at least 44px tall', async () => {
    oauth = { linked: true, status: 'active' };
    await mount(createElement(card.StudiosCard));
    for (const title of ['How Studios is paid', 'Image', 'Video', 'Character shots', 'Recast', 'Your media', 'My Studios media']) await openSection(title);
    for (const b of buttons()) expect(b.className).toContain('min-h-[44px]');
    for (const s of container?.querySelectorAll('select') ?? []) expect(s.className).toContain('min-h-[44px]');
  });
});

describe('Spending card: Studios numbers per day', () => {
  test('raising videos per day asks the linked wallet to sign; lowering saves at once', async () => {
    const { SpendingCard } = await import('./spending-card');
    await mount(createElement(SpendingCard));
    await type(field('Videos per day'), '3');
    await click(button('Save spend rules'));
    expect(log.map((l) => l.fn)).toEqual(['policy-challenge', 'policy-put']);
    expect(calls('policy-challenge')[0]!.arg).toMatchObject({ studiosVideosPerDay: 3, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1 });
    expect(calls('policy-put')[0]!.arg).not.toHaveProperty('studiosPayMode');
    log.length = 0;
    await type(field('Recasts per day'), '0');
    await type(field('Videos per day'), '2');
    await click(button('Save spend rules'));
    expect(log.map((l) => l.fn)).toEqual(['policy-put']);
    expect(calls('policy-put')[0]!.arg).toMatchObject({ studiosVideosPerDay: 2, studiosRecastsPerDay: 0 });
  });
});

describe('Approvals card reads well for every operation', () => {
  test('a recast with no text names its preset; a video names its model', async () => {
    const approvals = await import('./approvals-card');
    const base = { vendor: 'studios', mode: 'account', surface: 'api', maxUsdCents: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    (api as unknown as Record<string, unknown>).studiosApprovals = async () => ({
      approvals: [
        { ...base, requestId: 'r1', operation: 'recast', prompt: '', model: 'duo-dance' },
        { ...base, requestId: 'r2', operation: 'video', prompt: 'a crab', model: 'minimax-h3-max-turbo' },
        { ...base, requestId: 'r3', operation: 'character_shots', prompt: '', model: null },
      ],
    });
    try {
      await mount(createElement(approvals.ApprovalsCard));
      const items = [...(container?.querySelectorAll('[data-testid="approval-item"]') ?? [])].map((el) => el.textContent ?? '');
      expect(items[0]).toContain('a Studios recast clip');
      expect(items[0]).toContain('No text. Only the settings.');
      expect(items[0]).toContain('Preset: duo-dance');
      expect(items[1]).toContain('Model: minimax-h3-max-turbo');
      expect(items[2]).toContain('Studios character shots');
      expect(items[2]).toContain('No text. Only the settings.');
    } finally {
      (api as unknown as Record<string, unknown>).studiosApprovals = async () => ({ approvals: [] });
    }
  });
});

describe('pure helpers', () => {
  test('an open request is read every 4 s until it ends', () => {
    const view = (status: string) => ({ requestId: REQ, operation: 'video', status, mode: 'wallet', mediaPath: null, media: [], code: null }) as never;
    for (const status of ['awaiting_approval', 'pending', 'running']) expect(card.studiosPollInterval(view(status))).toBe(4000);
    expect(card.studiosPollInterval(undefined)).toBe(4000);
    for (const status of ['done', 'failed', 'ambiguous', 'declined', 'expired']) expect(card.studiosPollInterval(view(status))).toBe(false);
  });

  test('durations, recast price and performer count', () => {
    expect(forms.durationChoices({ min: 5, max: 10, step: 5 })).toEqual([5, 10]);
    expect(forms.durationChoices({ min: 0, max: 99, step: 1 }).at(-1)).toBe(30);
    const preset = { id: 'p', performers: 6, priceUsd: 2, defaultResolution: '720p', resolutions: [{ id: '720p', priceUsd: 2.5 }, { id: '4k', priceUsd: 9 }] };
    expect(forms.performerCount(preset)).toBe(4);
    expect(forms.recastPriceUsd(preset, '')).toBe(2.5);
    expect(forms.presetResolutions(preset).map((r) => r.id)).toEqual(['720p']);
    expect(forms.buildCharacterBody({ shots: [], prompt: ' ', random: false, style: '', imagePath: '' }, (p) => p)).toBeNull();
  });
});
