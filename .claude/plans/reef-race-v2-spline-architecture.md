# Reef Race v2 — Spline Architecture Design

> Status: DESIGN DRAFT 2026-04-28. For review before any implementation.
> Companion to `reef-race-v2.md` (spec locked 2026-04-28).

---

## 1. Spline Representation

**Decision: Catmull-Rom, open (non-periodic), 14-18 control points.**

Rationale:

Catmull-Rom wins over Hermite and natural cubic for this use case on three counts:

1. Tangents are automatic — each control point's tangent is derived from its two neighbors. Zero per-point hand-authoring for the track designer. Hermite requires explicit tangent vectors per point, which is error-prone for a slalom and degrades easily when points are redistributed.
2. The curve passes through every control point (interpolating, not approximating). This matters because the spline is also the server sim's ground truth. Visual art, sim math, and bot AI can all address the same point set without a conversion step.
3. Natural cubics require a global solve (tridiagonal system) when points change. Catmull-Rom is purely local — any future track editor that tweaks one control point only invalidates two adjacent segments.

The spec fixes a single slalom river with 6-8 curves over ~60s of racing. At `REEF_MAX_SPEED=500 wu/s` the track arclength is roughly 30 000 wu. Spacing control points ~2 000 wu apart = 15 points. Recommendation: **16 control points** (14 interior + 1 phantom at each end for tangent computation at the open endpoints). The phantom points duplicate the real endpoints and need no special-casing in the LUT.

**Width encoding:** Each control point carries a scalar `halfWidth: number` alongside its XZ position. `widthAt(t)` is computed by Catmull-Rom interpolation of the `halfWidth` values using the same parametric t — this gives smooth corridor expansion/contraction through chicanes and wide sections with zero extra math.

**Arclength LUT:** Pre-baked at track boot. Adaptive Simpson integration with ~1 000 sample points produces the table `s[i] → t[i]`. Total pre-computation cost is O(1000) square-roots — negligible at startup. The LUT is the only mutable structure at boot; once built it is frozen and never written at sim runtime.

**Coordinate system:** Identical to the current ellipse sim — flat XZ plane in server-space. `y` in server-space remains 0 for ground-level bodies; the new `heightOffset` field (§4) is orthogonal.

---

## 2. Spline Math Primitives

All functions are pure and operate on a pre-built `ReefSpline` struct (control points + LUT). No global state.

```ts
// Core spline struct (single source of truth shared between sim and client)
interface ReefSpline {
  points: Array<{ x: number; z: number; halfWidth: number }>;
  // phantom[0] = points[0], phantom[N+1] = points[N-1]
  totalArcLength: number;
  lut: Array<{ s: number; t: number }>; // ~1000 entries, monotonic
}

// t is the Catmull-Rom parameter, 0 at first real point, 1 at last.

centerlineAt(spline, t): { x: number; z: number }
// Catmull-Rom position evaluation. O(1) — segment lookup by floor(t * (N-1)).

tangentAt(spline, t): { x: number; z: number }
// Unit tangent via analytic derivative of the Catmull-Rom basis.
// Normalizes the result. Zero-length guard returns {x:1, z:0}.

normalAt(spline, t): { x: number; z: number }
// 90° CCW rotation of tangent in XZ. Left side of track from perspective
// of forward travel. Normalized by construction (tangent already is).

bankNormalAt(spline, t): { x: number; y: number; z: number }
// Always {0, 1, 0} for Phase 1. Phase 2+ can interpolate a per-point
// bank angle to tilt the up vector on banked turns without changing any
// other primitive.

widthAt(spline, t): number
// Catmull-Rom interpolation of control-point halfWidth values.
// Returns the corridor half-width in wu.

arclengthFromT(spline, t): number
// Forward LUT walk: binary search + linear interpolation.

tFromArclength(spline, s): number
// Inverse LUT walk: same binary search pattern. O(log N).

closestPointOnSpline(spline, x, z): {
  t: number;
  distance: number;        // unsigned perpendicular distance from centerline
  side: 'L' | 'R';        // L = left of forward direction (normal side)
  closestX: number;
  closestZ: number;
}
// Newton's method starting from coarse t from a linear-distance scan
// over LUT samples. 4-6 iterations converges to <0.01 wu error.
// Most expensive primitive; must be O(~15 Newton steps) not O(N segments).

progressFraction(spline, x, z): number
// Returns closestPointOnSpline(…).t (i.e., t is the progress in [0,1]).
// t=0 = start, t=1 = finish line.
// Replaces lap counter entirely.
```

