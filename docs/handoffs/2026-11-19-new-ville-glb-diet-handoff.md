# Handoff: session new-ville, GLB diet round 2 (2026-11-19 03:06Z)

Branch `perf/glb-diet-2` (worktree `.worktrees/game-load-perf`, tracks `origin/staging`).
Last code commit `9004a6c20`; last docs commit `d4b3bf65c` (before this file). Nothing is running.

## What this session did
- Built a GLB before/after quality check: `scripts/models/glb-compare.mjs` (+ `glb-compare.html`,
  `glb-breakdown.mjs`, `glb-compare-selftest.mjs`, `glb-geometry-pack.mjs`, `glb-set-texture.mjs`,
  `glb-copy-textures.mjs`). It renders far, mid, game-camera, high and worst-case views, scores
  PSNR / SSIM / per-tile detail, renders BEFORE geometry with AFTER textures (texture-only loss),
  and decodes both files for position / normal / UV error and lost or moved triangles.
  Exit 1 = BLOCK. Selftest (`glb-compare-selftest.mjs <float-position good.glb> <work-dir>`) prints SELFTEST PASS.
- Codex E3 review: rounds 1-3 BLOCK (all fixed, each with a selftest fixture), round 4 APPROVE.
- Shipped to staging (verified 2026-11-14 02:05Z: CI 43542785583 green, both containers
  SOURCE_COMMIT `9004a6c20`, all three GLBs 200, desktop Chrome /game 0 console errors):
  - Pavilion `quest-bounty-pavilion-v3-ktx.glb` 2,999,016 -> 2,068,664 bytes. Fixes the softer
    display boards of the 11-12 256 px staging file (deleted).
  - Arcade `arcade/claw-arcade-exterior-opt2-mo-ktx.glb` 835,240 -> 604,816 bytes.
  - Shisha `shisha-oasis-v2-mo-ktx.glb` 547,828 -> 498,756 bytes.
- Rejected by the check (kept their size): one arcade map, bazaar stand map, lobster map.
  Lobster geometry not changed (10 call sites read its local bounds).
- Docs: 3dStructure.md top entry, FOUNDER-REVIEW.md PERF entry, deploy-status.md DEPLOY LOG 2026-11-14 02:06Z.

## NOT on prod
Prod = `f87ec1734` (promotion #29). These web items are staging only.

## Next steps
1. Founder eyes: staging /game, walk to the pavilion boards, arcade sign, shisha stall; compare to prod.
2. Measure load time on staging with the stage probe (never prod).
3. Check other boot models with `glb-compare.mjs`. Skip IP models (pineapple, chum-bucket,
   krusty-krab, patrick's rock, squidward house, characters: founder is phasing them out) and
   brainchain-office unless session brainchain agrees.
4. After a prod promotion that carries the new paths: delete old `claw-arcade-exterior-opt1-ktx.glb`
   and `shisha-oasis-mo-ktx.glb`, then remove this worktree (unlink `.claude` junctions with
   `cmd /c rmdir`, `cmd /c rmdir /s /q node_modules`, `git worktree remove`, delete the branch).
5. Release gates before promotion: `agent-onboarding-smoke.ts`, `hosted-skill-runtime-probe.ts`, E5 audit.

## Open questions for the owner
- Do the three models look the same as prod on staging?
- The arcade exterior shows a Pac-Man figure and a Rayman poster. Is it part of the IP phase-out?
- Other founder eyes owed from this session: emote bar hidden, shadows off, Trading Floor terminal.
- Phone loader fallback still closes at about 20-28 s (not fixed).

## Rules still in force
No local app test runs on itachi222 until the junction/casing error is fixed (test on staging).
`docker builder prune -af` on staging before every code push; staging disk was 76% after the last build.
