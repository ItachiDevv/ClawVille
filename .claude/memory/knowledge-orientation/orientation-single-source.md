---
name: orientation-single-source
description: "world-facts live in CLAWVILLE_ORIENTATION_KNOWLEDGE; Nori spreads + new avatars append + export prepends; editing town-guide.ts alone drifts 2 of 3 consumers"
category: pattern
confidence: high
date: 2026-06-22
---

---
name: orientation-single-source
description: World-facts live ONCE in CLAWVILLE_ORIENTATION_KNOWLEDGE; spread into Nori + new avatars + export. Editing town-guide.ts alone drifts the copies.
category: pattern
confidence: 0.92
date: 2026-06-22
---

# Orientation single-source (SSOT chain)

World-orientation facts live ONCE in `CLAWVILLE_ORIENTATION_KNOWLEDGE` (`packages/shared/src/constants/orientation-skill.ts`). The constant fans into THREE consumers:

1. **Nori's `knowledge[]`** — `town-guide.ts` SPREADS `...CLAWVILLE_ORIENTATION_KNOWLEDGE`.
2. **Every new avatar's `characterConfig.knowledge`** — `avatars.ts buildCharacterConfig` APPENDS it.
3. **The agent-export skillPack** — `agent-export.ts buildSkillPack` PREPENDS it (also `CLAWVILLE_ORIENTATION_SKILL` wrapper).

## The trap

Adding a world-fact ONLY to `town-guide.ts knowledge[]` reaches Nori but SILENTLY misses new avatars + the export pack. Put the canonical fact in the CONSTANT; only **Nori-VOICE framing** + 'point at the teacher by name' directives are hand-written inline in `town-guide.ts`. Any inline world-fact must be a deliberate, marked grep-safety MIRROR of a constant entry.

## Evidence

- `town-guide.ts` spreads `...CLAWVILLE_ORIENTATION_KNOWLEDGE` in `knowledge[]`.
- `orientation-skill.ts` header states the single-source rule explicitly + lists the 3 fan-out consumers.
- `avatars.ts buildCharacterConfig` + `agent-export.ts buildSkillPack` both read the constant.

## Status: LIVE (master == staging, verified byte-identical 2026-06-22).

Related: [[three-surface-knowledge-sync]] · [[system-npc-seeder]]
