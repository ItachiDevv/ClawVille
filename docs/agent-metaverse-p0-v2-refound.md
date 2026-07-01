# P0 v2 — re-founded on origin/staging (v7) + folded review findings

> Supersedes the build instructions in `agent-metaverse-p0-lifecycle-design.md` (that doc's DESIGN + ground-truth reasoning still hold; this doc updates the BASE and folds in the collaborative-review findings from the first (v3) implementation attempt). Same P0 goal — **lifecycle truth**, no autonomy engine, no substrate rename, no `[ACTION:]` generalization.
>
> **BASE: `origin/staging` @ `7ff0d793`, `PROTOCOL_VERSION = 7`.** The first attempt was built on a branch 818 commits stale (`PROTOCOL_VERSION = 3`) and is discarded. **Re-validate EVERY v3 line number against v7 before editing** — the session-lifecycle files moved hundreds of commits. Worktree: `C:/Users/itachi/Documents/Crypto/cv-agent-p0`, branch `feat/agent-metaverse-p0`.
> **Reference only (do NOT merge):** the discarded v3 impl is commit `630a0602` on branch `feat/agent-metaverse-build` (worktree `cv-agent-metaverse`); its rehydrator draft is a useful shape reference but must be re-derived against v7.

## ⚠️ RE-SCOPE (2026-07-01, from regress-auditor's v7 pre-read — verified): D-1 rehydrator DROPPED

**v7 ALREADY solved restart-survival, better than the v3 design.** `apps/api/src/services/openclaw-session-restore.ts` (2026-06-11), wired into `validateLiveAgentSession` (`require-auth-or-agent.ts:119`), does **lazy on-demand restore**: on a gate Map-miss it hashes the incoming bearer → finds the row by persisted `session_key_hash` → re-validates TTL fail-closed → rebuilds `{config,client}` under the agent's **ORIGINAL bearer** (not re-minted; hatcher-proxy cognition fully restored). Restore matrix: hatcher/nanoclaw/milady/anonymous = restorable; openclaw/ironclaw/custom real-gateway = NOT restorable (no persisted `auth_token`).

Consequences:
- **D-1 eager rehydrator: DROPPED.** Redundant + CONFLICTING — an eager boot-rehydrator that mints a fresh sessionId collides with lazy-restore (double-body for avatar / "already overridden" lockout for override when the real agent presents its surviving original bearer). Do NOT port it. (Eager in-world presence for SERVER-DRIVEN autonomous agents, if wanted, is a P1 concern and must be restore-compatible, not a fresh-id mint.)
- **D-2 session-status: NARROWED to RESTORE-AWARE.** Not the v3 "require RAM-live → 410" (that would 410 restorable sessions and regress the restore feature). Fix only the residual lie: report `connected` when TTL-live AND (RAM-live OR `isRowRestorableFromIdentity(identityType)`); needs-reconnect only for TTL-live + UNRESTORABLE real-gateway types. Reuse the restore module's restorability logic.
- **D-3 sweeper body-removal: KEEPS (ports cleanly)** — v7 sweeper still leaves a zombie body. Race-safe vs restore (restore refuses swept rows; mark-swept before remove). The v3 M1/H2 rehydrator races are moot (no fresh-id minting).
- **H1/H2/M1** were rehydrator problems → moot. **B1 + D-4 unchanged.**

**Net v7 P0 = B1 root-fix + restore-aware session-status (D-2) + sweeper body-removal (D-3) + scoped constants (D-4).** No rehydrator.

## P0 deliverables on v7 (superseded where the RE-SCOPE above conflicts) + the folded fixes below

### B1 — BLOCKING, pre-existing LIVE vuln — FIX IN THIS DIFF (founder call: fold into P0)
`GET /api/npc/state` + `GET /api/npc/stream` (`routes/npc-sse.ts`, **no auth**) and the multiplayer `/api/world/:room/stream` return `getSnapshot()` / `getRoomSnapshot()`, which spread each body verbatim — and an **avatar-mode connected agent's body carries `id = "oc-${sessionId}"`**, where `sessionId` IS the `X-Clawville-Agent-Session` bearer. Any unauthenticated visitor reads `oc-<S>` and replays it → impersonation; ledger-capable session → **real-CT theft**; else → drive the body + farm leaderboard as the bound user. Verified live on `origin/staging`. Pre-existing (the 2026-06-03 auth-lens "fix #1" scrubbed `getActiveOpenClawBots` but NOT the snapshot path).
- **Fix:** sanitize the PUBLIC serializers (`npc-simulation.ts` `getSnapshot` ~:545 + `getRoomSnapshot` ~:569 — re-anchor on v7). An avatar body's **wire `id` must be a non-secret stable token = the body's public `agentId`**, never `oc-${sessionId}`. Keep the internal Map key `oc-${sessionId}` unchanged (server-internal). Override bodies already use the public `targetNpcId` — no change.
- **Client parity (money-grade, cove/land discipline):** verify `apps/web` treats `npc.id` as an OPAQUE stable entity key (no `oc-` parsing; no client→server round-trip that sends the id to a session-scoped route). If any path sends the id back, map it server-side. The id must stay STABLE per body across ticks (agentId is stable+unique) so entity interpolation doesn't break.
- This is the single most important fix in P0. Treat it with full money-path care: ledger-only, no new leak, adversary re-audits the agent path specifically.

### H1 — HIGH — session-status must not lie to a REMOTE after rehydration
Rehydrating a body under a NEW server-minted sessionId makes the agentId-keyed `session-status` report `connected:true` (RAM-live via the rehydrated session) while the remote/BYO/Hatcher agent's OLD bearer 401s — so the remote never sees a 410 and never reconnects. D-1 defeats D-2's truthfulness for the remote path.
- **Fix:** mark rehydrated sessions **PROVISIONAL / needs-reconnect**. `session-status`: when the only live RAM session(s) for an agentId are provisional, return the **needs-reconnect 410 variant** (NOT `connected:true`) so the remote reconnects. A real `/connect` or `/reconnect` clears the provisional flag / replaces the session → subsequent polls report connected. Body continuity is preserved (the body renders) while remotes are told to reconnect. Server-driven/hosted agents (no external bearer — they ARE the session) are unaffected.

### H2 — HIGH — evict-by-agentId on the `openclaw.ts /register` path
After rehydrate, a re-register on `routes/openclaw.ts` (deliberately does NOT evict by agentId, anti-grief) → OVERRIDE: `registerOpenClaw` "already overridden" throw → 400 → keyless legacy agent **locked out up to 24h**; AVATAR: **double body**. Only `/connect` + `partner-hatcher` got the unconditional evict.
- **Fix:** a same-agentId re-register on `openclaw.ts` must first evict its OWN **provisional/rehydrated** body (scope the eviction to a provisional or same-owner session so the anti-grief property is preserved — do NOT let a stranger evict a live owned session). OR exclude non-owned/legacy rows from rehydration entirely. Prefer the scoped-evict. Re-anchor on v7 `openclaw.ts`.

### M1 — MEDIUM — sweeper race (D-3)
D-3's body-removal resolves "the session(s) for this expired agentId" AT REMOVAL TIME; a `/connect` landing in the sweep window installs a NEW live session (future TTL) which the sweep then unregisters → the just-succeeded reconnect is silently voided.
- **Fix:** the sweeper must only unregister the session(s) it actually observed expired — capture the sessionId(s) at snapshot time, or re-check the resolved session's TTL is still expired immediately before `unregisterOpenClaw`. Never unregister a session whose TTL is now in the future.

### L1 — LOW — gateway-protocol dormant = inert
Non-hatcher/non-nanoclaw gateway rows (`openai-compat`/`custom-webhook`) must rehydrate to the **inert nanoclaw** path (dormant, no outbound), matching the hatcher-decrypt-fail fallback — NOT a broken `gatewayUrl:'http://localhost:0'` client (per the design doc's "prefer dormant over broken").

## Invariants (re-assert against v7)
- **`PROTOCOL_VERSION` stays 7 — NO bump.** Re-apply the skill-protocol §5 `410 session_not_live` doc-variant + the `orientation-skill.ts` drift-fix onto the CURRENT v7 files; do NOT drop v7's newer lines. The manual text update is a required same-diff doc, not a wire-contract change.
- Rehydration fail-CLOSED: rehydrated = **non-ledger** (`ledgerCapable:false`), verified enforced downstream (cove 403s it until a proof-carrying `/connect`/`/reconnect`).
- Per-row try/catch; never crash boot. Never log a raw sessionId (sessionDigest only). NULL TTL = expired. One body per agentId.
- Same-diff docs: `ARCHITECTURE.md` §6/§13, `CLAUDE.md` (metaverse framing + 4-mode matrix — re-apply against v7 which lacks them), tick P0 in `docs/agent-metaverse-model.md §9`.

## Gates (before "done")
- `tsc` clean on touched files (note: v7 has a PRE-EXISTING poker-cash tsc breakage unrelated to P0 — don't be blamed for it, but don't add to it).
- Existing tests green for touched areas; the Hatcher `selftest-e2e.ts` no worse than baseline.
- **Codex adversarial pass** on the B1 fix + rehydration + session-status (money/bearer surface).
- **Live restart-survival proof** on staging: connect an agent → restart API → assert session-status + bearer agree, body rehydrates (provisional), `/reconnect` cleanly replaces it (no double body), AND `/api/npc/state` no longer leaks any `oc-<sessionId>`.
- Founder sign-off.
