"""
Phase 2 v2: Fixed face deletion.
Uses local-to-world transform correctly via matrix_world.
Deletes faces whose centroid (in world space) falls within the target zone.
"""
import bpy
import bmesh
import mathutils
import math
import os
import sys

GLB_IN   = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
GLB_TMP  = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino-no-tables-uncompressed.glb"

# Target zone (Blender local/world space — GLB imported at identity transform)
# Right-side two poker tables: X > -639 (world +X), Y in [100, 440] (spawn-depth rows)
# Bounds chosen to avoid right wall at blX ≈ -478 (buffer of 27 units: cut at -505)
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

def count_verts():
    return sum(len(o.data.vertices) for o in bpy.context.scene.objects if o.type == 'MESH')

def face_centroid_world(face, matrix_world):
    """Compute the world-space centroid of a bmesh face."""
    local_cx = sum(v.co.x for v in face.verts) / len(face.verts)
    local_cy = sum(v.co.y for v in face.verts) / len(face.verts)
    local_cz = sum(v.co.z for v in face.verts) / len(face.verts)
    world_co = matrix_world @ mathutils.Vector((local_cx, local_cy, local_cz))
    return world_co

def in_zone(wx, wy):
    """Check if world (x, y) falls in deletion zone."""
    return BL_X_MIN <= wx <= BL_X_MAX and BL_Y_MIN <= wy <= BL_Y_MAX

def delete_right_tables():
    total_faces_deleted = 0
    total_verts_removed = 0
    affected = []

    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue

        mesh = obj.data
        mat = obj.matrix_world

        # Quick check: does this object have ANY vertex in the zone?
        has_zone_verts = False
        for v in mesh.vertices:
            wco = mat @ v.co
            if in_zone(wco.x, wco.y):
                has_zone_verts = True
                break

        if not has_zone_verts:
            continue

        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.faces.ensure_lookup_table()
        bm.verts.ensure_lookup_table()

        faces_to_del = []
        for face in bm.faces:
            wco = face_centroid_world(face, mat)
            if in_zone(wco.x, wco.y):
                faces_to_del.append(face)

        if not faces_to_del:
            bm.free()
            continue

        print(f"  {obj.name}: deleting {len(faces_to_del)} faces", flush=True)
        total_faces_deleted += len(faces_to_del)

        # Delete faces
        bmesh.ops.delete(bm, geom=faces_to_del, context='FACES')

        # Clean up isolated verts and edges
        isolated_verts = [v for v in bm.verts if not v.link_faces]
        if isolated_verts:
            total_verts_removed += len(isolated_verts)
            bmesh.ops.delete(bm, geom=isolated_verts, context='VERTS')

        bm.to_mesh(mesh)
        mesh.update()
        bm.free()
        affected.append(obj.name)

    return total_faces_deleted, total_verts_removed, affected

def do_export(path):
    """Export as uncompressed GLB (Draco applied by gltf-transform post-process)."""
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_tangents=False,
        export_image_format='AUTO',
        export_extras=False,
        export_lights=False,
        export_cameras=False,
        use_visible=False,
        use_renderable=False,
        use_active_collection=False,
        use_selection=False,
        export_materials='EXPORT',
    )

def main():
    print("=== Casino Table Deletion v2 ===", flush=True)
    print(f"Zone: X[{BL_X_MIN},{BL_X_MAX}] Y[{BL_Y_MIN},{BL_Y_MAX}]", flush=True)

    reset_scene()
    import_glb(GLB_IN)

    verts_before = count_verts()
    print(f"Verts before: {verts_before:,}", flush=True)

    faces_del, verts_removed, affected = delete_right_tables()
    print(f"Deleted {faces_del:,} faces from: {affected}", flush=True)
    print(f"Removed {verts_removed:,} isolated verts", flush=True)

    verts_after = count_verts()
    delta = verts_before - verts_after
    print(f"Verts after: {verts_after:,} (delta: -{delta:,})", flush=True)

    if faces_del == 0:
        print("ERROR: 0 faces deleted — aborting export", flush=True)
        sys.exit(1)

    print(f"Exporting to: {GLB_TMP}", flush=True)
    do_export(GLB_TMP)
    size = os.path.getsize(GLB_TMP)
    print(f"Exported: {size:,} bytes", flush=True)
    print("=== Done ===", flush=True)

if __name__ == "__main__":
    main()
