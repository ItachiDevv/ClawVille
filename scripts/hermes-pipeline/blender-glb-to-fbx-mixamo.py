# Headless Blender — convert a Rodin/Tripo GLB into a Mixamo-ready FBX.
#
# Mixamo's auto-rigger expects:
#   - FBX (or OBJ) format
#   - Single mesh OR multi-mesh; rigger handles both but single mesh is cleaner
#   - T-pose static character (no existing skeleton/armature)
#   - Y-up axis convention with character standing on Y=0 plane
#   - Reasonable poly count (5k-50k recommended; we leave decimation manual for now)
#
# Usage:
#   blender --background --python blender-glb-to-fbx-mixamo.py -- <input.glb> <out.fbx> [rotateZdeg]
#
# MIXAMO ORIENTATION — hard-won 2026-06-05 (Phanes). Two rules make the model
# land DEAD-FRONT in Mixamo's auto-rigger with ZERO manual rotation:
#   1. bake_space_transform MUST be False. With it True, Blender bakes the
#      Z-up->Y-up axis swap into the verts AND declares it in the FBX header, so
#      Mixamo double-applies it and the character imports SIDEWAYS (right
#      profile). Every upload then needs a manual rotate in the Orient step, and
#      THAT manual rotate is what produced the wrong arm rig. Keep it False.
#   2. The character must FACE -Y in Blender before export (front-ortho shows the
#      face; bbox X = arm span, bbox Y = depth). Tripo/Rodin image-to-3d meshes
#      come out facing +X -> pass rotateZdeg=-90. A source already facing -Y
#      needs 0 (the default).

import bpy
import os
import sys
import math

argv = sys.argv
user_argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(user_argv) not in (2, 3):
    print("usage: blender --background --python blender-glb-to-fbx-mixamo.py -- <input.glb> <out.fbx> [rotateZdeg]")
    sys.exit(1)

GLB, FBX = user_argv[:2]
# Yaw correction (degrees about Z) applied so the rest mesh faces -Y before
# export. Tripo/Rodin -> -90. Default 0 = no rotation (source already faces -Y).
ROTATE_Z = float(user_argv[2]) if len(user_argv) == 3 else 0.0
os.makedirs(os.path.dirname(os.path.abspath(FBX)) or ".", exist_ok=True)

# Reset scene
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
for db in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.actions):
    for item in list(db):
        if item.users == 0:
            db.remove(item)

print(f"=== importing {GLB} ===")
bpy.ops.import_scene.gltf(filepath=GLB)

# Print pre-state
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
armatures = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
print(f"  imported: {len(meshes)} mesh(es), {len(armatures)} armature(s)")
for o in meshes:
    tri = sum(len(p.vertices) - 2 for p in o.data.polygons if len(p.vertices) >= 3)
    print(f"    {o.name}: {len(o.data.vertices)} verts, ~{tri} tris")

# Strip any armatures — Rodin/Tripo sometimes attach a placeholder rig that
# would confuse Mixamo's auto-detection. Mixamo wants the rigless static body.
for arm in armatures:
    print(f"  removing armature: {arm.name}")
    bpy.data.objects.remove(arm, do_unlink=True)

# Unparent meshes from anything else, apply all transforms so the mesh sits
# at world origin with identity rotation and scale=1. Mixamo reads world coords,
# not pivot/parent transforms.
for obj in meshes:
    obj.parent = None
    obj.matrix_world = obj.matrix_world  # force evaluation
bpy.context.view_layer.update()

# Select all meshes + apply transforms (location/rotation/scale)
bpy.ops.object.select_all(action="DESELECT")
for obj in meshes:
    obj.select_set(True)
if meshes:
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Join all meshes into one for cleanest Mixamo auto-rig
if len(meshes) > 1:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    print(f"  joined {len(meshes)} meshes → single mesh '{bpy.context.active_object.name}'")
else:
    print(f"  single mesh, no join needed")

# Ground the model — translate so the lowest vertex sits at Y=0 (Blender world Z).
# Mixamo auto-rig works regardless but it makes the result visually clean.
active = bpy.context.active_object
if active and active.type == "MESH":
    min_z = min((active.matrix_world @ v.co)[2] for v in active.data.vertices)
    active.location.z -= min_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    print(f"  grounded: shifted down by {min_z:.4f} so feet at Z=0")

# Facing correction: rotate so the character faces -Y (Mixamo front). Tripo/Rodin
# meshes face +X out of the box -> pass rotateZdeg=-90. rotation_mode is set
# explicitly because some imports default to QUATERNION, which silently ignores
# rotation_euler assignments (the bug that cost us the Phanes session).
if ROTATE_Z != 0.0 and active and active.type == "MESH":
    active.rotation_mode = "XYZ"
    active.rotation_euler = (0.0, 0.0, math.radians(ROTATE_Z))
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    active.select_set(True)
    bpy.context.view_layer.objects.active = active
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    print(f"  facing-corrected {ROTATE_Z:+.1f} deg about Z (now faces -Y)")

# Export FBX
# Mixamo expects:
#   - axis_forward='-Z', axis_up='Y'  (Y-up convention from Blender Z-up via FBX)
#   - global_scale=1.0 (we keep Blender meters; Mixamo handles m vs cm via header)
#   - object_types={'MESH'}  (no empties, no armature — we stripped those)
#   - bake_space_transform=False  (CRITICAL: True imports SIDEWAYS in Mixamo — see header)
print(f"=== exporting {FBX} ===")
# embed_textures + path_mode=COPY: pack ALL referenced images into the FBX so
# Mixamo's auto-rig pipeline preserves them on the round-trip. Without these
# the diffuse + normal textures ship as 0×0 references → VRM finalize loses
# them → in-game avatar renders monochrome. Lesson learned 2026-05-21 after
# eliza-chibi + milady-chibi shipped colorless. See feedback memory:
# fbx-export-must-embed-textures-for-mixamo.
bpy.ops.export_scene.fbx(
    filepath=FBX,
    use_selection=False,
    object_types={"MESH"},
    apply_unit_scale=True,
    apply_scale_options="FBX_SCALE_ALL",
    bake_space_transform=False,
    axis_forward="-Z",
    axis_up="Y",
    global_scale=1.0,
    use_mesh_modifiers=True,
    add_leaf_bones=False,
    bake_anim=False,
    embed_textures=True,
    path_mode="COPY",
)
size_kb = os.path.getsize(FBX) / 1024.0
print(f"=== done: {FBX} ({size_kb:.1f} KB) ===")
