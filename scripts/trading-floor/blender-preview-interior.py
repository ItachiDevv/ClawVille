# Headless Blender previewer for an INTERIOR room GLB.
#
# The exterior previewer (hermes-pipeline/blender-preview-glb.py) frames the
# whole bounding box from outside, which for a closed room renders six grey
# walls. This one puts the camera INSIDE: at avatar eye height just inside the
# doorway, plus a high corner overview and a plan view. Lights are placed inside
# the room too, otherwise every shot is black.
#
# Coordinates are given in glTF space (Y-up) and converted to Blender (Z-up)
# here, so the numbers match the values in build-interior.mjs.
#
# Usage:
#   blender --background --python blender-preview-interior.py -- <in.glb> <out-dir> <RW> <RH> <RD>

import bpy
import os
import sys
import math
import mathutils

argv = sys.argv
ua = argv[argv.index("--") + 1:] if "--" in argv else []
if len(ua) < 2:
    print("usage: ... -- <in.glb> <out-dir> [RW RH RD]")
    sys.exit(1)

GLB, OUT_DIR = ua[0], ua[1]
RW = float(ua[2]) if len(ua) > 2 else 2600.0
RH = float(ua[3]) if len(ua) > 3 else 950.0
RD = float(ua[4]) if len(ua) > 4 else 2200.0
os.makedirs(OUT_DIR, exist_ok=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.import_scene.gltf(filepath=GLB)


def g2b(p):
    """glTF (x, y, z) -> Blender (x, -z, y)."""
    return (p[0], -p[2], p[1])


# Interior lighting: one warm key over the centre, two cool fills at the sides.
def add_point(name, gpos, energy, color):
    bpy.ops.object.light_add(type="POINT", location=g2b(gpos))
    lt = bpy.context.active_object
    lt.name = name
    lt.data.energy = energy
    lt.data.color = color
    lt.data.shadow_soft_size = 300.0


# Point-light irradiance falls off as P/(4*pi*r^2). At the ~1,000 unit working
# distance of this room that means P ~ 1.3e7 for roughly 1 W/m^2 -- the first
# pass used 9.0e8 and blew the floor to pure white while the far wall still read
# as black, which looked like missing geometry rather than bad exposure.
add_point("Key", (0, RH * 0.85, 0), 3.0e7, (0.75, 0.95, 1.0))
add_point("FillL", (-RW * 0.32, RH * 0.6, RD * 0.22), 1.4e7, (0.55, 0.9, 0.8))
add_point("FillR", (RW * 0.32, RH * 0.6, -RD * 0.22), 1.4e7, (0.55, 0.9, 0.8))
add_point("Back", (0, RH * 0.5, -RD * 0.33), 1.0e7, (0.6, 0.95, 0.85))

world = bpy.context.scene.world
if world is None:
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg is not None:
    bg.inputs[0].default_value = (0.02, 0.05, 0.07, 1.0)
    bg.inputs[1].default_value = 1.0

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [
    e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
] else "BLENDER_EEVEE"
scene.render.resolution_x = 1280
scene.render.resolution_y = 800
scene.render.film_transparent = False

bpy.ops.object.camera_add(location=(0, 0, 0))
cam = bpy.context.active_object
cam.data.lens = 24  # wide, so a 2,600 wu hall reads from inside
# The GLB is authored in WORLD UNITS (the hall is 2,600 across), but Blender's
# default camera clip range is 0.1 .. 100. Everything past 100 units is culled,
# which silently deletes the walls, ceiling and far props from the render while
# nearer geometry still draws -- it looks exactly like missing geometry.
cam.data.clip_start = 1.0
cam.data.clip_end = 40000.0
scene.camera = cam

for ob in bpy.context.scene.objects:
    if ob.type == "MESH":
        bb = [ob.matrix_world @ mathutils.Vector(c) for c in ob.bound_box]
        lo = [min(v[i] for v in bb) for i in range(3)]
        hi = [max(v[i] for v in bb) for i in range(3)]
        print(f"  imported MESH {ob.name}: min=[{lo[0]:.0f},{lo[1]:.0f},{lo[2]:.0f}] max=[{hi[0]:.0f},{hi[1]:.0f},{hi[2]:.0f}]")


def shoot(name, gpos, gtarget, lens=24):
    cam.data.lens = lens
    cam.location = g2b(gpos)
    d = mathutils.Vector(g2b(gtarget)) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(OUT_DIR, f"interior-{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"  rendered {scene.render.filepath}")


# 1. Standing just inside the doorway at avatar eye height (avatar = 270 wu).
shoot("entry", (0, 240, RD * 0.42), (0, 200, -RD * 0.40))
# 1b. Same doorway, looking diagonally across the hall. The straight-ahead shot
# above puts the console row ~59 deg off axis, outside a 24mm frame, so it reads
# as an empty room; this angle catches the console AND the dais together.
shoot("entry-diagonal", (RW * 0.24, 260, RD * 0.42), (-RW * 0.27, 100, 0), lens=18)
# 2. High corner overview, under the ceiling.
shoot("overview", (-RW * 0.36, RH * 0.72, RD * 0.44), (0, 100, -RD * 0.10), lens=18)
# 3. Walk-up view of the monitor station hotspot.
shoot("monitor", (0, 250, -RD * 0.18), (0, 260, -RD * 0.50), lens=35)
# 4. Plan view from just below the ceiling.
shoot("plan", (0, RH * 0.92, 0), (0, 0, -1), lens=16)

print("=== done ===")
