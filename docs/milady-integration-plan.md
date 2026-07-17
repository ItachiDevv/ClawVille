# ClawVille → Milady App Store Submission — Plan v2

**Status:** Draft v2, 2026-04-10 (supersedes v1 which had the direction inverted)
**Author:** Claude (this session)
**Scope:** ClawVille as a submitted Milady app, not Milady as a ClawVille identity provider

---

## §0 — What changed in v2

Plan v1 got the integration direction wrong. I assumed **Milady users would connect their agents to ClawVille** (Milady = identity provider). The user corrected me:

> *"we leverage their app in ours, and are submitting our app to their app store"*

So the real direction is inverted:

- **ClawVille is the app being submitted** (like Babylon, Defense of the Agents, 2004scape, Shopify)
- **Milady is the host platform** that embeds ClawVille as a viewer + speaks to its API
- **The submission** is a PR to `github.com/milady-ai/milady` adding a new plugin at `plugins/app-clawville/` + an entry in the curated app list

Everything below assumes this direction.

---

## §1 — Milady's app store: the actual mechanism

### §1.1 — The curated list

Milady's "app store" is a hand-curated TypeScript constant in `packages/shared/src/contracts/apps.ts`:

```ts
export const MILADY_CURATED_APP_DEFINITIONS: readonly MiladyCuratedAppDefinition[] = [
  { slug: "companion",               canonicalName: "@miladyai/app-companion",               aliases: [] },
  { slug: "hyperscape",              canonicalName: "@hyperscape/plugin-hyperscape",         aliases: ["@elizaos/app-hyperscape"] },
  { slug: "babylon",                 canonicalName: "@elizaos/app-babylon",                  aliases: [] },
  { slug: "2004scape",               canonicalName: "@elizaos/app-2004scape",                aliases: [] },
  { slug: "defense-of-the-agents",   canonicalName: "@elizaos/app-defense-of-the-agents",    aliases: [] },
  { slug: "vincent",                 canonicalName: "@miladyai/app-vincent",                 aliases: [] },
  { slug: "shopify",                 canonicalName: "@elizaos/app-shopify",                  aliases: ["@elizaos/plugin-shopify"] },
];
```

**To "submit ClawVille" means opening a PR that adds an 8th entry:**
```ts
{ slug: "clawville", canonicalName: "@clawville/app-clawville", aliases: [] },
```

Plus the plugin code that backs it.

### §1.2 — The plugin structure (learned from app-babylon + app-defense-of-the-agents)

Every app plugin lives at `plugins/app-<slug>/` inside the Milady monorepo and ships this layout:

```
plugins/app-clawville/
  package.json          # contains the elizaos.app manifest block
  src/
    index.ts            # exports { handleAppRoutes, resolveLaunchSession }
    routes.ts           # the real logic — HTTP proxy, viewer HTML builder, session state
    clawville-auth.ts   # config resolution + shared fetch helpers
```

The `package.json` is the app manifest. Example from `app-defense-of-the-agents`:

```json
{
  "name": "@clawville/app-clawville",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Milady app integration for ClawVille — sea-themed agent game.",
  "main": "./src/index.ts",
  "exports": {
    "./package.json": "./package.json",
    ".": "./src/index.ts",
    "./routes": "./src/routes.ts"
  },
  "homepage": "https://clawville.world/",
  "repository": { "type": "git", "url": "https://github.com/milady-ai/milady.git" },
  "keywords": ["game", "agents", "sea", "openclaw", "elizaos"],
  "dependencies": {
    "@elizaos/core": "workspace:*",
    "@miladyai/shared": "workspace:*"
  },
  "elizaos": {
    "kind": "app",
    "app": {
      "displayName": "ClawVille",
      "category": "game",
      "launchType": "connect",
      "launchUrl": "https://clawville.world/game",
      "capabilities": ["game", "skill-learning", "tokens", "multi-agent"],
      "runtimePlugin": "@clawville/app-clawville",
      "viewer": {
        "url": "/api/apps/clawville/viewer",
        "sandbox": "allow-scripts allow-same-origin allow-popups allow-forms"
      },
      "session": {
        "mode": "spectate-and-steer",
        "features": ["commands", "telemetry", "suggestions"]
      }
    }
  }
}
```

