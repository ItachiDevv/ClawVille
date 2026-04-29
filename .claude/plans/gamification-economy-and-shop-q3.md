# Gamification, Economy & Shop — Q3 Plan

> Drafted 2026-04-28. Consolidates: anti-farm, leaderboard rebalance, Player tier (account-without-agent), tutorial-quest server-side reward, multi-rail ClawToken top-up (fiat / SOL / USDC / $CLAWVILLE), agent-payment surfaces (Stripe ACP + MPP), first-party cosmetic shop, deferred agent CT→$CLAWVILLE redemption.
>
> **Author intent:** ship in 6 phases. Phases 1–3 run in parallel. Phase 4 depends on 3. Phase 5 gated by 7d post-launch data.
>
> **All §8 open questions closed 2026-04-28.**

---

## 0. Locked decisions

| # | Decision | Source |
|---|---|---|
| L1 | Single leaderboard with filter chips (`All` / `Players` / `Trainers`) — not separate boards | Q convo |
| L2 | New **Player tier**: account + pet, no agent, full leaderboard participation | Q convo |
| L3 | ClawTokens are the only in-game currency; multi-rail top-up; **$CLAWVILLE pays at 1.25× CT** (the discount) | Q convo |
| L4 | Agent CT → $CLAWVILLE redemption ships in **week 2** (~7d post-Phase-1 data), not 30d | Q convo |
| L5 | Cosmetics CT-only at base price; periodic CLV-exclusive limited drops for FOMO | Q convo |
| L6 | Tutorial-quest token rewards become **real** server-side credits via `creditClawTokens({reason: 'tutorial_quest'})` | Q convo |
| L7 | Anti-farm: **permanent** `fp_hash` + `ip_prefix_hash`, salted with `SERVER_SECRET`, ClawVille-scoped, never rotated | Q convo |
| L8 | Daily caps per `(subject, event_type, day)` — implemented as `LEAST(count, cap)` in scoring SQL | Q convo |
| L9 | Cosmetic catalog must exist BEFORE shop UI ships (Phase 3 gates Phase 4) | Q convo |
| L10 | Fingerprint stack = OSS `@fingerprintjs/fingerprintjs` | Q convo |
| L11 | Stripe Standard Account, **LLC merchant**, `STRIPE_SECRET_KEY` hard-required env (no graceful-degrade — repo is source-available, not fork-friendly) | Q1 |
| L12 | Stripe Tax enabled at launch — auto-collects EU VAT + US state sales tax for ~0.5% of fiat revenue | Q1 |
| L13 | $CLAWVILLE mint **verified** on-chain: `Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA`. **Token-2022 program**, 6 decimals, 999.98M fixed supply, no mint/freeze authority, no transfer fee. Need `@solana/spl-token@0.4+` or `@solana/kit` toolchain | Q2 |
| L14 | Float-tied CLV pricing via **DexScreener public API** (free, keyless, 300/min). Single call returns `priceUsd` + 24h change + liquidity. **Lazy fetch** on quote request (5-min server cache), JWT-signed quote ID with 5-min expiry | Q2 |
| L15 | Two CLV wallets only: **Inbound treasury** (receive-only) + **Payout reserve** (sends + holds ~5 SOL for fees/ATA rent). No separate operating wallet | Q3 |
| L16 | Log `usd_basis_at_receipt` on every CLV-touching `claw_token_transactions` row for accounting | Q3 |
| L17 | Identity-aware bot defense: Turnstile + honeypot **only on anonymous-checkout path**; authenticated humans + agents bypass | Q4 |
| L18 | Stripe ACP + MPP shipped in Phase 4 (Option A — single coherent payment surface, +1-1.5 weeks scope) | Q4 |
| L19 | Refund policy: auto-refund <$5 disputes within 24h, manual >$5, hard ban after 2 chargebacks. Crypto rails non-refundable. CLV-exclusive drops non-refundable | Q5 |
| L20 | Limited drops UX = B+C hybrid: visible to all with FOMO badge + countdown; CLV holders see "Buy Now"; non-holders see "🔒 Unlock with CLAWVILLE →" opening top-up preselected to CLV tab | Q6 |
| L21 | **Stripe SKUs = 4 CT bundles, NOT per-cosmetic** (Fortnite VBucks model). In-game items live in `cosmetic_skus` DB table, bought with CT in-game, never touch Stripe. Bundle tiers (USD): Starter 500 CT/$4.99 · Popular 1200 CT/$9.99 · Big 3500 CT/$20 · Whale 8000 CT/$30. CLV pay = +25% bonus on any tier (so Whale via CLV = 10,000 CT for $30) | Bundle convo |
| L22 | **Cosmetic catalog ships at whatever exists** — no minimum. First content = the 4 surfboards from the Reef Race session. Shop UI handles 1 or 1000 SKUs identically | Cosmetic convo |
| L23 | Cosmetic schema is **scope-aware + variant-aware**: SKUs have `scope` (`world`/`avatar`/`activity:reef-race`/`all`) and may have multiple `cosmetic_variants` rows (one per `rigType`) so e.g. sunglasses can have a Milady variant + a lobster variant. Reflects per-rig fitting requirements | Cosmetic convo |
| L24 | License tracking on cosmetic_skus: `attribution`, `attributionUrl`, `licenseSpdx` columns. Required because Sketchfab assets carry CC-BY etc. that demand in-app credit display | Cosmetic convo |
| L25 | **Three-track structure** replaces old Phase 3+4: Engine track (one-shot, ~1wk) + Storefront track (one-shot, ~2wk) + Content track (ongoing, drops as ready). Engine and Storefront ship independently; first content drop = the 4 surfboards | Cosmetic convo |

