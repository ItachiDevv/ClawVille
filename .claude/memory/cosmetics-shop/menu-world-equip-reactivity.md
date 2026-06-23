---
name: menu-world-equip-reactivity
description: "INVARIANT: the cosmetic drawer mutation and the in-world loader read share ONE React Query key ['cosmetics','owned']; that shared key is the only menu<->world equip sync wire -- forking it for the local player breaks live render reactivity."
category: pattern
confidence: high
date: 2026-06-22
---

---
name: menu-world-equip-reactivity
description: "Drawer equip + in-world loader read share ['cosmetics','owned']; that key is the menu<->world sync seam. Never fork it for the local player."
category: pattern
confidence: 0.95
date: 2026-06-22
---

## The seam
The Wardrobe drawer and the in-world VRM render are two VIEWS of the same `avatar_skins` state. The DB is truth; they stay in sync via ONE shared TanStack Query key.

- `use-cosmetics.ts` `useEquipCosmetic` optimistically `setQueryData(['cosmetics','owned'])` + invalidates it on settle (with rollback `onError`).
- `cosmetic-loader.tsx:411` `useEquippedCosmetics()` READS the same key (`:423-431`) -- so a drawer equip propagates to the live VRM instantly, no reload.

This is the land-class WORLD<->MENU<->DB parity, applied to cosmetics: the menu and the gameplay must not be "two universes that don't talk."

## Rules
- **Never fork `['cosmetics','owned']` for the LOCAL player.** A separate key = the drawer equips but the world doesn't update (or vice versa).
- When adding per-avatar rendering ([[local-player-only-render]]), keep the local player on this key and add per-avatar keys only for OTHER avatars.
- **Do NOT raise the 120s poll** or re-enable `refetchOnWindowFocus` -- the previous 30s+focus combo cascaded a useMemo + reconciler pass inside the active R3F `useFrame` loop on Iris Xe, causing visible jitter (perf audit 2026-04-29 #2). Equip mutations stay instant via the explicit invalidate, so polling can be slow.

## State
**INVARIANT / current correct design.** Verified: shared key + comment in both files mandating the match.

Related: [[local-player-only-render]], [[sku-needs-row-asset-mesh]].
