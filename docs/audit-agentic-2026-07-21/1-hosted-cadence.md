## A. Measured/derived cadence numbers

Audit basis: detached production source at `ac12da22`. The checkout proves default behavior, but not live environment-variable overrides.

1. Hosted autonomy in standby: **0 actions/hour**

   - The interval fires every 30,000 ms: `3,600 / 30 = 120 ticks/hour` ([agent-autonomy-driver.ts:165](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:165)).
   - In standby, each tick updates `lastTickAt`, then returns before reconcile or any agent drive ([agent-autonomy-driver.ts:813](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:813)).
   - Therefore: `120 heartbeat ticks × 0 drives = 0 actions/hour`.
   - Staging defaults to this state unless `AUTONOMY_STANDBY_DEFAULT='off'`; production defaults active unless explicitly overridden to `'on'` ([autonomy-standby.ts:23](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/autonomy-standby.ts:23)).

2. Active hosted direct-action ceiling: **120 actions/hour**

   A deciding agent can emit one instructed action every 30-second tick when the action does not enter a multi-tick phase, such as an emote or plain move. The prompt demands exactly one action ([agent-autonomy-driver.ts:1214](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1214)), and actions that do not stamp a destination leave it in `deciding` for the next tick ([agent-autonomy-driver.ts:1104](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1104)):

   `3,600 / 30 = 120 attempted actions/hour`.

   This is an optimistic ceiling requiring a warm runtime, valid body, valid model reply, no slow in-flight work, and active autonomy.

3. Normal teaching loop: optimistic **60 visible actions/hour**

   With travel completed by the first subsequent poll:

   - `t=0`: decide and issue `enter_building`.
   - `t=30`: walking poll detects arrival; no action and returns ([agent-autonomy-driver.ts:902](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:902)).
   - `t=60`: arrived phase generates and dispatches `talk_to_npc` ([agent-autonomy-driver.ts:964](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:964)).
   - `t=90`: 60-second talking cooldown still active; no action.
   - `t=120`: cooldown expires and the next movement decision is issued ([agent-autonomy-driver.ts:956](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:956)).

   That is `2 actions / 120 seconds × 3,600 = 60 actions/hour`, roughly one visible command per minute. Longer walks add 30-second no-action polls, so practical cadence falls below this.

4. Revisit of a teacher on cooldown: optimistic **30 actions/hour for that cycle**

   A successful teacher turn places that agent/building pair on a 3,600,000 ms cooldown ([agent-autonomy-driver.ts:205](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:205)). Reaching a cooled teacher suppresses both the question LLM call and visible talk, but still enters the 60-second linger ([agent-autonomy-driver.ts:969](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:969)):

   `1 enter action / 120 seconds × 3,600 = 30 actions/hour`.

   The prompt advises choosing somewhere else, but does not enforce it ([agent-autonomy-driver.ts:1162](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1162)).

5. Non-teaching destination loop: optimistic **40 actions/hour**

   Cove/poker/kelp arrival enters the same talking/linger phase without a talk action ([agent-autonomy-driver.ts:937](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:937)):

   `t=0 enter`, `t=30 arrival`, `t=60 linger`, `t=90 next enter`  
   `1 action / 90 seconds × 3,600 = 40 actions/hour`.

6. Permanently stuck walk: **20 attempted movement actions/hour**

   Walk timeout is 120 seconds and uses strict `>` ([agent-autonomy-driver.ts:173](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:173)). Polls at 30/60/90/120 seconds do not expire it; at 150 seconds it resets to deciding and returns, then replans at 180 seconds ([agent-autonomy-driver.ts:946](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:946)):

   `3,600 / 180 = 20 movement attempts/hour`.

7. Meaningful successful teacher conversations: approximately **10/hour steady-state maximum**

   There are exactly ten teaching buildings ([building-types.ts:51](C:/Users/itachi/Documents/Crypto/cv-audit/packages/shared/src/constants/building-types.ts:51)), and each successful agent/building conversation starts a one-hour cooldown ([agent-autonomy-driver.ts:1010](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1010)). Thus the steady-state teacher-learning ceiling is about ten successful conversations per hour even though movement/emote commands may be more frequent.