---

## 1. Brand Identity diff (proposed `CLAUDE.md` edit — apply same diff as Phase 1 PR)

Sign-off received from user 2026-04-28. Do NOT apply to disk yet — staged here so Phase 1 PR can include it.

### `## TOP PROJECT PRIORITIES` block — add Player tier + cosmetic shop carve-out

**Add to Priority #2 (Open agent onboarding):**

> Players can also onboard **without** an agent (Player tier). They get a pet, earn ClawTokens, rank on the leaderboard via human↔agent chats and activity matches. The "upgrade to Trainer" path (connect an agent) is non-destructive — pet, tokens, rank carry forward. Player ↔ Agent is one of the three first-class collaboration axes; it must be playable on its own.

**Add to Priority #3 (Free agent leaderboard):**

> Leaderboard ranks **all subjects** — Players (pet-only) and Trainers (agent-bound) on one board with filter chips. Same scoring engine, same weights, no fragmented surfaces. A Player's teacher chats and a Trainer's collab turns both feed the same `events` aggregation.
>
> **Cosmetic shop carve-out:** a first-party cosmetic shop (skins, hats, auras) IS allowed and is NOT a peer marketplace. Pricing in CT only; CT purchasable via fiat/SOL/USDC/$CLAWVILLE (with 25% bonus on CLV pay). The marketplace pause continues to apply to **peer skill commerce** (`bazaar_listings`, `auctions`, `published_skills`).

**Add to "Every PR" guard:**

> Cosmetic shop SKUs ship through Phase 3's asset pipeline; do not add a SKU without an existing `pet_skins` row + valid asset URL + 3da-validated mesh.

**Updated leaderboard weights (replace existing `Weights:` line):**

> Weights: `building.visited` 3 · `agent.chat.turn` 10 · `agent.collaboration.turn` 40 · `skill_md.fetched` 1 · unique `agent.connected` 1 · `identity.issued` 5 · `activity.match.placed` (1st=12, 2nd=6, 3rd=3, default=1). Daily caps per subject: chat=50, collab=50, building=10, skill_md=11, activity=10. Anti-farm: events tagged with `(fp_hash, ip_prefix_hash)`; events exceeding cap are scored at `LEAST(count, cap)`.

**Add new env vars to existing env section:**

> `STRIPE_SECRET_KEY` · `STRIPE_PUBLISHABLE_KEY` · `STRIPE_WEBHOOK_SECRET` · `FINGERPRINT_SECRET` (32-byte hex, server-generated, for fp_hash salting) · `CLV_INBOUND_TREASURY_PUBKEY` · `CLV_PAYOUT_RESERVE_PUBKEY` (+ encrypted SK via existing CF KEK) · `CLV_MINT = Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA` · `CLOUDFLARE_TURNSTILE_SITE_KEY` + `CLOUDFLARE_TURNSTILE_SECRET_KEY` · `STRIPE_AGENT_TOOLKIT_SCOPE_PREFIX` (for restricted key naming). **No price-oracle API key needed** — Jupiter Lite is keyless.

---

## 2. Phase 1 — Anti-farm + leaderboard rebalance + tutorial-quest server reward

**Goal:** unify scoring math, kill the tutorial-quest reward lie, lay anti-farm foundation. No new UI work. Backend-heavy.

### 2.1 DB migrations (`packages/database/src/schema/`)

```ts
// events.ts — add fingerprint columns
fpHash: text('fp_hash'),                 // sha256(SERVER_SECRET || browser_fp), nullable for server-emitted events
ipPrefixHash: text('ip_prefix_hash'),    // sha256(SERVER_SECRET || ip_first_3_octets)

// Index for cap-enforcement queries
index('idx_events_subject_type_day')
  .on(events.agentId, events.petId, events.eventType, sql`date_trunc('day', ts)`)
```

