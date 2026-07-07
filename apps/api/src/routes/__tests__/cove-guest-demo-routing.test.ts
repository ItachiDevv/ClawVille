/**
 * GUEST ACCOUNT → DEMO COVE SUBJECT — structural forcing-function test.
 *
 * Founder ruling 2026-07-06: the guest economy is FULLY DEMO. A guest ACCOUNT
 * (an `is_guest` Lucia user) has a real cookie + avatar + 100-CT SOFT balance,
 * so before this fix each cove card game's `getSubject` resolved it straight
 * to `kind:'user'` and settled REAL CT on that balance — a founder-ruling
 * violation. The fix routes a guest account to the SAME demo `kind:'guest'`
 * subject an anonymous visitor gets (session/shoe demo balance, ZERO ledger),
 * checked via the shared `isGuestUser()` helper BEFORE the real-CT `kind:'user'`
 * return. NOT a 403 — guests keep playing the Cove for fun on demo CT (that is
 * why the cove games are intentionally EXCLUDED from
 * `guest-economy-guard-coverage.test.ts`'s block-guard MANIFEST — they demote
 * to demo, they do not 403).
 *
 * This test READS each route file's SOURCE (readFileSync) and never imports
 * the routers — importing land/cove/etc. executes module-load side effects
 * like the fingerprint-secret throw. Mirrors the readFileSync + regex
 * approach in `guest-economy-guard-coverage.test.ts`.
 *
 * Reverting the fix in ANY of the 4 files (removing the `isGuestUser` import,
 * or removing/reordering the guest-account check inside `getSubject`'s
 * `if (user) { ... }` block) fails the corresponding assertion below.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTES_DIR = join(import.meta.dir, '..');

const MANIFEST: string[] = ['cove-slots.ts', 'cove-blackjack.ts', 'cove-baccarat.ts', 'cove-holdem.ts'];

const sourceCache = new Map<string, string>();
function readRoute(file: string): string {
  if (!sourceCache.has(file)) {
    sourceCache.set(file, readFileSync(join(ROUTES_DIR, file), 'utf8'));
  }
  return sourceCache.get(file)!;
}

// Captures everything between `if (user) {` (inside getSubject's signature
// scope) and the real-CT `return { kind: 'user'` that follows it. Anchoring on
// the `async function getSubject(c: {` preamble first keeps this from ever
// matching an unrelated `if (user) {` elsewhere in the file (there is exactly
// one `if (user) {` per file today, but the anchor makes the intent explicit
// and keeps the test robust if that ever changes).
const USER_BRANCH_RE = /async function getSubject\(c: \{[\s\S]*?if \(user\) \{([\s\S]*?)return \{ kind: 'user'/;

describe('cove guest-account → demo-subject routing lock', () => {
  for (const file of MANIFEST) {
    describe(file, () => {
      it('imports isGuestUser from the shared require-non-guest middleware', () => {
        const src = readRoute(file);
        expect(src).toContain("import { isGuestUser } from '../middleware/require-non-guest';");
      });

      it("getSubject's if(user) branch checks isGuestUser BEFORE returning kind:'user'", () => {
        const src = readRoute(file);
        const m = src.match(USER_BRANCH_RE);
        expect(m, `${file}: could not locate getSubject's if(user){...}return kind:'user' span`).not.toBeNull();

        const guardedSpan = m![1];
        expect(
          guardedSpan.includes('isGuestUser('),
          `${file}: if(user) branch does not call isGuestUser(...) before the real-CT kind:'user' return`,
        ).toBe(true);

        // A guest account must be demoted to the SAME demo subject an anonymous
        // visitor gets — either via the shared `guestDemoSubject(` constructor
        // or an inline `kind: 'guest'` return. Either satisfies "demoted to
        // demo, not routed to real-CT".
        const demotesToDemo = guardedSpan.includes('guestDemoSubject(') || guardedSpan.includes("kind: 'guest'");
        expect(
          demotesToDemo,
          `${file}: if(user) branch does not demote a guest account to the demo kind:'guest' subject`,
        ).toBe(true);
      });

      it('getSubject does NOT 403 a guest account (guests keep playing on demo CT)', () => {
        const src = readRoute(file);
        const m = src.match(USER_BRANCH_RE);
        expect(m).not.toBeNull();
        const guardedSpan = m![1];
        expect(
          /HTTPException\(403/.test(guardedSpan),
          `${file}: if(user) branch throws a 403 for a guest account — guests must be demoted to demo, not blocked`,
        ).toBe(false);
      });
    });
  }

  it('the shared guestDemoSubject(...) constructor exists in every file (DRY demo-subject path)', () => {
    for (const file of MANIFEST) {
      const src = readRoute(file);
      expect(src, `${file}: missing the shared guestDemoSubject(...) helper`).toContain('function guestDemoSubject(');
      // Both the guest-account case (inside if(user)) and the anonymous-visitor
      // fall-through at the bottom of getSubject call the SAME constructor —
      // asserts there are at least 2 call sites (definition excluded by the
      // `function guestDemoSubject(` signature not matching a call).
      const callSites = (src.match(/guestDemoSubject\(c\)/g) ?? []).length;
      expect(callSites, `${file}: expected guestDemoSubject(c) to be called at least twice (guest-account case + anonymous fall-through)`).toBeGreaterThanOrEqual(2);
    }
  });
});
