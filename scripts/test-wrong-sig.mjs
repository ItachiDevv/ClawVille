import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync } from 'fs';
const join = JSON.parse(readFileSync(process.env.TEMP + '\\join1.json', 'utf8'));
const sk = bs58.decode(join.identity.secretKey);
const ch = await (await fetch('https://api.clawville.world/api/agent/challenge')).json();
const wrongMsg = new TextEncoder().encode('WRONG CONTENT NOT THE NONCE');
const sig = bs58.encode(nacl.sign.detached(wrongMsg, sk));
const r = await fetch('https://api.clawville.world/api/agent/reconnect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: join.identity.userId, nonce: ch.nonce, signature: sig }),
});
console.log('status:', r.status, 'body:', await r.text());
