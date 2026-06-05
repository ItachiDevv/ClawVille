"""
Blender Mixamo FBX → VRM 1.0 finalize WITH textures restored from a source GLB.

Use this variant when the Mixamo round-trip lost textures (FBX export didn't
embed images, so Mixamo received 0×0 texture refs and the VRM finalize gave
us a monochrome avatar). The Rodin/Tripo GLB still has the proper textures
embedded — we re-attach them to the rigged FBX's material before VRM export.

Usage:
  blender --background --python blender-vrm-finalize-with-textures.py -- \\
    <name> <rigged.fbx> <texture-source.glb> <output.vrm>

Example:
  blender --background --python blender-vrm-finalize-with-textures.py -- \\
    eliza-chibi  ~/Downloads/eliza-chibi-FOR-MIXAMO.fbx \\
    apps/web/public/models/eliza-chibi-mesh/raw.glb \\
    apps/web/public/avatars/eliza-chibi.vrm

Requires VRM_Addon_for_Blender (Saturday06) — auto-enabled.
"""

import bpy
import os
import sys

# ---------------- args ----------------
argv = sys.argv
user_argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(user_argv) not in (4, 5):
    print(
        "usage: blender --background --python blender-vrm-finalize-with-textures.py -- "
        "<name> <rigged.fbx> <texture-source.glb> <output.vrm> [rotateZdeg]"
    )
    sys.exit(1)

CHARACTER, FBX_PATH, TEX_GLB, VRM_PATH = user_argv[:4]
# Optional yaw correction (degrees about Z) baked into the rest pose so the
# character faces -Y in Blender (the VRM/glTF front convention). Tripo & Rodin
# image-to-3d meshes frequently come out facing +X -> pass -90. A source that
# already faces -Y (e.g. the Meshy Hermes mesh) needs none -> omit or pass 0.
# Default 0 keeps every existing caller's behaviour identical.
ROTATE_Z = float(user_argv[4]) if len(user_argv) == 5 else 0.0
FBX_PATH = os.path.abspath(FBX_PATH)
TEX_GLB  = os.path.abspath(TEX_GLB)
VRM_PATH = os.path.abspath(VRM_PATH)
assert os.path.isfile(FBX_PATH), f"FBX not found: {FBX_PATH}"
assert os.path.isfile(TEX_GLB),  f"texture GLB not found: {TEX_GLB}"

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

# ---------------- 1. VRM addon ----------------
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
            print(f"[vrm-finalize-tex] enabled VRM addon: {mod_name}")
            break
        except Exception as e:
            print(f"[vrm-finalize-tex] {mod_name} not available ({e})")
    else:
        raise SystemExit("VRM_Addon_for_Blender is not installed.")

# ---------------- 2. import the texture-source GLB FIRST ----------------
# Imports the Rodin/Tripo GLB so its textures land in bpy.data.images first.
# We grab a reference to the diffuse + normal images, then delete the GLB's
# mesh + material before importing the rigged FBX.
print(f"[vrm-finalize-tex] importing texture source: {TEX_GLB}")
bpy.ops.import_scene.gltf(filepath=TEX_GLB)

# Find the textures by name. Rodin standard naming: texture_diffuse, texture_normal,
# texture_metallic-texture_roughness. Tripo may differ — we fall back to any large
# image we can find.
def find_image(*candidates):
    for name in candidates:
        for img in bpy.data.images:
            if img.name == name or img.name.startswith(name):
                if img.size[0] >= 256:
                    return img
    # fallback: any image with a meaningful size
    for img in bpy.data.images:
        if img.size[0] >= 512 and img.name not in ("Render Result", "Viewer Node"):
            return img
    return None

diffuse_img = find_image("texture_diffuse", "diffuse", "base_color", "albedo")
normal_img  = find_image("texture_normal", "normal")
print(f"[vrm-finalize-tex] diffuse: {diffuse_img.name if diffuse_img else 'NONE'} "
      f"({diffuse_img.size[0]}×{diffuse_img.size[1]})" if diffuse_img else "[vrm-finalize-tex] NO diffuse texture found in source GLB")

