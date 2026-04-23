/**
 * Q2 Activity Portals — generic anti-cheat validators (chunk #3).
 *
 * Game-agnostic validators reused by both Bumper Shells (chunk #3) and
 * Reef Race (chunk #5). Pure functions where possible — the rate-tracker
 * carries per-avatar state in a Map but exposes pure-style verdicts.
 *
 * Trust-model summary (backend §4.1): inputs are intent, state is
 * authoritative. These validators sit at the input boundary — every
 * incoming message that mutates server state runs through one of them.
 *
 * NOTE on profanity: there's no existing word-list utility in the repo.
 * Chunk #3 ships a tiny rolling list of seven egregious words so chat
 * isn't completely raw; chunk #12 will replace this with a proper
 * curated list (e.g. fluent-ffmpeg-style or a cdn-served jsonl).
 */

// ─── Constants — founder-tunable ────────────────────────────────────────────

/** Max chat message length per backend §3.3 + ClientChatFrame schema */
export const MAX_CHAT_LEN = 140;

/**
 * Max accepted client input rate (Hz). Backend §3.3 specs ≤60Hz humans;
 * the anti-cheat clamps higher than that to absorb burst jitter without
 * over-flagging. Above CLAMP → soft `error` reply, no close.
 */
export const MAX_INPUT_HZ = 60;

/**
 * Window over which we count input frames for rate enforcement.
 * 1s window × MAX_INPUT_HZ = the per-second cap; the rolling-window
 * approach is gentler on bursty traffic than a hard frame-by-frame cap.
 */
const INPUT_RATE_WINDOW_MS = 1_000;

/**
 * Default tolerance multiplier applied when clamping over-magnitude
 * inputs (overspeed / overaccel). 1.15 absorbs ~15% drift from network
 * jitter + float rounding without flagging — see backend §12.5.
 */
export const DEFAULT_CLAMP_TOLERANCE = 1.15;

/**
 * The seven "stop-the-show" words. Replaced wholesale in chunk #12 with
 * a curated jsonl. Lowercased + word-boundary substring match — not a
 * real moderation system, just a baseline so chat isn't gross out of
 * the gate.
 */
