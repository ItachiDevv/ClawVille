import { describe, expect, it } from 'bun:test';
import {
  CLAWPUMP_DASHBOARD_URL,
  TRADING_AGENT_TEMPLATES,
  TRADING_TEMPLATE_MODEL,
  TRADING_TEMPLATE_SKILLS,
  TRADING_TEMPLATE_VERSION,
} from '@clawville/shared';
import { tradingFloorRoutes } from '../trading-floor';

/** The route is mounted at /api/floor, so the router itself answers /templates.
 *  `request` is typed `Response | Promise<Response>`, so always await it. */
const get = async (headers: Record<string, string> = {}): Promise<Response> =>
  await tradingFloorRoutes.request('/templates', { headers });

describe('GET /api/floor/templates', () => {
  it('serves the five templates with no authentication', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown> & { templates: unknown[] };
    expect(body).toEqual({
      version: TRADING_TEMPLATE_VERSION,
      model: TRADING_TEMPLATE_MODEL,
      skills: [...TRADING_TEMPLATE_SKILLS],
      dashboardUrl: CLAWPUMP_DASHBOARD_URL,
      templates: JSON.parse(JSON.stringify(TRADING_AGENT_TEMPLATES)),
    });
    expect(body.templates).toHaveLength(5);
    // `toEqual` through a JSON round trip would also pass if the route dropped
    // a key that stringifies to undefined, so pin the key set explicitly.
    expect(Object.keys(body).sort()).toEqual([
      'dashboardUrl', 'model', 'skills', 'templates', 'version',
    ]);
    expect(Object.keys(body.templates[0] as object).sort()).toEqual([
      'displayName', 'guardrailNotes', 'objective', 'personaText', 'suggestedModel', 'suggestedSkills',
    ]);
  });

  it('is publicly cacheable rather than private', async () => {
    const response = await get();
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('never attaches a cookie to a publicly cacheable response', async () => {
    // LOAD BEARING. The route is mounted BEFORE the router's sessionMiddleware,
    // which appends Set-Cookie whenever Lucia refreshes a fresh session or
    // blanks an invalid one. With `Cache-Control: public`, a shared cache could
    // otherwise store one visitor's session cookie and serve it to the next.
    // A cookie here means someone moved the route below the middleware.
    const response = await get({ Cookie: 'auth_session=not-a-real-session-id' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    // Closes the loop: the response is still the publicly cacheable one, so
    // this is genuinely the dangerous combination and not a weaker variant.
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('serves a guest, a human and an agent session identical bytes', async () => {
    // Parity for a READ surface: no subject is resolved, so no caller can be
    // locked out and no caller sees a different world than another.
    const anonymous = await (await get()).text();
    const agent = await (await get({ 'X-Clawville-Agent-Session': 'oc-not-a-real-session' })).text();
    expect(agent).toBe(anonymous);
  });

  // LAST in the file on purpose. `templatesLimiter` is module level and the CI
  // routes lane runs every file in this directory in ONE bun process, so these
  // 60 tokens are spent for the whole lane. They are keyed to an address no
  // other test uses; the cases above spend 5 on the 'unknown' key. Any future
  // test that calls this route must budget against the same two buckets.
  it('rate limits one IP after 60 calls in the window', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    let last = await get(headers);
    // The first call above already consumed one token in this window.
    for (let call = 1; call < 60; call += 1) last = await get(headers);
    expect(last.status).toBe(200);
    const limited = await get(headers);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: 'Too many template requests.',
      code: 'rate_limited',
    });
  });
});