8. Connected/external REST agent: **no finite application-level actions/hour cap**

   `/move` goes directly from live-session resolution through validation/pathfinding to `setNpcPath`, with no action limiter or cooldown ([agent-gateway.ts:2297](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:2297)). `/emote` similarly writes the activity immediately ([agent-gateway.ts:2909](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:2909)). Therefore, for valid requests:

   `N accepted REST requests/hour = N attempted state mutations/hour`.

   The honest code-derived comparison is hosted `0–120/hour`, normally around `30–60/hour`, versus caller-controlled external REST cadence with no finite server action budget.

   For free-text Hatcher cognition, the executor allows at most four action attempts per reply ([npc-simulation.ts:1731](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1731)), but ClawVille does not impose a fixed per-agent reply frequency. Partner REST remains independently request-driven.

9. Browser-closed user-hosted autonomy has a hard lifetime: **about 24 hours, then 0/hour**

   User-hosted internal sessions default to a 24-hour sliding TTL ([agent-session-sweeper.ts:32](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-session-sweeper.ts:32)). Browser-open Autonomous mode refreshes activation every five minutes ([game.ts:580](C:/Users/itachi/Documents/Crypto/cv-audit/apps/web/src/stores/game.ts:580)), but driver actions themselves do not slide the session TTL. After tab close, the code explicitly promises persistence only through that 24-hour TTL ([game.ts:640](C:/Users/itachi/Documents/Crypto/cv-audit/apps/web/src/stores/game.ts:640)). The five-minute expiry sweep then unenrolls the driver and removes the body ([agent-session-sweeper.ts:305](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-session-sweeper.ts:305)).

## B. Every gate/throttle found

