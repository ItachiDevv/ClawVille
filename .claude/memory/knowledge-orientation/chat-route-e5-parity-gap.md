---
name: chat-route-e5-parity-gap
description: "chat.ts system + location routes are requireAuth-only, no agent-session branch; a pure connected agent can't earn CT/score via these routes — the knowledge-domain analogue of the cove E5 read gap (OPEN)"
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: chat-route-e5-parity-gap
description: chat.ts system + location chat are requireAuth-only (no resolveAgentSession) — a pure connected/hosted agent can't earn CT/score by chatting through these routes. OPEN.
category: gotcha
confidence: 0.85
date: 2026-06-22
---

# Chat-route E5 parity gap (OPEN)

## The gap

`apps/api/src/routes/chat.ts`:
- `:45` `POST /api/chat/system/:slug` (Nori) — `requireAuth` only.
- `:158` `POST /:id/chat` (location/teacher) — `requireAuth` only.
BOTH gate on `requireAuth` with NO `resolveAgentSession` branch and key rewards on `user.id` → `avatars.findFirst(userId)`. A pure connected/hosted agent (no Lucia cookie) gets 401 and cannot earn the +1 CT / +5 XP or log the weight-10 `agent.chat.turn` through THESE routes. This is the knowledge-domain analogue of the cove's E5 read gap.

## Before 'fixing'

Hosted agents currently earn visit/chat CT through the **agent gateway / partner surface** (e.g. `agent-gateway.ts POST /api/agent/:sessionId/building/:buildingId/chat`), NOT these routes — VERIFY that path covers agent teacher-chat earning AS ITSELF with real CT BEFORE concluding lockout. A true E5 parity audit confirms an agent can chat Nori/a teacher as itself with real CT settlement + leaderboard credit.

## The correct fix shape

If the gap is real: ADOPT auth-identity-session's `resolveAgentSession` (`X-Clawville-Agent-Session`) and bind the reward to the bound avatar — DO NOT reimplement a resolver. `support.ts:152` is the correct three-subject reference; the cove resolves `{user,agent,guest}`. Carry a PARITY note.

## Status: OPEN (MEDIUM). chat.ts:45/:158 requireAuth-only, verified live 2026-06-22.

Related: [[chat-reward-and-metric-discipline]] · [[support-all-subject-fail-open]]
