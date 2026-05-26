"""
Before view from correct POV (same as interior_view1 that worked).
With red highlight box showing deletion zone.
"""
import bpy
import math
import mathutils

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_BEFORE = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\before_view.png"
SS_BEFORE_HL = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\before_view_highlighted.png"

CTR_X = -720.6
CTR_Y =    0.3
MIN_Z = -274.4
EYE_Z = MIN_Z + 96

# Deletion zone
BL_X_MIN = -645.0
BL_X_MAX = -505.0
BL_Y_MIN =  100.0
BL_Y_MAX =  440.0

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)

def setup_render():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = False
    scene.display.shading.show_backface_culling = False

def track_camera(name, loc, target, fov=70):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = 'PERSP'
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

def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"Saved: {path}", flush=True)

def add_highlight_box():
    cx = (BL_X_MIN + BL_X_MAX) / 2
    cy = (BL_Y_MIN + BL_Y_MAX) / 2
    sx = (BL_X_MAX - BL_X_MIN)
    sy = (BL_Y_MAX - BL_Y_MIN)
    sz = 240.0

    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, MIN_Z + sz/2))
    box = bpy.context.active_object
    box.scale = (sx/2, sy/2, sz/2)
    box.name = "DELETE_ZONE"
    mat = bpy.data.materials.new("RedHL")
    mat.diffuse_color = (1, 0, 0, 1)
    box.data.materials.append(mat)
    return box

def main():
    print("=== Before View ===", flush=True)
    reset_scene()
    import_glb(GLB_PATH)
    setup_render()

    # Clean POV (same as interior_view1 that worked)
    cam, tar = track_camera("POV",
        loc=(CTR_X, 450, EYE_Z),      # inside room near spawn, at eye height
        target=(CTR_X, 0, EYE_Z),     # looking toward back wall (low Y)
        fov=80)
    render(SS_BEFORE)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.objects.remove(tar, do_unlink=True)

    # With highlight box
    box = add_highlight_box()
    cam2, tar2 = track_camera("POV2",
        loc=(CTR_X, 450, EYE_Z),
        target=(CTR_X, 0, EYE_Z),
        fov=80)
    render(SS_BEFORE_HL)
    bpy.data.objects.remove(cam2, do_unlink=True)
    bpy.data.objects.remove(tar2, do_unlink=True)
    bpy.data.objects.remove(box, do_unlink=True)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
