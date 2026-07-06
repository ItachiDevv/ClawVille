// FIX-2 persistence proof: register stats hp100 → PATCH stats hp145 → print uuid.
// Then query the DB for metadata.stats to confirm the PATCH PERSISTED (not just 200).
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const apiBase = 'https://api-staging.clawville.world';
const kp = nacl.sign.keyPair.fromSecretKey(
  bs58.decode((JSON.parse(readFileSync('.hatcher-ref/cv-test-partner.json', 'utf8')) as { secretKeyB58: string }).secretKeyB58),
);
const pub = bs58.encode(kp.publicKey);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sign = (m: string) => bs58.encode(nacl.sign.detached(new Uint8Array(createHash('sha256').update(m).digest()), kp.secretKey));

async function w(method: string, path: string, body: unknown | null) {
  const raw = body === null ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Hatcher-Issuer-Pubkey': pub, 'X-Hatcher-Signature': sign(`clawville-partner-write\n${method}\n${path}\n${ts}\n${sha(raw)}`), 'X-Hatcher-Timestamp': ts },
    body: method === 'DELETE' && raw === '' ? undefined : raw,
  });
  return { status: res.status, text: await res.text() };
}

const ID = 'mock-persist';
const cognition = { backend: 'hatcher-proxy', proxyBaseUrl: 'https://api.hatcher.host', scopedToken: `pp-${bs58.encode(nacl.randomBytes(16))}` };

await w('DELETE', `/api/partner/hatcher/agents/${ID}`, null);
const reg = await w('POST', '/api/partner/hatcher/agents', { agentId: ID, mode: 'avatar', name: 'Persist', stats: { hp: 100, attack: 12, defense: 10, speed: 12 }, homeX: 3000, homeY: 3000, cognition });
const uuid = JSON.parse(reg.text)?.agent?.uuid;
console.log(`REGISTER status=${reg.status} uuid=${uuid} (stats hp=100, home=3000)`);
const pat = await w('PATCH', `/api/partner/hatcher/agents/${ID}`, { stats: { hp: 145, attack: 21, defense: 19, speed: 23 }, homeX: 4200, homeY: 4400 });
console.log(`PATCH  {stats hp=145, home=4200/4400} status=${pat.status}`);
console.log(`UUID=${uuid}`);
console.log(`NEXT: query metadata.stats for this uuid in the DB; expect hp=145, homeX=4200.`);
