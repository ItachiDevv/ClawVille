import { afterEach, describe, expect, test } from 'bun:test';
import {
  MCP_APP_OPEN_LINK_TYPE,
  MCP_APP_PARENT_ORIGINS,
  MCP_APP_PARENT_SESSION_KEY,
  MCP_APP_SESSION_KEY,
  __resetMcpAppFrameBridgeForTests,
  installMcpAppFrameBridge,
  isMcpAppFrameBridgeActive,
  normalizeOpenUrl,
  resolveMcpAppParent,
} from './mcp-app-frame-bridge';

const SELF = 'https://clawville.world';
const PROD_SANDBOX = 'https://fbbf4fac72ecb46c1810ee8a4f3bb886.claudemcpcontent.com';
const STAGING_SANDBOX = 'https://b1bb7d1e416a979f53eac06556dc647b.claudemcpcontent.com';
const MILADY = 'http://localhost:2138';

describe('MCP_APP_PARENT_ORIGINS', () => {
  test('lists claude.ai and the two exact sandbox hosts, no wildcard', () => {
    expect([...MCP_APP_PARENT_ORIGINS]).toEqual(['https://claude.ai', PROD_SANDBOX, STAGING_SANDBOX]);
    expect(MCP_APP_PARENT_ORIGINS.some((o) => o.includes('*'))).toBe(false);
  });
});

describe('resolveMcpAppParent', () => {
  const base = {
    framed: true,
    search: '?embed=mcp-app',
    selfOrigin: SELF,
    storedMode: null,
    storedParent: null,
    ancestorOrigins: null,
    referrer: '',
  };

  test('not framed: off even with param and an allowed parent', () => {
    expect(resolveMcpAppParent({ ...base, framed: false, ancestorOrigins: [PROD_SANDBOX] })).toBeNull();
  });
  test('no param and no stored flag: off', () => {
    expect(resolveMcpAppParent({ ...base, search: '', ancestorOrigins: [PROD_SANDBOX] })).toBeNull();
    expect(resolveMcpAppParent({ ...base, search: '?embed=milady', ancestorOrigins: [PROD_SANDBOX] })).toBeNull();
  });
  test('param + allowed ancestor origin: on', () => {
    expect(resolveMcpAppParent({ ...base, ancestorOrigins: [PROD_SANDBOX, 'https://claude.ai'] })).toBe(PROD_SANDBOX);
  });
  test('param + allowed referrer (no ancestorOrigins, Firefox): on', () => {
    expect(resolveMcpAppParent({ ...base, referrer: `${STAGING_SANDBOX}/view?x=1` })).toBe(STAGING_SANDBOX);
  });
  test('framed + param but parent not allowed: off (Milady / uOS with a stray param)', () => {
    expect(resolveMcpAppParent({ ...base, ancestorOrigins: [MILADY] })).toBeNull();
    expect(resolveMcpAppParent({ ...base, ancestorOrigins: ['https://www.uos.agency'] })).toBeNull();
    expect(resolveMcpAppParent({ ...base, referrer: 'https://www.uos.agency/' })).toBeNull();
    expect(resolveMcpAppParent({ ...base, ancestorOrigins: ['https://evil.claudemcpcontent.com'] })).toBeNull();
    expect(resolveMcpAppParent({ ...base, ancestorOrigins: ['https://claude.ai.evil.com'] })).toBeNull();
  });
  test('framed + param but parent unknown and nothing stored: off', () => {
    expect(resolveMcpAppParent(base)).toBeNull();
    expect(resolveMcpAppParent({ ...base, referrer: 'not a url' })).toBeNull();
  });
  test('ancestorOrigins is authoritative over a stored parent', () => {
    expect(resolveMcpAppParent({
      ...base,
      search: '',
      storedMode: 'mcp-app',
      storedParent: PROD_SANDBOX,
      ancestorOrigins: [MILADY],
    })).toBeNull();
  });
  test('referrer missing (Firefox reload): reuses the stored verified parent', () => {
    expect(resolveMcpAppParent({ ...base, search: '', storedMode: 'mcp-app', storedParent: PROD_SANDBOX })).toBe(PROD_SANDBOX);
  });
  test('same-origin referrer (navigation inside the frame): reuses the stored parent', () => {
    expect(resolveMcpAppParent({
      ...base,
      search: '',
      storedMode: 'mcp-app',
      storedParent: STAGING_SANDBOX,
      referrer: `${SELF}/game`,
    })).toBe(STAGING_SANDBOX);
  });
  test('stored parent that is not allowed is ignored', () => {
    expect(resolveMcpAppParent({ ...base, storedMode: 'mcp-app', storedParent: MILADY })).toBeNull();
  });
  test('stored parent without the stored flag is ignored', () => {
    expect(resolveMcpAppParent({ ...base, storedParent: PROD_SANDBOX })).toBeNull();
  });
});

