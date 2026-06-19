/**
 * ClawVille Avatar Manifest (CAM) — pure, web-bundle-safe surface.
 *
 * Types + canonicalisation + Zod schema only. The crypto (sha256, ed25519
 * sign/verify) lives SERVER-SIDE in `apps/api/src/services/avatar-manifest-
 * core.ts` so the web bundle (which imports the `@clawville/shared` barrel)
 * never pulls Node's `crypto`. See `.claude/plans/agent-export-portability.md`.
 */
export * from './types';
export * from './canonicalize';
export * from './schema';
