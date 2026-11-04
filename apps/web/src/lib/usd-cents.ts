/**
 * Dollar text <-> integer US cents for the spend-rules form. No float math:
 * the text is split at the decimal point. Empty text means "not set" (null).
 */

export type UsdParse = { ok: true; cents: number | null } | { ok: false; reason: string };

export function parseUsdToCents(text: string, maxCents: number): UsdParse {
  const trimmed = text.trim().replace(/^\$/, '');
  if (trimmed === '') return { ok: true, cents: null };
  const match = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (!match) return { ok: false, reason: 'Use dollars, for example 2 or 0.50' };
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents > maxCents) return { ok: false, reason: `The limit is $${(maxCents / 100).toFixed(2)}` };
  return { ok: true, cents };
}

export function centsToUsdText(cents: number | null): string {
  if (cents === null) return '';
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
