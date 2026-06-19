/**
 * ClawVille Avatar Manifest — DB-FREE core: assemble → sign → verify.
 *
 * This module deliberately has NO database import so it stays trivially
 * unit-testable (see `__tests__/avatar-manifest.test.ts`). It takes already-
 * resolved inputs (the DB reads + body fetch happen in
 * `avatar-manifest-service.ts`) and produces / verifies a signed manifest.
 *
 * Signing reuses the protected `service-issuer.signPayload()` verbatim (import
 * only — we never edit that file). `signPayload` canonicalises with the issuer's
 * own `canonicalJson`; our `@clawville/shared` `canonicalize` is a byte-for-byte
 * clone, so a manifest signed here verifies with the shared canonicaliser. The
 * parity is pinned by the test `canonicalize(core) === signPayload(core).body`.
 *
 * INVARIANT: no secret ever enters a manifest — only `owner.address` (avatar
 * wallet pubkey) and `clawville.identity.pubkey`. Callers pass pubkeys only.
 */
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  canonicalize,
  type CamAssetRef,
  type CamCosmeticRef,
  type CamMeshFormat,
  type CamSkeleton,
  type ClawvilleAvatarManifest,
  type ClawvilleAvatarManifestCore,
} from '@clawville/shared';
import { signPayload } from './service-issuer';

/** Solana mainnet CAIP-2 reference — matches x402-config + agent-registration. */
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** Lowercase-hex SHA-256 of raw bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface AssembleManifestInput {
  avatarId: string;
  avatarName: string;
  mesh: { uri: string; sha256: string; format: CamMeshFormat; kBytes: number };
  skeleton: CamSkeleton;
  /** Avatar wallet PUBKEY (base58) or null when the avatar has no wallet. */
  ownerAddress: string | null;
  /** CAIP-2 chain for `owner` — defaults to Solana mainnet. */
  ownerChain?: string;
  /** ISO-8601 export timestamp (caller supplies; keeps this fn side-effect-free). */
  createdAt: string;
  animations?: CamAssetRef[];
  cosmetics?: CamCosmeticRef[];
  /** ed25519 identity PUBKEY (base58) or null. */
  identityPubkey: string | null;
  /** ElizaOS Character (will be JSON-normalised to plain JSON here). */
  character: unknown;
  /** SkillPackEntry[] (will be JSON-normalised here). */
  skillPack: unknown[];
  provenance: { harness: string; agentCategory: string; modelKey: string };
}

/**
 * Collapse any non-plain values (proto-backed objects, Dates, toJSON, etc.)
 * into plain JSON. Critical for determinism: `canonicalize` recurses with
 * `Object.keys` and does NOT honour `toJSON`, so a `Date` would canonicalise
 * to `{}` while the signed `body` (also via canonicalize) and a later
 * `JSON.parse(body)` round-trip must agree. Normalising up front guarantees
 * every value is a plain JSON primitive/array/object with no `undefined`.
 */
function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build the UNSIGNED manifest core. No `undefined` values are ever emitted —
 * optional fields are omitted via conditional spread (so `canonicalize` and the
 * `JSON.parse(signed.body)` round-trip stay byte-stable).
 */
export function assembleManifestCore(input: AssembleManifestInput): ClawvilleAvatarManifestCore {
  const character = toPlainJson(input.character);
  const skillPack = toPlainJson(input.skillPack ?? []);

  const core: ClawvilleAvatarManifestCore = {
    schemaVersion: 1,
    kind: 'clawville.avatar.v1',
    id: `clawville:avatar:${input.avatarId}`,
    name: input.avatarName,
    mesh: {
      uri: input.mesh.uri,
      sha256: input.mesh.sha256,
      format: input.mesh.format,
      kBytes: input.mesh.kBytes,
    },
    skeleton: input.skeleton,
    owner: input.ownerAddress
      ? { chain: input.ownerChain ?? SOLANA_MAINNET_CAIP2, address: input.ownerAddress }
      : null,
    createdAt: input.createdAt,
    ...(input.animations && input.animations.length ? { animations: input.animations } : {}),
    ...(input.cosmetics && input.cosmetics.length ? { cosmetics: input.cosmetics } : {}),
    clawville: {
      ...(input.identityPubkey ? { identity: { pubkey: input.identityPubkey } } : {}),
      character,
      skillPack,
      provenance: {
        platform: 'clawville.world',
        exportedFrom: { avatarId: input.avatarId, avatarName: input.avatarName },
        harness: input.provenance.harness,
        agentCategory: input.provenance.agentCategory,
        modelKey: input.provenance.modelKey,
      },
    },
  };
  return core;
}

/**
 * Sign a manifest core with the ClawVille service-issuer key. Returns the full
 * signed manifest. The non-signature part is reconstructed from
 * `JSON.parse(signed.body)` so it is EXACTLY the bytes that were canonicalised
 * + signed — guaranteeing `verifyAvatarManifestSignature` recomputes identical
 * bytes. Throws if `CLAWVILLE_SERVICE_ISSUER_SK/_PUBKEY` are unset (via
 * `signPayload`).
 */
export function signManifestCore(core: ClawvilleAvatarManifestCore): ClawvilleAvatarManifest {
  const signed = signPayload(core);
  const signedCore = JSON.parse(signed.body) as ClawvilleAvatarManifestCore;
  return {
    ...signedCore,
    signature: {
      algorithm: 'ed25519',
      value: signed.signature,
      signer: signed.pubkey,
      canonicalization: 'clawville-jcs-v1',
      purpose: 'avatar-manifest',
    },
  };
}

export interface ManifestVerifyResult {
  valid: boolean;
  signer: string;
  reason?: string;
}

/**
 * Verify a manifest's detached ed25519 signature over
 * `sha256(canonicalize(manifest \ signature))`. PURE — needs only the embedded
 * signer pubkey, NOT the secret key, so any consumer (the verifier script, the
 * future reimport route) can call it.
 *
 * Pass `opts.expectedSigner` (e.g. the pubkey from
 * `/.well-known/clawville-issuer.json`) to additionally assert WHO signed it —
 * a valid signature from an UNTRUSTED signer is not enough to trust a manifest.
 */
export function verifyAvatarManifestSignature(
  manifest: unknown,
  opts?: { expectedSigner?: string },
): ManifestVerifyResult {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, signer: '', reason: 'not an object' };
  }
  const { signature, ...core } = manifest as ClawvilleAvatarManifest & Record<string, unknown>;
  if (!signature || typeof signature !== 'object' || !signature.value || !signature.signer) {
    return { valid: false, signer: '', reason: 'missing signature' };
  }
  if (opts?.expectedSigner && signature.signer !== opts.expectedSigner) {
    return { valid: false, signer: signature.signer, reason: 'signer is not the expected issuer' };
  }
  const canonical = canonicalize(core);
  const digest = createHash('sha256').update(canonical).digest();
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new Uint8Array(digest),
      bs58.decode(signature.value),
      bs58.decode(signature.signer),
    );
  } catch {
    ok = false; // malformed base58 → invalid, never throw
  }
  return ok
    ? { valid: true, signer: signature.signer }
    : { valid: false, signer: signature.signer, reason: 'signature does not verify' };
}
