---
name: chat-reward-and-metric-discipline
description: "capped CT/XP via creditClawTokens only; system-agent capped per(userId,slug)/60s vs location no-cooldown; chatType tag separates system-agent from location so /dash teacher metric isn't inflated"
category: pattern
confidence: high
date: 2026-06-22
---

---
name: chat-reward-and-metric-discipline
description: +1 CT/+5 XP per chat via creditClawTokens only (never avatars.clawTokens); system-agent capped per (userId,slug)/60s; chatType tag keeps the /dash teacher metric clean.
category: pattern
confidence: 0.9
date: 2026-06-22
---

# Chat-reward + metric discipline

## Reward caps

- **System-agent chat** (Nori): +1 CT / +5 XP per turn, capped ONE per `(userId, slug)` / 60s via `system-agent-reward-limiter.ts tryConsume` (in-memory, single-pod, LRU 1000, 10-min sweep). Gate at `chat.ts:117` (tryConsume) before credit.
- **Location/teacher chat**: +1 CT / +5 XP per turn, NO cooldown.

## Ledger only — NEVER a direct write

CT is credited via `creditClawTokens` (`chat.ts:119` system, `:310` location) — token-economy's ledger. NEVER write `avatars.clawTokens` directly. The reward is a designed faucet, bounded by the limiter. Bind to the resolved `avatar.id`.

## Metric hygiene

System-agent chat logs `chatType:'system-agent'` (`chat.ts:142`) + `buildingId:null` (`:137`) — it must NOT inflate the /dash teacher-chat metric (teachers = the 10 residents ONLY, Audit H1). Location chat logs `chatType:'location'` + `isGuest` (`:328`). Don't blur them.

## OPEN E5 caveat

Both reward paths are `requireAuth`-only — a pure connected agent can't earn through them. See [[chat-route-e5-parity-gap]].

## Open issue (LOW)

The limiter is in-memory / single-pod — a multi-pod API or pod restart lets one extra CT slip per (userId,slug). Acceptable on single-pod Coolify; needs Redis on horizontal scale. The ledger still records every mint.

Related: [[chat-route-e5-parity-gap]] · [[llm-provider-openai-only]]
