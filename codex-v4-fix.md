Working dir already set. Branch: perf/meshlet-integration. Do not push to staging/master.

ONE surgical change. Do not dump diagnostics. Do not read entire files end-to-end. Make the edits, build, commit, push.

Files:
- apps/web/src/lib/three/meshlet/build-buildings-atlas.ts
- apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts
- apps/web/src/app/preview/meshlet-spike-all-12/page.tsx

Edit: remove every solid-color / fallbackColor code path. If a sub-mesh has no drawable diffuse map (material.map is null OR the image fails to draw to canvas), SKIP that sub-mesh entirely — do not include it in the merge inputs, do not reserve an atlas slot. material.color must be ignored. The atlas should only contain real GLB diffuse images.

Do NOT modify apps/web/src/lib/three/experimental/nanite-rasterizer.ts.

After edits:
  cd apps/web && bun run build 2>&1 | tail -10

If green, commit and push:
  cd .. && git add -A
  git commit -m "phase-b v4: skip sub-meshes without drawable diffuse — no more guessed solid colors"
  unset GITHUB_TOKEN && git push origin perf/meshlet-integration

Report only: commit hash + build status (green/red). Done.
