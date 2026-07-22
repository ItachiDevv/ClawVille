# Codex Report — Agentic Wave 2

Date: 2026-07-22  
Branch: `fix/agentic-wave2-2026-07-22`  
Base: `origin/staging` at `ddefe662`

## Commits

- `5d2ff6b3` — `feat(cove): add autonomous slots action`
- `440f8143` — `feat(cove): add autonomous blackjack hands`
- `5fab1a75` — `fix(world): suppress autonomous position uploads`

No push was performed. `master` and `staging` were not modified.

## Implemented surfaces

### P1A — autonomous slots

- Added `play_cove_game(game=slots, wager=<int>)` to the shared Hatcher action menu and executor.
- Reused the existing slots route/engine/ledger settlement through a module-private in-process adapter; no direct avatar balance write or duplicate settle primitive was added.
- Requires a live ledger-capable agent session whose current agent/avatar binding exactly matches the in-world body, and requires the body to be within the existing Cove interaction radius.
- Uses the existing slots min/max/step constants, a 30-second per-avatar action interval, and `AGENT_COVE_PLAY_DAILY_WAGER_VCLAW` (default 1000, hard floor 20).
- Daily usage is exact-avatar, UTC-day, tagged-ledger accounting under a per-avatar advisory lock. Cap admission is authoritative inside the spin transaction. Over-cap mismatched-session requests are refused before close/open mutation.
- Successful play marks the body with a visible Cove-playing activity tag.

### P1B — autonomous blackjack

- Extended `play_cove_game` to `game=blackjack` with the existing 5..500 vCLAW bounds.
- Added a pure six-deck S17, DAS, late-surrender basic-strategy policy. It never takes insurance and sees only the player's cards plus dealer upcard.
- One action generates and settles one complete hand. The one-shot internal path reuses/rotates the agent-owned shoe and runs in one transaction through a settlement tail shared with the REST route.
- Before any card-derived work, the transaction holds the shared daily avatar advisory lock plus the exact active-avatar row lock and admits against the card-independent maximum exposure of 4× wager. It then debits/tags only the engine's exact `totalBet`.
- The transaction preserves shoe cursor/dealt drift assertions, creates no persistent in-progress wedge, routes payout/rake/treasury/event writes through the existing primitives, and uses owner-bound cross-shoe action idempotency.
- Settlement publication and blackjack skill-memory work occur only for a fresh post-commit result, never an idempotent replay.

### P2 — autonomous double-body suppression

- `use-world-stream.ts` now suppresses only the client `/api/world/position` uplink in `autonomous` mode, as it already did for `explore`.
- SSE/downlink lifecycle remains active. `player` (Controlled) and NPC position uploads retain the existing path.

## Protocol and documentation

- `PROTOCOL_VERSION` is `36`.
- Executor, shared action menu, protocol manual, Hatcher integration spec, Nori town-guide knowledge, orientation knowledge, `GameFeatures.md`, `ARCHITECTURE.md`, and the environment documentation were synchronized.
- The protocol manual also documents the existing connected-agent REST surfaces for baccarat, Hold'em, slots, and poker MTT play.
- Agent-facing and user-facing additions use “the Cove”, “card tables”, or “provably-fair games”.

PARITY note: human path: cove UI / REST cove routes; agent path: play_cove_game [ACTION:] + REST cove routes; settlement binds to the agent's bound avatar via resolveAgentSession.

## Files changed

- Canonical/config docs: `ARCHITECTURE.md`, `CLAUDE.md`, `GameFeatures.md`, `docs/hatcher-integration-spec.md`
- Shared/template surfaces: `packages/shared/src/constants/hatcher-actions.ts`, `packages/shared/src/constants/orientation-skill.ts`, `packages/shared/src/constants/slot-paytables.ts`, `packages/agent-templates/src/locations/town-guide.ts`
- API routes/services: `apps/api/src/routes/cove-slots.ts`, `apps/api/src/routes/cove-blackjack.ts`, `apps/api/src/services/autonomous-cove-wager-cap.ts`, `apps/api/src/services/blackjack-basic-strategy.ts`, `apps/api/src/services/blackjack-engine.ts`, `apps/api/src/services/npc-simulation.ts`, `apps/api/src/services/skill-protocol.ts`
- API tests: `apps/api/src/routes/__tests__/cove-slots.test.ts`, `apps/api/src/routes/__tests__/cove-blackjack-autonomous-basic-strategy.test.ts`, `apps/api/src/routes/__tests__/agent-paid-surface.test.ts`, `apps/api/src/services/__tests__/agent-action-covenant.test.ts`, `apps/api/src/services/__tests__/blackjack-basic-strategy.test.ts`, `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts`
- Web: `apps/web/src/hooks/use-world-stream.ts`

## Verification evidence

Final post-commit checks:

- `packages/shared`: `bun run build` — exit 0
- `packages/agent-templates`: `bun run build` — exit 0
- `apps/api`: `bunx tsc --noEmit` — exit 0
- `apps/web`: `bunx tsc --noEmit` — exit 0
- Combined slots, blackjack engine, basic-strategy, autonomous-hand, executor-covenant, and protocol suite — 73 passed, 26 skipped, 0 failed, 5244 assertions
- `git diff --check` — clean before each feature commit
- No `use-world-stream` / world-stream unit or spec file exists in this tree; P2 was verified by web type-check and scoped diff inspection.

Commit-level adversarial review found and corrected these issues before approval:

- slots cap refusal initially occurred after a mismatched-session close/open mutation;
- S17 soft-19 and no-split ace strategy fallbacks;
- bounded hit-loop implicit-stand risk;
- missing autonomous shoe cursor/dealt drift assertion;
- blackjack daily admission needed a card-independent 4× exposure gate to avoid a free-peek retry channel.

## Remaining reviewer gates / unavailable checks

- `DATABASE_URL` was absent. Nineteen slots lifecycle tests and seven blackjack route/transaction tests were therefore skipped (26 total); the no-database engine, policy, covenant, protocol, and preflight tests passed.
- The mock-Hatcher harness and staging adversarial money-path pass were not run in this worktree. They remain the named reviewer gates before promotion.
- The pre-existing untracked `run-codex-wave2.cmd` was left untouched.

## Fix round — money-path audit findings 2, 3, and 4

Date: 2026-07-22

Scope: reviewer-triaged Wave 2 findings only; no push performed.

### Fix A — PostgreSQL-clock UTC-day cap window

- Commit `1092df90` (`fix(cove): use database clock for autonomous daily cap`).
- Removed the Node `Date` UTC-midnight calculation from autonomous Cove usage accounting.
- The shared slots/blackjack usage query now derives its lower bound from PostgreSQL transaction-scoped `now()`, matching ledger `created_at` timestamps.
- Preserved the per-avatar advisory lock, `amount < 0`, and `metadata.autonomousCove=true` filters.
- Verification before commit: API `bunx tsc --noEmit` exit 0; wager-cap unit test 1 passed, 0 failed.

### Fix B — autonomous slots binding pin

- Commit `df4f448c` (`fix(cove): pin autonomous slots avatar binding`).
- Threaded expected agent, owner, and avatar IDs from the executor through `playAutonomousCoveSlots` into the module-private internal `/spin` context.
- Re-resolution mismatch now fails before session lookup, cap reads, close/open, or spin.
- The autonomous spin transaction locks the exact expected avatar row `FOR UPDATE` and requires matching `user_id` plus `is_active=true` before cap/debit or free-spin credit.
- Human, guest-demo, and ordinary REST-agent slots behavior is unchanged.
- Verification before commit: API `bunx tsc --noEmit` exit 0; slots/executor suite 24 passed, 19 DB-infrastructure skips, 0 failed.

### Fix C — owner-scoped autonomous slots idempotency

- Commit title: `fix(cove): make autonomous slots actions owner-idempotent` (the commit containing this fix-round report).
- Added an owner-filtered `slot_spins JOIN slot_sessions` lookup for `auto:<actionId>` before open-session selection and cap preflight.
- A stored same-wager action replays the original session's cached result; a different wager returns 409; another owner's coincident key does not match.
- Closed the concurrent stale-preflight race with an authoritative owner/action advisory lock and cross-session recheck inside the internal autonomous `/spin` transaction before daily cap, avatar, ledger, spin, or event mutations.
- Lock order is session row → owner/action advisory → daily advisory → exact avatar row. No schema, event/outbox, or public route change was added.
- Human/guest slots idempotency remains scoped to `(session_id, idempotency_key)`.

### Final verification

- API `bunx tsc --noEmit`: exit 0 after every fix and after the final combined diff.
- Wager-cap + Cove slots + blackjack route/basic-strategy + executor-covenant suite: 31 passed, 26 DB-infrastructure skips, 0 failed, 3,222 assertions.
- Skips: 19 slots lifecycle cases and 7 blackjack route/transaction cases require unavailable database/wallet infrastructure.
- `git diff --check`: exit 0 before the final commit; only Git CRLF conversion advisories were emitted.
- Independent adversarial re-review approved Fixes A and B. Fix C's first preflight-only design was rejected for a concurrent stale-miss race; the transaction advisory/recheck repair was then re-reviewed and approved.

### Explicitly unchanged

- Finding 1: implicit-house conservation / house-bank escrow.
- Finding 5: integer balance-column width.
- Finding 6: transactional live agent-session row re-lock.
- Finding 7: settlement outbox / exactly-once publication.
- No schema migration, protocol version bump, push, or staging/production mutation was performed.
