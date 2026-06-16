# Codex task — IMPLEMENT two fixes to the controlled-mode suppression (edit the files directly)

Worktree: `C:\Users\newma\Documents\Crypto\ClawVille-codex-review`, branch `fix/hatcher-contract-parity`.
The controlled-mode-through-magic-link feature just shipped (commit 55a8403b). Hatcher is testing
it LIVE against our STAGING, so these two "v1-acceptable" deferrals are real defects to FIX NOW, not
defer. You implemented the original design (`.hatcher-ref/CONTROLLED-FINDINGS.md`) and reviewed the
impl (`.hatcher-ref/CONTROLLED-REVIEW-FINDINGS.md`) — this is your follow-up. EDIT THE SOURCE FILES
DIRECTLY (you have a bypass sandbox). Use ultrathink reasoning before writing code.

## Current state (the code as shipped — read it first, do not assume)
- `apps/api/src/services/npc-simulation.ts`:
  - `humanControlledOpenClawUntil: Map<agentId, epochMs>` + `isHumanControlledOpenClawNpc(npcId,now)`
    (npcId→sessionId via `npcOverrides`→`config.agentId`→Map), `markHumanControlledOpenClaw(agentId, ttlMs=3000)`
    (also freezes the body: clears path/pathIndex/destinationBuildingId, walking→idle),
    `refreshHumanControlledOpenClawForUser(userId, ttlMs=3000)` — **THE BUG**: it iterates ALL `openClawBots`
    and re-ups EVERY bot whose `config.boundUserId === userId`.
  - Suppression consumed in getSnapshot, getRoomSnapshot, planNpcBehaviors, getIdleAliveNpcs,
    findNearestIdleNpc, moveNpcs, dispatchHatcherActions; cleared in unregisterOpenClaw.
- `apps/api/src/routes/partner-hatcher-launch.ts`: on exchange success calls
  `npcSimulation.markHumanControlledOpenClaw(namespacedAgentId)`. The ownership guard above it now
  GUARANTEES `user.id === row.userId` (== the agent's `config.boundUserId`).
- `apps/api/src/routes/world.ts` `/position`: calls `refreshHumanControlledOpenClawForUser(presence.userId)`
  on every human position upload. It knows ONLY the human userId — NOT which agent was launched. **Do
  NOT change the client or add an agentId to the position upload.**

## FIX 1 (primary) — suppress ONLY the launched agent, not all of a user's bound Hatcher proxies
A user with multiple Hatcher agents bound to the same ClawVille user currently has ALL their proxies
hidden+frozen the moment they drive one. Suppress only the agent(s) the owner actually LAUNCHED/drives.

Design (validate or improve — your call, but justify): a server-side binding of userId → the launched
agentId(s) being driven, set when the exchange succeeds, consulted by the position-refresh so it re-ups
ONLY bound agents. Requirements:
- The binding must survive a transient >3s upload stall: when the owner is in player mode driving the
  agent's avatar, a network stall can let the 3s window lapse; on resumed uploads the refresh MUST
  re-prime suppression for that agent (else the autonomous proxy reappears AND walks while the owner
  drives the SAME avatar — the exact two-body bug, permanently, after one stall). So refresh must be
  able to RE-CREATE the window for a bound-launched agent, not merely extend an existing one.
- Other Hatcher agents bound to the same user but NOT launched must keep running autonomously (no window).
- Clean the binding when the agent's session unregisters (`unregisterOpenClaw`) so it can't leak.
- The exchange (`partner-hatcher-launch.ts`) is where the launched agentId is known — wire the binding there.
- Keep `markHumanControlledOpenClaw(agentId)` as the immediate prime in the exchange (covers the pre-first-upload window).

## FIX 2 — no lingering speech bubble from a suppressed proxy
A conversation a proxy was ALREADY in when suppression starts is not filtered from getSnapshot/
getRoomSnapshot, so a hidden NPC can leave a visible speech bubble until the convo completes. Filter
active conversations out of BOTH snapshots when EITHER participant NPC id is a currently-suppressed proxy
(`isHumanControlledOpenClawNpc`). Keep it cheap (the conversations arrays are small). Match the existing
`.filter(c => c.state === 'active')` style.

## CONSTRAINTS
- Do not change the web client or the position-upload payload.
- Do not break the existing single-agent behavior, the freeze, or the ownership guard.
- TypeScript strict. `config.agentId` / `config.boundUserId` exist on OpenClawRegistration. The conversation
  objects in getSnapshot/getRoomSnapshot have participant npc ids — read the real shape, don't guess the field names.

## VERIFY (you run these)
- `cd <worktree> && bunx tsc --noEmit -p apps/api/tsconfig.json` → MUST exit 0 (rebuild `packages/shared` first ONLY if you change a shared type — you shouldn't need to here).

## OUTPUT
Edit the source files directly. Then write a concise summary (what changed, the binding mechanism +
lifecycle, the stall-robustness rationale, and the convo-filter) to `.hatcher-ref/CONTROLLED-FIX2-FINDINGS.md`,
ending with the exact list of files+functions you touched. Do NOT commit or push — Claude reviews, builds the web side, and ships.
