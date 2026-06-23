---
name: hatcher-namespace-reserved
description: "The 'hatcher:' agentId prefix + 'hatcher' identityType are reserved on PUBLIC/unsigned registration paths via reserved-agent-namespaces guards (case-sensitive exact-prefix), wired into agent-gateway + legacy openclaw. The signed router owns the namespace and does not call them. FIXED (Codex R2-1)."
category: security
confidence: high
date: 2026-06-22
---

# hatcher: namespace reservation (public writers)

**Status: FIXED + LIVE (Codex R2-1).**

## Invariant
SSOT in `reserved-agent-namespaces.ts`: `RESERVED_PARTNER_AGENT_PREFIXES=['hatcher:']` (`:42`), `RESERVED_PARTNER_IDENTITY_TYPES=['hatcher']` (`:52`). `isReservedPartnerAgentId` (`:61`, **CASE-SENSITIVE exact-prefix** — `'Hatcher:'`/`'x-hatcher:'` are NOT reserved by design; partners derive the exact lowercase literal) + `isReservedPartnerIdentityType` (`:70`).

## Two-layer defense
1. **Namespace isolation** — every Hatcher agentId is stored namespaced `hatcher:<rawId>` (the RAW id is sent to Hatcher's proxy).
2. **Ownership guard** — register/PATCH refuse to mutate any row whose `identityType !== 'hatcher'` (register ⇒ 409, PATCH ⇒ 404); PUBLIC unsigned writers reject reserved ids/rows.

## Who calls the guards
PUBLIC/unsigned writers MUST call them:
- `agent-gateway.ts:281` (POST `/api/agent/connect` — reject reserved agentId) + `:428` (reject mutating a reserved-identity existing row).
- `openclaw.ts:149` + `:214` (legacy `/api/openclaw/register`).

The ed25519-**signed** `partner-hatcher.ts` router OWNS the namespace and does NOT call these guards.

## When onboarding a future partner
Add ONE prefix + identityType entry to `reserved-agent-namespaces.ts` and BOTH public guards cover it automatically. Case-sensitivity is asserted in `__tests__/reserved-agent-namespaces.test.ts:40-46`.

→ [[register-bearer-seam]]
