# Headless Blender FBX inspector — dumps mixamorig:Hips translation curves
# for a Mixamo .fbx so we can tell whether the "shoot vertical" bug is in
# the Mixamo bake (root motion in the FBX) or in the Blender FBX→GLB
# conversion (axis swap turning forward Z into Y).
#
# Usage:
#   blender --background --python diagnose-fbx-walk.py -- <path-to-walk.fbx>
#
# Prints:
#   - axis info from the FBX file (Up axis, Forward axis from header)
#   - bind-pose hip Y at scale=1
#   - per-frame Hips location_x/y/z keyframe values
#   - per-frame Hips delta_location_x/y/z if any
#   - frame range + frame count

import bpy
import sys
import os

argv = sys.argv
user_argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(user_argv) != 1:
    print("usage: blender --background --python diagnose-fbx-walk.py -- <path-to-fbx>")
    sys.exit(1)

FBX = user_argv[0]
if not os.path.exists(FBX):
    print(f"file not found: {FBX}")
    sys.exit(1)

# Reset scene
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a, do_unlink=True)

print(f"\n=== Importing {FBX} (global_scale=100 — same as production) ===")
bpy.ops.import_scene.fbx(filepath=FBX, global_scale=100, use_anim=True)

print(f"\n--- bpy.context.scene.unit_settings ---")
us = bpy.context.scene.unit_settings
print(f"  system={us.system}  scale_length={us.scale_length}")

print(f"\n--- objects ---")
for o in bpy.context.scene.objects:
    print(f"  {o.name} type={o.type}")

# Find the armature
arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
if not arm:
    print("ERROR: no armature found in scene")
    sys.exit(1)

print(f"\n--- armature: {arm.name} ---")
print(f"  scale={arm.scale}  rotation_euler={tuple(arm.rotation_euler)}")

# Find Hips bone
hips_bone = None
for b in arm.data.bones:
    if "Hips" in b.name:
        hips_bone = b
        break

if hips_bone:
    print(f"\n--- bind-pose Hips ({hips_bone.name}) ---")
    print(f"  head_local={tuple(hips_bone.head_local)}")
    print(f"  tail_local={tuple(hips_bone.tail_local)}")

# Dump action keyframes — Blender 4.4+ uses slot/channelbag indirection;
# fall back to iterating through any object's animation_data.action_curves.
def iter_fcurves(action):
    # Modern API (4.4+): action.layers[*].strips[*].channelbag(slot).fcurves
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


print(f"\n--- actions ---")
for action in bpy.data.actions:
    print(f"\nAction: {action.name}  frame_range={action.frame_range}")
    for fc in iter_fcurves(action):
        if "Hips" not in fc.data_path:
            continue
        if "location" not in fc.data_path:
            continue
        vals = [f"{kp.co[1]:.4f}" for kp in fc.keyframe_points]
        axis = ["X", "Y", "Z"][fc.array_index]
        print(f"  {fc.data_path}[{axis}]  ({len(vals)} kfs)")
        print(f"    values: [{', '.join(vals)}]")
        if vals:
            nums = [kp.co[1] for kp in fc.keyframe_points]
            print(f"    min={min(nums):.4f}  max={max(nums):.4f}  range={max(nums)-min(nums):.4f}")

print("\n=== done ===")
