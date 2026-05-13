# Blender headless Mixamo-FBX → mesh-free animation GLB batch converter.
#
# Each input FBX from Mixamo contains: a character mesh + skeleton + the animation
# baked onto that skeleton (Skin: With Skin). We only need the skeleton + keyframes
# for runtime retargeting — three.js plays the AnimationClip on the VRM via
# vrm-character-animator.ts. Stripping the mesh drops the GLB size from
# ~2 MB to ~50–250 KB per clip.
#
# Invoked as:
#   blender --background --python blender-convert-anims.py -- <src_dir> <out_dir>
#
# Arguments are everything after the literal `--`. Blender's own argv comes first.
#
# src_dir: directory of <slug>-<slot>.fbx files produced by fetch-animations.ts
# out_dir: target dir for <slot>.glb files (apps/web/public/avatars/animations/<slug>/)

import bpy
import os
import sys

# Parse args after the literal `--` separator (Blender's own argv ends there).
argv = sys.argv
if "--" in argv:
    user_argv = argv[argv.index("--") + 1:]
else:
    user_argv = []

if len(user_argv) != 2:
    print("usage: blender --background --python blender-convert-anims.py -- <src_dir> <out_dir>")
    sys.exit(1)

SRC_DIR, OUT_DIR = user_argv
os.makedirs(OUT_DIR, exist_ok=True)


def nuke():
    """Reset Blender's scene between FBX imports.

    Mixamo FBXs leave residual actions in bpy.data.actions even after the owning
    armature is deleted, which means the next clip's GLB export would bundle the
    PREVIOUS clip's keyframes. Force-remove all actions; the existing
    'orphan-prune' helpers don't because action.users stays > 0 while bound to
    the deleted armature's animation_data slot for a tick.
    """
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a, do_unlink=True)
    for db in (
        bpy.data.meshes,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for item in list(db):
            if item.users == 0:
                db.remove(item)


# Inputs: <SRC_DIR>/<anything>-<slot>.fbx. The slot is whatever the TS script
# named the FBX; we derive it from the filename (strip path + extension + the
# leading slug prefix). The TS script writes them as `<slug>-<slot>.fbx`.
fbx_paths = sorted(
    os.path.join(SRC_DIR, f)
    for f in os.listdir(SRC_DIR)
    if f.lower().endswith(".fbx")
)

if not fbx_paths:
    print(f"no .fbx files in {SRC_DIR}")
    sys.exit(0)

print(f"=== converting {len(fbx_paths)} FBXs from {SRC_DIR} → {OUT_DIR} ===")

results = []
for src in fbx_paths:
    fname = os.path.basename(src)
    base = os.path.splitext(fname)[0]
    # Filename pattern from fetch-animations.ts is `<slug>-<slot>.fbx`. Take
    # the last hyphen-segment as the slot so multi-hyphen slugs still work
    # (e.g. "hermes-male-cheering.fbx" → slot "cheering").
    parts = base.split("-")
    slot = parts[-1] if len(parts) > 1 else base

    nuke()
    print(f"\n--- {slot} ---")
    print(f"  pre-import actions: {len(bpy.data.actions)}")

    bpy.ops.import_scene.fbx(filepath=src, global_scale=100, use_anim=True)

    if bpy.data.actions:
        bpy.data.actions[0].name = slot
    else:
        print(f"  WARN: no action found in {fname}, skipping")
        continue

    # Strip the mesh — we only ship the skeleton + animation; runtime uses the
    # VRM's own mesh and retargets to its bones via the action.
    for o in list(bpy.context.scene.objects):
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)

    # Find the armature, ensure exactly its action is bound (not whatever
    # bpy.data.actions[0] happens to be after a prior iteration).
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    if not arm.animation_data:
        arm.animation_data_create()
    arm.animation_data.action = bpy.data.actions[0]

    out = os.path.join(OUT_DIR, f"{slot}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_animations=True,
        export_force_sampling=True,
        export_nla_strips=False,
        export_apply=False,
        use_selection=False,
    )
    sz = os.path.getsize(out)
    results.append((slot, sz))
    print(f"  → {os.path.basename(out)} ({sz / 1024:.1f} KB)")

print(f"\n=== done: {len(results)} GLBs ===")
total = sum(s for _, s in results)
for slot, sz in results:
    print(f"  {slot}.glb: {sz / 1024:.1f} KB")
print(f"  TOTAL: {total / 1024:.1f} KB ({total / 1024 / 1024:.2f} MB)")