**Design note on `closestPointOnSpline`:** The current ellipse uses `ellipseScaleAt` — one hypot call per body per tick. Newton's method over a Catmull-Rom needs more work (~15 multiply-adds). At 30Hz × 8 bodies that is 240 Newton iterations/sec — cheap on a modern server. No caching needed.

---

## 3. Wall Collision Design

**Replace `enforceWallClamp` with `enforceSplineWallClamp`.**

Algorithm:

```
1. closest = closestPointOnSpline(spline, body.x, body.z)
2. halfW = widthAt(spline, closest.t)
3. if closest.distance <= halfW: return   // inside corridor, no clamp
4. // Outside wall — push body back to halfW along the perp normal
   overshoot = closest.distance - halfW
   pushNormal = (closest.side === 'L') ? normalAt(closest.t) : -normalAt(closest.t)
   // pushNormal points FROM wall TOWARD centerline
   body.x += pushNormal.x * overshoot
   body.z += pushNormal.z * overshoot
   // Velocity reflection: kill outward component, keep tangent
   vN = dot(body.vx, body.vz, pushNormal)   // outward speed
   if vN < 0:  // moving toward wall
     body.vx -= pushNormal.x * vN
     body.vz -= pushNormal.z * vN
     body.vx *= WALL_TANGENT_FRICTION
     body.vz *= WALL_TANGENT_FRICTION
     // minSlideSpeed reinject — KEEP with the cap fix
```

**On `minSlideSpeed`:** Keep it. The current bug is that it adds `minSlideSpeed` as an absolute injection even when the body's tangent velocity already exceeds it — causing a speed burst after a light wall brush. Fix: the `if (currentSlide < minSlideSpeed)` branch is correct but the injection `add = minSlideSpeed - max(0, currentSlide)` must also be capped so that `currentSlide + add <= minSlideSpeed`, not `add = full minSlideSpeed` unconditionally. One-line fix: `const add = minSlideSpeed - Math.max(0, currentSlide)` — which is what the code already does, but the guard condition `currentSlide < minSlideSpeed` is missing the edge case where `currentSlide` is already above the minimum (should not reinject). The code already handles this correctly — the only real bug is the cap-less injection when the kart enters the wall at a sharp angle. Keep `minSlideSpeed = REEF_MAX_SPEED * 0.25 = 125 wu/s` unchanged.

**Wall-slide projection replacement:** The current step 8 `REEF_OUTER_WALL_PROJECT_SCALE` guard and outward-intent stripping are replaced by the same logic using `closestPointOnSpline` → compute outward normal → if body is within 5% of wall AND intent has outward component, strip that component before computing `targetVx/Vz`. Identical semantics, different normal source.

---

## 4. Vertical Axis (Y / Height) Integration

**Decision: Option A — `body.heightOffset: number` (defaults 0).**

Reasoning: The entire XZ sim (slipstream, collision, wall-clamp, bot AI, progress tracking, anti-cheat position delta) works in the flat plane. Promoting the body to full Vec3 would require auditing every arithmetic site (200+ lines) against the Y dimension. Phase 1 of v2 does not even use Y. Option A adds one field, three write sites (jump trigger, dive arch exit, gravity tick), and zero risk to existing XZ logic.

Architecture:

```ts
// On ReefBody (additions only):
heightOffset: number;       // 0 = ground; positive = airborne
vyAxis: number;             // vertical velocity wu/s (positive = up)
airborneTicks: number;      // counter; 0 when on ground
```

Gravity tick (run AFTER XZ integration, once per tick):

```
if (body.heightOffset > 0 || body.vyAxis !== 0):
  body.vyAxis -= REEF_GRAVITY * dt          // REEF_GRAVITY = 1200 wu/s²
  body.heightOffset = max(0, body.heightOffset + body.vyAxis * dt)
  if (body.heightOffset === 0 && body.vyAxis < 0):
    body.vyAxis = 0                         // land
    body.airborneTicks = 0
  else if (body.heightOffset > 0):
    body.airborneTicks++
```

**Two jump trigger paths** — DRIFT MECHANIC RETIRED 2026-04-28; Shift now binds JUMP. See `reef-race-v2.md` "Jump Mechanic" section for full spec lock.

**Path 1 — Manual jump (player presses Shift / `ACTION_BIT_JUMP` bit 2):**

```
if (body.intent.actionBits & ACTION_BIT_JUMP) && body.airborneTicks === 0 && body.heightOffset === 0:
  body.vyAxis += REEF_JUMP_IMPULSE_MANUAL    // ~480 wu/s → ~96 wu apex, ~0.6s airtime
  body.airborneTicks = 1                     // immediate gate so next tick can't re-fire
```

