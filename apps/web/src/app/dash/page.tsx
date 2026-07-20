/**
 * Internal admin dashboard — /dash
 *
 * Server-rendered, no client state, 10-minute meta-refresh. Admin-gated via
 * the upstream /api/dashboard/* routes (ADMIN_USER_IDS env allowlist).
 *
 * Five tabs (Q3 plan §gamification dashboard):
 *
 *   ?tab=overview        — DAU + funnel + retention + collab metrics (the
 *                          original "is the leaderboard thesis working" view)
 *   ?tab=tokens          — score weights + daily caps + bundle tiers + CLV
 *                          mint info + treasury balances
 *   ?tab=quests          — 10 tutorial quests with claim counts + backend
 *                          admin-curated quests
 *   ?tab=cosmetics       — catalog grid w/ thumbnails (or category icon
 *                          fallback), variant counts, license attribution
 *   ?tab=phases          — Q3 plan phase status, mutable via the dashboard
 *                          MCP server (tools/dashboard-mcp/)
 *
 * Tab state via search param so links are shareable. Each tab is its own
 * server component file under ./tabs/*.tsx; the shell here just dispatches.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import OverviewTab from './tabs/overview';
import TokenEconomyTab from './tabs/token-economy';
import QuestsTab from './tabs/quests';
import CosmeticsTab from './tabs/cosmetics';
import PhasesTab from './tabs/phases';
import { AutonomyStatus } from './AutonomyStatus';
import type { AutonomyDashboardState } from './AutonomyStatus';

export const dynamic = 'force-dynamic';

/**
 * Top-level auth gate. Server-side checks /api/dashboard/__check before
 * rendering ANY dashboard chrome (tab nav, Brand Identity banner, tab
 * content). On 401/403, redirect to /dash/login so reviewers without a
 * Lucia admin session can authenticate via the shared password.
 *
 * Per-tab data fetches inside each tab component still handle 401/403
 * gracefully as a defensive fallback (e.g. cookie expired mid-session),
 * but the primary auth surface is here.
 */
async function ensureDashAuthOrRedirect(): Promise<void> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) {
    // Dev / mis-configured env — let the page render so the operator can
    // see the original "NEXT_PUBLIC_API_URL is not configured" message
    // from the tabs.
    return;
  }
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  // CRITICAL: `redirect()` from next/navigation throws an internal
  // NEXT_REDIRECT error that the framework catches at the route boundary.
  // It MUST NOT be inside a try/catch that swallows generic errors —
  // otherwise the redirect silently fails. We isolate the fetch in its
  // own try/catch (network errors only) and call redirect AFTER, so the
  // NEXT_REDIRECT error propagates cleanly.
  let status = 0;
  try {
    const res = await fetch(`${apiBase}/api/dashboard/__check`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    status = res.status;
  } catch {
    // Network error to API — render the page; tabs will show their own
    // "Fetch failed" cards.
    return;
  }
  if (status === 401 || status === 403) {
    redirect('/dash/login');
  }
}

