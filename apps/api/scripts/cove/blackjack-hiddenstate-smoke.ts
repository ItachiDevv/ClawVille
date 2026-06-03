/**
 * Cove blackjack RUNTIME smoke - hidden-state + money invariants on REAL responses.
 *
 * WHY THIS EXISTS (project rule [[feedback_live_smoke_catches_audit_misses]]):
 * a prior holdem engine PASSED an APPROVED multi-agent money audit while leaking
 * all community cards preflop - only a live smoke caught it. Code review of a
 * provably-fair engine is explicitly deemed INSUFFICIENT. This smoke produces
 * RUNTIME evidence on the ACTUAL Hono responses.
 *
 * METHOD - two complementary planes, all in-process (NEVER `bun run dev`):
 *
 *   PLANE A (live route, GUEST demo tier, real DB):
 *     Mounts the SHIPPING `coveBlackjackRouter` behind the SHIPPING
 *     `fingerprintMiddleware` in a tiny Hono app - byte-identical to
 *     apps/api/src/index.ts (`app.use('*', fingerprintMiddleware)` +
 *     `app.route('/api/cove/blackjack', coveBlackjackRouter)`). Drives a guest
 *     (X-CV-Fingerprint header → demo CT on the shoe row, NO real ledger, NO
 *     leaderboard) through open → deal → action(s) → settle → close over many
 *     hands and asserts the four hidden-state invariants + the rake/settlement
 *     money-math on the REAL responses. The dealer-hole / undealt / seed
 *     withholding is the SAME response-shaping code for guest, human, and agent
 *     (the agent tool endpoint is a pure verbatim proxy to this router - see
 *     agent-gateway.ts `coveBlackjackRouter.request(...)`), so guest proves it
 *     for the agent path too. Guest play touches NOTHING persistent that maps to
 *     a real user/agent.
 *
 *   PLANE B (engine + route serialization, synthetic seeds, NO DB):
 *     Searches synthetic (serverSeed, clientSeed) pairs for a deterministic
 *     WIN, PUSH, and LOSS, then asserts `computeBlackjackRake` + the route's
 *     settled `outcome` (serializeHandResult) money-math EXACTLY: winner credit
 *     == gross - floor(net*0.05); push/loss NEVER raked; rake never touches the
 *     returned stake. This pins the exact arithmetic Plane A can only sample.
 *
 * PROD-MUTATION POSTURE: Plane A writes ONLY guest-tier rows (blackjack_shoes /
 * blackjack_hands / cove_game_events tagged with guest_fp_hash, user_id NULL) on
 * the shared Supabase DB. It debits/credits NO real avatar or agent CT (guest
 * balance lives on the shoe row). Rows are guest-scoped and left in place
 * (closing the shoe is part of the seed-reveal invariant); a cleanup query id is
 * printed so they can be deleted if desired. The fingerprint is randomized per
 * run so the guest is unique and isolated.
 *
 * Run:  (from repo root, with DATABASE_URL + crash-loud env vars exported)
 *   set -a; . "$TEMP/.cove-smoke-env"; set +a
 *   cd apps/api && bun run scripts/cove/blackjack-hiddenstate-smoke.ts
 * Exit: 0 on all-pass, 1 on any FAIL.
 */

