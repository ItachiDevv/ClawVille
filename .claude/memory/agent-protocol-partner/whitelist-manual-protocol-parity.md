---
name: whitelist-manual-protocol-parity
description: "The [ACTION:] executor whitelist (npc-simulation, authoritative gate), the §3a protocol manual (skill-protocol buildProtocolManual), and PROTOCOL_VERSION (skill-protocol.ts:63) must move same-diff. §3a bounds are hard-mirrored literals that can silently diverge. v6 = 6 verbs. Whitelist lookups use Object.hasOwn."
category: pattern
confidence: high
date: 2026-06-22
---

# Whitelist ↔ manual ↔ PROTOCOL_VERSION three-surface parity

**Status: INVARIANT (mechanical CLAUDE.md rule).** PROTOCOL_VERSION=6 in this worktree.

## Rule (same-diff, mandatory)
Three surfaces move together:
1. **Executor** `npc-simulation.ts executeHatcherAction` (`:1182`) — the AUTHORITATIVE hard gate. Safety lives HERE, never the SKILL.md; non-whitelisted verbs are silently dropped. `dispatchHatcherActions` (`:1126`) caps at `MAX_HATCHER_ACTIONS_PER_REPLY=4` (`:100`) and strips ALL tags from speech.
2. **Manual** `skill-protocol.ts buildProtocolManual` §3a — what a connected agent is TOLD it can do.
3. **`PROTOCOL_VERSION`** (`skill-protocol.ts:63`, single source). The bump is the **eager re-embed signal**: partners poll the manifest `protocol.contentHash/version` and re-pull (`openclaw-client.ts:238`).

Mismatch ⇒ agents attempt actions the server silently drops, or never learn an allowed one.

## The silent-divergence trap
§3a bounds are **HARD-MIRRORED literals** of the executor's module-private constants (NOT imported — service↔service cycle avoidance). Re-verify each on any change: `HATCHER_MOVE_MIN/MAX` 32..11488 (`:70`), `HATCHER_TALK_MESSAGE_MAX=500` (`:89`), `MAX_HATCHER_ACTIONS_PER_REPLY=4`, `HATCHER_EMOTE_MAP` keys (`:76`), the 10 building ids.

## Current whitelist (v6, 6 verbs)
`move`, `emote`, `enter_building`, `talk_to_npc`, `enter_cove`, `enter_poker_room`. v6 added `enter_poker_room` + the tournament-poker manual section (2026-06-16).

## Prototype-pollution guard
Every whitelist lookup uses `Object.hasOwn(MAP, key)` (`:1209-1217` emote, `:1225` building, `:1310` talk) — inherited keys (`constructor`, `__proto__`, `toString`) must NEVER satisfy the whitelist.

## Betting NEVER flows through the [ACTION:] parser
Action tags drive only VISIBLE in-world MOTION + SPEECH. Real-CT settlement (blackjack/poker tools) flows ONLY through authenticated session-bound tool endpoints driven by the PARTNER BACKEND holding the sessionId; `enter_cove()`/`enter_poker_room()` are gateway WALK verbs only.

A verb change must also propagate to Nori `knowledge[]` + the hosted-runtime protocol-knowledge surface (CLAUDE.md three-surface rule), update `docs/hatcher-integration-spec.md`, and run the harness GREEN.

→ [[controlled-two-body-model]] [[validate-against-hatcher-ref]]
