"""
Phase 1: Visual inspection + positional clustering of poker tables.
Takes screenshots from top/front/perspective views.
Clusters Material3.004 islands by Y position (the room's long axis = depth).
No file modifications.
"""
import bpy
import bmesh
import mathutils
import sys
import os
import math

GLB_PATH   = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
SS_TOP     = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_top.png"
SS_SIDE    = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_side.png"
SS_PERSP   = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_persp.png"
SS_BOTTOM  = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_bottom.png"

# ---- World transform constants (matching Three.js runtime) ----
# GLB coords (Blender-space after import):
#   X: [-963, -478]  center=-720.5
#   Y: [-508, +509]  center=+0.29   <- long axis, maxDim=1016 -> scale=1.967
#   Z: [-274, -71]   minZ=-274.4     <- height axis, floor at wY=0
SCALE      = 2000.0 / 1016.704833984375  # 1.9671
CTR_X      = (-963.236572 + (-477.876892)) / 2.0   # -720.5569
CTR_Y      = (-508.062286 + 508.642548) / 2.0       # +0.2901
MIN_Z      = -274.3991394                            # floor

# Spawn in world: wX=0, wZ=+800
# wZ = (blY - CTR_Y) * SCALE => blY_spawn = 800/SCALE + CTR_Y = 406.97
SPAWN_BL_Y = 800.0 / SCALE + CTR_Y  # ≈ 407.0

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb():
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

def get_meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']

def world_coords(blX, blY, blZ):
    """Convert Blender-import coords to Three.js world coords."""
    wX = (blX - CTR_X) * SCALE
    wY = (blZ - MIN_Z) * SCALE   # blender Z = world height
    wZ = (blY - CTR_Y) * SCALE   # blender Y = world depth
    return (wX, wY, wZ)

def cluster_by_blY(meshes, mesh_name, bin_size=30.0):
    """
    Collect all vertex Y-coords from a named mesh, bin by Y in [bin_size] increments.
    Returns sorted list of (bin_center_Y, vertex_count, xz_extent).
    """
    bins = {}
    for obj in meshes:
        if not obj.name.startswith(mesh_name):
            continue
        mat = obj.matrix_world
        for v in obj.data.vertices:
            wco = mat @ v.co
            by = wco.y
            bin_k = round(by / bin_size) * bin_size
            if bin_k not in bins:
                bins[bin_k] = {'count': 0, 'xs': [], 'zs': [], 'blY_vals': []}
            bins[bin_k]['count'] += 1
            bins[bin_k]['xs'].append(wco.x)
            bins[bin_k]['zs'].append(wco.z)
            bins[bin_k]['blY_vals'].append(wco.y)

    result = []
    for bk, data in sorted(bins.items()):
        cx = sum(data['xs'])/len(data['xs'])
        cz = sum(data['zs'])/len(data['zs'])
        result.append({
            'bin_blY': bk,
            'vcount': data['count'],
            'centroid_X': cx,
            'centroid_Y': bk,
            'centroid_Z': cz,
        })
    return result

