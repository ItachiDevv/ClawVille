'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  FLOOR_ARENA_FIRST_SIGHT_SOURCES,
  FLOOR_ARENA_MAX_TP_LEGS,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_RANK_BY,
  type FloorArenaBound,
  type FloorArenaFilters,
  type FloorArenaFirstSightSources,
  type FloorArenaParams,
  type FloorArenaRankBy,
} from '@clawville/shared';

import { FLOOR_TEXT } from '../tokens';
import {
  errorsByPath,
  firstSightLabel,
  formatBoundValue,
  rankByLabel,
  UNIT_SUFFIX,
} from './arena-format';
import {
  ArenaHardRules,
  arenaButtonStyle,
  arenaInnerCardStyle,
  arenaInputStyle,
} from './arena-kit';

// The rules form. One component for the launch flow and for "Edit rules" on
// the desk panel, so both render the same labels, units and bounds from
// FLOOR_ARENA_PARAM_BOUNDS and both validate with validateFloorArenaParams.
// A field the player empties becomes NaN, which the shared validator reports
// as "must be a number" next to that field, so a half-typed value can never
// pass as the old one.

const B = FLOOR_ARENA_PARAM_BOUNDS;

const FILTER_ROWS: ReadonlyArray<{
  title: string;
  min?: keyof FloorArenaFilters;
  max?: keyof FloorArenaFilters;
}> = [
  { title: 'Market cap', min: 'mcap_min', max: 'mcap_max' },
  { title: 'Liquidity', min: 'liq_min', max: 'liq_max' },
  { title: 'Pair age', min: 'age_min_s', max: 'age_max_s' },
  { title: '1-hour volume / market cap', min: 'vol1h_over_mcap_min', max: 'vol1h_over_mcap_max' },
  { title: '5-minute change', min: 'chg5m_min', max: 'chg5m_max' },
  { title: '1-hour change', min: 'chg1h_min', max: 'chg1h_max' },
  { title: '6-hour change', min: 'chg6h_min', max: 'chg6h_max' },
  { title: '24-hour change', min: 'chg24h_min', max: 'chg24h_max' },
  { title: 'Trades in 1 hour', min: 'txns1h_min', max: 'txns1h_max' },
  { title: 'Top-10 holders', max: 'top10_max_pct' },
];

/** The value an "off" field takes when the player turns it on. */
const ON_DEFAULTS: Readonly<Record<string, number>> = {
  'entry.discovered_within_s': 300,
  'exits.stop_mult': 0.8,
  'exits.trail_from_peak': 0.2,
  'exits.trail_arm_mult': 1.2,
};

function onDefault(path: string, bound: FloorArenaBound): number {
  const preset = ON_DEFAULTS[path];
  if (preset !== undefined) return preset;
  return path.includes('max') ? bound.max : bound.min;
}

function FieldErrors({ errors }: { errors: readonly string[] | undefined }) {
  if (!errors || errors.length === 0) return null;
  return (
    <>
      {errors.map((line) => (
        <div key={line} role="alert" style={{ color: FLOOR_TEXT.danger, fontSize: 11 }}>
          {line}
        </div>
      ))}
    </>
  );
}

function NumberInput({
  id,
  bound,
  value,
  disabled,
  onChange,
  ariaLabel,
}: {
  id?: string;
  bound: FloorArenaBound;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
  ariaLabel?: string;
}) {
  // The draft keeps what the player is typing ("1." or "") on screen; the
  // value the parent holds is what the validator judges.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={bound.min}
      max={bound.max}
      step={bound.step}
      value={shown}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        onChange(text.trim() === '' ? Number.NaN : Number(text));
      }}
      onBlur={() => setDraft(null)}
      style={{ ...arenaInputStyle, opacity: disabled ? 0.5 : 1 }}
    />
  );
}