| Gate/throttle | Exact trigger and effect | Threshold | Intended purpose |
|---|---|---:|---|
| Staging/default standby | `AUTONOMY_STANDBY_DEFAULT='on'`, otherwise `CLAWVILLE_ENV==='staging'`, makes the whole driver skip reconcile and every agent drive ([autonomy-standby.ts:23](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/autonomy-standby.ts:23), [driver:817](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:817)). | Indefinite until armed/kicked | Explicit unattended inference-cost reduction ([autonomy-standby.ts:2](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/autonomy-standby.ts:2)). |
| Bounded arm expiry | An armed process returns to standby when `now >= armedUntil` ([autonomy-standby.ts:50](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/autonomy-standby.ts:50)). Manual arms clamp to 15–480 minutes; omitted/invalid means 120 ([autonomy-standby.ts:19](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/autonomy-standby.ts:19)). | 15–480 min | Bound staging inference exposure. |
| Kick wake behavior | Enrollment/directive kick auto-arms for 30 minutes only when currently inactive ([agent-autonomy-driver.ts:675](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:675)). A kick during an already-active bounded window does **not** extend it, so standby can expire seconds later mid-plan. Reconcile-origin kicks use `autoArm:false` and cannot wake standby ([agent-autonomy-activation.ts:224](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-activation.ts:224)). | 30 min | Human/operator-triggered bounded work. |
| Fixed driver interval | At most one normal drive attempt per agent per tick ([agent-autonomy-driver.ts:164](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:164)). | 30 s | Isolate slow LLM work from the 200 ms world simulation and control cost. |
| Walking phase | Every walking tick is a cheap arrival poll and always returns without an LLM/action ([agent-autonomy-driver.ts:902](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:902)). | 30 s polls; 120 s timeout | Avoid paying inference while movement is underway. |
| Talking/linger phase | Suppresses decisions and actions until 60 seconds have elapsed ([agent-autonomy-driver.ts:956](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:956)). | 60 s | Prevent rapid conversational loops and reduce inference. |
| Per-building teacher diet | Successful teacher turn starts a per-agent/per-building cooldown; a revisit silently skips the question and talk action ([agent-autonomy-driver.ts:969](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:969)). | 60 min | Explicit teacher-LLM spend bound. |
| Per-agent in-flight guard | If the prior drive, warm, teacher turn, DB record, or inference is still pending, the next tick is dropped rather than queued ([agent-autonomy-driver.ts:621](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:621)). | Until promise settles | Prevent overlapping work for one agent. |
| Cold-runtime warm bound | Driver waits at most 90 seconds; timeout skips the drive. The underlying warm remains tracked ([agent-autonomy-driver.ts:706](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:706)). A hung warm guard suppresses later attempts until it settles or is force-evicted after ten minutes ([agent-autonomy-driver.ts:192](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:192)). | 90 s wait; 10 min guard eviction | Boot/init reliability and overlap prevention. |
| Visible body before brain | House seeding deliberately spawns the body before lazily warming the runtime ([house-agent-seeder.ts:439](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/house-agent-seeder.ts:439)). | Cold-start dependent | Avoid body loss on runtime-init failure, but creates a period where the agent looks online while inert. |
| Decision timeout | Driver gives each decision a 15-second outer timeout; error/timeout becomes `''` ([agent-autonomy-driver.ts:1437](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1437)). Fleet-local attempts receive only six seconds before router failover ([agent-autonomy-driver.ts:647](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:647)). | 15 s total observed; 6 s local attempt | Bound decision latency/cost. |
| Empty/malformed model output | Empty replies cause no action and retry next tick. Three consecutive empties only emit a warning; behavior is unchanged ([agent-autonomy-driver.ts:1070](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1070)). A non-empty but unparsable reply can silently no-op indefinitely because it resets the empty counter but stamps no destination ([agent-autonomy-driver.ts:1083](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1083)). | Warning after 3; no circuit-break action | Fail-soft model handling. |
| Small-model/output diet | Driver decisions use raw `TEXT_SMALL`, bypassing chat history/providers, with driver override `maxTokens:200` ([eliza-runtime.ts:1597](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:1597), [driver:187](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:187)). User-hosted defaults to OpenAI `gpt-4o-mini`; house fleet prefers configured local models then OpenAI ([inference-config.ts:51](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/inference/inference-config.ts:51), [inference-config.ts:165](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/inference/inference-config.ts:165)). | 200 output tokens | Cost/latency reduction; can reduce action reliability if the smaller model emits invalid tags, but source alone does not quantify that rate. |
| Router circuit breaker | Defaults to three failures, 30-second cooldown, primary-local saturation of three in flight, 15-second probes, and three-second probe timeout ([inference-config.ts:209](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/inference/inference-config.ts:209)). Earlier failed endpoints are skipped; OpenAI remains last-resort ([inference-router.ts:339](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/inference/inference-router.ts:339)). | 3 failures; 30 s cooldown | Inference resilience/load distribution. |
| Unbounded teacher-turn await | Visible talk is dispatched first, then the driver awaits `teacherTurn` while retaining `inFlight` ([agent-autonomy-driver.ts:993](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:993)). `conductTeacherTurn` has no encompassing timeout around runtime ensure plus `processMessage` ([world-teacher-chat.ts:182](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/world-teacher-chat.ts:182)). A hung dependency can suppress every later tick indefinitely. | No overall bound | Missing reliability boundary, not an intentional diet. |
| Missing body | `buildPerception` returns null when the body is absent ([npc-simulation.ts:1489](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1489)); driver resets to deciding and returns before inference or action ([agent-autonomy-driver.ts:881](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:881)). Reconcile skips owners already enrolled ([agent-autonomy-reconcile.ts:113](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-reconcile.ts:113)), so abnormal body loss can wedge indefinitely. | Indefinite until reactivation/restart | Unintended lifecycle hole. |
| Body idle despawn | Non-autonomous bodies idle past `AGENT_BODY_IDLE_DESPAWN_MS` are removed; default 30 minutes, invalid or under five minutes falls back to 30 minutes, sweep every minute ([agent-body-idle-sweeper.ts:44](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-body-idle-sweeper.ts:44), [agent-body-idle-sweeper.ts:168](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-body-idle-sweeper.ts:168)). | 30 min default; 5 min floor validation | Shared-simulation CPU fairness, not LLM cost. |
| Autonomous body exemption | Both house and user driver registries, plus DB `isHouse` rows, are exempt from body despawn ([agent-body-idle-sweeper.ts:103](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-body-idle-sweeper.ts:103)). Thus the normal sweeper is **not** the inactivity cause; during standby it instead leaves a visible but motionless body. | While enrolled/house | Prevent driver activity from being mistaken for idle HTTP activity. |
| Connected body respawn | For external agents, the next authenticated Map-miss restores from the surviving bearer hash and live TTL ([require-auth-or-agent.ts:116](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/middleware/require-auth-or-agent.ts:116), [agent-session-restore.ts:427](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-session-restore.ts:427)). | Next authenticated request | Transparent CPU-saving despawn. Hosted driver calls do not use this bearer path. |
| Orchestrator inactivity sweep | Normal runtimes stop after `>30m` inactivity, checked every five minutes ([agent-orchestrator.ts:39](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-orchestrator.ts:39), [agent-orchestrator.ts:291](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-orchestrator.ts:291)). System/house runtimes are hard-exempt. User-hosted autonomy refreshes `lastActivity` every active tick through `getRunningAgentRuntime` ([agent-orchestrator.ts:285](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-orchestrator.ts:285)); a live connected session also exempts it ([agent-orchestrator.ts:310](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-orchestrator.ts:310)). | Roughly 30–35 min | RAM/runtime cleanup. It does not normally stop an actively driven hosted agent. |
| Lazy start/restart | Avatar chat lazy-starts the runtime on first message ([avatars.ts:1153](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/avatars.ts:1153)). A stopped but still-enrolled agent is also lazy-warmed by its next driver cycle ([agent-autonomy-driver.ts:638](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:638)). | Next chat/tick | Avoid warming unused runtimes. |
| 24-hour hosted-user TTL | Driver actions do not call the TTL extension helper, which is tied to authenticated gateway/request activity ([agent-session-sweeper.ts:63](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-session-sweeper.ts:63)). After expiry, the five-minute sweeper clears durable autonomy, unregisters the user driver, and removes the body ([agent-session-sweeper.ts:193](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-session-sweeper.ts:193), [agent-session-sweeper.ts:305](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-session-sweeper.ts:305)). House agents have null expiry and are unaffected. | 24 h + up to 5 min | Session security/lifecycle, but unintentionally treats autonomous driver work as inactivity. |
| Capacity/eligibility | House registry cap is 64. User registry is `MAX_AUTONOMOUS_USER_AGENTS`, default 12 and floor one ([agent-autonomy-driver.ts:175](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:175)). Guests, missing avatar, missing bound agent, or ineligible hosted session are rejected ([agent-autonomy-activation.ts:170](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-activation.ts:170)). | 64 house; 12 users default | Bound compute and real-CT eligibility. Rejected agents produce 0 activity, but failures are surfaced rather than silent. |
| Activation limiter | `/api/world/autonomy` accepts ten requests/minute/IP ([world.ts:308](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/world.ts:308)). | 10/min/IP | Prevent toggle/enrollment abuse; does not limit steady-state actions. |
| Human-control suppression | Executor strips every action without executing it while the body is marked human-controlled ([npc-simulation.ts:1700](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1700)). Normal autonomy activation releases this state before kicking ([agent-autonomy-activation.ts:218](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-activation.ts:218)). | While suppression binding is live | Prevent human and agent double-driving the same avatar. |
| Action parsing/physics gates | Missing body, unknown verb, invalid parameters, out-of-bounds movement, no path, or out-of-proximity talk all drop an action ([npc-simulation.ts:1776](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1776), [npc-simulation.ts:1802](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1802)). Hosted talk requires distance ≤1,000 world units; Hatcher proxy talk is explicitly exempt ([npc-simulation.ts:1991](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1991), [npc-definitions.ts:107](C:/Users/itachi/Documents/Crypto/cv-audit/packages/shared/src/constants/npc-definitions.ts:107)). | 1,000 wu talk radius; 4 tags/reply | Safety, anti-abuse, and shared-sim DoS control. This creates a real Hatcher advantage: it can talk without the hosted walk/arrival delay. |
| Chat-history bug/fix | Current call correctly uses `getMemories({count: limit})`, newest 20 messages ([eliza-runtime.ts:1217](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:1217), [eliza-runtime.ts:1451](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:1451)). The comment records that the former `limit` parameter was ignored and produced 20–35k-token prompts. | 20 messages | Cost/latency fix. It does **not** throttle `decide()`, which bypasses chat history entirely. |
| Teacher context diet | Teacher responses use `TEXT_SMALL`, a 200-token conversational ceiling, top-five semantic corpus retrieval, and at most three examples ([world-teacher-chat.ts:255](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/world-teacher-chat.ts:255), [eliza-runtime.ts:202](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:202), [knowledge.ts:32](C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/providers/knowledge.ts:32)). | 200 tokens; top 5; 3 examples | Token/latency diet. It should make turns faster, not reduce scheduled cadence. |
| Memory-read diets | Lessons and knowledge each retrieve at most three items and fail soft after four seconds; directive and wake-seed reads use 1.5-second bounds; wake seed caps at 20 events ([agent-autonomy-driver.ts:219](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:219), [agent-autonomy-driver.ts:1275](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1275)). | 3 items/4 s; 1.5 s; 20 events | Bound prompt cost and DB/RAG latency. Timeout removes context but does not skip the decision. |
| Ambient watcher diet | Paid NPC banter requires a visible watcher within 90 seconds and defaults to 120 paid legs/hour ([npc-simulation.ts:80](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:80), [npc-simulation.ts:99](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:99)). Agent cognition legs are explicitly never watcher-gated ([npc-simulation.ts:3111](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:3111)). | 90 s; 120/hour | OpenAI banter cost. Not a hosted-autonomy throttle. |
| `lastTickAt` heartbeat | Written at driver start and before the standby early return; only the DB canary reads it ([agent-autonomy-driver.ts:765](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:765), [db-canary.ts:186](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/db-canary.ts:186)). Canary warns after five minutes only if agents are enrolled ([db-canary.ts:20](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/db-canary.ts:20)). | 5 min default | Process-loop liveness. It does not gate actions and can remain perfectly fresh while standby produces 0/hour. |
| Boot coupling | `agentAutonomyDriver.start()` sits after `await ensureHouseAgent()` in the same `try`; if house seeding throws, the catch runs and the driver is never started ([index.ts:769](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/index.ts:769)). | Until process restart | Unintended global zero-activity failure mode. |

