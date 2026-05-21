"""Headless Blender: dump hip Y track of a GLB + material/texture inventory of a VRM.

Usage:
  blender --background --python inspect-glb-and-vrm.py -- <walk.glb> <eliza-chibi.vrm>
"""
import bpy, os, sys

argv = sys.argv
user_argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(user_argv) != 2:
    print("usage: blender --background --python inspect-glb-and-vrm.py -- <walk.glb> <eliza-chibi.vrm>")
    sys.exit(1)

WALK_GLB, VRM_PATH = user_argv

# ---- Pass 1: walk.glb hip Y ----
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
for db in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.images):
    for item in list(db):
        if item.users == 0:
            db.remove(item)

print(f"\n=== Pass 1: {WALK_GLB} ===")
bpy.ops.import_scene.gltf(filepath=WALK_GLB)

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
    for fc in action.fcurves:
        yield fc

for action in bpy.data.actions:
    print(f"action: {action.name}")
    for fc in iter_fcurves(action):
        if "Hips" not in fc.data_path or "location" not in fc.data_path:
            continue
        axis = ["X", "Y", "Z"][fc.array_index]
        vals = [kp.co[1] for kp in fc.keyframe_points]
        if vals:
            print(f"  Hips.location[{axis}]  min={min(vals):.4f} max={max(vals):.4f} range={max(vals)-min(vals):.4f}")

# ---- Pass 2: eliza-chibi.vrm materials + textures ----
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
for db in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.images):
    for item in list(db):
        if item.users == 0:
            db.remove(item)

# Enable VRM addon — try both module paths
for mod in ("bl_ext.user_default.vrm", "bl_ext.blender_org.vrm", "io_scene_vrm"):
    try:
        bpy.ops.preferences.addon_enable(module=mod)
        print(f"[vrm] addon enabled: {mod}")
        break
    except Exception:
        pass

print(f"\n=== Pass 2: {VRM_PATH} ===")
try:
    bpy.ops.import_scene.vrm(filepath=VRM_PATH)
except Exception as e:
    print(f"VRM import failed, trying gltf: {e}")
    bpy.ops.import_scene.gltf(filepath=VRM_PATH)

mats = list(bpy.data.materials)
imgs = list(bpy.data.images)
print(f"materials: {len(mats)}")
for m in mats:
    print(f"  - {m.name}: use_nodes={m.use_nodes}")
    if m.use_nodes and m.node_tree:
        for node in m.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                print(f"    TEX_IMAGE → {node.image.name}  size={node.image.size[0]}x{node.image.size[1]}")
            elif node.type == "BSDF_PRINCIPLED":
                base_color = node.inputs["Base Color"].default_value
                print(f"    BSDF_PRINCIPLED  base_color=({base_color[0]:.2f},{base_color[1]:.2f},{base_color[2]:.2f},{base_color[3]:.2f})")

print(f"\nimages: {len(imgs)}")
for img in imgs:
    print(f"  - {img.name}: size={img.size[0]}x{img.size[1]} packed={img.packed_file is not None} filepath={img.filepath}")

# Check meshes have materials assigned
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
print(f"\nmesh material slots:")
for mesh in meshes:
    print(f"  {mesh.name}: {len(mesh.material_slots)} slot(s)")
    for i, slot in enumerate(mesh.material_slots):
        print(f"    [{i}] {slot.material.name if slot.material else '(empty)'}")