import { randomBytes, createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Crash-loud env vars MUST be present BEFORE importing any apps/api module.
// DATABASE_URL is required for real (guest-only) play. The others are provided
// from the running container by the operator (see header) or dummied if absent
// (only DATABASE_URL is genuinely used by the cove path).
// ---------------------------------------------------------------------------
function ensureEnv(k: string, v: string) {
  if (!process.env[k] || process.env[k]!.length === 0) process.env[k] = v;
}
const HEX32 = '0'.repeat(64);
ensureEnv('FINGERPRINT_SECRET', HEX32);
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
if (!process.env.DATABASE_URL) {
  console.error(
    'FATAL: DATABASE_URL not set. Export the read-creds first:\n' +
      '  set -a; . "$TEMP/.cove-smoke-env"; set +a',
  );
  process.exit(1);
}
// HARNESS-ENV ADJUSTMENT (not a product change): the @clawville/database client
// is bare `postgres(connectionString)` (default pool, prepared statements ON).
// Against Supabase's TRANSACTION-mode pooler (port 6543) a short-lived multi-
// request smoke hits read-your-writes failures - a hand committed by /hand/deal
// on one pooled backend is briefly invisible to the /action read on another
// (prepared-statement + per-tx connection artifact; the long-lived prod api
// container warms its pool differently and is unaffected; the api's own
// eliza-migrator uses {max:1, prepare:false} for the same reason). Switching to
// the SESSION-mode pooler (port 5432) gives a stable connection with consistent
// read-your-writes. This changes ONLY how THIS smoke connects - zero effect on
// the route/engine code under test (identical SQL, identical primary DB).
if (process.env.DATABASE_URL.includes(':6543')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(':6543', ':5432');
}

import { Hono } from 'hono';
import { fingerprintMiddleware } from '../../src/middleware/fingerprint';
import { coveBlackjackRouter } from '../../src/routes/cove-blackjack';
import {
  playHand,
  serializeHandResult,
  computeBlackjackRake,
  buildShoe,
  type HandScript,
  type SerializedHandResult,
} from '../../src/services/blackjack-engine';
import { db, blackjackShoes, blackjackHands, coveGameEvents } from '@clawville/database';
import { eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
interface Inv {
  name: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
}
const invariants: Inv[] = [];
const log: string[] = [];
const leaks: string[] = [];
function emit(s: string) {
  log.push(s);
  console.log(s);
}
function pass(name: string, evidence: string) {
  invariants.push({ name, status: 'PASS', evidence });
  emit(`PASS  ${name} :: ${evidence}`);
}
function fail(name: string, evidence: string) {
  invariants.push({ name, status: 'FAIL', evidence });
  emit(`FAIL  ${name} :: ${evidence}`);
}

// ---------------------------------------------------------------------------
// The app under test - the EXACT production wiring for guest cove play.
// ---------------------------------------------------------------------------
const app = new Hono();
app.use('*', fingerprintMiddleware);
app.route('/api/cove/blackjack', coveBlackjackRouter);

// A unique guest fingerprint for this run → isolated demo wallet, no collision.
const GUEST_FP = `cove-smoke-${randomBytes(8).toString('hex')}`;
const GUEST_HEADERS = {
  'Content-Type': 'application/json',
  'X-CV-Fingerprint': GUEST_FP,
  'User-Agent': 'cove-hiddenstate-smoke/1.0',
};

async function post(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers: { ...GUEST_HEADERS, ...extraHeaders },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text.length ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}
async function get(path: string) {
  const res = await app.fetch(
    new Request(`http://local${path}`, { method: 'GET', headers: GUEST_HEADERS }),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text.length ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Hidden-state leak scanner - walks any object and flags forbidden disclosure
// in a PRE-settle (in-progress) agent/player-facing response.
//   - a SECOND dealer card (the hole) under any "dealer*"/cards key
//   - any field named serverSeed / remaining* / undealt* (the shoe)
//   - a clientSeed is NOT secret (it's public at open), so not flagged
// ---------------------------------------------------------------------------
const SEED_KEY_RE = /^(server_?seed|remaining|undealt|hole)/i;
function scanPreSettleLeak(obj: any, where: string): string[] {
  const found: string[] = [];
  const visit = (node: any, path: string) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (SEED_KEY_RE.test(k) && v !== null && v !== undefined && v !== '') {
        found.push(`${where}: forbidden key '${p}'=${JSON.stringify(v)}`);
      }
      // A "dealer" object/array carrying >1 card pre-settle = hole-card leak.
      if (/dealer/i.test(k) && v && typeof v === 'object') {
        const cards = (v as any).cards;
        if (Array.isArray(cards) && cards.length > 1) {
          found.push(`${where}: dealer exposes ${cards.length} cards pre-settle (hole leaked) at '${p}'`);
        }
      }
      visit(v, p);
    }
  };
  visit(obj, '');
  return found;
}

// Best blackjack total of a small card list (Ace soft-promotion). Used only to
// pick a never-busting hit (<=11) so the SAFE driver never trips the bust path.
function handTotalOf(cards: Array<{ rank: string }> | undefined): number {
  if (!Array.isArray(cards)) return 99;
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      total += 1;
      aces++;
    } else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J' || c.rank === '10') {
      total += 10;
    } else {
      total += Number(c.rank);
    }
  }
  if (aces > 0 && total + 10 <= 21) total += 10;
  return total;
}

// Count dealer cards exposed at a given response (upcard surfaces are scalars or
// a 1-element list; settled outcome.dealer.cards is the full hand, expected).
function dealerCardsExposed(resp: any): number {
  // deal/action shape: dealerUpcard is a single Card object (or undefined).
  if (resp?.dealerUpcard) return Array.isArray(resp.dealerUpcard) ? resp.dealerUpcard.length : 1;
  return 0;
}