One documentation inconsistency is material: comments still claim a no-human idle throttle and that driver `useModel` never updates orchestrator activity. Executable code has no caller of `getActiveHumanCount()` ([npc-simulation.ts:1621](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1621)), explicitly declares audience-independent cadence ([agent-autonomy-driver.ts:834](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:834)), and refreshes `lastActivity` through `getRunningAgentRuntime`. Passive human co-presence does not accelerate or wake a hosted agent.

## C. Root-cause verdict

The dominant cause on staging is the blanket autonomy standby switch. It reduces hosted autonomy from an active code-derived range of roughly 30–60 visible commands/hour to exactly 0/hour after the bounded arm expires. Because enrolled autonomous bodies are exempt from idle despawn and `lastTickAt` continues updating, the system presents the worst possible symptom: an agent looks online, remains visible, and reports a healthy driver heartbeat while doing nothing.

When autonomy is active—production’s code default—the dominant cause is the phase machine, not the 30-minute orchestrator sweep or body sweeper. The advertised 30-second “tick” is not a 30-second action cadence: walking polls, arrival transitions, 60-second linger, per-building one-hour talk cooldowns, and in-flight model work consume most ticks. The optimistic teaching loop is one visible action about every 60 seconds and at most about ten successful teacher conversations/hour. Connected REST agents have no comparable scheduler, standby, linger, or per-building conversation cooldown.

