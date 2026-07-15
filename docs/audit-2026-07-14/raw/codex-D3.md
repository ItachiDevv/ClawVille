# codex-D3 — BACKEND / API / DB INTEGRITY + PARITY — Forensic Audit
## Summary
The audited backend has several strong foundations: `avatars.user_id` is unique, the platform-agent singleton is DB-enforced, and leaderboard weights, daily caps, `LEAST(count, cap)` scoring, guest exclusion, caching, and endpoint limits match the governing specification (`packages/database/src/schema/avatars.ts:92-98`, `packages/database/src/schema/agents.ts:41-60`, `apps/api/src/routes/leaderboard.ts:326-379`, `apps/api/src/routes/leaderboard.ts:582-630`, `apps/api/src/routes/leaderboard.ts:697-707`, `apps/api/src/routes/leaderboard.ts:1049-1099`).
The worst economic issue is location chat: every successful authenticated message mints 1 vCLAW and 5 XP with no route-local cooldown or idempotency, while connected agents receive only one building reward per day (`apps/api/src/routes/chat.ts:336-353`, `apps/api/src/routes/agent-gateway.ts:2582-2601`).
Canonical balance integrity is also violated by the guest item-purchase path, which directly updates `avatars.claw_tokens` outside the ledger (`apps/api/src/routes/items.ts:120-146`).
The migration system can either destroy production data through `drizzle-kit push --force` or omit required manual migrations that deployed code already assumes exist (`packages/database/package.json:14-20`, `packages/database/scripts/migrate-ci.ts:84-118`, `packages/database/migrations-manual/2026-07-10_add_events_subject_was_guest.sql:10-35`).
Material E5 gaps remain in cosmetic purchases/equipping, avatar customization, location-agent management, research, and profile mutations (`apps/api/src/routes/cosmetics.ts:353-387`, `apps/api/src/routes/avatars.ts:506-552`, `apps/api/src/routes/locations.ts:64-65`, `apps/api/src/routes/research.ts:86-95`, `apps/api/src/routes/users.ts:73-75`).
Leaderboard anti-farm integrity is weakened by caller-forged agent IDs on public skill fetches and placement events emitted without fingerprint or IP-prefix hashes (`apps/api/src/routes/skills.ts:556-560`, `apps/api/src/services/activity/reward-pipeline.ts:552-569`).
Headline count: **6 BLOCKER, 13 HIGH, 3 MEDIUM, 1 LOW**.

## Findings
### [BLOCKER] Production-facing DB commands still run destructive schema push  —  packages/database/package.json:14
- What the code does: Both `migrate` and `push` execute `drizzle-kit push --force` rather than the ordered migration runner (`packages/database/package.json:14-20`).
- Why it's wrong/risky: The repository itself records that this command can translate a rename into dropping and recreating `avatars`, wiping production rows; it also records two prior Eliza-table drops (`scripts/deploy/apply-rename-migration.sh:11-17`, `apps/api/src/services/eliza-migrator.ts:14-22`).
- Failure scenario (concrete inputs -> bad outcome): An operator follows the documented `bun run db:push` workflow against a non-disposable database; Drizzle interprets a rename or drift as destructive DDL and deletes live avatar or Eliza state (`CLAUDE.md:264`, `scripts/deploy/apply-rename-migration.sh:11-17`).
- Fix: Remove or rename these scripts, make destructive push fail closed outside an explicitly marked disposable database, and point `migrate` exclusively to `packages/database/scripts/migrate-ci.ts`.

### [BLOCKER] CI migration discovery omits required manual migrations  —  packages/database/scripts/migrate-ci.ts:84
- What the code does: The CI runner discovers SQL only under `packages/database/migrations`, while required SQL remains under `packages/database/migrations-manual` (`packages/database/scripts/migrate-ci.ts:84-118`, `packages/database/migrations-manual/2026-07-10_add_events_subject_was_guest.sql:10-35`).
- Why it's wrong/risky: Deployed event code writes `subject_was_guest`, and the manual migration explicitly warns that event writes and leaderboard queries fail until that column exists (`apps/api/src/services/event-logger.ts:541-559`, `packages/database/migrations-manual/2026-07-10_add_events_subject_was_guest.sql:10-15`).
- Failure scenario (concrete inputs -> bad outcome): A fresh environment runs every CI-discovered migration and deploys the current API; the first scoring event references the absent column, falls into failed-event handling, and leaderboard SQL can return 500 (`apps/api/src/services/event-logger.ts:560-587`, `packages/database/migrations-manual/2026-07-10_add_events_subject_was_guest.sql:10-15`).
- Fix: Move every deployment-required manual migration into the ordered main migration directory, add a pre-deploy schema-compatibility assertion, and prohibit new deploy-required SQL under `migrations-manual`.

