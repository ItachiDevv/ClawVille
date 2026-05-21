# Headless Blender GLB previewer — renders front / side / back PNGs of a
# given GLB so the user can visually evaluate a freshly generated mesh
# without opening Blender's UI (which is exclusively claimed by the user).
#
# Usage:
#   blender --background --python blender-preview-glb.py -- <input.glb> <out-dir>
#
# Writes:
#   <out-dir>/preview-front.png
#   <out-dir>/preview-side.png
#   <out-dir>/preview-back.png

import bpy
import os
import sys
import math

argv = sys.argv
user_argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(user_argv) != 2:
    print("usage: blender --background --python blender-preview-glb.py -- <input.glb> <out-dir>")
    sys.exit(1)

GLB, OUT_DIR = user_argv
os.makedirs(OUT_DIR, exist_ok=True)

# Clean scene
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

# Import GLB
bpy.ops.import_scene.gltf(filepath=GLB)

# Find imported root and compute world bbox
imported = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not imported:
    print("ERROR: no mesh objects after import")
    sys.exit(1)

# Combined bbox
min_v = [float("inf")] * 3
max_v = [float("-inf")] * 3
for obj in imported:
    obj.update_tag()
bpy.context.view_layer.update()
for obj in imported:
    for corner in obj.bound_box:
        wc = obj.matrix_world @ __import__("mathutils").Vector(corner)
        for i in range(3):
            if wc[i] < min_v[i]:
                min_v[i] = wc[i]
            if wc[i] > max_v[i]:
                max_v[i] = wc[i]
center = [(min_v[i] + max_v[i]) / 2 for i in range(3)]
size = [max_v[i] - min_v[i] for i in range(3)]
diag = max(size)
cam_distance = diag * 1.8
print(f"  bbox: min={min_v}, max={max_v}, center={center}, size={size}, cam_dist={cam_distance:.2f}")

# Lights — simple 3-point so the mesh isn't lit only by ambient
def add_sun(name, location, energy):
    bpy.ops.object.light_add(type="SUN", location=location)
    light = bpy.context.active_object
    light.name = name
    light.data.energy = energy

add_sun("Key",  (cam_distance,  cam_distance, cam_distance), 3.0)
add_sun("Fill", (-cam_distance, cam_distance, cam_distance * 0.3), 1.5)

# World background (so transparent areas read as neutral)
world = bpy.context.scene.world
if world is None:
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg is not None:
    bg.inputs[0].default_value = (0.94, 0.94, 0.94, 1.0)  # light grey
    bg.inputs[1].default_value = 1.0

# Camera
bpy.ops.object.camera_add(location=(0, -cam_distance, center[2]))
cam = bpy.context.active_object
cam.name = "RenderCam"
cam.data.lens = 50
bpy.context.scene.camera = cam

# Render settings — Eevee for speed (no GPU lookup needed in headless)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [
    e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
] else "BLENDER_EEVEE"
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
scene.render.film_transparent = False

# Helper — point cam at center
def look_at(cam_obj, target):
    import mathutils
    direction = mathutils.Vector(target) - cam_obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    cam_obj.rotation_euler = rot_quat.to_euler()

# 3 views — front (-Y), side (+X), back (+Y)
views = [
    ("front", ( center[0],                 center[1] - cam_distance, center[2])),
    ("side",  ( center[0] + cam_distance,  center[1],                center[2])),
    ("back",  ( center[0],                 center[1] + cam_distance, center[2])),
]

for name, loc in views:
    cam.location = loc
    look_at(cam, center)
    out = os.path.join(OUT_DIR, f"preview-{name}.png")
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f"  rendered {out}")

print("=== done ===")
