"""
Blender Python script — Mixamo FBX -> VRM 1.0 finalize.

Run via blender-mcp (mcp__blender__execute_blender_code) with these globals injected:
  CHARACTER  = "male" | "female"
  FBX_PATH   = absolute path to *-mixamo.fbx
  VRM_PATH   = absolute path to write final .vrm

Requires:
  - Blender 4.x
  - VRM_Addon_for_Blender (Saturday06, https://vrm-addon-for-blender.info)
"""

import bpy
import os

# ---------------- args (injected from MCP call) ----------------
try:
    CHARACTER  # noqa
    FBX_PATH   # noqa
    VRM_PATH   # noqa
except NameError:
    raise SystemExit("Set CHARACTER, FBX_PATH, VRM_PATH before exec")

assert os.path.isfile(FBX_PATH), f"FBX not found: {FBX_PATH}"

# ---------------- 0. clean slate (DO NOT use read_factory_settings — it
# disables BlenderMCP itself and kills our socket. Just delete current objects.)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for col in list(bpy.data.collections):
    if col.name != "Collection":  # keep default
        bpy.data.collections.remove(col)
# also drop orphan meshes/armatures/materials so the scene is fully clean
for blk in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
    for item in list(blk):
        if item.users == 0:
            blk.remove(item)

# ---------------- 1. confirm VRM addon present ----------------
if "io_scene_vrm" not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module="io_scene_vrm")
    except Exception as e:
        raise SystemExit(
            "VRM_Addon_for_Blender (io_scene_vrm) is not installed. "
            "Install from https://vrm-addon-for-blender.info, then retry. "
            f"Underlying error: {e}"
        )

# ---------------- 2. import Mixamo FBX ----------------
print(f"[hermes] Importing {FBX_PATH}")
bpy.ops.import_scene.fbx(
    filepath=FBX_PATH,
    automatic_bone_orientation=True,
    ignore_leaf_bones=False,
    use_anim=False,
)

armature = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
mesh     = next((o for o in bpy.context.scene.objects if o.type == "MESH"), None)
assert armature is not None, "No armature in imported FBX"
assert mesh is not None,     "No mesh in imported FBX"
print(f"[hermes] Armature='{armature.name}'  Mesh='{mesh.name}'  bones={len(armature.data.bones)}")

# Mixamo's import scale: armature is often 0.01 (FBX units cm vs Blender m).
# Apply transforms so vert positions are clean.
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

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
    print(f"[hermes] WARN: missing bones (will skip in mapping): {missing}")

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
        print(f"[hermes] no slot '{vrm_slot}' in human_bones (skip)")

print(f"[hermes] Assigned {assigned}/{len(MIXAMO_TO_VRM)} humanoid bones")

# Required meta (VRM 1.0 demands these or export errors out)
meta = ext.vrm1.meta
meta.vrm_name        = f"Hermes-{CHARACTER.capitalize()}"
meta.version         = "1.0.0"
meta.authors.clear()
a = meta.authors.add(); a.value = "ClawVille"
meta.copyright_information = "ClawVille internal asset"
meta.contact_information   = ""
meta.license_url           = ""

# ---------------- 5. export VRM ----------------
os.makedirs(os.path.dirname(VRM_PATH), exist_ok=True)
print(f"[hermes] Exporting -> {VRM_PATH}")
bpy.ops.export_scene.vrm(
    filepath=VRM_PATH,
    export_invisibles=False,
    enable_advanced_preferences=False,
)
size_kb = os.path.getsize(VRM_PATH) / 1024
print(f"[hermes] Done. {VRM_PATH} ({size_kb:.0f} KB)")