### [BLOCKER] Guest item purchases write the canonical balance outside the ledger  —  apps/api/src/routes/items.ts:120
- What the code does: The guest demo purchase locks an avatar, computes a new balance, and directly updates both `clawTokens` and `softBalance` (`apps/api/src/routes/items.ts:92-146`).
- Why it's wrong/risky: The schema declares ledger-derived balance a hard invariant, but this mutation creates no canonical ledger transaction and bypasses its audit/idempotency controls (`packages/database/src/schema/avatars.ts:124-132`, `packages/database/src/schema/avatars.ts:315-325`).
- Failure scenario (concrete inputs -> bad outcome): A guest purchases a book; the avatar balance changes while `claw_token_transactions` has no corresponding transfer, so balance replay, economic auditing, and any later guest-to-account reconciliation disagree (`apps/api/src/routes/items.ts:120-146`).
- Fix: Keep demo funds in a separate non-canonical session or demo-wallet store, or represent the move through a ledger-supported demo subject; never update `avatars.clawTokens` directly.

### [BLOCKER] Location chat is an uncapped vCLAW faucet and disadvantages agents  —  apps/api/src/routes/chat.ts:336
- What the code does: Every successful non-guest location-chat response credits 1 vCLAW and 5 XP unconditionally (`apps/api/src/routes/chat.ts:336-353`).
- Why it's wrong/risky: There is no route-local cooldown, daily cap, or idempotency key, whereas system chat has a 60-second per-user/per-character limiter and connected-agent building rewards are once per building per day (`apps/api/src/routes/chat.ts:127-145`, `apps/api/src/routes/agent-gateway.ts:2582-2601`).
- Failure scenario (concrete inputs -> bad outcome): An authenticated human repeatedly submits minimal valid messages; each completed response mints another vCLAW and XP, while an agent performing equivalent building chat stops earning after its daily award (`apps/api/src/routes/chat.ts:179-183`, `apps/api/src/routes/chat.ts:336-353`).
- Fix: Route both humans and agents through one durable reward policy keyed by subject, building, and day; enforce the same cap transactionally and give the ledger mint an idempotency source key.

### [BLOCKER] vCLAW cosmetic purchases exclude connected agents  —  apps/api/src/routes/cosmetics.ts:386
- What the code does: The vCLAW purchase endpoint requires Lucia authentication and a non-guest user, then debits the buyer through the real ledger and grants the skin (`apps/api/src/routes/cosmetics.ts:386-387`, `apps/api/src/routes/cosmetics.ts:426-501`).
- Why it's wrong/risky: A connected/hosted agent cannot purchase the same economy item as its bound avatar, and the ledger actor is hardcoded as human (`apps/api/src/routes/cosmetics.ts:450-463`).
- Failure scenario (concrete inputs -> bad outcome): A bound agent has sufficient real vCLAW and calls the purchase path with its live agent session; middleware rejects it because no human user session exists, while a human with the same avatar balance succeeds (`apps/api/src/routes/cosmetics.ts:386-410`).
- Fix: Resolve a human or live agent principal into one bound-avatar subject, debit that subject through the same ledger transaction, and record the correct actor kind.

### [BLOCKER] Activity rewards lack durable result and ledger idempotency  —  apps/api/src/services/activity/reward-pipeline.ts:454
- What the code does: Reward issuance inserts an activity result and then credits vCLAW, with no conflict guard or stable ledger idempotency key (`apps/api/src/services/activity/reward-pipeline.ts:454-504`).
- Why it's wrong/risky: `activity_results` has no unique constraint on `(room_id, avatar_id)`, so nothing prevents a repeated settlement from inserting and minting again (`packages/database/src/schema/activity-results.ts:36-105`).
- Failure scenario (concrete inputs -> bad outcome): A completed room is retried after a crash, recovery action, or duplicate terminal transition; the same participant receives a second result row and a second vCLAW credit (`apps/api/src/services/activity/activity-room-manager.ts:945-982`, `apps/api/src/services/activity/reward-pipeline.ts:454-504`).
- Fix: Add a unique `(room_id, avatar_id)` constraint, insert the result as the settlement claim, and use the same stable room/participant reference as a unique ledger idempotency key.

