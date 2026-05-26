"""
Render the casino from the same POV as the user's screenshot,
with the targeted deletion zone highlighted in RED.
This is the "before" confirmation screenshot.
"""
import bpy
import bmesh
import math
import mathutils

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_BEFORE = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_before_highlighted.png"
SS_AFTER_PREVIEW = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_after_preview.png"

# Deletion zone (Blender import space)
BL_X_MIN = -645.0
BL_X_MAX = -505.0
BL_Y_MIN =  100.0
BL_Y_MAX =  440.0

# World transform constants
CTR_X = -720.6
CTR_Y =    0.3
MIN_Z = -274.4
SCALE = 1.9671

# POV from user screenshot:
# Avatar at world (0, 0, 800), facing -Z (into room)
# Camera behind avatar: world (~0, ~190, ~1100), looking toward avatar
# In Blender coords: blX=CTR_X (world X=0), blY≈407+150=557 (+Z camera = higher blY), blZ = EYE+pitch
# Camera target: avatar position = (CTR_X, 407, MIN_Z + 96)
# Camera behind (higher blY): (CTR_X, 540, MIN_Z + 100)
# Camera pitched down slightly to see tables

EYE_Z = MIN_Z + 96   # avatar eye height

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)

def highlight_target_zone():
    """
    Create a transparent red box mesh to show the deletion zone.
    """
    # Box center
    cx = (BL_X_MIN + BL_X_MAX) / 2
    cy = (BL_Y_MIN + BL_Y_MAX) / 2
    sx = (BL_X_MAX - BL_X_MIN)
    sy = (BL_Y_MAX - BL_Y_MIN)
    sz = 250.0  # Full room height

    bpy.ops.mesh.primitive_cube_add(
        size=1,
        location=(cx, cy, MIN_Z + sz/2)
    )
    box = bpy.context.active_object
    box.scale = (sx/2, sy/2, sz/2)
    box.name = "DELETE_ZONE"

    mat = bpy.data.materials.new("RedHighlight")
    mat.use_nodes = True
    mat.blend_method = 'BLEND'
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (1, 0, 0, 0.5)
        bsdf.inputs['Alpha'].default_value = 0.3
    box.data.materials.append(mat)
    return box

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

def make_cam(name, loc, target):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = 'PERSP'
    cam_data.angle = math.radians(70)
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
    print("=== Before Highlight Render ===", flush=True)
    reset_scene()
    import_glb(GLB_PATH)

    setup_render()

    # --- BEFORE: show room from same POV as user screenshot, with red zone ---
    highlight_target_zone()

    # Camera matching user's screenshot POV:
    # User is behind avatar, slightly elevated, looking into room
    # Avatar at blY=407 (spawn), camera at blY=550, slightly above floor
    cam1, tar1 = make_cam("UserPOV",
        loc=(CTR_X, 540, EYE_Z + 60),   # behind avatar, slightly elevated
        target=(CTR_X, 250, EYE_Z - 30)) # look toward middle of room + tables
    render(SS_BEFORE)
    bpy.data.objects.remove(cam1, do_unlink=True)
    bpy.data.objects.remove(tar1, do_unlink=True)

    # --- ALSO render without highlight box (clean before) ---
    # Remove the highlight box
    for obj in list(bpy.context.scene.objects):
        if obj.name == "DELETE_ZONE":
            bpy.data.objects.remove(obj, do_unlink=True)

    cam2, tar2 = make_cam("UserPOV2",
        loc=(CTR_X, 540, EYE_Z + 60),
        target=(CTR_X, 250, EYE_Z - 30))
    render(SS_AFTER_PREVIEW)
    bpy.data.objects.remove(cam2, do_unlink=True)
    bpy.data.objects.remove(tar2, do_unlink=True)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
