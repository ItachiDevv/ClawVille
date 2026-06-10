"""
Headless CLI wrapper around blender-vrm-finalize.py — same Mixamo→VRM 1.0
finalize logic but takes argv after `--` instead of injected globals, so we
can pipeline it from the shell.

Usage:
  blender --background --python blender-vrm-finalize-cli.py -- <name> <input.fbx> <output.vrm>

Example:
  blender --background --python blender-vrm-finalize-cli.py -- \\
    eliza-chibi  apps/web/public/models/eliza-chibi-mesh/rigged.fbx  apps/web/public/avatars/eliza-chibi.vrm

Requires VRM_Addon_for_Blender (Saturday06).
"""

import bpy
import os
import sys

# ---------------- args ----------------
argv = sys.argv
user_argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(user_argv) != 3:
    print("usage: blender --background --python blender-vrm-finalize-cli.py -- <name> <input.fbx> <output.vrm>")
    sys.exit(1)

CHARACTER, FBX_PATH, VRM_PATH = user_argv
FBX_PATH = os.path.abspath(FBX_PATH)
VRM_PATH = os.path.abspath(VRM_PATH)
assert os.path.isfile(FBX_PATH), f"FBX not found: {FBX_PATH}"

# ---------------- 0. clean slate ----------------
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for col in list(bpy.data.collections):
    if col.name != "Collection":
        bpy.data.collections.remove(col)
for blk in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
    for item in list(blk):
        if item.users == 0:
            blk.remove(item)

# ---------------- 1. confirm VRM addon ----------------
# Blender 4.2+ moved add-ons to the extensions system. The VRM addon's module
# name depends on how it was installed:
#   - Legacy (pre-4.2): "io_scene_vrm"
#   - Extension (4.2+): "bl_ext.user_default.vrm" (or "bl_ext.blender_org.vrm"
#     if installed from the Blender extensions repo).
# Try each in order until one loads.
addons = bpy.context.preferences.addons
already_loaded = (
    "bl_ext.user_default.vrm" in addons
    or "bl_ext.blender_org.vrm" in addons
    or "io_scene_vrm" in addons
)
if not already_loaded:
    for mod_name in (
        "bl_ext.user_default.vrm",
        "bl_ext.blender_org.vrm",
        "io_scene_vrm",
    ):
        try:
            bpy.ops.preferences.addon_enable(module=mod_name)
            print(f"[vrm-finalize] enabled VRM addon: {mod_name}")
            break
        except Exception as e:
            print(f"[vrm-finalize] {mod_name} not available ({e})")
    else:
        raise SystemExit(
            "VRM_Addon_for_Blender is not installed in this Blender. "
            "Install from https://vrm-addon-for-blender.info."
        )

# ---------------- 2. import Mixamo FBX ----------------
print(f"[vrm-finalize] Importing {FBX_PATH}")
bpy.ops.import_scene.fbx(
    filepath=FBX_PATH,
    automatic_bone_orientation=True,
    ignore_leaf_bones=False,
    use_anim=False,
    global_scale=100.0,  # Mixamo FBX is cm → import cm->m so verts land ~1m tall.
)                        # hermes dfabf725: do NOT rely on transform_apply(scale) — it bakes the 0.01 and shrinks the mesh 100x.

armature = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
mesh     = next((o for o in bpy.context.scene.objects if o.type == "MESH"), None)
assert armature is not None, "No armature in imported FBX"
assert mesh is not None,     "No mesh in imported FBX"
print(f"[vrm-finalize] Armature='{armature.name}'  Mesh='{mesh.name}'  bones={len(armature.data.bones)}")

