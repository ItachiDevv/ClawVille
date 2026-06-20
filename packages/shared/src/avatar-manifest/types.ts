/**
 * ClawVille Avatar Manifest (CAM) v1 — the portable, signed artifact a user
 * or agent walks away with when they export a ClawVille-hosted agent.
 *
 * Design goals (see `.claude/plans/agent-export-portability.md` §5):
 *   - three.ws-COMPATIBLE on the minimal `mesh` / `owner` / `signature` core
 *     so an external three.ws-style viewer can at least render the body.
 *   - A ClawVille-namespaced SUPERSET (`clawville.*`) for the economy/skill
 *     fields three.ws has no concept of (character, skillPack, provenance).
 *   - Integrity by URI + SHA-256 (content-addressed), NOT by on-chain presence
 *     — so the off-chain signed manifest stands alone today and an on-chain
 *     ownership anchor can be slotted into `owner` later with no schema change.
 *
 * HARD INVARIANTS (enforced by the builder, not just convention):
 *   - NO secret keys ever appear. Only `owner.address` (avatar wallet PUBKEY)
 *     and `clawville.identity.pubkey` (ed25519 identity PUBKEY). The custodial
 *     `wallet.secretKey` is emitted exactly once at connect-time and never
 *     re-emitted — a manifest must never carry it.
 *   - `clawville.character.knowledge` stays empty: ElizaOS v2 treats knowledge
 *     strings as filesystem paths, so RAG rides `clawville.skillPack` instead
 *     (mirrors the existing export-character contract).
 *   - The signature is a DETACHED ed25519 signature over
 *     `sha256(canonicalize(manifest \ signature))`. `canonicalize` is the
 *     byte-for-byte clone of the service-issuer canonicaliser, so the same key
 *     that signs partner payloads signs manifests and any consumer can verify.
 */

/** Body mesh container format. */
export type CamMeshFormat = 'vrm' | 'glb' | 'gltf';

/** Rig family. `vrm-humanoid` = a standard VRM humanoid skeleton. */
export type CamSkeleton = 'vrm-humanoid' | 'custom';

export interface CamMesh {
  /** Absolute, fetchable URL to the body bytes (content-addressed serve). */
  uri: string;
  /** Lowercase hex SHA-256 of the exact body bytes at `uri` at export time. */
  sha256: string;
  format: CamMeshFormat;
  /** Body size in KiB (rounded) — a cheap pre-fetch hint for consumers. */
  kBytes: number;
}

export interface CamOwner {
  /** CAIP-2 chain id, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  chain: string;
  /** Base58 owner address (avatar wallet PUBKEY). PUBKEY ONLY — never a secret. */
  address: string;
}

/** A referenced (not baked) render asset, byte-verifiable when `sha256` present. */
export interface CamAssetRef {
  name?: string;
  uri: string;
  /** Optional lowercase-hex SHA-256 (best-effort; omitted if the asset could not be hashed). */
  sha256?: string;
}

/** An equipped cosmetic, resolved from `avatar_skins` at export time. */
export interface CamCosmeticRef {
  /** Cosmetic slot/category, e.g. `hat`, `glasses`, `aura`. */
  slot: string;
  /** Stable cosmetic SKU slug. */
  skuSlug: string;
  /** Render scope, e.g. `avatar`, `world`, `all`, `activity:reef-race`. */
  scope: string;
  /** Absolute asset URL (mesh cosmetics only; shader/registry-key cosmetics are omitted). */
  uri: string;
  /** Which rig the chosen variant targets, e.g. `milady-vrm`, `universal`. */
  rigType: string;
  /** Optional best-effort SHA-256 of the cosmetic asset bytes. */
  sha256?: string;
}

/** ClawVille-namespaced extension block (a bare three.ws validator would reject this). */
export interface CamClawvilleExt {
  /** Phase 5.1 ed25519 identity PUBKEY (omitted when the owner has none). */
  identity?: { pubkey: string };
  /** ElizaOS v2 Character (opaque here to keep `@clawville/shared` free of `@elizaos/core`). */
  character: unknown;
  /** SkillPackEntry[] — the authoritative RAG carrier (see export-character). */
  skillPack: unknown[];
  provenance: {
    platform: 'clawville.world';
    exportedFrom: { avatarId: string; avatarName: string };
    harness: string;
    agentCategory: string;
    modelKey: string;
  };
}

export interface CamSignature {
  algorithm: 'ed25519';
  /** Base58 detached signature over `sha256(canonicalize(manifest \ signature))`. */
  value: string;
  /** Base58 ed25519 PUBKEY of the signer (the ClawVille service issuer). */
  signer: string;
  /** Canonicalisation scheme id — pins how `value` was computed. */
  canonicalization: 'clawville-jcs-v1';
  /** Disambiguates this signature's intent from other service-issuer signatures. */
  purpose: 'avatar-manifest';
}

/** The unsigned manifest core — exactly the bytes that get canonicalised + signed. */
export interface ClawvilleAvatarManifestCore {
  schemaVersion: 1;
  kind: 'clawville.avatar.v1';
  /** Resolvable id, e.g. `clawville:avatar:<uuid>`. */
  id: string;
  name: string;
  mesh: CamMesh;
  skeleton: CamSkeleton;
  /** Off-chain today (null when no wallet); on-chain anchor slots in here later. */
  owner: CamOwner | null;
  createdAt: string;
  animations?: CamAssetRef[];
  cosmetics?: CamCosmeticRef[];
  clawville: CamClawvilleExt;
}

/** A fully-signed, portable ClawVille avatar manifest. */
export interface ClawvilleAvatarManifest extends ClawvilleAvatarManifestCore {
  signature: CamSignature;
}
