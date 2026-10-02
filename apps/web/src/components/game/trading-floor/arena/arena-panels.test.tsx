import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_TEMPLATES,
} from '@clawville/shared';

import { readContest, readEvent, readPosition } from '@/hooks/use-floor-arena';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { useGameStore } from '@/stores/game';
import { FLOOR_TEXT } from '../tokens';
import {
  addonChoicesValid,
  addonMaxCostPerDay,
  enabledCapTotal,
} from './addon-picker';
import {
  compactUsd,
  contestPhase,
  contestStandingsCopy,
  countLabel,
  errorsByPath,
  exitTargets,
  formatCountdown,
  formatDuration,
  formatParamValue,
  paramPathLabel,
  positionExits,
  signedUsd,
} from './arena-format';
import { ADDON_WALLET_WARNING, ARENA_WALLET_FUNDING_NOTE } from './addon-picker';
import { ARENA_GUEST_UPSELL } from './arena-kit';
import { ArenaClosedTrades, arenaEventTone, unresolvedContestLoss } from './arena-parts';
import { addonUnderfunded, deskStatus } from './my-trader';

// Same DOM harness as floor-components.test.tsx: bun has no global DOM.
const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'HTMLAnchorElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let FloorArenaSection: typeof import('./arena-section').FloorArenaSection;
let TradingFloorTab: typeof import('../trading-floor-tab').TradingFloorTab;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
let meBody: Record<string, unknown> = { agent: null };
let profileBody: Record<string, unknown> = {};
let houseAgentsBody: unknown[] = [];
let addonsBody: Record<string, unknown> = { addons: [], paymentsEnabled: false };
let contestBody: Record<string, unknown> = {};
/** Answers for GET /discovery, in order; an empty queue answers an empty feed. */
let discoveryResponses: Array<{ status: number; body: unknown }> = [];
let requests: string[] = [];

function installDom(): void {
  previousDescriptors = new Map(installedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: testWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: testWindow.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: testWindow.navigator });
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: testWindow[name as keyof typeof testWindow],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function reactProps(element: Element): {
  onClick?: () => void;
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
} {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
  expect(key).toBeDefined();
  return (element as unknown as Record<string, ReturnType<typeof reactProps>>)[key!]!;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    reactProps(element).onClick?.();
  });
  await flush();
}

async function render(props: { isGuest?: boolean; onGuestBlocked?: () => void } = {}): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: client! },
        createElement(FloorArenaSection, {
          active: true,
          isGuest: props.isGuest ?? false,
          onGuestBlocked: props.onGuestBlocked ?? (() => undefined),
        }),
      ),
    );
  });
  await flush();
  return container;
}

function myAgentBody(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      id: '11111111-2222-4333-8444-555555555555',
      kind: 'user',
      name: 'My Genesis',
      templateId: 'genesis',
      params: FLOOR_ARENA_TEMPLATES[0]!.params,
      paramsVersion: 1,
      mode: 'paper',
      status: 'active',
      seated: false,
      seatIndex: null,
      paymentAddress: null,
      provisionState: 'pending',
      addons: [],
      autoApplySuggestions: false,
      ...overrides,
    },
    paymentAddress: null,
    provision: { state: 'pending', error: null },
    wallet: null,
    addons: [],
    stats: null,
    latestReport: null,
  };
}

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ FloorArenaSection } = await import('./arena-section'));
  ({ TradingFloorTab } = await import('../trading-floor-tab'));
});

beforeEach(() => {
  requests = [];
  meBody = { agent: null };
  houseAgentsBody = [];
  addonsBody = { addons: [], paymentsEnabled: false };
  contestBody = {};
  discoveryResponses = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/discovery')) {
        const next = discoveryResponses.shift() ?? { status: 200, body: { mints: [] } };
        return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
      }
      let body: unknown = {};
      if (url.includes('/me')) body = meBody;
      else if (url.includes('/leaderboard')) body = { rows: [] };
      else if (url.includes('/templates')) body = { houseAgents: houseAgentsBody };
      else if (url.includes('/addons')) body = addonsBody;
      else if (url.includes('/contest')) body = contestBody;
      else if (url.includes('/events')) body = { events: [] };
      else if (url.includes('/agents/')) body = profileBody;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  useFloorArenaUi.setState({
    panel: 'overview',
    profileAgentId: null,
    launchTemplateId: null,
    localSeatIndex: -1,
    myAgent: 'unknown',
    seatWriteVersion: 0,
    launched: null,
  });
  useGameStore.setState({ exchangeOpen: false, exchangeTab: 'browse' });
});