# global_scale=100 at import already did the cm->m conversion (armature scale ~1.0),
# so this apply is now just cleaning loc/rot, NOT baking a 0.01 shrink.
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# WELD split-vertex islands + recalc normals (hermes c565445a). Meshy/Tripo ship
# the mesh UNWELDED — sub-mm duplicate verts → tens of thousands of non-manifold
# islands → bad shading in realtime AND dress/cloth "shredding" when rigged (each
# island follows its own bone after the 4-influence export cap). Merge-by-distance
# fixes both. Weights of merged verts are averaged correctly by Blender.
_v0 = len(mesh.data.vertices)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
bpy.context.view_layer.objects.active = mesh
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.001)
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[vrm-finalize] welded + recalc normals: {_v0} -> {len(mesh.data.vertices)} verts")

# ---------------- 3. canonical Mixamo -> VRM 1.0 humanoid map ----------------
# Source: .claude/memory/threejs/patterns/vrm-mixamo-retarget.md
# NB: VRM Add-on uses snake_case slot names on the Python side
# (Vrm1HumanBonesPropertyGroup attrs), even though VRM 1.0 JSON uses camelCase.
MIXAMO_TO_VRM = {
    "hips":            "mixamorig:Hips",
    "spine":           "mixamorig:Spine",
    "chest":           "mixamorig:Spine1",
    "upper_chest":     "mixamorig:Spine2",
    "neck":            "mixamorig:Neck",
    "head":            "mixamorig:Head",
    "left_shoulder":   "mixamorig:LeftShoulder",
    "left_upper_arm":  "mixamorig:LeftArm",
    "left_lower_arm":  "mixamorig:LeftForeArm",
    "left_hand":       "mixamorig:LeftHand",
    "right_shoulder":  "mixamorig:RightShoulder",
    "right_upper_arm": "mixamorig:RightArm",
    "right_lower_arm": "mixamorig:RightForeArm",
    "right_hand":      "mixamorig:RightHand",
    "left_upper_leg":  "mixamorig:LeftUpLeg",
    "left_lower_leg":  "mixamorig:LeftLeg",
    "left_foot":       "mixamorig:LeftFoot",
    "left_toes":       "mixamorig:LeftToeBase",
    "right_upper_leg": "mixamorig:RightUpLeg",
    "right_lower_leg": "mixamorig:RightLeg",
    "right_foot":      "mixamorig:RightFoot",
    "right_toes":      "mixamorig:RightToeBase",
}

bone_names = {b.name for b in armature.data.bones}
missing = [m for m in MIXAMO_TO_VRM.values() if m not in bone_names]
if missing:
    print(f"[vrm-finalize] WARN: missing bones (will skip in mapping): {missing}")

# ---------------- 4. assign VRM humanoid bones ----------------
ext = armature.data.vrm_addon_extension
ext.spec_version = "1.0"
human_bones = ext.vrm1.humanoid.human_bones

assigned = 0
for vrm_slot, mixamo_name in MIXAMO_TO_VRM.items():
    if mixamo_name not in bone_names:
        continue
    try:
        getattr(human_bones, vrm_slot).node.bone_name = mixamo_name
        assigned += 1
    except AttributeError:
        print(f"[vrm-finalize] no slot '{vrm_slot}' in human_bones (skip)")

print(f"[vrm-finalize] Assigned {assigned}/{len(MIXAMO_TO_VRM)} humanoid bones")

# Required meta (VRM 1.0 export errors out without these)
meta = ext.vrm1.meta
meta.vrm_name        = CHARACTER
meta.version         = "1.0.0"
meta.authors.clear()
a = meta.authors.add(); a.value = "ClawVille"
meta.copyright_information = "ClawVille internal asset"
meta.contact_information   = ""
meta.license_url           = ""

# ---------------- 5. export VRM ----------------
os.makedirs(os.path.dirname(VRM_PATH), exist_ok=True)
print(f"[vrm-finalize] Exporting -> {VRM_PATH}")
bpy.ops.export_scene.vrm(
    filepath=VRM_PATH,
    export_invisibles=False,
    enable_advanced_preferences=False,
)
size_kb = os.path.getsize(VRM_PATH) / 1024
print(f"[vrm-finalize] Done. {VRM_PATH} ({size_kb:.0f} KB)")
