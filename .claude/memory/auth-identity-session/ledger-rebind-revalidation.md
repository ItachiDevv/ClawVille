---
name: ledger-rebind-revalidation
description: "config.ledgerCapable is frozen at registration; re-validate at resolve time against boundUserId===row.userId or a rebound row lets a stale session spend the victim's CT"
category: gotcha
confidence: high
date: 2026-06-22
---

# Ledger-capable rebind re-validation (stale-session theft)

**The vector:** `config.ledgerCapable` is frozen at registration, but the bound `userId` on the live row can change underneath it. An attacker registers a ledger-capable session while an agentId is unbound (or theirs), then a later owned-token connect REBINDS that same agentId's row to a VICTIM. The frozen flag would otherwise authorize the attacker's stale session to spend the victim's real CT.

**Two backstops (either alone closes it; both = belt-and-suspenders on a money path):**
1. **Eviction-on-rebind** in `/connect` + register — unregister all prior sessions for the agentId BEFORE registering when `tokenUserId !== existingBoundUserId` (`agent-gateway.ts:576-586`; partner register re-register hygiene at `partner-hatcher.ts:1044-1050`).
2. **Resolve-time re-validation** — `resolveAgentSession` demotes to non-ledger when `config.boundUserId !== live row userId` (both non-null), and `unregisterOpenClaw`'s the session ONLY when both are present-and-different real users — the theft signal (`require-auth-or-agent.ts:280-294`). A first-contact null→null session stays alive (non-ledger) so it can still chat/perceive (:287-288).

**Default-fail-closed:** `ledgerCapable` defaults FALSE when the config omits it (`require-auth-or-agent.ts:280`) so any registration path that forgets to set it fails closed at the cove gate.

Status: FIXED + on prod. Related: [[bearer-ttl-gate]], [[guest-demo-isolation]].
