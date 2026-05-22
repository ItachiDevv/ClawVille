# 03 — Steamworks SDK Integration for ClawVille Desktop

*Owner: Steamworks SDK Integration lead (5-agent Steam packaging team)*
*Last audited: 2026-04-17*
*Scope: how the Electron-wrapped ClawVille desktop app talks to the Steam client at runtime, and how `api.clawville.world` validates Steam identities against our existing Lucia + Drizzle auth model.*

> This doc is a sibling of `docs/steam-packaging-research.md` (policy + packaging) and assumes the Electron-over-remote-Next.js architecture decided there. It is the **implementation-level** spec for Steam auth, achievements, overlay, rich presence, cloud, DRM, and the backend route that federates `SteamID64` into `users`.

---

## 0. Executive summary

| Decision | Value | Rationale |
|---|---|---|
| Native binding | **`steamworks.js`** (ceifa/steamworks.js) | Rust-NAPI, TS-first, actively maintained, prebuilt binaries, supports `getAuthTicketForWebApi`. Greenworks is effectively unmaintained. |
| Electron init | Main process calls `steamworks.init(appId)`; renderer uses `contextBridge`-exposed IPC | Renderer touching native modules directly requires `nodeIntegration: true`, which is a security smell. Keep native in main. |
| Auth federation | **Option A** — nullable unique `users.steam_id BIGINT` column | Matches the existing `identity_fingerprint` pattern on the same row; zero JOIN cost on the hot session-validation path; Lucia's `getUserAttributes` can surface it. |
| Federation identity string | Fixed constant `"clawville.world:v1"` | Must be identical on client (ticket creation) and server (ticket validation). Versioned so we can rotate without invalidating in-flight tickets. |
| Achievements | Client-side `SetAchievement` via `steamworks.js`, triggered by backend push over existing SSE channel | We already stream quest/skill events over SSE. Don't duplicate Steam stats — keep our DB authoritative. |
| Stats | **Skip.** Our DB is authoritative. | Steam stats would double-write and create reconciliation bugs. |
| Cloud saves | **Disable.** | We are server-authoritative. Cloud-save conflict UI is a time sink. Document "Steam Cloud: disabled; your avatar lives at api.clawville.world" in the store page. |
| Overlay | Enable via `client.electronEnableSteamOverlay()` in `main.js` | ceifa ships the hack that makes overlay work inside Chromium. Default-on, free. |
| Rich presence | `localplayer.setRichPresence('status', 'Exploring Tide Clock Grotto')` | Pushed on building-entry events that the renderer already emits. |
| Screenshot (F12) | Enable (default) | Free. |
| Workshop | **Skip.** | Not a UGC game. |
| Steam Input | **Skip v1, revisit for Deck Verified.** | We have keyboard + mobile joystick; controller remapping ships in a v1.1 polish window. |
| DRM wrapper | **Enable.** | Valve's DRM is weak but expected; disabling it is a small signal we're half-committed. Trivial to toggle. |
| Steam refusal | **Launch anyway** with a dismissible "Running in offline mode — Steam features disabled" banner | Prevents "Steam isn't running" lockouts during dev/test; production uses Steam-launched EXE so this path is rare. |

### v1 ship list (must-have for store launch)

1. `steam_appid.txt` (dev only) + `SteamAPI_Init` in Electron main
2. `auth.getAuthTicketForWebApi` → `POST /api/auth/steam` → Lucia cookie
3. Overlay enabled
4. Rich presence pushed on 10 building-entry events
5. 20 achievements registered in Steamworks backend + unlocked via IPC-from-renderer
6. DRM wrapper on Windows EXE

### v1.1 defer list (polish, post-launch)

1. Steam Input (controller remapping) — needed for Deck Verified
2. Linux/macOS builds — Windows-first in v1
3. Additional 10 achievements tied to skill-marketplace milestones (blocked by the Steam-build stripping Bazaar UI — see §2 of `steam-packaging-research.md`)
4. `ISteamFriends` invite-to-game flow

---

## 1. Steamworks SDK — 2026 state

### 1.1 SDK version

Steamworks SDK is versioned monotonically; as of 2026-04, v1.62+ is the latest public release. `steamworks.js` wraps the same C++ SDK via Rust NAPI and ships the redistributable DLLs (`steam_api64.dll`, `libsteam_api.dylib`, `libsteam_api.so`) inside the npm package. We don't directly depend on the C++ SDK version — `steamworks.js` pins it.

Interfaces we exercise:

| Interface | Purpose | Used by |
|---|---|---|
| `ISteamUser` | `GetAuthTicketForWebApi`, `GetSteamID`, `CancelAuthTicket` | Auth handshake |
| `ISteamUserStats` | `RequestCurrentStats`, `SetAchievement`, `StoreStats` | Achievements |
| `ISteamFriends` | `SetRichPresence` (wrapped by steamworks.js as `localplayer.setRichPresence`) | Rich presence |
| `ISteamApps` | `GetCurrentGameLanguage`, `BIsSubscribedApp` | Paranoia check that launch user owns the app |
| `ISteamRemoteStorage` | **Not used** — cloud disabled | — |

