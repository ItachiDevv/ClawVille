/**
 * reef-race-spline-instance.ts
 *
 * Module-scope singleton of the Reef Race v2 spline — instantiated once at
 * module load so all client components share the same pre-built arclength LUT.
 *
 * Both `ReefRaceTrack` (ribbon geometry) and `ReefRacePlayer` (spline-t
 * position reads) import `clientSpline` from here. The import of the pure-math
 * modules (`reef-race-spline.ts`, `reef-race-track-layout.ts`) therefore
 * happens exactly once across the entire client bundle regardless of how many
 * players or track instances are rendered.
 *
 * Import path crosses the monorepo boundary (apps/web → apps/api) via a
 * relative path. Both source files are pure TypeScript with no Node/Bun-only
 * imports — safe for the Next.js webpack bundler (`moduleResolution: bundler`).
 *
 * Constructor cost: one Simpson integration pass over 1 000 LUT entries
 * (~1 ms on any modern CPU). Subsequent method calls are O(log n) binary-search
 * on the pre-built LUT.
 */

import { ReefSpline, REEF_RACE_DEFAULT_TRACK } from '@clawville/shared';

/**
 * Shared client-side spline instance.
 *
 * Provides the same centripetal Catmull-Rom math used by the server sim so the
 * visual river bed is guaranteed to match the corridor math exactly.
 *
 * Available methods:
 *   centerlineAt(t)  → Vec2 { x, z }
 *   tangentAt(t)     → Vec2 (unit vector, +Z direction of travel at t=0)
 *   normalAt(t)      → Vec2 (90° CCW of tangent = LEFT of travel direction)
 *   widthAt(t)       → number (half-width in wu, interpolated across CPs)
 *   arclengthFromT(t)→ number (wu)
 *   tFromArclength(s)→ number
 */
// CLOSED-LOOP (2026-06-22): the v3 default track is a periodic ring (1 lap =
// one full loop). Build with `{ closed: true }` so the visual ribbon's closing
// chord CP[N-1]→CP[0] matches the server sim exactly (sim-coord-match invariant).
// The 3D ribbon may still render a visible seam until the dedicated render pass.
export const clientSpline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
