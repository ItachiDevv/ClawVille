"""
Phase 1 visual v5: close-up of spawn-side tables with numbered markers.
We know from floor plan: bottom of room (spawn side, high blender Y) has arch-shaped tables.
"""
import bpy
import math

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_SPAWN  = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_spawn_tables.png"    # close-up spawn tables
SS_DETAIL = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_tables_numbered.png" # top-down numbered

CTR_X = -720.6
CTR_Y =    0.3
CTR_Z = -172.7
MIN_Z = -274.4
MAX_Z =  -71.0
SCALE = 1.9671

EYE_Z = MIN_Z + 96  # avatar eye height above floor

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb():
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

def add_marker(loc, r=8, name="M", rgb=(1,0,0)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=8, ring_count=6)
    obj = bpy.context.active_object
    obj.name = name
    mat = bpy.data.materials.new(name + "_m")
    mat.diffuse_color = (*rgb, 1.0)
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
    return obj

def setup_render(w=1440, h=900):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = False
    scene.display.shading.show_backface_culling = False

def track_camera(name, camtype, loc, target_loc, ortho_scale=None, fov_deg=70):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = camtype
    if ortho_scale:
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.location = loc
    target = bpy.data.objects.new(name + "_tar", None)
    bpy.context.scene.collection.objects.link(target)
    target.location = target_loc
    con = cam_obj.constraints.new('TRACK_TO')
    con.target = target
    con.track_axis = 'TRACK_NEGATIVE_Z'
    con.up_axis = 'UP_Y'
    bpy.context.view_layer.update()
    bpy.context.scene.camera = cam_obj
    return cam_obj, target

def render(filepath):
    bpy.context.scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    print(f"Saved: {filepath}", flush=True)

def cleanup_cam(cam_obj, target):
    bpy.data.objects.remove(cam_obj, do_unlink=True)
    bpy.data.objects.remove(target, do_unlink=True)

def main():
    print("=== Visual Inspect v5 (spawn tables close-up) ===", flush=True)
    reset_scene()
    import_glb()

    # From the floor plan we can see 3 arch-tables at the bottom (spawn side).
    # The Material3.004 clusters analysis showed:
    # blY=500 -> wZ=983, verts=1533 -> this is the FAR wall area / entrance structure
    # blY=450 -> wZ=885, verts=106
    # blY=400 -> wZ=786, verts=395 <- 2 tables symmetrically placed
    # blY=350 -> wZ=688, verts=746 <- 2 more tables
    # The 3 arches at bottom of floor plan likely correspond to blY range 300-500.
    # The LEFT-RIGHT cluster analysis showed:
    # blY=400: LEFT blX=-942 -> worldX=-435, RIGHT blX=-498 -> worldX=437
    # blY=350: LEFT blX=-943 -> worldX=-438, RIGHT blX=-498 -> worldX=438
    # blY=300: LEFT blX=-959 -> worldX=-469, RIGHT blX=-481 -> worldX=471
    # blY=500: LEFT blX=-861 -> worldX=-277, RIGHT blX=-576 -> worldX=284 (closer together = different structure)
    # The 3 arches are likely: LEFT at blY=350, CENTER at blY=400/450, RIGHT at blY=350.
    # Actually from floor plan the 3 arches span the full width - they appear to be 3 large tables
    # arranged along the spawn-side wall, side by side across the room width.

    # Let's analyze the blY=500 cluster more carefully - it has 1533 verts and LEFT/RIGHT
    # are at worldX=-277 and +284 (more centered), and blY=400 has LEFT/RIGHT at +-435.
    # The 3-arch layout suggests: LEFT, CENTER, RIGHT table at the same Y depth.
    # blY=500 center cluster at worldX~=0 (center table), side tables at blY=350/400.

    # Print the world coordinates for all candidate tables
    tables = {
        "TABLE_A (blY=500, wZ=983, CENTER)": (-719.6, 500, -205.1),    # center-ish, near entrance
        "TABLE_B_L (blY=400, wZ=786, LEFT)": (-942, 400, -204),
        "TABLE_B_R (blY=400, wZ=786, RIGHT)": (-498, 400, -204),
        "TABLE_C_L (blY=350, wZ=688, LEFT)": (-943, 350, -182),
        "TABLE_C_R (blY=350, wZ=688, RIGHT)": (-498, 350, -182),
    }

    print("\n--- All spawn-side table candidates (world coords) ---", flush=True)
    for label, (bx, by, bz) in tables.items():
        wX = (bx - CTR_X) * SCALE
        wY = (bz - MIN_Z) * SCALE
        wZ = (by - CTR_Y) * SCALE
        dist_spawn = abs(wZ - 800)
        print(f"  {label}", flush=True)
        print(f"    World: X={wX:.0f}, Y={wY:.0f}, Z={wZ:.0f} | dist_from_spawn={dist_spawn:.0f}", flush=True)

    # Add numbered markers for each table
    colors = {
        "TABLE_A": (0.5, 0, 1),     # purple = near entrance
        "TABLE_B_L": (1, 0, 0),     # red = pair closest to spawn
        "TABLE_B_R": (1, 0, 0),
        "TABLE_C_L": (1, 0.5, 0),   # orange
        "TABLE_C_R": (1, 0.5, 0),
    }
    for label, (bx, by, bz) in tables.items():
        key = label.split(" ")[0]
        rgb = colors.get(key, (1,1,0))
        add_marker((bx, by, bz), r=10, name=label[:12], rgb=rgb)

    # SPAWN marker
    add_marker((CTR_X, 407, EYE_Z), r=14, name="SPAWN", rgb=(0, 1, 1))

    setup_render()

    # ---- Close-up from spawn looking at the 3 arch tables ----
    # Camera at spawn (blY=450), slightly elevated, looking toward blY=350
    cam1, tar1 = track_camera("SpawnClose", 'PERSP',
        loc=(CTR_X + 100, 470, EYE_Z + 30),
        target_loc=(CTR_X, 350, MIN_Z + 60),
        fov_deg=75)
    render(SS_SPAWN)
    cleanup_cam(cam1, tar1)

    # ---- Top-down floor plan of just the spawn-zone (blY 200..510) ----
    # Camera directly above the spawn-side half of room, looking down
    cam2, tar2 = track_camera("TablePlanCam", 'ORTHO',
        loc=(CTR_X, 350, MIN_Z + 500),
        target_loc=(CTR_X, 350, MIN_Z - 100),
        ortho_scale=350)
    render(SS_DETAIL)
    cleanup_cam(cam2, tar2)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
