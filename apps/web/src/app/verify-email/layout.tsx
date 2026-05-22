/**
 * Verify-email bouncer lives at /verify-email?token=<raw-32-bytes-hex>.
 * Same Referer-leakage concern as /reset-password — the raw verify token
 * is in the query string, and the page reads it client-side before
 * navigating to the API GET endpoint. The API leg already sets
 * `Referrer-Policy: no-referrer` on its redirects; this matches that
 * defense for the web hop so the token can't leak via Referer if anyone
 * later adds cross-origin resources to the route tree (adversary M2,
 * 2026-05-22).
 */
export const metadata = {
  other: { referrer: 'no-referrer' },
};

export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
