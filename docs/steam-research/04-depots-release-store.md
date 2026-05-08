# 04 — Depots, Release & Store Page (ClawVille on Steam)

**Owner:** Release & Distribution lead (5-agent Steam packaging team)
**Scope:** depot uploads, branches, store-page assets, platform distribution (Steam Deck), binary-to-release steps.
**Last audited:** 2026-04-17. All specs cited inline against `partner.steamgames.com` (primary source only — no third-party blogs).

Out of scope for this doc (owned by other leads on the team):
- Electron/steamworks.js wrapping internals → "Client Wrapper" lead
- Legal/ToS & marketplace stripping (Rule 8) → "Policy & Compliance" lead
- Branding/capsule art direction → "Art & Marketing" lead
- Save/cloud sync design → "Platform Integration" lead

This doc owns the **mechanical** path from "we have a built `.exe`" to "we hit Release Now".

---

## 0. TL;DR for the team

- **Launch model:** ship **paid, Windows-only, 1 depot** at v1. F2P is tempting because we have ClawTokens, but Valve treats F2P with extra scrutiny (section 4) and our token marketplace is legally stripped on Steam anyway (Policy lead owns that). A single ~$9.99 SKU is the lowest-friction path to "Release Now".
- **Longest pole:** the **Coming Soon → Release clock**. Store page must be live as Coming Soon for **≥ 2 weeks** before Valve approves the build checklist, and review itself takes **3–5 business days** each round — Valve recommends submitting **≥ 7 business days** before desired launch. Practically this is a 4-week minimum from "I have a store page draft" to "Release Now" even if everything passes first try. [Release Process — partner.steamgames.com/doc/store/releasing, accessed 2026-04-17] [Coming Soon — partner.steamgames.com/doc/store/coming_soon, accessed 2026-04-17]
- **Deck cert:** submit as **Windows-only via Proton** for v1. Electron's Chromium renderer runs under Proton via DXVK/VKD3D; our WebGPU scene will fall back to WebGL2 on Deck (Iris Xe Gen12 parity). Expect **Playable**, not **Verified**, in round 1.

---

## 1. Release timeline (4-week minimum / 8-week comfortable)

Gantt-in-markdown. `[====]` = active work, `[....]` = blocked/waiting, `|V|` = Valve gate.

```
Week:              1        2        3        4        5        6        7        8
                   |--------|--------|--------|--------|--------|--------|--------|--------|
Steam Direct $100  [=]                                                                       # 1 day, admin-only perm
Tax interview      [==]                                                                      # W-8/W-9 + banking; can't pay out without it
Capsule art        [========]                                                                # 5 sizes + library hero/logo; see section 3
Screenshots x5     [===]                                                                     # 1920x1080 in-game captures
Trailer (60-90s)   [======]                                                                  # gameplay-first cut
Short desc + body  [==]                                                                      # <= 300 char short; BBCode body
Sys-req + langs    [=]                                                                       # min + rec columns
Upload v0.1 build  [=]          [=]            [=]           [=]                             # iterate; first upload to internal branch
Store presence                                                                               # checklist 1 of 2
  Mark Ready       .........[|V|]                                                            # triggers Valve review
  Valve review     ..........[===]                                                           # 3-5 business days
  Post Coming Soon ..............|V|                                                         # green-light button; starts 2-week clock
  2-week minimum   ..............[=================]                                         # HARD GATE, can't shortcut
Build checklist                                                                              # checklist 2 of 2
  Final build      ...................[===]                                                  # Windows depot to default branch
  Age rating       ................[=====]                                                   # IARC self-attestation
  Mark Ready       .......................|V|
  Valve review     ........................[===]                                             # second review, same 3-5 day SLA
Release Now btn    ...............................[ENABLED]                                  # developer-triggered, not auto
Launch day         ..............................................|SHIP|
Post-launch patch  ...................................................[=====][=====]         # cadence for discovery algo
Deck cert submit   .........................................................[===]            # after launch is stable
Deck review        ............................................................[====]        # ~1 week; Valve email w/ results
```

Key gates (none of these are skippable):

| Gate | What must be true | Source |
|---|---|---|
| Coming Soon live | Store page approved; "Mark as ready for review" → Valve approves → "Post as Coming Soon" clicked | partner.steamgames.com/doc/store/coming_soon |
| 2-week clock | Coming Soon visible ≥ 2 weeks before release | partner.steamgames.com/doc/store/coming_soon |
| Build reviewed | "Substantially complete" build on default branch, approved by Valve | partner.steamgames.com/doc/store/releasing |
| Release Now enabled | BOTH checklists green AND tax/banking set | partner.steamgames.com/doc/store/releasing |

