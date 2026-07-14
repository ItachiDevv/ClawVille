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
 *     --keyfile <path to 64-byte ed25519 secret key JSON>   # from --gen-key
 *
 *   --gen-key <path>   generate a fresh ed25519 keypair, write the secret to
 *                      <path> (JSON array), print the base58 pubkey, exit.
 *
 * FULL-CHAIN VERIFICATION (Codex covenant round 3 HIGH #4 — a partial probe
 * that samples one page can green-light a broken chain):
 *   1. unsigned GET /actions          → non-200 (fail-closed)
 *   2. signed GET /actions/head       → 200; head and latestBatch must be
 *      JOINTLY null or JOINTLY present, and when present the pair must be
 *      self-consistent (batch.lastPosition === head.chainPosition,
 *      batch.batchRoot === head.recordHash)
 *   3. signed GET /actions paginated FROM POSITION 0 TO THE CAPTURED HEAD:
 *      strict per-record schema, GENESIS check (position 1 has the 64-zero
 *      prev_hash), gapless positions across pages, prev_hash linkage across
 *      every boundary, payload re-hash + record_hash recompute on EVERY
 *      record, and the walk MUST terminate exactly at the captured head
 *      (position AND hash). Records sealed after the head capture are ignored
 *      beyond the head — the verified prefix is what the head attests.
 *   4. signed GET with a TAMPERED path → 401 (signature binds the path)
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

const GENESIS_HASH = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const POSINT = /^\d+$/;

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

/** Strict per-record schema check. Returns null + fails the run on breach. */
function validateRecordShape(a: any, i: string): boolean {
  const ok =
    a != null &&
    typeof a === 'object' &&
    typeof a.chainPosition === 'string' &&
    POSINT.test(a.chainPosition) &&
    typeof a.action === 'string' &&
    typeof a.subjectType === 'string' &&
    typeof a.subjectId === 'string' &&
    (a.actorKind === null || typeof a.actorKind === 'string') &&
    a.payload != null &&
    typeof a.payload === 'object' &&
    typeof a.payloadHash === 'string' &&
    HEX64.test(a.payloadHash) &&
    typeof a.prevHash === 'string' &&
    HEX64.test(a.prevHash) &&
    typeof a.recordHash === 'string' &&
    HEX64.test(a.recordHash) &&
    typeof a.createdAt === 'string' &&
    !Number.isNaN(Date.parse(a.createdAt));
  if (!ok) assert(false, `record schema strict-valid at ${i}`, JSON.stringify(a).slice(0, 200));
  return ok;
}

// 1. Unsigned → fail-closed
{
  const res = await fetch(`${apiBase}/api/partner/covenant/actions`);
  assert(res.status !== 200, `unsigned GET /actions fail-closed (got ${res.status})`);
}

// 2. Signed head — capture the verification target
let headPosition: bigint | null = null;
let headHash: string | null = null;
{
  const path = '/api/partner/covenant/actions/head';
  const res = await fetch(`${apiBase}${path}`, { headers: signedHeaders(path) });
  assert(res.status === 200, `signed GET /actions/head 200 (got ${res.status})`);
  if (res.status === 200) {
    const body = (await res.json()) as any;
    const hasHead = body.head != null;
    const hasBatch = body.latestBatch != null;
    // Jointly null or jointly present — a half-null pair is malformed
    // (the sealer writes head + batch in one tx).
    assert(hasHead === hasBatch, `head and latestBatch jointly null/present (head=${hasHead}, batch=${hasBatch})`);
    if (hasHead && hasBatch) {
      const shapeOk =
        typeof body.head.chainPosition === 'string' &&
        POSINT.test(body.head.chainPosition) &&
        HEX64.test(body.head.recordHash ?? '') &&
        POSINT.test(body.latestBatch.lastPosition ?? '') &&
        HEX64.test(body.latestBatch.batchRoot ?? '');
      assert(shapeOk, 'head/batch schema strict-valid', JSON.stringify(body).slice(0, 300));
      assert(
        body.latestBatch.lastPosition === body.head.chainPosition &&
          body.latestBatch.batchRoot === body.head.recordHash,
        'head/batch pair self-consistent (single-snapshot read)',
        JSON.stringify({ head: body.head, batch: body.latestBatch }),
      );
      if (shapeOk) {
        headPosition = BigInt(body.head.chainPosition);
        headHash = body.head.recordHash;
      }
    } else {
      console.log('  INFO empty chain (no sealed records yet) — full-walk checks will assert emptiness');
    }
  }
}