afterEach(async () => {
  await act(async () => {
    await client?.cancelQueries();
    client?.clear();
  });
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client = null;
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('Arena overview', () => {
  test('shows the contest, its three prizes, the paper pill and all five templates', async () => {
    const host = await render();
    const text = host.textContent ?? '';
    expect(text).toContain(FLOOR_ARENA_CONTEST.name);
    expect(text).toContain('Paper trading only');
    expect(text).toContain('1,000,000 $CLAWVILLE');
    expect(text).toContain('500,000 $CLAWVILLE');
    expect(text).toContain('250,000 $CLAWVILLE');
    for (const template of FLOOR_ARENA_TEMPLATES) {
      expect(host.querySelector(`[data-testid="arena-template-${template.id}"]`)).not.toBeNull();
      expect(text).toContain(template.tagline);
    }
    expect(buttonByText(host, 'Launch your trader')).toBeDefined();
  });

  test('template card counts are singular for 1 and plural otherwise', async () => {
    const stats = (trades: number, wins: number, losses: number) => ({
      realisedUsd: 0.4, trades, wins, losses, deaths: 0, openPositions: 0, lastTradeAt: null,
    });
    houseAgentsBody = [
      { id: 'house:genesis', name: 'Genesis', templateId: 'genesis', stats: { all: stats(1, 1, 0) } },
      { id: 'house:runner', name: 'Runner', templateId: 'runner', stats: { all: stats(2, 0, 1) } },
    ];
    const host = await render();
    const genesis = host.querySelector('[data-testid="arena-template-genesis"]')?.textContent ?? '';
    const runner = host.querySelector('[data-testid="arena-template-runner"]')?.textContent ?? '';
    expect(genesis).toContain('1 trade · 1 win · 0 losses · 0 open');
    expect(runner).toContain('2 trades · 0 wins · 1 loss · 0 open');
  });

  test('a guest who taps Launch gets the sign-up prompt, not the form', async () => {
    let blocked = 0;
    const host = await render({ isGuest: true, onGuestBlocked: () => { blocked += 1; } });
    await click(buttonByText(host, 'Launch your trader'));
    expect(blocked).toBe(1);
    expect(host.querySelector('[data-testid="arena-launch"]')).toBeNull();
    // A guest never asks for GET /me: it can only be refused.
    expect(requests.some((url) => url.endsWith('/me'))).toBe(false);
  });

  test('a player with a trader sees Open my trader and no Start buttons', async () => {
    meBody = myAgentBody();
    const host = await render();
    expect(buttonByText(host, 'Open my trader')).toBeDefined();
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === 'Start from this template')).toBe(false);
  });
});

describe('Launch flow', () => {
  test('Start from a template opens the rules form with the fixed $20, the hard rules and a closed live mode', async () => {
    const host = await render();
    const card = host.querySelector('[data-testid="arena-template-genesis"]')!;
    await click(buttonByText(card as HTMLElement, 'Start from this template'));
    expect(host.querySelector('[data-testid="arena-launch"]')).not.toBeNull();
    expect(host.textContent).toContain('Step 2 of 4');
    expect(host.querySelector('[data-testid="arena-field-limits.position_usd"]')?.textContent).toContain('$20 per position');
    expect(host.querySelector('[data-testid="arena-hard-rules"]')?.textContent).toContain('Mint authority revoked');
    const live = buttonByText(host, 'Live trading');
    expect(live.disabled).toBe(true);
    expect(live.textContent).toContain('Coming later');
  });

  test('Runner starts with the first-sight select on "tradeable", and liq_min has an off toggle', async () => {
    const host = await render();
    await click(buttonByText(host.querySelector('[data-testid="arena-template-runner"]') as HTMLElement, 'Start from this template'));
    const field = host.querySelector('[data-testid="arena-field-entry.first_sight_sources"]') as HTMLElement;
    const select = field.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('tradeable');
    expect(select.disabled).toBe(false);
    expect([...select.querySelectorAll('option')].map((node) => node.textContent)).toEqual([
      FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS.any,
      FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS.tradeable,
    ]);
    const liq = host.querySelector('[data-testid="arena-field-filters.liq_min"]') as HTMLElement;
    expect(liq.querySelector('button[aria-pressed]')).not.toBeNull();
    const rules = host.querySelector('[data-testid="arena-hard-rules"]')?.textContent ?? '';
    for (const rule of FLOOR_ARENA_HARD_RULES) expect(rules).toContain(rule.label);
    expect(rules).toContain('Coins seen only by GeckoTerminal are shown in the feed but are not traded.');
  });

  test('a value outside its bound is refused next to its own field and the flow stays on the rules', async () => {
    const host = await render();
    await click(buttonByText(host.querySelector('[data-testid="arena-template-genesis"]') as HTMLElement, 'Start from this template'));
    const field = host.querySelector('[data-testid="arena-field-filters.mcap_min"]') as HTMLElement;
    const input = field.querySelector('input') as HTMLInputElement;
    await act(async () => {
      reactProps(input).onChange?.({ target: { value: '500' } });
    });
    await click(buttonByText(host, 'Next'));
    // Re-read the field: the filter list re-mounts open when it gains an error.
    const after = host.querySelector('[data-testid="arena-field-filters.mcap_min"]') as HTMLElement;
    expect(after.textContent).toContain('must be between 1000 and 100000000');
    expect(after.closest('details')?.open).toBe(true);
    expect(host.textContent).toContain('Step 2 of 4');
  });
});

