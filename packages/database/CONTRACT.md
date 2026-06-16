# Hatcher ↔ ClawVille — REAL partner contract (pulled from HatcherLabs/hatcher-host-frontend@main, 2026-06-13)

This is the AUTHORITATIVE partner-side contract, extracted from Hatcher's actual open-source
frontend (their backend `api.hatcher.host` is private, but the frontend's API client + types
define every field that flows through their backend to/from our endpoints). Review OUR
implementation against THIS, not against assumptions.

Source files (staged in this dir):
- `hatcher-types.ts`     = HatcherLabs/hatcher-host-frontend `lib/api/types.ts` (ClawVille* interfaces)
- `hatcher-methods.ts`   = `lib/api/methods.ts` (their API client — verbs/paths/bodies)
- `ClawVilleWalletPanel.tsx` = their integration UI (modes, stat ranges, launch flow)
- `hatcher-api-index.ts` = `lib/api/index.ts`

Our code under review (worktree = c0fe8dde, byte-identical to staging):
- `apps/api/src/routes/partner-hatcher.ts`        (register/PATCH/DELETE/stats/cognition)
- `apps/api/src/routes/partner-hatcher-launch.ts` (launch-exchange callback)
- `apps/web/src/components/game/hatcher-launch-handler.tsx` (owner launch entry)
- `apps/api/src/services/{openclaw-session-restore,agent-session-config,hatcher-session-webhook,agent-body-idle-sweeper,reserved-agent-namespaces,keyed-mutex,partner-signature}.ts`
- `apps/api/src/middleware/require-auth-or-agent.ts`
- `apps/api/src/services/openclaw-client.ts` + `hatcher-config.ts` (SSRF)
- `apps/web/src/lib/three/{vrm-avatar-sizing,vrm-character-animator,remote-players}.tsx`
- `apps/api/src/services/skill-protocol.ts` (PROTOCOL_VERSION)

## Their type contract (verbatim, hatcher-types.ts:579-637)

```ts
interface ClawVilleProtocolPointer { version?: number; contentHash?: string; url?: string; [k]: unknown }
interface ClawVilleRegistrationStatus {
  agentId: string; mode: string|null; name: string|null; species: string|null;
  walletAddress: string|null; sessionId: string|null; sessionExpiresAt: string|null;
  protocol: ClawVilleProtocolPointer|null; registeredAt: string|null; updatedAt: string|null;
}
interface ClawVilleConfigStatus { enabled; configured; apiBaseUrl; proxyBaseUrl;
  issuerPublicKey: string|null; issuerWellKnownUrl; registered; registration }
interface ClawVilleRegisterBody {
  mode?: "avatar"|"override"; name?; species?; personality?;
  stats?: { hp?; attack?; defense?; speed? };
  homeX?: number; homeY?: number; targetNpcId?: string; rotateScopedToken?: boolean;
}
type ClawVillePatchBody = Partial<ClawVilleRegisterBody>;   // ← can send ALL register fields
interface ClawVilleRegisterResponse { registration: unknown; local: ClawVilleConfigStatus }
interface ClawVilleLaunchResponse { grantId; agentId; launchToken; launchUrl; expiresAt }
type ClawVilleStatsResponse = unknown;
```

Their wallet panel (`ClawVilleWalletPanel.tsx`) form ranges: **hp min 1 max 500; attack/defense/speed min 1 max 100.**
Defaults: hp 100, attack 12, defense 10, speed 12. mode select: `avatar | override`.

Their backend builds the launch URL (`launchUrl` in ClawVilleLaunchResponse) and the user
opens it. Per Hatcher's own message their PROD generates a **QUERY string**:
`https://staging.clawville.world/game?hatcher_agent=<id>&hatcher_launch=<token>`.
After landing, OUR client must POST a signed callback to
`https://api.hatcher.host/integrations/clawville/launch/exchange`
with `{agentId, launchToken, clawvillePlayerId, clawvilleSessionId, mode}`, signed with the
ClawVille service-issuer (same as chat-cognition callbacks).

## SEED FINDINGS (orchestrator pre-read — verify, expand, do NOT assume complete)