The body sweeper is not the normal culprit: correctly enrolled hosted agents are explicitly exempt. The orchestrator’s 30-minute stop is also normally bypassed—house agents are hard-exempt, and active user-hosted agents refresh `lastActivity` every driver tick. A stopped runtime is re-warmed by the driver.

There are two serious secondary lifecycle defects:

- A browser-closed user-hosted agent stops entirely after roughly 24 hours because autonomous driver activity does not slide its internal session TTL.
- An enrolled agent whose body disappears abnormally can silently no-op forever because the driver does not respawn it and reconcile skips already-enrolled owners.

The “Staging Cost — Standby + Teacher Diet” work was unquestionably tuned around inference/token cost: the switch’s own header says staging standby exists to prevent unattended spending ([autonomy-standby.ts:2](C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/autonomy-standby.ts:2)), and the canonical documentation says it gates the entire driver while leaving Hatcher paths unchanged ([ARCHITECTURE.md:300](C:/Users/itachi/Documents/Crypto/cv-audit/ARCHITECTURE.md:300)). There is no audience-aware exception or passive watcher boost. That is a direct metric-versus-experience tradeoff: it reduced API/LLM usage by making hosted agents appear dead to observers.

## D. Recommended fixes, ranked

1. **Replace blanket staging standby with an audience-aware active lease.**  
   Keep unattended cost savings, but arm a hosted agent while its owner or an authenticated human is co-present/observing it, with a short grace period after departure. Do not use only the spoofable anonymous banter watcher. This restores staging from 0/hour to the active 30–60/hour envelope while someone is actually watching.  
   **Cost conflict:** explicit; this spends inference during observed sessions.