describe('Desk panel', () => {
  test('a trader that is active but not seated reads Waiting for you to sit', async () => {
    meBody = myAgentBody();
    useFloorArenaUi.setState({ panel: 'desk' });
    const host = await render();
    expect(host.querySelector('[data-testid="arena-desk-status"]')?.textContent).toBe('Waiting for you to sit');
    expect(host.textContent).toContain('Setting up your ClawPump agent...');
  });

  test('the desk panel with no trader shows the launch flow instead', async () => {
    useFloorArenaUi.setState({ panel: 'desk' });
    const host = await render();
    expect(host.querySelector('[data-testid="arena-launch"]')).not.toBeNull();
    expect(host.textContent).toContain('Step 1 of 4');
  });
});

function publicProfile(kind: 'house' | 'user', latestReport: unknown) {
  return {
    agent: {
      id: kind === 'house' ? 'house:genesis' : '11111111-2222-4333-8444-555555555555',
      kind,
      name: kind === 'house' ? 'Genesis' : 'Someone',
      templateId: 'genesis',
      params: FLOOR_ARENA_TEMPLATES[0]!.params,
      paramsVersion: 1,
      mode: 'paper',
      status: 'active',
      seated: true,
      seatIndex: kind === 'house' ? null : 2,
    },
    stats: null,
    openPositions: [],
    closedPositions: [],
    paramChanges: [],
    ...(latestReport === undefined ? {} : { latestReport }),
  };
}

describe('Guest sign-up prompt for the arena', () => {
  test('the arena wording says paper trades, names the USDC add-on exception, and prizes need an account', () => {
    const text = `${ARENA_GUEST_UPSELL.headline} ${ARENA_GUEST_UPSELL.body} ${ARENA_GUEST_UPSELL.ctaLabel}`;
    const lower = text.toLowerCase();
    expect(lower).toContain('paper only');
    // Paid add-ons spend real USDC, so the prompt names that exception and
    // never claims that no real money moves.
    expect(lower).toContain('add-ons are optional');
    expect(text).toContain('USDC');
    expect(lower).toContain("your agent's own wallet");
    expect(lower).not.toContain('no real money');
    // The same phrases the contest rules use, so the prompt and the rules agree.
    for (const phrase of [
      'no vclaw is spent',
      'no real tokens are bought',
      "add-ons are optional and spend only usdc that you send to your agent's own wallet",
      'guests cannot enter',
    ]) {
      expect({ phrase, inPrompt: lower.includes(phrase) }).toEqual({ phrase, inPrompt: true });
      expect({ phrase, inRules: FLOOR_ARENA_CONTEST.rules.some((rule) => rule.toLowerCase().includes(phrase)) }).toEqual({
        phrase,
        inRules: true,
      });
    }
    expect(text).toContain('$CLAWVILLE');
    expect(text).toContain('vCLAW');
    // The Exchange copy this replaces talked about escrow; the arena has none.
    expect(text.toLowerCase()).not.toContain('escrow');
    expect(text).not.toContain('\u2014');
    expect(text.toLowerCase()).not.toContain('casino');
    expect(text).not.toMatch(/\bCT\b/);
  });

  test('both arena launch buttons in the Trading Floor tab ask for the arena wording', async () => {
    const variants: Array<string | undefined> = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: client! },
          createElement(TradingFloorTab, {
            active: true,
            isGuest: true,
            onGuestBlocked: (variant?: 'arena') => { variants.push(variant); },
          }),
        ),
      );
    });
    await flush();
    const host = container;
    await click(host.querySelector('[data-testid="arena-launch-button"]') as HTMLElement);
    const entry = host.querySelector('[data-testid="arena-launch-entry"]') as HTMLElement;
    await click(buttonByText(entry, 'Launch your trader'));
    expect(variants).toEqual(['arena', 'arena']);
  });
});

/** Opens the discovery `<details>` the way a tap does: `open` flips, then the toggle handler runs. */
async function openDiscovery(host: HTMLElement): Promise<HTMLElement> {
  const details = host.querySelector('[data-testid="arena-discovery"]') as HTMLElement & { open: boolean };
  expect(details).not.toBeNull();
  await act(async () => {
    details.open = true;
    (reactProps(details) as unknown as { onToggle?: (event: { currentTarget: Element }) => void })
      .onToggle?.({ currentTarget: details });
  });
  await flush();
  return details;
}