// 3. Full paginated walk: position 0 → captured head, verify EVERYTHING.
{
  const path = '/api/partner/covenant/actions';
  let cursor = 0n;
  let prevRecordHash: string | null = null; // set after the first record
  let count = 0n;
  let walkOk = true;
  let reachedHead = headPosition === null;

  while (!reachedHead || (headPosition === null && count === 0n)) {
    const res = await fetch(`${apiBase}${path}?sincePosition=${cursor}&limit=500`, {
      headers: signedHeaders(path),
    });
    if (res.status !== 200) {
      assert(false, `signed GET /actions page 200 (got ${res.status} at cursor ${cursor})`);
      walkOk = false;
      break;
    }
    const body = (await res.json()) as any;
    assert(Array.isArray(body.actions), `actions is an array (cursor ${cursor})`);
    if (!Array.isArray(body.actions)) {
      walkOk = false;
      break;
    }
    if (body.actions.length === 0) {
      if (headPosition !== null && cursor < headPosition) {
        assert(false, `chain walk starved before head (cursor ${cursor} < head ${headPosition})`);
        walkOk = false;
      }
      break;
    }
    for (const a of body.actions) {
      if (!validateRecordShape(a, `position ${a?.chainPosition ?? '?'}`)) {
        walkOk = false;
        break;
      }
      const pos = BigInt(a.chainPosition);
      // Stop at the captured head — later-sealed records are beyond the
      // attestation target and not part of this verification.
      if (headPosition !== null && pos > headPosition) {
        reachedHead = count > 0n && cursor >= headPosition;
        break;
      }
      // Gapless: every position is exactly prior + 1 (genesis = 1).
      const expected = cursor + 1n;
      if (pos !== expected) {
        assert(false, `gapless positions (expected ${expected}, got ${pos})`);
        walkOk = false;
        break;
      }
      // Genesis / linkage.
      const expectedPrev = prevRecordHash ?? GENESIS_HASH;
      if (pos === 1n && a.prevHash !== GENESIS_HASH) {
        assert(false, `genesis prev_hash is 64 zeros (got ${a.prevHash.slice(0, 12)}…)`);
        walkOk = false;
        break;
      }
      if (prevRecordHash !== null && a.prevHash !== expectedPrev) {
        assert(false, `prev_hash links to prior record_hash at position ${pos}`);
        walkOk = false;
        break;
      }
      // Content: payload re-hash + record hash recompute.
      const ph = createHash('sha256').update(canonicalJson(a.payload), 'utf8').digest('hex');
      if (ph !== a.payloadHash) {
        assert(false, `payload re-hashes to payload_hash at position ${pos}`);
        walkOk = false;
        break;
      }
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
      if (rh !== a.recordHash) {
        assert(false, `record_hash recomputes at position ${pos}`);
        walkOk = false;
        break;
      }
      prevRecordHash = a.recordHash;
      cursor = pos;
      count += 1n;
      if (headPosition !== null && pos === headPosition) {
        reachedHead = true;
        break;
      }
    }
    if (!walkOk || reachedHead) break;
  }

  if (headPosition === null) {
    assert(count === 0n, `empty chain serves zero records (got ${count})`);
  } else if (walkOk) {
    assert(
      reachedHead && cursor === headPosition,
      `walk terminated exactly at the captured head (cursor ${cursor}, head ${headPosition})`,
    );
    assert(
      prevRecordHash === headHash,
      'final record_hash equals the captured head recordHash',
      `walk ${prevRecordHash?.slice(0, 12)}… vs head ${headHash?.slice(0, 12)}…`,
    );
    console.log(`  INFO verified ${count} records, genesis → head ${headPosition}`);
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