Backfill: leave existing rows NULL — pre-launch noise floor.

### 2.2 Fingerprint emission (`apps/web/src/lib/fingerprint.ts` — new file)

```ts
import FingerprintJS from '@fingerprintjs/fingerprintjs';
const fp = await FingerprintJS.load();
const { visitorId } = await fp.get();
// Sent on every event-emitting API call as X-CV-Fingerprint header
```

### 2.3 Server-side hashing (`apps/api/src/middleware/fingerprint.ts` — new)

```ts
import { createHash } from 'crypto';
const SERVER_SECRET = process.env.FINGERPRINT_SECRET;
export function fingerprintMiddleware(c, next) {
  const rawFp = c.req.header('X-CV-Fingerprint') ?? '';
  const ip = getClientIp(c.req.raw.headers);
  const ipPrefix = ip.split('.').slice(0, 3).join('.');
  c.set('fpHash', createHash('sha256').update(SERVER_SECRET + rawFp).digest('hex'));
  c.set('ipPrefixHash', createHash('sha256').update(SERVER_SECRET + ipPrefix).digest('hex'));
  await next();
}
```

Mount on every event-emitting route. Update `event-logger.ts` to read from context and write to `events.fpHash` / `events.ipPrefixHash`.

### 2.4 Scoring SQL rewrite (`apps/api/src/routes/leaderboard.ts:418-520`)

```ts
const AGENT_SCORE_WEIGHTS = {
  buildingVisit: 3,
  teacherChat: 10,
  collaboration: 40,
  skillFetch: 1,
  session: 1,
  identityIssued: 5,
} as const;
const ACTIVITY_PLACEMENT_WEIGHTS = {
  1: 12, 2: 6, 3: 3, default: 1,
} as const;
const DAILY_CAPS = {
  teacherChat: 50,
  collaboration: 50,
  buildingVisit: 10,
  skillFetch: 11,
  activity: 10,
} as const;
```

Wrap per-event `COUNT(*) FILTER (...)` in `LEAST(COUNT(*) FILTER (...), <cap>)` per `(subject_id, day)`. Inner CTE: per-day-per-event counts → cap → sum.

### 2.5 Pet-key path (groundwork for Phase 2 — does NOT ship Player UI yet)

Modify `buildAgentSnapshot` to UNION agent-keyed and pet-keyed rows. Result rows tagged with `subject_type: 'agent' | 'pet'` for Phase 2's filter chips.

### 2.6 Tutorial-quest server-side reward (kill the lie)

`POST /api/quests/tutorial/:id/claim` — server validates counter delta against the event log, calls `creditClawTokens({reason: 'tutorial_quest'})`, returns `{credited, balance}`. Update `apps/web/src/stores/quest.ts` to hit endpoint on completion. Toast displays the actual credit.

### 2.7 Doc updates (same diff)

- `CLAUDE.md` — Brand Identity block per §1
- `ARCHITECTURE.md` — Free Agent Leaderboard section: weights, caps, fingerprint columns
- `GameFeatures.md` — §6 Quests subsection: tutorial quests now credit server-side
- Town Guide knowledge in `packages/agent-templates/src/locations/town-guide.ts`: new weights, daily caps, "tutorial quests now pay tokens"

### 2.8 Done criteria

- [ ] Migration applied; new events carry fp/ip hashes
- [ ] Leaderboard JSON returns same shape (UI compatible)
- [ ] Existing test suite passes
- [ ] Browser smoke test: chat with town-guide → CT credit ≥1 lands; complete `first-steps` tutorial → CT credit lands
- [ ] Town Guide knowledge updated; chat "what are the leaderboard weights?" returns new numbers

---

## 3. Phase 2 — Player tier + single-board filter

**Goal:** account-without-agent path is fun and rankable.

### 3.1 Mode rename (`apps/web/src/stores/game.ts`)

`controlMode`: `'guest' | 'npc' | 'player' | 'trainer' | 'autonomous'` (was `explore | npc | player | autonomous`)

- `'guest'` = current `'explore'`
- `'npc'` = unchanged
- `'player'` = **NEW** (account + pet + no agent)
- `'trainer'` = renamed from existing `'player'` (account + pet + agent, manual)
- `'autonomous'` = unchanged

Migration: localStorage `'player'` → `'trainer'` on first load via zustand persist `migrate` fn, version bump.

### 3.2 Onboarding flow (`apps/web/src/app/onboarding/`)

Existing pet creator works without `platform_agent_id`. Add "Connect Agent (optional)" step:
- "Just play" → land in `/game` as Player
- "Connect agent" → existing modal → land as Trainer

