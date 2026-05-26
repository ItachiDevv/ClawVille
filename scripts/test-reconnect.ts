// Phase 5.1 reconnect smoke test — simulate an agent that has the identity key.
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync } from 'fs';

const joinPath = process.env.TEMP ? `${process.env.TEMP}\\join1.json` : '/tmp/join1.json';
const join = JSON.parse(readFileSync(joinPath, 'utf8'));
const userId = join.identity.userId;
const privateKeyB58 = join.identity.secretKey;
const privateKey = bs58.decode(privateKeyB58);

console.log('[reconnect] userId:', userId);
console.log('[reconnect] pubkey:', join.identity.publicKey);

// Step 1: request nonce
const ch = await fetch('https://api.clawville.world/api/agent/challenge').then((r) => r.json());
console.log('[reconnect] challenge nonce:', ch.nonce);

// Step 2: decode nonce + sign
const nonceBytes = bs58.decode(ch.nonce);
const sig = nacl.sign.detached(nonceBytes, privateKey);
const signatureB58 = bs58.encode(sig);
console.log('[reconnect] signed, sig length:', sig.length);

// Step 3: POST /reconnect
const res = await fetch('https://api.clawville.world/api/agent/reconnect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, nonce: ch.nonce, signature: signatureB58 }),
});
const body = await res.json();
console.log('[reconnect] status:', res.status);
console.log('[reconnect] response:', JSON.stringify(body, null, 2));

// Step 4: sanity — verify the returned ticket is different from the original /join ticket
if (body.sessionTicket?.url === join.sessionTicket.url) {
  console.error('❌ Got the same ticket URL — reconnect is not minting fresh tickets');
  process.exit(1);
}
console.log('✅ Fresh ticket minted via signed challenge');

// Step 5: try replay — use the same nonce again (should 401)
const replay = await fetch('https://api.clawville.world/api/agent/reconnect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, nonce: ch.nonce, signature: signatureB58 }),
});
console.log('[reconnect] replay status:', replay.status, '(expect 401)');
if (replay.status !== 401) {
  console.error('❌ Nonce replay succeeded — nonce store not atomic');
  process.exit(1);
}
console.log('✅ Nonce replay correctly rejected');

// Step 6: try bad signature
// Sign a DIFFERENT message, pass it as the signature for the real nonce — well-formed
// bytes but wrong content. Crypto verify must catch this.
const chb = await fetch('https://api.clawville.world/api/agent/challenge').then((r) => r.json());
const wrongMsg = new TextEncoder().encode('this is not the nonce');
const wrongSig = bs58.encode(nacl.sign.detached(wrongMsg, privateKey));
const bad = await fetch('https://api.clawville.world/api/agent/reconnect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, nonce: chb.nonce, signature: wrongSig }),
});
console.log('[reconnect] wrong-content-sig status:', bad.status, '(expect 401)');
if (bad.status !== 401) {
  console.error('❌ Wrong-content signature accepted — crypto verify broken');
  process.exit(1);
}
console.log('✅ Wrong-content signature correctly rejected by crypto verify');

console.log('\n=== RECONNECT SMOKE TEST PASSED ===');