> Valve quote: "Approved titles will not release themselves — you need to use these controls yourself at the moment you wish your product to be released." [Release Process, accessed 2026-04-17]

---

## 2. Depot layout + SteamPipe config

### 2.1 Depot strategy

One appID, **one depot** (Windows only) for v1. Rationale:

- ClawVille is an Electron shell that bundles its own Chromium + Node + native modules; there's no real asset-sharing win from splitting into multiple depots.
- Proton handles the Linux path for Deck — we do not need a second Linux depot at launch.
- A second macOS depot is deferred to v1.1. Electron cross-compiles cleanly, but Apple notarization is its own project.
- If we later need localized asset swaps, we can add per-language depots; Steam supports language-filtered depots on the same app. [SteamPipe — partner.steamgames.com/doc/sdk/uploading, accessed 2026-04-17]

Proposed IDs (placeholders until Steamworks assigns the app):
- `AppID` — assigned by Valve post-$100 submission
- `DepotID` — by convention `AppID + 1` for the Windows content depot

### 2.2 Folder layout

```
ClawVille/
  scripts/
    deploy/
      steam/
        app_build_clawville.vdf          # master build script
        depot_build_windows.vdf          # (unused if inline; see below)
        content/                         # gitignored — populated by Electron build
          ClawVille.exe
          resources/
            app.asar
            app.asar.unpacked/
              ...native modules (better-sqlite3, etc.)
          locales/
            en-US.pak
            ...
          swiftshader/
          steam_api64.dll                # from steamworks SDK
          steam_appid.txt                # contains the numeric AppID
        output/                          # gitignored — SteamPipe chunk cache + logs
```

Hot tip from Valve: `BuildOutput` "on a separate disk improves performance". [SteamPipe, accessed 2026-04-17] For CI we leave it on the runner's default disk — fine for our ~600 MB package.

### 2.3 `app_build_clawville.vdf` (example, Windows-only v1)

Inline depot config — simpler than maintaining two files:

```vdf
"AppBuild"
{
    "AppID"         "YOUR_APPID"          // assigned by Steam
    "Desc"          "ClawVille v1.x build from GitHub Actions"
    "ContentRoot"   "..\..\..\scripts\deploy\steam\content\"
    "BuildOutput"   "..\..\..\scripts\deploy\steam\output\"
    "SetLive"       ""                    // NEVER set "default" here — Valve forbids it
                                          // Use "internal" or "preview" for auto-promotion to a beta branch

    "Depots"
    {
        "YOUR_DEPOTID"
        {
            "FileMapping"
            {
                "LocalPath" "*"
                "DepotPath" "."
                "Recursive" "1"
            }

            // Exclude dev/debug artifacts from the shipped depot
            "FileExclusion" "*.pdb"
            "FileExclusion" "*.log"
            "FileExclusion" "**/.DS_Store"
            "FileExclusion" "**/node_modules/**"
        }
    }
}
```

### 2.4 Separate `depot_build_windows.vdf` (only if we split files later)

```vdf
"DepotBuild"
{
    "DepotID"       "YOUR_DEPOTID"
    "ContentRoot"   "..\..\..\scripts\deploy\steam\content\"

    "FileMapping"
    {
        "LocalPath" "*"
        "DepotPath" "."
        "Recursive" "1"
    }

    "FileExclusion" "*.pdb"
    "FileExclusion" "**/node_modules/**"
}
```

### 2.5 Upload behavior we can rely on

All verified from [partner.steamgames.com/doc/sdk/uploading, accessed 2026-04-17]:

- **Chunking:** files split into ~1 MB chunks; unchanged chunks are reused. Our Electron bundle changes mostly in `app.asar` — so a typical patch is <30 MB even though the package is 600 MB.
- **Delta patching:** "Only the new or modified portions of any file are turned into new chunks."
- **Preview mode:** `"Preview" "1"` in the VDF runs the full build flow locally with no upload — use this in PRs before merging to `master`.
- **Encryption + HTTP:** all chunks encrypted; delivered over port 80 so corporate HTTP caches can transparently serve them.
- **Branch auto-set:** `SetLive` CANNOT set a build live on `default` — that's a manual web-UI click. It CAN set a build live on a named branch (`preview`, `internal`, etc.).
- **Build-account security:** changes to the build account's email/password trigger a **3-day lockout** before builds can go live. Keep this account boring and MFA'd.

