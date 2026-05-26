"""
blender-build-guide.py
Builds the ClawVille town guide mesh: stripped body + skirt + piercings.
Output is ready for Mixamo auto-rig upload.

HOW TO RUN:
  1. Open Blender 5.1
  2. FILE -> NEW -> General (discard current session WITHOUT saving)
  3. Top tabs -> Scripting
  4. Text editor (middle panel) -> Open -> select this .py file
  5. Click "Run Script" (triangle button), or press Alt+P
  6. Watch console (Window -> Toggle System Console) for progress
  7. Output: scripts/blender-output/guide-ready-for-mixamo.fbx
           + scripts/blender-output/guide-with-skirt-piercings.blend
"""

import bpy
import os
from mathutils import Vector

# ---------------------------------------------------------------------------
# PATHS — hardcoded to this project
# ---------------------------------------------------------------------------
ROOT    = r"C:\Users\newma\Documents\Crypto\ClawVille"
MODELS  = os.path.join(ROOT, "apps", "web", "public", "models")
OUT_DIR = os.path.join(ROOT, "scripts", "blender-output")
os.makedirs(OUT_DIR, exist_ok=True)

GUIDE_GLB     = os.path.join(MODELS, "guide.glb")
SKIRT_GLB     = os.path.join(MODELS, "skirt_9.glb")
PIERCINGS_GLB = os.path.join(MODELS, "piercings_2.glb")

# ---------------------------------------------------------------------------
# 1. RESET — wipe all data blocks, then add a dummy active object so Blender's
#    glTF importer doesn't crash on `bpy.context.object == None`
# ---------------------------------------------------------------------------
print("=" * 70)
print("[1/9] Resetting scene (manual wipe + context holder)")

# Remove all objects
for obj in list(bpy.data.objects):
    try:
        bpy.data.objects.remove(obj, do_unlink=True)
    except Exception:
        pass

# Remove all orphan data blocks so the next import starts clean
for block_list in [
    bpy.data.meshes, bpy.data.materials, bpy.data.images,
    bpy.data.armatures, bpy.data.cameras, bpy.data.lights,
    bpy.data.actions, bpy.data.node_groups,
]:
    for block in list(block_list):
        try:
            block_list.remove(block)
        except Exception:
            pass

# Blender 5.1 glTF importer calls bpy.context.object inside armature_display().
# If there's no active object, it raises AttributeError. Add a temp cube so
# bpy.context.object is non-None during the first import.
bpy.ops.mesh.primitive_cube_add(location=(0, -1000, 0))
_ctx_holder = bpy.context.active_object
_ctx_holder.name = "_ctx_tmp_delete_me"
_ctx_holder.hide_viewport = True

# ---------------------------------------------------------------------------
# 2. IMPORT GUIDE — fresh, untouched texture
# ---------------------------------------------------------------------------
print("[2/9] Importing guide.glb")
bpy.ops.import_scene.gltf(filepath=GUIDE_GLB)

# Find the armature (will need its bones for placement)
guide_armature = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if guide_armature is None:
    raise RuntimeError("No armature found in guide.glb — import failed")
print(f"  armature: {guide_armature.name}")

# ---------------------------------------------------------------------------
# 3. STRIP CLOTHING — delete every mesh using the 'cloth' material
# ---------------------------------------------------------------------------
print("[3/9] Stripping all cloth meshes (coat, shoes, scarf, buttons, pants, top)")
to_delete = []
for obj in list(bpy.data.objects):
    if obj.type != 'MESH':
        continue
    for slot in obj.material_slots:
        if slot.material and slot.material.name == 'cloth':
            to_delete.append(obj)
            break

for obj in to_delete:
    print(f"  deleting: {obj.name} (verts={len(obj.data.vertices)})")
    bpy.data.objects.remove(obj, do_unlink=True)

# ---------------------------------------------------------------------------
# 4. READ HIP + CHEST WORLD POSITIONS — needed for placement
# ---------------------------------------------------------------------------
print("[4/9] Locating Hips_04 and Chest_06 bones")
hips_world  = None
chest_world = None
for bone in guide_armature.data.bones:
    if bone.name == 'Hips_04':
        hips_world = guide_armature.matrix_world @ bone.head_local
    if bone.name == 'Chest_06':
        chest_world = guide_armature.matrix_world @ bone.head_local
