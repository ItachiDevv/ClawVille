---
name: chibi-arm-silhouette-normal
description: "For chibi-proportioned avatars, side-view arm geometry that appears to \"merge\" into the body torso is intentional anatomy, not a Rodin/Tripo defect. Do not regenerate or flag as a bug."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 735b5afc-95a7-4172-bd62-c10121462343
---

When evaluating image-to-mesh outputs (Rodin / Tripo / Meshy) for chibi-proportioned characters, the side-view profile will show stubby arms that visually overlap the torso silhouette. **This is correct.** Chibi arms have a tiny silhouette in orthographic profile relative to the head-dominant torso, so Rodin's triangulation naturally renders them as a bump on the body outline rather than a distinct limb.

**Why:** Past mistake 2026-05-21 — I flagged the eliza-chibi + milady-chibi Rodin side views as "arms merged into body, will need Mixamo marker re-placement" when in fact the mesh was correct chibi anatomy. User pushed back: "These look great, perfect chibi style, what's the issue? that stubby arm is just their style." Cost: nearly triggered an unnecessary regen + ~$0.40 of fal.ai spend.

**How to apply:** Only flag arm-geometry issues on side views for *realistic-proportioned* characters (Hermes-female, Hermes-male, Tekk). For chibi-class avatars (eliza-chibi, milady-chibi, future chibis) the silhouette-merge is expected and ship-ready. Related: [[pause-for-turnaround-approval]], [[humanoid-vrm-autofit]].
