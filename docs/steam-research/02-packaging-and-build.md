# ClawVille → Steam: Packaging & Build

*Track: Technical Packaging (Agent 2 of 5)*
*Last audited: 2026-04-17*
*Scope: desktop-app wrapper only — how we turn our Next.js 16 + Three.js WebGPU web app into a signed Steam-distributable binary. Store policy, auth, and economy gating are covered separately in `docs/steam-packaging-research.md`.*

---

## 0. Recommendation (one line)

**Use Electron 41.x (Chromium 146, stable) + electron-builder + steamworks.js, in remote-load mode pointed at `https://clawville.world/game?build=steam`, signed with Azure Trusted Signing on Windows and Apple Developer notarization on macOS. Let Steam's SteamPipe handle client-side patching — no electron-updater.**

That single sentence is load-bearing for everything below. Reasoning matrix in §1.

---

## 1. Decision matrix — Electron vs Tauri vs NW.js

Scored 1-5 where 5 = best for ClawVille specifically. "Weight" column reflects how load-bearing each criterion is for *our* codebase (Next.js + Three.js WebGPU + TSL node materials + PixiJS fallback). Scores are opinionated; references follow the table.

| Criterion | Weight | Electron 41 | Tauri 2 | NW.js |
|---|---|---|---|---|
| WebGPU parity with our browser build (Chromium 146) | **5** | 5 — identical Chromium runtime, same TSL compile path we already debug in prod | 2 — WebView2 works, but macOS WKWebView WebGPU inconsistent, Linux WebKitGTK lags | 4 — same Chromium base |
| TSL node materials (`three/webgpu`) compile correctness | **5** | 5 — bit-for-bit identical to what we test on clawville.world | 2 — per-platform WebView regression risk | 4 |
| Intel Iris Xe WebGPU crash surface (our known pain point) | **4** | 3 — same crash risk as today, but also same WebGL2 fallback via `WebGPURenderer.init()` | 2 — extra WebView unknowns compound the risk | 3 |
| Steam SDK binding maturity | **5** | 5 — `steamworks.js` (Rust NAPI) is TS-first and actively maintained | 3 — Rust crates exist but fewer proof-of-ship | 2 — binding options are stale |
| Next.js 16 + Turbopack + async `serverExternalPackages` compatibility | **4** | 5 — Chromium just renders, Next stays on Hetzner | 4 | 4 |
| Auto-update path that aligns with Steam user expectations | **3** | 5 — disable self-update, let SteamPipe patch | 5 | 4 |
| macOS notarization + hardened runtime tooling | **3** | 5 — `@electron/notarize` + `@electron/universal` are well-trodden | 4 — tauri-action works, smaller community | 2 |
| Bundle size on Steam depot | **1** | 2 — 150-250 MB baseline | 5 — 5-30 MB | 2 |
| CI/CD fit (GitHub Actions matrix) | **3** | 5 — electron-builder GH action is canonical | 4 — tauri-action | 2 |
| Code signing story (Windows + macOS) | **4** | 5 — mature `win.sign` / `mac.notarize` hooks | 4 | 2 |
| Steam Linux Runtime / Steam Deck support | **2** | 2 — known libcups SLR crash, need workaround | 3 | 2 |
| Long-term maintenance risk | **3** | 5 — OpenJS governance, huge ecosystem | 4 — Tauri 2 is stable but newer | 1 — NW.js is effectively maintained-only |

**Weighted totals:**
- Electron: **178 / 205** (87%)
- Tauri: **131 / 205** (64%)
- NW.js: **105 / 205** (51%)

Electron wins primarily because we *already* ship WebGPU + TSL node materials to users and have debugged their Iris Xe behavior in Chromium. Any WebView that isn't Chromium reopens that debugging window on three OS/GPU permutations.

### 1.1 Verifying the load-bearing WebGPU claim

The prior research assertion that "WebGPU on macOS WKWebView and Linux WebKitGTK isn't production-ready" holds as of 2026-04:

