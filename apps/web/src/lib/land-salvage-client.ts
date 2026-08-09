import { ApiError } from '@/lib/api';

/** Player-facing copy for the §2.9 `SettlementFailure` codes salvage claim can return. */
const ERROR_COPY: Readonly<Record<string, string>> = {
  node_on_cooldown: 'This spot is still recovering — come back later.',
  avatar_daily_cap: "You've salvaged as much as you can today.",
  owner_daily_cap: 'Your account has hit its daily salvage limit across all your avatars.',
  house_excluded: 'House actors cannot salvage.',
  owner_unresolved: 'Your session could not be verified — try reconnecting.',
  binding_drift: 'Your session changed — try reconnecting.',
  session_expired: 'Your session expired — try reconnecting.',
  not_ledger_capable: 'This account cannot earn materials yet.',
  idempotency_key_conflict: 'Try again.',
  concurrent_retry: 'Someone else reached this spot first — try again.',
};

export function salvageClaimErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.code ?? null;
}

export function isSalvageIdempotencyConflict(error: unknown): boolean {
  return salvageClaimErrorCode(error) === 'idempotency_key_conflict';
}

export function salvageClaimErrorMessage(error: unknown): string {
  const code = salvageClaimErrorCode(error);
  return (code && ERROR_COPY[code]) || "Couldn't gather that — try again.";
}

export function freshSalvageIdempotencyKey(): string {
  return crypto.randomUUID().slice(0, 32);
}
