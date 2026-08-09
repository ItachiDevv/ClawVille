export * from './types/avatar';
export * from './types/location';
export * from './types/agent';
export * from './constants/avatar-species';
export * from './constants/avatar-colors';
export * from './constants/avatar-archetypes';
export * from './constants/map-locations';
export * from './constants/knowledge-books';
export * from './constants/building-types';
export * from './constants/building-tools';
export * from './constants/npc-definitions';
export * from './constants/npc-activities';
export * from './types/agent-substrate';
export * from './types/arena';
export * from './types/research';
export * from './types/claw';
export * from './types/agent-gateway';
export * from './types/quest';
export * from './types/bounty';
export * from './constants/article-seeds';
export * from './constants/quest-seeds';
export * from './types/collaboration';
export * from './types/skill-pack';
// Reef Race v2 spline math + track layout (canonical home).
// `Vec2` is intentionally NOT re-exported from spline.ts because
// `activities/protocol.ts` already exports a different (zod-derived) `Vec2`
// — they describe the same shape but are separate type identities.
// Server consumers that need the spline-flavour Vec2 import directly from
// `apps/api/src/services/activity/sim/reef-race-spline.ts` (the shim
// re-exports it explicitly).
export type {
  Vec3 as ReefSplineVec3,
  SplineControlPoint,
  ClosestPointResult,
} from './reef-race/spline';
export { ReefSpline, parabolicRefineOffset } from './reef-race/spline';
export * from './reef-race/track-layout';
export * from './reef-race/start-grid';
export * from './reef-race/boost-pad';
export * from './reef-race/furniture';
// Reef Race v2 — pure surf-carving integrate step (server sim + client predict
// share this function so the physics is identical on both sides).
export * from './reef-race/surf-physics';
export * from './constants/milady-skills';
// Phase 6.0 — slot machine paytables (publicly verifiable, provably-fair)
export * from './constants/slot-paytables';
// Phase 6.0.4 — slot symbol SVG asset manifest (UI polish pass)
export * from './constants/slot-symbols';
// Phase 6.4.0 — cove blackjack shared types (mock + future engine).
export * from './types/cove-blackjack';
// Phase 6.5.0 — cove Texas Hold'em shared types (visual shell).
export * from './types/cove-holdem';
// Phase 6.6.1 — cove Baccarat (Punto Banco) shared wire types.
export * from './types/cove-baccarat';
export * from './constants/orientation-skill';
export * from './constants/hatcher-actions';
// Q3 plan §2.6 — server-credited token rewards for tutorial quests.
export * from './constants/tutorial-quest-rewards';
// `agent-models` uses type + value dual exports; explicit re-exports
// guarantee every symbol is public (the earlier `export *` worked but
// made the surface less obvious during Phase 2 audits).
export {
  AGENT_MODELS,
  AGENT_MODEL_KEYS,
  AGENT_CATEGORIES,
  AGENT_HARNESSES,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_MODEL_KEY,
  DEFAULT_AGENT_CATEGORY,
  DEFAULT_AGENT_HARNESS,
  getAgentModel,
  getAgentCategoryForModel,
  // Hatcher partner #2 (2026-06-01) — random render-model pick + fleet keys.
  HATCHER_MODEL_KEYS,
  pickRandomHatcherModelKey,
  // Phanes default Hatcher avatar (2026-06-05).
  DEFAULT_HATCHER_MODEL_KEY,
} from './constants/agent-models';
export type {
  AgentCategory,
  AgentHarness,
  AgentModelKey,
  AgentModelMeta,
} from './constants/agent-models';
// Agent export & portability (2026-06-19) — server-side modelKey→body-path
// mirror (paths-only, for the manifest export service) + the ClawVille Avatar
// Manifest (CAM) v1 pure surface (types + canonicalize + zod schema). Crypto
// lives server-side in apps/api (avatar-manifest-core.ts) so the web bundle
// never pulls Node `crypto`. See `.claude/plans/agent-export-portability.md`.
export * from './constants/agent-model-body-paths';
export * from './avatar-manifest';
// Q2 Activity Portals — protocol types + activity registry. See
// `packages/shared/src/activities/index.ts` for the surface.
export * from './activities';
// Multiplayer Phase 1 — room snapshot + player wire types shared by
// `/api/world/:roomId/stream` and the web client's world-stream hook.
export * from './types/world';
export * from './types/world-presence-ws';
// Server-usable AABB collision data (buildings + town-center props).
export * from './constants/world-colliders-data';
// Dedicated Kelp Forest realm: one authored maze layout derives client wall
// collision and the render-only beacon graph used by the isolated scene.
export * from './constants/kelp-realm';
// World dimensions + canonical spawn/center coords (S3, 2026-06-16) — the
// single source of truth the web client, API, and DB schema all align on so a
// world re-center (5120→18432→22528, latest the 576→704 land-builder grow) can
// never drift between layers again.
export * from './constants/world-dimensions';
// Land Economy Phase 0 (2026-06-15) — frozen tier contract (enum, supply counts, parcel-code
// format). The geometry (`land-parcels`) + economic (`land-economy`) constants both import it.
export * from './constants/land-tiers';
// Land Economy — deterministic parcel geometry (3-ring layout: 56 parcels
// founder 10 / starter 26 / c 20, SQUARE concentric block-frames; c added by the
// 576→704 land-builder grow 2026-06-24). Consumed by merged-seaweed.tsx (exclusion
// zones) and the 3D parcel-render pass.
export * from './constants/land-parcels';
// Land Economy Phase 0 (2026-06-15) — economic constants (tier ladder, upgrade costs, structure
// catalog, leaderboard event weights, founder-gated rest-bonus cap). Backend + frontend pricing.
export * from './constants/land-economy';

// Land P3 stage A — render-agnostic kit catalog, ladder, fees, and grid rules.
export * from './constants/land-kit';
// Land gamification P2b — the frozen MEASURED per-piece render manifest
// (authored heights, GLB-derived extents, rotation advertisements, Q8 support
// surfaces). Replaces the uniform cell-cube normalization (defects N-1/N-2/N-3).
export * from './constants/land-kit-manifest';
// Land gamification P3 — `evaluatePlacement`, the single footprint/rotation/
// stack-aware legality predicate shared by the write path and the yard editor.
// Replaces anchor-cell-only validation (defect D-1).
export * from './constants/land-placement';


// Land gamification P4b — seabed-salvage daily caps (the founder-ratified
// per-avatar and per-owner claim bounds the material ledger settles against).
export * from './constants/land-salvage';
// Land Showroom (2026-06-18) — deterministic ~15 starter-lot showroom (FOR RENT model buildings).
// Client-only decorative layer; no DB dependency.
export * from './constants/land-showroom';
// Land Signage (2026-06-18) — visual sign category model (regular/premium/premium-partner).
// Purely visual; does NOT encode economic data. Consumed by land-parcels.tsx 3D render.
export * from './constants/land-signage';
