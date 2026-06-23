---
name: sku-needs-row-asset-mesh
description: "INVARIANT: a sellable cosmetic SKU needs a DB row + a resolving public/cosmetics GLB + a 3da-validated mesh; the drawer reads the DB so a row-less SKU never appears and an asset-less one renders nothing. PaletteRenderer/OutfitRenderer/emote-geometry are stubs; supplyCap is un-enforced."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: sku-needs-row-asset-mesh
description: "A sellable SKU = DB row + resolving GLB + 3da-validated mesh. Palette/outfit/emote-geometry are stubs; supplyCap un-enforced."
category: constraint
confidence: 0.9
date: 2026-06-22
---

## The rule (the brand carve-out add-a-cosmetic checklist)
The drawer + catalog read the DB, so a SKU is only real when ALL of:
1. **Asset on disk** -- `public/cosmetics/<category>/<slug>.glb` (or the variant's `assetUrl`). `loadGlbAsset` console.errors on 404; `pickVariant` null filters the equipped item out (renders nothing).
2. **3da-validated mesh** -- loads + fits via `computeCosmeticHeadFit` (browser screenshot), under the Iris-Xe budget. (`CLAUDE.md`: a cosmetic SKU needs an existing `avatar_skins`/SKU row + valid asset URL + 3da-validated mesh.)
3. **DB rows** -- seed `cosmetic_skus` + `cosmetic_variants` on the TARGET DB.
4. Confirm it appears in `/catalog` AND renders equipped.

A NEW CATEGORY also needs 4 coupled lists updated in lockstep, same-diff: the schema `category` comment, the drawer `CATEGORY_FILTERS`, the loader `cat===` branch, and the seed + asset.

## Stubs -- do NOT sell these yet
- `PaletteRenderer` (`cosmetic-loader.tsx:~828`) -- whole-material swap, UV-region blit deferred -> effectively `return null`.
- `OutfitRenderer` (`:~900`) -- deferred (needs Marvelous-Designer skinned-mesh binding) -> `return null`.
- `emote` -- intentionally non-geometry; route through the emote-bus -> `VRMCharacterAnimator.playOneShot` + the EmoteHotbar, NOT the loader. An 'emote' SKU wires the hotbar, not a 3D mesh.

## supplyCap is UN-ENFORCED
`supplyCap` exists on `cosmetic_skus` but neither `/buy` nor `/catalog` reads it (`cosmetics.ts:94-96` defers the COUNT to Phase 4). A 'limited' drop CAN oversell. Before any capped drop, add `COUNT(avatar_skins WHERE skuId)` (under a lock / atomic with the insert) to both hide-when-full (catalog) and reject-when-full (buy).

## RESTRICT FKs
`cosmetic_variants.skuId` + `avatar_skins.skuId` are `onDelete:RESTRICT` -- never hard-delete a SKU; retire via `availableUntil` so ownership rows survive.

## State
**INVARIANT** + the stub/supplyCap parts are OPEN gaps to respect before selling those categories.

Related: [[proportion-aware-autofit]], [[menu-world-equip-reactivity]], [[asset-cache-bust-v-query]].
