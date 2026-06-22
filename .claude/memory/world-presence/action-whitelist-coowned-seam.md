---
name: action-whitelist-coowned-seam
description: "The [ACTION:] executor (npc-simulation) is the authoritative hard gate but the manual + PROTOCOL_VERSION are agent-protocol-partner's — move all three same-diff with a Codex pass + mock-Hatcher harness."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: action-whitelist-coowned-seam
description: The [ACTION:] whitelist is co-owned — executor here, manual + PROTOCOL_VERSION at agent-protocol-partner; move all three same-diff with a Codex pass + mock-Hatcher harness.
category: constraint
confidence: 0.95
date: 2026-06-22
---

# The [ACTION:] whitelist is a co-owned, move-together seam

**Ownership split (verified):** `world-presence` owns the AUTHORITATIVE executor body — `npc-simulation.ts` `dispatchHatcherActions:1126` / `executeHatcherAction:1182` — the deny-by-default hard gate where safety lives and which never depends on the manual. `agent-protocol-partner` owns the §3a manual in `skill-protocol.ts buildProtocolManual` + `PROTOCOL_VERSION` (`skill-protocol.ts:63`, currently **6**).

**v6 = exactly 6 verbs** (verified by reading the switch): `move`:1189, `emote`:1208, `enter_building`:1221, `enter_cove`:1243, `enter_poker_room`:1271, `talk_to_npc`:1298. Unknown verb -> `default` -> drop+log.

**The same-diff rule:** add/remove/change a verb, a param, or a bound -> edit the executor HERE **and** the §3a manual **and** bump `PROTOCOL_VERSION` in ONE diff. This is the PROTECTED Hatcher partner surface (CLAUDE.md 'Hatcher action whitelist parity'): invoke `codex:codex-rescue` for an adversarial pass AND run the mock-Hatcher harness (`apps/api/scripts/hatcher/run-mock-e2e.md`) GREEN on staging. `bun test` green is NOT a substitute. Connected agents poll the manual on entry + re-pull on `orientation.version` bump — the version bump is how an expanded whitelist reaches the LIVE partner.

**Hard-mirrored literals that silently diverge:** the executor's module-private bounds (`HATCHER_MOVE_MIN`=32, `HATCHER_MOVE_MAX`=MAP_WIDTH-32, `HATCHER_TALK_MESSAGE_MAX`=500, `MAX_HATCHER_ACTIONS_PER_REPLY`=4, the emote-map keys, the 10 building ids) appear as literal text in §3a — re-verify they match on every change.

**FIXED / present + correct (2026-06-22):** v6 executor and §3a manual agree (verified). INVARIANT (always-on). Related: `[[action-executor-hard-gate]]` `[[whitelist-manual-protocol-parity]]` `[[action-parser-is-motion-and-speech-only]]` `[[two-body-controlled-launch]]`.
