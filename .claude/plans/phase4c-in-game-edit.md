# Phase 4c — In-Game Agent Editing

**Status:** Layer 1 drafted on branch `worktree-agent-edit-layer1` (2026-04-23)

## Problem

Once a player creates their agent via `/create-agent` (Phase 4d), they're
stuck with the initial config. If they picked the wrong VRM, a tone that
doesn't fit, or just want to evolve their character, the only "out" today
is to export to Milady or abandon the pet. That's not the promise —
ClawVille is supposed to be a living, editable agent playground.

## Brand alignment

CLAUDE.md §TOP PROJECT PRIORITIES #4: "Gamified UI + free promotion +
leaderboard". Living/editable agents are a retention lever for the
same reason avatar personalization works in every MMO. Also aligns
with the "mastery curve" call-out in Brand Identity §1 — you tune your
agent, you play with the changes, you learn what works.

## Three layers, ordered by risk + dependency

### Layer 1 — Visual (shipped in this branch)

- **Avatar swap** within the same harness pool (Milady↔Milady, non-Milady↔non-Milady).
  Server enforces the pool constraint so a self-hosted pet can't be promoted to
  hosted Milady by switching avatars.
- **Color re-tint** for GLB avatars. VRMs show a disabled palette + note
  ("MToon preserves native tint").
- **Gender** swap (male / female).

No runtime restart. These fields don't feed Eliza's `characterConfig` — they're
pure visual state consumed by the 3D world and UI only.

**Files:**
- `apps/api/src/routes/pets.ts` — new `PATCH /api/pets/me/appearance` route
- `apps/web/src/lib/api.ts` — `api.editPetAppearance` helper
- `apps/web/src/hooks/use-pet.ts` — `useEditPetAppearance` mutation
- `apps/web/src/components/game/edit-appearance-section.tsx` — collapsible UI
- `apps/web/src/components/game/pet-settings-modal.tsx` — mount point
- `GameFeatures.md` — PetSettingsModal row updated

### Layer 2 — Personality (not in this branch)

- Swap archetype (regenerates `characterConfig.bio / lore / topics / style /
  rules / messageExamples` from the picked archetype preset)
- Change habitat · hobby · greeting triple (also affects stats via
  `calculateStats`)
- Rename (UNIQUE constraint on `pets.name` — requires re-availability check +
  50 ClawToken cost to prevent squatting)

Touches Eliza. Needs runtime stale-flag → reload on next chat message.

**Open decisions:**
- When user hand-tunes characterConfig then re-picks archetype, show a
  destructive-overwrite confirm? Or always preserve hand-tuned fields?
- Is the ClawToken cost a one-time or recurring friction for renames?

### Layer 3 — Advanced Eliza tuning (not in this branch)

Direct textareas for the Eliza `Character` fields: `bio`, `lore`, `topics`,
`adjectives`, `rules`, `style`, `system`, `messageExamples`, optional
`knowledge` chunk curator. Per-field length limits; preview panel that
validates against the Eliza `Character` Zod schema before save.

Power-user mode, opt-in via an "Advanced" toggle so the default modal
stays approachable.

## Non-goals

- **Harness edits.** Milady↔OpenClaw swap is out of scope forever. The
  harness is a product tier (hosted vs. self-hosted) and changing it
  mid-play would either require us to host an external framework
  (which we won't) or migrate their local framework state into
  Milady (one-way, destructive).
- **Identity / wallet rotation.** Phase 5.1 has a separate workflow for
  that.
- **Multi-pet.** Still `pets.userId UNIQUE`; one pet per user.

## Rollout

1. Layer 1 ships to main behind no feature gate — it's purely additive.
2. Layer 2 gated behind a `FEATURE_GATE` comment per CLAUDE.md rules
   until we see telemetry showing Layer 1 adoption justifies the
   runtime-restart plumbing work.
3. Layer 3 only after Layer 2 shows non-trivial usage. Easy to skip
   entirely if nobody asks.
