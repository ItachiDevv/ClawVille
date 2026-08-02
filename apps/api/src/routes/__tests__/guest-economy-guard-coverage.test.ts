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
 * guarded by the shared `middleware/require-non-guest.ts`. NOTE (2026-07-10): the
 * old "agents always pass, E5" shorthand was WRONG — a guest can own an agent
 * (guest-minted connect-token), so `requireNonGuestIdentity` now also 403s a
 * `kind:'agent'` identity whose bound userId is a guest (see require-non-guest.ts +
 * its unit test). The cove CARD games (blackjack/baccarat/holdem/slots) AND
 * `items.ts /buy` are intentionally NOT in the middleware MANIFEST below — they
 * resolve a guest (human OR guest-owned agent) to a DEMO balance instead of
 * blocking. The demo-resolution surfaces are asserted separately at the bottom of
 * this file so a regression (a guest-owned agent slipping into the real-CT branch)
 * still fails.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTES_DIR = join(import.meta.dir, '..');
const MIDDLEWARE_FILE = join(import.meta.dir, '..', '..', 'middleware', 'require-non-guest.ts');

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Entry {
  file: string;
  guard:
    | 'requireNonGuestUser'
    | 'requireNonGuestIdentity'
    | 'requireWagerCancelCaller'
    | 'requireLedgerCapableIdentity';
  routes: Array<{ method: Method; path: string }>;
}

const p = (method: Method, path: string) => ({ method, path });

