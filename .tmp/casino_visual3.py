"""
Phase 1 visual v3: correct camera orientations for casino GLB.
Room orientation in Blender: long axis=Y, width=X, height=Z.
GLB center X=-720.6, Y=0.3, Z=-172.7
For floor plan (top down): camera above (high Z), looking DOWN (-Z), ortho.
For long-wall side view: camera at far +Y, looking toward -Y, ortho.
For entrance view: camera at high +Y (spawn side), looking at -Y (into room).
"""
import bpy
import math

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_PLAN   = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_plan.png"    # floor plan top-down
SS_LONG   = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_long.png"    # along long axis
SS_ISO    = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_iso.png"     # iso/perspective

# Room dimensions in Blender space
CTR_X  = -720.6
CTR_Y  =    0.3
CTR_Z  = -172.7
MIN_Z  = -274.4  # floor
MAX_Z  =  -71.0  # ceiling
WIDTH_X = 485.4  # total room width
DEPTH_Y = 1017.0 # total room depth (long axis)
HEIGHT_Z = 203.4

SCALE  = 1.9671
# Spawn: blY = 407.0

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

def add_text_label(loc, text, size=12):
    """Add 3D text at a location."""
    try:
        bpy.ops.object.text_add(location=loc)
        obj = bpy.context.active_object
        obj.data.body = text
        obj.data.size = size
        mat = bpy.data.materials.new(text + "_txtm")
        mat.diffuse_color = (1, 1, 0, 1)
        obj.data.materials.append(mat)
        return obj
    except:
        return None

def setup_render():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = 1440
    scene.render.resolution_y = 900
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = False

def make_cam(name, camtype, loc, rot_euler, ortho_scale=None, fov_deg=60):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = camtype
    if ortho_scale:
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.location = loc
    cam_obj.rotation_euler = rot_euler
    bpy.context.scene.camera = cam_obj
    return cam_obj

def render(filepath):
    bpy.context.scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    print(f"Saved: {filepath}", flush=True)

