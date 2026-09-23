# Independent cleanup review

Last Audited: 2026-09-22. Reviewer: independent_review, team dd-bounty-cleanup-20260922.
Baseline: `10575a98`. Machine: itachi222. Worktree: `cv-dd-audit`.

## CI and deployment controls

The source diff enforces `gates -> migrate -> deploy` in both deployment workflows.
The reusable workflow resolves from the caller commit. Its concurrency group includes the caller workflow name and ref.
A PR or manual Gates run therefore does not share a deploy caller concurrency group.
The migration skip marker cannot bypass Gates. Neither dependent job uses `always()` or `continue-on-error`.

Independent verification used PyYAML BaseLoader to inspect both dependency chains and the reusable concurrency declaration.
Those checks passed. Git Bash syntax checks passed for both deployment helpers.
The helper code rejects missing, abbreviated, branch-name, or extra arguments before Docker.
The only accepted input is a 40-character hexadecimal SHA, inserted into Coolify's named `commit` argument.
The coordinator separately verified that both live Coolify versions accept that argument.
I did not run a live deployment or copy either helper to a server.

An initial local mock-Docker execution harness was rejected by an automatic approval hook.
The reason was: `Managed development launch refused because ownership or input validation failed.`
That inline harness did not execute. The reviewer then saved a standalone harness and ran the same test through a mock Docker function.
Both helpers rejected five invalid argument sets before the mock. Both passed the exact SHA and expected app IDs into the captured PHP argument.
No Docker daemon, SSH, deployment, database, or network operation ran during this test.
Actionlint 1.7.12 independently passed all three changed workflow files with exit code 0.

The first review found stale no-argument helper examples in both workflow comments and DEPLOY-HETZNER.md.
The reviewer corrected workflow headers; the coordinator corrected runbook examples.
Manual SSH/Coolify operations still bypass workflow Gates. Branch protection remains a separate control.
The host marker refuses stale helpers. The coordinator reports both installed helpers match their local SHA256 values.

## Constraint-parity findings

The staging inventory has 944 artifacts. The disposable CI database inventory has 811 artifacts.
Definition normalization removes generated names and public qualification. This leaves 128 staging definitions absent from CI and one CI-only definition.
The missing types are 51 foreign keys, 33 unique indexes, 26 primary keys, 15 CHECKs, two unique constraints, and one partial index.
Most belong to Eliza runtime tables or retired commerce tables outside the current app schema bootstrap.

Three active app gaps are verified:

- Twelve poker CHECKs across four tables are absent. Current Drizzle source declares them, but installed drizzle-kit 0.24.2 generates no CHECK clauses.
- The market_deed_locks listing foreign key exists in generated SQL, then DROP market_listings CASCADE removes it. Migration 0017 does not recreate it.
- The bounty_attempts_one_approved_per_bounty partial unique index exists only in a manual migration. CI neither declares nor replays it.

The land release index uses DESC NULLS LAST in CI and plain DESC on staging. Both indexed columns are NOT NULL.
This difference has no row-order effect under the current schema.
The four-table poker concern was valid. Source-only review initially disputed it; empirical database evidence reversed that conclusion.

Bounded repair: restore missing declared CHECKs and generated FKs only in the disposable CI database after migrations.
Declare the bounty unique index in its owning Drizzle schema. Add a permanent artifact inventory assertion.
Keep explicit accepts for runtime-managed and retired tables. Do not restore removed product tables merely to equalize counts.
Verify the repair with a fresh bootstrap, full migrations, the inventory query, and invalid-row probes.

The read-only query in `2026-09-22-constraint-inventory-readonly.sql` includes CHECK, FK, unique, primary-key, and exclusion constraints.
It also includes unique and partial indexes. It uses `BEGIN READ ONLY` and `ROLLBACK`.
The reconciler authored the bounded repair; the coordinator independently owns its disposable database verification.
No live database mutation ran as part of this review.

## UI cleanup

Reviewed the unconditional ChatPanel mount, guest bootstrap on definitive 401, error presentation, and safe-area geometry changes.
The chat panel remains hidden unless a chat opens. Its ESC recovery now exists before an avatar exists.
Guest bootstrap runs once after a definitive authorization failure. Network errors and server errors do not change identity.
Only successful replies increment the local quest counter. The existing route excludes guest CT and XP rewards.
The initial review found that the system chat route accepted only requireAuth and recorded actorKind human.
The subsequent shared Nori service and bound-agent action address this separate parity defect, as reviewed below.

