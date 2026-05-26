"""
After view from same POV as before_view.png, using the modified GLB.
"""
import bpy
import math

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_AFTER  = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\after_view.png"

CTR_X = -720.6
MIN_Z = -274.4
EYE_Z = MIN_Z + 96

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

def main():
    print("=== After View ===", flush=True)
    reset_scene()
    import_glb(GLB_PATH)
    setup_render()

    cam, tar = track_camera("POV",
        loc=(CTR_X, 450, EYE_Z),
        target=(CTR_X, 0, EYE_Z),
        fov=80)
    render(SS_AFTER)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.objects.remove(tar, do_unlink=True)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
