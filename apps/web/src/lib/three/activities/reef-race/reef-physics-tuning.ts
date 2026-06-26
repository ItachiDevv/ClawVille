/**
 * reef-physics-tuning.ts — LIVE tuning singleton for the Reef Race DRIVING FEEL.
 *
 * DEV TOOL (the free-drive sandbox on /preview/reef-race-v2?mode=drive). The mirror
 * of `reef-water-tuning.ts`, but for the surf-carving KINEMATICS instead of the
 * water look: one mutable object the sandbox's prediction loop READS every tick, and
 * the physics-tuner panel WRITES on slider change. Lets the founder drive with the
 * keyboard and dial handling/drift/whip live, then bake the values into the canonical
 * constants (`apps/api/src/services/activity/sim/reef-race-config.ts`, shared by the
 * server sim + client prediction) once the feel is right.
 *
 * SANDBOX-ONLY. The real race (server sim + client prediction in ReefRacePlayer) reads
 * the canonical `reef-race-config.ts` constants, NOT this singleton — so nothing here
 * changes the live game. This is purely the tuning workbench; baking = copying the
 * dialed numbers into the config in a separate, reviewed step.
 *
 * ─── DEFAULTS == the canonical committed constants ───────────────────────────
 * Every default below mirrors the live `reef-race-config.ts` value (cited inline), so
 * a fresh sandbox load drives EXACTLY like the real race. Tuning deviates from there.
 *
 * Whip is a NEW mechanic (founder 2026-06-24: "space to whip the back of the board
 * left and right, bumping your opponent"). Its params have no canonical home yet —
 * the sandbox prototypes the FEEL (board-tail swing + lateral impulse + bump a dummy);
 * the authoritative multiplayer bump (collision + impulse + anti-cheat) is a later
 * server-sim job. These defaults are first-guess starting points to dial in.
 */

export interface ReefPhysicsTuning {
  // ── Surf-carving kinematics (mirror surf-physics.ts SurfParams / reef-race-config) ──
  maxSpeed: number;          // REEF_MAX_SPEED 500 (wu/s)
  maxAccel: number;          // REEF_MAX_ACCEL 2000 (wu/s²) — 0.25s to top speed
  turnRate: number;          // REEF_TURN_RATE 2.6 (rad/s) base, grounded, low speed
  turnSpeedFalloff: number;  // REEF_TURN_SPEED_FALLOFF 0.45 (turn rate × (1-falloff·speedFrac))
  airborneSteerMult: number; // REEF_AIRBORNE_STEER_MULT 0.30
  forwardDrag: number;       // REEF_FORWARD_DRAG 0.992 (per-tick along-heading survival)
  lateralGrip: number;       // REEF_LATERAL_GRIP 0.90 (per-tick perpendicular survival; lower = grippier)
  boostMult: number;         // REEF_BOOST_MULT 1.4 (top-speed × while a boost is active)

  // ── Drift mini-turbo (mirror DRIFT_SPARK_TICK_* / DRIFT_MIN_SPEED_FOR_CHARGE) ──
  driftTick1: number;        // DRIFT_SPARK_TICK_1 8  (ticks held to charge spark tier 1)
  driftTick2: number;        // DRIFT_SPARK_TICK_2 20 (tier 2)
  driftTick3: number;        // DRIFT_SPARK_TICK_3 34 (tier 3)
  driftMinSpeedFrac: number; // DRIFT_MIN_SPEED_FOR_CHARGE / REEF_MAX_SPEED = 0.20
  /** Boost top-speed × per spark tier on release (sandbox prototype; tier 3 strongest). */
  driftBoost1: number;
  driftBoost2: number;
  driftBoost3: number;
  /** Boost duration (ticks) per release (sandbox prototype). */
  driftBoostTicks: number;

