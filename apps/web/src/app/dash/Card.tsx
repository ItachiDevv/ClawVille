interface CardProps {
  label: string;
  value: string | number;
  delta?: number;
  sublabel?: string;
}

export function Card({ label, value, delta, sublabel }: CardProps) {
  const deltaColor =
    delta === undefined || delta === 0
      ? 'text-slate-500'
      : delta > 0
        ? 'text-emerald-400'
        : 'text-red-400';
  const deltaSign = delta !== undefined && delta > 0 ? '+' : '';

  return (
    <div className="rounded-lg bg-slate-900 border border-slate-800 p-4">
      <div className="text-xs text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className="text-3xl font-bold tabular-nums">{value}</div>
        {delta !== undefined && (
          <div className={`text-sm ${deltaColor} tabular-nums`}>
            {deltaSign}
            {delta}
          </div>
        )}
      </div>
      {sublabel && <div className="mt-1 text-xs text-slate-500">{sublabel}</div>}
    </div>
  );
}
