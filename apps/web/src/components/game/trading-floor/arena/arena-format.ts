import {
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_RANK_BY_LABELS,
  type FloorArenaBound,
  type FloorArenaParams,
  type FloorArenaRankBy,
} from '@clawville/shared';

import { FLOOR_TEXT } from '../tokens';

// Pure formatting for the arena panels. No React, so the tests read it
// directly. Every money figure takes `number | null`: null is "we could not
// read it" and must never print as $0.00.

/** Two colours the shared token module does not carry yet. */
export const ARENA_TONE = {
  paramChange: FLOOR_TEXT.accent,
  report: 'rgba(196,181,253,1)',
} as const;

export function signedUsd(value: number | null): string {
  if (value === null) return 'n/a';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

/** Green for a gain, red for a loss, muted for exactly zero or unknown. */
export function pnlTone(value: number | null): string {
  if (value === null || value === 0) return FLOOR_TEXT.muted;
  return value > 0 ? FLOOR_TEXT.positive : FLOOR_TEXT.danger;
}

export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${trimZeros((abs / 1_000_000).toFixed(2))}M`;
  if (abs >= 1_000) return `${sign}$${trimZeros((abs / 1_000).toFixed(1))}k`;
  return `${sign}$${trimZeros(abs.toFixed(2))}`;
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** 900 -> "15 min", 21600 -> "6 h", 5400 -> "1 h 30 min", 45 -> "45 s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  if (seconds < 86_400 * 2) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.round((seconds % 3_600) / 60);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.round((seconds % 86_400) / 3_600);
  return hours ? `${days} d ${hours} h` : `${days} d`;
}

export function formatMultiple(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}x`;
}

export function formatFraction(value: number): string {
  return `${trimZeros((value * 100).toFixed(1))}%`;
}

/** "3m ago" from an ISO time; "time unavailable" when it cannot be read. */
export function isoAgo(iso: string | null, nowMs: number): string {
  if (!iso) return 'time unavailable';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'time unavailable';
  const ageMs = Math.max(0, nowMs - at);
  if (ageMs < 60_000) return 'now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

/** "4d 05h 59m 58s"; drops leading zero units. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

export type ContestPhase = 'upcoming' | 'live' | 'ended';

export function contestPhase(startsAt: string, endsAt: string, nowMs: number): ContestPhase {
  if (nowMs < Date.parse(startsAt)) return 'upcoming';
  if (nowMs <= Date.parse(endsAt)) return 'live';
  return 'ended';
}

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** "Wed, Sep 30, 6:00 PM EDT". The founder and the contest run on Eastern time. */
export function easternTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? EASTERN.format(at) : 'n/a';
}

/** A value in the unit its bound declares, for read-only display. */
export function formatBoundValue(bound: FloorArenaBound, value: number | null): string {
  if (value === null) return 'off';
  switch (bound.unit) {
    case 'usd':
      return compactUsd(value);
    case 'seconds':
      return formatDuration(value);
    case 'percent':
      return `${trimZeros(value.toFixed(2))}%`;
    case 'multiple':
      return `${value.toFixed(2)}x`;
    case 'fraction':
      return formatFraction(value);
    default:
      return trimZeros(String(value));
  }
}

export const UNIT_SUFFIX: Readonly<Record<FloorArenaBound['unit'], string>> = {
  usd: 'USD',
  seconds: 'seconds',
  percent: '%',
  ratio: 'ratio',
  multiple: 'x',
  fraction: '0 to 1',
  count: '',
};

export function rankByLabel(value: FloorArenaRankBy): string {
  return FLOOR_ARENA_RANK_BY_LABELS[value] ?? value;
}

/** One leg as "1.10x sells 100%". */
export function formatTpLeg([multiple, fraction]: readonly [number, number]): string {
  return `${multiple.toFixed(2)}x sells ${formatFraction(fraction)}`;
}

/** The exit rules of a params object as short phrases, for a position row. */
export function exitTargets(params: FloorArenaParams): string[] {
  const out = params.exits.tp.map((leg) => `TP ${formatTpLeg(leg)}`);
  if (params.exits.stop_mult !== null) out.push(`Stop ${formatMultiple(params.exits.stop_mult)}`);
  if (params.exits.trail_from_peak !== null) {
    const arm = params.exits.trail_arm_mult;
    out.push(
      `Trail ${formatFraction(params.exits.trail_from_peak)} from peak${arm !== null ? ` after ${formatMultiple(arm)}` : ''}`,
    );
  }
  out.push(`Max hold ${formatDuration(params.exits.max_hold_s)}`);
  return out;
}

/** The label a dotted param path has in the form, e.g. "Min market cap". */
export function paramPathLabel(path: string): string {
  const [section, key] = path.split('.') as [keyof typeof FLOOR_ARENA_PARAM_BOUNDS | 'entry', string];
  if (path === 'exits.tp') return 'Take-profit legs';
  if (path === 'entry.rank_by') return 'Pick order';
  const group = (FLOOR_ARENA_PARAM_BOUNDS as unknown as Record<string, Record<string, FloorArenaBound>>)[section];
  return group?.[key]?.label ?? path;
}

/** Formats a param value for a diff line or a suggestion card. */
export function formatParamValue(path: string, value: unknown): string {
  if (value === null || value === undefined) return 'off';
  if (path === 'exits.tp') {
    if (!Array.isArray(value) || value.length === 0) return 'no legs';
    return value
      .filter((leg): leg is [number, number] => Array.isArray(leg) && leg.length === 2)
      .map((leg) => formatTpLeg(leg))
      .join(', ');
  }
  if (path === 'entry.rank_by') return typeof value === 'string' ? rankByLabel(value as FloorArenaRankBy) : String(value);
  const [section, key] = path.split('.');
  const group = (FLOOR_ARENA_PARAM_BOUNDS as unknown as Record<string, Record<string, FloorArenaBound>>)[section ?? ''];
  const bound = group?.[key ?? ''];
  if (bound && typeof value === 'number') return formatBoundValue(bound, value);
  return String(value);
}

/**
 * Splits validator errors ("filters.mcap_min: must be ...") by the path before
 * the first ": ". A take-profit leg error ("exits.tp[0][0]: ...") is filed
 * under "exits.tp" so the leg editor shows it.
 */
export function errorsByPath(errors: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of errors) {
    const split = line.indexOf(': ');
    const rawPath = split > 0 ? line.slice(0, split) : 'params';
    const message = split > 0 ? line.slice(split + 2) : line;
    const path = rawPath.startsWith('exits.tp') ? 'exits.tp' : rawPath;
    const bucket = out.get(path) ?? [];
    bucket.push(rawPath.startsWith('exits.tp[') ? `${legLabel(rawPath)}: ${message}` : message);
    out.set(path, bucket);
  }
  return out;
}

function legLabel(rawPath: string): string {
  const match = /^exits\.tp\[(\d+)\](?:\[(\d)\])?/.exec(rawPath);
  if (!match) return 'Leg';
  const leg = Number(match[1]) + 1;
  if (match[2] === '0') return `Leg ${leg} multiple`;
  if (match[2] === '1') return `Leg ${leg} share`;
  return `Leg ${leg}`;
}