Citation: [Steamworks SDK docs — User Authentication & Ownership](https://partner.steamgames.com/doc/features/auth).

### 1.2 `steamworks.js` maintenance status

- Repo: https://github.com/ceifa/steamworks.js
- Maintainer: Thales (ceifa) — single-maintainer project, 600+ stars, active PR queue as of 2026-04
- Rust-NAPI binding → TypeScript declarations auto-generated → no hand-rolled `.d.ts` drift
- Prebuilt binaries per `node-api` target; Electron uses `electron-rebuild` patterns via `@electron/rebuild`
- Supports Windows/macOS/Linux x86_64; ARM64 macOS is supported since v0.3+; Linux ARM64 is still rough

Citations: [ceifa/steamworks.js repo](https://github.com/ceifa/steamworks.js) · [ceifa/steamworks.js README](https://raw.githubusercontent.com/ceifa/steamworks.js/main/README.md) · [ceifa/steamworks.js client.d.ts](https://raw.githubusercontent.com/ceifa/steamworks.js/main/client.d.ts).

### 1.3 Alternatives considered and rejected

| Alternative | Last commit | Verdict |
|---|---|---|
| [greenheartgames/greenworks](https://github.com/greenheartgames/greenworks) | Stale; "effectively dead" community sentiment | Reject — unmaintained, no `GetAuthTicketForWebApi` |
| [electron-steamworks](https://www.npmjs.com/package/electron-steamworks) | Single-version snapshot, no active dev | Reject — fewer interfaces wrapped |
| Direct `node-ffi-napi` to `steam_api64.dll` | We maintain it | Reject — we don't want to own the binding |

---

## 2. Steam auth flow (MOST IMPORTANT)

### 2.1 Why `GetAuthTicketForWebApi` (not `GetAuthSessionTicket`)

`GetAuthSessionTicket` was designed for **game-server-to-Steam** validation and has a known quirk: the ticket is authorized against an anonymous identity by default. The [2023 rewrite of the User Auth docs](https://partner.steamgames.com/doc/features/auth) introduced `GetAuthTicketForWebApi(identity: string)` whose ticket is **bound** to the `identity` string, and the backend MUST pass the same string to `ISteamUserAuth/AuthenticateUserTicket` for validation to succeed. This binding prevents ticket replay against a different backend (e.g. a malicious server tricking our client into producing a ticket usable on their service).

### 2.2 Sequence diagram

```
┌────────────┐   ┌─────────────┐   ┌──────────────────┐   ┌──────────────────────┐   ┌──────────┐
│Steam Client│   │Electron main│   │Electron renderer │   │api.clawville.world    │   │Steam API │
└─────┬──────┘   └──────┬──────┘   └─────────┬────────┘   └───────────┬──────────┘   └─────┬────┘
      │                 │                    │                        │                     │
      │  1. launch exe  │                    │                        │                     │
      ├────────────────►│                    │                        │                     │
      │  (SteamAppId)   │                    │                        │                     │
      │                 │                    │                        │                     │
      │                 │ 2. steamworks.init │                        │                     │
      │                 │    (appId=xxx)     │                        │                     │
      │                 │                    │                        │                     │
      │                 │ 3. createWindow    │                        │                     │
      │                 ├───────────────────►│                        │                     │
      │                 │    loadURL(...)    │                        │                     │
      │                 │                    │                        │                     │
      │                 │                    │ 4. window.steam===true │                     │
      │                 │                    │    detected (preload)  │                     │
      │                 │                    │                        │                     │
      │                 │                    │ 5. ipc.invoke(         │                     │
      │                 │                    │    'steam:getTicket')  │                     │
      │                 │◄───────────────────┤                        │                     │
      │                 │                    │                        │                     │
      │                 │ 6. auth.getAuthTicketForWebApi(             │                     │
      │                 │    'clawville.world:v1')                    │                     │
      │                 │◄───────────────────────────────────────────────────────────────────┤
      │                 │   (Ticket bytes — hex-encoded by us)        │                     │
      │                 │                    │                        │                     │
      │                 │ 7. return hex      │                        │                     │
      │                 ├───────────────────►│                        │                     │
      │                 │                    │                        │                     │
      │                 │                    │ 8. POST /api/auth/steam│                     │
      │                 │                    │    { ticket, identity } │                     │
      │                 │                    ├───────────────────────►│                     │
      │                 │                    │                        │                     │
      │                 │                    │                        │ 9. GET partner-api/│
      │                 │                    │                        │ AuthenticateUserTicket
      │                 │                    │                        ├────────────────────►│
      │                 │                    │                        │                     │
      │                 │                    │                        │ 10. steamid64       │
      │                 │                    │                        │◄────────────────────┤
      │                 │                    │                        │                     │
      │                 │                    │                        │ 11. upsert users    │
      │                 │                    │                        │     WHERE steam_id  │
      │                 │                    │                        │                     │
      │                 │                    │                        │ 12. lucia.createSession
      │                 │                    │                        │                     │
      │                 │                    │ 13. Set-Cookie         │                     │
      │                 │                    │◄───────────────────────┤                     │
      │                 │                    │                        │                     │
      │                 │                    │ 14. navigate to /game  │                     │
      │                 │                    │    (already cookied)   │                     │
```

Steps 6 + 9 cite:
- [ISteamUser::GetAuthTicketForWebApi](https://partner.steamgames.com/doc/features/auth) — "returns a ticket which can be validated by calling `ISteamUserAuth/AuthenticateUserTicket/v1/`. The `identity` input parameter… the identity string must match or authentication will fail."
- [ISteamUserAuth Web API](https://partner.steamgames.com/doc/webapi/ISteamUserAuth) — exact GET endpoint, mandatory `identity` parameter.

### 2.3 Publisher API key (not user Web API key)

`AuthenticateUserTicket` is gated behind the **publisher key**, not the user key at `steamcommunity.com/dev/apikey`. The publisher key is created in Steamworks admin under **Users & Permissions → Manage Groups → Create WebAPI Key**. Per [Valve's Web API overview](https://partner.steamgames.com/doc/webapi_overview/auth), publisher keys:

- Are tied to a publisher group + app IDs
- MUST be stored server-side only
- MUST be used over HTTPS only
- SHOULD be IP-whitelisted

**Storage plan for ClawVille:**

- Name: `STEAM_PUBLISHER_API_KEY`
- Location: Coolify env var on the **api** app only (App ID 3, UUID in `scripts/deploy/.env.deploy` as `API_APP_UUID`). NOT set on the web app.
- Access: Only `apps/api/src/routes/auth-steam.ts` reads it.
- Optional hardening: IP-whitelist the Hetzner VPS egress IP (`<PROD_VPS_IP>`, see `scripts/deploy/.env.deploy`) in the Steamworks admin — any leak of the key then fails any call from off-box.
- Rotation: documented in `docs/DEPLOY-HETZNER.md` once the route ships.

### 2.4 Federating SteamID64 → our `users` + `avatars` model

**Existing state** (`packages/database/src/schema/users.ts`):

- `email` nullable UNIQUE (Phase 5 made it nullable)
- `password_hash` nullable
- `identity_fingerprint` nullable UNIQUE (SHA-256 of `${type}:${key}`)
- CHECK `users_has_auth_method`: `(email IS NOT NULL AND password_hash IS NOT NULL) OR identity_fingerprint IS NOT NULL`

**Two federation options:**

| Option | Schema change | Pros | Cons |
|---|---|---|---|
| **A (chosen)** Add `steam_id BIGINT UNIQUE` column on `users` | `ALTER TABLE users ADD COLUMN steam_id BIGINT UNIQUE` + relax CHECK | Zero JOIN; mirrors `identity_fingerprint` style; one-row session lookup | Adds a 4th auth channel to the CHECK constraint |
| B Separate `steam_accounts` linking table | New table `steam_accounts(steam_id PK, user_id FK)` | Clean separation; supports multiple Steam accounts per user if we ever allowed | Extra JOIN on every Steam login; overkill for the 1:1 relationship we actually have |

**Chosen: Option A.** We already established the "multiple nullable unique auth keys on one users row" pattern in Phase 5 (email, identity_fingerprint). Adding `steam_id` is the natural continuation and avoids introducing a new table + JOIN for something that is always 1:1 with a user.

### 2.5 First-time login UX

`POST /api/auth/steam` returns a `{ userId, isNewUser, hasAvatar }` body. The renderer uses this to decide:

- `isNewUser === true` OR `hasAvatar === false` → redirect to `/create-agent` (existing flow, Three.js pedestal)
- otherwise → redirect to `/game`

### 2.6 Returning user

`steam_id` matches → the route mints a Lucia session cookie using the standard `lucia.createSession(userId, {})` + `lucia.createSessionCookie(session.id)` pattern copied from `apps/api/src/routes/auth.ts:71`. Zero extra state.

### 2.7 Account-linking flow (web user launches via Steam)

Scenario: Alice created a ClawVille account via email on `clawville.world`, then later installs from Steam. Her Steam ID has never been seen.

1. She launches from Steam → `POST /api/auth/steam` with ticket
2. Backend resolves `steamid=77XXXX...` → no matching `users.steam_id` row
3. Backend checks for an active Lucia cookie on the request (she might already be logged in on that Electron Chromium if it ever browsed to clawville.world — unlikely for a fresh install)
4. If active cookie → backend writes `steam_id` onto **that** user row (link)
5. If no cookie → new-user path (creates a fresh user with only `steam_id`)

This means returning web users who want to link must visit `clawville.world`, log in normally, then relaunch from Steam — OR we ship a **"Link existing account"** modal in the Electron shell that prompts for `email + password` and calls the existing `/api/auth/login` before proceeding with the Steam federation. This is a v1.1 feature; v1 is "Steam is your identity, period."

Security: we reject any Steam federation request where a Lucia cookie is present AND that user already has a non-null `steam_id` that doesn't match the incoming ticket. This prevents an attacker from hijacking a different user's Steam link.

---

## 3. Which Steamworks features to ship

### 3.1 Feature matrix

| Feature | v1? | Rationale |
|---|---|---|
| `SteamAPI_Init` + overlay | Yes | Required by Steam; near-zero cost |
| `GetAuthTicketForWebApi` | Yes | Primary auth path |
| Achievements (20) | Yes | Mapped to our quest system (§3.2) |
| Stats | No | Our DB is authoritative; duplicating invites reconciliation bugs |
| Cloud saves | No | Server-side DB holds avatar state; Cloud = dead weight |
| Overlay screenshots (F12) | Yes | Default-on |
| Rich presence | Yes | Cheap + high perceived polish |
| Workshop | No | Not a UGC game |
| Steam Input | No v1 | Revisit for Deck Verified |
| DRM wrapper | Yes | Default; trivial to toggle |
| `ISteamApps::BIsSubscribedApp` paranoia check | Yes | Refuses launch if the user doesn't own the app — prevents ticket-generation on torrented copies |
| `ISteamFriends::ActivateGameOverlayInviteDialog` | No v1 | Multi-player invite isn't in v1 gameplay |

### 3.2 Achievement list proposal (20 for v1)

All 20 achievements map to existing ClawVille quest, skill, or economy milestones that are **already reported over our SSE event channel** — so the unlock path is "backend emits event → renderer receives → IPC → `client.achievement.activate()`". No new DB columns required.

| # | API Name | Display Name | Unlock trigger |
|---|---|---|---|
| 1 | `ACH_FIRST_LOGIN` | Welcome to ClawVille | First successful Steam login |
| 2 | `ACH_CREATE_PET` | Hatchling | Completed `/create-agent` flow |
| 3 | `ACH_FIRST_BUILDING` | Tourist | Entered any of the 10 buildings for the first time |
| 4 | `ACH_VISIT_ALL` | Cartographer | Entered all 10 buildings |
| 5 | `ACH_FIRST_CHAT` | Hello? | First location-agent chat message |
| 6 | `ACH_CRON_HUB` | Tide Watcher | Read a book at Tide Clock Grotto |
| 7 | `ACH_WEBHOOK_GATEWAY` | Current Rider | Read a book at Current Gateway |
| 8 | `ACH_MEMORY_VAULT` | Abyss Scholar | Read a book at Abyssal Vault |
| 9 | `ACH_SKILL_FORGE` | Forged | Read a book at Hydrothermal Forge |
| 10 | `ACH_CHANNEL_BRIDGE` | Bridge Walker | Read a book at Coral Bridge |
| 11 | `ACH_TOOL_WORKSHOP` | Salvager | Read a book at Salvage Workshop |
| 12 | `ACH_CANVAS_STUDIO` | Bioluminescent | Read a book at Biolume Studio |
| 13 | `ACH_VOICE_TOWER` | Echo | Read a book at Echo Spire |
| 14 | `ACH_SECURITY_FORTRESS` | Shell Guard | Read a book at Shell Fortress |
| 15 | `ACH_CONFIG_CITADEL` | Nautilus Pilot | Read a book at Nautilus Citadel |
| 16 | `ACH_READ_ALL` | Librarian | Read at least one book at every building (20 books owned) |
| 17 | `ACH_LEVEL_10` | Crustacean | Avatar reaches level 10 |
| 18 | `ACH_STREAK_7` | Weekly Tide | 7-day login streak |
| 19 | `ACH_FIRST_QUEST` | Errand Runner | Complete first side-quest |
| 20 | `ACH_MAIN_QUEST` | Deep Diver | Complete first main-quest |

**Intentionally excluded:** anything referencing the Bazaar, wallet, or on-chain skill marketplace — see §2 of `steam-packaging-research.md` for the Steam-build feature flag that strips those surfaces per Valve's blockchain policy.

Achievement registration is done once in the Steamworks admin page per [Valve's Achievements doc](https://partner.steamgames.com/doc/features/achievements) — API name + display name + icon + hidden flag. No in-game fallback needed.

### 3.3 Unlock path

```
SSE event (existing)                 renderer                    main                 Steamworks
─────────────────────                ────────                    ────                 ──────────
{ type: 'quest.completed',
  achievement: 'ACH_FIRST_QUEST' }   ──► handle in store   ──►   ipc.invoke     ──►   client.achievement.activate()
                                         'steam:unlock'                              (returns true/false)
```

Backend owns unlock decisions. Renderer is a dumb forwarder. This means an agent that completes a quest autonomously correctly unlocks the achievement for the human who owns the agent — no special-casing needed.

### 3.4 Rich presence

Pushed from the renderer on building-enter / building-exit events (the `locationEnter` Zustand action already exists in `apps/web/src/stores/game.ts`). Hook:

```ts
// apps/web/src/lib/steam/rich-presence.ts (new)
import { isSteamBuild } from './env';

export function pushLocation(buildingName: string | null) {
  if (!isSteamBuild()) return;
  window.steam?.setRichPresence('status',
    buildingName ? `Exploring ${buildingName}` : 'Wandering the sea floor');
}
```

Steam overlay shows the rich-presence string next to the player's name in the friends list.

---

## 4. Steam launch flow

### 4.1 Electron main init

```ts
// apps/electron/src/main.ts (new; lives outside the existing monorepo apps/)
import { app, BrowserWindow, ipcMain } from 'electron';
import steamworks from 'steamworks.js';
import path from 'node:path';

const STEAM_APP_ID = Number(process.env.STEAM_APP_ID ?? 480); // 480 = SpaceWar (Valve's test app)
const WEB_ORIGIN = process.env.CLAWVILLE_WEB_ORIGIN ?? 'https://clawville.world';
const STEAM_IDENTITY = 'clawville.world:v1'; // MUST match server-side identity param

let steamClient: ReturnType<typeof steamworks.init> | null = null;
let steamReady = false;

try {
  steamClient = steamworks.init(STEAM_APP_ID);
  steamReady = true;
} catch (err) {
  console.warn('[steam] init failed — launching in offline mode', err);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1600, height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required by steamworks.js overlay hack
    },
  });
  win.loadURL(`${WEB_ORIGIN}/game?launch=steam`);

  // Overlay hack — must run after the window exists
  if (steamReady) {
    steamworks.electronEnableSteamOverlay();
  }
});

ipcMain.handle('steam:status', () => ({
  ready: steamReady,
  steamId: steamReady ? steamClient!.localplayer.getSteamId().steamId64.toString() : null,
  name: steamReady ? steamClient!.localplayer.getName() : null,
}));

ipcMain.handle('steam:getAuthTicket', async () => {
  if (!steamReady) throw new Error('steam-not-ready');
  const ticket = await steamClient!.auth.getAuthTicketForWebApi(STEAM_IDENTITY, 10);
  return {
    hex: ticket.getBytes().toString('hex'),
    identity: STEAM_IDENTITY,
  };
});

ipcMain.handle('steam:activateAchievement', (_e, apiName: string) => {
  if (!steamReady) return false;
  return steamClient!.achievement.activate(apiName);
});

ipcMain.handle('steam:setRichPresence', (_e, key: string, value: string | null) => {
  if (!steamReady) return;
  steamClient!.localplayer.setRichPresence(key, value ?? undefined);
});
```

### 4.2 Preload bridge

```ts
// apps/electron/src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('steam', {
  status: () => ipcRenderer.invoke('steam:status'),
  getAuthTicket: () => ipcRenderer.invoke('steam:getAuthTicket'),
  activateAchievement: (name: string) => ipcRenderer.invoke('steam:activateAchievement', name),
  setRichPresence: (k: string, v: string | null) => ipcRenderer.invoke('steam:setRichPresence', k, v),
});
```

### 4.3 Renderer handshake

```ts
// apps/web/src/lib/steam/auth.ts (new)
export async function steamSignInIfAvailable(): Promise<{ redirect: string } | null> {
  if (typeof window === 'undefined' || !window.steam) return null;
  const status = await window.steam.status();
  if (!status.ready) return null;

  const { hex, identity } = await window.steam.getAuthTicket();
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/steam`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: hex, identity }),
  });
  if (!res.ok) throw new Error(`steam-auth-failed: ${res.status}`);
  const body: { userId: string; isNewUser: boolean; hasAvatar: boolean } = await res.json();
  return { redirect: body.hasAvatar ? '/game' : '/create-agent' };
}
```

### 4.4 Steam-not-running fallback

If `steamworks.init` throws (Steam client not running, or `.exe` launched directly without Steam), we:

1. Log the failure
2. Continue launching the Electron window
3. Show a top-banner "Steam features disabled — log in via email to continue" in the renderer (visible because `status.ready === false`)
4. The renderer falls through to the existing `/login` route

This avoids forcing a restart on devs iterating locally and, more importantly, on rare users who launch the EXE from the filesystem rather than the Steam client.

### 4.5 `steam_appid.txt`

- Purpose: lets the binary know its AppID when not launched via Steam ([Valve docs](https://partner.steamgames.com/doc/sdk/api))
- Location in dev: `apps/electron/steam_appid.txt` next to `main.ts` output
- Contents: the App ID number, single line, no trailing newline
- **Must NOT ship in SteamPipe upload** — Valve explicitly warns against this
- `electron-builder` config: add `"extraResources": []` that EXCLUDES `steam_appid.txt`, and ensure the dev-only copy step is gated on `NODE_ENV !== 'production'`

---

## 5. Backend — `POST /api/auth/steam`

### 5.1 DB migration

```sql
-- packages/database/migrations/0042_steam_id.sql (next free slot — confirm before applying)
ALTER TABLE users ADD COLUMN steam_id BIGINT UNIQUE;

-- Relax the auth-method CHECK to recognize steam_id as a third channel
ALTER TABLE users DROP CONSTRAINT users_has_auth_method;
ALTER TABLE users ADD CONSTRAINT users_has_auth_method CHECK (
  (email IS NOT NULL AND password_hash IS NOT NULL)
  OR identity_fingerprint IS NOT NULL
  OR steam_id IS NOT NULL
);

-- Explicit index (UNIQUE above already creates one, kept for clarity in migrations)
-- CREATE UNIQUE INDEX IF NOT EXISTS users_steam_id_unique ON users(steam_id);
```

### 5.2 Drizzle schema diff (`packages/database/src/schema/users.ts`)

```ts
// ADD to the existing pgTable('users', { ... }) column block:
steamId: bigint('steam_id', { mode: 'bigint' }).unique(),

// REPLACE the existing hasAuthMethod CHECK with:
hasAuthMethod: check(
  'users_has_auth_method',
  sql`(${t.email} IS NOT NULL AND ${t.passwordHash} IS NOT NULL)
       OR ${t.identityFingerprint} IS NOT NULL
       OR ${t.steamId} IS NOT NULL`,
),
```

Then `bun run db:push` from repo root per the CLAUDE.md deploy rule. And `cd packages/database && bun run build` so consumers see the new column.

### 5.3 Route sketch

```ts
// apps/api/src/routes/auth-steam.ts (new)
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, users, avatars } from '@clawville/database';
import { lucia } from '../lib/auth';
import type { AppContext } from '../types';

export const authSteamRoutes = new Hono<AppContext>();

const STEAM_PARTNER_API = 'https://partner.steam-api.com';
const EXPECTED_IDENTITY = 'clawville.world:v1';

const bodySchema = z.object({
  ticket: z.string().regex(/^[0-9a-fA-F]+$/, 'ticket must be hex'),
  identity: z.string().min(1).max(128),
});

// Rate limit: 10/min per IP. Same in-memory pattern as milady-session-exchange.
const rateMap = new Map<string, { count: number; resetAt: number }>();
function checkRate(ip: string): boolean {
  const now = Date.now();
  const hit = rateMap.get(ip);
  if (!hit || hit.resetAt <= now) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  hit.count++;
  return hit.count <= 10;
}

authSteamRoutes.post('/steam', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip') ?? 'unknown';
  if (!checkRate(ip)) {
    throw new HTTPException(429, { message: 'Too many attempts' });
  }

  const parsed = bodySchema.safeParse(await c.req.json());
  if (!parsed.success) throw new HTTPException(400, { message: 'bad body' });
  const { ticket, identity } = parsed.data;

  // Fail fast on identity mismatch — prevents tickets minted for a different
  // backend from ever reaching Valve.
  if (identity !== EXPECTED_IDENTITY) {
    throw new HTTPException(400, { message: 'identity mismatch' });
  }

  const publisherKey = process.env.STEAM_PUBLISHER_API_KEY;
  const appId = process.env.STEAM_APP_ID;
  if (!publisherKey || !appId) {
    console.error('[auth/steam] missing STEAM_PUBLISHER_API_KEY or STEAM_APP_ID');
    throw new HTTPException(500, { message: 'steam not configured' });
  }

  // 1. Validate ticket with Valve.
  const url = new URL(`${STEAM_PARTNER_API}/ISteamUserAuth/AuthenticateUserTicket/v1/`);
  url.searchParams.set('key', publisherKey);
  url.searchParams.set('appid', appId);
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('identity', identity);

  const resp = await fetch(url.toString(), { method: 'GET' });
  if (!resp.ok) {
    console.error('[auth/steam] partner API returned', resp.status);
    throw new HTTPException(401, { message: 'ticket rejected' });
  }
  const json: {
    response?: {
      params?: {
        result?: string;        // 'OK' on success
        steamid?: string;       // uint64 as string
        ownersteamid?: string;  // uint64 as string
        vacbanned?: boolean;
        publisherbanned?: boolean;
      };
      error?: { errorcode: number; errordesc: string };
    };
  } = await resp.json();

  const p = json.response?.params;
  if (!p || p.result !== 'OK' || !p.steamid) {
    console.error('[auth/steam] ticket invalid', json.response?.error);
    throw new HTTPException(401, { message: 'ticket invalid' });
  }
  if (p.publisherbanned) {
    throw new HTTPException(403, { message: 'account banned' });
  }
  // Reject Family Sharing for now — steamid !== ownersteamid means the
  // logged-in user doesn't own the license. We can revisit later but v1
  // treats each license as its own avatar.
  if (p.ownersteamid && p.ownersteamid !== p.steamid) {
    throw new HTTPException(403, { message: 'family-sharing-not-supported' });
  }

  const steamIdBig = BigInt(p.steamid);

  // 2. Find or create the user.
  let user = await db.query.users.findFirst({ where: eq(users.steamId, steamIdBig) });
  let isNewUser = false;
  if (!user) {
    const [inserted] = await db.insert(users).values({
      steamId: steamIdBig,
      name: `Steam ${p.steamid.slice(-6)}`, // placeholder; real name fetched from ISteamUser::GetPlayerSummaries later
    }).returning();
    user = inserted;
    isNewUser = true;
  }

  // 3. Check for existing avatar (for /create-agent redirect).
  const avatar = await db.query.avatars.findFirst({ where: eq(avatars.userId, user.id) });

  // 4. Mint Lucia session cookie — same pattern as auth.ts:70.
  const session = await lucia.createSession(user.id, {});
  const cookie = lucia.createSessionCookie(session.id);
  c.header('Set-Cookie', cookie.serialize());

  return c.json({
    userId: user.id,
    isNewUser,
    hasAvatar: Boolean(avatar),
  });
});
```

### 5.4 Wire into the route tree

```ts
// apps/api/src/index.ts — alongside existing authRoutes registration
import { authSteamRoutes } from './routes/auth-steam';
// ...
app.route('/api/auth', authSteamRoutes);
```

### 5.5 Security checklist

- [x] Identity string validated against a constant before any Valve call (stops replay to a different backend)
- [x] Publisher key never leaves the API process; not exposed to web app
- [x] Rate-limit (10/min/IP) on the new route
- [x] Reject `publisherbanned` users
- [x] Reject Family-Sharing for v1 (steamid ≠ ownersteamid)
- [x] Hex validation on ticket input (Valve returns 400 on malformed ticket anyway, but fail fast)
- [x] HTTPS-only (Coolify Traefik terminates TLS; the outbound fetch is also HTTPS)
- [ ] IP-whitelist the publisher key to `<PROD_VPS_IP>` (see `scripts/deploy/.env.deploy`) in Steamworks admin (manual step at deploy time)
- [ ] Add `STEAM_APP_ID` + `STEAM_PUBLISHER_API_KEY` to Coolify env before deploy

### 5.6 `getUserAttributes` update

```ts
// apps/api/src/lib/auth.ts
getUserAttributes: (a) => ({
  email: a.email,
  name: a.name,
  avatarUrl: a.avatar_url,
  steamId: a.steam_id,           // <— NEW
}),

declare module 'lucia' {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: {
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      steam_id: bigint | null;   // <— NEW
    };
  }
}
```

Lucia reads this via its adapter's `getUserAttributes` callback — no other code change needed.

---

## 6. Coolify env var plan

Add to the **api** app (App ID 3, UUID in `scripts/deploy/.env.deploy` as `API_APP_UUID`) via the tinker pattern documented in root `CLAUDE.md`:

| Key | Value | Notes |
|---|---|---|
| `STEAM_APP_ID` | (assigned after Steam Direct payment) | not sensitive; appears in SteamPipe uploads too |
| `STEAM_PUBLISHER_API_KEY` | (generated in Steamworks admin under Users & Permissions) | **secret**. IP-whitelist to `<PROD_VPS_IP>` (see `scripts/deploy/.env.deploy`) |

`STEAM_APP_ID` is also needed by the **Electron build CI** (not a runtime env on the api app or web app — it's compiled into the main-process bundle). Store it alongside the code-signing cert secrets in the GitHub Actions secrets panel of the Electron repo.

**No env change is needed on the web app.** All Steam logic runs in Electron main + the api app.

---

## 7. Risks + open questions

### 7.1 Electron overlay reality check

[Valve's overlay doc](https://partner.steamgames.com/doc/features/overlay) explicitly says "web browsers do not support this [consistent rendering] model" and recommends embedded Chromium with a D3D window + input forwarding. That is exactly what `steamworks.js`'s `electronEnableSteamOverlay()` does via a private hack — but it is **not officially supported by Valve**, and it has historically broken on Electron major-version upgrades.

Mitigation:

- Pin Electron to a known-good version (v28 LTS at time of writing; retest on every Electron major bump)
- Keep `sandbox: false` on `BrowserWindow` `webPreferences` — required by the overlay hack
- Budget 1-2 days for overlay re-validation on every Electron upgrade

If overlay ever breaks irreparably, we can still ship achievements/rich-presence/auth without it; the overlay is just the UX wrapper.

### 7.2 Family Sharing

v1 rejects Family-Sharing users (steamid ≠ ownersteamid). This is conservative — many legitimate users share libraries with family. Revisit in v1.1 with a decision on whether sharers get their own avatar (probably yes) or are silently linked to the owner's account (no — that's a privacy violation).

### 7.3 Ticket replay across apps

Valve's `identity` binding is the anti-replay primitive. We use `'clawville.world:v1'`. If we ever need a second logical backend (e.g. staging), use `'clawville.world:v1-staging'` to hard-isolate tickets.

### 7.4 Publisher key rotation

No built-in rotation in Steamworks admin — we have to generate a new key, copy it to Coolify, deploy, then revoke the old one. Outage window ~60 seconds if scripted. Document in DEPLOY-HETZNER.md when the route ships.

### 7.5 Steam Deck / Proton

Running the Windows Electron build under Proton has historically been fine for simple Chromium apps; `steamworks.js` under Proton is untested by us. The fallback (Steam features disabled, email login) is the safe default for Deck until we test. Non-blocking for v1.

### 7.6 Anti-cheat

Not in v1 — no multiplayer, no competitive leaderboards yet. When the leaderboard ships, decide between VAC (Steam-only, can't be used on clawville.world) vs our own server-side validation.

### 7.7 Achievement taxonomy drift

If we later rename a building (e.g. Tide Clock Grotto → something else), the `ACH_CRON_HUB` display name must stay stable on Steam — Valve discourages renaming shipped achievements. Lock the API names now; display names can evolve per Valve's policy.

### 7.8 Open questions for the team

1. Do we want `ISteamFriends::ActivateGameOverlayInviteDialog` in v1? (No use-case for it yet — defer.)
2. Do we ship a "Link existing web account" modal in v1? Decision: **No**, v1.1.
3. Do we enable Steam Cloud as a read-only backup of character JSON? Decision: **No**, because the state on `api.clawville.world` is authoritative and a Cloud copy introduces conflict surface.
4. Do we want per-building rich-presence localization? Probably no for v1 — English strings only.

---

## 8. References

### Valve primary sources

- [Steamworks — User Authentication & Ownership](https://partner.steamgames.com/doc/features/auth) — `GetAuthTicketForWebApi` spec, identity binding, ticket cancel semantics.
- [ISteamUserAuth Web API](https://partner.steamgames.com/doc/webapi/ISteamUserAuth) — `AuthenticateUserTicket/v1/` endpoint, query params, publisher-key requirement.
- [Steamworks — Web API Overview (auth)](https://partner.steamgames.com/doc/webapi_overview/auth) — publisher key vs user key, storage rules.
- [Steamworks — Achievements](https://partner.steamgames.com/doc/features/achievements) — `SetAchievement`, `StoreStats`, admin registration, pre-release testing.
- [Steamworks — Overlay](https://partner.steamgames.com/doc/features/overlay) — why native web browsers don't support overlay out of the box.
- [Steamworks SDK API](https://partner.steamgames.com/doc/sdk/api) — `steam_appid.txt` semantics, "do not ship this."
- [Steam Direct Fee](https://partner.steamgames.com/doc/gettingstarted/appfee) — $100 Direct fee, AppID issuance.

### Community sources

- [ceifa/steamworks.js README](https://raw.githubusercontent.com/ceifa/steamworks.js/main/README.md) — init, overlay hack, Electron config.
- [ceifa/steamworks.js client.d.ts](https://raw.githubusercontent.com/ceifa/steamworks.js/main/client.d.ts) — canonical TS signatures for `auth.getAuthTicketForWebApi`, `achievement.*`, `localplayer.setRichPresence`.
- [greenheartgames/greenworks — abandonment indicators](https://github.com/greenheartgames/greenworks/issues/306) — why we skip this library.

### ClawVille internal

- `docs/steam-packaging-research.md` — parent policy + packaging doc.
- `apps/api/src/routes/auth.ts` — reference Lucia session cookie minting pattern.
- `apps/api/src/services/identity-service.ts` — reference "resolve-or-create race-safe" pattern for the same shape of federated-identity upsert.
- `packages/database/src/schema/users.ts` — existing `users_has_auth_method` CHECK that we relax in §5.1.
- `CLAUDE.md` — deploy workflow, Coolify tinker pattern for env vars, `bun run db:push` reminder.