### 3.3 Leaderboard UI filter (`apps/web/src/app/leaderboard/page.tsx`)

```
[ All ]  [ Players ]  [ Trainers ]    [ 24h ]  [ 7d ]  [ 30d ]  [ All ]
```

`?subject=all|players|trainers` query param. Backend filters on `subject_type` from §2.5.

### 3.4 Upgrade path

In-game button: "Upgrade to Trainer" appears for `controlMode === 'player'`. Opens existing agent-connect modal. On success, `controlMode → 'trainer'`. Pet/CT/rank unchanged.

### 3.5 Doc updates

- `GameFeatures.md` §1 (Game Modes): Player tier added, rename documented
- `CLAUDE.md` Game Modes block: same
- Town Guide knowledge: "you can play as a Player without an agent — connect one anytime to upgrade to Trainer"

### 3.6 Done criteria

- [ ] Sign up without connecting agent → land in `/game` with full pet
- [ ] Chat with town-guide → CT credit, leaderboard rank visible under "Players" filter
- [ ] "Upgrade to Trainer" → agent-connect modal flows correctly
- [ ] Existing Trainer flow unchanged (regression: existing test pets still work)

---

## 4. Phase 3 — Cosmetic asset pipeline + 55 SKU launch catalog

**Goal:** asset pipeline + equip/unequip plumbing + 55 SKUs ready before shop UI lands. **3da-led, parallel with Phases 1-2.**

### 4.1 DB schema

```ts
export const cosmeticSkus = pgTable('cosmetic_skus', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  category: text('category').notNull(),         // palette | hat | glasses | aura | particle | outfit
  displayName: text('display_name').notNull(),
  description: text('description'),
  rarity: text('rarity').notNull(),             // common | rare | epic | limited
  priceCt: integer('price_ct').notNull(),
  exclusiveCurrency: text('exclusive_currency'), // null | 'CLV'
  assetUrl: text('asset_url'),
  assetMeta: jsonb('asset_meta'),
  speciesFilter: text('species_filter').array(),
  availableFrom: timestamp('available_from'),
  availableUntil: timestamp('available_until'), // set for limited drops
  supplyCap: integer('supply_cap'),             // null = unlimited; Q6 hybrid uses for "Only 200 minted"
  createdAt: timestamp('created_at').defaultNow(),
});

export const petSkins = pgTable('pet_skins', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: uuid('pet_id').notNull().references(() => pets.id),
  skuId: uuid('sku_id').notNull().references(() => cosmeticSkus.id),
  acquiredAt: timestamp('acquired_at').defaultNow(),
  acquiredVia: text('acquired_via').notNull(),  // shop_ct | shop_clv | shop_sol | shop_usdc | shop_fiat | gift | reward
  equipped: boolean('equipped').notNull().default(false),
});
```

### 4.2 Asset production (3da-led, parallel)

| Type | Count | Asset cost | Pipeline |
|---|---|---|---|
| Color palettes | 30 (5 × 6 species) | ~1 day | Bake palette-grid texture; reuses UVs |
| Hats (universal) | 6 | ~3 days | Model + UV + 6 textures; head-bone anchor |
| Glasses (universal) | 4 | ~2 days | Same anchor pattern |
| Auras (TSL shader) | 8 | ~1 day | TSL fragment shader, no asset file |
| Particles (GPU sprite) | 4 | ~1 day | Reuses existing particle system |
| Premium VRM outfits | 3 | ~1 week | Marvelous Designer + bake; Milady-only |
| **Total** | **55** | **~2 weeks** | |

3da deliverables:
1. Bone-anchor pattern doc (`.claude/memory/threejs/patterns/cosmetic-bone-anchor.md`)
2. TSL aura shader template (`.claude/memory/threejs/patterns/aura-shader.md`)
3. Palette-swap pattern (`.claude/memory/threejs/patterns/palette-texture-swap.md`)
4. All 55 SKU assets in `apps/web/public/cosmetics/`
5. SKU seed script `packages/database/scripts/seed-cosmetics.ts`

### 4.3 Equip/unequip plumbing (no shop UI yet)

- `apps/web/src/lib/three/cosmetic-loader.tsx` — loads equipped SKUs per pet, applies anchors/shaders/textures
- `apps/web/src/components/game/cosmetic-drawer.tsx` — owned-SKU drawer with equip toggles
- `apps/api/src/routes/cosmetics.ts` — `GET /owned`, `POST /:skuId/equip`, `POST /:skuId/unequip`

### 4.4 Doc updates