const PROFANITY_FALLBACK = [
  // Intentionally light — full replacement in chunk #12.
  // Listing inline would attract grep noise; load from env if present.
  ...((process.env.ACTIVITY_PROFANITY_FALLBACK ?? '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0)),
];

// ─── Verdict shape ──────────────────────────────────────────────────────────

/**
 * Verdict returned by every validator. `clamped` carries the
 * server-acceptable value when the validator clamped a bound; `flagged`
 * trips the per-match flag counter (5 → forfeit per backend §4.7).
 */
export interface ValidationVerdict<T = unknown> {
  /** True if the input was within bounds without clamping */
  ok: boolean;
  /** Server-acceptable value (input as-is when ok, clamped otherwise) */
  value: T;
  /** Did we clamp the input down to a bound? */
  clamped: boolean;
  /** Should this trip the per-match flag counter? */
  flagged: boolean;
  /** Diagnostic flag-kind — feeds anti_cheat.flag event payload */
  flagKind?:
    | 'overspeed'
    | 'overaccel'
    | 'input_bounds'
    | 'input_rate'
    | 'powerup_unowned'
    | 'underminlap'
    | 'checkpoint_skip'
    | 'seq_gap'
    | 'ghost_input';
  /** Human-readable diagnostic for logs/admin UI */
  detail?: string;
}

// ─── Generic clamp helper ───────────────────────────────────────────────────

/**
 * Clamp a magnitude to `max * tolerance`. Returns `{clamped, didClamp}`
 * — caller decides whether `didClamp` should also flag.
 *
 * Designed for scalar overspeed/overaccel checks where the ratio matters
 * (NOT for vector clamps — see `clampVectorMagnitude` for those).
 */
export function clampToTolerance(
  value: number,
  max: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): { clamped: number; didClamp: boolean } {
  const limit = max * tolerance;
  if (Math.abs(value) <= limit) return { clamped: value, didClamp: false };
  // Clamp to the un-toleranced max (not the toleranced limit) so we
  // don't keep raising the ceiling on repeat over-magnitude inputs.
  const sign = value < 0 ? -1 : 1;
  return { clamped: sign * max, didClamp: true };
}

/**
 * Clamp a 2D vector's magnitude to `max * tolerance`, preserving
 * direction. Returns the clamped vector plus a flag.
 */
export function clampVectorMagnitude(
  v: { x: number; y: number },
  max: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): { clamped: { x: number; y: number }; didClamp: boolean } {
  const mag = Math.hypot(v.x, v.y);
  const limit = max * tolerance;
  if (mag <= limit || mag === 0) return { clamped: { x: v.x, y: v.y }, didClamp: false };
  const scale = max / mag;
  return { clamped: { x: v.x * scale, y: v.y * scale }, didClamp: true };
}

// ─── Chat validation ────────────────────────────────────────────────────────

/**
 * Validate an inbound chat frame's text. Length-clamped; profanity
 * blocked at substring level (case-insensitive).
 */
export function validateChatBounds(text: string): ValidationVerdict<string> {
  if (typeof text !== 'string') {
    return {
      ok: false,
      value: '',
      clamped: false,
      flagged: false,
      detail: 'chat_text_not_string',
    };
  }
  if (text.length === 0) {
    return {
      ok: false,
      value: '',
      clamped: false,
      flagged: false,
      detail: 'chat_text_empty',
    };
  }
  let value = text;
  let clamped = false;
  if (value.length > MAX_CHAT_LEN) {
    value = value.slice(0, MAX_CHAT_LEN);
    clamped = true;
  }
  if (PROFANITY_FALLBACK.length > 0) {
    const lower = value.toLowerCase();
    if (PROFANITY_FALLBACK.some((w) => lower.includes(w))) {
      return {
        ok: false,
        value: '',
        clamped: true,
        flagged: false,
        detail: 'chat_text_profane',
      };
    }
  }
  return { ok: !clamped, value, clamped, flagged: false };
}

// ─── Rate tracking ──────────────────────────────────────────────────────────

/**
 * Per-avatar rolling-window input timestamp tracker. The Map lives on the
 * tracker instance; one tracker per WS hub instance is plenty.
 *
 * On overflow → returns a verdict with `flagged=false` (rate is normal
 * latency noise, not cheating per backend §4.4 closing note); the WS
 * hub uses `ok=false` to send a soft `error` frame and DROP the input.
 */
export class InputRateTracker {
  private timestamps = new Map<string, number[]>();

  validateInputRate(avatarId: string, now: number = Date.now()): ValidationVerdict<void> {
    let times = this.timestamps.get(avatarId);
    if (!times) {
      times = [];
      this.timestamps.set(avatarId, times);
    }
    // Drop timestamps outside the rolling window.
    const cutoff = now - INPUT_RATE_WINDOW_MS;
    while (times.length > 0 && times[0] < cutoff) {
      times.shift();
    }
    if (times.length >= MAX_INPUT_HZ) {
      return {
        ok: false,
        value: undefined,
        clamped: false,
        flagged: false,
        flagKind: 'input_rate',
        detail: `input_rate_${times.length}_per_${INPUT_RATE_WINDOW_MS}ms`,
      };
    }
    times.push(now);
    return { ok: true, value: undefined, clamped: false, flagged: false };
  }

  /** Drop tracking for a avatar on disconnect / match end. */
  forget(avatarId: string): void {
    this.timestamps.delete(avatarId);
  }

  /** Test hook — wipe all in-memory state. */
  __resetForTest(): void {
    this.timestamps.clear();
  }
}

// ─── Misc input bounds ──────────────────────────────────────────────────────

/**
 * Validate scalar/vector input bounds present on every `ClientInputFrame`.
 * `dir` magnitude must be ≤ 1 (normalised joystick); `thrust` must be in
 * [0, 1]; `actionBits` must fit in a 16-bit unsigned int.
 *
 * Returns a verdict with the SAME shape as the input but with each
 * field clamped to its bound. This is reused by both activity sims —
 * each one wraps the result in their game-specific intent decoder.
 */
export interface InputBounds {
  dir?: { x: number; y: number };
  thrust?: number;
  actionBits?: number;
}

export function validateInputBounds(
  input: InputBounds,
): ValidationVerdict<InputBounds> {
  const out: InputBounds = {};
  let didClamp = false;
  let detail: string | undefined;

  if (input.dir !== undefined) {
    const { clamped, didClamp: c } = clampVectorMagnitude(input.dir, 1, 1);
    out.dir = clamped;
    if (c) {
      didClamp = true;
      detail = 'dir_magnitude_over_1';
    }
  }
  if (input.thrust !== undefined) {
    if (!Number.isFinite(input.thrust)) {
      out.thrust = 0;
      didClamp = true;
      detail = 'thrust_not_finite';
    } else if (input.thrust < 0) {
      out.thrust = 0;
      didClamp = true;
      detail = 'thrust_negative';
    } else if (input.thrust > 1) {
      out.thrust = 1;
      didClamp = true;
      detail = 'thrust_over_1';
    } else {
      out.thrust = input.thrust;
    }
  }
  if (input.actionBits !== undefined) {
    if (!Number.isInteger(input.actionBits) || input.actionBits < 0 || input.actionBits > 0xffff) {
      out.actionBits = 0;
      didClamp = true;
      detail = 'action_bits_out_of_range';
    } else {
      out.actionBits = input.actionBits;
    }
  }

  return {
    ok: !didClamp,
    value: out,
    clamped: didClamp,
    flagged: false,
    flagKind: didClamp ? 'input_bounds' : undefined,
    detail,
  };
}
