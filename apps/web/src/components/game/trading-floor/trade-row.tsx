'use client';

import type { TapeEntry } from '@/stores/trade-ticker';
import {
  decisionReasonCopy,
  decisionRowState,
  dexLabel,
  explorerUrl,
  formatNotionalUsd,
  formatRequestedUsd,
  multiplierLabel,
  operatorLabel,
  pairLabel,
  shortSignature,
  tradeAgeLabel,
  traderLabel,
  unscoredReasonCopy,
} from './format';
import { FLOOR_TEXT } from './tokens';

export interface TapeRowProps {
  entry: TapeEntry;
  density: 'tape' | 'panel';
  showTrader?: boolean;
  nowMs?: number;
}

type RowState =
  | 'scored'
  | 'unscored'
  | 'pending'
  | 'unconfirmed'
  | 'executed'
  | 'blocked';

function chipFor(entry: TapeEntry, nowMs: number): {
  state: RowState;
  label: string | null;
  title: string;
  color: string;
} {
  if (entry.kind === 'trade') {
    if (!entry.scored) {
      return {
        state: 'unscored',
        label: 'NOT SCORED',
        title: unscoredReasonCopy(entry.unscoredReason),
        color: FLOOR_TEXT.muted,
      };
    }
    return {
      state: 'scored',
      label: multiplierLabel(entry),
      title: 'Verified and scored.',
      color:
        entry.multiplier === 2 ? FLOOR_TEXT.value : FLOOR_TEXT.accent,
    };
  }

  const state = decisionRowState(entry, nowMs);
  if (state === 'blocked') {
    return {
      state,
      label: 'BLOCKED',
      title: decisionReasonCopy(entry.reason),
      color: FLOOR_TEXT.warning,
    };
  }
  if (state === 'executed') {
    return {
      state,
      label: 'EXECUTED',
      title: 'Executed. Waiting for the verified record.',
      color: FLOOR_TEXT.accent,
    };
  }
  if (state === 'unconfirmed') {
    return {
      state,
      label: 'UNCONFIRMED',
      title: 'Sent. Still unconfirmed.',
      color: FLOOR_TEXT.warning,
    };
  }
  return {
    state,
    label: 'PENDING',
    title: 'Sent. Waiting for confirmation.',
    color: FLOOR_TEXT.accent,
  };
}

export function TapeRow({
  entry,
  density,
  showTrader = true,
  nowMs = 0,
}: TapeRowProps) {
  const chip = chipFor(entry, nowMs);
  const isTape = density === 'tape';
  const operator = operatorLabel(entry, density);
  const size =
    entry.kind === 'trade'
      ? formatNotionalUsd(entry.notionalUsd)
      : formatRequestedUsd(entry.requestedUsd);
  const detail =
    entry.kind === 'trade'
      ? `${dexLabel(entry.dex)} · ${tradeAgeLabel(entry.blockTime, nowMs)}`
      : chip.title;

  return (
    <article
      data-testid="floor-tape-row"
      data-state={chip.state}
      data-opacity={chip.state === 'unscored' ? 'muted' : 'full'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: isTape ? '7px 8px' : '10px 12px',
        border: '1px solid rgba(125,211,252,0.16)',
        borderRadius: 8,
        background: 'rgba(2,8,23,0.78)',
        color: FLOOR_TEXT.primary,
        opacity: chip.state === 'unscored' ? 0.55 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minWidth: 0,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: isTape ? 10 : 12,
            color: FLOOR_TEXT.primary,
          }}
          title={showTrader ? traderLabel(entry) : pairLabel(entry)}
        >
          {showTrader ? traderLabel(entry) : pairLabel(entry)}
        </span>
        {chip.label ? (
          <span
            title={chip.title}
            style={{
              flexShrink: 0,
              color: chip.color,
              fontSize: 8,
              fontWeight: 800,
              letterSpacing: '0.08em',
            }}
          >
            {chip.label}
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minWidth: 0,
          fontSize: isTape ? 9 : 11,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: FLOOR_TEXT.muted,
          }}
        >
          {showTrader ? pairLabel(entry) : detail}
        </span>
        <span style={{ flexShrink: 0, color: FLOOR_TEXT.value }}>{size}</span>
      </div>

      {!isTape ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            minWidth: 0,
          }}
        >
          <span style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>{detail}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {operator ? (
              <span
                title="Operated by ClawVille"
                style={{ color: FLOOR_TEXT.accent, fontSize: 9 }}
              >
                {operator}
              </span>
            ) : null}
            {entry.kind === 'trade' ? (
              <a
                href={explorerUrl(entry.signature)}
                target="_blank"
                rel="noopener noreferrer"
                title={entry.signature}
                style={{
                  display: 'inline-flex',
                  minHeight: 44,
                  alignItems: 'center',
                  color: FLOOR_TEXT.link,
                  fontSize: 10,
                }}
              >
                {shortSignature(entry.signature)}
              </a>
            ) : null}
          </span>
        </div>
      ) : operator ? (
        <span
          title="Operated by ClawVille"
          style={{ color: FLOOR_TEXT.accent, fontSize: 8 }}
        >
          {operator}
        </span>
      ) : null}
    </article>
  );
}
