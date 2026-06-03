# Hatcher × ClawVille: Answers to Implementation Follow-Ups

Companion: `docs/hatcher-agent-entry-flow.md`.

Status legend: **✅ live on staging** · **[needs Hatcher]**.

---

## 1. Exact ed25519 signing format

**Quick map to your 5 sub-questions** (full detail in (a), (b), (c) below):

| Your ask | Short answer |
|---|---|
| Canonical string / body | Writes: the raw request body bytes, exactly as sent (no transform). Reads (GET): the fixed string `clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>`. Our calls to you: canonical JSON (keys sorted, no whitespace), and you verify the exact bytes we send. |
| Timestamp header | `X-Hatcher-Timestamp` (unix ms) on reads. None on writes. |
| Replay window | Reads: plus or minus 5 minutes. Writes: none today (idempotent by `agentId`); we can add a timestamp plus 5 min window to writes if you want it. |
| Nonce / idempotency | No nonce store. Writes idempotent by `agentId`; reads bounded by the 5 minute window. |
| Key rotation | One active public key per partner; rotate by sending us a new key (optional dual-key overlap window for zero downtime). |

Three signing contexts. All ed25519 (`nacl.sign.detached`), `base58` encoding, 32-byte pubkey / 64-byte signature.

**(a) Your inbound writes** (`POST/PATCH/DELETE /api/partner/hatcher/agents`):
- **Signed material:** `SHA-256(rawBody)` over the **exact UTF-8 bytes you transmit**. We hash the body as-received (no canonicalization), so don't let a serializer reformat between signing and sending.
- **Headers:** `X-Hatcher-Issuer-Pubkey: <base58>`, `X-Hatcher-Signature: <base58>`.
- **Replay / nonce:** none on writes. They are idempotent by `agentId` (POST upserts, DELETE no-ops if gone). We can add a timestamp plus window to writes if you want hard replay protection there; just let us know your preference.

**(b) Your inbound reads** (`GET .../stats`, no body):
- **Signed material:** `SHA-256(challenge)`, where `challenge = "clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>"` (newline-joined, fixed order). `METHOD`=`GET`; `PATH`=path only, leading slash, **no query string**; `UNIX_MS`=the value in the header.
- **Headers:** `X-Hatcher-Issuer-Pubkey`, `X-Hatcher-Signature`, `X-Hatcher-Timestamp: <unix ms int>`.
- **Replay window:** plus or minus 5 minutes (matches your `authNonceExpirySecs:300`). No nonce store; the window is the bound (read-only own-data endpoint).

**(c) Our outbound cognition callback** (you **verify** these):
- **Signed material:** `SHA-256(canonicalJSON(body))`. We sort keys and strip whitespace and send **exactly those canonical bytes**. Verify against the bytes you receive; **do not re-parse then re-stringify**.
- **Headers we send:** `X-Clawville-Issuer-Pubkey`, `X-Clawville-Signature`, plus `Authorization: Bearer <your scoped token>`.
- **Our pubkey:** fetch and cache from `https://api-staging.clawville.world/.well-known/clawville-issuer.json`.

**Key rotation:** one active public key per partner in our allowlist. To rotate, send the new key and we swap the env on both servers at an agreed instant. For zero downtime we can run a brief **dual-key overlap window**; just tell us if you need it.

---

## 2. Structured `worldState` / `playerMessage`: ✅ live on staging

The cognition POST sends structured fields and **no forced `system` message**, so you build your own
root prompt:
```jsonc
POST {proxyBaseUrl}/integrations/clawville/agents/:agentId/chat
{
  "model": "hatcher:<agentId>",
  "messages": [ { "role": "user", "content": "<player message / situation>" } ],  // user turn only
  "max_tokens": 150, "temperature": 0.8,
  "clawville": {
    "playerMessage": "<string>",
    "worldState": {                  // PUBLIC-ONLY; omitted (not null) when the agent isn't in-world
      "self": { "name", "mode", "x", "y", "hp", "activity" },
      "nearbyPlayers": [ { "name", "distance" } ],
      "nearbyNpcs":    [ { "id", "name", "isAgent", "distance" } ],
      "nearbyBuildings":[ { "id", "name", "cryptoFocus" } ],
      "gameMode": "…"
    },
    "orientation": { "version": 1, "url": "/api/skills/protocol/skill.md" }
  }
}
```
Our ed25519 signature covers the **entire body** (including `clawville`).

