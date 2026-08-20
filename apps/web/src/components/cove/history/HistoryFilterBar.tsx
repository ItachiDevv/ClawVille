'use client';

import type { GameType } from '@/lib/cove/history-client';

export interface HistoryFilters {
  game: GameType | undefined;
  outcome: 'win' | 'loss' | undefined;
}

interface HistoryFilterBarProps {
  filters: HistoryFilters;
  onChange: (next: HistoryFilters) => void;
}

// Game chip colors match the cove building signs:
// Slots = cyan, Blackjack = red, Hold'em = white/silver, Baccarat = blue
const GAME_CHIPS: { label: string; value: GameType; active: string; inactive: string }[] = [
  {
    value: 'slots',
    label: 'Slots',
    active: 'rgba(0,255,224,0.18)',
    inactive: 'rgba(0,255,224,0.06)',
  },
  {
    value: 'blackjack',
    label: 'Blackjack',
    active: 'rgba(220,56,56,0.22)',
    inactive: 'rgba(220,56,56,0.06)',
  },
  {
    value: 'holdem',
    label: "Hold'em",
    active: 'rgba(220,220,220,0.18)',
    inactive: 'rgba(220,220,220,0.05)',
  },
  {
    value: 'baccarat',
    label: 'Baccarat',
    active: 'rgba(60,120,220,0.22)',
    inactive: 'rgba(60,120,220,0.06)',
  },
  {
    value: 'poker',
    label: 'Poker',
    active: 'rgba(255,190,80,0.2)',
    inactive: 'rgba(255,190,80,0.06)',
  },
];

const GAME_CHIP_BORDER: Record<GameType, string> = {
  slots: 'rgba(0,255,224,0.55)',
  blackjack: 'rgba(220,56,56,0.6)',
  holdem: 'rgba(220,220,220,0.45)',
  baccarat: 'rgba(60,120,220,0.6)',
  poker: 'rgba(255,190,80,0.6)',
};

const GAME_CHIP_TEXT: Record<GameType, string> = {
  slots: '#9bfff0',
  blackjack: '#ff8aa0',
  holdem: '#dde8f0',
  baccarat: '#9ab4ff',
  poker: '#ffd27c',
};

export default function HistoryFilterBar({ filters, onChange }: HistoryFilterBarProps) {
  function toggleGame(g: GameType) {
    onChange({ ...filters, game: filters.game === g ? undefined : g });
  }

  function toggleOutcome(o: 'win' | 'loss') {
    onChange({ ...filters, outcome: filters.outcome === o ? undefined : o });
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        padding: '10px 0',
      }}
    >
      <span
        style={{
          color: 'rgba(0,255,224,0.55)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontFamily: 'monospace',
          marginRight: 4,
        }}
      >
        Filter:
      </span>

      {/* Game type chips */}
      {GAME_CHIPS.map((chip) => {
        const active = filters.game === chip.value;
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => toggleGame(chip.value)}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              border: `1.5px solid ${active ? GAME_CHIP_BORDER[chip.value] : 'rgba(255,255,255,0.12)'}`,
              background: active ? GAME_CHIPS.find((c) => c.value === chip.value)!.active : chip.inactive,
              color: active ? GAME_CHIP_TEXT[chip.value] : 'rgba(224,255,248,0.5)',
              fontSize: 12,
              fontFamily: 'monospace',
              fontWeight: active ? 700 : 400,
              cursor: 'pointer',
              letterSpacing: '0.04em',
              transition: 'border-color 0.15s, background 0.15s, color 0.15s',
            }}
          >
            {chip.label}
          </button>
        );
      })}

      {/* Divider */}
      <div
        style={{
          width: 1,
          height: 18,
          background: 'rgba(255,255,255,0.12)',
          margin: '0 4px',
        }}
      />

      {/* Win / Loss chips */}
      {(['win', 'loss'] as const).map((o) => {
        const active = filters.outcome === o;
        const isWin = o === 'win';
        return (
          <button
            key={o}
            type="button"
            onClick={() => toggleOutcome(o)}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              border: `1.5px solid ${active ? (isWin ? 'rgba(0,255,100,0.6)' : 'rgba(255,56,96,0.6)') : 'rgba(255,255,255,0.12)'}`,
              background: active
                ? isWin
                  ? 'rgba(0,255,100,0.12)'
                  : 'rgba(255,56,96,0.12)'
                : 'rgba(255,255,255,0.03)',
              color: active
                ? isWin
                  ? '#7cff9a'
                  : '#ff8aa0'
                : 'rgba(224,255,248,0.5)',
              fontSize: 12,
              fontFamily: 'monospace',
              fontWeight: active ? 700 : 400,
              cursor: 'pointer',
              letterSpacing: '0.04em',
              textTransform: 'capitalize',
              transition: 'border-color 0.15s, background 0.15s, color 0.15s',
            }}
          >
            {o === 'win' ? '↑ Win' : '↓ Loss'}
          </button>
        );
      })}

      {/* Clear all */}
      {(filters.game !== undefined || filters.outcome !== undefined) && (
        <button
          type="button"
          onClick={() => onChange({ game: undefined, outcome: undefined })}
          style={{
            padding: '5px 10px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.35)',
            fontSize: 11,
            fontFamily: 'monospace',
            cursor: 'pointer',
            marginLeft: 4,
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