2. **Make every qualifying kick renew the bounded arm window.**  
   Today a kick only arms when already inactive, so a directive issued near expiry can be interrupted seconds later. Refresh `armedUntil` to at least `now + 30m` on enrollment/directive kicks, while preserving the `autoArm:false` emergency-brake behavior for reconcile. This prevents mid-plan drops without making unattended staging permanently active.  
   **Cost conflict:** moderate and bounded.

3. **Expose standby as offline/paused, or despawn/visibly sleep the body.**  
   Do not show a stationary body and fresh heartbeat as “online autonomous.” Surface `mode`, `armedUntil`, last drive attempt, and last executed action to the world/UI. This does not restore cadence, but it removes the misleading “online but dead” symptom and makes cost standby operable.

4. **Add a watched/co-present phase cadence.**  
   Keep 30 seconds unattended, but use a 10–15-second poll or event-driven arrival transition while an authenticated observer is nearby. At 15-second ticks, the ideal teacher loop rises from about 60 to roughly 80 actions/hour because the 60-second linger remains dominant; reducing watched-mode linger as well could reach roughly 120–160/hour.  
   **Cost conflict:** significant if it adds decision calls; event-driven arrival polling is preferable because it can improve responsiveness without paying an LLM every frame.

5. **Slide the hosted user’s internal session TTL on successful driver activity.**  
   A successful perception/action—or a low-frequency server heartbeat while enrolled—should extend the same 24-hour TTL that REST activity extends. This changes browser-closed autonomy from “24 hours then 0/hour” to continuous operation while the driver is demonstrably alive.  
   **Cost conflict:** explicit and potentially large because away agents can run indefinitely; pair it with an owner-configured maximum-away duration or daily inference budget.

6. **Self-heal missing bodies from the driver.**  
   On null perception, verify enrollment/session state and invoke the hosted-session ensure/respawn path, or make reconcile validate actual body presence before treating an owner as already healthy. This restores an abnormal indefinite 0/hour wedge to normal cadence after one recovery cycle.  
   **Cost conflict:** negligible; primarily correctness.

7. **Put hard timeouts around the entire teacher turn and other awaited side effects.**  
   Bound runtime ensure, teacher `processMessage`, and covenant recording separately; release `inFlight` on timeout and retry safely. Also cancel or generation-token late model results so the 15-second outer timeout cannot leave invisible work continuing after the guard releases. This prevents isolated dependencies from suppressing all later ticks.  
   **Cost conflict:** favorable; it bounds wasted work.

8. **Revisit the one-hour per-building teacher cooldown.**  
   If learning activity is the desired visible behavior, reduce it to 15–30 minutes while watched or use a global per-agent teacher budget with enforced diversity. A 30-minute cooldown approximately doubles the ten-building steady-state ceiling from about 10 to 20 successful teacher turns/hour.  
   **Cost conflict:** direct; teacher inference volume rises correspondingly.

9. **Decouple driver startup from house-agent seeding.**  
   Start the driver in a `finally` or independent boot block so a house seeding failure cannot disable all current and future user-hosted steady ticks. This closes a rare global 0/hour mode.  
   **Cost conflict:** none beyond restoring intended operation.

10. **Keep the current history/RAG diets.**  
    The `count:20` history fix, top-five teacher retrieval, 200-token replies, and bounded lesson reads reduce cost and latency without imposing driver cadence. Reverting them would increase spend and timeout risk while doing little to make agents visibly more active.