The "must land first" cooldown is enforced by the `airborneTicks === 0` check — server-side, cheat-proof. Client press just sets the bit; if abused (held down on ground), server only acts on rising-edge transitions.

**Path 2 — Ramp jump (server-injected, body XZ inside ramp AABB AND `body.heightOffset === 0`):**

```
body.vyAxis += REEF_JUMP_IMPULSE_RAMP       // ~1200 wu/s → ~600 wu apex, ~1.2s airtime (~2.5× manual)
body.airborneTicks = 1
```

Ramps inject regardless of player input — player can be mid-tap-jump and ramp will OVERRIDE with the bigger impulse. Encourages ramp usage.

**Steering authority while airborne** — multiplied by `REEF_AIRBORNE_STEER_MULT = 0.30` in `applyIntentForTick` step 6 (yaw rate). XZ velocity is preserved unchanged; jump only adds Y. Player can mid-air correct but cannot snap-turn.

Dive arch: modeled as a ceiling plane at arch height. If `body.heightOffset > ARCH_CLEARANCE` AND body XZ is inside arch zone → reduce height to `ARCH_CLEARANCE`, zero `vyAxis`. This is the "hard ceiling" interpretation from the spec: a kart that jumps inside an arch hits the ceiling and drops. Simple, deterministic, no ambiguity about "transparent zone."

`heightOffset` is transmitted as the optional `EntityDelta.changed.height` field from the spec. Omitted when 0, so no bandwidth cost for ground-level karts (most of the race).

**Bot jumping** (updates section 5 below): bots emit `ACTION_BIT_JUMP` for one tick when an obstacle AABB intersects their lookahead window AND clearance height < manual jump apex. Always emit on ramp-AABB-entry tick (manual + ramp will not double-stack since ramp path runs after manual).

---

## 5. Bot AI

**Race-line:** Each bot targets a parametric offset from the centerline. At each tick the bot computes its current `t` from `closestPointOnSpline`, looks up the spline's curvature (estimated as the angular change in tangent between `t` and `t+0.02`), and offsets laterally toward the inside of the curve:

```
curvature = angleBetween(tangentAt(t), tangentAt(t + 0.02))
lateralTarget = curvature > threshold ? -INSIDE_OFFSET : 0
// Negative lateral = toward inside of curve (tighter line)
```

The race-line target point is `centerlineAt(t + LOOKAHEAD_T) + normal * lateralTarget`. LOOKAHEAD_T ≈ 0.03 (roughly one segment ahead). This gives bots a natural "apex" behavior without scripting.

**Pickup vs racing line:** Bots keep current probabilistic behavior (already exists). When a pickup box is within `REEF_POWERUP_RADIUS * 3` of the bot's lookahead point AND the bot has an empty slot AND the deviation from race-line is under `HALF_WIDTH * 0.4`, the bot steers toward the box. Otherwise it ignores it. No complex decision tree needed for Phase 1.

**Jump ramps:** Bots always jump ramps (Phase 1, skill ceiling 0 as spec says). The bot's intent simply treats the ramp zone entry as a trigger to output `actionBits |= ACTION_BIT_LAUNCH` for one tick. The server sim handles the physics; the bot does not need to compute landing spots.

---

## 6. Anti-Cheat Replacement

**`validateCheckpointSequence` → `validateProgressMonotonic`:**

```ts
function validateProgressMonotonic(
  prevProgress: number,  // 0..1
  currProgress: number,  // 0..1
  petId: string,
  flags: ReefFlagCounter,
): void {
  // Allow small backward drift for knockback (e.g. tide-wave)
  // Tolerance: 2% of total track = ~600 wu regression
  const BACKWARD_TOLERANCE = 0.02;
  if (currProgress < prevProgress - BACKWARD_TOLERANCE) {
    flags.flag(petId, 'progress_regression');
  }
}
```

The BACKWARD_TOLERANCE absorbs legitimate knockback from tide-wave and whirlpool. Any regression larger than 2% (600 wu on a 30 000 wu track) is suspicious.

**Lap-time validator:** Retires. Replaced by per-segment time check: if a body advances more than `SEGMENT_LENGTH` wu of progress in fewer ticks than `SEGMENT_LENGTH / (REEF_MAX_SPEED * REEF_KINEMATIC_TOLERANCE * dt)`, flag `overprogress`. This subsumes the old MIN_LAP_MS check with finer granularity.

**Position-delta and velocity-delta validators:** Unchanged. They operate on raw XZ coordinates, blind to progress framing.

---

## 7. Verticality / Anti-Cheat Tension

**Decision: exempt by axis, not by airborne state.**

