# Phase 4b — Hosted autonomous runtime for user agents (DEFERRED)

**Status:** DEFERRED — **not** on the active roadmap.
**Date:** 2026-04-16
**Depends on:** Phase 4a demand signal (waitlist count) + Milady team
conversation + counsel-reviewed ToS revision + hardware capacity plan.

---

## 1. Purpose of this file

This is a **decision record** plus a placeholder. It is not an implementation
plan. Do not extend this file with code details unless the gating criteria
below have all been cleared.

The full implications analysis lives in `AgentHosting.md` at the repo root
(gitignored). That doc is the substantive reading for anyone considering
Phase 4b.

---

## 2. What Phase 4b would be

If it were built: ClawVille runs a long-lived `AgentRuntime` per user
(using `createElizaRuntime` from `@clawville/agent-runtime`) on our own
infrastructure. User agents receive a public endpoint they can call into
to chat, trigger actions, or consume their own autonomy loop. We become an
**agent hosting platform**, not just a game.

---

## 3. Why it is deferred

Summary — full reasoning in `AgentHosting.md`:

1. **Direct product-positioning conflict with Milady's Companion product.**
   Phase 4b makes us a competitor to the platform we are submitting our
   app to (Priority #1). Phase 4a is additive; Phase 4b is subtractive.
2. **Infra cost shift.** Hosted agents burn Gemini tokens continuously
   even when idle (reflection, memory consolidation). Without hard
   metering, a single runaway agent can cost hundreds per day.
3. **Security / liability surface.** Hosted agents with outbound network
   access are an abuse vector we own. Requires egress allowlist, per-agent
   rate limits, token budgets, kill switches, audit logging.
4. **ToS / compliance rewrite.** "We are a game" becomes "we host user
   agents that act on their behalf." EU AI Act deployer obligations, DMCA
   for knowledge ingests, sorting out agent-output liability — all need
   counsel review.
5. **Demand is unmeasured.** We do not know how many users would pay for
   hosted vs. just run Milady locally. Phase 4a captures this signal via
   the waitlist before we commit.

---

## 4. Gating criteria — all four must clear before implementation starts

1. **Waitlist signal ≥ some threshold** (to be decided; "enough
   signup-having-users that the hosted tier has a real addressable
   market"). Actual number set when 4a ships and we see initial signup
   velocity.
2. **Milady team conversation.** Before building a direct competitor, ask
   them explicitly: is this OK with you? Do you have a recommended
   integration pattern (e.g. "we spawn runtimes that are actually Milady
   instances under the hood")? Their answer changes the architecture.
3. **ToS / AUP revision.** Counsel-reviewed. At minimum: agent ownership
   clause, user-responsibility for agent outputs, our right to kill
   quarantined agents, data residency.
4. **Capacity + ClawToken metering plan.** A concrete document specifying:
   - VPS sizing (likely a dedicated hosting VPS separate from the game
     VPS).
   - Postgres plan (dedicated or partitioned).
   - Egress allowlist (Milady API, our API, Gemini, specific MCP
     servers).
   - ClawToken burn rate for uptime.
   - Hard token-budget cutoff per agent.
   - Visible "kill my agent" control for users.
   - Admin kill-switch-all control for us.

---

## 5. What is NOT waiting on this phase

Priorities #1, #2, #3, #4 all land fine without Phase 4b. The game works,
agents can connect, skills can be learned, marketplace and leaderboard can
ship — none require us to host.

If the gating criteria never clear, Phase 4b stays deferred indefinitely.
That is an acceptable outcome. `AgentHosting.md` §7 explicitly allows this.

---

## 6. What to do if someone spawns a future session asking about Phase 4b

1. Read `AgentHosting.md` in full before considering whether to plan.
2. Check the waitlist count in the `agent_hosting_waitlist` table (runnable
   via `scripts/waitlist-report.ts` once Phase 4a has merged).
3. Confirm whether any of the §4 gating criteria have cleared since this
   file was written.
4. If all four clear: write `phase4b-hosted-runtime-implementation.md`
   alongside this file and start the actual planning work.
5. If not all four clear: add a dated note to this file explaining what
   was asked and why it remained deferred. Do not start coding.

---

## 7. Decision log

| Date | Note |
|---|---|
| 2026-04-16 | Phase 4b split from Phase 4 and deferred. `AgentHosting.md` captures rationale. Phase 4a ships the waitlist that informs future re-evaluation. |