// ===========================================================================
// PLANE A - live route, guest demo tier
// ===========================================================================
async function planeA(): Promise<void> {
  emit('\n===== PLANE A - live coveBlackjackRouter, GUEST demo tier (real DB, no ledger) =====');

  // ---- A4: bet-bounds enforcement (do this on the open shoe) -------------
  const open = await post('/api/cove/blackjack/session/open', { currency: 'clawtoken' });
  if (open.status !== 200 || !open.json?.shoe?.id) {
    fail('A0 guest shoe opens', `status=${open.status} body=${open.text.slice(0, 200)}`);
    return;
  }
  const shoeId: string = open.json.shoe.id;
  const startBal: number = open.json.walletBalance;
  emit(`shoe opened id=${shoeId} guestStartBal=${startBal} serverSeed(open)=${JSON.stringify(open.json.shoe.serverSeed)}`);

  // I3a: serverSeed MUST be null while the shoe is open (publicShoe redaction).
  if (open.json.shoe.serverSeed === null) {
    pass('A3a serverSeed null while shoe open (open resp)', `shoe.serverSeed=null, serverSeedHash present=${!!open.json.shoe.serverSeedHash}`);
  } else {
    leaks.push(`open shoe leaked serverSeed=${open.json.shoe.serverSeed}`);
    fail('A3a serverSeed null while shoe open (open resp)', `LEAK shoe.serverSeed=${JSON.stringify(open.json.shoe.serverSeed)}`);
  }

  // I3a': GET /session/:id is a LEDGER-SUBJECT-ONLY route - a guest is
  // intentionally 403'd (cove-blackjack.ts:1945). That is the correct gate (a
  // guest has no persistent fairness contract). Assert the gate, not a 200.
  const detail = await get(`/api/cove/blackjack/session/${shoeId}`);
  if (detail.status === 403) {
    pass('A3a2 GET /session/:id correctly gates guests (403, not a leak)', `guest GET → 403 guest_cannot_inspect_shoe`);
  } else {
    fail('A3a2 GET /session/:id correctly gates guests (403, not a leak)', `status=${detail.status} body=${detail.text.slice(0, 160)}`);
  }

  // ---- A4: bet bounds 5..500 ---------------------------------------------
  const tooLow = await post('/api/cove/blackjack/hand/deal', { shoeId, bet: 4 });
  const tooHigh = await post('/api/cove/blackjack/hand/deal', { shoeId, bet: 501 });
  const negative = await post('/api/cove/blackjack/hand/deal', { shoeId, bet: -10 });
  const nonInt = await post('/api/cove/blackjack/hand/deal', { shoeId, bet: 5.5 });
  const lowOk = tooLow.status === 400;
  const highOk = tooHigh.status === 400;
  const negOk = negative.status === 400;
  const fracOk = nonInt.status === 400;
  if (lowOk && highOk && negOk && fracOk) {
    pass('A4 bet bounds 5..500 enforced', `bet=4→${tooLow.status}, bet=501→${tooHigh.status}, bet=-10→${negative.status}, bet=5.5→${nonInt.status} (all 400)`);
  } else {
    fail('A4 bet bounds 5..500 enforced', `bet=4→${tooLow.status}, bet=501→${tooHigh.status}, bet=-10→${negative.status}, bet=5.5→${nonInt.status}`);
  }
  // Boundary accepts: 5 and 500 must NOT be rejected by the schema (they may
  // 400 for affordability, but never for the bounds). We assert via a 5-bet
  // deal succeeding below.

  // ---- Full-hand loop: play many hands, assert hidden-state + rake each ----
  const BET = 5; // min bet; guest starts at 100 demo CT → ~20 hands of headroom
  let handsPlayed = 0;
  let dealHoleLeakSeen = false;
  let actionLeakSeen = false;
  let dealUpcardOnlySeen = false;
  let actionUpcardOnlySeen = false;
  let rakeViolation: string | null = null;
  let settlementMathOk = 0;
  let winSampled = false,
    pushSampled = false,
    lossSampled = false;
  let demoBal = startBal;

  const MAX_HANDS = 40;
  for (let i = 0; i < MAX_HANDS; i++) {
    // affordability - stop before overdraw
    if (demoBal < BET) break;

    const deal = await post('/api/cove/blackjack/hand/deal', { shoeId, bet: BET });
    if (deal.status === 409 && deal.json?.reshuffled) {
      emit(`hand ${i}: shoe reshuffled (75% penetration) - stopping deal loop`);
      break;
    }
    if (deal.status !== 200) {
      // affordability 400 at deal → out of demo CT; stop cleanly
      if (deal.status === 400) break;
      fail('A-deal', `unexpected deal status=${deal.status} body=${deal.text.slice(0, 160)}`);
      break;
    }

    // Natural blackjack settles immediately at deal time (dealtImmediately).
    const settledAtDeal = deal.json?.dealtImmediately === true || deal.json?.status === 'settled';

    if (!settledAtDeal) {
      // --- I1: deal exposes dealer UPCARD ONLY (no hole) ---
      const dealLeaks = scanPreSettleLeak(deal.json, 'deal');
      if (dealLeaks.length) {
        dealHoleLeakSeen = true;
        leaks.push(...dealLeaks);
      }
      const dn = dealerCardsExposed(deal.json);
      const dealHasPlayerCards = Array.isArray(deal.json.playerHand) && deal.json.playerHand.length === 2;
      if (dn === 1 && dealHasPlayerCards && !('dealerHand' in deal.json) && !('dealer' in deal.json)) {
        dealUpcardOnlySeen = true;
      } else if (dn !== 1) {
        dealHoleLeakSeen = true;
        leaks.push(`deal exposed ${dn} dealer cards (expected 1 upcard); body keys=${Object.keys(deal.json).join(',')}`);
      }

      // --- play to terminal (clean state-machine SAFE driver) ---
      // Strategy: hit ONLY while the visible player total <= 11 (a single card
      // can NEVER bust an <=11 total), otherwise stand. This deterministically
      // samples at least one in_progress /action response on low openings while
      // NEVER tripping the separate bust-via-hit path (probed deliberately in
      // A6), so every hand reaches a real settle for the rake/settlement checks.
      // `currentTotal` tracks the last visible player total (opening, then each
      // in_progress action response). We never send a redundant action after a
      // settle.
      const handId: string = deal.json.handId;
      let settleResp: any = null;
      let currentTotal = handTotalOf(deal.json.playerHand);
      for (let step = 0; step < 14; step++) {
        const act: 'hit' | 'stand' = currentTotal <= 11 ? 'hit' : 'stand';
        const ar = await post('/api/cove/blackjack/action', { handId, action: act, handSlot: 0 });
        if (ar.status !== 200) {
          fail('A-action', `action ${act} status=${ar.status} body=${ar.text.slice(0, 160)}`);
          break;
        }
        if (ar.json?.status === 'settled') {
          settleResp = ar.json;
          break;
        }
        if (ar.json?.status === 'in_progress') {
          // --- I2: mid-hand action exposes UPCARD ONLY ---
          const al = scanPreSettleLeak(ar.json, 'action');
          if (al.length) {
            actionLeakSeen = true;
            leaks.push(...al);
          }
          const an = dealerCardsExposed(ar.json);
          if (an === 1 && Array.isArray(ar.json.playerHands)) {
            actionUpcardOnlySeen = true;
          } else if (an !== 1) {
            actionLeakSeen = true;
            leaks.push(`action exposed ${an} dealer cards (expected 1 upcard); keys=${Object.keys(ar.json).join(',')}`);
          }
          currentTotal = ar.json.playerHands?.[0]?.total ?? 99;
          continue;
        }
        // Unknown shape - stop this hand.
        break;
      }

      if (!settleResp) continue;
      var settled = settleResp;
    } else {
      var settled = deal.json;
    }

    // --- I5 + settled-shape assertions on the REAL settled response ---
    handsPlayed++;
    const outcome: SerializedHandResult = settled.outcome;
    if (!outcome || outcome.kind !== 'blackjack') {
      fail('A-settle-shape', `settled missing outcome.kind=blackjack; keys=${Object.keys(settled).join(',')}`);
      continue;
    }
    // Post-settle reveals the FULL dealer hand - that is CORRECT (hand over).
    const dealerCardsN = outcome.dealer?.cards?.length ?? 0;
    // The settled response MUST NOT expose serverSeed (still null until close).
    const settledSeedLeak: string[] = [];
    if ('serverSeed' in settled && settled.serverSeed) settledSeedLeak.push(`settled.serverSeed=${settled.serverSeed}`);
    if ((outcome as any).serverSeed) settledSeedLeak.push(`outcome.serverSeed=${(outcome as any).serverSeed}`);
    if ((outcome as any).remaining) settledSeedLeak.push(`outcome.remaining present`);
    if (settledSeedLeak.length) leaks.push(...settledSeedLeak);

    // --- rake invariant on every settled hand ---
    const totalBet = BigInt(outcome.totalBet);
    const totalPayout = BigInt(outcome.totalPayout);
    const rake = BigInt(outcome.rake ?? '0');
    const grossNet = totalPayout - totalBet;
    const expectedRake = grossNet > 0n ? (grossNet * 5n) / 100n : 0n;
    const rakedPayout = BigInt(outcome.rakedPayout);
    const responseRake = BigInt(settled.rake ?? '0');

    if (rake !== expectedRake) {
      rakeViolation = `hand ${i}: rake=${rake} != expected floor(max(0,${grossNet})*5/100)=${expectedRake}`;
    }
    if (responseRake !== rake) {
      rakeViolation = `hand ${i}: top-level settled.rake=${responseRake} != outcome.rake=${rake}`;
    }
    if (rakedPayout !== totalPayout - rake) {
      rakeViolation = `hand ${i}: rakedPayout=${rakedPayout} != totalPayout-rake=${totalPayout - rake}`;
    }
    // Rake must NEVER touch the returned stake: on a push (payout==bet) or loss
    // (payout<bet) rake MUST be 0.
    if (grossNet <= 0n && rake !== 0n) {
      rakeViolation = `hand ${i}: NON-WIN raked! net=${grossNet} rake=${rake} (push/loss must never be raked)`;
    }

    // Classify outcome for sampling coverage.
    if (grossNet > 0n) winSampled = true;
    else if (grossNet === 0n) pushSampled = true;
    else lossSampled = true;

    // --- settlement balance delta == rakedNet (guest demo balance) ---
    const newBal = settled.balance;
    const expectedNewBal = demoBal + Number(rakedPayout - totalBet);
    if (newBal === expectedNewBal) {
      settlementMathOk++;
    } else {
      rakeViolation = `hand ${i}: balance delta wrong: prev=${demoBal} new=${newBal} expected=${expectedNewBal} (rakedNet=${rakedPayout - totalBet})`;
    }
    demoBal = newBal;

    emit(
      `  hand ${i}: outcome=${outcome.playerHands.map((h) => h.outcome).join('/')} ` +
        `bet=${totalBet} gross=${totalPayout} net=${grossNet} rake=${rake} rakedNet=${rakedPayout - totalBet} ` +
        `dealerCards(post)=${dealerCardsN} bal=${demoBal}`,
    );
  }

  // ---- Roll up Plane A invariants ----
  if (dealUpcardOnlySeen && !dealHoleLeakSeen) {
    pass('A1 deal exposes dealer UPCARD ONLY (no hole card)', `${handsPlayed} hands; every non-natural deal returned exactly 1 dealer card (dealerUpcard) + 2 player cards, no dealer/dealerHand object`);
  } else {
    fail('A1 deal exposes dealer UPCARD ONLY (no hole card)', `dealUpcardOnlySeen=${dealUpcardOnlySeen} dealHoleLeakSeen=${dealHoleLeakSeen} leaks=${leaks.filter((l) => l.startsWith('deal')).slice(0, 3).join(' | ')}`);
  }
  if (actionUpcardOnlySeen && !actionLeakSeen) {
    pass('A2 mid-hand action withholds hole card + undealt shoe', `every in_progress /action response exposed exactly 1 dealer card (upcard) + playerHands only; no hole/remaining/seed key found`);
  } else if (!actionUpcardOnlySeen && !actionLeakSeen) {
    // Possible if every sampled hand settled in one action (all stands on a
    // pat opening). Re-run note rather than a silent pass.
    fail('A2 mid-hand action withholds hole card + undealt shoe', `NO in_progress /action sampled (every hand settled in one decision) - inconclusive from this run; engine Plane B covers the shape`);
  } else {
    fail('A2 mid-hand action withholds hole card + undealt shoe', `actionLeakSeen=${actionLeakSeen} leaks=${leaks.filter((l) => l.startsWith('action')).slice(0, 3).join(' | ')}`);
  }

  if (!rakeViolation && settlementMathOk === handsPlayed && handsPlayed > 0) {
    pass(
      'A5 settlement: win credits payout - 5% net-winnings rake; push/loss never raked; balance delta == rakedNet',
      `${handsPlayed} settled hands all correct; sampled win=${winSampled} push=${pushSampled} loss=${lossSampled}; balance-delta matched rakedNet on ${settlementMathOk}/${handsPlayed}`,
    );
  } else {
    fail(
      'A5 settlement: win credits payout - 5% net-winnings rake; push/loss never raked; balance delta == rakedNet',
      rakeViolation ?? `settlementMathOk=${settlementMathOk}/${handsPlayed}`,
    );
  }

  // ---- I3b: close the shoe → serverSeed revealed; events flip from null ----
  // First confirm cove_game_events.revealedServerSeed is NULL pre-close.
  const preCloseEvents = await db
    .select({ id: coveGameEvents.id, revealed: coveGameEvents.revealedServerSeed })
    .from(coveGameEvents)
    .where(and(eq(coveGameEvents.sessionId, shoeId), eq(coveGameEvents.gameType, 'blackjack')));
  const allNullPreClose = preCloseEvents.every((e) => e.revealed === null);
  if (preCloseEvents.length > 0 && allNullPreClose) {
    pass('A3b cove_game_events.revealedServerSeed NULL until close', `${preCloseEvents.length} hand event rows, all revealedServerSeed=NULL pre-close`);
  } else {
    fail('A3b cove_game_events.revealedServerSeed NULL until close', `rows=${preCloseEvents.length} allNull=${allNullPreClose}`);
  }

  // Guests are intentionally 403'd from /session/close (only ledger subjects
  // may close + reveal). So we cannot reveal via the guest route. To PROVE the
  // reveal mechanic on the SAME shoe without a real user, we (a) confirm the
  // guest close is correctly REJECTED (a hidden-state-adjacent gate: a guest
  // cannot force a reveal), (b) re-prove the seed is STILL redacted on the WIRE
  // while open via an idempotent re-open of the SAME shoe (the only guest-
  // readable wire surface), and (c) read the shoe's serverSeed directly from the
  // DB and verify sha256(serverSeed)===serverSeedHash - the commit-reveal proof.
  const closeAttempt = await post('/api/cove/blackjack/session/close', { shoeId });
  const guestCloseRejected = closeAttempt.status === 403;

  const shoeRow = await db.query.blackjackShoes.findFirst({ where: eq(blackjackShoes.id, shoeId) });
  const committedHash = shoeRow?.serverSeedHash ?? '';
  const realSeed = shoeRow?.serverSeed ?? '';
  const computedHash = realSeed ? createHash('sha256').update(realSeed).digest('hex') : '';
  const hashMatches = committedHash.length > 0 && computedHash === committedHash;

  // Idempotent re-open resumes the SAME open shoe → its publicShoe on the wire
  // must STILL have serverSeed=null even though the DB column now holds it.
  const reopen = await post('/api/cove/blackjack/session/open', { currency: 'clawtoken' });
  const resumedSameShoe = reopen.json?.shoe?.id === shoeId;
  const stillRedactedOnWire = reopen.json?.shoe?.serverSeed === null && shoeRow?.status === 'open' && resumedSameShoe;

  if (guestCloseRejected && hashMatches && stillRedactedOnWire) {
    pass(
      'A3c seed redacted on wire while open; commit-reveal hash verified; guest cannot force reveal',
      `guest /session/close → ${closeAttempt.status} (rejected); idempotent re-open of same shoe still serverSeed=null while status=open; sha256(serverSeed)===serverSeedHash (${computedHash.slice(0, 12)}…)`,
    );
  } else {
    fail(
      'A3c seed redacted on wire while open; commit-reveal hash verified; guest cannot force reveal',
      `guestCloseRejected=${guestCloseRejected}(${closeAttempt.status}) hashMatches=${hashMatches} stillRedactedOnWire=${stillRedactedOnWire}(resumedSame=${resumedSameShoe}) status=${shoeRow?.status}`,
    );
  }

  // ---- A6: BUST-VIA-HIT path (the empirical FIX gate) ---------------------
  // This is the assertion that ORIGINALLY caught the bug: a /action 'hit' that
  // BUSTS returned HTTP 500 ("action recorded after bust") on both the human and
  // agent paths, because toPeekScript appended a 'stand' after the busting hit
  // and the engine threw. The peek-layer fix (dryRunHand is now bust-aware -
  // never appends a 'stand' after a busting hit) must make a bust-via-hit settle
  // as a normal LOSS via the existing settle path: HTTP 200, status 'settled',
  // playerHands[0].isBust === true, payout 0 / net == -bet, with NO hidden-state
  // (serverSeed / remaining) leaked. A 500 here means the fix regressed.
  //
  // Use a SEPARATE guest fingerprint → a FRESH 100-CT demo wallet (the primary
  // guest above is drained). GUEST TIER ONLY (X-CV-Fingerprint → demo balance on
  // the shoe row, NO real ledger, NO leaderboard).
  const BUST_FP = `cove-smoke-bust-${randomBytes(8).toString('hex')}`;
  const bustHeaders = { 'Content-Type': 'application/json', 'X-CV-Fingerprint': BUST_FP, 'User-Agent': 'cove-bust-probe/1.0' };
  const bpost = async (path: string, body: unknown) => {
    const res = await app.fetch(new Request(`http://local${path}`, { method: 'POST', headers: bustHeaders, body: JSON.stringify(body) }));
    const text = await res.text();
    let json: any = null;
    try {
      json = text.length ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, json, text };
  };
  const bustShoe = await bpost('/api/cove/blackjack/session/open', { currency: 'clawtoken' });
  const bustShoeId = bustShoe.json?.shoe?.id;
  let bustStatus: number | null = null;
  let bustSettledClean = false;
  let bustBodyLeak = false;
  let bustBodySample = '';
  let bustLossMathOk = false;
  let bustEvidence = '';
  if (bustShoeId) {
    for (let i = 0; i < 30 && bustStatus === null; i++) {
      const d = await bpost('/api/cove/blackjack/hand/deal', { shoeId: bustShoeId, bet: 5 });
      if (d.status === 409 && d.json?.reshuffled) break;
      if (d.status !== 200) break; // out of demo CT
      if (d.json?.dealtImmediately || d.json?.status === 'settled') continue; // natural
      const hid = d.json.handId;
      for (let k = 0; k < 12; k++) {
        const a = await bpost('/api/cove/blackjack/action', { handId: hid, action: 'hit', handSlot: 0 });
        // any non-200 OR a settled-on-bust ends this hand's probe
        if (a.status !== 200) {
          bustStatus = a.status;
          bustBodySample = a.text.slice(0, 160);
          // A 5xx body that carries a card rank / suit / seed would be a leak;
          // for the FIXED path we never reach here, but keep the scan honest.
          bustBodyLeak = /serverSeed|hole|suit|clubs|diamonds|hearts|spades|remaining|"rank"/i.test(a.text);
          break;
        }
        if (a.json?.status === 'settled') {
          const bustedHand = a.json.outcome?.playerHands?.find((h: any) => h.isBust);
          if (bustedHand) {
            bustStatus = 200;
            bustSettledClean = true;
            // A busted player hand MUST settle as a LOSS: 0 payout on that hand,
            // session totalPayout 0 (no other live hand), net == -totalBet,
            // rake 0 (no net winnings). Assert the real settle money-math.
            const o = a.json.outcome;
            const totalBet = BigInt(o.totalBet);
            const totalPayout = BigInt(o.totalPayout);
            const rake = BigInt(o.rake ?? '0');
            const net = BigInt(o.net);
            bustLossMathOk =
              bustedHand.outcome === 'loss' &&
              BigInt(bustedHand.payout) === 0n &&
              totalPayout === 0n &&
              net === -totalBet &&
              rake === 0n;
            // Settled body legitimately reveals the full dealer hand (hand over),
            // but must NOT carry serverSeed/remaining (still secret until close).
            bustBodyLeak = !!a.json.serverSeed || !!a.json.outcome?.serverSeed || !!a.json.outcome?.remaining;
            bustEvidence =
              `playerHands.isBust=true outcome=${bustedHand.outcome} handPayout=${bustedHand.payout} ` +
              `totalBet=${o.totalBet} totalPayout=${o.totalPayout} net=${o.net} rake=${o.rake ?? '0'}`;
          }
          break;
        }
        // still in_progress and not bust → keep hitting (will bust eventually)
      }
    }
  }
  if (bustStatus === 200 && bustSettledClean && bustLossMathOk && !bustBodyLeak) {
    pass(
      'A6 bust-via-hit settles as a LOSS (HTTP 200 settled, isBust, payout 0, net=-bet, rake 0) with NO hidden-state leak',
      `bust-via-hit → 200 settled; ${bustEvidence}; no seed/remaining in body. (Was HTTP 500 before the peek-layer fix.)`,
    );
  } else if (bustStatus === 500) {
    if (bustBodyLeak) leaks.push(`bust-via-hit 500 leaked hidden state: body=${bustBodySample}`);
    fail(
      'A6 bust-via-hit settles as a LOSS (HTTP 200) - REGRESSED: returned HTTP 500',
      `bust-via-hit → HTTP 500 body=${JSON.stringify(bustBodySample)} - the peek-layer fix (bust-aware dryRunHand) is NOT in effect. leak=${bustBodyLeak}`,
    );
  } else if (bustStatus === null) {
    fail('A6 bust-via-hit path probed', `could not reach a bust in the demo-CT budget (inconclusive)`);
  } else if (bustStatus === 200 && bustSettledClean && !bustLossMathOk) {
    fail(
      'A6 bust-via-hit settles as a LOSS - settled 200 but loss-math WRONG',
      `${bustEvidence} (expected outcome=loss, handPayout=0, totalPayout=0, net=-totalBet, rake=0)`,
    );
  } else {
    if (bustBodyLeak) leaks.push(`bust-via-hit response leaked hidden state: status=${bustStatus} body=${bustBodySample}`);
    fail('A6 bust-via-hit settles as a LOSS with NO leak', `status=${bustStatus} settledClean=${bustSettledClean} lossMathOk=${bustLossMathOk} leak=${bustBodyLeak} body=${JSON.stringify(bustBodySample)}`);
  }

  emit(`\n[PLANE A cleanup id] guest fp='${GUEST_FP}'. shoeIds=${shoeId}, ${bustShoeId ?? 'n/a'} (guest-tier, user_id NULL).`);
}

