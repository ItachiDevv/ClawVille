/**
 * Re-export shim — canonical source moved to @clawville/shared/reef-race/spline
 * on 2026-04-29 to fix the Docker web-build (apps/web could not reach this
 * path through the apps/api source tree). Server-side imports keep working
 * via this thin forward; the shared package is the single source of truth.
 *
 * Imports come from the SUBPATH (not the package index) so we get the
 * spline-flavour Vec2 — the package index re-exports a different `Vec2`
 * (the zod-derived one from activities/protocol.ts).
 */
export type {
  Vec2,
  Vec3,
  SplineControlPoint,
  ClosestPointResult,
} from '@clawville/shared/reef-race/spline';
export { ReefSpline } from '@clawville/shared/reef-race/spline';
