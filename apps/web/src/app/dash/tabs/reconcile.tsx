/** Read-only settlement posture. This tab never initiates reconciliation. */
import { cookies } from 'next/headers';

interface ReconcileDashboard {
  reconcileRows: Array<{
    table: string;
    id: string;
    createdAt: string;
    reconcileReason: string | null;
    recommendation: string;
    autoReconcile: { bucket: string; detail: string; at: string } | null;
    bounty?: { bountyId: string } | null;
  }>;
  tier1Frozen: Array<{
    bountyId: string;
    plan: { kind: string; reason: string | null };
    paymentId: string | null;
    settlementAttempt: number;
    lastWedgeAlertAt: string | null;
    wedgeAlertCount: number;
  }>;
}

async function fetchReconcile(): Promise<ReconcileDashboard | { error: string }> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) return { error: 'NEXT_PUBLIC_API_URL is not configured.' };
  const cookieStore = await cookies();
  try {
    const res = await fetch(`${apiBase}/api/dashboard/reconcile`, {
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
    });
    if (res.status === 401) return { error: 'Not authenticated. Sign in as an admin first.' };
    if (res.status === 403) return { error: 'Admin access is required.' };
    if (!res.ok) return { error: `API returned ${res.status}.` };
    return await res.json() as ReconcileDashboard;
  } catch (err) {
    return { error: `Fetch failed: ${String(err)}` };
  }
}

function age(createdAt: string, now: number): string {
  const hours = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 3_600_000));
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
}

export default async function ReconcileTab() {
  const data = await fetchReconcile();
  if ('error' in data) {
    return <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">{data.error}</div>;
  }
  const now = Date.now();
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 text-lg font-semibold">Reconcile</h2>
        <p className="mb-4 text-sm text-slate-400">Frozen payments and the latest automatic review. This view does not send payments.</p>
        <div className="overflow-x-auto rounded border border-slate-700/50" tabIndex={0} role="region" aria-label="Reconcile payments">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-800/50 text-slate-300">
              <tr>{['ID', 'Table', 'Age', 'Reason', 'Recommendation', 'Auto review', 'Tier-1 bounty'].map((label) => <th key={label} scope="col" className="whitespace-nowrap p-3">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {data.reconcileRows.map((row) => (
                <tr key={`${row.table}:${row.id}`}>
                  <td className="whitespace-nowrap p-3 font-mono">{row.id}</td>
                  <td className="p-3">{row.table}</td>
                  <td className="whitespace-nowrap p-3" title={row.createdAt}>{age(row.createdAt, now)}</td>
                  <td className="p-3">{row.reconcileReason ?? 'Unknown'}</td>
                  <td className="p-3">{row.recommendation}</td>
                  <td className="p-3" title={row.autoReconcile ? `${row.autoReconcile.at}: ${row.autoReconcile.detail}` : undefined}>{row.autoReconcile?.bucket ?? 'Not reviewed'}</td>
                  <td className="whitespace-nowrap p-3 font-mono">{row.bounty?.bountyId ?? '—'}</td>
                </tr>
              ))}
              {data.reconcileRows.length === 0 ? <tr><td colSpan={7} className="p-4 text-slate-400">No payments require reconciliation.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">Tier-1 frozen holds</h2>
        <div className="overflow-x-auto rounded border border-slate-700/50" tabIndex={0} role="region" aria-label="Tier-1 frozen holds">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-800/50 text-slate-300">
              <tr>{['Bounty', 'Payment', 'Plan', 'Attempt', 'Last alert', 'Alert count'].map((label) => <th key={label} scope="col" className="whitespace-nowrap p-3">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {data.tier1Frozen.map((row) => (
                <tr key={row.bountyId}>
                  <td className="whitespace-nowrap p-3 font-mono">{row.bountyId}</td>
                  <td className="whitespace-nowrap p-3 font-mono">{row.paymentId ?? '—'}</td>
                  <td className="p-3">{row.plan.reason ?? row.plan.kind}</td>
                  <td className="p-3">{row.settlementAttempt}</td>
                  <td className="whitespace-nowrap p-3">{row.lastWedgeAlertAt ?? 'Never'}</td>
                  <td className="p-3">{row.wedgeAlertCount}</td>
                </tr>
              ))}
              {data.tier1Frozen.length === 0 ? <tr><td colSpan={6} className="p-4 text-slate-400">No Tier-1 holds require attention.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
