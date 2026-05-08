# ClawVille → Steam Packaging Research

*Last audited: 2026-04-17*
*Author: Research pass (Opus 4.7, 1M context)*

---

## TL;DR

- **Shipping ClawVille on Steam is technically feasible but policy-risky.** The engineering is tractable (Electron wrapper around the existing Next.js/Three.js frontend, Steam Auth federated to our Lucia user/avatar model, SteamPipe uploads). The business risk is policy — see next bullet.
- **The single biggest blocker is Steam's blockchain/NFT ban.** Steam's onboarding rules still list "Applications built on blockchain technology that issue or allow exchange of cryptocurrencies or NFTs" as item #13 under "what you shouldn't publish." Our Solana custodial wallets, ClawToken economy, and skill marketplace trip this directly. ([Steam onboarding policy](https://partner.steamgames.com/doc/gettingstarted/onboarding))
- **The workaround is the "Off The Grid" playbook** — ship a *Steam build* that strips or gates all crypto features (wallet, bazaar, token buy/sell), keep the full-fat version on clawville.world, and handle Steam approval as a case-by-case discussion with Valve. Blockchain games have landed on Steam in 2025 (Off The Grid, Sparkball) by making Web3 strictly optional/external. ([CCN on OTG](https://www.ccn.com/news/technology/off-the-grid-first-blockchain-game-steam-crypto-ban/))
- **Steam Direct fee is $100 per app, recoupable after $1,000 adjusted gross revenue.** ([Steam Direct Fee doc](https://partner.steamgames.com/doc/gettingstarted/appfee))
- **AI/LLM disclosure is mandatory** for any content "consumed by players." ClawVille's NPC chat (Gemini-backed live generation) requires the live-generated disclosure plus a written description of guardrails. ([Steam AI policy rewrite 2026-01-17](https://store.steampowered.com/news/group/4145017/view/3862463747997849618))
- **Recommended tech path: Electron + electron-builder + `steamworks.js` (not Greenworks — it is effectively unmaintained).** Tauri's WebGPU on macOS/Linux is not production-ready yet and WebView2 WebGPU has rough edges; Electron's bundled Chromium gives us the same WebGPU runtime we ship today to browsers.
- **Online-only is fine.** Steam ships many always-online games; no formal Valve-enforced disclosure field exists beyond the system-requirements free-text + EULA, but community expectation is that we call it out explicitly on the store page. ([Steam community thread](https://steamcommunity.com/discussions/forum/10/3278065526397444667/))
- **Electron apps on Steam Deck Linux Runtime need care.** There is a documented incompatibility (libcups) when launched directly in SLR; ship Windows build + rely on Proton, or ship a native Linux build with Flatpak-style Electron deps. ([ValveSoftware/steam-runtime#579](https://github.com/ValveSoftware/steam-runtime/issues/579))
- **Estimated engineering cost: 4-6 engineer-weeks** for a viable Windows-first Steam release (Electron wrapper, Steam auth federation, crypto-features-stripped build variant, SteamPipe pipeline, store assets, first submission). macOS/Linux adds ~2 weeks each; Steam Deck Verified adds ~1-2 weeks of polish.
- **Out-of-pocket costs in year 1: ~$600-900** ($100 Steam Direct + $200-400 Windows OV code-signing cert + $99 Apple Developer if we ship macOS + optional $300 for trailer/capsule art if we don't produce them in-house).

---

## Recommended Path

**Electron wrapper over the existing Next.js frontend, connected to an unmodified `api.clawville.world` backend, with a Steam-build feature flag that disables the Solana/bazaar surfaces.**

### Why Electron over Tauri for ClawVille specifically

| Concern | Electron verdict | Tauri verdict |
|---|---|---|
| WebGPU on Windows | Chromium WebGPU, identical to what we test in browser today | WebView2 WebGPU works but has historically needed workarounds ([GH #6381](https://github.com/tauri-apps/tauri/issues/6381)) |
| WebGPU on macOS | Same Chromium WebGPU across platforms | WKWebView WebGPU is inconsistent — "Mac support is questionable" for GPU compute ([pkgpulse 2026 comparison](https://www.pkgpulse.com/blog/electron-vs-tauri-2026)) |
| WebGPU on Linux | Chromium handles it; same renderer everywhere | WebKitGTK lags upstream WebKit significantly |
| Steam SDK bindings | `steamworks.js` is Rust-NAPI, actively maintained, TS-first ([ceifa/steamworks.js](https://github.com/ceifa/steamworks.js/)) | Native Rust crate exists but less community proof-of-ship for full Steam overlay |
| Our Three.js code | Zero changes needed — renders in bundled Chromium | Would need per-platform WebView regression pass |
| Build artifact size | ~150-250 MB (acceptable for a Steam download) | ~15-30 MB (nicer, but not worth the GPU risk) |

**Decision:** Electron is boring and safe. The bundle size tradeoff (~200 MB vs 20 MB) is irrelevant for a Steam distributable where the baseline player expectation is 1-50 GB.

### Why `steamworks.js` over `greenworks`

- `greenworks` has been "updated on a best-effort basis" for years; community issues describe it as "effectively dead." ([greenheartgames/greenworks#306](https://github.com/greenheartgames/greenworks/issues/306))
- `steamworks.js` is Rust-backed, has TypeScript definitions, prebuilt binaries per platform, and is "great and very needed." ([ceifa/steamworks.js](https://github.com/ceifa/steamworks.js/))
- We get overlay, achievements, rich presence, `GetAuthTicketForWebApi`, cloud saves (we will not use — we have Supabase).

### Architecture sketch

```
┌──────────────── Electron main process ────────────────┐
│ - steamworks.js init (app_id from steam_appid.txt)    │
│ - window.loadURL('https://clawville.world/game?steam=1') │
│   OR bundled static export (see auto-update section)  │
│ - IPC bridge: steam:getAuthTicketForWebApi            │
│ - Steam overlay enabled (default in Chromium)         │
└────────────────────────────┬──────────────────────────┘
                             │ IPC
┌────────────────────────────▼──────────────────────────┐
│ Renderer (existing Next.js + Three.js + Zustand)      │
│ - Detects window.steam === true                       │
│ - Calls ipcRenderer.invoke('steam:getAuthTicket')     │
│ - POST /api/auth/steam with ticket                    │
│ - If build flag steam=true, hide wallet/bazaar UI    │
└────────────────────────────┬──────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼──────────────────────────┐
│ api.clawville.world (Hono on Hetzner — unchanged)     │
│ + NEW: /api/auth/steam — calls                        │
│   ISteamUserAuth/AuthenticateUserTicket on            │
│   partner.steam-api.com, receives SteamID64,          │
│   upserts row in users with steam_id column, issues   │
│   existing Lucia session cookie                       │
└────────────────────────────────────────────────────────┘
```

**The backend stays remote and unmodified for the Steam ship.** Clients who launch via Steam get a normal session cookie after ticket validation, and ClawVille behaves like it does on the web — except the wallet/bazaar UI is hidden behind a compile-time feature flag.

---

## Step-by-Step Execution Plan

### Phase 0 — Policy go/no-go (Week 0)

1. Open a Steamworks partner account under the ClawVille entity (not personal) and email `steamdirect@valvesoftware.com` with a plain-English description of the Steam build (no crypto, no wallet UI, no bazaar) to get a pre-commitment read from Valve before paying the $100. This is the Off The Grid playbook — confirm acceptance before investing engineering weeks.
2. If Valve pushes back, negotiate or abandon. Do **not** try to hide the crypto layer — Steam reviewers check game content during approval and a rejection creates a paper trail that poisons future attempts.

### Phase 1 — Steamworks partner onboarding (Week 1)

1. Complete digital paperwork (tax form, banking info, entity identity verification). Takes 3-10 business days for tax clearance. ([Steam Direct doc](https://partner.steamgames.com/doc/gettingstarted/appfee))
2. Pay $100 Steam Direct fee. App ID is issued within minutes.
3. Fill out the content survey — including the **AI disclosure form** (pre-generated=no, live-generated=yes, guardrails=describe Gemini prompt template + output moderation + NPC system prompt constraints). Reference: [Steam AI policy 2026-01-17 rewrite](https://store.steampowered.com/news/group/4145017/view/3862463747997849618).
4. Fill out the age rating content questionnaire. Steam's built-in survey is mandatory for Germany sale. ([Age Ratings Germany doc](https://partner.steamgames.com/doc/gettingstarted/contentsurvey/germany))

### Phase 2 — Feature-flag the crypto surface (Week 1-2)

1. Add `NEXT_PUBLIC_BUILD_TARGET` env var (`web` | `steam`). Default `web`.
2. Gate in `apps/web/src/components/`:
   - Wallet address display in avatar profile → hidden if `steam`
   - Bazaar / auction listings (`skill-marketplace`, any `bazaar_*` UI) → hidden if `steam`
   - ClawToken buy/cashout paths → hidden (ClawToken balance as an internal point system is fine; the cash-out/on-chain bridge is what trips Steam)
   - Any copy referencing "Solana," "crypto," "blockchain," "NFT," "wallet" → removed or replaced with "points"/"tokens"/"inventory"
3. Backend: add a `x-clawville-build: steam` header check on `/api/wallet/*`, `/api/bazaar/*`, `/api/treasury/*` — return 404 so even a tampered client can't reach them.
4. Keep all feature code in-tree — we do **not** fork the repo. A single codebase with build-time and request-time gating.

### Phase 3 — Electron wrapper (Week 2-3)

1. New workspace `apps/desktop/` with `electron-builder`, `electron-updater`, `steamworks.js`.
2. Main process:
   ```ts
   import { init, Client } from 'steamworks.js';
   init(Number(process.env.STEAM_APP_ID));
   const client = Client.init();
   ipcMain.handle('steam:getAuthTicketForWebApi', async () => {
     const ticket = await client.auth.getAuthTicketForWebApi('clawville');
     return ticket.getBytes().toString('hex');
   });
   ```
3. Renderer loads `https://clawville.world/game?build=steam` (hosted Next.js). Rationale: keeps Coolify as the single deploy pipeline and avoids having to re-package the frontend into the .exe on every game patch. Offline is not supported anyway — ClawVille requires the backend.
4. Alternative mode: static-export the Next.js app into the Electron bundle. More work, only useful if we want the binary to work when clawville.world is down (which it won't anyway, because the Hono API is the source of truth). Skip for v1.
5. Auto-update via `electron-updater` pointed at GitHub Releases or a private S3. Note: Steam's own client-version patching is an alternative that deprecates electron-updater — pick one. Recommend **Steam-native patching** via SteamPipe for v1 so Steam users never see an Electron-branded update dialog.

### Phase 4 — Steam auth federation (Week 3)

1. New route `POST /api/auth/steam` in `apps/api/src/routes/auth.ts`:
   ```ts
   const { ticket } = body; // hex string from client
   const res = await fetch(
     `https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/` +
     `?key=${STEAM_WEBAPI_KEY}&appid=${STEAM_APP_ID}&ticket=${ticket}`
   );
   const { response } = await res.json();
   if (response.params.result !== 'OK') return 401;
   const steamId64 = response.params.steamid;
   // Upsert user row with steam_id column, create Lucia session
   ```
2. DB migration: add `steam_id BIGINT UNIQUE` to `users` table (nullable — web users don't have one).
3. Frontend: if `window.isSteamBuild`, skip the Lucia signup/login flow and call `/api/auth/steam` on boot with the ticket from Electron IPC.
4. First-time Steam users auto-create an avatar using Steam `persona_name` as the default display name. Reference: [ISteamUser doc](https://partner.steamgames.com/doc/api/isteamuser).

### Phase 5 — Store page assets (Week 3-4, in parallel with 3-4)

Required graphical assets ([standard](https://partner.steamgames.com/doc/store/assets/standard) + [library](https://partner.steamgames.com/doc/store/assets/libraryassets)):

| Asset | Dimensions | Notes |
|---|---|---|
| Header capsule | 920 × 430 | Top of store page, recommended-for-you |
| Small capsule | 462 × 174 | Search results, lists (auto-scales to 184×69, 120×45) |
| Main capsule | 1232 × 706 | Front page carousel |
| Vertical capsule | 748 × 896 | Seasonal sales |
| Page background | 1438 × 810 | Optional; auto-generated from screenshot |
| Library capsule | 600 × 900 | Library overview |
| Library header | 920 × 430 | Library "Recent Games" |
| Library hero | 3840 × 1240 | Top of library detail page, 860×380 safe area |
| Library logo | 1280w or 720h PNG, transparent | Overlaid on hero |
| Screenshots | min 1920 × 1080, min 5 images | 16:9 |
| Trailer | 1080p MP4, 30s–2min recommended | Uploaded via partner backend |

Budget ~$300-1000 for capsule art + trailer if we outsource; less if we reuse the 3D scene in-engine for trailer capture via `screen-recorder`.

### Phase 6 — SteamPipe upload (Week 4)

1. Install Steamworks SDK, use `tools/ContentBuilder/` + `steamcmd.exe`. ([SteamPipe doc](https://partner.steamgames.com/doc/sdk/uploading))
2. Directory layout:
   ```
   ContentBuilder/
     content/windows/         # .exe, .dll, resources
     content/osx/             # .app bundle (if shipping macOS)
     content/linux/           # AppImage or tarball
     scripts/app_build_XXX.vdf
     scripts/depot_build_XXX_win.vdf
     scripts/depot_build_XXX_osx.vdf
     scripts/depot_build_XXX_linux.vdf
   ```
3. Use `preview 1` in the appbuild VDF for dry runs before the first real upload.
4. CI integration: `CM2Walki/steampipe` Docker image in GitHub Actions for reproducible builds. ([repo](https://github.com/CM2Walki/steampipe))
5. Branches: `default` (public), `beta` (opt-in testers), `internal` (password-gated pre-release).

### Phase 7 — Pre-release beta (Week 4-5)

1. Set app to "coming soon" store state, ship to `internal` branch, invite ~20 testers via Steam Keys.
2. Collect feedback on launcher startup, Steam overlay interaction, FPS vs web build, Steam friends integration.
3. Submit for Valve's content review (~2-5 business days). Anything flagged gets addressed.
4. If Valve flags the wallet/bazaar hiding as insufficient — escalate to the manual review contact we opened in Phase 0.

### Phase 8 — Release (Week 5-6)

1. Wait the mandatory **30 days** between first store page publish and release — Valve's cooldown for discoverability fairness.
2. Set pricing (recommendation: free-to-play given current business model, or $4.99-9.99 if we add a Steam-only cosmetics pack to justify pricing + align with the Steam Direct fee recoupment math).
3. Launch. Monitor Steam reviews + backend error rate for 72h.

### Phase 9 — Steam Deck + Linux (Optional, Week 6-8)

1. Electron on Linux in the Steam Linux Runtime has a known libcups crash ([issue #579](https://github.com/ValveSoftware/steam-runtime/issues/579)). Two options:
   - Ship Windows-only and rely on Proton (Electron-on-Proton works for many apps in 2026)
   - Ship a native Linux AppImage and disable SLR via the launch options escape hatch
2. Submit to Steam Deck Verified review — 2 days to 1 week turnaround. Criteria: on-screen keyboard works for text input (joystick/NPC chat), 30fps floor, controller support, 1280×800 UI readability. ([Deck Verified landing](https://www.steamdeck.com/en/verified))
3. ClawVille's current UI is mouse-and-keyboard first; Steam Deck polish is a real pass (gamepad navigation for chat, for inventory, for the agent-connect flow). Budget 1-2 weeks.

---

## Cost + Timeline Table

| Item | One-time | Annual | Notes |
|---|---|---|---|
| Steam Direct fee | $100 | — | Recoupable after $1K revenue |
| Windows OV code-signing cert | — | $200-400 | Sectigo/SSL.com — $200-300 entry, DigiCert $409/yr ([SSLinsights 2026](https://sslinsights.com/best-code-signing-certificate-providers/)) |
| Windows EV code-signing cert | — | $300-500 | Optional — EV removes SmartScreen warning faster; OV is fine for most indie |
| Apple Developer Program | — | $99 | Required for macOS notarization |
| macOS notarization | — | $0 | Included with Apple dev membership |
| Microsoft Trusted Signing (alternative) | — | $10-100/mo | Cloud-based; no HSM token required ([SSLinsights](https://sslinsights.com/best-code-signing-certificate-providers/)) |
| Capsule art + trailer (outsourced) | $300-1500 | — | Trailer can be self-captured |
| **Total Year 1 (Windows-only)** | **$400-1600** | **$200-500** | Lean case: $500 out the door |
| **Total Year 1 (Win + macOS)** | **$500-1700** | **$300-600** | Adds Apple dev |

### Engineer-week estimates

| Scope | Estimate |
|---|---|
| Phase 0 policy pre-check | 0.5 wk (calendar — mostly waiting for Valve reply) |
| Phase 1 onboarding + paperwork | 0.5 wk |
| Phase 2 feature flag crypto surface | 1 wk |
| Phase 3 Electron wrapper + steamworks.js | 1.5 wk |
| Phase 4 Steam auth federation | 0.5 wk |
| Phase 5 store assets | 1 wk (design-heavy) |
| Phase 6 SteamPipe CI | 0.5 wk |
| Phase 7 beta + Valve review | 1 wk (mostly calendar) |
| Phase 8 release + 30-day cooldown | 0.5 wk of active work during cooldown |
| **Windows-only total** | **~4-6 engineer-weeks active** + ~4-6 weeks calendar |
| Phase 9 macOS port | +2 wk (notarization + WKWebView regression) |
| Phase 9 Linux port | +2 wk (SLR workaround + AppImage) |
| Phase 9 Steam Deck Verified | +1-2 wk (controller UI polish) |

**Realistic shipping window:** 8-10 calendar weeks from "go" decision to first public release on Steam, Windows-only, assuming Phase 0 pre-check clears.

---

## Platform-Specific Notes

### Windows

- **Code signing is mandatory for a good first-run experience.** Unsigned Electron apps get SmartScreen warnings on download.
- OV cert costs $200-400/yr; signing requires an HSM/USB token as of the CA/B Forum 2023 rule. Microsoft Trusted Signing is a cloud alternative (~$10-100/mo) that skips the token. ([SSLinsights](https://sslinsights.com/best-code-signing-certificate-providers/))
- As of Feb 2026, CA/B Forum capped code-signing cert lifetime at 459 days — multi-year certs now ship as a new cert + new token each year.

### macOS

- Apple Developer Program ($99/yr) required.
- Must use hardened runtime + notarization. For Electron 12+, do **not** add `com.apple.security.cs.allow-unsigned-executable-memory` — that entitlement is only for Electron ≤11. ([kilianvalkhof guide](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/))
- Notarization submissions have been stuck "In Progress" for developers in March-April 2026 ([Apple Dev Forums](https://developer.apple.com/forums/thread/814827)) — budget buffer time on first submission.

### Linux

- Electron + Steam Linux Runtime has a known `libcups` conflict — document workaround or ship via Flatpak-style dependency bundling.
- Proton generally runs Electron Windows builds OK; could skip native Linux entirely.

### Steam Deck

- 1280×800 screen, 30 FPS floor for Verified, full controller navigation required.
- Current ClawVille is keyboard/mouse first; Verified = real polish work.
- On-screen keyboard via Steamworks bindings (`steamworks.js` has `activateGameOverlayToTextInput`) — the automatic keyboard pop-up is unreliable post-Proton-9.

---

## Risks + Blockers Specific to ClawVille

### 1. Crypto/Solana/Bazaar (CRITICAL)

**Risk:** Steam rejects the app at submission or retroactively removes it. [Policy](https://partner.steamgames.com/doc/gettingstarted/onboarding) is unambiguous.

**Mitigation:**
- Ship a Steam-specific build with wallet + bazaar + on-chain skill economy hidden via build flag
- Never reference Solana/crypto/NFT/blockchain in store copy, trailer, or screenshots
- Do not allow Steam accounts to reach the custodial wallet signup
- Get a written OK from Valve in Phase 0 before spending engineering weeks

**If Valve says no:** Abandon the Steam plan or ship a **much** more stripped version (essentially a demo — just the 3D world + NPC chat, no economy at all) as a marketing funnel back to clawville.world.

**Reference precedent:** Off The Grid (GUNZ chain) launched on Steam in June 2025 with blockchain features hidden from the Steam client — players who want on-chain play download a launcher from the OTG website. ([CCN](https://www.ccn.com/news/technology/off-the-grid-first-blockchain-game-steam-crypto-ban/)) Sparkball (Somnia) is on Steam with on-chain features gated outside Steam. ([CCN](https://www.ccn.com/news/technology/steam-web3-game-experimental/))

### 2. Payment-processor compliance (Rule 15, July 2025)

**Risk:** Steam added Rule 15 disallowing content "that may violate the rules and standards set forth by Steam's payment processors." Crypto-adjacent apps sit uncomfortably close to the categories payment processors police. ([Automaton](https://automaton-media.com/en/news/steam-rules-updated-to-prohibit-content-that-violates-rules-set-forth-by-payment-processors-and-banks/))

**Mitigation:** Same as #1 — no crypto surface, no mention of crypto.

### 3. Online-only requirement

**Risk:** ClawVille cannot run without `api.clawville.world`. There is no formal Steam toggle for "always online," but Steam players expect disclosure on the store page and in system requirements.

**Mitigation:**
- Explicit store-page language: "Requires a persistent internet connection and the ClawVille online service. Game content may become unavailable if service is discontinued."
- Add a graceful offline error screen in Electron that says so and links to a status page.
- Mirror the Helldivers 2 / Destiny 2 disclosure pattern — Steam has accepted many always-online games.

### 4. Gemini live-generated NPC chat — AI disclosure

**Risk:** Steam's 2026 AI disclosure policy requires us to disclose live-generated content AND describe guardrails. No disclosure = potential store removal.

**Mitigation:**
- Select "Live-Generated AI Content" in the content survey
- Describe guardrails: Gemini safety settings set to `BLOCK_MEDIUM_AND_ABOVE` across HARM_CATEGORY_* dimensions; NPC system prompts constrain output to in-world topics; no user-generated prompts routed directly to the model; output-level filter for IP references/profanity
- Disclosure text reference: [Steam AI policy rewrite](https://store.steampowered.com/news/group/4145017/view/3862463747997849618)
- **Hard rule:** Adult-only sexual content from live AI is absolutely prohibited — our NPC chat cannot produce this. Verify with a test suite before submission.

### 5. Age rating — AI-generated content flags

Some rating boards (USK, PEGI) in 2026 are starting to weight AI-generated content as a rating-up factor. IARC questionnaire answers will affect regional availability.

### 6. Steam Auth mapping to existing Lucia + avatar system

Low risk — just a schema migration (`steam_id` column) and a new `/api/auth/steam` route. Well-documented pattern. ([Steam Auth doc](https://partner.steamgames.com/doc/features/auth))

### 7. Steam Deck + Electron libcups bug

Medium risk if we target Deck Verified. Workarounds exist. If we only care about Windows + Proton on Deck, skip.

---

## Steamworks SDK Features — What We Want

| Feature | Use? | Notes |
|---|---|---|
| Auth (`GetAuthTicketForWebApi`) | YES | Required for federated login |
| Steam Overlay | YES (default) | Free with Electron + steamworks.js |
| Achievements | YES — ~30 to start | "First Avatar," "First NPC Chat," "First Building Entered," "Learned First Skill," "10 ClawTokens Earned" (no cash-out), etc. |
| Rich Presence | YES | "In Skill Forge," "Chatting with Sandy," "Exploring" |
| Cloud Saves | NO | We have Supabase — single source of truth |
| Stats (leaderboards) | MAYBE | We already have an internal leaderboard; Steam leaderboard is additive |
| Steam Input (controller) | YES for Deck | Controller-to-game-action mapping |
| Workshop | NO | Not applicable |
| Steam Networking | NO | Not a multiplayer match-based game |
| P2P / Lobbies | NO | Our world is authoritative server-side |
| Screenshots | YES (default) | F12 just works |
| Big Picture Mode | Handled by Steam Input | No extra work |

---

## Open Questions / Unknowns

1. **Will Valve accept a crypto-adjacent game even with the surface stripped?** Off The Grid and Sparkball precedents suggest yes, but Valve's case-by-case approach means no guarantee. **Must be resolved in Phase 0 before spending.**
2. **Does "persistent custodial wallet with no user-visible surface on Steam" still count as a blockchain app?** The onboarding rule says "built on blockchain technology that issue or allow exchange." Technically our backend does issue Solana keypairs even for Steam users — that might trip the rule even with UI hidden. Safer architecture: don't create a custodial wallet for Steam-auth'd users at all. Flag `users.wallet_generation_disabled = true` if `steam_id IS NOT NULL`.
3. **Electron + Three.js + WebGPU Chromium flags on Steam distribution.** Some WebGPU features may need `--enable-unsafe-webgpu` on Linux; verify early.
4. **Steam Direct 30-day cooldown exact current value.** Historical: 30 days between store page publish and release. Valve has adjusted this before. Confirm in Steamworks dashboard during Phase 1.
5. **Will Steam Input automatic "Desktop Configuration" interfere with our custom controls?** Likely fine for mouse-first UI, but need Phase 7 test on a physical Deck or Steam Input emulator.
6. **Notarization stability in April 2026.** Multiple reports of stuck "In Progress" status on Apple's notarization service. Budget time; consider delaying macOS to v1.1.
7. **LLM disclosure language granularity.** The 2026 policy rewrite is recent and the exact free-text expectations for "describe your guardrails" are still fuzzy — read the then-current content-survey field wording in Phase 1 and keep answers conservative.
8. **ClawVille's "open agent onboarding" priority #2.** Can a Steam-installed build still accept external agents via `/api/agent/connect`? Yes — the API is unchanged; the Steam client is just another user-side entry. But the skill marketplace (priority #3) is what we're gating, and that's where agents buy/sell. On Steam, agents can still *use* skills but not *trade* them. This is a material gameplay reduction — flag for product.

---

## References

### Valve / Steam official

- [Steam Direct Fee](https://partner.steamgames.com/doc/gettingstarted/appfee) — $100 fee, $1K recoupment
- [Onboarding — What You Shouldn't Publish](https://partner.steamgames.com/doc/gettingstarted/onboarding) — blockchain/NFT ban, item #13
- [Steam Distribution Agreement](https://partner.steamgames.com/doc/finance) — legal framework
- [Content Survey for Germany](https://partner.steamgames.com/doc/gettingstarted/contentsurvey/germany) — age rating mandatory for DE
- [User Authentication and Ownership](https://partner.steamgames.com/doc/features/auth) — GetAuthTicketForWebApi
- [ISteamUser API](https://partner.steamgames.com/doc/api/isteamuser) — SDK reference
- [Uploading to Steam (SteamPipe)](https://partner.steamgames.com/doc/sdk/uploading) — build pipeline
- [Builds](https://partner.steamgames.com/doc/store/application/builds) — branches, depots
- [Standard Store Graphical Assets](https://partner.steamgames.com/doc/store/assets/standard) — header, small, main capsule dimensions
- [Library Assets](https://partner.steamgames.com/doc/store/assets/libraryassets) — library capsule, hero, logo dimensions
- [AI Content on Steam — 2026 policy](https://store.steampowered.com/news/group/4145017/view/3862463747997849618) — disclosure requirements
- [Steam Deck and Proton](https://partner.steamgames.com/doc/steamdeck/proton) — compatibility layer
- [Deck Verified program](https://www.steamdeck.com/en/verified) — verification criteria

### Third-party & community

- [SSLinsights: Top Code Signing Certificate Providers 2026](https://sslinsights.com/best-code-signing-certificate-providers/) — OV/EV pricing
- [SSLinsights: OV vs EV for Windows](https://sslinsights.com/best-code-signing-certificate-windows-applications/)
- [SSL.com eSigner Pricing](https://www.ssl.com/guide/esigner-pricing-for-code-signing/)
- [ceifa/steamworks.js](https://github.com/ceifa/steamworks.js/) — recommended Steam SDK binding
- [greenheartgames/greenworks](https://github.com/greenheartgames/greenworks) — legacy, not recommended
- [electron/notarize](https://github.com/electron/notarize) — macOS notarization tool
- [electron-builder auto-update](https://www.electron.build/auto-update.html) — alternative to Steam patching
- [ValveSoftware/steam-runtime#579](https://github.com/ValveSoftware/steam-runtime/issues/579) — Electron + SLR libcups bug
- [CM2Walki/steampipe Docker](https://github.com/CM2Walki/steampipe) — CI image for SteamPipe uploads
- [Tauri WebGPU issue #6381](https://github.com/tauri-apps/tauri/issues/6381) — WebGPU + WebView2 status
- [Tauri v2 webview versions](https://v2.tauri.app/reference/webview-versions/) — WebView platform matrix

### News / Analysis

- [PC Gamer: Steam AI disclosure form update](https://www.pcgamer.com/software/ai/steam-updates-ai-disclosure-form-to-specify-that-its-focused-on-ai-generated-content-that-is-consumed-by-players-not-efficiency-tools-used-behind-the-scenes/)
- [PC Gamer: Steam bans NFT/crypto games (2021 origin)](https://www.pcgamer.com/steam-bans-nfts-cryptocurrencies-blockchain/)
- [CCN: Off The Grid on Steam](https://www.ccn.com/news/technology/off-the-grid-first-blockchain-game-steam-crypto-ban/)
- [CCN: Steam cautiously testing Web3 case-by-case](https://www.ccn.com/news/technology/steam-web3-game-experimental/)
- [Decrypt: Crypto/NFT games still launching on Steam despite ban](https://decrypt.co/153196/crypto-nft-games-still-launching-steam-despite-ongoing-ban)
- [Winston & Strawn legal analysis: Steam NFT ban implications](https://www.winston.com/en/blogs-and-podcasts/the-playbook/steam-bans-nft-and-cryptocurrency-games-implications-and-ramifications-for-the-videogame-industry)
- [Automaton: Rule 15 payment-processor content rule](https://automaton-media.com/en/news/steam-rules-updated-to-prohibit-content-that-violates-rules-set-forth-by-payment-processors-and-banks/)
- [Slashdot: Steam bans payment-processor-disapproved games](https://games.slashdot.org/story/25/07/16/2034212/steam-now-bans-games-that-violate-the-rules-and-standards-of-payment-processors)
- [VGC: Valve significantly rewrote AI disclosure rules](https://www.videogameschronicle.com/news/valve-has-significantly-rewritten-steams-rules-for-how-developers-much-disclose-ai-use/)
- [DataHumble: Steam Direct 2026 Guide](https://datahumble.com/blog/steam-direct-fee-requirements-roi-2026-guide)
- [pkgpulse: Electron vs Tauri 2026](https://www.pkgpulse.com/blog/electron-vs-tauri-2026)
- [utsubo.com: Migrate Three.js to WebGPU 2026](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)
- [Kilian Valkhof: Notarizing Electron apps](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/)
- [JamesMoulang: Electron + Steam notes](https://github.com/JamesMoulang/electron-steam-notes)
- [liana.one: HTML5 Electron + Steam API alternatives](https://liana.one/integrate-electron-steam-api-steamworks)
- [Skala: Age Ratings practical guide](https://www.skala.io/blog/age-ratings-for-games-a-practical-guide-for-game-development-startups)

---

## Closing Note

Nothing in this document is a commitment until Phase 0 clears — the crypto policy pre-check with Valve gates all subsequent investment. If the pre-check is ambiguous (Valve says "submit and we'll decide"), treat that as a 60% accept signal and proceed with the stripped-build plan, but keep ClawVille's primary distribution channel as `clawville.world` and the Milady app store (priority #1 in CLAUDE.md). Steam is a secondary acquisition channel, not a replacement for the web/Milady path.