### [HIGH] Research SSE globally discloses private artifacts and accepts unbound session IDs  —  apps/api/src/routes/research-sse.ts:8
- What the code does: The unauthenticated SSE endpoint registers every listener in a global set and broadcasts every research event to all clients (`apps/api/src/routes/research-sse.ts:8-29`, `apps/api/src/routes/research-sse.ts:36-75`).
- Why it's wrong/risky: Events contain session ID, avatar ID, synthesized knowledge, and the full generated `skillMd`; the trigger also accepts client-supplied session and Claw session IDs without ownership binding (`packages/shared/src/types/research.ts:16-29`, `apps/api/src/routes/research.ts:18-22`, `apps/api/src/routes/research.ts:48-77`).
- Failure scenario (concrete inputs -> bad outcome): An unauthenticated observer opens the stream while another user finishes research and receives that user’s complete generated artifact and identifiers; an attacker who knows a Claw session ID can also trigger knowledge mutation under an arbitrary event channel (`apps/api/src/services/research-service.ts:184-189`, `apps/api/src/routes/research.ts:48-77`).
- Fix: Authenticate the stream, derive its subject and channel server-side, filter events per authorized principal, and require ownership of every referenced avatar or agent session.

### [HIGH] Any authenticated user can launch global scraping and seeding jobs  —  apps/api/src/routes/research.ts:160
- What the code does: `/scrape` and `/seed` require only ordinary authentication and start asynchronous global refresh work (`apps/api/src/routes/research.ts:160-186`).
- Why it's wrong/risky: Neither endpoint has an admin gate, route-specific limiter, or job-level idempotency guard; the trigger limiter applies only to the separate research-trigger path (`apps/api/src/routes/research.ts:29-38`, `apps/api/src/routes/research.ts:160-186`).
- Failure scenario (concrete inputs -> bad outcome): A normal account loops `/seed` and `/scrape`, repeatedly starting outbound scraping and database refresh work, increasing provider cost and racing content updates (`apps/api/src/routes/research.ts:160-186`).
- Fix: Restrict both routes to administrators or an authenticated internal scheduler, validate location against a fixed enum, and use rate-limited, deduplicated background jobs.

### [HIGH] Public skill fetches can forge scored agent identities  —  apps/api/src/routes/skills.ts:556
- What the code does: A public play-skill route logs `agentId` and `sessionId` directly from caller-controlled headers (`apps/api/src/routes/skills.ts:556-560`, `apps/api/src/routes/skills.ts:590-593`).
- Why it's wrong/risky: The event logger preserves the supplied agent ID without validating a live agent principal, and leaderboard SQL treats any non-null `agent_id` as an agent subject (`apps/api/src/services/event-logger.ts:531-551`, `apps/api/src/routes/leaderboard.ts:582-709`).
- Failure scenario (concrete inputs -> bad outcome): An unauthenticated caller fetches the public skill with `X-Clawville-Agent-Id: victim`; scored `skill_md.fetched` events are attributed to the victim, or rotating invented IDs creates phantom leaderboard subjects (`apps/api/src/routes/skills.ts:556-560`).
- Fix: Derive scored agent identity only from a validated live session or partner principal; store untrusted claimed metadata separately and leave anonymous public fetches unscored.

