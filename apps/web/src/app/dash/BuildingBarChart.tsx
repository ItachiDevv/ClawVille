import { BUILDING_OPENCLAW_THEMES, MAP_LOCATIONS } from '@clawville/shared';

interface Building {
  id: string;
  visits7d: number;
  rank: number;
}

function displayFor(id: string): { label: string; icon: string } {
  const theme = BUILDING_OPENCLAW_THEMES[id];
  const loc = MAP_LOCATIONS.find((l) => l.id === id);
  return {
    label: theme?.label ?? id,
    icon: loc?.icon ?? '🏛️',
  };
}

export function BuildingBarChart({ buildings }: { buildings: Building[] }) {
  if (buildings.length === 0) {
    return (
      <p className="text-slate-500 text-sm">
        No building visits in the last 7 days yet.
      </p>
    );
  }

  const maxVisits = Math.max(...buildings.map((b) => b.visits7d));

  return (
    <div className="space-y-2">
      {buildings.map((b) => {
        const { label, icon } = displayFor(b.id);
        const width = maxVisits > 0 ? (b.visits7d / maxVisits) * 100 : 0;
        return (
          <div key={b.id} className="flex items-center gap-3">
            <div className="w-8 text-right text-slate-500 tabular-nums text-sm">
              #{b.rank}
            </div>
            <div className="w-56 text-sm truncate flex items-center gap-2">
              <span>{icon}</span>
              <span>{label}</span>
            </div>
            <div className="flex-1 h-6 bg-slate-900 rounded overflow-hidden">
              <div
                className="h-full bg-emerald-500"
                style={{ width: `${width}%` }}
              />
            </div>
            <div className="w-16 text-right tabular-nums text-sm">{b.visits7d}</div>
          </div>
        );
      })}
    </div>
  );
}