describe('normalizeOpenUrl', () => {
  const page = `${SELF}/game?embed=mcp-app`;
  test('resolves relative URLs against the page', () => {
    expect(normalizeOpenUrl('/leaderboard', page)).toBe(`${SELF}/leaderboard`);
    expect(normalizeOpenUrl('docs', page)).toBe(`${SELF}/docs`);
  });
  test('keeps absolute http(s) URLs', () => {
    expect(normalizeOpenUrl('https://x.com/a?b=1', page)).toBe('https://x.com/a?b=1');
    expect(normalizeOpenUrl(new URL('http://example.org/'), page)).toBe('http://example.org/');
  });
  test('rejects non-http(s), empty and missing values', () => {
    expect(normalizeOpenUrl('javascript:alert(1)', page)).toBeNull();
    expect(normalizeOpenUrl('mailto:a@b.c', page)).toBeNull();
    expect(normalizeOpenUrl('data:text/html,hi', page)).toBeNull();
    expect(normalizeOpenUrl('', page)).toBeNull();
    expect(normalizeOpenUrl('   ', page)).toBeNull();
    expect(normalizeOpenUrl(undefined, page)).toBeNull();
    expect(normalizeOpenUrl(null, page)).toBeNull();
  });
});

// ─── install() against a minimal fake window ────────────────────────────────

type Listener = (event: MouseEvent) => void;

function makeFakeWindow(opts: {
  framed: boolean;
  search: string;
  ancestor?: string;
  referrer?: string;
  stored?: Record<string, string>;
}) {
  const posted: Array<{ message: unknown; origin: string }> = [];
  const listeners: Array<{ type: string; fn: Listener; capture: boolean }> = [];
  const storage = new Map<string, string>(Object.entries(opts.stored ?? {}));
  const originalOpenCalls: unknown[][] = [];
  const win: Record<string, unknown> = {
    location: {
      search: opts.search,
      origin: SELF,
      href: `${SELF}/game${opts.search}`,
      ancestorOrigins: opts.ancestor ? [opts.ancestor] : undefined,
    },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
    document: {
      referrer: opts.referrer ?? '',
      addEventListener: (type: string, fn: Listener, capture: boolean) => listeners.push({ type, fn, capture }),
    },
    parent: { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) },
    open: (...args: unknown[]) => {
      originalOpenCalls.push(args);
      return null;
    },
  };
  win.self = win;
  win.top = opts.framed ? {} : win;
  return { win: win as unknown as Window, posted, listeners, storage, originalOpenCalls };
}

/** A fake element tree: `closest('a[href]')` walks parents like the DOM does. */
interface FakeEl {
  tag: string;
  attrs: Record<string, string>;
  parent: FakeEl | null;
  getAttribute(name: string): string | null;
  closest(sel: string): FakeEl | null;
}

function el(tag: string, attrs: Record<string, string>, parent: FakeEl | null = null): FakeEl {
  const node: FakeEl = {
    tag,
    attrs,
    parent,
    getAttribute: (name) => attrs[name] ?? null,
    closest: (sel) => {
      if (sel !== 'a[href]') return null;
      for (let cur: FakeEl | null = node; cur; cur = cur.parent) {
        if (cur.tag === 'a' && cur.attrs.href !== undefined) return cur;
      }
      return null;
    },
  };
  return node;
}