Independent tests on itachi222: guest Nori chat 8 pass, 0 fail; HUD geometry and registry 96 pass, 0 fail.
The Nori suite now has its own CI process to contain DOM globals and API spies.
The tests exercise opening, closing, retries, failures, and safe-area arithmetic across portrait and landscape device sizes.
They do not provide real-browser screenshot or real-iPad safe-area evidence.

## DoorDash independent review

The first new tip parser accepted seven ambiguous amounts. Examples included `tip 4 euros`, `tip 4,50`, and `tip 1,000`.
The reviewer reproduced all seven failures in a separate no-network test file. The author replaced the parser with a complete confirmation grammar.
Further review rejected arbitrary prefixes that could contain cancellation. Four cancellation cases now join the independent suite.
The independent suite also verifies apartment changes, option quantities, and incomplete identity refusal.
The reviewer also reproduced a fingerprint collision when raw coordinate arrays reversed their order.
The author changed canonicalization to preserve every array order. Object key order remains irrelevant.
The final parser, independent, and quote suites pass 67 tests with zero failures and 803 assertions on itachi222.

After the author released test ownership, the reviewer added six workflow tests.
These cover expiry before repricing, expiry during repricing, agent submission refusal, ambiguous-charge count limits, and tip-inclusive dollar limits.
The workflow suite passes 19 tests with zero failures. Tests use a fake database and vendor boundary; they spend no money.
The existing workflow cases verify equal-price changes, confirmation revocation before failed writes, duplicate submissions, and same-process cart serialization.

The workflow mutex covers one API process. It cannot lock the external DoorDash app or a second environment with another database.
The fingerprint detects changes visible at final repricing; it cannot prevent an external change after that read.
No paid order or live vendor charge ran as part of this review. No claim of a race-free external vendor transaction is justified.

## CI repair verification

The reconciler added CI-only invariant restoration, an explicit 14-artifact catalog assertion, and the bounty approval index declaration.
Database source typecheck and separate script typecheck pass on itachi222. The local guard test passes; its DB case skips without a database URL.
The coordinator independently reports a fresh disposable PostgreSQL replay of 85 migrations, including the two new additive migrations.
The narrowed restore adds exactly 13 constraints; its second run adds zero. The catalog and concurrent approval tests pass 3/0 with 35 assertions.
The first restore added 31 declarations. Eighteen additional CHECKs were absent from staging as well as CI.
The final repair is therefore limited to the 12 verified poker CHECKs and one market foreign key.
The bounty approval index comes from the schema declaration and additive migration 0069.
The production read-only probe found no equivalent bounty approval index and no duplicate approved bounty IDs among 13,652 approved attempts.
Migration 0069 never edits history and fails closed if duplicates appear before deployment.
The database regression test races two real approval updates and requires exactly one success plus one unique violation.
Its fixtures stay in the guarded disposable database and invoke no payout or ledger path.

## Tracked pre-existing schema drift outside this repair

The following 18 declared CHECKs are absent from the observed staging database. Their production state was not checked here.
The first broad CI restore exposed this difference. Applying them automatically could reject existing authentication or game rows.
They remain outside the bounded repair by the coordinator's explicit decision. Review deadline: 2026-09-29.
The owner must compare production definitions, count violating rows read-only, and review a separate additive migration before enforcement.

| Owner | Table and CHECK names | Count |
|---|---|---|
| auth-identity-session / agent-protocol-partner | agent_session_tickets.ticket_ttl; auth_tokens.auth_tokens_purpose_valid; auth_tokens.auth_tokens_ttl; avatars.avatars_harness_valid; users.users_has_auth_method; users.users_username_format | 6 |
| cove-casino | baccarat_shoes.baccarat_shoes_subject_check; blackjack_shoes.blackjack_shoes_subject_check; holdem_tables.holdem_tables_subject_check | 3 |
| land-economy | land_structures.land_structure_level_range; service_listings.service_listings_price_non_negative | 2 |
| activities-arena | lobbies.lobbies_max_players_range; lobbies.lobbies_state_valid; lobbies.lobbies_visibility_valid; lobbies.lobbies_mode_valid; lobbies.lobbies_invite_code_required; lobbies.lobbies_joined_count_range; lobby_events.lobby_events_kind_valid | 7 |

The users schema comments claim database enforcement for authentication method and username format.
Those claims do not match staging catalog evidence. Runtime validation can still exist; this review does not claim an exploit.
The cove subject CHECKs and ticket/auth-token TTL CHECKs also deserve priority because their names encode security or identity invariants.
No live constraint or row changed under this review.

