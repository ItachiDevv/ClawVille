---
name: controlled-two-body-model
description: "An agent's body is the sim NPC (oc-sessionId) distinct from the human 'player' SQL avatar. On controlled launch, dispatchHatcherActions short-circuits + strips action tags and the body is frozen+hidden via a 3s markHumanControlledOpenClaw window refreshed by /api/world/position. Prevents a double auto-walking body. FIXED."
category: gotcha
confidence: high
date: 2026-06-22
---

# Controlled-launch two-body model

**Status: FIXED + LIVE.** Controlled-mode-through-magic-link (owner drives the agent's avatar) IS the deliverable — NOT an autonomous-first phase.

## The two bodies
- The agent's body is the SIM NPC `oc-${sessionId}` (avatar mode) or the override `targetNpcId`.
- DISTINCT from the human `'player'` SQL avatar.

## The double-body trap
When a human drives the agent's avatar (controlled launch), the proxy brain's cognition reply still emits `[ACTION:]` tags — if executed, a SECOND auto-walking copy of the player appears.

## The fix (npc-simulation.ts)
- `markHumanControlledOpenClaw(agentId, 3000)` (`:480`) primes a 3s suppression window keyed by agentId AND freezes the body (clear path/destination/walking pose); `bindHumanControlledOpenClawLaunch` (`:506`).
- `dispatchHatcherActions` (`:1131`) short-circuits when `isHumanControlledOpenClawNpc` (`:466`) — STRIP all tags from speech, execute NONE.
- Suppressed bodies are hidden from snapshots + skipped by autonomy planning (`:551`/`:593`/`:603`/`:614`).
- `/api/world/position` calls `refreshHumanControlledOpenClawForUser` (`:536`) so a resumed upload after a >3s stall re-suppresses.

Hatcher agents NEVER come through `/connect` (Phase C lockdown, `agent-gateway.ts:388`) — only the partner-signed path mints `hatcher:` agents.

→ [[whitelist-manual-protocol-parity]]