1. **[CRITICAL — integration silently dead] query-vs-fragment.** `hatcher-launch-handler.tsx`
   reads ONLY `window.location.hash` (fragment). Hatcher PROD sends QUERY params. Result: handler
   finds nothing, no exchange fires, owner lands as a plain guest with no agent binding. Our
   exchange route's own comment claims fragment is the contract — but the partner's deployed
   behavior is query. Weigh: (a) accept BOTH query+fragment client-side (works immediately;
   launchToken is useless to a third party without OUR issuer signature, so the log-leak risk is
   low — the signed exchange is the real boundary) vs (b) hard-depend on Hatcher switching to
   fragment (integration stays broken until they redeploy). Recommend a robust fix that works
   against the partner's ACTUAL current behavior.

2. **[HIGH — silent no-op] patchSchema drops fields.** `patchSchema` only has
   name/species/color/personality/mode/targetNpcId/cognition. Their `ClawVillePatchBody =
   Partial<RegisterBody>` can send **stats, homeX, homeY, rotateScopedToken**. Plain Zod object
   strips unknown keys silently → PATCH returns 200 but restat/reposition/rotate never apply.

3. **[MED] rotateScopedToken unhandled** in register AND patch schemas. Hatcher added it to their
   type intending to use it (rotate the scoped cognition bearer). We never read it. Determine the
   intended semantics vs our existing `cognition` re-supply path and whether they collide.

4. **[MED] statsSchema bounds mismatch.** Ours: hp 50-150, atk/def/spd 5-25. Theirs (form): hp
   1-500, atk/def/spd 1-100. Default form values pass; any out-of-range value → 400. Decide widen
   vs relay-to-partner.

5. **[verify] response-shape parity.** Does our register/stats/`publicAgentRecord` output carry
   every field their `ClawVilleRegistrationStatus` reads (sessionId, sessionExpiresAt, updatedAt,
   walletAddress, protocol{version,contentHash,url}, registeredAt, mode, name, species)? Missing
   fields render as `-`/null in their UI (nullable, non-fatal) but are parity gaps.

These are STARTING POINTS. The review must cover the entire surface (security, session
lifecycle, 3D avatar fixes, cognition proxy, three-surface knowledge sync) and cross-reference
each claim against the staged Hatcher source with file:line citations.

## RESOLVED IN `fix/hatcher-contract-parity` (2026-06-13)

Full findings + line citations: `REVIEW-REPORT.md`. Canonical doc updates: `ARCHITECTURE.md`
(route/schema/response, session lifecycle, issuer purposes, security), `GameFeatures.md §2f`
(owner-launch flow), `3dStructure.md §6c` (Phanes height + walk in-place strip).

### CODED IN THIS BRANCH (our side, shipped)