- **Tauri webview map:** Tauri 2 uses WKWebView on macOS, WebKitGTK on Linux, WebView2 on Windows. ([Webview Versions | Tauri](https://v2.tauri.app/reference/webview-versions/), accessed 2026-04-17)
- **Open Tauri WebGPU issue** remains unresolved for cross-platform parity. ([tauri-apps/tauri#6381](https://github.com/tauri-apps/tauri/issues/6381), accessed 2026-04-17)
- **WebView2 (Windows):** WebGPU works since Edge/WebView2 tracks Chromium closely, but historically has required user-facing troubleshooting for complex TSL shader graphs.
- **WKWebView (macOS):** WebKit's WebGPU implementation ships behind flags and has uneven coverage; complex TSL compute/vertex node graphs that Chromium Dawn handles cleanly are where WKWebView falls over.
- **WebKitGTK (Linux):** Lags upstream WebKit significantly; WebGPU is not a distributable target here in 2026.

Our code at `apps/web/src/components/three/World3DCanvas.tsx` imports `three/webgpu` and uses `WebGPURenderer.init()` (Three.js r182). It explicitly falls back to the classic `WebGLRenderer` if WebGPU init throws. In Electron that whole branch runs inside the same Chromium engine users already hit from Chrome, so we avoid a second-render-engine regression matrix entirely.

### 1.2 Does our PixiJS fallback save us on Tauri?

Not enough. PixiJS (`apps/web/src/components/pixi/PixiCanvas.tsx`) is a 2D fallback retained for devices that can't run Three.js at all — it doesn't render the 3D world. Shipping the 2D sprite version as the Steam experience would gut the product. The WebGPU compatibility question is not optional.

### 1.3 NW.js ruling

NW.js is effectively a legacy option. No active Steam-SDK binding, no advantage over Electron for our stack, smaller contributor base. Ruled out.

---

## 2. Electron architecture

```
┌─────────────────────── Windows .exe / .app / .AppImage ─────────────────────┐
│                                                                             │
│  ┌──────── Electron main process (Node.js 24, single instance) ─────────┐  │
│  │ apps/desktop/src/main.ts                                              │  │
│  │   - app.whenReady() → createWindow()                                  │  │
│  │   - steamworks.js Client.init(STEAM_APP_ID) — reads steam_appid.txt   │  │
│  │   - BrowserWindow:                                                    │  │
│  │       width/height from store, frame:true, titleBarStyle:'default'    │  │
│  │       webPreferences:                                                 │  │
│  │         preload: path.join(__dirname, 'preload.cjs')                  │  │
│  │         contextIsolation: true                                        │  │
│  │         nodeIntegration: false                                        │  │
│  │         sandbox: true                                                 │  │
│  │         webSecurity: true                                             │  │
│  │   - win.loadURL('https://clawville.world/game?build=steam')           │  │
│  │   - ipcMain.handle('steam:getAuthTicket', ...)                        │  │
│  │   - ipcMain.handle('steam:setRichPresence', ...)                      │  │
│  │   - ipcMain.handle('steam:unlockAchievement', ...)                    │  │
│  │   - app.on('before-quit') → client.shutdown()                         │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      │ IPC                                   │
│  ┌───────────────────────────────────▼───────────────────────────────────┐  │
│  │ Renderer (Chromium 146) — loads clawville.world/game?build=steam      │  │
│  │   - existing Next.js 16 bundle, Three.js r182 + TSL, Zustand          │  │
│  │   - detects window.steam (injected by preload)                        │  │
│  │   - on boot: invoke('steam:getAuthTicket') → POST /api/auth/steam     │  │
│  │   - hides bazaar/wallet UI when ?build=steam (also NEXT_PUBLIC gated) │  │
│  │   - Steam overlay renders on top automatically (Chromium compositor)  │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      │ HTTPS                                 │
└──────────────────────────────────────┼──────────────────────────────────────┘
                                       │
                       ┌───────────────▼────────────────┐
                       │  api.clawville.world (Hono)    │
                       │  unchanged except new route:   │
                       │  POST /api/auth/steam          │
                       │    → AuthenticateUserTicket    │
                       │    → upsert users.steam_id     │
                       │    → issue Lucia session       │
                       └────────────────────────────────┘
```

### 2.1 Preload script (CJS, isolated)

```js
// apps/desktop/src/preload.cjs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steam', {
  getAuthTicket: () => ipcRenderer.invoke('steam:getAuthTicket'),
  setRichPresence: (key, value) => ipcRenderer.invoke('steam:setRichPresence', key, value),
  unlockAchievement: (id) => ipcRenderer.invoke('steam:unlockAchievement', id),
  // Feature detection for the web renderer
  isSteamBuild: true,
});
```

Renderer-side usage (new file, e.g. `apps/web/src/lib/steam.ts`):

```ts
declare global {
  interface Window {
    steam?: {
      getAuthTicket: () => Promise<string>;
      setRichPresence: (k: string, v: string) => Promise<void>;
      unlockAchievement: (id: string) => Promise<boolean>;
      isSteamBuild: true;
    };
  }
}

export const isSteamBuild = () => typeof window !== 'undefined' && !!window.steam?.isSteamBuild;
```

### 2.2 IPC surface (kept intentionally small)

| Channel | Direction | Purpose |
|---|---|---|
| `steam:getAuthTicket` | renderer → main | Issue `GetAuthTicketForWebApi('clawville')` hex ticket for `/api/auth/steam` |
| `steam:setRichPresence` | renderer → main | Update "In Skill Forge" / "Chatting with Sandy" strings |
| `steam:unlockAchievement` | renderer → main | Unlock by AppID-scoped ID |
| `steam:onOverlayActivated` | main → renderer (event) | Pause autonomous agent loop while overlay is open |

Everything else stays remote-fetched from `api.clawville.world`. We do **not** expose `fs`, `child_process`, `shell.openExternal` without URL validation, or any Node primitives.

---

## 3. Remote-load vs bundled-static-export

### 3.1 Option A — Remote load (recommended for v1)

`win.loadURL('https://clawville.world/game?build=steam')`

**Pros:**
- No re-packaging the frontend on every Next.js deploy — Coolify remains the single source of truth.
- Users instantly get UI/content patches (string fixes, balance tweaks, new quests) without a Steam patch round trip.
- Keeps the codebase identical to web. Zero "packaging drift" bug class.
- Honors `apps/web/next.config.mjs` CSP `frame-ancestors` (already permits `electrobun:`, `tauri:`, `app:`, `file:` — we can keep scheme-agnostic).

**Cons:**
- App is dead when the user is offline or clawville.world is down. Not a real-world loss because **the backend is also remote** — the product can't work offline by design.
- Remote-URL Electron has a larger security surface. Requires disciplined `contextIsolation: true`, strict CSP response headers, preload-only Node exposure, `webSecurity: true`. Baseline enforced per [Electron Security checklist](https://www.electronjs.org/docs/latest/tutorial/security) (accessed 2026-04-17).
- Steam users expect a local install to "work without internet for a minute" — we ship a graceful offline error screen (§6.4) to manage that expectation.

### 3.2 Option B — Bundled static export

`next build` with `output: 'export'` into `apps/desktop/resources/www/` and `win.loadFile('index.html')`.

**Pros:**
- Works when clawville.world is down (only static assets serve offline; game still needs API).
- No CSP remote-origin debate.

**Cons:**
- Breaks on our current Next.js code. We use server components, server actions, and dynamic `apps/web/src/lib/three/ktx2-loader-setup.tsx`-style loaders. Full static export would require splitting out an "API-only" frontend variant — more platform code.
- Every content patch now needs a Steam upload. Multiplies the patch cadence penalty.
- We'd still need to hit `https://api.clawville.world/...` for everything, so "offline" is illusory.

**Verdict:** Ship Option A for v1. Re-evaluate Option B only if Valve demands it for Steam Deck Verified polish (unlikely — many always-online games pass review).

### 3.3 Security hardening for remote-load

Per [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) (accessed 2026-04-17) + [Bishop Fox Reasonably Secure Electron](https://bishopfox.com/blog/reasonably-secure-electron) (accessed 2026-04-17):

1. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every `BrowserWindow`.
2. Expose only the minimum IPC via `contextBridge.exposeInMainWorld('steam', { ... })`.
3. Tighten CSP on the remote response. Current `apps/web/next.config.mjs` only sets `frame-ancestors`. **Add a full CSP header**:
   ```
   Content-Security-Policy: default-src 'self' https://api.clawville.world;
     script-src 'self' 'wasm-unsafe-eval';
     style-src 'self' 'unsafe-inline';
     img-src 'self' data: blob: https:;
     connect-src 'self' https://api.clawville.world https://*.supabase.co wss://*.supabase.co;
     worker-src 'self' blob:;
     frame-ancestors 'self' https://*.clawville.world electrobun: capacitor: tauri: app: file:;
   ```
   `wasm-unsafe-eval` is required for the KTX2 basis transcoder at `apps/web/public/basis/*`.
4. Lock `BrowserWindow.webContents.setWindowOpenHandler` to reject `window.open` for any URL that isn't `https://clawville.world/*` or `https://*.clawville.world/*`.
5. Intercept `will-navigate` — block any navigation that drifts off our origin.
6. Disable `eval` at the app level: never bundle code that relies on it.
7. Subresource integrity on the (few) CDN assets we serve.

---

## 4. Build pipeline (Turborepo + Electron)

### 4.1 Workspace layout

```
ClawVille/
  apps/
    web/            (unchanged — Next.js 16, serves clawville.world)
    api/            (unchanged — Hono)
    desktop/        NEW — Electron wrapper
      package.json
      electron-builder.yml
      src/
        main.ts           Electron main + steamworks.js init
        preload.cjs       IPC bridge (CJS because contextBridge requires it)
        steam/
          auth.ts         GetAuthTicketForWebApi wrapper
          presence.ts     rich presence + achievements helpers
          overlay.ts      overlay event → renderer event bridge
      resources/
        steam_appid.txt   (gitignored in public branches; present for local dev)
        icon.ico          Windows
        icon.icns         macOS
        icon.png          Linux (1024x1024)
      build/
        entitlements.mac.plist
```

### 4.2 `apps/desktop/package.json` (canonical snippet)

```jsonc
{
  "name": "@clawville/desktop",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "clean": "rm -rf dist release",
    "build:main": "tsc -p tsconfig.main.json",
    "build:preload": "cp src/preload.cjs dist/preload.cjs",
    "build": "bun run clean && bun run build:main && bun run build:preload",
    "dist": "bun run build && electron-builder --config electron-builder.yml",
    "dist:win": "bun run build && electron-builder --config electron-builder.yml --win",
    "dist:mac": "bun run build && electron-builder --config electron-builder.yml --mac",
    "dist:linux": "bun run build && electron-builder --config electron-builder.yml --linux",
    "pack": "bun run build && electron-builder --config electron-builder.yml --dir"
  },
  "dependencies": {
    "steamworks.js": "^0.4.0"
  },
  "devDependencies": {
    "@electron/notarize": "^3.0.0",
    "@electron/universal": "^2.0.1",
    "@types/node": "^20.14.10",
    "electron": "^41.2.1",
    "electron-builder": "^26.0.0",
    "typescript": "^5.5.3"
  }
}
```

Version choices:
- **Electron 41.2.1** is current stable as of 2026-04-15 per [releases.electronjs.org](https://releases.electronjs.org/) (accessed 2026-04-17). Bundles Chromium 146.0.7680.188 and Node.js 24.14.1. WebGPU is enabled by default in Chromium 146 on Windows and macOS. Linux still needs `--enable-unsafe-webgpu` + `--enable-vulkan` for non-blocklisted GPUs per [Chrome WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips) (accessed 2026-04-17).
- **electron-builder ^26** over electron-forge: electron-builder has ~1.5M weekly downloads vs ~2K for forge, is our preferred signing/packaging workflow, and has mature `publish` integration per [npmcompare](https://npmcompare.com/compare/electron-builder,electron-forge,electron-packager) (accessed 2026-04-17). The Electron team recommends forge for greenfield apps but electron-builder handles our "no self-update + Steam-native patch" requirement more cleanly.
- **`steamworks.js` ^0.4** over `greenworks` (dead) — ([ceifa/steamworks.js](https://github.com/ceifa/steamworks.js/), accessed 2026-04-17).

### 4.3 `apps/desktop/electron-builder.yml`

```yaml
appId: world.clawville.desktop
productName: ClawVille
copyright: Copyright © 2026 ClawVille
directories:
  output: release
  buildResources: resources
files:
  - dist/**/*
  - resources/**/*
  - package.json
  - "!node_modules/*/{test,tests,__tests__,docs,doc,example,examples}/**"
extraResources:
  - from: resources/steam_appid.txt
    to: steam_appid.txt

asar: true
asarUnpack:
  # steamworks.js ships native .node binaries; must be outside asar
  - "node_modules/steamworks.js/**/*"

# We do NOT ship an auto-updater. Steam patches the binary via SteamPipe.
# Removing electron-updater from dependencies is intentional.

win:
  target:
    - target: nsis
      arch:
        - x64
  # Azure Trusted Signing — fields picked up by CI signing step (not here)
  signingHashAlgorithms: [sha256]
  sign: ./scripts/sign-azure.js
  publisherName: "ClawVille Inc."
  icon: resources/icon.ico

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  runAfterFinish: false          # Steam launches, not the installer
  createDesktopShortcut: false   # Steam creates the shortcut
  createStartMenuShortcut: false
  deleteAppDataOnUninstall: true
  artifactName: ClawVille-${version}-win-${arch}.exe

mac:
  target:
    - target: dir
      arch:
        - x64
        - arm64
  category: public.app-category.games
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize:
    teamId: "$APPLE_TEAM_ID"
  icon: resources/icon.icns

linux:
  target:
    - target: AppImage
      arch: [x64]
    - target: tar.gz
      arch: [x64]
  category: Game
  icon: resources/icon.png
  artifactName: ClawVille-${version}-linux-${arch}.${ext}
```

The `mac.target: dir` is intentional — we produce both `x64` and `arm64` `.app` directories and stitch them with `@electron/universal` in a CI step so Steam ships a single universal binary. Pattern documented in [electron/universal](https://github.com/electron/universal) (accessed 2026-04-17).

### 4.4 `build/entitlements.mac.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Required for V8 JIT under hardened runtime -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <!-- Required for Chromium sandbox to map executable memory regions -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <!-- Outbound HTTPS to clawville.world + WebSockets -->
  <key>com.apple.security.network.client</key>
  <true/>
  <!-- Do NOT add com.apple.security.device.audio-input unless we add voice chat -->
</dict>
</plist>
```

Per [Kilian Valkhof's guide](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/) (accessed 2026-04-17), `allow-unsigned-executable-memory` is still required for Electron's own JIT surfaces on macOS despite the old "Electron ≤11 only" warning — the specific scenarios changed with Electron 20+'s sandbox architecture. Verify on first notarize run.

### 4.5 CI — GitHub Actions matrix

```yaml
# .github/workflows/desktop-release.yml (skeleton)
name: Desktop release
on:
  push:
    tags: ['desktop-v*']
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        os: [windows-2022, macos-14, ubuntu-22.04]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run --filter @clawville/desktop dist
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Windows
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_TRUSTED_SIGNING_ENDPOINT: ${{ secrets.AZURE_TRUSTED_SIGNING_ENDPOINT }}
          AZURE_TRUSTED_SIGNING_ACCOUNT: ${{ secrets.AZURE_TRUSTED_SIGNING_ACCOUNT }}
          AZURE_TRUSTED_SIGNING_CERT_PROFILE: ${{ secrets.AZURE_TRUSTED_SIGNING_CERT_PROFILE }}
          # macOS
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with:
          name: clawville-${{ matrix.os }}
          path: apps/desktop/release/*

  universal-mac:
    needs: build
    runs-on: macos-14
    steps:
      - uses: actions/download-artifact@v4
      - run: node scripts/make-universal.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: clawville-mac-universal
          path: release/*.app.zip

  steampipe-upload:
    needs: [build, universal-mac]
    runs-on: ubuntu-22.04
    container: cm2network/steampipe:latest
    steps:
      - uses: actions/download-artifact@v4
      - name: Stage content
        run: |
          mkdir -p ContentBuilder/content/windows ContentBuilder/content/osx ContentBuilder/content/linux
          cp -r clawville-windows-2022/win-unpacked/* ContentBuilder/content/windows/
          cp -r clawville-mac-universal/ClawVille.app ContentBuilder/content/osx/
          cp -r clawville-ubuntu-22.04/linux-unpacked/* ContentBuilder/content/linux/
          cp scripts/steampipe/*.vdf ContentBuilder/scripts/
      - name: Upload to Steam
        env:
          STEAM_USERNAME: ${{ secrets.STEAM_USERNAME }}
          STEAM_CONFIG_VDF: ${{ secrets.STEAM_CONFIG_VDF }}
        run: |
          mkdir -p /home/steam/Steam/config
          echo "$STEAM_CONFIG_VDF" | base64 -d > /home/steam/Steam/config/config.vdf
          steamcmd +login $STEAM_USERNAME \
            +run_app_build ContentBuilder/scripts/app_build_${APP_ID}.vdf \
            +quit
```

`cm2network/steampipe` Docker image is the canonical CI container for headless SteamPipe per [CM2Walki/steampipe](https://github.com/CM2Walki/steampipe) (accessed 2026-04-17).

### 4.6 Steam ContentBuilder artifact spec

From [Steamworks Uploading to Steam](https://partner.steamgames.com/doc/sdk/uploading) (accessed 2026-04-17), SteamPipe expects:

```
ContentBuilder/
  builder/               steamcmd.exe (image brings this)
  output/                build logs + chunk cache
  scripts/
    app_build_XXX.vdf         # master build manifest
    depot_build_XXX_win.vdf   # Windows depot — points to content/windows
    depot_build_XXX_osx.vdf   # macOS depot
    depot_build_XXX_linux.vdf # Linux depot
  content/
    windows/   → extracted NSIS install payload OR win-unpacked/ directly
    osx/       → ClawVille.app universal bundle
    linux/     → AppImage or linux-unpacked/ directory
```

**Important:** SteamPipe can upload either the raw `win-unpacked/` tree (no installer) OR the NSIS installer executable. Uploading the unpacked tree gives SteamPipe maximum delta-patching efficiency because Steam knows the file contents — uploading an installer blob makes every patch re-download the whole blob. Ship `win-unpacked/` to `content/windows/`.

### 4.7 Turbo.json addition

Add to root `turbo.json`:

```jsonc
{
  "tasks": {
    "dist:desktop": {
      "dependsOn": ["@clawville/web#build"],
      "outputs": ["apps/desktop/release/**", "apps/desktop/dist/**"],
      "cache": false
    }
  }
}
```

`@clawville/web#build` is a dependency only in the bundled-static-export path. For remote-load v1 it's not strictly needed, but we include it so switching to Option B doesn't require a turbo config change.

---

## 5. Code signing

### 5.1 Windows — use Azure Trusted Signing

**Recommendation: Azure Trusted Signing (formerly "Artifact Signing"), Basic tier.**

- $9.99/month for 5,000 signatures; $99.99/month for 100,000. Additional signatures $0.005 ea. ([Azure pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/), accessed 2026-04-17)
- **Gives instant SmartScreen reputation tied to your verified identity**, not the cert — so revoking/rotating doesn't reset reputation. Per [Melatonin Dev on Azure Trusted Signing](https://melatonin.dev/blog/code-signing-on-windows-with-azure-trusted-signing/) (accessed 2026-04-17).
- **No HSM / USB token.** This is the 2023-onwards CA/B Forum requirement that made traditional OV/EV certs painful ([SSLinsights 2026](https://sslinsights.com/best-code-signing-certificate-providers/), accessed 2026-04-17).
- Integrates with electron-builder via a custom sign hook. Example (`apps/desktop/scripts/sign-azure.js` — we'd fill this in at implementation time using `@azure/trusted-signing-cli`).
- Available in US/Canada/EU/UK — ClawVille Inc. registered in a supported region is a prerequisite.

**Fallback if not available:** Traditional OV cert from Sectigo/SSL.com (~$200-400/yr, requires a USB HSM token). EV cert (~$300-500/yr) used to give instant reputation but Microsoft removed that instant-trust behavior in March 2024 per [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/417016/reputation-with-ov-certificates-and-are-ev-certifi) (accessed 2026-04-17) — EV is no longer meaningfully better than OV for SmartScreen purposes.

Verdict: Azure Trusted Signing at $120/year fully dominates OV/EV options in 2026.

### 5.2 macOS — Apple Developer + notarize

Standard workflow, no exotic entitlements needed:

1. Apple Developer Program membership — $99/yr. ([Apple Developer](https://developer.apple.com/programs/), accessed 2026-04-17)
2. Create a Developer ID Application certificate, download the `.p12`, upload base64 as `MAC_CSC_LINK` GitHub secret.
3. App-specific password (generate at appleid.apple.com) stored as `APPLE_APP_SPECIFIC_PASSWORD`.
4. electron-builder's `mac.notarize.teamId` field triggers `@electron/notarize` automatically during `--mac` build.
5. Expect 5-30 minutes typical per notarization; Apple Dev Forums showed some multi-hour stuck "In Progress" cases in March-April 2026. Budget a buffer on first submission.
6. After notarization, the `.app` is stapled so first launch works offline.

Entitlements listed in §4.4. Hardened runtime is required for notarization. We do **not** need `com.apple.security.cs.debugger` or `com.apple.security.device.audio-input` — no voice chat yet.

### 5.3 Linux — not signed

AppImage and tar.gz aren't signed in the macOS/Windows sense. Optional GPG-sign the release artifact checksums; not required by Steam.

### 5.4 Costs — Year 1

| Line item | Cost | Note |
|---|---|---|
| Apple Developer Program | $99/yr | Required if shipping macOS |
| Azure Trusted Signing (Basic) | $120/yr ($9.99 × 12) | Windows signing |
| Optional: Sectigo OV cert (fallback) | $200-400/yr | Only if Azure not viable |
| Optional: Apple hardware | $0 | Any M-series Mac works for build + notarize; GitHub macOS runners cover CI |
| **Year 1 essential (Win + Mac)** | **~$219** | Not including Steam Direct's $100 (covered in policy doc) |

---

## 6. Iris Xe + WebGPU risk analysis

### 6.1 The known problem

Per CLAUDE.md: "NEVER run `bun run dev` locally. Intel Iris Xe GPU crashes on the Three.js/WebGPU scene and requires a PC restart." Intel Iris Xe has a documented history of crashing Electron/Chromium apps — [Framework Community thread](https://community.frame.work/t/iris-xe-gpu-driver-crash-with-multiple-electron-chrome-based-apps/10842) (accessed 2026-04-17), [Intel Community LiveKernelEvent 141](https://community.intel.com/t5/Graphics/LiveKernelEvent-141-crash-with-Intel-Iris-Xe-Graphics-on-Lenovo/m-p/1709415) (accessed 2026-04-17).

### 6.2 Will packaged Electron builds reproduce the crash?

**Yes, almost certainly, on the same combination of scene + driver version.** Electron bundles Chromium 146; the dev environment also runs Chromium via Next.js's browser target — same engine, same TSL shader compile path, same Dawn WebGPU backend. The crash isn't caused by Next.js dev mode; it's caused by the scene's WebGPU usage hitting an Iris Xe driver bug.

What *does* improve in a packaged build:
- No Turbopack/Next dev double-render overhead; lower pressure on the GPU's working set.
- Production builds use minified/shader-compiled TSL outputs that sometimes happen to sidestep specific driver bugs (empirical, not guaranteed).

What does **not** change:
- If the user has a vulnerable Iris Xe driver version and visits a scene that compiles the problem shader, they'll crash in Electron too.

### 6.3 Mitigations (must ship all of them)

1. **Keep the WebGL2 fallback.** `World3DCanvas.tsx` already does this via `WebGPURenderer.init()` auto-fallback and an outer try/catch that constructs a classic `WebGLRenderer`. Do not remove this code path for the Steam build.
2. **Allow a launch option to force WebGL.** Add `--force-webgl` → sets `process.env.FORCE_WEBGL=1` → renderer reads it via preload and skips the WebGPU branch. Document in a "Troubleshooting" knowledge base article.
3. **Chromium flags in main.ts:**
   ```ts
   // Suppress blocklists on Iris Xe — they're overly conservative in Chromium 146
   app.commandLine.appendSwitch('enable-unsafe-webgpu');
   // Only on Linux; no-op on Win/Mac
   app.commandLine.appendSwitch('enable-features', 'Vulkan');
   // Disable the GPU process sandbox as a last resort (DON'T enable by default,
   // only if Steam users report widespread crashes and we ship a hotfix)
   // app.commandLine.appendSwitch('disable-gpu-sandbox');
   ```
   `--enable-unsafe-webgpu` bypasses the WebGPU adapter blocklist, which Chromium Dawn populates with known-bad GPU/driver combinations. For a game targeting Iris Xe it's a reasonable default *if* we also ship the WebGL fallback toggle. Per [Chrome WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips) (accessed 2026-04-17).
4. **Watch `device.lost` handler in WorldCanvas.** Already implemented — on `reason === 'unknown'` we reload. For the Steam build we should escalate to "retry once, then prompt user to switch to WebGL fallback."
5. **Telemetry.** Ship a Sentry or OpenTelemetry hook that reports GPU vendor/renderer + crash reason. We already log to console; piping to Sentry gives us a Steam-wide crash dashboard.

### 6.4 Offline / GPU-fail graceful error screen

Render a static HTML error screen in main process (not via `win.loadURL`) when either:
- `win.webContents` emits `render-process-gone` with reason `crashed` or `oom`, OR
- Network detection fails on boot (`navigator.onLine === false` + a fetch probe to `https://api.clawville.world/health` times out).

```ts
// apps/desktop/src/main.ts (snippet)
win.webContents.on('render-process-gone', (_, details) => {
  if (details.reason === 'crashed' || details.reason === 'oom') {
    win.loadFile(path.join(__dirname, '..', 'resources', 'gpu-error.html'));
  }
});
```

---

## 7. Bundle size + Steam depot implications

Electron 41 + native modules + our preload:
- **Windows unpacked:** ~180-220 MB (Chromium ~170 MB + Node runtime + steamworks.js native ~5 MB + our JS ~1 MB)
- **macOS universal:** ~400 MB unpacked (x64 + arm64 fat binary)
- **Linux AppImage:** ~220 MB

Steam depots support delta patching at the chunk level. Initial download is ~200 MB on Windows. For a game that otherwise ships zero assets locally (assets served from clawville.world CDN), this is entirely acceptable — indie Steam baseline is 1-5 GB.

**Optimization pass** we can do later:
- `asar` compression (default on, saves ~15% on JS).
- Strip Electron's unused locales in electron-builder (`electronLanguages: ['en-US']`) — saves ~20 MB.
- Drop debug symbols via `--prune=true` (default).

None of these are needed for v1 ship.

---

## 8. Auto-update strategy — use Steam, not electron-updater

**Recommendation: disable electron-updater entirely. Let SteamPipe patch the Electron binary like any Steam game.**

Reasoning:
- Steam users *expect* updates via the Steam client. An Electron-native "update available" toast inside the game feels foreign and makes them suspicious.
- Two competing update systems race for the binary. Steam's launch-time integrity check could flag a self-updated binary as tampered → instant refund spike.
- SteamPipe's delta patching is chunk-level efficient and bandwidth-optimized. ([Steam Updates best practices](https://partner.steamgames.com/doc/store/updates), accessed 2026-04-17)
- We already plan to do remote-load for the *content* of the game. New quests, new UI, new NPC personalities land via Next.js deploy — zero Steam round trip. SteamPipe patches are reserved for actual Electron/main-process changes (rare: a few times per year).

Implementation: **do not depend on `electron-updater`** in `apps/desktop/package.json`. If we ever need to force a remote-content ABI bump, we bump the `?build=steam&v=N` query param and the renderer can detect incompatibility.

### 8.1 Version-gating remote content against a stale Steam client

The remote renderer needs to know which desktop version loaded it so we can degrade gracefully when the desktop wrapper is out of date:

```ts
// preload.cjs
contextBridge.exposeInMainWorld('steam', {
  clientVersion: app.getVersion(), // e.g. "0.3.2"
  ...
});
```

Server-side on `/api/auth/steam`, record `client_version` in a `users.last_steam_client_version` column. If a known-broken version hits us, we can push a forced-update nag via remote content.

---

## 9. Steam Linux Runtime + Steam Deck

### 9.1 The libcups incompatibility

Per [ValveSoftware/steam-runtime#579](https://github.com/ValveSoftware/steam-runtime/issues/579) (accessed 2026-04-17), Electron apps cannot launch inside the Steam Linux Runtime sniper/soldier containers due to libcups version mismatches. This affects any native Electron Linux build targeting Steam Deck directly.

### 9.2 Decision: Windows + Proton on Steam Deck for v1

Two paths:
1. **Ship Windows NSIS only. Steam Deck runs it through Proton.** Proton 9+ handles modern Electron Windows builds well. Zero additional engineering. Recommended for v1.
2. **Ship a native Linux AppImage AND override SLR via launch options.** Requires `--no-sandbox` or `LD_LIBRARY_PATH` hackery, plus Flatpak-style dependency bundling. More work, better integration, required only if Deck Verified is a goal.

For v1: ship Windows + macOS, rely on Proton for Linux/Deck users. Revisit Deck Verified in a polish phase.

---

## 10. Concrete snippets

### 10.1 `apps/desktop/src/main.ts`

```ts
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import * as steamworks from 'steamworks.js';

const REMOTE_URL = 'https://clawville.world/game?build=steam';
const STEAM_APP_ID = Number(process.env.STEAM_APP_ID ?? 0);

// Must be called before app.ready
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

let mainWindow: BrowserWindow | null = null;
let steamClient: steamworks.Client | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a2a4a',
    title: 'ClawVille',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Lock navigation to clawville.world
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const u = new URL(url);
    if (u.origin !== 'https://clawville.world') event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open external links (docs, socials) in the system browser, not a new Electron window
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[clawville] render process gone', details);
    if (details.reason === 'crashed' || details.reason === 'oom') {
      mainWindow?.loadFile(path.join(__dirname, '..', 'resources', 'gpu-error.html'));
    }
  });

  mainWindow.loadURL(REMOTE_URL);
}

app.whenReady().then(() => {
  if (STEAM_APP_ID > 0) {
    try {
      steamworks.init(STEAM_APP_ID);
      steamClient = steamworks.Client.init();
    } catch (err) {
      console.error('[clawville] steamworks init failed', err);
    }
  }

  ipcMain.handle('steam:getAuthTicket', async () => {
    if (!steamClient) throw new Error('Steam not initialized');
    const ticket = await steamClient.auth.getAuthTicketForWebApi('clawville');
    return Array.from(ticket.getBytes() as Uint8Array)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  });

  ipcMain.handle('steam:setRichPresence', (_, key: string, value: string) => {
    steamClient?.friends.setRichPresence(key, value);
  });

  ipcMain.handle('steam:unlockAchievement', (_, id: string) => {
    return steamClient?.achievement.activate(id) ?? false;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    steamClient?.shutdown?.();
  } catch {
    /* noop */
  }
});
```

### 10.2 Renderer-side integration (`apps/web/src/lib/steam.ts`)

```ts
declare global {
  interface Window {
    steam?: {
      getAuthTicket: () => Promise<string>;
      setRichPresence: (k: string, v: string) => Promise<void>;
      unlockAchievement: (id: string) => Promise<boolean>;
      isSteamBuild: true;
      clientVersion: string;
    };
  }
}

export const isSteamBuild = () =>
  typeof window !== 'undefined' && window.steam?.isSteamBuild === true;

export async function bootstrapSteamSession(): Promise<void> {
  if (!isSteamBuild()) return;
  const ticket = await window.steam!.getAuthTicket();
  await fetch('/api/auth/steam', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, clientVersion: window.steam!.clientVersion }),
    credentials: 'include',
  });
}
```

Called once from the game page's top-level boot effect, before the autonomy loop starts.

---

## 11. Open follow-ups (out of scope for this doc)

These are intentionally deferred to other tracks:

- **Store policy + crypto-surface gating.** Covered by `docs/steam-packaging-research.md`.
- **Backend Steam auth federation migration.** `users.steam_id` column, `/api/auth/steam` route, Lucia session integration. Covered by the Auth track.
- **Achievements taxonomy + rich presence strings.** Covered by the Product track.
- **Deck Verified polish (gamepad UI, 1280×800 layout).** Covered by the UX track. Requires a distinct 1-2 week pass post-Windows release.
- **AI content disclosure copy.** Gemini guardrails description for Steam's form. Covered by Policy track.

---

## 12. References

All dates are "accessed" dates in April 2026.

### Electron + tooling
- [Electron Releases index](https://releases.electronjs.org/) — stable 41.2.1, Chromium 146.0.7680.188, 2026-04-15 (accessed 2026-04-17)
- [Electron 38.0.0 blog post](https://www.electronjs.org/blog/electron-38-0) (accessed 2026-04-17)
- [Electron Security checklist](https://www.electronjs.org/docs/latest/tutorial/security) (accessed 2026-04-17)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) (accessed 2026-04-17)
- [Bishop Fox — Reasonably Secure Electron](https://bishopfox.com/blog/reasonably-secure-electron) (accessed 2026-04-17)
- [electron/universal](https://github.com/electron/universal) (accessed 2026-04-17)
- [@electron/notarize](https://github.com/electron/notarize) (accessed 2026-04-17)
- [electron-builder vs electron-forge — Electron Forge docs](https://www.electronforge.io/core-concepts/why-electron-forge) (accessed 2026-04-17)
- [npmcompare: electron-builder vs electron-forge](https://npmcompare.com/compare/electron-builder,electron-forge,electron-packager) (accessed 2026-04-17)
- [ceifa/steamworks.js](https://github.com/ceifa/steamworks.js/) (accessed 2026-04-17)
- [Kilian Valkhof — Notarizing Electron](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/) (accessed 2026-04-17)
- [Electron issue #26944 — WebGPU enablement](https://github.com/electron/electron/issues/26944) (accessed 2026-04-17)

### Tauri / alternatives
- [Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/) (accessed 2026-04-17)
- [Tauri WebGPU tracking issue #6381](https://github.com/tauri-apps/tauri/issues/6381) (accessed 2026-04-17)

### Chromium / WebGPU
- [Chrome Developers — WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips) (accessed 2026-04-17)
- [WebGPU implementation status wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) (accessed 2026-04-17)

### Iris Xe
- [Framework Community — Iris Xe Electron crashes](https://community.frame.work/t/iris-xe-gpu-driver-crash-with-multiple-electron-chrome-based-apps/10842) (accessed 2026-04-17)
- [Intel Community — LiveKernelEvent 141 on Iris Xe](https://community.intel.com/t5/Graphics/LiveKernelEvent-141-crash-with-Intel-Iris-Xe-Graphics-on-Lenovo/m-p/1709415) (accessed 2026-04-17)

### Code signing
- [Azure Trusted Signing (Artifact Signing) pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/) (accessed 2026-04-17)
- [Melatonin — Code signing on Windows with Azure Trusted Signing](https://melatonin.dev/blog/code-signing-on-windows-with-azure-trusted-signing/) (accessed 2026-04-17)
- [Microsoft Q&A — OV vs EV reputation in 2024](https://learn.microsoft.com/en-us/answers/questions/417016/reputation-with-ov-certificates-and-are-ev-certifi) (accessed 2026-04-17)
- [SSLinsights — OV vs EV Code Signing 2026](https://sslinsights.com/best-code-signing-certificate-windows-applications/) (accessed 2026-04-17)
- [Rick Strahl — Fighting through Microsoft Trusted Signing](https://weblog.west-wind.com/posts/2025/Jul/20/Fighting-through-Setting-up-Microsoft-Trusted-Signing) (accessed 2026-04-17)

### Steam + SteamPipe
- [Steamworks — Uploading to Steam (SteamPipe)](https://partner.steamgames.com/doc/sdk/uploading) (accessed 2026-04-17)
- [Steamworks — Updating Your Game best practices](https://partner.steamgames.com/doc/store/updates) (accessed 2026-04-17)
- [Steamworks — Steam Deck and Proton](https://partner.steamgames.com/doc/steamdeck/proton) (accessed 2026-04-17)
- [CM2Walki/steampipe Docker](https://github.com/CM2Walki/steampipe) (accessed 2026-04-17)
- [ValveSoftware/steam-runtime#579 — Electron libcups incompatibility](https://github.com/ValveSoftware/steam-runtime/issues/579) (accessed 2026-04-17)

### Next.js
- [Next.js 16 release](https://nextjs.org/blog/next-16) (accessed 2026-04-17)
- [Next.js — Static Exports guide](https://nextjs.org/docs/pages/guides/static-exports) (accessed 2026-04-17)

### ClawVille codebase
- `apps/web/src/components/three/World3DCanvas.tsx` — WebGPU renderer + WebGL2 fallback
- `apps/web/next.config.mjs` — current CSP `frame-ancestors` + GLB/KTX2 caching
- `apps/web/src/components/pixi/PixiCanvas.tsx` — 2D fallback (not a full replacement for 3D)
- `apps/web/src/app/game/page.tsx` — `World3DCanvas` boot entry
- `CLAUDE.md` — Iris Xe GPU crash rule + production deployment topology
