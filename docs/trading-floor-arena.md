# Trading Floor Arena (paper contest) — build spec + decision log

Last Audited: 2026-09-30 (session tradeDeskMain, lead). Status: IN BUILD on branch `feat/trading-floor-arena`
(worktree `.worktrees/trading-floor-arena`, base `origin/staging` a2a073a7).

Founder goal (2026-09-30, verbatim summary): five house trading agents on the Trading Floor, each running its own
strategy in PAPER mode with public results, fine-tuned about every 30 minutes, ranked on a P&L leaderboard on the
floor TV. Any ClawVille player walks into the Trading Floor, watches the house agents, and launches their own trading
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
| D2 | Shared discovery = table `floor_discovery_mints` filled by one poller per source (each source called once per interval, all agents read the table). Free sources: DexScreener token-profiles/latest, token-boosts/latest + top, ClawPump (Bitget) `/intelligence/signals` + `/signals/anomalies`, GeckoTerminal `new_pools` (Solana). | Founder's "dead letter queue": one call per source, every agent reads the same queue. Failed source calls retry with backoff and never block other sources. |
| D3 | Paper fills are priced with ClawPump `POST /swap/quote` (our Enterprise key, 10M calls/month); marks and triggers use DexScreener batch prices; costs 2.5% buy haircut + 1.0% sell haircut on top of the quote. No Jupiter key use. | Jupiter credits are nearly spent (22.5M/25M until Oct 7). Costs = measured execution cost (memory 09-21). |
| D4 | A quote failure never books a near-zero exit: retry the sell quote each exit tick; after 3 failures over >= 45 s, fill at the DexScreener mark minus costs and flag `fill_source='mark_fallback'`. | Lesson 13 (no-quote exits booked 0.01x during a ClawPump outage). |
| D5 | Hard rules (not editable, shown on every form): LP burned or locked >= 95%, mint authority revoked, freeze authority revoked, no Token-2022 transfer fee, pool reserves present, liquidity >= $5,000. | Founder rules (LP lock etc.); the liquidity floor removes bonding-curve coins (liq 0) that we cannot price safely. |
| D6 | Contest "Trading Arena Week 1": starts 2026-09-30 22:00Z (6 PM EDT), ends 2026-10-05 03:59:59Z (Sun Oct 4, 11:59:59 PM EDT). Score = realised paper P&L in USD of positions opened in the window and closed by the end. Fixed $20 per position, max 5 open. One arena agent per account; guests excluded; house agents shown but not eligible. Prize eligibility (after the Codex review): launched before the end AND at least one position opened and closed inside the window. Prizes 1,000,000 / 500,000 / 250,000 $CLAWVILLE, paid manually by the team after review. | "By the end of the week"; equal ticket size makes USD P&L comparable. |
| D7 | Seat gating: a user agent opens NEW positions only while seated at a Trading Floor desk. Seated is a server state set by "sit" and cleared by "stand"/leaving; it persists when the player closes the tab (the agent stays at its desk). Exits always run. House agents are always seated. | Founder: the agent must be in the arena to trade; persistent seat avoids "keep the tab open" contests. |
| D8 | Launch creates one ClawPump agent under ClawVille's account per user agent (name `CV Arena · <name>`, private, not accepting bids, no trading skills; `x402` skill only when paid add-ons are on). Provisioning failure does not block paper trading; it retries. | Founder requirement; paper mode needs no ClawPump execution yet. |
| D9 | Paid x402 add-ons: catalog of vetted feeds only; the engine pays from the agent's own ClawPump wallet via the ClawPump x402 route with `max_amount_usd` = catalog price; per-agent daily cap (default $1, max $5); poll interval per add-on >= 10 min; mints from an add-on stay private to that agent. | Vetting found listed prices 100x below real prices (seerium $0.10 not $0.001). Users pay for their own add-ons. |
| D10 | 30-minute analysis for every agent with activity: stats + an LLM summary + at most ONE suggested parameter change within bounds. House agents apply the suggestion automatically (logged publicly as a param change); user agents see it and apply with one click. The report is also written into the agent's ElizaOS memory when a runtime exists. | "Self-learning", "fine-tuning every 30 minutes". |
| D11 | Live mode is in the schema but rejected (`live_not_available`) until a later founder go. | Founder: start paper-only. |
| D12 | Agent parity: every arena write route uses `requireAuthOrAgentSession` and resolves the subject to its avatar; tools.json + manual §17c + PROTOCOL_VERSION bump + Nori/orientation lines in the same PR. No new `[ACTION:]` verb (tools.json only) to keep the protected executor untouched. | Rule E5 / three knowledge surfaces. |

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
/house/:id/params`, `POST /engine/pause|resume`, `GET /engine/state`.
SSE: reuse the world stream if cheap; else the client polls `/agents/:id/events` every 5 s.

## 6. Engine (`apps/api/src/services/floor-arena/`)

`leader.ts` (pg advisory lock, re-acquire loop), `discovery-hub.ts` (pollers + DexScreener enrichment + expiry),
`chain-checks.ts` (hard rules, 30-min cache; port of the Python runner's `chain_checks` / `lp_lock_fail` / reserve
check, reuse `trading-rpc.ts` / `trading-mint-info.ts`), `pricing.ts` (ClawPump quote fills + DexScreener marks),
`engine.ts` (15 s entry tick, 10 s exit tick), `analysis.ts` (30-min reports + house tuner), `provisioning.ts`
(ClawPump create/update agent), `addons.ts` (x402 polling + spend ledger), `leaderboard.ts`, `index.ts`
(`startFloorArena()` called from `apps/api/src/index.ts` next to the trade observer; env kill switch
`FLOOR_ARENA_ENGINE_ENABLED` default on).

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
  reports. No player text (agent name) and no token symbol or mint reaches the prompt. The suggestion reason goes
  through `redactArenaText` (queries.ts, the public routes' own add-on redaction) before it is stored, because an
  applied reason is public on the param-change log and the source cuts can name a player's paid add-on.
  Failure or timeout: the report is written with a deterministic summary and no suggestion (`stats.suggestionCheck.llm = 'failed'`).
- Suggestion checks (code): a path in `FLOOR_ARENA_PARAM_PATHS`, never `limits.position_usd`, passes
  `validateFloorArenaParams`, exactly one leaf differs, and no suggestion before the current params have 6 closed
  trades. House identity guard: the tuner moves only leaves the template already sets, never switches a filter or exit
  on or off, never changes `entry.rank_by`, a take-profit fraction or the leg count, keeps each moved leaf inside
  "half to double" of the template value (the gain above 1 for a TP or trail-arm multiple, the loss below 1 for the stop,
  +/-10 for a template 0), and keeps at most 4 leaves away from the template. A failed check stores no suggestion,
  state `rejected`, reason in `stats.suggestionCheck`.
- Apply: house agents auto-apply (source `house-tuner`, state `auto_applied`); user agents get `pending`, or
  auto-apply with source `suggestion` when `auto_apply_suggestions` is on. At most one automatic change per agent per
  30 min. The report is inserted first (`pending`, under a per-agent advisory lock; a report from the last 25 min makes
  it a duplicate, which covers two leaders during a failover). The apply then goes through `updateArenaAgentParams`
  (queries.ts, the one params writer the owner routes use too): it claims the pending report as `auto_applied`,
  re-checks `params_version`, and writes the param change and its event in one transaction. On a version conflict a
  house report turns `rejected` (`params_changed`); a user report stays `pending` for its owner. Events: `report`, then
  `param_change` ("Tuner changed <path> from <a> to <b>: <reason>").
- Memory: for a user agent whose avatar has a RUNNING hosted ElizaOS runtime, the report is stored with
  `recordEarnedSkillMemory` (building `cron-automation`; memory id seeded with the runtime agent id). No runtime: skipped
  with a log line; never lazy-starts a runtime.
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

## 8. Punch list (tracked deferrals, rule E6)

| # | Item | Owner condition | Review deadline |
|---|---|---|---|
| P1 | Hosted runtimes that act only through `[ACTION:]` can read §17c but have no verb to launch or seat an arena agent (connected agents use tools.json). Add `[ACTION:]` verbs through the protected-surface process (§11 harness + Codex). | After the founder reviews the arena on staging. | 2026-10-07 |
| P2 | Live mode (D11) stays rejected; enabling it needs a founder go, the live execution path through the player's ClawPump agent, and a Codex money review. | Founder go. | 2026-10-14 |
| P3 | Contest payout (1,000,000 / 500,000 / 250,000 $CLAWVILLE) is manual; the team reviews the final standings for abuse before paying. | Contest end 2026-10-05 03:59:59Z. | 2026-10-06 |
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
  Owed by the lead: ARCHITECTURE.md §8 table list + migration 0070, and `prod-migration-pending: 0070_floor_arena.sql`.