describe('Shared discovery feed card (prod verify b8d52ab6, finding 3)', () => {
  // On prod the closed card read as a bare heading: `display: flex` on the
  // summary removes the disclosure triangle, and nothing else said it opens.
  test('closed, it shows a Show coins cue and asks the server for nothing', async () => {
    const host = await render();
    const details = host.querySelector('[data-testid="arena-discovery"]') as HTMLElement;
    expect(details.querySelector('[data-testid="arena-discovery-toggle"]')?.textContent).toBe('Show coins');
    expect(requests.some((url) => url.includes('/discovery'))).toBe(false);
  });

  test('an empty feed says it fills when the engine scans, and the cue turns to Hide', async () => {
    discoveryResponses = [{ status: 200, body: { mints: [], generatedAt: '2026-10-01T14:00:00.000Z' } }];
    const host = await render();
    const details = await openDiscovery(host);
    expect(requests.filter((url) => url.includes('/discovery'))).toHaveLength(1);
    expect(details.querySelector('[data-testid="arena-discovery-empty"]')?.textContent).toBe(
      'No coins in the feed yet; it fills when the engine scans.',
    );
    expect(details.querySelector('[data-testid="arena-discovery-toggle"]')?.textContent).toBe('Hide');
  });

  test('a failed fetch says so, and Try again fetches again and shows the coins', async () => {
    discoveryResponses = [
      { status: 503, body: { error: 'The discovery feed is unavailable.' } },
      {
        status: 200,
        body: {
          mints: [{
            mint: 'TestMint11111111111111111111111111111111111',
            symbol: 'TESTCOIN',
            firstSeenAt: '2026-10-01T13:56:45.528Z',
            firstSource: 'gecko:new-pools',
            snapshot: null,
          }],
        },
      },
    ];
    const host = await render();
    const details = await openDiscovery(host);
    const error = details.querySelector('[data-testid="arena-discovery-error"]') as HTMLElement | null;
    expect(error?.textContent).toContain('The feed could not be loaded right now.');
    expect(details.querySelector('[data-testid="arena-discovery-empty"]')).toBeNull();
    await click(buttonByText(error!, 'Try again'));
    expect(requests.filter((url) => url.includes('/discovery'))).toHaveLength(2);
    expect(details.querySelector('[data-testid="arena-discovery-error"]')).toBeNull();
    expect(details.textContent).toContain('TESTCOIN');
  });
});

describe('Paper arena and live traders are named apart (prod verify b8d52ab6, finding 2)', () => {
  test('the Trading Floor tab says paper for the arena and real money for the live traders', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: client! },
          createElement(TradingFloorTab, { active: true, isGuest: true, onGuestBlocked: () => undefined }),
        ),
      );
    });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('The five arena house agents (paper)');
    expect(text).toContain('Live traders (real money');
    // The old heading sat on the live floor card AND on the live traders panel,
    // right under the arena's own house agents of the same names.
    expect(text).not.toContain('Watch the house traders');
  });
});

