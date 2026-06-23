# leaderboard-progression — Memory Index

> Persistent memory for the `leaderboard-progression` agent — owner of the **scoring engine + event-weight registry + quests/bounties/daily/XP + /dash** vertical (menu/UI ↔ backend ↔ economics ↔ knowledge). **Precedence: live code > the 3 canonical docs > this memory** — verify `git show origin/master:<f>` vs `origin/staging:<f>` vs working tree before trusting any FIXED/LIVE claim. Seeded 2026-06-22 from a verified code audit.

## Known traps (read BEFORE any change in this domain — feeds Phase 0)
1. **fp_hash coverage gap = the anti-farm escape hatch.** A request-path emitter using bare `logEvent({...})` instead of `logEventFromContext(c, {...})` writes `fp_hash = NULL`, so its rows escape the (fp,ip) farm-detection tier. CONFIRMED OPEN: `agent.collaboration.turn` (weight 40, the highest) is emitted bare at `agent-collaboration.ts:114` (system-internal, no Hono context); the per-day cap of 50 still bounds it by subject, but the fingerprint tier is blind. `/dash fingerprintCoverage24h` surfaces it. `[[fphash-coverage-gap]]`
2. **The two-leg scoring CTE must stay byte-for-byte in lockstep.** `agent_daily` (agent_id NOT NULL = Trainers) and `avatar_daily` (agent_id NULL AND avatar_id NOT NULL = Players) are DISJOINT; a new scored column/cap/filter added to one leg only silently zero-scores the other tier (in-code "KEEP IN LOCKSTEP" comment at :705). `[[scoring-cte-dual-leg-lockstep]]`
3. **A scored event name is a cross-file contract.** Each `eventType` literal lives in the emitter + the scoring CTE filter + the `/dash` query + the tutorial engagement gate; `events.event_type` is plain text (no compile-time guard) so a rename/typo silently drops scoring. Move all same-diff. `[[event-name-is-a-cross-file-contract]]`
4. **A reward credit must be ledger-only + atomic + idempotent.** Through `creditClawTokens`/`debitClawTokens` only, INSIDE the same `db.transaction` as its idempotency anchor (quest compare-and-set status, bounty escrow, tutorial unique index + 23505, level-up). A credit outside its anchor tx double-pays on retry/race. `[[reward-credit-atomic-idempotent]]`
5. **Daily-login streak update is NOT in the same tx as the credit — but is idempotent by date.** The `if (lastLoginDate === today)` short-circuit BEFORE both is the barrier (under-pay-on-crash only, never double); don't "fix" by moving the short-circuit after the credit. `[[daily-login-and-xp-idempotency]]`
6. **`awardXp` writes XP columns and CT in SEPARATE statements** — never add `clawTokens` to the XP `.set` (bypasses the ledger row-lock + audit row, the #1 token-economy ban). `[[daily-login-and-xp-idempotency]]`
7. **Guests must be 403'd from userId-keyed rewards.** A fresh guest signup mints a new `userId`, defeating a `(userId,questId)` idempotency key — `quests.ts:1305` checks `users.isGuest` → 403 `guest_not_eligible`; any new account-bound reward needs the same guard. `[[guest-reward-farm-guard]]`
8. **Proportional activity-cap denominator must equal the numerator universe.** `act_total` counts ONLY placement-IS-NOT-NULL non-bot rows; a malformed/NULL-placement row in the denominator deflates honest scores via `LEAST(act_total,cap)/act_total`; `act_total=0 → 0`. `[[activity-proportional-cap]]`
9. **Window/interval/limit/subject are whitelisted — never interpolate a raw query param into the scoring SQL.** `windowToInterval` maps a validated enum to a fixed literal via `sql.raw`; limit clamped 1..100; subject is a 3-value whitelist. `[[whitelisted-window-no-sql-injection]]`
10. **`agent.connected` per-day distinct-session cap is midnight-safe ONLY because it is a POINT event** (one row per connect, fresh session_id, single timestamp). Do NOT fold a multi-row-per-session event into the same daily distinct-count without re-checking the boundary. `[[scoring-cte-dual-leg-lockstep]]`
11. **Weights must match the canonical Brand-Identity scheme** (learning > arcade) — a weight change is a brand decision, not a number tweak, and must update CLAUDE.md + ARCHITECTURE.md + Nori `town-guide.ts` same-diff. The web `/leaderboard` page hard-codes the weights/caps in three spots (WEIGHTS / BREAKDOWN_HINTS / ScoringLegend) — a same-diff multi-site change until they're sourced from a shared constant like land. `[[event-weight-registry]]`
12. **The legacy composite board is a different surface — don't conflate.** `GET /api/leaderboard` (avatars-only, `COMPOSITE_WEIGHTS`, auth'd, 30s, reads paused peer-commerce domain tables) is the pre-pivot modal; Priority #3 is `GET /api/leaderboard/agents` (event-weighted, public, 60s, events-only). Editing one does not touch the other. `[[event-weight-registry]]`

