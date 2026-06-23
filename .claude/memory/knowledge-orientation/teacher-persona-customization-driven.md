---
name: teacher-persona-customization-driven
description: "the 'everyone answers as Pearl' bug was the eliza-runtime char-builder config-fallback, NOT templates; persona is customization-first + seeder stamps config.locationId (FIXED prod PR #159)"
category: solution
confidence: high
date: 2026-06-22
---

---
name: teacher-persona-customization-driven
description: Teacher persona resolves from customization + stamped config.locationId, NEVER the eliza-runtime cron-automation/Pearl config-fallback. FIXED prod PR #159.
category: solution
confidence: 0.9
date: 2026-06-22
---

# Teacher persona is customization-driven, not template-only

## Symptom (the bug)

ALL teachers + Nori answered as PEARL (the `cron-automation` persona) despite correct templates AND correct DB rows.

## Root cause

The eliza-runtime char-builder `convertToElizaCharacter` (`packages/agent-runtime/src/eliza-runtime.ts`) loaded a HARDCODED `cron-automation`/Pearl fallback for every seeded agent whose `config` was empty (no locationId) AND ignored `customization`. A template rename was necessary-but-INSUFFICIENT — the cause was the RUNTIME char-builder + its config-fallback default, NOT the templates/DB.

## Fix (FIXED, on prod)

1. Made `convertToElizaCharacter` **customization-FIRST**.
2. Killed the hardcoded fallback: a missing locationId now resolves to `''`, not a real character (`eliza-runtime.ts:281`).
3. The seeder defensively stamps `config:{locationId:buildingId}` (`system-npc-seeder.ts:197/:210`).
4. Regression test: `eliza-runtime.persona.test.ts`.
Shipped PR #159 / `8520fe1b`; VERIFIED on prod via live probe.

## Lesson

Persona wrong but DB/template correct ⇒ check the RUNTIME char builder + its config-fallback defaults, NOT just the templates.

Related: [[system-npc-seeder]] · [[llm-provider-openai-only]]
