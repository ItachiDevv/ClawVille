/**
 * Hatcher partner-integration END-TO-END SELF-TEST (Phase A, v2).
 *
 * Goal: PROVE the Hatcher partner integration contract works with a generated
 * ed25519 keypair, with hard per-case evidence, BEFORE Hatcher sends real keys.
 *
 * RUN AGAINST: the SHIPPING working-tree HEAD of feat/hatcher-portal
 * (PROTOCOL_VERSION = 2, 5-verb whitelist INCLUDING enter_cove, full Cove-play
 * protocol manual). The previous revision of this harness mistakenly ran against
 * origin/staging @ e2982469 (4-verb, v1) and codified the ABSENCE of the Cove
 * agent-parity feature — this version tests the code that actually ships.
 *
 * This harness imports the REAL ClawVille functions (never reimplements the
 * contract) and exercises:
 *   A. Body-hash signature primitive (verifyPartnerSignature, the shared
 *      primitive portal.ts still uses) + canonicalization trap
 *   W. Inbound WRITE signature  (verifyPartnerWriteSignature + partnerWriteChallenge):
 *      timestamp + replay window + domain separation on POST/PATCH/DELETE
 *   B. Inbound GET signature    (verifyPartnerGetSignature + partnerGetChallenge)
 *   C. Register Zod contract + publicAgentRecord() shape + userId-binding parity
 *   D. Hatcher [ACTION:] whitelist executor incl. enter_cove HAPPY PATH (NO DB)
 *   E. buildHatcherWorldState public-only (NO secrets)
 *   F. Outbound cognition signing (signPayload) + chatHatcherProxy fail-soft
 *   G. Protocol single-source content-hash invariant @ v2 + EXECUTOR↔MANUAL parity
 *   H. HTTP gates via Hono app.request — negatives AND body-signed accept (NO DB writes)
 *   I. Cove agent-tool money path: tools.json + POST :tool + getSubject parity (NO DB writes)
 *
 * Run:  bun run scripts/hatcher/selftest-e2e.ts
 * Exit: 0 on all-pass, 1 on any FAIL.
 *
 * SAFETY: NO writes to the shared Supabase. Every DB-touching path is either a
 * pure function, an in-memory sim, or a NEGATIVE/early-return HTTP path that
 * returns BEFORE persistence (401 auth-reject, 400 zod-reject, 404 row-missing,
 * 401/403/404 session-reject). `bun run dev` is never invoked.
 *
 * IMPORTANT: this harness imports the EXPORTED publicAgentRecord from
 * apps/api/src/routes/partner-hatcher.ts (case C). That function is private on
 * the committed tree; the one-line `export` fix in fixesApplied[] is applied in
 * the worktree first (pure refactor, no behavior change).
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Crash-loud env vars: the API has module-load env requirements. We provide
// DUMMY values (no real connection is ever made — every test is a pure fn, an
// in-memory sim, or a negative/early-return HTTP path that returns before any DB
// write). Set BEFORE importing any apps/api module. Real test secrets
// (PARTNER_PUBKEYS, CLAWVILLE_SERVICE_ISSUER_SK/PUBKEY, VANITY_ENCRYPTION_KEY)
// are set with keypairs/keys we generate here so the verify/sign paths are
// genuinely valid.
// ---------------------------------------------------------------------------
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
const HEX32 = '0'.repeat(64);
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

// --- Generate the test partner keypair (stands in for Hatcher's real key) ---
const partnerKp = nacl.sign.keyPair();
const partnerPubB58 = bs58.encode(partnerKp.publicKey);
process.env.PARTNER_PUBKEYS = JSON.stringify({ hatcher: partnerPubB58 });

// --- Generate the ClawVille service-issuer keypair (outbound signing) ---
const issuerKp = nacl.sign.keyPair();
process.env.CLAWVILLE_SERVICE_ISSUER_SK = bs58.encode(issuerKp.secretKey);
process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY = bs58.encode(issuerKp.publicKey);

// ---------------------------------------------------------------------------
// Test harness scaffolding
// ---------------------------------------------------------------------------
interface CaseResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  evidence: string;
}
const results: CaseResult[] = [];
const bugs: string[] = [];

function record(name: string, status: CaseResult['status'], evidence: string) {
  results.push({ name, status, evidence });
  const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`[${tag}] ${name}\n        ${evidence.replace(/\n/g, '\n        ')}`);
}

/** Assert helper: records PASS/FAIL with evidence. Never throws. */
function check(name: string, cond: boolean, evidence: string) {
  record(name, cond ? 'PASS' : 'FAIL', evidence);
}

/** Run an async test block; a thrown error is a FAIL (records the message). */
async function safe(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    record(name, 'FAIL', `threw: ${msg}`);
  }
}

// Helpers to sign the way Hatcher must.
// INBOUND scheme: sign over sha256(EXACT RAW transmitted bytes) — NOT a
// re-canonicalized JSON. This asymmetry is deliberate (see case A8): the server
// verifies the literal bytes, so a partner that re-serializes/canonicalizes the
// inbound body before signing MUST be rejected.
function signRawBody(rawBody: string, sk: Uint8Array): string {
  const digest = createHash('sha256').update(rawBody).digest();
  return bs58.encode(nacl.sign.detached(new Uint8Array(digest), sk));
}
function signChallenge(challenge: string, sk: Uint8Array): string {
  const digest = createHash('sha256').update(challenge).digest();
  return bs58.encode(nacl.sign.detached(new Uint8Array(digest), sk));
}
// WRITE scheme (POST/PATCH/DELETE): the partner signs sha256(challenge) where
// challenge = clawville-partner-write\nMETHOD\nPATH\nUNIX_MS\nsha256hex(rawBody).
// This binds the verb, path, timestamp, and body hash, with a +/- 5 min window.
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function buildWriteChallenge(method: string, path: string, tsMillis: string, rawBody: string): string {
  return `clawville-partner-write\n${method.toUpperCase()}\n${path}\n${tsMillis}\n${sha256hex(rawBody)}`;
}
function signWriteChallenge(method: string, path: string, tsMillis: string, rawBody: string, sk: Uint8Array): string {
  return signChallenge(buildWriteChallenge(method, path, tsMillis, rawBody), sk);
}

