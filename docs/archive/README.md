# docs/archive — historical and one-off notes

This directory holds working notes that were once useful at the repo root
but are no longer current reference material. They are kept around in case
the context they captured turns out to matter later. None of these files
are canonical — see `CLAUDE.md` for the current four canonical docs:

- `CLAUDE.md` — agent operating instructions
- `WorldContent.md` — open-world scene manifest
- `3dStructure.md` — 3D specs (world dims, GPU constraints, perf budget)
- `GameFeatures.md` — gameplay reference
- `ARCHITECTURE.md` — tech-stack reference

---

## Layout

### `audits/`
Past codebase audits with numbered prefixes. Snapshots of "where things
stood" at a specific point — usually before a major refactor.

- `05-codebase-audit-and-gate-plan.md` — feature-gate plan and audit from
  a previous numbering convention. Some recommendations were taken,
  some weren't; check current state before acting on anything here.

### `rewrites/`
Plans/logs for completed migrations. The migrations themselves have
landed; these are the design docs that drove them.

- `avatars-rewrite.md` — the pets → avatars rename pass (2026-05-08).
- `pets-to-avatar-rewrite.md` — same migration, alternate planning doc.
- `eliza-integration-architecture.md` — ElizaOS integration design;
  superseded by the relevant sections in `ARCHITECTURE.md`.

### `design-notes/`
Single-topic notes that captured a specific decision or discovery. The
decision has been made / the discovery applied; the note is here for
historical context.

- `avatar-scale-vs-glb-native-height.md` — scale normalization research.
- `world-labels-overlay.md` — design doc for the single-root
  WorldLabelsOverlay (already implemented in
  `apps/web/src/lib/three/world-labels-overlay.tsx`).
- `improvements.md` — feature-gate proposals; some merged into TODO.md,
  most still pending.

---

## What was deleted, not archived

The following one-off files were removed entirely on the same cleanup
pass — they had no archival value:

- `cv-pr-body.md` — PR description text. The PR is on GitHub.
- `github-support-ticket.md` — text for a GitHub support ticket.

If you need either, GitHub is the source of truth.

---

## Adding to this archive

When you move a file out of repo root:

1. Add a one-line entry under the appropriate subdir in this README so
   the next reader knows what each file is without opening it.
2. Untracked files (`git ls-files --error-unmatch <file>` exits 1) can
   just be `mv`'d — no commit needed for the move itself.
3. Tracked files use `git mv` to preserve history.
