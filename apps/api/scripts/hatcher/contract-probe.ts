/**
 * CONTRACT PROBE — live evidence that our register/PATCH schemas diverge from
 * Hatcher's REAL ClawVilleRegisterBody / ClawVillePatchBody (pulled from
 * HatcherLabs/hatcher-host-frontend@main 2026-06-13). Staging-only; uses the
 * ALLOW_TEST_PARTNER_PUBKEY test key (/tmp/cv-test-partner.json).
 *
 * Proves, against the LIVE API:
 *  A. register accepts Hatcher's full real body (mode/name/personality/stats/
 *     homeX/homeY/rotateScopedToken) → 200 (rotateScopedToken silently stripped).
 *  B. register with stats outside OUR bounds but inside THEIR form range
 *     (hp 300, atk 50…) → 400 (statsSchema bounds mismatch).
 *  C. PATCH { stats } only → 400 "No mutable fields provided" (Zod strips stats,
 *     refine sees {}). i.e. their "Update avatar" stats edit HARD-FAILS.
 *  D. PATCH { homeX, homeY } only → 400 (same — reposition impossible via PATCH).
 *  E. PATCH { rotateScopedToken:true } only → 200 since FIX-8 (accept-and-ignore
 *     no-op — declared in patchSchema so the partner intent isn't Zod-stripped,
 *     which also satisfies the non-empty refine). Pre-FIX-8 this was 400.
 *  F. PATCH { name, stats } → 200 but stats SILENTLY dropped (name carries refine).
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

function show(label: string, r: { status: number; text: string }) {
  console.log(`\n[${label}] status=${r.status}\n   ${r.text.slice(0, 240).replace(/\n/g, ' ')}`);
}

async function main() {
  console.log(`=== Hatcher contract probe vs ${apiBase} (key ${pub.slice(0, 8)}…) ===`);

  // cleanup any prior
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID}`, null);
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID_OOB}`, null);

  // A. full real body — Hatcher's actual ClawVilleRegisterBody + cognition
  const a = await writeSigned('POST', '/api/partner/hatcher/agents', {
    agentId: ID, mode: 'avatar', name: 'Probe Agent', personality: 'curious',
    stats: { hp: 100, attack: 12, defense: 10, speed: 12 },
    homeX: 3000, homeY: 3000, rotateScopedToken: true, cognition,
  });
  show('A register full-real-body (expect 200; rotateScopedToken stripped)', a);

  // B. stats outside OUR bounds, inside THEIR form (hp<=500, others<=100)
  const b = await writeSigned('POST', '/api/partner/hatcher/agents', {
    agentId: ID_OOB, mode: 'avatar', name: 'OOB',
    stats: { hp: 300, attack: 50, defense: 40, speed: 60 }, cognition,
  });
  show('B register out-of-bounds stats (their form allows; expect 400 = bounds mismatch)', b);

  // C. PATCH stats only
  const c = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { stats: { hp: 140, attack: 20, defense: 18, speed: 22 } });
  show('C PATCH {stats} only (Hatcher Update-avatar; expect 400 No-mutable-fields)', c);

  // D. PATCH home only
  const d = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { homeX: 4000, homeY: 4000 });
  show('D PATCH {homeX,homeY} only (reposition; expect 400)', d);

  // E. PATCH rotateScopedToken only
  const e = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { rotateScopedToken: true });
  show('E PATCH {rotateScopedToken} only (expect 200 — FIX-8 accept-and-ignore no-op)', e);

  // F. PATCH name + stats — name carries refine, stats silently dropped
  const f = await writeSigned('PATCH', `/api/partner/hatcher/agents/${ID}`, { name: 'Renamed', stats: { hp: 150, attack: 25, defense: 25, speed: 25 } });
  show('F PATCH {name,stats} (expect 200; stats SILENTLY dropped)', f);

  // cleanup
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID}`, null);
  await writeSigned('DELETE', `/api/partner/hatcher/agents/${ID_OOB}`, null);
  console.log('\n=== probe done (cleaned up) ===');
}
main().catch((err) => { console.error('FATAL', err); process.exit(1); });
