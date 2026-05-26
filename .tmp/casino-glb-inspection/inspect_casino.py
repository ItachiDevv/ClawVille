"""
Headless Blender inspection script for casino.glb
Run via: blender --background --python inspect_casino.py
"""
import bpy
import sys
import json
import os
import math

GLB_PATH = r"C:/Users/newma/Downloads/casino.glb"
OUT_DIR = r"C:/Users/newma/Documents/Crypto/ClawVille/.tmp/casino-glb-inspection"

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)

def import_glb():
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

def setup_camera(location, rotation_euler, name="InspectCam"):
    bpy.ops.object.camera_add(location=location)
    cam = bpy.context.object
    cam.name = name
    cam.rotation_euler = rotation_euler
    cam.data.lens = 35
    bpy.context.scene.camera = cam
    return cam

def setup_lighting():
    # Remove existing lights
    for obj in bpy.data.objects:
        if obj.type == 'LIGHT':
            bpy.data.objects.remove(obj, do_unlink=True)
    # Add a sun
    bpy.ops.object.light_add(type='SUN', location=(5, 5, 10))
    sun = bpy.context.object
    sun.data.energy = 3.0
    # Add fill light
    bpy.ops.object.light_add(type='AREA', location=(-3, -3, 5))
    fill = bpy.context.object
    fill.data.energy = 500.0
    fill.data.size = 5.0

def get_scene_bounds():
    """Get world-space bounding box of all mesh objects."""
    all_verts = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        matrix = obj.matrix_world
        for v in obj.data.vertices:
            co = matrix @ v.co
            all_verts.append(co)
    if not all_verts:
        return None
    xs = [v.x for v in all_verts]
    ys = [v.y for v in all_verts]
    zs = [v.z for v in all_verts]
    return {
        'min': [min(xs), min(ys), min(zs)],
        'max': [max(xs), max(ys), max(zs)],
        'size': [max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs)],
        'center': [(min(xs)+max(xs))/2, (min(ys)+max(ys))/2, (min(zs)+max(zs))/2],
    }

def get_mesh_stats():
    stats = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        # Tri count (each polygon may be n-gon; count tris)
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        # Materials
        mat_names = [m.name if m else "None" for m in obj.material_slots if m.material]
        # Local bounding box
        bbox = [obj.matrix_world @ v for v in [obj.matrix_world.inverted() @ (obj.matrix_world @ b) for b in [obj.location]]]
        lb = obj.bound_box  # 8 corners in local space
        world_corners = [obj.matrix_world @ __import__('mathutils').Vector(c) for c in lb]
        xs = [c.x for c in world_corners]
        ys = [c.y for c in world_corners]
        zs = [c.z for c in world_corners]
        stats.append({
            'name': obj.name,
            'verts': len(mesh.vertices),
            'faces': len(mesh.polygons),
            'tris': tris,
            'location': list(obj.location),
            'bbox_world': {
                'min': [min(xs), min(ys), min(zs)],
                'max': [max(xs), max(ys), max(zs)],
                'size': [max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs)],
            },
            'materials': mat_names,
        })
    return stats

def render_viewport(filepath, res=(1280, 720)):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = res[0]
    scene.render.resolution_y = res[1]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = filepath
    # Workbench settings for good visibility
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_object_outline = True
    scene.display.shading.show_shadows = True
    bpy.ops.render.render(write_still=True)

def point_camera_at(cam, target):
    import mathutils
    direction = target - cam.location
    rot_quat = direction.to_track_quat('-Z', 'Y')
    cam.rotation_euler = rot_quat.to_euler()

