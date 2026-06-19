/**
 * Avatar-manifest unit tests — the security crux of the export feature.
 *
 * Proves, WITHOUT a database:
 *   1. `canonicalize` is deterministic (key-order independent).
 *   2. The shared `canonicalize` is BYTE-IDENTICAL to the service-issuer's
 *      private `canonicalJson` (`canonicalize(core) === signPayload(core).body`)
 *      — the parity invariant the whole sign/verify scheme rests on.
 *   3. build → sign → verify round-trips, and any tamper (body hash, payload
 *      field, signer) fails verification.
 *   4. `AGENT_MODEL_BODY_PATHS` covers every `AGENT_MODEL_KEYS` (drift guard).
 *   5. No secret ever appears in a serialized manifest.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  canonicalize,
  clawvilleAvatarManifestSchema,
  AGENT_MODEL_BODY_PATHS,
  AGENT_MODEL_KEYS,
  type ClawvilleAvatarManifestCore,
} from '@clawville/shared';
import {
  assembleManifestCore,
  signManifestCore,
  verifyAvatarManifestSignature,
  type AssembleManifestInput,
} from '../avatar-manifest-core';
import { signPayload } from '../service-issuer';

let testPub = '';

const baseInput: AssembleManifestInput = {
  avatarId: '11111111-1111-1111-1111-111111111111',
  avatarName: 'TestAvatar',
  mesh: {
    uri: 'https://clawville.world/avatars/phanes.vrm?v=2',
    sha256: 'a'.repeat(64),
    format: 'vrm',
    kBytes: 3120,
  },
  skeleton: 'vrm-humanoid',
  ownerAddress: 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1',
  createdAt: '2026-06-19T00:00:00.000Z',
  identityPubkey: '8pZ4kQvXq2bWnT3rYh6sJdN1mLcF5gE9aPzRwUxKyVbo',
  character: { name: 'TestAvatar', bio: ['a sea agent'], knowledge: [] },
  skillPack: [{ skillId: 'orient', name: 'ClawVille', knowledge: ['k1', 'k2'] }],
  provenance: { harness: 'milady', agentCategory: 'hatcher', modelKey: 'phanes' },
};

function makeCore(): ClawvilleAvatarManifestCore {
  return assembleManifestCore(baseInput);
}

beforeAll(() => {
  // Service-issuer reads its key LAZILY inside signPayload, so setting env here
  // (after module import) is sufficient. Use a throwaway ed25519 keypair.
  const kp = nacl.sign.keyPair();
  process.env.CLAWVILLE_SERVICE_ISSUER_SK = bs58.encode(kp.secretKey); // 64 bytes
  process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY = bs58.encode(kp.publicKey); // 32 bytes
  testPub = bs58.encode(kp.publicKey);
});

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('sorts nested object keys but preserves array order', () => {
    expect(canonicalize({ a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}]}');
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
  it('handles null + primitives like JSON.stringify', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(5)).toBe('5');
  });
});

describe('AGENT_MODEL_BODY_PATHS coverage', () => {
  it('has a body path for every AGENT_MODEL_KEYS (drift guard)', () => {
    expect(Object.keys(AGENT_MODEL_BODY_PATHS).sort()).toEqual([...AGENT_MODEL_KEYS].sort());
  });
});

describe('canonicalization parity with the service issuer', () => {
  it('canonicalize(core) === signPayload(core).body', () => {
    const core = makeCore();
    expect(canonicalize(core)).toBe(signPayload(core).body);
  });
});

describe('build → sign → verify', () => {
  it('round-trips a valid manifest', () => {
    const manifest = signManifestCore(makeCore());
    expect(manifest.signature.algorithm).toBe('ed25519');
    expect(manifest.signature.purpose).toBe('avatar-manifest');
    expect(manifest.signature.canonicalization).toBe('clawville-jcs-v1');
    expect(manifest.signature.signer).toBe(testPub);

    expect(verifyAvatarManifestSignature(manifest, { expectedSigner: testPub }).valid).toBe(true);
    expect(clawvilleAvatarManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('omits owner/identity when absent, still verifies', () => {
    const core = assembleManifestCore({ ...baseInput, ownerAddress: null, identityPubkey: null });
    const manifest = signManifestCore(core);
    expect(manifest.owner).toBeNull();
    expect((manifest.clawville as { identity?: unknown }).identity).toBeUndefined();
    expect(verifyAvatarManifestSignature(manifest).valid).toBe(true);
  });

  it('rejects a tampered body hash', () => {
    const manifest = signManifestCore(makeCore());
    const tampered = { ...manifest, mesh: { ...manifest.mesh, sha256: 'b'.repeat(64) } };
    expect(verifyAvatarManifestSignature(tampered).valid).toBe(false);
  });

  it('rejects a tampered payload field', () => {
    const manifest = signManifestCore(makeCore());
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.clawville.provenance.modelKey = 'lobster';
    expect(verifyAvatarManifestSignature(tampered).valid).toBe(false);
  });

  it('rejects when the signer is not the expected issuer', () => {
    const manifest = signManifestCore(makeCore());
    const res = verifyAvatarManifestSignature(manifest, {
      expectedSigner: bs58.encode(nacl.sign.keyPair().publicKey),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('expected');
  });

  it('does not throw on a malformed signature', () => {
    const manifest = signManifestCore(makeCore());
    const bad = { ...manifest, signature: { ...manifest.signature, value: 'not-base58-!!!' } };
    expect(verifyAvatarManifestSignature(bad).valid).toBe(false);
  });
});

describe('custody invariant', () => {
  it('never serializes a secret key', () => {
    const manifest = signManifestCore(makeCore());
    const blob = JSON.stringify(manifest).toLowerCase();
    expect(blob).not.toContain('secretkey');
    expect(blob).not.toContain('secret_key');
    expect(blob).not.toContain('privatekey');
  });
});
