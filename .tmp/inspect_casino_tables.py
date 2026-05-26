"""
Phase 1 inspection: enumerate vertex islands in casino-interior.glb,
identify poker table islands, report centroids + face counts.
No file modifications — read-only.
"""
import bpy
import bmesh
import sys
import json
import math

GLB_PATH = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
OUTPUT_JSON = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_islands.json"
SCREENSHOT_TOP = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_top.png"
SCREENSHOT_FRONT = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_front.png"
SCREENSHOT_PERSP = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_persp.png"

# --- Autofit transform params (from runtime) ---
INTERIOR_TARGET_HEIGHT = 2000.0

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Remove default objects
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()

def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)

def get_mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']

def compute_autofit(mesh_objects):
    """
    Replicate the runtime autofit: scale = TARGET / maxDim,
    then center X/Z, push min-Y to 0.
    Returns (scale, offset_x, offset_y, offset_z)
    """
    min_x = min_y = min_z = math.inf
    max_x = max_y = max_z = -math.inf
    for obj in mesh_objects:
        for v in obj.data.vertices:
            wco = obj.matrix_world @ v.co
            min_x = min(min_x, wco.x)
            max_x = max(max_x, wco.x)
            min_y = min(min_y, wco.y)
            max_y = max(max_y, wco.y)
            min_z = min(min_z, wco.z)
            max_z = max(max_z, wco.z)
    dx = max_x - min_x
    dy = max_y - min_y
    dz = max_z - min_z
    max_dim = max(dx, dy, dz)
    scale = INTERIOR_TARGET_HEIGHT / max_dim
    cx = (min_x + max_x) / 2.0
    cz = (min_z + max_z) / 2.0
    return {
        "scale": scale,
        "offset_x": -cx * scale,
        "offset_y": -min_y * scale,
        "offset_z": -cz * scale,
        "glb_bounds": {
            "x": [min_x, max_x],
            "y": [min_y, max_y],
            "z": [min_z, max_z]
        },
        "dims": [dx, dy, dz],
        "max_dim": max_dim
    }

def glb_to_world(pt, af):
    """Apply the autofit transform to a GLB-space point."""
    return (
        pt[0] * af["scale"] + af["offset_x"],
        pt[1] * af["scale"] + af["offset_y"],
        pt[2] * af["scale"] + af["offset_z"],
    )

def enumerate_islands(obj, af):
    """
    Use bmesh to find disconnected vertex islands.
    Returns list of dicts with centroid, face_count, vert_count.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()

    visited_faces = set()
    islands = []

    for start_face in bm.faces:
        if start_face.index in visited_faces:
            continue
        # BFS to collect connected faces
        island_faces = []
        stack = [start_face]
        while stack:
            f = stack.pop()
            if f.index in visited_faces:
                continue
            visited_faces.add(f.index)
            island_faces.append(f)
            for edge in f.edges:
                for linked_face in edge.link_faces:
                    if linked_face.index not in visited_faces:
                        stack.append(linked_face)

        # Gather verts
        island_verts = set()
        for f in island_faces:
            for v in f.verts:
                island_verts.add(v.index)

        # Compute centroid in object local space
        vert_cos = [bm.verts[vi].co.copy() for vi in island_verts]
        cx = sum(c.x for c in vert_cos) / len(vert_cos)
        cy = sum(c.y for c in vert_cos) / len(vert_cos)
        cz = sum(c.z for c in vert_cos) / len(vert_cos)

        # Transform to world (object matrix_world then autofit)
        import mathutils
        local_pt = mathutils.Vector((cx, cy, cz))
        world_local = obj.matrix_world @ local_pt
        glb_pt = (world_local.x, world_local.y, world_local.z)
        wpt = glb_to_world(glb_pt, af)

        # Bounding box of island
        xs = [c.x for c in vert_cos]
        ys = [c.y for c in vert_cos]
        zs = [c.z for c in vert_cos]
        local_size = (max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs))

        islands.append({
            "mesh": obj.name,
            "island_idx": len(islands),
            "face_count": len(island_faces),
            "vert_count": len(island_verts),
            "glb_centroid": list(glb_pt),
            "world_centroid": list(wpt),
            "local_size_xyz": list(local_size),
        })

    bm.free()
    return islands

def take_screenshot(filepath, view='TOP'):
    """Render a viewport screenshot."""
    # Find the 3D viewport area
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                for space in area.spaces:
                    if space.type == 'VIEW_3D':
                        if view == 'TOP':
                            space.region_3d.view_perspective = 'ORTHO'
                            bpy.ops.view3d.view_axis(type='TOP')
                        elif view == 'FRONT':
                            space.region_3d.view_perspective = 'ORTHO'
                            bpy.ops.view3d.view_axis(type='FRONT')
                        else:
                            space.region_3d.view_perspective = 'PERSP'
                        break
    bpy.ops.render.opengl(write_still=True, filepath=filepath, view_context=True)

def main():
    print("=== Casino GLB Inspection ===", flush=True)
    reset_scene()
    print("Importing GLB...", flush=True)
    import_glb(GLB_PATH)

    meshes = get_mesh_objects()
    print(f"Mesh objects: {[m.name for m in meshes]}", flush=True)

    # Compute autofit transform
    af = compute_autofit(meshes)
    print(f"Autofit: scale={af['scale']:.4f}, bounds X={af['glb_bounds']['x']}, Y={af['glb_bounds']['y']}, Z={af['glb_bounds']['z']}", flush=True)
    print(f"Dims: {af['dims']}, maxDim={af['max_dim']:.2f}", flush=True)

    # Enumerate islands per mesh
    all_islands = []
    for obj in meshes:
        print(f"  Enumerating islands in {obj.name}...", flush=True)
        islands = enumerate_islands(obj, af)
        print(f"    Found {len(islands)} islands", flush=True)
        all_islands.extend(islands)

    # Sort by world Z descending (closest to spawn at world z=+800)
    all_islands.sort(key=lambda i: i["world_centroid"][2], reverse=True)

    print(f"\nTotal islands: {len(all_islands)}", flush=True)
    print("\nAll islands (sorted by world Z descending):", flush=True)
    for i, island in enumerate(all_islands):
        wc = island["world_centroid"]
        gc = island["glb_centroid"]
        print(f"  [{i}] mesh={island['mesh']} faces={island['face_count']} verts={island['vert_count']}", flush=True)
        print(f"      GLB centroid: ({gc[0]:.1f}, {gc[1]:.1f}, {gc[2]:.1f})", flush=True)
        print(f"      World centroid: ({wc[0]:.1f}, {wc[1]:.1f}, {wc[2]:.1f})", flush=True)
        sz = island["local_size_xyz"]
        print(f"      Local size (xyz): ({sz[0]:.1f}, {sz[1]:.1f}, {sz[2]:.1f})", flush=True)

    # Save JSON
    result = {
        "autofit": af,
        "islands": all_islands,
    }
    with open(OUTPUT_JSON, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"\nJSON saved to {OUTPUT_JSON}", flush=True)

    print("\n=== Done ===", flush=True)

if __name__ == "__main__":
    main()