### §1.3 — What `handleAppRoutes` and `resolveLaunchSession` do

From reading `app-defense-of-the-agents/src/routes.ts`:

**`resolveLaunchSession(ctx: AppLaunchSessionContext)`**
- Called when a user clicks "Launch" on the Milady app card
- `ctx.runtime` is the Milady agent runtime (has `agentId`, `getSetting()`, `character.name`, …)
- The function calls the external service's API to establish a session
- Returns an `AppSessionState` that Milady renders in the side panel

**`handleAppRoutes(ctx)`**
- Called for every HTTP request that hits `/api/apps/<slug>/*` on the Milady embedded server (port 2138)
- The plugin decides which sub-routes it owns and returns `true` when it handled the request
- Main sub-routes implemented by Defense of the Agents:
  - `GET  /api/apps/defense-of-the-agents/viewer` — serves the **modified HTML** of the external site (fetches, rewrites assets, injects bootstrap script to hide login UI + auto-auth)
  - `GET  /api/apps/defense-of-the-agents/{sessionId}` — session state poll
  - `POST /api/apps/defense-of-the-agents/{sessionId}/command` — agent command
  - `POST /api/apps/defense-of-the-agents/{sessionId}/control` — pause/resume

### §1.4 — The viewer HTML rewrite trick

The most interesting piece. Defense of the Agents implements `buildEmbeddedViewerHtml(runtime)`:

1. Resolves `viewerUrl` (e.g. `https://www.defenseoftheagents.com/`)
2. Fetches the real HTML
3. Runs it through `absolutizeViewerHtmlAssetUrls(html, viewerUrl)` to fix relative paths (`<link href="/app.css">` → `<link href="https://.../app.css">`)
4. Builds a `<style>` + `<script>` injection that:
   - Passes the agent name via `JSON.stringify(agentName)` into the inline script
   - Hides login overlays, join buttons, and store panels (via a `MutationObserver` that re-applies as the SPA re-renders)
   - Adds a "Watching {agentName}" banner with a link back to the full site
5. Injects before `</head>` and serves with CSP `frame-ancestors` allowing Milady's embed origins:
   ```
   'self' http://localhost:* https://localhost:* electrobun: capacitor: tauri: file:
   ```
6. Strips `X-Frame-Options` from the upstream response

**This is how Milady embeds any web app without requiring the app to know anything about Milady.** The plugin is a transparent proxy that adds auth + embed-mode UI.

### §1.5 — Agent-level configuration

Milady stores per-agent secrets in `runtime.character.secrets` + `runtime.getSetting()`. The plugin's auth module resolves via a helper:

```ts
export function resolveSettingLike(runtime, key) {
  return runtime?.getSetting?.(key) ?? process.env[key] ?? undefined;
}
```

Babylon uses `BABYLON_AGENT_ID` + `BABYLON_AGENT_SECRET`. Defense of the Agents uses `DEFENSE_API_URL`. **Our convention**: `CLAWVILLE_API_URL`, `CLAWVILLE_AGENT_ID`, `CLAWVILLE_SESSION_TOKEN`.

**IMPORTANT**: These settings are per-agent, not global. A user running Milady with 3 different agents can have each agent connected to a separate ClawVille session.

---

## §2 — The ClawVille side: what changes

Six areas need changes on the ClawVille codebase (this repo) to make the Milady plugin work cleanly.

### §2.1 — Identity: Milady → ClawVille session exchange

User answered question 5: **"ClawVille here" is the identity provider**.

The flow is:

