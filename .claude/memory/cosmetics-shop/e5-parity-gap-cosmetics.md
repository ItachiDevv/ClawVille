---
name: e5-parity-gap-cosmetics
description: "OPEN on prod: the whole /api/cosmetics/* route is requireAuth (human-only) on a CT money path -- a connected/hosted agent cannot buy/equip/read its own cosmetics. The cove's founding E5 violation, repeated."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: e5-parity-gap-cosmetics
description: "Whole cosmetics API is requireAuth human-only on a CT money path -- agents locked out (E5 violation). OPEN on prod."
category: gotcha
confidence: 0.95
date: 2026-06-22
---

## Symptom
A connected/hosted agent (its session bound to an avatar) cannot buy, equip, unequip, or even READ its own cosmetics. The shop is reachable by a logged-in human only.

## Root cause
All FIVE auth'd endpoints mount bare `requireAuth`:
- `cosmetics.ts:128` `GET /owned`
- `cosmetics.ts:241` `POST /:skuId/equip`
- `cosmetics.ts:246` `POST /:skuId/unequip`
- `cosmetics.ts:263` `POST /:skuId/buy`

The debit binds to `getCallerAvatar(user.id)` only. **git-verified: 0 occurrences of `requireAuthOrAgentSession` in `cosmetics.ts` on `origin/master`, `origin/staging`, and the working tree.** The `{user,agent,guest}` resolver EXISTS (`require-auth-or-agent.ts:249`/`:315`) but is not imported here.

Per `CLAUDE.md` Rule E5 a CT-economy money route doing only `requireAuth` is an **automatic BLOCKING issue** -- this is the exact defect the cove was created to fix (cove `getSubject`, land `c.var.identity.avatarId`).

## Fix (FIX-it, not document-and-walk-past -- Rule E5 + Memory RULE 6)
1. Swap `requireAuth` -> `requireAuthOrAgentSession` on `/owned`, `/equip`, `/unequip`, `/buy`; resolve the acting avatar from `c.var.identity.avatarId`.
2. Resolve `{user, agent}`; an unbound/non-ledger agent -> 401/403, **NEVER a guest demotion** (cosmetics are real-CT). Guest -> 403 on buy.
3. Change the READ path (`/owned`) the SAME diff or an agent's purchased cosmetics vanish from its own wardrobe (the cove slots/history bug class).
4. Carry a PARITY note: "human path: POST /api/cosmetics/:skuId/buy; agent path: same via X-Clawville-Agent-Session; settlement binds to identity.avatarId."
5. Web layer also needs an agent-session header path -- `use-cosmetics.ts` is `credentials:'include'` cookie-only today.
6. Exposing buy/equip on the agent ACTION surface (tools.json + `[ACTION:]` + PROTOCOL bump) is the **protected partner surface** -- separate change, Codex pass + mock-Hatcher harness.

## State
**OPEN on prod/staging/WT.** This is the dominant work item for the vertical.

Related: [[ct-only-carve-out-not-marketplace]], [[menu-world-equip-reactivity]].