function NumberField({
  path,
  bound,
  value,
  onChange,
  errors,
  disabled,
  offLabel = 'Off',
}: {
  path: string;
  bound: FloorArenaBound;
  value: number | null;
  onChange: (next: number | null) => void;
  errors: readonly string[] | undefined;
  disabled: boolean;
  offLabel?: string;
}) {
  const id = useId();
  const [remembered, setRemembered] = useState<number | null>(value);
  const on = value !== null;
  const unit = UNIT_SUFFIX[bound.unit];

  if (bound.locked) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={`arena-field-${path}`}>
        <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>{bound.label}</div>
        <div style={{ color: FLOOR_TEXT.value, fontSize: 14, minHeight: 44, display: 'flex', alignItems: 'center' }}>
          {formatBoundValue(bound, bound.min)} per position (fixed for everyone)
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={`arena-field-${path}`}>
      <label htmlFor={id} style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
        {bound.label}
        {unit ? <span style={{ color: FLOOR_TEXT.faint }}> ({unit})</span> : null}
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        {bound.nullable ? (
          <button
            type="button"
            aria-pressed={on}
            aria-label={`${bound.label}: ${on ? 'on' : 'off'}`}
            disabled={disabled}
            onClick={() => {
              if (on) {
                if (Number.isFinite(value)) setRemembered(value);
                onChange(null);
              } else {
                onChange(remembered !== null && Number.isFinite(remembered) ? remembered : onDefault(path, bound));
              }
            }}
            style={{
              ...arenaButtonStyle,
              minWidth: 56,
              padding: '8px 10px',
              color: on ? FLOOR_TEXT.accent : FLOOR_TEXT.muted,
            }}
          >
            {on ? 'On' : offLabel}
          </button>
        ) : null}
        {on ? (
          <NumberInput id={id} bound={bound} value={value} disabled={disabled} onChange={onChange} />
        ) : (
          <div
            id={id}
            style={{ ...arenaInputStyle, display: 'flex', alignItems: 'center', color: FLOOR_TEXT.faint, fontSize: 13 }}
          >
            Not used
          </div>
        )}
      </div>
      <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
        {formatBoundValue(bound, bound.min)} to {formatBoundValue(bound, bound.max)}
        {on && Number.isFinite(value) && (bound.unit === 'seconds' || bound.unit === 'usd' || bound.unit === 'fraction')
          ? `, now ${formatBoundValue(bound, value)}`
          : ''}
      </div>
      <FieldErrors errors={errors} />
    </div>
  );
}

function Section({ title, children, errors }: { title: string; children: ReactNode; errors?: readonly string[] }) {
  return (
    <section style={arenaInnerCardStyle}>
      <h4 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 13 }}>{title}</h4>
      <FieldErrors errors={errors} />
      {children}
    </section>
  );
}

function grid(compact: boolean) {
  return {
    display: 'grid',
    gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    gap: 10,
  } as const;
}