### [HIGH] Activity placement events omit mandatory anti-farm fingerprints  —  apps/api/src/services/activity/reward-pipeline.ts:552
- What the code does: The reward pipeline emits `activity.match.placed` without `fpHash` or `ipPrefixHash` (`apps/api/src/services/activity/reward-pipeline.ts:552-569`).
- Why it's wrong/risky: The logger stores absent hashes as null, while leaderboard SQL scores these placement events without requiring the anti-farm fields (`apps/api/src/services/event-logger.ts:541-551`, `apps/api/src/routes/leaderboard.ts:600-630`, `apps/api/src/routes/leaderboard.ts:727-754`).
- Failure scenario (concrete inputs -> bad outcome): Multiple accounts or agents operated from one browser/IP farm their ten daily activity placements each; the leaderboard cannot correlate or enforce the required fingerprint/IP-prefix anti-farm policy (`apps/api/src/routes/leaderboard.ts:372-379`).
- Fix: Capture trusted fingerprint and IP-prefix hashes at enqueue/session entry, carry them through room settlement, and exclude untagged user-controlled placement events from scoring.

### [HIGH] Party enqueue is partial and misattributes non-leader identities  —  apps/api/src/routes/activities.ts:301
- What the code does: Party members are enqueued sequentially; non-leaders receive null user/agent IDs and inherit the leader’s `subjectType` because their identities are not resolved (`apps/api/src/routes/activities.ts:301-321`).
- Why it's wrong/risky: The route promises atomic party entry, but an error after one insert does not roll back earlier entries, and mixed human/agent parties lose durable subject attribution (`apps/api/src/routes/activities.ts:103-105`, `packages/database/src/schema/activity-queue-entries.ts:21-23`).
- Failure scenario (concrete inputs -> bad outcome): The leader is queued successfully and the second member hits duplicate/capacity validation; the party is left partially queued. In a human-led party containing an agent, the agent is recorded as human with `agentId=null`, corrupting later reward/event attribution (`apps/api/src/routes/activities.ts:301-321`, `apps/api/src/services/activity/reward-pipeline.ts:457-489`).
- Fix: Resolve each member’s durable principal independently, prevalidate the entire party, and commit all queue entries atomically with rollback on any failure.

### [HIGH] Limited cosmetic supply is declared but never enforced  —  apps/api/src/routes/cosmetics.ts:206
- What the code does: The route explicitly defers the full supply-cap check; purchase eligibility checks identity, availability, and currency only (`apps/api/src/routes/cosmetics.ts:78-95`, `apps/api/src/routes/cosmetics.ts:206-208`).
- Why it's wrong/risky: The schema describes `supplyCap` as a hard maximum, but purchases grant ownership without counting sold units or locking supply (`packages/database/src/schema/cosmetics.ts:93-97`, `apps/api/src/routes/cosmetics.ts:492-500`).
- Failure scenario (concrete inputs -> bad outcome): A SKU with `supply_cap=100` receives 101 sequential purchases—or concurrent purchases at the boundary—and every buyer receives the supposedly limited skin (`apps/api/src/routes/cosmetics.ts:392-410`, `apps/api/src/routes/cosmetics.ts:492-500`).
- Fix: Enforce supply under the purchase transaction with a locked inventory counter or equivalent atomic conditional update, and mark sold-out SKUs unavailable to catalog and purchase queries.

### [HIGH] Cosmetic equip state is human-session only  —  apps/api/src/routes/cosmetics.ts:353
- What the code does: Cosmetic equip and unequip mutations require a human auth session and resolve ownership through that user (`apps/api/src/routes/cosmetics.ts:353-360`).
- Why it's wrong/risky: A connected agent can own or represent an avatar but cannot alter the same visible cosmetic state as itself; even the owned-cosmetic read path is cookie-authenticated (`apps/api/src/routes/cosmetics.ts:240-242`).
- Failure scenario (concrete inputs -> bad outcome): An agent-bound avatar owns a skin and supplies a valid agent session, but the equip endpoint rejects it while the human controller succeeds (`apps/api/src/routes/cosmetics.ts:353-360`).
- Fix: Resolve human and connected-agent sessions to the same avatar ownership model for reads, equip, and unequip.

### [HIGH] Avatar profile and appearance mutations are cookie-only  —  apps/api/src/routes/avatars.ts:506
- What the code does: Avatar patching, appearance updates, and daily-login state use human authentication rather than a human-or-agent subject resolver (`apps/api/src/routes/avatars.ts:506-552`, `apps/api/src/routes/avatars.ts:908-923`, `apps/api/src/routes/avatars.ts:1557-1611`).
- Why it's wrong/risky: These are persistent user-facing avatar mutations, but a connected/hosted agent cannot operate them as its bound avatar (`apps/api/src/routes/avatars.ts:506-552`, `apps/api/src/routes/avatars.ts:908-923`).
- Failure scenario (concrete inputs -> bad outcome): A hosted agent attempts to change its bound avatar’s allowed appearance with a valid live session; it receives an auth failure, while a logged-in human can mutate the same row (`apps/api/src/routes/avatars.ts:908-923`).
- Fix: Introduce a shared avatar-subject resolver, enforce per-field capabilities for humans and agents, and test both principals against the same state transition.

