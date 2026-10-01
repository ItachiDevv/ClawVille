# Trading Floor Arena (paper contest) — build spec + decision log

Last Audited: 2026-10-01 (session tradeDeskMain, arena follow-ups T3 on branch `fix/arena-followups`: D33 checkpoint schedule (tests only at 20/40/80/160/200/400/800 closed trades on the current params, each once, alpha 0.01/0.005/0.0025, 0.05 per rule set; reasons `waiting_checkpoint`, `budget_spent`) in D10, D27, D33 and §6a; status log corrects the `10cd060d` "4.0%" claim (per look, not per rule set); §6a redaction drift (model text redacted, the reason is code text); P8 no-rename record). Prior Last Audited: 2026-10-01 (session tradeDeskMain, arena follow-ups A3 on branch `fix/arena-followups`: new decision D33 (honest tuner: code searches one-filter tightenings, a change needs D27 AND a shuffle test p <= 0.05, the model reply is commentary only, every report states why); line 7, D10, D27 and §6a no longer claim "fine-tuned about every 30 minutes"; D30/D31 deployed on staging in `5049971e`, verified 2026-10-01; D32 Codex r23-money APPROVE, deployed on staging, live add-on call owed; D6 score wording; §8 P8 FIXED on the branch, P6 three notes; status log 2026-10-01 verify entry). Prior Last Audited: 2026-10-01 (session coolerTrading: P9 RESOLVED (post-reveal stall fixed, lane C), new rows P10 (late WebGL avatar first-draw compile) and P11 (from-/game WebGL curtain freeze)). Prior Last Audited: 2026-10-01 (session coolerTrading: §8 rows P8 (number-shaped agent names on the leaderboard) and P9 (post-reveal stall) added; the shared tape path now strips `$` from symbols and trader names and validates the symbol AFTER the action-length cut and drops it unless it keeps a letter, has no decimal number and no run of 5+ digits, `trading-floor-trade-tape.ts`, so the board tape row, the 3D chips and the interior ticker can never print a figure the route did not send). Prior Last Audited: 2026-09-30 (session tradeDeskMain, lead; D6 prize-eligibility text synced with `FLOOR_ARENA_CONTEST` rule 6 by arena-docs; §1 decision rows D13-D29 added with amendment pointers on D2-D10 and D26; D28 fresh chain verdicts on tradeable coins; D29 every user-agent report stored as an earned-skill lesson and recalled in owner avatar chat; punch list P4; 2026-10-01: D30/D31 rows synced to the code, P3 B1 events, P5, D6 rule-6 wording; D30/D31/rule 6 marked BUILT, not deployed, after Codex r22 APPROVE, r19-r22 chain in §7; single ClawPump writer, Codex r19 money, in §5/§6/D8; D32 x402 removal = hygiene, design v8b in §6). Status: IN BUILD on branch `feat/trading-floor-arena`
(worktree `.worktrees/trading-floor-arena`, base `origin/staging` a2a073a7).

Founder goal (2026-09-30, verbatim summary): five house trading agents on the Trading Floor, each running its own
strategy in PAPER mode with public results, reviewed about every 30 minutes (the founder said "fine-tuned"; a param
changes only when the evidence check passes, D27 + D33, so most reviews change nothing), ranked on a P&L leaderboard
on the floor TV. Any ClawVille player walks into the Trading Floor, watches the house agents, and launches their own trading
agent from one of five templates (one per house agent), edits the template's rules in a form, and starts it. Every
agent reads ONE shared free discovery feed; a player may add paid x402 discovery feeds that they fund themselves.
Launching creates a ClawPump agent under ClawVille's ClawPump account that serves only that player's agent. The agent
trades only while it sits at a Trading Floor desk. The player sees the live decision stream, open positions, trade
history and a 30-minute analysis. Paper only for now; announced as a one-week contest with $CLAWVILLE prizes
(1st 1,000,000 · 2nd 500,000 · 3rd 250,000).

This file is the canonical design for the arena until its content moves into GameFeatures.md / ARCHITECTURE.md
(same PR). Every build agent follows the CONTRACT below exactly; a contract change goes through the lead.

## 0. What exists (origin/staging a2a073a7) and what we keep

- The Floor board, tape, P&L and `/api/leaderboard/agents` read ONLY `verified_trades` (on-chain swaps of bound
  wallets, `trade-observer.ts`). Paper trades never reach it. We KEEP all of that untouched (live path).
- `clawpump-client.ts` is read-only (GET /agents, GET /agents/:id) with a host allowlist and env `CLAWPUMP_API_KEY`.
  We ADD write methods in a new module (see §5) and keep the allowlist.
- `TRADING_AGENT_TEMPLATES` (persona templates for live ClawPump agents, self-serve disabled) stay for the live path.
  The arena adds NEW param templates (`FLOOR_ARENA_TEMPLATES`); the "Start a ClawPump trader" panel is replaced in the
  UI by the arena launch flow.
- Python paper agents on the staging box (Genesis-paper wide-4, C1) keep running as research. They are NOT the house
  agents of the arena; the arena engine runs its own five house agents so the board, contest and user agents share one
  engine, one pricing model and one ledger.

## 1. Decisions (lead, founder asleep, "make the best decision"; each is reversible)

