---
name: drawer-agent-gated-dead-click
description: "OPEN: the cosmetic Wardrobe drawer mounts inside the agentConnected gate (game/page.tsx:604) while its triggers fire regardless -- a non-agent Player gets a dead click. The shop is a Player-tier carve-out."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: drawer-agent-gated-dead-click
description: "CosmeticDrawerMount is inside the agentConnected gate; triggers fire regardless -> non-agent Player dead click. OPEN."
category: gotcha
confidence: 0.9
date: 2026-06-22
---

## Symptom
A player WITHOUT a connected agent (Player tier) clicks the cosmetics sidebar button / bazaar stall / building shop overlay and nothing opens -- the drawer never mounts.

## Root cause
`game/page.tsx:604` wraps `<CosmeticDrawerMount/>` (`:614`) in `{agentConnected && controlMode !== 'npc' && controlMode !== 'explore' && (...)}`. But the triggers flip `setCosmeticDrawerOpen(true)` regardless of `agentConnected`:
- `sidebar-menu.tsx:928` + `:942`
- `bazaar-stall.tsx:121`
- `shop-overlay.tsx:121`

So the open flag flips with nothing mounted to render. The cosmetic shop is a **Player-tier-playable carve-out** (Brand Identity: Player <-> Agent is a first-class axis), so agent-gating it blocks the human-only axis.

## Fix
Move `<CosmeticDrawerMount/>` OUT of the `agentConnected` block and mount it on the `hasAvatar` gate -- exactly like `<AvatarChatBar/>` at `game/page.tsx:601` (`{hasAvatar && controlMode !== 'npc' && controlMode !== 'explore' && ...}`). Verify the open flow for a fresh non-agent guest in the browser (mobile + iPad sweep per CLAUDE.md if UI moves).

## State
**OPEN.** Matches the older memory `project_cosmetics_ingame_swap_plan` ("drawer mount agent-gated (dead click)").

Related: [[local-player-only-render]], [[e5-parity-gap-cosmetics]].
