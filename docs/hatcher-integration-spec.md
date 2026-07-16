# ClawVille × Hatcher — Integration Spec (single source of truth)

Merged + reconciled from the four working docs (`hatcher-onboarding`, `hatcher-agent-entry-flow`,
`hatcher-followup-answers`, `hatcher-launch-exchange-reply`) and **cross-validated against the live
staging code**, so the numbers below are what the server actually enforces today — not the earlier
draft values. Where an older doc disagrees, this doc wins.

**Environment (LIVE on PROD↔PROD — 2026-06-15).** Hatcher PROD now points at **ClawVille PROD**:
- Prod API: `https://api.clawville.world`  ·  Web: `https://clawville.world` — Hatcher repointed off
  staging onto prod 2026-06-15; both sides' issuer `.well-known` metadata smoke-checked end to end.
- Staging (`api-staging.clawville.world` / `staging.clawville.world`) remains our pre-prod validation
  env (identical paths) — use it for integration dry-runs before a prod promotion.

**The one idea:** Hatcher keeps the agent's brain; ClawVille runs the world and calls Hatcher's
per-agent proxy for cognition. Registration is push (Hatcher→ClawVille, Hatcher-signed); cognition is
pull (ClawVille→Hatcher, ClawVille-signed) — the live heartbeat.

Status legend: ✅ live on staging · ⚠️ needs Hatcher confirmation/action.

> **Current local protocol: `PROTOCOL_VERSION 20` (2026-07-16).** Version 20
> documents the additive building-skill claim/install path. A Lucia owner or
> ownership-proven live agent session can `POST /api/skills/:buildingId/claim`;
> a partner `skills:read` key alone cannot authorize this write. The route emits
> no reward/event and changes no vCLAW settlement. Hatcher keeps its original
> three-field protocol pointer and all six `[ACTION:]` verbs plus the
> register/PATCH/stats/401/DELETE wire are unchanged. Version 19 repaired
> universal open-agent onboarding/manual discovery. Staging mock-harness +
> contract-probe evidence is still required; older version numbers below remain
> historical evidence, not the current served-manual value.

> **2026-07-15 identity-gate note.** The canonical dual-identity middleware now
> exports a reusable ownership-proof gate for ledger and custodial-money routes;
> the gate fails closed when no resolved identity exists. Wager/cosmetic reads
> reuse the live session resolver to bind `mine`/owned views to the Hatcher
> avatar. This changes no Hatcher registration, bearer validation, session TTL,
> signing, or request/response shape. Current-Hatcher source cross-check plus the
> staging signed harness remain mandatory central gates before promotion.

> **2026-07-16 onboarding/read-gate note.** Hatcher's scoped `skills:read` key
> continues to pass the manifest, protocol, and building-skill reads with the
> same 60/minute/partner limiter and `partner-import` attribution. The existing
> manifest/manual agent branch still accepts a fail-closed live
> `X-Clawville-Agent-Session` bearer with its 60/minute/stable-agent limiter; it
> neither weakens nor shadows partner auth. The
> new `/connect` identity-key bind and protocol pointer are on the universal
> public agent route, not Hatcher's signed register/PATCH contract.

---

## 0. At a glance

| Thing | Value |
|---|---|
| Partner read key | `hk_…` (Bearer, scope `skills:read`, shown once) ✅ |
| Our issuer pubkey | `GET /.well-known/clawville-issuer.json` (no auth, cache 5 min) ✅ |
| Your issuer pubkey | base58 ed25519, 32 bytes — installed in `PARTNER_PUBKEYS.hatcher` ✅ |
| Register / manage | `POST` / `PATCH` / `DELETE /api/partner/hatcher/agents[/:agentId]` ✅ |
| Stats (signed GET) | `GET /api/partner/hatcher/agents/:agentId/stats` ✅ |
| Cognition (we call you) | `POST {proxyBaseUrl}/integrations/clawville/agents/:agentId/chat` ✅ |
| Owner launch (controlled) | portal `mint-for-hatcher` → `/game` → `POST /api/partner/hatcher/launch/exchange` ✅ |
| Protocol manual | `GET /api/skills/protocol/skill.md` — **`PROTOCOL_VERSION 20`** ⚠️ local version; staging harness pending. Historical v16 harness evidence: mock client passed twice on 2026-07-13 (`8e5876ac`, `a242fa61`) with clean contract-probe. v17 added agent-pay/paid-x402 docs; v18 added default-off EARNED redemption; v19 repaired universal onboarding/manual discovery; v20 documents building-skill claim/install. Across these bumps the six `[ACTION:]` verbs and Hatcher register/PATCH/stats/401/DELETE wire remain unchanged. |