```
Milady agent clicks "Launch ClawVille"
  ↓
Milady plugin's resolveLaunchSession() fires
  ↓
Plugin POSTs to https://api.clawville.world/api/agent/connect
  body: {
    identityType: "milady",
    miladyAgentId: runtime.agentId,
    miladyAgentName: runtime.character.name,
    miladyInstanceId: <derived from some stable fingerprint>,
    species: <preference or default>,
    ...
  }
  ↓
ClawVille:
  1. Creates or looks up an openclaw_bots row keyed on miladyAgentId
  2. AUTO-GENERATES a Solana wallet for the agent (question 7 follow-up)
  3. Spawns an NPC in the world
  4. Returns { sessionId, agentId, walletAddress, eventsUrl, position }
  ↓
Milady plugin stashes the sessionId via runtime.setSetting("CLAWVILLE_SESSION_ID", sessionId)
  ↓
Plugin returns an AppSessionState to Milady's side panel
```

No token round-trip, no mTLS, no browser-mediated handshake. ClawVille is stateless about who Milady is — anyone can POST to `/api/agent/connect` — but the plugin code lives inside a curated Milady app and therefore is trusted by the Milady user.

(Current contract, 2026-07-17: `milady` is the ClawVille-hosted public identity and requires the Milady runtime signal. It is one of exactly four public identities alongside Hermes, OpenClaw, and the general `custom` gateway path; internal wire-protocol names are not public identity types.)

### §2.2 — Auto-generated Solana wallets for avatars

Following Milady's pattern (`generateWalletKeys()` in `packages/agent/src/api/wallet.ts`), ClawVille should auto-generate a Solana keypair for every connecting agent. The Phase 4 treasury infrastructure is already wired up — we just need to add a **avatar custody wallet** pattern alongside the merchant wallet.

**Schema changes:**
- `avatars.walletAddress varchar(64) UNIQUE` — base58 public key
- `avatar_wallets` table (new, parallel to `treasury_wallets`):
  ```ts
  id uuid PK
  avatar_id uuid FK -> avatars.id (unique)
  public_key varchar(64) UNIQUE
  encrypted_secret_key text
  encryption_iv varchar(32)
  encryption_tag varchar(32)
  created_at timestamp
  ```
- OR alternately, reuse `treasury_wallets` with a new `purpose: 'avatar-custody'` enum value and a nullable `avatar_id` column. **I lean toward a separate `avatar_wallets` table** because the access patterns are different (avatars query by their own id, treasury queries by purpose) and it keeps the treasury table focused on merchant/fee-collector/escrow purposes.

**Encryption:**
- Reuse the existing `VANITY_ENCRYPTION_KEY` AES-256-GCM master key
- Reuse `encryptSecretKey()` / `decryptSecretKey()` from `apps/api/src/services/keypair-vault.ts`
- The private key never leaves the ClawVille API server. For now, the wallet is **custodial** — ClawVille signs on the agent's behalf. Export/withdrawal is out of scope for v1.

**Auto-gen trigger points:**
1. **On avatar creation** (via the existing `POST /api/avatars` endpoint for human players)
2. **On first Milady connect** — when an agent connects without a matching row, `/api/agent/connect` auto-generates a wallet as part of creating the `openclaw_bots` row
3. **Lazy backfill** — a migration script that generates wallets for existing avatars that don't have one yet

### §2.3 — CORS + CSP for Milady embedding

ClawVille's web frontend (`https://clawville.world/game`) needs to be embeddable in Milady's viewer. This means:

**On `clawville.world/game`:**
- Remove `X-Frame-Options: DENY` (if set by Next.js middleware)
- Add CSP: `Content-Security-Policy: frame-ancestors 'self' https://*.clawville.world http://localhost:* https://localhost:* electrobun: capacitor: tauri: file:;`
- Ensure the page doesn't break when loaded in an iframe (test: `<iframe src="https://clawville.world/game">` in a local HTML file)

**On `api.clawville.world`:**
- Extend `CORS_ORIGIN` env var to include Milady embed origins: `electrobun://`, `capacitor://localhost`, `http://localhost:2138`, `http://localhost:5173`, and the dynamic `file://` for Electrobun packaged apps
- Already partially handled in `apps/api/src/index.ts:36-44` which allows any `http://localhost:*` — Milady production ships on Electrobun which may use `app://` or `electrobun://` URL schemes for the renderer

