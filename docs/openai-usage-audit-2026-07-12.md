# OpenAI usage audit — 2026-07-12

Founder question: "How are we using so much OpenAI if it's just chat generations? I think autonomous agents on staging are using chat inference we don't need — more on in staging than prod."

## Verdict

**The autonomous agents are NOT the burner.** Both boxes route the agent fleet + hosted-user agents local-first (`INFERENCE_ROUTE_FLEET` / `INFERENCE_ROUTE_HOSTED_USER = local-secondary,local-primary,openai`), and the live counts confirm it: staging has 1 autonomous agent (Coralia, house), prod has 2 (Coralia + 1 enrolled user agent), all served by the qwen boxes (`[InferenceRouter] served route=fleet by=local-secondary …` in logs; 103 local-served on staging / 710 on prod in the sampled window).

**The burner is the ambient NPC↔NPC banter layer** (`npc-simulation.ts tryStartConversation` → `npc-conversation-engine.ts` → router route `default`, which was OpenAI-only by baked default). It runs with **no human-presence gate** at a metronomic rate on BOTH boxes:

| Box | Banter conversations/hour (measured) | Per day |
|---|---|---|
| staging | ~410 (1,173 in the 3.5h since last redeploy) | ~9,800 |
| prod | 407–420, flat for 17 straight hours | ~9,800 |

Each conversation = 1 chat completion (gpt-4o-mini, ~500–700 tokens in, ≤400 out). ≈ **19,600 OpenAI calls/day total, ~$3–6/day, ~$100–180/month — for chatter no one is watching.** By call count this is effectively 100% of ClawVille's OpenAI traffic when no users are online (teachers/Nori are user-triggered; embeddings are negligible; moderation endpoint is free).

## The receipt: account is quota-dead AGAIN

Both boxes started throwing `429 insufficient_quota` at **2026-07-13T01:16Z, the same minute** — they share one key (`sk-proj-DWkVd…`). The top-up from 2026-07-10 lasted ~2.5 days. Until billing is restored, every OpenAI-backed path is down on prod: teacher/Nori chat, hosted-user OpenAI fallback, transient NPC chat. Banter degrades invisibly (canned-line fallback), which is why nothing "looks" broken.

Ruled out:
- **Codex reviews** — `codex login status` = "Logged in using ChatGPT" (the $200/mo sub), not the API key.
- **`OPENAI_LARGE_MODEL=gpt-4o` teacher turns** — the 2026-07-10 `gpt-4o-mini` pin is live in both containers.
- **Enrolled-autonomy pileup on staging** — `openclaw_bots.autonomy_enrolled`: staging=0, prod=1.

Not ruled out: the local tooling key in `~/.itachi-api-keys` is a DIFFERENT project (`sk-proj-qYxmG…`) but possibly the SAME OpenAI org — quota is org-level. Check platform.openai.com → Usage → group by project to see the split.

## Fix

**Superseded mitigation (REVERTED):** `INFERENCE_ROUTE_DEFAULT=local-first` env rows were created on both api apps ~01:45Z, then DELETED ~02:05Z on founder direction — the local GPU capacity is reserved for the agent runtime (~20 concurrent agents comfortably on the primary box); banter must not compete for it. Both apps are back to exactly pre-audit env.

