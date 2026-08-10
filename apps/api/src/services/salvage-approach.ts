/**
 * Seabed salvage — the approach gate (Land gamification P7b, design §2.5).
 *
 * ══ THIS IS FRICTION AND TELEMETRY. IT IS NOT ANTI-CHEAT. ═══════════════════
 *
 * Say it plainly because the design says it plainly. Position updates are NOT
 * authoritative today: `worldPositionSchema` accepts any finite coordinate and
 * `roomRegistry.updatePosition` assigns it with no speed, path or collider
 * validation — the only guard is a 10 Hz throttle. A determined client can
 * therefore place itself beside any node and satisfy everything below.
 *
 * What this buys, honestly:
 *   - a real cost to casual teleport-farming (a dwell period per node, and a
 *     poisoned window after any impossible jump),
 *   - a NAMED refusal code on every failure, so teleport attempts show up in
 *     telemetry instead of being invisible,
 *   - a seam that a real arrival proof drops into unchanged.
 *
 * What it does NOT buy: any part of the economy's safety. That work is done by
 * the per-node cooldown, the per-avatar daily cap and the per-owner daily cap,
 * none of which depend on position being truthful.
 *
 * Founder ruling Q10 scoped server-authoritative movement as its own
 * world-presence pass. When it lands, `issueApproachToken` is where the real
 * proof replaces the heuristic. Nothing here blocks on it.
 *
 * ── WHY THE ANCHOR IS IN-PROCESS ────────────────────────────────────────────
 * The anchor is a heuristic input to a heuristic gate, so persisting it would
 * buy durability for a signal that is not trusted anyway — at the cost of a
 * database write on every 10 Hz-adjacent probe. A process restart or a request
 * landing on another API process simply finds no anchor and costs the player
 * one dwell period, which the design calls out explicitly as the accepted
 * behaviour rather than a defect.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  SALVAGE_APPROACH_DWELL_MS,
  SALVAGE_APPROACH_RANGE_WU,
  SALVAGE_APPROACH_TOKEN_TTL_MS,
  SALVAGE_MAX_SPEED_WU_PER_S,
  getSalvageNode,
} from '@clawville/shared';

const TOKEN_DOMAIN = 'clawville:salvage-approach:v1';
/** Tolerated clock skew when reading an `issuedAt` from a token. */
const CLOCK_SKEW_MS = 5_000;
/** Anchors older than this are indistinguishable from "absent" and are swept. */
const ANCHOR_TTL_MS = 10 * 60 * 1000;
const ANCHOR_SWEEP_THRESHOLD = 5_000;

export type ApproachRefusalCode =
  | 'node_unknown'
  | 'anchor_pending'
  | 'movement_poisoned'
  | 'impossible_movement'
  | 'out_of_range'
  | 'dwell_pending';

export type ApproachVerdict =
  | { readonly ok: true; readonly token: string; readonly expiresAt: string }
  | {
      readonly ok: false;
      readonly code: ApproachRefusalCode;
      /** Milliseconds the caller should wait before retrying, when knowable. */
      readonly retryAfterMs?: number;
    };

interface AnchorState {
  x: number;
  z: number;
  atMs: number;
  /** Eligibility is refused until this instant after an impossible jump. */
  poisonedUntilMs: number;
  /** Which node the current dwell is accumulating against. */
  dwellNodeId: string | null;
  dwellSinceMs: number;
}

const anchors = new Map<string, AnchorState>();

function sweep(nowMs: number): void {
  if (anchors.size <= ANCHOR_SWEEP_THRESHOLD) return;
  for (const [key, state] of anchors) {
    if (nowMs - state.atMs > ANCHOR_TTL_MS) anchors.delete(key);
  }
}

/** Test seam — clears in-process anchor state. */
export function resetSalvageApproachAnchors(): void {
  anchors.clear();
}

function hmacKey(secret: string): Buffer {
  return createHash('sha256').update(`${secret}${TOKEN_DOMAIN}`).digest();
}

function requireSecret(): string {
  const secret = process.env.FINGERPRINT_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error('salvage-approach: FINGERPRINT_SECRET is required to sign approach tokens');
  }
  return secret;
}

function sign(subject: string, nodeId: string, issuedAtMs: number, secret: string): string {
  return createHmac('sha256', hmacKey(secret))
    .update(`${subject}|${nodeId}|${issuedAtMs}`)
    .digest('base64url');
}

/**
 * Advance the anchor and, if the caller has dwelled in range, issue a token.
 *
 * The anchor advances ONLY when the reported movement was physically possible
 * at `SALVAGE_MAX_SPEED_WU_PER_S`. An impossible jump poisons eligibility for
 * exactly as long as walking the excess distance would have taken, so the
 * cheat is never faster than the honest route.
 */
