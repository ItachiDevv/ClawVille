---
name: system-npc-seeder
description: "ensureSystemNpcs/ensureSystemAgents idempotent upsert-on-boot, singleton partial index by slug, system-agents-first ordering, Retry-After boot race, add-a-system-agent recipe"
category: pattern
confidence: high
date: 2026-06-22
---

---
name: system-npc-seeder
description: ensureSystemNpcs (10 teachers) + ensureSystemAgents (Nori) upsert on every boot; slug-keyed singleton; system-agents-first to shrink the 503 race.
category: pattern
confidence: 0.92
date: 2026-06-22
---

# System-NPC seeder (idempotent, singleton-safe, boot-ordered)

`apps/api/src/services/system-npc-seeder.ts`:
- `ensureSystemNpcs()` upserts the **10 building teachers** (location_agents rows).
- `ensureSystemAgents()` upserts the **system agents** (Nori et al.).
Both run on EVERY API boot and are safe to re-run — a template/knowledge change reaches live RAG only AFTER redeploy.

## Singleton + slug, never name

System agents are identified by `type='system-agent'` + `customization->>'slug'`, enforced by the partial unique index `platform_agents_system_singleton` (`agents.ts:58-60`, `WHERE type='system-agent'`). Every lookup keys on slug (`system-npc-seeder.ts:352`, `:397` 'NEVER look up by name', `:409`); slug is kept at the TOP LEVEL of `customization`. Names are free-form / duplicate-prone — a name lookup hits the wrong/no row and the index won't protect you.

## Boot ordering + the 503 race

`ensureSystemAgents()` runs FIRST (`index.ts:468`) before `ensureSystemNpcs()` (`:498`), independent of map_locations, to shrink the `POST /api/chat/system/:slug` 503 boot-race window. The route sets `Retry-After: 3` (chat.ts) — clients must back off.

## Add a system agent

(1) write the template, (2) register in `SYSTEM_AGENT_TEMPLATES`, (3) ship. `ensureSystemAgents()` upserts on next boot — no migration (the index already exists).

## Persona stamp (defense-in-depth)

The seeder stamps `config:{locationId:buildingId}` (`:197/:210`) so no empty-config row re-introduces the Pearl default — see [[teacher-persona-customization-driven]].

## Status: LIVE.

Related: [[teacher-persona-customization-driven]] · [[three-surface-knowledge-sync]]
