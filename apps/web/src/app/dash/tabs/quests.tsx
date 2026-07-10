/**
 * Quests tab — dashboard-side surface for the 30 tutorial quests.
 *
 * Renders each tier as its own grouped section with a "live" / "pending"
 * badge so reviewers can see at a glance which quests have a working
 * backend validator and which are still stubs.
 *
 * Source of truth: `TUTORIAL_QUESTS` in @clawville/shared. The dashboard
 * pulls claim counts from the API and zips them onto each card.
 */

import { cookies } from 'next/headers';
import {
  TUTORIAL_QUESTS,
  TUTORIAL_QUEST_TOTAL_REWARD,
  TUTORIAL_QUEST_LIVE_REWARD,
  type TutorialQuestId,
} from '@clawville/shared';

interface TutorialClaim { questId: string; claimCount: number; totalCt: number }
interface AdminQuest {
  id: string;
  title: string;
  tier: string;
  status: string;
  tokenReward: number;
  currentCompletions: number;
  maxCompletions: number;
}
interface QuestsResponse { tutorial: TutorialClaim[]; admin: AdminQuest[]; generatedAt: string }
type FetchResult = QuestsResponse | { error: string };

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1 · Hello',
  2: 'Tier 2 · Conversation',
  3: 'Tier 3 · The Town',
  4: 'Tier 4 · Economy & Learning',
  5: 'Tier 5 · Activities',
  6: 'Tier 6 · Connect',
  7: 'Tier 7 · Climb',
  8: 'Tier 8 · Cross-World',
  9: 'Tier 9 · Capstones',
};

async function fetchQuests(): Promise<FetchResult> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  if (!apiBase) return { error: 'NEXT_PUBLIC_API_URL is not configured.' };
  const cookieStore = await cookies();
  try {
    const res = await fetch(`${apiBase}/api/dashboard/quests`, {
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
    });
    if (res.status === 401) return { error: 'Not authenticated. Sign in as an admin first.' };
    if (res.status === 403) return { error: 'Your account is not in ADMIN_USER_IDS.' };
    if (!res.ok) return { error: `API returned ${res.status}.` };
    return (await res.json()) as QuestsResponse;
  } catch (err) {
    return { error: `Fetch failed: ${String(err)}` };
  }
}

export default async function QuestsTab() {
  const data = await fetchQuests();
  if ('error' in data) {
    return <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">{data.error}</div>;
  }

  const claimsByQuest = new Map(data.tutorial.map((t) => [t.questId, t]));
  const totalClaimed = data.tutorial.reduce((sum, t) => sum + t.totalCt, 0);

  const byTier = new Map<number, typeof TUTORIAL_QUESTS[number][]>();
  for (const q of TUTORIAL_QUESTS) {
    const arr = byTier.get(q.tier) ?? [];
    arr.push(q);
    byTier.set(q.tier, arr);
  }
  const tiers = Array.from(byTier.keys()).sort((a, b) => a - b);

  const liveCount = TUTORIAL_QUESTS.filter((q) => q.status === 'live').length;
  const pendingCount = TUTORIAL_QUESTS.length - liveCount;

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-1 text-lg font-semibold">Tutorial quests (client-tracked, server-credited)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          {TUTORIAL_QUESTS.length} quests · {liveCount} live · {pendingCount} pending ·
          max <span className="text-amber-300">{TUTORIAL_QUEST_TOTAL_REWARD.toLocaleString()} vCLAW</span> all-tier ·
          <span className="text-emerald-300"> {TUTORIAL_QUEST_LIVE_REWARD.toLocaleString()} vCLAW</span> earnable today.
          Settled via <code>POST /api/quests/tutorial/:id/claim</code>{' '}
          (idempotency table <code>tutorial_quest_claims</code>).
        </p>

        {tiers.map((tier) => {
          const list = byTier.get(tier) ?? [];
          return (
            <div key={tier} className="mb-6">
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">
                {TIER_LABELS[tier] ?? `Tier ${tier}`}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((q) => {
                  const claim = claimsByQuest.get(q.id as TutorialQuestId);
                  const claimCount = claim?.claimCount ?? 0;
                  const totalCt = claim?.totalCt ?? 0;
                  const isPending = q.status === 'pending';
                  return (
                    <div
                      key={q.id}
                      className={`rounded border p-3 ${
                        isPending
                          ? 'border-slate-700/40 bg-slate-900/20 opacity-70'
                          : 'border-slate-700/50 bg-slate-900/30'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <h4 className="font-mono text-xs uppercase tracking-[0.16em] text-slate-200">
                          {q.icon} {q.title}
                        </h4>
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${
                            isPending
                              ? 'border border-slate-600/40 text-slate-400'
                              : 'border border-emerald-400/30 text-emerald-300'
                          }`}
                        >
                          {q.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{q.description}</p>
                      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
                        <span className="text-amber-300">+{q.reward} vCLAW</span>
                        <span className="text-slate-500">·</span>
                        <span className="text-cyan-300">{claimCount} claimed</span>
                        <span className="text-slate-500">·</span>
                        <span className="text-slate-300">{totalCt} vCLAW issued</span>
                        <span className="text-slate-500">·</span>
                        <span className="font-mono text-[10px] text-slate-500">{q.id}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <p className="mt-3 text-xs font-mono text-slate-500">
          Tutorial vCLAW issued (lifetime): <span className="text-amber-300">{totalClaimed.toLocaleString()} vCLAW</span>
        </p>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Admin-curated quests (PR submission flow)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          Backend <code>quests</code> table · admin posts via{' '}
          <code>POST /api/quests/admin/create</code> · users submit GitHub PRs ·
          atomic approve/reject by admin
        </p>
        {data.admin.length === 0 ? (
          <p className="rounded border border-slate-700/50 bg-slate-900/30 p-4 text-xs text-slate-400">
            No admin quests posted yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-700/50 bg-slate-900/30">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-700/50 bg-slate-800/40">
                <tr>
                  {['Title', 'Tier', 'Status', 'Reward vCLAW', 'Completions'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-slate-300">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.admin.map((q) => (
                  <tr key={q.id} className="border-b border-slate-700/30 last:border-0">
                    <td className="px-3 py-2 text-xs text-slate-200">{q.title}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{q.tier}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{q.status}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-amber-300">{q.tokenReward}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-300">
                      {q.currentCompletions} / {q.maxCompletions}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
