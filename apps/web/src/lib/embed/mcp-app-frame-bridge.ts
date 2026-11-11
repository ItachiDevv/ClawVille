/**
 * Claude MCP App frame bridge.
 *
 * Claude can show ClawVille inside an MCP App view: claude.ai frames a
 * sandbox host (`<sha256(serverUrl)[0:32]>.claudemcpcontent.com`), and the
 * view on that host frames our page with `?embed=mcp-app`. Inside that
 * sandbox `window.open()` and `<a target="_blank">` do nothing and
 * `confirm()` always returns false.
 *
 * The bridge installs ONLY when all of these hold:
 *   1. the page is framed,
 *   2. the mode is requested (`embed=mcp-app` in the URL, or the flag a
 *      verified earlier load stored in sessionStorage for this tab),
 *   3. the parent origin resolves to an entry of MCP_APP_PARENT_ORIGINS
 *      (`location.ancestorOrigins[0]`, else the `document.referrer` origin,
 *      else the parent origin a verified earlier load stored for this tab).
 * When installed, every new-tab open becomes a
 * `{ type: 'clawville:open-link', url }` postMessage to that parent origin.
 * The view checks `event.origin` and calls `ui/open-link`.
 *
 * In every other context (normal browsing, Milady / uOS embeds even with a
 * stray `?embed=mcp-app`) the bridge does nothing: no listeners, no
 * `window.open` wrap, no storage write.
 *
 * The CSP side lives in `apps/web/next.config.mjs` (FRAME_ANCESTORS).
 * Docs: ARCHITECTURE.md, Last Audited 2026-11-11 entry.
 */

/**
 * Exact parent origins that may receive our open-link messages. Never a
 * `*.claudemcpcontent.com` wildcard: each sandbox host is derived from one
 * MCP server URL.
 *   - claude.ai
 *   - prod sandbox:    sha256("https://api.clawville.world/api/agent/mcp")[0:32]
 *   - staging sandbox: sha256("https://api-staging.clawville.world/api/agent/mcp")[0:32]
 */
export const MCP_APP_PARENT_ORIGINS: readonly string[] = [
  'https://claude.ai',
  'https://fbbf4fac72ecb46c1810ee8a4f3bb886.claudemcpcontent.com',
  'https://b1bb7d1e416a979f53eac06556dc647b.claudemcpcontent.com',
];

export const MCP_APP_EMBED_PARAM = 'embed';
export const MCP_APP_EMBED_VALUE = 'mcp-app';
export const MCP_APP_OPEN_LINK_TYPE = 'clawville:open-link';
/** sessionStorage: mode flag, written only after a parent origin was verified. */
export const MCP_APP_SESSION_KEY = 'clawville:embed-mode';
/** sessionStorage: the verified parent origin, reused when a reload has no referrer. */
export const MCP_APP_PARENT_SESSION_KEY = 'clawville:embed-parent';

export interface McpAppOpenLinkMessage {
  type: typeof MCP_APP_OPEN_LINK_TYPE;
  url: string;
}

function isAllowedParent(origin: string | null | undefined): origin is string {
  return typeof origin === 'string' && MCP_APP_PARENT_ORIGINS.includes(origin);
}

function originOf(value: string): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Pure: the parent origin the bridge posts to, or null when the bridge must
 * stay off. See the module comment for the three conditions.
 *
 * Parent resolution order:
 *   - `ancestorOrigins[0]` when the browser gives it (Chromium, Safari). It is
 *     authoritative: a non-allowed value means "not Claude", full stop.
 *   - the `document.referrer` origin when it is a foreign origin. A foreign,
 *     non-allowed referrer means "not Claude".
 *   - no referrer (Firefox reload, referrer policy) or a same-origin referrer
 *     (navigation inside the frame): the parent origin stored by a verified
 *     earlier load in this tab, if any.
 */