async function main() {
  console.log('=== Hatcher partner-integration self-test (v2 — shipping HEAD) ===');
  console.log(`partner pubkey (test): ${partnerPubB58}`);
  console.log(`issuer  pubkey (test): ${process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY}`);
  console.log('');

  // ===================================================================
  // CASE A — Inbound WRITE signature (verifyPartnerSignature)
  // ===================================================================
  const partnerSig = await import('../../src/services/partner-signature.ts');
  const {
    verifyPartnerSignature,
    verifyPartnerGetSignature,
    partnerGetChallenge,
    loadPartnerPubkeys,
    PARTNER_GET_SIGNATURE_WINDOW_MS,
    verifyPartnerWriteSignature,
    partnerWriteChallenge,
    PARTNER_WRITE_SIGNATURE_WINDOW_MS,
  } = partnerSig;

  await safe('A0 loadPartnerPubkeys parses PARTNER_PUBKEYS env', () => {
    const map = loadPartnerPubkeys();
    check(
      'A0 loadPartnerPubkeys parses PARTNER_PUBKEYS env',
      !!map && map.hatcher === partnerPubB58,
      `loadPartnerPubkeys() => ${JSON.stringify(map)} ; expected hatcher=${partnerPubB58}`,
    );
  });

  await safe('A0b loadPartnerPubkeys returns null on malformed env', () => {
    const saved = process.env.PARTNER_PUBKEYS;
    process.env.PARTNER_PUBKEYS = '{not json';
    const map = loadPartnerPubkeys();
    process.env.PARTNER_PUBKEYS = saved;
    check(
      'A0b loadPartnerPubkeys returns null on malformed env',
      map === null,
      `malformed PARTNER_PUBKEYS '{not json' => ${JSON.stringify(map)} (expect null)`,
    );
  });

  // A body with keys in a NON-canonical order so the canonicalization trap (A8)
  // is observable: a canonical re-serialize would re-sort these keys.
  const writeBody = JSON.stringify({
    zeta: 'last-key-first',
    agentId: 'selftest-agent-1',
    cognition: {
      backend: 'hatcher-proxy',
      proxyBaseUrl: 'https://api.hatcher.host',
      scopedToken: 'a-scoped-token-1234',
    },
  });
  const goodSig = signRawBody(writeBody, partnerKp.secretKey);

  await safe('A1 WRITE accepts a correct signature', () => {
    const r = verifyPartnerSignature('hatcher', {
      pubkeyHeader: partnerPubB58,
      signatureHeader: goodSig,
      rawBody: writeBody,
    });
    check(
      'A1 WRITE accepts a correct signature',
      r.ok === true && (r as { partnerId: string }).partnerId === 'hatcher',
      `verifyPartnerSignature(correct) => ${JSON.stringify(r)} (expect {ok:true,partnerId:'hatcher'})`,
    );
  });

  await safe('A2 WRITE rejects a tampered body', () => {
    const tampered = writeBody.replace('selftest-agent-1', 'selftest-agent-EVIL');
    const r = verifyPartnerSignature('hatcher', {
      pubkeyHeader: partnerPubB58,
      signatureHeader: goodSig,
      rawBody: tampered,
    });
    check(
      'A2 WRITE rejects a tampered body',
      r.ok === false && (r as { reason: string }).reason === 'bad_signature',
      `verify(tampered body, original sig) => ${JSON.stringify(r)} (expect ok:false reason:bad_signature)`,
    );
  });

  await safe('A3 WRITE rejects a wrong key not in the allowlist', () => {
    const evil = nacl.sign.keyPair();
    const evilPub = bs58.encode(evil.publicKey);
    const evilSig = signRawBody(writeBody, evil.secretKey);
    const r = verifyPartnerSignature('hatcher', {
      pubkeyHeader: evilPub,
      signatureHeader: evilSig,
      rawBody: writeBody,
    });
    check(
      'A3 WRITE rejects a wrong key not in the allowlist',
      r.ok === false && (r as { reason: string }).reason === 'unknown_partner',
      `verify(evil pubkey) => ${JSON.stringify(r)} (expect ok:false reason:unknown_partner)`,
    );
  });

  await safe('A4 WRITE rejects missing headers', () => {
    const r1 = verifyPartnerSignature('hatcher', { pubkeyHeader: null, signatureHeader: goodSig, rawBody: writeBody });
    const r2 = verifyPartnerSignature('hatcher', { pubkeyHeader: partnerPubB58, signatureHeader: null, rawBody: writeBody });
    check(
      'A4 WRITE rejects missing headers',
      r1.ok === false && (r1 as { reason: string }).reason === 'missing_signature' && r2.ok === false && (r2 as { reason: string }).reason === 'missing_signature',
      `missing pubkey => ${JSON.stringify(r1)} ; missing sig => ${JSON.stringify(r2)} (both expect missing_signature)`,
    );
  });

  await safe('A5 WRITE rejects a valid sig by a DIFFERENT signer matching no allowlist pubkey', () => {
    const other = nacl.sign.keyPair();
    const sigByOther = signRawBody(writeBody, other.secretKey);
    const r = verifyPartnerSignature('hatcher', { pubkeyHeader: partnerPubB58, signatureHeader: sigByOther, rawBody: writeBody });
    check(
      'A5 WRITE rejects a valid sig by a DIFFERENT signer matching no allowlist pubkey',
      r.ok === false && (r as { reason: string }).reason === 'bad_signature',
      `verify(allowlisted pubkey, sig from other key) => ${JSON.stringify(r)} (expect bad_signature)`,
    );
  });

  await safe('A6 WRITE rejects bad base58 signature encoding', () => {
    const r = verifyPartnerSignature('hatcher', { pubkeyHeader: partnerPubB58, signatureHeader: '0OIl-not-base58!!', rawBody: writeBody });
    check(
      'A6 WRITE rejects bad base58 signature encoding',
      r.ok === false && ['bad_signature_encoding', 'bad_signature_length', 'bad_signature'].includes((r as { reason: string }).reason),
      `verify(bad-b58 sig) => ${JSON.stringify(r)} (expect a decode/length/sig reject)`,
    );
  });

  await safe('A7 WRITE verifies signature over EMPTY body (DELETE raw-bytes case)', () => {
    const emptySig = signRawBody('', partnerKp.secretKey);
    const r = verifyPartnerSignature('hatcher', { pubkeyHeader: partnerPubB58, signatureHeader: emptySig, rawBody: '' });
    check(
      'A7 WRITE verifies signature over EMPTY body (DELETE raw-bytes case)',
      r.ok === true,
      `verify(empty body, sig over '') => ${JSON.stringify(r)} (expect ok:true — server verifies the exact empty string)`,
    );
  });

  // NEW — A8: the CANONICALIZATION-REJECTION half of the asymmetry trap. The
  // server signs the literal transmitted bytes. A partner who (wrongly) signs a
  // CANONICALIZED re-serialization of the SAME logical object — but transmits
  // the original non-canonical bytes — MUST be rejected, because the bytes the
  // server hashes differ from the bytes the partner hashed. This proves the
  // contract is "sign the raw bytes you send", not "sign some canonical form".
  await safe('A8 WRITE rejects a sig made over a CANONICALIZED re-serialization (raw-bytes-only contract)', () => {
    // Parse + re-stringify with sorted keys → a DIFFERENT byte string than
    // writeBody (which has keys in zeta-first order + nested ordering).
    const obj = JSON.parse(writeBody) as Record<string, unknown>;
    const canonical = JSON.stringify(obj, Object.keys(obj).sort());
    const canonicalDiffers = canonical !== writeBody;
    // Partner signs the canonical form but the server receives the original raw bytes.
    const sigOverCanonical = signRawBody(canonical, partnerKp.secretKey);
    const r = verifyPartnerSignature('hatcher', {
      pubkeyHeader: partnerPubB58,
      signatureHeader: sigOverCanonical,
      rawBody: writeBody, // transmitted bytes = original, NOT the canonical form
    });
    const rejected = r.ok === false && (r as { reason: string }).reason === 'bad_signature';
    if (!rejected) bugs.push('WRITE accepted a signature over a canonicalized re-serialization — raw-bytes-only contract broken (replay/ambiguity risk)');
    check(
      'A8 WRITE rejects a sig made over a CANONICALIZED re-serialization (raw-bytes-only contract)',
      rejected && canonicalDiffers,
      `canonicalForm(${canonical.slice(0, 60)}...) != rawBytes(${writeBody.slice(0, 60)}...) => differ=${canonicalDiffers}\nverify(sig-over-canonical, transmit-raw) => ${JSON.stringify(r)} (expect bad_signature)`,
    );
  });

  // ===================================================================
  // CASE W: Inbound WRITE signature (verifyPartnerWriteSignature)
  // ===================================================================
  // The pre-production cutover: writes (POST/PATCH/DELETE) now require a
  // timestamp + replay window, signing the domain-separated challenge
  // clawville-partner-write\nMETHOD\nPATH\nUNIX_MS\nsha256hex(rawBody). These
  // cases mirror the GET cases (B*) but for the body-bearing write verbs, and
  // add the body-tamper / cross-verb / cross-path / domain-separation guards.
  const writePath = '/api/partner/hatcher/agents';
  const wBody = JSON.stringify({ agentId: 'selftest-w', cognition: { backend: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok-w-12345' } });

  await safe('W0 partnerWriteChallenge format is exact (domain-separated, body-hash bound, LF-joined)', () => {
    const ch = partnerWriteChallenge({ method: 'post', path: '/x', tsMillis: '99', rawBody: 'hello' });
    const expected = `clawville-partner-write\nPOST\n/x\n99\n${sha256hex('hello')}`;
    check('W0 partnerWriteChallenge format is exact (domain-separated, body-hash bound, LF-joined)', ch === expected, `partnerWriteChallenge({post,/x,99,'hello'}) => ${JSON.stringify(ch)}\nexpected ${JSON.stringify(expected)}`);
  });

  await safe('W1 WRITE accepts a fresh, correct signature within the window', () => {
    const now = Date.now();
    const ts = String(now);
    const sig = signWriteChallenge('POST', writePath, ts, wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W1 WRITE accepts a fresh, correct signature within the window', r.ok === true && (r as { partnerId: string }).partnerId === 'hatcher', `verifyPartnerWriteSignature(fresh) => ${JSON.stringify(r)} (expect ok:true)`);
  });

  await safe('W2 WRITE rejects a missing X-Hatcher-Timestamp (tsHeader null)', () => {
    const now = Date.now();
    const ts = String(now);
    const sig = signWriteChallenge('POST', writePath, ts, wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: null, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W2 WRITE rejects a missing X-Hatcher-Timestamp (tsHeader null)', r.ok === false && (r as { reason: string }).reason === 'missing_signature', `verify(ts=null) => ${JSON.stringify(r)} (expect missing_signature)`);
  });

  await safe('W3 WRITE rejects an expired timestamp (outside the window, past)', () => {
    const now = Date.now();
    const staleTs = String(now - (PARTNER_WRITE_SIGNATURE_WINDOW_MS + 1));
    const sig = signWriteChallenge('POST', writePath, staleTs, wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: staleTs, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W3 WRITE rejects an expired timestamp (outside the window, past)', r.ok === false && (r as { reason: string }).reason === 'stale_timestamp', `verify(ts=window+1ms old) => ${JSON.stringify(r)} (expect stale_timestamp); window=${PARTNER_WRITE_SIGNATURE_WINDOW_MS}ms`);
  });

  await safe('W4 WRITE rejects a future timestamp beyond the window', () => {
    const now = Date.now();
    const futureTs = String(now + (PARTNER_WRITE_SIGNATURE_WINDOW_MS + 1));
    const sig = signWriteChallenge('POST', writePath, futureTs, wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: futureTs, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W4 WRITE rejects a future timestamp beyond the window', r.ok === false && (r as { reason: string }).reason === 'stale_timestamp', `verify(ts=window+1ms future) => ${JSON.stringify(r)} (expect stale_timestamp)`);
  });

  await safe('W5 WRITE rejects a non-digit timestamp header', () => {
    const now = Date.now();
    const sig = signWriteChallenge('POST', writePath, '123abc', wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: '123abc', pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W5 WRITE rejects a non-digit timestamp header', r.ok === false && (r as { reason: string }).reason === 'bad_timestamp', `verify(ts='123abc') => ${JSON.stringify(r)} (expect bad_timestamp)`);
  });

  await safe('W6 WRITE rejects a body tamper (sig over original body, verify with mutated body)', () => {
    const now = Date.now();
    const ts = String(now);
    // Sign the challenge for the ORIGINAL body, then verify with a MUTATED body
    // (different body hash => the challenge the server recomputes differs).
    const sig = signWriteChallenge('POST', writePath, ts, wBody, partnerKp.secretKey);
    const mutated = wBody.replace('selftest-w', 'selftest-w-EVIL');
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: mutated, nowMs: now });
    check('W6 WRITE rejects a body tamper (sig over original body, verify with mutated body)', r.ok === false && (r as { reason: string }).reason === 'bad_signature', `verify(sig-over-original, mutated-body) => ${JSON.stringify(r)} (expect bad_signature)`);
  });

  await safe('W7 WRITE rejects a wrong method (sign POST, verify PATCH)', () => {
    const now = Date.now();
    const ts = String(now);
    const sig = signWriteChallenge('POST', writePath, ts, wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'PATCH', path: writePath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W7 WRITE rejects a wrong method (sign POST, verify PATCH)', r.ok === false && (r as { reason: string }).reason === 'bad_signature', `verify(sig-for-POST, method=PATCH) => ${JSON.stringify(r)} (expect bad_signature, cross-verb replay blocked)`);
  });

  await safe('W8 WRITE rejects a wrong path (sign /a, verify /b)', () => {
    const now = Date.now();
    const ts = String(now);
    const sig = signWriteChallenge('POST', '/a', ts, wBody, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: '/b', tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, rawBody: wBody, nowMs: now });
    check('W8 WRITE rejects a wrong path (sign /a, verify /b)', r.ok === false && (r as { reason: string }).reason === 'bad_signature', `verify(sig-for-/a, path=/b) => ${JSON.stringify(r)} (expect bad_signature, cross-path replay blocked)`);
  });

  await safe('W9 DOMAIN SEPARATION (a GET-scheme signature does NOT verify as a write)', () => {
    const now = Date.now();
    const ts = String(now);
    // Make a signature over the GET challenge (clawville-partner-get domain) for
    // the SAME path/ts, then present it to the WRITE verifier. The differing
    // domain prefix means the recomputed write challenge can never match.
    const getCh = partnerGetChallenge({ method: 'POST', path: writePath, tsMillis: ts });
    const getSig = signChallenge(getCh, partnerKp.secretKey);
    const r = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: getSig, rawBody: wBody, nowMs: now });
    if (!(r.ok === false && (r as { reason: string }).reason === 'bad_signature')) bugs.push('a GET-scheme signature verified as a WRITE: domain separation broken (cross-context replay)');
    check('W9 DOMAIN SEPARATION (a GET-scheme signature does NOT verify as a write)', r.ok === false && (r as { reason: string }).reason === 'bad_signature', `verify(GET-domain sig, WRITE verifier, same path/ts) => ${JSON.stringify(r)} (expect bad_signature, a GET sig must NOT verify as a write)`);
  });

  await safe('W10 WRITE rejects a wrong key not in the allowlist (unknown_partner); and missing pubkey/sig (missing_signature)', () => {
    const now = Date.now();
    const ts = String(now);
    const evil = nacl.sign.keyPair();
    const evilPub = bs58.encode(evil.publicKey);
    const evilSig = signWriteChallenge('POST', writePath, ts, wBody, evil.secretKey);
    const rEvil = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: ts, pubkeyHeader: evilPub, sigHeader: evilSig, rawBody: wBody, nowMs: now });
    const goodSigW = signWriteChallenge('POST', writePath, ts, wBody, partnerKp.secretKey);
    const rNoPub = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: ts, pubkeyHeader: null, sigHeader: goodSigW, rawBody: wBody, nowMs: now });
    const rNoSig = verifyPartnerWriteSignature('hatcher', { method: 'POST', path: writePath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: null, rawBody: wBody, nowMs: now });
    const ok = rEvil.ok === false && (rEvil as { reason: string }).reason === 'unknown_partner' && rNoPub.ok === false && (rNoPub as { reason: string }).reason === 'missing_signature' && rNoSig.ok === false && (rNoSig as { reason: string }).reason === 'missing_signature';
    check('W10 WRITE rejects a wrong key not in the allowlist (unknown_partner); and missing pubkey/sig (missing_signature)', ok, `evil-key => ${JSON.stringify(rEvil)} (expect unknown_partner); missing pubkey => ${JSON.stringify(rNoPub)}; missing sig => ${JSON.stringify(rNoSig)} (both expect missing_signature)`);
  });

  // ===================================================================
  // CASE B — Inbound GET signature (verifyPartnerGetSignature)
  // ===================================================================
  const statsPath = '/api/partner/hatcher/agents/selftest-agent-1/stats';

  await safe('B0 partnerGetChallenge format is exact (uppercased method, LF-joined)', () => {
    const ch = partnerGetChallenge({ method: 'get', path: '/test', tsMillis: '1234' });
    const expected = 'clawville-partner-get\nGET\n/test\n1234';
    check('B0 partnerGetChallenge format is exact (uppercased method, LF-joined)', ch === expected, `partnerGetChallenge({get,/test,1234}) => ${JSON.stringify(ch)} ; expected ${JSON.stringify(expected)}`);
  });

  await safe('B1 GET accepts a fresh, correct signature within the window', () => {
    const now = Date.now();
    const ts = String(now);
    const ch = partnerGetChallenge({ method: 'GET', path: statsPath, tsMillis: ts });
    const sig = signChallenge(ch, partnerKp.secretKey);
    const r = verifyPartnerGetSignature('hatcher', { method: 'GET', path: statsPath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, nowMs: now });
    check('B1 GET accepts a fresh, correct signature within the window', r.ok === true && (r as { partnerId: string }).partnerId === 'hatcher', `verifyPartnerGetSignature(fresh) => ${JSON.stringify(r)} (expect ok:true)`);
  });

  await safe('B2 GET rejects an expired timestamp (outside replay window)', () => {
    const now = Date.now();
    const staleTs = String(now - (PARTNER_GET_SIGNATURE_WINDOW_MS + 1));
    const ch = partnerGetChallenge({ method: 'GET', path: statsPath, tsMillis: staleTs });
    const sig = signChallenge(ch, partnerKp.secretKey);
    const r = verifyPartnerGetSignature('hatcher', { method: 'GET', path: statsPath, tsHeader: staleTs, pubkeyHeader: partnerPubB58, sigHeader: sig, nowMs: now });
    check('B2 GET rejects an expired timestamp (outside replay window)', r.ok === false && (r as { reason: string }).reason === 'stale_timestamp', `verify(ts=window+1ms old) => ${JSON.stringify(r)} (expect stale_timestamp); window=${PARTNER_GET_SIGNATURE_WINDOW_MS}ms`);
  });

  await safe('B3 GET rejects a wrong path (signed path != request path)', () => {
    const now = Date.now();
    const ts = String(now);
    const ch = partnerGetChallenge({ method: 'GET', path: '/api/partner/hatcher/agents/OTHER/stats', tsMillis: ts });
    const sig = signChallenge(ch, partnerKp.secretKey);
    const r = verifyPartnerGetSignature('hatcher', { method: 'GET', path: statsPath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, nowMs: now });
    check('B3 GET rejects a wrong path (signed path != request path)', r.ok === false && (r as { reason: string }).reason === 'bad_signature', `verify(sig for other path) => ${JSON.stringify(r)} (expect bad_signature)`);
  });

  await safe('B3b GET path must EXCLUDE query string (signing with ?query fails)', () => {
    const now = Date.now();
    const ts = String(now);
    const ch = partnerGetChallenge({ method: 'GET', path: `${statsPath}?foo=bar`, tsMillis: ts });
    const sig = signChallenge(ch, partnerKp.secretKey);
    const r = verifyPartnerGetSignature('hatcher', { method: 'GET', path: statsPath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, nowMs: now });
    check('B3b GET path must EXCLUDE query string (signing with ?query fails)', r.ok === false && (r as { reason: string }).reason === 'bad_signature', `verify(signed path incl ?foo=bar, request path-only) => ${JSON.stringify(r)} (expect bad_signature)`);
  });

  await safe('B4 GET rejects a tampered signature', () => {
    const now = Date.now();
    const ts = String(now);
    const ch = partnerGetChallenge({ method: 'GET', path: statsPath, tsMillis: ts });
    let sig = signChallenge(ch, partnerKp.secretKey);
    const decoded = bs58.decode(sig);
    decoded[0] = decoded[0] ^ 0xff;
    sig = bs58.encode(decoded);
    const r = verifyPartnerGetSignature('hatcher', { method: 'GET', path: statsPath, tsHeader: ts, pubkeyHeader: partnerPubB58, sigHeader: sig, nowMs: now });
    check('B4 GET rejects a tampered signature', r.ok === false && ['bad_signature', 'bad_signature_length', 'bad_signature_encoding'].includes((r as { reason: string }).reason), `verify(tampered sig) => ${JSON.stringify(r)} (expect a sig reject)`);
  });

  await safe('B5 GET rejects a non-digit timestamp header', () => {
    const now = Date.now();
    const ch = partnerGetChallenge({ method: 'GET', path: statsPath, tsMillis: '123abc' });
    const sig = signChallenge(ch, partnerKp.secretKey);
    const r = verifyPartnerGetSignature('hatcher', { method: 'GET', path: statsPath, tsHeader: '123abc', pubkeyHeader: partnerPubB58, sigHeader: sig, nowMs: now });
    check('B5 GET rejects a non-digit timestamp header', r.ok === false && (r as { reason: string }).reason === 'bad_timestamp', `verify(ts='123abc') => ${JSON.stringify(r)} (expect bad_timestamp)`);
  });

  // ===================================================================
  // CASE C — Register Zod contract + publicAgentRecord() shape (NO DB)
  // ===================================================================
  const ph = await import('../../src/routes/partner-hatcher.ts');
  const skillProto = await import('../../src/services/skill-protocol.ts');
  const { PROTOCOL_VERSION, buildProtocolManual, contentHashOf, protocolPointer, protocolContentHash, resolveApiBase } = skillProto;

  await safe('C1 publicAgentRecord() strips hatcher: prefix + carries protocol pointer + OMITS all token fields', () => {
    if (typeof ph.publicAgentRecord !== 'function') throw new Error('publicAgentRecord is not exported (harness fix not applied)');
    const future = new Date(Date.now() + 3600_000);
    const syntheticRow = {
      agentId: 'hatcher:test-agent-123', id: 'uuid-1', identityType: 'hatcher', mode: 'avatar', targetNpcId: null,
      name: 'TestBot', species: 'hatcher_1', color: 0xff0000, cognitionBackend: 'hatcher-proxy', proxyUrl: 'https://api.hatcher.host',
      proxyTokenEnc: 'ENC_CIPHERTEXT_SHOULD_NEVER_APPEAR', proxyTokenIv: 'IV_SHOULD_NEVER_APPEAR', proxyTokenTag: 'TAG_SHOULD_NEVER_APPEAR',
      walletAddress: 'SoLPubKey1111111111111111111111111111111111', userId: 'user-id-1', sessionExpiresAt: future,
    } as unknown as Parameters<typeof ph.publicAgentRecord>[0];
    const out = ph.publicAgentRecord(syntheticRow) as Record<string, unknown>;
    const keys = Object.keys(out);
    const proto = out.protocol as { version?: unknown; contentHash?: unknown; url?: unknown } | undefined;
    const presentOk = out.agentId === 'test-agent-123' && out.uuid === 'uuid-1' && out.identityType === 'hatcher' && out.mode === 'avatar' && out.targetNpcId === null && out.name === 'TestBot' && out.species === 'hatcher_1' && out.color === 0xff0000 && out.cognitionBackend === 'hatcher-proxy' && out.proxyUrl === 'https://api.hatcher.host' && out.walletAddress === 'SoLPubKey1111111111111111111111111111111111' && out.userId === 'user-id-1' && out.sessionExpiresAt instanceof Date && !!proto && typeof proto.version === 'number' && typeof proto.contentHash === 'string' && (proto.contentHash as string).startsWith('sha256:') && proto.url === '/api/skills/protocol/skill.md';
    const tokenKeys = ['proxyTokenEnc', 'proxyTokenIv', 'proxyTokenTag', 'scopedToken', 'authToken'];
    const tokenKeyPresent = tokenKeys.some((k) => k in out);
    const serialized = JSON.stringify(out);
    const ciphertextLeaked = serialized.includes('ENC_CIPHERTEXT_SHOULD_NEVER_APPEAR') || serialized.includes('IV_SHOULD_NEVER_APPEAR') || serialized.includes('TAG_SHOULD_NEVER_APPEAR');
    if (tokenKeyPresent) bugs.push('publicAgentRecord() leaked a token column key in its output');
    if (ciphertextLeaked) bugs.push('publicAgentRecord() leaked encrypted-token ciphertext in its serialized output');
    check('C1 publicAgentRecord() strips hatcher: prefix + carries protocol pointer + OMITS all token fields', presentOk && !tokenKeyPresent && !ciphertextLeaked, `keys=${JSON.stringify(keys)}\nagentId=${out.agentId} protocol=${JSON.stringify(proto)}\ntokenKeyPresent=${tokenKeyPresent} ciphertextLeaked=${ciphertextLeaked}`);
  });

  await safe('C2 publicAgentRecord() protocol.contentHash matches the served manual hash (single source)', () => {
    const future = new Date(Date.now() + 3600_000);
    const row = { agentId: 'hatcher:abc', id: 'u', identityType: 'hatcher', mode: 'avatar', targetNpcId: null, name: null, species: null, color: null, cognitionBackend: 'hatcher-proxy', proxyUrl: 'https://api.hatcher.host', proxyTokenEnc: 'x', proxyTokenIv: 'x', proxyTokenTag: 'x', walletAddress: null, userId: null, sessionExpiresAt: future } as unknown as Parameters<typeof ph.publicAgentRecord>[0];
    const out = ph.publicAgentRecord(row) as { protocol: { contentHash: string; version: number } };
    const liveHash = contentHashOf(buildProtocolManual(resolveApiBase()));
    // Assert against the LIVE manual hash (whatever the shipping manual produces)
    // + that the record's version equals the SINGLE-SOURCE PROTOCOL_VERSION,
    // NOT a hardcoded stale literal (tracks the live version across bumps).
    const versionMatchesSource = out.protocol.version === PROTOCOL_VERSION;
    check('C2 publicAgentRecord() protocol.contentHash matches the served manual hash (single source)', out.protocol.contentHash === liveHash && versionMatchesSource, `record.protocol.contentHash=${out.protocol.contentHash}\nlive contentHashOf(buildProtocolManual)=${liveHash}\nversion=${out.protocol.version} (PROTOCOL_VERSION=${PROTOCOL_VERSION})`);
  });

  // NEW — C3: the Rule-E5 "agent plays AS ITSELF" binding, asserted on the
  // shaping function WITHOUT a DB write. A register that binds an identityKey
  // resolves a userId (resolveOrCreateUserByIdentity in the handler) and that
  // userId is what attributes CT + leaderboard credit. publicAgentRecord MUST
  // echo the bound userId back (so settlement/scoring bind to the agent's user),
  // and MUST do so even when the row is in OVERRIDE mode bound to an NPC body.
  await safe('C3 publicAgentRecord() carries the bound userId (CT/leaderboard settlement binds to the agent — Rule E5)', () => {
    const future = new Date(Date.now() + 3600_000);
    const boundRow = {
      agentId: 'hatcher:bound-agent', id: 'uuid-bound', identityType: 'hatcher', mode: 'override', targetNpcId: 'milady-miu',
      name: 'BoundBot', species: 'hatcher_2', color: 0x00ff00, cognitionBackend: 'hatcher-proxy', proxyUrl: 'https://api.hatcher.host',
      proxyTokenEnc: 'x', proxyTokenIv: 'x', proxyTokenTag: 'x',
      walletAddress: 'SoLAvatarWallet22222222222222222222222222222', userId: 'real-user-uuid-42', sessionExpiresAt: future,
    } as unknown as Parameters<typeof ph.publicAgentRecord>[0];
    const out = ph.publicAgentRecord(boundRow) as Record<string, unknown>;
    // userId present + echoed (the ledger anchor) and walletAddress present (the
    // avatar's real wallet) — the two facts that make agent play settle for real.
    const bindingOk = out.userId === 'real-user-uuid-42' && out.walletAddress === 'SoLAvatarWallet22222222222222222222222222222' && out.mode === 'override' && out.targetNpcId === 'milady-miu';
    check('C3 publicAgentRecord() carries the bound userId (CT/leaderboard settlement binds to the agent — Rule E5)', bindingOk, `userId=${out.userId} walletAddress=${out.walletAddress} mode=${out.mode} targetNpcId=${out.targetNpcId} (a bound agent must echo its ledger userId + avatar wallet so it plays AS ITSELF, not as a guest)`);
  });

  // ===================================================================
  // CASE D — Hatcher [ACTION:] whitelist executor (in-memory sim, NO DB)
  // ===================================================================
  const simMod = await import('../../src/services/npc-simulation.ts');
  const { npcSimulation, startSimulation, stopSimulation } = simMod;
  const shared = await import('@clawville/shared');
  const { NPC_IDS, NPC_BUILDING_CENTERS, MAP_LOCATIONS } = shared;

  startSimulation(false);

  const overrideNpcId = NPC_IDS[0];
  const buildingIds = Object.keys(NPC_BUILDING_CENTERS);
  const testBuildingId = buildingIds.includes('messaging-channels') ? 'messaging-channels' : buildingIds[0];

  // Compute the expected Cove center the SAME way the executor does (MAP_LOCATIONS
  // 'cove' rect → center) so the enter_cove happy-path test is grounded, not
  // hardcoded.
  const coveLoc = MAP_LOCATIONS.find((l: { id: string }) => l.id === 'cove') as
    | { id: string; positionX: number; positionY: number; width: number; height: number }
    | undefined;

  class MockOpenClawClient {
    getProtocol() { return 'hatcher-proxy' as const; }
    setWorldStateProvider() {}
    setSystemContextProvider() {}
  }

  // A registered OVERRIDE session — this is BOTH the executor body for D-cases AND
  // a live, resolvable agent session reused by case I (cove tools.json / POST :tool).
  //
  // FIXTURE-PARITY FIX (2026-06-04): the override config now mirrors EXACTLY what a
  // real Hatcher-SIGNED register produces (partner-hatcher.ts:545/551 override branch
  // and :571/572 avatar branch): `ledgerCapable: true` + `boundUserId: row.userId`.
  // A real Hatcher agent IS ledger-capable (E5 parity holds) — see the long note on
  // case I below — so the fixture session must carry the same two flags or
  // resolveAgentSession (require-auth-or-agent.ts:219-233) would correctly DEMOTE it
  // to non-ledger and the cove getSubject would 403. The agentId/boundUserId/avatar
  // are wired through the DB-lookup stubs installed just before case I so the shipped
  // DB-row liveness gate (validateLiveAgentSession) resolves this session the SAME way
  // it resolves a persisted Hatcher row — WITHOUT any real DB connection or write.
  const SELFTEST_SESSION = 'selftest-session-d';
  // The synthetic bound identity for the fixture session: a real Hatcher register
  // resolves `row.userId` from `data.identityKey` (resolveOrCreateUserByIdentity,
  // partner-hatcher.ts:386-394) and that userId is the CT/leaderboard ledger anchor.
  // We mint a fixed UUID here and thread it through (a) the in-memory `boundUserId`
  // config flag and (b) the openclaw_bots + avatars DB-lookup stubs, so the whole
  // E5 binding chain (session → bound userId → active avatar → real-CT subject) is
  // exercised end to end with NO DB write.
  const SELFTEST_USER_ID = '00000000-0000-4000-8000-00000000d00d';
  const SELFTEST_AVATAR_ID = '00000000-0000-4000-8000-00000000ava7';
  const overrideConfig = { agentId: 'hatcher:selftest-d', sessionId: SELFTEST_SESSION, sessionKey: SELFTEST_SESSION, gatewayUrl: 'http://localhost:0', authToken: '', protocol: 'hatcher-proxy', mode: 'override', autonomyMode: 'server-managed', targetNpcId: overrideNpcId, ledgerCapable: true, boundUserId: SELFTEST_USER_ID } as unknown as Parameters<typeof npcSimulation.registerOpenClaw>[0];
  npcSimulation.registerOpenClaw(overrideConfig, new MockOpenClawClient() as never);

  // Helper: count agent_chat events currently in the snapshot whose message matches.
  function countAgentChatEvents(messageSubstring: string): number {
    const snap = npcSimulation.getSnapshot();
    return snap.events.filter(
      (e: { type: string; data?: { message?: string } }) =>
        e.type === 'agent_chat' && typeof e.data?.message === 'string' && e.data.message.includes(messageSubstring),
    ).length;
  }

  await safe('D1 move(x,y) sets a path via findPath', () => {
    const npc = npcSimulation.getNpcById(overrideNpcId)!;
    const beforePathLen = npc.path.length;
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, 'On my way. [ACTION: move(x=5760, y=5760)]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    check('D1 move(x,y) sets a path via findPath', after.path.length > 0 && after.activity === 'walking' && !cleaned.includes('[ACTION:'), `before path.len=${beforePathLen} after path.len=${after.path.length} activity=${after.activity}\ncleaned speech=${JSON.stringify(cleaned)}`);
  });

  await safe('D2 emote(name=wave) sets activity+emoji from HATCHER_EMOTE_MAP', () => {
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, 'Hi! [ACTION: emote(name=wave)]');
    const npc = npcSimulation.getNpcById(overrideNpcId)!;
    check('D2 emote(name=wave) sets activity+emoji from HATCHER_EMOTE_MAP', npc.activity === 'socializing' && npc.activityEmoji === '\u{1F44B}' && cleaned === 'Hi!', `activity=${npc.activity} emoji=${npc.activityEmoji} cleaned=${JSON.stringify(cleaned)} (expect socializing/wave-emoji/'Hi!')`);
  });

  await safe('D3 enter_building(buildingId) walks toward a whitelisted building', () => {
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, `Heading in. [ACTION: enter_building(buildingId=${testBuildingId})]`);
    const npc = npcSimulation.getNpcById(overrideNpcId)!;
    check('D3 enter_building(buildingId) walks toward a whitelisted building', npc.path.length > 0 && npc.destinationBuildingId === testBuildingId && !cleaned.includes('[ACTION:'), `path.len=${npc.path.length} destinationBuildingId=${npc.destinationBuildingId} (expect ${testBuildingId})\ncleaned=${JSON.stringify(cleaned)}`);
  });

  // FIXED (was a false-pass): D4 now OBSERVES the visible effect of talk_to_npc.
  // injectAgentChat pushes an {type:'agent_chat', data:{message}} event onto the
  // sim's pendingEvents (snapshot-readable). A silently-dropped valid verb would
  // produce ZERO such event — the old "tag stripped == dispatched" inference was
  // invalid. We assert the event count goes UP by exactly one with our message.
  await safe('D4 talk_to_npc(npcId,message) actually injects an agent_chat event (observed, not inferred)', () => {
    const targetNpc = NPC_IDS[1];
    const uniqueMsg = `d4-positive-${Date.now()}`;
    const before = countAgentChatEvents(uniqueMsg);
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, `[ACTION: talk_to_npc(npcId=${targetNpc}, message=${uniqueMsg})]`);
    const after = countAgentChatEvents(uniqueMsg);
    const ok = after === before + 1 && !cleaned.includes('[ACTION:');
    if (!ok && after === before) bugs.push('talk_to_npc valid verb produced NO agent_chat event — silently no-op (parity defect)');
    check('D4 talk_to_npc(npcId,message) actually injects an agent_chat event (observed, not inferred)', ok, `agent_chat events with "${uniqueMsg}": before=${before} after=${after} (expect +1) cleaned=${JSON.stringify(cleaned)} target=${targetNpc}`);
  });

  await safe('D5 unknown verb is DROPPED (no state change) and stripped', () => {
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, 'Doing something weird. [ACTION: selfdestruct(target=world)]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    check('D5 unknown verb is DROPPED (no state change) and stripped', after.activity === 'idle' && cleaned === 'Doing something weird.' && !cleaned.includes('selfdestruct'), `activity stayed=${after.activity} cleaned=${JSON.stringify(cleaned)} (unknown verb must not execute, tag stripped)`);
  });

  await safe('D6 prototype-pollution emote(name=constructor) is DROPPED (Object.hasOwn guard)', () => {
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, '[ACTION: emote(name=constructor)]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    const ok = after.activity === 'idle' && cleaned === '';
    if (!ok) bugs.push('emote prototype-key (constructor) was NOT dropped — prototype-pollution guard failing');
    check('D6 prototype-pollution emote(name=constructor) is DROPPED (Object.hasOwn guard)', ok, `activity after=${after.activity} (expect idle) cleaned=${JSON.stringify(cleaned)}`);
  });

  await safe('D6b prototype-pollution enter_building(buildingId=__proto__) is DROPPED', () => {
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const npcBefore = npcSimulation.getNpcById(overrideNpcId)!;
    const destBefore = npcBefore.destinationBuildingId;
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, '[ACTION: enter_building(buildingId=__proto__)]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    const ok = after.destinationBuildingId === destBefore && cleaned === '';
    if (!ok) bugs.push('enter_building prototype-key (__proto__) was NOT dropped');
    check('D6b prototype-pollution enter_building(buildingId=__proto__) is DROPPED', ok, `destinationBuildingId after=${after.destinationBuildingId} (unchanged=${destBefore}) cleaned=${JSON.stringify(cleaned)}`);
  });

  // FIXED (was a weak false-pass): D7 now asserts EXACTLY 4 distinct emotes were
  // EXECUTED (state-observed via the LAST-applied emoji), not merely that tags
  // were stripped. The cap stops execution at 4: with 6 DISTINCT emotes in order
  // [wave,dance,think,scan,work,celebrate], the 4th executed is 'scan'; 'work'
  // and 'celebrate' (5th,6th) are NEVER applied. We assert the resulting emoji is
  // 'scan's emoji and is NOT 'work'/'celebrate's — proving execution stopped at 4.
  await safe('D7 action cap=4 — EXACTLY 4 executed (5th/6th never applied to state)', async () => {
    const emoteMod = await import('../../src/services/npc-simulation.ts');
    // Pull the emote map indirectly by emitting single emotes and reading state
    // (the map is module-private). Determine the emoji for the 4th vs 6th verb.
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    npcSimulation.dispatchHatcherActions(overrideNpcId, '[ACTION: emote(name=scan)]');
    const scanEmoji = npcSimulation.getNpcById(overrideNpcId)!.activityEmoji;
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    npcSimulation.dispatchHatcherActions(overrideNpcId, '[ACTION: emote(name=celebrate)]');
    const celebrateEmoji = npcSimulation.getNpcById(overrideNpcId)!.activityEmoji;
    void emoteMod;
    // Now the real cap test: 6 distinct emotes; only first 4 should execute.
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const reply = '[ACTION: emote(name=wave)][ACTION: emote(name=dance)][ACTION: emote(name=think)][ACTION: emote(name=scan)][ACTION: emote(name=work)][ACTION: emote(name=celebrate)] done';
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, reply);
    const finalEmoji = npcSimulation.getNpcById(overrideNpcId)!.activityEmoji;
    // Final emoji must be the 4th executed (scan) — NOT the 6th (celebrate).
    const executedFour = finalEmoji === scanEmoji && finalEmoji !== celebrateEmoji && scanEmoji !== celebrateEmoji;
    const strippedAll = cleaned === 'done' && !cleaned.includes('[ACTION:');
    if (!executedFour) bugs.push(`action cap not enforced at 4: finalEmoji=${finalEmoji} expected 4th(scan)=${scanEmoji} not 6th(celebrate)=${celebrateEmoji}`);
    check('D7 action cap=4 — EXACTLY 4 executed (5th/6th never applied to state)', executedFour && strippedAll, `4th(scan) emoji=${scanEmoji} 6th(celebrate) emoji=${celebrateEmoji} finalEmojiAfter6Tags=${finalEmoji} (final == 4th, != 6th => exactly 4 executed) cleaned=${JSON.stringify(cleaned)}`);
  });

  await safe('D8 over-length reply (50 tags) bounded by cap, never throws, all stripped', () => {
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const many = Array.from({ length: 50 }, () => '[ACTION: emote(name=wave)]').join(' ') + ' tail';
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, many);
    check('D8 over-length reply (50 tags) bounded by cap, never throws, all stripped', cleaned === 'tail' && !cleaned.includes('[ACTION:'), `input had 50 tags; cleaned=${JSON.stringify(cleaned)} (no throw, all tags stripped, only first 4 executed)`);
  });

  await safe('D9 out-of-bounds move params are DROPPED', () => {
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const npc = npcSimulation.getNpcById(overrideNpcId)!; npc.path = []; npc.pathIndex = 0;
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, '[ACTION: move(x=10, y=99999)]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    check('D9 out-of-bounds move params are DROPPED', after.path.length === 0 && cleaned === '', `path.len after=${after.path.length} (expect 0 — out-of-bounds dropped) cleaned=${JSON.stringify(cleaned)}`);
  });

  await safe('D9b non-finite move params (x=abc) are DROPPED', () => {
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const npc = npcSimulation.getNpcById(overrideNpcId)!; npc.path = []; npc.pathIndex = 0;
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, '[ACTION: move(x=abc, y=200)]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    check('D9b non-finite move params (x=abc) are DROPPED', after.path.length === 0 && cleaned === '', `path.len after=${after.path.length} (expect 0 — Number.isFinite guard) cleaned=${JSON.stringify(cleaned)}`);
  });

  // FIXED: D10 now OBSERVES that an unknown talk_to_npc target produces NO
  // agent_chat event (the negative twin of D4's positive observation).
  await safe('D10 talk_to_npc with unknown target is DROPPED (no agent_chat event)', () => {
    const uniqueMsg = `d10-negative-${Date.now()}`;
    const before = countAgentChatEvents(uniqueMsg);
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, `[ACTION: talk_to_npc(npcId=no-such-npc-xyz, message=${uniqueMsg})]`);
    const after = countAgentChatEvents(uniqueMsg);
    check('D10 talk_to_npc with unknown target is DROPPED (no agent_chat event)', after === before && cleaned === '' && !cleaned.includes('[ACTION:'), `agent_chat events with "${uniqueMsg}": before=${before} after=${after} (expect unchanged) cleaned=${JSON.stringify(cleaned)}`);
  });

  // INVERTED from the old false-pass: D11 is now the enter_cove HAPPY PATH against
  // the SHIPPING 5-verb whitelist. The shipping executor (npc-simulation.ts:942)
  // walks the body to COVE_CENTER, tags destinationBuildingId='cove', and sets
  // activity 'trading' with the 🎰 emoji. This is the Rule-E5 Cove gateway verb.
  await safe('D11 enter_cove() HAPPY PATH — walks to the Cove, tags dest=cove, activity=trading 🎰 (shipping 5-verb whitelist)', () => {
    if (!coveLoc) throw new Error("MAP_LOCATIONS has no 'cove' rect — enter_cove cannot resolve a center (would no-op)");
    npcSimulation.setNpcActivity(overrideNpcId, 'idle', '');
    const npc0 = npcSimulation.getNpcById(overrideNpcId)!; npc0.path = []; npc0.pathIndex = 0; npc0.destinationBuildingId = null;
    const cleaned = npcSimulation.dispatchHatcherActions(overrideNpcId, 'To the casino [ACTION: enter_cove()]');
    const after = npcSimulation.getNpcById(overrideNpcId)!;
    const ok =
      after.path.length > 0 &&
      after.destinationBuildingId === 'cove' &&
      after.activity === 'trading' &&
      after.activityEmoji === '\u{1F3B0}' && // 🎰
      cleaned === 'To the casino' &&
      !cleaned.includes('[ACTION:');
    if (!ok) bugs.push('enter_cove() did NOT execute the shipping behavior (walk to cove + dest=cove + trading/🎰) — Rule-E5 Cove gateway broken');
    check('D11 enter_cove() HAPPY PATH — walks to the Cove, tags dest=cove, activity=trading 🎰 (shipping 5-verb whitelist)', ok, `path.len=${after.path.length} (expect >0) destinationBuildingId=${after.destinationBuildingId} (expect 'cove') activity=${after.activity} (expect 'trading') emoji=${after.activityEmoji} (expect 🎰) cleaned=${JSON.stringify(cleaned)}`);
  });

  // ===================================================================
  // CASE E — buildHatcherWorldState public-only (NO secrets)
  // ===================================================================
  await safe('E1 buildHatcherWorldState returns documented public fields, NO secret/token field', () => {
    const ws = npcSimulation.buildHatcherWorldState(overrideNpcId, 'override');
    if (!ws) throw new Error('buildHatcherWorldState returned null for an in-world npc');
    const serialized = JSON.stringify(ws);
    const SECRET_RE = /token|secret|scopedToken|wallet[_-]?secret|sessionId|session_id|userId|user_id|privateKey|secretKey|dek|cipher|bearer|authorization/i;
    const leaked = SECRET_RE.test(serialized);
    const shapeOk = ws.self && typeof ws.self.name === 'string' && ws.self.mode === 'override' && typeof ws.self.x === 'number' && typeof ws.self.y === 'number' && typeof ws.self.hp === 'number' && typeof ws.self.activity === 'string' && Array.isArray(ws.nearbyPlayers) && Array.isArray(ws.nearbyNpcs) && Array.isArray(ws.nearbyBuildings) && typeof ws.gameMode === 'string';
    const playersClean = ws.nearbyPlayers.every((p) => Object.keys(p).sort().join(',') === 'distance,name');
    const npcsClean = ws.nearbyNpcs.every((n) => Object.keys(n).sort().join(',') === 'distance,id,isAgent,name');
    const bldClean = ws.nearbyBuildings.every((b) => Object.keys(b).sort().join(',') === 'cryptoFocus,id,name');
    if (leaked) bugs.push('buildHatcherWorldState leaked a secret-pattern field');
    check('E1 buildHatcherWorldState returns documented public fields, NO secret/token field', shapeOk && !leaked && playersClean && npcsClean && bldClean, `shapeOk=${shapeOk} leaked=${leaked} playersClean=${playersClean} npcsClean=${npcsClean} bldClean=${bldClean}\nself=${JSON.stringify(ws.self)} nearbyBuildings[0]=${JSON.stringify(ws.nearbyBuildings[0])}`);
  });

  await safe('E2 buildHatcherWorldState returns null for an unknown npcId', () => {
    const ws = npcSimulation.buildHatcherWorldState('no-such-npc-zzz', 'avatar');
    check('E2 buildHatcherWorldState returns null for an unknown npcId', ws === null, `buildHatcherWorldState(unknown) => ${ws === null ? 'null' : JSON.stringify(ws)} (expect null)`);
  });

  // ===================================================================
  // CASE F — Outbound cognition signing + chatHatcherProxy fail-soft
  // ===================================================================
  const issuer = await import('../../src/services/service-issuer.ts');
  const { signPayload } = issuer;

  await safe('F1 signPayload produces a partner-verifiable ed25519 signature over canonical JSON', () => {
    const body = { model: 'hatcher:bot1', messages: [{ role: 'user', content: 'hello' }], max_tokens: 500, temperature: 0.8, clawville: { playerMessage: 'hello', orientation: { version: PROTOCOL_VERSION, url: '/api/skills/protocol/skill.md' } } };
    const signed = signPayload(body);
    const digest = createHash('sha256').update(signed.body).digest();
    const valid = nacl.sign.detached.verify(new Uint8Array(digest), bs58.decode(signed.signature), bs58.decode(signed.pubkey));
    const pubkeyMatches = signed.pubkey === process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY;
    check('F1 signPayload produces a partner-verifiable ed25519 signature over canonical JSON', valid === true && pubkeyMatches, `nacl.sign.detached.verify(sha256(body), sig, pubkey) => ${valid}\npubkey matches env issuer pubkey: ${pubkeyMatches}\nbody=${signed.body.slice(0, 120)}...`);
  });

  await safe('F2 signPayload canonical JSON is deterministic + key-sorted regardless of input order (OUTBOUND canonicalizes — the trap twin of A8)', () => {
    const a = signPayload({ b: 2, a: 1, nested: { y: 1, x: 2 } });
    const b = signPayload({ nested: { x: 2, y: 1 }, a: 1, b: 2 });
    const canonicalOk = a.body === '{"a":1,"b":2,"nested":{"x":2,"y":1}}';
    check('F2 signPayload canonical JSON is deterministic + key-sorted regardless of input order (OUTBOUND canonicalizes — the trap twin of A8)', a.body === b.body && a.signature === b.signature && canonicalOk, `bodyA=${a.body}\nbodyB=${b.body}\nsame body=${a.body === b.body} same sig=${a.signature === b.signature} (OUTBOUND signs canonical; INBOUND (A8) signs raw bytes — asymmetric by design)`);
  });

  await safe('F3 signPayload throws when CLAWVILLE_SERVICE_ISSUER_SK is missing', () => {
    const saved = process.env.CLAWVILLE_SERVICE_ISSUER_SK;
    delete process.env.CLAWVILLE_SERVICE_ISSUER_SK;
    let threw = false;
    try { signPayload({ x: 1 }); } catch { threw = true; } finally { process.env.CLAWVILLE_SERVICE_ISSUER_SK = saved; }
    check('F3 signPayload throws when CLAWVILLE_SERVICE_ISSUER_SK is missing', threw, `signPayload() with no SK env threw=${threw} (expect true)`);
  });

  const ocMod = await import('../../src/services/openclaw-client.ts');
  const { OpenClawClient } = ocMod;

  await safe('F4 chatHatcherProxy FAILS SOFT on network throw (returns empty, no throw, no token leak)', async () => {
    const SCOPED = 'super-secret-scoped-token-DO-NOT-LOG';
    const client = new OpenClawClient({ sessionId: 's-f4', sessionKey: 's-f4', gatewayUrl: 'http://localhost:0', authToken: '', agentId: 'hatcher:f4', proxyAgentId: 'f4', protocol: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: SCOPED } as never);
    client.setWorldStateProvider(() => null);
    const origFetch = globalThis.fetch; const origErr = console.error; const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    // @ts-expect-error override for test
    globalThis.fetch = async () => { throw new Error('Network error (stubbed)'); };
    let reply: string; let threw = false;
    try { reply = await client.chat([{ role: 'user', content: 'speak' }]); } catch { threw = true; reply = '<<THREW>>'; } finally { globalThis.fetch = origFetch; console.error = origErr; }
    const tokenLeaked = logged.some((l) => l.includes(SCOPED));
    if (tokenLeaked) bugs.push('chatHatcherProxy logged the scoped token on failure');
    check('F4 chatHatcherProxy FAILS SOFT on network throw (returns empty, no throw, no token leak)', threw === false && reply === '' && !tokenLeaked, `threw=${threw} reply=${JSON.stringify(reply)} tokenLeaked=${tokenLeaked}\nlogs=${JSON.stringify(logged)}`);
  });

  await safe('F5 chatHatcherProxy FAILS SOFT on non-2xx response', async () => {
    const client = new OpenClawClient({ sessionId: 's-f5', sessionKey: 's-f5', gatewayUrl: 'http://localhost:0', authToken: '', agentId: 'hatcher:f5', proxyAgentId: 'f5', protocol: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok' } as never);
    client.setWorldStateProvider(() => null);
    const origFetch = globalThis.fetch;
    // @ts-expect-error override for test
    globalThis.fetch = async () => new Response('server error', { status: 500, statusText: 'Internal Server Error' });
    let reply = ''; let threw = false;
    try { reply = await client.chat([{ role: 'user', content: 'hi' }]); } catch { threw = true; } finally { globalThis.fetch = origFetch; }
    check('F5 chatHatcherProxy FAILS SOFT on non-2xx response', threw === false && reply === '', `threw=${threw} reply=${JSON.stringify(reply)} (500 -> expect '')`);
  });

  await safe('F6 chatHatcherProxy FAILS SOFT on 3xx redirect (refuses to follow)', async () => {
    const client = new OpenClawClient({ sessionId: 's-f6', sessionKey: 's-f6', gatewayUrl: 'http://localhost:0', authToken: '', agentId: 'hatcher:f6', proxyAgentId: 'f6', protocol: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok' } as never);
    client.setWorldStateProvider(() => null);
    const origFetch = globalThis.fetch;
    // @ts-expect-error override for test
    globalThis.fetch = async () => new Response(null, { status: 301, headers: { location: 'https://169.254.169.254/' } });
    let reply = ''; let threw = false;
    try { reply = await client.chat([{ role: 'user', content: 'hi' }]); } catch { threw = true; } finally { globalThis.fetch = origFetch; }
    check('F6 chatHatcherProxy FAILS SOFT on 3xx redirect (refuses to follow)', threw === false && reply === '', `threw=${threw} reply=${JSON.stringify(reply)} (301 -> expect '', no SSRF follow)`);
  });

  await safe('F7 chatHatcherProxy reply cap = 4000 chars (DoS guard before [ACTION:] parser)', async () => {
    const client = new OpenClawClient({ sessionId: 's-f7', sessionKey: 's-f7', gatewayUrl: 'http://localhost:0', authToken: '', agentId: 'hatcher:f7', proxyAgentId: 'f7', protocol: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok' } as never);
    client.setWorldStateProvider(() => null);
    const huge = 'x'.repeat(5000); const origFetch = globalThis.fetch;
    // @ts-expect-error override for test
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: huge } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    let reply = '';
    try { reply = await client.chat([{ role: 'user', content: 'hi' }]); } finally { globalThis.fetch = origFetch; }
    check('F7 chatHatcherProxy reply cap = 4000 chars (DoS guard before [ACTION:] parser)', reply.length === 4000, `proxy returned 5000 chars; client truncated to length=${reply.length} (expect 4000)`);
  });

  await safe('F8 chatHatcherProxy FAILS SOFT on SSRF-rejected proxy URL (non-https)', async () => {
    const client = new OpenClawClient({ sessionId: 's-f8', sessionKey: 's-f8', gatewayUrl: 'http://localhost:0', authToken: '', agentId: 'hatcher:f8', proxyAgentId: 'f8', protocol: 'hatcher-proxy', proxyBaseUrl: 'http://api.hatcher.host', scopedToken: 'tok' } as never);
    client.setWorldStateProvider(() => null);
    let fetchCalled = false; const origFetch = globalThis.fetch;
    // @ts-expect-error override for test
    globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
    let reply = '';
    try { reply = await client.chat([{ role: 'user', content: 'hi' }]); } finally { globalThis.fetch = origFetch; }
    check('F8 chatHatcherProxy FAILS SOFT on SSRF-rejected proxy URL (non-https)', reply === '' && fetchCalled === false, `reply=${JSON.stringify(reply)} fetchCalled=${fetchCalled} (http:// proxy -> SSRF reject, no outbound fetch)`);
  });

  const hc = await import('../../src/services/hatcher-config.ts');
  const { validateHatcherProxyUrl, validateHatcherProxyUrlResolved } = hc;

  await safe('F9 SSRF rejects private/link-local/loopback IP literals + non-https; allows allowlisted https', () => {
    const cases: Array<[string, boolean, string?]> = [['https://169.254.169.254', false, 'private_ip'], ['https://192.168.1.1', false, 'private_ip'], ['https://127.0.0.1', false, 'private_ip'], ['https://[::1]', false, 'private_ip'], ['http://api.hatcher.host', false, 'not_https'], ['https://api.hatcher.host', true], ['https://proxy.hatcher.host', true], ['https://evil.example.com', false, 'host_not_allowlisted'], ['https://user:pass@api.hatcher.host', false, 'credentials_in_url']];
    const lines: string[] = []; let allOk = true;
    for (const [url, expectOk, expectReason] of cases) {
      const r = validateHatcherProxyUrl(url);
      const okMatch = r.ok === expectOk;
      const reasonMatch = expectOk ? true : !expectReason || (r as { reason: string }).reason === expectReason;
      const pass = okMatch && reasonMatch; if (!pass) allOk = false;
      lines.push(`${pass ? 'ok' : 'XX'} ${url} => ${JSON.stringify(r)} (expect ok=${expectOk}${expectReason ? ` reason=${expectReason}` : ''})`);
    }
    check('F9 SSRF rejects private/link-local/loopback IP literals + non-https; allows allowlisted https', allOk, lines.join('\n'));
  });

  await safe('F10 DNS-aware SSRF rejects an allowlisted host that resolves to a private IP (localhost)', async () => {
    const saved = process.env.HATCHER_PROXY_ALLOWED_HOSTS;
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = 'localhost';
    const r = await validateHatcherProxyUrlResolved('https://localhost');
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = saved;
    check('F10 DNS-aware SSRF rejects an allowlisted host that resolves to a private IP (localhost)', r.ok === false && (r as { reason: string }).reason === 'resolves_to_private_ip', `validateHatcherProxyUrlResolved('https://localhost', allow=localhost) => ${JSON.stringify(r)} (expect resolves_to_private_ip)`);
  });

  // ===================================================================
  // CASE G — Protocol single-source content-hash invariant @ v2
  // ===================================================================
  await safe('G1 protocolPointer().contentHash === contentHashOf(buildProtocolManual()) ; version === PROTOCOL_VERSION (single source)', () => {
    const apiBase = resolveApiBase();
    const manual = buildProtocolManual(apiBase);
    const hash1 = contentHashOf(manual);
    const ptr = protocolPointer(apiBase);
    const hashMatch = ptr.contentHash === hash1 && ptr.contentHash === protocolContentHash(apiBase);
    const versionMatchesSource = ptr.version === PROTOCOL_VERSION;
    const urlOk = ptr.url === '/api/skills/protocol/skill.md';
    if (!hashMatch) bugs.push('protocol contentHash mismatch across single-source surfaces');
    check('G1 protocolPointer().contentHash === contentHashOf(buildProtocolManual()) ; version === PROTOCOL_VERSION (single source)', hashMatch && versionMatchesSource && urlOk, `pointer.contentHash=${ptr.contentHash}\ncontentHashOf(manual)=${hash1}\nprotocolContentHash()=${protocolContentHash(apiBase)}\nversion=${ptr.version} (PROTOCOL_VERSION=${PROTOCOL_VERSION}) url=${ptr.url}`);
  });

  await safe('G2 buildProtocolManual is deterministic for a fixed apiBase', () => {
    const apiBase = resolveApiBase();
    const h1 = contentHashOf(buildProtocolManual(apiBase));
    const h2 = contentHashOf(buildProtocolManual(apiBase));
    check('G2 buildProtocolManual is deterministic for a fixed apiBase', h1 === h2, `hash run1=${h1}\nhash run2=${h2} (must be byte-identical — no randomness/LLM in builder)`);
  });

  // NEW — G3: the served manual must DOCUMENT the enter_cove gateway verb + the
  // Cove play flow. The whitelist-parity rule (CLAUDE.md MANDATORY) says the
  // manual a connected agent is TOLD it can do must match what the server
  // enforces. We hash/inspect the ACTUAL served body (tracking the live version).
  await safe('G3 served manual DOCUMENTS [ACTION: enter_cove()] + the Cove blackjack play flow', () => {
    const manual = buildProtocolManual(resolveApiBase());
    const documentsEnterCove = manual.includes('[ACTION: enter_cove()]');
    const documentsCovePlay = /cove_blackjack_open_session|cove\/blackjack\/tools\.json/.test(manual);
    const versionLine = manual.includes(`version: ${PROTOCOL_VERSION}`) || manual.includes(`protocol_version: ${PROTOCOL_VERSION}`);
    if (!documentsEnterCove) bugs.push('manual does NOT document [ACTION: enter_cove()] — whitelist/manual parity broken (agent never learns the shipping verb)');
    check('G3 served manual DOCUMENTS [ACTION: enter_cove()] + the Cove blackjack play flow', documentsEnterCove && documentsCovePlay && versionLine, `documents enter_cove=${documentsEnterCove} documents cove-play tools=${documentsCovePlay} version-line(v${PROTOCOL_VERSION})=${versionLine}`);
  });

  // NEW — G4: EXECUTOR ↔ MANUAL whitelist-parity. The set of verbs the server
  // executor ACCEPTS must equal the set the protocol manual DOCUMENTS — the exact
  // same-diff whitelist-parity rule. We probe the executor at runtime for each
  // candidate verb (does it have an effect / not log "not in whitelist"?) and
  // cross-check against the manual text. A drift like "manual lists enter_cove
  // but executor dropped it" (the v1/v2 skew the previous harness missed) fails.
  await safe('G4 EXECUTOR verb-set === MANUAL verb-set (whitelist-parity, the same-diff MANDATORY rule)', () => {
    const manual = buildProtocolManual(resolveApiBase());
    // The 5 verbs the shipping executor implements (npc-simulation.ts switch).
    const EXPECTED_EXECUTOR_VERBS = ['move', 'emote', 'enter_building', 'enter_cove', 'talk_to_npc'];

    // Probe the executor: capture console.warn to detect "not in whitelist".
    const origWarn = console.warn;
    function executorAccepts(verb: string, sampleTag: string): boolean {
      const warns: string[] = [];
      console.warn = (...a: unknown[]) => { warns.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
      try {
        npcSimulation.dispatchHatcherActions(overrideNpcId, sampleTag);
      } finally {
        console.warn = origWarn;
      }
      // An ACCEPTED verb never logs the default-branch "not in whitelist" message.
      return !warns.some((w) => w.includes('not in whitelist'));
    }
    const samples: Record<string, string> = {
      move: '[ACTION: move(x=5760, y=5760)]',
      emote: '[ACTION: emote(name=wave)]',
      enter_building: `[ACTION: enter_building(buildingId=${testBuildingId})]`,
      enter_cove: '[ACTION: enter_cove()]',
      talk_to_npc: `[ACTION: talk_to_npc(npcId=${NPC_IDS[1]}, message=parity-probe)]`,
    };
    const executorSet = EXPECTED_EXECUTOR_VERBS.filter((v) => executorAccepts(v, samples[v]));
    // A verb that should NOT exist must be rejected (negative control).
    const bogusRejected = !executorAccepts('selfdestruct', '[ACTION: selfdestruct(x=1)]');

    // Manual-documented verbs: enter_cove is an [ACTION:] tag; the world verbs
    // (move/emote/enter_building/talk_to_npc) are documented via the world-verb
    // [ACTION: name()] mechanism (manual line ~162) + their REST twins. We assert
    // the manual at minimum documents enter_cove as an action tag AND references
    // the action-tag world-verb mechanism, so an agent learns the shipping verb.
    const manualDocsEnterCove = manual.includes('[ACTION: enter_cove()]');
    const manualDocsActionMechanism = manual.includes('[ACTION:');

    const executorMatchesExpected =
      executorSet.length === EXPECTED_EXECUTOR_VERBS.length &&
      EXPECTED_EXECUTOR_VERBS.every((v) => executorSet.includes(v));
    const enterCoveParity = executorSet.includes('enter_cove') && manualDocsEnterCove;

    const ok = executorMatchesExpected && bogusRejected && enterCoveParity && manualDocsActionMechanism;
    if (!ok) bugs.push(`whitelist-parity FAIL: executorSet=[${executorSet.join(',')}] expected=[${EXPECTED_EXECUTOR_VERBS.join(',')}] manualDocsEnterCove=${manualDocsEnterCove}`);
    check('G4 EXECUTOR verb-set === MANUAL verb-set (whitelist-parity, the same-diff MANDATORY rule)', ok, `executor accepts=[${executorSet.join(',')}] (expect all 5) bogusRejected=${bogusRejected} manual docs enter_cove=${manualDocsEnterCove} manual uses [ACTION:]=${manualDocsActionMechanism} enterCoveParity=${enterCoveParity}`);
  });

  // ===================================================================
  // CASE H — HTTP gates via Hono app.request (NO DB writes)
  // ===================================================================
  const app = new Hono();
  app.route('/api/partner/hatcher', ph.partnerHatcherRoutes);

  await safe('H1 POST /agents with NO signature -> 401 (before persistence)', async () => {
    const res = await app.request('/api/partner/hatcher/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'x', cognition: { backend: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok12345' } }) });
    check('H1 POST /agents with NO signature -> 401 (before persistence)', res.status === 401, `status=${res.status} body=${JSON.stringify(await res.json())} (expect 401)`);
  });

  await safe('H2 POST /agents with BAD signature -> 401 (before persistence)', async () => {
    const body = JSON.stringify({ agentId: 'x', cognition: { backend: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok12345' } });
    // Valid fresh timestamp, but the write challenge is signed over a DIFFERENT
    // body, so the recomputed body hash differs => bad_signature => 401.
    const ts = String(Date.now());
    const badSig = signWriteChallenge('POST', '/api/partner/hatcher/agents', ts, '{"different":"body"}', partnerKp.secretKey);
    const res = await app.request('/api/partner/hatcher/agents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hatcher-Issuer-Pubkey': partnerPubB58, 'X-Hatcher-Signature': badSig, 'X-Hatcher-Timestamp': ts }, body });
    check('H2 POST /agents with BAD signature -> 401 (before persistence)', res.status === 401, `status=${res.status} body=${JSON.stringify(await res.json())} (expect 401)`);
  });

  await safe('H3 POST /agents with VALID signature but Zod-INVALID body -> 400 (stops before persistence)', async () => {
    const body = JSON.stringify({ notAgentId: 'oops', cognition: { backend: 'WRONG-BACKEND' } });
    const ts = String(Date.now());
    const sig = signWriteChallenge('POST', '/api/partner/hatcher/agents', ts, body, partnerKp.secretKey);
    const res = await app.request('/api/partner/hatcher/agents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hatcher-Issuer-Pubkey': partnerPubB58, 'X-Hatcher-Signature': sig, 'X-Hatcher-Timestamp': ts }, body });
    const j = (await res.json()) as { error?: string };
    check('H3 POST /agents with VALID signature but Zod-INVALID body -> 400 (stops before persistence)', res.status === 400 && j.error === 'Invalid request', `status=${res.status} body=${JSON.stringify(j)} (expect 400 Invalid request — Zod reject after auth, before DB)`);
  });

  await safe('H4 GET /agents/:id/stats with NO signature (partner-key-gated read) -> 401', async () => {
    const res = await app.request('/api/partner/hatcher/agents/selftest-agent-1/stats', { method: 'GET' });
    check('H4 GET /agents/:id/stats with NO signature (partner-key-gated read) -> 401', res.status === 401, `status=${res.status} body=${JSON.stringify(await res.json())} (expect 401 — partner-signed GET required)`);
  });

  await safe('H5 PATCH /agents/:id with NO signature -> 401', async () => {
    const res = await app.request('/api/partner/hatcher/agents/selftest-agent-1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'NewName' }) });
    check('H5 PATCH /agents/:id with NO signature -> 401', res.status === 401, `status=${res.status} body=${JSON.stringify(await res.json())} (expect 401)`);
  });

  // NEW — H6: a CORRECTLY-SIGNED PATCH is ACCEPTED past auth (auth-accept on a
  // mutating route, proven end-to-end). The mutating handlers run auth FIRST
  // (readSignedBody → 401 unauthorized on a bad/absent sig, BEFORE any DB call),
  // then proceed to the row-lookup. With a real signature the handler clears the
  // auth gate and reaches the DB read — which, against our dummy DATABASE_URL,
  // fails (no real Postgres). That downstream failure is itself the PROOF that
  // auth was ACCEPTED: a rejected request would have short-circuited to a clean
  // 401 `{error:'unauthorized'}` and never touched the DB. We therefore assert
  // the response is NOT the 401-unauthorized auth-reject. Crucially the lookup
  // is a READ that never returns a row, so NO mutation/tombstone is written —
  // the no-DB-writes invariant holds. (Versus H5, the no-sig twin: clean 401.)
  await safe('H6 PATCH /agents/:id with VALID signature -> auth-ACCEPTED (passes the 401 gate, reaches DB read; no write)', async () => {
    const body = JSON.stringify({ name: 'NewName' });
    const patchPath = '/api/partner/hatcher/agents/selftest-nonexistent-patch';
    const ts = String(Date.now());
    const sig = signWriteChallenge('PATCH', patchPath, ts, body, partnerKp.secretKey);
    const res = await app.request(patchPath, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Hatcher-Issuer-Pubkey': partnerPubB58, 'X-Hatcher-Signature': sig, 'X-Hatcher-Timestamp': ts }, body });
    const text = await res.text();
    let parsedErr: string | undefined;
    try { parsedErr = (JSON.parse(text) as { error?: string }).error; } catch { /* non-JSON DB-error 500 body */ }
    // Auth ACCEPTED iff this is NOT the clean 401 unauthorized reject. Reaching
    // the (un-mocked) DB read => signature cleared readSignedBody.
    const authAccepted = !(res.status === 401 && parsedErr === 'unauthorized');
    if (!authAccepted) bugs.push('PATCH with a valid partner signature was rejected as unauthorized — auth-accept broken on a mutating route');
    check('H6 PATCH /agents/:id with VALID signature -> auth-ACCEPTED (passes the 401 gate, reaches DB read; no write)', authAccepted, `status=${res.status} body=${text.slice(0, 160)} (auth-reject twin H5 = clean 401 unauthorized; a SIGNED PATCH must get PAST that — here it reached the un-mocked DB read, proving acceptance; no row returned => no mutation)`);
  });

  // NEW — H7: a CORRECTLY-SIGNED DELETE is ACCEPTED past auth. readSignedBody
  // calls JSON.parse on the raw bytes, so a DELETE must carry a signed JSON body
  // (we send signed '{}'). Same auth-accept proof as H6: a valid signature clears
  // the 401 gate and reaches the DB read (which fails on the dummy DB) — NOT the
  // clean 401-unauthorized of the no-sig twin (H8). No row is read/written.
  await safe('H7 DELETE /agents/:id with VALID signed body -> auth-ACCEPTED (passes the 401 gate, reaches DB read; no write)', async () => {
    const body = '{}';
    const deletePath = '/api/partner/hatcher/agents/selftest-nonexistent-delete';
    const ts = String(Date.now());
    const sig = signWriteChallenge('DELETE', deletePath, ts, body, partnerKp.secretKey);
    const res = await app.request(deletePath, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Hatcher-Issuer-Pubkey': partnerPubB58, 'X-Hatcher-Signature': sig, 'X-Hatcher-Timestamp': ts }, body });
    const text = await res.text();
    let parsedErr: string | undefined;
    try { parsedErr = (JSON.parse(text) as { error?: string }).error; } catch { /* non-JSON DB-error 500 body */ }
    const authAccepted = !(res.status === 401 && parsedErr === 'unauthorized');
    if (!authAccepted) bugs.push('DELETE with a valid signed body was rejected as unauthorized — auth-accept broken on the tombstone route');
    check('H7 DELETE /agents/:id with VALID signed body -> auth-ACCEPTED (passes the 401 gate, reaches DB read; no write)', authAccepted, `status=${res.status} body=${text.slice(0, 160)} (no-sig twin H8 = clean 401 unauthorized; a SIGNED DELETE must get PAST that — reached the un-mocked DB read, proving acceptance; no tombstone written)`);
  });

  await safe('H8 DELETE /agents/:id with NO signature -> 401', async () => {
    const res = await app.request('/api/partner/hatcher/agents/selftest-agent-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('H8 DELETE /agents/:id with NO signature -> 401', res.status === 401, `status=${res.status} body=${JSON.stringify(await res.json())} (expect 401)`);
  });

  // NEW (H-REPLAY): a write with a CORRECT signature over an EXPIRED timestamp is
  // rejected at the route with a clean 401 (stale_timestamp inside readSignedBody
  // => {ok:false} => 401 unauthorized), proving the +/- 5 min replay window is
  // enforced end-to-end through the HTTP gate, not just in the unit verifier. The
  // window check fires BEFORE the allowlist/sig/DB work, so this stops before
  // persistence. The signature itself is valid for the (expired) challenge, so the
  // ONLY thing rejecting it is the window: a captured-and-replayed real request
  // expires instead of being accepted forever.
  await safe('H-REPLAY POST /agents with a correctly-signed but EXPIRED timestamp -> 401 (replay window enforced at the route)', async () => {
    const body = JSON.stringify({ agentId: 'replay', cognition: { backend: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: 'tok-replay-1' } });
    const writePathH = '/api/partner/hatcher/agents';
    // Timestamp well outside the window in the past; sign the challenge for that
    // exact expired ts so the signature is otherwise valid.
    const expiredTs = String(Date.now() - (PARTNER_WRITE_SIGNATURE_WINDOW_MS + 60_000));
    const sig = signWriteChallenge('POST', writePathH, expiredTs, body, partnerKp.secretKey);
    const res = await app.request(writePathH, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hatcher-Issuer-Pubkey': partnerPubB58, 'X-Hatcher-Signature': sig, 'X-Hatcher-Timestamp': expiredTs }, body });
    const j = (await res.json()) as { error?: string };
    const ok = res.status === 401 && j.error === 'unauthorized';
    if (!ok) bugs.push('a correctly-signed write with an EXPIRED timestamp was NOT rejected at the route: replay window not enforced end-to-end through readSignedBody');
    check('H-REPLAY POST /agents with a correctly-signed but EXPIRED timestamp -> 401 (replay window enforced at the route)', ok, `status=${res.status} body=${JSON.stringify(j)} (expect 401 unauthorized: stale_timestamp rejected inside readSignedBody before any DB write); window=${PARTNER_WRITE_SIGNATURE_WINDOW_MS}ms`);
  });

  // ===================================================================
  // CASE I — Cove agent-tool money path (parity), NO DB writes
  // ===================================================================
  // The Rule-E5 Cove parity: an agent that walked in via enter_cove() PLAYS via
  // session-bound tools (GET/POST /api/agent/:sid/cove/blackjack/*) that bind to
  // its avatar's REAL ClawToken ledger through the cove route's getSubject. We
  // exercise: (1) the installable tools.json bundle shape (4 real-CT tools with
  // 5..500 bet bounds), (2) session-gating + prototype-pollution guard on POST
  // :tool, (3) the getSubject E5 contract end-to-end via the cove router itself
  // (agent-session → bound avatar OR explicit reject — NEVER a silent guest
  // demotion). All negative/early-return — no shoe is opened, no CT moves.
  //
  // ===================================================================
  // E5 PARITY VERDICT (2026-06-04, synthesizing the 7cff0bba auth model) — PARITY HOLDS
  // ===================================================================
  // QUESTION: does a real Hatcher-SIGNED agent (POST /api/partner/hatcher/agents)
  // resolve as `ledgerCapable === true` and settle REAL CT to its bound avatar?
  //
  // ANSWER: YES — the "first-contact non-ledger" rule (FOLLOW-UP #6) does NOT catch
  // the Hatcher path. Hatcher is its own ledger-capable surface:
  //   - partner-hatcher.ts:545/551 (override) + :571/572 (avatar) HARDCODE
  //     `ledgerCapable: true` + `boundUserId: row.userId ?? null` on the registered
  //     session config, BECAUSE the register route is reached only behind the ed25519
  //     partner-signed guard (cryptographically-proven ownership === the same trust
  //     basis as an owned-token /connect). It NEVER uses /connect's
  //     `existingBoundUserId === null` first-contact derivation (agent-gateway.ts:503).
  //   - resolveAgentSession (require-auth-or-agent.ts:219-233) keeps `ledgerCapable`
  //     true iff `config.boundUserId === live row.userId` (both non-null) — true for a
  //     Hatcher register that carried an identityKey.
  //   - cove getSubject (cove-blackjack.ts:271-284) then binds the agent to its real
  //     avatar and settles REAL CT.  => E5 parity HOLDS for the happy path.
  //
  // CONDITIONAL GAP (documented, NOT a code bug — fails CLOSED, never guest):
  //   (a) Hatcher register WITHOUT a `data.identityKey` → `row.userId` null →
  //       `boundUserId` null → resolveAgentSession DEMOTES to non-ledger →
  //       cove 403 `agent_session_not_ledger_authorized` (cove-blackjack.ts:271).
  //       Still operational (Hatcher must send identityKey to be a ledger subject);
  //       the no-key path is intentionally non-ledger and creates no avatar.
  //   (b) CLOSED 2026-06-04 (was: "register WITH identityKey but NO active avatar →
  //       cove 403 agent_session_has_no_active_avatar"). The register handler now
  //       AUTO-PROVISIONS a default avatar for the bound user on every
  //       identityKey-bound register (partner-hatcher.ts ensureHatcherAvatar /
  //       buildHatcherAvatarValues), so a fresh Hatcher agent is immediately
  //       ledger-capable + Cove-playable for real CT. Idempotent + no-faucet: it
  //       reuses an existing active avatar and never re-grants the schema-default
  //       100 CT (same balance the human + /join paths get). Covered by the
  //       focused verify scripts/hatcher/verify-avatar-provision.ts (4/4).
  //   (a) remains a clean 403 (NOT a silent demotion to the guest/demo tier), so
  //   E5's "never silently downgrade a connected agent" guarantee is intact. This
  //   harness models the HAPPY path (identityKey + avatar — now the default).
  //
  // WHY I1/I4 PREVIOUSLY 404'd (the stale-fixture root cause — NOT ledgerCapable):
  //   I1 (tools.json) routes via resolveSession→validateLiveAgentSession and I4
  //   (:tool) via validateLiveAgentSession directly (agent-gateway.ts:3597/3670).
  //   Neither checks ledgerCapable — that gate lives one layer deeper, in cove
  //   getSubject (only case I5 reaches it). validateLiveAgentSession (added in
  //   7cff0bba, require-auth-or-agent.ts:91-111) requires a real `openclaw_bots` DB
  //   row with a future `session_expires_at`; Map membership alone is no longer
  //   enough. The fixture registers the session in-memory ONLY (registerOpenClaw,
  //   above) and never inserts a row, so the DB lookup failed → 404/500. The fixture
  //   was stale for the NEW DB-row LIVENESS requirement, not for any ledger reason.
  //
  // FIXTURE FIX (test-only, no auth/cove code touched, NO DB connection or write):
  //   We stub `db.query.openclawBots.findFirst` + `db.query.avatars.findFirst` so the
  //   shipped validateLiveAgentSession resolves the SELFTEST session EXACTLY as it
  //   resolves a real persisted Hatcher row: a future-TTL `openclaw_bots` row bound to
  //   SELFTEST_USER_ID + an active `avatars` row for that user. The stubs return rows
  //   only for the fixture's own agentId/userId and `undefined` for everything else,
  //   so the negative cases (I2/I3 unknown-session 404, I5 unregistered-session 401,
  //   I6 unknown→null) keep failing closed. postgres-js connects lazily on the FIRST
  //   query, and the stubs short-circuit before any query runs — so the no-DB-writes
  //   (and no-DB-connection) invariant is preserved.
  const dbMod = await import('@clawville/database');
  const stubDb = dbMod.db as unknown as {
    query: {
      openclawBots: { findFirst: (args?: unknown) => Promise<unknown> };
      avatars: { findFirst: (args?: unknown) => Promise<unknown> };
    };
  };
  // The fixture row now carries a real `sessionKeyHash = sha256Hex(SELFTEST_SESSION)`
  // so the b453fb18 restart-survival RESTORE path (restoreAgentSessionFromRow, which
  // looks up `eq(openclawBots.sessionKeyHash, sha256Hex(incoming bearer))` on a
  // Map-MISS) resolves the fixture session — and ONLY the fixture session — exactly
  // as a real persisted Hatcher row would.
  const SELFTEST_SESSION_KEY_HASH = createHash('sha256').update(SELFTEST_SESSION).digest('hex');
  const SELFTEST_BOT_ROW = {
    id: 'uuid-selftest-bot',
    agentId: overrideConfig.agentId, // 'hatcher:selftest-d' — must match the registered config
    identityType: 'hatcher',
    userId: SELFTEST_USER_ID,
    sessionExpiresAt: new Date(Date.now() + 3600_000), // future TTL — liveness gate passes
    sessionKeyHash: SELFTEST_SESSION_KEY_HASH,
    sessionSweptAt: null, // not swept — restore's swept-gate (restore.ts:326) passes
    // hatcher-restore needs a rebuildable proxy client; a non-hatcher-proxy restore
    // (override mode here) rebuilds from these. The override path only needs targetNpcId.
    mode: 'override',
    protocol: 'hatcher-proxy',
    proxyUrl: 'https://api.hatcher.host',
    targetNpcId: overrideConfig.targetNpcId,
    metadata: {},
  };
  const SELFTEST_AVATAR_ROW = { id: SELFTEST_AVATAR_ID, userId: SELFTEST_USER_ID, isActive: true };

  // ── WHERE-CLAUSE-AWARE openclaw_bots stub (fix 2026-06-12) ──
  // Why the previous UNCONDITIONAL stub broke I2/I3/I5/I6: it returned the fixture
  // row for EVERY query. Its comment assumed this stub is reached ONLY for a live
  // registered session, because an unknown session returns at validateLiveAgentSession
  // step 1 (isValidAgentSession Map-miss). That assumption was TRUE before b453fb18
  // but FALSE after: the restart-survival fix made the Map-MISS path call
  // restoreAgentSessionFromRow → `findFirst({ where: eq(sessionKeyHash, sha256(id)) })`.
  // So an UNKNOWN session now hits this stub via the restore lookup, and the
  // unconditional stub "restored" it from the fixture row — making I2/I3/I5/I6 see a
  // live session instead of a miss. (b453fb18 broke the harness mock, not prod.)
  //
  // The faithful model: introspect the Drizzle where-clause (a known-stable shape:
  // queryChunks = [..., <Column>, " = ", <Param>, ...]) to read the queried COLUMN
  // and VALUE, and return the fixture row ONLY when the query matches the fixture's
  // identity (agent_id == the registered agentId, OR session_key_hash == the fixture
  // session's hash). Any other key → `undefined` (row-missing), so unknown sessions
  // fail closed exactly as against a real DB.
  // Recursively collect (column names, Param literal values) from a Drizzle
  // where-clause. Handles `eq()` (flat queryChunks: [..., <Column>, " = ", <Param>])
  // AND `and()`/`or()` (which nest each comparison inside a child SQL chunk). A
  // `Column` chunk has a `columnType` + a `name`; a `Param` chunk has
  // `constructor.name === 'Param'` and carries the real literal on `.value`
  // (StringChunks also have a `.value`, but it's an array of SQL fragments — we use
  // the Param-constructor check to read ONLY real bound literals).
  function collectWhere(node: unknown, columns: Set<string>, values: unknown[]): void {
    const n = node as { queryChunks?: unknown[]; name?: string; columnType?: string; value?: unknown; constructor?: { name?: string } } | null;
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.queryChunks)) {
      for (const chunk of n.queryChunks) collectWhere(chunk, columns, values);
      return;
    }
    if (n.columnType && typeof n.name === 'string') columns.add(n.name);
    if (n.constructor?.name === 'Param' && 'value' in n) values.push(n.value);
  }
  function introspectWhere(args: unknown): { columns: Set<string>; values: unknown[] } {
    const where = (args as { where?: unknown } | undefined)?.where;
    const columns = new Set<string>();
    const values: unknown[] = [];
    collectWhere(where, columns, values);
    return { columns, values };
  }
  stubDb.query.openclawBots.findFirst = async (args?: unknown) => {
    const { columns, values } = introspectWhere(args);
    // Live path: validateLiveAgentSession → eq(agent_id, config.agentId).
    if (columns.has('agent_id') && values.includes(overrideConfig.agentId)) {
      return SELFTEST_BOT_ROW as unknown;
    }
    // Restore path (b453fb18): restoreAgentSessionFromRow → eq(session_key_hash,
    // sha256(incoming bearer)). Only the fixture session's OWN hash matches; an
    // unknown session's hash finds no row → undefined (fail closed) → restore null.
    if (columns.has('session_key_hash') && values.includes(SELFTEST_SESSION_KEY_HASH)) {
      return SELFTEST_BOT_ROW as unknown;
    }
    return undefined;
  };
  // avatars stub: active avatar for the bound test user ONLY (the avatars lookup is
  // `and(eq(user_id, ...), eq(is_active, true))`), so a query for any other user
  // surfaces the 403-no-avatar path. Match when the bound test user id is a Param.
  stubDb.query.avatars.findFirst = async (args?: unknown) => {
    const { values } = introspectWhere(args);
    return values.includes(SELFTEST_USER_ID) ? (SELFTEST_AVATAR_ROW as unknown) : undefined;
  };

  const agentGw = await import('../../src/routes/agent-gateway.ts');
  const { agentGatewayRoutes } = agentGw;
  const coveMod = await import('../../src/routes/cove-blackjack.ts');
  const { coveBlackjackRouter } = coveMod;

  const gwApp = new Hono();
  gwApp.route('/api/agent', agentGatewayRoutes);

  await safe('I1 GET cove/blackjack/tools.json (live agent session) -> 200, 4 real-CT tools, bet bounds 5..500', async () => {
    const res = await gwApp.request(`/api/agent/${SELFTEST_SESSION}/cove/blackjack/tools.json`, { method: 'GET' });
    if (res.status !== 200) { check('I1 GET cove/blackjack/tools.json (live agent session) -> 200, 4 real-CT tools, bet bounds 5..500', false, `status=${res.status} (expect 200 for the registered override session ${SELFTEST_SESSION})`); return; }
    const tools = (await res.json()) as Array<{ name: string; input_schema?: { properties?: Record<string, unknown> }; parameters?: { properties?: { bet?: { minimum?: number; maximum?: number } } } }>;
    const names = tools.map((t) => t.name).sort();
    const expectedNames = ['cove_blackjack_action', 'cove_blackjack_close_session', 'cove_blackjack_deal', 'cove_blackjack_open_session'];
    const namesOk = names.length === 4 && expectedNames.every((n) => names.includes(n));
    const deal = tools.find((t) => t.name === 'cove_blackjack_deal');
    const betBounds = deal?.parameters?.properties?.bet;
    const boundsOk = betBounds?.minimum === 5 && betBounds?.maximum === 500;
    check('I1 GET cove/blackjack/tools.json (live agent session) -> 200, 4 real-CT tools, bet bounds 5..500', namesOk && boundsOk, `status=${res.status} tools=${JSON.stringify(names)} dealBetBounds=${JSON.stringify(betBounds)} (expect 4 tools + bet 5..500 real-CT)`);
  });

  await safe('I2 GET cove/blackjack/tools.json (UNKNOWN session) -> 404 (session-gated)', async () => {
    const res = await gwApp.request('/api/agent/no-such-session-xyz/cove/blackjack/tools.json', { method: 'GET' });
    check('I2 GET cove/blackjack/tools.json (UNKNOWN session) -> 404 (session-gated)', res.status === 404, `status=${res.status} (expect 404 — only a live agent can fetch the bundle)`);
  });

  await safe('I3 POST cove/blackjack/:tool (UNKNOWN session) -> 404 (no anonymous play)', async () => {
    const res = await gwApp.request('/api/agent/no-such-session-xyz/cove/blackjack/cove_blackjack_open_session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('I3 POST cove/blackjack/:tool (UNKNOWN session) -> 404 (no anonymous play)', res.status === 404, `status=${res.status} body=${JSON.stringify(await res.json())} (expect 404 — invalid agent session)`);
  });

  await safe('I4 POST cove/blackjack/:tool prototype-pollution tool name (constructor) -> 404 unknown_tool (Object.hasOwn guard)', async () => {
    const res = await gwApp.request(`/api/agent/${SELFTEST_SESSION}/cove/blackjack/constructor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = (await res.json()) as { error?: string };
    const ok = res.status === 404 && j.error === 'unknown_tool';
    if (!ok) bugs.push('cove POST :tool resolved a prototype key (constructor) to a route — Object.hasOwn guard missing on the money path');
    check('I4 POST cove/blackjack/:tool prototype-pollution tool name (constructor) -> 404 unknown_tool (Object.hasOwn guard)', ok, `status=${res.status} body=${JSON.stringify(j)} (expect 404 unknown_tool — inherited prototype key must NOT map to a cove endpoint)`);
  });

  await safe('I5 cove route getSubject — agent-session header for an UNREGISTERED session -> 401, NOT a silent guest demotion (Rule E5)', async () => {
    // Drive the audited cove router directly. sessionMiddleware (self-applied) sees
    // no Cookie → user=null; getSubject reads the agent-session header → an
    // unregistered session → resolveAgentSession returns null → throws 401
    // invalid_or_expired_agent_session. The E5 guarantee: a connected agent is
    // NEVER silently downgraded to the guest/demo tier on a bad session.
    const res = await coveBlackjackRouter.request('/session/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Clawville-Agent-Session': 'unregistered-agent-session-zzz' },
      body: JSON.stringify({ currency: 'clawtoken' }),
    });
    const text = await res.text();
    const is401 = res.status === 401;
    const mentionsAgentSession = /agent_session|agent session|invalid_or_expired/i.test(text);
    if (!is401) bugs.push(`cove getSubject did NOT 401 on an invalid agent session (status=${res.status}) — risk of silent guest demotion (E5 violation)`);
    check('I5 cove route getSubject — agent-session header for an UNREGISTERED session -> 401, NOT a silent guest demotion (Rule E5)', is401 && mentionsAgentSession, `status=${res.status} body=${text.slice(0, 160)} (expect 401 invalid_or_expired_agent_session — never fall through to guest)`);
  });

  await safe('I6 resolveAgentSession(unknown) === null (the parity gate that blocks unbound play)', async () => {
    const ra = await import('../../src/middleware/require-auth-or-agent.ts');
    const r = await ra.resolveAgentSession('definitely-not-a-real-session-000');
    check('I6 resolveAgentSession(unknown) === null (the parity gate that blocks unbound play)', r === null, `resolveAgentSession(unknown) => ${JSON.stringify(r)} (expect null — an unknown session can never bind to an avatar/CT)`);
  });

  // CLEANUP — stop the sim tick interval (so the process can exit).
  stopSimulation();

  // SUMMARY
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log('');
  console.log('========================================================');
  console.log(`SUMMARY: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP  (total ${results.length})`);
  if (bugs.length > 0) { console.log(`BUGS FOUND (${bugs.length}):`); for (const b of bugs) console.log(`  - ${b}`); } else { console.log('BUGS FOUND: none'); }
  console.log('========================================================');
  console.log(`HARNESS EXIT: ${failed > 0 ? 1 : 0}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('HARNESS CRASHED:', err); process.exit(2); });
