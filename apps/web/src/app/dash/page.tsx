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

import OverviewTab from './tabs/overview';
import TokenEconomyTab from './tabs/token-economy';
import QuestsTab from './tabs/quests';
import CosmeticsTab from './tabs/cosmetics';
import PhasesTab from './tabs/phases';

export const dynamic = 'force-dynamic';

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