## Nori identity, execution, memory, and privacy review

The new route preserves human cookie precedence and the existing owner-specific room identifier.
Agent requests require a live session, ledger authority, the exact active bound avatar, and a canonical non-guest owner.
The shared service repeats authority checks after cognition and moderation, then before rewards and optional agent memory.
Independent tests change session identity, body identity, guest status, and avatar activity across those awaits.
They also revoke authority inside a successful credit. The original subject retains its event; no new memory reaches a replacement subject.

The first service draft supplied runtime services before the final authority check.
Actual Eliza action execution consumes those services, so reply comments alone did not establish safety.
The revised service supplies read-only avatar and inventory context without executable services for both human and agent callers.
An actual-runtime test refuses a malicious action for both subjects. Its positive control supplies services and executes the action once.
The service strips reply action tags before private feedback and earned memory.
The full isolated API run found a stale building-reward source assertion after extraction.
The revised assertion follows route delegation and retains canonical guest validation before the shared reward limiter.

The first hosted draft published Nori's full reply through injectAgentChat.
That path reaches public world snapshots and streams, while Nori's owner-specific room can contain private conversation context.
The revised action retains the answer only in private agent feedback and memory.
A regression test requires the private marker in the agent's next decision prompt and excludes it from the public snapshot.
The earned-memory identifier now includes the runtime agent ID. Two runtime agents retain distinct memory IDs for identical avatar lessons.

Independent executions: shared service 8/0 with 26 assertions; HTTP contract 14/0 with 56 assertions; hosted action 8/0 with 19 assertions.
Actual-runtime capability test: 1/0 with 3 assertions. Earned-memory identity test: 1/0 with 5 assertions.
CI discovers the new service and route tests automatically, isolates mock.module suites, and runs each runtime suite separately.
The signed partner wire test independently passes 1/0 with 16 assertions.
It verifies the exact outgoing signature, private answer consumption, public-state exclusion, fresh-client isolation, action stripping, and the 2,000-character cap.
The partner-owned root prompt remains unchanged; the answer travels as quoted data in the sole user message and playerMessage field.

The hosted runtime probe preserves any existing fleet halt and keeps its fixture disarmed and killed.
It emits one Nori action, checks fixture-owned earned memory and one chat credit, and requires zero trade decisions.
Cleanup targets only random fixture IDs and their derived private Nori rooms, with postconditions for memory, ledger, events, and subject rows.
The probe stops fixture autonomy and runtime before cleanup. It never clears fleet halts.
Its focused tests independently pass 2/0 with 12 assertions and now run explicitly in CI.

## Additional release controls and visible correction

Every pull request now emits the three stable Gates job names, including documentation-only changes.
This removes the path-filter deadlock before required status checks become active.
The API invariant job now checks TypeScript source after building package dependencies; Bun bundling alone does not check types.
The final independent API typecheck passed with exit code 0. Actionlint and git diff --check also passed.
Both helper comments now state that each invocation queues deployments, without claiming idempotency.

The coordinator reproduced Baccarat Close and Fairness buttons under a pointer-events:none HUD on production.
Their centers hit the canvas. The bounded correction adds pointer-events:auto to the topActions container.
Other seated HUDs did not show the same source defect. The gameplay document records the correction and human/agent effect.
Browser validation of the changed bundle remains a coordinator release check.

## Prior CI plan closure boundary

Phase0c requires catalog parity classification, dynamic mock isolation, a green staging-tip run, required master checks, and a deliberate red scratch-PR proof.
The first two have code and disposable-database evidence. Remote protection and release proofs remain coordinator responsibilities.
The 14-gate coupling registry is an explicit subsequent Task C, but Phase0c's definition of done does not include its implementation.
The full CI protection plan remains incomplete without Phase1 and its later phases.
This audit does not describe those future enforcement mechanisms as delivered.
Status-check-only protection with enforce_admins=false preserves an administrator bypass; it does not universally prohibit direct master pushes.

## Review verdict and remaining release evidence

The reviewed local code has no unresolved blocking finding. The coordinator can proceed to the authorized staging release checks.
The remaining evidence is operational: full same-SHA CI, installed bundle verification, browser checks, signed staging partner harness, and hosted-runtime/onboarding probes.
Master protection requires a read-back plus the deliberate red scratch-PR proof before Phase0c can be reported as enforced.
Real-iPad safe-area appearance still requires device evidence; source arithmetic and emulation do not supply that evidence.
The 18 pre-existing schema checks and later CI-plan phases remain explicitly tracked outside this bounded repair.

