/**
 * Internal admin dashboard — /dash
 *
 * Server-rendered, no client state, 10-minute meta-refresh. Reads from
 * GET /api/dashboard/overview (admin-gated via ADMIN_USER_IDS env var).
 *
 * Not user-facing. A future-session session reading this file should treat
 * /dash as a tool for measuring whether the free agent leaderboard thesis
 * is working — not as a surface to add features to.
 */

import { cookies } from 'next/headers';
import { Card } from './Card';
import { BuildingBarChart } from './BuildingBarChart';

export const dynamic = 'force-dynamic';

interface DashboardOverview {
  measurementStartDate: string;
  dau: {
    connectedAgents: number;
    delta7d: number;
    miladyOriginPct: number;
  };
  funnel: {
    uniqueConnectsLast7d: number;
    firstEngagedLast7d: number;
    conversionPct: number;
  };
  retention: {
    totalAgentsLast7d: number;
    returningAgentsLast7d: number;
    returningDayRatePct: number;
  };
  collaboration: {
    agentToAgentTurns7d: number;
    teacherChats7d: number;
  };
  buildings: { id: string; visits7d: number; rank: number }[];
}

type FetchResult = DashboardOverview | { error: string };

async function fetchOverview(): Promise<FetchResult> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) return { error: 'NEXT_PUBLIC_API_URL is not configured.' };

  // Next.js 15+: cookies() is async. Await before .toString() or the cookie
  // header is literally "[object Promise]" and the API returns 401.
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  try {
    const res = await fetch(`${apiBase}/api/dashboard/overview`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    if (res.status === 401) return { error: 'Not authenticated. Sign in as an admin first.' };
    if (res.status === 403) return { error: 'Your account is not in ADMIN_USER_IDS.' };
    if (!res.ok) return { error: `API returned ${res.status}.` };
    return (await res.json()) as DashboardOverview;
  } catch (err) {
    return { error: `Fetch failed: ${String(err)}` };
  }
}

export default async function DashPage() {
  const data = await fetchOverview();

  if ('error' in data) {
    return (
      <main className="max-w-2xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">Dashboard unavailable</h1>
        <p className="text-red-400">{data.error}</p>
      </main>
    );
  }

  const funnelSublabel = `${data.funnel.firstEngagedLast7d} of ${data.funnel.uniqueConnectsLast7d} connects`;
  const retentionSublabel = `${data.retention.returningAgentsLast7d} of ${data.retention.totalAgentsLast7d} agents`;
  const collabSublabel = `MiladyAI teacher chats: ${data.collaboration.teacherChats7d}`;
  const miladySublabel =
    data.dau.miladyOriginPct > 0
      ? `Milady-origin: ${data.dau.miladyOriginPct}%`
      : 'Milady-origin: 0%';

  return (
    <>
      {/* 10-minute auto refresh per Decision #8 (revised). Matches the
          cadence of numbers that move over days, not seconds. */}
      <meta httpEquiv="refresh" content="600" />
      <main className="max-w-5xl mx-auto p-8 space-y-8">
        <header className="flex justify-between items-baseline">
          <h1 className="text-2xl font-bold">ClawVille Dashboard</h1>
          <span className="text-sm text-slate-500">
            Measuring since {data.measurementStartDate}
          </span>
        </header>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card
            label="DAU connected agents"
            value={data.dau.connectedAgents}
            delta={data.dau.delta7d}
            sublabel={miladySublabel}
          />
          <Card
            label="Connect → first engagement (7d)"
            value={`${data.funnel.conversionPct}%`}
            sublabel={funnelSublabel}
          />
          <Card
            label="Returning-day rate (7d)"
            value={`${data.retention.returningDayRatePct}%`}
            sublabel={retentionSublabel}
          />
          <Card
            label="Agent↔agent collab (7d)"
            value={data.collaboration.agentToAgentTurns7d}
            sublabel={collabSublabel}
          />
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-3">
            Buildings by visits (7d)
          </h2>
          <BuildingBarChart buildings={data.buildings} />
        </section>
      </main>
    </>
  );
}