### [HIGH] Location-agent management is human-only and not transactionally unique  —  apps/api/src/routes/locations.ts:64
- What the code does: Create/delete require human auth; creation performs a read-then-insert across platform-agent and location-agent rows without a transaction, while deletion removes them in separate operations (`apps/api/src/routes/locations.ts:64-65`, `apps/api/src/routes/locations.ts:83-123`, `apps/api/src/routes/locations.ts:129-149`).
- Why it's wrong/risky: Connected agents cannot manage equivalent location state, and the schema has no unique `(user_id, location_id)` constraint to close concurrent creation races (`packages/database/src/schema/location-agents.ts:23-36`).
- Failure scenario (concrete inputs -> bad outcome): Two concurrent creates both observe no row and insert duplicate agents; a failure after the first insert leaves an orphan. A connected agent cannot perform either operation at all (`apps/api/src/routes/locations.ts:83-149`).
- Fix: Support an explicit human-or-agent subject model, add the assumed unique constraint, and perform create/delete atomically with FK/cascade semantics.

### [HIGH] Research learning has no connected-agent first-class path  —  apps/api/src/routes/research.ts:86
- What the code does: Avatar research resolves only a Lucia user, while the alternate branch accepts a browser Claw session rather than a validated connected/hosted agent principal (`apps/api/src/routes/research.ts:48-95`).
- Why it's wrong/risky: Research mutates synthesized knowledge and emits a persistent skill artifact, but the connected agent cannot invoke it through its bound identity (`apps/api/src/routes/research.ts:60-77`, `apps/api/src/services/research-service.ts:184-189`).
- Failure scenario (concrete inputs -> bad outcome): A hosted agent with a bound avatar requests the same research action available to a human; it has neither a human session nor the client-supplied browser Claw session shape and is rejected or forced through an unbound path (`apps/api/src/routes/research.ts:48-95`).
- Fix: Authenticate live agent sessions, derive their bound avatar and research state server-side, and apply the same persistence and scoring semantics as the human path.

### [HIGH] Username uniqueness is race-prone and only case-sensitive in the DB  —  apps/api/src/routes/users.ts:99
- What the code does: The route checks `lower(username)` before updating, but the DB has only a normal case-sensitive unique constraint (`apps/api/src/routes/users.ts:99-116`, `packages/database/src/schema/users.ts:35-50`).
- Why it's wrong/risky: Application prechecks do not serialize concurrent claims and cannot enforce the documented case-insensitive identity invariant; the mutation also requires only a human session (`apps/api/src/routes/users.ts:73-75`).
- Failure scenario (concrete inputs -> bad outcome): Two users concurrently claim `Foo` and `foo`; both prechecks see no match and the database accepts both distinct strings (`apps/api/src/routes/users.ts:99-116`, `packages/database/src/schema/users.ts:35-50`).
- Fix: Add a unique index on `lower(username)` or use `CITEXT`, handle unique violations deterministically, and define the corresponding bound-agent profile capability.

### [HIGH] Rotating the dashboard password does not revoke dashboard cookies  —  apps/api/src/middleware/admin-only.ts:48
- What the code does: Dashboard cookies remain valid for 30 days and are an HMAC of the constant string `dash-access` using `FINGERPRINT_SECRET`; `DASH_SHARED_PASSWORD` is used only at login (`apps/api/src/routes/dash-auth.ts:10-18`, `apps/api/src/routes/dash-auth.ts:77-104`, `apps/api/src/middleware/admin-only.ts:48-57`).
- Why it's wrong/risky: The middleware comment says password rotation invalidates cookies, but validation has no dependency on the password or a revocation version (`apps/api/src/middleware/admin-only.ts:22-27`, `apps/api/src/middleware/admin-only.ts:75-94`).
- Failure scenario (concrete inputs -> bad outcome): An employee’s dashboard access is revoked by rotating `DASH_SHARED_PASSWORD`; their previously captured cookie continues authorizing every `adminOnly` route until expiry (`apps/api/src/middleware/admin-only.ts:75-94`).
- Fix: Bind the signed cookie to a rotatable session/version or password-derived revision, and support immediate server-side revocation.