PARITY: controls protect the shared human and agent deployment. Nori uses exact bound-avatar real settlement; guests retain demo boundaries.

## Staging Nori probe diagnosis, 2026-09-22

The latest coordinator probe reported one queued Nori request, zero emitted Nori actions, six decision requests, one valid binding, and one active avatar. Rewards and room memories remained zero. This result does not establish a shared-service refusal. An older generic warning cannot identify this fixture.

Source review confirms that the directive route stores the supplied text without model interpretation. The directive formatter preserves the marker. The decision runtime passes the complete prompt to the gateway as one user message. The directive reader returns null after a 1.5-second timeout or a database error; this can omit a directive, but no live result yet identifies it as the cause.

The reviewer removed the speculative product catch diagnostic and its test. Product authorization, protocol version, and action behavior remain unchanged. The probe author added private-content-free counters and exact stored-directive checks to distinguish marker loss from action execution. Promotion still requires a successful Nori lesson and later decision-consumption result.

The coordinator then proved the fixture error with a read-only PostgreSQL query. Raw postgres.js serialized an already-stringified JSON value again. The fixture's config became a JSON string; merging a directive object produced an array. The nested directive lookup therefore returned no value. Drizzle overrides the JSON serializers with identity functions, so the product directive writer did not share this error. The probe author changed raw fixture writes to `tx.json` and added object-shape assertions before commit. The coordinator reported all 99 staging checks passed on `59dba1cf`, including Nori lesson persistence, private next-decision consumption, one chat reward, zero trades, and cleanup.

The investigation also found an independent appearance race in `avatars.ts`. Its stale whole-config replacement could erase a concurrent directive or cursor. The bounded repair merges only appearance-owned model/category keys and omits config for customization-only edits. The new Postgres regression uses two connections and the actual merge helper. Local API typecheck passed. On disposable PostgreSQL 15, the coordinator's legacy-replacement mutation failed because both keys disappeared (one pass, one fail, five assertions). The corrected helper passed both tests and five assertions. Evidence: `cv-dd-appearance-race-red.log` and `cv-dd-appearance-race-green.log` in the coordinator's temporary evidence directory. This verifies the actual database update, not full route E2E. The appearance race was not the probe failure's cause.

The independent release auditor also repaired directive read/replacement races. Four deterministic tests failed before that repair. Unavailable reads now defer cognition and action dispatch; a known missing directive remains valid. Owner-kick revisions preserve newer instructions and reject older model results after replacement. One immediate follow-up remains the upper bound. Author evidence on Bun 1.3.11: 19 focused tests with 110 assertions, plus 39 adjacent driver tests with 250 assertions. The adjacent reviewer checks that diff separately. Protocol, action grammar, authorization, and settlement contracts remain unchanged.

The fresh independent driver review found two further async boundaries: target reads before cognition, and the arrived/teacher model result. The author added revision and enrollment checks at both boundaries. Final independent focused run: 22 tests passed, 119 assertions, on Bun 1.3.11. The 39 adjacent driver tests also passed independently with 250 assertions. The bounded driver diff received an independent approval.

The appearance follow-up exposed a pre-existing E5 defect: no equivalent bound-agent route or action existed. The coordinator authorized shared-service parity before release. `avatar-appearance.ts` now owns the existing validation and writes, with explicit human and agent actors. Human cookies retain precedence and guest cosmetics. Agent requests check the live session, real owner, exact active non-guest avatar, and owned platform agent. Body-supplied identity fields cannot select the target. The transaction pins the avatar and related state, and revalidates the session/body before commit. Captured bot rows receive appearance fields atomically; post-commit projection requires another live-session check and unchanged body/config objects. Local route/service regressions passed 24 tests with 84 assertions, including rollback on revocation and no projection after post-commit revocation. The reviewer separately audits projection and hosted execution. Live acceptance remains a coordinator task on the new release SHA.

The projection reviewer reproduced a concurrent-order risk: an older request could project after a newer committed appearance. The shared service now uses the existing owner/avatar mutex through commit and live projection, with fresh identity and avatar reads after lock acquisition. A no-mutex mutation of the held-request regression failed (one expected avatar write versus two observed). The actual mutex passed; the independent reviewer repeated all 24 tests and 84 assertions on Bun 1.3.11. API typecheck passed after service and executor integration.
