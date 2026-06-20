/**
 * Zod schema for a ClawVille Avatar Manifest (CAM) v1. Used to validate an
 * UNTRUSTED manifest before acting on it — primarily the future reimport path
 * (`POST /api/avatar/import-manifest`) and the standalone verifier script.
 *
 * Structure validation ONLY — it does NOT verify the signature or the body
 * hash (those are crypto operations in `apps/api/src/services/
 * avatar-manifest-core.ts`). Validate structure first, then verify crypto.
 *
 * Pure (zod only) — web-bundle safe via the `@clawville/shared` barrel.
 */
import { z } from 'zod';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'must be lowercase hex sha256');

export const camMeshSchema = z.object({
  uri: z.string().url(),
  sha256: hex64,
  format: z.enum(['vrm', 'glb', 'gltf']),
  kBytes: z.number().int().nonnegative(),
});

export const camOwnerSchema = z.object({
  chain: z.string().min(1),
  address: z.string().min(1),
});

export const camAssetRefSchema = z.object({
  name: z.string().optional(),
  uri: z.string().url(),
  sha256: hex64.optional(),
});

export const camCosmeticRefSchema = z.object({
  slot: z.string().min(1),
  skuSlug: z.string().min(1),
  scope: z.string().min(1),
  uri: z.string().url(),
  rigType: z.string().min(1),
  sha256: hex64.optional(),
});

export const camClawvilleExtSchema = z.object({
  identity: z.object({ pubkey: z.string().min(1) }).optional(),
  // character + skillPack are opaque (ElizaOS shapes) — validate presence/kind only.
  character: z.unknown(),
  skillPack: z.array(z.unknown()),
  provenance: z.object({
    platform: z.literal('clawville.world'),
    exportedFrom: z.object({ avatarId: z.string().min(1), avatarName: z.string().min(1) }),
    harness: z.string().min(1),
    agentCategory: z.string().min(1),
    modelKey: z.string().min(1),
  }),
});

export const camSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  value: z.string().min(1),
  signer: z.string().min(1),
  canonicalization: z.literal('clawville-jcs-v1'),
  purpose: z.literal('avatar-manifest'),
});

/** Unsigned core (the canonicalised + signed bytes). */
export const clawvilleAvatarManifestCoreSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('clawville.avatar.v1'),
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  mesh: camMeshSchema,
  skeleton: z.enum(['vrm-humanoid', 'custom']),
  owner: camOwnerSchema.nullable(),
  createdAt: z.string().datetime(),
  animations: z.array(camAssetRefSchema).optional(),
  cosmetics: z.array(camCosmeticRefSchema).optional(),
  clawville: camClawvilleExtSchema,
});

/** Full signed manifest. */
export const clawvilleAvatarManifestSchema = clawvilleAvatarManifestCoreSchema.extend({
  signature: camSignatureSchema,
});
