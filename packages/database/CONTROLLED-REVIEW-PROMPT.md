# Codex task — independent review of the controlled-mode-through-magic-link build

You are reviewing a build that Claude just APPLIED to this worktree
(`C:\Users\newma\Documents\Crypto\ClawVille-codex-review`, branch
`fix/hatcher-contract-parity`). The diff implements **controlled-mode-through-magic-link**:
an owner clicks Launch on Hatcher → magic-link auth (`POST /api/portal/mint-for-hatcher`)
→ lands in `'player'` control of their Hatcher agent's avatar, NOT spectating it. The
agent's autonomous proxy NPC is hidden + frozen server-side while the owner drives.

This is the diff from `.hatcher-ref/CONTROLLED-FINDINGS.md`, now applied. Read the APPLIED
state in these files (git diff against HEAD bfafa96a shows exactly what changed):
- `packages/shared/src/types/openclaw.ts` (HatcherLaunchExchangeResponse.mode: 'autonomous'→'controlled')
- `apps/api/src/routes/partner-hatcher-launch.ts` (exchangeBody.mode, success markHumanControlledOpenClaw, response mode)
- `apps/api/src/routes/world.ts` (/position refresh hook)
- `apps/web/src/components/game/hatcher-launch-handler.tsx` (land in 'player', no explore/spectate/camera-focus)
- `apps/api/src/services/npc-simulation.ts` (humanControlledOpenClawUntil Map + isHumanControlledOpenClawNpc/markHumanControlledOpenClaw/refreshHumanControlledOpenClawForUser + 6 suppression sites)

## VERIFY THESE WITH CITATIONS (do not assume — code is the source of truth)

1. **Identity equality chain (LOAD-BEARING).** Suppression refresh keys on
   `config.boundUserId === presence.userId` (world.ts). For this to actually hide the proxy,
   the magic-link session's `userId` MUST equal the agent's `config.boundUserId`. Trace and
   confirm/refute with file:line:
   - `boundUserId = row.userId = resolveOrCreateUserByIdentity('hatcher', identityKey)` at register (partner-hatcher.ts).
   - magic-link mint logs the owner into `userId` parsed from `principal:clawville:<uuid>` (portal.ts:854,887).
   - Does the principal-uuid provably equal the agent's `row.userId` (boundUserId)? If only "by partner contract"
     (Hatcher must send the right principal) and not enforced by our code, SAY SO explicitly.

2. **Should the exchange enforce `row.userId === user.id`?** The exchange (partner-hatcher-launch.ts)
   currently accepts ANY logged-in session for any agentId. If the launching session-user is NOT the
   agent's bound user, suppression silently never fires (two bodies). Recommend whether to add a
   guard that rejects the launch when `row.userId !== user.id` (loud failure instead of silent
   two-body), and whether that would regress the existing flow (e.g. unbound agents, `row.userId` null).

3. **Edge cases — for each, state behavior + whether it's acceptable for v1:**
   - (a) Unbound agent (`row.userId` null → no `ensureHatcherAvatar`, no bound avatar). What does a
     controlled launch do? Is there even an avatar to drive? Should it fall back or hard-fail?
   - (b) Multi-agent user: `refreshHumanControlledOpenClawForUser(userId)` suppresses ALL of that
     user's Hatcher proxies, not just the launched one. Problem or fine?
   - (c) Does landing in `'player'` get yanked back to spectate/explore by any residual state —
     `hatcherSpectate`, `setAgentPaired` (game.ts ~908), or the explore→player promotion guard
     (game/page.tsx ~394)? We removed `setHatcherSpectate(true)`; confirm nothing else re-sets it
     for this session. Note: the magic-link owner has a Lucia HUMAN session, NOT an
     `X-Clawville-Agent-Session` bearer — confirm `/api/auth/me/agent-session` does NOT resolve for them.
   - (d) Does `PlayerAvatar` actually render the AGENT's avatar? Confirm `/api/avatars/me` for the
     magic-link session returns the agent's bound SQL avatar row (so the body the owner drives IS the
     agent's avatar, not a generic one).

4. **Adversarial correctness/security/regression review of the applied diff:**
   - TTL race: 200ms upload interval vs 3000ms TTL — any window where the proxy reappears mid-drive?
     What about the position route's own throttle (POSITION_MIN_INTERVAL_MS) dropping uploads?
   - `markHumanControlledOpenClaw(namespacedAgentId)` in the exchange uses the NAMESPACED agentId.
     Confirm `config.agentId` stored at registration is also namespaced (so the keys match).
   - Does hiding the proxy from `getRoomSnapshot`/`getSnapshot` break anything that expects the
     agent body present (cove/blackjack settlement, conversation routing, leaderboard, room capacity)?
   - Any path that still runs the agent's cognition while suppressed (conversations initiated BY
     other NPCs/players, `dispatchHatcherActions`)? We skip planNpcBehaviors/getIdleAliveNpcs/
     findNearestIdleNpc — is that complete, or can a proxy still get pulled into a turn?
   - Does suppression correctly EXPIRE when the owner switches to explore (uploads stop) so the
     agent resumes autonomy? Confirm the lazy-prune in isHumanControlledOpenClawNpc.

## OUTPUT
Write findings to `.hatcher-ref/CONTROLLED-REVIEW-FINDINGS.md`. For each item: VERIFIED / REFUTED /
UNVERIFIED + file:line citations. End with a clear verdict: SHIP / SHIP-WITH-FIXES (list exact
fixes) / BLOCK (list blockers). Do not edit source files — review only; propose exact diffs in the
findings doc if you recommend changes.