export function resolveMcpAppParent(input: {
  framed: boolean;
  search: string;
  selfOrigin: string;
  storedMode: string | null;
  storedParent: string | null;
  ancestorOrigins: readonly string[] | null;
  referrer: string;
}): string | null {
  if (!input.framed) return null;
  let param: string | null = null;
  try {
    param = new URLSearchParams(input.search).get(MCP_APP_EMBED_PARAM);
  } catch {
    param = null;
  }
  const storedVerified = input.storedMode === MCP_APP_EMBED_VALUE;
  if (param !== MCP_APP_EMBED_VALUE && !storedVerified) return null;

  const ancestor = input.ancestorOrigins?.[0];
  if (ancestor) return isAllowedParent(ancestor) ? ancestor : null;

  const referrerOrigin = originOf(input.referrer);
  if (referrerOrigin && referrerOrigin !== input.selfOrigin) {
    return isAllowedParent(referrerOrigin) ? referrerOrigin : null;
  }

  return storedVerified && isAllowedParent(input.storedParent) ? input.storedParent : null;
}

/** Pure: resolve a URL against `base`. Returns the absolute URL for http(s) only. */
export function normalizeOpenUrl(raw: string | URL | null | undefined, base: string): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw.trim() : raw.href;
  if (text === '') return null;
  try {
    const url = new URL(text, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function isFramed(win: Window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    // Cross-origin access to `top` threw: we are framed.
    return true;
  }
}

function readSession(win: Window, key: string): string | null {
  try {
    return win.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(win: Window, key: string, value: string): void {
  try {
    win.sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked in the sandbox: the bridge still holds for this JS context.
  }
}

function ancestorOriginsOf(win: Window): string[] | null {
  try {
    const list = win.location.ancestorOrigins;
    if (!list) return null;
    return Array.from(list);
  } catch {
    return null;
  }
}

let activeParentOrigin: string | null = null;

/** True when the bridge is installed in this JS context (a verified Claude parent). */
export function isMcpAppFrameBridgeActive(): boolean {
  return activeParentOrigin !== null;
}

/**
 * Install the bridge once per JS context. Returns true when the bridge is
 * active (now or from an earlier call). Does nothing outside a verified
 * Claude MCP App frame.
 */
export function installMcpAppFrameBridge(win: Window = window): boolean {
  if (activeParentOrigin !== null) return true;
  const parentOrigin = resolveMcpAppParent({
    framed: isFramed(win),
    search: win.location.search,
    selfOrigin: win.location.origin,
    storedMode: readSession(win, MCP_APP_SESSION_KEY),
    storedParent: readSession(win, MCP_APP_PARENT_SESSION_KEY),
    ancestorOrigins: ancestorOriginsOf(win),
    referrer: win.document.referrer,
  });
  if (!parentOrigin) return false;
  activeParentOrigin = parentOrigin;
  writeSession(win, MCP_APP_SESSION_KEY, MCP_APP_EMBED_VALUE);
  writeSession(win, MCP_APP_PARENT_SESSION_KEY, parentOrigin);

  const postOpenLink = (rawUrl: string | URL | null | undefined): void => {
    const url = normalizeOpenUrl(rawUrl, win.location.href);
    if (!url) return;
    const message: McpAppOpenLinkMessage = { type: MCP_APP_OPEN_LINK_TYPE, url };
    win.parent.postMessage(message, parentOrigin);
  };

  const originalOpen = win.open.bind(win);
  win.open = ((url?: string | URL, target?: string, features?: string): Window | null => {
    // A same-frame navigation still works inside the sandbox.
    if (target === '_self') return originalOpen(url, target, features);
    postOpenLink(url);
    return null;
  }) as typeof win.open;

  win.document.addEventListener(
    'click',
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      const anchor = target && typeof target.closest === 'function'
        ? (target.closest('a[href]') as HTMLAnchorElement | null)
        : null;
      if (!anchor) return;
      if ((anchor.getAttribute('target') ?? '').toLowerCase() !== '_blank') return;
      const href = anchor.getAttribute('href');
      if (!normalizeOpenUrl(href, win.location.href)) return;
      event.preventDefault();
      postOpenLink(href);
    },
    true,
  );

  return true;
}

/** Test-only: reset the once-per-context guard. */
export function __resetMcpAppFrameBridgeForTests(): void {
  activeParentOrigin = null;
}
