# Steam Packaging — Master Plan

**Research date:** 2026-04-17
**Research team:** 5 parallel ultrathink agents (policy, packaging, Steamworks, release, codebase audit)
**Status:** Research complete. Go/no-go decision pending human review + Valve pre-submission ticket.

This document synthesizes findings from five focused research docs. Read this first; drill into sub-docs as needed:

| # | Sub-doc | Scope |
|---|---|---|
| 01 | [`01-policy-and-legal.md`](./01-policy-and-legal.md) | Steam crypto/AI/online-only rules, acceptance probability, pre-submission email |
| 02 | [`02-packaging-and-build.md`](./02-packaging-and-build.md) | Electron vs Tauri, code signing, WebGPU/Iris Xe, CI pipeline |
| 03 | [`03-steamworks-integration.md`](./03-steamworks-integration.md) | `steamworks.js` integration, Steam auth → Lucia federation, achievements |
| 04 | [`04-depots-release-store.md`](./04-depots-release-store.md) | SteamPipe, store assets, Steam Deck Verified, launch checklist |
| 05 | [`05-codebase-audit-and-gate-plan.md`](./05-codebase-audit-and-gate-plan.md) | File:line strip/gate plan for wallets + marketplace, AI disclosure inputs |

---

## TL;DR

- **Can we ship to Steam as-is? No.** As architected on 2026-04-17, ClawVille simultaneously trips three Valve policies: Rule 13 (blockchain content), Rule 15 (payment-processor-risk marketplaces), and the 2026-01-16 live-AI guardrails requirement. Estimated acceptance probability **~10–20%**.
- **Can we ship with rework? Yes, probably.** Applying the Sister-Build pattern (Off The Grid / Sparkball / Champions Ascension precedent) plus a real AI moderation layer plus a pre-submission Steamworks ticket raises acceptance to **~75–85%**.
- **Recommended path:** Electron 41.2.1 + `steamworks.js` + remote-load against `https://clawville.world/game?build=steam`. Windows-only, paid $9.99, single depot, v1 ships without Steam Deck certification. macOS/Linux deferred to v1.1.
- **Biggest blocker (non-technical):** The public landing page at `apps/web/src/app/page.tsx` is a crypto-token marketing site (Solana CA, `$CLAWVILLE` tokenomics, Pump.fun/Raydium/4meme launch cards). Steam reviewers will click the website link from the store page → instant rejection. Requires either a Steam-clean host or a full page fork. **Non-negotiable.**
- **Biggest blocker (technical):** Rule 13 must be **compiled out** of the Steam binary, not runtime-feature-flagged. A `NEXT_PUBLIC_BUILD_TARGET=steam` env check is not sufficient — Valve reviewers have rejected apps where crypto code was dead but present. Must use build-time dead-code elimination so the artifact has no Solana, wallet, or bazaar code at all.
- **Minimum time to Release Now button: ~10 weeks** (4 weeks Valve-gated + 4–6 weeks engineering in parallel). The 4-week Valve clock (2-week Coming Soon minimum + two 3–5 business day reviews) cannot be compressed.
- **Minimum out-of-pocket, Year 1:** ~$500 ($100 Steam Direct + $9.99/mo Azure Trusted Signing + $99 Apple dev, deferred). Store art budget separate.
- **One decision needs the user before engineering starts:** Do we fork `page.tsx` into a Steam-clean variant at `clawville.world/game`, or stand up a second host (e.g. `steam.clawville.world` or `clawville.com`) that is entirely crypto-free? This decision cascades into the store page URL field and cannot be changed after submission.

---

## The Single Recommended Path

### Stack