function TakeProfitEditor({
  legs,
  onChange,
  errors,
  disabled,
  compact,
}: {
  legs: Array<[number, number]>;
  onChange: (next: Array<[number, number]>) => void;
  errors: readonly string[] | undefined;
  disabled: boolean;
  compact: boolean;
}) {
  const setLeg = (index: number, slot: 0 | 1, next: number) => {
    onChange(legs.map((leg, i): [number, number] => {
      if (i !== index) return [leg[0], leg[1]];
      return slot === 0 ? [next, leg[1]] : [leg[0], next];
    }));
  };
  const used = legs.reduce((sum, [, fraction]) => sum + (Number.isFinite(fraction) ? fraction : 0), 0);
  const addLeg = () => {
    const last = legs[legs.length - 1];
    const multiple = last && Number.isFinite(last[0]) ? Math.min(B.exits.tp_multiple.max, Number((last[0] + 0.1).toFixed(2))) : 1.1;
    const fraction = Math.max(B.exits.tp_fraction.min, Number((1 - used).toFixed(2)));
    onChange([...legs.map((leg): [number, number] => [leg[0], leg[1]]), [multiple, fraction]]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="arena-field-exits.tp">
      <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
        {B.exits.tp_legs.label} (up to {FLOOR_ARENA_MAX_TP_LEGS}). Each leg sells a share of the ORIGINAL position when
        the price reaches its multiple. Shares add up to 100% or less.
      </div>
      {legs.length === 0 ? (
        <div style={{ color: FLOOR_TEXT.faint, fontSize: 12 }}>No take-profit legs. A stop, a trailing stop or the max hold time ends each trade.</div>
      ) : null}
      {legs.map(([multiple, fraction], index) => (
        <div
          key={index}
          style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr 1fr' : '1fr 1fr auto',
            gap: 6,
            alignItems: 'end',
          }}
        >
          <label style={{ color: FLOOR_TEXT.muted, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
            Leg {index + 1}: sell at (x)
            <NumberInput
              bound={B.exits.tp_multiple}
              value={multiple}
              disabled={disabled}
              onChange={(next) => setLeg(index, 0, next)}
              ariaLabel={`Leg ${index + 1} multiple`}
            />
          </label>
          <label style={{ color: FLOOR_TEXT.muted, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
            Share to sell (0 to 1)
            <NumberInput
              bound={B.exits.tp_fraction}
              value={fraction}
              disabled={disabled}
              onChange={(next) => setLeg(index, 1, next)}
              ariaLabel={`Leg ${index + 1} share`}
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(legs.filter((_, i) => i !== index).map((leg): [number, number] => [leg[0], leg[1]]))}
            style={{ ...arenaButtonStyle, color: FLOOR_TEXT.danger, gridColumn: compact ? '1 / -1' : undefined }}
          >
            Remove leg {index + 1}
          </button>
        </div>
      ))}
      <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
        Multiple {formatBoundValue(B.exits.tp_multiple, B.exits.tp_multiple.min)} to{' '}
        {formatBoundValue(B.exits.tp_multiple, B.exits.tp_multiple.max)}, share {B.exits.tp_fraction.min} to{' '}
        {B.exits.tp_fraction.max}. Shares used now: {Math.round(used * 100)}%.
      </div>
      {legs.length < FLOOR_ARENA_MAX_TP_LEGS ? (
        <button type="button" disabled={disabled} onClick={addLeg} style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}>
          Add a take-profit leg
        </button>
      ) : null}
      <FieldErrors errors={errors} />
    </div>
  );
}

export function ArenaParamsForm({
  value,
  onChange,
  errors,
  disabled = false,
  compact,
}: {
  value: FloorArenaParams;
  onChange: (next: FloorArenaParams) => void;
  errors: readonly string[];
  disabled?: boolean;
  compact: boolean;
}) {
  const byPath = errorsByPath(errors);
  const rankId = useId();
  const firstSightId = useId();
  const filterErrorCount = [...byPath.keys()].filter((path) => path.startsWith('filters')).length;

  const setFilter = (key: keyof FloorArenaFilters, next: number | null) =>
    onChange({ ...value, filters: { ...value.filters, [key]: next } });
  const setEntry = (patch: Partial<FloorArenaParams['entry']>) =>
    onChange({ ...value, entry: { ...value.entry, ...patch } });
  const setExits = (patch: Partial<FloorArenaParams['exits']>) =>
    onChange({ ...value, exits: { ...value.exits, ...patch } });
  const setLimits = (patch: Partial<FloorArenaParams['limits']>) =>
    onChange({ ...value, limits: { ...value.limits, ...patch } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="arena-params-form">
      <ArenaHardRules />
      <FieldErrors errors={byPath.get('params')} />

      <details
        // Re-mounts when errors appear, so a collapsed filter list opens on the
        // field that needs a fix instead of hiding it.
        key={filterErrorCount > 0 ? 'filters-errors' : 'filters-ok'}
        open={filterErrorCount > 0 || !compact}
        style={arenaInnerCardStyle}
      >
        <summary
          style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer', color: FLOOR_TEXT.value, fontSize: 13, fontWeight: 700 }}
        >
          Which coins it looks at
          {filterErrorCount > 0 ? (
            <span style={{ color: FLOOR_TEXT.danger, fontWeight: 400, marginLeft: 6 }}>
              ({filterErrorCount} to fix)
            </span>
          ) : null}
        </summary>
        <FieldErrors errors={byPath.get('filters')} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          {FILTER_ROWS.map((row) => (
            <div key={row.title} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ color: FLOOR_TEXT.primary, fontSize: 12, fontWeight: 700 }}>{row.title}</div>
              <div style={grid(compact)}>
                {row.min ? (
                  <NumberField
                    path={`filters.${row.min}`}
                    bound={B.filters[row.min]}
                    value={value.filters[row.min]}
                    onChange={(next) => setFilter(row.min!, next)}
                    errors={byPath.get(`filters.${row.min}`)}
                    disabled={disabled}
                  />
                ) : null}
                {row.max ? (
                  <NumberField
                    path={`filters.${row.max}`}
                    bound={B.filters[row.max]}
                    value={value.filters[row.max]}
                    onChange={(next) => setFilter(row.max!, next)}
                    errors={byPath.get(`filters.${row.max}`)}
                    disabled={disabled}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </details>

      <Section title="How it picks a coin" errors={byPath.get('entry')}>
        <div style={grid(compact)}>
          <NumberField
            path="entry.discovered_within_s"
            bound={B.entry.discovered_within_s}
            value={value.entry.discovered_within_s}
            onChange={(next) => setEntry({ discovered_within_s: next })}
            errors={byPath.get('entry.discovered_within_s')}
            disabled={disabled}
            offLabel="Any"
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="arena-field-entry.first_sight_sources">
            <label htmlFor={firstSightId} style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
              Count first sight from
            </label>
            <select
              id={firstSightId}
              value={value.entry.first_sight_sources}
              // Only the "first seen within" clock reads it, so it waits until
              // that filter is on. The value stays in the rules either way.
              disabled={disabled || value.entry.discovered_within_s === null}
              onChange={(event) => setEntry({ first_sight_sources: event.target.value as FloorArenaFirstSightSources })}
              style={{ ...arenaInputStyle, opacity: disabled || value.entry.discovered_within_s === null ? 0.5 : 1 }}
            >
              {FLOOR_ARENA_FIRST_SIGHT_SOURCES.map((option) => (
                <option key={option} value={option}>
                  {firstSightLabel(option)}
                </option>
              ))}
            </select>
            {value.entry.discovered_within_s === null ? (
              <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>Used only when &quot;Only coins first seen within&quot; is on.</div>
            ) : null}
            <FieldErrors errors={byPath.get('entry.first_sight_sources')} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="arena-field-entry.rank_by">
            <label htmlFor={rankId} style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
              Pick order when several coins pass
            </label>
            <select
              id={rankId}
              value={value.entry.rank_by}
              disabled={disabled}
              onChange={(event) => setEntry({ rank_by: event.target.value as FloorArenaRankBy })}
              style={arenaInputStyle}
            >
              {FLOOR_ARENA_RANK_BY.map((option) => (
                <option key={option} value={option}>
                  {rankByLabel(option)}
                </option>
              ))}
            </select>
            <FieldErrors errors={byPath.get('entry.rank_by')} />
          </div>
          <NumberField
            path="entry.entries_per_tick"
            bound={B.entry.entries_per_tick}
            value={value.entry.entries_per_tick}
            onChange={(next) => setEntry({ entries_per_tick: next ?? Number.NaN })}
            errors={byPath.get('entry.entries_per_tick')}
            disabled={disabled}
          />
        </div>
      </Section>

      <Section title="When it sells" errors={byPath.get('exits')}>
        <TakeProfitEditor
          legs={value.exits.tp}
          onChange={(tp) => setExits({ tp })}
          errors={byPath.get('exits.tp')}
          disabled={disabled}
          compact={compact}
        />
        <div style={grid(compact)}>
          <NumberField
            path="exits.stop_mult"
            bound={B.exits.stop_mult}
            value={value.exits.stop_mult}
            onChange={(next) => setExits({ stop_mult: next })}
            errors={byPath.get('exits.stop_mult')}
            disabled={disabled}
          />
          <NumberField
            path="exits.trail_from_peak"
            bound={B.exits.trail_from_peak}
            value={value.exits.trail_from_peak}
            // The arm only means something with a trail, and the validator
            // refuses an arm without one, so turning the trail off clears it.
            onChange={(next) =>
              setExits(next === null ? { trail_from_peak: null, trail_arm_mult: null } : { trail_from_peak: next })
            }
            errors={byPath.get('exits.trail_from_peak')}
            disabled={disabled}
          />
          <NumberField
            path="exits.trail_arm_mult"
            bound={B.exits.trail_arm_mult}
            value={value.exits.trail_arm_mult}
            onChange={(next) => setExits({ trail_arm_mult: next })}
            errors={byPath.get('exits.trail_arm_mult')}
            disabled={disabled || value.exits.trail_from_peak === null}
            offLabel="At once"
          />
          <NumberField
            path="exits.max_hold_s"
            bound={B.exits.max_hold_s}
            value={value.exits.max_hold_s}
            onChange={(next) => setExits({ max_hold_s: next ?? Number.NaN })}
            errors={byPath.get('exits.max_hold_s')}
            disabled={disabled}
          />
        </div>
      </Section>

      <Section title="Limits" errors={byPath.get('limits')}>
        <div style={grid(compact)}>
          <NumberField
            path="limits.position_usd"
            bound={B.limits.position_usd}
            value={value.limits.position_usd}
            onChange={() => undefined}
            errors={byPath.get('limits.position_usd')}
            disabled
          />
          <NumberField
            path="limits.max_open"
            bound={B.limits.max_open}
            value={value.limits.max_open}
            onChange={(next) => setLimits({ max_open: next ?? Number.NaN })}
            errors={byPath.get('limits.max_open')}
            disabled={disabled}
          />
          <NumberField
            path="limits.reentry_cooldown_s"
            bound={B.limits.reentry_cooldown_s}
            value={value.limits.reentry_cooldown_s}
            onChange={(next) => setLimits({ reentry_cooldown_s: next ?? Number.NaN })}
            errors={byPath.get('limits.reentry_cooldown_s')}
            disabled={disabled}
          />
        </div>
      </Section>
    </div>
  );
}
