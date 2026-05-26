"""
Phase 2: Delete the 2 right-side poker tables from casino-interior.glb and re-export.

COORDINATE MAPPING:
- Blender (after gltf import): X = room width, Y = room depth (long axis), Z = height
- GLB room: X [-963, -478], Y [-508, +509], Z [-274, -71]
- Center X = -720.6, Center Y = +0.29
- Scale = 2000 / 1016.7 = 1.9671
- World X = (blX - -720.6) * 1.9671
- World Z = (blY - 0.29) * 1.9671  (Y is depth axis)
- World Y = (blZ - -274.4) * 1.9671 (Z is height axis)

FROM USER SCREENSHOT:
- Avatar at world (0, 0, +800), camera behind at +Z looking toward -Z (into room)
- Camera RIGHT = world +X
- Circled tables: RIGHT column (world +X), BOTH depth rows visible
- Right column blender X threshold: blX > -639 (= worldX > +166)
- Depth range for spawn-side tables: blY ≈ 130 to 430 (worldZ ≈ 255 to 849)
  This covers BOTH the near and far visible right-side tables

DELETION STRATEGY:
For each mesh object, enter edit mode, select vertices where:
  blX > -640 AND blY > 130 AND blY < 440
Then delete selected faces.

IMPORTANT: We use a spatial box selection. The right side tables are the only
significant geometry in this blX/blY zone that's table-specific. The right wall
is at blX ≈ -478, so we need blX > -640 (world +X > +160) to catch tables
but avoid the wall itself (blX ≈ -478 IS the right wall — we must avoid deleting
the wall geometry).

REFINED BOUNDS from Phase 1 cluster analysis:
- RIGHT arch cluster: blX > -639, blY 280..510 = first row (near spawn)
- Also need: blX > -639, blY 130..280 = second row (behind first)
- But must PRESERVE: right wall at blX -478 and structures attached to it

Actually looking at floor plan: the RIGHT side tables have their centeroids at:
- Phase 1 RIGHT cluster: blX_ctr = -576, blY in [300..500]
- The tables probably span blX from about -640 to -520 (left edge to right edge)
- The right wall is at blX -478

So safe deletion bounds:
  blX in [-645, -505]  (table range, avoids wall at -478)
  blY in [100, 440]    (both table rows, spawn side half of room)
  This captures the 2 right-side poker tables without touching the wall.

We also capture only geometry well away from the wall (blX < -505 buffer of ~27 units).
"""

import bpy
import bmesh
import math
import os
import sys

GLB_IN   = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"
GLB_TMP  = r"C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino-no-tables-uncompressed.glb"  # intermediate
GLB_OUT  = r"C:\Users\newma\Documents\Crypto\ClawVille\apps\web\public\models\casino\casino-interior.glb"

# Spatial deletion bounds (Blender import space)
# Right-side tables: X range avoids the wall at blX ≈ -478
BL_X_MIN = -645.0  # left edge of right table
BL_X_MAX = -505.0  # right edge of right table (wall at -478, give 27-unit buffer)
BL_Y_MIN =  100.0  # back of second row
BL_Y_MAX =  440.0  # front (spawn side) of first row
# No Z restriction (delete full height of table geometry)

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)

def count_all_verts():
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            total += len(obj.data.vertices)
    return total

def preview_deletion_scope():
    """Count how many vertices would be deleted before actually deleting."""
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        mat = obj.matrix_world
        for v in obj.data.vertices:
            co = mat @ v.co
            if (BL_X_MIN <= co.x <= BL_X_MAX and
                BL_Y_MIN <= co.y <= BL_Y_MAX):
                total += 1
    return total