**The real fix (founder-directed, 2026-07-13): watcher-presence gate + hard budget — banter is "just for entertaining users," so it costs nothing when nobody is watching, and is bounded even under abuse.** Branch `fix/banter-watcher-gate`, three rounds (Codex adversarial review after each; round-1 and round-2 HIGHs all fixed):
- **Arming signal = visibility heartbeat ONLY**: the web client POSTs `/api/npc/watch` every 30s while the tab is visible (`use-watch-heartbeat.ts`, mounted by both stream hooks — /game, /arena, /perf); server latch expires after 90s. SSE connections do NOT arm (Codex HIGH #1 — hidden/abandoned tabs keep EventSource open and would hold the gate open indefinitely); the public REST `/api/npc/state` does NOT arm (Codex HIGH #2 — one crawler request a minute would force continuous paid inference); agent sessions get 204 without arming.
- **Hard hourly LLM budget** independent of the latch: `NPC_BANTER_HOURLY_LLM_CAP` (default 120/hr ≈ $0.03/hr worst case; 0 = LLM banter off). /watch stays unauthenticated by design (anonymous explore visitors are the acquisition funnel), so the latch is spoofable — the budget bounds what any spoofer can burn.
- Gated-off conversations use `generateCannedConversation` (zero LLM, any backend); conversations still exist, so snapshots and agent perception keep their shape. Log markers `(canned, unwatched)` / `(canned, capped)` / `(npc-legs canned, …)` = greppable burn meter.
- **Round 3 (Codex round-2 HIGHs):** (a) cap parser — `Number('') === 0` meant an UNSET `NPC_BANTER_HOURLY_LLM_CAP` silently disabled LLM banter instead of defaulting to 120; unset/blank/invalid/negative now default correctly. (b) **Server-managed agent cognition is never gated** — for hatcher-proxy/hermes-local bodies, ambient conversations ARE the cognition + `[ACTION:]` path, so `client.chat` + dispatch always run; only non-agent paid legs honor `allowNpcLlm` (canned when gated). Budget consumed only when watched AND a paid leg exists.
- Also repaired in-branch: the 3 pre-existing `partner-hatcher-p5-handler.test.ts` failures (fabricated rows missing `createdAt/updatedAt`; table-blind db stub letting post-commit wallet inserts clobber the agent row → PATCH 404). All suites green.
- **Round 4 (Codex round-3 HIGHs):** (a) budget is consumed **per paid request**, not per conversation — a mixed agent/NPC conversation makes up to two paid calls, so the old per-conversation unit understated spend 2× (engine `tryConsumePaidLeg` hook; refused legs go canned; `paid=N` in every start log). (b) **Accepted residual, founder to confirm:** the counter is per-process and resets on restart. Durable (Postgres) accounting was evaluated and rejected as disproportionate for a cosmetic-chat budget — it would add a schema table + prod-migration gate + a DB write per banter call, while two stronger bounds already hold regardless of counter state: the visibility heartbeat, and the sim cadence itself (≤1 conversation/8s × ≤2 paid legs ≈ $0.25/hr absolute worst case, only while a watcher heartbeat is live). The counter's job is killing the 24/7 idle burn, which a process-local window does fully. If the founder wants the durable version anyway, it's a small follow-up (singleton-row table + atomic upsert).
- **Round 5 (Codex round-4 MEDIUM):** heartbeat now requires the NPC stream to be CONNECTED (`useNpcStore.connected`), not just tab visibility — a visible tab with a dead stream (retry exhaustion, failed join) can't receive banter and no longer pays for it. Codex's re-raised durability HIGH remains the documented accepted residual (per-process counter; cadence-bound worst case) — with one addition to the founder checklist: **set an OpenAI project-level spending limit + alert in the dashboard before topping up**; that is the authoritative account-wide backstop Codex recommends and covers every consumer of the org, no code required.
- **Round 6 (founder ask — log detail):** the router now logs EVERY served inference request with token counts (`[InferenceRouter] served route=… by=… model=… in=… out=… <ms>ms`, cloud included — previously only local-served calls logged, which is why this audit had to reconstruct OpenAI volume from side effects) and every failed attempt (failover was silent). `grep "\[InferenceRouter\] served"` = the complete per-box inference ledger.
- Expected effect: ~19.6k calls/day → 0 while the world is empty; with users online, cost scales with actual audience; absolute worst case under abuse+crash-loop ≈ $6/day/box (cadence-bound), typical capped day ≈ $0.70/box.

**Remaining, in order:**
1. Ship `fix/banter-watcher-gate` through the normal loop (Codex adversarial review → staging → verify canned-marker logs + zero OpenAI banter calls with no browser open → founder sign-off → rides the next staging→master PR).
2. **Top up OpenAI billing AFTER the gate is live on prod**, not before — else the new credit burns on chatter again. (Prod is at master tip `9c6ac3a0`; the gate reaches prod via the next merge.)
3. Consider an OpenAI project-level usage limit + email alert so quota-dead is a warning, not an outage. Also check the usage dashboard per-project split — `~/.itachi-api-keys` carries a different project key (`sk-proj-qYxmG…`) that may share the same org quota.
4. Pre-existing debt found on the way: 3 `partner-hatcher-p5-handler.test.ts` tests fail on the clean staging tip `2b8a03e0` (mocked-db shape issues — `row.createdAt` undefined, override-already-registered). Not from this change; needs its own session.

## Reference numbers (how to re-measure)

```bash
# banter rate per hour
docker logs --timestamps --since 24h <api> 2>&1 | grep "Conversation started" | cut -c1-13 | sort | uniq -c
# quota state
docker logs --since 1h <api> 2>&1 | grep -c insufficient_quota
# what local boxes served
docker logs --since 24h <api> 2>&1 | grep -c "\[InferenceRouter\] served"
```