### §2.4 — Login bypass when embedded

When ClawVille's web app loads inside a Milady viewer, the current flow sends the user to `/login` because there's no auth cookie. That breaks the embedded experience.

Two options:

**(A) postMessage handshake** — the Milady plugin injects a bootstrap script that posts a message to the ClawVille iframe with `{ type: 'milady-auth', sessionId, agentId }`. ClawVille's `page.tsx` listens for that message, and if received, calls `/api/auth/milady-session-exchange` with the Milady sessionId, gets back a ClawVille auth cookie, and proceeds.

**(B) Query parameter token** — Milady plugin rewrites the `launchUrl` to include `?milady_session=<token>` (signed JWT). ClawVille's login middleware detects the param, verifies the JWT, auto-logs-in as a "guest" user, and strips the param from the URL.

**I lean toward (A)** because it's how Babylon/DOTA both seem to do it (the `buildViewerShellInjection` pattern injects runtime data via inline JS) and because it's more secure (no token in URL/referrer headers).

### §2.5 — Skill catalog (trivial reuse of existing work)

We already ship `GET /api/skills` (JSON index) and `GET /api/skills/:buildingId/skill.md` (raw markdown). Milady's `packages/agent/src/types/agent-skills.ts` + `packages/app-core/src/services/agent-skills-catalog-fetch.ts` should be able to consume our existing endpoint as-is, OR we may need a slightly different shape.

**Action**: read the Milady catalog type definition to confirm. This is still open (§4.3 in v1).

### §2.6 — VRM avatar support (question 6)

User answered yes to VRM: plan the data model now, implement later.

**Schema addition:**
- `avatars.avatarType enum('glb', 'vrm') default 'glb'`
- `avatars.avatarUrl text` — URL to the model file (currently implicit based on species + color lookup)
- `avatars.vrmMetadata jsonb` — Expression map, animation names, bone mapping

Rendering work (Phase 5, probably needs the 3da subagent):
- `World3DCanvas.tsx` checks `avatar.avatarType` and dispatches to either the existing lobster GLB or a new VRM renderer
- VRM renderer uses `@pixiv/three-vrm` — same package Milady uses
- Graceful fallback if VRM load fails (loads the lobster GLB)

---

## §3 — Critical self-assessment

Things I'm confident about (I have direct source evidence):

1. **The plugin structure** — I read the actual `package.json` manifest format and the actual `routes.ts` of two existing apps (Babylon + Defense of the Agents). The shape is concrete, not guessed.
2. **The curated list mechanism** — I read `packages/shared/src/contracts/apps.ts` and saw the exact array + type.
3. **The MIT license** — I read the actual `LICENSE` file, not the prior research doc which was wrong.
4. **The viewer HTML rewrite trick** — I read `buildEmbeddedViewerHtml` directly and traced the injection logic. The CSP `frame-ancestors` values are copied verbatim.
5. **Agent-level config resolution** — Babylon's `resolveSettingLike` pattern is clearly the Milady convention.
6. **Wallet auto-generation exists in Milady** — I read `packages/agent/src/api/wallet.ts` and saw `generateWalletKeys()`, `generateWalletForChain()`, `deriveSolanaAddress()`. Milady auto-generates wallets on startup for ITSELF. The game plugins (Babylon) don't auto-gen wallets for connected agents — Babylon uses pre-configured `BABYLON_AGENT_ID` + `BABYLON_AGENT_SECRET`. **Our proposal to auto-gen a Solana wallet per avatar is a ClawVille-specific innovation**, not a copy of existing app-plugin patterns.

Things I'm NOT sure about:

1. **How Milady actually installs a plugin from GitHub before it's in the curated list** — for DEV testing during the PR cycle, we need to sideload `@clawville/app-clawville` into a local Milady checkout. I haven't yet found the "install by GitHub URL" mechanism in the CLI. Need to read `apps/cli` or the installation docs.

