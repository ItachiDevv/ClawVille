'use client';

import { useState } from 'react';
import {
  cloneFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaParams,
} from '@clawville/shared';

import {
  FloorArenaApiError,
  floorArenaErrorCode,
  floorArenaErrorCopy,
  useFloorArenaAddons,
  useFloorArenaAgent,
  floorArenaProvisionInProgress,
  useFloorArenaMyEvents,
  useFloorArenaSuggestionAction,
  usePatchFloorArenaAddons,
  usePatchFloorArenaParams,
  usePatchFloorArenaSettings,
  useSetFloorArenaSeat,
  useSetFloorArenaStatus,
  type FloorArenaMyAgent,
} from '@/hooks/use-floor-arena';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { FLOOR_TEXT } from '../tokens';
import {
  ADDON_WALLET_WARNING,
  AddonPicker,
  addonChoicesValid,
  defaultAddonChoice,
  type AddonChoice,
} from './addon-picker';
import {
  ArenaBlock,
  ArenaClosedTrades,
  ArenaEventStream,
  ArenaOpenPositions,
  ArenaReport,
  ArenaStatsRow,
} from './arena-parts';
import {
  ArenaBackButton,
  ArenaCopyField,
  ArenaMuted,
  ArenaPill,
  ArenaStickyFooter,
  arenaButtonStyle,
  arenaCardStyle,
  arenaPrimaryButtonStyle,
  useArenaNow,
} from './arena-kit';
import { ArenaParamsForm } from './arena-params-form';

export type DeskStatus = 'trading' | 'waiting' | 'paused' | 'stopped';

/** One word for the desk: trading needs BOTH an active agent and a seat. */
export function deskStatus(agent: Pick<FloorArenaMyAgent, 'status' | 'seated'>): DeskStatus {
  if (agent.status === 'stopped') return 'stopped';
  if (agent.status === 'paused') return 'paused';
  return agent.seated ? 'trading' : 'waiting';
}

const DESK_STATUS_LOOK: Record<DeskStatus, { label: string; tone: string }> = {
  trading: { label: 'Trading', tone: FLOOR_TEXT.positive },
  waiting: { label: 'Waiting for you to sit', tone: FLOOR_TEXT.accent },
  paused: { label: 'Paused', tone: FLOOR_TEXT.warning },
  stopped: { label: 'Stopped', tone: FLOOR_TEXT.danger },
};

function InlineMessage({ text, tone = FLOOR_TEXT.warning }: { text: string | null; tone?: string }) {
  if (!text) return null;
  return (
    <div role="status" style={{ color: tone, fontSize: 12 }}>
      {text}
    </div>
  );
}

function SeatBlock({ me }: { me: FloorArenaMyAgent }) {
  const localSeatIndex = useFloorArenaUi((state) => state.localSeatIndex);
  const leave = useSetFloorArenaSeat();
  const [message, setMessage] = useState<string | null>(null);

  if (localSeatIndex >= 0) {
    return (
      <ArenaMuted>
        You sit at desk {localSeatIndex + 1}.{' '}
        {me.seated
          ? 'Your agent opens new positions while it holds the desk. Stand up in the room to leave it.'
          : 'Taking the desk for your agent...'}
      </ArenaMuted>
    );
  }
  if (me.seated) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ArenaMuted>
          Your agent keeps desk {me.seatIndex !== null ? me.seatIndex + 1 : ''} while you are away, and it keeps trading.
        </ArenaMuted>
        <button
          type="button"
          disabled={leave.isPending}
          onClick={() =>
            leave.mutate(
              { seated: false },
              { onError: (error) => setMessage(floorArenaErrorCopy(error)), onSuccess: () => setMessage(null) },
            )
          }
          style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
        >
          {leave.isPending ? 'Leaving...' : 'Leave the desk'}
        </button>
        <InlineMessage text={message} />
      </div>
    );
  }
  return (
    <ArenaMuted>
      Sit at any desk in the Trading Floor to start trading. Your agent opens new positions only while it holds a desk;
      exits always run.
    </ArenaMuted>
  );
}

