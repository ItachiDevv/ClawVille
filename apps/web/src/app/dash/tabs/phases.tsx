/**
 * Phases tab — Q3 plan roadmap status. Reads dashboard_phases via
 * /api/dashboard/phases. Mutable via the dashboard MCP server
 * (tools/dashboard-mcp/server.ts).
 */

import { cookies } from 'next/headers';

interface Phase {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface PhasesResponse { phases: Phase[]; generatedAt: string }
type FetchResult = PhasesResponse | { error: string };

const STATUS_META: Record<string, { color: string; bg: string; label: string }> = {
  shipped:     { color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-400/30', label: '✓ Shipped' },
  in_progress: { color: 'text-cyan-300',    bg: 'bg-cyan-500/10 border-cyan-400/30',       label: '→ In progress' },
  planned:     { color: 'text-slate-300',   bg: 'bg-slate-500/10 border-slate-500/30',     label: '○ Planned' },
  blocked:     { color: 'text-amber-300',   bg: 'bg-amber-500/10 border-amber-400/30',     label: '⚠ Blocked' },
  paused:      { color: 'text-violet-300',  bg: 'bg-violet-500/10 border-violet-400/30',   label: '⏸ Paused' },
};

async function fetchPhases(): Promise<FetchResult> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) return { error: 'NEXT_PUBLIC_API_URL is not configured.' };
  const cookieStore = await cookies();
  try {
    const res = await fetch(`${apiBase}/api/dashboard/phases`, {
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
    });
    if (res.status === 401) return { error: 'Not authenticated. Sign in as an admin first.' };
    if (res.status === 403) return { error: 'Your account is not in ADMIN_USER_IDS.' };
    if (!res.ok) return { error: `API returned ${res.status}.` };
    return (await res.json()) as PhasesResponse;
  } catch (err) {
    return { error: `Fetch failed: ${String(err)}` };
  }
}

export default async function PhasesTab() {
  const data = await fetchPhases();
  if ('error' in data) {
    return <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">{data.error}</div>;
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 text-lg font-semibold">Q3 plan — phase status</h2>
        <p className="mb-4 text-xs font-mono text-slate-500">
          Mutable via the <code>dashboard-phases</code> MCP server
          (<code>tools/dashboard-mcp/server.ts</code>). Plan markdown stays
          authoritative for design; this table tracks live ship status.
        </p>

        <ol className="space-y-3">
          {data.phases.map((p) => {
            const meta = STATUS_META[p.status] ?? STATUS_META.planned;
            return (
              <li key={p.id} className={`rounded border p-4 ${meta.bg}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-mono text-sm uppercase tracking-[0.14em] text-slate-100">
                    <span className="mr-2 inline-block min-w-[2ch] text-slate-500">{p.sortOrder}.</span>
                    {p.name}
                  </h3>
                  <span className={`font-mono text-[11px] ${meta.color}`}>{meta.label}</span>
                </div>
                {p.description ? (
                  <p className="mt-2 text-xs text-slate-300">{p.description}</p>
                ) : null}
                {p.notes ? (
                  <div className="mt-2 rounded border border-slate-700/50 bg-black/30 p-2 font-mono text-[10px] text-slate-400">
                    <span className="font-bold text-slate-300">Notes: </span>
                    {p.notes}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 font-mono text-[9px] text-slate-500">
                  <code>{p.slug}</code>
                  <span>·</span>
                  <span>updated {new Date(p.updatedAt).toISOString().split('T')[0]}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