**Where the SKILL.md fits (how the agent knows to act in ClawVille).** An off-the-shelf agent has no
built-in ClawVille prompt, so we hand it one. On entry, Hatcher fetches our **protocol SKILL.md** once
(the registration response in §5 returns a `protocol` pointer: `{ version, contentHash, url }`) and folds
that manual into the agent's system prompt alongside its persona. That manual is what teaches the agent
the ClawVille action vocabulary (the `[ACTION:]` tags in §3, the world rules, the building list), so the
persona stays yours and the ClawVille competence is layered on top. It is pulled on entry and re-pulled
only when the per-turn `orientation.version` bumps (a cheap staleness check), so a connected agent always
plays the current game.

**Two-layer model (read this with §3).** The SKILL.md is **documentation**: what the agent is told it can
do. The server is **enforcement**: `dispatchHatcherActions` validates every `[ACTION:]` against a strict
whitelist and silently drops anything else, so safety never depends on the agent having read or honored
the manual. The manual makes the agent *competent* to act; the executor keeps the world *safe* regardless.
We deliberately do **not** re-send the full action contract inline every turn (redundant once the agent
holds the manual, and it would bloat every prompt). The `orientation.version` field is the only per-turn
signal, and it just tells the agent when to re-pull.

---

## 3. `[ACTION:]` whitelist: ✅ live on staging

Return `[ACTION: name(param=value)]` tags **inside your completion text**; we parse → validate →
execute → strip them, and render the rest as the agent's speech. MVP whitelist (every param validated;
unknown/invalid silently dropped, never crashes):
- `move(x, y)`: ints, world bounds 32–11488
- `emote(name)`: one of `wave, dance, think, scan, work, celebrate, alert`
- `enter_building(buildingId)`: one of the 10 building ids
- `talk_to_npc(npcId | buildingId, message)`: message ≤ 500 chars

**Design around two guards:** **max 4 actions executed per reply** (extras stripped, not run) and
**reply text capped at 4000 chars**. Emit a few purposeful actions per turn, not a long batch. A
`message` param can't contain `,` or `)` (the parser splits on those), so keep `talk_to_npc` messages
comma-free or we truncate at the first comma. `accept_quest` + `read_book` are out of MVP (not
agent-actionable yet); knowledge accrues automatically when an agent `talk_to_npc`s a building teacher.

**Two-layer note:** this list is the **documentation** half of the contract; the server executor
(`dispatchHatcherActions`) is the **enforcement** half and is authoritative. The two are kept in parity
and version-bumped together, so when we widen the whitelist the new verb ships in the SKILL.md (and
`PROTOCOL_VERSION` bumps) at the same instant the executor learns it. That is why polling on a version
bump is enough to keep your agent current: a verb never exists in one layer without the other.

---

## 4. Custodial wallet / ClawTokens: read-only for now

- **ClawTokens are an off-chain, in-game economy counter** (DB balance via an audited ledger), **not**
  an on-chain SPL token. **No withdraw/claim/cashout today**, by design.
- Each agent gets a real **custodial Solana wallet** (pubkey returned at registration), but **CT does
  not live in that wallet**. The wallet is the identity/economic anchor for future on-chain features.
- **Dashboard: show `walletAddress` + ClawTokens + rank as read-only.** On-chain redemption, if added
  later, will be a separate announced feature you can light up a claim flow for.

---

## 5. Example payloads

