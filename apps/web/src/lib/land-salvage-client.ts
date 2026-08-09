import { ApiError } from '@/lib/api';

/**
 * Salvage error-code reader. The salvage routes return `{ ok:false, error:
 * '<code>', ... }` — there is NO `code` field on the wire, so `ApiError.code`
 * (populated from a `code` field elsewhere in the API) is always undefined
 * here. `ApiError.message` carries the `error` field's value instead (see
 * `honoRequest`: `new ApiError(err.error || ..., status, err.code, ...)`).
 * Falls back `code ?? message`, matching the established
 * `landPieceErrorCode` convention in `land-yard-editor.ts` for the same
 * reason (that route ALSO answers with `error`, not `code`, on several
 * refusals).
 */
export function salvageErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.code ?? error.message ?? null;
}

export function isSalvageIdempotencyConflict(error: unknown): boolean {
  return salvageErrorCode(error) === 'idempotency_key_conflict';
}

/**
 * Approach-poll codes that are the EXPECTED steady state while dwelling, not
 * a real problem — a poller should keep polling silently, not toast an error.
 */
const APPROACH_IN_PROGRESS_CODES = new Set(['anchor_pending', 'dwell_pending']);

export function isApproachInProgress(error: unknown): boolean {
  return APPROACH_IN_PROGRESS_CODES.has(salvageErrorCode(error) ?? '');
}

/** Player-facing copy for the real `LandSalvageApproachErrorCode` union. */
const APPROACH_ERROR_COPY: Readonly<Record<string, string>> = {
  node_unknown: "That spot isn't a salvage node.",
  out_of_range: 'Move closer to gather here.',
  movement_poisoned: 'Move to the node and hold still.',
  impossible_movement: 'Move to the node and hold still.',
  rate_limited: 'Slow down — try again in a moment.',
};

export function salvageApproachErrorMessage(error: unknown): string {
  const code = salvageErrorCode(error);
  return (code && APPROACH_ERROR_COPY[code]) || "Couldn't reach that spot — try again.";
}

/** Player-facing copy for the real `LandSalvageClaimErrorCode` union. */
const CLAIM_ERROR_COPY: Readonly<Record<string, string>> = {
  node_unknown: "That spot isn't a salvage node.",
  node_on_cooldown: 'This spot is still recovering — come back later.',
  avatar_daily_cap: "You've salvaged as much as you can today.",
  owner_daily_cap: 'Your account has hit its daily salvage limit across all your avatars.',
  house_excluded: 'House actors cannot salvage.',
  owner_unresolved: 'Your session could not be verified — try reconnecting.',
  binding_drift: 'Your session changed — try reconnecting.',
  idempotency_key_conflict: 'Try again.',
  idempotency_key_required: 'Try again.',
  invalid_body: 'Try again.',
  concurrent_retry: 'Someone else reached this spot first — try again.',
  invalid_token: 'That approach expired — walk up again.',
  expired_token: 'That approach expired — walk up again.',
  rate_limited: 'Slow down — try again in a moment.',
};

export function salvageClaimErrorMessage(error: unknown): string {
  const code = salvageErrorCode(error);
  return (code && CLAIM_ERROR_COPY[code]) || "Couldn't gather that — try again.";
}

/** A claim's `approachToken` expired or is otherwise invalid — restart the approach poll, not a scary toast. */
export function isSalvageTokenInvalid(error: unknown): boolean {
  const code = salvageErrorCode(error);
  return code === 'invalid_token' || code === 'expired_token';
}

export function freshSalvageIdempotencyKey(): string {
  return crypto.randomUUID().slice(0, 32);
}