2. **What a `launchType: "connect"` actually does vs other values** — I saw `"connect"` on DOTA but never the full enum. Could be `"connect"` | `"embed"` | `"external"` | `"viewer-only"`. Need to grep the agent package for the type definition.

3. **Whether there's a review/QA process for curated apps** — submitting a PR to the Milady repo is the mechanism, but is there a reviewer (human? bot? test suite?) who validates the plugin against some acceptance criteria? Need to check CONTRIBUTING.md or the PR template.

4. **The agent settings UX** — when a user installs ClawVille in Milady, they probably see a "configure this app" dialog that asks for `CLAWVILLE_AGENT_ID` etc. We need to know what fields are shown and whether they're required at install time or can be provisioned lazily on first launch. For v1 we want the smoothest flow: zero config, just click "Launch" and we auto-provision everything server-side.

5. **Session lifecycle** — what happens when a Milady agent stops? Does Milady call an unregister endpoint? The `app-package-routes.ts` file I saw suggests a `stop-app` route exists, which would then hit the plugin's own teardown hook. Need to verify.

6. **Cost of being wrong about the CSP/CORS details.** If our `frame-ancestors` list is too narrow, the viewer shows a blank frame with no error — incredibly hard to debug. Need to test against a real Milady build (ideally the Electrobun desktop one) before we submit.

7. **Whether ClawVille's web app currently works in an iframe at all.** Next.js 16 can set `X-Frame-Options: DENY` by default via `next.config.mjs` security headers, and any third-party widget we load (Cloudflare Turnstile, Stripe, etc.) might add its own X-Frame-Options headers. **Need to test before submitting.**

8. **The "custodial avatar wallet" proposal has legal/regulatory implications.** Holding user keys in a KYC-free game could attract MSB or money-transmitter scrutiny in some jurisdictions if the wallet ever holds real value. Worth a lightweight legal review before Phase 5 makes these wallets load-bearing. For v1 (empty wallets only used as x402 payment sources for ~$0.001 pings) the risk is nil.

9. **Direction #7 in the original prompt — "if other apps auto-generate wallets for connected agents, we should too"** — **this premise doesn't fully hold up under the evidence.** Milady auto-generates wallets for the Milady user's own agent on startup. Babylon/Defense of the Agents don't auto-gen wallets for agents that connect to them; they require pre-configured agent credentials. **So we have two valid paths:**
   - **(a)** Follow the Babylon/DOTA precedent: require users to configure `CLAWVILLE_AGENT_ID` in Milady before launching. Simple, matches the canon. No wallet auto-gen.
   - **(b)** Pioneer a new pattern: auto-gen a Solana wallet for every ClawVille visitor, inspired by Milady's startup auto-gen. Richer UX but adds custody risk and schema.
   I'm recommending (b) because the user explicitly asked for it, but flagging that it's a **new pattern**, not an existing one being copied.

---

## §4 — File-by-file implementation plan

This is a **two-repo** plan because the work spans both `milady-ai/milady` (for the plugin) and `ItachiDevv/ClawVille` (for API changes).

### §4.1 — Milady-side changes (new files in `milady-ai/milady`)

#### Phase M1 — Plugin scaffold (~120 lines)

| File | New/Modified | Purpose | ~Lines |
|---|:-:|---|---:|
| `plugins/app-clawville/package.json` | NEW | App manifest with `elizaos.app` block | 50 |
| `plugins/app-clawville/src/index.ts` | NEW | Re-exports `handleAppRoutes` + `resolveLaunchSession` | 5 |
| `plugins/app-clawville/src/clawville-auth.ts` | NEW | `resolveClawvilleConfig()`, `resolveSettingLike()`, `proxyClawvilleRequest()` — mirrors `babylon-auth.ts` | 120 |
| `plugins/app-clawville/tsconfig.json` | NEW | Copies the babylon tsconfig | 10 |
| `packages/shared/src/contracts/apps.ts` | MODIFIED | Adds `{ slug: "clawville", canonicalName: "@clawville/app-clawville", aliases: [] }` to `MILADY_CURATED_APP_DEFINITIONS` | +5 |

