// Test: what does the OLD 8-symbol/40-strip paytable score?
// We mock the engine path by using `evaluateReels` against a synthetic
// build of the old paytable via direct sampling.

import { sampleIntFromBytes } from '../apps/api/src/services/provable-rng.ts';

const ORIG_STRIPS = [
  [0,1,2,0,3,1,0,2,4,0,1,3,0,2,1,5,0,1,2,0,3,4,0,1,2,0,3,1,6,0,2,1,0,4,1,2,7,0,1,3],
  [0,2,1,3,0,1,2,0,4,1,0,3,2,0,1,2,5,0,1,3,0,2,1,0,4,3,0,1,2,0,6,1,0,3,2,1,7,0,2,4],
  [1,0,2,1,3,0,2,4,0,1,2,0,3,1,5,0,2,1,0,3,4,0,1,2,0,3,1,2,0,4,1,6,0,2,3,0,1,7,2,0],
  [0,1,2,3,0,1,4,0,2,1,0,3,2,1,0,2,5,0,1,3,0,4,1,2,0,3,1,0,2,4,0,1,6,2,0,3,1,7,0,2],
  [2,0,1,0,3,2,0,1,4,0,2,1,3,0,1,2,0,5,1,0,3,2,0,4,1,0,3,2,1,0,4,1,6,0,2,1,0,3,7,1],
];
const ORIG_PAYOUTS = {
  0:[2,5,10,20], 1:[2,5,15,25], 2:[3,8,20,35], 3:[4,12,30,60],
  4:[5,20,50,100], 5:[10,40,100,250], 6:[20,100,300,800], 7:[5,25,75,200]
};
const WILD = 7;
const LINES = [
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],[0,1,2,2,2],[2,1,0,0,0],[0,0,0,1,2],
  [1,0,1,2,1],[1,2,1,0,1],[0,1,0,1,0],[2,1,2,1,2],[1,0,0,0,1],
  [1,2,2,2,1],[0,0,1,0,0],[2,2,1,2,2],[0,1,1,1,0],[2,1,1,1,2],
];

const N = 50_000;
const BET = 100;
const perLine = BET / 20;
let totalPay = 0;
let cursor = 0;
for (let i = 0; i < N; i++) {
  const reels = [];
  for (let r = 0; r < 5; r++) {
    const strip = ORIG_STRIPS[r];
    const { value: stop, bytesConsumed } = sampleIntFromBytes({
      serverSeed: 'a'.repeat(64), clientSeed: 'abcd1234', nonce: i,
      cursorStart: cursor, min: 0, max: strip.length,
    });
    cursor += bytesConsumed;
    const L = strip.length;
    reels.push([strip[(stop-1+L)%L], strip[stop], strip[(stop+1)%L]]);
  }
  for (const line of LINES) {
    const sym = line.map((row, r) => reels[r][row]);
    let kind = undefined;
    for (const s of sym) if (s !== WILD) { kind = s; break; }
    if (kind === undefined) kind = WILD;
    let len = 0;
    for (const s of sym) { if (s === kind || s === WILD) len++; else break; }
    if (len < 2) continue;
    const mult = ORIG_PAYOUTS[kind][len-2] || 0;
    totalPay += perLine * mult;
  }
}
const rtp = totalPay / (N * BET);
console.log(`Original 8-symbol paytable RTP over ${N} spins: ${(rtp*100).toFixed(2)}%`);
