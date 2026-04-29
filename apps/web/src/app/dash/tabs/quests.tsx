/**
 * Quests tab — 10 tutorial quests as cards with claim counts + total CT
 * issued + completion %, plus the backend admin-curated quests table.
 */

import { cookies } from 'next/headers';
import {
  TUTORIAL_QUEST_REWARDS,
  TUTORIAL_QUEST_TOTAL_REWARD,
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

// Same metadata schema as apps/web/src/lib/quests.ts QUEST_DEFINITIONS — duplicated
// here so the dashboard renders without importing from a client lib (server-side
// only, no zustand). One source for icons + titles is acceptable drift; the IDs +
// rewards remain authoritative via TUTORIAL_QUEST_REWARDS in @clawville/shared.
const TUTORIAL_META: Record<TutorialQuestId, { icon: string; title: string; threshold: string }> = {
  'first-steps':       { icon: '👣', title: 'First Steps',       threshold: 'Walk 200 units' },
  'building-explorer': { icon: '🧭', title: 'Explorer',          threshold: 'Visit 1 building' },
  'npc-chatter':       { icon: '💬', title: 'Small Talk',        threshold: '2 character chats' },
  'book-worm':         { icon: '📖', title: 'Book Worm',         threshold: 'Buy 1 book' },
  'pet-whisperer':     { icon: '💜', title: 'Agent Whisperer',   threshold: '3 pet chats' },
  'agent-scholar':     { icon: '🎓', title: 'AI Agent Scholar',  threshold: 'Learn 3 books' },
  'deep-explorer':     { icon: '🗺️', title: 'Cartographer',      threshold: '5 distinct buildings' },
  'bot-master':        { icon: '🤖', title: 'Bot Master',        threshold: 'Connect an OpenClaw bot' },
  'first-match':       { icon: '⚔️', title: 'First Match',       threshold: '1 activity match' },
  'first-win':         { icon: '🏆', title: 'First Victory',     threshold: '1 first-place finish' },
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

  return (
    <div className="space-y-10">
      {/* TUTORIAL */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">Tutorial quests (client-tracked, server-credited)</h2>
        <p className="mb-3 text-xs font-mono text-slate-500">
          10 quests · max {TUTORIAL_QUEST_TOTAL_REWARD} CT total per user · settled via{' '}
          <code>POST /api/quests/tutorial/:id/claim</code>{' '}
          (idempotency table <code>tutorial_quest_claims</code>)
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.entries(TUTORIAL_QUEST_REWARDS) as [TutorialQuestId, number][]).map(([id, reward]) => {
            const meta = TUTORIAL_META[id];
            const claim = claimsByQuest.get(id);
            const claimCount = claim?.claimCount ?? 0;
            const totalCt = claim?.totalCt ?? 0;
            return (
              <div key={id} className="rounded border border-slate-700/50 bg-slate-900/30 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-slate-200">
                    {meta.icon} {meta.title}
                  </h3>
                  <span className="font-mono text-[10px] text-slate-500">{id}</span>
                </div>
                <p className="mt-1 text-xs text-slate-400">{meta.threshold}</p>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
                  <span className="text-amber-300">+{reward} CT</span>
                  <span className="text-slate-400">·</span>
                  <span className="text-cyan-300">{claimCount} claimed</span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-300">{totalCt} CT issued</span>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs font-mono text-slate-500">Tutorial CT issued (lifetime): <span className="text-amber-300">{totalClaimed.toLocaleString()} CT</span></p>
      </section>

      {/* ADMIN-CURATED */}
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
                  {['Title', 'Tier', 'Status', 'Reward CT', 'Completions'].map((h) => (
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