const MANIFEST: Entry[] = [
  {
    file: 'wager.ts',
    guard: 'requireNonGuestIdentity',
    routes: [
      p('post', '/lobbies'),
      p('post', '/lobbies/:id/join'),
      p('post', '/lobbies/:id/refund'),
    ],
  },
  {
    file: 'wager.ts',
    guard: 'requireWagerCancelCaller',
    routes: [p('post', '/lobbies/:id/cancel')],
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
      // NOTE: the two disabled tenure stubs (`/parcels/:parcelId/buy`, `…/rent`)
      // are deliberately NOT listed — they are synchronous 409 stubs with no
      // middleware chain, and the span-to-first-`async` matcher would bleed into
      // the NEXT route's chain and falsely bless them (Codex hotfix review,
      // LOW). Their 409 behavior is pinned by land-tenure-phaseb.test.ts.
      p('post', '/claim-starter'),
      p('post', '/parcels/:parcelId/claim-hold'),
      p('post', '/parcels/:parcelId/deposit-topup'),
      p('post', '/parcels/:parcelId/release'),
      p('post', '/parcels/:parcelId/structure'),
      p('post', '/structures/:structureId/upgrade'),
      p('post', '/structures/:structureId/services'),
      p('patch', '/services/:listingId'),
      p('post', '/services/:listingId/buy'),
    ],
  },
  {
    // Ledger-capability lock (2026-08-02 hotfix): every land money mutation must
    // also fail closed on a non-ledger agent session (stale/restored/unproven
    // bearer). Every other money domain (cove, cosmetics, kelp, quests, wager)
    // already chains this guard; land was the gap (Codex land-redesign round 3,
    // finding 29). `/spawn-preference` is included per the Codex hotfix review
    // (MEDIUM): no money moves, but it persistently rewrites the bound avatar's
    // spawn state — same convention as the free cosmetic equip routes.
    file: 'land.ts',
    guard: 'requireLedgerCapableIdentity',
    routes: [
      p('post', '/claim-starter'),
      p('post', '/parcels/:parcelId/claim-hold'),
      p('post', '/parcels/:parcelId/deposit-topup'),
      p('post', '/parcels/:parcelId/release'),
      p('post', '/parcels/:parcelId/structure'),
      p('post', '/structures/:structureId/upgrade'),
      p('post', '/spawn-preference'),
      p('post', '/structures/:structureId/services'),
      p('patch', '/services/:listingId'),
      p('post', '/services/:listingId/buy'),
    ],
  },
  {
    file: 'quests.ts',
    guard: 'requireNonGuestIdentity',
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
  // NOTE: items.ts /buy is DELIBERATELY NOT here. The 2026-07-06 all-demo ruling
  // SUPERSEDED the 2026-07-07 requireNonGuestIdentity-403 on /buy: a guest now BUYS
  // on demo CT (in-handler demo branch, like the cove card games), never a 403. Its
  // guest-OWNED-agent safety is asserted by the demo-resolution source check below.
  {
    file: 'cosmetics.ts',
    guard: 'requireNonGuestIdentity',
    routes: [p('post', '/:skuId/buy')],
  },
  {
    // Latent hardening (2026-07-08): EVERY SAP write route does a custodial
    // on-chain sign from the caller's wallet — register/publish/feedback and
    // attestation write PDAs, escrow moves value — so a guest (fully-demo,
    // wallet-less) must never reach ANY of them. Masked today by the
    // SAP_ENABLED/SAP_ESCROW_ENABLED 503 gates, but guarded now so ungating
    // can never silently re-open the hole. (Codex round-1 flagged that
    // register/publish/feedback are custodial on-chain writes too, not mere
    // reputation metadata — so they are guarded, not carved out.)
    file: 'sap.ts',
    guard: 'requireNonGuestIdentity',
    routes: [
      p('post', '/register'),
      p('post', '/tools/publish'),
      p('post', '/feedback'),
      p('post', '/attestation'),
      p('post', '/attestation/revoke'),
      p('post', '/escrow/stake'),
      p('post', '/escrow/deposit-stake'),
      p('post', '/escrow/create'),
      p('post', '/escrow/deposit'),
      p('post', '/escrow/settle'),
      p('post', '/escrow/withdraw'),
      p('post', '/escrow/close'),
      p('post', '/escrow/usdc/open'),
      p('post', '/escrow/usdc/submit'),
      p('post', '/escrow/usdc/approve'),
      p('post', '/escrow/usdc/settle'),
      p('post', '/escrow/usdc/refund'),
    ],
  },
  {
    // Latent hardening (2026-07-08): a partner storefront purchase settles USDC
    // from the buyer's own custodial wallet — a guest (wallet-less, fully-demo)
    // must never reach the quote/settle path. Masked today by the always-503
    // partner_fulfillment_gated gate; guarded now so ungating stays honest.
    file: 'partner-storefront.ts',
    guard: 'requireNonGuestIdentity',
    routes: [p('post', '/quote'), p('post', '/settle')],
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

  describe('cosmetic guest + agent read parity', () => {
    for (const path of ['/:skuId/equip', '/:skuId/unequip']) {
      it(`POST ${path} preserves the authenticated guest happy path`, () => {
        const chain = readRoute('cosmetics.ts').match(routeChainRegex('post', path));
        expect(chain).not.toBeNull();
        expect(chain![0]).toContain('requireAuthOrAgentSession');
        expect(chain![0]).toContain('requireLedgerCapableIdentity');
        expect(chain![0]).not.toContain('requireNonGuestIdentity');
      });
    }

    it('GET /owned accepts a live ledger-capable agent identity', () => {
      const chain = readRoute('cosmetics.ts').match(routeChainRegex('get', '/owned'));
      expect(chain).not.toBeNull();
      expect(chain![0]).toContain('requireAuthOrAgentSession');
      expect(chain![0]).toContain('requireLedgerCapableIdentity');
      expect(chain![0]).not.toContain('requireNonGuestIdentity');
    });
  });

  // ── Demo-resolution surfaces (2026-07-10): a guest-OWNED agent must be treated
  // as a guest, NOT settle real CT — on the paths that resolve guests to a demo
  // balance instead of 403ing. These bypass requireNonGuestIdentity/ledgerCapable,
  // so they carry their own guest check. Source-level lock (mirrors the cove-guest
  // -demo-routing convention) so removing the agent branch fails here. ──
  describe('guest-owned-agent demo-resolution locks', () => {
    it("items.ts /buy demo-classifies a guest-OWNED agent (not just kind:'user')", () => {
      const src = readRoute('items.ts');
      // The demo `isGuest` classifier must include the agent kind, else a
      // guest-owned agent falls through to the real-CT debit + house-treasury.
      expect(
        src.includes("identity.kind === 'agent'") && src.includes('isGuestUser(userId)'),
        'items.ts /buy no longer routes a guest-owned agent to the demo branch',
      ).toBe(true);
    });

    it('building-reward.ts skips the REAL-CT building reward for a guest owner', () => {
      const src = readFileSync(
        join(import.meta.dir, '..', '..', 'services', 'building-reward.ts'),
        'utf8',
      );
      // resolveAvatarIdForBot must consult users.isGuest and return null for a
      // guest owner (both /visit-building + /building/:id/chat then skip the credit).
      expect(
        src.includes('isGuest') && src.includes('return null'),
        'building-reward.ts resolveAvatarIdForBot no longer gates guest owners off the real-CT credit',
      ).toBe(true);
    });

    it('resolveAgentSession demotes a guest-owned session to non-ledger', () => {
      const src = readFileSync(
        join(import.meta.dir, '..', '..', 'middleware', 'require-auth-or-agent.ts'),
        'utf8',
      );
      // The keystone: a session whose bound user is a guest must lose ledger
      // capability so every `!ledgerCapable` 403 (cove ×6, special-events, x402)
      // fires. Assert the guest lookup sets ledgerCapable = false.
      const demoted =
        /owner\??\.isGuest[\s\S]{0,60}ledgerCapable = false/.test(src) ||
        (src.includes('isGuest') && src.includes('ledgerCapable = false'));
      expect(
        demoted,
        'resolveAgentSession no longer demotes a guest-owned session to non-ledger',
      ).toBe(true);
    });

    it('connect-token 403s a guest at the source', () => {
      const src = readRoute('agent-gateway.ts');
      // Defense-in-depth: a guest must not be able to MINT a connect-token, so it
      // can never bind a ledger-capable agent to its guest userId in the first place.
      const m = src.match(/post\('\/connect-token'[\s\S]*?guest_not_allowed/);
      expect(
        m,
        'agent-gateway.ts /connect-token no longer blocks a guest (guest_not_allowed) at the source',
      ).not.toBeNull();
    });
  });
});
