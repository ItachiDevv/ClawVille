/**
 * Mock-Covenant partner probe — drives the LIVE signed wire of the
 * `/api/partner/covenant/*` read surface end-to-end (2026-07-13).
 *
 * Mirrors `scripts/hatcher/mock-hatcher-client.ts`'s role for the Covenant
 * partner: staging verification uses a TEST keypair provisioned via the
 * STANDARD `PARTNER_PUBKEYS` mechanism (`{"covenant":"<pubkey>"}` +
 * `COVENANT_ALLOWED_IPS`) — NOT the hatcher-only ALLOW_TEST_PARTNER_PUBKEY
 * backdoor, which is deliberately not extended to covenant. Provision, probe,
 * REMOVE + redeploy after (same hygiene as the hatcher harness).
 *
 * Usage:
 *   bun apps/api/scripts/covenant/mock-covenant-probe.ts \
 *     --api-base https://api-staging.clawville.world \
 *     --keyfile <path to solana-style 64-byte secret key JSON>   # generated with --gen-key
 *
 *   --gen-key <path>   generate a fresh ed25519 keypair, write the secret to
 *                      <path> (JSON array), print the base58 pubkey, exit.
 *
 * Asserts (fail-closed, non-zero exit on any miss):
 *   1. unsigned GET /actions            → 401/403/503 (never 200)
 *   2. signed GET /actions/head         → 200, self-consistent head/batch pair
 *   3. signed GET /actions?limit=…      → 200, sealed-only records, ascending
 *      chain positions, per-record hash RECOMPUTES (payload → payload_hash →
 *      record_hash chain link) — the full verifier contract on live data
 *   4. signed GET with a TAMPERED path  → 401 (signature binds the path)
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) continue;
        out[k] = sort(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function recordHash(parts: {
  prevHash: string;
  payloadHash: string;
  action: string;
  subjectType: string;
  subjectId: string;
  actorKind: string | null;
  chainPosition: string;
  createdAtIso: string;
}): string {
  const h = createHash('sha256');
  const push = (s: string, last = false) => {
    h.update(Buffer.from(s, 'utf8'));
    if (!last) h.update(Buffer.from([0]));
  };
  push(parts.prevHash);
  push(parts.payloadHash);
  push(parts.action);
  push(parts.subjectType);
  push(parts.subjectId);
  push(parts.actorKind ?? '');
  push(parts.chainPosition);
  push(parts.createdAtIso, true);
  return h.digest('hex');
}

const genKeyPath = arg('gen-key');
if (genKeyPath) {
  const kp = nacl.sign.keyPair();
  await Bun.write(genKeyPath, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`pubkey (base58): ${bs58.encode(kp.publicKey)}`);
  console.log(`secret written to ${genKeyPath} — provision PARTNER_PUBKEYS.covenant with the pubkey`);
  process.exit(0);
}

const apiBase = arg('api-base');
const keyfile = arg('keyfile');
if (!apiBase || !keyfile) {
  console.error('FATAL: --api-base and --keyfile are required (or --gen-key <path>)');
  process.exit(2);
}

const secret = new Uint8Array(JSON.parse(await Bun.file(keyfile).text()));
const kp = nacl.sign.keyPair.fromSecretKey(secret);
const pubkeyB58 = bs58.encode(kp.publicKey);

function signedHeaders(path: string, signPath?: string): Record<string, string> {
  const ts = Date.now().toString();
  const challenge = `clawville-partner-get\nGET\n${signPath ?? path}\n${ts}`;
  const digest = createHash('sha256').update(challenge).digest();
  const sig = nacl.sign.detached(new Uint8Array(digest), kp.secretKey);
  return {
    'X-Covenant-Issuer-Pubkey': pubkeyB58,
    'X-Covenant-Signature': bs58.encode(sig),
    'X-Covenant-Timestamp': ts,
  };
}

let failures = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1. Unsigned → fail-closed
{
  const res = await fetch(`${apiBase}/api/partner/covenant/actions`);
  assert(res.status !== 200, `unsigned GET /actions fail-closed (got ${res.status})`);
}

// 2. Signed head
{
  const path = '/api/partner/covenant/actions/head';
  const res = await fetch(`${apiBase}${path}`, { headers: signedHeaders(path) });
  assert(res.status === 200, `signed GET /actions/head 200 (got ${res.status})`);
  if (res.status === 200) {
    const body = (await res.json()) as any;
    if (body.head && body.latestBatch) {
      assert(
        body.latestBatch.lastPosition === body.head.chainPosition &&
          body.latestBatch.batchRoot === body.head.recordHash,
        'head/batch pair self-consistent (single-snapshot read)',
        JSON.stringify({ head: body.head, batch: body.latestBatch }),
      );
    } else {
      console.log('  INFO head/batch empty (no sealed records yet) — consistency check skipped');
    }
  }
}

// 3. Signed actions — full verifier recompute on live rows
{
  const path = '/api/partner/covenant/actions';
  const res = await fetch(`${apiBase}${path}?limit=100`, { headers: signedHeaders(path) });
  assert(res.status === 200, `signed GET /actions 200 (got ${res.status})`);
  if (res.status === 200) {
    const body = (await res.json()) as any;
    const actions: any[] = body.actions ?? [];
    console.log(`  INFO ${actions.length} sealed records served`);
    let ascending = true;
    let hashesOk = true;
    let payloadsOk = true;
    let prev = 0n;
    for (const a of actions) {
      const pos = BigInt(a.chainPosition);
      if (pos <= prev) ascending = false;
      prev = pos;
      const ph = createHash('sha256').update(canonicalJson(a.payload), 'utf8').digest('hex');
      if (ph !== a.payloadHash) payloadsOk = false;
      const rh = recordHash({
        prevHash: a.prevHash,
        payloadHash: a.payloadHash,
        action: a.action,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        actorKind: a.actorKind,
        chainPosition: a.chainPosition,
        createdAtIso: a.createdAt,
      });
      if (rh !== a.recordHash) hashesOk = false;
    }
    if (actions.length > 0) {
      assert(ascending, 'chain positions strictly ascending');
      assert(payloadsOk, 'every payload re-hashes to payload_hash (verifier contract)');
      assert(hashesOk, 'every record_hash recomputes from row fields (chain contract)');
      // Link check within the page
      let linked = true;
      for (let i = 1; i < actions.length; i++) {
        if (
          BigInt(actions[i].chainPosition) === BigInt(actions[i - 1].chainPosition) + 1n &&
          actions[i].prevHash !== actions[i - 1].recordHash
        ) {
          linked = false;
        }
      }
      assert(linked, 'adjacent records link (prev_hash = prior record_hash)');
    } else {
      console.log('  INFO no sealed records yet — recompute checks skipped');
    }
  }
}

// 4. Tampered path → 401 (signature binds path)
{
  const res = await fetch(`${apiBase}/api/partner/covenant/actions/head`, {
    headers: signedHeaders('/api/partner/covenant/actions/head', '/api/partner/covenant/actions'),
  });
  assert(res.status === 401, `path-tampered signature rejected (got ${res.status})`);
}

console.log(failures === 0 ? '\nALL ASSERTIONS PASSED' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