export function issueApproachToken(input: {
  readonly subject: string;
  readonly nodeId: string;
  readonly x: number;
  readonly z: number;
  readonly nowMs?: number;
  readonly secret?: string;
}): ApproachVerdict {
  const nowMs = input.nowMs ?? Date.now();
  const node = getSalvageNode(input.nodeId);
  if (!node) return { ok: false, code: 'node_unknown' };

  sweep(nowMs);
  const prior = anchors.get(input.subject);

  // No anchor (first probe, restart, or another API process) — record one and
  // refuse. This deliberately costs one dwell period; it is the design's stated
  // behaviour, not an oversight.
  if (!prior || nowMs - prior.atMs > ANCHOR_TTL_MS) {
    anchors.set(input.subject, {
      x: input.x,
      z: input.z,
      atMs: nowMs,
      poisonedUntilMs: 0,
      dwellNodeId: null,
      dwellSinceMs: 0,
    });
    return { ok: false, code: 'anchor_pending', retryAfterMs: SALVAGE_APPROACH_DWELL_MS };
  }

  const elapsedMs = Math.max(0, nowMs - prior.atMs);
  const travelled = Math.hypot(input.x - prior.x, input.z - prior.z);
  const reachable = (SALVAGE_MAX_SPEED_WU_PER_S * elapsedMs) / 1000;

  if (travelled > reachable) {
    // POISON. The excess distance is converted back into the time it would have
    // taken to walk, and eligibility is withheld for that long. The anchor
    // still moves to the claimed position, so the player is not stuck — they
    // just cannot profit from the jump.
    const excessMs = ((travelled - reachable) / SALVAGE_MAX_SPEED_WU_PER_S) * 1000;
    const poisonedUntilMs = Math.max(prior.poisonedUntilMs, nowMs + excessMs);
    anchors.set(input.subject, {
      x: input.x,
      z: input.z,
      atMs: nowMs,
      poisonedUntilMs,
      dwellNodeId: null,
      dwellSinceMs: 0,
    });
    return {
      ok: false,
      code: 'impossible_movement',
      retryAfterMs: Math.ceil(poisonedUntilMs - nowMs),
    };
  }

  const state: AnchorState = {
    x: input.x,
    z: input.z,
    atMs: nowMs,
    poisonedUntilMs: prior.poisonedUntilMs,
    dwellNodeId: prior.dwellNodeId,
    dwellSinceMs: prior.dwellSinceMs,
  };

  if (nowMs < state.poisonedUntilMs) {
    // A poisoned subject accrues no dwell — otherwise the poison window would
    // double as free dwell time and cost the cheater nothing.
    state.dwellNodeId = null;
    state.dwellSinceMs = 0;
    anchors.set(input.subject, state);
    return {
      ok: false,
      code: 'movement_poisoned',
      retryAfterMs: Math.ceil(state.poisonedUntilMs - nowMs),
    };
  }

  const distanceToNode = Math.hypot(input.x - node.x, input.z - node.z);
  if (distanceToNode > SALVAGE_APPROACH_RANGE_WU) {
    state.dwellNodeId = null;
    state.dwellSinceMs = 0;
    anchors.set(input.subject, state);
    return { ok: false, code: 'out_of_range' };
  }

  if (state.dwellNodeId !== input.nodeId) {
    state.dwellNodeId = input.nodeId;
    state.dwellSinceMs = nowMs;
    anchors.set(input.subject, state);
    return { ok: false, code: 'dwell_pending', retryAfterMs: SALVAGE_APPROACH_DWELL_MS };
  }

  const dwelled = nowMs - state.dwellSinceMs;
  anchors.set(input.subject, state);
  if (dwelled < SALVAGE_APPROACH_DWELL_MS) {
    return {
      ok: false,
      code: 'dwell_pending',
      retryAfterMs: Math.ceil(SALVAGE_APPROACH_DWELL_MS - dwelled),
    };
  }

  const secret = input.secret ?? requireSecret();
  const signature = sign(input.subject, input.nodeId, nowMs, secret);
  return {
    ok: true,
    token: `${nowMs}.${signature}`,
    expiresAt: new Date(nowMs + SALVAGE_APPROACH_TOKEN_TTL_MS).toISOString(),
  };
}

export type ApproachTokenVerdict =
  | { readonly ok: true; readonly issuedAtMs: number }
  | { readonly ok: false; readonly code: 'invalid_token' | 'expired_token' };

/**
 * Verify a token against the SUBJECT and the NODE it was issued for.
 *
 * Both are part of the signed payload, so a token earned by dwelling at one
 * node cannot be spent at another, and a token issued to one avatar cannot be
 * replayed by a second. Comparison is timing-safe.
 */
export function verifyApproachToken(input: {
  readonly token: string;
  readonly subject: string;
  readonly nodeId: string;
  readonly nowMs?: number;
  readonly secret?: string;
}): ApproachTokenVerdict {
  const nowMs = input.nowMs ?? Date.now();
  const parts = input.token.split('.');
  if (parts.length !== 2) return { ok: false, code: 'invalid_token' };
  const [issuedRaw, signatureRaw] = parts;
  const issuedAtMs = Number(issuedRaw);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs > nowMs + CLOCK_SKEW_MS) {
    return { ok: false, code: 'invalid_token' };
  }
  if (nowMs - issuedAtMs >= SALVAGE_APPROACH_TOKEN_TTL_MS) {
    return { ok: false, code: 'expired_token' };
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(signatureRaw!, 'base64url');
  } catch {
    return { ok: false, code: 'invalid_token' };
  }
  const expected = Buffer.from(
    sign(input.subject, input.nodeId, issuedAtMs, input.secret ?? requireSecret()),
    'base64url',
  );
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, code: 'invalid_token' };
  }
  return { ok: true, issuedAtMs };
}