describe('Agent wallet: funding note (P5 withdraw D34-k; replaces the audit-money M3 no-withdraw note)', () => {
  const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const FUNDING =
    'Send only USDC or SOL on Solana to this wallet. Keep at least 0.01 SOL in it, because each withdrawal pays its ' +
    'network fee in SOL. You can withdraw to an address that you prove is yours. Add-ons spend at most $5 a day from it.';

  test('the text is the agreed wording and the $5 comes from the shared cap', () => {
    expect(ARENA_WALLET_FUNDING_NOTE).toBe(FUNDING);
    expect(ARENA_WALLET_FUNDING_NOTE.toLowerCase()).not.toContain('cannot withdraw');
  });

  test('the desk panel shows it under the wallet address, and the old test id is gone', async () => {
    meBody = { ...myAgentBody({ paymentAddress: WALLET, provisionState: 'ready' }), paymentAddress: WALLET, provision: { state: 'ready', error: null } };
    useFloorArenaUi.setState({ panel: 'desk' });
    const host = await render();
    expect(host.querySelector('[data-testid="arena-wallet-no-withdraw"]')).toBeNull();
    const note = host.querySelector('[data-testid="arena-wallet-funding-note"]');
    expect(note?.textContent).toBe(FUNDING);
    // Both warnings sit in the same block as the address the player copies.
    const block = note?.closest('section') as HTMLElement;
    expect((block.querySelector('input') as HTMLInputElement | null)?.value).toBe(WALLET);
    expect(block.textContent).toContain(ADDON_WALLET_WARNING);
    // The same Wallet block holds the SOL line and the withdraw panel.
    expect(block.textContent).toContain('SOL in the wallet: ');
    expect(block.querySelector('[data-testid="arena-withdraw"]')).not.toBeNull();
  });

  test('the launch success screen shows it under the wallet address', async () => {
    meBody = { ...myAgentBody({ paymentAddress: WALLET, provisionState: 'ready' }), paymentAddress: WALLET, provision: { state: 'ready', error: null } };
    useFloorArenaUi.setState({ launched: { agentName: 'My Genesis', paymentAddress: WALLET } });
    const host = await render();
    const success = host.querySelector('[data-testid="arena-launch-success"]') as HTMLElement;
    expect(success).not.toBeNull();
    expect(success.querySelector('[data-testid="arena-wallet-funding-note"]')?.textContent).toBe(FUNDING);
    expect(success.querySelector('[data-testid="arena-wallet-no-withdraw"]')).toBeNull();
    expect(success.textContent).toContain(ADDON_WALLET_WARNING);
  });

  test('the add-on picker (launch step 3) shows both warnings when add-ons are offered', async () => {
    addonsBody = {
      addons: [{ id: 'feed-1', vendor: 'Vendor', name: 'Paid feed', priceUsd: 0.01, minIntervalS: 600, note: '' }],
      paymentsEnabled: true,
    };
    const host = await render();
    await click(buttonByText(host.querySelector('[data-testid="arena-template-genesis"]') as HTMLElement, 'Start from this template'));
    await click(buttonByText(host, 'Next'));
    const picker = host.querySelector('[data-testid="arena-addon-picker"]') as HTMLElement;
    expect(picker).not.toBeNull();
    expect(picker.textContent).toContain(FUNDING);
    expect(picker.textContent).toContain(ADDON_WALLET_WARNING);
    // Solana USDC or SOL only, the SOL fee rule, a proved address to withdraw
    // to, only this agent's add-ons, and no refund of spend.
    const lower = picker.textContent!.toLowerCase();
    for (const phrase of [
      'usdc or sol on solana',
      'keep at least 0.01 sol',
      'withdraw to an address that you prove is yours',
      'only for its own paid data add-ons',
      'does not refund',
    ]) {
      expect({ phrase, present: lower.includes(phrase) }).toEqual({ phrase, present: true });
    }
    expect(lower).not.toContain('cannot withdraw');
  });

  test('saving rules says that open positions keep their exits (audit-contest W-2)', async () => {
    meBody = myAgentBody();
    useFloorArenaUi.setState({ panel: 'desk' });
    const host = await render();
    await click(buttonByText(host, 'Edit rules'));
    const editor = host.querySelector('[data-testid="arena-rules-editor"]') as HTMLElement;
    expect(editor.textContent).toContain(
      'Changes apply to positions opened after you save. Open positions keep the exits they were opened with.',
    );
  });

  test('no address yet means no wallet text and no withdraw panel', async () => {
    meBody = myAgentBody();
    useFloorArenaUi.setState({ panel: 'desk' });
    const host = await render();
    expect(host.querySelector('[data-testid="arena-wallet-funding-note"]')).toBeNull();
    expect(host.querySelector('[data-testid="arena-withdraw"]')).toBeNull();
  });
});

