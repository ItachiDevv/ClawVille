/**
 * Server-side mirror of each `modelKey` → body-asset PATH.
 *
 * WHY THIS EXISTS: the authoritative path/scale registry lives web-side in
 * `apps/web/src/lib/three/agent-model-registry.ts` (`MODEL_REGISTRY`), which
 * `apps/api` cannot import (cross-app dependency). The manifest export service
 * needs, server-side, the URL of an avatar's body bytes so it can fetch them,
 * hash them (SHA-256), and embed the content-addressed `mesh` ref. This is the
 * paths-only mirror — NO Three.js, NO scale/anim/render metadata.
 *
 * ⚠️ KEEP IN SYNC with `MODEL_REGISTRY[key].path` in the web registry,
 * INCLUDING the `?v=N` cache-bust query strings (the bytes at
 * `/avatars/phanes.vrm` differ from `/avatars/phanes.vrm?v=2`, so the query is
 * part of the content-address). Drift is caught by the coverage test in
 * `apps/api/src/services/__tests__/avatar-manifest.test.ts`, which asserts this
 * map's keys equal `AGENT_MODEL_KEYS` — adding a model without a body path
 * fails CI. (A value drift, e.g. a stale `?v`, is not auto-detected; update
 * both in the same diff.)
 *
 * Pure string data — web-bundle safe.
 */
import type { AgentModelKey } from './agent-models';

export interface AgentModelBodyRef {
  /** Web-relative asset path (absolutised at export time against the web origin). */
  path: string;
  format: 'vrm' | 'glb';
}

export const AGENT_MODEL_BODY_PATHS: Record<AgentModelKey, AgentModelBodyRef> = {
  // ── OpenClaw (crustaceans) — GLB bodies ──
  lobster: { path: '/models/lobster-ktx.glb', format: 'glb' },
  sweet_crab: { path: '/models/sweet_crab_sketchfabweekly-ktx.glb', format: 'glb' },
  lobster_plush: { path: '/models/lobster_plush-ktx.glb', format: 'glb' },
  hermitcrab: { path: '/models/hermitcrab-ktx.glb', format: 'glb' },

  // ── Other (sea creatures) — GLB bodies ──
  jellyfish: { path: '/models/jellyfish-ktx.glb', format: 'glb' },
  octopus: { path: '/models/octopus_toy-ktx.glb', format: 'glb' },
  seahorse: { path: '/models/sea_horse-ktx.glb', format: 'glb' },

  // ── Milady (VRM humanoid) ──
  milady_official_1: { path: '/avatars/milady-official-1.vrm', format: 'vrm' },
  milady_official_2: { path: '/avatars/milady-official-2.vrm', format: 'vrm' },
  milady_official_3: { path: '/avatars/milady-official-3.vrm', format: 'vrm' },
  milady_official_4: { path: '/avatars/milady-official-4.vrm', format: 'vrm' },
  milady_official_5: { path: '/avatars/milady-official-5.vrm', format: 'vrm' },
  milady_official_6: { path: '/avatars/milady-official-6.vrm', format: 'vrm' },
  milady_official_7: { path: '/avatars/milady-official-7.vrm', format: 'vrm' },
  milady_official_8: { path: '/avatars/milady-official-8.vrm', format: 'vrm' },

  // ── Hermes (VRM humanoid) — ?v=2 = perf-round-2 decimation bust ──
  hermes_female: { path: '/avatars/hermes-female.vrm?v=2', format: 'vrm' },
  hermes_male: { path: '/avatars/hermes-male.vrm?v=2', format: 'vrm' },
  tekk: { path: '/avatars/tekk.vrm?v=2', format: 'vrm' },

  // ── Hatcher placeholders (point at the 8 Milady VRMs until bespoke art) ──
  hatcher_1: { path: '/avatars/milady-official-1.vrm', format: 'vrm' },
  hatcher_2: { path: '/avatars/milady-official-2.vrm', format: 'vrm' },
  hatcher_3: { path: '/avatars/milady-official-3.vrm', format: 'vrm' },
  hatcher_4: { path: '/avatars/milady-official-4.vrm', format: 'vrm' },
  hatcher_5: { path: '/avatars/milady-official-5.vrm', format: 'vrm' },
  hatcher_6: { path: '/avatars/milady-official-6.vrm', format: 'vrm' },
  hatcher_7: { path: '/avatars/milady-official-7.vrm', format: 'vrm' },
  hatcher_8: { path: '/avatars/milady-official-8.vrm', format: 'vrm' },

  // ── Bespoke Hatcher avatars (Meshy pipeline) — VRM 1.0 ~3MB ──
  phanes: { path: '/avatars/phanes.vrm?v=2', format: 'vrm' },
  cronus: { path: '/avatars/cronus.vrm?v=2', format: 'vrm' },
  helen: { path: '/avatars/helen.vrm?v=2', format: 'vrm' },
  clytemnestra: { path: '/avatars/clytemnestra.vrm?v=2', format: 'vrm' },

  // ── Chibi (VRM humanoid, half-height) — promoted into AGENT_MODELS 2026-06-21 ──
  // ?v=3 matches MODEL_REGISTRY[*_chibi].path in the web registry (the query is
  // part of the content-address — keep in sync, incl. the ?v on every bump).
  eliza_chibi: { path: '/avatars/eliza-chibi.vrm?v=3', format: 'vrm' },
  milady_chibi: { path: '/avatars/milady-chibi.vrm?v=3', format: 'vrm' },
};