### 2.6 Size / upload reality for ClawVille

- Expected package size: **~550–650 MB** (Electron base ~200 MB + node_modules ~150 MB + three.js assets ~150 MB + Steam SDK ~30 MB).
- First upload: ~15–20 min on a 100 Mbit CI runner.
- Subsequent uploads: 2–5 min thanks to delta patching.
- No soft/hard limit for normal games (Valve has published GB-scale shooters without approval friction).
- Rule-of-thumb from Valve: pack files >2 GB hurt delta efficiency. We're 4× under that threshold — fine.

---

## 3. Store page asset spec table (2026)

All dimensions from [Graphical Assets — partner.steamgames.com/doc/store/assets, accessed 2026-04-17]. Valve refreshed these in "August 2024"; older dimensions are no longer accepted.

| Asset | Required? | Dimensions | Format | Where it shows | ClawVille todo |
|---|---|---|---|---|---|
| Header Capsule | YES | **920 × 430** | PNG/JPG | Store search results, home page, tags | Design — lobster silhouette + "ClawVille" wordmark |
| Small Capsule | YES | **462 × 174** | PNG/JPG | Search/browse lists | Reuse header crop |
| Main Capsule | YES | **1232 × 706** | PNG/JPG | Front-page features, daily deal | Hero art, logo at bottom-left |
| Vertical Capsule | YES | **748 × 896** | PNG/JPG | Front-page seasonal features | Tall variant of main |
| Page Background | optional | **1438 × 810** | PNG/JPG | Store page bg tint | Subtle sea-floor wash |
| Library Capsule | YES | **600 × 900** | PNG | Steam client library shelf | Portrait hero + logo |
| Library Hero | YES | **3840 × 1240** | PNG | Big banner on top of library page | Wide sea-floor panorama, NO logo |
| Library Logo | YES | **1280 × 720** (flexible) | PNG w/ alpha | Overlaid on hero | Transparent wordmark only |
| Library Header Capsule | YES | **920 × 430** | PNG | Friend activity / client notifications | Can reuse store header |
| Client Icon | YES | **32 × 32 / 256 × 256** | ICO | Taskbar / desktop shortcut | Lobster claw silhouette |
| App Icon (Steam) | YES | **184 × 184** | JPG | In-client | Same artwork, JPG export |
| Screenshots | YES, **5 min** | **1920 × 1080** minimum, 16:9 | PNG/JPG | Store page carousel | 5 captures from `/game` (3D world + chat + marketplace) |
| Trailer (primary) | recommended | **1920 × 1080**, 16:9 | **MP4 H.264 + AAC**, 30/60 fps, ≥ 5,000 Kbps | Top of store page carousel | 60–90s gameplay cut |
| Event Cover (post-release) | optional | **800 × 450** | PNG/JPG | News / update posts | Deferred |
| Event Header (post-release) | optional | **1920 × 622** | PNG/JPG | News hubs | Deferred |

Trailer specs verified from [partner.steamgames.com/doc/store/trailer, accessed 2026-04-17]:
- **Containers accepted:** `.mov`, `.wmv`, `.mp4`
- **Codec preferred:** H.264 video + AAC audio
- **Resolution:** up to 1920 × 1080 (16:9 preferred; 4:3 allowed)
- **Frame rate:** 30 / 29.97 or 60 / 59.94 fps
- **Bitrate:** 5,000+ Kbps
- **Audio:** stereo at 44 / 48 kHz
- **Auto thumbnail:** Steam generates 600 × 380 poster + 232 × 130 thumb; overridable with a 1920 × 1080 custom image

### 3.1 Store text field limits

From [Store Page Written Description — partner.steamgames.com/doc/store/page/description, accessed 2026-04-17]:

- **Title:** Valve doesn't publish a hard cap; practical ceiling is ~45 chars before it truncates in search lists.
- **Short description:** "limited to a few hundred characters", **plain text only** — no BBCode, no bullets. Treat **300 chars** as the working budget.
- **About This Game:** no hard limit Valve publishes; supports formatting (bold, embedded screenshots/GIFs). **Keep all embedded screenshots + GIFs combined < 15 MB** or the page won't save.
- **Banned in descriptions:** external links, Steam-UI mockups, "Now Available" / release-date strings, ads for other games.

### 3.2 System requirements table (our recommended values)