The `validateReefVelocityDelta` and `validateReefPositionDelta` validators should be restructured to check the XZ speed independently of the Y axis:

```ts
// XZ speed: existing REEF_MAX_SPEED * REEF_KINEMATIC_TOLERANCE cap unchanged
const xzSpeed = Math.hypot(body.vx, body.vz);
validateReefVelocityDelta(prevXZ, currXZ, flags);  // unchanged

// Y axis: separate cap. Jump impulse produces at most REEF_JUMP_IMPULSE wu/s
// (server-injected, so it's already authoritative). Only outgoing client
// velocity needs a cap — clients cannot inject vyAxis.
// Implementation: server owns vyAxis entirely (never read from client input).
// Therefore no client anti-cheat is needed for the vertical axis.
```

The server NEVER reads `vyAxis` from the client. Jump triggers are server-side (body enters ramp AABB → server injects impulse). Vertical velocity is purely a server simulation output. This completely eliminates the anti-cheat tension: there is nothing for the client to fake.

**Overspeed flag exemption:** Because XZ and Y are separate, `overspeed` on XZ continues to fire normally. The Y burst from a ramp launch is invisible to the XZ validators. No tolerance changes needed.

---

## 8. Migration Path

**Decision: Option B — new `reef-race-spline-sim.ts` alongside existing sim, feature flag gate.**

Reasoning: The ellipse sim has 200+ tests, live production players, and carries months of Phase 1-4 tuning (drift, slipstream, apex, ribbons). Option A (in-place rewrite) risks one bad merge breaking production races mid-refactor. Option B lets:

1. The spline sim develop and test independently against the same test harness.
2. A feature flag (`REEF_RACE_USE_SPLINE=true` env var) routes `createReefRaceRoom` to either sim. Flipping one env var in Coolify = instant rollback without a deploy.
3. The Phase 1 ship gate ("races complete end-to-end") is reachable without any risk to the current production oval.

The ellipse sim is deleted once the spline sim has parity coverage (all anti-cheat, all power-ups, bots traverse). That is Phase 1's conclusion, not its start.

**Module boundaries:**

```
reef-race-spline.ts          — pure math: ReefSpline, all primitives in §2
reef-race-spline-config.ts   — control points, widths, zone definitions
reef-race-spline-sim.ts      — simulation loop (mirrors reef-race-sim.ts shape)
reef-race-sim.ts             — untouched until spline sim passes full test suite
```

`reef-race-spline.ts` is imported by both the spline sim (server) and the 3D client track builder — so the visual track is guaranteed to match the server's corridor math. This is the lesson from the existing gotcha "3D track curve MUST match server sim coordinate system."

---

## Risks and Pre-Implementation Prototypes

**Risk 1 — Newton convergence near S-curves:** If two spline segments overlap in XZ projection (extreme S-bends), `closestPointOnSpline` can converge to the wrong segment. Mitigation: design control points so the track never folds back within `REEF_BODY_RADIUS * 4 = 88 wu` of itself in any XZ projection. Prototype this visually before locking control-point positions.

**Risk 2 — `tFromArclength` LUT resolution at high speed:** At `REEF_MAX_SPEED=500 wu/s` with 1 000 LUT entries over 30 000 wu total = 30 wu/entry. Progress can advance 16.7 wu per tick (500/30). Binary search still works; just verify the LUT error is below 1 wu tolerance. If not, bump to 2 000 entries (still negligible memory).

**Risk 3 — Open-spline endpoint tangents:** Catmull-Rom phantom point at `t=1` (the finish line) must be placed carefully — if the phantom is collinear with the last two real points the tangent degenerates. Place the phantom 200 wu beyond the finish in the direction of travel (same as the last real segment's direction).

**Risk 4 — Bot avoidance + obstacles:** The spec notes this is the hardest AI change. For Phase 1 defer obstacle avoidance entirely — bots only follow race-line, obstacles are placed off the racing line so bots naturally miss them. True obstacle avoidance is a Phase 2 AI task.

**Risk 5 — `heightOffset` and existing anti-cheat position delta:** `validateReefPositionDelta` checks `|dx|+|dz|` per tick. A kart on a jump ramp has zero XZ acceleration from the ramp itself (the impulse is vertical only) — XZ position delta is unchanged by the jump. No conflict. Verified by inspection of the current validator.

**Prototype before code:** Implement `reef-race-spline.ts` in isolation, plot the output against a known track layout, verify `closestPointOnSpline` convergence on all 16 control points, verify LUT round-trip `tFromArclength(arclengthFromT(t)) ≈ t` within 0.001. This can be done in a standalone Bun script in one session before any sim code is touched.