def main():
    print("=== CASINO GLB INSPECTION START ===")

    clear_scene()
    import_glb()
    setup_lighting()

    # Gather stats
    bounds = get_scene_bounds()
    mesh_stats = get_mesh_stats()

    # Save JSON report
    report = {
        'scene_bounds': bounds,
        'mesh_count': len(mesh_stats),
        'meshes': mesh_stats,
        'total_tris': sum(m['tris'] for m in mesh_stats),
        'total_verts': sum(m['verts'] for m in mesh_stats),
        'total_faces': sum(m['faces'] for m in mesh_stats),
    }
    report_path = os.path.join(OUT_DIR, 'report.json')
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"Report saved: {report_path}")
    print(json.dumps(report, indent=2))

    # Figure out camera positions based on scene center + size
    if bounds:
        cx, cy, cz = bounds['center']
        sx, sy, sz = bounds['size']
        max_dim = max(sx, sy, sz)
        cam_dist = max_dim * 1.5 + 2.0
        import mathutils
        center = mathutils.Vector((cx, cy, cz))

        # ---- Front view ----
        cam = setup_camera(
            location=(cx, cy - cam_dist, cz + sz * 0.3),
            rotation_euler=(math.radians(80), 0, 0),
            name="CamFront"
        )
        point_camera_at(cam, center)
        render_viewport(os.path.join(OUT_DIR, "01_front.png"))

        # ---- Top view ----
        cam.location = (cx, cy, cz + cam_dist * 1.2)
        cam.rotation_euler = (0, 0, 0)
        point_camera_at(cam, center)
        render_viewport(os.path.join(OUT_DIR, "02_top.png"))

        # ---- 3/4 perspective ----
        cam.location = (cx + cam_dist * 0.8, cy - cam_dist * 0.8, cz + cam_dist * 0.6)
        point_camera_at(cam, center)
        render_viewport(os.path.join(OUT_DIR, "03_threequarter.png"))

        # ---- Side view (right) ----
        cam.location = (cx + cam_dist, cy, cz + sz * 0.3)
        point_camera_at(cam, center)
        render_viewport(os.path.join(OUT_DIR, "04_side.png"))

        # ---- Close-up of smallest meshes (find the 3 smallest by vert count) ----
        sorted_by_verts = sorted(mesh_stats, key=lambda m: m['verts'])
        small_meshes = sorted_by_verts[:3]
        if small_meshes:
            # Center on smallest mesh
            smallest = small_meshes[0]
            sc = smallest['bbox_world']
            scx = (sc['min'][0] + sc['max'][0]) / 2
            scy = (sc['min'][1] + sc['max'][1]) / 2
            scz = (sc['min'][2] + sc['max'][2]) / 2
            sdim = max(sc['size']) if max(sc['size']) > 0 else 1.0
            small_center = mathutils.Vector((scx, scy, scz))
            close_dist = sdim * 2.5 + 0.5
            cam.location = (scx + close_dist * 0.7, scy - close_dist * 0.7, scz + close_dist * 0.5)
            point_camera_at(cam, small_center)
            render_viewport(os.path.join(OUT_DIR, "05_closeup_smallest.png"))

        # ---- Interior angle (slightly below top, looking inward if interior) ----
        cam.location = (cx + sx * 0.3, cy + sy * 0.3, cz + sz * 0.6)
        point_camera_at(cam, center)
        render_viewport(os.path.join(OUT_DIR, "06_interior_angle.png"))

    # Also: check material properties (transparency, texture names)
    mat_info = []
    for mat in bpy.data.materials:
        info = {'name': mat.name}
        if mat.use_nodes:
            for node in mat.node_tree.nodes:
                if node.type == 'BSDF_PRINCIPLED':
                    alpha_input = node.inputs.get('Alpha')
                    info['alpha'] = alpha_input.default_value if alpha_input else 1.0
                    break
        info['blend_method'] = getattr(mat, 'blend_method', 'unknown')
        info['use_backface_culling'] = getattr(mat, 'use_backface_culling', None)
        mat_info.append(info)

    mat_path = os.path.join(OUT_DIR, 'materials.json')
    with open(mat_path, 'w') as f:
        json.dump(mat_info, f, indent=2)
    print(f"Materials saved: {mat_path}")
    print("=== DONE ===")

main()