print(f"  hips  world: {hips_world}")
print(f"  chest world: {chest_world}")

# ---------------------------------------------------------------------------
# 5. IMPORT SKIRT — cm-scale, 8 pattern pieces, needs join + scale + reposition
# ---------------------------------------------------------------------------
print("[5/9] Importing skirt_9.glb")
pre_import = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=SKIRT_GLB)
skirt_new = [o for o in bpy.data.objects if o not in pre_import]
skirt_meshes = [o for o in skirt_new if o.type == 'MESH']
print(f"  imported {len(skirt_meshes)} skirt mesh pieces")

# Apply all current transforms so scale from GLTF importer is baked into verts
bpy.ops.object.select_all(action='DESELECT')
for o in skirt_new:
    o.select_set(True)
bpy.context.view_layer.objects.active = skirt_meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Mesh data is in centimeters. Scale by 0.01 to convert to meters.
bpy.ops.object.select_all(action='DESELECT')
for m in skirt_meshes:
    m.select_set(True)
bpy.context.view_layer.objects.active = skirt_meshes[0]
for m in skirt_meshes:
    m.scale = (0.01, 0.01, 0.01)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Now the skirt occupies Y=0.92 to Y=1.20 roughly (since raw cm values were 92-120).
# Measure actual skirt Y extent so we can align its TOP to the hip bone.
skirt_min_y =  1e9
skirt_max_y = -1e9
for m in skirt_meshes:
    for v in m.data.vertices:
        wv = m.matrix_world @ v.co
        if wv.y < skirt_min_y: skirt_min_y = wv.y
        if wv.y > skirt_max_y: skirt_max_y = wv.y
print(f"  skirt Y range after scaling: {skirt_min_y:.3f} to {skirt_max_y:.3f}")

# Translate skirt so its TOP edge aligns with the hip bone Y position.
if hips_world is not None:
    offset_y = hips_world.y - skirt_max_y
    for m in skirt_meshes:
        m.location.y += offset_y
    print(f"  translated skirt by dy={offset_y:.3f} to align top with hips")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Join all 8 pattern pieces into one mesh called "Skirt"
bpy.ops.object.select_all(action='DESELECT')
for m in skirt_meshes:
    m.select_set(True)
bpy.context.view_layer.objects.active = skirt_meshes[0]
bpy.ops.object.join()
skirt = bpy.context.view_layer.objects.active
skirt.name = "Skirt"
print(f"  joined into: {skirt.name} (verts={len(skirt.data.vertices)})")

# Remove skirt empties (Sketchfab_model, RootNode, fbx wrappers)
for o in list(skirt_new):
    if o.type == 'EMPTY' and o.name in bpy.data.objects:
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except Exception:
            pass

# ---------------------------------------------------------------------------
# 6. IMPORT PIERCINGS — extract Piercing7 only, duplicate for L/R chest
# ---------------------------------------------------------------------------
print("[6/9] Importing piercings_2.glb")
pre_import = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=PIERCINGS_GLB)
piercing_new = [o for o in bpy.data.objects if o not in pre_import]

# Find Piercing7 mesh, delete siblings
piercing7 = None
p_to_delete = []
for o in piercing_new:
    if o.type == 'MESH' and 'Piercing7' in o.name:
        piercing7 = o
    elif o.type == 'MESH':
        p_to_delete.append(o)
    elif o.type == 'EMPTY' and 'Piercing7' not in o.name and 'Sketchfab' not in o.name and 'RootNode' not in o.name:
        # Parent empties for Piercing5/6/8
        if o.name.startswith('Piercing'):
            p_to_delete.append(o)

for o in p_to_delete:
    if o.name in bpy.data.objects:
        bpy.data.objects.remove(o, do_unlink=True)

if piercing7 is None:
    raise RuntimeError("Piercing7 mesh not found after import")
print(f"  extracted: {piercing7.name}")