### [HIGH] Most routes have no application-level body-size limit  —  apps/api/src/index.ts:376
- What the code does: Body limiting is installed for selected partner routes, not globally; ordinary routes call `req.json()` directly (`apps/api/src/index.ts:376-392`, `apps/api/src/routes/avatars.ts:169-185`, `apps/api/src/routes/chat.ts:51-55`).
- Why it's wrong/risky: Large request bodies can be buffered before route-level validation or rate limiting, and malformed JSON becomes an unexpected error handled as HTTP 500 rather than a consistent 400 (`apps/api/src/index.ts:510-540`, `apps/api/src/routes/items.ts:69-73`, `apps/api/src/routes/locations.ts:64-68`).
- Failure scenario (concrete inputs -> bad outcome): An unauthenticated client sends a very large JSON body to avatar creation; the API buffers/parses it before the route limiter runs. Repeated malformed bodies also generate 500 responses and operational alerts (`apps/api/src/routes/avatars.ts:169-185`, `apps/api/src/index.ts:510-540`).
- Fix: Apply a conservative global body limit before route registration, use narrower limits for expensive endpoints, and centralize JSON parsing so syntax and schema errors return bounded 400 responses.

### [MEDIUM] Reading an inventory item is not atomic with consuming it  —  apps/api/src/routes/items.ts:318
- What the code does: The route reads inventory, updates avatar or runtime knowledge, and only afterward decrements or deletes the inventory item (`apps/api/src/routes/items.ts:318-425`).
- Why it's wrong/risky: There is no transaction or row lock, and the inventory schema has neither a positive-quantity check nor an ownership/item uniqueness constraint (`packages/database/src/schema/inventory.ts:10-18`).
- Failure scenario (concrete inputs -> bad outcome): Two concurrent reads of a single-quantity book both pass the initial check, both apply knowledge and emit `book.read`, and then race the consumption update; a mid-handler failure can also apply knowledge without consuming the book (`apps/api/src/routes/items.ts:318-444`).
- Fix: Lock and atomically decrement the inventory row inside one transaction, make knowledge application idempotent, and add DB constraints for positive quantity and the intended stack uniqueness.

### [MEDIUM] Activity tables do not enforce lifecycle and identity assumptions  —  packages/database/src/schema/activity-queue-entries.ts:29
- What the code does: Queue entries, room participants, rooms, and results store free-form subject/status fields and numeric state without corresponding checks or active-entry uniqueness (`packages/database/src/schema/activity-queue-entries.ts:29-58`, `packages/database/src/schema/activity-room-participants.ts:31-50`, `packages/database/src/schema/activity-rooms.ts:30-56`, `packages/database/src/schema/activity-results.ts:36-105`).
- Why it's wrong/risky: Application code assumes valid subject types, one active queue membership, valid room statuses, and one participant result, but the database does not preserve those invariants under races or alternate writers (`apps/api/src/routes/activities.ts:301-321`, `apps/api/src/services/activity/reward-pipeline.ts:454-504`).
- Failure scenario (concrete inputs -> bad outcome): Concurrent requests create multiple active queue rows for one avatar, or a malformed internal write stores an unsupported subject/status value; matching and settlement then process inconsistent identity or lifecycle state (`packages/database/src/schema/activity-queue-entries.ts:29-58`).
- Fix: Add enum/check constraints, partial unique indexes for active membership, foreign keys where ownership is durable, nonnegative/range checks, and unique room-participant/result keys.