| Layer | Choice | Rationale |
|---|---|---|
| Desktop wrapper | **Electron 41.2.1** (Chromium 146, Node 24) | Only wrapper with production-ready WebGPU across all three OSes; Tauri's WKWebView + WebKitGTK WebGPU are not ready |
| Build tool | **electron-builder 26** | Better Steam depot compatibility than electron-forge in 2026 |
| Steamworks binding | **`steamworks.js`** (ceifa's fork) | Actively maintained; `greenworks` is abandoned |
| Load mode | **Remote** against `https://clawville.world/game?build=steam` | Backend is already remote; bundling static Next.js export adds complexity with no benefit |
| Windows signing | **Azure Trusted Signing** ($9.99/mo) | Microsoft killed EV instant-trust in March 2024 — OV/EV certs no longer worth the price premium |
| macOS signing | `@electron/notarize` + `@electron/universal` | Standard 2026 flow |
| Updates | **SteamPipe depots only** (no electron-updater) | Steam users expect Steam to update their games |
| Auth federation | **`steam_id BIGINT UNIQUE` column on `users`** | Mirrors existing Phase 5 `identity_fingerprint` pattern, zero JOIN on hot session path |
| Auth validation | `POST /api/auth/steam` → `ISteamUserAuth/AuthenticateUserTicket/v1/` | Standard Valve pattern; mints a normal Lucia session cookie |
| Launch model | **Paid $9.99, Windows-only, single depot** | F2P tanks discovery weight without IAP; Early Access blocked (we're feature-complete) |
| Steam Deck | **Playable target, post-launch** | Verified requires work we can't do pre-launch; Playable is adequate for round 1 |

### Architecture

```
┌─────────────────────────────────────────┐
│        Steam Client (launches)          │
│  ↓ passes SteamAppId via env + ticket   │
├─────────────────────────────────────────┤
│   Electron 41.2.1 main process          │
│   - SteamAPI_Init()                     │
│   - getAuthTicketForWebApi()            │
│   - IPC to renderer                     │
├─────────────────────────────────────────┤
│   Electron renderer (BrowserWindow)     │
│   - loadURL('https://clawville.world/   │
│      game?build=steam&ticket=...')      │
│   - WebGPU w/ WebGL2 fallback           │
│   - X-ClawVille-Client: steam header    │
├─────────────────────────────────────────┤
│       clawville.world (existing)        │
│   - renders Steam-mode UI (crypto off)  │
│   - calls api.clawville.world           │
├─────────────────────────────────────────┤
│      api.clawville.world (existing)     │
│   - POST /api/auth/steam validates      │
│     ticket, mints Lucia session         │
│   - middleware 404s bazaar/wallet       │
│     routes when Steam header present    │
└─────────────────────────────────────────┘
```

---

## Phased Execution Plan

### Phase 0 — Pre-submission validation (MUST happen first, no engineering yet)

**Timeline:** 1–2 weeks elapsed (waiting on Valve response)

1. File a Steamworks support ticket asking explicitly whether our Sister-Build plan is acceptable given Rule 13. Draft email is in [`01-policy-and-legal.md`](./01-policy-and-legal.md). Contact: the `Steam Direct` submission channel; `steamdirect@valvesoftware.com` per prior research, to be confirmed in the policy sub-doc.
2. Register a Steamworks partner account and complete the tax/banking interview (required before we can see non-public partner docs).
3. Pay the $100 Steam Direct fee for one new AppId (placeholder — can reuse if Valve rejects the concept).
4. While waiting for Valve's response, kick off Phase 1 artwork and Phase 2 engineering in parallel.

**Gate:** If Valve's response is "no, even stripped," stop. Do not burn 6 engineering weeks.

### Phase 1 — Steam-clean surface (blocks CI build gate)

**Timeline:** ~1.5 weeks engineering

**Two load-bearing decisions for the user before engineering starts:**

1. **Landing page strategy.** Pick one:
   - **Option A (fast):** Build-time fork — `apps/web/src/app/(steam)/page.tsx` with crypto-free copy, served at `clawville.world/steam` or a subdomain. Store page website field points there.
   - **Option B (cleaner):** Stand up `clawville.com` or `play.clawville.world` as a separate Next.js deploy with a dedicated landing page. Web marketing site stays on `clawville.world`.
   - Recommended: **B**. Cleaner separation, no env-branching in the marketing hero. Prevents accidental re-surfacing of crypto copy if someone edits `page.tsx` later.

2. **NPC archetype lore rewrite.** 8 of 14 archetypes in `packages/shared/src/constants/avatar-archetypes.ts` have Solscan / hardware-wallet / Pump.fun strings in `bios[]`, `topics[]`, `knowledge[]`. These feed live Gemini prompts → Steam NPCs would talk crypto on-screen. Options:
   - **Option A:** Rewrite all 8 archetype lore files to remove crypto references entirely. Breaks consistency with web version.
   - **Option B:** Ship Steam-specific archetype overrides — `packages/shared/src/constants/avatar-archetypes.steam.ts` loaded when `STEAM_BUILD=true`. Preserves web lore.
   - Recommended: **B**. Keeps web game unchanged.

**Concrete engineering tasks (post-decisions):**

- [ ] New Next.js deploy for Steam-clean landing (if Option 1B)
- [ ] `packages/shared/src/constants/avatar-archetypes.steam.ts` with clean lore (if Option 2B)
- [ ] Audit + remove every `wallet` / `solana` / `$CLAWVILLE` / `CA:` string from 18 frontend components per [`05-codebase-audit-and-gate-plan.md`](./05-codebase-audit-and-gate-plan.md)
- [ ] Server-side middleware: if request has `X-ClawVille-Client: steam` header, 404 these routes: `/api/bazaar/*`, `/api/auctions/*`, `/api/items/*` (marketplace parts), `/api/agent/x402/*`, `/api/avatars/me/wallet*`, and the like (exact list in sub-doc 05)
- [ ] AI moderation layer for Gemini NPC output — required for Steam AI disclosure. Implement a light pre/post-filter (simple profanity + PII + off-topic detection) wrapping `apps/api/src/services/npc-conversation-engine.ts`. Log blocked output for audit.

### Phase 2 — Electron wrapper + Steamworks integration

**Timeline:** ~2–3 weeks engineering

- [ ] New workspace: `apps/desktop/` with `electron-builder.yml`
- [ ] Main process: `SteamAPI_Init`, `steam_appid.txt` dev file, `getAuthTicketForWebApi`, overlay enable, rich presence API, DRM wrapper ID set
- [ ] Renderer loads `https://clawville.world/game?build=steam&ticket={b64ticket}` with custom user-agent string `ClawVille-Steam/1.0`
- [ ] Error handling: `render-process-gone` → static `gpu-error.html`, `--force-webgl` launch flag, `--enable-unsafe-webgpu` Chromium switch
- [ ] WebGL2 fallback validated in-game (already exists in the PixiJS path, but Three.js WebGL2 is the preferred fallback — confirm with 3da)
- [ ] New backend route: `POST /api/auth/steam` — full sketch in [`03-steamworks-integration.md`](./03-steamworks-integration.md). Validates ticket via publisher API, upserts user by `steam_id`, returns Lucia session cookie
- [ ] DB migration: `ALTER TABLE users ADD COLUMN steam_id BIGINT UNIQUE NULL;` + relax `users_has_auth_method` CHECK to accept it as a third auth channel
- [ ] Publisher API key stored in Coolify env as `STEAM_PUBLISHER_KEY`
- [ ] 20 achievements registered in Steamworks + unlocked from existing quest SSE events (list in sub-doc 03)
- [ ] CI: GitHub Actions build matrix (windows-latest runner) → `@electron/forge` / `electron-builder` → artifact → SteamCMD upload via `game-ci/steam-deploy` action

### Phase 3 — Store page + art assets

**Timeline:** ~1–2 weeks (mostly art-dependent)

- [ ] Create Steamworks app record, set AppId
- [ ] 11-asset capsule pack: header (920×430), main capsule (616×353), small capsule (462×174), library capsule (600×900), library hero (3840×1240), library logo (1280×720), page background (1438×810), community icon (184×184), 5+ screenshots (1920×1080 minimum), trailer (MP4 H.264, ≤2GB, 1920×1080). Full spec table in [`04-depots-release-store.md`](./04-depots-release-store.md)
- [ ] Store page copy — short (300 char), about-the-game (long), system requirements, genre/tag selection, features list. **Must not mention blockchain, Solana, NFT, tokenomics, or any of the stripped features**
- [ ] Website URL field → points to Steam-clean host from Phase 1
- [ ] Pricing: $9.99 USD, auto-regional
- [ ] AI disclosure form: live-generated content box ✓; guardrails description = our moderation layer from Phase 1
- [ ] Online-only disclosure in store page description (required)
- [ ] Age rating: IARC questionnaire — anticipate T/12+ due to AI chat

### Phase 4 — Coming Soon → Release

**Timeline:** 4 weeks (Valve-gated, cannot be compressed)

1. Submit store page for review (3–5 business days)
2. Submit build for review (3–5 business days, can overlap with store)
3. Set Coming Soon date ≥ 2 weeks out from now
4. Marketing push during Coming Soon window
5. Release Now button unlocks after the 2-week minimum
6. Post-launch: submit Steam Deck compat for Playable rating; monitor review bombing; patch cadence ≥ monthly

---

## Cross-Agent Conflicts Resolved

1. **Policy says "compile out, not feature-flag" for Rule 13; codebase audit proposed `NEXT_PUBLIC_BUILD_TARGET=steam` runtime gates.**
   - **Resolution:** Both are true — the env flag is still used, but it must trigger **build-time** dead-code elimination (webpack `DefinePlugin` + tree-shaking) so the production Electron bundle literally does not contain the stripped modules. Runtime-only gates are insufficient per Valve's enforcement pattern. Engineering task: confirm webpack's tree-shaker drops the wallet/bazaar imports when the flag is set at compile time. Verify with `grep -r "solana\|wallet\|bazaar" dist/` against the Steam build artifact.

2. **Steamworks doc proposes account-linking modal for v1; Release doc treats it as v1 scope; prior research said v1.1.**
   - **Resolution:** Defer to v1.1 per the Steamworks lead. A Steam-first user with no prior web account just gets a fresh avatar via `/create-agent`; a web user who launches via Steam for the first time can't link in v1 — they get a new avatar. Messy but acceptable for v1. Ship linking in v1.1 once the flow is validated.

3. **Packaging doc picks remote-load; this requires the Steam-clean host to be live before the Electron build can boot; Phase 1 becomes a hard dependency for Phase 2.**
   - **Resolution:** Phases 1 and 2 can start in parallel, but Phase 2 **cannot ship CI artifacts** until Phase 1's host is reachable and returning Steam-clean HTML. Gate the Electron CI build on a smoke test that curls `clawville.world/game?build=steam` and greps the response for `solana|bazaar|wallet` — fail the build if any hit.

---

## Cost + Timeline Summary

| Item | Cost | Timing |
|---|---|---|
| Steam Direct fee (one AppId) | **$100** (refundable after $1k sales) | Phase 0 |
| Azure Trusted Signing (Windows) | **$9.99/mo** | Ongoing from Phase 2 |
| Apple Developer Program (macOS, deferred) | $99/yr | v1.1 |
| Publisher API key | $0 | Phase 2 |
| Store art assets (11 capsules + trailer) | **$500–2000** (contractor) or 0 (in-house) | Phase 3 |
| Engineering | ~**5–7 engineer-weeks active** | Phases 1 + 2 in parallel |
| **Year-1 out-of-pocket minimum** | **~$320 + $9.99 × 12 = ~$440** | |
| **Year-1 out-of-pocket with store art** | **~$1500–2500** | |
| **Minimum calendar time to Release Now** | **~10 weeks** (4 Valve + 6 parallel eng) | |

---

## Open Questions (need user or Valve input)

1. **Landing strategy — Option A (fork `page.tsx`) or Option B (new host)?** Cascades into DNS + store page URL.
2. **Archetype lore — rewrite all 8, or ship Steam-specific overrides?** Cascades into `avatar-archetypes.ts` refactor shape.
3. **AI moderation layer — in-house implementation or third-party (e.g. OpenAI Moderation API, Lakera, Azure AI Content Safety)?** Third-party is faster but adds a vendor dependency. Depends on user's cost tolerance.
4. **Will Valve actually accept the Sister-Build pattern for our specific case?** Needs pre-submission ticket response. Our Solana custodial wallets are closer to "stablecoin gaming" than a Web3 NFT marketplace — which is a novel case compared to the Off The Grid precedent.
5. **macOS/Linux v1.1 target — should we design the depot layout now to accommodate, or build Windows-only forever?** Affects `app_build.vdf` shape.

---

## Prerequisite Reading for Implementers

When you pick up any engineering task, read the relevant sub-doc first:

- Writing the Electron wrapper → read [`02-packaging-and-build.md`](./02-packaging-and-build.md) end-to-end
- Adding the `POST /api/auth/steam` route → read [`03-steamworks-integration.md`](./03-steamworks-integration.md) and cross-reference `apps/api/src/routes/auth.ts` + `packages/database/src/schema/users.ts`
- Stripping crypto/marketplace surface → start from the table in [`05-codebase-audit-and-gate-plan.md`](./05-codebase-audit-and-gate-plan.md) — every row is a concrete file:line task
- Store page work → [`04-depots-release-store.md`](./04-depots-release-store.md) has the exact asset dimensions
- Policy disclosures on store page → [`01-policy-and-legal.md`](./01-policy-and-legal.md) has the AI disclosure form answers + online-only wording

---

## Sources

Every claim in every sub-doc is cited against primary Valve documentation (partner.steamgames.com) or reputable secondary sources (VGC, Decrypt, GamesIndustry.biz) with date accessed 2026-04-17. See each sub-doc's References section for the full URL list.