async function fetchAutonomyState(): Promise<{
  state: AutonomyDashboardState | null;
  error: string | null;
}> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) {
    return { state: null, error: 'NEXT_PUBLIC_API_URL is not configured.' };
  }

  const cookieStore = await cookies();
  try {
    const response = await fetch(`${apiBase}/api/dashboard/autonomy`, {
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
    });
    if (response.status === 401) {
      return { state: null, error: 'Not authenticated. Sign in as an admin first.' };
    }
    if (response.status === 403) {
      return { state: null, error: 'Your account is not in ADMIN_USER_IDS.' };
    }
    if (!response.ok) {
      return { state: null, error: `Autonomy status returned ${response.status}.` };
    }
    return { state: (await response.json()) as AutonomyDashboardState, error: null };
  } catch (caught) {
    return {
      state: null,
      error: `Autonomy status fetch failed: ${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }
}

const TABS = [
  { id: 'overview',  label: 'Overview',       hint: 'DAU · funnel · collab' },
  { id: 'tokens',    label: 'Token Economy',  hint: 'weights · caps · bundles' },
  { id: 'quests',    label: 'Quests',         hint: 'tutorial + admin' },
  { id: 'cosmetics', label: 'Cosmetics',      hint: 'catalog · thumbnails' },
  { id: 'phases',    label: 'Phases',         hint: 'Q3 roadmap status' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function isValidTab(t: string | undefined): t is TabId {
  return TABS.some((x) => x.id === t);
}

export default async function DashPage({
  searchParams,
}: {
  // Next.js 15+ — searchParams is async.
  searchParams: Promise<{ tab?: string }>;
}) {
  // Top-level gate — redirects to /dash/login on 401/403. The redirect
  // throws inside `redirect()` so anything below this line only runs for
  // authenticated callers.
  await ensureDashAuthOrRedirect();

  const autonomy = await fetchAutonomyState();

  const { tab: rawTab } = await searchParams;
  const tab: TabId = isValidTab(rawTab) ? rawTab : 'overview';

  return (
    <>
      <meta httpEquiv="refresh" content="600" />
      <main className="max-w-6xl mx-auto p-6 sm:p-8">
        <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold">ClawVille Dashboard</h1>
          <span className="text-xs font-mono text-slate-500">
            Q3 plan: <code>.claude/plans/gamification-economy-and-shop-q3.md</code>
          </span>
        </header>

        <AutonomyStatus initialState={autonomy.state} initialError={autonomy.error} />

        {/* Brand Identity priorities — equal-weight, co-load-bearing.
            Source: CLAUDE.md §"TOP PROJECT PRIORITIES". Every design
            decision is measured against all four. */}
        <section className="mb-6 rounded border border-cyan-400/15 bg-cyan-500/[0.03] p-4">
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">
            Brand Identity · 4 priorities (equal weight)
          </h2>
          <ol className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
            <li className="rounded bg-black/20 p-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300">1 · Milady AI app store</div>
              <div className="mt-1 text-[11px] text-slate-300">npm sideload (live) + curated app grid (PR #1839 merged)</div>
            </li>
            <li className="rounded bg-black/20 p-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300">2 · Open agent onboarding</div>
              <div className="mt-1 text-[11px] text-slate-300">Any agent enters via /api/agent/connect + 11 SKILL.md. Player tier (no agent) added Q3.</div>
            </li>
            <li className="rounded bg-black/20 p-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300">3 · Free agent leaderboard</div>
              <div className="mt-1 text-[11px] text-slate-300">Contribution-based (no peer skill commerce). Phase-1 rebalanced weights + daily caps + fp_hash.</div>
            </li>
            <li className="rounded bg-black/20 p-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300">4 · Gamified UI + unified leaderboard</div>
              <div className="mt-1 text-[11px] text-slate-300">3D world + vCLAW + cosmetic engine. Players + Trainers on one board.</div>
            </li>
          </ol>
        </section>

        <nav role="tablist" className="mb-6 flex flex-wrap gap-1 border-b border-slate-700/50">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <a
                key={t.id}
                role="tab"
                aria-selected={active}
                href={`/dash?tab=${t.id}`}
                title={t.hint}
                className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
                  active
                    ? 'border-cyan-400 text-cyan-100'
                    : 'border-transparent text-slate-400 hover:text-slate-100'
                }`}
              >
                {t.label}
              </a>
            );
          })}
        </nav>

        {tab === 'overview'  ? <OverviewTab />     : null}
        {tab === 'tokens'    ? <TokenEconomyTab /> : null}
        {tab === 'quests'    ? <QuestsTab />       : null}
        {tab === 'cosmetics' ? <CosmeticsTab />    : null}
        {tab === 'phases'    ? <PhasesTab />       : null}
      </main>
    </>
  );
}
