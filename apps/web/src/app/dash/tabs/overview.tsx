/**
 * Overview tab — the original /dash content. Reads from
 * GET /api/dashboard/overview which is admin-gated upstream.
 */

import { cookies } from 'next/headers';
import { Card } from '../Card';
import { BuildingBarChart } from '../BuildingBarChart';

interface DashboardOverview {
  measurementStartDate: string;
  dau: { connectedAgents: number; delta7d: number; miladyOriginPct: number };
  funnel: { uniqueConnectsLast7d: number; firstEngagedLast7d: number; conversionPct: number };
  retention: { totalAgentsLast7d: number; returningAgentsLast7d: number; returningDayRatePct: number };
  collaboration: { agentToAgentTurns7d: number; teacherChats7d: number };
  buildings: { id: string; visits7d: number; rank: number }[];
}

type FetchResult = DashboardOverview | { error: string };

async function fetchOverview(): Promise<FetchResult> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) return { error: 'NEXT_PUBLIC_API_URL is not configured.' };

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

export default async function OverviewTab() {
  const data = await fetchOverview();

  if ('error' in data) {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        <p>{data.error}</p>
        <p className="mt-2 text-xs text-red-200/70">
          Have a shared password instead? Sign in at{' '}
          <a href="/dash/login" className="underline">/dash/login</a>.
        </p>
      </div>
    );
  }

  const funnelSublabel = `${data.funnel.firstEngagedLast7d} of ${data.funnel.uniqueConnectsLast7d} connects`;
  const retentionSublabel = `${data.retention.returningAgentsLast7d} of ${data.retention.totalAgentsLast7d} agents`;
  const collabSublabel = `MiladyAI teacher chats: ${data.collaboration.teacherChats7d}`;
  const miladySublabel = `Milady-origin: ${data.dau.miladyOriginPct}%`;

  return (
    <div className="space-y-8">
      <p className="text-xs font-mono text-slate-500">
        Measuring since {data.measurementStartDate}
      </p>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="DAU connected agents" value={data.dau.connectedAgents} delta={data.dau.delta7d} sublabel={miladySublabel} />
        <Card label="Connect → first engagement (7d)" value={`${data.funnel.conversionPct}%`} sublabel={funnelSublabel} />
        <Card label="Returning-day rate (7d)" value={`${data.retention.returningDayRatePct}%`} sublabel={retentionSublabel} />
        <Card label="Agent↔agent collab (7d)" value={data.collaboration.agentToAgentTurns7d} sublabel={collabSublabel} />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Buildings by visits (7d)</h2>
        <BuildingBarChart buildings={data.buildings} />
      </section>
    </div>
  );
}