def setup_camera_top(distance=1500):
    """Set up a top-down orthographic camera."""
    cam_data = bpy.data.cameras.new("TopCam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 1200
    cam_obj = bpy.data.objects.new("TopCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.location = (-720, 0, distance)
    cam_obj.rotation_euler = (0, 0, 0)
    bpy.context.scene.camera = cam_obj
    return cam_obj

def setup_camera_side(distance=800):
    """Side orthographic camera (looking along X axis)."""
    cam_data = bpy.data.cameras.new("SideCam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 1200
    cam_obj = bpy.data.objects.new("SideCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.location = (-720 + distance, 0, -172)
    cam_obj.rotation_euler = (math.pi/2, 0, math.pi/2)
    bpy.context.scene.camera = cam_obj
    return cam_obj

def setup_camera_persp():
    cam_data = bpy.data.cameras.new("PerspCam")
    cam_data.type = 'PERSP'
    cam_data.lens = 35
    cam_obj = bpy.data.objects.new("PerspCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.location = (-720 + 600, -700, -172 + 200)
    cam_obj.rotation_euler = (math.radians(70), 0, math.radians(35))
    bpy.context.scene.camera = cam_obj
    return cam_obj

def setup_lighting():
    """Add a simple sun light."""
    light_data = bpy.data.lights.new("Sun", 'SUN')
    light_data.energy = 3
    light_obj = bpy.data.objects.new("Sun", light_data)
    bpy.context.scene.collection.objects.link(light_obj)
    light_obj.location = (-500, -300, 200)
    light_obj.rotation_euler = (math.radians(45), 0, math.radians(30))

def render_screenshot(filepath):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE_NEXT' if hasattr(bpy.types, 'EEVEE_NEXT_RenderEngine') else 'BLENDER_EEVEE'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = filepath
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    bpy.ops.render.render(write_still=True)
    print(f"Saved: {filepath}", flush=True)

def add_marker_sphere(location, radius=10, name="Marker", color=(1, 0, 0, 1)):
    """Add a colored sphere at a location to mark a table center."""
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=location)
    obj = bpy.context.active_object
    obj.name = name
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs['Base Color'].default_value = color
        bsdf.inputs['Emission Color'].default_value = color
        bsdf.inputs['Emission Strength'].default_value = 3.0
    obj.data.materials.append(mat)
    return obj

def main():
    print("=== Phase 1 Visual Inspection ===", flush=True)
    reset_scene()
    import_glb()
    meshes = get_meshes()
    print(f"Meshes: {[m.name for m in meshes]}", flush=True)

    # ---- Cluster Material3.004 by Blender Y position ----
    # Material3.004 = table surface/felt (multiple candidate islands at various depths)
    # We bin by blender Y with bin_size=50 to find clusters = individual table groups
    print("\n--- Clustering Material3.004 by Blender Y ---", flush=True)
    clusters = cluster_by_blY(meshes, 'Material3.004', bin_size=50.0)

    print(f"Distinct Y bins: {len(clusters)}", flush=True)

    # Convert to world coords for analysis
    table_candidates = []
    for c in clusters:
        if c['vcount'] < 8:  # skip tiny noise
            continue
        blY = c['bin_blY']
        blX = c['centroid_X']
        blZ = c['centroid_Z']
        wX, wY, wZ = world_coords(blX, blY, blZ)
        dist_from_spawn = abs(wZ - 800)
        table_candidates.append({
            'blY': blY, 'blX': blX, 'blZ': blZ,
            'wX': wX, 'wY': wY, 'wZ': wZ,
            'vcount': c['vcount'],
            'dist_from_spawn': dist_from_spawn,
        })

    # Sort by proximity to spawn
    table_candidates.sort(key=lambda x: x['dist_from_spawn'])

    print("\n--- Material3.004 clusters by blender Y (sorted by proximity to spawn wZ=+800) ---", flush=True)
    for i, tc in enumerate(table_candidates[:20]):
        print(f"  [{i}] blY={tc['blY']:.1f} wXYZ=({tc['wX']:.1f},{tc['wY']:.1f},{tc['wZ']:.1f}) vcount={tc['vcount']} dist_spawn={tc['dist_from_spawn']:.1f}", flush=True)

    # Also cluster all meshes to find anything near spawn Z
    print("\n--- Vertices near spawn zone (wZ in [600, 900]) across all meshes ---", flush=True)
    spawn_zone = {}
    for obj in meshes:
        mat = obj.matrix_world
        near_count = 0
        for v in obj.data.vertices:
            wco = mat @ v.co
            # convert to world Z: wZ = (blY - CTR_Y) * SCALE
            wZ_v = (wco.y - CTR_Y) * SCALE
            if 600 <= wZ_v <= 1000:
                near_count += 1
        if near_count > 0:
            spawn_zone[obj.name] = near_count
    for name, cnt in sorted(spawn_zone.items(), key=lambda x: -x[1]):
        print(f"  {name}: {cnt} vertices in wZ [600, 1000]", flush=True)

    # ---- Setup lighting ----
    setup_lighting()

    # ---- Mark the top 4 table candidates with colored spheres ----
    # We'll mark the 2 closest to spawn (spawn side tables) in RED
    # and the next 2 in YELLOW
    table_positions_blender = []
    for i, tc in enumerate(table_candidates[:6]):
        color = (1, 0, 0, 1) if i < 2 else (1, 1, 0, 1)
        loc = (tc['blX'], tc['blY'], tc['blZ'])
        table_positions_blender.append(loc)
        add_marker_sphere(loc, radius=15, name=f"Table_{i}", color=color)
        print(f"  Marker {i}: blender=({loc[0]:.1f},{loc[1]:.1f},{loc[2]:.1f}) world=({tc['wX']:.1f},{tc['wY']:.1f},{tc['wZ']:.1f})", flush=True)

    # Also add a CYAN marker at spawn position for reference
    spawn_blX = CTR_X  # spawn is at wX=0 => blX = CTR_X
    spawn_blY = SPAWN_BL_Y  # ≈ 407.0
    spawn_blZ = -172.7  # mid-height approximately
    add_marker_sphere((spawn_blX, spawn_blY, spawn_blZ), radius=20, name="SPAWN", color=(0, 1, 1, 1))
    print(f"\n  SPAWN marker at blender ({spawn_blX:.1f}, {spawn_blY:.1f}, {spawn_blZ:.1f})", flush=True)

    # ---- Render screenshots ----
    print("\n--- Rendering screenshots ---", flush=True)

    # Top-down view
    cam = setup_camera_top()
    render_screenshot(SS_TOP)
    bpy.data.objects.remove(cam, do_unlink=True)

    # Side view (looking along X)
    cam = setup_camera_side()
    render_screenshot(SS_SIDE)
    bpy.data.objects.remove(cam, do_unlink=True)

    # Perspective
    cam = setup_camera_persp()
    render_screenshot(SS_PERSP)
    bpy.data.objects.remove(cam, do_unlink=True)

    print("\n=== Done ===", flush=True)

if __name__ == "__main__":
    main()