# Hold strong refs by setting fake users on the images so they survive the
# scene wipe below.
if diffuse_img: diffuse_img.use_fake_user = True
if normal_img:  normal_img.use_fake_user = True

# Wipe the scene of mesh objects (keep images via fake-user)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for blk in (bpy.data.meshes, bpy.data.materials):
    for item in list(blk):
        if item.users == 0:
            blk.remove(item)

# ---------------- 3. import the rigged FBX ----------------
print(f"[vrm-finalize-tex] importing rigged FBX: {FBX_PATH}")
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
print(f"[vrm-finalize-tex] Armature='{armature.name}'  Mesh='{mesh.name}'  bones={len(armature.data.bones)}")

# Apply transforms so vertex positions are clean.
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# ---------------- 3b. facing correction: rest pose must face -Y ----------------
# rotation_mode MUST be set to XYZ first — VRM/FBX armatures often import as
# QUATERNION, in which case assigning rotation_euler is silently ignored.
if ROTATE_Z != 0.0:
    import math as _math
    armature.rotation_mode = "XYZ"
    armature.rotation_euler = (0.0, 0.0, _math.radians(ROTATE_Z))
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    print(f"[vrm-finalize-tex] facing-corrected {ROTATE_Z:+.1f} deg about Z (rest pose now faces -Y)")

# ---------------- 4. patch the mesh material with the preserved texture ----------------
if diffuse_img is not None and mesh.material_slots:
    slot = mesh.material_slots[0]
    if slot.material is None:
        slot.material = bpy.data.materials.new(name="model")
    mat = slot.material
    mat.use_nodes = True
    nt = mat.node_tree
    # Find the BSDF + an existing image-texture node
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new(type="ShaderNodeBsdfPrincipled")
    # Add or reuse the image texture node, point it at the preserved diffuse image
    tex_node = next((n for n in nt.nodes if n.type == "TEX_IMAGE" and n.label == "diffuse"), None)
    if tex_node is None:
        tex_node = nt.nodes.new(type="ShaderNodeTexImage")
        tex_node.label = "diffuse"
    tex_node.image = diffuse_img
    tex_node.image.colorspace_settings.name = "sRGB"
    # Pack the image into the .blend so VRM export embeds it
    if not tex_node.image.packed_file:
        try:
            tex_node.image.pack()
        except Exception as e:
            print(f"[vrm-finalize-tex] WARN: could not pack diffuse image: {e}")
    # Wire base color
    nt.links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
    print(f"[vrm-finalize-tex] patched material '{mat.name}' with diffuse texture")
else:
    print(f"[vrm-finalize-tex] WARN: no diffuse texture or no material slot — VRM will be monochrome again")

# ---------------- 5. assign VRM humanoid bones ----------------
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
        print(f"[vrm-finalize-tex] no slot '{vrm_slot}'")
print(f"[vrm-finalize-tex] assigned {assigned}/{len(MIXAMO_TO_VRM)} humanoid bones")

meta = ext.vrm1.meta
meta.vrm_name = CHARACTER
meta.version  = "1.0.0"
meta.authors.clear()
a = meta.authors.add(); a.value = "ClawVille"
meta.copyright_information = "ClawVille internal asset"
meta.contact_information   = ""
meta.license_url           = ""

# ---------------- 6. export ----------------
os.makedirs(os.path.dirname(VRM_PATH), exist_ok=True)
print(f"[vrm-finalize-tex] exporting -> {VRM_PATH}")
bpy.ops.export_scene.vrm(
    filepath=VRM_PATH,
    export_invisibles=False,
    enable_advanced_preferences=False,
)
size_kb = os.path.getsize(VRM_PATH) / 1024
print(f"[vrm-finalize-tex] done. {VRM_PATH} ({size_kb:.0f} KB)")
