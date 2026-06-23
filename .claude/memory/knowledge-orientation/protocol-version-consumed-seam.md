---
name: protocol-version-consumed-seam
description: "PROTOCOL_VERSION + the [ACTION:] executor whitelist are agent-protocol-partner's; you serve the manual; §3a bounds hard-mirror npc-simulation constants; bump+Codex on contract change"
category: constraint
confidence: high
date: 2026-06-22
---

---
name: protocol-version-consumed-seam
description: PROTOCOL_VERSION (=6) + the [ACTION:] executor whitelist are agent-protocol-partner's; knowledge-orientation owns the served manual emitters; §3a bounds hard-mirror npc-simulation and silently diverge.
category: constraint
confidence: 0.92
date: 2026-06-22
---

# PROTOCOL_VERSION is a CONSUMED seam (PROTECTED PARTNER SURFACE)

## Ownership split

- **knowledge-orientation OWNS the SERVED emitters**: `routes/skills.ts` manifest + `/protocol/skill.md`, and `skill-protocol.ts buildProtocolManual` content.
- **agent-protocol-partner OWNS**: the `PROTOCOL_VERSION` constant (`skill-protocol.ts:63 = 6`) + the authoritative `[ACTION:]` executor whitelist in `npc-simulation.ts dispatchHatcherActions`/`executeHatcherAction`. Real-CT NEVER flows through the `[ACTION:]` parser — only session-bound tools.

## The silent-drift trap

The §3a manual bounds (move/talk/emote ranges, actions-per-reply, building ids) are HARD-MIRRORED LITERALS of `npc-simulation.ts` module-private constants — they are NOT imported (service↔service cycle avoidance) so they can SILENTLY diverge from the executor.

## On any manual contract change

Editing `buildProtocolManual` content (a verb doc, a bound, a default, a section) OR an `[ACTION:]` verb:
1. Bump `PROTOCOL_VERSION` (defer the constant edit to agent-protocol-partner, align same-diff) — it is the eager re-embed signal partners poll via `manifest.json` (`protocol.version` + `contentHash`).
2. Re-verify §3a bounds == `npc-simulation.ts` constants.
3. Propagate to Nori + hosted runtime (see [[three-surface-knowledge-sync]]).
4. Update `docs/hatcher-integration-spec.md`.
5. Run the mock-Hatcher harness GREEN + a Codex adversarial pass (Hatcher runs LIVE on staging/prod).

## Status: PROTOCOL_VERSION = 6 LIVE (master == staging). v6 added enter_poker_room + the tournament-poker section.

Related: [[three-surface-knowledge-sync]] · [[skill-md-gating-leaderboard-tag]]
