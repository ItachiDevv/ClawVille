# uOS Mini App Integration — Research + Scoping Plan

> Session 2026-08-11 ("uos"). Research deep-dive per CLAUDE.md Planning rule; the Milady
> analog is `docs/milady-integration-plan.md`. Phase 1 (embed enablement + manifest) ships
> with this doc; publish is a founder action (wallet signature in uOS Dev Portal).

**Last Audited:** 2026-08-12 — status block added: published live + Verified; launch
announcement on hold (team vacation).

---

## 0. STATUS — PUBLISHED LIVE 2026-08-11, VERIFIED BADGE CONFIRMED

- **Phases 1 + 2 are DONE.** Manifest + CSP live on prod (promotion PR #266, cherry-pick of
  the two uOS commits onto master). Founder published from the uOS Dev Portal 2026-08-11
  with the dedicated publisher wallet. Catalog API (`GET https://www.uos.agency/api/apps`)
  confirms: slug `clawville`, id `90193120-0894-470e-afc6-d25c2830a15e`,
  `authorVerified: true`. Store had 5 apps total at publish — ClawVille is the 2nd
  third-party Mini App ever (after Meridian's Mpay) and the only real game.
- **Launch announcement: ON HOLD (founder, 2026-08-12).** The Register B announcement
  banner (`branding/graphics/banner-uos-launch.html`, partner-magenta variant) + the X post
  copy are BOTH founder-approved ("good copy"). Posting waits until the team is back from
  vacation — do not post or schedule anything until the founder gives the word. When the
  hold lifts: render the template at 1965×800, post with the approved copy, and consider
  the §5 Phase-2 outreach step (uOS Featured slot + co-announcement — they already repost
  us).
- **Open follow-ups (unchanged):** store screenshots (`screenshots: []` — add under
  `apps/web/public/press/uos/`, a re-publish refreshes the listing in place) · optional
  10 USDC analytics unlock from the publisher wallet · Phase 3 ideas in §5 are not scope.

---

## 1. What uOS is (verified)

**uOS ("Universal Operating System", @Universal_O_S, uos.agency)** is a browser-based
desktop OS on **Base** where "humans and AI work as equal partners." It renders a desktop
shell (dock, windows, terminal, wallet menubar) in one tab. Verified live 2026-08-11:

- **Desktop + dock** with first-party apps: uTOKENIZE (ERC-20 launcher), uGAME (AI agent
  plays Game Boy), uWORK, Terminal, internal Browser, Settings.
- **App Store** (rocket dock icon): Featured Apps = 3 pre-installed first-party apps +
  exactly ONE third-party Mini App: **Mpay by Meridian** (our x402 fallback facilitator).
  ClawVille would be roughly the second third-party app ever listed, and the first real game.
- **Agent Marketplace** (storefront dock icon): a unified hire-an-agent catalog showing
  **721,797 agents** at check time (x402 Bazaar 1,000 · ERC-8004 720,312 via 8004scan ·
  Circle CAS 485 via agents.circle.com). Pay-per-call USDC on Base via x402
  (EIP-3009 `transferWithAuthorization`, gasless for the payer).
- **Assistant** with Agent Mode: classifies a request, opens an app, drives it, streams
  reasoning. Roadmap (not live): task escrow + settlement with challenge windows and a
  revenue split — conceptually adjacent to our SAP escrow work.
- **$uOS token**: Base `0xbE8728795b935bf6E2a9253Ce7a2Ef6fA831f51E` (migrated from Solana
  `79HZe…srHY`), supply 1,000,000, veUOS vote-escrow planned. DexScreener 2026-08-11:
  ~$0.31, **market cap ~$76k, liquidity ~$16k, near-zero daily volume**. X followers ~3.6k.

**Relationship context:** uOS's X account reposted ClawVille's 2026-08-06 post (the x402
on Solana July roundup quote). Meridian, our live x402 partner, built the first Mini App.
Circle amplification of uOS was noted by third parties in July. This is our ecosystem.

**Docs:** https://docs.uos.agency (llms.txt index). Key pages: `/developers/manifest`,
`/developers/publish`, `/developers/sdk`, `/developers/analytics`, `/os/app-store`,
`/os/marketplace`, `/os/assistant`, `/os/tokenomics`. Local snapshots saved to the session
scratchpad (`uos-docs/`).

## 2. Honest value assessment

- **Reach today is small.** ~3.6k followers, micro-cap token, catalog counts are
  aggregations of external registries, not their own users. Do not expect a user surge.
- **Cost is also small.** The whole integration is a static manifest + 2 CSP origins;
  everything else was already built for the Milady embed (frame-ancestors CSP,
  SameSite=None auth cookie).
- **The upside is positioning.** First real game in a Base-native agentic OS app store;
  early = featured placement; the store's other tenant is our existing partner Meridian;
  the Circle/Base/x402 orbit is exactly where ClawVille markets itself. Fits Priority #1's
  acquisition-channel pattern (like the Milady curated grid: secondary channel, funnel to
  direct web).
- **Strategic watch item:** uOS's task-escrow roadmap overlaps our three-way settlement
  arch (Covenant RECORDS · SAP ESCROWS · PayAI SETTLES). If their Assistant can one day
  hire ClawVille as an agent service, that is a real agent-economy bridge. Not build scope
  today.

## 3. How the platform works (tech digest)

### Manifest (`/.well-known/uos-app.json`)
- Served from OUR domain; uOS fetches it **server-side** at publish: 5s timeout, 512KB cap,
  **`redirect: 'error'`** (any 3xx fails — apex must answer directly), must be JSON 200.
- Required: `name`, `entry.type: "iframe"`, `entry.url` (public https, **same host as the
  manifest**). `author.wallet` (EVM) required only for Dev Portal publish and must equal
  the wallet that signs there.
- Optional: `slug`, `version`, `description` (≤4000), `icon`, `category`, `tags` (≤16),
  `screenshots` (≤12), `permissions` (allowlist), `price.amountUsdc` (absent = free),
  `signature` (domain-association, Verified badge).
- Permissions allowlist: `wallet:request`, `wallet:sign`, `filesystem:read/write` (app-
  scoped virtual FS), `network:fetch` (host proxy), `agents:call` + `storage:ipfs` (not
  implemented yet). Users review permissions before install; ADDING permissions later
  forces re-consent. Declare only what is used.
- Verified badge: sign `"uOS Mini App Domain Association v1\ndomain: <host>\nentry:
  <entry.url>\nwallet: <wallet lowercase>"` with `author.wallet` (EOA or EIP-1271/ERC-6492).
  No signature = listed Unverified (allowed). INVALID signature = publish fails.

### Publish (uOS Dev Portal, in-shell)
Connect wallet → enter domain → sign a free message (`uOS App Publish v1`, ±10 min
timestamp window, 10 req/min rate limit) → uOS fetches the manifest → **live in the store
immediately** (self-serve, registered `approved`; one catalog entry per domain;
re-publish refreshes in place; unpublish is soft-delete). Publisher analytics (installs,
opens, retention cohorts, sources, sessions) is a one-time 10 USDC unlock per wallet.
Payout wallet for future app-purchase revenue defaults to `author.wallet`.

### Runtime
Mini Apps run in an iframe on OUR origin with sandbox
`allow-scripts allow-forms allow-popups allow-modals allow-same-origin` and
`allow="clipboard-write"`. Wallet consent sheets render in uOS chrome ABOVE the iframe.
Optional App SDK (`https://www.uos.agency/uos-app-sdk.js`): `uOS.ready()` (dismisses
splash — the splash ALSO clears on the iframe `load` event, so the SDK is optional),
`uOS.getContext()` ({appId, user.address, theme, locale}), `uOS.wallet.request()`
(EIP-1193; reads free, writes = per-request consent), app-scoped FS, proxied fetch.

## 4. ClawVille readiness audit (verified 2026-08-11)

| Gate | Status | Evidence |
|---|---|---|
| Iframe embeddable | ✅ infra exists, uOS origins MISSING | `apps/web/next.config.mjs` `FRAME_ANCESTORS` (built for Milady embed) currently allows self/subdomains/localhost/app-schemes only; live header confirmed via curl. **Phase-1 fix: add uOS origins.** |
| X-Frame-Options | ✅ correctly absent | Milady work explicitly does not set it |
| Auth cookie in 3P iframe | ✅ | `apps/api/src/lib/auth.ts:56` — `sameSite: 'none'` in production (Milady embed work) |
| Guest play without cookies | ✅ | Explore/NPC demo modes; `/game` boots logged-out |
| Agent connect | ✅ unaffected | magic-link + `X-Clawville-Agent-Session` bearer — no cookies involved |
| Pointer lock / fullscreen | ✅ not used | grep: no `requestPointerLock` / `requestFullscreen` in `apps/web/src` — sandbox lacks both, and we need neither (drag camera + WASD + joysticks) |
| Top-nav / popups | ✅ | sandbox has `allow-popups`; external links must use `target="_blank"` (no `allow-top-navigation`) |
| Manifest hosting | ✅ trivial | Next.js serves `apps/web/public/.well-known/uos-app.json` statically at the exact path, 200 JSON, no redirect on the https apex |
| Cloudflare vs server-side fetch | ✅ likely fine | curl with non-browser UAs (`node`, `uOS-manifest-fetcher/1.0`) returns 200 through CF today; if publish still fails, add a CF WAF skip rule for `/.well-known/*` |
| Square icon at a live URL | ✅ | `https://clawville.world/press/brand/clawlogo-main.jpg` — 1280×1280, founder-blessed press asset |
| Service worker in 3P iframe | ⚠️ degraded, not fatal | SW + caches are storage-partitioned in embedded contexts (and blocked where 3P storage is blocked). Cold load inside uOS will be slower; must not crash — SW registration failure is already non-fatal |
| Chrome 3P-cookie phase-out | ⚠️ accepted risk | same risk profile already accepted for the Milady embed; guest + agent paths unaffected; revisit CHIPS `Partitioned` cookie attribute if login-in-iframe breaks |

## 5. Phased plan

### Phase 1 — Embed enablement + manifest (THIS DIFF, staging-first)
1. `apps/web/next.config.mjs`: add `https://www.uos.agency https://uos.agency` to
   `FRAME_ANCESTORS`.
2. `apps/web/public/.well-known/uos-app.json`: manifest with `name`, `slug`, `version`,
   `description` (brand-language compliant: no em dashes, never "casino", keeper phrase C),
   `icon` (press logo), `category: "Games"`, `tags`, `entry.url =
   https://clawville.world/game`, `permissions: []` (cleanest install sheet — we do not
   touch the uOS wallet in Phase 1). **No `author.wallet` yet** (founder decision), no
   `screenshots` yet (founder-picked at publish).
3. Same-diff docs: this file + `ARCHITECTURE.md` Last Audited + `deploy-status.md` on push.
4. Verify on staging: curl the manifest (200, JSON, no redirect), curl the CSP header,
   then boot the game inside a local test page that iframes staging with uOS's EXACT
   sandbox attributes and confirm world render + guest entry.

### Phase 2 — Publish (FOUNDER actions; blocked on decisions §6)
1. Founder picks/creates the **publisher EVM wallet** → we add `author.wallet` to the
   manifest (+ optional domain-association `signature` for the Verified badge — worth it,
   it is one message signature).
2. Founder signs off store copy + 2–4 screenshots (add under
   `apps/web/public/press/uos/`, reference in manifest).
3. Promote staging → master so the manifest + CSP are live on `clawville.world`.
4. Founder opens uOS → Dev Portal → connects the publisher wallet → enters
   `clawville.world` → Publish (free message signature). Listing is live immediately.
5. Optional: 10 USDC analytics unlock on the publisher wallet.
6. Browser-verify the live listing + install + boot inside the real uOS shell.
7. Outreach: uOS team for a Featured slot + co-announcement (Register B banner per
   `branding/BRAND.md`; X posts). They already repost us — warm intro.

### Phase 3 — Optional deepening (each its own scoped session; NOT committed scope)
- **In-shell polish:** load the uOS App SDK only when embedded (`window.parent !== window`),
  call `uOS.ready()`, read `getContext()` theme/locale. Perf note: third-party script on
  the game boot path — lazy-load, embed-only, Priority #1 applies.
- **Wallet greeting / SIWE bind:** `wallet:request` permission to recognize the uOS user's
  Base address and offer wallet-linked login. Adds a permission → re-consent prompt.
- **Base-rail vCLAW top-ups from the uOS wallet:** our x402 checkout already has Meridian
  EVM rails; a "pay from your uOS wallet" path is natural but is a money-path change →
  full money-review chain, E5 parity notes, token-economy owner.
- **Agent marketplace presence:** expose a ClawVille x402 service (CDP Bazaar listing)
  and/or an ERC-8004 identity so uOS's Assistant can hire ClawVille agents. This is the
  real agent↔agent bridge; scope with agent-protocol-partner + SAP context.
- **Watch:** uOS task-escrow launch vs our Covenant/SAP/PayAI three-way settlement.

## 6. Founder decisions (resolved 2026-08-11 — founder said "get started now, yes new EVM wallet")
1. **Publisher EVM wallet — RESOLVED:** fresh dedicated EOA
   `0x2F5AbfdA66e1eD6882255D35022fC9bafb724ff9`, generated 2026-08-11. Key custody per the
   PK posture: plaintext ONLY in the offline Desktop backup dir
   (`.uos-publisher-2026-08-11.json`, dotfile) + AES-256-GCM `.enc` in brain
   `keys/agent-economy/` (round-trip verified). Never committed, never in chat/docs.
2. **Entry URL — RESOLVED:** `/game` (founder did not object to the proposal).
3. **Store copy — SHIPPED** in the manifest; **screenshots — FOLLOW-UP** (optional field;
   a re-publish refreshes the listing in place once founder picks shots).
4. **Verified badge — RESOLVED:** domain-association signature generated with the
   publisher key and verified locally with viem `verifyMessage`; shipped in the manifest.
   Re-sign whenever `domain`, `entry.url`, or `author.wallet` changes. If the uOS publish
   ever fails with `Manifest signature invalid`, remove the `signature` field, publish
   Unverified, then debug (invalid signature hard-fails the publish; absent = allowed).
5. **Analytics unlock — OPEN** (10 USDC one-time from the publisher wallet; do after
   listing is live if wanted).
6. **Go/no-go — GO** (founder 2026-08-11). The Dev Portal publish click itself remains a
   founder browser action (wallet signature).

## 7. Rules compliance notes
- **Not the protected Hatcher partner surface**: no partner route/service/type touched; no
  `PROTOCOL_VERSION` bump (no agent-visible capability change); mock-Hatcher harness not
  required for this diff.
- **Three-surface knowledge rule**: not triggered — no gameplay/world/economy mechanic
  changes. Nori should NOT advertise app stores (precedent: Milady npm sideload was
  deliberately stripped from onboarding surfaces 2026-07-23; the universal magic link
  remains the single connect story).
- **E5 parity**: acquisition/distribution surface only; no new state-mutating feature; no
  new write path. Parity unaffected. PARITY note carried in the commit body regardless.
- **Brand**: manifest copy follows `docs/brand-language.md` (no em dashes, no "casino",
  keeper phrase C verbatim); icon is the founder-blessed press logo. Any launch banner
  later = Register B, `branding/BRAND.md`.
- **Perf (#1)**: Phase 1 adds zero bytes to any page load (static JSON + a response
  header). The uOS SDK, if ever added, must be embed-gated and lazy.

## 8. Risks
- **Platform risk:** uOS is early/micro-cap; the store could stall. Mitigation: near-zero
  integration cost, listing is soft-deletable, nothing couples into gameplay.
- **In-iframe login breakage** as browsers tighten third-party storage: guest + magic-link
  agent flows survive; human login may need CHIPS/`Partitioned` cookies later (shared fix
  with the Milady embed).
- **Impersonation window:** until we publish, anyone could publish a domain THEY control as
  "ClawVille" in the uOS store (uOS verifies domain control, not trademarks). Early
  publish + Verified badge closes squat risk on our own name/domain.
- **Iframe perf on weak GPUs** inside a busy shell: our Iris-Xe floor work helps; treat
  in-shell FPS as a Phase-2 verification item (browser-verify in the real uOS desktop).
