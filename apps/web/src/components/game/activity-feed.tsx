'use client';

import { useEffect, useState } from 'react';
import { useGameStore, type GameState } from '@/stores/game';
import { api } from '@/lib/api';

interface ActivityEntry {
  id: string;
  avatarId: string;
  activityType: string;
  description: string;
  tokensEarned: number;
  createdAt: string;
}

const ACTIVITY_ICONS: Record<string, string> = {
  visit: '🏠',
  chat: '💬',
  purchase: '🛒',
  learn: '📖',
  explore: '🗺️',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ActivityFeed() {
  const activityFeedOpen = useGameStore((s: GameState) => s.activityFeedOpen);
  const toggleActivityFeed = useGameStore((s: GameState) => s.toggleActivityFeed);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activityFeedOpen) return;

    let cancelled = false;

    const fetchActivity = async () => {
      setLoading(true);
      try {
        const res = await api.getActivityFeed(20);
        if (!cancelled) setEntries(res.activities);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchActivity();
    const interval = setInterval(fetchActivity, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activityFeedOpen]);

  if (!activityFeedOpen) return null;

  return (
    <div className="absolute top-16 left-4 z-30 w-72 max-h-80 bg-amber-50 border-2 border-amber-700 rounded-lg shadow-lg overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 bg-amber-200 border-b border-amber-400">
        <span className="font-bold text-amber-900 text-sm">Activity Log</span>
        <button
          onClick={toggleActivityFeed}
          className="text-amber-700 hover:text-amber-900 text-lg leading-none"
        >
          x
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {loading && entries.length === 0 && (
          <p className="text-xs text-amber-600 text-center py-4">Loading...</p>
        )}
        {!loading && entries.length === 0 && (
          <p className="text-xs text-amber-600 text-center py-4">
            No activity yet. Your agent will log visits when it explores autonomously!
          </p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start gap-2 px-2 py-1.5 bg-white/60 rounded border border-amber-200"
          >
            <span className="text-base mt-0.5">
              {ACTIVITY_ICONS[entry.activityType] ?? '📝'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-800 leading-tight">{entry.description}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-500">{timeAgo(entry.createdAt)}</span>
                {entry.tokensEarned > 0 && (
                  <span className="text-[10px] text-amber-700 font-medium">
                    +{entry.tokensEarned} vCLAW
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
