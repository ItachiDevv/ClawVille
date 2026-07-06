---
name: intermediate-backups-before-destructive-3d-edits
description: Snapshot the GLB (or any 3D asset) after each successful edit and before the next destructive operation — not just once at the start of a session
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3c19235e-7fee-4160-8ca6-2586a33b60dc
---

When making multiple sequential edits to a GLB / 3D asset in Blender (or any irreversible mesh operation pipeline), save an intermediate backup AFTER each successful edit, BEFORE attempting the next one. A single "before everything" backup doesn't let you revert just the last bad step.

**Why:** During the casino-interior.glb session 2026-05-19, I made one backup (`casino-interior.glb.bak-pre-table-removal-2026-05-19`) at the start. Then layered 3 edits: (1) delete BC/FC tables+chairs ✓, (2) move dealer station ✓, (3) redistribute slot machines ✗ (algorithm fragmented chairs, deleted 102k verts irreversibly via `bmesh.ops.delete`). When edit #3 went bad, the only recovery path was to restore the pristine original and redo edits #1 and #2 from scratch — wasted ~15 min. If I'd snapshotted after #2, I could have rolled back just #3.

**How to apply:**
- Before each new destructive Blender/bmesh operation, write an intermediate GLB export to `.tmp/<asset>-checkpoint-<step>-<date>.glb` (uncompressed is fine — fast to write).
- Track checkpoints by step name so you can identify which one to restore.
- Particularly important for: `bmesh.ops.delete`, vertex translation across many verts, scaling that compounds with prior operations, anything that modifies more than a few hundred verts.
- The trivial cost (a few MB of disk per checkpoint) is always worth it.
- Related: [[blender07-scene-import-ban]] — never `append` a `.blend` into the live working scene; use headless inspection instead.