# Apply inherited transforms (the Sketchfab_model/RootNode hierarchy has scale 0.03 applied)
bpy.ops.object.select_all(action='DESELECT')
piercing7.select_set(True)
bpy.context.view_layer.objects.active = piercing7
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Piercing7 at native scale was ~2.6cm wide × 3.4cm tall (ring+spike).
# After transform_apply with 0.03 scale from importer, it's already tiny.
# Measure current size + rescale to target ~1.5cm wide for chest jewelry.
p_min = Vector(( 1e9,  1e9,  1e9))
p_max = Vector((-1e9, -1e9, -1e9))
for v in piercing7.data.vertices:
    wv = piercing7.matrix_world @ v.co
    for i in range(3):
        if wv[i] < p_min[i]: p_min[i] = wv[i]
        if wv[i] > p_max[i]: p_max[i] = wv[i]
current_width = p_max.x - p_min.x
print(f"  piercing current bbox: {p_max - p_min}, width={current_width:.4f}m")

TARGET_WIDTH = 0.015  # 1.5 cm ring diameter
if current_width > 0:
    sf = TARGET_WIDTH / current_width
    piercing7.scale = (sf, sf, sf)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    print(f"  rescaled by {sf:.3f}x to target {TARGET_WIDTH}m width")

# Zero location, then place at LEFT chest position
piercing7.location = (0, 0, 0)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Chest world position ≈ sternum centerline. Offset L/R by ~5cm, forward by ~7cm.
if chest_world is not None:
    # LEFT piercing (character's left = screen right)
    piercing7.location = (chest_world.x - 0.05, chest_world.y + 0.04, chest_world.z + 0.07)
    piercing7.name = "Piercing_L"
    # Duplicate for right
    bpy.ops.object.select_all(action='DESELECT')
    piercing7.select_set(True)
    bpy.context.view_layer.objects.active = piercing7
    bpy.ops.object.duplicate()
    piercing_r = bpy.context.active_object
    piercing_r.location.x = chest_world.x + 0.05
    piercing_r.name = "Piercing_R"
    print(f"  placed piercings at chest L={piercing7.location}, R={piercing_r.location}")
else:
    print("  WARNING: chest world position unknown, piercings at origin")

# ---------------------------------------------------------------------------
# 7. CLEAN UP ORPHAN EMPTIES from GLTF import wrappers + temp context holder
# ---------------------------------------------------------------------------
print("[7/9] Cleaning orphan empties + temp context holder")
# Delete the _ctx_tmp cube we added in step 1
for o in list(bpy.data.objects):
    if o.name == "_ctx_tmp_delete_me":
        bpy.data.objects.remove(o, do_unlink=True)
for o in list(bpy.data.objects):
    if o.type == 'EMPTY' and o.name.startswith(('Sketchfab_model', 'RootNode', 'sara', '7ff7', '54bb')):
        # Only delete if it has no children that we still want
        has_kept_children = False
        for child in o.children_recursive:
            if child.type in ('MESH', 'ARMATURE'):
                has_kept_children = True
                break
        if not has_kept_children:
            try:
                bpy.data.objects.remove(o, do_unlink=True)
            except Exception:
                pass

# ---------------------------------------------------------------------------
# 8. EXPORT FBX — Mixamo-ready
# ---------------------------------------------------------------------------
print("[8/9] Exporting FBX for Mixamo upload")
bpy.ops.object.select_all(action='SELECT')
out_fbx = os.path.join(OUT_DIR, "guide-ready-for-mixamo.fbx")
bpy.ops.export_scene.fbx(
    filepath=out_fbx,
    use_selection=True,
    axis_forward='-Z',
    axis_up='Y',
    apply_unit_scale=True,
    apply_scale_options='FBX_SCALE_NONE',
    bake_space_transform=False,
    mesh_smooth_type='FACE',
    use_mesh_modifiers=True,
    add_leaf_bones=False,
    path_mode='COPY',
    embed_textures=True,
)
print(f"  wrote: {out_fbx}")

# ---------------------------------------------------------------------------
# 9. SAVE .BLEND — backup so user can inspect/tweak
# ---------------------------------------------------------------------------
print("[9/9] Saving .blend backup")
out_blend = os.path.join(OUT_DIR, "guide-with-skirt-piercings.blend")
bpy.ops.wm.save_as_mainfile(filepath=out_blend)
print(f"  wrote: {out_blend}")

print("=" * 70)
print("DONE.")
print(f"Upload to Mixamo:  {out_fbx}")
print(f"Inspect in Blender: {out_blend}")
print("=" * 70)