Build a minimum vs recommended column — Valve requires both filled in before store-page submission.

| Field | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 64-bit | Windows 11 64-bit |
| CPU | Intel Core i5-8250U / AMD Ryzen 3 3200U | Intel Core i5-12400 / AMD Ryzen 5 5600 |
| RAM | 8 GB | 16 GB |
| GPU | Intel Iris Xe / GTX 1050 (WebGL2 fallback) | RTX 3060 / Radeon RX 6600 (WebGPU) |
| DirectX | 12 | 12 |
| Storage | 1 GB available | 1 GB available + 500 MB for cloud save |
| Network | Broadband (persistent backend at api.clawville.world) | Broadband |
| Notes | Requires internet; single-player offline mode not available at v1 | — |

### 3.3 Supported languages

English only at v1. Add a note in the Steam languages table: `English — Interface, Full Audio, Subtitles`. Other languages are queued for post-launch localization.

---

## 4. Pricing + F2P recommendation

### 4.1 The decision

**Recommend: paid, $9.99 USD launch price.** Reasoning:

1. **F2P has extra friction.** F2P monetization is supported via Steam DLC or Steamworks microtransaction APIs — BOTH require additional review, and microtransactions "require a reliable and secure backend to manage ... inventory and entitlements." [F2P — partner.steamgames.com/doc/store/freetoplay, accessed 2026-04-17]. Our ClawToken economy is explicitly stripped on the Steam build (Policy lead's call) because Valve's rules around third-party currencies/MTX of crypto-adjacent tokens are a cliff we don't want to walk off on day one.
2. **Our Coming Soon clock is the critical path.** F2P routes through exactly the same 2-week Coming Soon gate, but F2P games "compete algorithmically based on customer interest and in-game revenue" — with MTX stripped, we have no IAP revenue on Steam, which kills our algorithm visibility if listed as F2P.
3. **Paid = cleaner refund semantics.** Our web game is online-only (`api.clawville.world`). Steam's 2h-play / 14d-purchase refund rule means a chunk of users WILL refund. At $9.99, a 15% refund rate still clears the $100 Steam Direct recoupment threshold ($1,000 adjusted gross revenue) [App Fee — partner.steamgames.com/doc/gettingstarted/appfee, accessed 2026-04-17] at ~120 net sales.
4. **Discount headroom.** Valve's discount caps are tier-based [Pricing — partner.steamgames.com/doc/store/pricing, accessed 2026-04-17]:
   - $0.99 tier → max 50% off
   - $1.99 tier → max 75% off
   - $4.99 tier → max 90% off
   At $9.99 we inherit the widest discount flexibility without hitting the floor penalty, which matters for seasonal sales later.
5. **Regional pricing:** use Valve's "Multi-variable conversion" default when we set $9.99 USD. Valve will propose prices across **37 currencies + 4 region groups** that we can accept wholesale. The minimum transaction price after discounts is ~$0.49 USD equivalent.

### 4.2 Early Access?

**No, skip Early Access for v1.** Valve's 7 rules are explicit [Early Access — partner.steamgames.com/doc/store/earlyaccess, accessed 2026-04-17]:

- "Don't use Early Access if you aren't planning significant changes" — that's us. The web game is already feature-complete.
- Can't offer permanent discounts during EA.
- Requires a public "Early Access Questionnaire" that commits us to public dev-goal statements; that's extra surface area for community friction.

If we later want to stage a "beta cohort," use **Steam Playtest** instead (section 8). Playtest is a sibling child-appID with its own free license — no EA branding, no pricing lockout on the main app.

### 4.3 Refund reality check

From [Steam Refund Policy — store.steampowered.com/steam_refunds, accessed 2026-04-17]:

- **14-day window** from purchase + **< 2 hours playtime**.
- Pre-purchase: 14-day window starts **at release**, not purchase.
- VAC-banned accounts can't refund the affected game (N/A for us unless we ever add VAC — we shouldn't).
- Online-only concern: if our backend goes down during a buyer's first 2 hours, they WILL refund. Our SLA on `api.clawville.world` needs to hold ≥ 99% during launch week.

---

## 5. Steam Deck verification plan + risk assessment

### 5.1 The cert matrix

From [Deck Compat Review — partner.steamgames.com/doc/steamdeck/compat, accessed 2026-04-17]:

| Tier | Meaning |
|---|---|
| **Verified** | "Passes all compatibility checks. No configuration work is required for users to access all game functionality." |
| **Playable** | Runs, but needs manual user config (controller config, touch for launcher, etc). |
| **Unsupported** | Fails due to Proton incompatibility or hardware issues. |
| **Unknown** | Review not yet done. |

### 5.2 The 4 checks Valve runs

1. **Input** — default controller config must expose ALL game functionality. Button glyphs must match Deck/Xbox naming OR use the SteamInput API. Text input must open Steam keyboard (`ShowFloatingGamepadTextInput` / `ShowGamepadTextInput`).
2. **Display** — must support **1280 × 800** (Deck native) or **1280 × 720**. Default graphics settings must hit playable FPS. **Smallest on-screen font ≥ 9 px tall at 1280 × 800.**
3. **Seamlessness** — no "your hardware is unsupported" warnings. Launchers fully controller-navigable.
4. **Proton compatibility** — game runs under Proton unless we ship native Linux. "Blocking bugs trigger Unsupported ratings until resolved."

[Recommendations — partner.steamgames.com/doc/steamdeck/recommendations, accessed 2026-04-17] adds:
- Prefer **Vulkan** as graphics API; Proton auto-translates DX → Vulkan via DXVK.
- Avoid WMF codecs; use VP9 or AV1.
- Cloud saves required so Deck↔desktop hand-off works.
- Offline mode required for any single-player content.

### 5.3 ClawVille-specific risk matrix

| Risk | Severity | Notes | Mitigation |
|---|---|---|---|
| Electron + Proton | **Medium** | Chromium runs fine under Proton (proven — Discord, Slack, Figma all run on Deck under Proton). `steamworks.js` has a proven Linux build. [Proton — partner.steamgames.com/doc/steamdeck/proton, accessed 2026-04-17] | Smoke-test the Windows build on a Deck dev kit before cert submit. |
| WebGPU on Deck | **High** | Deck's Mesa/RADV supports Vulkan, but Chromium WebGPU (Dawn) backend on Linux-via-Proton is flaky — not officially supported by Chrome stable. | **Ship with WebGPU feature-flag OFF on Deck detection.** Fall back to WebGL2, which we already support for Iris Xe on Windows. Detect via user-agent + `navigator.userAgentData`. |
| Text readability | **Medium** | Our chat UI at 1280×800 is borderline — some system text hits 8px. | QA pass at 1280×800; bump all body text to 16px CSS (= ~12 px at native). |
| Controller input | **High** | ClawVille is WASD + mouse. We have a virtual joystick for mobile but no native gamepad mapping. | Ship a **default Steam Input config** mapping left-stick → WASD, right-stick → mouse look, A → click, B → back. Steam's default template config covers 90% of this. |
| Online-only | **Low** | Deck in offline mode = game can't boot. | Banner in game before online-required message; document in store page "Internet required". |
| Anti-cheat | **N/A** | We don't ship anti-cheat. | Skip. |

### 5.4 Submit plan

- **Cert NOT at launch.** Ship v1, stabilize 2–3 weeks, then submit via Steam Deck Compatibility Review link on the app's landing page.
- Review turnaround: ~1 week (Valve emails detailed results).
- **Target badge v1:** Playable (realistic). Verified requires default-config controller support which we won't have dialed in by launch.
- Re-submission is automatic after Proton updates, so if v1 lands Playable, we can ship a controller-config update and get re-scored without manual re-submit.

---

## 6. Branch strategy

From [Branches — partner.steamgames.com/doc/store/application/branches, accessed 2026-04-17]:

| Branch | Purpose | Password | Who sees it | Promote to default? |
|---|---|---|---|---|
| `default` | Live build for all customers | none | everyone | N/A (this IS live) |
| `preview` | Public beta, opt-in only | none (public) | users who opt in via Properties → Betas | manual via web UI |
| `internal` | Dev-only smoke tests | **password-protected** (env var `STEAM_INTERNAL_BRANCH_PW`) | only us + invited testers | never — internal QA only |
| `playtest` | Sibling appID for structured playtest cohorts | controlled via Playtest UI, not a branch | playtest pool | N/A |

Rules we must follow:
- Branch names: meaningful, **no spaces** ("internal" ✓, "my internal" ✗).
- Users opt in: right-click game → Properties → Betas tab → select branch. UI shows a branch indicator next to Play.
- `default` is the ONLY branch where `SetLive` in the VDF is forbidden — it requires the web-UI "Set Build Live Now" click.
- Set a password on `internal` via the Builds page (NOT via the VDF — password is a branch attribute, not a build attribute).