### [MEDIUM] Public event reads perform settlement writes  —  apps/api/src/routes/special-events.ts:241
- What the code does: The public `GET /:slug` route invokes event settlement when an event is live or completed, and settlement updates persistent event status (`apps/api/src/routes/special-events.ts:241-253`, `apps/api/src/services/special-event-manager.ts:753-814`).
- Why it's wrong/risky: A cacheable/read-oriented unauthenticated request acquires locks and mutates global state, making crawler traffic and status polling part of the event state machine (`apps/api/src/routes/special-events.ts:241-253`).
- Failure scenario (concrete inputs -> bad outcome): A crawler requests an event as its close time passes; that GET performs the completion transition and competes with normal settlement workers, increasing lock contention and making retries dependent on read traffic (`apps/api/src/services/special-event-manager.ts:760-814`).
- Fix: Keep GET pure and move settlement to a scheduled worker or authenticated idempotent command endpoint.

### [LOW] The cosmetic API exposes prohibited “CLV” naming  —  apps/api/src/routes/cosmetics.ts:404
- What the code does: The stored currency enum uses `CLV`, and the purchase error returns “This item must be purchased with CLV” to clients (`packages/database/src/schema/cosmetics.ts:72-78`, `apps/api/src/routes/cosmetics.ts:404-407`).
- Why it's wrong/risky: That is user-visible legacy naming rather than the required `$CLAWVILLE` label (`apps/api/src/routes/cosmetics.ts:404-407`).
- Failure scenario (concrete inputs -> bad outcome): A user attempts the wrong purchase rail and the UI displays the API message containing “CLV,” producing inconsistent token branding (`apps/api/src/routes/cosmetics.ts:404-407`).
- Fix: Keep any internal enum behind a presentation mapping and return `$CLAWVILLE` in all client-facing copy.

## Governing invariants
- WHEN any code changes a vCLAW balance, the change MUST call the canonical ledger or earned-mint chokepoint and MUST NOT directly update `avatars.clawTokens` (`apps/api/src/routes/items.ts:120-146`, `packages/database/src/schema/avatars.ts:315-325`).
- WHEN a reward can be retried, the change MUST claim a unique domain key and pass a stable idempotency key into the ledger before minting (`apps/api/src/services/activity/reward-pipeline.ts:454-504`, `packages/database/src/schema/activity-results.ts:36-105`).
- WHEN a user-facing economy or persistent-state route is added or changed, the change MUST resolve both human and connected-agent principals to their bound avatar and test identical outcomes for both (`apps/api/src/routes/cosmetics.ts:353-387`, `apps/api/src/routes/avatars.ts:506-552`).
- WHEN equivalent human and agent actions earn rewards, the change MUST apply the same durable cooldown, cap, amount, and leaderboard semantics to both (`apps/api/src/routes/chat.ts:336-353`, `apps/api/src/routes/agent-gateway.ts:2582-2601`).
- WHEN a leaderboard event names a user or agent, the change MUST derive that subject from authenticated server state rather than caller-supplied headers (`apps/api/src/routes/skills.ts:556-560`, `apps/api/src/services/event-logger.ts:531-551`).
- WHEN a user-controlled event is scoreable, the change MUST persist trusted salted fingerprint and IP-prefix hashes, preserve guest status, and apply daily caps with `LEAST(count, cap)` (`apps/api/src/services/activity/reward-pipeline.ts:552-569`, `apps/api/src/routes/leaderboard.ts:582-630`).
- WHEN a party enters a queue or room, the change MUST resolve every member independently and commit all membership rows atomically or none at all (`apps/api/src/routes/activities.ts:301-321`).
- WHEN an item has a supply cap, the purchase transaction MUST atomically reserve supply before charging or granting ownership (`packages/database/src/schema/cosmetics.ts:93-97`, `apps/api/src/routes/cosmetics.ts:492-500`).
- WHEN application correctness assumes case-folded identity uniqueness, one active row, positive quantity, a valid enum, or one result per participant, the change MUST encode that assumption as a DB `UNIQUE`, partial index, `CHECK`, or FK constraint (`packages/database/src/schema/users.ts:35-50`, `packages/database/src/schema/activity-results.ts:36-105`).
- WHEN a mutation spans multiple rows or external/runtime state, the change MUST use a transaction plus an idempotent outbox/reconciliation boundary so partial failure cannot consume, grant, or publish only half the operation (`apps/api/src/routes/items.ts:318-444`, `apps/api/src/routes/locations.ts:83-149`).
- WHEN schema changes are required for deployed code, the SQL MUST live in the directory consumed by the CI migration runner and deploy MUST fail before application rollout if compatibility is absent (`packages/database/scripts/migrate-ci.ts:84-118`, `packages/database/migrations-manual/2026-07-10_add_events_subject_was_guest.sql:10-35`).
- WHEN a database command can target a persistent environment, it MUST use ordered migrations and MUST refuse destructive schema push unless the target is explicitly disposable (`packages/database/package.json:14-20`, `scripts/deploy/apply-rename-migration.sh:11-17`).
- WHEN an endpoint accepts JSON, the change MUST impose a body-size limit before buffering, validate body/query/params with a schema, and map malformed input to a stable 4xx `ApiError` (`apps/api/src/index.ts:376-392`, `apps/api/src/index.ts:510-540`).
- WHEN an administrative credential is rotated, every session derived from the previous credential MUST become invalid immediately (`apps/api/src/routes/dash-auth.ts:77-104`, `apps/api/src/middleware/admin-only.ts:48-57`).
- WHEN an SSE or streaming response contains subject-specific data, the change MUST authenticate the subscriber and filter events using server-derived ownership rather than client-provided channel IDs (`apps/api/src/routes/research-sse.ts:36-75`, `packages/shared/src/types/research.ts:16-29`).
- WHEN an HTTP GET is public or cacheable, it MUST remain free of persistent state transitions; settlement belongs in an explicit idempotent command or worker (`apps/api/src/routes/special-events.ts:241-253`).