function click(target: FakeEl, button = 0) {
  let prevented = false;
  const event = {
    button,
    target,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as MouseEvent;
  return { event, wasPrevented: () => prevented };
}

describe('installMcpAppFrameBridge', () => {
  afterEach(() => __resetMcpAppFrameBridgeForTests());

  test('does nothing when not framed (normal browsing)', () => {
    const f = makeFakeWindow({ framed: false, search: '?embed=mcp-app', ancestor: PROD_SANDBOX });
    const before = f.win.open;
    expect(installMcpAppFrameBridge(f.win)).toBe(false);
    expect(isMcpAppFrameBridgeActive()).toBe(false);
    expect(f.listeners).toHaveLength(0);
    expect(f.win.open).toBe(before);
    expect(f.storage.size).toBe(0);
  });

  test('framed + param but parent not allowed: not installed, nothing stored', () => {
    const f = makeFakeWindow({ framed: true, search: '?embed=mcp-app', ancestor: MILADY });
    const before = f.win.open;
    expect(installMcpAppFrameBridge(f.win)).toBe(false);
    expect(isMcpAppFrameBridgeActive()).toBe(false);
    expect(f.listeners).toHaveLength(0);
    expect(f.win.open).toBe(before);
    expect(f.storage.size).toBe(0);
  });

  test('framed + param, parent unknown (no ancestor, no referrer): not installed', () => {
    const f = makeFakeWindow({ framed: true, search: '?embed=mcp-app' });
    expect(installMcpAppFrameBridge(f.win)).toBe(false);
    expect(f.listeners).toHaveLength(0);
    expect(f.storage.size).toBe(0);
  });

  test('framed without the param (Milady): not installed', () => {
    const f = makeFakeWindow({ framed: true, search: '', ancestor: 'https://www.uos.agency' });
    expect(installMcpAppFrameBridge(f.win)).toBe(false);
    expect(f.listeners).toHaveLength(0);
  });

  test('wraps window.open, stores flag + parent, posts an absolute URL to the parent', () => {
    const f = makeFakeWindow({ framed: true, search: '?embed=mcp-app', ancestor: PROD_SANDBOX });
    expect(installMcpAppFrameBridge(f.win)).toBe(true);
    expect(isMcpAppFrameBridgeActive()).toBe(true);
    expect(f.storage.get(MCP_APP_SESSION_KEY)).toBe('mcp-app');
    expect(f.storage.get(MCP_APP_PARENT_SESSION_KEY)).toBe(PROD_SANDBOX);
    expect(f.listeners).toHaveLength(1);
    expect(f.listeners[0]!.type).toBe('click');
    expect(f.listeners[0]!.capture).toBe(true);

    expect(f.win.open('/leaderboard', '_blank', 'noopener,noreferrer')).toBeNull();
    expect(f.posted).toEqual([
      { message: { type: MCP_APP_OPEN_LINK_TYPE, url: `${SELF}/leaderboard` }, origin: PROD_SANDBOX },
    ]);
    expect(f.originalOpenCalls).toHaveLength(0);

    f.win.open('javascript:alert(1)');
    expect(f.posted).toHaveLength(1);

    f.win.open('/same-frame', '_self');
    expect(f.originalOpenCalls).toHaveLength(1);
  });

  test('referrer missing (Firefox reload): installs from the stored verified parent', () => {
    const f = makeFakeWindow({
      framed: true,
      search: '',
      stored: { [MCP_APP_SESSION_KEY]: 'mcp-app', [MCP_APP_PARENT_SESSION_KEY]: STAGING_SANDBOX },
    });
    expect(installMcpAppFrameBridge(f.win)).toBe(true);
    f.win.open('https://x.com/');
    expect(f.posted).toEqual([
      { message: { type: MCP_APP_OPEN_LINK_TYPE, url: 'https://x.com/' }, origin: STAGING_SANDBOX },
    ]);
  });

  test('second install is a no-op (one listener only)', () => {
    const f = makeFakeWindow({ framed: true, search: '?embed=mcp-app', ancestor: PROD_SANDBOX });
    installMcpAppFrameBridge(f.win);
    expect(installMcpAppFrameBridge(f.win)).toBe(true);
    expect(f.listeners).toHaveLength(1);
  });

  test('click listener intercepts target=_blank anchors only', () => {
    const f = makeFakeWindow({ framed: true, search: '?embed=mcp-app', referrer: `${STAGING_SANDBOX}/` });
    expect(installMcpAppFrameBridge(f.win)).toBe(true);
    const onClick = f.listeners[0]!.fn;

    const blank = click(el('a', { href: 'https://x.com/clawville', target: '_BLANK' }));
    onClick(blank.event);
    expect(blank.wasPrevented()).toBe(true);
    expect(f.posted).toEqual([
      { message: { type: MCP_APP_OPEN_LINK_TYPE, url: 'https://x.com/clawville' }, origin: STAGING_SANDBOX },
    ]);

    const same = click(el('a', { href: '/game' }));
    onClick(same.event);
    expect(same.wasPrevented()).toBe(false);

    const mail = click(el('a', { href: 'mailto:a@b.c', target: '_blank' }));
    onClick(mail.event);
    expect(mail.wasPrevented()).toBe(false);

    const middle = click(el('a', { href: 'https://x.com/', target: '_blank' }), 1);
    onClick(middle.event);
    expect(middle.wasPrevented()).toBe(false);

    const plain = click(el('div', {}));
    onClick(plain.event);
    expect(plain.wasPrevented()).toBe(false);
    expect(f.posted).toHaveLength(1);
  });

  test('click on an element nested inside a _blank anchor is intercepted', () => {
    const f = makeFakeWindow({ framed: true, search: '?embed=mcp-app', ancestor: PROD_SANDBOX });
    installMcpAppFrameBridge(f.win);
    const anchor = el('a', { href: '/leaderboard', target: '_blank' });
    const icon = el('svg', {}, el('span', {}, anchor));
    const nested = click(icon);
    f.listeners[0]!.fn(nested.event);
    expect(nested.wasPrevented()).toBe(true);
    expect(f.posted).toEqual([
      { message: { type: MCP_APP_OPEN_LINK_TYPE, url: `${SELF}/leaderboard` }, origin: PROD_SANDBOX },
    ]);
  });
});