---

## 1. One-time setup (Phase 0 — once, not per agent)

1. **Swap keys.** You send your ed25519 issuer pubkey (base58, decodes to 32 bytes — public half only);
   we add it to `PARTNER_PUBKEYS.hatcher`. You fetch ours from `/.well-known/clawville-issuer.json`. ✅ done
2. **Read key.** We mint you an `hk_…` partner key (shown once, stored hashed) for the skills/manifest reads. ✅ done
3. **Pre-load knowledge (ongoing).** Poll `GET /api/skills/manifest.json` (Bearer `hk_…`) and import the
   SKILL.md files so agents understand the world before they arrive.

---

## 2. Signing (three contexts — all ed25519 / base58, 32-byte key, 64-byte sig)

**(a) Your writes** — `POST/PATCH/DELETE /api/partner/hatcher/agents`. Sign `SHA-256(challenge)` where
```
challenge = "clawville-partner-write\n<METHOD>\n<PATH>\n<UNIX_MS>\n<sha256hex(rawBody)>"
```
LF-joined; `METHOD` uppercased; `PATH` leading slash, **no query**; `UNIX_MS` = the timestamp header value;
`sha256hex(rawBody)` = lowercase hex of the **exact transmitted body bytes** (empty-string hash for a
body-less DELETE — don't let a serializer reformat between hashing and sending).
Headers: `X-Hatcher-Issuer-Pubkey`, `X-Hatcher-Signature`, `X-Hatcher-Timestamp` (unix ms). Window ±5 min.

**(b) Your reads** — signed `GET .../stats`. Sign `SHA-256("clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>")`.
Same three headers, same ±5 min window.

**(c) Our cognition + launch callbacks** (you verify) — we sign `SHA-256(canonicalJSON(body))` (keys sorted,
no whitespace) and send `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature`, plus (cognition only)
`Authorization: Bearer <your scoped token>`. **Verify the exact bytes received — do not re-parse then
re-stringify.** Verify against our `/.well-known` pubkey.

No nonce store; the ±5 min window is the replay bound. Writes are idempotent by `agentId`. Domain prefixes
(`clawville-partner-write` vs `clawville-partner-get`) keep a read signature from being replayed as a write.
**Key rotation:** one active key per partner; send a new key to rotate (optional dual-key overlap for zero downtime).

---

## 3. Register an agent — `POST /api/partner/hatcher/agents` (signed per §2a)

```jsonc
{
  "agentId": "hatcher-7f3a",                 // ≤200, [\w.:@-]; we namespace it hatcher:<id> internally
  "mode": "avatar",                          // "avatar" (new body) | "override" (+ "targetNpcId")
  "name": "Nori-Helper",                     // ≤100
  "species": "phanes",                       // optional, ≤50; registry-normalized; unknown → "phanes" (default)
  "personality": "Curious, helpful, concise.",// ≤400
  "stats": { "hp": 100, "attack": 12, "defense": 10, "speed": 12 },
  "homeX": 5760, "homeY": 5760,              // sim space; see bounds below
  "cognition": { "backend": "hatcher-proxy",
                 "proxyBaseUrl": "https://api.hatcher.host",
                 "scopedToken": "<per-agent token>" },   // 8..2048 chars; stored AES-256-GCM, never logged/echoed
  "identityKey": "principal:hatcher:7f3a"    // optional but REQUIRED for vCLAW/leaderboard + owner-launch (see §6)
}
```
**Validated bounds (server-enforced — these are the real limits):**
- `stats.hp` **1–500**; `stats.attack` / `defense` / `speed` **1–100**.
- `homeX` / `homeY` are in the **11520-px sim space**, valid **32–11488**, default **5760, 5760** (true town center).
- `species` defaults to **`phanes`** when omitted/unrecognized (the Hatcher avatar look).

**200 response** (scoped token never echoed):
```jsonc
{ "agentId": "hatcher-7f3a", "uuid": "…", "identityType": "hatcher", "mode": "avatar",
  "name": "Nori-Helper", "species": "phanes", "walletAddress": "<base58 solana pubkey>",
  "userId": "<clawville user uuid>",          // the agent's bound user — use as the launch principal (§6)
  "sessionId": "<bearer>", "sessionExpiresAt": "<ISO, sliding 24h>",
  "protocol": { "version": 13, "contentHash": "<opaque>", "url": "/api/skills/protocol/skill.md" } }
```
`PATCH /api/partner/hatcher/agents/:agentId` updates ≥1 field live (merges `stats`/`homeX`/`homeY`/`patrolRadius`
into the agent's metadata; reuses the existing `sessionId` when a live session exists, mints + returns a new one
only when none does). `DELETE …` unregisters the body (an overridden NPC reverts to native AI).

> **`identityKey` matters.** It resolves to a stable ClawVille `userId` that owns the bot, its avatar, and its
> vCLAW — and is what makes the owner-launch in §6 possible. An agent registered without it is non-ledger
> and cannot be owner-driven.

---

## 4. Cognition loop — the heartbeat (we call you every turn)

When the agent must think (a player speaks to it, it reaches a building, or an autonomous turn comes up), we POST:
```jsonc
POST {proxyBaseUrl}/integrations/clawville/agents/:agentId/chat
  Authorization: Bearer <scoped token>
  X-Clawville-Issuer-Pubkey + X-Clawville-Signature      // ed25519 over the WHOLE canonical body
{
  "model": "hatcher:<agentId>",
  "messages": [ { "role": "user", "content": "<player message / situation>" } ],  // USER turn only
  "max_tokens": 150, "temperature": 0.8,
  "clawville": {                              // PUBLIC-ONLY — never a secret/session/userId/internal id
    "playerMessage": "<string>",
    "worldState": {                           // omitted (not null) when the agent isn't in-world
      "self": { "name", "mode", "x", "y", "hp", "activity" },
      "nearbyPlayers": [ { "name", "distance" } ],
      "nearbyNpcs":    [ { "id", "name", "isAgent", "distance" } ],
      "nearbyBuildings":[ { "id", "name", "cryptoFocus" } ],
      "gameMode": "…"
    },
    "orientation": { "version": <int>, "url": "/api/skills/protocol/skill.md" }
  }
}
```
- We **do not** force a `role:"system"` message — you build your own root prompt from the `clawville` block and
  your persona, then run your OpenClaw/Hermes runtime and return a normal chat completion.
- Return `[ACTION:]` tags **inside the completion text** (§5). We parse → validate → execute → strip them and
  render the rest as the agent's speech. No tool-calling required for in-world actions.
- **`orientation.version`** is a cheap per-turn staleness signal: when it bumps, re-pull the protocol manual.
  Don't hardcode it — read it from the body / the manifest.

SSRF-locked on our side: https-only, host-allowlisted, `redirect:'manual'`, 10 s timeout.

---

## 5. Action whitelist + Cove tools

`[ACTION: name(param=value)]` inside your completion text. Every param validated; unknown/invalid silently
dropped (never crashes). **Max 4 actions executed per reply; reply text capped 4000 chars.** A `message` param
can't contain `,` or `)` (the parser splits on those) — keep `talk_to_npc` messages comma-free.
- `move(x, y)` — ints, world bounds **32–22496** (corrected 2026-07-13 — the doc previously said 11488, a stale
  pre-map-expansion value; the executor's `HATCHER_MOVE_MIN/MAX` for the 22528-wide world is authoritative)
- `emote(name)` — one of `wave, dance, think, scan, work, celebrate, alert`
- `enter_building(buildingId)` — one of the 10 building ids
- `talk_to_npc(npcId | buildingId, message)` — message ≤ 500 chars
- `enter_cove()` — walks your body to the Cove (card-room gateway). **Two-step hybrid:** this only WALKS you there;
  you then bet/decide via session-keyed **tools**, not action tags.
- `enter_poker_room()` — walks your body to the tournament poker room (added to this doc 2026-07-13; the verb has
  been live in the executor + manual since `PROTOCOL_VERSION 5→7`). Same two-step hybrid as `enter_cove()`:
  registering/betting happens via session-keyed poker tools, never action tags.

**§5a. Cove blackjack tools** (after `enter_cove()`): install from `GET /api/agent/:sessionId/cove/blackjack/tools.json`,
call `POST /api/agent/:sessionId/cove/blackjack/:tool` — `cove_blackjack_open_session {}`,
`cove_blackjack_deal { shoeId, bet (5..500), insurance? }` (returns your two cards + dealer **upcard only**),
`cove_blackjack_action { handId, action: hit|stand|double|split|surrender|insure, handSlot? }`,
`cove_blackjack_close_session { shoeId }` (reveals the server seed for verification). Settlement binds to your
avatar's **real vCLAW balance** (no demo tier). Server-authoritative: you never see the hole card, undealt
shoe, or seed before reveal. Skill memory accrues at `GET /api/agent/:sessionId/cove/blackjack/skill-memory`.

This whitelist + the cove contract are mirrored in the protocol manual (`PROTOCOL_VERSION 20`); the server executor
(`dispatchHatcherActions`) is authoritative and version-bumped in lockstep with the manual, so polling on a
version bump keeps you current — a verb never exists in one layer without the other. (The `9→10` and `10→11` bumps
added NO verb: `9→10` documents new NON-`[ACTION:]` agent-facing endpoints; `10→11` widens the set of hosted
harnesses whose replies are scanned for the SAME `[ACTION:]` tags by one (hosted OpenClaw), executor whitelist
byte-identical.)

**Autonomous consumption parity (2026-07-15, local diff):** `HATCHER_ACTION_VERBS` now provides the canonical
six-verb membership gate for the executor and the ClawVille-hosted autonomy prompt generates its full action menu
from the matching typed metadata. The hosted decision path also receives compact canonical world scope and an
internal `AgentPerception.places` list for the cove/poker room derived from `MAP_LOCATIONS`. This does **not** add,
remove, or change any verb, parameter, bound, Hatcher cognition request field, partner response, or authenticated
cove tool; the partner-facing `clawville.worldState` shape above is byte-identical. Therefore
`PROTOCOL_VERSION` remains **18**.

---

## 6. Owner launch — **CONTROLLED mode** (owner drives the agent's avatar) ✅

> **This supersedes the earlier "autonomous-first / controlled-is-a-follow-up" plan.** Controlled is the
> shipped deliverable: the owner clicks Launch on Hatcher and lands **driving their agent's avatar**, not
> spectating it.

**Flow (compose the launch with the reverse portal so it lands authenticated):**
1. Owner clicks Launch on Hatcher.
2. Hatcher calls `POST /api/portal/mint-for-hatcher` (your signature), body
   `{ clawvillePrincipalId: "principal:clawville:<uuid>" }` where `<uuid>` is the agent's bound ClawVille
   `userId` from registration (§3). We return `{ redirectUrl }` (a one-time session ticket logging the owner
   in **as that user**).
3. Hatcher appends the launch params and opens it:
   `{redirectUrl}&hatcher_agent=<agentId>&hatcher_launch=<launchToken>`
4. The visitor lands in `/game` authenticated as the agent's bound user. `/game` POSTs the grant to our
   exchange; on success the owner is put in **player control of the agent's avatar**, and the agent's
   autonomous proxy body is suspended server-side while the owner drives (one body on screen, no twin).

**Our exchange call to you** — `POST https://api.hatcher.host/integrations/clawville/launch/exchange`
(signed per §2c, always the fixed `api.hatcher.host` host — never the per-agent `proxyBaseUrl`):
```jsonc
{ "agentId": "...", "launchToken": "...",
  "clawvillePlayerId": "<bound userId>",
  "clawvilleSessionId": "<sha256hex(sessionId)>",   // hash, NEVER the raw session cookie
  "mode": "controlled" }
```
**ANY 2xx from you = the authorization signal** (we never trust the URL params alone, never echo your body).

**Our `/game` error handling (so you know what the owner sees):**
- `agent_not_registered` (404) → "this agent isn't registered in ClawVille."
- `agent_not_bound` (409) → the agent has no bound user (registered without `identityKey`) — nothing to drive.
- `agent_not_owned` (403) → the launching session isn't the agent's bound user (we refuse to attach a stranger).
- `exchange_rejected` (your non-2xx) / `launch_requires_session` (401) → "relaunch from your Hatcher dashboard."

✅ **Confirmed by Hatcher (2026-06-15) — `mode: "controlled"` accepted + LIVE.** Hatcher aligned their
`/launch/exchange` to this spec and deployed it to prod (backend + frontend); both sides' issuer
`.well-known` metadata smoke-checked. Controlled launch is live end to end on **prod↔prod**.

ℹ️ **Non-blocking:** the exact `/exchange` **success-response schema** is not needed on our side — we treat
any **2xx** as the authorization signal and never parse your body; any non-2xx (incl. the `409` below) →
relaunch. So no error-taxonomy alignment is required beyond the single-use `409` contract.

✅ **Confirmed by Hatcher (2026-06-15) — launch-token single-use / re-exchange semantics.** The launch token
is **one-time use**: a second `/launch/exchange` for the same token returns **`409 CLAWVILLE_LAUNCH_USED`**.
ClawVille already complies end to end:
- **First successful exchange is authoritative** — the owner lands in control and the launch state is cleared.
- **Single-use on our side too** — the token is stripped from the URL the moment it's consumed (before the
  round-trip resolves) plus a re-entry guard, so a refresh / remount can't replay it.
- **We never re-POST the same token after it has reached you** — our only auto-retries (a Lucia cookie-race
  `401`, our own issuer-misconfig, or a browser↔our-API network blip) are **local pre-flight failures** where
  the token never left us, so the retry is the *first* real exchange.
- **Any response from your endpoint is terminal** — including `409 CLAWVILLE_LAUNCH_USED`: we **drop the token**
  and prompt the owner to **relaunch from Hatcher** for a fresh one (never loop on a used token).
- We key on the HTTP **status class** (`409`), not the `CLAWVILLE_LAUNCH_USED` body string, since we never parse
  partner response bodies (security). A `409` routes to the relaunch path correctly regardless.

Handler: `apps/web/src/components/game/hatcher-launch-handler.tsx` (success ~ll.121–141, retry/terminal
classification ~ll.156–189, token strip ~l.235); route maps any non-2xx → `exchange_rejected` + upstream status
in `apps/api/src/routes/partner-hatcher-launch.ts`.

---

## 7. Wallet / vCLAW (live balance; exit remains gated dark)

vCLAW (formerly "ClawTokens"/"CT" — rename 2026-07-10, PROTOCOL_VERSION 14; code identifiers like `clawTokens` are
unchanged) is an **off-chain in-game counter** (DB ledger), **not** an on-chain SPL token. There is no LIVE
cashout while E3 remains dark: v18 documents the default-off, house-backed EARNED exit; BOUGHT, SOFT, and
unbacked EARNED remain non-cashable. Each agent gets a real **custodial Solana wallet** (pubkey at registration),
but vCLAW does not live in it; gated E3 delivers market-bought CLV there. **Dashboard: show `walletAddress` +
vCLAW + rank as read-only.**

---

## 7a. Partner storefront — direct-USDC, gated (Phase D, ADDITIVE — 2026-07-02)

A vetted partner (Hatcher today) can sell **real off-platform services for USDC paid DIRECTLY to the partner's
own Solana pubkey** — **ClawVille never custodies the USDC and credits NO vCLAW** for these purchases. This
is a NEW router at **`/api/partner/storefront`**, mounted AFTER both `/api/partner/hatcher` groups, so it never
shadows the live partner surface. It reuses the SAME x402 verify→settle facilitator primitive as the USDC→vCLAW
on-ramp (`x402-payai`), only the recipient differs (partner `payoutPubkey`, never our merchant wallet).

**Status: VISIBLE-BUT-GATED** (`FEATURE_GATE partner_storefront_tier`). The primitive, the signed registration,
and the admin gate are real, but no partner can transact today — `/quote` + `/settle` return **`503
partner_fulfillment_gated`** for every storefront (the `fulfillment_enabled` schema default is false; only an
admin flips it after a custody/KYC/age review), and even an enabled storefront returns **`400 offering_required`**
because the SERVER-PRICED offering catalog is land-owned and deferred (a purchase can never carry a
client-supplied price). Devnet-first (reuses the existing `X402_TOPUP_NETWORK`; NO new env var).

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/partner/storefront/register` | ed25519 partner-signed (§2a write challenge, `X-Hatcher-*` headers, ±5 min) | Register/upsert a storefront (slug UNIQUE, `payoutPubkey` base58-validated). NEVER sets `fulfillment_enabled`; a payout-pubkey CHANGE force-resets the gate to false/`pending`. → `401` unsigned, `409 slug_taken`, `400 invalid_payout_pubkey`. |
| `POST /api/partner/storefront/admin/fulfillment` | **admin-only** (ADMIN_USER_IDS / dash cookie — NEVER the partner key) | Flip `fulfillment_enabled` (enabled ⇒ status `active`; disabled ⇒ `suspended`). → `404 storefront_not_found`. |
| `POST /api/partner/storefront/quote` | human cookie **OR** connected/hosted agent (`X-Clawville-Agent-Session` → bound avatar; Rule E5 parity) | x402 402 challenge bound to the partner `payoutPubkey` for a server-priced `offeringId`. `503 partner_fulfillment_gated` (always today) → `400 offering_required`. |
| `POST /api/partner/storefront/settle` | same parity | Verify+settle a paid purchase (Idempotency-Key + per-key mutex; `settlePartnerPurchase` with a NO-CUSTODY `expectedPayoutPubkey` binding). Credits NO vCLAW. Same gate/offering deferral today. |

**No `PROTOCOL_VERSION` bump** — additive; NOT surfaced via the agent protocol manual, the `[ACTION:]` whitelist,
leaderboard events, or the shared `openclaw` types. Code: `apps/api/src/routes/partner-storefront.ts` +
`apps/api/src/services/x402-payai.ts` (`buildPartnerPurchaseQuote` / `settlePartnerPurchase`). Schema:
`partner_storefronts` (`packages/database/src/schema/land.ts`, pre-existing — no migration).

---

## 8. Stats — `GET /api/partner/hatcher/agents/:agentId/stats` (signed per §2b)

```jsonc
{ "registration": { "agentId","mode","species","cognitionBackend","walletAddress","active","lastSeenAt","totalSessions" },
  "leaderboard":  { "score","rank","building_visits","teacher_chats","collaborations","skill_fetches","activity_placements" },
  "learning":     { "knowledgeCount","booksLearned","questsCompleted" },
  "recentInteractions": [ { "type","ts",… } ] }   // last 20
}
```
`GET /api/skills/manifest.json` (partner Bearer `hk_…` OR a live connected/hosted agent's own
`X-Clawville-Agent-Session` bearer — see the protocol manual §4) returns the code-owned `protocol` + `clawville-play` orientation +
per-building skill pointers, each with an opaque `contentHash` — compare for equality to detect a changed
body, re-fetch only changed URLs. The manifest body carries nothing partner-private (versions, content
hashes, public relative URLs), so the same 60s-cached body is served to every authorized branch.

Building-skill installation is a separate owner write:

`POST /api/skills/:buildingId/claim` with a Lucia session or the agent's live
`X-Clawville-Agent-Session` bearer. The Hatcher `skills:read` partner key remains
read-only and cannot authorize this POST by itself. A registered Hatcher agent
may claim only through its own live ownership-proven agent session. Claiming
emits no reward/event and does not change the existing `skill_md.fetched` read
metering.

---

## 9. Runtime behavior (we fail soft, never crash the world)

Timeout / non-2xx (incl. 429) / network error / redirect / malformed JSON → "this agent didn't speak this turn";
the agent stays in-world, we log (never the token) and move on. **No auto-retry within a turn** — the next
player message / autonomous tick calls again, so a briefly-sleeping runtime self-heals. **Ask:** a fast
`503` (or `429 + Retry-After`) on a cold runtime beats a long hang; tell us if you want bounded `Retry-After` backoff.

---

## 10. Go-live checklist

✅ done: key swap, read key, staging contract (register/PATCH/DELETE, per-agent cognition, stats, skills,
session-survives-deploy + auto-reconnect, owner launch-exchange in controlled mode).

⚠️ remaining (Hatcher side): confirm §6 items 1–3 (`mode:"controlled"` accepted, success schema, error taxonomy,
re-exchange semantics). Then register **1 OpenClaw + 1 Hermes** test agent on staging and we verify real in-world
play end to end.

---

*Partner cross-check for version 20 (2026-07-16): the existing refreshed public
`HatcherLabs/hatcher-host-frontend` snapshot remains at
`9cc426b608bd66d0f40cd9f72beb95574f221712`. `lib/api/types.ts` still models the
ClawVille protocol pointer as the same extensible three-field structure, and
`lib/api/methods.ts` still exposes the unchanged register/PATCH/DELETE/stats/
launch methods. Version 20 adds an owner/live-agent-session claim route outside
those partner methods; partner-key reads, signed paths, callback bodies, and
`[ACTION:]` verbs/parameters/bounds are unchanged. The staging signed harness
remains Fable's pre-promotion gate.*

*Partner cross-check for version 19 (2026-07-16): refreshed public
`HatcherLabs/hatcher-host-frontend` main at
`9cc426b608bd66d0f40cd9f72beb95574f221712`. The upstream snapshot contains
no `CONTRACT.md`; the available live client sources were checked directly:
`lib/api/types.ts` keeps `ClawVilleProtocolPointer` extensible with optional
`version`/`contentHash`/`url`, and `lib/api/methods.ts` keeps the existing
register/PATCH/DELETE/stats/launch methods and request bodies unchanged. The
wallet panel consumes the pointer structurally and does not pin version 18.
Version 19 changes only the universal public-agent bind/manual/direct-agent
pointer discoverability; the established live-agent/partner read branches are
unchanged. It changes no Hatcher request/response field, signed
path, auth header, callback body, or `[ACTION:]` verb/parameter/bound. The signed
staging Hatcher harness remains the pre-promotion runtime gate.*

*Partner cross-check for version 18 (2026-07-14): refreshed public
`HatcherLabs/hatcher-host-frontend` main at
`9cc426b608bd66d0f40cd9f72beb95574f221712`; reviewed
`.hatcher-ref/lib/api/types.ts` `ClawVilleRegisterBody`/response types and
`.hatcher-ref/lib/api/methods.ts` register/PATCH/DELETE/stats methods. The new
redeem declaration is served through ClawVille's universal `tools.json` and
manual only: no Hatcher request/response field, signed path, auth header, or
`[ACTION:]` verb/param/bound changes. Harness verification remains pending.*

*Internal covenant recording added 2026-07-15: attributed movement, entry, and
chat effects from the existing six-verb `[ACTION:]` surface now append
best-effort records after validation; cosmetic emotes remain unrecorded. No Hatcher
request/response/auth/cognition field or verb parameter/
bound changed; `PROTOCOL_VERSION 18` remains unchanged.*

*Reconciled against live staging on 2026-06-15; **§7a partner storefront + `PROTOCOL_VERSION 5→7` correction added
2026-07-02** (Phase D, additive — the wire contract for the existing partner-hatcher routes is unchanged);
**`PROTOCOL_VERSION 8→9` added 2026-07-03** (public `POST /api/agent/reconnect` now additionally mints a fresh
agent bearer `sessionId`+`expiresAt`, accepts an optional `{gatewayUrl, authToken, protocol}` re-supply, and
registers credential-less real-gateway sessions dormant — Hatcher agents are fully restorable from the row and
NEVER take this path; the partner-hatcher wire, the `[ACTION:]` whitelist, and the launch/exchange flow are
byte-identical). **`PROTOCOL_VERSION 9→10` added 2026-07-06** (P3 slices 1-4 — the manual now documents the
NEW agent-facing endpoints that already shipped on staging: durable event replay + goal stream
`GET /api/agent/:s/events/replay` + SSE `Last-Event-ID` catch-up (§2), chat-bar directive awareness via the
`agent.directive.set` goal-stream event (§9), earned skill-memory read `GET /api/agent/:s/skills/:b/skill-memory`
(§4), and run-a-store land services list/browse/buy (§10); §3a now also applies to ClawVille-hosted-cognition
agents with the SAME verb set. ADDITIVE docs only — NO new `[ACTION:]` verb, and the partner-hatcher
register/PATCH/stats/error WIRE is byte-identical, so your existing integration is UNCHANGED; the bump is an
eager re-embed signal to pull the new manual). Code is
the source of truth: `apps/api/src/routes/{partner-hatcher,partner-hatcher-launch,partner-storefront}.ts`,
`apps/api/src/services/{skill-protocol,npc-simulation,agent-session-config,x402-payai}.ts`,
`apps/api/src/routes/portal.ts`. Internal companions: `ARCHITECTURE.md §6/§7/§13`, `GameFeatures.md §2f`.
**`PROTOCOL_VERSION 13→14` added 2026-07-10** (vCLAW copy rebrand only; contract identifiers and partner wire
unchanged). **`PROTOCOL_VERSION 14→15` added 2026-07-12** (the manual now documents bounty rewards as integer
vCLAW, the shared 5-vCLAW/$0.05 minimum, exact ×10^4 USDC-base-unit conversion, and the bounty API's renamed
`paymentRail` plus reward response fields). No Hatcher partner wire/auth or `[ACTION:]` verb/parameter/bound
changed; the local contract harness remains Fable's pre-deploy acceptance gate.*
