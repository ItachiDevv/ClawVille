# Canonical doc path drift, 2026-09-29

Owner: any session that edits the canonical docs (fix one reference, shrink the baseline).
Tracker: `scripts/ci/doc-paths-baseline.txt` (CI fails on NEW missing paths and on stale entries; the baseline grows only through a reviewed `--write-baseline` diff).
Review deadline: 2026-10-31. On deadline: fix every remaining current-state reference, or mark it as history in the doc and regenerate the baseline.
Guard: `scripts/ci/check-doc-paths.ts`, run in the gates coupling job.

The baseline contains 71 missing `<doc><tab><path>` pairs. The checker uses tracked Git paths. A local untracked file does not satisfy a reference.

| Doc | Missing pairs |
| --- | ---: |
| 3dStructure.md | 8 |
| ARCHITECTURE.md | 35 |
| GameFeatures.md | 26 |
| docs/DEPLOY-HETZNER.md | 2 |

## Current-state references to fix first

These lines describe a component, route, or build tool as present. The referenced repo path has no tracked file at that path. Historical entries in dated audit logs are excluded from this list.

| Doc line | Missing path | Review reason |
| --- | --- | --- |
| 3dStructure.md:2469 | `apps/web/src/app/casino/` | Section describes the casino route. |
| 3dStructure.md:2475 | `apps/web/src/app/casino/page.tsx` | Route table describes a page. |
| 3dStructure.md:2477 | `apps/web/src/components/three/CasinoCanvas.tsx` | Route table describes a canvas. |
| 3dStructure.md:2478 | `apps/web/src/lib/three/casino-interior.tsx` | Route table describes an interior scene. |
| GameFeatures.md:1256 | `apps/api/src/services/openclaw-session-sweeper.ts` | Sweeper description names a service. |
| GameFeatures.md:1260 | `apps/web/src/app/game/page.tsx` | UI hydration description names a page. |
| GameFeatures.md:2259 | `apps/web/src/components/game/activity/BumperShellsHud.tsx` | Component table names a HUD. |
| GameFeatures.md:2383 | `apps/web/src/components/casino/ui/` | UI description names a directory. |
| GameFeatures.md:2413 | `apps/web/src/app/casino/page.tsx` | Casino section names an interior page. |
| GameFeatures.md:2493 | `apps/web/src/app/cove/page.tsx` | Page mount description names a route. |

