"""
Final floor plan render: camera inside room at ceiling height looking down.
Room: X=[-963,-478], Y=[-508,+509], Z=[-274,-71]
Camera at ceiling (blZ=-71), inside the room, looking down toward floor.
"""
import bpy
import math

GLB_PATH = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS1 = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_floorplan_final.png"
SS2 = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_spawn_close.png"

CTR_X = -720.6
CTR_Y =    0.3
MIN_Y = -508.1
MAX_Y =  508.6
CTR_Z = -172.7
MIN_Z = -274.4
MAX_Z =  -71.0
SCALE = 1.9671

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

def setup_render(w=1600, h=1000):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = False
    scene.display.shading.show_backface_culling = False

def make_downward_cam(name, above_z, center_xy, ortho_scale):
    """Camera looking straight down (-Z direction in Blender)."""
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ortho_scale
    cam_obj = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    # Looking down: camera above, rotated so -Z faces down.
    # Blender camera default: -Z is view direction. To look at world -Z (down),
    # we need the camera's -Z local axis to point to world -Z.
    # Set camera to face straight down: rotate X by -pi/2 (camera -Z points to world -Y? No...)
    # Actually: default Blender camera: -Z local = view direction (into screen)
    # World down = -Z world. We want camera local -Z = world -Z.
    # That means NO rotation! Camera faces -Z by default in world space.
    # But "up" in the image would be +Y world. So:
    cam_obj.location = (center_xy[0], center_xy[1], above_z)
    cam_obj.rotation_euler = (0, 0, 0)  # camera faces -Z (downward)
    bpy.context.scene.camera = cam_obj
    return cam_obj

def render(filepath):
    bpy.context.scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    print(f"Saved: {filepath}", flush=True)

def main():
    print("=== Final floor plan render ===", flush=True)
    reset_scene()
    import_glb()

    # --- Markers ---
    # Spawn (cyan)
    add_marker((CTR_X, 407.0, MIN_Z + 5), r=12, name="SPAWN", rgb=(0, 1, 1))
    # Table B pair (RED) - closest to spawn, blY=400, wZ=786
    add_marker((-942, 400, MIN_Z + 5), r=10, name="TB_L",  rgb=(1, 0, 0))
    add_marker((-498, 400, MIN_Z + 5), r=10, name="TB_R",  rgb=(1, 0, 0))
    # Table C pair (ORANGE) - blY=350, wZ=688
    add_marker((-943, 350, MIN_Z + 5), r=10, name="TC_L",  rgb=(1, 0.5, 0))
    add_marker((-498, 350, MIN_Z + 5), r=10, name="TC_R",  rgb=(1, 0.5, 0))
    # Table A (PURPLE) - blY=500, wZ=983 - near entrance arch
    add_marker((-861, 500, MIN_Z + 5), r=10, name="TA_L",  rgb=(0.5, 0, 1))
    add_marker((-576, 500, MIN_Z + 5), r=10, name="TA_R",  rgb=(0.5, 0, 1))

    setup_render()

    # Floor plan: camera inside at ceiling height, looking down
    # Room is very thin in Z relative to XY. Camera at Z = -71 (ceiling level), looking down.
    cam = make_downward_cam("DownCam", above_z=MAX_Z - 5, center_xy=(CTR_X, CTR_Y), ortho_scale=600)
    render(SS1)
    bpy.data.objects.remove(cam, do_unlink=True)

    # Spawn close-up: camera at eye level near spawn, looking toward table zone
    cam_data = bpy.data.cameras.new("CloseUp")
    cam_data.type = 'PERSP'
    cam_data.angle = math.radians(70)
    cam_obj = bpy.data.objects.new("CloseUp", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    # Position: at spawn Y, slightly above floor, center X, looking toward -Y (into room)
    cam_obj.location = (CTR_X, 500, MIN_Z + 100)
    cam_obj.rotation_euler = (math.radians(90), 0, math.radians(180))  # face -Y
    bpy.context.scene.camera = cam_obj
    render(SS2)
    bpy.data.objects.remove(cam_obj, do_unlink=True)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