describe('Contest rules 2, 5 and 6 and the standings after the end (D30/D31)', () => {
  const AFTER_END = Date.parse(FLOOR_ARENA_CONTEST.endsAt) + 3_600_000;

  afterEach(() => {
    setSystemTime();
  });

  test('the standings wording: final, provisional with a count, and unknown', () => {
    expect(contestStandingsCopy('final', 0)).toEqual({
      pill: 'Final',
      text: 'The contest has ended. These are the final standings; the team reviews them and then pays the prizes.',
    });
    expect(contestStandingsCopy('provisional', 1).text).toBe(
      'The contest has ended. Standings are provisional: 1 position opened in the window is still open, and they still count.',
    );
    expect(contestStandingsCopy('provisional', 3).text).toContain('3 positions opened in the window are still open');
    expect(contestStandingsCopy('provisional', null).text).toContain('Some positions opened in the window are still open');
    expect(contestStandingsCopy(null, null)).toEqual({
      pill: null,
      text: 'The contest has ended. Final standings are published when the last position opened in the window closes.',
    });
  });

  test('GET /contest standings are read, and anything else is unknown', () => {
    expect(readContest({ status: 'ended', standings: 'provisional', openWindowPositions: 2 })).toMatchObject({
      standings: 'provisional',
      openWindowPositions: 2,
    });
    expect(readContest({ status: 'live', standings: null, openWindowPositions: null })).toMatchObject({
      standings: null,
      openWindowPositions: null,
    });
    expect(readContest({ standings: 'maybe' }).standings).toBeNull();
  });

  test('after the end the banner, the leaderboard and the rules panel say provisional', async () => {
    setSystemTime(new Date(AFTER_END));
    contestBody = { status: 'ended', standings: 'provisional', openWindowPositions: 2, top: [], house: [] };
    const host = await render();
    expect(host.querySelector('[data-testid="arena-standings"]')?.textContent).toBe('Provisional');
    expect(host.querySelector('[data-testid="arena-countdown"]')?.textContent).toBe(
      'The contest has ended. Standings are provisional: 2 positions opened in the window are still open, and they still count.',
    );
    expect(host.querySelector('[data-testid="arena-leaderboard"]')?.textContent).toContain('Provisional');
    await click(buttonByText(host, 'Contest rules'));
    expect(host.querySelector('[data-testid="arena-contest-rules"]')?.textContent).toContain('Top 10 (provisional)');
  });

  test('a final answer turns every label to final', async () => {
    setSystemTime(new Date(AFTER_END));
    contestBody = { status: 'ended', standings: 'final', openWindowPositions: 0, top: [], house: [] };
    const host = await render();
    expect(host.querySelector('[data-testid="arena-standings"]')?.textContent).toBe('Final');
    await click(buttonByText(host, 'Contest rules'));
    expect(host.querySelector('[data-testid="arena-contest-rules"]')?.textContent).toContain('Final top 10');
  });

  test('before the end nothing says provisional or final', async () => {
    setSystemTime(new Date(Date.parse(FLOOR_ARENA_CONTEST.startsAt) + 3_600_000));
    const host = await render();
    expect(host.querySelector('[data-testid="arena-standings"]')).toBeNull();
    expect(host.querySelector('[data-testid="arena-countdown"]')?.textContent).toContain('Ends in');
  });

  test('the score and eligibility copy follows rules 5 and 6, not the old "closed by its end"', async () => {
    const rule5 = FLOOR_ARENA_CONTEST.rules.find((rule) => rule.startsWith('Your score is'))!;
    const rule6 = FLOOR_ARENA_CONTEST.rules.find((rule) => rule.startsWith('To be eligible'))!;
    expect(rule5).toContain('including positions that close after the end');
    expect(rule6).toContain('opened inside the contest window and closed');
    const host = await render();
    const footnote = host.querySelector('[data-testid="arena-leaderboard"]')?.textContent ?? '';
    expect(footnote).toContain('also when they close after it ends');
    expect(footnote).toContain('once a position it opened inside the window has closed');
    // No arena source keeps the old wording.
    for (const name of readdirSync(import.meta.dir).filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.'))) {
      const source = readFileSync(join(import.meta.dir, name), 'utf8');
      expect({ name, old: /closed by its end|opens and closes inside|opened and\s+closed between/.test(source) }).toEqual({
        name,
        old: false,
      });
    }
  });

  test('an unresolved close shows its contest loss only when it opened inside the window (rule 2, D31)', async () => {
    const unresolved = readPosition({
      id: 'p1', mint: 'Mint1111', symbol: 'DEAD', status: 'closed', openedAt: '2026-10-01T00:00:00Z',
      closedAt: '2026-10-01T01:00:00Z', sizeUsd: 20, realisedUsd: 5, pnlUsd: null, pnlMult: null, exitReason: 'unresolved',
    })!;
    expect(unresolvedContestLoss(unresolved)).toBe(-15);
    expect(unresolvedContestLoss({ ...unresolved, exitReason: 'tp' })).toBeNull();
    expect(unresolvedContestLoss({ ...unresolved, realisedUsd: null })).toBeNull();
    // The leaderboard window is inclusive at both ends; outside it, no contest loss.
    const startMs = Date.parse(FLOOR_ARENA_CONTEST.startsAt);
    const endMs = Date.parse(FLOOR_ARENA_CONTEST.endsAt);
    const at = (ms: number) => ({ ...unresolved, openedAt: new Date(ms).toISOString() });
    expect(unresolvedContestLoss(at(startMs - 1_000))).toBeNull();
    expect(unresolvedContestLoss(at(startMs))).toBe(-15);
    expect(unresolvedContestLoss(at(endMs))).toBe(-15);
    expect(unresolvedContestLoss(at(endMs + 1_000))).toBeNull();
    expect(unresolvedContestLoss({ ...unresolved, openedAt: null })).toBeNull();

    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(ArenaClosedTrades, { positions: [unresolved], nowMs: Date.now() }));
    });
    expect(container.textContent).toContain('no usable price for 30 min');
    expect(container.querySelector('[data-testid="arena-unresolved-loss"]')?.textContent).toBe('contest: -$15.00');

    // Opened before the start: "unresolved" and no contest line.
    await act(async () => {
      root?.render(createElement(ArenaClosedTrades, { positions: [at(startMs - 3_600_000)], nowMs: Date.now() }));
    });
    expect(container.textContent).toContain('unresolved');
    expect(container.querySelector('[data-testid="arena-unresolved-loss"]')).toBeNull();
  });
});