function RulesEditor({ me, compact }: { me: FloorArenaMyAgent; compact: boolean }) {
  const [draft, setDraft] = useState<FloorArenaParams | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const save = usePatchFloorArenaParams();

  if (!me.params) {
    return <ArenaMuted>Your agent's rules could not be read right now, so they cannot be edited. Try again shortly.</ArenaMuted>;
  }
  if (!draft) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          onClick={() => {
            setDraft(cloneFloorArenaParams(me.params!));
            setErrors([]);
            setMessage(null);
          }}
          style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
        >
          Edit rules
        </button>
        <InlineMessage text={message} tone={FLOOR_TEXT.accent} />
      </div>
    );
  }

  const submit = () => {
    const result = validateFloorArenaParams(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    save.mutate(
      { params: result.params },
      {
        onSuccess: () => {
          setDraft(null);
          setMessage('Rules saved. They apply from the next scan.');
        },
        onError: (error) => {
          if (floorArenaErrorCode(error) === 'invalid_params' && error instanceof FloorArenaApiError) {
            setErrors(error.errors);
          }
          setMessage(floorArenaErrorCopy(error));
        },
      },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="arena-rules-editor">
      <ArenaParamsForm value={draft} onChange={setDraft} errors={errors} compact={compact} disabled={save.isPending} />
      <InlineMessage text={message} />
      <ArenaStickyFooter>
        <button type="button" onClick={() => setDraft(null)} style={arenaButtonStyle} disabled={save.isPending}>
          Cancel
        </button>
        <button type="button" onClick={submit} style={arenaPrimaryButtonStyle} disabled={save.isPending}>
          {save.isPending ? 'Saving...' : 'Save rules'}
        </button>
      </ArenaStickyFooter>
    </div>
  );
}

/**
 * True when the wallet balance is KNOWN and cannot pay for the add-on's next
 * call. An unknown balance is not reported as underfunded: that would be a
 * claim about the wallet we did not read.
 */
export function addonUnderfunded(
  addon: Pick<FloorArenaMyAgent['addons'][number], 'enabled' | 'priceUsd'>,
  walletUsdc: number | null,
): boolean {
  return addon.enabled && walletUsdc !== null && addon.priceUsd !== null && walletUsdc < addon.priceUsd;
}

function AddonsBlock({ me, active }: { me: FloorArenaMyAgent; active: boolean }) {
  const catalog = useFloorArenaAddons(active);
  const patch = usePatchFloorArenaAddons();
  const [editing, setEditing] = useState(false);
  const [choices, setChoices] = useState<Record<string, AddonChoice>>({});
  const [message, setMessage] = useState<string | null>(null);
  const on = me.addons.filter((addon) => addon.enabled);

  const startEditing = () => {
    setChoices(
      Object.fromEntries(
        me.addons.map((addon) => [
          addon.id,
          { enabled: addon.enabled, capUsd: addon.dailyCapUsd ?? defaultAddonChoice().capUsd },
        ]),
      ),
    );
    setMessage(null);
    setEditing(true);
  };

  const save = () => {
    if (!addonChoicesValid(choices)) return;
    // Only ids the catalog still offers: the route refuses an unknown add-on.
    const offered = new Set((catalog.data?.addons ?? []).map((addon) => addon.id));
    const entries = Object.entries(choices)
      .filter(([id]) => offered.has(id))
      .map(([id, choice]) => ({ id, enabled: choice.enabled, dailyCapUsd: choice.capUsd }));
    patch.mutate(
      { addons: entries },
      {
        onSuccess: () => {
          setEditing(false);
          setMessage('Add-ons saved.');
        },
        onError: (error) => setMessage(floorArenaErrorCopy(error)),
      },
    );
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <AddonPicker
          catalog={catalog.data?.addons ?? []}
          paymentsEnabled={catalog.data?.paymentsEnabled ?? false}
          isLoading={catalog.isLoading}
          isError={catalog.isError}
          choices={choices}
          onChange={(id, next) => setChoices((current) => ({ ...current, [id]: next }))}
          disabled={patch.isPending}
        />
        <InlineMessage text={message} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setEditing(false)} style={arenaButtonStyle} disabled={patch.isPending}>
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            style={arenaPrimaryButtonStyle}
            disabled={patch.isPending || !addonChoicesValid(choices)}
          >
            {patch.isPending ? 'Saving...' : 'Save add-ons'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="arena-addons-status">
      {on.length === 0 ? (
        <ArenaMuted>No paid add-ons. Your agent reads the shared free discovery feed.</ArenaMuted>
      ) : (
        on.map((addon) => {
          const underfunded = addonUnderfunded(addon, me.walletUsdc);
          return (
            <div key={addon.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ color: FLOOR_TEXT.value, fontSize: 12 }}>
                {addon.name}
                {underfunded ? (
                  <span style={{ marginLeft: 6 }}>
                    <ArenaPill colour={FLOOR_TEXT.danger} testId="arena-addon-underfunded">Underfunded</ArenaPill>
                  </span>
                ) : null}
              </div>
              <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
                Spent today: {addon.spentTodayUsd === null ? 'n/a' : `$${addon.spentTodayUsd.toFixed(2)}`}
                {addon.dailyCapUsd !== null ? ` of a $${addon.dailyCapUsd.toFixed(2)} daily cap` : ''}
                {addon.lastOk === false && addon.lastError ? ` · last call failed: ${addon.lastError}` : ''}
              </div>
              {underfunded ? (
                <div style={{ color: FLOOR_TEXT.danger, fontSize: 11 }}>
                  The agent&apos;s wallet holds less USDC than one call costs, so this add-on is skipped until you send
                  USDC to the wallet below.
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {on.length > 0 ? <div style={{ color: FLOOR_TEXT.warning, fontSize: 11 }}>{ADDON_WALLET_WARNING}</div> : null}
      <InlineMessage text={message} tone={FLOOR_TEXT.accent} />
      <button type="button" onClick={startEditing} style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}>
        Change add-ons
      </button>
    </div>
  );
}

/**
 * The desk panel: the viewer's own arena agent. Private bits (wallet,
 * add-ons, settings) come from GET /me; positions, trades and the report come
 * from the same public profile route everyone else reads.
 */
export function MyTrader({
  me,
  active,
  compact,
  onBack,
  onOpenProfile,
}: {
  me: FloorArenaMyAgent;
  active: boolean;
  compact: boolean;
  onBack: () => void;
  onOpenProfile: (agentId: string) => void;
}) {
  const nowMs = useArenaNow(active, 30_000);
  const profile = useFloorArenaAgent(me.id, active);
  const events = useFloorArenaMyEvents(me.id, active);
  const status = useSetFloorArenaStatus();
  const settings = usePatchFloorArenaSettings();
  const suggestion = useFloorArenaSuggestionAction();
  const [message, setMessage] = useState<string | null>(null);
  const template = floorArenaTemplateById(me.templateId);
  const look = DESK_STATUS_LOOK[deskStatus(me)];
  // GET /me is private and never edge-cached, so its report is the fresher one.
  const report = me.latestReport ?? profile.data?.latestReport ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="arena-my-trader">
      <ArenaBackButton onClick={onBack} />
      <header style={{ ...arenaCardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 16 }}>{me.name}</h3>
          <ArenaPill colour={look.tone} testId="arena-desk-status">{look.label}</ArenaPill>
          <ArenaPill colour={FLOOR_TEXT.warning}>Paper trading</ArenaPill>
        </div>
        <ArenaMuted>
          Template: {template?.displayName ?? me.templateId}
          {me.paramsVersion !== null ? ` · rules v${me.paramsVersion}` : ''}
        </ArenaMuted>
        <SeatBlock me={me} />
        <ArenaStatsRow stats={me.stats} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {me.status !== 'stopped' ? (
            <button
              type="button"
              disabled={status.isPending}
              onClick={() =>
                status.mutate(
                  { status: me.status === 'paused' ? 'active' : 'paused' },
                  { onError: (error) => setMessage(floorArenaErrorCopy(error)), onSuccess: () => setMessage(null) },
                )
              }
              style={arenaButtonStyle}
            >
              {status.isPending ? 'Saving...' : me.status === 'paused' ? 'Resume trading' : 'Pause trading'}
            </button>
          ) : null}
          <button type="button" onClick={() => onOpenProfile(me.id)} style={arenaButtonStyle}>
            Public profile
          </button>
        </div>
        {me.status === 'paused' ? (
          <ArenaMuted size={11}>While paused the agent opens nothing new. Open positions still exit on their rules.</ArenaMuted>
        ) : null}
        <InlineMessage text={message} />
      </header>

      <ArenaBlock title="Decision stream" testId="arena-desk-stream">
        <ArenaEventStream events={events.data ?? []} isLoading={events.isLoading} isError={events.isError} nowMs={nowMs} />
      </ArenaBlock>

      <ArenaBlock title="Open positions">
        {profile.isLoading ? (
          <ArenaMuted>Loading positions...</ArenaMuted>
        ) : (
          <ArenaOpenPositions
            positions={profile.data?.openPositions ?? []}
            params={me.params}
            paramsVersion={me.paramsVersion}
            nowMs={nowMs}
          />
        )}
      </ArenaBlock>

      <ArenaBlock title="Latest 30-minute report">
        <ArenaReport
          report={report}
          nowMs={nowMs}
          actions={
            report ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  disabled={suggestion.isPending}
                  onClick={() =>
                    suggestion.mutate(
                      { reportId: report.id, action: 'apply' },
                      { onError: (error) => setMessage(floorArenaErrorCopy(error)) },
                    )
                  }
                  style={arenaPrimaryButtonStyle}
                >
                  Apply
                </button>
                <button
                  type="button"
                  disabled={suggestion.isPending}
                  onClick={() =>
                    suggestion.mutate(
                      { reportId: report.id, action: 'dismiss' },
                      { onError: (error) => setMessage(floorArenaErrorCopy(error)) },
                    )
                  }
                  style={arenaButtonStyle}
                >
                  Dismiss
                </button>
              </div>
            ) : undefined
          }
        />
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 8, cursor: 'pointer', color: FLOOR_TEXT.primary, fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={me.autoApplySuggestions}
            disabled={settings.isPending}
            onChange={(event) =>
              settings.mutate(
                { autoApplySuggestions: event.target.checked },
                { onError: (error) => setMessage(floorArenaErrorCopy(error)) },
              )
            }
            style={{ width: 22, height: 22 }}
          />
          Auto-apply suggestions (each one stays inside the limits, and every change is logged publicly)
        </label>
      </ArenaBlock>

      <ArenaBlock title="Rules">
        <RulesEditor me={me} compact={compact} />
      </ArenaBlock>

      <ArenaBlock title="Closed trades (last 50)">
        <ArenaClosedTrades positions={profile.data?.closedPositions ?? []} nowMs={nowMs} limit={50} />
      </ArenaBlock>

      <ArenaBlock title="Paid add-ons">
        <AddonsBlock me={me} active={active} />
      </ArenaBlock>

      <ArenaBlock title="Wallet">
        {me.paymentAddress ? (
          <>
            <ArenaCopyField value={me.paymentAddress} label="Your agent's wallet (pays for add-ons)" />
            <ArenaMuted size={11}>
              USDC in the wallet: {me.walletUsdc === null ? 'not known right now' : `$${me.walletUsdc.toFixed(2)}`}
            </ArenaMuted>
          </>
        ) : me.provisionState === 'failed' ? (
          <ArenaMuted>
            The ClawPump agent setup did not finish yet. Paper trading works without it. ClawVille retries the
            setup every 10 minutes, up to five times.
          </ArenaMuted>
        ) : floorArenaProvisionInProgress(me.provisionState) ? (
          <ArenaMuted>Setting up your ClawPump agent...</ArenaMuted>
        ) : (
          <ArenaMuted>Your agent has no wallet yet. It needs one only for paid add-ons.</ArenaMuted>
        )}
      </ArenaBlock>
    </div>
  );
}
