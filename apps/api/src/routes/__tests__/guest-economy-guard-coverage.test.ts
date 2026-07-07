/**
 * GUEST → REAL-CT INVARIANT LOCK (structural).
 *
 * If you add an economy-WRITE route (any route that debits/credits real CT, or
 * becomes a real tournament/land/exchange entrant), add it to MANIFEST below with
 * its guard — or this test fails. This is the forcing function that stops a future
 * route from silently re-opening a guest→real-CT hole (founder ruling 2026-07-06).
 *
 * It READS each route file's SOURCE (never imports the routers — importing
 * land/poker/etc. executes module-load side effects like the fingerprint throw)
 * and asserts the guard name appears in each gated route's middleware chain
 * (between the path literal and the `async` handler).
 *
 * Guests earn DEMO CT only: every real-CT write surface with no demo tier is
 * guarded by the shared `middleware/require-non-guest.ts` (agents always pass, E5).
 * The cove CARD games (blackjack/baccarat/holdem/slots) are intentionally NOT here
 * — they resolve a guest to a DEMO session balance instead of blocking.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTES_DIR = join(import.meta.dir, '..');
const MIDDLEWARE_FILE = join(import.meta.dir, '..', '..', 'middleware', 'require-non-guest.ts');

type Method = 'post' | 'patch' | 'delete';
interface Entry {
  file: string;
  guard: 'requireNonGuestUser' | 'requireNonGuestIdentity';
  routes: Array<{ method: Method; path: string }>;
}

const p = (method: Method, path: string) => ({ method, path });

const MANIFEST: Entry[] = [
  {
    file: 'wager.ts',
    guard: 'requireNonGuestUser',
    routes: [
      p('post', '/lobbies'),
      p('post', '/lobbies/:id/join'),
      p('post', '/lobbies/:id/cancel'),
      p('post', '/lobbies/:id/refund'),
    ],
  },
  {
    file: 'bounties.ts',
    guard: 'requireNonGuestIdentity',
    routes: [
      p('post', '/create'),
      p('post', '/attempts/:attemptId/review'),
      p('post', '/:id/claim'),
      p('post', '/:id/submit'),
      p('post', '/:id/abandon'),
      p('patch', '/:id'),
      p('delete', '/:id'),
    ],
  },
  {
    file: 'exchange.ts',
    guard: 'requireNonGuestIdentity',
    routes: [
      p('post', '/create'),
      p('post', '/:id/order'),
      p('post', '/orders/:orderId/submit'),
      p('post', '/orders/:orderId/confirm'),
      p('post', '/orders/:orderId/cancel'),
      p('post', '/:id/cancel'),
    ],
  },
  {
    file: 'ct-topup.ts',
    guard: 'requireNonGuestIdentity',
    routes: [p('post', '/quote'), p('post', '/settle')],
  },
  {
    file: 'land.ts',
    guard: 'requireNonGuestIdentity',
    routes: [
      p('post', '/claim-starter'),
      p('post', '/parcels/:parcelId/buy'),
      p('post', '/parcels/:parcelId/structure'),
      p('post', '/structures/:structureId/upgrade'),
      p('post', '/parcels/:parcelId/rent'),
      p('post', '/structures/:structureId/services'),
      p('patch', '/services/:listingId'),
      p('post', '/services/:listingId/buy'),
    ],
  },
  {
    file: 'quests.ts',
    guard: 'requireNonGuestUser',
    routes: [p('post', '/:id/accept'), p('post', '/:id/start'), p('post', '/:id/submit')],
  },
  {
    file: 'cove-cash-poker.ts',
    guard: 'requireNonGuestUser',
    routes: [
      p('post', '/tables'),
      p('post', '/tables/join-by-code'),
      p('post', '/tables/:id/sit'),
      p('post', '/tables/:id/leave'),
      p('post', '/tables/:id/action'),
    ],
  },
  {
    file: 'cove-poker-mtt.ts',
    guard: 'requireNonGuestUser',
    routes: [p('post', '/:id/register'), p('post', '/action')],
  },
  {
    file: 'special-events.ts',
    guard: 'requireNonGuestUser',
    routes: [p('post', '/:slug/signup')],
  },
  {
    // Guest SPEND holes (2026-07-07): guests are FULLY demo — no real-CT spend either.
    file: 'items.ts',
    guard: 'requireNonGuestIdentity',
    routes: [p('post', '/buy')],
  },
  {
    file: 'cosmetics.ts',
    guard: 'requireNonGuestUser',
    routes: [p('post', '/:skuId/buy')],
  },
];

const sourceCache = new Map<string, string>();
function readRoute(file: string): string {
  if (!sourceCache.has(file)) {
    sourceCache.set(file, readFileSync(join(ROUTES_DIR, file), 'utf8'));
  }
  return sourceCache.get(file)!;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match the route-registration call for `<method>('<path>', …)` up to the FIRST
// `async` handler — the captured span holds the middleware chain, so we can assert
// the guard name is present in it. `[\s\S]*?` (dotall, non-greedy) spans multi-line
// registrations (e.g. land's `/structures/:structureId/services`).
function routeChainRegex(method: Method, path: string): RegExp {
  return new RegExp('\\.' + method + '\\(\\s*[\'"]' + escapeRegex(path) + '[\'"][\\s\\S]*?async');
}

describe('guest→real-CT guard coverage lock', () => {
  for (const entry of MANIFEST) {
    describe(entry.file, () => {
      for (const route of entry.routes) {
        it(`${route.method.toUpperCase()} ${route.path} is chained with ${entry.guard}`, () => {
          const src = readRoute(entry.file);
          const m = src.match(routeChainRegex(route.method, route.path));
          expect(
            m,
            `${entry.file}: ${route.method.toUpperCase()} ${route.path} route registration not found`,
          ).not.toBeNull();
          expect(
            m![0].includes(entry.guard),
            `${entry.file}: ${route.method.toUpperCase()} ${route.path} is missing the ${entry.guard} guard in its middleware chain`,
          ).toBe(true);
        });
      }
    });
  }

  it('require-non-guest.ts exports the shared guards', () => {
    const mw = readFileSync(MIDDLEWARE_FILE, 'utf8');
    expect(mw).toContain('export async function isGuestUser');
    expect(mw).toContain('export const requireNonGuestUser');
    expect(mw).toContain('export const requireNonGuestIdentity');
  });
});
