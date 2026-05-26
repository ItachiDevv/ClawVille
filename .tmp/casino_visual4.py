"""
Phase 1 visual v4: camera inside the room at floor level.
Room interior: Blender Y is depth axis, X is width, Z is height.
Floor at blender Z = -274.4 (MIN_Z), ceiling at -71.0.
Room center X = -720.6.
Camera placed at floor level looking toward the table zone.
"""
import bpy
import math

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_IN1    = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_interior_view1.png"  # from spawn looking in
SS_IN2    = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_interior_view2.png"  # floor plan from inside
SS_IN3    = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_interior_view3.png"  # side view interior

CTR_X  = -720.6
CTR_Y  =    0.3
CTR_Z  = -172.7
MIN_Z  = -274.4  # floor
MAX_Z  =  -71.0  # ceiling
SCALE  = 1.9671

# Spawn blender Y = 407, floor blender Z = -274.4
# Avatar eye height: ~270wu * 0.7 = 189wu / SCALE = 96 blender units above floor
EYE_Z = MIN_Z + 96   # ≈ -178.4

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb():
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

def add_marker(loc, r=10, name="M", rgb=(1,0,0)):
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

def setup_render():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = 1440
    scene.render.resolution_y = 900
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = False
    scene.display.shading.show_backface_culling = False  # see interior faces

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
    print("=== Visual Inspect v4 (interior) ===", flush=True)
    reset_scene()
    import_glb()

    # Markers
    # SPAWN position (cyan) - entrance side, avatar floor level
    add_marker((CTR_X, 407.0, EYE_Z), r=15, name="SPAWN", rgb=(0, 1, 1))
    # Table 1 pair (RED) - closest to spawn, blY=400
    add_marker((-942, 400, -200), r=12, name="T1_L", rgb=(1, 0, 0))
    add_marker((-498, 400, -200), r=12, name="T1_R", rgb=(1, 0, 0))
    # Table 2 pair (ORANGE) - next, blY=350
    add_marker((-943, 350, -182), r=12, name="T2_L", rgb=(1, 0.5, 0))
    add_marker((-498, 350, -182), r=12, name="T2_R", rgb=(1, 0.5, 0))

    setup_render()

    # ---- View 1: From spawn position looking INTO the room (-Y direction) ----
    # Camera at spawn blY=407, eye height, looking toward blY=0 (center of room)
    cam1, tar1 = track_camera("SpawnCam", 'PERSP',
        loc=(CTR_X, 450, EYE_Z),
        target_loc=(CTR_X, 0, EYE_Z),
        fov_deg=80)
    render(SS_IN1)
    cleanup_cam(cam1, tar1)

    # ---- View 2: Elevated overview from spawn corner, wider angle ----
    # Camera at spawn side but elevated, looking down-and-inward at 45deg
    cam2, tar2 = track_camera("ElevCam", 'PERSP',
        loc=(CTR_X + 300, 500, EYE_Z + 120),
        target_loc=(CTR_X, 100, MIN_Z + 40),
        fov_deg=65)
    render(SS_IN2)
    cleanup_cam(cam2, tar2)

    # ---- View 3: Floor-plan (ortho from directly above, inside room) ----
    # Camera at ceiling height (just below ceiling), looking straight down
    # Use ortho so we get a proper floor plan
    cam3, tar3 = track_camera("FloorPlanCam", 'ORTHO',
        loc=(CTR_X, CTR_Y, MIN_Z + 50),  # slightly above floor
        target_loc=(CTR_X, CTR_Y, MIN_Z - 200),  # look toward floor
        ortho_scale=600)
    render(SS_IN3)
    cleanup_cam(cam3, tar3)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
