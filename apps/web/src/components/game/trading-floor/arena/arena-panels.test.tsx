import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

import { readEvent } from '@/hooks/use-floor-arena';
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
  errorsByPath,
  exitTargets,
  formatCountdown,
  formatDuration,
  formatParamValue,
  paramPathLabel,
  signedUsd,
} from './arena-format';
import { arenaEventTone } from './arena-parts';
import { addonUnderfunded, deskStatus } from './my-trader';

// Same DOM harness as floor-components.test.tsx: bun has no global DOM.
const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'HTMLAnchorElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let FloorArenaSection: typeof import('./arena-section').FloorArenaSection;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
let meBody: Record<string, unknown> = { agent: null };
let profileBody: Record<string, unknown> = {};
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
});

beforeEach(() => {
  requests = [];
  meBody = { agent: null };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string) => {
      const url = String(input);
      requests.push(url);
      let body: unknown = {};
      if (url.includes('/me')) body = meBody;
      else if (url.includes('/leaderboard')) body = { rows: [] };
      else if (url.includes('/templates')) body = { houseAgents: [] };
      else if (url.includes('/addons')) body = { addons: [], paymentsEnabled: false };
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
    expect(exitTargets(FLOOR_ARENA_TEMPLATES[0]!.params)).toEqual(['TP 1.10x sells 100%', 'Max hold 15 min']);
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