#### Phase M2 — Routes + viewer (the core work) (~700 lines)

| File | Purpose | ~Lines |
|---|---|---:|
| `plugins/app-clawville/src/routes.ts` | The real logic. Implements: `resolveLaunchSession`, `refreshRunSession`, `collectLaunchDiagnostics`, `handleAppRoutes`, `buildEmbeddedViewerHtml`, `buildViewerShellInjection`, `sendHtmlResponse`, `applyViewerEmbedHeaders`. Proxies all sub-routes to `https://api.clawville.world`. | ~650 |
| `plugins/app-clawville/src/routes.test.ts` | Tests for `resolveLaunchSession` (mocked fetch), `handleAppRoutes` dispatch, viewer HTML injection integrity, CSP header presence | ~120 |

The `routes.ts` will define these Milady-side routes:
- `GET  /api/apps/clawville/viewer` — returns modified `clawville.world/game` HTML with injected auth bootstrap
- `GET  /api/apps/clawville/:sessionId` — session state poll (proxies to `GET https://api.clawville.world/api/agent/:sessionId/state`)
- `POST /api/apps/clawville/:sessionId/command` — execute an agent command (move/visit-building/chat/buy)
- `POST /api/apps/clawville/:sessionId/control` — pause/resume
- `POST /api/apps/clawville/:sessionId/stop` — disconnect

#### Phase M3 — Agent actions (optional but recommended) (~200 lines)

Defense of the Agents registers elizaOS **Actions** that let the agent issue in-game commands through natural language (e.g. "attack the top lane" → deploys a DOTA action). For ClawVille:

| File | Purpose | ~Lines |
|---|---|---:|
| `plugins/app-clawville/src/actions/visit-building.ts` | elizaOS Action: `VISIT_BUILDING` — agent can say "go to the tool workshop" and the plugin translates it to a POST to `/api/agent/:sessionId/visit-building` | 100 |
| `plugins/app-clawville/src/actions/learn-skill.ts` | elizaOS Action: `LEARN_SKILL` — agent can say "learn MCP" and the plugin figures out which building book teaches that, buys it, and marks it learned | 100 |

#### Phase M4 — Submission docs (~50 lines)

| File | Purpose |
|---|---|
| `plugins/app-clawville/README.md` | How this plugin works, how to run it locally, how to test against the ClawVille staging API |
| `plugins/app-clawville/CHANGELOG.md` | Follows Milady's convention (check existing plugin changelogs first) |

**Phase M totals: ~1200 lines across ~10 files, one PR to `milady-ai/milady`.**

### §4.2 — ClawVille-side changes (this repo)

#### Phase C1 — Milady identity type + session exchange (~400 lines)

| File | Change | ~Lines |
|---|---|---:|
| `packages/shared/src/types/openclaw.ts` | Add `'milady'` to `AgentIdentityType` union. Add `MiladyAgentMeta` interface: `{ miladyAgentId, miladyAgentName, miladyInstanceId?, preferredSpecies?, preferredColor? }` | +30 |
| `packages/database/src/schema/claws.ts` | Add `miladyAgentId text`, `miladyInstanceId text`, `miladyMeta jsonb` columns to `openclawBots` | +15 |
| `apps/api/src/services/milady-identity.ts` | NEW — `resolveMiladyAgent()`: takes the inbound metadata, creates or looks up a stable avatar identity, returns the canonical `agentId`. No external API call needed (ClawVille is the identity provider, per answer 5). | 100 |
| `apps/api/src/routes/agent-gateway.ts` | Extend `connectSchema` with Milady fields. Add a new identity branch that populates `identityType: 'milady'` and calls `resolveMiladyAgent()`. | +80 |
| `apps/api/src/routes/auth.ts` | NEW route: `POST /api/auth/milady-session-exchange` — takes a Milady `sessionId` from an iframe, mints a short-lived ClawVille auth cookie, returns 200. Used by the login bypass in §2.4(A). | +100 |
| `apps/web/src/app/page.tsx` + `game/page.tsx` | Add a `window.addEventListener('message', ...)` that listens for `{type: 'milady-auth', sessionId}` and calls the new auth endpoint | +50 |
| `bun run db:push` | Apply schema change | — |

