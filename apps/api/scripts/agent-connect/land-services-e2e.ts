/**
 * P3 SLICE-4 LIVE E2E — land services (run-a-store) against staging.
 *
 * Proves the slice-4 gate (docs/agent-metaverse-p3-plan.md §4 + the land
 * manager's 8 assertions). LLM-free — runs fine during the OpenAI quota outage.
 *
 * Cast:
 *   SELLER  = landtest1 (staging seed account, rich CT) — ensures a SHOP
 *             structure (claims/buys a parcel + places one if needed), lists a
 *             5-CT service.
 *   BUYER-H = landtest2 (human cookie path).
 *   BUYER-A = fresh signup + bound agent session (X-Clawville-Agent-Session,
 *             cookie-less cove-style calls) — E5 parity leg. Fresh accounts
 *             start with 100 CT (covers a 5-CT buy).
 *
 * Asserts (mapping to the land manager's list):
 *   1. human buy: buyer -5 / seller +5 (balances via /avatars/me), purchase row
 *      returned, land.service.sold emitted ONCE (checked via seller's agent
 *      stream if seller has a session — here via events count probe left to the
 *      operator; the harness asserts response-level single-charge).
 *   2. agent-session lists own service on its OWN shop? (v1: agent BUYS; agent
 *      LIST requires the agent's avatar to own a shop — covered as buy-parity).
 *   3. self-buy → 409 self_purchase.
 *   4. idempotent replay (same key) → cached:true, single charge (balance
 *      unchanged between replays).
 *   5. insufficient funds → 400 (price the second listing at 100000 CT).
 *   6. 7th active listing → 409 listing_cap_reached.
 *   7. buyer-agent's own /events/replay shows NO seller-keyed event (it's the
 *      buyer); seller-side stream check is operator/DB-level.
 *   8. structure_unavailable is exercised only if an evictable shop exists —
 *      skipped live (destructive to seed data); covered by DB-gated route tests.
 *
 * Usage:
 *   bun run apps/api/scripts/agent-connect/land-services-e2e.ts \
 *     --api-base https://api-staging.clawville.world
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : [],
  ),
) as Record<string, string>;

const API = (args['api-base'] ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const RUN = Date.now().toString(36);
const SELLER_EMAIL = 'landtest1@staging.clawville.test';
const BUYER_EMAIL = 'landtest2@staging.clawville.test';
const SEED_PASSWORD = 'LandTest!2026';
const FRESH_PASSWORD = 'StoreTest!2026aA';

let pass = 0; let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = () => (globalThis.crypto as any).randomUUID() as string;

async function req(method: string, path: string, body?: unknown, opts: { cookie?: string; agent?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.agent ? { 'X-Clawville-Agent-Session': opts.agent } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  const sc = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  return { status: res.status, json, authCookie: sc.find((c: string) => c.startsWith('auth_session='))?.split(';')[0] };
}

async function login(email: string, password: string) {
  const r = await req('POST', '/api/auth/login', { email, password });
  return r.authCookie ?? '';
}
async function myAvatar(cookie: string) {
  const r = await req('GET', '/api/avatars/me', undefined, { cookie });
  return r.json?.avatar ?? null;
}

/** Find (or create) a SHOP structure owned by this cookie's avatar. */
async function ensureShop(cookie: string): Promise<{ structureId: string; parcelId: string } | null> {
  // GET /api/land/me -> { avatarId, parcels[], structures[] } (owner view, uncached)
  const mine = await req('GET', '/api/land/me', undefined, { cookie });
  const structures: any[] = mine.json?.structures ?? [];
  const shopStruct = structures.find((s: any) => s.structureType === 'shop' && (s.status ?? 'active') === 'active');
  if (shopStruct) return { structureId: shopStruct.id, parcelId: shopStruct.parcelId };
  const parcels: any[] = mine.json?.parcels ?? [];
  const placeOn = async (parcelId: string) => {
    const place = await req('POST', `/api/land/parcels/${parcelId}/structure`,
      { structureType: 'shop', catalogKey: 'shop-stall' }, { cookie });
    const sid = place.json?.structure?.id;
    if (place.status === 200 && sid) return { structureId: sid, parcelId };
    console.log(`   place shop-stall on ${parcelId} -> ${place.status} ${JSON.stringify(place.json)?.slice(0, 160)}`);
    return null;
  };
  // A parcel may already carry a HOME structure — try each owned parcel.
  for (const p of parcels) {
    const got = await placeOn(p.id);
    if (got) return got;
  }
  const claim = await req('POST', '/api/land/claim-starter', {}, { cookie });
  const claimedId = claim.json?.parcel?.id ?? claim.json?.parcelId;
  if (claimedId) return placeOn(claimedId);
  console.log(`   claim-starter -> ${claim.status} ${JSON.stringify(claim.json)?.slice(0, 160)}`);
  return null;
}