def delete_table_verts():
    """Delete faces whose all vertices fall within the right-table spatial bounds."""
    total_deleted_verts = 0
    total_deleted_faces = 0
    affected_meshes = []

    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue

        mesh = obj.data
        mat = obj.matrix_world

        # Check if any vertex is in the target zone
        candidate_verts = set()
        for v in mesh.vertices:
            co = mat @ v.co
            if (BL_X_MIN <= co.x <= BL_X_MAX and
                BL_Y_MIN <= co.y <= BL_Y_MAX):
                candidate_verts.add(v.index)

        if not candidate_verts:
            continue

        print(f"  {obj.name}: {len(candidate_verts)} candidate verts", flush=True)

        # Use bmesh to delete faces that have ANY vertex in the target zone
        # This ensures connected partial quads are fully removed
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()

        # Strategy: delete faces where ALL verts are in zone, OR
        # where the face centroid is in zone.
        # Using centroid is safer to avoid partial-face artifacts.
        faces_to_delete = []
        for face in bm.faces:
            # Face centroid
            cx = sum(v.co.x for v in face.verts) / len(face.verts)
            cy = sum(v.co.y for v in face.verts) / len(face.verts)
            # Transform to world (multiply by object matrix)
            wco = mat @ type(face.verts[0].co)((cx, cy, 0))
            wx, wy = wco.x, wco.y

            if (BL_X_MIN <= wx <= BL_X_MAX and
                BL_Y_MIN <= wy <= BL_Y_MAX):
                faces_to_delete.append(face)

        if faces_to_delete:
            print(f"    Deleting {len(faces_to_delete)} faces from {obj.name}", flush=True)
            total_deleted_faces += len(faces_to_delete)
            bmesh.ops.delete(bm, geom=faces_to_delete, context='FACES')
            # Remove isolated vertices
            isolated = [v for v in bm.verts if not v.link_faces and not v.link_edges]
            if isolated:
                bmesh.ops.delete(bm, geom=isolated, context='VERTS')
                total_deleted_verts += len(isolated)
            bm.to_mesh(mesh)
            mesh.update()
            affected_meshes.append(obj.name)

        bm.free()

    return total_deleted_faces, affected_meshes

def do_export(path):
    """Export all meshes as GLB (no Draco — will apply via gltf-transform)."""
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=False,           # no modifiers to apply
        export_animations=False,      # no animations
        export_skins=False,
        export_morph=False,
        export_tangents=False,
        export_image_format='AUTO',   # preserve WebP
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
    print("=== Casino Table Deletion Phase 2 ===", flush=True)
    print(f"Target bounds: blX [{BL_X_MIN:.1f}, {BL_X_MAX:.1f}], blY [{BL_Y_MIN:.1f}, {BL_Y_MAX:.1f}]", flush=True)

    # ---- Import ----
    reset_scene()
    import_glb(GLB_IN)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    print(f"Imported {len(meshes)} mesh objects", flush=True)

    # ---- Count before ----
    verts_before = count_all_verts()
    print(f"Total verts before: {verts_before:,}", flush=True)

    # ---- Preview scope ----
    preview = preview_deletion_scope()
    print(f"Verts in target zone: {preview:,}", flush=True)

    # ---- Safety check: if preview > 120,000, something is wrong ----
    if preview > 150000:
        print("ERROR: Too many verts selected — bounds are too wide. Aborting.", flush=True)
        sys.exit(1)

    if preview == 0:
        print("WARNING: 0 verts in target zone. Check bounds.", flush=True)
        sys.exit(1)

    # ---- Delete ----
    print("Deleting right-side table faces...", flush=True)
    deleted_faces, affected = delete_table_verts()
    print(f"Deleted {deleted_faces:,} faces from: {affected}", flush=True)

    # ---- Count after ----
    verts_after = count_all_verts()
    delta = verts_before - verts_after
    print(f"Total verts after: {verts_after:,} (delta: -{delta:,})", flush=True)

    # ---- Export uncompressed (Draco applied post-process by gltf-transform) ----
    print(f"Exporting to: {GLB_TMP}", flush=True)
    do_export(GLB_TMP)
    size = os.path.getsize(GLB_TMP)
    print(f"Exported: {size:,} bytes", flush=True)

    print("=== Done — run gltf-transform draco next ===", flush=True)

if __name__ == "__main__":
    main()
