/**
 * /game route — force dynamic rendering.
 *
 * Why this file exists: page.tsx is 'use client', so Next.js sees no
 * server-side data fetching and treats the HTML shell as STATIC. Static
 * pages get `Cache-Control: s-maxage=31536000, stale-while-revalidate`
 * — Cloudflare then edge-caches the HTML for a YEAR. Every deploy ships
 * a new chunk graph (immutable, content-hashed) but the cached HTML
 * still references the OLD chunk filenames. Hard refresh on the browser
 * doesn't bust Cloudflare; users see stale code indefinitely.
 *
 * The fix: a server-component layout wrapping the route that exports
 * `dynamic = 'force-dynamic'`. Next.js drops the page from the SSG/ISR
 * path and returns `Cache-Control: no-store` (or similar
 * non-edge-cacheable headers). Edge caches stop caching, hard refresh
 * works, every build shows up immediately.
 *
 * Verified live 2026-04-26: HTML response had `s-maxage=31536000` →
 * users were stuck on 5+-hour-old chunk graphs even with hard refresh.
 */
export const dynamic = 'force-dynamic';

export default function GameLayout({ children }: { children: React.ReactNode }) {
  return children;
}