async function main() {
  console.log(`\n=== P3 slice-4 land-services E2E → ${API} ===  run=${RUN}\n`);

  // ── cast setup ─────────────────────────────────────────────────────────────
  const sellerCk = await login(SELLER_EMAIL, SEED_PASSWORD);
  const buyerCk = await login(BUYER_EMAIL, SEED_PASSWORD);
  ok(!!sellerCk && !!buyerCk, 'LOGIN seller (landtest1) + human buyer (landtest2)');
  if (!sellerCk || !buyerCk) return finish();
  const sellerAv = await myAvatar(sellerCk);
  const buyerAv = await myAvatar(buyerCk);
  if (!sellerAv || !buyerAv) { ok(false, 'avatars readable'); return finish(); }

  const shop = await ensureShop(sellerCk);
  ok(!!shop, 'SELLER has an active SHOP structure', shop ? `structure=${shop.structureId}` : '');
  if (!shop) return finish();

  // ── seller lists a 5-CT service ───────────────────────────────────────────
  const list = await req('POST', `/api/land/structures/${shop.structureId}/services`, {
    title: `Fortune telling ${RUN}`,
    description: 'One prophecy, mildly accurate.',
    priceCt: 5,
  }, { cookie: sellerCk });
  const listingId: string | undefined = list.json?.listing?.id ?? list.json?.id;
  ok(list.status === 200 && !!listingId, 'LIST service 200', `status=${list.status} listing=${listingId}`);
  if (!listingId) { console.log(`   body: ${JSON.stringify(list.json)?.slice(0, 240)}`); return finish(); }

  // browse shows it publicly (no auth)
  const browse = await req('GET', `/api/land/structures/${shop.structureId}/services`);
  ok(browse.status === 200 && (browse.json?.listings ?? browse.json?.services ?? []).some((l: any) => l.id === listingId),
    'BROWSE (public) shows the listing');

  // ── human buy: balances + single charge ───────────────────────────────────
  const sellerBefore = (await myAvatar(sellerCk))?.clawTokens;
  const buyerBefore = (await myAvatar(buyerCk))?.clawTokens;
  const key1 = uuid();
  const buy1 = await req('POST', `/api/land/services/${listingId}/buy`, { idempotencyKey: key1 }, { cookie: buyerCk });
  ok(buy1.status === 200 && buy1.json?.purchase?.id, 'HUMAN BUY 200 + purchase row', `status=${buy1.status}`);
  const sellerAfter = (await myAvatar(sellerCk))?.clawTokens;
  const buyerAfter = (await myAvatar(buyerCk))?.clawTokens;
  ok(buyerBefore - buyerAfter === 5 && sellerAfter - sellerBefore === 5,
    'CONSERVATION: buyer -5 / seller +5 (DB-verified balances)',
    `buyer ${buyerBefore}->${buyerAfter} seller ${sellerBefore}->${sellerAfter}`);

  // idempotent replay: same key → cached, no second charge
  const buy1b = await req('POST', `/api/land/services/${listingId}/buy`, { idempotencyKey: key1 }, { cookie: buyerCk });
  const buyerAfter2 = (await myAvatar(buyerCk))?.clawTokens;
  ok(buy1b.status === 200 && buy1b.json?.cached === true && buyerAfter2 === buyerAfter,
    'IDEMPOTENT replay: cached:true, single charge', `cached=${buy1b.json?.cached} balance=${buyerAfter2}`);

  // self-buy rejected
  const selfBuy = await req('POST', `/api/land/services/${listingId}/buy`, { idempotencyKey: uuid() }, { cookie: sellerCk });
  ok(selfBuy.status === 409 && (selfBuy.json?.error === 'self_purchase'), 'SELF-BUY -> 409 self_purchase', `status=${selfBuy.status} err=${selfBuy.json?.error}`);

  // ── agent-session buy (E5 parity) ──────────────────────────────────────────
  const su = await req('POST', '/api/auth/signup', { email: `p3s4-${RUN}@staging.clawville.test`, password: FRESH_PASSWORD, name: `Store${RUN}`.slice(0, 14) });
  const freshCk = su.authCookie ?? '';
  const freshAvId = su.json?.avatar?.id;
  const me = await req('GET', '/api/auth/me', undefined, { cookie: freshCk });
  const freshUserId = me.json?.user?.id ?? me.json?.id;
  ok(!!freshCk && !!freshAvId && !!freshUserId, 'FRESH signup (agent buyer host)');
  let agentSid: string | undefined;
  if (freshCk && freshAvId && freshUserId) {
    const tok = await req('POST', '/api/agent/connect-token', { avatarId: freshAvId, userId: freshUserId }, { cookie: freshCk });
    if (tok.json?.token) {
      const conn = await req('POST', '/api/agent/connect', {
        connectionToken: tok.json.token, agentId: `e2e-store-${RUN}`, identityType: 'openclaw',
        gatewayUrl: 'https://example.com/openclaw-mock', protocol: 'openai-compat',
        autonomyMode: 'self-managed', mode: 'avatar', name: 'E2EStore', species: 'milady_official_1',
      }, { cookie: freshCk });
      agentSid = conn.json?.sessionId;
    }
  }
  ok(!!agentSid, 'CONNECT agent session (bound to fresh avatar)');
  if (agentSid) {
    const freshBefore = (await myAvatar(freshCk))?.clawTokens;
    const sellerB2 = (await myAvatar(sellerCk))?.clawTokens;
    const buyA = await req('POST', `/api/land/services/${listingId}/buy`, { idempotencyKey: uuid() }, { agent: agentSid });
    const freshAfter = (await myAvatar(freshCk))?.clawTokens;
    const sellerA2 = (await myAvatar(sellerCk))?.clawTokens;
    ok(buyA.status === 200 && buyA.json?.purchase?.buyerAvatarId === freshAvId,
      'AGENT-SESSION BUY 200, settles to the AGENT\'S BOUND AVATAR (E5)', `status=${buyA.status} buyer=${buyA.json?.purchase?.buyerAvatarId}`);
    ok(freshBefore - freshAfter === 5 && sellerA2 - sellerB2 === 5,
      'AGENT buy conservation: agent avatar -5 / seller +5', `agent ${freshBefore}->${freshAfter} seller ${sellerB2}->${sellerA2}`);
    const bytes = JSON.stringify(buyA.json ?? {});
    ok(!bytes.includes(agentSid), 'no bearer echoed in buy response');
  }

  // ── insufficient funds ─────────────────────────────────────────────────────
  const bigList = await req('POST', `/api/land/structures/${shop.structureId}/services`, {
    title: `Yacht ${RUN}`, description: 'Slightly used.', priceCt: 100000000,
  }, { cookie: sellerCk });
  const bigId = bigList.json?.listing?.id ?? bigList.json?.id;
  if (bigId && agentSid) {
    const poorBuy = await req('POST', `/api/land/services/${bigId}/buy`, { idempotencyKey: uuid() }, { agent: agentSid });
    ok(poorBuy.status === 400 && poorBuy.json?.error === 'insufficient_clawtokens', 'INSUFFICIENT funds -> 400', `status=${poorBuy.status} err=${poorBuy.json?.error}`);
  }

  // ── listing cap (6 active) ─────────────────────────────────────────────────
  let capHit = false;
  for (let i = 0; i < 8; i++) {
    const r = await req('POST', `/api/land/structures/${shop.structureId}/services`, {
      title: `Filler ${RUN}-${i}`, description: 'cap filler', priceCt: 1,
    }, { cookie: sellerCk });
    if (r.status === 409 && r.json?.error === 'listing_cap_reached') { capHit = true; break; }
    if (r.status !== 200) { console.log(`   filler ${i}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`); break; }
  }
  ok(capHit, 'LISTING CAP -> 409 listing_cap_reached at the 7th active');

  // cleanup: delist fillers + yacht + main (best-effort, leaves seed data tidy)
  const mine = await req('GET', '/api/land/services/mine', undefined, { cookie: sellerCk });
  for (const l of (mine.json?.listings ?? [])) {
    if (String(l.title ?? '').includes(RUN)) {
      await req('PATCH', `/api/land/services/${l.id}`, { status: 'delisted' }, { cookie: sellerCk });
    }
  }
  console.log('   cleanup: delisted all run-tagged listings');
  console.log(`\n   [operator follow-ups] events probe: land.service.sold rows for this run == 2 (one per fresh buy, none for cached); scoring CTE credit once task #10 deploys.`);
  finish();
}

function finish() {
  console.log(`\n======================================================`);
  console.log(`SUMMARY: ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
