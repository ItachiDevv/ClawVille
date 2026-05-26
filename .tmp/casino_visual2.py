"""
Phase 1 visual: use Workbench renderer (solid mode) for reliable headless screenshots.
No file writes to the GLB.
"""
import bpy
import math

GLB_PATH  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_TOP    = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_top.png"
SS_SIDE   = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_side.png"
SS_PERSP  = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_persp.png"

# GLB center / bounds (Blender import space)
CTR_X  = -720.557
CTR_Y  =    0.290
CTR_Z  = -172.730  # approximate height center (min=-274.4, max=-71.0)
MIN_Z  = -274.399

SCALE  = 1.9671

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb():
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

def add_marker(loc, r=12, name="M", rgb=(1,0,0)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    mat = bpy.data.materials.new(name + "_m")
    mat.diffuse_color = (*rgb, 1.0)
    obj.data.materials.append(mat)
    return obj

def setup_render_workbench():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    # Workbench settings
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True

def make_cam(name, camtype, loc, rot_euler, ortho_scale=None):
    cam_data = bpy.data.cameras.new(name)
    cam_data.type = camtype
    if ortho_scale:
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.lens = 28
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
    print("=== Visual Inspect v2 ===", flush=True)
    reset_scene()
    import_glb()

    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    print(f"Meshes: {[m.name for m in meshes]}", flush=True)

    # ---- Cluster Material3.004 by Blender Y (room depth axis) ----
    # From earlier run: top clusters near spawn:
    # blY=400 -> wZ=786 (closest, 395 verts)
    # blY=450 -> wZ=885 (106 verts)
    # blY=350 -> wZ=688 (746 verts)
    # blY=500 -> wZ=983 (1533 verts = far wall area)
    # The spawn is at blY=407, wZ=800.
    # Tables are symmetric left-right clusters at same blY but different blX.
    # Let's find clusters at blY ~350-450 more precisely by X split.

    table_data = {}  # blY_bin -> {left: [], right: []}
    for obj in meshes:
        if not obj.name.startswith('Material3.004'):
            continue
        mat = obj.matrix_world
        for v in obj.data.vertices:
            wco = mat @ v.co
            blY = wco.y
            blX = wco.x
            bin_y = round(blY / 50.0) * 50.0
            if bin_y not in table_data:
                table_data[bin_y] = {'xs': [], 'zs': []}
            table_data[bin_y]['xs'].append(blX)
            table_data[bin_y]['zs'].append(wco.z)

    print("\n--- Material3.004 clusters with X detail (blY 250..510) ---", flush=True)
    for by in sorted(table_data.keys()):
        if not (250 <= by <= 510):
            continue
        xs = table_data[by]['xs']
        zs = table_data[by]['zs']
        if len(xs) < 5:
            continue
        min_x = min(xs); max_x = max(xs); cx = sum(xs)/len(xs); cz = sum(zs)/len(zs)
        wZ = (by - CTR_Y) * SCALE
        wY = (cz - MIN_Z) * SCALE
        wX_ctr = (cx - CTR_X) * SCALE
        print(f"  blY={by:.0f}: verts={len(xs)} blX=[{min_x:.0f}..{max_x:.0f}] cx={cx:.0f} cz={cz:.0f}", flush=True)
        print(f"    -> worldXYZ=({wX_ctr:.0f}, {wY:.0f}, {wZ:.0f})", flush=True)
        # Check if two X clusters (left table, right table)
        left  = [x for x in xs if x < cx - 50]
        right = [x for x in xs if x > cx + 50]
        if left and right:
            cx_l = sum(left)/len(left)
            cx_r = sum(right)/len(right)
            wX_l = (cx_l - CTR_X) * SCALE
            wX_r = (cx_r - CTR_X) * SCALE
            print(f"    LEFT cluster:  blX_ctr={cx_l:.0f} -> worldX={wX_l:.0f}", flush=True)
            print(f"    RIGHT cluster: blX_ctr={cx_r:.0f} -> worldX={wX_r:.0f}", flush=True)

    # ---- Add visual markers ----
    # Top 4 candidate table centers (from earlier analysis):
    # blY=400 (wZ=786, closest to spawn) - 2 tables left+right
    # blY=350 (wZ=688) - 2 tables left+right
    # blY=450 (wZ=885) - likely fewer but still near spawn
    SPAWN_BL = (CTR_X, 407.0, CTR_Z)
    add_marker(SPAWN_BL, r=20, name="SPAWN_CYAN", rgb=(0, 1, 1))

    # Markers at the two primary blY clusters
    for blY, rgb, label in [
        (400.0, (1, 0, 0), "T_400_RED"),
        (350.0, (1, 0.5, 0), "T_350_ORG"),
        (450.0, (1, 1, 0), "T_450_YEL"),
        (500.0, (0.5, 0, 1), "T_500_PUR"),
    ]:
        if blY in table_data:
            xs = table_data[blY]['xs']
            zs = table_data[blY]['zs']
            if xs:
                cx = sum(xs)/len(xs)
                cz = sum(zs)/len(zs)
                add_marker((cx, blY, cz), r=15, name=label, rgb=rgb)
                # If left/right split exists, add both
                left  = [x for x in xs if x < cx - 50]
                right = [x for x in xs if x > cx + 50]
                if left and right:
                    cx_l = sum(left)/len(left)
                    cx_r = sum(right)/len(right)
                    cz_l = sum(zs[i] for i,x in enumerate(xs) if x < cx-50) / len(left)
                    cz_r = sum(zs[i] for i,x in enumerate(xs) if x > cx+50) / len(right)
                    add_marker((cx_l, blY, cz_l), r=15, name=label+"_L", rgb=rgb)
                    add_marker((cx_r, blY, cz_r), r=15, name=label+"_R", rgb=rgb)

    setup_render_workbench()

    # Top-down ortho: camera above center, pointing down (-Z)
    cam = make_cam("TopCam", 'ORTHO',
                   loc=(CTR_X, CTR_Y, MIN_Z + 600),
                   rot_euler=(0, 0, 0),
                   ortho_scale=700)
    render(SS_TOP)
    bpy.data.objects.remove(cam, do_unlink=True)

    # Side ortho: camera from +X side, looking inward (-X dir)
    # rotation: pitch 90deg to look horizontally, then yaw to face -X
    cam = make_cam("SideCam", 'ORTHO',
                   loc=(CTR_X + 800, CTR_Y, CTR_Z),
                   rot_euler=(math.pi/2, 0, math.pi/2),
                   ortho_scale=700)
    render(SS_SIDE)
    bpy.data.objects.remove(cam, do_unlink=True)

    # Perspective: looking from +Y (front entrance) into the room
    # In blender: room long axis = Y, so player enters from high-Y side
    # Camera at +Y extreme, looking toward -Y (into the room)
    cam = make_cam("PerspCam", 'PERSP',
                   loc=(CTR_X, CTR_Y + 700, CTR_Z + 200),
                   rot_euler=(math.radians(75), 0, 0))
    render(SS_PERSP)
    bpy.data.objects.remove(cam, do_unlink=True)

    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
