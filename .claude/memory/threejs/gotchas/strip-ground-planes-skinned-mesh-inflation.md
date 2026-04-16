---
title: stripGroundPlanes full-bounds must use non-skinned bbox (not setFromObject)
category: gotcha
tags: [bbox, skinned-mesh, building, normalization, ground-plane]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary

`stripGroundPlanes()` must compute the full model height from non-SkinnedMesh geometry, NOT `Box3.setFromObject()`. Using `setFromObject` inflates `fullHeight` for any scene with rigged nodes, widening the "is at bottom" threshold and causing real structural geometry to be wrongly stripped.

## Details

The function uses `fullHeight` to determine the "bottom 5%" window: `isAtBottom = bb.max.y < fullMinY + fullHeight * 0.05`. If `fullHeight` is inflated 3× by bind-pose SkinnedMesh nodes, then `fullMinY + fullHeight * 0.05` is far too large — geometry that is actually halfway up the building can be classified as "at the bottom" and stripped.

Fix: traverse only non-SkinnedMesh nodes with `geometry.boundingBox.applyMatrix4(mesh.matrixWorld)` (with `updateMatrixWorld(true)` first), then union the results. Fall back to `setFromObject` only if no non-skinned geometry found.

This is the same approach used by `computeBuildingScale` for height normalization — the two must be consistent or one can strip geometry that the other needs to measure.

## Context

ClawVille buildings measured 210-800 world units instead of uniform 800. The fix to `computeBuildingScale` (use non-skinned bbox for normalization) was correct, but `stripGroundPlanes` still used `setFromObject` for its threshold measurement. This caused some buildings' roof geometry to be stripped before normalization, leaving only the base, which then normalized to 800 correctly — but the visual was wrong.
