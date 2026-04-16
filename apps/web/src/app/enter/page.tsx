/**
 * Phase 5 — magic-link click-through page.
 *
 * Flow: the agent emits a URL like `https://clawville.world/enter?t=sess-xyz`.
 * The human clicks it from their agent chat. This page server-side-redirects
 * the browser straight to `https://api.clawville.world/api/auth/enter?t=...`,
 * where the API atomically consumes the ticket, sets the Lucia session
 * cookie on the API origin, and 302s to `/game` on the web origin.
 *
 * Why a thin redirect instead of a server-to-server fetch? The session
 * cookie has to end up on the USER's browser. A server-to-server call
 * from Next.js to the API would receive the Set-Cookie header in the
 * Next server's response, not the browser's. Proxying it back out
 * would technically work but adds a ceremony layer for no benefit —
 * the browser can follow the 302 directly and the cookie lands
 * natively.
 *
 * This page is a Server Component — rendered once on the server, no
 * client JS bundle, no React hydration. `redirect()` from
 * `next/navigation` throws a RedirectError that Next handles as an
 * HTTP 307, which browsers follow with the exact same method (GET,
 * in our case).
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic'; // never statically prerender this page

interface EnterPageProps {
  searchParams: { t?: string };
}

function resolveApiUrl(): string {
  // NEXT_PUBLIC_API_URL is already baked into the frontend build (it's
  // how the browser-side `fetch` calls find the API). We reuse it here
  // for the server-side redirect. Falls back to the prod URL if unset
  // (matches the fallback pattern in other routes).
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.clawville.world';
  return base.replace(/\/+$/, '');
}

export default function EnterPage({ searchParams }: EnterPageProps) {
  const ticket = searchParams.t;

  if (!ticket) {
    // No ticket → send them to the landing page with the expired-link
    // error copy. Matches what the API does for invalid tickets so the
    // UX is identical whether the ticket was missing, malformed, or
    // already consumed.
    redirect('/?error=expired-link');
  }

  const apiUrl = resolveApiUrl();
  // encodeURIComponent so a ticket with unusual chars survives the
  // redirect intact. base58 output is URL-safe on its own but
  // defensive encoding costs nothing.
  redirect(`${apiUrl}/api/auth/enter?t=${encodeURIComponent(ticket)}`);
}
