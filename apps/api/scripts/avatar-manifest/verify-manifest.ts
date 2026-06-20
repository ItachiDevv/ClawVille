/**
 * Standalone ClawVille Avatar Manifest verifier — proves the portability loop
 * end-to-end OUTSIDE the server: given an exported manifest, it (1) validates
 * structure, (2) verifies the ed25519 signature over
 * `canonicalize(manifest \ signature)`, and (3) fetches the body bytes and
 * asserts their SHA-256 equals `mesh.sha256`. This is the "a third party can
 * trust this artifact without ClawVille" check.
 *
 * Usage (Bun):
 *   bun run apps/api/scripts/avatar-manifest/verify-manifest.ts <manifest-url-or-file> [flags]
 *
 * Flags:
 *   --issuer=<url>    Fetch the trusted issuer pubkey from this URL
 *                     (e.g. https://api-staging.clawville.world/.well-known/clawville-issuer.json)
 *                     and assert the manifest was signed by it.
 *   --signer=<pubkey> Assert the signer equals this base58 pubkey directly.
 *
 * With neither flag the signature is checked for validity but the SIGNER is not
 * checked against a trusted issuer (a valid signature from an unknown key is not
 * proof of provenance) — a warning is printed.
 *
 * Exit code 0 iff signature + body-hash both pass (and signer matches when a
 * trust anchor was supplied); 1 otherwise.
 */
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { clawvilleAvatarManifestSchema, type ClawvilleAvatarManifest } from '@clawville/shared';
import { verifyAvatarManifestSignature } from '../../src/services/avatar-manifest-core';

function getFlag(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

async function loadManifest(src: string): Promise<unknown> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch manifest ${src}: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(src, 'utf8'));
}

async function fetchIssuerPubkey(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch issuer ${url}: HTTP ${res.status}`);
  const info = (await res.json()) as { publicKey?: string };
  if (!info.publicKey) throw new Error(`issuer ${url} has no publicKey`);
  return info.publicKey;
}

async function main(): Promise<number> {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: verify-manifest.ts <manifest-url-or-file> [--issuer=<url>] [--signer=<pubkey>]');
    return 1;
  }

  const raw = await loadManifest(src);

  // 1) Structure.
  const parsed = clawvilleAvatarManifestSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('✗ STRUCTURE  invalid:', parsed.error.issues.slice(0, 5));
    return 1;
  }
  const manifest = parsed.data as unknown as ClawvilleAvatarManifest;
  console.log('✓ STRUCTURE  valid —', manifest.id, `(${manifest.mesh.format}, ${manifest.mesh.kBytes}KiB)`);

  // 2) Signature (+ optional trust anchor).
  // NOTE: verification runs on the canonical CORE (signature stripped, keys
  // re-sorted), not the literal received bytes — so zod stripping unknown keys
  // above is safe: any key that was actually signed but is now missing, or any
  // injected extra, changes the canonical bytes and breaks the signature. Never
  // wire a trust decision onto the RAW input — only onto a verified manifest.
  let expectedSigner = getFlag('signer');
  const issuerUrl = getFlag('issuer');
  if (!expectedSigner && issuerUrl) expectedSigner = await fetchIssuerPubkey(issuerUrl);

  const sig = verifyAvatarManifestSignature(manifest, expectedSigner ? { expectedSigner } : undefined);
  if (!sig.valid) {
    console.error(`✗ SIGNATURE  ${sig.reason} (signer ${sig.signer})`);
    return 1;
  }
  if (expectedSigner) {
    console.log(`✓ SIGNATURE  valid + signed by trusted issuer ${sig.signer}`);
  } else {
    console.log(`✓ SIGNATURE  valid (signer ${sig.signer})`);
    console.warn('  ⚠ signer NOT checked against a trusted issuer — pass --issuer=<url> for provenance.');
  }

  // 3) Body content-address.
  const bodyRes = await fetch(manifest.mesh.uri);
  if (!bodyRes.ok) {
    console.error(`✗ BODY       fetch ${manifest.mesh.uri}: HTTP ${bodyRes.status}`);
    return 1;
  }
  const bytes = new Uint8Array(await bodyRes.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.mesh.sha256) {
    console.error(`✗ BODY       sha256 mismatch\n   expected ${manifest.mesh.sha256}\n   actual   ${actual}`);
    return 1;
  }
  console.log(`✓ BODY       sha256 matches (${bytes.length} bytes)`);

  console.log('\nPASS — manifest is structurally valid, signature verifies, body is content-addressed.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('verify-manifest error:', err);
    process.exit(1);
  });