| FIX | Area | What changed |
|---|---|---|
| FIX-1  | launch carrier | Owner-launch handler reads the grant from BOTH query AND fragment, PREFERRING query (Hatcher PROD sends query — fragment-only reader was silently dead); strips from whichever carrier it arrived on. |
| FIX-2  | PATCH schema | `patchSchema` accepts `stats`/`homeX`/`homeY`/`patrolRadius` and merges them into one `metadata` object — restat/reposition now applies (was a 200-OK no-op). |
| FIX-3  | stats bounds | Widened to **hp 1-500, atk/def/spd 1-100** (feeds `metadata.stats`+display only, never settlement). Conservative match of Hatcher's form ranges — authoritative range pending **R4**. |
| FIX-4  | session TTL | `extendSessionTtl(agentId)` (was dead code) fires fire-and-forget from every mutating gateway action via `resolveSession()`; a continuously-active connected/Hatcher agent is no longer idle-despawned/swept. |
| FIX-5  | protocol manual | `buildProtocolManual §3a` documents all 5 `[ACTION:]` verbs (was only `enter_cove`) → executor↔manual parity. `PROTOCOL_VERSION` stays 5 (no verb/param changed). |
| FIX-6  | DoS | 64KB `bodyLimit` mounted on `/api/partner/hatcher/*` before handlers. |
| FIX-7  | exchange mode | Conservative handling of the exchange `mode` field — authoritative accept/reject pending **R2**. |
| FIX-8  | rotateScopedToken | Accepted-and-ignored (no schema-strip 400). Rotate by re-supplying `cognition.scopedToken` — semantics pending **R3**. |
| FIX-9  | replay residual | ACCEPTED idempotent residual — NO seen-cache (it was prototyped then reverted: would falsely 401 legit retries per Codex review; writes are idempotent-by-agentId, window = Hatcher's 300s skew). Future non-idempotent verbs must add nonce protection. |
| FIX-10 | cove driver | Documented the proxy-cognition cove path (brain `enter_cove()` → partner backend plays session-bound blackjack tools with the register-returned `sessionId` for real-CT settlement). |
| FIX-11 | 3D height | `phanes: 297` added to `SPECIES_TARGET_HEIGHT_WU` — owner (animatorId-keyed) and peer (species-keyed) views now agree. |
| FIX-12 | launch recovery | Transient launch failures (network / issuer 503 / 401 cookie-race) offer an in-page Retry + one auto re-attempt; terminal failures keep the relaunch dead-end. |
| FIX-13 | coordinate space | `homeX`/`homeY` pinned to the **11520-px sim space**, bounds **32-11488**, default **5760,5760** (true center; supersedes 2560). Pending partner agreement **R5**. |
| FIX-14 | issuer purpose | `partner-launch-exchange` added to published issuer purposes. Only load-bearing if Hatcher enforces purpose-scoping — **R8**. |
| FIX-15 | 3D in-place strip | Defensive `walk` added to `PER_CHARACTER_IN_PLACE_CLIPS['hermes-male']` so the latent broken on-disk `hermes-male/walk.glb` (+1.887 hips-Y/loop) stays sink-safe if ever re-wired. |
| FIX-16 | species render key | `species` registry-normalized (`getAgentModel` `'hatcher'` else `DEFAULT_HATCHER_MODEL_KEY`) before persist/spawn — arbitrary owner string can't become the body modelKey. |
| FIX-17 | response fields | `registeredAt`/`updatedAt` (ISO) emitted on register/PATCH/stats responses. |
| FIX-18 | IP trust | `getClientIp` drops spoofable `x-real-ip`; order now `cf-connecting-ip` → last `x-forwarded-for` → `unknown`. No-op on CF-fronted prod. |
| FIX-19 | wallet status | `walletPending:boolean` added to register/PATCH responses (true when `ensureWallet` deferred). |

### ACCEPTED RESIDUAL (no code change, documented)

| FIX | Why |
|---|---|
| FIX-20 | DNS-rebind TOCTOU residual on the cognition fetch — accept; adopt pinned-IP fetch when the runtime exposes it. Current SSRF guard (sync literal-IP reject + async DNS-resolve reject + `redirect:'manual'`) already closes the common cases. |

### PARTNER RELAY — Hatcher must change or confirm (NOT unilateral)

| Relay | Coupled FIX | Hatcher action |
|---|---|---|
| **R1** | FIX-1 | Migrate `launchUrl` to emit the grant in the URL **fragment** (`#hatcher_agent=…&hatcher_launch=…`) as the durable log-hygiene carrier. Query works today; fragment is the hardening follow-up. |
| **R2** | FIX-7 | Confirm whether their private exchange validator accepts/ignores `mode:'autonomous'` (outside their `avatar\|override` enum). |
| **R3** | FIX-8 | Confirm `rotateScopedToken` semantics — is "rotate" satisfied by re-supplying `cognition.scopedToken` (our accept-and-ignore), or do they expect a distinct rotation? |
| **R4** | FIX-3 | Confirm the AUTHORITATIVE stat range (their form is hp 1-500 / atk-def-spd 1-100). ClawVille widened to match; will re-clamp if they pin tighter. |
| **R5** | FIX-13 | Agree on the single `homeX`/`homeY` coordinate space + bounds ClawVille pins (11520-px sim, center 5760,5760). |
| **R6** | — | Confirm Hatcher treats `sessionId` ABSENCE on a PATCH response as "unchanged," not "cleared" (it is a spendable bearer delivered once; we only re-mint when no live session exists). |
| **R7** | — | Provide the exact proxy chat endpoint spec (`/integrations/clawville/agents/:id/chat` path, headers, request body, response envelope) — our round-trip shape is currently ASSUMED, not verified. |
| **R8** | FIX-14 | Confirm whether their exchange verifier enforces signed-purpose scoping; if so, our `partner-launch-exchange` purpose becomes load-bearing (today verification succeeds on pubkey match regardless). |

Coordinate items (FIX-3/7/8/13/14) shipped the conservative variant immediately and are safe to
tighten once the matching relay item is confirmed — none block the integration working today.
