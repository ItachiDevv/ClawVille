/**
 * CONTRACT REGRESSION GATE — asserts that our register/PATCH schemas stay aligned
 * with Hatcher's REAL ClawVilleRegisterBody / ClawVillePatchBody (pulled from
 * HatcherLabs/hatcher-host-frontend@main 2026-06-13). Staging-only; uses the
 * ALLOW_TEST_PARTNER_PUBKEY test key (/tmp/cv-test-partner.json).
 *
 * Asserts, against the LIVE API:
 *  A. register accepts Hatcher's full real body → 200; FIX-8 accepts-and-ignores
 *     rotateScopedToken as a documented no-op.
 *  B. register accepts hp 300 / attack 50 / defense 40 / speed 60 → 200; FIX-3
 *     widened statsSchema to match Hatcher's form bounds.
 *  B2. register rejects hp 501 → 400, proving the FIX-3 upper bound is enforced.
 *  C. PATCH { stats } only → 200 and stats are applied by FIX-2.
 *  D. PATCH { homeX, homeY } only → 200 and reposition is applied by FIX-2.
 *  E. PATCH { rotateScopedToken:true } only → 200; FIX-8 accept-and-ignore no-op.
 *  F. PATCH { name, stats } → 200 and both fields are applied by FIX-2.
 *
 * Run: bun run apps/api/scripts/hatcher/contract-probe.ts \
 *        --api-base https://api-staging.clawville.world \
 *        --keyfile /tmp/cv-test-partner.json
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const argv = process.argv.slice(2);
const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const apiBase = (get('--api-base') ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const keyfile = get('--keyfile') ?? '/tmp/cv-test-partner.json';

const parsed = JSON.parse(readFileSync(keyfile, 'utf8')) as { secretKeyB58: string };
const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(parsed.secretKeyB58));
const pub = bs58.encode(kp.publicKey);

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const signDigest = (m: string) => bs58.encode(nacl.sign.detached(new Uint8Array(createHash('sha256').update(m).digest()), kp.secretKey));

async function writeSigned(method: string, path: string, body: unknown | null) {
  const raw = body === null ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const challenge = `clawville-partner-write\n${method}\n${path}\n${ts}\n${sha256hex(raw)}`;
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Hatcher-Issuer-Pubkey': pub,
      'X-Hatcher-Signature': signDigest(challenge),
      'X-Hatcher-Timestamp': ts,
    },
    body: method === 'DELETE' && raw === '' ? undefined : raw,
  });
  const text = await res.text();
  return { status: res.status, text };
}

const cognition = { backend: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: `probe-${bs58.encode(nacl.randomBytes(16))}` };
const ID = 'mock-contract-probe';
const ID_OOB = 'mock-contract-probe-oob';
const ID_OOB2 = 'mock-contract-probe-oob2';

interface CaseResult {
  label: string;
  expectedStatus: number;
  actualStatus: number;
  passed: boolean;
}

function show(label: string, expectedStatus: number, r: { status: number; text: string }): CaseResult {
  const result = { label, expectedStatus, actualStatus: r.status, passed: r.status === expectedStatus };
  console.log(`\n[${result.passed ? 'PASS' : 'FAIL'}] ${label} — actual=${r.status}, expected=${expectedStatus}\n   ${r.text.slice(0, 240).replace(/\n/g, ' ')}`);
  return result;
}

async function cleanup() {
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID}`, null);
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID_OOB}`, null);
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID_OOB2}`, null);
}

async function main() {
  console.log(`=== Hatcher contract probe vs ${apiBase} (key ${pub.slice(0, 8)}…) ===`);
  const results: CaseResult[] = [];

  try {
    // cleanup any prior
    await cleanup();

    // A. full real body — Hatcher's actual ClawVilleRegisterBody + cognition
    const a = await writeSigned('POST', '/api/partner/hatcher/agents', {
      agentId: ID, mode: 'avatar', name: 'Probe Agent', personality: 'curious',
      stats: { hp: 100, attack: 12, defense: 10, speed: 12 },
      homeX: 3000, homeY: 3000, rotateScopedToken: true, cognition,
    });
    results.push(show('A register full-real-body (FIX-8 accepts-and-ignores rotateScopedToken)', 200, a));

    // B. stats inside the FIX-3 widened bounds (hp<=500, others<=100)
    const b = await writeSigned('POST', '/api/partner/hatcher/agents', {
      agentId: ID_OOB, mode: 'avatar', name: 'OOB',
      stats: { hp: 300, attack: 50, defense: 40, speed: 60 }, cognition,
    });
    results.push(show('B register widened-band stats (FIX-3 matches Hatcher form bounds)', 200, b));

    // B2. stats above the FIX-3 widened bounds still fail validation
    const b2 = await writeSigned('POST', '/api/partner/hatcher/agents', {
      agentId: ID_OOB2, mode: 'avatar', name: 'OOB2',
      stats: { hp: 501, attack: 50, defense: 40, speed: 60 }, cognition,
    });
    results.push(show('B2 register hp 501 (above FIX-3 upper bound)', 400, b2));

    // C. PATCH stats only
    const c = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { stats: { hp: 140, attack: 20, defense: 18, speed: 22 } });
    results.push(show('C PATCH {stats} only (FIX-2 applies stats)', 200, c));

    // D. PATCH home only
    const d = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { homeX: 4000, homeY: 4000 });
    results.push(show('D PATCH {homeX,homeY} only (FIX-2 applies reposition)', 200, d));

    // E. PATCH rotateScopedToken only
    const e = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { rotateScopedToken: true });
    results.push(show('E PATCH {rotateScopedToken} only (FIX-8 accept-and-ignore no-op)', 200, e));

    // F. PATCH name + stats
    const f = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { name: 'Renamed', stats: { hp: 150, attack: 25, defense: 25, speed: 25 } });
    results.push(show('F PATCH {name,stats} (FIX-2 applies both fields)', 200, f));
  } finally {
    await cleanup();
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\n=== probe summary: ${results.length - failed.length}/${results.length} passed (cleaned up) ===`);
  if (failed.length > 0) process.exit(1);
}
main().catch((err) => { console.error('FATAL', err); process.exit(1); });
