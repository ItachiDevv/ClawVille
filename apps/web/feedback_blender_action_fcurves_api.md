---
name: blender-action-fcurves-api
description: "Blender 4.4+ moved Action.fcurves into a layered slot/channelbag indirection — direct iteration of action.fcurves errors with AttributeError. Always iterate via action.layers[*].strips[*].channelbag(slot).fcurves with a legacy fallback."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 735b5afc-95a7-4172-bd62-c10121462343
---

When writing headless Blender Python that iterates animation curves, do NOT assume `action.fcurves` exists. Blender 4.4+ replaced direct fcurve access with a layered slot/channelbag system. Use a version-tolerant iterator:

```python
def iter_fcurves(action):
    if hasattr(action, "layers"):
        for layer in action.layers:
            for strip in layer.strips:
                for slot in action.slots:
                    cb = strip.channelbag(slot)
                    if cb:
                        for fc in cb.fcurves:
                            yield fc
        return
    # Legacy API (<=4.3)
    for fc in action.fcurves:
        yield fc
```

**Why:** Discovered 2026-05-15 while writing `scripts/mixamo/diagnose-fbx-walk.py` — direct `for fc in action.fcurves` raised `AttributeError: 'Action' object has no attribute 'fcurves'` on Blender 5.1.1. The user's local Blender install is 5.1, and the production Mixamo conversion script (`blender-convert-anims.py`) targets the same version. Any new Blender Python helper that touches keyframes needs the iterator pattern or it'll crash on the first curve access.

**How to apply:** Reach for the helper above whenever you write a new Blender script that reads keyframe data. Existing `blender-convert-anims.py` only sets actions (doesn't iterate fcurves) so it wasn't affected; any future inspector / baker / re-targeter MUST use the iterator. Related: [[blender07-scene-import-ban]].
