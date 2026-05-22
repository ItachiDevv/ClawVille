/**
 * Reset-password page lives at a URL like /reset-password?token=<raw-32-bytes-hex>.
 * The raw token is in the query string and MUST NOT leak via Referer when the
 * page (or LandingScene) makes any outbound resource request. The API leg
 * already sets `Referrer-Policy: no-referrer` on its 302; this is the matching
 * defense-in-depth for the web hop (adversary M2, 2026-05-22). If anyone
 * later adds analytics, Sentry, CDN fonts, or any cross-origin asset to this
 * route's tree, the token still cannot leak to those origins.
 */
export const metadata = {
  other: { referrer: 'no-referrer' },
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
