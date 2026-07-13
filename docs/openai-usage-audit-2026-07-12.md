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

**The real fix (founder-directed, 2026-07-13): watcher-presence gate — banter is "just for entertaining users," so it costs nothing when nobody is watching.** Branch `fix/banter-watcher-gate`:
- `npcSimulation` tracks watcher presence: stamped by SSE listener add/remove on BOTH stream paths (`/api/npc/stream` legacy + `/api/world/:roomId/stream`) and by the REST `/api/npc/state` fallback; `hasActiveWatchers()` = any live SSE listener OR any watcher within a 60s grace window.
- `tryStartConversation`: unwatched → `generateCannedConversation` (the engine's existing canned pool, zero LLM calls, on any backend); watched → LLM paths unchanged. Conversations still exist unwatched, so snapshots and agent perception keep their shape.
- Log marker `Conversation started (canned, unwatched):` = greppable burn meter.
- Expected effect: ~19.6k calls/day → ~0 while the world is empty; while users ARE online, worst case is the old rate (~410/hr ≈ $0.10/hr on gpt-4o-mini) — cost now scales with actual audience.

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
