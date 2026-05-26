"""
Final definitive render: low-altitude top-down inside the room to clearly count tables.
Also a side view from spawn looking along the table row.
"""
import bpy
import math

GLB_PATH = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS1 = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\final_top_lowalt.png"
SS2 = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\final_rightwall.png"
SS3 = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\final_spawn_wide.png"

CTR_X = -720.6
CTR_Y =    0.3
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

def make_cam(name, loc, target, camtype='PERSP', ortho_scale=None, fov=60):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = camtype
    if ortho_scale:
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.angle = math.radians(fov)
    cam_obj = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.location = loc
    tar = bpy.data.objects.new(name+"T", None)
    bpy.context.scene.collection.objects.link(tar)
    tar.location = target
    con = cam_obj.constraints.new('TRACK_TO')
    con.target = tar
    con.track_axis = 'TRACK_NEGATIVE_Z'
    con.up_axis = 'UP_Y'
    bpy.context.view_layer.update()
    bpy.context.scene.camera = cam_obj
    return cam_obj, tar

def render(filepath):
    bpy.context.scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    print(f"Saved: {filepath}", flush=True)

def rm(cam, tar):
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.objects.remove(tar, do_unlink=True)

def main():
    print("=== Final definitive render ===", flush=True)
    reset_scene()
    import_glb()

    # Spawn marker
    add_marker((CTR_X, 407.0, MIN_Z + 5), r=12, name="SPAWN", rgb=(0, 1, 1))
    # Mark the 3 arch tables at spawn side
    # LEFT (worldX=-282, worldZ=642)
    add_marker((-864, 320, MIN_Z+5), r=10, name="ARCH_L", rgb=(1,0,0))
    # CENTER (worldX=0, worldZ=623)
    add_marker((-720, 316, MIN_Z+5), r=10, name="ARCH_C", rgb=(1,0.5,0))
    # RIGHT (worldX=+284, worldZ=642)
    add_marker((-576, 320, MIN_Z+5), r=10, name="ARCH_R", rgb=(1,0,0))

    setup_render()

    # 1. Low-altitude top-down ortho: camera just below ceiling, looking down
    # Camera at MAX_Z (ceiling = -71), looking toward floor at MIN_Z
    # ORTHO looking down: camera local -Z = world -Z direction
    cam1_data = bpy.data.cameras.new("TopCam")
    cam1_data.type = 'ORTHO'
    cam1_data.ortho_scale = 600
    cam1 = bpy.data.objects.new("TopCam", cam1_data)
    bpy.context.scene.collection.objects.link(cam1)
    cam1.location = (CTR_X, CTR_Y, MAX_Z - 5)  # just below ceiling
    cam1.rotation_euler = (0, 0, 0)  # default: camera faces -Z = downward in blender
    bpy.context.scene.camera = cam1
    render(SS1)
    bpy.data.objects.remove(cam1, do_unlink=True)

    # 2. Side view from the RIGHT WALL (blX = -478, looking toward -X = left wall)
    # This shows the table row from the side, good for counting individual tables
    cam2, tar2 = make_cam("SideRight",
        loc=(-478 + 10, CTR_Y, CTR_Z + 50),
        target=(-963, CTR_Y, CTR_Z),
        camtype='ORTHO', ortho_scale=250)
    render(SS2)
    rm(cam2, tar2)

    # 3. Wide spawn view - camera further back (blY=530) looking at all 3 arches at once
    cam3, tar3 = make_cam("SpawnWide",
        loc=(CTR_X, 530, MIN_Z + 80),
        target=(CTR_X, 350, MIN_Z + 40),
        camtype='PERSP', fov=90)
    render(SS3)
    rm(cam3, tar3)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