#### Phase C2 — Auto-generated Solana avatar wallets (~300 lines)

| File | Change | ~Lines |
|---|---|---:|
| `packages/database/src/schema/avatar-wallets.ts` | NEW — `avatar_wallets` table (mirrors `treasury_wallets` shape, keyed on avatar_id) | 40 |
| `packages/database/src/schema/avatars.ts` | Add `walletAddress varchar(64) UNIQUE` column to `avatars` table | +2 |
| `packages/database/src/schema/index.ts` | Register new `avatarWallets` export + relation | +3 |
| `apps/api/src/services/avatar-wallet-service.ts` | NEW — `generatePetWallet(avatarId)`: calls `Keypair.generate()`, encrypts secret via `keypair-vault`, inserts into `avatar_wallets`, updates `avatars.walletAddress` | 80 |
| `apps/api/src/routes/avatars.ts` | Call `generatePetWallet()` on avatar creation if the avatar has no wallet | +20 |
| `apps/api/src/routes/agent-gateway.ts` | In the Milady branch, call `generatePetWallet()` when creating a new `openclaw_bots` row for a first-time Milady agent | +15 |
| `scripts/backfill-avatar-wallets.ts` | NEW — one-time script that finds all avatars without a wallet and generates one for each | 60 |
| `apps/api/src/routes/avatars.ts` | Add `GET /api/avatars/:id/wallet` — returns pubkey + balance (not the secret) | +40 |
| `bun run db:push` | Apply schema change | — |

#### Phase C3 — VRM avatar data model (preparation, not rendering) (~50 lines)

| File | Change | ~Lines |
|---|---|---:|
| `packages/database/src/schema/avatars.ts` | Add `avatarType varchar enum('glb','vrm')`, `avatarUrl text`, `vrmMetadata jsonb` columns | +5 |
| `packages/shared/src/types/avatar.ts` | Add fields to the `Avatar` type + a `AvatarAvatarConfig` helper type | +20 |
| `apps/api/src/routes/avatars.ts` | Accept `avatarUrl` in the create/update endpoints | +10 |
| Frontend: NO changes yet — `World3DCanvas.tsx` stays on the lobster GLB path. The VRM branch comes later, probably with the `3da` subagent driving the rendering work | — |
| `docs/vrm-avatar-roadmap.md` | NEW short doc explaining that the data model is ready but the renderer isn't | 30 |

#### Phase C4 — CORS + CSP for embed (~40 lines)

| File | Change | ~Lines |
|---|---|---:|
| `apps/api/src/index.ts` | Extend CORS allowlist to include `electrobun://*`, `capacitor://localhost`, and the Milady desktop shell origins | +10 |
| `apps/web/next.config.mjs` | Remove any `X-Frame-Options: DENY` header. Add a `frame-ancestors` CSP to allow Milady embed origins | +20 |
| `apps/web/src/middleware.ts` | If a middleware exists, ensure it doesn't strip CSP or add `X-Frame-Options: DENY` | +5 |
| `docs/milady-integration.md` | NEW doc covering how to test the embedded viewer locally | 50 |

#### Phase C5 — Smoke test (~80 lines)

| File | Change | ~Lines |
|---|---|---:|
| `scripts/test-milady-plugin-flow.ts` | NEW — mimics what the Milady plugin's `resolveLaunchSession` will do. POSTs to `/api/agent/connect` with `identityType: 'milady'`, asserts an avatar wallet was generated, calls `/move` and `/visit-building`, disconnects. | 80 |

**Phase C totals: ~870 lines across ~14 files, 2 schema migrations.**

### §4.3 — Two-repo summary

