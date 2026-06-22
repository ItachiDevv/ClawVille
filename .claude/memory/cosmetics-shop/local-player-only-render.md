---
name: local-player-only-render
description: "OPEN/scaffold: CosmeticLoader is mounted only on the local player VRM (player-avatar.tsx:709, avatarId='self'); the /owned cache key is not per-avatar -- NPC/other-player/agent-body avatars render no cosmetics."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: local-player-only-render
description: "Equipped cosmetics render only on the local player VRM; no per-avatar owned read -> NPC/remote/agent bodies show none. OPEN/scaffold."
category: gotcha
confidence: 0.9
date: 2026-06-22
---

## Symptom
Another player's, or a hosted-agent-as-NPC's, equipped cosmetics never appear in-world. Only the local player sees their own.

## Root cause
- `<CosmeticLoader>` is mounted exactly ONCE: `player-avatar.tsx:709` with `avatarId='self'`. (grep: referenced only in `cosmetic-loader.tsx` + `player-avatar.tsx`.)
- `useEquippedCosmetics()` (`cosmetic-loader.tsx:411`) hard-codes a single 'caller-avatar' cache slot: it `void avatarId;` and uses query key `['cosmetics','owned']` (`:423-431`). The comment says the prop is "forward-compat for future per-NPC cosmetic rendering" -- the API resolves ownership from the session cookie, so there is NO per-avatarId read path.
- `GET /owned` itself has no `?avatarId=` form.

## Fix (dispatch 3da for the render side)
1. Add a per-avatar equipped source: a public `GET /owned?avatarId=` (or an equipped-list on the NPC/presence payload).
2. Use a per-avatar query key for OTHER avatars; **keep the LOCAL player on `['cosmetics','owned']`** so the menu<->world sync ([[menu-world-equip-reactivity]]) keeps working.
3. Mount `<CosmeticLoader>` on the NPC/remote-player VRM with their `rigType`/`vrmRenderScale` -- under the Iris-Xe draw budget (more avatars * cosmetics = more draw calls; 3da reviews).

## State
**OPEN / forward-compat scaffold.** Do NOT claim multiplayer cosmetics work. (Note: this couples with the multiplayer/shared-world effort.)

Related: [[menu-world-equip-reactivity]], [[e5-parity-gap-cosmetics]].
