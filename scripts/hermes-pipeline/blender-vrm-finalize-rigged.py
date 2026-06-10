"""
Finalize a Mixamo-rigged FBX (textures already embedded by Mixamo's FBX export)
into a VRM 1.0. Unlike the other two finalize scripts this one:
  - imports at the FBX's own scale and ASSERTS the result is human-height
    (this Meshy->Mixamo FBX already lands ~1.9 m at global_scale=1.0; the
    cli.py global_scale=100 would make it 191 m). No blind cm->m baking.
  - keeps the material + textures that came IN the FBX (no GLB re-extract,
    so we never accidentally bind the normal map as base color).
  - gentle merge-by-distance only at 1e-5 (cleans exact dup verts from FBX
    seam-splitting without collapsing UV islands).
  - optional MToon1 enable via the 4th arg "mtoon".

Usage:
  blender --background --python blender-vrm-finalize-rigged.py -- <name> <rigged.fbx> <out.vrm> [mtoon]
"""
import bpy, os, sys

argv = sys.argv
ua = argv[argv.index("--")+1:] if "--" in argv else []
if len(ua) not in (3, 4):
    print("usage: ... -- <name> <rigged.fbx> <out.vrm> [mtoon]"); sys.exit(1)
CHARACTER, FBX_PATH, VRM_PATH = ua[:3]
ENABLE_MTOON = (len(ua) == 4 and ua[3].lower() == "mtoon")
FBX_PATH = os.path.abspath(FBX_PATH); VRM_PATH = os.path.abspath(VRM_PATH)
assert os.path.isfile(FBX_PATH), f"FBX not found: {FBX_PATH}"

# ---- 0. clean slate ----
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections):
    if c.name != "Collection": bpy.data.collections.remove(c)
for blk in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
    for it in list(blk):
        if it.users == 0: blk.remove(it)

# ---- 1. VRM addon ----
addons = bpy.context.preferences.addons
if not any(m in addons for m in ("bl_ext.user_default.vrm","bl_ext.blender_org.vrm","io_scene_vrm")):
    for m in ("bl_ext.user_default.vrm","bl_ext.blender_org.vrm","io_scene_vrm"):
        try: bpy.ops.preferences.addon_enable(module=m); print(f"[fin] addon {m}"); break
        except Exception as e: print(f"[fin] {m} n/a ({e})")
    else: raise SystemExit("VRM addon not installed")

# ---- 2. import rigged FBX at native scale ----
print(f"[fin] import {FBX_PATH}")
bpy.ops.import_scene.fbx(filepath=FBX_PATH, automatic_bone_orientation=True,
                         ignore_leaf_bones=False, use_anim=False)
arm  = next((o for o in bpy.context.scene.objects if o.type=="ARMATURE"), None)
mesh = next((o for o in bpy.context.scene.objects if o.type=="MESH"), None)
assert arm and mesh, "need armature + mesh"
print(f"[fin] armature={arm.name} bones={len(arm.data.bones)} mesh={mesh.name}")

bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True); mesh.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# height assert (catch the cm/m trap loudly instead of shipping a 191 m avatar)
from mathutils import Vector
zs = [(mesh.matrix_world @ Vector(c)).z for c in mesh.bound_box]
H = max(zs) - min(zs)
print(f"[fin] mesh height = {H:.3f} m")
assert 1.0 <= H <= 2.6, f"height {H:.2f} not human — scale wrong, refusing to export"

# ---- 3. gentle dedup (exact FBX seam-split dups only; do NOT collapse UV islands) ----
v0 = len(mesh.data.vertices)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True); bpy.context.view_layer.objects.active = mesh
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.00001)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[fin] dedup {v0} -> {len(mesh.data.vertices)} verts")

# ---- 4. material: keep embedded, ensure sRGB base color + packed ----
diffuse_img = None
for slot in mesh.material_slots:
    mat = slot.material
    if not mat or not mat.use_nodes: continue
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type=="BSDF_PRINCIPLED"), None)
    if not bsdf: continue
    bc = bsdf.inputs["Base Color"]
    if bc.is_linked:
        src = bc.links[0].from_node
        if src.type == "TEX_IMAGE" and src.image:
            src.image.colorspace_settings.name = "sRGB"
            if not src.image.packed_file:
                try: src.image.pack()
                except Exception as e: print(f"[fin] pack warn {e}")
            diffuse_img = src.image
            print(f"[fin] base color img: {src.image.name} {src.image.size[0]}x{src.image.size[1]}")
if diffuse_img is None:
    print("[fin] WARN: no base color texture found on any material")

# NOTE (2026-06-10): do NOT kill the Emission wiring. Meshy bakes its lighting
# into an emissive duplicate of the base color — removing it sinks the eyes
# into shadow and turns the skin waxy. The emissive copy is load-bearing.

# ---- 5. optional MToon1 ----
if ENABLE_MTOON and diffuse_img is not None:
    for slot in mesh.material_slots:
        mat = slot.material
        if not mat: continue
        try:
            mtoon = mat.vrm_addon_extension.mtoon1
            mtoon.enabled = True
            mtoon.pbr_metallic_roughness.base_color_texture.index.source = diffuse_img
            print(f"[fin] MToon enabled on {mat.name}")
        except Exception as e:
            print(f"[fin] MToon enable failed on {mat.name}: {e}")

# ---- 6. humanoid bones ----
MAP = {
 "hips":"mixamorig:Hips","spine":"mixamorig:Spine","chest":"mixamorig:Spine1",
 "upper_chest":"mixamorig:Spine2","neck":"mixamorig:Neck","head":"mixamorig:Head",
 "left_shoulder":"mixamorig:LeftShoulder","left_upper_arm":"mixamorig:LeftArm",
 "left_lower_arm":"mixamorig:LeftForeArm","left_hand":"mixamorig:LeftHand",
 "right_shoulder":"mixamorig:RightShoulder","right_upper_arm":"mixamorig:RightArm",
 "right_lower_arm":"mixamorig:RightForeArm","right_hand":"mixamorig:RightHand",
 "left_upper_leg":"mixamorig:LeftUpLeg","left_lower_leg":"mixamorig:LeftLeg",
 "left_foot":"mixamorig:LeftFoot","left_toes":"mixamorig:LeftToeBase",
 "right_upper_leg":"mixamorig:RightUpLeg","right_lower_leg":"mixamorig:RightLeg",
 "right_foot":"mixamorig:RightFoot","right_toes":"mixamorig:RightToeBase",
}
names = {b.name for b in arm.data.bones}
ext = arm.data.vrm_addon_extension
ext.spec_version = "1.0"
hb = ext.vrm1.humanoid.human_bones
n = 0
for slot, mx in MAP.items():
    if mx not in names: continue
    try: getattr(hb, slot).node.bone_name = mx; n += 1
    except AttributeError: pass
print(f"[fin] humanoid bones {n}/{len(MAP)}")
miss = [m for m in MAP.values() if m not in names]
if miss: print(f"[fin] missing: {miss}")

meta = ext.vrm1.meta
meta.vrm_name = CHARACTER; meta.version = "1.0.0"
meta.authors.clear(); a = meta.authors.add(); a.value = "ClawVille"
meta.copyright_information = "ClawVille internal asset"

# ---- 7. export ----
os.makedirs(os.path.dirname(VRM_PATH), exist_ok=True)
print(f"[fin] export -> {VRM_PATH}")
bpy.ops.export_scene.vrm(filepath=VRM_PATH, export_invisibles=False, enable_advanced_preferences=False)
print(f"[fin] DONE {VRM_PATH} ({os.path.getsize(VRM_PATH)/1024:.0f} KB)")