## Invariants (the contract)
1. The events table is the ONLY scoring source — buildAgentSnapshot (leaderboard.ts:555) + /dash read EXCLUSIVELY from events (jsonb payload, 4 partial-ts indexes); never derive rank/metric from a domain table. The legacy composite board (GET /api/leaderboard, leaderboard.ts:1105, avatars-only, COMPOSITE_WEIGHTS, auth'd, reads paused peer-commerce tables, 30s cache) is a SEPARATE pre-pivot surface — editing one does not touch the other.
2. Event-weight registry is canonical + single-sourced in leaderboard.ts: AGENT_SCORE_WEIGHTS (:370 — buildingVisit 3 / teacherChat 10 / collaboration 40 / skillFetch 1 / session 1 / identityIssued 5), ACTIVITY_PLACEMENT_WEIGHTS (:387 — 1st 12 / 2nd 6 / 3rd 3 / default 1), DAILY_CAPS (:416 — building 10 / teacherChat 50 / collaboration 50 / skillFetch 11 / activity 10 / session 10); land weights/caps imported from @clawville/shared (:446 LAND_W/LAND_C). A weight/cap change updates CLAUDE.md Brand-Identity line + ARCHITECTURE.md + Nori town-guide.ts same-diff.
3. A scored contribution needs FOUR coupled sites or it silently scores 0 / farms uncapped: a weight, a LEAST(count,cap) daily cap, a COUNT(*) FILTER column in BOTH agent_daily AND avatar_daily, and a score term in BOTH agent_scores AND avatar_scores + the breakdown shaping. Mirror the land shared-constant pattern when adding a core weight.
4. The two CTE legs are disjoint subject tiers that must stay byte-symmetric: agent_daily (agent_id IS NOT NULL = Trainers) vs avatar_daily (agent_id IS NULL AND avatar_id IS NOT NULL = Players), UNION'd onto one board (in-code 'KEEP IN LOCKSTEP' comment at :705). A column/cap/filter added to one leg only scores that cohort differently.
5. Per-(subject,day) LEAST(count,cap) capping — not a global cap; over-cap events still LOG, score capped. agent.connected is capped via COUNT(DISTINCT session_id) and is midnight-safe ONLY because it is a POINT event (one row, one session_id, one timestamp, one day — :595 comment); never move a multi-row-per-session event under the same distinct-session cap without re-deriving midnight safety.
6. The proportional activity-cap denominator (act_total) must equal the four-bucket numerator universe (placement IS NOT NULL, non-bot) or LEAST(act_total,cap)/act_total deflates honest scores; act_total=0 → 0 (no divide-by-zero). Audit finding 2026-04-28.
7. Anti-farm = (fp_hash, ip_prefix_hash) salted by FINGERPRINT_SECRET (the FORENSIC detection tag, owned by auth-identity-session — NOT the cap key in the CTE) + the per-day cap + agent.connected emission coalescing (shouldEmitAgentConnected, 60s/fp, event-logger.ts:340). Routes emit via logEventFromContext(c,...) (event-logger.ts:443) which populates the tag; a bare logEvent() writes NULL fp_hash and escapes the fingerprint tier (legit only for system/cron).
8. Event names are cross-file contracts with no compile-time guard: a scored event_type literal (and scored payload keys placement/subjectType/isGuest/via/chatType) lives in the emitter + BOTH CTE legs + /dash + the tutorial engagement gate; events.event_type is plain text, so a rename/typo silently drops scoring. Grep the literal across apps/api/src and move all sites same-diff; coordinate payload shape with the emitter's owning domain.
9. Rewards are ledger-only AND atomic-idempotent: every CT reward (XP level-up, tutorial claim, admin-quest approve, bounty payout, daily-login) settles via creditClawTokens/debitClawTokens — NEVER a raw avatars.clawTokens write — inside the SAME db.transaction as its idempotency anchor (quest compare-and-set status quests.ts:432, bounty escrow bounties.ts:347/554/1219, tutorial unique (user_id,quest_id) index quests.ts:1369 + 23505, level-up). Earn paths short-circuit on the anchor BEFORE crediting.
10. awardXp (xp-service.ts:56-68) writes xp/level/totalXp via .set and the level-up CT via creditClawTokens in SEPARATE statements; clawTokens is NEVER in the XP .set. Daily-login (avatars.ts:1082) short-circuits if lastLoginDate===today BEFORE the credit (date-idempotent; streak+credit are two non-tx statements = under-pay-on-crash only, never double-pay).
11. Bots + guests score ZERO (subjectType <> 'bot', isGuest <> 'true') and feed nothing persistent; userId-keyed rewards 403 guests (guest_not_eligible, quests.ts:1305) because a fresh-userId-per-guest defeats a (userId,questId) idempotency key. An agent must NEVER be guest-demoted on the read/score path or its real contribution silently zeroes (the auth subject-keying-keystone).
12. Tutorial-quest = client-tracked but SERVER owns amounts (TUTORIAL_QUEST_REWARDS), idempotency (unique (user_id,quest_id)), AND a per-quest proof-of-engagement gate that counts the same events (validateTutorialQuestEngagement); pending quests hard-block (feature_not_shipped).
13. No user input reaches the scoring SQL: window → fixed interval via windowToInterval whitelist (leaderboard.ts:517) before the only sql.raw; limit clamped 1..100; subject whitelisted. Public board is events-only, unauth, 60 req/min/IP on a DEDICATED limiter (the S5 fix, not shared with reef-race daily-best), 60s per-window snapshot (cap 500, sliced to limit); getAgentLeaderboardEntry reuses the same cache so the Hatcher partner stats endpoint shows the SAME rank the agent sees publicly.
14. /dash teacher-chat counts the 10 residents ONLY: agent.chat.turn AND chatType IN ('building','location') AND isGuest <> 'true' (dashboard.ts:137); system-agent (Nori), wandering character NPCs, and guests are excluded — a new chat surface must pick a chatType that doesn't pollute this metric unless it IS a teacher. fingerprintCoverage24h (dashboard.ts:291/333) surfaces fp-null emitters.
15. Staging-first + same-diff docs + the 3 operational-knowledge surfaces: a weight/cap/quest/earn change updates ARCHITECTURE.md (Free Agent Leaderboard rubric) + GameFeatures.md + CLAUDE.md Priority #3 line AND Nori's town-guide.ts knowledge[] (it tells agents how to earn rank — stale = onboarding lies); connection SKILL.md + hosted-runtime are the other two surfaces. Memory is advisory: live code > 3 canonical docs > memory — verify git show origin/master vs origin/staging vs working tree before trusting FIXED/LIVE.

## File map (owned)
## Owned files (the leaderboard-progression vertical)

| Concern | File | Role / key invariant |
|---|---|---|
| **Scoring engine + weight registry + both boards** | `apps/api/src/routes/leaderboard.ts` (1194 lines) | `buildAgentSnapshot` (:555) two-leg per-(subject,day)-capped CTE; `AGENT_SCORE_WEIGHTS` (:370) / `ACTIVITY_PLACEMENT_WEIGHTS` (:387) / `DAILY_CAPS` (:416) canonical registry; `LAND_W`/`LAND_C` sourced from `@clawville/shared` (:446); `windowToInterval` whitelist (:517); `getAgentLeaderboardEntry` (:498) reuses the cache (partner stats == public rank); public `/agents` route (:953); legacy composite `COMPOSITE_WEIGHTS` (:108) + `/` (:1105) SEPARATE surface |
| **Events spine + writer** | `apps/api/src/services/event-logger.ts` (457) + `packages/database/src/schema/events.ts` + `schema/event-write-failures.ts` | fire-and-forget never-throws (3-tier fallback :398-429); secret-key sanitizer; raw-bearer redaction `RAW_BEARER_RE` (:57, exact-shape so `agent_id` GROUP BY handles survive); `agent.connected` coalesce `shouldEmitAgentConnected` (:340); `logEventFromContext` (:443) injects fp/ip; `events` cols + fp_hash/ip_prefix_hash + 4 partial-ts indexes |
| **XP / level-up** | `apps/api/src/services/xp-service.ts` (87) | `awardXp` (:25); XP cols via `.set` (:56-64, never clawTokens), level-up CT via `creditClawTokens` (:68); `XP_PER_LEVEL=level*100`, `TOKENS_PER_LEVEL_UP=50` |
| **Quests + tutorial ladder** | `apps/api/src/routes/quests.ts` (1430) + `schema/quests.ts` + `schema/tutorial-quest-claims.ts` + `packages/shared/src/constants/{quest-seeds,tutorial-quest-rewards}.ts` | admin review = compare-and-set + atomic credit-in-tx (:432); tutorial claim (:1281-1410) = guest-blocked (:1305) + engagement-gated (`validateTutorialQuestEngagement` :950) + unique-index idempotent (:1369) + 23505 (:1411); unique `(user_id,quest_id)` is the double-claim barrier |
| **Bounties (PAUSED peer-commerce)** | `apps/api/src/routes/bounties.ts` + `schema/bounties.ts` | escrow debit+INSERT atomic (:347); release/refund atomic+idempotent (:554/:1219); marketplace-paused 503 gate (verify before assuming live) |
| **/dash admin metrics** | `apps/api/src/routes/dashboard.ts` (389) + `apps/web/src/app/dash/**` | admin-gated; reads `events` + `claw_token_transactions` only; teacher-chat discriminator (:137-147) excludes character/system-agent/guest; `fingerprintCoverage24h` (:291/:333) |
| **Public leaderboard page** | `apps/web/src/app/leaderboard/**` | window/subject filter chips; consumes `/agents`; NOTE: hard-codes WEIGHTS/HINTS/ScoringLegend (the #1 UI-drift risk) and is missing the land breakdown keys (live drift) |

## Cross-domain seam (not owned — review usage, file changes to owner)

| File | Owner | Why this domain reads it |
|---|---|---|
| `apps/api/src/routes/avatars.ts` (`/me/daily-login` :1067-1124) | auth-identity-session | the daily-login earn mechanic is in this domain's scope but physically lives in their file |
| `apps/api/src/services/agent-collaboration.ts` (:28 import, :114-115 emit) | knowledge-orientation / world-presence | emits `agent.collaboration.turn` (weight 40) via bare `logEvent` → fp_hash NULL (the confirmed OPEN fphash-coverage-gap) |

## Created seed (this is the deliverable)

| File | Role |
|---|---|
| `.claude/agents/leaderboard-progression.md` | the manager+reviewer subagent def (description, PRE-READ trap gate, 13 invariants, OWN/CONSUME/EMITTER-COUPLED/CONSUMED-BY boundaries) |
| `.claude/memory/leaderboard-progression/MEMORY.md` | RLM index: 12 Known-traps (Phase-0 checklist), 13 invariants, the canonical event-weight registry table, git-verified deployment state, severity-tagged open issues, file map, entry list |
| `.claude/memory/leaderboard-progression/*.md` (11 entries) | 5 patterns + 3 gotchas + 2 solutions + 1 economy, all file-anchored, FIXED-vs-OPEN, `[[slug]]`-linked |

## Boundaries (owns vs consumes)
**OWNS:** `routes/{leaderboard,quests,bounties,dashboard}`, `services/{event-logger,xp-service}`, `schema/{events,quests,bounties,tutorial-quest-claims}`, `constants/{quest-seeds,tutorial-quest-rewards}`, `app/{leaderboard,dash}/**`, plus `.claude/agents/leaderboard-progression.md` + `.claude/memory/leaderboard-progression/**`.

**CO-OWNS (shared seam — review usage, move same-diff, but the emit site belongs to the other domain):**
- The scored `event_type` + payload shape with each event's emitter domain. This domain owns the SCORING of an event; the other owns the EMIT site — a name/payload change moves both same-diff:
  - **world-presence** — `building.visited`
  - **knowledge-orientation** — `agent.chat.turn` (teacher chats)
  - **agent-collaboration / world-presence** — `agent.collaboration.turn` (the fp-null OPEN case)
  - **agent-protocol-partner / knowledge-orientation** — `skill_md.fetched` (partner-import carve-out), `identity.issued`, `agent.connected`
  - **activities-arena** — `activity.match.placed` (placement/subjectType/isGuest payload)
  - **land-economy** — `land.*` (weights sourced from `@clawville/shared`)

**CONSUMES (never edit the primitive — file the change to its owner):**
- **token-economy** — every reward binds to `creditClawTokens`/`debitClawTokens` on the resolved `avatar.id`; never write `avatars.clawTokens`. `/dash/economy` reads `claw_token_transactions` (the ledger's audit table, read-only here).
- **auth-identity-session** — the `{user,agent,guest}` resolver, `fingerprintMiddleware` (`fp_hash`/`ip_prefix_hash`), `requireAuth`/`adminOnly`. The board groups by the `agent_id`/`avatar_id` columns the resolver/emitters populate. The daily-login mechanic lives in their `avatars.ts`.
- **knowledge-orientation** — Nori's `town-guide.ts knowledge[]` is the orientation surface that must echo the rubric same-diff (the forcing-function rule).

**CONSUMED-BY:**
- **agent-protocol-partner (PROTECTED SURFACE)** — the Hatcher per-agent stats endpoint reuses `getAgentLeaderboardEntry()` so partner stats == public rank. Any change to scored-event names/weights the partner reads, or to the reuse path, is a protected-surface change → Codex adversarial pass + mock-Hatcher harness.
- **activities-arena** — emits `activity.match.placed`; its payload is the contract the proportional-cap math depends on.
- **The public web** (`/leaderboard`) + **admins** (`/dash`) are the read consumers; `/leaderboard` is also the #1 UI-drift risk (it hard-codes the weights/caps).

## Entries

### Patterns
- [event-weight-registry](event-weight-registry.md) — The canonical contribution-scoring scheme (weights + caps) is single-sourced in leaderboard.ts; the legacy composite board is a separate surface; land weights import from @clawville/shared
- [scoring-cte-dual-leg-lockstep](scoring-cte-dual-leg-lockstep.md) — agent_daily and avatar_daily are disjoint subject tiers that must stay byte-for-byte symmetric; the agent.connected per-day session cap is midnight-safe only because it is a POINT event
- [activity-proportional-cap](activity-proportional-cap.md) — The activity tier-cap scales by LEAST(act_total,cap)/act_total; the denominator must equal the four-bucket numerator universe or honest scores deflate; bots+guests score zero
- [reward-credit-atomic-idempotent](reward-credit-atomic-idempotent.md) — Every CT reward (quest/bounty/tutorial/level-up) goes through the ledger inside the SAME db.transaction as its idempotency anchor; the anchor differs per reward type
- [whitelisted-window-no-sql-injection](whitelisted-window-no-sql-injection.md) — windowToInterval maps a validated enum to a fixed literal before sql.raw; limit clamped 1..100; subject whitelisted — no user input reaches the raw scoring SQL

### Gotchas
- [fphash-coverage-gap](fphash-coverage-gap.md) — A request-path emitter using bare logEvent writes NULL fp_hash and escapes the anti-farm fingerprint tier; agent.collaboration.turn (weight 40) is the confirmed OPEN case
- [event-name-is-a-cross-file-contract](event-name-is-a-cross-file-contract.md) — A scored eventType string lives in the emitter + the scoring CTE + /dash + the tutorial gate; rename/add moves all same-diff or scoring silently drops with no error
- [guest-reward-farm-guard](guest-reward-farm-guard.md) — Fresh-userId-per-guest defeats a (userId,questId) idempotency key; account-bound rewards must 403 guests, and an agent must never be guest-demoted on the score path

### Economy
- [no-farm-is-a-rank](no-farm-is-a-rank.md) — Measurement integrity is the premise: per-(subject,day) caps + the (fp,ip) tag + bot/guest zero-score keep contribution honest; a farm that climbs the board is a product-level defect

### Solutions
- [daily-login-and-xp-idempotency](daily-login-and-xp-idempotency.md) — Daily-login short-circuits on date before credit (date-idempotent, under-pay-on-crash only); awardXp writes XP columns and the token balance in separate statements
- [tutorial-quest-server-gate](tutorial-quest-server-gate.md) — The tutorial ladder is client-tracked but the server owns amounts + idempotency + a per-quest proof-of-engagement gate that counts the same events; guests are 403'd