### Workflow
1. CI pushes every `master` commit to `internal` branch with `"SetLive" "internal"` in the VDF → auto-live for the team.
2. Manual promote `internal` → `preview` when we have a cohort of external testers (Discord invite only).
3. Manual promote `preview` → `default` on release day via the web UI's "Set Build Live Now" button.

> "The default branch is the version of your game delivered to your customers on Steam." [Branches, accessed 2026-04-17]

---

## 7. CI/CD pipeline sketch (GitHub Actions → SteamCMD)

Use [`game-ci/steam-deploy`](https://github.com/game-ci/steam-deploy) — the community-maintained action wrapping SteamCMD. Its TOTP auth is required for headless runners (Steam Guard MFA config.vdf is brittle across runner regenerations).

### 7.1 Required GitHub secrets

| Secret | Purpose | How to obtain |
|---|---|---|
| `STEAM_USERNAME` | Build account username | Create dedicated "clawville-builder" account with Edit App Metadata + Publish App Changes permissions |
| `STEAM_CONFIG_VDF` | Base64-encoded `config.vdf` after one interactive login | Run `steamcmd +login clawville-builder` on a dev box, `base64` the resulting `~/.steam/config/config.vdf` |
| `STEAM_APP_ID` | Your AppID | Valve assigns post-$100 payment |
| `STEAM_DEPOT_ID` | Your Windows depot ID | Valve assigns (typically AppID+1) |
| `STEAM_SSFN_FILE_NAME` / `STEAM_SSFN_FILE_CONTENTS` | Steam Guard session token | Same dev-box run as above |

### 7.2 `.github/workflows/steam-deploy.yml`

```yaml
name: Deploy to Steam

on:
  push:
    tags:
      - 'steam-v*'        # tag e.g. steam-v1.0.3 to trigger
  workflow_dispatch:
    inputs:
      branch:
        description: 'Steam branch to set live'
        required: true
        default: 'internal'
        type: choice
        options: [internal, preview, '']    # '' = no auto-set (for default)

jobs:
  build-electron:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - name: Package Electron
        run: bun run electron:package --win --dir
      - name: Stage Steam content
        shell: bash
        run: |
          mkdir -p scripts/deploy/steam/content
          cp -r apps/desktop/out/ClawVille-win32-x64/* scripts/deploy/steam/content/
          echo "${{ secrets.STEAM_APP_ID }}" > scripts/deploy/steam/content/steam_appid.txt
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: steam-content
          path: scripts/deploy/steam/content/
          retention-days: 7

  deploy:
    needs: build-electron
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: steam-content
          path: scripts/deploy/steam/content/
      - name: Render VDF
        run: |
          sed -i "s/YOUR_APPID/${{ secrets.STEAM_APP_ID }}/g" scripts/deploy/steam/app_build_clawville.vdf
          sed -i "s/YOUR_DEPOTID/${{ secrets.STEAM_DEPOT_ID }}/g" scripts/deploy/steam/app_build_clawville.vdf
          sed -i 's/"SetLive"        ""/"SetLive"        "${{ inputs.branch || 'internal' }}"/g' scripts/deploy/steam/app_build_clawville.vdf
      - name: Deploy to Steam
        uses: game-ci/steam-deploy@v3
        with:
          username: ${{ secrets.STEAM_USERNAME }}
          configVdf: ${{ secrets.STEAM_CONFIG_VDF }}
          ssfnFileName: ${{ secrets.STEAM_SSFN_FILE_NAME }}
          ssfnFileContents: ${{ secrets.STEAM_SSFN_FILE_CONTENTS }}
          appId: ${{ secrets.STEAM_APP_ID }}
          buildDescription: "CI build ${{ github.sha }}"
          rootPath: scripts/deploy/steam/content
          depot1Path: .
          releaseBranch: ${{ inputs.branch || 'internal' }}
```

### 7.3 Operational notes

- **First run is interactive.** You have to log in on a dev box, let Steam Guard email the code, complete login, then base64 the resulting `config.vdf` into GitHub secrets. Never commit the raw VDF.
- **Tokens rotate.** If the CI fails auth, re-do the interactive login locally, re-encode, re-set secret.
- **Never auto-release to `default`.** Always promote through `internal` → `preview` → manual web-UI click for `default`. Leaving `SetLive=default` would fail anyway (Valve blocks this), but guarding CI input prevents accidents.
- **Smoke test via Preview mode.** For PR validation, run with `SetLive=''` and `Preview=1` in the VDF — logs the upload plan without touching Steam.

---

## 8. Steam Playtest (deferred, but planned)

From [Playtest — partner.steamgames.com/doc/features/playtest, accessed 2026-04-17]:

- **Sibling child-appID** of the main ClawVille app. Separate store presence, separate install, no wishlist/review pollution.
- **Monetization forbidden.** "Free access only." Matches our "ClawTokens stripped on Steam" posture perfectly — Playtest is where the marketplace-stripped build can live as a feedback tool.
- **Signup models:** limited (we admit in batches), open (auto-admit), key distribution (up to 50k keys), friend invites.
- **Assets needed:** library capsule + community assets; simplified store review.
- **Use case for us:** once v1 ships paid, a Playtest child-app lets us test experimental web features (WebGPU enhancements, new 3D pipelines) on a free cohort without risking main-app reviews.

Not on the v1 critical path. Add to the week-6+ roadmap.

---

## 9. Steam Next Fest eligibility

From [Next Fest — partner.steamgames.com/doc/marketing/upcoming_events/nextfest, accessed 2026-04-17]:

Eligibility check for ClawVille:

| Rule | ClawVille status |
|---|---|
| Never participated before | PASS |
| Steamworks account in good standing | PASS (new account) |
| Public base game store page | Will PASS after Coming Soon step |
| Playable demo by event start | NEED to build a demo child-appID |
| Not releasing before fest concludes | **RISK** — if we aim to release fast, Next Fest won't fit |
| Not a prologue/preview of already-released game | PASS |

**Schedule:** 3 per year — February, June, October. Dates at [nextfest/2026june, nextfest/2026october, accessed 2026-04-17].

**Submission deadlines:**
- Demo reviewed ≥ **4 weeks before Press Preview** if releasing before preview.
- Demo reviewed ≥ **2 weeks before fest start** otherwise.
- Demo must launch ≥ 30 min before the event starts.

**Recommendation:** target **October 2026 Next Fest** — gives us a release slot of Oct-Nov 2026 without the "can't release before fest ends" conflict. The June 2026 fest is too close to comfortably hit our release gates.

---

## 10. Release Day Checklist (in order)

All items below must be green BEFORE clicking Release Now. Numbered for cross-team signoff.

### Pre-launch (T-4 weeks → T-0)

1. **Steam Direct $100 fee paid** — admin-only account action. Receipt visible in Steamworks. [App Fee, accessed 2026-04-17]
2. **Tax interview complete** — W-9 (US) or W-8BEN/BEN-E (non-US) + banking details. NO payouts without this. Blocks the Release Now button silently.
3. **Build account secured** — MFA enabled, phone attached, NOT the admin account. Permissions: Edit App Metadata + Publish App Changes.
4. **App created** — AppID assigned by Valve.
5. **Store page draft complete**
   - [ ] Short description (< 300 char, plain text)
   - [ ] About This Game body (embedded screenshots/GIFs < 15 MB total)
   - [ ] Feature list (5–10 bullets)
   - [ ] Genre tags + user-defined tags
6. **All store assets uploaded** (see section 3 table; all "YES" rows).
7. **Screenshots: 5+ at 1920×1080**.
8. **Primary trailer uploaded** (MP4 H.264 AAC, 1080p, ≥ 5000 Kbps).
9. **System requirements filled** (min + recommended).
10. **Supported languages set** (English — Interface + Full Audio + Subtitles).
11. **Age rating questionnaire** — IARC self-attest (30 min, free).
12. **Pricing set** — $9.99 USD base, accept Valve's multi-variable regional conversion.
13. **"Mark as ready for review" clicked on store presence** — starts 3–5 day Valve review.
14. **Valve approves store → "Post as Coming Soon" clicked** — 2-week clock starts.
15. **Release date set** in Steamworks — must be ≥ 2 weeks out from Coming Soon post.
16. **First build uploaded** to `default` branch (not set live yet — just uploaded). "Substantially complete" per Valve's rule.
17. **Build checklist "Mark as ready for review" clicked** — second 3–5 day Valve review.
18. **Valve approves build** — Release Now button becomes clickable.

### Launch day (T-0)

19. **Set build live on `default`** via web UI → "Set Build Live Now" (CI cannot do this).
20. **Click "Release App"** → confirm package publishing summary → "Publish Now" → final "Release Now" confirmation.

### T+hours

21. **Verify game installs from store** using a non-dev Steam account. Install, launch, confirm sign-in to `api.clawville.world`.
22. **Monitor `api.clawville.world/health`** — 99%+ uptime during launch week is required to keep refund rate tolerable.
23. **Announce in community hub** + pin a "known issues / feedback here" post.

---

## 11. Post-release ops

### Patch cadence
Steam's discovery algorithm rewards recency. Target: **1 patch per week for the first 8 weeks**, then monthly. Each patch = a new build uploaded to default branch + a community announcement.

### News posts
Use Steam Events & Announcements system. At minimum:
- Release announcement (day 0)
- Patch notes (each patch)
- Roadmap update (monthly)

### Reviews
- Respond to **thoughtful negative reviews** publicly — this visibly increases helpful-upvotes on your reply. Don't engage with trolls.
- Never "review bomb" back — Valve moderates aggressive developer responses.

### Delisting risk
If Valve pulls the app for a policy violation (e.g. ClawToken economy leakage into the Steam build):
- Existing purchasers keep access indefinitely.
- No new sales.
- Appeal via Steam Direct support form; typical resolution 1–2 weeks.
- Repeat violations can permanently ban the developer account.

**Mitigation:** Policy lead owns a scheduled "marketplace-stripped" audit before every patch upload. The Windows Steam build MUST NOT expose `/bazaar` routes or ClawToken purchase UI. Automated check: grep built `app.asar` for `bazaar` route strings in CI before uploading.

---

## 12. References (primary-source only)

All URLs accessed 2026-04-17.

- [Steamworks Documentation Home](https://partner.steamgames.com/doc)
- [Uploading to Steam (SteamPipe / ContentBuilder)](https://partner.steamgames.com/doc/sdk/uploading)
- [Branches (Betas)](https://partner.steamgames.com/doc/store/application/branches)
- [Graphical Assets — Overview](https://partner.steamgames.com/doc/store/assets)
- [Trailers](https://partner.steamgames.com/doc/store/trailer)
- [Store Page Written Description](https://partner.steamgames.com/doc/store/page/description)
- [Coming Soon](https://partner.steamgames.com/doc/store/coming_soon)
- [Release Process](https://partner.steamgames.com/doc/store/releasing)
- [Pricing](https://partner.steamgames.com/doc/store/pricing)
- [Free to Play Games](https://partner.steamgames.com/doc/store/freetoplay)
- [Early Access](https://partner.steamgames.com/doc/store/earlyaccess)
- [Steam Direct Fee ($100)](https://partner.steamgames.com/doc/gettingstarted/appfee)
- [Steam Refund Policy](https://store.steampowered.com/steam_refunds/)
- [Steam Deck Compatibility Review](https://partner.steamgames.com/doc/steamdeck/compat)
- [Steam Deck Recommendations](https://partner.steamgames.com/doc/steamdeck/recommendations)
- [Steam Deck and Proton](https://partner.steamgames.com/doc/steamdeck/proton)
- [Steam Playtest](https://partner.steamgames.com/doc/features/playtest)
- [Steam Next Fest](https://partner.steamgames.com/doc/marketing/upcoming_events/nextfest)

Community tooling (not primary Valve source, but referenced for CI):
- [game-ci/steam-deploy GitHub Action](https://github.com/game-ci/steam-deploy)
- [CM2Walki/steampipe Docker image](https://github.com/CM2Walki/steampipe)

---

## Appendix A — Hard-confirmed 2026 rules quick card

- **Steam Direct fee:** $100 USD per app, recoupable at $1,000 adjusted gross revenue.
- **Coming Soon clock:** ≥ 2 weeks live before release.
- **Store review SLA:** 3–5 business days (submit ≥ 7 business days ahead).
- **Build account security lockout:** 3 days after email/password change.
- **Refund window:** 14 days + < 2 hours playtime (pre-purchase: clock starts at release).
- **Early Access discount lockout:** price increases trigger 30-day discount cooldown.
- **Playtest:** no monetization allowed; child-appID; simplified review.
- **Next Fest:** one-shot per app; 3 fests/year (Feb/Jun/Oct); must not release before fest ends.
- **Deck font floor:** ≥ 9 px at 1280 × 800.
- **Trailer:** MP4 H.264 + AAC; 1080p; 30/60 fps; ≥ 5000 Kbps.
- **Max embedded screenshot+GIF size in About This Game:** 15 MB total.