## Doc drift
- `GameFeatures.md` says guest item purchase is rejected and the demo genesis balance is inert, but the live route permits guest demo purchases, writes canonical avatar balance directly, and persists inventory (`GameFeatures.md:23`, `apps/api/src/routes/items.ts:92-195`).
- `CLAUDE.md` says production schema changes flow through the CI migration gate, but a required July migration is outside the runner’s discovery directory and the repository still documents and exposes `db:push --force` (`CLAUDE.md:129`, `CLAUDE.md:264`, `packages/database/scripts/migrate-ci.ts:84-118`, `packages/database/package.json:14-20`).
- `CLAUDE.md` requires first-class human/agent parity, but cosmetic, avatar, location-agent, research, and profile mutations remain cookie-only (`CLAUDE.md:34-38`, `apps/api/src/routes/cosmetics.ts:353-387`, `apps/api/src/routes/avatars.ts:506-552`, `apps/api/src/routes/locations.ts:64-65`, `apps/api/src/routes/research.ts:86-95`, `apps/api/src/routes/users.ts:73-75`).
- `CLAUDE.md` requires scoreable events to carry salted fingerprint and IP-prefix hashes, but activity placement events emit neither (`CLAUDE.md:82`, `apps/api/src/services/activity/reward-pipeline.ts:552-569`).
- `GameFeatures.md` describes aligned player-facing economic caps, while human location chat mints on every successful request and connected-agent building rewards are once daily (`GameFeatures.md:32`, `apps/api/src/routes/chat.ts:336-353`, `apps/api/src/routes/agent-gateway.ts:2582-2601`).
- `ARCHITECTURE.md` describes scored skill fetching as an organic action by a live connected agent, but the public route attributes events using an unvalidated caller-supplied agent header (`ARCHITECTURE.md:408`, `apps/api/src/routes/skills.ts:556-560`).
- `CLAUDE.md` still uses legacy “CT” and “CLV” terminology for cosmetic pricing, conflicting with the shared naming rule and reinforcing the live API’s “CLV” response (`CLAUDE.md:86`, `apps/api/src/routes/cosmetics.ts:404-407`).
- No D3-relevant mismatch was identified in `3dStructure.md`; render and asset-cache invariants were outside this backend audit.

## Coverage note
This was a static, read-only audit of the requested Hono route layer, database schemas, leaderboard SQL, event logging, research streaming, activity settlement, and cross-cutting middleware on the checkout matching `origin/master`.

D1/D2-owned game, wallet, wager, marketplace-money, and partner-signing implementations were not fully re-audited except where D3 routes depended on their identity, ledger, or event interfaces. The live database was not queried, so whether operators manually applied every file under `migrations-manual` is **UNVERIFIED**; the reproducibility defect for fresh environments is verified from the runner and SQL layout. No mutation-capable integration tests, live endpoint calls, race harnesses, frontend Next.js async API checks, or render/GPU checks were performed.