- `3dStructure.md` — cosmetic anchor system, palette pipeline, aura shader budget
- `ARCHITECTURE.md` — `cosmetic_skus` + `pet_skins` tables, `/cosmetics` routes
- `GameFeatures.md` — cosmetic system overview (no shop yet)

### 4.5 Done criteria

- [ ] All 55 SKUs render correctly on a test pet (3da-validated screenshot per SKU)
- [ ] Equip/unequip works in drawer; persists across reload
- [ ] No frame-rate regression on Iris Xe (<5fps drop with 5 cosmetics equipped)
- [ ] Seed script populates `cosmetic_skus` from a manifest file

---

## 5. Phase 4 — Shop UI + multi-rail CT top-up + ACP/MPP agent payments

**Goal:** all six payment surfaces live, all four currency rails funded, shop UI consuming Phase 3 catalog. **Depends on Phase 3 SKU catalog. Phase 4 is the largest phase — ~2-2.5 weeks.**

### 5.1 Six checkout surfaces

| Endpoint | Auth | Who | Defense |
|---|---|---|---|
| `/topup/checkout/web` | Lucia cookie | Logged-in human | Standard rate limits |
| `/topup/checkout/anon` | Turnstile + honeypot | Unauthenticated checkout (signup-pay flow) | Strict per-fp + Turnstile + honeypot |
| `/topup/checkout/agent` | Phase 5.1 signed challenge | ClawVille-native agents | Standard rate limits, generous per-agent caps |
| `/acp/products` + `/acp/checkout/sessions` | Delegated payment spec from AI provider | ChatGPT/Claude/Milady users buying via assistant | Stripe handles fraud + signature verification against AI-provider PK |
| `/mpp/402` (one-shot) + `/mpp/recurring` | Stripe restricted key (`rk_*`) | Agent-as-principal autonomous payments | Stripe Radar + scoped-key rate limits |
| `/topup/sol`, `/topup/usdc`, `/topup/clv` | User wallet signature | Crypto rails (any tier) | x402 verification (existing) |

All write to `claw_token_transactions` with reasons: `topup_fiat_web | topup_fiat_anon | topup_fiat_agent | topup_acp | topup_mpp | topup_sol | topup_usdc | topup_clv`.

### 5.2 Conversion rates

| Rail | Backend | CT received |
|---|---|---|
| Fiat (Stripe Standard + Stripe Tax) | new `topup-fiat.ts` | `1 USD = 100 CT` |
| SOL | reuses Phase 4 x402 merchant | live SOL/USD × 100 |
| USDC | reuses x402 with USDC mint | `1 USDC = 100 CT` |
| **$CLAWVILLE (Token-2022)** | new `topup-clv.ts` (Token-2022 SDK path) | live CLV/USD × **125** (the 25% bonus) |

CLV pricing: lazy fetch from `https://api.dexscreener.com/latest/dex/tokens/<CLV_MINT>` on quote-request, parse `pairs[0].priceUsd`, 5-min server cache, JWT-signed quote with 5-min expiry. User's transfer must match the quoted rate. DexScreener is keyless, free, 300/min.

### 5.3 Identity-aware bot defense (L17)

| Auth class | Defense |
|---|---|
| Logged-in human (Lucia cookie) | Standard rate limits (10/hr IP, 5/hr fp, 20/day account) |
| Authenticated ClawVille agent (signed challenge) | Standard rate limits (60 checkout-init/hr per agent identity, 10× looser) |
| Stripe ACP/MPP-authenticated agent | Stripe handles fraud; our limits = generous per-agent caps |
| Anonymous traffic (no auth) | **Turnstile + honeypot + strict per-fp limits + 3-decline-per-IP-per-hour → 24h block** |

Honeypot/Turnstile only apply on `/anon` path. Agent paths bypass entirely.

### 5.4 Stripe + Stripe Tax + Radar

- Stripe Standard Account (LLC merchant) — application kicked off Day 1, expect 7-14d verification
- Stripe Tax enabled at launch (auto-collects EU VAT + US state sales tax, ~0.5% revenue)
- Stripe Radar Standard enabled with extra rules:
  - Block if CVC check fails
  - Block if zip/postal check fails
  - Block if `risk_level: 'highest'`
  - Block known card-tester BIN ranges (Stripe-maintained list)
- All checkout via Stripe Checkout (SAQ A PCI tier) — never collect card numbers on our forms
- Activity description on Stripe app: "Web-based game with virtual currency purchases for cosmetic items and digital content" (avoid "tokens", "rewards", "payouts" — high-risk-vertical triggers)

### 5.5 Shop UI (`apps/web/src/app/shop/page.tsx` — new)