  // ── Board-whip bump (NEW — sandbox prototype of the FEEL only) ──
  /** Lateral velocity impulse (wu/s) the whip imparts to SELF (the recoil sidestep). */
  whipSelfImpulse: number;
  /** Velocity impulse (wu/s) imparted to a bumped opponent, along the whip direction. */
  whipBumpImpulse: number;
  /** Reach of the whip hit (wu) — how close an opponent must be behind/beside to bump. */
  whipReach: number;
  /** Cooldown (ticks) between whips. */
  whipCooldownTicks: number;
  /** Visual swing duration (ticks) of the board tail. */
  whipSwingTicks: number;

  // ── Off-track forgiveness (sandbox prototype of the Rainbow-Road void edge) ──
  /** Extra lateral tolerance (wu) BEYOND the track half-width before you fall off.
   *  Low = punishing (fall the instant you drift wide, which interrupts drift charging);
   *  high = forgiving (room to carve a drift). Tuned up from the original hard 60. */
  offtrackMargin: number;

  // ── VIEW (sandbox board + chase camera placement) ──
  /** Surfboard render scale (KART_SCALE=20 is the canonical decorative scale). */
  kartScale: number;
  /** Ride height (wu) the board floats above the wave surface. */
  rideHeight: number;
  /** Chase cam distance behind the kart (wu). */
  camBack: number;
  /** Chase cam height above the kart (wu). */
  camUp: number;
  /** Chase cam look-ahead distance (wu). */
  camAhead: number;
}

// ─── Canonical defaults (mirror reef-race-config.ts @ ebb9c9a6) ──────────────
const CANONICAL: ReefPhysicsTuning = {
  // Founder-tuned 2026-06-24 (kept from the sandbox): faster top speed + accel.
  maxSpeed: 940,
  maxAccel: 3500,
  turnRate: 2.6,
  turnSpeedFalloff: 0.45,
  airborneSteerMult: 0.3,
  forwardDrag: 0.992,
  lateralGrip: 0.9,
  boostMult: 1.4,

  driftTick1: 8,
  driftTick2: 20,
  driftTick3: 34,
  driftMinSpeedFrac: 0.2,
  driftBoost1: 1.18,
  driftBoost2: 1.32,
  driftBoost3: 1.5,
  driftBoostTicks: 40,

  // Whip — first-guess starting points (no canonical home yet; sandbox-tuned).
  whipSelfImpulse: 140,
  whipBumpImpulse: 460,
  whipReach: 260,
  whipCooldownTicks: 24,
  whipSwingTicks: 12,

  // Off-track forgiveness — wide tolerance so a drift can be carried without
  // instantly dropping into the void (the original hard 60 reset drift charges).
  offtrackMargin: 280,

  // View — founder-tuned 2026-06-24 (kept from the sandbox): big board, slightly
  // sunk into the surface, pulled-back high chase cam looking well ahead.
  kartScale: 125,
  rideHeight: -20,
  camBack: 710,
  camUp: 660,
  camAhead: 720,
};

/** The live singleton — read by the sandbox prediction loop, written by the panel. */
export const REEF_PHYSICS_TUNING: ReefPhysicsTuning = { ...CANONICAL };

/** Frozen snapshot of the canonical defaults — the panel marks a slider "at default"
 *  against this, and Reset restores it. */
export const REEF_PHYSICS_DEFAULTS: Readonly<ReefPhysicsTuning> = { ...CANONICAL };

/** Restore every knob to the canonical committed value (panel "Reset" button). */
export function resetReefPhysics(): void {
  Object.assign(REEF_PHYSICS_TUNING, CANONICAL);
}

/** Snapshot the current tuning as a copy-pasteable summary (panel "Copy values"). */
export function snapshotReefPhysics(): string {
  const t = REEF_PHYSICS_TUNING;
  const f = (n: number) => Number(n.toFixed(3));
  const out: Record<string, number> = {};
  (Object.keys(t) as (keyof ReefPhysicsTuning)[]).forEach((k) => { out[k] = f(t[k]); });
  return JSON.stringify(out, null, 2);
}