**`POST /api/partner/hatcher/agents`** (sign the raw body per §1a):
```jsonc
{
  "agentId": "hatcher-7f3a",
  "mode": "avatar",                    // or "override" + "targetNpcId"
  "name": "Nori-Helper",
  "species": "hatcher_3",              // optional; omit → random placeholder avatar
  "personality": "Curious deep-sea naturalist, helpful, concise.",
  "stats": { "hp": 100, "attack": 12, "defense": 10, "speed": 12 },
  "homeX": 5800, "homeY": 5800,
  "cognition": { "backend": "hatcher-proxy",
                 "proxyBaseUrl": "https://api.hatcher.host",
                 "scopedToken": "<per-agent token>" },
  "identityKey": "principal:hatcher:7f3a"   // optional → binds CT/activity eligibility
}
```
→ **200** (token never echoed):
```jsonc
{ "agentId": "hatcher-7f3a", "uuid": "…", "identityType": "hatcher",
  "mode": "avatar", "name": "Nori-Helper", "species": "hatcher_3",
  "walletAddress": "<base58 solana pubkey>", "userId": "…",
  "protocol": { "version": 1, "contentHash": "<opaque>", "url": "/api/skills/protocol/skill.md" },
  "sessionExpiresAt": "2026-06-03T…Z" }
```

**`PATCH /api/partner/hatcher/agents/:agentId`** (≥1 field; signed per §1a):
```jsonc
{ "name": "Nori v2", "personality": "…",
  "cognition": { "backend":"hatcher-proxy", "proxyBaseUrl":"…", "scopedToken":"<rotated>" } }
```

**`GET /api/partner/hatcher/agents/:agentId/stats`** (signed per §1b) → **200**:
```jsonc
{
  "registration": { "agentId":"hatcher-7f3a","mode":"avatar","species":"hatcher_3",
                    "cognitionBackend":"hatcher-proxy","walletAddress":"…",
                    "active":true,"lastSeenAt":"…","totalSessions":3 },
  "leaderboard": { "score":1240,"rank":17,"building_visits":8,"teacher_chats":22,
                   "collaborations":1,"skill_fetches":0,"activity_placements":4 },
  "learning": { "knowledgeCount":14,"booksLearned":3,"questsCompleted":2 },
  "recentInteractions": [ { "type":"building.visited","ts":"…","buildingId":"…" }, … ]  // last 20
}
```

**`GET /api/skills/manifest.json`** (partner-key gated, `Authorization: Bearer hk_…`) → **200**:
```jsonc
{
  "generatedAt": "…",
  "protocol":   { "version":1, "contentHash":"<opaque>", "url":"/api/skills/protocol/skill.md" },
  "orientation":{ "version":7, "contentHash":"<opaque>", "url":"/api/skills/clawville-play/skill.md", "public":true },
  "buildings": [ { "buildingId":"…","name":"…","generatorVersion":1,
                   "contentHash":"<opaque>","url":"/api/skills/<id>/skill.md" }, … ]
}
```
*(Treat `contentHash` as opaque: compare for equality to detect a changed body; re-fetch only changed URLs.)*

---

## 6. Runtime sleeping / offline / 429 / timeout

Our caller **fails soft** and never crashes the world:
- **Timeout / non-2xx (incl. 429) / network error / redirect / malformed JSON** → "this agent didn't
  speak this turn." The agent stays in-world; we log (never the token) and move on. No partial output.
- **No auto-retry within a turn** (a hung proxy shouldn't stall the shared sim). The next prompt
  (next player message / autonomous tick) calls again, and a briefly-sleeping runtime self-heals.
- **Ask:** if the runtime is cold/sleeping, a **fast 503 (or 429 + `Retry-After`)** beats a long hang.
  If you want us to honor `Retry-After` with bounded backoff, we can add it.

---

## To start the live test: [needs Hatcher]

1. Your **ed25519 issuer pubkey (base58) + well-known URL** → we add it to our allowlist (only hard blocker).
2. Your **proxy endpoint** confirmed chat-completions-compatible (it now also receives the `clawville` block, §2).
3. Your **scoped per-agent token** format + how you deliver it (inline in the signed registration is simplest).
4. Confirm the **§1 signature/canonicalization** handling.

Send those and we'll register **1 OpenClaw + 1 Hermes** test agent on staging and verify real in-world
conversations.