- Grid of available SKUs from `GET /api/cosmetics/catalog`
- SKU detail modal: preview render, owned status, price in CT
- Buy button → if balance < price, opens top-up modal
- Top-up modal: 4 tabs (Fiat / SOL / USDC / CLV); CLV tab has prominent "+25% bonus" badge
- **Limited-drop carousel** at top:
  - Featured SKUs with `availableUntil` countdown ticker
  - "Limited Edition" badge
  - Serial cap if `supplyCap` set ("Only 200 minted")
  - **CLV holders** see standard "Buy with CLAWVILLE"
  - **Non-holders** see "🔒 Unlock with CLAWVILLE →" → opens top-up modal preselected to CLV tab with exact CLV amount pre-filled

### 5.6 Wallet-only Player path

Players without an agent who connect a Solana wallet pay SOL/USDC/CLV directly. New flow: `POST /api/wallet/connect-external` (signature-verified ownership) → top-up rails accept that wallet as source.

### 5.7 ACP server (`apps/api/src/routes/acp.ts` — new)

Implements [Agentic Commerce Protocol](https://docs.stripe.com/agentic-commerce/protocol):

```
POST /acp/products           — return SKU catalog in ACP format
POST /acp/checkout/sessions  — accept delegated payment spec; verify signature against AI provider PK
POST /acp/checkout/sessions/:id/complete — confirm payment + credit CT/equip SKU
```

Stripe Agent Toolkit (`@stripe/agent-toolkit`) handles JWT verification + checkout session creation. Restricted API Keys per ACP-onboarded AI provider for permission scoping.

### 5.8 MPP server (`apps/api/src/routes/mpp.ts` — new)

Implements [Machine Payments Protocol](https://stripe.com/blog/machine-payments-protocol):

```
GET  /mpp/quote?sku=…       — returns 402 Payment Required with payment instructions
POST /mpp/pay              — agent submits PaymentIntent token, server verifies via Stripe, credits SKU
POST /mpp/recurring        — recurring agent subscription for monthly CT auto-top-up
```

Standard 402-flow shape, similar to existing x402 plumbing.

### 5.9 Refund policy enforcement (L19)

Stored in TOS + applied in `apps/api/src/routes/refunds.ts`:

| Scenario | Action |
|---|---|
| User requests refund within 24h, CT unspent | Auto-approve, full Stripe refund |
| User requests refund within 24h, CT partially spent | Refund only unspent CT × top-up rate |
| User requests refund after 24h | Manual review queue, default no-refund |
| Stripe chargeback (any) | $15 fee absorbed; account flagged |
| 2nd chargeback | Account banned, all CT zeroed, SKU access revoked |
| ACP dispute | Routed to delegating user |
| MPP dispute | Routed to agent owner (per `rk_*` metadata) |
| CLV/SOL/USDC top-up | **Non-refundable** — stated upfront in checkout |
| CLV-exclusive limited drops | **Non-refundable** regardless of timing — final-sale class |

Threshold of `$5` for auto-refund (L19 update; was $10).

### 5.10 Anti-fraud

- Stripe charges held in escrow until `payment_intent.succeeded` webhook
- SOL/USDC/CLV tx confirmed via Helius webhook before CT credit (reuses x402)
- Idempotency keys on every top-up route
- Cloudflare Turnstile required ONLY on `/anon` checkout path
- Honeypot field on `/anon` checkout form — bots fill, humans don't, instant block

### 5.11 Doc updates

- `GameFeatures.md` — new shop section + 6-surface payment matrix + limited drop UX
- `ARCHITECTURE.md` — top-up routes, ACP/MPP routes, Stripe integration, idempotency contract, Token-2022 SDK note
- `CLAUDE.md` env vars (per §1)
- Town Guide knowledge: "you can buy ClawTokens with fiat, SOL, USDC, or $CLAWVILLE — paying with $CLAWVILLE gets you 25% more. Agents can pay too via Stripe ACP/MPP."

### 5.12 Done criteria

- [ ] Buy a SKU with each of 6 surfaces → SKU appears in drawer, equippable
- [ ] CLV path verifiably credits 1.25× CT vs. equivalent USD value at SOL/CLV price
- [ ] Stripe webhook idempotent under double-fire
- [ ] Player tier (no agent) can connect external wallet and pay
- [ ] ACP test: ChatGPT/Claude calls `/acp/checkout/sessions` with valid delegated payment → CT credits to delegating user
- [ ] MPP test: agent with restricted key calls `/mpp/quote` → `/mpp/pay` → SKU equipped
- [ ] Card-tester simulation (curl burst, 100 attempts/min) → blocked by Turnstile + 3-decline rule
- [ ] Stripe Tax dashboard shows EU VAT + US state sales tax accruing on test charges
- [ ] Refund <$5 within 24h auto-approves; >$5 hits manual queue

---

## 6. Phase 5 — Agent CT → $CLAWVILLE payout (gated by Week-1 data)

**Goal:** top-leaderboard agents redeem earned CT into $CLAWVILLE on-chain.

### 6.1 Calibration (Day 7 manual review)

After 7 days of Phase 1 data:

```sql
SELECT
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY weekly_ct) AS p50,
  percentile_cont(0.9)  WITHIN GROUP (ORDER BY weekly_ct) AS p90,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY weekly_ct) AS p99,
  MAX(weekly_ct)                                          AS top
FROM (
  SELECT subject_id, SUM(amount) AS weekly_ct
  FROM claw_token_transactions
  WHERE created_at > now() - interval '7 days' AND amount > 0
  GROUP BY subject_id
) x;
```

Set faucet so:
- p99 agent can redeem ~10% of weekly earnings to CLV
- Top agent capped at fixed CLV/week ceiling
- Below p50: redemption disabled

### 6.2 Implementation

```
POST /api/wallet/redeem-ct
  body: { amount: number, target: 'CLV' | 'SOL' }
  auth: signed challenge from agent identity key (Phase 5.1 reconnect pattern)
```

Backend:
1. Check eligibility (above p50 weekly, under weekly CLV cap)
2. Deduct CT via `claw_token_transactions` with `reason: 'redeem_clv'`
3. Sign + send **Token-2022** transfer from payout reserve to agent's pet wallet
4. Create ATA if recipient doesn't have one (~0.002 SOL rent)
5. Record on-chain tx hash on the ledger row
6. Log `usd_basis_at_receipt` (CLV price at moment of payout) for cost-basis tracking

Shared helper `clv-transfer.ts` reused from §5.2 (Token-2022 SDK path).

### 6.3 Doc updates

- `ARCHITECTURE.md` — payout route, two-wallet flow, eligibility logic, Token-2022 SDK note
- `CLAUDE.md` env vars per §1
- Town Guide knowledge: "top-ranked agents can redeem ClawTokens for $CLAWVILLE — eligibility resets weekly"

### 6.4 Done criteria

- [ ] Test agent on devnet redeems → on-chain CLV transfer confirms (Token-2022 path verified)
- [ ] Below-eligibility agent gets 403 with clear "earn more CT to qualify" message
- [ ] Weekly CLV cap enforced (second redemption past cap fails atomically)
- [ ] Idempotent under retry (same nonce = no double-pay)
- [ ] Payout reserve has ≥5 SOL on first deploy
- [ ] Telegram alert fires when payout reserve SOL < 1

---

## 7. Phase 6 — Periodic CLV-exclusive limited drops (ongoing)

**Goal:** sustained CLV utility via FOMO drops. Operational pattern.

### 7.1 Cadence

- Every 1-2 weeks: ship a single new SKU
- `exclusiveCurrency: 'CLV'`, `availableUntil: now + 7 days`
- Optional `supplyCap` for "Only 200 minted" treatment
- Each drop = ~1-2 days 3da work

### 7.2 UX (B+C hybrid per L20)

Same FOMO treatment for everyone:
- Featured carousel slot at top of shop
- Countdown ticker (`Drops in 23h 14m`)
- "Limited Edition" badge
- Optional serial cap badge ("Only 200 minted")
- Lock icon overlay on the SKU card

Differentiated click action:
- **CLV holder** → "Buy with CLAWVILLE" → direct purchase
- **Non-holder** → "🔒 Unlock with CLAWVILLE →" → top-up modal preselected to CLV tab with exact CLV amount pre-filled

After drop window expires:
- SKU stays in owners' inventories
- Shop carousel removes it
- Browse page tags as "Past Drop" — visible but unpurchasable

### 7.3 First drop ships when Phase 5 lands

Operational, no engineering ticket needed beyond "drop weekly."

---

## 8. Status

- **All 6 §8 questions closed 2026-04-28** (was: Stripe onboarding, $CLAWVILLE address, treasury funding, rate-limit thresholds, refund policy, limited-drops UX)
- **Brand Identity diff approved** — applies in Phase 1 PR
- **Master rewrite landed** — `origin/master` at `84bbcf7`. Push unblocked.
- **External setup owned by user:** (1) Stripe LLC account + Stripe Tax, (2) Cloudflare Turnstile site + keys
- **No external API keys to procure for engineering** — Jupiter Lite (price) keyless; FingerprintJS OSS keyless; FINGERPRINT_SECRET generated server-side
- **Next action:** branch `gamification-q3-phase1` off `origin/master` (`84bbcf7`), implement §2, open PR with Brand Identity diff inline

---

## 9. Anti-pattern checklist (pre-merge guard for every phase)

- [ ] No SKU shipped without an asset file 3da-validated on a test pet
- [ ] No top-up route shipped without idempotency key + webhook signature verification
- [ ] No leaderboard event shipped without fp_hash population (server falls back to a hash of UA + IP if header missing — never NULL)
- [ ] No tutorial quest shipped with informational-only token rewards
- [ ] No CLV-exclusive drop without a non-holder unlock CTA (the lock must always have a doorway)
- [ ] Town Guide knowledge updated same diff as every gameplay change
- [ ] Brand Identity diff (§1) lands in Phase 1 PR — not deferred
- [ ] Token-2022 SDK path used for any CLV transfer (never classic SPL Token); spawn solana-dev for CLV transfer code
- [ ] Stripe Tax confirmed enabled before any production charge
- [ ] Identity-aware defense gates (Turnstile/honeypot) NEVER applied to authenticated agent paths
- [ ] Anti-bot challenges (Turnstile, honeypot, behavioral fingerprint) NEVER appear on any endpoint with `agent`, `acp`, or `mpp` in its path — those endpoints validate via cryptographic auth, not human-vs-bot heuristics. Violation = brand-identity contradiction

---

## 10. File-by-file quick index

| File | Phase | Action |
|---|---|---|
| `packages/database/src/schema/events.ts` | 1 | add fp_hash, ip_prefix_hash + index |
| `apps/web/src/lib/fingerprint.ts` | 1 | new — FingerprintJS wrapper |
| `apps/api/src/middleware/fingerprint.ts` | 1 | new — server hash |
| `apps/api/src/routes/leaderboard.ts` | 1 | rebalance weights, daily caps, pet-keyed UNION |
| `apps/api/src/services/event-logger.ts` | 1 | persist fp/ip hashes |
| `apps/api/src/routes/quests.ts` | 1 | tutorial-quest server reward route |
| `apps/web/src/stores/quest.ts` | 1 | hit reward endpoint on completion |
| `apps/web/src/stores/game.ts` | 2 | controlMode rename + migration |
| `apps/web/src/app/onboarding/` | 2 | optional-agent step |
| `apps/web/src/app/leaderboard/page.tsx` | 2 | filter chips |
| `packages/database/src/schema/cosmetics.ts` | 3 | new — cosmetic_skus, pet_skins |
| `apps/web/src/lib/three/cosmetic-loader.tsx` | 3 | new — equip/render |
| `apps/web/src/components/game/cosmetic-drawer.tsx` | 3 | new — drawer UI |
| `apps/api/src/routes/cosmetics.ts` | 3 | new — owned + equip routes |
| `apps/web/public/cosmetics/` | 3 | 55 asset files |
| `packages/database/scripts/seed-cosmetics.ts` | 3 | new — SKU manifest seed |
| `apps/api/src/routes/topup-fiat.ts` | 4 | new — Stripe Standard, Stripe Tax |
| `apps/api/src/routes/topup-clv.ts` | 4 | new — **Token-2022 transfer + Birdeye lazy quote** |
| `apps/api/src/routes/topup-sol.ts` | 4 | new — reuses x402 plumbing |
| `apps/api/src/routes/topup-usdc.ts` | 4 | new — reuses x402 plumbing |
| `apps/api/src/routes/acp.ts` | 4 | new — ACP server endpoints |
| `apps/api/src/routes/mpp.ts` | 4 | new — MPP 402 + recurring |
| `apps/api/src/routes/refunds.ts` | 4 | new — refund policy enforcement |
| `apps/api/src/services/clv-transfer.ts` | 4,5 | shared Token-2022 transfer helper |
| `apps/api/src/services/clv-quote.ts` | 4 | new — DexScreener API, lazy fetch w/ 5-min cache + JWT-signed quote |
| `apps/web/src/app/shop/page.tsx` | 4 | new — grid + carousel + B+C hybrid |
| `apps/web/src/components/shop/limited-drop-card.tsx` | 4 | new — countdown + lock icon + CTAs |
| `apps/web/src/components/shop/topup-modal.tsx` | 4 | new — 4 tabs |
| `apps/api/src/routes/wallet-redeem.ts` | 5 | new — CT → CLV (Token-2022) |
| `packages/agent-templates/src/locations/town-guide.ts` | 1,2,3,4,5 | knowledge[] update each phase |
| `CLAUDE.md` | 1 | Brand Identity diff (§1) |
| `ARCHITECTURE.md` | 1,3,4,5 | per-phase additions |
| `GameFeatures.md` | 1,2,3,4 | per-phase additions |
| `3dStructure.md` | 3 | cosmetic anchor system |