| | New files | Modified files | Approx lines | Deploy |
|---|---|---|---|---|
| Milady plugin PR | 6 | 1 | ~1200 | PR to milady-ai/milady |
| ClawVille API changes | 6 | 8 | ~870 | Push to master → Coolify |
| **Total** | **12** | **9** | **~2070** | **Two coordinated releases** |

---

## §5 — Recommended phasing

The temptation is to ship everything at once. Against that:

- **C1 (Milady identity type) is independent of Milady.** It's just one more identity type on the existing agent-gateway. It can ship today and be smoke-tested with a fake Milady client (see `scripts/test-milady-plugin-flow.ts`).
- **C2 (avatar wallets) is independent of Milady.** Any avatar gets a wallet; Milady agents just happen to get one via the new identity branch.
- **C4 (CORS/CSP) is a one-liner deploy.** Ship it early so the Milady plugin doesn't need to wait.
- **M1 + M2 (the plugin itself) can be a single PR to milady-ai/milady** after C1, C2, C4 are deployed to production.
- **M3 (agent actions) is optional** — ship the plugin without actions first, add actions in a follow-up once we've seen real users.
- **C3 (VRM data model) is optional** — can ship alongside M2 or later.

Suggested order:
1. **Week 1**: Ship C1 + C2 + C4. Smoke test against `scripts/test-milady-plugin-flow.ts`. No Milady involvement yet.
2. **Week 2**: Write M1 + M2 plugin against the now-live ClawVille API. Clone milady-ai/milady locally, develop in-place, test against localhost Milady.
3. **Week 3**: Open PR to milady-ai/milady. Iterate on review feedback.
4. **Week 4**: Ship C3 + M3 as a v1.1 release.

---

## §6 — Remaining clarifying questions for the user

I still need answers before Phase M2 writes code. From v1's question list, these are still open:

1. **Scope for this session** (question 4 — explicitly deferred): Given the two-repo, ~2000-line scope, do you want me to:
   - (a) Ship Phase C1 + C2 + C4 tonight (ClawVille API work only, stop at smoke test)
   - (b) Also scaffold the Milady plugin files in a local clone of milady-ai/milady (doesn't submit a PR, just has code ready)
   - (c) Full two-repo implementation + a Milady PR by end of session
   - (d) Something smaller first — e.g. just read more Milady code tonight and plan a follow-up session for the actual coding

2. **Legal review on custodial avatar wallets** — do you have any existing legal guidance on holding user keys, or is this a net-new concern I should flag publicly in the code as "custodial — do not store real value until legal review"?

3. **Does ClawVille's Next.js currently set `X-Frame-Options`?** I haven't grepped yet. If it does, I can fix it as part of C4, but it's good to confirm nothing depends on it.

4. **Agent settings UX**: when a Milady user installs ClawVille, should they see a config dialog (asking for e.g. preferred species), or should we go zero-config and auto-pick (random species, neutral color)? The latter is smoother for v1.

5. **Does milady-ai/milady have a public developer contact** for pre-PR coordination? Given the scope, pinging a maintainer before dropping a 1200-line PR would avoid rework on a format they don't accept.

---

## §7 — What I can start on without waiting on your answers

Unblocked actions:
- **Phase C1 coding** (Milady identity type in agent-gateway). Zero risk, matches the existing `moltbook` pattern.
- **Phase C2 coding** (avatar wallet service + schema). Mechanical, reuses existing `keypair-vault.ts`.
- **Phase C4 coding** (CORS/CSP). A few lines.
- **Phase M1 scaffold** in a NEW directory outside the ClawVille repo (e.g. `~/milady-plugin-scratch/app-clawville/`), using the exact package.json format I read from babylon.

Things I should NOT start without your answers:
- The Milady PR itself (need answer to question 5 about maintainer contact)
- Any work in an actual milady-ai/milady clone (need answer to scope question 1)
- Actions/agent commands (M3) (need answer to question 4)

Answers to any of the §6 questions unblock the next step.
