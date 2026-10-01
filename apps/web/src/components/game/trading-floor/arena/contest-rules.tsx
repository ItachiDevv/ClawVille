'use client';

import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_PAPER_COSTS,
} from '@clawville/shared';

import { useFloorArenaContest } from '@/hooks/use-floor-arena';
import { FLOOR_TEXT } from '../tokens';
import { contestPhase, contestStandingsCopy, easternTime, pnlTone, signedUsd } from './arena-format';
import { ArenaBlock } from './arena-parts';
import { ArenaBackButton, ArenaHardRules, ArenaMuted, ArenaPill, useArenaNow } from './arena-kit';

const PLACE_LABEL: Record<1 | 2 | 3, string> = { 1: '1st', 2: '2nd', 3: '3rd' };

/** Rules, prizes, dates and the current top 10. Copy from FLOOR_ARENA_CONTEST. */
export function ContestRules({
  active,
  onBack,
  onOpenAgent,
}: {
  active: boolean;
  onBack: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const contest = useFloorArenaContest(active);
  const top = contest.data?.top ?? [];
  const nowMs = useArenaNow(active, 60_000);
  const ended = contestPhase(FLOOR_ARENA_CONTEST.startsAt, FLOOR_ARENA_CONTEST.endsAt, nowMs) === 'ended';
  const standings = contestStandingsCopy(contest.data?.standings ?? null, contest.data?.openWindowPositions ?? null);
  const topTitle = !ended
    ? 'Top 10 now'
    : standings.pill === 'Final'
      ? 'Final top 10'
      : standings.pill === 'Provisional'
        ? 'Top 10 (provisional)'
        : 'Top 10';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="arena-contest-rules">
      <ArenaBackButton onClick={onBack} />
      <ArenaBlock title={`${FLOOR_ARENA_CONTEST.name}: rules`}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          <ArenaPill colour={FLOOR_TEXT.warning}>Paper trading only</ArenaPill>
        </div>
        <ArenaMuted>
          Starts {easternTime(FLOOR_ARENA_CONTEST.startsAt)}. Ends {easternTime(FLOOR_ARENA_CONTEST.endsAt)}.
        </ArenaMuted>
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: FLOOR_TEXT.primary, fontSize: 12 }}>
          {FLOOR_ARENA_CONTEST.rules.map((rule) => (
            <li key={rule} style={{ marginBottom: 4 }}>
              {rule}
            </li>
          ))}
          <li>
            Every paper buy costs {FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct}% and every paper sell costs{' '}
            {FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct}% on top of the live quote, which is what a real swap costs.
          </li>
        </ul>
      </ArenaBlock>

      <ArenaBlock title="Prizes">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {FLOOR_ARENA_CONTEST.prizes.map((prize) => (
            <div key={prize.place} style={{ color: FLOOR_TEXT.value, fontSize: 13 }}>
              {PLACE_LABEL[prize.place]}: {prize.amount.toLocaleString('en-US')} {prize.token}
            </div>
          ))}
        </div>
      </ArenaBlock>

      <ArenaHardRules />

      <ArenaBlock title={topTitle}>
        {ended ? (
          <div style={{ marginBottom: 6 }}>
            <ArenaMuted size={11}>{standings.text}</ArenaMuted>
          </div>
        ) : null}
        {contest.isLoading ? (
          <ArenaMuted>Loading the standings...</ArenaMuted>
        ) : contest.isError ? (
          <ArenaMuted>The standings are unavailable right now.</ArenaMuted>
        ) : top.length === 0 ? (
          <ArenaMuted>No eligible agent has closed a position opened in the contest window yet.</ArenaMuted>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {top.map((row) => (
              <button
                key={row.agentId}
                type="button"
                onClick={() => onOpenAgent(row.agentId)}
                style={{
                  minHeight: 44,
                  display: 'grid',
                  gridTemplateColumns: '36px minmax(0, 1fr) auto',
                  gap: 8,
                  alignItems: 'center',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(125,211,252,0.08)',
                  color: FLOOR_TEXT.primary,
                  textAlign: 'left',
                  cursor: 'pointer',
                  padding: '4px 0',
                }}
              >
                <span style={{ color: FLOOR_TEXT.muted }}>#{row.rank ?? '-'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                <span style={{ color: pnlTone(row.realisedUsd), fontWeight: 700 }}>{signedUsd(row.realisedUsd)}</span>
              </button>
            ))}
          </div>
        )}
      </ArenaBlock>
    </div>
  );
}