def main():
    print("=== Visual Inspect v3 ===", flush=True)
    reset_scene()
    import_glb()

    # ---- Add markers ----
    # Spawn position (cyan) - at blY=407 = entrance side
    add_marker((CTR_X, 407.0, MIN_Z + 10), r=15, name="SPAWN", rgb=(0, 1, 1))

    # Material3.004 clusters from previous analysis (poker table felt / surface material)
    # blY=400 wZ=786 (395 verts) - 2 tables straddling spawn, LEFT=-435 RIGHT=+437 world X
    add_marker((-942, 400, -204), r=12, name="T1_L_RED",  rgb=(1, 0, 0))  # LEFT  table, cluster ~blY=400
    add_marker((-498, 400, -204), r=12, name="T1_R_RED",  rgb=(1, 0, 0))  # RIGHT table, cluster ~blY=400
    # blY=350 wZ=688 (746 verts) - 2 tables one step further from spawn
    add_marker((-943, 350, -182), r=12, name="T2_L_ORG",  rgb=(1, 0.5, 0))  # LEFT  ~blY=350
    add_marker((-498, 350, -182), r=12, name="T2_R_ORG",  rgb=(1, 0.5, 0))  # RIGHT ~blY=350
    # blY=450 wZ=885 (106 verts) - smaller cluster, possibly partial tables at far-spawn edge
    add_marker((-962, 450, -240), r=10, name="T3_L_YEL",  rgb=(1, 1, 0))
    add_marker((-479, 450, -240), r=10, name="T3_R_YEL",  rgb=(1, 1, 0))

    # Label info printout
    print("\n--- Table marker world positions ---", flush=True)
    markers = [
        ("T1_L (RED, closest pair - LEFT)",  (-942, 400, -204)),
        ("T1_R (RED, closest pair - RIGHT)", (-498, 400, -204)),
        ("T2_L (ORANGE, next pair - LEFT)",  (-943, 350, -182)),
        ("T2_R (ORANGE, next pair - RIGHT)", (-498, 350, -182)),
    ]
    for label, (bx, by, bz) in markers:
        wX = (bx - CTR_X) * SCALE
        wY = (bz - MIN_Z) * SCALE
        wZ = (by - CTR_Y) * SCALE
        print(f"  {label}: worldXYZ=({wX:.0f}, {wY:.0f}, {wZ:.0f})", flush=True)

    print(f"\n  SPAWN: world (0, 0, +800) = blender ({CTR_X:.0f}, 407, {MIN_Z:.0f}+)", flush=True)

    setup_render()

    # ---- Floor plan (looking straight down, -Z in blender) ----
    # Camera at high Z, pointing down: rotation (0, 0, 0) in Blender means camera faces -Y.
    # To face -Z (down), rotate X by -90deg.
    cam = make_cam("PlanCam", 'ORTHO',
                   loc=(CTR_X, CTR_Y, MAX_Z + 600),
                   rot_euler=(0, 0, 0),   # camera -Y axis points down when X=0? No...
                   ortho_scale=600)
    # In Blender, camera default orientation: -Z is view direction, +Y is up.
    # Looking DOWN (toward -Z): camera local -Z should point toward world -Z
    # Camera at high blender Z, pointing toward -Z: rotation = (0, 0, 0) means -Z forward...
    # Actually: camera faces -Z by default in Blender. To look DOWN we need:
    # camera_up = +Y, camera_forward = -Z -> but we want forward = -blender_Z (down)
    # Rotate X by -90deg: forward goes from -Z to -Y... hmm
    # Blender Euler: XYZ rotations in world space
    # Default camera: looks along -Z (into screen), up is +Y
    # To look "down" (toward -Z in world), we need to rotate camera:
    #   pitch by -90deg (rotate X by -pi/2): now camera looks along +Y... no
    # Let me use a track-to constraint approach:
    bpy.data.objects.remove(cam, do_unlink=True)

    # More reliable: create camera, use track-to target
    cam_data = bpy.data.cameras.new("PlanCam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 650
    cam_obj = bpy.data.objects.new("PlanCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    # Place camera above the room center, looking straight down
    cam_obj.location = (CTR_X, CTR_Y, MAX_Z + 600)
    # Track to a target at room center (below camera)
    target = bpy.data.objects.new("TarPlan", None)
    bpy.context.scene.collection.objects.link(target)
    target.location = (CTR_X, CTR_Y, MIN_Z)
    con = cam_obj.constraints.new('TRACK_TO')
    con.target = target
    con.track_axis = 'TRACK_NEGATIVE_Z'
    con.up_axis = 'UP_Y'
    bpy.context.view_layer.update()
    bpy.context.scene.camera = cam_obj
    render(SS_PLAN)
    bpy.data.objects.remove(cam_obj, do_unlink=True)
    bpy.data.objects.remove(target, do_unlink=True)

    # ---- Long-wall view (looking along blender Y axis, into the room) ----
    # Camera at high +Y (spawn side = blY=507), looking toward -Y (back of room)
    cam_data2 = bpy.data.cameras.new("LongCam")
    cam_data2.type = 'ORTHO'
    cam_data2.ortho_scale = 600
    cam_obj2 = bpy.data.objects.new("LongCam", cam_data2)
    bpy.context.scene.collection.objects.link(cam_obj2)
    cam_obj2.location = (CTR_X, CTR_Y + 800, CTR_Z + 100)
    target2 = bpy.data.objects.new("TarLong", None)
    bpy.context.scene.collection.objects.link(target2)
    target2.location = (CTR_X, CTR_Y, CTR_Z)
    con2 = cam_obj2.constraints.new('TRACK_TO')
    con2.target = target2
    con2.track_axis = 'TRACK_NEGATIVE_Z'
    con2.up_axis = 'UP_Y'
    bpy.context.view_layer.update()
    bpy.context.scene.camera = cam_obj2
    render(SS_LONG)
    bpy.data.objects.remove(cam_obj2, do_unlink=True)
    bpy.data.objects.remove(target2, do_unlink=True)

    # ---- Isometric perspective ----
    cam_data3 = bpy.data.cameras.new("IsoCam")
    cam_data3.type = 'PERSP'
    cam_data3.angle = math.radians(50)
    cam_obj3 = bpy.data.objects.new("IsoCam", cam_data3)
    bpy.context.scene.collection.objects.link(cam_obj3)
    # Place camera at +X, +Y, +Z offset from center
    cam_obj3.location = (CTR_X + 500, CTR_Y + 600, CTR_Z + 400)
    target3 = bpy.data.objects.new("TarIso", None)
    bpy.context.scene.collection.objects.link(target3)
    target3.location = (CTR_X, CTR_Y, CTR_Z)
    con3 = cam_obj3.constraints.new('TRACK_TO')
    con3.target = target3
    con3.track_axis = 'TRACK_NEGATIVE_Z'
    con3.up_axis = 'UP_Y'
    bpy.context.view_layer.update()
    bpy.context.scene.camera = cam_obj3
    render(SS_ISO)
    bpy.data.objects.remove(cam_obj3, do_unlink=True)
    bpy.data.objects.remove(target3, do_unlink=True)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