| # | Decision | Reason |
|---|---|---|
| D1 | The arena engine runs inside the ClawVille API (TypeScript), leader-locked with a Postgres advisory lock. | One engine for house + user agents; data lands in Postgres for board, leaderboard, contest, agent parity. |
| D2 | Shared discovery = table `floor_discovery_mints` filled by one poller per source (each source called once per interval, all agents read the table). Free sources: DexScreener token-profiles/latest, token-boosts/latest + top, ClawPump (Bitget) `/intelligence/signals` + `/signals/anomalies`, GeckoTerminal `new_pools` (Solana). (GeckoTerminal `trending_pools?duration=5m` added 11:55Z; see D25/D28: only `ds:` / `clawpump:` sightings are tradeable and chain-checked.) | Founder's "dead letter queue": one call per source, every agent reads the same queue. Failed source calls retry with backoff and never block other sources. |
| D3 | Paper fills are priced with ClawPump `POST /swap/quote` (our Enterprise key, 10M calls/month); marks and triggers use DexScreener batch prices; costs 2.5% buy haircut + 1.0% sell haircut on top of the quote. No Jupiter key use. (See D22: marks come only from the DB; D23: a take-profit is judged on the quote, not the mark.) | Jupiter credits are nearly spent (22.5M/25M until Oct 7). Costs = measured execution cost (memory 09-21). |
| D4 | A quote failure never books a near-zero exit: retry the sell quote each exit tick; after 3 failures over >= 45 s, fill at the DexScreener mark minus costs and flag `fill_source='mark_fallback'`. (Extended: Codex r3 `quote_confirmed` and r5 `unresolved` exits with the run persisted in `exit_run`; see D22 DB-only marks, D23 take-profit on the quote.) | Lesson 13 (no-quote exits booked 0.01x during a ClawPump outage). |
| D5 | Hard rules (not editable, shown on every form): LP burned or locked >= 95%, mint authority revoked, freeze authority revoked, no Token-2022 transfer fee, pool reserves present, liquidity >= $5,000. (Amended by D26: no liquidity floor; hard rules = 5. Wording of the Token-2022 rule: see D14.) | Founder rules (LP lock etc.); the liquidity floor removes bonding-curve coins (liq 0) that we cannot price safely. |
| D6 | Contest "Trading Arena Week 1": starts 2026-09-30 22:00Z (6 PM EDT), ends 2026-10-05 03:59:59Z (Sun Oct 4, 11:59:59 PM EDT). Score = realised paper P&L in USD of positions OPENED in the window, whatever their close time; an `unresolved` close counts as a loss of its open stake in the contest score only (D30/D31). Fixed $20 per position, max 5 open. One arena agent per account; guests excluded; house agents shown but never eligible. Prize eligibility (Codex r2 #6 / r3 #6; `FLOOR_ARENA_CONTEST.rules` rule 6, verbatim): "To be eligible for a prize, your agent must be launched before the contest ends and have at least one position opened inside the contest window and closed." (wording since D30, lead decision B: the qualifying position may close at any time, the same set as the D30 score; the matching code change shipped with D30, deployed on staging in `5049971e`.) Code: launch writes `contest_id` only strictly before the end (enrolment), and `eligible` = a user agent with that `contest_id` and at least one qualifying closed trade; the contest top 10 ranks eligible rows only. Prizes 1,000,000 / 500,000 / 250,000 $CLAWVILLE, paid manually by the team after review. (Amended by D30: the score counts positions opened in the window whatever their close time, final standings after the last one closes; by D31: an unresolved close is a loss of its open stake; rule 6, decision B: a qualifying trade may close at any time. All three deployed on staging in `5049971e` (Codex r22 APPROVE), verified 2026-10-01: `ops/house-traders/arena-review/VERIFY_STAGING_9b3c1f93_2026-10-01.md`.) | "By the end of the week"; equal ticket size makes USD P&L comparable. |
| D7 | Seat gating: a user agent opens NEW positions only while seated at a Trading Floor desk. Seated is a server state set by "sit" and cleared by "stand"/leaving; it persists when the player closes the tab (the agent stays at its desk). Exits always run. House agents are always seated. | Founder: the agent must be in the arena to trade; persistent seat avoids "keep the tab open" contests. |
| D8 | Launch creates one ClawPump agent under ClawVille's account per user agent (name `CV Arena · <name>`, private, not accepting bids, no trading skills; `x402` skill only when paid add-ons are on). Provisioning failure does not block paper trading; it retries. (Amended by the single-writer design, Codex r19 money, 2026-10-01: the launch request writes only the row as `pending`, and the engine LEADER creates the ClawPump agent on its next provisioning tick, every 30 s; only the leader writes to ClawPump. See D16: staging form `CV Arena (staging) · <name> #<id12>`, production `CV Arena · <name> #<id12>`; see D24: ClawPump's six sticky default skills stay, every other trading or spending skill is denied.) | Founder requirement; paper mode needs no ClawPump execution yet. |
| D9 | Paid x402 add-ons: catalog of vetted feeds only; the engine pays from the agent's own ClawPump wallet via the ClawPump x402 route with `max_amount_usd` = catalog price; per-agent daily cap (default $1, max $5); poll interval per add-on >= 10 min; mints from an add-on stay private to that agent. (See D15: run-time floor 600 s; D18: the x402 wrapper confirmed on staging.) | Vetting found listed prices 100x below real prices (seerium $0.10 not $0.001). Users pay for their own add-ons. |
| D10 | 30-minute review for every agent with activity: stats + an LLM summary + at most ONE parameter change within bounds. A parameter changes only when the evidence check passes (D27 + D33), so most reviews end with no change, and each report states why. House agents apply the change automatically (logged publicly as a param change); user agents see it and apply with one click. The report is also written into the agent's ElizaOS memory when a runtime exists. (Amended by D27: a change needs 20 closed trades and the split check; by D33: code, not the model, finds the change, only at a trade-count checkpoint, it also needs a shuffle test with p at or below that checkpoint's alpha, and the LLM summary is commentary only; see D21: house reports are public.) | Founder words: "self-learning", "fine-tuning every 30 minutes". D33 keeps the 30-minute review and makes every change evidence-backed; with an honest gate, changes are rare (`ops/house-traders/arena-review/TUNER_CHECK_2026-10-01.md`). |
| D11 | Live mode is in the schema but rejected (`live_not_available`) until a later founder go. | Founder: start paper-only. |
| D12 | Agent parity: every arena write route uses `requireAuthOrAgentSession` and resolves the subject to its avatar; tools.json + manual §17c + PROTOCOL_VERSION bump + Nori/orientation lines in the same PR. No new `[ACTION:]` verb (tools.json only) to keep the protected executor untouched. | Rule E5 / three knowledge surfaces. |
| D13 | `top10_max_pct` is null (off) in all five templates; null or >= 100 never fails; a cap below 100 fails a coin whose top-10 share is unmeasured (`top10_unknown`). Players keep the 1..100 bound. | A set cap fails any coin whose top-10 share is unmeasured (12:13Z, arena-core). |
| D14 | Hard rule `t22-fee` reads "Token-2022: no transfer fee or risky extension". | The engine blocks every risky extension, not only a transfer fee (12:13Z). |
| D15 | Add-on poll floor 600 s at run time (interval = max(catalog `minIntervalS`, 600 s)); catalog intervals: token screener 600 s, DEX trades 900 s. | Enforces D9's 10-minute minimum in code, not only in the catalog (12:13Z). |
| D16 | Staging may provision real ClawPump agents; outside production (`CLAWVILLE_ENV`) they are named `CV Arena (staging) · ...`. | Staging agents stay visible as such in ClawVille's one ClawPump account (12:30Z; `provisioning.ts`). |
| D17 | Engine pause is in memory on the process that receives the admin call. | One api container outside deploy flips; acceptable for now (12:30Z). |
| D18 | Nobody says add-ons work until one real $0.01 Nansen call confirms ClawPump's REST x402 response wrapper on staging. Confirmed 18:58Z (ledger row `done`, $0.010, 50 mints). | The wrapper key is not documented in the ClawPump MCP source (12:30Z). |
| D19 | A player agent's params and param-change history are PUBLIC. | The arena is a public strategy showcase; the founder wants players to watch strategies (13:28Z, Codex r3). |
| D20 | Executed trades (positions, entry and exit events, tape) are PUBLIC for every agent; only add-on setup, wallet address, reports, suggestions and add-on sources are private. | Lead ruling on the remaining Codex r3 privacy findings (13:28Z). |
| D21 | House agents' 30-minute reports and suggestions are intentionally public. | Our own agents; players watch how a house strategy learns and tunes (13:41Z, Codex r4). |
| D22 | The engine keeps NO in-memory marks: every exit decision reads the newest DB mark and re-reads it inside the booking transaction after the quote; a newer mark means a lost race and a re-decision next tick. | Remove the class, not the instance: Codex r8/r9 found interleavings between memory and DB marks around a slow sell quote (14:33Z). |
| D23 | A take-profit leg sells only when the QUOTED multiple reaches the leg's multiple; otherwise hold and log `tp_not_confirmed_by_quote`. Stops, trail and time exits still sell at the quote. | Live finding: a TP fired on the DexScreener mark but the quote realised a loss ("Genesis exit SAID reason tp pnl -0.096"); the Python runner judged TP on the quote (14:47Z). |
| D24 | `private-transfers` (a ClawPump platform default) is allowed; every non-default trading or spending skill stays denied. | ClawPump's six default skills are sticky (a PATCH only toggles `x402`), so denying one would fail every new provision (18:58Z, verifier A). |
| D25 | A shared-feed coin is tradeable only after a DexScreener or ClawPump sighting; GeckoTerminal-only coins are shown, not traded; add-on mints are exempt. | Deaths analysis: 19 of Runner's 20 coins were GeckoTerminal-only sightings (9 TP, 9 deaths, -$114.45) (19:05Z). |
| D26 | The $5k liquidity floor stops being a hard rule (the founder's five stay: LP burned or locked with curves OK, mint and freeze authority revoked, no risky Token-2022 extension, pool reserves present). Runner follows C1: `liq_min` null, first sight counted from the first DexScreener or ClawPump sighting (`entry.first_sight_sources`). (See D28: D26 also dropped the liquidity bound from the chain-check universe; D28 limits checks to tradeable coins.) | The floor blocked pump.fun curve coins (16 of C1's 18 trades), so the arena Runner did not match C1 (19:05Z). |
| D27 | The tuner auto-applies only with >= 20 closed trades on the current params and a deterministic split check (>= 8 kept and >= 8 excluded, kept mean `pnl_mult` >= 0.03 better, raw means; filter changes only). House agents reset to template v2 (migration 0072). Every exit quote refusal is logged. (Amended by D33: the check alone is too weak for a searched candidate; code, not the model, searches the candidates, only at a trade-count checkpoint, and a change also needs a max-statistic shuffle test with p at or below that checkpoint's alpha; the same gate now also governs a click-to-apply suggestion.) | The tuner's one change (Runner `chg5m_max` 41.48 -> 20.74) was not supported by the data (19:05Z; raw-mean fix after Codex r12). |
| D28 | Chain-check budget and verdict age. (1) `selectDueChainChecks` checks only SHARED coins with a tradeable source (a `ds:` or `clawpump:` source, the `FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES` rule) plus every private add-on mint; each tick (`pickDueChainChecks`, Codex r14) gives at least half of its checks, rounded up (10 of 20), to already-checked due rows, oldest verdict first, and the rest to never-checked rows, newest first sight first; each half fills the other's spare room, and the SQL reads both sets separately (UNION ALL), so a flood of new coins cannot hide the old ones. (2) Entry gate `entryVerdictStatus`, run TWICE (Codex r14): at candidate load, and again inside the entry transaction right before the INSERT (`insertTimeGate`: the discovery or private-mint row re-read `FOR SHARE`, the wall clock, the current snapshot pair; abort codes `chain_verdict_stale`, `chain_pending`, `hard_rules`, and `top10` / `top10_unknown` when a newer verdict's top-10 share fails the filters; an abort writes a `skip` event with `at: 'insert'`). Rule at both points: a verdict counts only for the pair priced now (strict `pairAddress` equality; a verdict with no `pairAddress` for a priced pair is pending) and only while it is younger than `CHAIN_VERDICT_TTL_MS` (30 min, measured from `chain_checked_at`, else `verdict.checkedAt`; exactly 30 min is stale); an older verdict fails the entry with code `chain_verdict_stale`, for shared and private mints alike. (3) The entry event data carries `chainCheckedAt`, taken from the insert-time re-read; a newer verdict's `top10Pct` is re-filtered and stored in `entry_features`. (4) Enrichment puts non-tradeable shared rows in the last tier (`enrichTier` 4). No protocol change: PROTOCOL_VERSION stays 75. | Verifier A on `9dc59f73` (23:44Z): D26 also removed the liquidity bound from the chain-check universe, so 95% of the check budget went to GeckoTerminal-only coins that are never bought; 309 of 390 tradeable coins had verdicts older than the 30-min TTL, and entries used verdicts 62-90 min old, so an LP pulled after the check would not be seen. |
| D29 | Every FULL user-agent report (not a short no-trade report, which returns before the memory write) is stored by `writeArenaReportMemory` through `recordEarnedSkillLesson` as an earned-skill lesson of the owner's avatar (building `cron-automation`, teacher "Trading Arena analyst"): in the avatar's warm hosted ElizaOS runtime, else in the avatar-keyed `npc_memories` store (`subtype: 'earned-skill'`); one log line names the store (`eliza`, `npc_memories` or `none`); never lazy-starts a runtime. Owner avatar chat (`POST /api/avatars/me/chat`) folds up to 3 Trading Floor lessons as `dynamicContext` for arena owners only (`tradingFloorLessonContext`; ONE 1.5 s time box over the arena-owner lookup and the lesson read together, Codex r14; fail-soft). Readers, all via `readEarnedSkillLessons`: owner chat (human cookie), the Trading Floor teacher chat and the autonomy decide loop (both HOSTED agents only: `world-teacher-chat.ts` folds lessons only with a `platformAgentId`, and only the hosted autonomy driver calls it), and `GET /api/agent/:sessionId/skills/cron-automation/skill-memory` (the CONNECTED agent's read path). The runtime's KnowledgeProvider does not read them. | Verifier A found 0 arena memories on staging: the old writer needed a warm runtime, and runtimes sleep after 30 idle minutes. |
| D30 | DEPLOYED on staging in `5049971e` (deployed head `9b3c1f93`), verified 2026-10-01: server checks in `ops/house-traders/arena-review/VERIFY_STAGING_9b3c1f93_2026-10-01.md`, browser checks in `ops/house-traders/arena-review/browser-2026-10-01/BROWSER_VERIFY_2026-10-01.md` (arena-contest-impl; consolidated build; Codex r19-r22, r22 VERDICT: APPROVE; `leaderboard.ts`, `contest.ts`, `engine.ts`). Before the end `GET /contest` returns `standings: null`, as specified; `provisional` and `final` can be checked only after 2026-10-05 03:59:59Z. The contest score counts every closed position OPENED in the contest window, whatever its close time (`closedTo: null` on the contest window). `GET /contest` reports `standings`: null before the end, then `provisional` while a window position is still open or until 5 min after the end (`ARENA_CONTEST_FINAL_GRACE_MS`: the commit of one entry transaction, bounded by `transaction_timeout` = `ENTRY_TX_TIMEOUT_MS` (60 s, `engine.ts`), plus the 10 s caches; the first statement of the entry transaction sets `statement_timeout` = `ENTRY_STATEMENT_TIMEOUT_MS` (30 s) and resets `transaction_timeout` to 0, then to 60 s, because PostgreSQL 17 does not restart an active timer when its value changes (Codex r21); on a server before PostgreSQL 17 only the statement bound applies and the engine warns once; the engine reads the insert-time wall clock after that statement and stamps it as `opened_at`, so an entry inserted after the end is not a window position; a failed or timed-out entry transaction rolls back, buys nothing, and the tick skips that coin with the skip reason `entry_tx_failed`), then `final`; `openWindowPositions` counts the open ones. Prize eligibility (rule 6, lead decision B, 2026-10-01): a qualifying trade is a position opened in the window and closed at ANY time, the same set as the D30 score; the code (`isContestEligible`) now requires an enrolled user agent with contest-window `trades >= 1`, so an unresolved close counts too; the separate close-by-end count (`qualifyingClosedTo`) is removed. Rules text (`FLOOR_ARENA_CONTEST.rules` 2, 5, 6) updated by arena-core. | audit-contest D-A: "closed by the end" gives a free option in the final 24 h (a losing position still open at the end would drop out of the score). |
| D31 | DEPLOYED on staging in `5049971e`, verified 2026-10-01 (same two reports as D30; 0 `unresolved` exits since 03:35Z, so the loss path has no live case yet) (arena-contest-impl; consolidated build; Codex r22 VERDICT: APPROVE; `leaderboard.ts`). On the contest window only, an `unresolved` close counts with P&L = `realised_usd - size_usd` (the gross proceeds of earlier take-profit legs minus the $20 stake, i.e. a loss of its open stake) and multiple = `realised_usd / size_usd`; it counts as a trade, as a loss when below 0, and as a death at 0.5x or lower (with today's single-leg templates: always -$20, a loss and a death). The 24 h and all-time windows, agent reports and the analysis stats keep leaving it out. | audit-contest D-B: a rug with no usable price closes `unresolved` and would otherwise drop out of the score. |
| D32 | Codex r23-money VERDICT: APPROVE; DEPLOYED on staging in `5049971e` (lead, 2026-10-01; consolidated build; `provisioning.ts`, `addons.ts`, `clawpump-writer.ts`). The x402 add-on path ran no payment since the flip (the only add-on call is from 2026-09-30 14:52Z; 0 duplicate settlement refs, 0 stale `reserved` rows), so a live add-on call on staging is owed, and it needs a founder go because it spends real USDC (`ops/house-traders/arena-review/VERIFY_STAGING_9b3c1f93_2026-10-01.md` F3). `x402` removal from a player's ClawPump agent is HYGIENE, not a money control. The money invariant: no USDC moves unless the reservation and `confirmDispatch` pass (add-on enabled, agent active and seated, engine not paused, caps) AND the ClawPump writer's own last read before the pay shows a stopped agent that holds `x402`. A late or failed `x402` removal therefore never lets a payment through; the removal passes (§6) only keep the skill off agents that do not need it. | Lead decision (relayed by arena-api). A removal can wait on a busy lock, an empty call budget or a ClawPump failure (§6), while the payment gates are checked at pay time on every call. |
| D33 | Honest tuner (lead, 2026-10-01; branch `fix/arena-followups`, not deployed; `analysis.ts`, `analysis-rules.ts`). The tuner runs on every due report (about every 30 minutes, quiet reports and a failed or timed-out model included), but it TESTS only at trade-count checkpoints (`TUNER_CHECKPOINTS`): 20, 40, 80, 160, 200, 400 and 800 closed trades under the current `params_version`, each checkpoint ONCE per params version, at its own alpha (`TUNER_CHECKPOINT_ALPHA`): 0.01 at 20, 40, 80 and 160, 0.005 at 200, 0.0025 at 400 and 800, a family budget of 0.05 per rule set. At a report it tests the largest untested checkpoint it has reached; a smaller checkpoint it skipped is forfeited (its alpha is not spent elsewhere). Between checkpoints it does not search (reason `waiting_checkpoint`, `needed` = the next checkpoint); after 800 the reason is `budget_spent` (no automatic change until the rules change; a new params version starts a new schedule). At a checkpoint, code searches ONE-filter tightenings inside the agent's band (the house band for a house agent, the validation bounds for a user agent) on those closed trades. A change needs D27 (>= 20 closed trades, >= 8 kept, >= 8 excluded, edge >= +0.03 mean multiple, raw means) AND a max-statistic shuffle test over every filter tried with p <= that checkpoint's alpha (`EVIDENCE_PERMUTATIONS` = 2000 shuffles, seeded by `agentId:paramsVersion:n`, so a rerun gives the same answer). Auto-apply agents (every house agent; a user agent with auto-apply on) change only then; a click-to-apply user agent gets a pending suggestion only then (the 6-trade suggestion gate no longer applies). The AI model's reply is commentary only: code ignores any model proposal. Each report stores `stats.suggestionCheck.tuner` = `{ decision, reason, n, needed, checkpoint, alpha, best, p }` (`decision` `changed`, `suggested` or `none`; `best` = `{ path, from, to, kept, excluded, edge }` or null); reasons `below_sample`, `waiting_checkpoint`, `budget_spent`, `no_candidate`, `not_significant`, `rate_limited`, `changed`, `suggested`, `params_changed`, `not_tunable`. A rejected report also drops `stats.suggestionCheck.evidence` in the same UPDATE. Most reviews end with no change, and each report states why: players see one line under each report, agents read it from the report. Manual §17c, the `clawville_arena_settings` tool text and GameFeatures §17g.3 say the same (PROTOCOL_VERSION 77, unpublished, no new bump). | `ops/house-traders/arena-review/TUNER_CHECK_2026-10-01.md`: 104 house reports since the 2026-09-30 20:07Z reset, 0 proposals (the model could not see the split data and the prompt told it to return null, so D27 never ran); a naive code search with the D27 thresholds alone "confirms" a change on shuffled outcomes 74-99.6% of the time (search-adjusted p 0.74-0.87 for Genesis, Late Bloomer, Dip Hunter). The manual and spec said "re-tuned / fine-tuned about every 30 minutes" while 0 changes happened in 12.7 h. Checkpoints (review of `10cd060d`, 2026-10-01): a test on EVERY report at p <= 0.05 is optional stopping (many looks at one growing sample); a reviewer simulation on pure noise changed about 25% of agents by 100 trades and 43% by 400. Seven fixed looks whose alphas sum to 0.05 keep the pure-noise change rate at most about 5% per rule set (a union bound over the looks; D27 can only lower it). |

## 2. CONTRACT — shared (`packages/shared/src/constants/floor-arena.ts`, exported from the package index)

```ts
export const FLOOR_ARENA_VERSION = 1;
export type FloorArenaRankBy = 'vol_over_mcap' | 'newest' | 'oldest' | 'txns1h' | 'lowest_vol_over_mcap' | 'mid_vol_over_mcap';
export interface FloorArenaFilters {            // every field number | null (null = off); chg in %, age = DexScreener PAIR age in s
  mcap_min: number | null; mcap_max: number | null; liq_min: number | null; liq_max: number | null;
  age_min_s: number | null; age_max_s: number | null;
  vol1h_over_mcap_min: number | null; vol1h_over_mcap_max: number | null;
  chg5m_min: number | null; chg5m_max: number | null; chg1h_min: number | null; chg1h_max: number | null;
  chg6h_min: number | null; chg6h_max: number | null; chg24h_min: number | null; chg24h_max: number | null;
  txns1h_min: number | null; txns1h_max: number | null; top10_max_pct: number | null;
}
export interface FloorArenaEntry { discovered_within_s: number | null; rank_by: FloorArenaRankBy; entries_per_tick: number; }
export interface FloorArenaExits {
  tp: Array<[number, number]>;                  // [multiple, fraction of the ORIGINAL position], 0..3 legs, fractions sum <= 1
  stop_mult: number | null; trail_from_peak: number | null; trail_arm_mult: number | null; max_hold_s: number;
}
export interface FloorArenaLimits { position_usd: number; max_open: number; reentry_cooldown_s: number; }
export interface FloorArenaParams { filters: FloorArenaFilters; entry: FloorArenaEntry; exits: FloorArenaExits; limits: FloorArenaLimits; }
export interface FloorArenaTemplate {
  id: string; displayName: string; houseAgentId: string; tagline: string; thesis: string; risk: string;
  params: FloorArenaParams;
}
export const FLOOR_ARENA_TEMPLATES: readonly FloorArenaTemplate[];   // exactly 5; ids + params from docs §3
export const FLOOR_ARENA_HOUSE_AGENTS: readonly { id: string; name: string; templateId: string; clawpumpAgentId: string | null }[];
export const FLOOR_ARENA_HARD_RULES: readonly { id: string; label: string }[];   // D5, in display order
export const FLOOR_ARENA_PARAM_BOUNDS: {...};   // per field: min, max, step, unit, label, locked?: boolean
export const FLOOR_ARENA_PAPER_COSTS = { buy_haircut_pct: 2.5, sell_haircut_pct: 1.0 } as const;
export const FLOOR_ARENA_CONTEST: { id: 'arena-week-1'; name: string; startsAt: string; endsAt: string;
  prizes: readonly { place: 1 | 2 | 3; amount: number; token: '$CLAWVILLE' }[]; rules: readonly string[] };
export interface FloorArenaAddon { id: string; vendor: string; name: string; url: string; method: 'GET' | 'POST';
  query: Record<string, string> | null; body: Record<string, unknown> | null;
  dedupeVary: { path: string; values: [number, number] } | null;   // alternate per poll (ClawPump x402 cache)
  priceUsd: number; minIntervalS: number; mintPath: string; symbolPath: string | null; note: string; }
export const FLOOR_ARENA_ADDONS: readonly FloorArenaAddon[];   // from ops X402_FEEDS catalog (approved only)
export function validateFloorArenaParams(p: unknown): { ok: true; params: FloorArenaParams } | { ok: false; errors: string[] };
export function diffFloorArenaParams(a: FloorArenaParams, b: FloorArenaParams): Array<{ path: string; from: unknown; to: unknown }>;
```
Bounds (enforced by `validateFloorArenaParams`; the UI renders them): mcap 1,000..100,000,000; liq_min >= 5,000
(hard floor) .. 50,000,000; age 0..2,592,000 s; vol1h/mcap 0..100; chg 5m/1h -100..1,000,000; chg 6h/24h
-100..10,000,000; txns1h 0..1,000,000; top10 1..100; every min < its max when both set; discovered_within_s null or
30..86,400; entries_per_tick 1..3; tp legs 0..3, multiple 1.01..10, fraction 0.05..1, sum <= 1; stop_mult null or
0.30..0.99; trail_from_peak null or 0.02..0.60; trail_arm_mult null or 1.0..5.0 (only with trail); max_hold_s
60..86,400 (required); position_usd LOCKED 20; max_open 1..5; reentry_cooldown_s 0..604,800. Unknown keys reject.
At least one of: a tp leg, stop_mult, trail_from_peak (max_hold_s always ends a trade).

## 3. The five templates (house agent = template; params from `ops/house-traders/TEMPLATES_2026-09-30.md`)

| id | House agent | Status |
|---|---|---|
| `genesis` | Genesis | locked = paper wide-4 (mcap 10k-250k, liq >= 15k, pair age 30 min-6 h, rank vol/mcap, TP 1.10 full, 900 s) |
| `runner` | Runner | locked = paper C1 (discovered_within_s 120, chg6h >= 680.4, chg5m <= 41.48, TP 1.20 full, 900 s) |
| `dip-hunter` | Dip Hunter | mcap 250k-50M, liq >= 50k, age >= 6 h, chg1h <= -5, chg24h >= 0, rank lowest vol/mcap; TP 1.08, stop 0.90, 2 h |
| `midcap-climber` | Mid-Cap Climber | mcap 500k-5M, liq >= 30k, age 1-24 h, chg5m >= 0, chg1h 5..60, rank txns1h; TP 1.10, 60 min |
| `late-bloomer` | Late Bloomer | mcap 50k-500k, liq >= 15k, age 6-48 h, chg5m >= 2, chg1h >= 20, rank txns1h; TP 1.10, 30 min |

Evidence (strategy designer, `ops/house-traders/TEMPLATES_2026-09-30.md`, tape simulation on a 31-h Genesis-paper
log, in-sample, small n; the simulator is about 2 points pessimistic on 148 real entries): Dip Hunter n=15, 73% TP,
0 deaths, +0.4%/trade, 0.82 entries/30 min; Mid-Cap Climber n=20, 0 deaths, about +0.7%/trade, 0.20-0.41/30 min;
Late Bloomer n=42, 0 deaths, -5.5% to -6.3%/trade (loses about the round-trip cost), 0.66-0.75/30 min. Rejected by
the data: Volume Surge (-17% to -28%/trade, many deaths), Fresh Graduation (about -18%/trade), every trailing-exit
Trend Rider variant. Clamps to arena bounds: max_open 20 -> 5 (Genesis, Runner), Runner entries_per_tick 99 -> 3,
Runner liq_min null -> 5,000 (platform floor). Dip Hunter's 0.90 stop is a lead decision (founder asleep).

## 4. CONTRACT — database (`packages/database/src/schema/floor-arena.ts`, migration `packages/database/migrations/0070_floor_arena.sql`, IF NOT EXISTS style)

- `floor_discovery_mints`: `mint text PK`, `first_seen_at timestamptz not null`, `first_source text not null`,
  `sources text[] not null default '{}'`, `last_seen_at timestamptz not null`, `symbol text`, `name text`,
  `snapshot jsonb` (DexScreener pair fields: priceUsd, mcap, liqUsd, pairAddress, dexId, pairCreatedAt, ageS, chg5m,
  chg1h, chg6h, chg24h, txns1h, vol1h, volOverMcap), `snapshot_at timestamptz`, `chain_verdict jsonb` ({pass, fails[],
  checkedAt, error?}), `chain_checked_at timestamptz`, `expires_at timestamptz not null`. Index on (first_seen_at desc),
  (expires_at).
- `floor_arena_agents`: `id text PK` (house: `house:<templateId>`; user: uuid string), `kind text check in
  ('house','user')`, `owner_user_id uuid null references users`, `avatar_id uuid null`, `name text not null`,
  `template_id text not null`, `params jsonb not null`, `params_version int not null default 1`, `mode text not null
  default 'paper' check in ('paper','live')`, `status text not null default 'active' check in ('active','paused',
  'stopped')`, `seated boolean not null default false`, `seat_index int null`, `seated_at timestamptz null`,
  `clawpump_agent_id text null`, `clawpump_wallet text null`, `provision_state text not null default 'none' check in
  ('none','pending','ready','failed')`, `provision_error text null`, `addons jsonb not null default '[]'`
  ([{id, enabled, dailyCapUsd}]), `auto_apply_suggestions boolean not null default false`, `contest_id text null`,
  `created_at`, `updated_at`. Unique partial index: one row per `owner_user_id` where kind='user'.
- `floor_arena_positions`: `id uuid PK`, `agent_id text not null`, `mint text not null`, `symbol text`, `source text`
  (discovery source that surfaced it), `opened_at timestamptz not null`, `size_usd numeric not null`, `tokens numeric not
  null`, `entry_price_usd numeric not null`, `entry_fill_source text` ('quote'), `entry_features jsonb`,
  `params_version int not null`, `peak_mult numeric not null default 1`, `last_mark_mult numeric`, `last_mark_at`,
  `remaining_fraction numeric not null default 1`, `realised_usd numeric not null default 0`, `status text check in
  ('open','closed')`, `closed_at timestamptz`, `exit_reason text` ('tp','stop','trail','time','manual'), `exit_fill_source
  text` ('quote','mark_fallback'), `pnl_usd numeric`, `pnl_mult numeric`, `exit_quote_failures int not null default 0`.
  Indexes (agent_id, status), (agent_id, opened_at desc), (closed_at).
- `floor_arena_events`: `id bigserial PK`, `agent_id text not null`, `at timestamptz not null default now()`, `type text`
  ('scan','pass','skip','entry','exit','param_change','report','status','addon'), `mint text null`, `summary text not
  null` (<= 280 chars, human readable), `data jsonb`. Index (agent_id, id desc). Retention: prune > 7 days except
  entry/exit/param_change/report.
- `floor_arena_reports`: `id uuid PK`, `agent_id`, `period_start`, `period_end`, `stats jsonb`, `summary text`,
  `suggestion jsonb null` ({path, from, to, reason}), `suggestion_state text` ('none','pending','applied','dismissed',
  'auto_applied','rejected'), `created_at`.
- `floor_arena_param_changes`: `id bigserial PK`, `agent_id`, `at`, `source text` ('user','house-tuner','admin',
  'suggestion'), `changes jsonb` (diff list), `params_version int`, `reason text`.
- `floor_arena_private_mints`: PK (`agent_id`, `mint`), `first_seen_at`, `source text` (addon id).
- `floor_arena_addon_calls`: `id bigserial PK`, `agent_id`, `addon_id`, `at`, `price_usd numeric`, `ok boolean`,
  `error text null`, `mints int`, `response_ref text null`.

## 5. CONTRACT — API (`apps/api/src/routes/floor-arena.ts`, mounted at `/api/floor/arena`; public GETs registered before `sessionMiddleware` like `trading-floor.ts`)

Public (60/min per IP, short cache): `GET /templates` (templates + hard rules + bounds + each house agent's live stats),
`GET /leaderboard?window=contest|24h|all` (rows: rank, agentId, name, kind, templateId, realisedUsd, trades, wins,
deaths, openPositions, lastTradeAt, eligible), `GET /agents/:id` (public profile: params, status, seated, stats, open
positions, last 50 closed, latest report, last 20 param changes; never a wallet secret; owner id never exposed),
`GET /agents/:id/events?after=<id>&limit<=100` (decision stream), `GET /discovery?limit<=100` (shared feed, newest
first), `GET /contest` (window, prizes, rules, top 10), `GET /addons` (catalog), `GET /tape?limit<=24` (newest
entry/exit events across all agents for the TV tape: id, at, agentId, agentName, kind, type, mint, symbol, side, usd,
pnlUsd, pnlMult, reason).
Authed (`requireAuthOrAgentSession`, non-guest, subject -> avatar): `GET /me` (my agent or null + wallet + provision
state + addon status), `POST /me/launch` {templateId, params, mode:'paper', addons:[{id, dailyCapUsd}], name?} ->
201 {agent, paymentAddress|null}; 409 `already_have_agent`; 400 `invalid_params` {errors}; 400 `live_not_available`,
`PATCH /me/params` {params, reason?}, `POST /me/seat` {seated, seatIndex?}, `POST /me/status` {status:
'active'|'paused'}, `PATCH /me/addons` {addons}, `POST /me/suggestions/:reportId` {action:'apply'|'dismiss'},
`PATCH /me/settings` {autoApplySuggestions}.
Admin (`/api/admin/floor-arena`, same guard as admin-trading: session + moneyOperatorOnly): `POST
/house/:id/params`, `POST /engine/pause|resume`, `GET /engine/state`, `POST /agents/:id/reprovision` (money audit N4: a
failed user agent back to `pending`; no ClawPump call in the route, the engine leader provisions it on its next tick).
Single writer (Codex r19 money): no request handler calls ClawPump. `POST /me/launch` leaves the row `pending`,
`PATCH /me/addons` changes the row only, reprovision resets the row; the engine leader applies each one: a launch or a
reprovision on its next 30 s provisioning tick, an add-on OFF on the next tick (x402 removal is hygiene, not a money
control, D32), an add-on ON right before the first payment (details in §6).
SSE: reuse the world stream if cheap; else the client polls `/agents/:id/events` every 5 s.
Anti-sybil events (audit-contest B1, built; table `events`, written by `logEventFromContext` in `routes/floor-arena.ts`,
constants `ARENA_LAUNCH_EVENT` / `ARENA_SEAT_EVENT`):
- `floor_arena.launch`: one row after a successful `POST /me/launch` insert; payload `{arenaAgentId, templateId,
  identityKind ('user' | 'agent'), contestId (null after the contest end)}`.
- `floor_arena.seat`: one row when `POST /me/seat` really changes the seat AND `seated = true` (the agent starts to
  trade); no row on stand-up or on a no-op; payload `{arenaAgentId, seatIndex, identityKind}`.
- Both rows carry `user_id`, `avatar_id`, `agent_id` (only for an agent session), `fp_hash` and `ip_prefix_hash`
  (`fingerprintMiddleware` stamps both hashes on every request). Weight 0 in scoring: the leaderboard scores named event
  types only, and these two are not among them. Purpose: the P3 payout review (§8, "P3 review query (B1)" at the end of §8).
- PARITY: the human (login session) and the agent (agent session) launch and seat paths both write the rows;
  `identityKind` tells them apart.

## 6. Engine (`apps/api/src/services/floor-arena/`)

`leader.ts` (pg advisory lock, re-acquire loop), `discovery-hub.ts` (pollers + DexScreener enrichment + expiry),
`chain-checks.ts` (hard rules, 30-min cache; port of the Python runner's `chain_checks` / `lp_lock_fail` / reserve
check, reuse `trading-rpc.ts` / `trading-mint-info.ts`), `pricing.ts` (ClawPump quote fills + DexScreener marks),
`engine.ts` (15 s entry tick, 10 s exit tick), `analysis.ts` (30-min reports + house tuner), `provisioning.ts`
(ClawPump create/update agent and the x402 reconcile, 30 s tick), `addons.ts` (x402 polling + spend ledger),
`leaderboard.ts`, `index.ts` (`startFloorArena()` called from `apps/api/src/index.ts` next to the trade observer; env
kill switch `FLOOR_ARENA_ENGINE_ENABLED` default on).

Single writer for ClawPump (Codex r19 money, lead design, 2026-10-01; design v8b after Codex r20/r21 and audit-money).
Only the arena engine LEADER writes to ClawPump: creates, config PATCHes, x402 on/off and add-on payments. Request
handlers write only the DB row (§5): launch leaves `pending`, `PATCH /me/addons` changes the row, admin reprovision
resets to `pending`.
D32 (lead): x402 removal is HYGIENE, not a money control. The money invariant: no USDC moves unless the reservation and
`confirmDispatch` pass (add-on enabled, active, seated, engine not paused, caps) and the ClawPump writer's last read
shows a stopped agent that holds x402.
- x402 ON only for a READY agent with an enabled add-on, not while paused, never on a `running` agent.
- x402 OFF otherwise, also while paused and on a `running` agent (a removal only takes capability away).
- Provisioning NEVER adds x402: its config sync runs in the x402 section with x402 not allowed and PATCHes
  `enabled_skills: []`, which removes x402 if present (a busy lock fails the attempt with `x402_lock_busy`).
Each 30 s provisioning tick (±10%, leader, also while the operator pause is on) runs the x402 REMOVALS first
(`runArenaX402Reconcile` -> `removeUnwantedArenaX402`, removal-priority calls), then, unless paused, up to 20 due rows:
- R1: every add-on-free agent whose row changed since the previous pass start minus 2 minutes, keyset-paged by id with
  no row limit (`readArenaX402RecentOff`). The watermark is DATABASE time (`readDbNow`, `SELECT now()` at pass start).
  The FIRST pass of each leader term (`startArenaX402LeaderTerm`, called on election) covers EVERY add-on-free agent.
- R2: a fair cursor over all add-on-free agents, 6 per tick, paged, advancing every tick (`readArenaX402OffAgents`).
- R3: earlier failures and deferrals, oldest first, one attempt per agent per tick. An agent whose removal FAILS
  backs off 30 s, 1, 2, 4 ... minutes (at most 30) in every pass; a busy lock or an empty budget retries next tick.
Then, only when no removal was deferred (busy lock or call budget) and the budget allows normal calls, 4 re-checks per
tick over all agents (`readArenaX402SweepAgents`, a second cursor); a re-check that finds unwanted x402, or a running
agent with x402, removes it at once.
x402 is ADDED only by the add-on tick (60 s, leader) right before it pays (`ensureArenaX402ForPay`): at most 8 adds per
tick, none while a removal is deferred, and a failed or impossible add backs off 1, 2, 4 ... minutes (at most 30) for
that agent. If the player turns add-ons off during an add, x402 comes off in the same call. The add-on tick reserves
only when x402 is on a stopped agent that wants it; `confirmDispatch` then re-checks the add-on under the add-on lock,
and the ClawPump writer re-checks x402 and the status at its own last read before the POST: any status other than
`stopped` (`agent_running` for `running`, `agent_not_stopped` for null, missing or any other value; Codex r22-money)
refuses every PATCH that is not removal-only (only `enabled_skills`, no x402, a subset of the agent's skills) and every
payment; a payment also needs x402 on the agent.
Every x402 decision runs in ONE x402 section at a time per process (an in-process mutex shared by the provisioning
tick and the add-on tick), inside a transaction (`tryWithArenaX402Lock`) whose first statement sets `statement_timeout`
30 s (`ARENA_X402_STATEMENT_TIMEOUT_MS`) and, on PostgreSQL 17, resets `transaction_timeout` to 0 and arms it at 60 s
(`ARENA_X402_TX_TIMEOUT_MS`; the engine.ts pattern; before 17 only the statement bound applies and a warning is logged
once), then takes `pg_try_advisory_xact_lock('floor-arena-x402:<id>')`, a separate key from the add-on lock. The lock is
held across the row read (`readArenaAgentLocked`, its own short transaction under the add-on lock), a fresh ClawPump
GET, a PATCH only when needed and a verifying GET. Each ClawPump call is bounded at 15 s by default
(`CLAWPUMP_HTTP_TIMEOUT_MS`, at most 30 s); a section makes at most 4 calls for a removal, 8 for provisioning's
config sync and 13 for an add with its compensating removal; a section that passes 60 s is ended by Postgres (rolled
back, lock released), its caller sees an error and the next tick re-checks (D32: hygiene, never a payment). A busy
agent is skipped and retried next tick. Two leaders during a failover never interleave on one agent, and a slow
ClawPump call never blocks a player's seat, status or add-on write. The x402 path uses at most 2 pooled connections
per process (the long x402 transaction plus one short query: the add-on-lock row read or the writer's ownership
query); the add-on reservation, `confirmDispatch` and finalize transactions run outside it. No in-memory cache ever
skips a ClawPump read. CI: the gates step "Run PostgreSQL-backed Trading Floor database contracts" runs
`floor-arena-queries.db.test.ts` on a real Postgres, including a two-connection test of the x402 try-lock (A holds
it; B is refused at once; another agent's lock is free; a route-style seat write commits while A is open).
ClawPump call budget: the writer allows 60 calls a minute per process with a burst of 10, checked before each request
(`CLAWPUMP_WRITER_CALLS_PER_MINUTE`, `CLAWPUMP_WRITER_BURST`). It covers every arena call through the writer, the
arena's agent GETs included; the house traders' calls and the paper-fill quotes are out of its scope. The last 5 of
the 10 tokens are reserved for removal calls (`CLAWPUMP_WRITER_REMOVAL_RESERVE`). An empty budget refuses with
`budget_exhausted` (ClawPump's HTTP 429 stays `rate_limited`) before sending. When the budget is low, the add-on tick
defers its tick and re-checks are skipped, with one log line per tick. A refused payment books 0 (stored error
`clawpump_budget_exhausted`).
ClawPump quota: Enterprise 10,000,000 calls a month, "recorded but not enforced", no per-second limit (research
2026-09-30: ops/house-traders/research-20260930-clawpump R2-api.md, R1-docs.md; outside git).
Post-condition: x402 comes OFF on the tick after the change, also while paused, unless the agent's x402 lock is busy,
the call budget is empty or ClawPump fails. Those are retried every tick, and a failing agent backs off 30 s, 1, 2,
4 ... min (at most 30 min). The fair cursor reaches every add-on-free agent within ceil(N / 6) ticks (30 s each). x402
comes ON only right before the first payment, never while paused or while the agent runs. No payment depends on x402
alone.

## 6a. Analysis as built (D10; `analysis.ts` + `analysis-store.ts`, tests `services/__tests__/floor-arena-analysis.test.ts`)

- Cadence: the engine calls `runArenaAnalysisTick(now)` every 60 s (in-flight guarded). A report is due 30 min after the last
  one (or after creation). With a position opened or closed since then: stats + LLM report. With no activity: a short
  deterministic "no trade" report, at most every 2 h, only for an `active` agent. A paused or stopped agent is reported
  only while its exits close positions. Per tick: at most 12 LLM reports and 40 quiet reports (the rest wait a minute).
- Stats (code, no LLM), three windows: the period, trades opened under the CURRENT `params_version`, and lifetime
  (newest 5,000). Exits by reason, deaths (`pnl_mult <= 0.5`), severe (`<= 0.6`, deaths included), win rate
  (`pnl_usd > 0`), realised USD, mean/best/worst multiple and USD, and cuts by pair age, 5-minute change sign,
  1-hour volume over mcap and discovery source (from `entry_features`).
- LLM: InferenceRouter `default` route (the NPC banter route; `gpt-4o-mini` in the baked config), 20 s time box,
  concurrency 2. The prompt carries the template thesis/risk, live params, hard rules, bounds, stats and the last 3
  reports. No player text (agent name) and no token symbol or mint reaches the prompt. The model's summary and
  observations go through `redactArenaText` (queries.ts, the public routes' own add-on redaction) before they are
  stored, because a house report is public and the source cuts can name a player's paid add-on. Since D33 the
  suggestion and change reason is code text from `tunerChangeReason` (trade counts, edge and shuffle p only, at most
  200 characters), never model text, so no model output reaches the public param-change log.
  Failure or timeout: the report is written with a deterministic summary (`stats.suggestionCheck.llm = 'failed'`), and
  the tuner still decides (D33). Since D33 the model's reply is commentary only: code ignores any model proposal.
- Suggestion checks (code): a path in `FLOOR_ARENA_PARAM_PATHS`, never `limits.position_usd`, passes
  `validateFloorArenaParams`, and exactly one leaf differs (D33: the tuner runs these checks on each of its own
  candidates; the old 6-closed-trade suggestion gate is retired, every change or suggestion needs the gate below).
  House identity guard: the tuner moves only leaves the template already sets, never switches a filter or exit
  on or off, never changes `entry.rank_by`, a take-profit fraction or the leg count, keeps each moved leaf inside
  "half to double" of the template value (the gain above 1 for a TP or trail-arm multiple, the loss below 1 for the stop,
  +/-10 for a template 0), and keeps at most 4 leaves away from the template. Before D33 a failed check of a model
  proposal stored no suggestion, state `rejected`, reason in `stats.suggestionCheck`; since D33 a candidate that
  fails a check is simply not a change, and `stats.suggestionCheck.tuner.reason` says why no change was made.
- D27 + D33 change gate (every agent since D33; constants in `floor-arena/analysis-rules.ts`): the tuner (code, not
  the model) decides only after 20 closed trades on the current params (`below_sample` otherwise), and each candidate
  must pass `evaluateSuggestionEvidence`. Each closed trade on the
  current params is re-run through the engine's own `passesFilters` on its `entry_features` at the instant the engine
  judged it (`entry_features.judgedAt`, the entry tick time; `opened_at` is the later insert time, and older rows
  without `judgedAt` fall back to it; `tradeJudgedAt`), under the current and the new filters; a trade the new value adds a fail code to is EXCLUDED, else KEPT. Confirmed only when
  kept and excluded each hold >= 8 trades and the kept mean pnl_mult beats the excluded mean by >= 0.03. A looser
  filter excludes nothing, and exit, entry or limit changes are `not_evaluable`, so the tuner never proposes them.
  Reproduced on the 2026-09-30 Runner change (chg5m_max 41.48 -> 20.74: kept 13, excluded 7): refused.
  D33 (honest tuner): the tuner runs on every due report but TESTS only at trade-count checkpoints
  (`TUNER_CHECKPOINTS`: 20, 40, 80, 160, 200, 400, 800 closed trades on the current params), each checkpoint once per
  params version, at its own alpha (`TUNER_CHECKPOINT_ALPHA`: 0.01 for 20-160, 0.005 for 200, 0.0025 for 400 and 800;
  sum 0.05, the family budget per rule set). At a report it tests the largest untested checkpoint it has reached;
  skipped smaller checkpoints are forfeited. Between checkpoints it does not search (`waiting_checkpoint`, `needed` =
  the next checkpoint); after 800 it reports `budget_spent` and makes no automatic change until the rules change. At a
  checkpoint it searches ONE-filter tightenings (the house band for a house agent, the validation bounds for a user
  agent), keeps the best split with >= 8 per side, and computes a max-statistic shuffle test over every split it tried
  (`EVIDENCE_PERMUTATIONS` = 2000 shuffles of `pnl_mult`, seeded by `agentId:paramsVersion:n`). A change needs D27
  confirmed AND p <= that checkpoint's alpha. An auto-apply agent changes only then; a click-to-apply owner gets a
  `pending` suggestion only then. Every report stores
  `stats.suggestionCheck.tuner = { decision, reason, n, needed, checkpoint, alpha, best, p }` with reason
  `below_sample`, `waiting_checkpoint`, `budget_spent`, `no_candidate`, `not_significant`, `rate_limited`, `changed`,
  `suggested`, `params_changed` or `not_tunable`, so most reviews end with no change and each one states why. Why the
  checkpoints: a test on every report at p <= 0.05 is optional stopping; a reviewer simulation on pure noise changed
  about 25% of agents by 100 trades and 43% by 400. Seven fixed looks whose alphas sum to 0.05 keep that at most about
  5% per rule set (union bound).
- Apply: house agents auto-apply (source `house-tuner`, state `auto_applied`); user agents get `pending`, or
  auto-apply with source `suggestion` when `auto_apply_suggestions` is on. At most one automatic change per agent per
  30 min. The report is inserted first (`pending`, under a per-agent advisory lock; a report from the last 25 min makes
  it a duplicate, which covers two leaders during a failover). The apply then goes through `updateArenaAgentParams`
  (queries.ts, the one params writer the owner routes use too): it claims the pending report as `auto_applied`,
  re-checks `params_version`, and writes the param change and its event in one transaction. On a version conflict the
  report of every auto-apply agent (house, and user with auto-apply on) turns `rejected` with tuner reason
  `params_changed`, patched in the same UPDATE, which also drops `stats.suggestionCheck.evidence` (D33). Candidate values are cut to 3 significant figures before the
  splits are scored, rounded toward keeping the trade they came from (down for a min filter, up for a max filter).
  Events: `report`, then
  `param_change` ("Tuner changed <path> from <a> to <b>: <reason>").
- Memory (D29): EVERY full report of a user agent (not a short no-trade report, which returns before the memory write) is stored with `recordEarnedSkillLesson` as an earned-skill lesson of the
  owner's avatar (building `cron-automation`, teacher "Trading Arena analyst", provenance = the arena agent id): in the
  avatar's hosted ElizaOS runtime when it is warm in this API process (memory id seeded with the runtime agent id), else
  in the avatar-keyed `npc_memories` keyword store. Never lazy-starts a runtime, never throws, logs `store=eliza |
  npc_memories | none`. (Before D29 the write needed a warm runtime; runtimes sleep after 30 idle minutes, so staging
  held 0 arena memories.) Readers, all via `readEarnedSkillLessons`: the owner's avatar chat `POST /api/avatars/me/chat`
  (`tradingFloorLessonContext`: up to 3 lessons as `dynamicContext`, only for an owner with an arena agent, 1.5 s
  bound), the Trading Floor teacher chat (`world-teacher-chat.ts`), the hosted autonomy decide loop
  (`agent-autonomy-driver.ts`) and `GET /api/agent/:sessionId/skills/cron-automation/skill-memory`. The runtime's
  KnowledgeProvider does not read them.
- Exported for the apply route: `evaluateArenaSuggestion({current, path, to, template?})`.

## 7. Status log (newest last)

- 11:40Z: spec written; worktree created; research inputs: `ops/house-traders/research-20260930-clawpump/SUMMARY.md`.
- 11:45Z: build team started (Opus): arena-core (shared + DB), arena-engine (discovery, chain checks, pricing, engine),
  arena-api (routes, ClawPump writer, provisioning, add-ons, leaderboard, contest), arena-analysis (30-min reports +
  tools.json + manual §17c + Nori/orientation), arena-web (launch flow, desk panel, profiles), arena-board (3da: TV board
  + tape). Parallel inputs: strategy-designer (3 new templates), x402-vetter (paid feed catalog, $0.40 cap from Runner).
- 11:48Z: x402 vetter early finding: seerium feeds charge $0.10 per call (listing says $0.001); D9 price cap confirmed.
- 11:42Z: templates final (strategy designer): genesis, runner, dip-hunter, midcap-climber, late-bloomer (§3).
- 11:55Z: x402 vetting done (`ops/house-traders/X402_FEEDS_2026-09-30.md`): 16 candidates, 2 approved, both Nansen
  POST feeds: token-screener $0.01 (21/30 mints not in the free feeds, 4 new band passes) and smart-money dex-trades
  $0.05. Rejected: seerium (real price $0.10, payments failed), Birdeye x402 (needs a payment-identifier extension that
  ClawPump does not send), Otto/CoinGecko/Syra (resell free GeckoTerminal/DexScreener data), Heurist (6.7-day-old data),
  PayAI DEX Trending (Base only). Spend: 12 on-chain USDC transfers, $0.119 total, from the Runner wallet (61.330385 ->
  61.211385 USDC); Runner gained the `x402` skill, nothing else changed. Contract change: `FloorArenaAddon` gains
  `body` and `dedupeVary` (ClawPump's x402 route caches identical calls for 3-12 min and returns `duplicate: true`).
  Free source added: GeckoTerminal `trending_pools?duration=5m`.
- 12:13Z: arena-core done (38/38 then 40/40 arena tests, shared 159/0, tsc 0, PGlite migration ALL PASS on the live
  and CI paths). Lead decisions: D13 `top10_max_pct` null (off) in all templates; null or >= 100 never fails; a cap
  < 100 fails unmeasured coins (`top10_unknown`). D14 the Token-2022 hard rule reads "Token-2022: no transfer fee or
  risky extension" (the engine blocks every risky extension). D15 add-on poll floor 600 s at run time; token-screener
  catalog interval 600 s, dex-trades 900 s. Runner takes up to 3 entries per tick (C1 took every passing coin).
- 12:20Z: arena-engine done: leader (session advisory lock on a dedicated 1-connection client, 30 s self-check),
  6 free pollers, DexScreener enrichment (<= 114 req/min), chain checks (port of the Python runner's hard rules, 30-min
  cache, fail closed), entries 15 s / exits 10 s, $20 fixed. 80 tests pass; PGlite SQL smoke 11/11; read-only live run
  parsed all 6 sources. Accepted deviations: a sell quote > 35% above the mark counts as a quote failure; a SOL-side
  pool with no SOL price fails the reserve check closed; the trail arms at `trail_arm_mult` (no template uses a trail).
  NOT verified locally: live RPC chain checks (no Helius key locally) and single-leader behaviour across a real deploy
  flip -> verify on staging (`chain_verdict` rows, `/api/admin/floor-arena/engine/state`).
- 12:25Z: arena-analysis done: 30-min reports via `getInferenceRouter().generateText` (route 'default', size 'small';
  20 s time box, concurrency 2, deterministic fallback); tuner guard: 6 closed trades on current params before any
  suggestion, house changes only move leaves the template sets, within half-to-double of the template value, at most
  4 leaves away from the template, at most 1 auto change per 30 min. 11 agent tools (adds `clawville_arena_addons`,
  `clawville_arena_settings`), manual §17c as a `## 17c.` section (hosted runtimes chunk by `## `), PROTOCOL_VERSION
  73 -> 74, "Coming soon" launch copy removed from §17/§3a/orientation/Nori. Tests: analysis 29/0, knowledge 11/0,
  service lane 2811/0 (114 skip), shared 161/0, hatcher selftest 87/0; tsc 0 for api/shared/agent-templates.

- 12:30Z: arena-api done: `/api/floor/arena` mounted BEFORE `/api/floor` (that router's session middleware also
  matches `/arena/*`; a test pins it); `/me/*` chain = session -> requireAuthOrAgentSession -> non-guest ->
  ledger-capable -> noStorePrivate; writes 30/min, launch 5/min per account (human + agent share the bucket); new env
  `FLOOR_ARENA_ADDON_PAYMENTS_ENABLED`. ClawPump agent name `CV Arena · <name> #<8 of arena id>`; the writer refuses
  update/pay on any agent whose name does not start with "CV Arena" (house agents safe); provisioning is
  first-writer-wins across containers. Add-on caps: per add-on daily cap AND $5/day per agent. Tests: 79/0 (its
  files), arena services 180/0, api tsc 0; SQL on PGlite 6 tests / 62 asserts. The routes-dir suite shows 27
  pre-existing cross-file failures that also fail without the arena files (pass one file at a time).
  Lead decisions: D16 staging provisioning allowed but named `CV Arena (staging) · ...` when CLAWVILLE_ENV is not
  production; D17 engine pause is in memory on the process that receives the admin call (one api container outside
  deploy flips; acceptable for now); D18 the REST x402 response wrapper is confirmed with one real $0.01 Nansen call
  on staging before anyone says add-ons work. Unknown: ClawPump's per-account agent limit (a provisioning failure
  never blocks paper trading).

- 12:55Z: all build agents done; tree frozen and staged (79 files); doc path guard passes (599 refs).
- 12:56-13:04Z: Codex review (lead-run, prompt on stdin, `-s read-only`). r1 could not read the disk (Windows
  sandbox) -> r2 with the full numbered source of 20 files embedded (434 KB): `VERDICT: BLOCK`
  (`ops/house-traders/arena-review/codex_verdict_arena_r2.txt`). R3 (ClawPump writer), R6 (paper only), R8
  (validation) PASS. Blocking findings and the lead's fix decisions: (1) public profiles of player agents showed
  add-on config, wallet address and reports -> public view keeps params, status, stats, positions, trades, param
  changes; the rest is owner-only via /me (house agents keep everything); (2) public events could reveal coins a
  player's paid add-on found -> public events of player agents are entry/exit/param_change/status only, add-on
  sources shown as 'addon'; (3) add-on spend not atomic -> reserve the ledger row before paying; (4) two containers
  could create two ClawPump agents -> DB claim (`creating` state + lease) and a unique index on
  `clawpump_agent_id`, 12-char id suffix; (5) a near-zero sell quote closed a position at once -> a quote below
  0.5x a fresh mark counts as a quote failure (D4 fallback applies); (6) every player agent was contest-eligible ->
  eligible only when launched before the end AND >= 1 qualifying closed trade in the window. Non-blocking: sanitize
  vendor symbol/name at intake; public discovery verdict without internal `error`.

- 13:28Z: Codex r3 (fixed tree, fence 19a2553850ce): `VERDICT: BLOCK`. FIXED per Codex: r2 #3 reservation, #4
  claim + unique index, #7 vendor text, #8 public verdict. Lead decisions on the rest: D19 a player agent's params and
  param-change history are PUBLIC (the arena is a public strategy showcase; the founder wants players to watch
  strategies); D20 executed trades (positions, entry/exit events, tape) are PUBLIC for every agent; only add-on setup,
  wallet address, reports, suggestions and add-on SOURCES are private. Fixes ordered: #5 with no fresh mark a
  near-zero sell quote is a quote failure; after the D4 threshold the exit fills at the latest quote
  ('quote_confirmed'); #6 contest enrollment (`contest_id` set at launch before the end; eligibility requires it);
  #9 an unverified outcome keeps the catalog price reserved; #10 the reservation re-reads the agent's current add-on
  settings; #11 provisioning completion/failure writes are fenced by a claim token.

- 13:41Z: Codex r4 (fence ee19bab9d284): `VERDICT: BLOCK` on two points. FIXED per Codex: r3 #6 enrollment, #9
  uncertain charge kept, #10 settings re-read in the reservation transaction, #11 claim-token fence; R1, R3-R8, R10
  PASS. Lead decision D21: house agents' 30-minute reports and suggestions are INTENTIONALLY public (our own agents;
  players watch how a house strategy learns and tunes). Remaining defect ordered: r4 #1 a cached low sell quote must
  never become a fill after unrelated failures; `quote_confirmed` books only on current, repeated low quotes.

- 13:48Z: Codex r5 (narrow, engine exit fallback, fence 276f6d86a57e): r4 #1 FIXED (a cached quote is never a fill).
  Three new edge cases ordered: (1) a low quote followed by a lasting ClawPump outage never closed -> after 30 min of
  failures the position closes as 'unresolved' with NULL P&L, excluded from every stat; (2) the failure-run state is
  persisted on the position (`exit_run` jsonb) so a restart cannot book an old mark; (3) two low quotes confirm only
  when <= 5 min apart.

- 13:58Z: Codex r6 (narrow, fence c0f5b465a068): all three r5 items FIXED (unresolved close with NULL P&L; persisted
  run; 5-min low-quote window). Two new small items ordered: `sawLow` survives a > 5-min gap (no stale-mark fill once
  a low quote was seen; the 30-min unresolved clock is not extended by gaps), and the `exit_run` write is
  compare-and-swap.

- 14:16Z: Codex r7 (commit 720f6f57, rebased onto origin/staging f78b8f42): every r5 and r6 item FIXED. One new
  item: an older exit tick could overwrite a newer stored mark (needs overlapping exit ticks, which the leader lock
  and non-overlapping loops prevent; fixed anyway: stored-mark writes keep the newer timestamp). Lead decision: push to
  staging after this fix with its tests; Codex r8 runs in parallel; any r8 finding is fixed before promotion to prod.

- 14:20Z: PUSHED `315abf26` to staging (fast-forward on f78b8f42, workflow-scope token). CI run 36728304050: all 4
  gate jobs (incl. the Postgres-backed route tests), migrate (0070 applied to the staging DB) and deploy: success.
- 14:23Z: Codex r8 (on 315abf26): every r7 item FIXED; two new fallback-mark items -> follow-up commit `078e00d3`
  (not yet pushed; one staging build at a time). 14:33Z Codex r9: both r8 items FIXED; two more interleavings of the
  same class (marks kept in memory AND in the DB, with a slow sell quote between). Lead decision D22: remove the class,
  not the instance: the engine keeps NO in-memory marks; every exit decision reads the newest DB mark and re-reads it
  inside the booking transaction after the quote; a newer mark means lost race and re-decide next tick.

- 14:34Z: staging API serves `315abf26`; the engine runs: 5 house agents trading paper, discovery rows arriving
  (gecko:trending_5m, ds:*, bitget). 14:47Z live board: Genesis +$5.20 (6 trades), Dip Hunter -$2.55 (1), Runner
  -$7.87 (3, 1 death), Mid-Cap Climber and Late Bloomer open positions only.
- 14:47Z: Codex r10 (on 8f5b80f2, single mark source): every r9 item FIXED. One new item: re-judge mark freshness
  inside the booking transaction (a mark can age past 60 s during the quote). LIVE finding by the lead: a TP leg fired
  on the DexScreener mark but the sell quote realised a loss ("Genesis exit SAID reason tp pnl -0.096"). Decision D23:
  a TP leg sells only when the QUOTED multiple reaches the TP multiple (as the Python runner did); otherwise hold and log
  'tp_not_confirmed_by_quote'; stops, trail and time exits still sell at the quote.

- 14:49Z: verifier A (staging 315abf26) steps 1-3 PASS; launch as landtest1 created ClawPump agent
  136de7ec "CV Arena (staging) · LandTest1 #4821bfae4287" in 2 s (private, no bids, stopped) BUT it kept ClawPump's 6
  default skills (action-plans, web-browsing, private-transfers, bitget-intel, self-learning, skill-management; no
  trading skill). Fix ordered: provisioning reads the agent back and strips any denied trading/spending skill, else
  fails with `clawpump_denied_skill_present`.
- 14:58Z: Codex r11 (on fcc60ed2): TP rule reaches stop/trail/time (OK); two items ordered: wall-clock freshness under
  the position lock right before booking; the TP-skip path persists the low-quote guard.

- 18:54Z: (session limit paused work 15:10-18:54Z) PUSHED `758177db` (Codex r8-r11 engine fixes, TP-by-quote, skill
  read-back, two release-gate script fixes, deploy-status entry).
- 18:58Z: verifier A final report on 315abf26: steps 1-6 PASS. x402 add-on end to end: one real Nansen token-screener
  call via ClawPump's REST x402 route (D18 confirmed): ledger row state done, $0.010, 50 mints (37 not in the shared
  feed), private to the agent; the agent traded 5 of them; public views show only 'addon'. Spend: $0.01 left
  ClawVille's account; Runner moved 0.05 USDC to the test agent wallet (Runner whitelist added then removed).
  NEW FACT: ClawPump's 6 default skills are sticky (PATCH only toggles x402), so the 758177db deny list (which included
  private-transfers) would fail every new provision -> D24: private-transfers is a platform default, allowed; every
  non-default trading/spending skill stays denied. Fix build follows.
- 18:55Z live board after ~4.5 h: Mid-Cap Climber +1.21 (4 trades, 0 deaths), Late Bloomer -10.94 (11, 0), Dip Hunter
  -19.13 (15, 0), Genesis -53.74 (44, 5 deaths), Runner -110.08 (20, 9 deaths; the Python C1 had 0 deaths in 15).
  Analysis of the deaths (real vs artifact, first-sight source, tuner changes) in progress.

- 19:05Z: deaths analysis (`ops/house-traders/arena-review/ARENA_DEATHS_2026-09-30.md`): all 14 deaths are REAL
  collapses (valid ClawPump sell quotes; DexScreener marks agree on 12/14 within 2%; GeckoTerminal candles on 13/14
  within 4%; no outage; 0 quote-failure skips). Cause = discovery: 19 of Runner's 20 coins were GeckoTerminal-only
  sightings (never seen by DexScreener or ClawPump): 9 TP, 9 deaths, -$114.45; all 19 later had 95-100% of supply in
  the pool. Genesis's 3 arena-only deaths vs the Python agent were also GeckoTerminal-only. Runner != C1 because the
  $5k liquidity floor (D5) blocks pump.fun curve coins (16 of C1's 18 trades). The tuner's one change (Runner
  chg5m_max 41.48 -> 20.74) was not supported by the data. Lead decisions: D25 a shared-feed coin is tradeable only
  after a DexScreener or ClawPump sighting (GeckoTerminal-only coins shown, not traded; add-on mints exempt); D26 the
  $5k liquidity floor stops being a hard rule (the founder's hard rules stay: LP burned/locked with curves OK, mint +
  freeze authority revoked, no risky Token-2022 extension, pool reserves present) and Runner follows C1 (liq_min
  null, first sight counted from the first DexScreener/ClawPump sighting, param `entry.first_sight_sources`); D27
  the tuner auto-applies only with >= 20 closed trades on current params and a deterministic split check (n >= 8 per
  side, >= 3 points better); house agents reset to template v2 (migration 0072 adds `source_first_seen`,
  `template_version`); every exit quote refusal is logged. The contest window starts clean at 22:00Z, so rows are
  not reset or deleted.
- 19:46Z: PUSHED `66b710e7` (D25-D27, protocol 75, migration 0072). 19:47-19:49Z Codex r12 on the diff: BLOCK, 2
  findings. (1) A discovery row written before D25 has tradeable sources with no recorded time; the next sighting
  would record them at NOW, so an old coin could look freshly seen to a 'tradeable' clock. Fix (lead): the hub
  writer records a previously known source without a time at the row's `first_seen_at` (the earliest time the hub
  knows); only a source new to the row gets now; a recorded time never changes. The reader already counts a missing
  time from `first_seen_at`. We have no per-source history before 0072, so for those rows the tradeable window can
  only close sooner, never open later; the effect ends when the rows expire (at most 24 h after first sight).
  (2) The D27 edge check compared rounded means (an edge of 0.02992 rounded to 0.03). Fix: compare raw means.
  19:51Z: CI run 36767948215 cancelled before the migrate step (the migrate job stopped at job setup), so 0072 is
  applied nowhere; staging stays on `758177db` until the fix build.
- 19:56Z: Codex r13 on the r12 fixes: VERDICT: APPROVE (finding 1 ACCEPTED-BY-DESIGN, finding 2 FIXED). PUSHED
  `9dc59f73`; CI run 36769198384 green (4 gates, migrate applied 0072, deploy); api + web SOURCE_COMMIT `9dc59f73`,
  flip 20:06-20:09Z, before the 22:00Z contest start. (Session pause 20:00-23:43Z; checks ran after it.)
- 23:44-23:47Z verifier A on `9dc59f73`, all PASS: (1) the 5 house agents at template_version 2 since 20:07:49Z,
  public param_changes "template updated to v2" (Runner: liq_min 5000 -> null, chg5m_max 20.74 -> 41.48 (the
  unsupported tuner change undone), first_sight_sources any -> tradeable); hard rules served = 5; (2) landtest2
  launch -> provision ready in 2.3 s, ClawPump agent 461c6357 "CV Arena (staging) · LandTest2 #251f806a850a", skills
  read back = the 6 sticky defaults only, private, not accepting bids; then paused, unseated; (3) 42 house entries
  after the flip: 0 GeckoTerminal-only, every one had a DexScreener/ClawPump sighting at or before entry; Runner
  6 of 8 on pump.fun curve coins, 0-70 s after the first tradeable sighting; (4) 16 TP exits after the flip, 0 with
  a loss (lowest 1.0915x); (5) `source_not_tradeable` fails 1,820 of 1,932 coins per scan; (6) landtest1 still
  paused. Observation (strategy, no code change): Genesis (no stop) had 4 real collapses on DexScreener coins.
  NEW DEFECT (medium, entry safety): D26 also removed the liquidity bound from the chain-check universe, so 95% of
  the check budget went to GeckoTerminal-only coins that are never bought; 309 of 390 tradeable coins had verdicts
  older than the 30-min TTL, and the entry gate never checked the verdict age (entries on verdicts 62-90 min old).
  Lead decision D28: chain checks select only shared coins with a tradeable source (private mints unchanged), oldest
  first; an entry needs a verdict younger than CHAIN_VERDICT_TTL_MS (30 min) on the current pair, else the fail
  code `chain_verdict_stale`; the entry event records the verdict time. Fix build follows.
- 2026-10-01: audit-contest (reported by the lead): scoring VERIFIED: the leaderboard matches the audit's own SQL
  recompute row for row; 185/185 entry fills and 176/176 exit fills match their ClawPump quotes. 25 house entries in
  the contest window (22:04Z-00:27Z) predate D28, so their entry events carry no `chainCheckedAt`; house agents only,
  no prize impact. Lead decisions from the audit: D30 (count positions opened in the window whatever their close
  time; audit D-A) and D31 (an `unresolved` close counts as a loss of its open stake in the contest score; audit D-B),
  both in build; P3 gains the test-account exclusions and the top-10 hand check.
- 2026-10-01 (later): D30 and D31 (arena-contest-impl: `leaderboard.ts`, `contest.ts` `standings` /
  `openWindowPositions`, 15-min final grace, later cut to 5 min when `opened_at` became the insert time), the contest rules text (arena-core: rules 2, 5, 6), B1 (`floor_arena.launch`
  / `floor_arena.seat` events with fp/ip hashes) and the reserved house names (`floor-arena/names.ts`, launch 400
  `name_reserved`) are in the working tree for the consolidated build; docs synced by arena-docs. Not yet committed.
- 2026-10-01: Codex chain on the contest build (D30, D31, rule 6, reserved names, the entry transaction bound);
  verdict files codex_verdict_arena_r19_contest.txt to codex_verdict_arena_r22_contest.txt in
  ops/house-traders/arena-review/ of the main checkout (not tracked).
  r19 BLOCK: (1) the 15-min final margin had no proven bound, so a late backdated entry could turn a `final` board
  back to `provisional`; (2) "GeΝesis" with a Greek capital Nu passed the name check. Fixes: `opened_at` and the entry
  event time = max(tick start, clock read inside the entry transaction right before the INSERT); margin cut to 5 min;
  the name key maps each EXACT character before any case change.
  r20 BLOCK: (1) the 5-min margin still had no database-enforced bound on a slow entry transaction; (2) the
  Cherokee look-alike "ᏀᎬneᏚᎥs" passed, because the hand table missed four letters; NON-BLOCKING: the backstop
  reserved "Ge猫esis". Fixes: `transaction_timeout` = `ENTRY_TX_TIMEOUT_MS` (60 s) and `statement_timeout` =
  `ENTRY_STATEMENT_TIMEOUT_MS` (30 s) set by the first statement of the entry transaction (a failed entry
  transaction rolls back and the tick skips the coin, `entry_tx_failed`); the hand table and the backstop replaced
  by a table generated from Unicode's UTS #39 confusables.txt (Version 18.0.0) plus the named extra folds
  (`FLOOR_ARENA_EXTRA_FOLDS`).
  r21 BLOCK: (1) PostgreSQL 17 does not restart an active transaction timer when its value changes, so a longer
  session or role default kept the longer timer; (2) "Ɠenesis" passed, because Unicode maps Ɠ to "G'" and the
  generator dropped prototypes with punctuation. Fixes: the same statement resets `transaction_timeout` to 0, then
  arms 60 s, in a CASE that skips on PostgreSQL before 17 (team probe on staging PostgreSQL 17.11 with a 10-min
  session timeout: without the reset a 1 s bound did not end the transaction; with it the session ended at 1 s);
  the generator cleans each prototype the way the name key cleans a name (NFD, marks removed, letters and digits
  only), regenerated with 2,263 entries.
  r22 VERDICT: APPROVE: all five findings FIXED, no new blocking finding. Codex could not run the repository tests
  (shell policy); the staging probe is team evidence. D30, D31 and rule 6 are now BUILT, not deployed. arena-docs
  re-ran the name key on the current tree: "GeΝesis", "ᏀᎬneᏚᎥs", "Ɠenesis", "G3nesis", "Genesi5", "ʀunner" refused;
  "Ge猫esis", "Genesis Two", "Generic" free; the generated table has 2,263 entries.
- 2026-10-01: single ClawPump writer (lead design after Codex r19 money, VERDICT: BLOCK with three blockers: #3 the
  writer's own last GET before a PATCH did not refuse a `running` agent; N7 a process treated its local "x402 absent"
  as proof and skipped re-checks; new: a stale `syncAgentConfig` row snapshot could add x402 back after another process
  removed it). Fixes: the writer guard (`isRemovalOnlyPatch`, payment needs stopped + x402 at the last read), the
  leader-only reconcile, and the row read under the per-agent advisory lock before each PATCH. In the working tree for
  the consolidated build, not committed, Codex money re-review pending. Only the engine leader writes to ClawPump;
  launch, `PATCH /me/addons` and the admin reprovision route write only the DB row; the provisioning tick is 30 s (was
  60 s) and starts with the x402 pass. A first version (v6) ordered a 10-agent reconcile by an in-memory record of what
  ClawPump showed (8 slots for changes and unknowns, 2 re-checks); audit-money's constraints replaced it with design v7:
  S4 removals with no throttle on the next tick plus a 10-agent id-cursor sweep, S2 a separate per-agent lock
  `floor-arena-x402:<id>` across GET, PATCH and verifying GET, the add-on tick reconciles right before paying
  (`ensureArenaX402ForPay`), S6 a 60-calls-a-minute writer rate limit per process, S7 the post-condition; no in-memory
  cache can skip a ClawPump read. Then design v8 (Codex r20 BLOCK on removal fairness + audit-money F, L, B): removals
  first each tick (R1 fresh OFFs, no cap; R2 a fair 6-per-tick cursor over all add-on-free agents; R3 retries, oldest
  first), then 4 re-checks only when nothing was deferred; provisioning never adds x402 and only the add-on tick adds
  it, right before paying (at most 8 adds a tick, none while a removal is deferred, per-agent backoff 1-30 min); the
  lock became `pg_try_advisory_xact_lock` with `statement_timeout` 30 s (a busy agent is skipped, never waited on);
  the writer budget became 60 a minute with a burst of 10, the last 5 tokens for removals, `budget_exhausted` before
  sending. Then v8b (Codex r21 + lead D32): D32 makes x402 removal hygiene, not a money control (§1); R1 is
  keyset-paged with no row limit and uses a DATABASE-time watermark, and the first pass of each leader term covers
  every add-on-free agent; a failing removal backs off 30 s to 30 min; one x402 section at a time per process; the x402
  transaction is bounded (`statement_timeout` 30 s, `transaction_timeout` 60 s on PostgreSQL 17). It replaces the money
  audit N7 design (an immediate `removeArenaX402` on the last add-on off, plus a removal sweep of
  at most 10 agents a tick with a cursor), and launch and reprovision no longer run a provisioning attempt in the
  request. Docs synced by arena-docs (§5, §6, D8; ARCHITECTURE, `docs/clawpump-integration.md`, GameFeatures §17g.3).
- 2026-10-01 02:43Z: verifier A on staging `90939209` (api flip 00:28:25Z, web 00:31:33Z, both SOURCE_COMMIT
  909392095a6b, restarts 0). D28 PASS: 55 entries since the flip, all with `data.chainCheckedAt`; max verdict age at
  entry 29.64 min, 0 at or above 30 min; insert-gate skips 0; tradeable in-universe verdict age median 7.3 min, p90
  16.5, max 29.7, 0 older than 30 min (was median 64 min on `9dc59f73`); 0 checks on shared GeckoTerminal-only rows in
  10 min (the 5 GeckoTerminal-only rows checked were also private add-on mints); 0 TP exits with negative P&L since
  the flip. D29 live test on landtest2 (arena 251f806a, avatar 372a0ce6, hosted runtime 8025ea44), paper only, no
  USDC: COLD report 853993f7 (02:10:32) -> `npc_memories` 598f01fd (entity avatar, target cron-automation, subtype
  earned-skill, teacher 'Trading Arena analyst') + log "report memory store=npc_memories"; the skill-memory read
  through an agent session returned it; owner `/api/avatars/me/chat` (lazy-started the runtime) quoted it ("146
  minutes ... zero closed trades ... $0 realized"). WARM report 9dcde48a (02:40:38) -> log "report memory
  store=eliza" -> ElizaOS row f88a7851 (agent_id 8025ea44, room earned-skill:<avatar>, unique); the recomputed uuidv5
  seed `earned-skill:<agentId>:<avatarId>:cron-automation:<text>` matches the stored id (without the agentId it does
  not), so the per-agent seed rule holds; the warm skill-memory read returned the 02:40 report (text only in
  ElizaOS); owner chat 2 quoted "11 trades, 54.5% win rate, realized loss $8.24" and the pending age_min_s 1800 ->
  7200 suggestion. Limit: the chat fold logs nothing, so its time inside the 1.5 s box was not measured.
  Observations sent to the lead: quiet reports are not stored (the text now says only full reports are stored); a
  warm read returns only ElizaOS rows and hides older `npc_memories` lessons (fix in progress). Teardown: landtest2
  paused and unseated; verifier A's connected session expires 2026-10-02 02:11:50Z.
- 2026-10-01 08:39Z-08:52Z (session tradeDeskMain): staging verify of the arena build `5049971e` (deployed head
  `9b3c1f93`, no api/packages change between the two; `origin/staging` `d8540db3` adds docs only).
  Server verify PASS (arena-verify-server, `ops/house-traders/arena-review/VERIFY_STAGING_9b3c1f93_2026-10-01.md`):
  SOURCE_COMMIT api + web and 4/4 `/health` = `9b3c1f93`; onboarding smoke 14/14; hosted skill runtime probe 125/125;
  served manual byte-identical to `buildProtocolManual` at PROTOCOL_VERSION 76; one engine leader; five house agents
  active and seated; 23 positions in the last 2 h; D28 53/53 entries with a verdict younger than 30 min (max 29.83
  min); D25 0 violations from the new code; 0 `entry_tx_failed`; x402 single writer clean but not exercised; 0
  floor-arena errors in the api logs. Browser verify PASS (arena-verify-browser, guest, 3 desktop and 7 touch sizes,
  `ops/house-traders/arena-review/browser-2026-10-01/BROWSER_VERIFY_2026-10-01.md`): board rows and tape match the
  API, the exit prompt follows the spec, the Exchange arena section and the guest prompt fit and dismiss at every
  size, 0 JS exceptions. Findings and where each went: server F1 (one pre-flip position with no `tradeableSource`,
  opened by the old leader) closed, info only; F2 (`standings: null` before the end) is the D30 spec, re-check after
  2026-10-05 03:59:59Z (D30 row); F3 (the x402 path ran no payment since the flip) -> D32 row, a live add-on call is
  owed and needs a founder go; F4 (this file's status drift) -> D6, D30, D31 and D32 rows updated here; F5 (manual
  "re-tuned about every 30 minutes" with 0 changes) -> arena-tuner-check found a DEFECT
  (`ops/house-traders/arena-review/TUNER_CHECK_2026-10-01.md`) -> new decision D33 (honest tuner) on branch
  `fix/arena-followups`. Browser F1 (a guest's `GET /api/wallet/link` returns 401 on every visit) and the guest
  tutorial card "You just created an AI-powered agent" -> web task A4 on `fix/arena-followups` (GameFeatures §13a);
  browser F2, F3 and F4 -> P6 notes; P8 (number-shaped names) -> FIXED on `fix/arena-followups`.
- 2026-10-01 (session tradeDeskMain, arena follow-ups review of `10cd060d`, not deployed): the D33 tuner moves to a
  checkpoint schedule (D33 row, §6a). Correction of the `10cd060d` commit message: it says "noise false-change rate
  4.0%". That figure is PER LOOK (one shuffle test on one pure-noise sample at p <= 0.05). It is not the rate per rule
  set. With a test on every report, the reviewer simulation on pure noise changed about 25% of agents by 100 closed
  trades and 43% by 400. With the checkpoints (20, 40, 80, 160, 200, 400, 800, each once, alphas summing to 0.05) the
  pure-noise change rate is at most about 5% per rule set. Same pass: §6a states that the model text, not the
  suggestion reason, goes through `redactArenaText` (the reason is code text from `tunerChangeReason`); P8 records
  that no staging agent name lacks a letter, so no rename; manual §17c, the `clawville_arena_settings` and
  `clawville_arena_launch` tool texts, GameFeatures §17g.3 and ARCHITECTURE state the checkpoints and the
  `name_needs_letter` rule (PROTOCOL_VERSION 77, unpublished, no new bump).

## 8. Punch list (tracked deferrals, rule E6)

| # | Item | Owner condition | Review deadline |
|---|---|---|---|
| P1 | Hosted runtimes that act only through `[ACTION:]` can read §17c but have no verb to launch or seat an arena agent (connected agents use tools.json). Add `[ACTION:]` verbs through the protected-surface process (§11 harness + Codex). | After the founder reviews the arena on staging. | 2026-10-07 |
| P2 | Live mode (D11) stays rejected; enabling it needs a founder go, the live execution path through the player's ClawPump agent, and a Codex money review. | Founder go. | 2026-10-14 |
| P3 | Contest payout (1,000,000 / 500,000 / 250,000 $CLAWVILLE) is manual; the team reviews the final standings for abuse before paying. The review EXCLUDES test agents (staging arena agent ids: LandTest1 `4821bfae-4287-4c92-8314-b7c949ef4999`, LandTest2 `251f806a-850a-4e69-a136-9d1c333892bb`, the ParityAudit agent `9b5839f1-03e5-4033-9e5a-8ce522bfaf91` with owner user `bd17a5e2-b536-4ee5-8eda-c59c3381ff7b` per audit-parity, and any later test agent), hand-checks every `unresolved` or `mark_fallback` position of the top 10, and uses the launch and seat fingerprint / IP-prefix events (B1, BUILT, passed audit-contest: `events` rows `floor_arena.launch` on every successful launch and `floor_arena.seat` on every sit, stamped with `fp_hash` and `ip_prefix_hash` by `logEventFromContext`; weight 0 in scoring, because the leaderboard scores named event types only and these are not among them; the review runs the read-only "P3 review query (B1)" and its companion query for agents with no launch event, at the end of §8). | Contest end 2026-10-05 03:59:59Z. | 2026-10-06 |
| P4 | RESOLVED 2026-09-30 (PROTOCOL_VERSION 75 -> 76): manual §17c now carries the D29 memory sentence ("Every full 30-minute report (not the short no-trade reports) is also stored as your avatar's own Trading Floor lesson ..."; verifier A: the quiet no-trade path never wrote memory, so the text was narrowed, not the code) and the D28 entry rule (a passing chain check of the CURRENT pool younger than `CHAIN_VERDICT_TTL_MS`, re-read right before the buy, no new on-chain check; `chain_pending` / `chain_verdict_stale` in `failCounts`); shared orientation and Nori say a player's arena trader keeps its reports as lessons. Recall wording (audit-parity T1-A): the owner's avatar chat can recall them; the Trading Floor teacher and the decide loop only for a HOSTED agent; a CONNECTED agent reads `GET /api/agent/:sessionId/skills/cron-automation/skill-memory`. Every 17c duration the analyst or the chain gate enforces (chain TTL, report cadence, quiet-report cadence, house change gap) is rendered from its constant (T1-C, E6.2; cadences in `analysis-rules.ts`). Orientation and Nori no longer say "no money moves": paid add-ons spend real USDC (audit-money B1). Still owed before promotion: the release gates (onboarding smoke, hosted-skill-runtime probe) and the §11 mock-Hatcher harness on staging for 76. | Done in code; gates with the staging push. | 2026-10-03 |
| P5 | No path returns unspent USDC from a player's arena ClawPump execution wallet (players can fund it for paid add-ons). A refund/withdraw path (or a cap on what the UI asks a player to send) is a founder decision; until then the UI warns: Solana USDC only, add-on spend only, not withdrawable through ClawVille (audit-money M3; `ARENA_WALLET_NO_WITHDRAW` under every copyable wallet address: "Send only USDC on Solana. You cannot withdraw USDC from this wallet in ClawVille, so send only what your add-ons will spend (at most $5 a day)."). | Founder decision. | 2026-10-05 (before prod promotion) |
| P6 | The floor TV's text is at the legibility limit from the /trading-floor spawn: the board is minified about 1.85:1 there (0.52-0.54 screen px per canvas px), so a 15-16 px Courier capital is about 5 screen px and some letters swap depending on sub-pixel phase (verifier B: "GENZSIS" single-level with regular text; "LANDTKST1" / "NO PRIZR" with trilinear mips, which were reverted). This build ships bold + single-level (best real-GPU evidence). Durable fix: larger glyphs at the spawn distance (about 22 canvas px fonts, about 6.5 screen px capitals), which means fewer rows and/or columns, e.g. no TEMPLATE text on house rows; design sketch + mock PNG prepared by arena-board for the founder. Same note: 3dStructure.md §9g Big board row. Three more notes from the 2026-10-01 browser verify (`ops/house-traders/arena-review/browser-2026-10-01/BROWSER_VERIFY_2026-10-01.md` F2-F4): (1) the armed Exit capsule ("the armed prompt always", as specified) paints over board rows 7-8 and the footer when a player stands in the door band; (2) the board tags a user agent with no contest trade "NO PRIZE" and shows no tag on an eligible one, while the Exchange modal says "No contest trade" and "Eligible": the two surfaces must use the same words; (3) at 390x844 the canvas renders the board at 273x590, cut off and unreadable, so the Exchange modal is the phone path to the same data. | After the founder sees the board on staging. | 2026-10-04 |
| P7 | E6.2 rest of manual §17c (audit-parity T1-C follow-up, arena-analysis 2026-09-30): three numbers in the 17c text are still typed, because their constants live in files the manual must not import or that have no exported constant: the `unresolved` exit clock ("could not be priced for 30 minutes", `EXIT_UNRESOLVED_AFTER_MS` in `engine.ts`, which pulls the engine into the manual graph), the route limits ("60 requests per minute", "30 changes or 5 launches in a minute", inline literals in `routes/floor-arena.ts`), and the death line ("0.5x or lower", `ARENA_DEATH_MULT` defined twice, in `analysis.ts` and `leaderboard.ts`). Fix: move each to an import-free module (`analysis-rules.ts` or `packages/shared` `floor-arena.ts`), import it from the engine, the route and the manual, and pin it in `floor-arena-knowledge.test.ts`. Today the values match the code. | Owners arena-engine (clock), arena-api (limits, death line); next arena build. | 2026-10-04 |
| P8 | FIXED on branch `fix/arena-followups` (2026-10-01, not deployed): an arena agent's launch name needs at least one letter, checked on the server (the launch route) and in the launch form (client), so a number-shaped name such as `-4200.00` is refused (400 `name_needs_letter`); with no name sent, an avatar name with no letter launches as `Arena Agent`. Existing rows: worker A4 checked the staging arena agents on 2026-10-01 and found no name without a letter, so no row is renamed and no migration ships. Was: the launch route's agent NAME rule (`/^[\p{L}\p{N} _.'-]+$/u` in `apps/api/src/routes/floor-arena.ts`) rejects `$` but accepts a number-shaped name such as `-4200.00`, which the board's leaderboard TRADER column would print beside the realised P&L column. The tape path is already guarded (`tapeTraderName` / `tapeSymbol` in `trading-floor-trade-tape.ts`, 2026-10-01, session coolerTrading: `$` stripped, decimal-number symbols dropped). Fix at the input: require at least one letter in an agent name (and decide whether to rename existing rows). Found by tfx-audit (session coolerTrading). | Arena owner (tradeDeskMain's successor lead); low risk, no money path. | 2026-10-10 |
| P9 | RESOLVED 2026-10-01 (session coolerTrading, lane C): the post-reveal 0.6-1.0 s stall is gone (WebGPU 550-617 ms -> 17-18 ms after the reveal; WebGL2 17 ms after the reveal with the 1.8-2.1 s warm freeze removed; a failed avatar no longer blocks the room). Ready gate waits for room + avatar (1500 ms fallback), late avatars compile hidden via chainPostBootCompile, GPU drain before ackReady, avatar error boundary. Record: 3dStructure.md §9i. | Done. | 2026-10-03 |
| P10 | A LATE player avatar (mounting more than 1.5 s after the room) on the WebGL2 backend still costs one 633-667 ms frame at its first visible draw, in the Trading Floor and probably in `/game`. Measured cause: the default avatar's (milady-official-1.vrm) 12 skinned meshes carry an 8-bit `JOINTS_0` skinIndex, so ANGLE D3D11 compiles a draw-time vertex variant that `compileAsync` does not cover; converting skinIndex to Float32 before the first draw removed the freeze in a page experiment (3/3 runs, same look). Fix in the VRM loader normalisation, WebGL backend only (WebGPU not tested); check the other avatars and `/game` too. Found by tfx-audit (session coolerTrading). | VRM loader owner (3da). | 2026-10-10 |
| P11 | Arriving from `/game` on the WebGL2 backend, the transition curtain freezes for 2.0-3.7 s over the after-fix runs (2.1-2.2 s before lane C): 22-23 synchronous program-link waits during the Trading Floor slot warm (pre-existing). WebGPU has separate 250-350 ms hitches before the reveal; their cause is not traced. It happens before the reveal, so nothing is drawn wrong, but the page is unresponsive. Candidate: poll `KHR_parallel_shader_compile` completion instead of blocking link-status reads in the stage warm, for every slot. Found by tfx-audit (session coolerTrading). | World-stage owner (3da). | 2026-10-15 |
- 12:03Z (date -u) arena-core: shared constants + DB contract landed; shared and database dists rebuilt. Files:
  `packages/shared/src/constants/floor-arena.ts` (+ test, 42 pass), `packages/database/src/schema/floor-arena.ts`,
  `packages/database/migrations/0070_floor_arena.sql` (0070 is free on origin/staging; checked on PGlite: applies twice, and
  after the Drizzle CI bootstrap). Deviations and additions, all additive:
  (1) templates = the lead's FINAL set and copy (TEMPLATES §5 values clamped: max_open 5, Runner entries_per_tick 3 and
  liq_min 5,000). Lead decision: top10_max_pct is null (off) on all five, because a set cap fails any coin whose top-10
  share is unmeasured; the 1..100 bound stays for players. Hard rule t22-fee label is now "Token-2022: no transfer fee
  or risky extension" (the engine blocks every risky extension). (2) Validation also requires liq_min, whole numbers
  for count/seconds fields, and strictly ascending tp multiples (positions store only remaining_fraction, so fired legs
  follow from the order). Bounds entries carry `nullable` and `integer`; exits bounds are tp_legs/tp_multiple/tp_fraction.
  (3) Extra exports: DB value-set arrays + types, jsonb types, FLOOR_ARENA_PARAM_PATHS, applyFloorArenaParamChange,
  FLOOR_ARENA_RANK_BY_LABELS, FLOOR_ARENA_EVENT_SUMMARY_MAX; every exported table is deep-frozen.
  (4) DB: child agent_id FKs and owner_user_id FK are ON DELETE CASCADE; CHECKs on every §4 value set plus
  owner_matches_kind (house = no owner, user = owner), closed_stamp, amounts > 0, remaining_fraction 0..1; unique OPEN
  position per (agent_id, mint); addon price_usd NOT NULL without default; extra indexes for per-agent reads, the
  events prune, addon_calls (agent_id, addon_id, at DESC), and the public trade tape (events id DESC WHERE type
  IN ('entry','exit')). CHECKs sit in a guarded DO block because drizzle-kit 0.24 emits none in the CI bootstrap.
  (5) Columns the engine/api code needed: floor_arena_agents provision_attempts, provision_next_at;
  floor_arena_private_mints last_seen_at, symbol, snapshot, snapshot_at, chain_verdict, chain_checked_at (+ mint index).
  (6) FloorArenaAddon per the lead: query nullable, body (POST JSON), dedupeVary {path, values: [number, number]};
  FLOOR_ARENA_ADDONS = the two approved Nansen POST feeds; token-screener minIntervalS 600 (D9), note $1.44/day. FloorArenaChainVerdict and FloorDiscoverySnapshot gained the
  engine's optional keys (codes, decimals, top10Pct, pairAddress, tokenProgram; liqBase, liqQuote, quoteMint, labels,
  symbol, name).
  (7) Codex BLOCK fixes (lead): unique partial index floor_arena_agents_clawpump_agent_uq (clawpump_agent_id WHERE NOT
  NULL), and provision_state gains 'creating' (CHECK + FLOOR_ARENA_PROVISION_STATES). Codex r2 (arena-api):
  floor_arena_addon_calls.state text NOT NULL DEFAULT 'done' CHECK IN ('reserved','done')
  (FLOOR_ARENA_ADDON_CALL_STATES); a reserved row at the catalog price precedes every payment.
  (8) FLOOR_ARENA_CONTEST.rules has 9 rules; the 6th (lead) is the prize eligibility rule: launched before the contest
  ends and at least one position opened and closed inside the window. D6 above does not state it yet (lead's row).
  (9) Codex r3 #5 (arena-engine): exit_fill_source gains 'quote_confirmed' (CHECK + FLOOR_ARENA_EXIT_FILL_SOURCES): no
  fresh mark, a sell quote below 0.5x the reference refused 3+ times over >= 45 s, exit filled at that latest quote.
  (10) Codex r5 (lead): floor_arena_positions.exit_run jsonb NULL; 'unresolved' added to exit_reason and exit_fill_source
  (CHECKs + FLOOR_ARENA_EXIT_REASONS / FLOOR_ARENA_EXIT_FILL_SOURCES); new CHECK floor_arena_positions_closed_pnl: a closed
  position has pnl_usd unless exit_reason = 'unresolved'.
  (11) D25/D26 (lead): FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES ['ds:', 'clawpump:'] + isFloorArenaTradeableSource(); new
  required param entry.first_sight_sources 'any' | 'tradeable' (FLOOR_ARENA_FIRST_SIGHT_SOURCES + _LABELS; Runner
  'tradeable', the rest 'any'); hard rule min-liquidity and FLOOR_ARENA_MIN_LIQUIDITY_USD removed; liq_min nullable
  0..50,000,000; Runner liq_min null; FLOOR_ARENA_TEMPLATE_VERSION 2; FLOOR_ARENA_VERSION 1 -> 2 (params shape changed).
  0070 is applied on staging, so new migration `packages/database/migrations/0072_floor_arena_sources.sql`:
  floor_discovery_mints.source_first_seen jsonb NOT NULL DEFAULT '{}', floor_arena_agents.template_version int NOT NULL
  DEFAULT 1, a backfill of entry.first_sight_sources = 'any' into stored params that lack it, and a backfill of
  source_first_seen = {first_source: first_seen_at} (UTC ISO) into existing discovery rows whose map is empty. Number note
  (lead): numbered 0072, not 0071, because branch chore/self-hosted-db carries 0071_special_event_start_guard.sql.
  ARCHITECTURE.md §8 now lists the tables and migrations 0070/0072 (arena-docs). deploy-status.md carries the SCHEMA
  line (prod-migration-pending: 0070_floor_arena.sql, 0072_floor_arena_sources.sql) since `66b710e7`.
  (12) audit-contest SHOULD-FIX (lead): FLOOR_ARENA_CONTEST.rules[0] no longer claims that no real money moves. It now
  reads: paper trading only, no vCLAW is spent and no real tokens are bought; optional paid data add-ons spend only USDC
  that you send to your agent's own wallet. Wording only: no number, window, eligibility rule, count or order changed.
  (13) D30/D31 rule text (lead): rule 2 adds "a position with no usable price for 30 minutes closes as unresolved and
  counts as a loss of its open stake in the contest score"; rule 5 counts positions opened inside the window including
  those that close after the end (final standings once the last closes); rule 6 = "...at least one position opened inside
  the contest window and closed." 9 rules, same order; floor-arena.test.ts pins all three.

### P3 review query (B1)

Provided by arena-api (2026-10-01; not in a repo file under the build freeze, so it is kept here verbatim). Run it
read-only on the database of the box where the contest ran (staging today; the recipe is the same, inside that
box's api container). arena-api ran it on PGlite fixtures: it found a shared device and a shared
network, and it excluded a non-contest agent and an event after the end.

```sql
-- P3 payout review, audit-contest B1: contest arena agents that share a device (fp_hash)
-- or a network prefix (ip_prefix_hash) on their launch or seat events. Read-only.
-- Contest: FLOOR_ARENA_CONTEST arena-week-1, ends 2026-10-05T03:59:59Z.
-- A launch can come before the contest start (it enrols while now < endsAt), so the
-- window filter is the end only; the contest itself is chosen by floor_arena_agents.contest_id.
WITH entries AS (
  SELECT e.ts, e.event_type, e.user_id, e.fp_hash, e.ip_prefix_hash,
         e.payload->>'arenaAgentId' AS arena_agent_id
  FROM events e
  JOIN floor_arena_agents a ON a.id = e.payload->>'arenaAgentId'
  WHERE e.event_type IN ('floor_arena.launch', 'floor_arena.seat')
    AND a.kind = 'user'
    AND a.contest_id = 'arena-week-1'
    AND e.ts <= '2026-10-05T03:59:59Z'::timestamptz
),
links AS (
  SELECT 'device' AS link, fp_hash AS link_hash, arena_agent_id, user_id, ts
  FROM entries WHERE fp_hash IS NOT NULL
  UNION ALL
  SELECT 'network', ip_prefix_hash, arena_agent_id, user_id, ts
  FROM entries WHERE ip_prefix_hash IS NOT NULL
)
SELECT link, link_hash,
       count(DISTINCT arena_agent_id) AS arena_agents,
       count(DISTINCT user_id) AS accounts,
       array_agg(DISTINCT arena_agent_id ORDER BY arena_agent_id) AS arena_agent_ids,
       min(ts) AS first_seen, max(ts) AS last_seen
FROM links
GROUP BY link, link_hash
HAVING count(DISTINCT arena_agent_id) > 1
ORDER BY link, arena_agents DESC, link_hash;
```

How to read it: it groups by device and by network SEPARATELY, because a pair grouping (fp_hash, ip_prefix_hash) would
miss one device used on two networks. A shared device is strong evidence. A shared network alone is weak (shared NAT,
mobile carriers, the same office). The query only lists candidates; the reviewer decides. Also exclude the listed test
agents (P3).

Agents launched BEFORE the B1 deploy have no `floor_arena.launch` event, so the cluster query cannot see them. List
them with this companion query (audit-contest) and review each one by hand as "no device data":

```sql
SELECT a.id, a.name, a.created_at FROM floor_arena_agents a
WHERE a.kind = 'user' AND a.contest_id = 'arena-week-1'
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_type = 'floor_arena.launch' AND e.payload->>'arenaAgentId' = a.id)
ORDER BY a.created_at;
```

On staging (2026-10-01) it would list LandTest1, LandTest2 and the ParityAudit agent. audit-contest ran the cluster query
read-only on staging Postgres: it parses and runs (0 rows, because no `floor_arena.*` events exist before the deploy).