describe('Contest rules panel', () => {
  test('renders every rule from the shared constant, including the eligibility rule', async () => {
    useFloorArenaUi.setState({ panel: 'rules' });
    const host = await render();
    const items = [...host.querySelectorAll('[data-testid="arena-contest-rules"] li')].map((node) => node.textContent);
    for (const rule of FLOOR_ARENA_CONTEST.rules) expect(items).toContain(rule);
    expect(FLOOR_ARENA_CONTEST.rules.some((rule) => rule.includes('eligible'))).toBe(true);
  });
});

describe('Agent profile', () => {
  test("a player's public profile hides the report block and says the stream is partial", async () => {
    profileBody = publicProfile('user', undefined);
    useFloorArenaUi.setState({ panel: 'profile', profileAgentId: '11111111-2222-4333-8444-555555555555' });
    const host = await render();
    expect(host.querySelector('[data-testid="arena-agent-profile"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Latest 30-minute report');
    expect(host.textContent).toContain('Public view: buys, sells, rule changes and status changes only.');
    expect(host.textContent).not.toContain('wallet');
  });

  test('a house profile keeps its report block', async () => {
    profileBody = publicProfile('house', {
      id: 'r1',
      summary: 'Quiet half hour.',
      suggestion: null,
      suggestionState: 'none',
      periodEnd: '2026-09-30T20:00:00Z',
    });
    useFloorArenaUi.setState({ panel: 'profile', profileAgentId: 'house:genesis' });
    const host = await render();
    expect(host.textContent).toContain('Latest 30-minute report');
    expect(host.textContent).toContain('Quiet half hour.');
  });
});

describe('Arena pure helpers', () => {
  test('desk status needs both an active agent and a seat to read Trading', () => {
    expect(deskStatus({ status: 'active', seated: true })).toBe('trading');
    expect(deskStatus({ status: 'active', seated: false })).toBe('waiting');
    expect(deskStatus({ status: 'paused', seated: true })).toBe('paused');
    expect(deskStatus({ status: 'stopped', seated: true })).toBe('stopped');
  });

  test('event colours: entry green, exit by its P&L, skip grey, rules blue, report purple', () => {
    const tone = (raw: Record<string, unknown>) => arenaEventTone(readEvent({ id: 1, summary: 'x', ...raw })!);
    expect(tone({ type: 'entry' })).toBe(FLOOR_TEXT.positive);
    expect(tone({ type: 'exit', data: { pnlUsd: 1.2 } })).toBe(FLOOR_TEXT.positive);
    expect(tone({ type: 'exit', data: { pnlUsd: -3 } })).toBe(FLOOR_TEXT.danger);
    expect(tone({ type: 'exit' })).toBe(FLOOR_TEXT.muted);
    expect(tone({ type: 'skip' })).toBe(FLOOR_TEXT.faint);
    expect(tone({ type: 'param_change' })).toBe(FLOOR_TEXT.accent);
    expect(tone({ type: 'report' })).not.toBe(FLOOR_TEXT.accent);
  });

  test('validator errors land on their field; a leg error lands on the leg editor', () => {
    const map = errorsByPath([
      'filters.mcap_min: must be between 1000 and 100000000',
      'exits.tp[1][0]: must be above the previous leg\'s multiple',
      'exits: needs a take-profit leg, a stop_mult or a trail_from_peak',
      'params: must be an object',
    ]);
    expect(map.get('filters.mcap_min')).toEqual(['must be between 1000 and 100000000']);
    expect(map.get('exits.tp')).toEqual(["Leg 2 multiple: must be above the previous leg's multiple"]);
    expect(map.get('exits')).toHaveLength(1);
    expect(map.get('params')).toEqual(['must be an object']);
  });

  test('money never prints an unknown as $0.00, and a loss keeps its sign', () => {
    expect(signedUsd(null)).toBe('n/a');
    expect(signedUsd(0)).toBe('$0.00');
    expect(signedUsd(-2.5)).toBe('-$2.50');
    expect(signedUsd(3)).toBe('+$3.00');
    expect(compactUsd(250_000)).toBe('$250k');
    expect(compactUsd(1_500_000)).toBe('$1.5M');
    expect(compactUsd(20)).toBe('$20');
  });

  test('count labels are singular for exactly 1 and plural for 0, 2 and an unknown count', () => {
    const kinds: Array<[string, string | undefined, string]> = [
      ['trade', undefined, 'trades'],
      ['win', undefined, 'wins'],
      ['loss', 'losses', 'losses'],
      ['rule', undefined, 'rules'],
    ];
    for (const [singular, plural, expectedPlural] of kinds) {
      expect(countLabel(0, singular, plural)).toBe(`0 ${expectedPlural}`);
      expect(countLabel(1, singular, plural)).toBe(`1 ${singular}`);
      expect(countLabel(2, singular, plural)).toBe(`2 ${expectedPlural}`);
      expect(countLabel(null, singular, plural)).toBe(`- ${expectedPlural}`);
    }
  });

  test('durations and the countdown read in plain units', () => {
    expect(formatDuration(900)).toBe('15 min');
    expect(formatDuration(21_600)).toBe('6 h');
    expect(formatDuration(5_400)).toBe('1 h 30 min');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatCountdown(((4 * 24 + 5) * 3_600 + 59 * 60 + 58) * 1_000)).toBe('4d 05h 59m 58s');
    expect(formatCountdown(-5_000)).toBe('0m 00s');
  });

  test('the contest phase follows the shared window', () => {
    const start = Date.parse(FLOOR_ARENA_CONTEST.startsAt);
    const end = Date.parse(FLOOR_ARENA_CONTEST.endsAt);
    expect(contestPhase(FLOOR_ARENA_CONTEST.startsAt, FLOOR_ARENA_CONTEST.endsAt, start - 1)).toBe('upcoming');
    expect(contestPhase(FLOOR_ARENA_CONTEST.startsAt, FLOOR_ARENA_CONTEST.endsAt, start)).toBe('live');
    expect(contestPhase(FLOOR_ARENA_CONTEST.startsAt, FLOOR_ARENA_CONTEST.endsAt, end + 1)).toBe('ended');
  });

  test('the first-sight choice has a label and formats in diffs and suggestions', () => {
    expect(paramPathLabel('entry.first_sight_sources')).toBe('Count first sight from');
    expect(formatParamValue('entry.first_sight_sources', 'tradeable')).toBe(
      FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS.tradeable,
    );
  });

  test('a position row lists the exit rules of its agent', () => {
    expect(exitTargets(FLOOR_ARENA_TEMPLATES[0]!.params.exits)).toEqual(['TP 1.10x sells 100%', 'Max hold 15 min']);
  });

  test('an open position runs on its frozen exits, not on rules saved later (audit-contest W-2)', () => {
    const params = FLOOR_ARENA_TEMPLATES[0]!.params;
    const frozen = { ...params.exits, stop_mult: 0.7 };
    // Frozen exits from the route always win.
    expect(positionExits({ entryExits: frozen, paramsVersion: 1 }, params, 3)).toBe(frozen);
    // Without them, the current rules apply only to a position opened under the same version.
    expect(positionExits({ entryExits: null, paramsVersion: 3 }, params, 3)).toBe(params.exits);
    expect(positionExits({ entryExits: null, paramsVersion: 1 }, params, 3)).toBeNull();
    expect(positionExits({ entryExits: null, paramsVersion: null }, params, 3)).toBeNull();
  });

  test('add-on caps: each on cap counts toward the $5 total; an off add-on costs nothing', () => {
    expect(enabledCapTotal({ a: { enabled: true, capUsd: 2 }, b: { enabled: false, capUsd: 5 } })).toBe(2);
    expect(addonChoicesValid({ a: { enabled: true, capUsd: 3 }, b: { enabled: true, capUsd: 2 } })).toBe(true);
    expect(addonChoicesValid({ a: { enabled: true, capUsd: 3 }, b: { enabled: true, capUsd: 2.5 } })).toBe(false);
    expect(addonChoicesValid({ a: { enabled: true, capUsd: Number.NaN } })).toBe(false);
    expect(addonMaxCostPerDay({ priceUsd: 0.1, minIntervalS: 600 })).toBeCloseTo(14.4, 6);
  });

  test('underfunded only when the balance is KNOWN to be short', () => {
    expect(addonUnderfunded({ enabled: true, priceUsd: 0.1 }, 0.05)).toBe(true);
    expect(addonUnderfunded({ enabled: true, priceUsd: 0.1 }, null)).toBe(false);
    expect(addonUnderfunded({ enabled: false, priceUsd: 0.1 }, 0)).toBe(false);
  });
});

describe('Arena copy and colour rules', () => {
  // The same rules trading-floor-structural.test.ts applies to the rest of the
  // tab: no em dash, never the word casino, never CT outward, colours only
  // from the token module (rgba literals are layout tints, not hex colours).
  test('no arena source file breaks the outward copy rules or carries a hex colour', () => {
    const files = readdirSync(import.meta.dir).filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const name of files) {
      const source = readFileSync(join(import.meta.dir, name), 'utf8');
      expect({ name, emDash: source.includes('\u2014') }).toEqual({ name, emDash: false });
      expect({ name, casino: source.toLowerCase().includes('casino') }).toEqual({ name, casino: false });
      expect({ name, ct: /\bCT\b/.test(source) }).toEqual({ name, ct: false });
      expect({ name, hex: /#[0-9a-fA-F]{3,8}\b/.test(source) }).toEqual({ name, hex: false });
    }
  });
});
