import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DASHBOARD_RESOURCE_URI,
  USEPOD_BALANCE_PATH,
  claudeSandboxDomain,
  dashboardCalls,
  dashboardResourceContent,
  dashboardSummary,
  gameUrlForApiBase,
  type DashboardData,
} from '../mcp-app/dashboard';
import { EXT_APPS_SDK_URL, buildDashboardViewHtml } from '../mcp-app/dashboard-view';

const ROUTES = join(import.meta.dir, '..', '..', 'routes');
const INDEX = readFileSync(join(import.meta.dir, '..', '..', 'index.ts'), 'utf8');

describe('Claude sandbox domain', () => {
  test('matches the documented example and both ClawVille MCP URLs', () => {
    expect(claudeSandboxDomain('https://example.com/mcp')).toBe('c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com');
    expect(claudeSandboxDomain('https://api.clawville.world/api/agent/mcp')).toBe('fbbf4fac72ecb46c1810ee8a4f3bb886.claudemcpcontent.com');
    expect(claudeSandboxDomain('https://api-staging.clawville.world/api/agent/mcp')).toBe('b1bb7d1e416a979f53eac06556dc647b.claudemcpcontent.com');
  });

  test('the resource content item carries the domain of the serving API base', () => {
    expect(dashboardResourceContent('https://api.clawville.world')._meta.ui.domain).toBe('fbbf4fac72ecb46c1810ee8a4f3bb886.claudemcpcontent.com');
    expect(dashboardResourceContent('https://api-staging.clawville.world')._meta.ui.domain).toBe('b1bb7d1e416a979f53eac06556dc647b.claudemcpcontent.com');
    expect(dashboardResourceContent('https://api.clawville.world').uri).toBe(DASHBOARD_RESOURCE_URI);
  });

  test('game URL per API base', () => {
    expect(gameUrlForApiBase('https://api.clawville.world')).toBe('https://clawville.world/game');
    expect(gameUrlForApiBase('https://api-staging.clawville.world')).toBe('https://staging.clawville.world/game');
    expect(gameUrlForApiBase('http://localhost:4001')).toBe('http://localhost:3000/game');
  });
});

describe('dashboard view HTML', () => {
  const html = buildDashboardViewHtml('https://staging.clawville.world/game');

  test('has no HTML-string DOM sink and no eval', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc']) {
      expect({ sink, found: html.includes(sink) }).toEqual({ sink, found: false });
    }
    expect(html).toContain('textContent');
  });

  test('never reads the tool arguments (the model may pass the sessionId there)', () => {
    expect(html).not.toContain('ontoolinput');
    expect(html).not.toContain('sessionId');
  });

  test('loads only the pinned SDK and makes no network call of its own', () => {
    const scriptSrcs = [...html.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    expect(new Set(scriptSrcs.filter((u) => !u.includes('clawville.world')))).toEqual(new Set([EXT_APPS_SDK_URL]));
    expect(EXT_APPS_SDK_URL).toMatch(/@modelcontextprotocol\/ext-apps@\d+\.\d+\.\d+\//);
    for (const net of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon']) expect(html).not.toContain(net);
  });

  test('refresh uses the app-only tool with the view token; links go through openLink', () => {
    expect(html).toContain('app.callServerTool({ name: cfg.refreshTool, arguments: { viewToken } })');
    expect(html).toContain('app.openLink({ url })');
    expect(html).toContain('"refreshTool":"clawville_dashboard_refresh"');
  });

  test('forwards clawville:open-link only from the game origin', () => {
    expect(html).toContain('"gameOrigin":"https://staging.clawville.world"');
    expect(html).toContain('if (event.origin !== cfg.gameOrigin) return;');
    expect(html).toContain('data.type !== "clawville:open-link"');
  });

  test('buttons are at least 44px', () => {
    expect(html).toMatch(/button \{[^}]*min-height: 44px/);
  });

  test('the page config cannot close its script element', () => {
    const evil = buildDashboardViewHtml('https://clawville.world/game?x=</script><script>alert(1)</script>');
    expect(evil).not.toContain('</script><script>alert(1)');
  });
});

describe('dashboard sub-requests use existing routes', () => {
  const session = { sessionId: 'sid-1', agentId: 'agent-1' };
  const routeExists = (file: string, method: string, literal: string) =>
    readFileSync(join(ROUTES, file), 'utf8').includes(`.${method}(${literal}`);

  test('each call maps to a mounted route', () => {
    const paths = dashboardCalls(session).map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(paths).toEqual([
      'GET /api/agent/session-status',
      'GET /api/agent/wallet',
      'GET /api/wallet/balances',
      'GET /api/wallet/spend-policy',
      'GET /api/agent-ai',
    ]);
    expect(routeExists('agent-gateway.ts', 'get', "'/session-status'")).toBe(true);
    expect(routeExists('agent-gateway.ts', 'get', "'/wallet'")).toBe(true);
    expect(routeExists('wallet-withdraw.ts', 'get', "'/balances'")).toBe(true);
    expect(routeExists('spend-policy.ts', 'get', "'/'")).toBe(true);
    expect(routeExists('agent-ai.ts', 'get', "'/'")).toBe(true);
    expect(routeExists('agent-ai.ts', 'get', "'/usepod/balance'")).toBe(true);
    expect(USEPOD_BALANCE_PATH).toBe('/api/agent-ai/usepod/balance');
    expect(INDEX).toContain("app.route('/api/wallet/spend-policy', spendPolicyRoutes)");
    expect(INDEX).toContain("app.route('/api/agent-ai', agentAiRoutes)");
  });

  test('wallet read is scoped by the session; status by the agentId', () => {
    const [status, wallet] = dashboardCalls(session);
    expect(status!.path).toBe('/api/agent/session-status?agentId=agent-1');
    expect(wallet!.path).toBe('/api/agent/wallet?sessionId=sid-1');
  });
});

describe('dashboard text', () => {
  const base: DashboardData = {
    generatedAt: '2026-11-11T00:00:00.000Z',
    agent: { agentId: 'agent-1', avatarName: null, connected: false, humanControlled: false, sessionExpiresAt: null },
    wallet: { address: null, vclaw: null, sol: null, usdc: null, clv: null, unavailable: 'Not available (status 404).' },
    spendRules: { unavailable: 'Not available (status 500).' },
    ownAi: { unavailable: 'Not available (status 403, ledger_capability_required).' },
    links: { game: 'https://clawville.world/game' },
    nextSteps: ['Call clawville_connect again with the same agentId and identityKey.'],
  };

  test('every section has a line even when it did not load', () => {
    const text = dashboardSummary(base);
    expect(text.split('\n')).toEqual([
      'ClawVille dashboard (agent agent-1).',
      'Status: not connected.',
      'Wallet: n/a vCLAW, n/a USDC, n/a SOL, n/a CLV. Not available (status 404).',
      'Spend rules: Not available (status 500).',
      'Agent AI: Not available (status 403, ledger_capability_required).',
      'Game: https://clawville.world/game',
      'Next: Call clawville_connect again with the same agentId and identityKey.',
    ]);
  });
});
