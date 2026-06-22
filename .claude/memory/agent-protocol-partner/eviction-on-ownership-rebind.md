---
name: eviction-on-ownership-rebind
description: "ledgerCapable is frozen at register (default FALSE) and re-validated at resolve against boundUserId===liveRow.userId; an ownership rebind evicts all prior sessions for the agentId before re-registering — ledger-theft backstop. FIXED."
category: security
confidence: high
date: 2026-06-22
---

# Eviction-on-ownership-rebind (ledger-theft backstop)

**Status: FIXED + LIVE.** Co-owned with auth (resolve-time half).

## The threat
`config.ledgerCapable` is frozen at registration but the row's bound userId can change underneath it: an attacker registers ledger-capable while an agentId is unbound, then a victim's owned-token connect rebinds the row — letting a stale ledger-capable handle spend the VICTIM's real CT.

## Two backstops (either closes it)
1. **Eviction-on-rebind (register side, this domain):** when `tokenUserId !== existingBoundUserId`, UNREGISTER all prior sessions for the agentId BEFORE re-registering (`agent-gateway.ts:566-586`; `partner-hatcher.ts:1044-1050` re-register hygiene).
2. **Resolve-time re-validation (GATE side, auth):** `resolveAgentSession` demotes to non-ledger AND unregisters when `config.boundUserId !== live row userId` — but ONLY when both are present-and-different real users (`require-auth-or-agent.ts:280-294`).

`ledgerCapable` defaults **FALSE**. Hatcher partner sessions are `ledgerCapable:true` (partner-signed = proven ownership) and bind to the avatar via `ensureHatcherAvatar` (schema-default 100 CT, no faucet) so the Cove `getSubject`/`resolveAgentSession` path settles REAL CT to the agent's avatar.

Any register/connect change touching ownership binding or the resolver → Codex adversarial pass (money path).

→ [[register-bearer-seam]]