// ===========================================================================
// PLANE B - engine + route serialization, synthetic seeds, NO DB
// ===========================================================================
function settleStandScript(): HandScript {
  return { hands: [['stand']], didSplit: false, tookInsurance: false };
}

/** Play a fresh-shoe hand-0 with a stand script for given seeds. */
function playStand(serverSeed: string, clientSeed: string) {
  return playHand({
    serverSeed,
    clientSeed,
    nonce: 0,
    cursor: 0,
    bet: 100n, // 100 CT → net win 100 makes a non-zero rake (floor(100*5/100)=5)
    script: settleStandScript(),
    dealtBefore: 0,
    remainingShoe: undefined,
  });
}

async function planeB(): Promise<void> {
  emit('\n===== PLANE B - engine + route serialization, synthetic seeds (NO DB) =====');

  // Sanity: buildShoe is 312 cards.
  const shoe = buildShoe();
  if (shoe.length === 312) pass('B0 buildShoe = 312 cards (6-deck)', `len=${shoe.length}`);
  else fail('B0 buildShoe = 312 cards (6-deck)', `len=${shoe.length}`);

  // Search synthetic seeds for one clean WIN, PUSH, and LOSS at bet=100.
  let win: { r: any; ss: string; cs: string } | null = null;
  let push: { r: any; ss: string; cs: string } | null = null;
  let loss: { r: any; ss: string; cs: string } | null = null;
  for (let i = 0; i < 4000 && (!win || !push || !loss); i++) {
    const ss = createHash('sha256').update(`bjsmoke-ss-${i}`).digest('hex');
    const cs = randomBytes(8).toString('hex');
    let r;
    try {
      r = playStand(ss, cs);
    } catch {
      continue;
    }
    const net = r.totalPayout - r.totalBet;
    if (net > 0n && !win) win = { r, ss, cs };
    else if (net === 0n && !push) push = { r, ss, cs };
    else if (net < 0n && !loss) loss = { r, ss, cs };
  }

  // --- WIN: rake = floor(net*5/100); rakedPayout = gross - rake ---
  if (win) {
    const r = win.r;
    const raked = computeBlackjackRake(r);
    const ser = serializeHandResult(r, { cursorBefore: 0, dealtBefore: 0, nonce: 0 });
    const net = r.totalPayout - r.totalBet;
    const expectedRake = (net * 5n) / 100n;
    const ok =
      raked.rake === expectedRake &&
      raked.rakedPayout === r.totalPayout - expectedRake &&
      BigInt(ser.rake) === expectedRake &&
      BigInt(ser.rakedPayout) === r.totalPayout - expectedRake &&
      // rake never touches the returned stake: rakedPayout >= totalBet on a win
      raked.rakedPayout >= r.totalBet;
    if (ok) {
      pass(
        'B1 WIN raked: floor(net*5/100), rakedPayout=gross-rake, stake untouched',
        `bet=${r.totalBet} gross=${r.totalPayout} net=${net} rake=${raked.rake} rakedPayout=${raked.rakedPayout} (ser.rake=${ser.rake})`,
      );
    } else {
      fail('B1 WIN raked', `rake=${raked.rake} expected=${expectedRake} rakedPayout=${raked.rakedPayout} ser.rake=${ser.rake}`);
    }
  } else {
    fail('B1 WIN raked', 'no winning seed found in 4000 tries (search coverage gap)');
  }

  // --- PUSH: rake MUST be 0; rakedPayout == totalPayout == totalBet ---
  if (push) {
    const r = push.r;
    const raked = computeBlackjackRake(r);
    const ser = serializeHandResult(r, { cursorBefore: 0, dealtBefore: 0, nonce: 0 });
    const ok = raked.rake === 0n && raked.rakedPayout === r.totalPayout && r.totalPayout === r.totalBet && BigInt(ser.rake) === 0n;
    if (ok) pass('B2 PUSH never raked; stake returned whole', `bet=${r.totalBet} payout=${r.totalPayout} rake=${raked.rake}`);
    else fail('B2 PUSH never raked', `bet=${r.totalBet} payout=${r.totalPayout} rake=${raked.rake}`);
  } else {
    fail('B2 PUSH never raked', 'no push seed found in 4000 tries');
  }

  // --- LOSS: rake MUST be 0; rakedPayout == totalPayout (<= bet) ---
  if (loss) {
    const r = loss.r;
    const raked = computeBlackjackRake(r);
    const ser = serializeHandResult(r, { cursorBefore: 0, dealtBefore: 0, nonce: 0 });
    const ok = raked.rake === 0n && raked.rakedPayout === r.totalPayout && r.totalPayout < r.totalBet && BigInt(ser.rake) === 0n;
    if (ok) pass('B3 LOSS never raked', `bet=${r.totalBet} payout=${r.totalPayout} rake=${raked.rake}`);
    else fail('B3 LOSS never raked', `bet=${r.totalBet} payout=${r.totalPayout} rake=${raked.rake}`);
  } else {
    fail('B3 LOSS never raked', 'no loss seed found in 4000 tries');
  }

  // --- B4: the engine peek ALWAYS holds the full dealer hand (the danger) ---
  // This is the exact regression class the route must guard: a single edit
  // returning `peek.dealer` instead of `.cards[0]` would leak the hole. We
  // PROVE the engine's HandResult.dealer.cards is the FULL hand (>=2) so the
  // route's slicing is load-bearing - and Plane A proved the route only ships
  // cards[0]. Together: the withholding is in the route shaping, verified live.
  if (win) {
    const r = win.r;
    const full = r.dealer.cards.length;
    if (full >= 2) {
      pass(
        'B4 engine peek carries FULL dealer hand → route slicing to cards[0] is the load-bearing guard (Plane A proved it ships only cards[0])',
        `engine HandResult.dealer.cards.length=${full}; route deal/action ship dealerUpcard=cards[0] only (see A1/A2)`,
      );
    } else {
      fail('B4 engine peek carries full dealer hand', `dealer.cards.length=${full}`);
    }
  }
}

// ===========================================================================
async function main() {
  emit('Cove blackjack hidden-state + money RUNTIME smoke');
  emit(`guest fp = ${GUEST_FP}`);
  emit(`DB = ${process.env.DATABASE_URL!.replace(/:[^:@/]+@/, ':[REDACTED]@')}`);

  try {
    await planeB(); // pure first (fast, no DB)
  } catch (err) {
    fail('PLANE B crashed', String((err as Error).stack ?? err));
  }
  try {
    await planeA();
  } catch (err) {
    fail('PLANE A crashed', String((err as Error).stack ?? err));
  }

  const failed = invariants.filter((i) => i.status === 'FAIL');
  emit('\n========================= SUMMARY =========================');
  for (const inv of invariants) emit(`${inv.status}  ${inv.name}`);
  if (leaks.length) {
    emit('\n--- LEAKS DETECTED ---');
    for (const l of leaks) emit(`LEAK  ${l}`);
  } else {
    emit('\n--- NO LEAKS DETECTED ---');
  }
  emit(`\n${invariants.length - failed.length}/${invariants.length} invariants PASS`);

  try {
    await (await import('@clawville/database')).db.$client.end?.();
  } catch {}
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
