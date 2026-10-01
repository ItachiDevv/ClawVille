'use client';

import { floorArenaTemplateById } from '@clawville/shared';

import { useFloorArenaAgent, useFloorArenaEvents } from '@/hooks/use-floor-arena';
import { FLOOR_TEXT } from '../tokens';
import {
  ArenaBlock,
  ArenaClosedTrades,
  ArenaEventStream,
  ArenaOpenPositions,
  ArenaParamChanges,
  ArenaParamsSummary,
  ArenaReport,
  ArenaStatsRow,
} from './arena-parts';
import { ArenaBackButton, ArenaMuted, ArenaPill, arenaCardStyle, useArenaNow } from './arena-kit';

/**
 * Public view of ANY arena agent, house or player. Everything here comes from
 * the public routes, which never carry a wallet secret or the owner's id.
 */
export function AgentProfile({
  agentId,
  active,
  onBack,
}: {
  agentId: string;
  active: boolean;
  onBack: () => void;
}) {
  const nowMs = useArenaNow(active, 30_000);
  const profile = useFloorArenaAgent(agentId, active);
  const events = useFloorArenaEvents(agentId, active);
  const data = profile.data;

  if (profile.isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ArenaBackButton onClick={onBack} />
        <ArenaMuted>Loading the agent...</ArenaMuted>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ArenaBackButton onClick={onBack} />
        <ArenaMuted>This agent could not be loaded. It may not exist, or the arena is unavailable right now.</ArenaMuted>
      </div>
    );
  }

  const { agent } = data;
  // A player's agent is public only in part: the route sends no reports or
  // suggestions, no add-on setup, no wallet and only buys, sells, rule changes
  // and status changes on its stream. House agents keep everything.
  const isPlayer = agent.kind === 'user';
  const template = floorArenaTemplateById(agent.templateId);
  const statusCopy = agent.status === 'paused'
    ? 'Paused'
    : agent.status === 'stopped'
      ? 'Stopped'
      : agent.seated
        ? 'Trading'
        : 'Away from its desk';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="arena-agent-profile">
      <ArenaBackButton onClick={onBack} />
      <header style={arenaCardStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 16 }}>{agent.name}</h3>
          {agent.kind === 'house' ? <ArenaPill colour={FLOOR_TEXT.accent}>House</ArenaPill> : null}
          <ArenaPill colour={agent.status === 'active' && agent.seated ? FLOOR_TEXT.positive : FLOOR_TEXT.muted}>
            {statusCopy}
          </ArenaPill>
          <ArenaPill colour={FLOOR_TEXT.warning}>Paper trading</ArenaPill>
        </div>
        <ArenaMuted>
          Template: {template?.displayName ?? agent.templateId}
          {agent.paramsVersion !== null ? ` · rules v${agent.paramsVersion}` : ''}
        </ArenaMuted>
        <div style={{ marginTop: 10 }}>
          <ArenaStatsRow stats={data.stats} />
        </div>
      </header>

      <ArenaBlock title="Rules">
        <ArenaParamsSummary params={agent.params} />
      </ArenaBlock>
      <ArenaBlock title="Open positions">
        <ArenaOpenPositions
          positions={data.openPositions}
          params={agent.params}
          paramsVersion={agent.paramsVersion}
          nowMs={nowMs}
        />
      </ArenaBlock>
      <ArenaBlock title="Decision stream">
        {isPlayer ? (
          <div style={{ marginBottom: 6 }}>
            <ArenaMuted size={11}>Public view: buys, sells, rule changes and status changes only.</ArenaMuted>
          </div>
        ) : null}
        <ArenaEventStream
          events={events.data ?? []}
          isLoading={events.isLoading}
          isError={events.isError}
          nowMs={nowMs}
        />
      </ArenaBlock>
      {!isPlayer || data.latestReport ? (
        <ArenaBlock title="Latest 30-minute report">
          <ArenaReport report={data.latestReport} nowMs={nowMs} />
        </ArenaBlock>
      ) : null}
      <ArenaBlock title="Recent trades">
        <ArenaClosedTrades positions={data.closedPositions} nowMs={nowMs} />
      </ArenaBlock>
      <ArenaBlock title="Rule changes">
        <ArenaParamChanges changes={data.paramChanges} nowMs={nowMs} />
      </ArenaBlock>
    </div>
  );
}
