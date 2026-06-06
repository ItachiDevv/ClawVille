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
export * from './types/openclaw';
export * from './types/arena';
export * from './types/research';
export * from './types/marketplace';
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
export { ReefSpline } from './reef-race/spline';
export * from './reef-race/track-layout';
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
// Q2 Activity Portals — protocol types + activity registry. See
// `packages/shared/src/activities/index.ts` for the surface.
export * from './activities';
// Multiplayer Phase 1 — room snapshot + player wire types shared by
// `/api/world/:roomId/stream` and the web client's world-stream hook.
export * from './types/world';
// Server-usable AABB collision data (buildings + town-center props).
export * from './constants/world-colliders-data';
